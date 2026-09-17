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
import { generateKeypair } from './wire.mjs';
import { killTrackedChildren } from './procs.mjs';

// Re-exported so the signal/exit handlers in run.mjs + watch.mjs can reach the SYNC last-resort
// SIGKILL of every spawned child PID (relay + web server) without a new import path. See
// harness/procs.mjs for why this is the critical orphan-prevention layer.
export { killTrackedChildren };

// Re-exported so a test can grab a guaranteed-dead relay URL (a port the harness binds to :0 then
// immediately closes — nothing listens, so a connect yields ECONNREFUSED, the REAL "relay
// unreachable" failure mode — not Chrome's ERR_UNSAFE_PORT artifact). See `13-offline`.
export { pickFreePort };

/**
 * Per-test AsyncLocalStorage context. `runOne` (in run.mjs) wraps each `mod.run()` in
 * `_testCtx.run({ file: test.file, browser }, ...)`, so any code path inside the flow — including
 * `setup()` — can read `_testCtx.getStore()` to discover WHICH test file it is running under (and
 * WHICH browser shard owns it). This is how `setup()` registers its freshly-created driver into the
 * `_drivers` registry and picks its lane's browser WITHOUT the flow having to pass any of that
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

/**
 * Browser-process shards beyond the session's first browser. The pool's concurrency lanes are
 * spread across SEVERAL browser processes because one chrome process serializes its contexts:
 * measured 2026-09-16 on this 16-core box, a flow that runs ~10-15s alone inflated 2-5x when 12
 * contexts shared ONE chrome-headless-shell (CPU sat ~96% idle the whole time — the bottleneck is
 * the process's serialized main/IO work, not compute), which both inflated the wall clock AND made
 * inner waits false-fire RED on healthy flows. Each shard is a full browser launched with the SAME
 * flags as the first; contexts (fresh identity per test) are created from their shard's browser, so
 * isolation semantics are unchanged. Shards are launched once per run (primeBrowserShards) and torn
 * down with the session (their stops ride the session's `stops` list).
 */
const _shardBrowsers = new Map();
let _browserShardsWanted = 1;

/** Set how many browser-process shards the pool wants (runTestsSubset calls this; default 1). */
export function setBrowserShards(n) {
  _browserShardsWanted = Math.max(1, n | 0);
}

/**
 * The browser process for pool lane `index` (0-based). Lane 0 (and any lane when sharding is off)
 * gets the session's own browser; other lanes get shard `index % _browserShardsWanted`, launched
 * lazily on first use and reused for every later test on that lane. Awaiting getSession() first
 * means a lane that starts before the shared build finishes simply queues behind it.
 */
export async function laneBrowser(index) {
  const s = await getSession();
  if (index <= 0 || _browserShardsWanted <= 1) return s.browser;
  const shard = index % _browserShardsWanted;
  if (shard === 0) return s.browser;
  if (!_shardBrowsers.has(shard)) {
    const { browser, stop } = await Driver.launchBrowser();
    _shardBrowsers.set(shard, browser);
    s.addStop(stop);
    console.log(`[lib] headless browser shard #${shard + 1} launched (shared by its lanes; fresh context per test)`);
  }
  return _shardBrowsers.get(shard);
}

/**
 * Launch every non-primary browser shard up front, concurrently, BEFORE the pool seeds — so a lane
 * never pays a mid-run launch and the map's check-then-set above stays single-threaded. Calling
 * this also publishes the shard count (setBrowserShards) in one step.
 */
export async function primeBrowserShards(n) {
  setBrowserShards(n);
  if (n <= 1) return;
  await Promise.all(Array.from({ length: n - 1 }, (_, k) => laneBrowser(k + 1)));
}

