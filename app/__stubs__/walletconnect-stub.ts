// Typed jest stub for `@walletconnect/*` (MC8 U6.2 hardening).
//
// `wallet.ts`'s `resolveOnrampProvider()` is WEB-FIRST (it returns `window.ethereum` before ever
// reaching the WC branch), and the WC branch is gated on `Platform.OS !== 'web'` + a non-empty
// `WALLETCONNECT_PROJECT_ID`. So under jest (node/jsdom, no projectId by default) NO WalletConnect
// code is ever reached at runtime. This moduleNameMapper stub (`^@walletconnect/.*` → this file,
// wired in jest.config.js) is belt-and-braces: even a stray import resolves here, never to real WC.
//
// Type fidelity (MC8 U6.2 hardening): this stub is now a `.ts` module so `just typecheck` checks it.
// Its `EthereumProvider.init` IS the typed `FAKE_INIT` (re-exported from
// `../__tests__/walletconnect-fake`), whose argument signature is the genuine
// `EthereumProviderOptions` — the SAME jest.fn `walletconnect.test.ts` asserts on, and the SAME
// instance `walletconnect.ts` captures at import time (single source). tsc still resolves the REAL
// `@walletconnect/ethereum-provider` types for production code (it ignores moduleNameMapper), so
// `walletconnect.ts`'s `EthereumProvider.init({...})` call is checked against the genuine surface.
// Lives under `__stubs__/` (NOT `__tests__/`) so jest's default testMatch does not pick it up as a
// suite. `import {FAKE_INIT}` is a VALUE import (not type-only) so the runtime jest.fn resolves.
import {FAKE_INIT} from '../__tests__/walletconnect-fake';

export const EthereumProvider = {
  init: FAKE_INIT,
};

export default {EthereumProvider};
