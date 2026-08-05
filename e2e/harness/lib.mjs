// Shared harness library — the single import a `e2e/tests/NN-name.mjs` file uses. It:
//   1. Generates `dfx/wire_layout.json` (the single source of truth for the wire layout + golden
//      signed bytes) if missing, via `cargo run -p dpay-fixture --release -- wire-layout`. The
//      DpayCore shim reads this JSON so it never hand-transcribes the layout.
//   2. Spawns the REAL test relay (FakeLedger) on a free port (local mode only).
//   3. Builds + serves the REAL web app once (cached across tests in a single run).
//   4. Hands the test a `Driver` over CDP.
//
// `setup()` returns an `env` with `{ mode, relayBaseURL?, webBaseURL, driver, stop }`. `stop()` is
// the single teardown path — closes the browser, stops the relay (if local), stops the web server.
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Driver } from './driver.mjs';
import { startRelay } from './relay.mjs';
import { buildWeb, serveWeb, pickFreePort } from './web.mjs';

// Re-exported so a test can grab a guaranteed-dead relay URL (a port the harness binds to :0 then
// immediately closes — nothing listens, so a connect yields ECONNREFUSED, the REAL "relay
// unreachable" failure mode — not Chrome's ERR_UNSAFE_PORT artifact). See `13-offline`.
export { pickFreePort };

/**
 * Per-test AsyncLocalStorage context. `runOne` (in run.mjs) wraps each `mod.run()` in
 * `_testCtx.run(test.file, ...)`, so any code path inside the flow — including `setup()` — can read
 * `_testCtx.getStore()` to discover WHICH test file it is running under. This is how `setup()`
 * registers its freshly-created driver into the `_drivers` registry WITHOUT the flow having to pass
 * its filename through (which would mean editing every flow's `setup()` call). AsyncLocalStorage
 * propagates through native promises/async boundaries in Node 18+, so it survives the
 * `runOne → mod.run → flow body → setup()` call chain. Standalone runs (`node tests/NN.mjs` directly)
 * have no store → `setup()` skips registration (fine — no orchestrator to dump on RED).
 */
export const _testCtx = new AsyncLocalStorage();

/**
 * Per-test driver registry: `Map<testFile, Driver>`. Populated by `setup()` (keyed by the active
 * `_testCtx` store) so `runPool`'s catch can reach the failing test's driver and call
 * `dumpDiagnostics` on it. Concurrency-safe: each test file runs at most once per run, so the keys
 * are disjoint across the parallel pool — no race.
 */
const _drivers = new Map();

/** Register a driver under its test file (called from `setup()` when an `_testCtx` store is active). */
export function _registerDriver(file, driver) {
  if (file) _drivers.set(file, driver);
}

/** Drop a driver from the registry. NOT called from the per-test `stop()` closure (the dump fires
 *  AFTER stop() — see setup()), but exported for explicit cleanup by long-lived callers (e.g. a
 *  future watch-mode exit hook) that want to free entries proactively. */
export function _unregisterDriver(file) {
  if (file) _drivers.delete(file);
}

/**
 * Dump diagnostics for the named test file's driver. Returns the dump directory path (or null if no
 * driver is registered for that file, e.g. a standalone run). The dump itself is best-effort; any
 * failure is logged and swallowed so it can never mask the real RED error that triggered the dump.
 */
