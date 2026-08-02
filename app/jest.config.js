module.exports = {
  preset: 'react-native',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // react-native-qrcode-svg ships ESM (`export default`); transform it so jest can load it.
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|react-native-qrcode-svg|react-native-vision-camera)/)',
  ],
  // MC8 U6.2 — WalletConnect isolation. `wallet.ts`'s `resolveOnrampProvider()` is web-first and
  // only dynamic-imports `./walletconnect` on native with a non-empty projectId, so jest never
  // reaches WC code in practice. This mapper is belt-and-braces: any `@walletconnect/*` specifier
  // (the static imports inside `walletconnect.ts`, or a transitive dep) resolves to the no-op stub
  // under `__tests__/__stubs__/` instead of executing real WalletConnect code. tsc still resolves
  // the genuine WC types (it ignores moduleNameMapper), so type safety is unaffected.
  moduleNameMapper: {
    '^@walletconnect/.*': '<rootDir>/__stubs__/walletconnect-stub.js',
  },
};
