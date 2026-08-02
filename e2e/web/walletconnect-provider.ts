// WalletConnect noop shim for the e2e web build (MC8 U6.2).
//
// The real app's `wallet.ts` `resolveOnrampProvider()` is WEB-FIRST: it returns `window.ethereum`
// (which the e2e harness's flow 16 installs as a recording mock) before EVER reaching the
// WalletConnect branch, and that branch is gated on `Platform.OS !== 'web'` (the vite build is
// react-native-web → Platform.OS === 'web') AND a non-empty `WALLETCONNECT_PROJECT_ID` (unset in
// the harness). So the WC code path is doubly unreachable in `just e2e`.
//
// This shim is the belt-and-braces alias target (mirrors the `react-native-vision-camera` alias in
// vite.config.js): `@walletconnect/ethereum-provider` AND `@walletconnect/react-native-compat` both
// resolve here, so even if an import path changed the vite bundle never executes real WalletConnect
// code (and never pulls the WC SDK's heavy dep tree into the web bundle). The real
// `@walletconnect/ethereum-provider` types are still resolved by `tsc` (vite aliasing does not
// affect typecheck), so `walletconnect.ts` remains type-checked against the genuine WC surface.
//
// `react-native-compat` is imported in `walletconnect.ts` purely for its side effects (RN polyfills);
// aliasing it to this side-effect-free module is a harmless no-op on web.

// A inert `EthereumProvider` stand-in. `init` is never called in the web build (web-first resolver),
// but if it ever were, it resolves a minimal EIP-1193-shaped object rather than throwing.
export const EthereumProvider = {
  init: () =>
    Promise.resolve({
      request: async () => null,
    }),
};

export default {EthereumProvider};
