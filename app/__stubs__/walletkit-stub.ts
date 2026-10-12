// Typed jest stub for the wallet-side WC SDK (`@reown/*` + the two `@walletconnect/*` pieces the
// walletkit module names) — the wallet-side twin of `walletconnect-stub.ts` (W1 step 2).
//
// `walletkit.ts` is the ONLY file that statically imports `@reown/*`, the app reaches it only
// through a lazy dynamic import from the post-identity path, and the disabled guard (web /
// empty WALLETCONNECT_PROJECT_ID) keeps the module inert under jest by default. This
// moduleNameMapper stub is belt-and-braces, exactly like the dApp-side stub: even a stray import
// resolves here, never to real WC code, and NO relay socket is ever opened under jest.
//
// Type fidelity (the house rule from `walletconnect-stub.ts`): the stub is a `.ts` module so
// `just typecheck` checks it, and its members ARE the typed fakes from `../__tests__/walletkit-fake`
// — `FAKE_WALLETKIT_INIT`'s argument signature is the genuine `WalletKitTypes.Options`, the SAME
// jest.fn `walletkit.test.ts` asserts on, and the SAME instance `walletkit.ts` captures at import
// time (single source). tsc still resolves the REAL SDK types for production code (it ignores
// moduleNameMapper), so `walletkit.ts`'s `WalletKit.init({...})` / `new Core({...})` calls are
// checked against the genuine surface.
//
// Lives under `__stubs__/` (NOT `__tests__/`) so jest's default testMatch does not pick it up as a
// suite. The fake's imports are TYPE-ONLY, so re-exporting its values here closes no runtime cycle.
import {
  FAKE_BUILD_APPROVED_NAMESPACES,
  FAKE_CORE,
  FAKE_WALLETKIT_INIT,
  fakeGetSdkError,
} from '../__tests__/walletkit-fake';

export const WalletKit = {
  init: FAKE_WALLETKIT_INIT,
};

export {FAKE_CORE as Core};
export {FAKE_BUILD_APPROVED_NAMESPACES as buildApprovedNamespaces};
export {fakeGetSdkError as getSdkError};

export default {WalletKit, Core: FAKE_CORE, buildApprovedNamespaces: FAKE_BUILD_APPROVED_NAMESPACES, getSdkError: fakeGetSdkError};