export async function dumpDiagnosticsFor(file, err) {
  const driver = _drivers.get(file);
  if (!driver || typeof driver.dumpDiagnostics !== 'function') return null;
  try {
    return await driver.dumpDiagnostics(file, err);
  } catch (e) {
    console.error(`[lib] dumpDiagnosticsFor(${file}) failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const WIRE_LAYOUT = join(REPO_ROOT, 'dfx', 'wire_layout.json');

/**
 * Resolve the run mode from $DPAY_E2E_MODE (default `local`). `live` requires $DPAY_E2E_BASE — the
 * harness does NOT spawn a relay in live mode (it drives the real one + canister).
 */
export function resolveMode() {
  const m = (process.env.DPAY_E2E_MODE ?? 'local').toLowerCase();
  if (m !== 'local' && m !== 'live') {
    throw new Error(`DPAY_E2E_MODE=${m} — expected 'local' or 'live'`);
  }
  return m;
}

/**
 * Ensure `dfx/wire_layout.json` exists (regenerate via dpay-fixture ONLY if missing). The DpayCore
 * shim + the cross-validation test both read it. Single source of truth for the wire layout — never
 * hand-transcribed anywhere else.
 *
 * Regenerating every test run was wasteful (a ~1s `cargo run` per test); the JSON is committed and
 * stable, so we only regenerate when it's actually absent. Force a regen with
 * `DPAY_E2E_REGEN_LAYOUT=1` (e.g. after a wire-format change — then commit the new JSON).
 */
export async function ensureWireLayout() {
  if (existsSync(WIRE_LAYOUT) && process.env.DPAY_E2E_REGEN_LAYOUT !== '1') return;
  console.log('[lib] regenerating dfx/wire_layout.json via dpay-fixture…');
  const code = await new Promise((resolve, reject) => {
    const child = spawn('cargo', ['run', '-p', 'dpay-fixture', '--release', '--', 'wire-layout', WIRE_LAYOUT], {
      cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('dpay-fixture wire-layout timed out after 180s'));
    }, 180_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`dpay-fixture wire-layout exited ${code}\n${stderr.split('\n').slice(-20).join('\n')}`));
      } else resolve(code ?? 0);
    });
  });
  if (code !== 0) throw new Error(`dpay-fixture wire-layout failed (exit ${code})`);
}

/**
 * Shared session: the relay + web server + browser PROCESS are spawned ONCE per run and reused
 * across tests. Each `setup()` call still gets a FRESH incognito browser context (fresh localStorage
 * → fresh identity) and the shared relay carries no cross-test account state (every test mints
 * distinct random keys + nonces). This preserves the real isolation — fresh identity per test, no
 * cross-test state pollution — while cutting the ~2.5s relay+web+browser spawn cost that a
 * per-test process would charge 15×. Torn down once at the end of the run by `stopSession()`.
 *
 * Concurrency-safe under PARALLEL test execution (run.mjs runs tests in a bounded pool): the
 * in-flight build is memoized as a Promise, so the first caller builds the session while every other
 * concurrent `setup()` AWAITS the same build — no double-spawn race. The returned session is then
 * immutable for the rest of the run (only the per-test contexts are created/destroyed).
 */
let _session = null;
let _sessionPromise = null;

async function getSession(opts = {}) {
  if (_session) return _session;
  // Memoize the BUILD as a promise so concurrent callers (parallel test pool) await the SAME build
  // instead of racing to spawn a second relay/web/browser.
  if (!_sessionPromise) {
    _sessionPromise = (async () => {
      await ensureWireLayout();
      const mode = resolveMode();
      let relayBaseURL = '';
      const stops = [];

      try {
        if (mode === 'live') {
          const base = process.env.DPAY_E2E_BASE;
          if (!base) throw new Error('DPAY_E2E_MODE=live requires DPAY_E2E_BASE=<url> (e.g. https://dpay.kalaj.org)');
          relayBaseURL = base;
          console.log(`[lib] live mode — pointing app at ${relayBaseURL} (throttle + throwaway identity)`);
        } else if (!opts.noRelay) {
          const relay = await startRelay();
          relayBaseURL = relay.baseURL;
          stops.push(relay.stop);
          console.log(`[lib] local relay up at ${relayBaseURL} (shared across tests)`);
        }

        let webBaseURL = '';
        if (!opts.noWeb) {
          await buildWeb({ force: opts.rebuildWeb });
          const web = await serveWeb();
          webBaseURL = web.baseURL;
          stops.push(web.stop);
          console.log(`[lib] web app served at ${webBaseURL} (shared across tests)`);
        }

        const { browser, stop: stopBrowser } = await Driver.launchBrowser();
        stops.push(stopBrowser);
        console.log('[lib] headless browser launched (shared across tests; fresh context per test)');

        const stop = async () => { for (const s of stops.slice().reverse()) { try { await s(); } catch {} } };
        return { mode, relayBaseURL, webBaseURL, browser, stop };
      } catch (e) {
        for (const s of stops.slice().reverse()) { try { await s(); } catch {} }
        throw e;
      }
    })();
    // If the build fails, clear the promise so a later retry can attempt it again (don't cache a
    // rejection forever — a transient relay/web failure should be retryable on the next run).
    _sessionPromise.catch(() => { _sessionPromise = null; });
  }
  _session = await _sessionPromise;
  return _session;
}

/** Tear down the shared session (relay + web + browser). Called once at the end of the run. */
export async function stopSession() {
  if (!_session) return;
  const s = _session;
  _session = null;
  _sessionPromise = null;
  try { await s.stop(); } catch {}
}

/**
 * Per-test setup. Returns a `Driver` over a FRESH incognito context (fresh localStorage → fresh
 * identity) against the SHARED relay + web + browser. `env.stop()` closes only this test's context;
 * call `stopSession()` once at the end of the run to tear the shared resources down.
 *
 * Isolation: fresh context = fresh identity, no shared cookies/storage. The shared relay's only
 * cross-test global state is the spent-nonce set (random 16-byte nonces → collision-free) and the
 * faucet (funds each test's own distinct account) — no account-state leakage between tests.
 *
 * @param {{noRelay?: boolean, noWeb?: boolean, rebuildWeb?: boolean}} [opts]
 */
export async function setup(opts = {}) {
  const { mode, relayBaseURL, webBaseURL, browser } = await getSession(opts);

  // Fresh incognito context per test → fresh localStorage → fresh identity (the isolation gate).
  const driver = await Driver.create(browser);

  // Register this driver for diagnostics-on-RED lookup, keyed by the active test file (propagated
  // through `_testCtx` by `runOne`). When run under the orchestrator this lets `runPool`'s catch
  // reach the driver and dump screenshot/DOM/timeline at the RED point. Standalone runs (no store)
  // skip registration — there's no orchestrator to call `dumpDiagnosticsFor`.
  //
  // NOTE: the driver is intentionally NEVER unregistered from `stop()`. The flow's own
  // `finally { await env.stop(); }` runs BEFORE the rejection reaches `runPool`'s catch (where the
  // dump fires), so unregistering in `stop()` would erase the driver from the registry before the
  // dump could find it. The map self-bounds: it is keyed by test file (at most one entry per file),
  // a re-run of the same file overwrites, and a CLOSED driver is cheap to retain (its page/context/
  // browser are gone — only the small in-memory timeline/consoleLog arrays persist, which is exactly
  // what the dump needs). One-shot runs reap the map at process exit; watch-mode re-runs overwrite.
  const testFile = _testCtx.getStore();
  if (testFile) _registerDriver(testFile, driver);

  // `driver.close()` also asserts that the page produced no unexpected diagnostics. Never swallow
  // that assertion: a flow that looked correct after a page/network error must be RED.
  const stop = async () => {
    await driver.close();
  };

  try {
    if (!opts.noWeb) {
      // about:blank first so localStorage.clear() has a same-origin context to operate on (a fresh
      // context is already empty, but this is harmless and keeps the path identical for live mode).
      await driver.navigate('about:blank', '/');
      try { await driver.clearStorage(); } catch {}
      const navPath = `/?relay=${encodeURIComponent(relayBaseURL)}`;
      // domcontentloaded (not networkidle0): a fresh context lands on the Onboarding screen, which
      // starts NO continuous polls, so networkidle0's 500ms zero-network window is pure waste. The
      // real readiness gate is waitReady() polling `window.__DPAY_READY` (set after shims install),
      // so resolving navigation as soon as the DOM is parsed cuts ~500ms/flow with no correctness
      // change. This mirrors the pattern flows 12/33 already use for returning-user reloads.
      await driver.navigate(webBaseURL, navPath, { waitUntil: 'domcontentloaded', timeoutMs: mode === 'live' ? 20_000 : 8_000 });
      await driver.waitReady({ timeoutMs: mode === 'live' ? 20_000 : 10_000 });
    }
    return { mode, relayBaseURL, webBaseURL, driver, stop };
  } catch (e) {
    try { await stop(); } catch {}
    throw e;
  }
}

// --- assertion helpers (kept tiny so the suite has zero test-framework deps) -----------------

/** Assert `cond` is true; throw with `msg`. */
export function assert(cond, msg) {
  if (!cond) throw new Error(`[assert] ${msg}`);
}

/** Assert `actual === expected`; the message includes both values for fast triage. */
export function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`[assert] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Assert `actual` contains `substring`; the message includes a body excerpt. */
export function assertIncludes(actual, substring, label) {
  if (!actual.includes(substring)) {
    const excerpt = actual.length > 400 ? actual.slice(0, 400) + '…' : actual;
    throw new Error(`[assert] ${label}: page text should include "${substring}".\n  body excerpt:\n${excerpt}`);
  }
}

// --- onboarding + identity helpers (shared across every browser flow) --------------------------

/**
 * Onboard a fresh wallet: type the username, click create, wait for the funded balance. This is the
 * shared preamble every browser test used to copy-paste (4 lines × 15 files). Returns the driver for
 * chaining. The faucet funds synchronously in create(); the balance poll (fast-poll seam = 150ms in
 * test, 2.5s in prod) reflects it on the next tick, so waitForText('∂100.00') lands quickly.
 */
export async function onboardWallet(driver, name = 'e2e', opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  await driver.typeByPlaceholder('e.g. Alice', name, { timeoutMs: 8_000 });
  await driver.click('btn-create', { timeoutMs: 4_000 });
  await driver.findByTestID('balance', { timeoutMs: 10_000 });
  await driver.waitForText('∂100.00', { timeoutMs });
  return driver;
}

/** Read the wallet identity from localStorage (the app stores it as `dpay.identity.v1`). Returns the
 *  parsed object (with `.publicHex`) or null if not found. */
export async function accountOf(driver) {
  return await driver.eval(() => {
    const v = localStorage.getItem('dpay.identity.v1');
    return v ? JSON.parse(v) : null;
  });
}

/**
 * Open the Balances sheet (the wallet's single money hub) by tapping the header balance. The sheet is
 * the sole home for the full currency list + every top-up, so most deposit/withdraw/asset flows now
 * start here. Waits for the close button so callers can assume the sheet is mounted. Mirrors how a
 * user reaches it (a header-balance tap), not an internal hook.
 */
export async function openBalances(driver, opts = {}) {
  await driver.click('balance', { timeoutMs: opts.timeoutMs ?? 5_000 });
  await driver.findByTestID('btn-balances-close', { timeoutMs: opts.timeoutMs ?? 5_000 });
}

// --- relay client helpers (used by the deposit/pay flows) -------------------------------------
//
// Every call has a timeout (AbortController) and surfaces a thrown Error on non-2xx — no silent
// failures. These hit the REAL test relay the harness spawned (FakeLedger offline), proving the
// credited/settled path end-to-end rather than mocking it.

/** GET `/api/v1/balance/<hex>?currency=N` → the balance in minor units. MC1 units 2-4: the relay
 *  serializes the balance as a DECIMAL STRING (raw u64), so the helper returns a string. */
export async function getBalance(relayBaseURL, accountHex, currency = 0, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${relayBaseURL}/api/v1/balance/${accountHex}?currency=${currency}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`balance ${r.status}`);
    const j = await r.json();
    if (typeof j.balance !== 'string') throw new Error(`balance: bad body ${JSON.stringify(j)}`);
    return j.balance;
  } finally { clearTimeout(t); }
}

/**
 * POST `/api/v1/test/deposit/seed` (feature `test-helpers` ONLY — the harness builds the relay with
 * `--features test-helpers`, the prod image never does). Seeds a pending deposit of `amount` minor
 * units for `accountHex` in `currency`; the NEXT `/deposit/refresh` drains + credits it (mirrors a
 * confirmed ckBTC mint). Used by flow 05 to prove the credited path through the real relay+FakeLedger.
 */
export async function seedDeposit(relayBaseURL, accountHex, currency, amount, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${relayBaseURL}/api/v1/test/deposit/seed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: accountHex, currency, amount }), signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`seed ${r.status}: ${await r.text().catch(() => '')}`);
    return r.json();
  } finally { clearTimeout(t); }
}

