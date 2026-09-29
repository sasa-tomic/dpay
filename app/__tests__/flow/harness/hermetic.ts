/**
 * hermetic.ts — LOCAL shim for the hermetic per-file flow harness (lane migration branch
 * flow-hermetic-pay). The REAL harness lands on main as this same path; integration keeps main's
 * version and deletes this shim, so the export surface here is EXACTLY the spec'd API and nothing
 * else: hermeticFlow + hermeticDescribe (+ the HermeticFlow type).
 *
 *   hermeticFlow(opts?: { relay?: { checkout?: boolean; faucet?: boolean; env?: Record<string,string> } })
 *     Call ONCE at module scope (top of the file, before any describe). Spawns the file's PRIVATE
 *     test-helpers relay (startFlowRelay, free port, per-spawn knobs), re-points the world at it —
 *     the IC gateway seam, the app's baked-default origin AND the shared-relay origin are both
 *     fetch-rewritten to this relay (so harness relayClient defaults, module-captured proxy URLs
 *     and the app's pre-boot window all land HERE, never on the shared relay) — purges
 *     AsyncStorage, resets the seam stashes and the rail operator/transport module state, and
 *     registers the afterAll cleanup. The relay is detached from the shared lifecycle's per-test
 *     drain: it lives for the whole FILE and dies in this file's afterAll.
 *
 *   hermeticDescribe(name, fn)
 *     The describe wrapper: guarantees the flow exists (creates the default one when the file did
 *     not call hermeticFlow itself), awaits its readiness in beforeAll, and re-asserts per-test
 *     isolation (gateway seam → private relay, POLL/convert seams, stash resets, rail overrides)
 *     AFTER the shared lifecycle's per-test resets — which re-point the gateway at the shared
 *     relay and would otherwise leak a test's point across tests.
 *
 * Zero cross-file globalThis contracts: everything this module plants lives on the file's own
 * globalThis (fresh per jest file), so worker recycling is survivable by construction.
 *
 * LOAD ORDER: this module imports ONLY flowRelay (no app graph). Files that need the
 * module-load-captured seams (the SOL RPC override) keep their seam installs in the module body
 * BEFORE the hermeticFlow()/hermeticDescribe() call — the same contract solrpc.ts documents.
 */
import {afterAll, beforeAll, beforeEach, describe} from '@jest/globals';
import {startFlowRelay, type FlowRelay} from './flowRelay';

/** The origin baked into the app the fetch rewrite re-points (app/relayConfig.ts RELAY_DEFAULT). */
const BAKED_ORIGIN = 'https://dpay.kalaj.org';

export type HermeticFlow = {
  /** The file's private relay. `baseURL` is the origin every shared-relay reference means. */
  relay: {baseURL: string; port: number};
};

type HermeticOpts = {relay?: {checkout?: boolean; faucet?: boolean; env?: Record<string, string>}};

type G = Record<string, unknown>;
const g = globalThis as unknown as G;
/** The shared relay this jest run's globalSetup spawned — the origin hermetic files LEAVE. */
const SHARED_ORIGIN = process.env.DPAY_JEST_RELAY_URL ?? '';

type Impl = HermeticFlow & {ready: Promise<FlowRelay>};
let current: Impl | null = null;

function createFlow(opts: HermeticOpts): Impl {
  snapshotSeams();
  resetStashes();
  const ready = (async (): Promise<FlowRelay> => {
    const relay = await startFlowRelay({
      checkout: opts.relay?.checkout,
      faucet: opts.relay?.faucet,
      env: opts.relay?.env,
    });
    detachFromLifecycleDrain(relay);
    await purgeStorage();
    resetModuleState();
    pointGatewayAt(relay.baseURL);
    return relay;
  })();
  installFetchRedirect(ready);
  const impl: Impl = {
    relay: {
      get baseURL(): string { throw new Error('[hermetic] the private relay is not ready — read baseURL after the flow resolved (tests/hermeticDescribe see it ready)'); },
      get port(): number { throw new Error('[hermetic] the private relay is not ready — read port after the flow resolved'); },
    },
    ready,
  };
  // Resolve the public surface once the spawn is healthy (beforeAll awaits `ready` first).
  void ready.then((r) => {
    Object.defineProperty(impl, 'relay', {value: {baseURL: r.baseURL, port: r.port}});
  });
  afterAll(async () => {
    const r = await ready.catch(() => null);
    if (r) await r.stop().catch(() => undefined);
  }, 30_000);
  return impl;
}

