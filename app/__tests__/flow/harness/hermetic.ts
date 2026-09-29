/**
 * hermetic.ts — the flow tier's per-file execution model. One file = ONE PRIVATE test relay +
 * zero cross-file globalThis contracts. A recycled worker cannot break a file, because the file
 * re-derives its entire world (relay, storage, seams) from this module.
 *
 * WHAT IS ACTUALLY SHARED ACROSS FILES (and therefore what this module neutralizes):
 *   - the globalSetup relay (the OLD shared world) — a hermetic file never talks to it: the IC
 *     gateway seam, the fetch rewrite and the walk all point at THIS file's relay before the
 *     first mount, and the app's persisted relay list is planted to match;
 *   - `globalThis.__DPAY_JEST_ASYNC_STORAGE` (the ONE AsyncStorage instance) — purged here and
 *     per-test by the lifecycle (belt and braces; the instance itself is per-file anyway);
 *   - NOTHING ELSE: every other seam stash is per-file globalThis and dies with the file — the
 *     explicit resets below are belt-and-suspenders against future shared instances.
 *
 * USAGE (module scope of a flow file, before any describe):
 *   import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
 *   const hf = hermeticFlow();                    // spawns THIS file's relay (async, pipelined)
 *   hermeticDescribe('flow N — …', () => {        // beforeAll awaits readiness; body unchanged
 *     it('…', async () => {
 *       const {baseURL} = await hf.ready;         // for /api/v1/test/* knobs
 *       …
 *     });
 *   });
 *
 * The per-test lifecycle (storage purge, seam resets, fail-closed fetch assertion) stays exactly
 * as it was — hermetic files keep it for free.
 */
import {afterAll, beforeAll, describe} from '@jest/globals';
import {pickFreePort, startFlowRelay, type FlowRelay} from './flowRelay';
import {resetPageEventListeners} from './setupFlow';

/** Substituted with the spawned relay's own base URL in `opts.relay.env` values — flow 199's
 *  DPAY_PUBLIC_ORIGIN needs the relay's OWN address at spawn time (the webhook registration is
 *  built from it before any port is otherwise knowable to the file). */
const BASE_TOKEN = '{{base}}';

export type HermeticRelayInfo = {baseURL: string; port: number};

export type HermeticFlow = {
  /** Resolves once THIS file's relay is spawned and /api/v1/health answered. */
  ready: Promise<HermeticRelayInfo>;
  /** The private relay handle (present after `ready`; the afterAll stops it). */
  relay: Promise<FlowRelay>;
  /** The private relay's base URL — '' until `ready` resolves; every test context runs after. */
  get baseURL(): string;
  /** Idempotent wiring — hermeticDescribe calls this in beforeAll; files may too. */
  ensureWired: () => Promise<HermeticRelayInfo>;
};

type HermeticOpts = {
  relay?: {checkout?: boolean; faucet?: boolean; env?: Record<string, string>};
};

type G = {
  __DPAY_FLOW_HERMETIC_RELAY__?: string;
  __DPAY_FLOW_HERMETIC_READY__?: Promise<HermeticRelayInfo>;
  __DPAY_FLOW_HERMETIC_RELAY_HANDLE__?: Promise<FlowRelay>;
  __DPAY_FLOW_HERMETIC_STOP__?: (() => Promise<void>) | null;
  __DPAY_JEST_ASYNC_STORAGE?: {getAllKeys: () => Promise<string[]>; removeItem: (k: string) => Promise<void>; clear: () => Promise<void>; setItem: (k: string, v: string) => Promise<void>};
  __DPAY_TEST_SCAN_RESET?: () => void;
  __DPAY_QR_LAST?: unknown;
  __DPAY_TEST_NFC_READER_REQUEST?: unknown;
  __DPAY_TEST_NFC_STATUS?: unknown;
  __DPAY_TEST_NFC_APPROVED_WIRE?: unknown;
  __DPAY_TEST_NFC_RESULT?: unknown;
  __DPAY_SOL_NFC_LAST?: unknown;
  __DPAY_SOL_REQ_LAST?: unknown;
  __DPAY_TEST_CLIPBOARD?: string;
  __DPAY_FLOW_ALLOWED_DEAD_ORIGINS__?: Set<string>;
  __DPAY_FLOW_FETCH_RECORDS__?: unknown[];
  __DPAY_LOG_TAIL?: string[];
  __DPAY_TEST_IC_GATEWAY?: string;
};

const g = globalThis as unknown as G;

async function purgeStorage(): Promise<void> {
  const AS = g.__DPAY_JEST_ASYNC_STORAGE;
  if (!AS) return;
  for (const k of await AS.getAllKeys()) await AS.removeItem(k);
  await AS.clear();
}

/** Belt-and-suspenders seam reset — everything that could conceivably cross a boundary. */
function resetSeams(): void {
  g.__DPAY_QR_LAST = undefined;
  g.__DPAY_TEST_NFC_READER_REQUEST = undefined;
  g.__DPAY_TEST_NFC_STATUS = undefined;
  g.__DPAY_TEST_NFC_APPROVED_WIRE = undefined;
  g.__DPAY_TEST_NFC_RESULT = undefined;
  g.__DPAY_SOL_NFC_LAST = undefined;
  g.__DPAY_SOL_REQ_LAST = undefined;
  g.__DPAY_TEST_CLIPBOARD = '';
  (g.__DPAY_TEST_SCAN_RESET as (() => void) | undefined)?.();
  resetPageEventListeners();
  g.__DPAY_FLOW_ALLOWED_DEAD_ORIGINS__?.clear();
  if (g.__DPAY_FLOW_FETCH_RECORDS__) (g.__DPAY_FLOW_FETCH_RECORDS__ as unknown[]).length = 0;
  if (g.__DPAY_LOG_TAIL) (g.__DPAY_LOG_TAIL as string[]).length = 0;
}

