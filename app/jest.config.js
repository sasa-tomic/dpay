// Pin the timezone before any test module constructs a `Date`. `fmtTime` renders every ledger row
// through the device clock, so its Today/Yesterday boundary and its hour digits are functions of
// the host TZ — unpinned, the same assertion passes in Zurich and fails in UTC. Config load is the
// earliest hook jest offers, and Node caches the zone on first use.
process.env.TZ = 'UTC';

// Root config — the shared base EVERY project below inherits (projects override what they name).
// react-native-qrcode-svg ships ESM (`export default`); transform it so jest can load it.
// async-storage v3 also ships its jest mock as ESM under lib/module — list it here so babel-jest
// transforms the `export` syntax before jest's VM tries to evaluate it.
const transformIgnorePatterns = [
  // @noble: the wasm-core shim (e2e/web/dpay-core-wasm.ts) imports @noble/ed25519 + hashes/utils;
  // ed25519 2.x ships ESM in its `main`, so babel must transform it.
  'node_modules/(?!(react-native|@react-native|react-native-qrcode-svg|react-native-vision-camera|@react-native-async-storage/async-storage|@noble)/)',
];
// MC8 U6.2 — WalletConnect isolation + vite `?url` asset stubs (see the notes at the bottom of
// this file, kept from the single-project era).
const moduleNameMapper = {
  '^@walletconnect/.*': '<rootDir>/__stubs__/walletconnect-stub',
  '\\?url$': '<rootDir>/__stubs__/url-asset-stub',
};
const testPathIgnorePatterns = ['/node_modules/', '<rootDir>/__tests__/walletconnect-fake.ts'];
const testMatch = ['<rootDir>/__tests__/**/*.test.@(ts|tsx)'];

// Shared base — spread into EVERY project (projects are independent configs; anything a project
// does not name falls back to the root config, and the root names this as the common ground).
const common = {
  preset: '@react-native/jest-preset',
  testMatch,
  testPathIgnorePatterns,
  transformIgnorePatterns,
  moduleNameMapper,
  // modulePaths: this worktree's `e2e/node_modules` is absent (gitignored, not installed), but
  // jest still transforms+requires e2e/web/* (the wasm-core shim and, in the flow project, the
  // NFC shims). Their bare imports (@babel/runtime helpers, @noble/*) resolve through the app's
  // own node_modules via this extra search root — the same packages the app builds against.
  modulePaths: ['<rootDir>/node_modules'],
};

// Smoke tier admission is env-gated: `just smoke` sets DPAY_SMOKE=1 AND passes explicit manifest
// files (scripts/smoke-files.mjs). With the env unset the smoke project discovers NOTHING, so a
// bare full-jest run never double-runs the roster files, and a bare `--selectProjects smoke` finds
// no tests (an error) — an unlisted file can never sneak into the tier.
const smokeActive = process.env.DPAY_SMOKE === '1';

// node-anvil tier admission is env-gated the same way: `just node-anvil` sets DPAY_NODE_ANVIL=1
// (the project globalSetup then stages ONE anvil + relay pipe for the whole run). With the env
// unset the project discovers NOTHING — a bare full-jest run (`just test-app`) never spawns a
// chain, and the setup/teardown no-op on top (belt and braces).
const nodeAnvilActive = process.env.DPAY_NODE_ANVIL === '1';

