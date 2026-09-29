/**
 * hermetic.ts — LOCAL LANE SHIM (lane nfc) for the core lead's harness/hermetic.ts. API is the
 * spec, verbatim; when main lands the real file, integration keeps main's version and this one
 * is deleted. Everything a hermetic file may rely on is exactly these two entry points:
 *
 *   hermeticFlow(opts?: { relay?: { checkout?: boolean; faucet?: boolean; env?: Record<string,string> } }): HermeticFlow
 *   hermeticDescribe(name: string, fn: () => void): void
 *
 * What a module-scope `hermeticFlow()` owns for the FILE:
 *   • ONE private relay — startFlowRelay (free port, per-spawn knobs), spawned at call time so
 *     startup overlaps collection; readiness is awaited by the first hermeticDescribe hook.
 *   • The app world pointed at it: the IC gateway seam (`__DPAY_TEST_IC_GATEWAY`, per-call read)
 *     re-pointed per test, and the venue registry — the persisted relay list `dpay.relays.v1`
 *     (services/relayAddresses.ts) — planted with the private base per test, so a mount wires
 *     the walk + the SOL/EVM derivations to the private relay and NOTHING reaches the shared
 *     relay or the baked default.
 *   • The harness HTTP oracles follow too: `process.env.DPAY_JEST_RELAY_URL` is swapped to the
 *     private base for the file's lifetime and restored in afterAll. relayClient's
 *     relayBaseURL() reads it PER CALL, so lib's faucetAccount/getBalance/icpCatalog/railTransfer
 *     (which take no baseURL) and every file-side `${process.env.DPAY_JEST_RELAY_URL}` fetch hit
 *     the private relay with zero per-file churn — the only lever that does not require harness
 *     edits. Restore-on-teardown keeps later files on the same worker unaffected; every hermetic
 *     file re-swaps at its own module load, so worker recycling stays survivable (no file ever
 *     READS another file's value — each writes its own before any use).
 *   • afterAll cleanup: relay stopped (idempotent), env restored.
 *
 * hermeticDescribe layers per-test isolation AFTER the shared lifecycle (jest.flow-after-env.js
 * registers it at root level, so its beforeEach runs FIRST): by the time this hook runs, the
 * shared lifecycle has already purged storage and reset the seams to the SHARED relay — this hook
 * re-points the private world and re-plants the registry the purge just wiped. No duplicate
 * purge: nothing runs between the two hooks. Seam stashes are reset again here regardless (the
 * hermetic tier owns isolation, not the shared lifecycle).
 *
 * Import discipline: this module must NOT import ../lib or anything under app/config — lib pulls
 * the whole app graph, and constants.ts/endpoints.ts capture `__DPAY_TEST_SOLANA_RPC_URL` /
 * `__DPAY_TEST_EVM_RPC_URL` at MODULE LOAD. The lazy `solEnv()` / `evmEnv()` files set those
 * seams only inside test bodies; an early constants load here would freeze their overrides at ''
 * and silently kill the SOL/EVM lanes. Hence the one literal below (RELAY_LIST_STORAGE_KEY,
 * app/config/constants.ts) and lazy requires everywhere.
 */
import {afterAll, beforeEach, describe} from '@jest/globals';
import {startFlowRelay, type FlowRelay} from './flowRelay';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {installFlowLifecycle} = require('./setupFlow') as {installFlowLifecycle: () => void};

export type HermeticRelayOpts = {checkout?: boolean; faucet?: boolean; env?: Record<string, string>};

/** The handle a file gets back. The private base travels through the swapped
 *  `process.env.DPAY_JEST_RELAY_URL` (the documented channel above); `ready()` resolves with the
 *  spawned relay for the rare file that must await it outside a test body. */
export type HermeticFlow = {ready: () => Promise<FlowRelay>};

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

/** `dpay.relays.v1` — RELAY_LIST_STORAGE_KEY (app/config/constants.ts). Literal on purpose: see
 *  the import-discipline note above. */
const RELAY_LIST_KEY = 'dpay.relays.v1';

// The canonical fast-cadence seams (setupFlow.ts §1; not exported there — duplicated verbatim,
// this file may not edit the frozen harness). Reset per test so a file that shrank a cadence
// mid-test cannot leak the shrink into its own later tests.
const CANON_POLL: Record<string, number> = {
  balance: 100, history: 100, deposit: 100, receiptPay: 100, receiptRcv: 100, request: 100,
  balanceIdle: 100, historyIdle: 100,
};
const CANON_CONVERT_ENGINE: Record<string, unknown> = {
  rearmMs: 500, stuckWatchMs: 2000, providerPollMs: 500,
  executorOpts: {submitAttempts: 3, poll: {attempts: 4, intervalMs: 100}, settleAttempts: 10, settleIntervalMs: 100},
};

