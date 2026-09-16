// Top-level orchestrator — runs every `tests/NN-name.mjs` in a BOUNDED PARALLEL pool, each driving
// the shared relay + web + browser (one process) through a FRESH incognito context (fresh identity).
// The first RED test stops the pool from STARTING new tests (fail-fast); in-flight tests drain so no
// context is orphaned, then the run exits non-zero with the first failure. Tail output is the suite
// summary with per-test timing.
//
// Usage: `node run.mjs` (local, default) | `DPAY_E2E_MODE=live node run.mjs` (live).
// Concurrency: `DPAY_E2E_CONCURRENCY=N` (default 12; `1` = sequential, useful for debugging).
// Filter:     `DPAY_E2E_FILTER=<token>` runs only tests the token matches. A token matches on ANY of:
//             filename substring (legacy), meta.id (`07`), meta.name (`scan-pay`), meta.journey
//             (`pay` → every pay flow), or a covers slug (`receipt`). Comma-separated for several,
//             e.g. `DPAY_E2E_FILTER=07,13,15` or `pay,offline`. Free ports per run → parallel
//             `node run.mjs` invocations do not collide; use the filter for fast per-test TDD.
//
// --- Why parallel is sound here (the concurrency-safety proof) ---
// The shared relay is concurrency-safe by construction: FakeLedger holds ALL state (balances, spent
// nonces, txns, pending deposits) behind ONE `Mutex<FakeState>` (crates/dpay-relay/src/ledger.rs),
// and the relay's idempotency cache is `Arc<Mutex<HashMap>>` — every read-check-write serializes on
// the lock, so concurrent requests cannot data-race. Each test onboards a DISTINCT random 32-byte
// pubkey (on-device keygen) → distinct `(pubkey, currency)` balance keys → no balance collision;
// each payment nonce is a random 16-byte value → collision-free across tests; the faucet funds each
// test's OWN distinct account; balance/history reads are account-scoped. So N parallel browser
// contexts against the one relay touch DISJOINT account/nonce keys, and the only shared mutable
// structures (spent set, txn log, idempotency cache) are append/insert under a mutex. Browser
// contexts are isolated (fresh localStorage each → fresh identity). Screenshots use distinct
// filenames. Therefore parallel execution changes NO assertion and adds NO cross-test coupling — it
// only overlaps independent flows. (If a future test ever reuses a fixed account/nonce, it must be
// marked exclusive; none do today.)
//
// Add a flow = add `tests/NN-name.mjs` exporting `async function run()` + a `meta` export (see
// harness/meta.mjs). No other change needed — the harness auto-discovers it, filters by it, and
// regenerates FLOWS.md from it.
import os from 'node:os';
import fs from 'node:fs';
import { stopSession, killTrackedChildren, _testCtx, dumpDiagnosticsFor } from './harness/lib.mjs';
import { loadTestsMeta, filterByToken, JOURNEYS } from './harness/meta.mjs';

// Default concurrency: 12. The host has 16 cores; each parallel test is one chrome incognito context
// against the shared relay + web + browser process. 12 leaves headroom for the relay/web/V8 and is
// the measured sweet spot (the suite is bounded by the slowest test on the critical path, not raw
// throughput, so going higher yields diminishing returns and risks CPU contention thrash). Tunable
// via env; `DPAY_E2E_CONCURRENCY=1` runs sequentially (debugging).
const DEFAULT_CONCURRENCY = 12;
const FALLBACK_TIMEOUT_MS = 60_000;

/**
 * Triage mode: `DPAY_E2E_NO_FAILFAST=1` lets every flow attempt regardless of earlier REDs (the
 * default fail-fast aborts ~45 flows on one flake, yielding almost no signal under contention).
 * `firstFailure` still records the first RED for the exit code (exit 1 if any test failed), but
 * doesn't stop new tests from starting. Useful for surfacing ALL flakes in one run instead of one.
 */
const noFailFast = process.env.DPAY_E2E_NO_FAILFAST === '1';

