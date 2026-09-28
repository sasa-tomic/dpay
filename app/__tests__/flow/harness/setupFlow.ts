/**
 * Flow-harness environment installer — runs ONCE per test file (setupFiles re-execute per file,
 * which is exactly the isolation boundary jest gives us) and mounts the e2e web seam set onto
 * the jest runtime BEFORE any test file imports `../App`. Mount order mirrors `e2e/web/shims.ts`
 * (the proven seam order); the seam NAMES are preserved verbatim so ported flows read the same
 * globals they read in the browser.
 *
 * The only re-expressed code is the fetch rewrite (~20 lines, cited below); the wasm core, the
 * NFC shims, and the scan registry are LITERALLY the e2e fixtures (required here, not copied).
 * e2e/harness/*.mjs stays untouched (frozen) and unimported from jest — babel's CJS transform
 * breaks its `import.meta.url`; requiring e2e/web/*.ts is the proven precedent
 * (dpay-core-wasm-timeout.test.ts).
 */
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {jest} from '@jest/globals';
import {NativeModules, Share} from 'react-native';
import {scaled as budgetScaled} from './budget';

const here = dirname(__filename); // app/__tests__/flow/harness
const appRoot = join(here, '..', '..', '..'); // app/
const repoRoot = join(appRoot, '..');
/** app/relayConfig.ts RELAY_DEFAULT — the origin baked into the app the fetch rewrite re-points. */
const RELAY_DEFAULT_ORIGIN = 'https://dpay.kalaj.org';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

// --- 0. web-ish runtime surface -----------------------------------------------------------------
// The RN jest preset runs a NODE environment (no window/document). The app's web branches are all
// capability-guarded (`typeof globalThis.location === 'undefined'` etc.), so aliasing window →
// globalThis simply lets the e2e shims' `typeof window !== 'undefined'` guards and seam stashes
// behave like the browser's.
if ((globalThis as unknown as {window?: unknown}).window === undefined) {
  g.window = globalThis;
}

// The flow tier drives the app with SYNC act + plain-sleep poll loops (async act awaits the app's
// perpetual poll chains and hangs), so background poll renders legitimately happen outside act.
// React's per-update act warning is the expected noise of that design — drop exactly that line,
// keep every other console.error (the app's log sink wraps these later and forwards to it).
const rawConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === 'string' && (first.includes('not wrapped in act') || first.includes('inside a test was not wrapped in act'))) {
    return;
  }
  rawConsoleError(...args);
};

// The app's URL surface (deepLink.ts, useWalletHistory.ts) is Platform.OS-gated web-only. The RN
// preset defaults to 'ios', which would make every URL flow inert. The flow tier runs the app AS
// THE WEB APP (exactly what the e2e browser drives): Platform.OS = 'web', with the location +
// history stub below carrying the real routing code. Everything the 'web' branch touches is
// capability-guarded (navigator/matchMedia/ethereum degrade to their guarded fallbacks).
jest.mock('react-native/Libraries/Utilities/Platform', () => {
  const mod = jest.requireActual('react-native/Libraries/Utilities/Platform') as Record<string, unknown> & {__esModule?: boolean; default?: Record<string, unknown>};
  const base = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;
  // Copy via property DESCRIPTORS so Platform's getter-defined props (isPad, Version, …) stay
  // lazy instead of being invoked at mock time, then flip the OS.
  const mocked = Object.create(Object.getPrototypeOf(base ?? {}), Object.getOwnPropertyDescriptors(base ?? {})) as Record<string, unknown> & Record<string, any>;
  mocked.OS = 'web';
  if (typeof mocked.select !== 'function') {
    mocked.select = (spec: Record<string, unknown>) => spec['web'];
  }
  // Mirror the REAL module's export shape ({default} + __esModule — consumers do
  // `require('…/Platform').default`), so both named and default import styles keep working.
  if (mod && typeof mod === 'object' && mod.__esModule) {
    return {...mod, __esModule: true, default: mocked};
  }
  return {__esModule: true, default: mocked};
});

// --- 1. fast-poll + convert-engine seams (read at app module load — set BEFORE ../App) ----------
g.__DPAY_TEST_POLL = {
  balance: 25, history: 25, deposit: 25, receiptPay: 25, receiptRcv: 25, request: 25,
  // Idle cadences collapsed onto the active ones, same intent as the e2e driver (wall-clock
  // request budgets are meaningless under test cadences; the cadence-independent invariants are
  // what flows pin).
  balanceIdle: 25, historyIdle: 25,
};
// Convert engine shrink seams (app/convert/execute.ts) — the honest-pending/resume invariants at
// ~100ms probe cadence instead of prod's seconds; the prod defaults stay pinned as the ?? fallbacks.
g.__DPAY_TEST_CONVERT_ENGINE = {
  rearmMs: 500, stuckWatchMs: 2000, providerPollMs: 500,
  executorOpts: {submitAttempts: 3, poll: {attempts: 4, intervalMs: 100}, settleAttempts: 10, settleIntervalMs: 100},
};

