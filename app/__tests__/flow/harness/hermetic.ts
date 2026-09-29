/**
 * hermetic.ts — the per-FILE hermetic execution model for the jest flow tier. LOCAL shim for the
 * convert-lane migration (branch flow-hermetic-convert); when the core lead lands the real
 * harness/hermetic.ts on main, integration keeps MAIN's version and this file is dropped — the
 * test-file contract is only the two exported calls:
 *
 *   hermeticFlow(opts?: { relay?: { checkout?: boolean; faucet?: boolean; env?: Record<string,string> } }): HermeticFlow
 *   hermeticDescribe(name: string, fn: () => void): void
 *
 * WHAT hermeticFlow() DOES (module-scope call, one per test file): spawns a PRIVATE test-helpers
 * relay (startFlowRelay, a free port, per-spawn knobs — checkout/faucet/env), points every
 * app-facing seam at it (the per-call `__DPAY_TEST_IC_GATEWAY` seam for /api/v2; a fetch rewrite
 * wrapper for the app's baked-origin /api/v1 traffic), re-points the test-side relay client
 * (DPAY_JEST_RELAY_URL — knobs, faucet, oracles, balances ride the SAME private relay), purges
 * AsyncStorage, resets the rail operator overrides + transport module state, and takes OWNERSHIP
 * of the relay's lifecycle (afterAll stop — the per-test afterEach drain deliberately does NOT
 * kill it: every test in the file rides the same private relay). `opts.relay.env` values may
 * carry the `{{base}}` token — substituted with the spawned relay's own base URL (flow 199's
 * DPAY_PUBLIC_ORIGIN needs its own address at spawn time, before any port is knowable).
 *
 * WHAT hermeticDescribe(name, fn) ADDS: per-test isolation on top of the root lifecycle's
 * per-test purge + seam resets — the IC gateway seam re-pointed at the private relay every test
 * (the root lifecycle resets it to the shared relay first), rail overrides off, seam stashes
 * cleared — and `await flow.ready` before the file's own beforeAll hooks (fixture knobs arm on a
 * LIVE relay). ZERO cross-file globalThis contracts: every test file spawns its own relay, jest
 * gives each file its own module registry + globalThis, and worker recycling re-runs both.
 */
import {afterAll, beforeAll, beforeEach, afterEach, describe} from '@jest/globals';
import {pickFreePort, startFlowRelay, type FlowRelay} from './flowRelay';
import {setSolanaRpcUrl} from '../../../config/constants';
import {setEvmRpcUrl} from '../../../evm/endpoints';

/** app/relayConfig.ts RELAY_DEFAULT — the baked origin the app's /api/v1 fetches target. */
const RELAY_DEFAULT_ORIGIN = 'https://dpay.kalaj.org';
/** Substituted with the spawned relay's own base URL in opts.relay.env values. */
const BASE_TOKEN = '{{base}}';

export type HermeticRelay = {base: string; port: number};
export type HermeticFlow = {ready: Promise<HermeticRelay>};
export type HermeticFlowOpts = {relay?: {checkout?: boolean; faucet?: boolean; env?: Record<string, string>}};

type Seams = Record<string, unknown>;
const g = globalThis as unknown as Seams;
/** The seam stashes a convert-style file plants and must never leak across tests (the rail
 *  OPERATOR overrides live in app modules — resetRailOverrides below reaches those). */
const SEAM_STASHES = ['__DPAY_TEST_SOLANA_RPC_STUB', '__DPAY_TEST_EVM_SIGN'];

function resetRailOverrides(): void {
  setSolanaRpcUrl('');
  setEvmRpcUrl('');
}

async function purgeAsyncStorage(): Promise<void> {
  const AS = g.__DPAY_JEST_ASYNC_STORAGE as {getAllKeys: () => Promise<string[]>; removeItem: (k: string) => Promise<void>; clear: () => Promise<void>} | undefined;
  if (!AS) return;
  for (const k of await AS.getAllKeys()) await AS.removeItem(k);
  await AS.clear();
}

type FlowImpl = {
  ready: Promise<HermeticRelay>;
  info: HermeticRelay | null;
  relay: FlowRelay | null;
};