/**
 * Spawn THIS file's relay now (module scope) and return the handle. One relay per file — the
 * spawn is pipelined (no await at module scope); `hermeticDescribe`'s beforeAll awaits
 * readiness before the first test runs, and the wiring (gateway seam, persisted relay list,
 * storage purge, seam reset) happens there, in order, before any mount.
 */
export function hermeticFlow(opts: HermeticOpts = {}): HermeticFlow {
  if (g.__DPAY_FLOW_HERMETIC_STOP__) {
    // Already spawned for this file (module scope + hermeticDescribe both call this).
    const relay = g.__DPAY_FLOW_HERMETIC_RELAY_HANDLE__!;
    return {
      ready: g.__DPAY_FLOW_HERMETIC_READY__!,
      relay,
      get baseURL() { return g.__DPAY_FLOW_HERMETIC_RELAY__ ?? ''; },
      ensureWired: wire,
    };
  }
  const relayP: Promise<FlowRelay> = pickFreePort().then((port) => startFlowRelay({
    port,
    ownLifecycle: true, // the file's own afterAll stops it — NOT the per-test teardown list
    checkout: opts.relay?.checkout,
    faucet: opts.relay?.faucet,
    env: opts.relay?.env == null
      ? undefined
      : Object.fromEntries(Object.entries(opts.relay.env).map(([k, v]) => [k, v.split(BASE_TOKEN).join(`http://127.0.0.1:${port}`)])),
  }));
  const readyP = relayP.then(async (relay) => {
    // The ONE wiring point: gateway seam + fetch-rewrite target + the app's persisted relay
    // list (storage) — then a clean world: storage purge, seam reset. Boot (per mount) re-reads
    // the planted list; resetSessionModuleState re-derives module state per mount.
    g.__DPAY_FLOW_HERMETIC_RELAY__ = relay.baseURL;
    // The resolved handle, for SYNC readers (the driver's stall trap can't await a Promise).
    (g as unknown as {__DPAY_FLOW_HERMETIC_RELAY_OBJ__?: FlowRelay}).__DPAY_FLOW_HERMETIC_RELAY_OBJ__ = relay;
    g.__DPAY_TEST_IC_GATEWAY = relay.baseURL;
    const AS = g.__DPAY_JEST_ASYNC_STORAGE;
    if (AS) {
      for (const k of await AS.getAllKeys()) await AS.removeItem(k);
      await AS.clear();
    }
    // LAZY require — never a static import: config/constants CAPTURES `__DPAY_TEST_SOLANA_RPC_URL`
    // at its module load, and a static import here would load it at the hermetic import — BEFORE
    // the importing file's body could set the SOL seam (the solrpc.ts load-order contract: the
    // file sets the seam, THEN loads the app graph). Every SOL flow file died on exactly this
    // (rail captured '', observed 2026-09-29 gate2: 34 suites red, every SOL-rail flow among
    // them). At wire time the file body has long finished, so the capture sees the seam.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {RELAY_LIST_STORAGE_KEY} = require('../../../config/constants') as {RELAY_LIST_STORAGE_KEY: string};
    await AS?.setItem(RELAY_LIST_STORAGE_KEY, JSON.stringify([relay.baseURL]));
    resetSeams();
    return {baseURL: relay.baseURL, port: relay.port};
  });
  const stop = async (): Promise<void> => {
    g.__DPAY_FLOW_HERMETIC_RELAY__ = undefined;
    (g as unknown as {__DPAY_FLOW_HERMETIC_RELAY_OBJ__?: FlowRelay}).__DPAY_FLOW_HERMETIC_RELAY_OBJ__ = undefined;
    g.__DPAY_FLOW_HERMETIC_STOP__ = null;
    try {
      const r = await relayP;
      await r.stop();
    } catch { /* a spawn that never came up has nothing to stop */ }
  };
  g.__DPAY_FLOW_HERMETIC_READY__ = readyP;
  g.__DPAY_FLOW_HERMETIC_RELAY_HANDLE__ = relayP;
  g.__DPAY_FLOW_HERMETIC_STOP__ = stop;
  // File-level cleanup: the relay dies AFTER the file's last test (never per-test — it is the
  // file's world), and the storage drain barrier closes the late-writer window one last time.
  afterAll(async () => {
    await purgeStorage();
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setImmediate(r));
      const keys = await g.__DPAY_JEST_ASYNC_STORAGE?.getAllKeys() ?? [];
      if (keys.length === 0) break;
      await purgeStorage();
    }
    await stop();
  });
  return {
    ready: readyP,
    relay: relayP,
    get baseURL() { return g.__DPAY_FLOW_HERMETIC_RELAY__ ?? ''; },
    ensureWired: wire,
  };
}

async function wire(): Promise<HermeticRelayInfo> {
  // Idempotent re-wiring for files that call ensureWired() manually (e.g. a beforeAll that
  // re-planted storage and needs the seams re-pointed).
  const info = await (g.__DPAY_FLOW_HERMETIC_READY__ as Promise<HermeticRelayInfo>);
  g.__DPAY_FLOW_HERMETIC_RELAY__ = info.baseURL;
  g.__DPAY_TEST_IC_GATEWAY = info.baseURL;
  return info;
}

/**
 * The describe wrapper: guarantees the file's hermetic world is wired before the first test
 * (awaiting relay readiness in beforeAll) and registers the file cleanup. The body is the
 * plain describe body — its its/inner-describes run unchanged under the existing lifecycle.
 */
export function hermeticDescribe(name: string, fn: () => void): void {
  hermeticFlow();
  describe(name, () => {
    beforeAll(() => wire());
    fn();
  });
}