/**
 * How overloaded is the host RIGHT NOW? Returns the ratio of 1-min load average to logical cores.
 * ≤1 means the host has headroom (idle-ish); ≥2 means the runqueue is at least 2× oversubscribed —
 * every flow will run that much slower, so per-test timeouts must scale up by the same factor or they
 * false-fire on slow (not hung) hardware. This is the difference between a GREEN-but-slow suite on a
 * busy shared dev box and a uniformly RED one.
 *
 * The load average is a trailing metric (1-min window), so this is a one-shot decision at run start —
 * it does NOT re-adapt mid-run. That's fine: we pick a sustainable concurrency + timeout scale up
 * front and hold them for the whole run. If the host frees up, the next `just e2e` picks the faster
 * settings automatically.
 */
function hostLoadFactor() {
  const cpus = os.cpus().length || 4;
  const load1 = os.loadavg()[0]; // 1-min load average (runqueue length)
  return { cpus, load1, factor: Math.max(1, load1 / cpus) };
}

/**
 * Sustainable concurrency: the number of heavy browser contexts the host can run in parallel WITHOUT
 * thrashing. Estimated as the free cores (cores − 1-min load), clamped to [2, 12]. On an idle 16-core
 * box → 12 (the cap); on a box at load 35 → 2 (the floor). This keeps the suite GREEN on a busy shared
 * host (slower but reliable) instead of uniformly RED. An explicit `DPAY_E2E_CONCURRENCY` overrides it.
 */
function autoConcurrency() {
  const { cpus, load1 } = hostLoadFactor();
  const headroom = cpus - load1;
  return Math.min(DEFAULT_CONCURRENCY, Math.max(2, Math.round(headroom)));
}

/**
 * Per-context slowdown the run inflicts ON ITSELF by running `concurrency` flows at once.
 *
 * `hostLoadFactor` only sees load that ALREADY EXISTS (a 1-min trailing average, sampled before the
 * first context launches). It therefore cannot see the run's own contention — and the two pull in
 * opposite directions: an idle host yields the MAXIMUM concurrency (12) and simultaneously the
 * MINIMUM timeout headroom (×1.00). That inversion is why the suite went red on a QUIET machine
 * while every one of those flows passed in isolation.
 *
 * Slowdown tracks concurrency rather than spare cores because the contexts are not independent:
 * all of them share ONE browser process (`launched (shared across tests; fresh context per test)`),
 * so its main/IO threads serialize a fraction of every flow. Spare cores do not relieve that.
 *
 * CONTENTION_PER_CONTEXT is empirical, with deliberate margin: 12-settings runs ~9.9s alone and
 * ~21.1s at concurrency 12 (≈2.1×), so 0.15 predicts ≈2.65× — ~25% above the worst case measured.
 * Erring high is the correct bias: this timeout exists to catch a genuine HANG (which never
 * finishes, so a looser bound still catches it), whereas a bound that is too tight produces false
 * REDs on healthy code — the expensive failure, and the one that erodes trust in the gate.
 */
const CONTENTION_PER_CONTEXT = 0.15;
function selfContentionFactor(concurrency) {
  return 1 + Math.max(0, concurrency - 1) * CONTENTION_PER_CONTEXT;
}

/**
 * The per-test timeout scale: the WORSE of ambient load and self-inflicted contention. The host may
 * already be busy, and we are about to make it busier ourselves; either term alone under-predicts a
 * flow's wall clock.
 *
 * This is the ONE definition on purpose. It previously lived in two places — `runTestsSubset`
 * derived it from load, and the `just e2e` entry derived it again and passed it in as an explicit
 * override — so fixing one silently left the other authoritative on the main path.
 */
function resolveTimeoutScale(load, concurrency) {
  return Math.max(load.factor, selfContentionFactor(concurrency));
}

/**
 * Resolve run concurrency: an explicit `DPAY_E2E_CONCURRENCY` wins (the caller knows their host);
 * otherwise auto-pick from current headroom. Returns `{ concurrency, auto, load }` so the startup log
 * can report exactly which path was taken (debuggable — no silent magic).
 */
function resolveConcurrency() {
  const load = hostLoadFactor();
  const env = process.env.DPAY_E2E_CONCURRENCY;
  if (env !== undefined && env !== '') {
    const raw = parseInt(env, 10);
    if (Number.isFinite(raw) && raw >= 1) return { concurrency: raw, auto: false, load };
  }
  return { concurrency: autoConcurrency(), auto: true, load };
}