export async function getSession(opts = {}) {
  if (_session) {
    // Watch-mode freshness (OPEN_ISSUES U5): a memoized session must not pin a STALE web bundle.
    // A `rebuildWeb` call on a live session rebuilds the dist IN PLACE — same directory, same
    // sirv server, so the next per-test fresh-context navigation loads the new assets. (Watch
    // re-runs are serial, so there is no concurrent-rebuild race.) Everything else (relay, port,
    // browsers) stays exactly as built; `stopSession()` clears the memo as before.
    if (opts.rebuildWeb && _session.webBaseURL) {
      console.log('[lib] rebuildWeb on live session — rebuilding web bundle in place');
      await buildWeb({ force: true });
    }
    return _session;
  }
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

        const addStop = (fn) => { stops.push(fn); };
        const stop = async () => { for (const s of stops.slice().reverse()) { try { await s(); } catch {} } };
        return { mode, relayBaseURL, webBaseURL, browser, addStop, stop };
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
  _shardBrowsers.clear();
  _browserShardsWanted = 1;
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
 * @param {{noRelay?: boolean, noWeb?: boolean, rebuildWeb?: boolean, solStub?: boolean,
 *           solRpcUrl?: 'relay' | string, dark?: boolean, locale?: string,
 *           lazyBoot?: boolean}} [opts]
 *   `lazyBoot`: skip the eager app-boot prologue (the default — `onboardWallet`'s seeded fast
 *   path pays exactly one boot). `false` restores the old double-boot shape for flows that
 *   hand-roll the create path or write storage directly; `DPAY_E2E_NO_LAZY_BOOT=1` is the
 *   suite-wide kill switch.
 *   `solRpcUrl`: re-enable the REAL Solana RPC path (suite default is rail-off). `'relay'`
 *   deletes the test override so the candidate list DERIVES from the App-installed relay
 *   list — the exact production path, harness relay's proxy route included (flow 165); any
 *   other string is injected as the whole candidate list. Mutually exclusive with `solStub`
 *   in intent: `solStub` answers in-page before fetch; `solRpcUrl` drives the real wire.
 */
export async function setup(opts = {}) {
  const { mode, relayBaseURL, webBaseURL, browser: mainBrowser } = await getSession(opts);
  // The store is `{file, browser}` when driven by run.mjs's pool (`browser` = this lane's shard
  // process), or a plain file string from older callers, or undefined standalone. Fall back to the
  // session's own browser whenever the store doesn't carry a shard pick.
  const store = _testCtx.getStore();
  const ctxBrowser = store && typeof store === 'object' ? store.browser : null;
  const browser = ctxBrowser || mainBrowser;

  // Fresh incognito context per test → fresh localStorage → fresh identity (the isolation gate).
  const driver = await Driver.create(browser, {
    solStub: opts.solStub,
    // `'relay'` resolves to the driver's 'derive' mode: no pinned URL — the app derives its
    // SOL candidates from the relay list it was booted with (the harness relay's base is
    // known only after getSession started it, and the derivation needs no base from us).
    solRpcUrl: opts.solRpcUrl === 'relay' ? 'derive' : opts.solRpcUrl,
    dark: opts.dark,
    locale: opts.locale,
  });

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
  const storeForFile = _testCtx.getStore();
  const testFile = typeof storeForFile === 'string' ? storeForFile : storeForFile?.file;
  if (testFile) _registerDriver(testFile, driver);

  // `driver.close()` also asserts that the page produced no unexpected diagnostics. Never swallow
  // that assertion: a flow that looked correct after a page/network error must be RED.
  const stop = async () => {
    await driver.close();
  };

  try {
    if (!opts.noWeb) {
      const navPath = `/?relay=${encodeURIComponent(relayBaseURL)}`;
      driver.appBoot = {
        base: webBaseURL,
        path: navPath,
        relay: relayBaseURL,
        navTimeoutMs: mode === 'live' ? 20_000 : 8_000,
        readyTimeoutMs: mode === 'live' ? 20_000 : 10_000,
      };
      // Lazy boot (default): stop after context + globals — the seeding fast path lands the app
      // with ONE boot carrying the planted identity, instead of the old scheme where setup()
      // booted the app only so a seeder could eval against a live page and boot AGAIN. Flows
      // that hand-roll the create path or write storage themselves ask for the eager prologue
      // with `lazyBoot: false` — the exact pre-lazy shape, kill switch DPAY_E2E_NO_LAZY_BOOT=1.
      const lazyBoot = opts.lazyBoot ?? process.env.DPAY_E2E_NO_LAZY_BOOT !== '1';
      if (!lazyBoot) {
        // about:blank first so localStorage.clear() has a same-origin context to operate on (a fresh
        // context is already empty, but this is harmless and keeps the path identical for live mode).
        await driver.navigate('about:blank', '/');
        try { await driver.clearStorage(); } catch {}
        // domcontentloaded (not networkidle0): a fresh context lands on the Onboarding screen, which
        // starts NO continuous polls, so networkidle0's 500ms zero-network window is pure waste. The
        // real readiness gate is waitReady() polling `window.__DPAY_READY` (set after shims install),
        // so resolving navigation as soon as the DOM is parsed cuts ~500ms/flow with no correctness
        // change. This mirrors the pattern flows 12/33 already use for returning-user reloads.
        await driver.navigate(webBaseURL, navPath, { waitUntil: 'domcontentloaded', timeoutMs: driver.appBoot.navTimeoutMs });
        await driver.waitReady({ timeoutMs: driver.appBoot.readyTimeoutMs });
        driver.appBooted = true;
      }
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
 * Dismiss the first-run walkthrough if it is showing (Trip Ready J1). A no-op when absent —
 * `isPresent` never throws — so flows can call it defensively before any onboarding interaction.
 * onboardWallet calls this at its start; flows that tap btn-create/username-input manually
 * (01, 23, 37, 58, 68, 82, stage-landing-shots) call it explicitly.
 */
export async function skipWalkthroughIfPresent(driver, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 4_000;
  // The app resolves the first-run gate asynchronously (identity + journey are read from storage
  // before Onboarding decides walkthrough-vs-form), so a single instantaneous isPresent can race
  // the boot and miss the Skip button. Poll until the Skip button OR the create form's username
  // field is in the DOM — one of the two appears on every onboarding path — then skip if seen.
  //
  // The press is confirmed by its EFFECT, not by the absence of an exception. Skip unmounts the
  // walkthrough — i.e. it destroys the very node being clicked — so puppeteer can report the node
  // as detached for a press that LANDED, and `driver.click`'s blind retry then re-looks for a
  // button that is correctly gone and fails the whole flow for a successful press. (Two REDs on
  // 2026-09-01, both `btn-walkthrough-skip not visible within 4000ms` immediately after an
  // isPresent said it WAS there.) Checking the create form instead tells the two apart; a press
  // error is only reported if neither surface ever materialises.
  // Two phases, so the budget covers the work it authorises. `timeoutMs` bounds the DECISION (which
  // of the two surfaces this page is on); once the answer is "the walkthrough", the press and its
  // effect get their own budget — the previous single-window version authorised a 4s press and a 4s
  // effect wait inside one 4s window, which cannot both fit.
  const deadline = Date.now() + timeoutMs;
  let sawSkip = false;
  while (Date.now() < deadline) {
    if (await driver.isPresent('username-input')) return;
    if (await driver.isPresent('btn-walkthrough-skip')) { sawSkip = true; break; }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!sawSkip) return; // neither surface — the documented no-op (a returning-user page has neither)

  let pressErr = null;
  try { await driver.click('btn-walkthrough-skip', {timeoutMs}); }
  catch (e) { pressErr = e; } // may simply mean the press landed and took its own button with it
  // Skip awards the `walkthroughDone` stamp — an async storage write — BEFORE it flips the gate, so
  // the create form is not on screen the instant the press returns.
  try { await driver.findByTestID('username-input', {timeoutMs}); }
  catch (e) {
    throw new Error(
      `[lib] the walkthrough Skip was pressed but the create form never appeared within ${timeoutMs}ms`
      + `${pressErr ? ` (the press itself reported: ${pressErr.message})` : ''}`
      + `. On screen: ${JSON.stringify((await driver.bodyText()).slice(0, 300))}`,
    );
  }
}

/**
 * Leave the first-run PRACTICE payment if it is showing (2026-09-08; it replaced the two-phone
 * rehearsal leaflet). On the create path the RECOVERY SAVED stamp beat plays first (~750ms) before
 * practice mounts, so poll for one of practice's two exits OR the surface that comes after it —
 * one of them appears on every path (the restore path skips practice entirely).
 *
 * There are TWO exits and which one is on screen is a real fact about the run, not a race: the
 * request card carries `btn-practice-skip`, and every outcome and every fail-closed branch carries
 * `btn-practice-continue` instead. A flow whose relay has no faucet (37) lands on the second, so
 * this helper takes whichever it finds rather than assuming the happy one.
 *
 * A no-op when absent; onboardWallet calls this after the backup ack, and flows that tap
 * btn-mnemonic-continue manually call it explicitly.
 */
export async function skipPracticeIfPresent(driver, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  // Same press-confirmed-by-effect rule as `skipWalkthroughIfPresent` above, for the same reason:
  // the exit unmounts the screen that carries the button being pressed.
  // "Onboarding is over" is TWO possible surfaces: the wallet itself, or the home-currency
  // question that stands in front of it on a first run (2026-09-04). Waiting only for `balance`
  // made every create-path flow fail here with the chooser plainly on screen.
  const done = async () => (await driver.isPresent(WALLET_READY)) || (await driver.isPresent('btn-home-currency-continue'));
  const deadline = Date.now() + timeoutMs;
  let exit = null;
  while (Date.now() < deadline) {
    if (await done()) return;
    if (await driver.isPresent('btn-practice-skip')) { exit = 'btn-practice-skip'; break; }
    if (await driver.isPresent('btn-practice-continue')) { exit = 'btn-practice-continue'; break; }
    await new Promise(r => setTimeout(r, 100));
  }
  if (exit === null) return; // neither surface — the documented no-op (a restore path has neither)

  // Press, and confirm by EFFECT — then press again if the screen moved under us. Practice resolves
  // asynchronously (a balance read, a capability probe, sometimes a faucet call), and the exit it
  // offers depends on the answer: the request card's Skip, or a fail-closed branch's Continue. A
  // press aimed at one the instant it becomes the other lands on a node React has already replaced,
  // which is a no-op that no exception reports. Re-deciding and re-pressing is what makes this
  // helper immune to that, without slowing the ordinary case (the first press almost always lands).
  let pressErr = null;
  while (Date.now() < deadline) {
    const now = (await driver.isPresent('btn-practice-skip')) ? 'btn-practice-skip'
      : (await driver.isPresent('btn-practice-continue')) ? 'btn-practice-continue'
      : null;
    if (now !== null) {
      try { await driver.click(now, {timeoutMs: 2_000}); }
      catch (e) { pressErr = e; }
    }
    const settle = Date.now() + 2_000;
    while (Date.now() < settle) {
      if (await done()) return;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error(
    `[lib] practice was left but the wallet never appeared within ${timeoutMs}ms`
    + `${pressErr ? ` (the last press reported: ${pressErr.message})` : ''}`
    + `. On screen: ${JSON.stringify((await driver.bodyText()).slice(0, 300))}`,
  );
}

/**
 * Answer the first-run home-currency question if it is showing (2026-09-04).
 *
 * The wallet asks "which currency do you think in?" whenever no currency is stored, which is every
 * fresh context — so this sits on the same shared preamble as the walkthrough and practice,
 * and follows the same two rules they do: poll for EITHER surface before deciding (the gate is
 * resolved from storage, so an instantaneous isPresent races the boot), and confirm the press by
 * its EFFECT, because Continue unmounts the very button being clicked.
 *
 * A no-op when the chooser is absent (a context that already stored a currency).
 */
export async function chooseHomeCurrencyIfPresent(driver, currency = 'CHF', opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const deadline = Date.now() + timeoutMs;
  let sawChooser = false;
  while (Date.now() < deadline) {
    if (await driver.isPresent(WALLET_READY)) return;
    if (await driver.isPresent('btn-home-currency-continue')) { sawChooser = true; break; }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!sawChooser) return;

  await driver.click(`home-currency-${currency}`, {timeoutMs});
  let pressErr = null;
  try { await driver.click('btn-home-currency-continue', {timeoutMs}); }
  catch (e) { pressErr = e; }
  try { await driver.findByTestID(WALLET_READY, {timeoutMs}); }
  catch (e) {
    throw new Error(
      `[lib] the home-currency Continue was pressed but the wallet never appeared within ${timeoutMs}ms`
      + `${pressErr ? ` (the press itself reported: ${pressErr.message})` : ''}`
      + `. On screen: ${JSON.stringify((await driver.bodyText()).slice(0, 300))}`,
    );
  }
}

/**
 * Put the wallet on the DEMO asset — the funded, offline, play-money rail the vast majority of
 * flows exercise.
 *
 * Since 2026-09-04 a fresh wallet lands on its HOME CURRENCY's rail (VCHF), not on DEMO, and the
 * selection is session state re-derived from that currency on every load. Flows that want demo
 * funds therefore have to say so. This is a preamble step rather than a per-flow one precisely
 * because it is the suite's shared assumption, not any single flow's subject.
 */
export async function selectDemoAsset(driver, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  // `openBalances` owns knowing WHICH affordance this screen offers (the header chip everywhere,
  // Home's labelled pill on Home) — one place, so a third entry point never needs a third copy.
  await openBalances(driver, {timeoutMs});
  // Selecting a row closes no chrome, so this helper OWNS the return trip: confirm the row's
  // aria-selected state, then restore Pay so every caller keeps the shared "onboard ends on the
  // Pay scanner" assumption — which is now something this helper ESTABLISHES rather than
  // inherits, since the app itself lands on Home.
  await driver.click('asset-demo-select', {timeoutMs});
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const selected = await driver.eval((t) => {
      const el = document.querySelector(`[data-testid="${t}"]`);
      return el ? el.getAttribute('aria-selected') === 'true' : null;
    }, 'asset-demo');
    if (selected === true) break;
    if (Date.now() > deadline) throw new Error('selectDemoAsset: asset-demo is not selected');
    await new Promise((r) => setTimeout(r, 100));
  }
  await driver.click('tab-pay', {timeoutMs});
  await driver.findByTestID('pay-scan', {timeoutMs});
}

/**
 * The init-script payload for pre-boot seeding. Registered via `driver.addInitScript`, so it runs
 * on the APP ORIGIN before any bundle code — where `localStorage.clear()` actually operates on the
 * app's storage (the old boot-then-eval scheme evaluated on whatever page was up). Plants identity
 * + journey and raises the flag the seeded boot asserts on.
 */
function seedInitScript(identityJson, journeyJson) {
  try { localStorage.clear(); } catch {}
  localStorage.setItem('dpay.identity.v1', identityJson);
  localStorage.setItem('dpay.journey.v1', journeyJson);
  globalThis.__DPAY_TEST_SEEDED = true;
}

/**
 * Where a seeded boot should land: the relay the seed funds against, and the app URL carrying it.
 * A page ALREADY on an app origin wins — a flow's own navigation, or setup()'s eager prologue
 * (DPAY_E2E_NO_LAZY_BOOT=1); its query is preserved so the boot re-lands on the SAME relay. Under
 * the lazy-boot default nothing has loaded yet, so setup()'s stashed boot intent is the target.
 */
function seedTarget(driver) {
  const url = driver.pageURL();
  if (/^https?:/i.test(url)) {
    const u = new URL(url);
    const relay = u.searchParams.get('relay');
    if (relay) return { relay, base: u.origin, path: `${u.pathname}${u.search}` };
  }
  return driver.appBoot
    ? { relay: driver.appBoot.relay, base: driver.appBoot.base, path: driver.appBoot.path }
    : null;
}

/**
 * Plant a fresh, FUNDED identity PRE-BOOT and bring the app up ONCE over it — the seeded-identity
 * fast path. Generates a fresh random keypair (the same ed25519 wire format every flow's
 * `generateKeypair` uses), funds it over the relay's faucet route (the exact `{account}` POST
 * Onboarding itself sends, → ∂100.00), and registers an init script that writes the two storage
 * keys the first-run router gates on BEFORE the bundle evaluates:
 *   `dpay.identity.v1` = {secretHex, publicHex, username}   (STORAGE_KEY)
 *   `dpay.journey.v1`  = {stamps:[walkthroughDone, recoverySaved], at:{…}, seen:[firstRunPractice]}
 * …which is byte-for-byte the end-state the real create path leaves (Skip awarded walkthroughDone,
 * the backup ack awarded recoverySaved, the practice skip marked firstRunPractice seen). The
 * home-currency question is deliberately NOT seeded — the chooser itself answers it through the
 * app's own persistence, exactly as the slow path does.
 *
 * ONE navigation total: under lazy boot this is the app's first and only boot; under the eager
 * prologue it is the reload. The `__DPAY_TEST_SEEDED` flag is asserted fail-loud after waitReady
 * (the flow-75 seam doctrine: a boot that did not actually carry the planted identity must stop
 * the flow, not silently onboard over an unknown wallet). The init script is then REMOVED — it is
 * one-shot by contract, so later in-flow reloads see the page exactly as the app left it.
 *
 * Returns true when the wallet shell is mounted over the planted identity; false when the
 * environment can't support it (no relay target, or the relay serves no faucet) so the caller
 * falls back to the real create path. Throws on REAL failures after the seed was decided on —
 * a half-planted identity must never silently reroll.
 */
async function seedAndBoot(driver, name, opts = {}) {
  const target = seedTarget(driver);
  if (!target) return false;
  const kp = await generateKeypair();
  if (opts.fund !== false) {
    const fund = await faucetAccount(target.relay, kp.publicHex, undefined);
    if (!fund.ok) return false; // e.g. a relay advertising no faucet — the slow path handles it honestly
  }
  const now = Date.now();
  const seedId = await driver.addInitScript(
    seedInitScript,
    JSON.stringify({ secretHex: kp.secretHex, publicHex: kp.publicHex, username: name }),
    JSON.stringify({
      stamps: ['walkthroughDone', 'recoverySaved', 'flowUnderstood'],
      at: { walkthroughDone: now, recoverySaved: now, flowUnderstood: now },
      seen: ['firstRunPractice'],
    }),
  );
  try {
    const boot = driver.appBoot;
    await driver.navigate(target.base, target.path, {
      waitUntil: 'domcontentloaded',
      timeoutMs: boot?.navTimeoutMs,
    });
    await driver.waitReady({ timeoutMs: boot?.readyTimeoutMs });
    driver.appBooted = true;
    const flagged = await driver.eval(() => globalThis.__DPAY_TEST_SEEDED === true);
    assert(flagged, '[lib] the seeded boot never ran its init script (__DPAY_TEST_SEEDED unset) — this page is NOT the planted identity; refusing to continue');
  } finally {
    try { await driver.removeInitScript(seedId); } catch {}
  }
  return true;
}

/**
 * Land the app for the SLOW onboarding path. Under the lazy-boot default nothing has loaded when
 * `onboardWallet` starts, so the create path's first probe would hit a blank page: boot ONCE here
 * (the same single boot the seeded path would have paid — no configuration pays two). A page a
 * flow navigated itself is adopted as-is (its query carries ITS relay); the eager prologue has
 * nothing left to do. Idempotent.
 */
async function bootPendingApp(driver) {
  if (driver.appBooted) return;
  if (/^https?:/i.test(driver.pageURL())) {
    await driver.waitReady({ timeoutMs: driver.appBoot?.readyTimeoutMs ?? 10_000 });
  } else {
    if (!driver.appBoot) return;
    const boot = driver.appBoot;
    await driver.navigate(boot.base, boot.path, { waitUntil: 'domcontentloaded', timeoutMs: boot.navTimeoutMs });
    await driver.waitReady({ timeoutMs: boot.readyTimeoutMs });
  }
  driver.appBooted = true;
}


/**
 * Onboard a fresh wallet: land a funded returning-user identity in ONE app boot, then settle to
 * the Pay scanner. This is the shared preamble every browser test used to copy-paste (4 lines ×
 * 15 files). Returns the driver for chaining.
 *
 * FAST PATH (the default): `seedAndBoot` plants a fresh random identity + journey pre-boot via an
 * init script and brings the app up ONCE over it — the seeded single-boot path, skipping ~30 UI
 * round trips (walkthrough → create → backup ack → practice beat → polls) that none of the ~140
 * non-onboarding flows assert on. The REAL create path stays the subject of the flows that ARE
 * about onboarding (01/23/37/58/68/152-156 hand-roll the steps) and of `opts.slow`;
 * `DPAY_E2E_SLOW_ONBOARD=1` is the suite-wide slow-path switch. `DPAY_E2E_NO_LAZY_BOOT=1` restores
 * the old double-boot shape (eager prologue in `setup()` + seeded reload here) for bisecting.
 * The end state is the SAME both ways: identity + journey stamps in storage, home currency
 * answered, funded DEMO wallet, on the Pay scanner, ∂100.00 on screen.
 *
 * D4-B: clicking btn-create now shows the mnemonic backup screen BEFORE the faucet runs. The backup
 * is dismissed (check the ack checkbox + Continue) so the faucet fires and the wallet loads. The
 * checkbox→Continue pair uses `waitForEnabled` because btn-mnemonic-continue is `disabled` until
 * React re-renders after the checkbox tap — a bare `click` could land before the re-render and be a
 * silent no-op. The faucet funds synchronously in finishCreate(); the balance poll (fast-poll seam =
 * 150ms in test, 2.5s in prod) reflects it on the next tick, so waitForText('∂100.00') lands quickly.
 *
 * After the backup ack the RECOVERY SAVED beat plays (~750ms) and then the first-run PRACTICE
 * payment mounts — skipPracticeIfPresent leaves it (restore paths never see it).
 */
export async function onboardWallet(driver, name = 'e2e', opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  if (opts.slow !== true && process.env.DPAY_E2E_SLOW_ONBOARD !== '1') {
    if (await seedAndBoot(driver, name)) {
      // The seeded boot landed the wallet as a returning user: settle to exactly where the slow
      // path ends (home currency answered, Pay tab, DEMO selected, ∂100.00 visible).
      await chooseHomeCurrencyIfPresent(driver);
      await driver.findByTestID(WALLET_READY, { timeoutMs: 10_000 });
      await selectDemoAsset(driver);
      await driver.waitForText('∂100.00', { timeoutMs });
      return driver;
    }
    // No relay/faucet on this page → fall through to the real create path (it owns the honest
    // no-faucet branches; e.g. flow 37's practice-continue exit).
  }
  await bootPendingApp(driver);
  // Trip Ready J1 — a fresh context boots into the walkthrough before the create form. Skip it
  // (no-op if already dismissed — e.g. a flow that skipped it manually first).
  await skipWalkthroughIfPresent(driver);
  await driver.typeByPlaceholder('e.g. Alice', name, { timeoutMs: 8_000 });
  await driver.click('btn-create', { timeoutMs: 4_000 });
  await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
  await driver.click('mnemonic-backup-checkbox', { timeoutMs: 4_000 });
  await waitForEnabled(driver, 'btn-mnemonic-continue', { timeoutMs: 4_000 });
  await driver.click('btn-mnemonic-continue', { timeoutMs: 4_000 });
  await skipPracticeIfPresent(driver);
  // The home-currency question, then back onto DEMO: the wallet now opens in the user's chosen
  // currency, and this preamble's contract with every downstream flow is a funded DEMO wallet.
  await chooseHomeCurrencyIfPresent(driver);
  await driver.findByTestID(WALLET_READY, { timeoutMs: 10_000 });
  await selectDemoAsset(driver);
  await driver.waitForText('∂100.00', { timeoutMs });
  return driver;
}

/**
 * The seeded fast path WITHOUT the funded-DEMO contract: seed + single boot + the home-currency
 * question, ending at the mounted wallet shell — no selectDemoAsset, no ∂100.00 wait. `opts.fund`
 * = false also skips the IC faucet POST entirely (the create path for these flows skips the
 * practice funding, so the planted identity must be UNFUNDED on IC too — e.g. 165, whose subject
 * is the SOL rail funding the wallet through the relay proxy). If seeding is impossible (no relay
 * target / no faucet when funding) this returns false so the caller can fall back to its own
 * create path; after the seed is decided on it throws on real failures (the fail-loud seam
 * doctrine) — a half-planted identity must never silently reroll.
 */
export async function onboardSeededUnfunded(driver, name = 'e2e', opts = {}) {
  if (!(await seedAndBoot(driver, name, opts))) return false;
  await chooseHomeCurrencyIfPresent(driver);
  await driver.findByTestID(WALLET_READY, { timeoutMs: 10_000 });
  return true;
}

/**
 * Wait for a Pressable matched by `testID` to become enabled (not aria-disabled / not disabled).
 * Needed after tapping a gate checkbox (e.g. `mnemonic-backup-checkbox`) that flips a separate
 * button's `disabled` prop — the driver's `click` doesn't wait for enabled state, so clicking the
 * gated button immediately after the gate can be a silent no-op if React hasn't re-rendered yet.
 */
export async function waitForEnabled(driver, testID, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isDisabled(driver, testID))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`[lib] element testID=${testID} stayed disabled past ${timeoutMs}ms`);
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
 * Open the wallet's money hub — the ACCOUNTS route (2026-09-08; the list left the Home tab, and
 * the Balances SHEET was retired before that) — by tapping the header balance chip. The name and
 * the contract are kept from the sheet era: this is still how most deposit/withdraw/asset flows
 * reach the full currency list + the faucet row. Waits for the DEMO row's select Pressable so
 * callers can assume the list is mounted. Mirrors how a user reaches it (the chip that carries the
 * account name and a chevron, present on every screen), not an internal hook.
 *
 * The chip is DISABLED while a pay engine holds the selection lock (`selectionLocked && mode ===
 * 'pay'`), which the old `tab-home` route was not. That is the wallet genuinely refusing, so this
 * helper does not work around it: a flow that needs the list mid-review must leave the review
 * first (flow 71 owns that contract).
 */
/**
 * The testID that means "the wallet shell is mounted", for every wait that used to look for the
 * header balance chip. The chip is NO LONGER that signal: since 2026-09-09 it is absent on Home,
 * which is the landing screen — so waiting for it hung with the wallet plainly on screen. The tab
 * bar is the honest anchor: it renders on every wallet surface and on none of the onboarding ones.
 */
export const WALLET_READY = 'tab-home';

/** Wait until the wallet shell is mounted. What every flow that used to `findByTestID('balance')`
 *  after onboarding/restore actually meant. */
export async function waitForWallet(driver, opts = {}) {
  return driver.findByTestID(WALLET_READY, { timeoutMs: opts.timeoutMs ?? 10_000 });
}

export async function openBalances(driver, opts = {}) {
  // TWO affordances reach the ONE accounts route, and which one exists depends on the screen the
  // caller happens to be on. Home has `btn-home-accounts` — since 2026-09-14 that is the HEADLINE
  // BLOCK ITSELF (founder: "if the user clicks on the balance, they should be taken to the
  // accounts and balances"; the old "Accounts · N" pill is gone) — and deliberately has NO header
  // chip: the chip names the SELECTED account while Home's headline names the HOME CURRENCY, and
  // rendering both put two different accounts in one viewport (founder, 2026-09-09). Every other
  // screen has the chip and not the tappable balance.
  //
  // This is a lookup, not a fallback: neither present is a hard failure with both names, because
  // the accounts route being unreachable from the current screen is exactly the regression the
  // "one gesture from every screen" rule (flow 150) exists to catch.
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const affordance = (await driver.isPresent('balance'))
    ? 'balance'
    : (await driver.isPresent('btn-home-accounts')) ? 'btn-home-accounts' : null;
  if (affordance === null) {
    throw new Error('openBalances: this screen offers neither the header chip (`balance`) nor Home\'s tappable headline (`btn-home-accounts`) — the accounts route is unreachable from here');
  }
  await driver.click(affordance, { timeoutMs });
  await driver.findByTestID('asset-demo-select', { timeoutMs });
}

/**
 * Select an IC catalog currency in the ACCOUNTS route via its whole-row select Pressable
 * (`asset-<key>-select`). Assumes the caller is already on that route (`openBalances`). Waits for
 * the row's aria-selected (the route has no sheet chrome to close), then restores the Pay tab —
 * the context every caller assumes after selecting. This is the SOLE way to make a currency the
 * active asset (the row is one big select Pressable). `key` is the assetTestKey (e.g. 'ckbtc',
 * 'ckusdc', 'cketh'); 'demo' for the DEMO row.
 */
export async function selectCurrency(driver, key, opts = {}) {
  await driver.click(`asset-${key}-select`, { timeoutMs: opts.timeoutMs ?? 5_000 });
  // Poll until the row reports aria-selected="true" — the selection is React state, so the
  // attribute can lag the click by a render under pool contention (the inline list has no sheet
  // chrome whose unmount could serve as the signal).
  const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
  for (;;) {
    const v = await driver.eval(
      (sel) => {
        const el = document.querySelector(sel);
        return el ? el.getAttribute('aria-selected') : null;
      },
      `[data-testid="asset-${key}"]`,
    );
    if (v === 'true') break;
    if (Date.now() > deadline) {
      throw new Error(`selectCurrency: asset-${key} is not selected (aria-selected=${v}) after ${opts.timeoutMs ?? 5_000}ms`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await driver.click('tab-pay', { timeoutMs: opts.timeoutMs ?? 5_000 });
}

/**
 * Switch to the Receive tab and open the "My address" sub-mode (the on-chain deposit flow, lifted
 * inline). Assumes the desired currency is already the active asset (select it in Balances first).
 * The toggle renders for any asset with an on-chain identity — a chain-key family (CkBtcUtxo /
 * CkEthErc20) OR a complete no-minter direct-ICRC row (VCHF / ICP), whose "address" is the wallet's
 * own ICRC-1 principal. DEMO alone has none. Returns nothing; the deposit body (e.g.
 * `deposit-address`) is the gate.
 */
export async function openReceiveAddress(driver, opts = {}) {
  await driver.click('tab-receive', { timeoutMs: opts.timeoutMs ?? 5_000 });
  await driver.click('btn-receive-address', { timeoutMs: opts.timeoutMs ?? 5_000 });
}

/**
 * Switch to the Pay tab and open the "Send to address" sub-mode, lifted inline. Assumes the desired
 * currency is already the active asset (select it in Balances first). The toggle renders for any
 * asset that can LEAVE the wallet — a chain-key family (CkBtcUtxo / CkEthErc20 → the minter burn,
 * WithdrawSheet) OR a complete no-minter direct-ICRC row (VCHF / ICP → a plain icrc1_transfer,
 * SendSheet). DEMO alone has no send path and shows no toggle. Mirrors `openReceiveAddress`.
 */
export async function openPaySend(driver, opts = {}) {
  await driver.click('tab-pay', { timeoutMs: opts.timeoutMs ?? 5_000 });
  await driver.click('btn-pay-send', { timeoutMs: opts.timeoutMs ?? 5_000 });
}

// --- pay-intent scan gate -----------------------------------------------------------------------
//
// Founder rule 2026-08-23: the payer-side scan surfaces (PayMode IC + SolPayMode SOL) keep the
// camera (QrScanner) AND the NFC card (NfcTap/SolNfcTap) UNMOUNTED until the explicit "Start
// scanning" tap (btn-start-scan / btn-sol-start-scan). Every e2e path that injects a scan payload
// (`__DPAY_TEST_SCAN`) or dispatches a payer NFC event (`__DPAY_TEST_NFC_SESSION` /
// `__DPAY_TEST_SOL_NFC_SESSION`) must first funnel through these arming helpers — the CHOKE POINTS.
// They are idempotent and surface-aware: an already-armed session (or an ungated receive-side
// scanner) has listeners > 0 and is left untouched, and the gate button unmounts once armed, so a
// stray double-press cannot happen. Within an armed session the card re-arms itself (nfcKey), so
// only reset()/subMode-flip/tab-switch (fresh mount → idle) re-expose the gate — which these
// helpers then press again.

/** Query the camera shim's listener count (mounted <QrScanner> instances). */
async function scanCount(driver) {
  return driver.eval(() => (typeof window.__DPAY_TEST_SCAN_COUNT === 'function' ? window.__DPAY_TEST_SCAN_COUNT() : -1));
}

/** Press whichever pay-intent gate button is on screen, if any. Returns true when a press was
 *  issued. Safe to call repeatedly: the button unmounts once armed, and a mid-navigation race
 *  (button gone between probe and click) just returns false for the next poll to retry. */
async function pressScanGate(driver) {
  const gate = await driver.eval(() => {
    for (const t of ['btn-start-scan', 'btn-sol-start-scan']) {
      if (document.querySelector(`[data-testid="${t}"]`)) return t;
    }
    return null;
  });
  if (!gate) return false;
  try {
    await driver.click(gate, { timeoutMs: 2_000 });
    return true;
  } catch {
    return false; // unmounted mid-click (tab switch / re-render) — the caller's poll retries
  }
}

/**
 * Ensure the payer scan surface is ARMED (camera listening). THE choke point for every
 * `__DPAY_TEST_SCAN` injection against the Pay tab: presses the gate when the surface is idle,
 * no-ops when already armed, and fails loudly when neither a scanner nor a gate ever appears.
 */
export async function armPayScan(driver, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await scanCount(driver)) > 0) return;
    await pressScanGate(driver); // no-op when no gate is on screen (ungated surface / mid-nav)
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(false, `pay scan surface never armed within ${timeoutMs}ms (listeners=0 throughout, no gate button pressed)`);
}

/**
 * Ensure the payer-side NFC CARD is armed (NfcTap/SolNfcTap mounted + listening). THE choke point
 * for every payer `__DPAY_TEST_NFC_SESSION` (rail 'ic') / `__DPAY_TEST_SOL_NFC_SESSION`
 * (rail 'sol') dispatch. The same "Pay Now" tap arms card + camera together, so this
 * shares pressScanGate; only the listener wait is seam-specific (NFC counts, not camera counts).
 */
export async function armNfcCard(driver, rail, opts = {}) {
  const seam = { ic: '__DPAY_TEST_NFC_COUNT', sol: '__DPAY_TEST_SOL_NFC_COUNT' }[rail];
  assert(seam, `armNfcCard: unknown rail ${JSON.stringify(rail)} (expected 'ic' | 'sol')`);
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await driver.eval((g) => (typeof window[g] === 'function' ? window[g]() : -1), seam);
    if (n > 0) return;
    await pressScanGate(driver);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(false, `${rail} NFC card never mounted within ${timeoutMs}ms (listeners=0 throughout; the pay-intent gate never armed it)`);
}

/**
 * Assert that a <QrScanner> is mounted and listening for scans (arming the pay-intent gate first
 * if needed). Catches the class of bug where the scanner fails to render (a conditional/overlay
 * prevents it) — the camera shim would SILENTLY lose the injected scan payload, the flow hangs,
 * and the failure is an opaque timeout instead of an actionable error.
 */
export async function assertScannerMounted(driver, label = 'scan screen') {
  await armPayScan(driver);
  const count = await scanCount(driver);
  assert(count > 0, `QrScanner must be mounted on ${label} (listeners=${count}); the scanner component failed to render — check for a conditional/overlay that prevents <QrScanner> from mounting.`);
}

/**
 * Poll until a <QrScanner> is mounted (listener count > 0), arming the pay-intent gate on the
 * way (an idle payer surface starts with listeners=0 by design). Use after re-entering a scan
 * phase — reset()/subMode-flip disarm, and the scanner also needs a tick to re-mount after the
 * review/qr phases. The camera shim's fail-loud `__DPAY_TEST_SCAN` catches a missing scanner at
 * injection time, but this helper gives a cleaner failure + avoids the race for flows that re-scan.
 */
export async function waitForScanner(driver, opts = {}) {
  await armPayScan(driver, opts);
}

// --- relay-retarget / offline helpers -----------------------------------------------------------
//
// The "open Settings → type relay URL → Apply → close Settings" dance is repeated across the offline
// + deposit-error + low-balance flows (13/19/20/22). `setRelay` is the one-direction primitive (used
// for BOTH going offline AND restoring the good relay); `goOffline` wraps it with a guaranteed-dead
// port + the request-failure allowance the offline flows need. Pure refactor — the click sequence +
// timeouts match the inline originals byte-for-byte so no behavior changes.

/**
 * Open Settings, type `url` into the relay field, click Apply, then close Settings. This is the
 * single primitive for retargeting the app's relay (used by the offline, deposit-error, low-balance,
 * and relay-retarget flows). Mirrors the exact inline sequence that was copy-pasted across 4 flows:
 * `btn-settings` → type `settings-relay` → `btn-relay-apply` → `btn-settings-close`. The `type`
 * helper select-all's first, so the URL REPLACES the current value (no need to clear).
 */
export async function setRelay(driver, url, opts = {}) {
  const t = opts.timeoutMs ?? 4_000;
  await driver.click('btn-settings', { timeoutMs: t });
  await driver.click('btn-advanced-toggle', { timeoutMs: t }); // expand the disclosure (defaults collapsed)
  await driver.type('settings-relay', url, { timeoutMs: t });
  await driver.click('btn-relay-apply', { timeoutMs: t });
  await driver.click('btn-settings-close', { timeoutMs: t });
  // The fake-IC /api/v2 gateway rides the SAME origin as the relay in this harness (shims.ts
  // bootstraps `__DPAY_TEST_IC_GATEWAY` from `?relay=` ONCE at page load). A mid-session retarget
  // must re-point the seam too, or the app's value path keeps submitting at the bootstrap origin —
  // e.g. coming back "online" would leave a dead gateway behind while the relay is alive.
  // `app/services/icp.ts` reads the seam PER CALL (load-bearing: that per-call read is what makes
  // runtime retargeting work at all — do NOT "align" the app to a one-time capture). Only re-point
  // when the seam already exists (local e2e builds); live mode serves the web-prod bundle where the
  // seam is compiled out and icp.ts defaults to icp-api.io — never create the global on a prod page.
  await driver.eval((u) => {
    if (typeof globalThis.__DPAY_TEST_IC_GATEWAY === 'string') globalThis.__DPAY_TEST_IC_GATEWAY = u;
  }, url);
}

/**
 * Point the app at a GENUINELY-DEAD relay (a port nothing listens on → ECONNREFUSED, the real
 * "relay unreachable" failure mode — NOT Chrome's ERR_UNSAFE_PORT artifact). Picks a free port,
 * registers it with `driver.allowRequestFailuresFrom` (so the dead-relay connection refusals don't
 * fail-closed the flow at teardown), and retargets the app via `setRelay`. Returns `{deadRelay,
 * deadGateway}` so the caller can reference the origins (e.g. to filter `recordRequestFailures()`
 * by URL) if needed.
 *
 * Full offline premise (2026-08-20): by default this ALSO kills the IC gateway transport — the
 * fake-IC gateway lives INSIDE the shared relay process, so a per-flow "kill" is retargeting THIS
 * page's `__DPAY_TEST_IC_GATEWAY` seam at a UNIQUE dead origin via `driver.eval` (the flow-22
 * pattern). A unique port (not the deadRelay origin) keeps concurrent offline flows' gateway
 * refusals disjoint when filtering `recordRequestFailures()` by URL. The balance/history polls hit
 * the RELAY (`/api/v1/balances` etc.), so `online` still flips false from the relay death alone —
 * the gateway kill adds the /api/v2 value path (signed queries, read_state) to the dead set.
 *
 * `{keepGateway: true}` is the offline-BY-RELAY-ONLY variant for flows whose design REQUIRES a
 * live gateway (flow 20's offline hand-off: the payer signs an icrc1_transfer envelope — the rail
 * submits envelopes to IC, not to the relay — and the counterparty POSTs to the gateway). It
 * snapshots the seam before `setRelay` re-points it and restores it after.
 *
 * The reverse (coming back online) is just `setRelay(driver, goodRelayUrl)` — no port/allowance
 * needed for a live relay; it re-points the gateway seam back at the live origin too.
 */
export async function goOffline(driver, opts = {}) {
  const deadPort = await pickFreePort();
  const deadRelay = `http://127.0.0.1:${deadPort}`;
  driver.allowRequestFailuresFrom(deadRelay);
  // Pick + allowlist BOTH dead origins BEFORE retargeting anything, so no in-flight poll can hit
  // a dead-but-not-yet-allowed origin in the window between the retarget steps.
  const gwPort = await pickFreePort();
  const deadGateway = `http://127.0.0.1:${gwPort}`;
  driver.allowRequestFailuresFrom(deadGateway);
  const keepGateway = opts.keepGateway === true;
  const prevGateway = keepGateway
    ? await driver.eval(() => (typeof globalThis.__DPAY_TEST_IC_GATEWAY === 'string' ? globalThis.__DPAY_TEST_IC_GATEWAY : null))
    : null;
  await setRelay(driver, deadRelay, opts);
  if (keepGateway) {
    if (prevGateway) {
      await driver.eval((gw) => { globalThis.__DPAY_TEST_IC_GATEWAY = gw; }, prevGateway);
    }
  } else {
    // Same exists-check as setRelay: never CREATE the seam on a prod-shaped (live-mode) page.
    await driver.eval((gw) => {
      if (typeof globalThis.__DPAY_TEST_IC_GATEWAY === 'string') globalThis.__DPAY_TEST_IC_GATEWAY = gw;
    }, deadGateway);
  }
  return { deadRelay, deadGateway };
}

// --- disabled-state helpers --------------------------------------------------------------------
//
// `btn-approve`/`btn-withdraw-confirm` are RN `Pressable` with `disabled={...}`. RNW surfaces that
// as `aria-disabled="true"` + the DOM `disabled` property. The aria-disabled/disabled eval was
// copy-pasted across the expired (10), low-balance (19), and withdraw-errors (18) flows. Centralized
// here so the probe stays identical everywhere (and a future testID gets the check for free).

/**
 * Read the disabled state of the element matched by `testID`. Returns true iff the Pressable is
 * currently disabled (aria-disabled="true" OR the DOM `disabled` property/attribute, including a
 * nested <button>'s disabled). Returns false if the element is absent (matches the inline original —
 * a missing button is treated as "not disabled" rather than throwing, so the caller's assertion
 * message is the one that fires).
 */
export async function isDisabled(driver, testID) {
  return await driver.eval((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return false;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (el.hasAttribute('disabled')) return true;
    if (el.disabled === true) return true;
    const innerBtn = el.querySelector('button');
    if (innerBtn && innerBtn.disabled) return true;
    return false;
  }, testID);
}

/**
 * Assert the element matched by `testID` is currently disabled. Used to prove a doomed action
 * (expired request, insufficient balance, below-min withdraw) is gated at the UI before it can reach
 * the relay. Pairs with `isDisabled` for the rare "disabled until condition clears" checks.
 */
export async function assertDisabled(driver, testID, label) {
  const disabled = await isDisabled(driver, testID);
  if (!disabled) throw new Error(`[assert] ${label}: element testID=${testID} should be disabled but is not`);
}

// --- relay client helpers (used by the deposit/pay flows) -------------------------------------
//
// Every call has a timeout (AbortController) and surfaces a thrown Error on non-2xx — no silent
// failures. These hit the REAL test relay the harness spawned (FakeLedger offline), proving the
// credited/settled path end-to-end rather than mocking it.

/** GET `/api/v1/balances/<hex>` (the always-on batch route the app itself polls) → the balance in
 *  minor units for `currency`. The response is a map keyed by DECIMAL-STRING currency id whose
 *  values are DECIMAL STRINGS (MC1 units 2-4: raw u64 across the JSON boundary as a string), so
 *  the helper returns a string. Under the test-helpers relay the route reads the fake-IC gateway
 *  snapshot — exactly where the faucet credits and signed transfers move, so assertions see real
 *  settled state. A currency MISSING from the map THROWS (the route is best-effort per currency) —
 *  never a silent '0'. */
export async function getBalance(relayBaseURL, accountHex, currency = 0, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const url = `${relayBaseURL}/api/v1/balances/${accountHex}`;
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 500)}`);
    const j = await r.json();
    const bal = j?.[String(currency)];
    if (typeof bal !== 'string') {
      throw new Error(`GET ${url}: no balance entry for currency ${currency} in ${JSON.stringify(j).slice(0, 500)}`);
    }
    return bal;
  } catch (e) {
    // Re-throw already-enriched errors verbatim; wrap a bare transport failure (abort/network) with
    // method + URL so the failure names the endpoint instead of an opaque "operation was aborted".
    if (e instanceof Error && /^GET /.test(e.message)) throw e;
    throw new Error(`GET ${url} failed: ${e instanceof Error ? e.message : e}`);
  } finally { clearTimeout(t); }
}

/**
 * GET /api/v1/currencies → the v2 network-first catalog (`200 {"networks":[{protocol,name,
 * environment,assets}]}` — three sections in order: icp mainnet, icp testnet, solana mainnet).
 * Returns the IC assets as ONE flat list (icp mainnet ++ icp testnet), each section selected by
 * `protocol === 'icp'` + `environment` — never by display name — mirroring the app's own parse
 * seam (`icpCatalogOf` in app/config/catalog.ts). IC rows keep the exact `CurrencyDescriptor`
 * field set, so callers keep doing `find((c) => c.currency === N)`; currency ids are unique
 * across the two icp sections (the REAL prod rows since the 2026-08-28 catalog transplant:
 * mainnet DEMO 0 / ckBTC 1 / ckUSDC 2 / ckETH 6 / VCHF 7 / ICP 8; testnet ckTESTBTC 3 /
 * ckSepoliaUSDC 4 / ckSepoliaETH 5).
 * Solana rows live in their own section and never appear here. Throws on non-200 or a non-v2
 * body (no back-compat — there are no deployed clients).
 */
export async function icpCatalog(relayBaseURL, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const url = `${relayBaseURL}/api/v1/currencies`;
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j?.networks)) {
      throw new Error(`GET ${url}: unexpected body (want v2 {networks:[…]}): ${JSON.stringify(j).slice(0, 300)}`);
    }
    const section = (environment) =>
      j.networks.find((n) => n.protocol === 'icp' && n.environment === environment)?.assets ?? [];
    return [...section('mainnet'), ...section('testnet')];
  } catch (e) {
    if (e instanceof Error && /^GET /.test(e.message)) throw e;
    throw new Error(`GET ${url} failed: ${e instanceof Error ? e.message : e}`);
  } finally { clearTimeout(t); }
}

/**
 * IC-rail transfer (2026-08-19 cutover): sign an icrc1_transfer update envelope as a HARNESS-side
 * payer (the stand-in for "the payer's own phone submitted it online") and POST it straight to
 * the fake-IC /api/v2 gateway the test relay mounts. Byte-identical to what the app's wasm core
 * signs (wire.mjs is the golden oracle). The request memo (nonce hex) is the reconciliation key.
 *
 * `desc` (optional) is an IC catalog row (see `icpCatalog`); when omitted it is fetched from
 * /api/v1/currencies. Returns `{ok, status, requestIdHex, bodyText}` — a 202 means accepted
 * (dedup keyed request_id; identical-byte resubmit is free and settles once).
 */
export async function railTransfer(relayBaseURL, payerSecretHex, payeePubHex, amountMinor, { currency = 0, memoHex = '', desc = null, timeoutMs = 8000 } = {}) {
  if (desc == null) {
    desc = (await icpCatalog(relayBaseURL)).find((c) => c.currency === currency);
  }
  if (!desc?.ledger) throw new Error(`railTransfer: no ledger for currency ${currency}`);
  const { icpPrincipalBytes, icpTransferArgBytes, icpSignUpdate } = await import('./wire.mjs');
  const arg = icpTransferArgBytes(icpPrincipalBytes(payeePubHex), BigInt(amountMinor), {
    fee: desc.fee != null ? BigInt(desc.fee) : null,
    memoHex,
  });
  const expiry = BigInt(Date.now() + 300_000) * 1_000_000n;
  const signed = await icpSignUpdate(payerSecretHex, desc.ledger, 'icrc1_transfer', arg, expiry);
  const url = `${relayBaseURL}/api/v2/canister/${desc.ledger}/call`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const bytes = new Uint8Array(signed.envelopeHex.match(/../g).map((h) => parseInt(h, 16)));
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/cbor' }, body: bytes, signal: ctrl.signal });
    const bodyText = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, requestIdHex: signed.requestIdHex, bodyText };
  } catch (e) {
    throw new Error(`POST ${url} failed (transport): ${e instanceof Error ? e.message : e}`);
  } finally { clearTimeout(t); }
}

/**
 * The payee/payer PRINCIPAL TEXT (self_authenticating of the app pubkey) — what the fake-IC
 * gateway keys balances/txns on and what /api/v1/transactions rows carry in from/to. Flows assert
 * on this text (the pubkey-hex history rows of the facade era are gone).
 */
export async function railPrincipalText(pubHex) {
  const { icpPrincipalBytes, principalToText } = await import('./wire.mjs');
  return principalToText(icpPrincipalBytes(pubHex));
}

/**
 * POST `/api/v1/faucet` `{account, currency?, amount?}` → credits fake-IC at the ARBITRARY
 * account hex's PRINCIPAL (self_authenticating of the pubkey — exactly where the rail keys
 * balances). `currency` defaults to the relay's DEMO (0); pass `{currency: N}` to fund a
 * multi-asset flow (ckBTC=1, ckUSDC=2, …) the way the old test/deposit/seed route used to.
 * Returns `{ok, status, body}`; a non-2xx (e.g. cooldown) surfaces in `body.error`. Throws on
 * transport failure (see `railTransfer`).
 */
export async function faucetAccount(relayBaseURL, accountHex, amount, opts = {}) {
  const { currency, timeoutMs = 6000 } = opts;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const url = `${relayBaseURL}/api/v1/faucet`;
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: accountHex, amount, ...(currency != null ? { currency } : {}) }), signal: ctrl.signal,
    });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    throw new Error(`POST ${url} failed (transport): ${e instanceof Error ? e.message : e}`);
  } finally { clearTimeout(t); }
}