/**
 * POST `/api/v1/deposit/refresh/{hex}?currency=N` — drains a seeded pending deposit and credits the
 * balance (mirrors the ck minter minting after confirmations). Used by the withdraw flow (15) to
 * credit ckBTC to the wallet's subaccount WITHOUT opening the deposit sheet, so the asset card
 * appears and the withdraw path has a balance to draw from. Returns the refreshed `minted_total`.
 */
export async function refreshDeposit(relayBaseURL, accountHex, currency, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${relayBaseURL}/api/v1/deposit/refresh/${accountHex}?currency=${currency}`, {
      method: 'POST', signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`deposit/refresh ${r.status}`);
    return r.json();
  } finally { clearTimeout(t); }
}

/**
 * POST `/api/v1/withdraw` with the signed WithdrawRequest → `{ok, status, body}`. Used by the
 * withdraw flow (15) to assert the route's error mapping on a below-min / wrong-sig rejection
 * directly (the app's own submit path is exercised through the UI).
 */
export async function postWithdraw(relayBaseURL, req, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${relayBaseURL}/api/v1/withdraw`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req), signal: ctrl.signal,
    });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch {
    return { ok: null, status: null, body: {} };
  } finally { clearTimeout(t); }
}

/** POST `/api/v1/pay` with a `{qr}` body → `{ok, status, body}` (null `ok`/`status` on fetch throw). */
export async function postPay(relayBaseURL, qrCode, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${relayBaseURL}/api/v1/pay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qr: qrCode }), signal: ctrl.signal,
    });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch {
    return { ok: null, status: null, body: {} };
  } finally { clearTimeout(t); }
}