/**
 * Discover + filter the tests via the shared metadata loader. A token matches on filename (legacy),
 * meta.id, meta.name, meta.journey, or a covers slug — so `DPAY_E2E_FILTER=pay` runs the whole pay
 * journey, `=07` runs flow 07, `=scan-pay` runs by slug, `=receipt` runs every flow covering receipts.
 * Comma-separated for several. Empty = all (minus `meta.optional` flows — see below). Returns
 * objects with `{file, id, name, path, meta}`.
 *
 * OPTIONAL flows: a flow marked `meta.optional = true` (e.g. 39-store-screens, a render-only
 * capture harness with no behavior contract) is EXCLUDED from the default enumeration so `just e2e`
 * is a pure behavior gate. It stays reachable via ANY explicit filter token that matches it
 * (id/name/journey/covers/filename — e.g. `just e2e-store` filters on `store-screens`), so the
 * optional flow is never orphaned. An explicit filter ALWAYS wins over the exclusion.
 */
export async function loadTests() {
  const all = await loadTestsMeta();
  const filterRaw = process.env.DPAY_E2E_FILTER ?? '';
  const tokens = filterRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const pool = tokens.length === 0 ? all.filter((t) => !t.meta?.optional) : all;
  return filterByToken(pool, filterRaw);
}

/** Race `promise` against a hard timeout; reject with a labeled, debuggable error on expiry. The
 *  message names the EFFECTIVE timeout (after the host-load scale) so a false-fire is self-diagnosing:
 *  if a flow trips a 33s timeout on a host whose load factor is ×2.2, the base timeout was 15s and the
 *  flow genuinely hung (vs. just running slowly under contention). */
export function withTimeout(promise, timeoutMs, label) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[${label}] exceeded its per-test timeout of ${timeoutMs}ms (after host-load scaling) — likely a genuine hang; a merely-slow flow should have completed by now`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

async function runOne(test, timeoutScale) {
  const mod = await import(`file://${test.path}`);
  if (typeof mod.run !== 'function') throw new Error(`${test.file}: no \`run\` export`);
  const base = test.meta?.timeoutMs ?? FALLBACK_TIMEOUT_MS;
  const effective = Math.round(base * timeoutScale);
  // Wrap mod.run() in an AsyncLocalStorage context carrying the test file. setup() (called inside
  // the flow body) reads this store to register its freshly-created driver into the per-test
  // registry, so runPool's catch can later reach it for the RED-path diagnostics dump. ALS
  // propagates through native async/promise boundaries in Node 18+, surviving the
  // runOne → mod.run → flow body → setup() chain. No flow file had to change.
  const run = _testCtx.run(test.file, () => mod.run());
  await withTimeout(run, effective, test.file);
}

/**
 * A bounded parallel pool that preserves FAIL-FAST: as soon as one test fails, no further tests are
 * STARTED; in-flight tests are allowed to finish (so their contexts tear down cleanly), then the
 * pool drains. Returns the ordered results + the first failure (if any).
 */
