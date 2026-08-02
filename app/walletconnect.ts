/**
 * walletconnect — the WalletConnect v2 EIP-1193 provider source for the NATIVE (Android) ckERC20
 * direct onramp. The web/browser path uses `window.ethereum` (see `wallet.ts`); this module is the
 * Android counterpart, reached ONLY via `wallet.ts`'s `resolveOnrampProvider()` (web-first: it
 * returns `window.ethereum` before ever reaching here) AND only when `WALLETCONNECT_PROJECT_ID` is
 * non-empty.
 *
 * NON-CUSTODIAL INVARIANT (load-bearing — see CLAUDE.md): WalletConnect brokers an ENCRYPTED
 * request/response between this dApp and the user's wallet app. The wallet signs locally and
 * returns ONLY a signature / transaction hash. dpay sends `{method, params}` and receives hashes —
 * it NEVER sees, holds, or transports the user's Ethereum key. This module adds ZERO key surface.
 *
 * Isolation (load-bearing — `just verify` never executes WalletConnect code): this module is the
 * ONLY file in the app that statically imports `@walletconnect/*`. `wallet.ts`'s
 * `resolveOnrampProvider()` reaches it via a lazy dynamic `import('./walletconnect')` that the
 * web/jest path never takes (web-first resolver returns `window.ethereum` first; jest has no
 * `window.ethereum` AND an empty `WALLETCONNECT_PROJECT_ID`, so the dynamic import is never
 * evaluated). Belt-and-braces: the e2e vite build aliases `@walletconnect/ethereum-provider` +
 * `@walletconnect/react-native-compat` to no-op shims (e2e/vite.config.js), and jest's
 * moduleNameMapper maps `^@walletconnect/.*` to a stub (__stubs__/walletconnect-stub.ts) — so even
 * a stray import resolves to a no-op, never real WC code.
 */
import {Platform} from 'react-native';
import {EthereumProvider} from '@walletconnect/ethereum-provider';
import '@walletconnect/react-native-compat'; // side-effect: RN polyfills for the WC SDK
import {WALLETCONNECT_PROJECT_ID} from './config/constants';
import type {Eip1193Provider} from './wallet';

// The single cached init promise. WalletConnect's pairing/session is long-lived; calling
// `EthereumProvider.init` again would tear down the session and re-prompt the QR modal every time
// the sheet opens. Init once, share the resulting provider across calls.
let cachedProvider: Promise<Eip1193Provider> | null = null;

/**
 * Get the WalletConnect EIP-1193 provider (singleton). Returns null when WalletConnect is DISABLED
 * — i.e. on web (`Platform.OS === 'web'` — the browser uses `window.ethereum` instead) or when no
 * `WALLETCONNECT_PROJECT_ID` is configured (empty default = today's behavior, no onramp source).
 * When enabled, initializes `EthereumProvider` once (showQrModal surfaces the pairing QR) and
 * caches the promise; the resolved provider's `.request` IS the EIP-1193 surface `wallet.ts` uses.
 */
export async function getWalletConnectProvider(): Promise<Eip1193Provider | null> {
  // Disabled guard (defense-in-depth — `resolveOnrampProvider()` already gates Platform + projectId
  // before dynamically importing this module; this makes the module self-protecting too).
  if (Platform.OS === 'web' || !WALLETCONNECT_PROJECT_ID) return null;
  if (!cachedProvider) {
    cachedProvider = EthereumProvider.init({
      projectId: WALLETCONNECT_PROJECT_ID,
      chains: [1], // Ethereum mainnet — ckERC20 (ckUSDC) deposits settle on chain 1 (MC8 U3 gate).
      optionalChains: [1],
      showQrModal: true, // surface the WalletConnect QR pairing modal on the device
      metadata: {
        name: 'dpay',
        description: 'dpay non-custodial wallet',
        url: 'https://dpay.kalaj.org',
        icons: [],
        redirect: {native: 'org.kalaj.dpay://'}, // deep-link back into this app after the wallet signs
      },
    }).then((p) => p as unknown as Eip1193Provider);
  }
  return cachedProvider;
}