module.exports = {
  // Root-level (applies to every project): the honest hang backstop — see the single-project-era
  // note at the bottom of this file for the measured reasoning.
  testTimeout: 30_000,

  projects: [
    {
      // The DEFAULT tier: component + service tests (`just test-app`). Most new tests belong here.
      // (In projects mode, root-level setupFiles do NOT cascade — every project names its own.)
      displayName: 'domain',
      ...common,
      setupFiles: ['<rootDir>/jest.setup.js'],
      testPathIgnorePatterns: [...testPathIgnorePatterns, '<rootDir>/__tests__/flow/', '<rootDir>/__tests__/node-anvil/'],
    },
    {
      // The FLOW tier (`just flow`): full <App/> mounts against the REAL test-helpers relay,
      // porting the e2e flow suite browser-free. The relay is spawned ONCE per jest run by
      // globalSetup (jest.relay-setup.js → e2e/harness/relay.mjs, verbatim); jest-side relay
      // access goes through flow/harness/relayClient.ts (e2e/harness/*.mjs uses import.meta.url,
      // which babel's CJS transform breaks — never import those from test code).
      displayName: 'flow',
      ...common,
      testMatch: ['<rootDir>/__tests__/flow/**/*.test.@(ts|tsx)'],
      // HERMETIC EXECUTION MODEL: files are self-contained (one private relay + fresh seams per
      // file, harness/hermetic.ts) — high worker counts are safe, and a worker recycle (the
      // workerIdleMemoryLimit below) cannot break a file, because nothing crosses files.
      maxWorkers: '50%',
      workerIdleMemoryLimit: '2GB',
      // Jest's mocks record every call for the mock's lifetime — the whole FILE. Full-app flow
      // files mount 34 describes into ONE registry, and per-test render churn then accumulates
      // unboundedly in mock.call records (the convert lane's measured OOM class, 2026-09-29).
      // Clear per test: records stay per-test-bounded, implementations survive (mockClear
      // semantics — the AsyncStorage mock's backing store and every impl keep working).
      clearMocks: true,
      setupFiles: ['<rootDir>/jest.flow-setup.js', '<rootDir>/jest.setup.js'],
      // The per-test lifecycle (AsyncStorage purge, seam resets, the fail-closed fetch
      // assertion) — lifecycle hooks only exist AFTER the test framework is installed, so
      // this is a setupFilesAfterEnv file. installFlowLifecycle is idempotent: batches that
      // self-register it at collection time (the interim workaround for this file missing
      // here) keep working, and both paths coexist.
      setupFilesAfterEnv: ['<rootDir>/jest.flow-after-env.js'],
      globalSetup: '<rootDir>/jest.relay-setup.js',
      globalTeardown: '<rootDir>/jest.relay-teardown.js',
      // `react-native-web` → react-native: the e2e web shims (e2e/web/dpay-{core-wasm,nfc,sol-nfc}.ts,
      // mounted by jest.flow-setup.js) import NativeEventEmitter from react-native-web, which is a
      // browser-build-only package. Mapping it to react-native routes the shims' event bus through
      // the SAME module-level RCTDeviceEventEmitter singleton the app's NativeEventEmitter listeners
      // use — the seam contract (__DPAY_TEST_NFC_SESSION listener-count fail-loud) is preserved
      // verbatim, and react-native-web need not be installed for jest at all.
      // `react-native-qrcode-svg` → the recorder mock: renders nothing, stashes the EXACT encoded
      // value on `globalThis.__DPAY_QR_LAST` (same seam name + semantics as e2e/web/qrcode.tsx), so
      // flow tests assert the QR payload field-for-field with the app's own codecs.
      moduleNameMapper: {
        ...moduleNameMapper,
        '^react-native-web$': 'react-native',
        '^react-native-qrcode-svg$': '<rootDir>/__mocks__/qrcode-svg-recorder.tsx',
      },
    },
    {
      // The SMOKE tier (`just smoke`): money-defining invariants ONLY, admitted exclusively via
      // app/__tests__/smoke/manifest.ts, <=250 ms per test (budget-setup.js), <=12 s suite total
      // (the recipe's `timeout 20s`). Pure node, zero network, deterministic, fake timers allowed.
      displayName: 'smoke',
      ...common,
      setupFiles: ['<rootDir>/jest.setup.js', '<rootDir>/__tests__/smoke/budget-setup.js'],
      testPathIgnorePatterns: smokeActive
        ? [...testPathIgnorePatterns, '<rootDir>/__tests__/flow/', '<rootDir>/__tests__/node-anvil/']
        // Env unset → discover nothing (never double-run the roster under a bare full jest).
        : ['<rootDir>/__tests__/'],
    },
    {
      // The NODE-ANVIL tier (`just node-anvil`): real-chain EVM proofs with NO browser and NO DOM
      // mount — a scratch anvil (31337, 1s blocks) + the REAL test-helpers relay staged ONCE per
      // run by the globalSetup child (jest.node-anvil-setup.js →
      // __tests__/node-anvil/stage-child.mjs, which imports e2e/harness/evm/{anvil,pipe}.mjs
      // verbatim; test code never imports those, babel's CJS transform breaks import.meta.url).
      // The app's own seam (`../evm`) drives the chain THROUGH the relay pipe; assertions read
      // REAL anvil state DIRECT as the second source. Env-gated like smoke: DPAY_NODE_ANVIL=1
      // admits it, unset discovers nothing.
      displayName: 'node-anvil',
      ...common,
      testMatch: ['<rootDir>/__tests__/node-anvil/**/*.test.@(ts|tsx)'],
      setupFiles: ['<rootDir>/jest.setup.js'],
      globalSetup: '<rootDir>/jest.node-anvil-setup.js',
      globalTeardown: '<rootDir>/jest.node-anvil-teardown.js',
      testPathIgnorePatterns: nodeAnvilActive ? testPathIgnorePatterns : ['<rootDir>/__tests__/'],
      // ONE anvil + ONE relay serve the whole run; the three files run SERIALLY against them
      // (each file uses its own deterministic device identities, so there is no cross-file state).
      maxWorkers: 1,
    },
  ],
};

// --- single-project-era notes, still load-bearing -----------------------------------------------
// MC8 U6.2 — WalletConnect isolation. `wallet.ts`'s `resolveOnrampProvider()` is web-first and
// only dynamic-imports `./walletconnect` on native with a non-empty projectId, so jest never
// reaches WC code in practice. The `@walletconnect/*` mapper is belt-and-braces: any such
// specifier resolves to the TYPED stub under `__stubs__/` (a `.ts` module — `just typecheck`
// checks it too) instead of executing real WalletConnect code. The extension is intentionally
// omitted so jest resolves `.ts` via its default moduleFileExtensions. tsc still resolves the
// genuine WC types (it ignores moduleNameMapper), so type safety is unaffected.
// vite `?url` asset imports (e.g. the wasm core in e2e/web/dpay-core-wasm.ts) never resolve under
// jest — the vite asset transform doesn't run. Any `?url` specifier maps to a typed string stub
// (vite's semantics: the default export IS the asset's served URL).
// MC8 U6.2 hardening: `__tests__/walletconnect-fake.ts` is a typed test DOUBLE (not a suite — no
// `test()` calls) and stays excluded from every project's discovery; tsc still checks it.