async function runPool(tests, concurrency, timeoutScale) {
  const results = new Map(); // name -> { ok, ms, err? }
  let firstFailure = null;
  let nextIdx = 0;
  let activeWorkers = 0;
  let resolveAll;
  const allDone = new Promise((r) => { resolveAll = r; });

  const maybeFinish = () => {
    // Drain when every test has been started (or we've stopped enqueueing after a failure) AND no
    // worker is still running a test. In no-failfast mode, `firstFailure` does NOT stop enqueueing.
    const exhausted = (!noFailFast && firstFailure) || nextIdx >= tests.length;
    if (exhausted && activeWorkers === 0) resolveAll();
  };

  const startOne = async () => {
    if (firstFailure && !noFailFast) return; // fail-fast: don't start new tests after a failure
    const idx = nextIdx++;
    if (idx >= tests.length) return;
    const test = tests[idx];
    const key = test.file;
    // A flow whose module import failed (retired-helper imports mid-cutover) is skipped LOUDLY —
    // never silently dropped, never counted as passed, and does NOT trip fail-fast (it needs its
    // own rewrite wave, not this run's diagnostics). The final verdict still fails on it. (Dormant
    // insurance post-cutover: the suite currently has zero broken flows; the machinery stays so a
    // future retirement wave degrades loudly instead of hard-crashing the run.)
    if (test.broken) {
      results.set(key, { ok: false, ms: 0, err: new Error(`BROKEN (import failed): ${test.broken}`), broken: true });
      console.error(`  ⚠ ${key}  SKIPPED — module import failed: ${test.broken}`);
      void startOne(); // keep the worker chain alive (this slot is done instantly)
      return;
    }
    activeWorkers++;
    const tStart = Date.now();
    try {
      await runOne(test, timeoutScale);
      results.set(key, { ok: true, ms: Date.now() - tStart });
      console.log(`  ✓ ${key}  ${((Date.now() - tStart) / 1000).toFixed(2)}s`);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // Dump diagnostics (screenshot/DOM/console/timeline/error) BEFORE recording the failure. The
      // flow's own `finally { await env.stop(); }` has usually already closed the page by now, so
      // screenshot/DOM are best-effort — but the in-memory timeline + consoleLog + error always
      // land. Wrapped so a diagnostics failure can NEVER mask the real RED error.
      try {
        const dir = await dumpDiagnosticsFor(test.file, err);
        if (dir) console.error(`  diagnostics dumped to ${dir}`);
      } catch (diagErr) {
        console.error(`  (diagnostics dump failed: ${diagErr instanceof Error ? diagErr.message : diagErr})`);
      }
      results.set(key, { ok: false, ms: Date.now() - tStart, err });
      if (!firstFailure) firstFailure = { key, err };
      console.error(`  ✗ ${key}  RED after ${((Date.now() - tStart) / 1000).toFixed(2)}s: ${err.stack || err.message || err}`);
    } finally {
      activeWorkers--;
      // Spawn the next test (unless we've fail-fast-stopped), then check for drain.
      if (!firstFailure || noFailFast) {
        void startOne();
      }
      maybeFinish();
    }
  };

  // Seed `concurrency` workers (but never more than there are tests).
  const seeded = Math.min(concurrency, tests.length);
  for (let i = 0; i < seeded; i++) void startOne();

  await allDone;
  return { results, firstFailure };
}

/**
 * Run a SUBSET of tests through the bounded-parallel pool, print the per-test summary + coverage
 * matrix for the subset, optionally tear down the shared session, and return the verdict. This is
 * the shared runner both `main()` (the all-flows `just e2e` entry) and `e2e/watch.mjs` (the long-
 * running dev loop) call. It does NOT print the startup banner — the caller decides what to print
 * before the run (so the watcher can print its own re-run header).
 *
 * Options:
 *   - `concurrency`  (number)  override the auto/explicit concurrency resolution (caller-knows).
 *                              If omitted, the same `resolveConcurrency()` as `main()` is used.
 *   - `timeoutScale` (number)  override the host-load timeout scale. If omitted, derived from load.
 *   - `keepSession`  (boolean) if TRUE, do NOT call `stopSession()` after the run — the shared
 *                              relay+web+browser process PERSISTS for the next re-run. The caller
 *                              (e2e/watch.mjs) is then responsible for tearing it down on exit.
 *                              Default FALSE → tears down (the `just e2e` behavior).
 *
 * Returns `{ passed, total, elapsed, firstFailure, timeoutScale }`. Does NOT call `process.exit` —
 * the caller decides the exit code (the watcher keeps running on RED; the one-shot run exits 1).
 *
 * The fail-fast behavior (no further tests STARTED after the first RED; in-flight tests drain) is
 * inherited from `runPool`. The per-test timeout scaling (so a slow-under-load host doesn't false-
 * fire) is preserved: `effective = base * timeoutScale`.
 *
 * The load-adjusted 30s×factor slip target is ONLY checked when `keepSession` is FALSE — a watch
 * re-run of a single journey is not the full-suite gate, so the slip signal doesn't apply there.
 */