// --- 2. the REAL wasm core via the documented Node injection seam --------------------------------
// Byte-identical to what e2e-on-web loads (the committed asset `just wasm-core` drift-checks).
const WASM_PATH = join(repoRoot, 'crates', 'dpay-relay', 'assets', 'dpay-core.wasm');
g.__DPAY_WASM_BYTES = new Uint8Array(readFileSync(WASM_PATH));
// (require, not import: keeps tsc's app program off the e2e tree — the
// dpay-core-wasm-timeout.test.ts precedent.)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {DpayCore} = require(join(repoRoot, 'e2e', 'web', 'dpay-core-wasm')) as {DpayCore: unknown};
export {DpayCore};
// services/native.ts destructures NativeModules ONCE at its module load; setupFiles run before
// any test-file import of ../App, so this assignment is what App sees.
(NativeModules as unknown as G).DpayCore = DpayCore;

// --- 3. NFC shims — the e2e web event-bus shims, verbatim ----------------------------------------
// They install NativeModules.DpayNfc / DpaySolNfc and the fail-loud __DPAY_TEST_NFC_SESSION /
// __DPAY_TEST_SOL_NFC_SESSION seams. Their `NativeEventEmitter` import resolves to react-native
// (the flow project's react-native-web→react-native mapper), whose module-level
// RCTDeviceEventEmitter singleton is the SAME bus the app's listeners register on — the exact
// wiring the RNW browser build gives them.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {DpayNfc, installNfcSeam} = require(join(repoRoot, 'e2e', 'web', 'dpay-nfc')) as {DpayNfc: unknown; installNfcSeam: (scope: G) => void};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {DpaySolNfc, installSolNfcSeam} = require(join(repoRoot, 'e2e', 'web', 'dpay-sol-nfc')) as {DpaySolNfc: unknown; installSolNfcSeam: (scope: G) => void};
(NativeModules as unknown as G).DpayNfc = DpayNfc;
(NativeModules as unknown as G).DpaySolNfc = DpaySolNfc;
installNfcSeam(g);
installSolNfcSeam(g);

// --- 4. Share/clipboard recorder ----------------------------------------------------------------
// Platform.OS is 'web' here, so app/lib/clipboard.ts prefers navigator.clipboard (absent in the
// node env) and falls through to Share.share — which this recorder captures into
// __DPAY_TEST_CLIPBOARD (same seam name as e2e/web/shims.ts). Installed unconditionally,
// regardless of the preset's mocks.
g.__DPAY_TEST_CLIPBOARD = '';
(Share as unknown as {share: unknown}).share = async (opts?: {message?: string; url?: string}) => {
  const msg = opts && typeof opts.message === 'string' ? opts.message : (opts && opts.url) || '';
  g.__DPAY_TEST_CLIPBOARD = msg;
  return {action: 'sharedAction'};
};

// --- 5. fetch rewrite + request/failure recorder (the e2e fail-closed rule) ----------------------
// The app targets the BAKED default origin (app/relayConfig.ts; jest has no `?relay=` override).
// Every request is rewritten to the ONE relay globalSetup spawned, and every outcome is recorded;
// teardown fails a test whose fetches died against an origin it did not pre-declare
// (`driver.allowRequestFailuresFrom`), preserving "browser errors fail closed".
const relayURL = process.env.DPAY_JEST_RELAY_URL;
if (!relayURL || !relayURL.startsWith('http')) {
  throw new Error(
    '[flow-harness] DPAY_JEST_RELAY_URL is not set — the flow globalSetup (jest.relay-setup.js) ' +
    'did not run or failed. Run the flow project via `just flow` (or check the relay build: ' +
    'the e2e message applies — the relay binary lives in .dev/target-e2e/debug/).',
  );
}
g.__DPAY_TEST_IC_GATEWAY = relayURL; // the IC boundary (app/services/icp.ts, INV-9) → fake-IC gateway
export type FetchRecord = {url: string; origin: string; ok: boolean; status: number; error?: string};