// --- the reset surfaces ---------------------------------------------------------------------------

/** The fast-poll + convert-engine seams setupFlow installs at module load — snapshotted so a test
 *  that stretched a cadence cannot leak the stretch into the next test of the same file. */
let pollSnapshot: Record<string, number> = {};
let convertSnapshot: Record<string, unknown> = {};

function snapshotSeams(): void {
  pollSnapshot = {...(g.__DPAY_TEST_POLL as Record<string, number> | undefined ?? {})};
  convertSnapshot = {...(g.__DPAY_TEST_CONVERT_ENGINE as Record<string, unknown> | undefined ?? {})};
}

/** The stash/override reset HERMETIC files can rely on: every assertion stash a mounted app or a
 *  scanner shim writes, plus the cadence seams, plus the rail operator overrides. Deliberately NOT
 *  touched: `__DPAY_TEST_SOLANA_RPC_URL` / `__DPAY_TEST_EVM_RPC_URL` (module-load-captured test
 *  overrides — resetting the global would lie about what the app captured), `__DPAY_SOL_ACCOUNTS`
 *  (the solrpc fixture helper, installed once at module scope by contract) and the NFC session
 *  seams (installed once by the e2e shims, not per-test state). */
function resetStashes(): void {
  for (const k of [
    '__DPAY_QR_LAST',
    '__DPAY_TEST_NFC_STATUS', '__DPAY_TEST_NFC_READER_REQUEST',
    '__DPAY_TEST_NFC_APPROVED_WIRE', '__DPAY_TEST_NFC_RESULT',
    '__DPAY_SOL_NFC_LAST', '__DPAY_SOL_REQ_LAST',
    '__DPAY_TEST_SOLANA_RPC_STUB',
    '__DPAY_TEST_DEEPLINK', '__DPAY_TEST_EVM_SIGN', '__DPAY_TEST_RNG',
    '__DPAY_TEST_CONVERT_STALE_MS', '__DPAY_TEST_BALANCE_STALE_MS', '__DPAY_TEST_BALANCE_OFFLINE_AFTER',
    '__DPAY_TEST_SOL_SEND_TIMEOUT_MS', '__DPAY_TEST_SOL_ACTIVE_WINDOW_MS', '__DPAY_TEST_SOL_GENESIS_HASH',
  ]) delete g[k];
  g.__DPAY_TEST_CLIPBOARD = '';
  (g.__DPAY_TEST_SCAN_RESET as (() => void) | undefined)?.();
  g.__DPAY_TEST_POLL = {...pollSnapshot};
  g.__DPAY_TEST_CONVERT_ENGINE = {...convertSnapshot};
}

/** Rail OPERATOR overrides + transport module state, back to the pre-wiring defaults. Lazy
 *  requires: the app graph must load under the TEST FILE's control (the solrpc load-order
 *  contract), never from this module's import. `''` clears an operator choice (never an offline
 *  switch); the ForTest resets are the modules' own documented seams. */