export async function runTestsSubset(tests, opts = {}) {
  const startedAt = Date.now();
  const { concurrency: explicitConcurrency, timeoutScale: explicitScale, keepSession = false } = opts;

  const resolved = explicitConcurrency
    ? { concurrency: explicitConcurrency, auto: false, load: hostLoadFactor() }
    : resolveConcurrency();
  const timeoutScale = explicitScale ?? resolveTimeoutScale(resolved.load, resolved.concurrency);

  // Publish the scale to the driver so a flow's INNER waits stretch with the host exactly as its
  // wall-clock budget does. Two notions of "how slow is this host" is how a loaded machine produced
  // "element not visible within 5000ms" — a statement about the app that was really about the box.
  process.env.DPAY_E2E_TIMEOUT_SCALE = String(timeoutScale);
  const { results, firstFailure } = await runPool(tests, resolved.concurrency, timeoutScale);

  // Timing seam: testruns.py points DPAY_TESTRUNS_TIMING at a file; dump per-flow wall
  // times so `just timing e2e` shows exactly where the suite's time went. Best-effort —
  // a dump failure must never affect the run itself.
  const timingPath = process.env.DPAY_TESTRUNS_TIMING;
  if (timingPath) {
    try {
      const flows = tests.map((t) => {
        const r = results.get(t.file);
        return { name: t.file, ok: !!r?.ok, secs: (r?.ms ?? 0) / 1000, ran: !!r };
      });
      fs.writeFileSync(timingPath, JSON.stringify({ format: 'e2e-flows', flows }));
    } catch (e) {
      console.error(`  (timing dump failed: ${e instanceof Error ? e.message : e})`);
    }
  }

  // Tear down the shared relay + web server + browser once the run is done (pass OR fail) — UNLESS
  // the caller asked to keep it alive (watch mode reuses it across re-runs).
  if (!keepSession) await stopSession();

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  const passed = [...results.values()].filter((r) => r.ok).length;
  const total = tests.length;

  // Ordered per-test summary (so the report is stable regardless of completion order).
  console.log('\n--- results ---');
  for (const test of tests) {
    const r = results.get(test.file);
    if (!r) { console.log(`  · ${test.file}  (not run${noFailFast ? '' : ' — fail-fast'})`); continue; }
    const mark = r.ok ? '✓' : '✗';
    console.log(`  ${mark} ${test.file}  ${(r.ms / 1000).toFixed(2)}s`);
  }

  // Coverage matrix: journey → flows, for the selected set. Makes the suite self-describing at a
  // glance and surfaces journeys with thin coverage. Derived purely from each flow's `meta`.
  console.log('\n--- coverage (journey → flows) ---');
  for (const journey of JOURNEYS) {
    const inJourney = tests.filter((t) => t.meta.journey === journey);
    if (inJourney.length === 0) continue;
    const label = journey.padEnd(10);
    const flows = inJourney.map((t) => `${t.meta.id}-${t.meta.name}`).join(' · ');
    console.log(`  ${label} [${String(inJourney.length).padStart(2)}]   ${flows}`);
  }

  if (firstFailure) {
    console.error(`\n[run] FAILED in ${elapsed}s (first RED: ${firstFailure.key})`);
  } else {
    const brokenCount = [...results.values()].filter((r) => r.broken).length;
    if (brokenCount > 0) {
      // (Dormant insurance post-cutover — see the `test.broken` note in runPool. Kept so a future
      // helper-retirement wave surfaces here instead of crashing the run outright.)
      console.error(`\n[run] ${passed}/${total} GREEN in ${elapsed}s — but ${brokenCount} flow(s) SKIPPED (module import failed; pending IC-rail rewrite)`);
    } else {
      console.log(`\n[run] ${passed}/${total} GREEN in ${elapsed}s`);
    }
    // The target scales with suite size: 18 flows → 15s; the Wave-E expansion to 24 flows → 20s; wire-
    // format v2 (flow 26 + per-payment name encoding) → 22s; the Phase-4 coverage expansion to 44 flows
    // (00-43, incl. visual-regression + a11y census + receipt-reject + decimal-edges) → ~30s. The suite
    // runs real-browser flows in a bounded-parallel pool; CPU contention adds ±3s variance. The target
    // is a LOAD-ADJUSTED ceiling — on a busy shared host the per-flow wall time inflates by the load
    // factor, so a 30s×factor budget keeps the signal meaningful (a genuinely regressed suite still
    // trips it; a merely-loaded host does not). The raw 30s target is what an idle 16-core box should
    // hit. Only meaningful for a full-suite run — skipped in watch mode (keepSession) where a single
    // journey re-runs.
    if (!keepSession) {
      const target = 30 * timeoutScale;
      if (parseFloat(elapsed) > target) {
        console.warn(`[run] ⚠️  suite slipped past the load-adjusted target of ${target.toFixed(0)}s (took ${elapsed}s, load factor ×${timeoutScale.toFixed(2)}) — flag this`);
      }
    }
  }

  return { passed, total, elapsed, firstFailure, results, timeoutScale };
}