type State = {
  relayEnvBackup: string | undefined;
  relay: Promise<FlowRelay>;
  opts: {checkout?: boolean; faucet?: boolean; env?: Record<string, string>};
};

// Per-FILE state: hermetic.ts loads once per test-file module registry, so this module-level
// singleton is one hermetic world per file — never shared across files.
let state: State | null = null;

function init(opts: {relay?: HermeticRelayOpts} = {}): State {
  // The lifecycle is guaranteed by jest.flow-after-env.js; self-register too (idempotent) so a
  // hermetic file stays self-sufficient if the after-env wiring ever changes (the h.ts doctrine).
  installFlowLifecycle();

  const relayOpts = opts.relay ?? {};
  // ENV SWAP FIRST: anything resolved later in this file's lifetime (lib helpers, file fetches)
  // must resolve to the private relay, never the shared one.
  const relayEnvBackup = process.env.DPAY_JEST_RELAY_URL;
  // Kick the spawn off now; the first hermeticDescribe hook absorbs the startup wait.
  const relay = startFlowRelay({
    checkout: relayOpts.checkout,
    faucet: relayOpts.faucet,
    env: relayOpts.env,
  });
  // Keep OUR relay OFF the shared per-test drain list: the frozen lifecycle's afterEach stops
  // everything registered on __DPAY_FLOW_RELAYS__, which would kill this file's relay after the
  // first test. Splice it out as soon as the spawn resolves; afterAll stops it instead. The same
  // resolution lands the ENV SWAP: the private base only exists once the spawn picked its port.
  relay.then((r) => {
    const list = g.__DPAY_FLOW_RELAYS__ as FlowRelay[] | undefined;
    const i = list ? list.indexOf(r) : -1;
    if (i >= 0) list!.splice(i, 1);
    process.env.DPAY_JEST_RELAY_URL = r.baseURL;
  }).catch(() => { /* surfaces through the hook await */ });

  afterAll(async () => {
    state = null;
    try { await relay.then((r) => r.stop()).catch(() => undefined); } finally {
      process.env.DPAY_JEST_RELAY_URL = relayEnvBackup;
    }
  });

  return {relayEnvBackup, relay, opts: relayOpts};
}

async function ready(): Promise<FlowRelay> {
  if (state == null) state = init();
  return state.relay;
}

/** The per-test hermetic hook body — also the honest list of what "isolation" means here. */
async function hermeticBeforeEach(): Promise<void> {
  const relay = await ready();

  // 1. The IC gateway seam → private. The shared lifecycle's beforeEach reset it to the SHARED
  //    relay one hook earlier; this re-point is the whole hermetic premise for /api/v2.
  g.__DPAY_TEST_IC_GATEWAY = relay.baseURL;

  // 2. Seam stashes (stashes only — never the seam FUNCTIONS: the NFC sessions, listener
  //    counters and scan registry accessors are installed by the shims and are read-only to us).
  g.__DPAY_TEST_CLIPBOARD = '';
  g.__DPAY_QR_LAST = undefined;
  g.__DPAY_TEST_NFC_STATUS = undefined;
  g.__DPAY_TEST_NFC_READER_REQUEST = undefined;
  g.__DPAY_TEST_NFC_APPROVED_WIRE = undefined;
  g.__DPAY_TEST_NFC_RESULT = undefined;
  g.__DPAY_SOL_NFC_LAST = undefined;
  g.__DPAY_SOL_REQ_LAST = undefined;
  (g.__DPAY_TEST_SCAN_RESET as (() => void) | undefined)?.();
  g.__DPAY_TEST_POLL = {...CANON_POLL};
  g.__DPAY_TEST_CONVERT_ENGINE = {...CANON_CONVERT_ENGINE};

  // 3. Plant the venue registry with the private base. The shared lifecycle's purge (one hook
  //    earlier) wiped it; the plant must land before the body mounts, because App.tsx's boot
  //    effect wires the walk + the SOL/EVM derivations from this list in the same tick.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AS = require('@react-native-async-storage/async-storage') as {
    setItem: (k: string, v: string) => Promise<void>;
  };
  await AS.setItem(RELAY_LIST_KEY, JSON.stringify([relay.baseURL]));
}

/** The spec's describe wrapper: identical describe, plus the hermetic per-test hook above. */
export function hermeticDescribe(name: string, fn: () => void): void {
  describe(name, () => {
    beforeEach(hermeticBeforeEach);
    fn();
  });
}

/** The spec's module-scope entry point. Idempotent per file: a second call returns the first
 *  call's world (per-file opts are the contract; later calls pass identical opts). */
export function hermeticFlow(opts: {relay?: HermeticRelayOpts} = {}): HermeticFlow {
  if (state == null) state = init(opts);
  return {ready};
}
