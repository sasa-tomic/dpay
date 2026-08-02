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

// PR3 — dpay-side bound on `provider.connect()`. The WC SDK's pairing topic has its own ~5min TTL,
// but dpay must NOT rely silently on that internal behavior: if the wallet never scans the QR, the
// sheet would otherwise wait indefinitely on `connect()` with no honest error. 5min is generous
// (matches the SDK's pairing-topic TTL ceiling) and surfaces a truthful "timed out" error to the
// user instead of an infinite spinner. Exported so the test can advance fake timers by exactly this.
export const PAIR_TIMEOUT_MS = 5 * 60 * 1000;

// PR13 — the Android deep-link back into this app after the wallet signs. MUST stay in lockstep
// with the `applicationId` in `app/android/app/build.gradle` (currently "org.kalaj.dpay", which is
// INTENTIONALLY != the java package namespace "com.dpay" — see app/android/app/play-signing/README.md).
// If the applicationId ever changes and this drifts, the wallet's "return to dpay" deep-link breaks
// SILENTLY (no error, just a dead tap). A documented named const is the single source here — no
// build-time injection (the applicationId is a gradle value, not reachable from JS at runtime).
const ANDROID_DEEP_LINK = 'org.kalaj.dpay://';

// The single cached init promise. WalletConnect's pairing/session is long-lived; calling
// `EthereumProvider.init` again would tear down the session and re-pair every time the sheet opens.
// Init once, share the resulting provider across calls. Cleared by `disconnectWalletConnect()` (U6.5)
// so a teardown (sheet close mid-pair, or an aborted session) forces a fresh init on the next open.
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
      redirect: {native: ANDROID_DEEP_LINK}, // PR13: deep-link back into this app after the wallet signs
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

  // PR3 — bound connect() with Promise.race + PAIR_TIMEOUT_MS so a wallet that never scans the QR
  // surfaces an honest "timed out" error instead of hanging forever on the SDK's internal TTL. The
  // timeout promise's timer is cleared in `finally` on the happy path (no dangling timer). Declared
  // in the enclosing scope so `finally` can clear it (a `let` inside `try` would be out of scope).
  // NOTE: Promise.race cannot truly cancel the underlying connect() (JS promises aren't
  // cancellable) — the SDK's connect() stays pending until its own pairing-topic TTL or until
  // `disconnectWalletConnect()` tears the provider down (the sheet wires that on close).
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // connect() initiates the pairing handshake; it resolves when the session is established (the
    // wallet approved). The SDK emits display_uri (→ onUri(uri)) during this call, then connect
    // (→ onUri(null)) when the session settles. No opts needed (the chains were set at init).
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('pairing timed out — no wallet scanned within 5 min')),
        PAIR_TIMEOUT_MS,
      );
    });
    await Promise.race([provider.connect(), timeout]);
  } catch (e) {
    // Translate to a clear, typed pair-failure error so the sheet can surface friendly copy.
    throw new Error(
      `WalletConnect pairing failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    // Always clean up listeners + the timeout timer (success OR failure) so a re-pair doesn't stack
    // duplicate handlers or leak a dangling timer.
    if (timer) clearTimeout(timer);
    provider.removeListener('display_uri', onDisplayUri);
    provider.removeListener('connect', onConnect);
  }
}

/**
 * U6.5 — disconnect the cached WalletConnect provider AND clear the cache. Idempotent + safe to call
 * from a fire-and-forget teardown (the sheet's unmount cleanup): swallows any provider.disconnect()
 * failure so a teardown glitch never propagates to a caller that has already torn down its UI.
 *
 * Why clear the cache: the WC pairing/session is bound to a specific provider instance. Leaving a
 * disconnected/stale provider cached would make the next `getWalletConnectProvider()` /
 * `pairWalletConnect()` reuse a dead session. Clearing forces a fresh `EthereumProvider.init` on the
 * next open, so the user gets a clean re-pair rather than errors on a stale provider. The cache is
 * cleared BEFORE awaiting disconnect so even a rejecting disconnect leaves the module in the clean
 * (re-init-next) state.
 *
 * Disabled guard: web Platform / empty projectId → immediate no-op (mirrors the other exports, so
 * the sheet can call this unconditionally without special-casing the disabled path).
 */
export async function disconnectWalletConnect(): Promise<void> {
  // Disabled guard — same gate as the other exports (defense-in-depth).
  if (Platform.OS === 'web' || !WALLETCONNECT_PROJECT_ID) return;
  const cached = cachedProvider;
  if (!cached) return; // nothing cached (never initialized, or already disconnected) → no-op.
  // Clear the cache FIRST so a rejecting disconnect cannot leave a stale provider cached.
  cachedProvider = null;
  try {
    const provider = await cached;
    await provider.disconnect();
  } catch {
    // Swallow — best-effort teardown. The cache is already cleared; a disconnect failure (e.g. the
    // SDK session already dropped on its own) must not propagate to the fire-and-forget caller.
  }
}