/**
 * The `just e2e` entry: discover + filter the tests (via DPAY_E2E_FILTER), print the startup banner,
 * run them via `runTestsSubset`, and translate the verdict to a process exit code. Behavior here is
 * preserved byte-for-byte from before the `runTestsSubset` extraction — the banner wording, the
 * concurrency/load reporting, the slip-target warning, and the exit codes all match the original
 * `main()`. The runner itself (pool + summary + verdict) now lives in `runTestsSubset` so the watch
 * loop can re-invoke it without re-printing the banner or re-launching the shared session.
 */
async function main() {
  const tests = await loadTests();
  if (tests.length === 0) {
    console.error('[run] no tests matched (check DPAY_E2E_FILTER — try a journey/id/name/covers slug)');
    process.exit(1);
  }
  const { concurrency, auto, load } = resolveConcurrency();
  const timeoutScale = resolveTimeoutScale(load, concurrency);
  const filter = process.env.DPAY_E2E_FILTER ?? '';
  const filterNote = filter
    ? ` matching filter "${filter}" (by journey/id/name/filename/covers)`
    : '';
  const concurrencyNote = auto
    ? `concurrency=${concurrency} (auto: load ${load.load1.toFixed(1)} on ${load.cpus} cores → headroom ${Math.max(0, load.cpus - load.load1).toFixed(1)}, timeout scale ×${timeoutScale.toFixed(2)} = max(load ×${load.factor.toFixed(2)}, contention ×${selfContentionFactor(concurrency).toFixed(2)}))`
    : `concurrency=${concurrency} (explicit; timeout scale ×${timeoutScale.toFixed(2)} = max(load ×${load.factor.toFixed(2)} on ${load.cpus} cores, contention ×${selfContentionFactor(concurrency).toFixed(2)}))`;
  console.log(
    `[run] running ${tests.length} test(s)${filterNote} in ${process.env.DPAY_E2E_MODE ?? 'local'} mode` +
    ` (parallel, ${concurrencyNote})` +
    `${noFailFast ? ' [NO-FAILFAST: every flow attempts; first RED still sets exit 1]' : ''}\n`,
  );

  const { firstFailure, results } = await runTestsSubset(tests, { concurrency, timeoutScale });
  // Broken (import-failed, pending-rewrite) flows don't trip fail-fast, but they must still fail
  // the run — a suite with silently-skipped flows is a false green. (The broken path is dormant
  // insurance post-cutover; see runPool's `test.broken` note.)
  if (firstFailure || [...results.values()].some((r) => r.broken)) process.exit(1);
}