// ONE shim, ONE ledger — on globalThis. This module loads in EVERY jest module registry
// (setupFile, afterEnv, and every test file's import); a module-level records array would be a
// per-registry instance, so the lifecycle (afterEnv) could assert a DIFFERENT ledger than the
// outermost shim writes, and each registry's load would re-wrap globalThis.fetch (a triple-shim
// stack, triple-recording every request). Guarded install + global structures make the recorder
// identity- and registry-proof.
type FetchG = {
  __DPAY_FLOW_FETCH_SHIM__?: boolean;
  __DPAY_FLOW_FETCH_RECORDS__?: FetchRecord[];
  __DPAY_FLOW_ALLOWED_DEAD_ORIGINS__?: Set<string>;
};
const fg = globalThis as unknown as FetchG;
const fetchRecords: FetchRecord[] = (fg.__DPAY_FLOW_FETCH_RECORDS__ ??= []);
const allowedDeadOrigins: Set<string> = (fg.__DPAY_FLOW_ALLOWED_DEAD_ORIGINS__ ??= new Set<string>());
const originOf = (url: string): string => {
  try { return new URL(url).origin; } catch { return url; }
};
if (!fg.__DPAY_FLOW_FETCH_SHIM__) {
  fg.__DPAY_FLOW_FETCH_SHIM__ = true;
  const realFetch = globalThis.fetch.bind(globalThis);
  // The harness's own probe channel (flowRelay.ts health polls): the shim records everything it
  // carries, and a relay's not-yet-up health probe is not an app request — never a recordable
  // failure. Stashed here because this is the last point where the unrecorded fetch is reachable.
  (g as unknown as {__DPAY_TEST_RAW_FETCH?: typeof fetch}).__DPAY_TEST_RAW_FETCH = realFetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const target = url.startsWith(RELAY_DEFAULT_ORIGIN)
      ? relayURL + url.slice(RELAY_DEFAULT_ORIGIN.length)
      : url;
    // The e2e driver's offline sentinels (`'stub'` — solrpc.ts's SOL sentinel) are not origins:
    // the fetch rejects exactly as it did unfixed, but the fail-closed ledger only ever recorded
    // REAL origins, so a non-URL is not a recordable request.
    const recordable = /^https?:\/\//i.test(url);
    try {
      const res = await realFetch(target, init);
      if (recordable) fetchRecords.push({url, origin: originOf(url), ok: res.ok, status: res.status});
      return res;
    } catch (e) {
      if (recordable) fetchRecords.push({url, origin: originOf(url), ok: false, status: 0, error: e instanceof Error ? e.message : String(e)});
      throw e;
    }
  }) as typeof fetch;
} else {
  // A later-registry load must not downgrade the probe channel either (it is already installed).
  (g as unknown as {__DPAY_TEST_RAW_FETCH?: typeof fetch}).__DPAY_TEST_RAW_FETCH ??= globalThis.fetch;
}

export function allowRequestFailuresFrom(url: string): void {
  allowedDeadOrigins.add(originOf(url));
}
export function fetchFailureRecords(): FetchRecord[] {
  return fetchRecords.filter((r) => !r.ok);
}
function assertNoUndeclaredFailures(): void {
  // The rule is TRANSPORT-ONLY — the honest port of the e2e gate, which flags browser network
  // errors (ERR_CONNECTION_REFUSED …) and never an HTTP status: a 4xx/5xx ANSWER (the faucet's
  // 422 cooldown refusal, the walk's probe 404s) is the app's own handled contract. So: a record
  // with an `error` (fetch threw — the origin never answered) is the flagged class.
  // AbortError is the app aborting its OWN in-flight poll (unmount/remount/timeout) — the e2e
  // harness ignores net::ERR_ABORTED for exactly this reason; a transport failure to a dead
  // origin is a different error class and stays flagged.
  const undeclared = fetchRecords.filter((r) => r.error !== undefined && !/abort/i.test(r.error) && !allowedDeadOrigins.has(r.origin));
  if (undeclared.length > 0) {
    const lines = [...new Set(undeclared.map((r) => `${r.url} — ${r.error}`))];
    throw new Error(
      '[flow-harness] unexpected failed request(s) — a dead origin must be pre-declared with ' +
      `driver.allowRequestFailuresFrom(origin):\n${lines.map((l) => `  - ${l}`).join('\n')}`,
    );
  }
}