function resetModuleState(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {setSolanaRpcUrl} = require('../../../config/constants') as {setSolanaRpcUrl: (u: string) => void};
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {setEvmRpcUrl} = require('../../../evm/endpoints') as {setEvmRpcUrl: (u: string) => void};
    setSolanaRpcUrl('');
    setEvmRpcUrl('');
  } catch { /* the app graph is not loaded in this registry — nothing to reset */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {resetRelayAddressesForTest} = require('../../../services/relayAddresses') as {resetRelayAddressesForTest: () => void};
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {resetRelayBuildStateForTest} = require('../../../services/relay') as {resetRelayBuildStateForTest: () => void};
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {resetCheckoutRelayPinForTest} = require('../../../services/checkout') as {resetCheckoutRelayPinForTest: () => void};
    resetRelayAddressesForTest();
    resetRelayBuildStateForTest();
    resetCheckoutRelayPinForTest();
  } catch { /* same — mountApp re-runs the walk-state resets per mount anyway */ }
}

/** The storage purge goes through the ONE instance the lifecycle hands off on globalThis (the
 *  jest per-registry mock instances differ — setupFlow.ts documents the handoff). */
async function purgeStorage(): Promise<void> {
  const as = g.__DPAY_JEST_ASYNC_STORAGE as {getAllKeys: () => Promise<string[]>; removeItem: (k: string) => Promise<void>; clear: () => Promise<void>} | undefined;
  if (!as) return;
  for (const k of await as.getAllKeys()) await as.removeItem(k);
  await as.clear();
}

function pointGatewayAt(baseURL: string): void {
  g.__DPAY_TEST_IC_GATEWAY = baseURL;
}

// --- the private-origin fetch rewrite -------------------------------------------------------------

/** ONE wrapper per file, outermost: the app's baked-default origin and the run's shared-relay
 *  origin are both rewritten to THIS file's relay before the harness shim (inner) ever sees them.
 *  The rewrite happens per fetch, so module-captured URLs (a relay proxy URL captured at app
 *  module load) land on the private relay too. Records therefore carry the PRIVATE origin —
 *  assertions over the fetch ledger must match PATHS, not the shared origin. */
function installFetchRedirect(ready: Promise<FlowRelay>): void {
  const prev = globalThis.fetch.bind(globalThis);
  const rewritten = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let target: string | null = null;
    if (url === BAKED_ORIGIN || url.startsWith(BAKED_ORIGIN + '/')) target = url.slice(BAKED_ORIGIN.length);
    else if (SHARED_ORIGIN && (url === SHARED_ORIGIN || url.startsWith(SHARED_ORIGIN + '/'))) target = url.slice(SHARED_ORIGIN.length);
    if (target === null) return prev(input, init);
    const {baseURL} = await ready;
    return prev(baseURL + target, init);
  };
  globalThis.fetch = rewritten as typeof fetch;
}

/** Lift the relay out of the shared lifecycle's per-test drain list: hermetic relays outlive
 *  every test of their file and die in this file's afterAll instead. */
function detachFromLifecycleDrain(relay: FlowRelay): void {
  const live = g.__DPAY_FLOW_RELAYS__ as FlowRelay[] | undefined;
  if (!live) return;
  const i = live.indexOf(relay);
  if (i >= 0) live.splice(i, 1);
}

// --- the API --------------------------------------------------------------------------------------

export function hermeticFlow(opts: HermeticOpts = {}): HermeticFlow {
  if (current !== null) return current; // one flow per file — later callers (hermeticDescribe) reuse it
  current = createFlow(opts);
  return current;
}

/** The describe wrapper: guarantees the flow, awaits it, and re-asserts per-test isolation AFTER
 *  the shared lifecycle's beforeEach (registration order: after-env lifecycle → this). */
export function hermeticDescribe(name: string, fn: () => void): void {
  if (current === null) current = createFlow({});
  const hf = current;
  describe(name, () => {
    beforeAll(async () => {
      const r = await hf.ready;
      pointGatewayAt(r.baseURL);
    }, 30_000);
    beforeEach(async () => {
      const r = await hf.ready; // resolved long before the first test — awaited for the type
      resetStashes();
      resetModuleState();
      pointGatewayAt(r.baseURL);
    });
    fn();
  });
}