// --- process-level safety net (prevent orphaned child processes) ---------------------------------
//
// The shared session spawns long-lived children (the relay binary + the sirv web server — registered
// into harness/procs.mjs at spawn time) whose NORMAL teardown is the async `stopSession()` called
// from `runTestsSubset` on completion. But an ABNORMAL exit — Ctrl-C (SIGINT), SIGTERM, SIGHUP, an
// uncaughtException, or an unhandledRejection — can kill Node BEFORE that async drain completes,
// orphaning the children. Over many sessions ~9 zombie relays accumulated this way and starved the
// host (load avg 55 on 16 cores → flaky e2e). After `pkill -f dpay-relay` the suite went 67/67 green.
//
// This net has two layers, both required:
//   1. Signal/exception handlers → best-effort ASYNC `stopSession()` (graceful SIGTERM + SIGKILL
//      after 2s per child) + a force-exit timer so a wedged teardown can't hang the exit, then exit
//      non-zero. Re-entrancy-guarded: a SECOND Ctrl-C exits IMMEDIATELY (no waiting on the drain).
//   2. `process.on('exit', killTrackedChildren)` → a SYNC SIGKILL of every tracked child PID still
//      alive. The `exit` event CANNOT await, so this is the ONLY layer that can fire when an
//      uncaughtException routes straight to `process.exit`. It is a no-op on the happy path (children
//      already dead → ESRCH swallowed) and lifesaving on every abnormal path. This is what makes
//      orphaning structurally impossible: no tracked child can outlive the harness process.
//
// Registered ONLY when run.mjs is the direct entry (the `import.meta.url` guard below) — watch.mjs
// imports `runTestsSubset` and installs its OWN handlers, so registering here unconditionally would
// double-register in watch mode.
let cleaning = false;
function teardownAndExit(code) {
  if (cleaning) process.exit(code); // a second Ctrl-C → immediate exit (don't wait on the first drain)
  cleaning = true;
  process.stderr.write(`[run] exit(${code}) — tearing down shared session (relay + web + browser)…\n`);
  // Force-exit fallback: if stopSession stalls on a child that won't die, exit hard after 6s so the
  // operator never has to SIGKILL the harness (which would itself orphan the children). The natural
  // drain is ≤ ~4-5s (relay SIGTERM+2s grace, then web SIGTERM+2s grace, then browser close); 6s
  // leaves headroom. REF'd so the timer actually keeps the event loop alive until it fires.
  const force = setTimeout(() => {
    process.stderr.write('[run] force-exit after 6s (a child may not have torn down cleanly)\n');
    process.exit(code);
  }, 6_000);
  stopSession()
    .catch((e) => process.stderr.write(`[run] teardown error (continuing to exit): ${e instanceof Error ? e.message : e}\n`))
    .finally(() => { clearTimeout(force); process.exit(code); });
}

function installExitHandlers() {
  // SIGINT-family: best-effort graceful teardown, then exit with the conventional 128+signum code.
  process.on('SIGINT', () => teardownAndExit(130));   // 128 + SIGINT(2)  — Ctrl-C
  process.on('SIGTERM', () => teardownAndExit(143));  // 128 + SIGTERM(15) — default `kill`
  process.on('SIGHUP', () => teardownAndExit(129));   // 128 + SIGHUP(1)   — terminal hangup
  // An uncaught exception or unhandled rejection means the process is in an unknown state; log it,
  // tear down best-effort, and exit non-zero (do NOT keep running — that masks bugs). Without these
  // the default behavior is a hard exit that skips the async teardown entirely → orphaned children.
  process.on('uncaughtException', (e) => {
    process.stderr.write(`[run] uncaughtException: ${e instanceof Error ? e.stack || e.message : e}\n`);
    teardownAndExit(1);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[run] unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : reason}\n`);
    teardownAndExit(1);
  });
  // SYNC last-resort: fires on EVERY exit (normal + abnormal) and SIGKILLs any tracked child still
  // alive. On normal completion stopSession has already killed them (ESRCH → no-op). On abnormal exit
  // this is the guarantee. See harness/procs.mjs.
  //
  // NOTE: wrapped in an arrow (NOT `process.on('exit', killTrackedChildren)` directly) because the
  // `exit` event passes the exit CODE as the first arg — a bare reference would feed that code into
  // killTrackedChildren's `signal` param (e.g. signal=130), and `process.kill(pid, 130)` is an invalid
  // signal → EINVAL → swallowed by the catch → NO kill → orphan. The arrow calls it with no args so
  // `signal` defaults to 'SIGKILL'. (This is exactly the bug that let the relay survive the first
  // SIGINT-verification attempt.)
  process.on('exit', () => killTrackedChildren());
}

// Only auto-run when invoked directly (`node run.mjs` / `just e2e`). When imported (by
// `e2e/watch.mjs` reusing `runTestsSubset`), main() does NOT fire — the importing module decides
// when to run. Same guard pattern the test files use (`if (import.meta.url === process.argv[1])`).
// Without this guard, `import { runTestsSubset } from './run.mjs'` would side-effect the entire
// suite as soon as the module loads. The exit handlers are installed HERE (under the same guard) so
// watch mode — which has its own handlers — never double-registers.
if (import.meta.url === `file://${process.argv[1]}`) {
  installExitHandlers();
  main().catch((e) => {
    console.error(`[run] FATAL: ${e.stack || e.message}`);
    process.exit(1);
  });
}
