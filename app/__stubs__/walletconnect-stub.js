// Belt-and-braces jest stub for the `@walletconnect/*` packages (MC8 U6.2).
//
// `resolveOnrampProvider()` in `wallet.ts` is WEB-FIRST: it returns `window.ethereum` before ever
// reaching the WalletConnect branch, and that branch is only entered on native (`Platform.OS !==
// 'web'`) with a non-empty `WALLETCONNECT_PROJECT_ID`. So under jest (node/jsdom, no projectId by
// default) NO WalletConnect code is ever reached at runtime. This moduleNameMapper stub
// `^@walletconnect/.*` → this file (wired in `jest.config.js`). Is a CommonJS `.js` module (mirrors
// `__mocks__/react-native-vision-camera.js`) so tsc does not type-check it and the `jest` runtime
// global is available. Lives under `__stubs__/` (NOT `__tests__/`) so jest's default testMatch does
// not pick it up as a suite. Typecheck still resolves the REAL `@walletconnect/ethereum-provider`
// types (tsc ignores moduleNameMapper), so `walletconnect.ts` is type-checked against the genuine WC
// surface.
module.exports = {
  EthereumProvider: {
    init: jest.fn(),
  },
};
