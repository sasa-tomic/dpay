/**
 * walletconnect — the WalletConnect v2 EIP-1193 provider source + pairing driver for the NATIVE
 * (Android) ckERC20 direct onramp. The web/browser path uses `window.ethereum` (see `wallet.ts`);
 * this module is the Android counterpart, reached ONLY via `wallet.ts`'s `resolveOnrampProvider()`
 * (web-first: it returns `window.ethereum` before ever reaching here) AND only when
 * `WALLETCONNECT_PROJECT_ID` is non-empty.
 *
 * NON-CUSTODIAL INVARIANT (load-bearing — see CLAUDE.md): WalletConnect brokers an ENCRYPTED
 * request/response between this dApp and the user's wallet app. The wallet signs locally and
 * returns ONLY a signature / transaction hash. dpay sends `{method, params}` and receives hashes —
 * it NEVER sees, holds, or transports the user's Ethereum key. This module adds ZERO key surface.
 *
 * PAIRING (MC8 U6 capstone): WC's built-in QR modal (`@reown/appkit/core`) is web-only and has no
 * RN-resolvable subpath — at runtime it would crash. We bypass it entirely: `showQrModal:false` in
 * `EthereumProvider.init`, then `pairWalletConnect(onUri)` subscribes to the provider's `display_uri`
 * event (the SDK emits the WC pairing URI as a plain string — see `IProviderEvents.EventArguments`
 * in the installed .d.ts) and forwards it to the caller, which renders a custom on-brand `<QRCode>`
 * (react-native-qrcode-svg, already a dep). When the wallet approves the session the `connect` event
 * fires → `onUri(null)` clears the QR. This makes the @reown/appkit import path RUNTIME-UNREACHABLE
 * (ethereum-provider only dynamic-imports the modal when showQrModal is true), so the Metro shim
 * (`app/shims/reown-appkit-core.js`) is a pure build-time satisfier — see its FIXME.
 *
 * Isolation (load-bearing — `just verify` never executes WalletConnect code): this module is the
 * ONLY file in the app that statically imports `@walletconnect/*`. `wallet.ts`'s
 * `resolveOnrampProvider()` + `pairOnrampWallet()` reach it via a lazy dynamic `import('./walletconnect')`
 * that the web/jest path never takes (web-first resolver returns `window.ethereum` first; jest has no
 * `window.ethereum` AND an empty `WALLETCONNECT_PROJECT_ID` via jest.setup.js, so the dynamic import
 * is never evaluated). Belt-and-braces: the e2e vite build aliases `@walletconnect/ethereum-provider` +
 * `@walletconnect/react-native-compat` to no-op shims (e2e/vite.config.js), and jest's
 * moduleNameMapper maps `^@walletconnect/.*` to a stub (__stubs__/walletconnect-stub.ts) — so even
 * a stray import resolves to a no-op, never real WC code.
 */
import {Platform} from 'react-native';
import {EthereumProvider} from '@walletconnect/ethereum-provider';
import '@walletconnect/react-native-compat'; // side-effect: RN polyfills for the WC SDK
import {WALLETCONNECT_PROJECT_ID} from './config/constants';
import type {Eip1193Provider} from './wallet';

// The real EthereumProvider instance type (the package root exports a `const` value; the instance
// type is derived via InstanceType — see walletconnect-fake.ts for the detailed rationale).
type EthereumProviderInstance = InstanceType<typeof EthereumProvider>;

// The single cached init promise. WalletConnect's pairing/session is long-lived; calling
// `EthereumProvider.init` again would tear down the session and re-pair every time the sheet opens.
// Init once, share the resulting provider across calls.
//
// MC8 U6 capstone — typed as `Promise<EthereumProviderInstance>` (the FULL provider surface) so
// `pairWalletConnect` can use `.on('display_uri', ...)` / `.connect()` / `.removeListener(...)`.
// `getWalletConnectProvider()` narrows it to `Eip1193Provider | null` on return — the assignability
// is pinned at compile time by walletconnect-conformance.test.ts (`_promisePin` +
// `_instanceToEip1193`), so an SDK bump that breaks the narrowing fails `just typecheck`.
let cachedProvider: Promise<EthereumProviderInstance> | null = null;