// --- 6. location/history stub (the URL surface flows 49/50/161/175 port against) ----------------
// Minimal, honest: the app's own routing code (useWalletHistory + deepLink) runs against it
// unmodified — pushState entries, popstate replay on back(), foreign query params preserved.
type Loc = {href: string; origin: string; pathname: string; search: string};
const LOCATION_ORIGIN = 'http://localhost';
const historyStack: string[] = ['/'];
let historyIndex = 0;
const eventListeners: Record<string, Array<(e?: unknown) => void>> = {};
const fire = (type: string, e?: unknown) => {
  for (const fn of eventListeners[type] ?? []) {
    try { fn(e); } catch { /* a bad listener must not break the others */ }
  }
};
const parseEntry = (u: string): {pathname: string; search: string} => {
  const q = u.indexOf('?');
  return q === -1 ? {pathname: u, search: ''} : {pathname: u.slice(0, q), search: u.slice(q)};
};
const syncLocation = (): void => {
  const {pathname, search} = parseEntry(historyStack[historyIndex]);
  const loc = g.location as Loc;
  loc.pathname = pathname;
  loc.search = search;
  loc.href = `${LOCATION_ORIGIN}${pathname}${search}`;
};
g.location = {href: `${LOCATION_ORIGIN}/`, origin: LOCATION_ORIGIN, pathname: '/', search: ''} as Loc;
g.history = {
  pushState(_s: unknown, _t: string, url: string) {
    historyStack.splice(historyIndex + 1);
    historyStack.push(url);
    historyIndex += 1;
    syncLocation();
  },
  replaceState(_s: unknown, _t: string, url: string) {
    historyStack[historyIndex] = url;
    syncLocation();
  },
  back() {
    if (historyIndex <= 0) return;
    historyIndex -= 1;
    syncLocation();
    fire('popstate');
  },
  forward() {
    if (historyIndex >= historyStack.length - 1) return;
    historyIndex += 1;
    syncLocation();
    fire('popstate');
  },
  go(n: number) {
    const next = historyIndex + n;
    if (next < 0 || next >= historyStack.length) return;
    historyIndex = next;
    syncLocation();
    fire('popstate');
  },
  get length() { return historyStack.length; },
  get state() { return null; },
};
g.addEventListener = (type: string, fn: (e?: unknown) => void) => {
  (eventListeners[type] ??= []).push(fn);
};
g.removeEventListener = (type: string, fn: (e?: unknown) => void) => {
  eventListeners[type] = (eventListeners[type] ?? []).filter((f) => f !== fn);
};
/** Cold-load semantics: replace the whole stack with one entry — what a fresh page load is. */
export function setPageURL(pathWithSearch: string): void {
  historyStack.length = 0;
  historyStack.push(pathWithSearch.startsWith('/') ? pathWithSearch : `/${pathWithSearch}`);
  historyIndex = 0;
  syncLocation();
}
export function keydownHandlers(): Array<(e: {key: string}) => void> {
  return (eventListeners.keydown ?? []) as Array<(e: {key: string}) => void>;
}

export function installFlowEnvironment(): void { /* all side effects above — see module doc */ }

// --- 8. the per-test lifecycle -------------------------------------------------------------------
// Registered by jest.flow-after-env.js (a setupFilesAfterEnv file — lifecycle hooks are only
// available AFTER the test framework is installed) and, historically, self-registered by some
// batch files at collection time as the interim workaround for the config naming no
// setupFilesAfterEnv. Both paths coexist: this is IDEMPOTENT (the second registration no-ops),
// and everything it touches lives on globalThis or the ONE shared AsyncStorage instance, so
// WHICH registry invoked it does not matter.
const clipboardKey = '__DPAY_TEST_CLIPBOARD';
declare function beforeEach(fn: () => void | Promise<void>, timeoutMs?: number): void;
declare function afterEach(fn: () => void, timeoutMs?: number): void;

type LifecycleG = {
  __DPAY_FLOW_LIFECYCLE_INSTALLED__?: boolean;
  __DPAY_FLOW_ACTIVE_MOUNTS__?: Array<{unmount: () => Promise<void>}>;
  __DPAY_JEST_ASYNC_STORAGE?: {
    getAllKeys: () => Promise<string[]>;
    removeItem: (k: string) => Promise<void>;
    clear: () => Promise<void>;
  };
};
const lg = globalThis as unknown as LifecycleG;

/**
 * The storage purge goes through the ONE AsyncStorage instance jest.setup.js's mock factory
 * plants on globalThis. Jest gives setupFiles, setupFilesAfterEnv, and the test file each their
 * OWN module registry, so a plain `require` from here resolves a different mock Map than the
 * app's (measured: instance identity differs across all three registries) — this handoff is the
 * fix for the keys-from-a-previous-flow's-boot-survive class. getAllKeys+removeItem AND clear():
 * belt and braces, either bug class dies.
 */