/** The most recent hermeticFlow() in THIS test-file registry — hermeticDescribe binds to it.
 *  Module state, not globalThis: jest gives every test file its own registry, so this cannot
 *  leak across files (the zero-contract rule). */
let current: FlowImpl | null = null;

export function hermeticFlow(opts: HermeticFlowOpts = {}): HermeticFlow {
  const flow: FlowImpl = {ready: null as unknown as Promise<HermeticRelay>, info: null, relay: null};

  // The fetch rewrite: baked-origin /api/v1 app traffic → the private relay, ON TOP of the
  // harness's own recording rewrite (setupFlow installed first, so this wrapper sees the app's
  // ORIGINAL url strings and the recording ledger still sees the private origin). Installed once
  // per file registry; it dies with the file's environment.
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (flow.info != null && url.startsWith(RELAY_DEFAULT_ORIGIN)) {
      return prevFetch(flow.info.base + url.slice(RELAY_DEFAULT_ORIGIN.length), init);
    }
    return prevFetch(input as RequestInfo, init);
  }) as typeof fetch;

  // Owning teardown: the private relay stops ONCE, at file end (idempotent), regardless of how
  // many hermeticDescribe calls or failures ran. Registered at the file root so even a file that
  // never calls hermeticDescribe cannot leak its relay into the worker.
  afterAll(async () => {
    try { await flow.relay?.stop(); } catch { /* the file's own verdicts already name a dead relay */ }
  });

  flow.ready = (async (): Promise<HermeticRelay> => {
    // {{base}} substitution needs the port BEFORE the spawn — pick it here, pass it through.
    const port = await pickFreePort();
    const base = `http://127.0.0.1:${port}`;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.relay?.env ?? {})) env[k] = v.split(BASE_TOKEN).join(base);
    const relay = await startFlowRelay({port, checkout: opts.relay?.checkout, faucet: opts.relay?.faucet, env});
    // Take OWNERSHIP: startFlowRelay registered the relay on the harness's per-test afterEach
    // drain list — a hermetic relay must survive every test in its file, so splice it off. The
    // list is harness-owned globalThis state within THIS file's environment (never a cross-file
    // contract); the real main-side hermetic owns its relay without this detach.
    const drain = g.__DPAY_FLOW_RELAYS__ as FlowRelay[] | undefined;
    if (Array.isArray(drain)) {
      const i = drain.indexOf(relay);
      if (i >= 0) drain.splice(i, 1);
    }
    flow.relay = relay;
    flow.info = {base: relay.baseURL, port: relay.port};
    // Every seam the app and the test side read now points at THIS file's relay:
    process.env.DPAY_JEST_RELAY_URL = relay.baseURL; // relayClient: knobs, faucet, oracles, balances
    g.__DPAY_TEST_IC_GATEWAY = relay.baseURL; // app /api/v2 boundary (INV-9)
    await purgeAsyncStorage();
    resetRailOverrides();
    return flow.info;
  })();

  current = flow;
  return flow;
}

export function hermeticDescribe(name: string, fn: () => void): void {
  const flow = current;
  if (flow == null) throw new Error('[hermetic] hermeticDescribe called before hermeticFlow()');
  describe(name, () => {
    // FIRST hook of the file's describe: the private relay is healthy (and every seam pointed)
    // before the file's own beforeAll arms its knobs. Hook timeout inherits the budget-scaled
    // per-test ceiling (the spawn probes health on its own budget-scaled deadline).
    beforeAll(async () => {
      await flow.ready;
    });
    beforeEach(async () => {
      if (flow.info == null) await flow.ready;
      // The root lifecycle's beforeEach just reset the IC gateway seam to the SHARED relay and
      // purged storage — re-point the seam at THIS file's relay (the app boots after this).
      g.__DPAY_TEST_IC_GATEWAY = flow.info!.base;
      resetRailOverrides();
      for (const k of SEAM_STASHES) delete g[k];
    });
    afterEach(async () => {
      // Inner-first relative to the root lifecycle's afterEach: stub wrappers unwind and the
      // rail overrides close BEFORE the lifecycle drains mounts and asserts the fetch ledger.
      resetRailOverrides();
      for (const k of SEAM_STASHES) delete g[k];
    });
    fn();
  });
}