/** Initialize the provider with the capstone options (showQrModal:false — we render the QR ourselves). */
function initProvider(): Promise<EthereumProviderInstance> {
  return EthereumProvider.init({
    projectId: WALLETCONNECT_PROJECT_ID,
    chains: [1], // Ethereum mainnet — ckERC20 (ckUSDC) deposits settle on chain 1 (MC8 U3 gate).
    optionalChains: [1],
    showQrModal: false, // MC8 U6 capstone: bypass the web-only @reown/appkit modal; render our own QR.
    metadata: {
      name: 'dpay',
      description: 'dpay non-custodial wallet',
      url: 'https://dpay.kalaj.org',
      icons: [],
      redirect: {native: 'org.kalaj.dpay://'}, // deep-link back into this app after the wallet signs
    },
  });
}

/**
 * Get the WalletConnect EIP-1193 provider (singleton). Returns null when WalletConnect is DISABLED
 * — i.e. on web (`Platform.OS === 'web'` — the browser uses `window.ethereum` instead) or when no
 * `WALLETCONNECT_PROJECT_ID` is configured (empty = disabled). When enabled, initializes the
 * provider once and caches the promise; the resolved provider's `.request` IS the EIP-1193 surface
 * `wallet.ts` consumes.
 */
export async function getWalletConnectProvider(): Promise<Eip1193Provider | null> {
  // Disabled guard (defense-in-depth — `resolveOnrampProvider()` already gates Platform + projectId
  // before dynamically importing this module; this makes the module self-protecting too).
  if (Platform.OS === 'web' || !WALLETCONNECT_PROJECT_ID) return null;
  if (!cachedProvider) cachedProvider = initProvider();
  // EthereumProviderInstance is assignable to Eip1193Provider (request signature compatible) —
  // pinned by walletconnect-conformance.test.ts. No cast needed (pure assignability).
  return cachedProvider;
}

/**
 * MC8 U6 capstone — drive a WalletConnect pairing and surface the pairing URI for a custom QR.
 *
 * With `showQrModal:false`, the WC SDK does NOT open its own modal. Instead it emits the pairing URI
 * via the `display_uri` event (payload: a plain `string` — the `wc:` URI the user's wallet scans).
 * This function subscribes BEFORE calling `connect()`, forwards the URI to `onUri` (the sheet renders
 * a custom `<QRCode>`), and clears it (`onUri(null)`) when the `connect` event fires (session
 * established). Listeners are removed on both success and failure so a subsequent pair doesn't
 * double-fire. Throws on pair failure (the caller surfaces an honest error).
 *
 * Disabled guard: web Platform / empty projectId → returns immediately (no-op). This mirrors
 * `getWalletConnectProvider()`'s guard and makes `pairOnrampWallet`'s delegation safe.
 */
export async function pairWalletConnect(onUri: (uri: string | null) => void): Promise<void> {
  // Disabled guard — same gate as getWalletConnectProvider (defense-in-depth).
  if (Platform.OS === 'web' || !WALLETCONNECT_PROJECT_ID) return;
  if (!cachedProvider) cachedProvider = initProvider();
  const provider = await cachedProvider;

  // Subscribe BEFORE connect() so the display_uri event (emitted during connect) is never missed.
  // The display_uri payload is a plain string (the WC pairing URI); the connect payload is
  // ProviderInfo {chainId} — we ignore it and just signal "paired" via onUri(null).
  const onDisplayUri = (uri: string) => onUri(uri);
  const onConnect = () => onUri(null);
  provider.on('display_uri', onDisplayUri);
  provider.on('connect', onConnect);

  try {
    // connect() initiates the pairing handshake; it resolves when the session is established (the
    // wallet approved). The SDK emits display_uri (→ onUri(uri)) during this call, then connect
    // (→ onUri(null)) when the session settles. No opts needed (the chains were set at init).
    await provider.connect();
  } catch (e) {
    // Translate to a clear, typed pair-failure error so the sheet can surface friendly copy.
    throw new Error(
      `WalletConnect pairing failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    // Always clean up listeners (success OR failure) so a re-pair doesn't stack duplicate handlers.
    provider.removeListener('display_uri', onDisplayUri);
    provider.removeListener('connect', onConnect);
  }
}