async function purgeAsyncStorage(): Promise<void> {
  const AS = lg.__DPAY_JEST_ASYNC_STORAGE;
  if (!AS) return; // the factory never ran (no test file imported the module) — nothing to purge
  for (const k of await AS.getAllKeys()) await AS.removeItem(k);
  await AS.clear();
}

export function installFlowLifecycle(): void {
  if (lg.__DPAY_FLOW_LIFECYCLE_INSTALLED__) return;
  lg.__DPAY_FLOW_LIFECYCLE_INSTALLED__ = true;
  // The jest per-test ceiling must scale WITH the wait budgets or it becomes the binding bound:
  // budget-scaled inner waits (harness/budget.ts) are pointless under a fixed 30s test timeout on
  // a starved box. SAMPLED PER FILE here (after-env evaluation), because jest-circus seeds the
  // per-file state from the global timeout symbol exactly once at run_start — a mid-run
  // jest.setTimeout in a hook would write the symbol but never re-seed the state. Each test file
  // re-samples at its own install, so a burst mid-run lifts every later file's ceiling; the
  // factor itself is monotone within a file (budget.ts high-water). The base MUST match
  // jest.config.js's root `testTimeout: 30_000`. Hook timeouts inherit this state too
  // (jest-circus run.js: `hook.timeout || getState().testTimeout`), so beforeAll/afterAll knob
  // calls in flow files get the same relief. Keep it a pure positive-transition stretch: nothing
  // here weakens a refusal assertion, it only stops the clock from false-firing healthy code.
  jest.setTimeout(budgetScaled(30_000));
  beforeEach(async () => {
    g[clipboardKey] = '';
    g.__DPAY_TEST_NFC_STATUS = undefined;
    g.__DPAY_QR_LAST = undefined;
    // The NFC reader-request stash (e2e/web/dpay-nfc.ts plants it on card dispatch): a per-test
    // reset, so a flow that read the machine code can never leak it into the next card tap's
    // assertion. Flows 25/97/98 clear it in-file too — harmless duplication.
    g.__DPAY_TEST_NFC_READER_REQUEST = undefined;
    // The IC gateway seam is read PER CALL (app/services/icp.ts): reset to the ONE shared relay
    // so a flow that pointed it at its private relay (startFlowRelay) never leaks the point.
    g.__DPAY_TEST_IC_GATEWAY = relayURL;
    // The SOL/EVM rail test overrides, back to the jest.setup.js offline defaults ('' = rail
    // off). NOTE: the override values are CAPTURED at constants.ts/endpoints.ts module load per
    // test file, so this reset matters for per-call readers and hygiene only; the rail
    // OPERATOR overrides (setSolanaRpcUrl/setEvmRpcUrl module-session state) are app-module
    // state in the TEST FILE's registry — files that touch them reset in-file (see
    // flows.test.tsx) or call lib.ts's resetRailOverrides().
    g.__DPAY_TEST_SOLANA_RPC_URL = '';
    g.__DPAY_TEST_EVM_RPC_URL = '';
    // Fresh incognito context: identity + relay lists + journey are per-test state (the e2e
    // fresh-context contract) — purged through the app's OWN instance (see purgeAsyncStorage).
    await purgeAsyncStorage();
    setPageURL('/');
  }, budgetScaled(15_000)); // the hook itself: storage purge under starvation is a positive wait
  afterEach(async () => {
    // Teardown ORDER is load-bearing (the e2e flow-38 convention): quiesce the app's polls
    // FIRST — unmounting aborts in-flight fetches (AbortError, ignored by the fail-closed rule)
    // — THEN stop any private relays, so a dying origin is never observed by a live poll.
    // Each unmount is BOUNDED: a wedged act-unmount (a known async-act hang class on a broken
    // surface) must stay the failed test's own verdict, never bleed into the next suite. The
    // bound scales with the load budget — on a starved box a HEALTHY unmount also crawls, and
    // a false bleed-into-next-suite is exactly the expensive failure class this harness exists
    // to prevent.
    const mounts = lg.__DPAY_FLOW_ACTIVE_MOUNTS__ ?? [];
    for (const m of mounts.splice(0, mounts.length)) {
      await Promise.race([
        m.unmount().catch(() => undefined),
        new Promise((r) => setTimeout(r, budgetScaled(5_000))),
      ]);
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {teardownFlowRelays} = require('./flowRelay') as {teardownFlowRelays: () => Promise<void>};
    await teardownFlowRelays();
    // The e2e fail-closed rule: a test that let a fetch die without declaring it is RED, even green.
    assertNoUndeclaredFailures();
    fetchRecords.length = 0;
  }, budgetScaled(15_000));
}
