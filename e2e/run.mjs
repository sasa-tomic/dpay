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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopSession, killTrackedChildren, _testCtx, dumpDiagnosticsFor, laneBrowser, primeBrowserShards } from './harness/lib.mjs';
import { loadTestsMeta, filterByToken, JOURNEYS } from './harness/meta.mjs';
import { PROFILING, profileSnapshot, profileOpTotals, profilePhaseTotals } from './harness/profile.mjs';

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
 * thrashing. Estimated as the free cores (cores − 1-min load), clamped to [6, 12]. On an idle 16-core
 * box → 12 (the cap); on a heavily loaded shared box → 6 (the floor). The floor is deliberate,
 * measured 2026-09-16: wall time is FLAT across c6–c12 (full suite 462.8s at c6 vs 475.3s at c12 —
 * the extra lanes are almost exactly cancelled by self-contention, and the timeout scale absorbs the
 * rest) while c6 stays GREEN, so slowing FURTHER buys nothing but wall time. The old floor of 2 is
 * exactly how this suite recorded a 968.6s run: external load on the shared dev box (a sibling CI
 * runner + other sessions) collapsed `headroom` to 2 and every flow ran near-serially. A busy host
 * is the timeout scale's job (`resolveTimeoutScale`), not the lane count's. An explicit
 * `DPAY_E2E_CONCURRENCY` overrides it.
 */
