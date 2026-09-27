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
if (typeof window === 'undefined') {
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
  const mod = jest.requireActual('react-native/Libraries/Utilities/Platform');
  const base = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;
  // Copy via property DESCRIPTORS so Platform's getter-defined props (isPad, Version, …) stay
  // lazy instead of being invoked at mock time, then flip the OS.
  const mocked = Object.create(Object.getPrototypeOf(base ?? {}), Object.getOwnPropertyDescriptors(base ?? {}));
  mocked.OS = 'web';
  if (typeof mocked.select !== 'function') {
    mocked.select = (spec: Record<string, unknown>) => spec[mocked.OS];
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
const fetchRecords: FetchRecord[] = [];
const allowedDeadOrigins = new Set<string>();
const realFetch = globalThis.fetch.bind(globalThis);
const originOf = (url: string): string => {
  try { return new URL(url).origin; } catch { return url; }
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const target = url.startsWith(RELAY_DEFAULT_ORIGIN)
    ? relayURL + url.slice(RELAY_DEFAULT_ORIGIN.length)
    : url;
  try {
    const res = await realFetch(target, init);
    fetchRecords.push({url, origin: originOf(url), ok: res.ok, status: res.status});
    return res;
  } catch (e) {
    fetchRecords.push({url, origin: originOf(url), ok: false, status: 0, error: e instanceof Error ? e.message : String(e)});
    throw e;
  }
}) as typeof fetch;

export function allowRequestFailuresFrom(url: string): void {
  allowedDeadOrigins.add(originOf(url));
}
export function fetchFailureRecords(): FetchRecord[] {
  return fetchRecords.filter((r) => !r.ok);
}
function assertNoUndeclaredFailures(): void {
  // AbortError is the app aborting its OWN in-flight poll (unmount/remount/timeout) — the e2e
  // harness ignores net::ERR_ABORTED for exactly this reason; a transport failure to a dead
  // origin is a different error class and stays flagged.
  const undeclared = fetchRecords.filter((r) => !r.ok && !(r.error && /abort/i.test(r.error)) && !allowedDeadOrigins.has(r.origin));
  if (undeclared.length > 0) {
    const lines = [...new Set(undeclared.map((r) => `${r.url}${r.error ? ` — ${r.error}` : ` — HTTP ${r.status}`}`))];
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

// --- 7. per-test lifecycle (registered by jest.flow-after-env.js, a setupFilesAfterEnv file —
// lifecycle hooks are only available AFTER the test framework is installed, never in setupFiles)
const clipboardKey = '__DPAY_TEST_CLIPBOARD';
export function installFlowLifecycle(): void {
  beforeEach(async () => {
    g[clipboardKey] = '';
    g.__DPAY_TEST_NFC_STATUS = undefined;
    g.__DPAY_QR_LAST = undefined;
    // Fresh incognito context: identity + relay lists + journey are per-test state (the e2e
    // fresh-context contract). The official AsyncStorage mock clears synchronously enough here.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AsyncStorage = require('@react-native-async-storage/async-storage') as {clear: () => Promise<void>};
    await AsyncStorage.clear();
    setPageURL('/');
  });
  afterEach(() => {
    // The e2e fail-closed rule: a test that let a fetch die without declaring it is RED, even green.
    assertNoUndeclaredFailures();
    fetchRecords.length = 0;
  });
}

export function installFlowEnvironment(): void { /* all side effects above — see module doc */ }
