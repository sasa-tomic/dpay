// Jest setup: mock the native-backed modules that aren't available under node/jsdom so <App/>
// renders in the test harness. AsyncStorage ships an official mock; vision-camera is stubbed via
// the root __mocks__ directory.
//
// async-storage v3 moved the mock: it now lives at the package subpath `.../jest` (was
// `.../jest/async-storage-mock`) and exports a DEFAULT instance — `require(...).default` — rather
// than the module itself being the mock.
//
// ONE INSTANCE PER JEST CONTEXT, shared across every module registry (flow-harness M3): jest
// gives setupFiles, setupFilesAfterEnv, and the test file EACH their own module registry, so a
// plain `require` from the flow lifecycle (setupFlow.ts) resolves a DIFFERENT mock Map than the
// app's — the lifecycle's clear() purged the wrong instance and keys from a previous flow's boot
// survived (observed: the SOL-rail placeholder leaking across flows). The first factory execution
// plants the instance on globalThis (which IS shared across registries) and every later execution
// returns that same one, so the app, the driver, and the lifecycle all read/write ONE store.
jest.mock('@react-native-async-storage/async-storage', () => {
  const mod = require('@react-native-async-storage/async-storage/jest');
  if (globalThis.__DPAY_JEST_ASYNC_STORAGE === undefined) {
    globalThis.__DPAY_JEST_ASYNC_STORAGE = mod.default;
  }
  return globalThis.__DPAY_JEST_ASYNC_STORAGE;
});

// MC8 U6 capstone — WalletConnect is now ENABLED in production (real projectId baked in
// constants.ts). For the offline jest inner loop, DISABLE WC globally so no test accidentally
// triggers the WC code path. The resolver's WC branch is gated by Platform.OS; in jest the RN
// preset defaults Platform.OS to 'ios', so without this override a non-empty projectId would make
// resolveOnrampProvider() reach the WC dynamic import in any test that calls it. Tests that need
// WC ENABLED (walletconnect.test.ts) set the override inside jest.isolateModules. Same
// __DPAY_TEST_* override-seam pattern as the SOLANA_RPC_URL line below.
globalThis.__DPAY_TEST_WALLETCONNECT_PROJECT_ID = '';
// SOL native device-key rail: DISABLE for the offline jest inner loop so no test hits real devnet.
// An empty SOLANA_RPC_URL makes useSolanaBalance no-op and the SOL card render with `—`. Mirrors
// the WC seam above. (solana-rpc.test.ts mocks fetch itself and never reads this constant.)
globalThis.__DPAY_TEST_SOLANA_RPC_URL = '';
// EVM native device-key rail: DISABLE for the offline jest inner loop, exactly like the SOL seam
// above. An empty EVM RPC URL makes the `app/evm.ts` seam no-op (no dynamic import of the network
// module, no fetch) — the offline inner loop never touches a chain. (evm-seam.test.ts overrides
// it inside isolateModules and mocks fetch where the network path is the subject.)
globalThis.__DPAY_TEST_EVM_RPC_URL = '';
