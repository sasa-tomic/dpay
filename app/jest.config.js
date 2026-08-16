module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // react-native-qrcode-svg ships ESM (`export default`); transform it so jest can load it.
  // async-storage v3 also ships its jest mock as ESM under lib/module — list it here so babel-jest
  // transforms the `export` syntax before jest's VM tries to evaluate it.
  transformIgnorePatterns: [
    // @noble: the wasm-core shim (e2e/web/dpay-core-wasm.ts) imports @noble/ed25519 + hashes/utils
    // from e2e/node_modules; ed25519 2.x ships ESM in its `main`, so babel must transform it.
    'node_modules/(?!(react-native|@react-native|react-native-qrcode-svg|react-native-vision-camera|@react-native-async-storage/async-storage|@noble)/)',
  ],
  // MC8 U6.2 — WalletConnect isolation. `wallet.ts`'s `resolveOnrampProvider()` is web-first and
  // only dynamic-imports `./walletconnect` on native with a non-empty projectId, so jest never
  // reaches WC code in practice. This mapper is belt-and-braces: any `@walletconnect/*` specifier
  // (the static imports inside `walletconnect.ts`, or a transitive dep) resolves to the TYPED stub
  // under `__stubs__/` (a `.ts` module — so `just typecheck` checks it too) instead of executing
  // real WalletConnect code. The extension is intentionally omitted so jest resolves `.ts` via its
  // default moduleFileExtensions. tsc still resolves the genuine WC types (it ignores moduleNameMapper),
  // so type safety is unaffected.
  moduleNameMapper: {
    '^@walletconnect/.*': '<rootDir>/__stubs__/walletconnect-stub',
    // vite `?url` asset imports (e.g. the wasm core in e2e/web/dpay-core-wasm.ts) never resolve
    // under jest — the vite asset transform doesn't run. Map ANY `?url` specifier to a typed string
    // stub (vite's semantics: the default export IS the asset's served URL).
    '\\?url$': '<rootDir>/__stubs__/url-asset-stub',
  },
  // MC8 U6.2 hardening: `__tests__/walletconnect-fake.ts` is a typed test DOUBLE (exported +
  // consumed by the stub + the test), NOT a suite — it has no `test()` calls. Jest's default
  // testMatch picks up every `.ts` under `__tests__/`, so exclude it explicitly (it is still tsc-
  // checked by `just typecheck`). `/node_modules/` is re-stated because setting this field replaces
  // jest's default ignore list.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/__tests__/walletconnect-fake.ts'],
};