function autoConcurrency() {
  const { cpus, load1 } = hostLoadFactor();
  const headroom = cpus - load1;
  return Math.min(DEFAULT_CONCURRENCY, Math.max(6, Math.round(headroom)));
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
 * The model is the WORSE of two sharing terms: contexts-per-BROWSER-PROCESS (one chrome process
 * serializes a fraction of every context's work on its main/IO threads — spare cores do not
 * relieve that) and LANES-PER-FREE-CORE (the run's own chromes + drivers oversubscribing whatever
 * headroom the ambient load left — spare cores very much do not relieve that).
 *
 * CONTENTION_PER_CONTEXT is empirical, with deliberate margin: 12-settings runs ~9.9s alone and
 * ~21.1s at concurrency 12 (≈2.1×), so 0.15 predicts ≈2.65× at 12 ctx/browser — ~25% above the
 * worst case measured. Erring high is the correct bias: this timeout exists to catch a genuine
 * HANG (which never finishes, so a looser bound still catches it), whereas a bound that is too
 * tight produces false REDs on healthy code — the expensive failure, and the one that erodes trust
 * in the gate.
 */
const CONTENTION_PER_CONTEXT = 0.15;
/**
 * Cores one active lane really wants while running (a chrome process + its node driver share the
 * same second of wall clock). The 2026-09-17 false-RED that surfaced this: with 1 ctx/browser the
 * old model scaled ×1.00 while 9 lanes ran on a box already carrying load 7.3 — flow 109's
 * scan-surface arm (5s inner wait, 18s solo) starved and REDed, though every flow is green solo.
 * Lanes ÷ free cores is the missing term; 1.5 biases high per the rule below (a false RED is the
 * expensive failure; an over-scaled wait just fires a little later on a genuine hang).
 */
const CORES_PER_LANE = 1.5;
function selfContentionFactor(concurrency, shards = 1, freeCores = concurrency) {
  const perBrowser = Math.max(1, Math.ceil(concurrency / Math.max(1, shards)));
  const browserSharing = 1 + Math.max(0, perBrowser - 1) * CONTENTION_PER_CONTEXT;
  const cpuSharing = (concurrency * CORES_PER_LANE) / Math.max(1, freeCores);
  return Math.max(browserSharing, cpuSharing);
}

/**
 * Browser-process shards for the pool. One chrome-headless-shell process serializes the main/IO
 * work of every context inside it — measured 2026-09-16 (idle 16-core box): per-flow time inflated
 * ~2.1× at concurrency 12 while the CPU sat ~96% IDLE, i.e. the lanes starved on the shared browser
 * process, not on compute — and that inflation both wasted wall time and false-fired inner waits
 * into RED on healthy flows (see 04/05 RED at tree 1d7264d, green solo minutes later). ~3
 * contexts/process was the first cut; the 2026-09-17 A/B on the SAME tree (post lazy-boot rework)
 * showed the remaining sharing still halves throughput: 12 lanes @ 3 ctx/browser ran 467.7s while
 * 7 lanes @ 1 ctx/browser (auto-picked, host load 8.5) ran 387.4s — 2.1× the lane-throughput. The
 * default is now ONE context per browser process (shards = concurrency): per-test isolation is
 * identical (fresh context per test, whatever process it lives in), and at the suite level the
 * browser processes ARE the parallelism. `DPAY_E2E_BROWSERS` overrides (1 restores the old
 * single-browser behavior); extra processes cost ~150-250MB each — 12 of them peaked at well
 * under half this 62GB host.
 */
function resolveBrowserShards(concurrency) {
  const env = process.env.DPAY_E2E_BROWSERS;
  if (env !== undefined && env !== '') {
    const raw = parseInt(env, 10);
    if (Number.isFinite(raw) && raw >= 1) return Math.min(raw, concurrency);
  }
  return concurrency;
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
function resolveTimeoutScale(load, concurrency, shards = 1) {
  const freeCores = Math.max(1, load.cpus - load.load1);
  return Math.max(load.factor, selfContentionFactor(concurrency, shards, freeCores));
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

async function runOne(test, timeoutScale, lane = 0, shards = 1) {
  const mod = await import(`file://${test.path}`);
  if (typeof mod.run !== 'function') throw new Error(`${test.file}: no \`run\` export`);
  const base = test.meta?.timeoutMs ?? FALLBACK_TIMEOUT_MS;
  // The run-start scale is a trailing 1-min average and goes stale on a bursty host: a test that
  // STARTS during a sibling-load spike must be budgeted for the spike, not for the calmer run
  // start (measured 2026-09-16: flows killed mid-crawl at scale ×1.6 while the 1-min load was 3×
  // the run-start sample). Take the max of the two at test start.
  const scale = Math.max(timeoutScale, hostLoadFactor().factor);
  const effective = Math.round(base * scale);
  // Republish with the LIVE factor so the driver's inner waits (scaled()) stretch with it too —
  // a test starting mid-spike gets spike-budgeted waits, not the run-start scale. All lanes share
  // one env; that is correct, the scale is a box-level property, and lanes differ by noise only.
  // Wrap mod.run() in an AsyncLocalStorage context carrying the test file AND this lane's browser
  // shard. setup() (called inside the flow body) reads this store to register its freshly-created
  // driver into the per-test registry (so runPool's catch can later reach it for the RED-path
  // diagnostics dump) and to create the test's context on the lane's own browser process. ALS
  // propagates through native async/promise boundaries in Node 18+, surviving the
  // runOne → mod.run → flow body → setup() chain. No flow file had to change.
  const browser = shards > 1 ? await laneBrowser(lane) : null;
  const run = _testCtx.run({ file: test.file, browser }, () => mod.run());
  process.env.DPAY_E2E_TIMEOUT_SCALE = String(scale);
  await withTimeout(run, effective, test.file);
}

/**
 * A bounded parallel pool that preserves FAIL-FAST: as soon as one test fails, no further tests are
 * STARTED; in-flight tests are allowed to finish (so their contexts tear down cleanly), then the
 * pool drains. Returns the ordered results + the first failure (if any).
 */
async function runPool(tests, concurrency, timeoutScale, shards = 1) {
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

  const startOne = async (lane = 0) => {
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
      void startOne(lane); // keep the worker chain alive (this slot is done instantly)
      return;
    }
    activeWorkers++;
    const tStart = Date.now();
    try {
      await runOne(test, timeoutScale, lane, shards);
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
        void startOne(lane);
      }
      maybeFinish();
    }
  };

  // Seed `concurrency` workers (but never more than there are tests). Each seed owns a fixed lane
  // index for its whole chain: lane → browser shard = lane % shards (runOne), so a chain never
  // migrates browser processes mid-run.
  const seeded = Math.min(concurrency, tests.length);
  for (let i = 0; i < seeded; i++) void startOne(i);

  await allDone;
  return { results, firstFailure };
}

/**
 * Per-flow duration history for LONGEST-FIRST scheduling (LPT): the pool's wall time is bounded by
 * the makespan, and the classic minimizer is to start the longest jobs first — otherwise the one
 * 136s flow (198, pinned by the relay's 60s status-spacing agreement) starts mid-run and drags a
 * single-lane tail minutes past the last short flow. The history is an EWMA of measured wall times
 * persisted across runs (`.dev/e2e-flow-timing.json`, gitignored like the rest of .dev/); a flow
 * with no history falls back to its `meta.timeoutMs` cap (corr ≈ 0.5 with actual duration — good
 * enough to keep the heavy convert/withdraw flows at the head). Absent history AND cap → the
 * default budget, so brand-new flows sort by size class rather than alphabetically.
 */
const TIMING_HISTORY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev', 'e2e-flow-timing.json');
const TIMING_EWMA_ALPHA = 0.3;

function loadTimingHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(TIMING_HISTORY_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function recordTimingHistory(results) {
  try {
    const hist = loadTimingHistory();
    for (const [file, r] of results) {
      if (typeof r?.ms !== 'number' || r.ms <= 0) continue;
      const prev = hist[file]?.ewmaMs;
      hist[file] = {
        ewmaMs: prev == null ? r.ms : Math.round(prev * (1 - TIMING_EWMA_ALPHA) + r.ms * TIMING_EWMA_ALPHA),
        runs: (hist[file]?.runs ?? 0) + 1,
        lastMs: Math.round(r.ms),
      };
    }
    fs.mkdirSync(dirname(TIMING_HISTORY_PATH), { recursive: true });
    fs.writeFileSync(TIMING_HISTORY_PATH, JSON.stringify(hist));
  } catch (e) {
    console.error(`  (timing-history write failed: ${e instanceof Error ? e.message : e})`);
  }
}

/** Longest-first ordering (LPT scheduling): start the expensive flows while every lane is free.
 *  PURELY a schedule — it changes NO assertion, no lane count, no timeout; it only decides the
 *  order tests START in, so no flow's result can depend on it beyond wall-clock contention. */
function longestFirst(tests) {
  const hist = loadTimingHistory();
  const estimate = (t) => hist[t.file]?.ewmaMs ?? t.meta?.timeoutMs ?? FALLBACK_TIMEOUT_MS;
  return [...tests].sort((a, b) => estimate(b) - estimate(a));
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
 * The parallelism-efficiency warning (wall vs Σ(flow time)/lanes) is ONLY checked when
 * `keepSession` is FALSE — a watch re-run of a single journey is not the full-suite gate, so the
 * signal doesn't apply there.
 */
export async function runTestsSubset(testsIn, opts = {}) {
  let tests = testsIn;
  const startedAt = Date.now();
  const { concurrency: explicitConcurrency, timeoutScale: explicitScale, keepSession = false } = opts;

  const resolved = explicitConcurrency
    ? { concurrency: explicitConcurrency, auto: false, load: hostLoadFactor() }
    : resolveConcurrency();
  const timeoutScale = explicitScale ?? resolveTimeoutScale(resolved.load, resolved.concurrency);

  // Longest-first start order (makespan minimization): the heavy flows claim lanes while all lanes
  // are free, instead of surfacing as a single-lane tail at the end. Pure re-ordering — same tests,
  // same assertions, same timeouts.
  tests = longestFirst(tests);

  // Publish the scale to the driver so a flow's INNER waits stretch with the host exactly as its
  // wall-clock budget does. Two notions of "how slow is this host" is how a loaded machine produced
  // "element not visible within 5000ms" — a statement about the app that was really about the box.
  process.env.DPAY_E2E_TIMEOUT_SCALE = String(timeoutScale);
  // Browser shards: spread the lanes across several chrome processes (ONE process serializes its
  // contexts — see resolveBrowserShards). Clamped by tests.length so a small subset doesn't launch
  // more browsers than lanes; primed up-front so no lane pays a mid-run launch.
  const shards = Math.min(resolveBrowserShards(resolved.concurrency), tests.length);
  await primeBrowserShards(shards);
  const { results, firstFailure } = await runPool(tests, resolved.concurrency, timeoutScale, shards);

  // Timing seam: testruns.py points DPAY_TESTRUNS_TIMING at a file; dump per-flow wall
  // times so `just timing e2e` shows exactly where the suite's time went. Best-effort —
  // a dump failure must never affect the run itself. The same measurements also feed the
  // cross-run EWMA history the longest-first scheduler reads on the next run.
  recordTimingHistory(results);
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

  // Profiler dump (DPAY_E2E_PROFILE=1): write the phase/op spans + print the "where did the
  // seconds go" summary. Best-effort — never affects the verdict. Skipped in watch mode
  // (keepSession), where a partial re-run would produce a misleading cumulative dump.
  if (PROFILING && !keepSession) dumpProfile(tests, results, elapsed);
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
    // The honest "did the pool do its job" signal is PARALLELISM EFFICIENCY, not a fixed wall
    // target: the per-flow times are known only after the run, so compare the wall against the
    // ideal for the lanes actually used — Σ(flow ms) / concurrency. Within ~1.5× of ideal means
    // the lanes ran full (stragglers + the serial tail explain the rest); beyond that, lanes
    // starved (host oversubscription, a relay/browser wedge) or a single straggler dominates the
    // tail — both worth naming. The old fixed target (30s × load factor) predates the suite's
    // growth past ~30 flows and fired on EVERY full run, which is noise, not signal. Only
    // meaningful for a full-suite run — skipped in watch mode (keepSession) where a single
    // journey re-runs.
    if (!keepSession) {
      const sumMs = [...results.values()].reduce((a, r) => a + (r.ms ?? 0), 0);
      const ideal = sumMs / 1000 / resolved.concurrency;
      if (parseFloat(elapsed) > ideal * 1.5) {
        console.warn(`[run] ⚠️  wall ${elapsed}s is >1.5× the ${resolved.concurrency}-lane ideal (Σ flow time ${(sumMs / 1000).toFixed(0)}s → ideal ${ideal.toFixed(0)}s) — lanes starved or a straggler dominates the tail; flag this`);
      }
    }
  }

  return { passed, total, elapsed, firstFailure, results, timeoutScale };
}

/**
 * Profiler summary + JSON dump (DPAY_E2E_PROFILE=1). Prints three tables — suite-level op totals
 * (which op class eats the wall clock), phase totals (where the fixed costs sit), and the slowest
 * flows with their phase split — and writes the full span dump to `$DPAY_E2E_PROFILE` when it is a
 * path, else `e2e/shots/profile-<ts>.json`.
 */
function dumpProfile(tests, results, elapsed) {
  try {
    const opTotals = profileOpTotals();
    const phaseTotals = profilePhaseTotals();
    const snap = profileSnapshot();

    console.log('\n--- profile: op totals (all flows, inclusive) ---');
    for (const t of opTotals.slice(0, 14)) {
      console.log(`  ${t.op.padEnd(18)} ×${String(t.count).padStart(5)}  total ${(t.totalMs / 1000).toFixed(1)}s  max ${(t.maxMs / 1000).toFixed(2)}s`);
    }
    console.log('--- profile: phase totals ---');
    for (const t of phaseTotals) {
      console.log(`  ${t.name.padEnd(26)} ×${String(t.count).padStart(4)}  total ${(t.totalMs / 1000).toFixed(1)}s  max ${(t.maxMs / 1000).toFixed(2)}s`);
    }
    // Slowest flows with the phase split attributed to them (boot/context/teardown).
    const byFile = new Map();
    for (const p of snap.phases) {
      if (!p.file) continue;
      let e = byFile.get(p.file);
      if (!e) { e = { file: p.file, totalMs: 0 }; byFile.set(p.file, e); }
      e.totalMs += p.ms;
    }
    const slow = tests
      .map((t) => ({ file: t.file, wall: results.get(t.file)?.ms ?? 0, phases: byFile.get(t.file)?.totalMs ?? 0 }))
      .sort((a, b) => b.wall - a.wall)
      .slice(0, 12);
    console.log('--- profile: slowest flows (wall vs harness-phase time) ---');
    for (const s of slow) {
      console.log(`  ${s.file.padEnd(44)} wall ${(s.wall / 1000).toFixed(2)}s  harness phases ${(s.phases / 1000).toFixed(2)}s`);
    }

    const out = process.env.DPAY_E2E_PROFILE !== '1' && process.env.DPAY_E2E_PROFILE !== ''
      ? process.env.DPAY_E2E_PROFILE
      : new URL('./shots/profile-' + Date.now() + '.json', import.meta.url).pathname;
    fs.mkdirSync(new URL('.', import.meta.url).pathname + '/shots', { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ elapsedSec: Number(elapsed), opTotals, phaseTotals, ...snap }, null, 2));
    console.log(`--- profile: full dump → ${out}`);
  } catch (e) {
    console.error(`(profile dump failed: ${e instanceof Error ? e.message : e})`);
  }
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
  const shards = Math.min(resolveBrowserShards(concurrency), tests.length);
  const timeoutScale = resolveTimeoutScale(load, concurrency, shards);
  const filter = process.env.DPAY_E2E_FILTER ?? '';
  const filterNote = filter
    ? ` matching filter "${filter}" (by journey/id/name/filename/covers)`
    : '';
  const ctxNote = `${Math.ceil(concurrency / shards)} ctx/browser × ${shards} browser${shards === 1 ? '' : 's'}`;
  const concurrencyNote = auto
    ? `concurrency=${concurrency} (auto: load ${load.load1.toFixed(1)} on ${load.cpus} cores → headroom ${Math.max(0, load.cpus - load.load1).toFixed(1)}, timeout scale ×${timeoutScale.toFixed(2)} = max(load ×${load.factor.toFixed(2)}, contention ×${selfContentionFactor(concurrency, shards).toFixed(2)} @ ${ctxNote}))`
    : `concurrency=${concurrency} (explicit; timeout scale ×${timeoutScale.toFixed(2)} = max(load ×${load.factor.toFixed(2)} on ${load.cpus} cores, contention ×${selfContentionFactor(concurrency, shards).toFixed(2)} @ ${ctxNote}))`;
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
