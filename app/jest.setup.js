// Jest setup: mock the native-backed modules that aren't available under node/jsdom so <App/>
// renders in the test harness. AsyncStorage ships an official mock; vision-camera is stubbed via
// the root __mocks__ directory.
//
// async-storage v3 moved the mock: it now lives at the package subpath `.../jest` (was
// `.../jest/async-storage-mock`) and exports a DEFAULT instance — `require(...).default` — rather
// than the module itself being the mock.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest').default,
);

// MC8 U6 capstone — WalletConnect is now ENABLED in production (real projectId baked in
// constants.ts). For the offline jest inner loop, DISABLE WC globally so no test accidentally
// triggers the WC code path. The resolver's WC branch is gated by Platform.OS; in jest the RN
// preset defaults Platform.OS to 'ios', so without this override a non-empty projectId would make
// resolveOnrampProvider() reach the WC dynamic import in any test that calls it. Tests that need
// WC ENABLED (walletconnect.test.ts) set the override inside jest.isolateModules. Mirrors the
// EXPECTED_RECEIPT_PUBKEY seam exactly.
globalThis.__DPAY_TEST_WALLETCONNECT_PROJECT_ID = '';
// SOL native device-key rail: DISABLE for the offline jest inner loop so no test hits real devnet.
// An empty SOLANA_RPC_URL makes useSolanaBalance no-op and the SOL card render with `—`. Mirrors
// the WC seam above. (solana-rpc.test.ts mocks fetch itself and never reads this constant.)
globalThis.__DPAY_TEST_SOLANA_RPC_URL = '';
