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
import { stopSession } from './harness/lib.mjs';
import { loadTestsMeta, filterByToken, JOURNEYS } from './harness/meta.mjs';

// Default concurrency: 12. The host has 16 cores; each parallel test is one chrome incognito context
// against the shared relay + web + browser process. 12 leaves headroom for the relay/web/V8 and is
// the measured sweet spot (the suite is bounded by the slowest test on the critical path, not raw
// throughput, so going higher yields diminishing returns and risks CPU contention thrash). Tunable
// via env; `DPAY_E2E_CONCURRENCY=1` runs sequentially (debugging).
const DEFAULT_CONCURRENCY = 12;
const FALLBACK_TIMEOUT_MS = 60_000;

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
 * Comma-separated for several. Empty = all. Returns objects with `{file, id, name, path, meta}`.
 */
export async function loadTests() {
  const all = await loadTestsMeta();
  return filterByToken(all, process.env.DPAY_E2E_FILTER ?? '');
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
  await withTimeout(mod.run(), effective, test.file);
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
    // worker is still running a test.
    const exhausted = firstFailure || nextIdx >= tests.length;
    if (exhausted && activeWorkers === 0) resolveAll();
  };

  const startOne = async () => {
    if (firstFailure) return; // fail-fast: don't start new tests after a failure
    const idx = nextIdx++;
    if (idx >= tests.length) return;
    const test = tests[idx];
    const key = test.file;
    activeWorkers++;
    const tStart = Date.now();
    try {
      await runOne(test, timeoutScale);
      results.set(key, { ok: true, ms: Date.now() - tStart });
      console.log(`  ✓ ${key}  ${((Date.now() - tStart) / 1000).toFixed(2)}s`);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      results.set(key, { ok: false, ms: Date.now() - tStart, err });
      if (!firstFailure) firstFailure = { key, err };
      console.error(`  ✗ ${key}  RED after ${((Date.now() - tStart) / 1000).toFixed(2)}s: ${err.stack || err.message || err}`);
    } finally {
      activeWorkers--;
      // Spawn the next test (unless we've fail-fast-stopped), then check for drain.
      if (!firstFailure) {
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
 * The load-adjusted 22s×factor slip target is ONLY checked when `keepSession` is FALSE — a watch
 * re-run of a single journey is not the full-suite gate, so the slip signal doesn't apply there.
 */
export async function runTestsSubset(tests, opts = {}) {
  const startedAt = Date.now();
  const { concurrency: explicitConcurrency, timeoutScale: explicitScale, keepSession = false } = opts;

  const resolved = explicitConcurrency
    ? { concurrency: explicitConcurrency, auto: false, load: hostLoadFactor() }
    : resolveConcurrency();
  const timeoutScale = explicitScale ?? resolved.load.factor;

  const { results, firstFailure } = await runPool(tests, resolved.concurrency, timeoutScale);

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
    if (!r) { console.log(`  · ${test.file}  (not run — fail-fast)`); continue; }
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
    console.log(`\n[run] ${passed}/${total} GREEN in ${elapsed}s`);
    // The target scales with suite size: 18 flows → 15s; the Wave-E expansion to 24 flows → 20s; wire-
    // format v2 (flow 26 + per-payment name encoding) → 22s. The suite runs real-browser flows in a
    // bounded-parallel pool; CPU contention adds ±3s variance. The target is a LOAD-ADJUSTED ceiling —
    // on a busy shared host the per-flow wall time inflates by the load factor, so a 22s×factor budget
    // keeps the signal meaningful (a genuinely regressed suite still trips it; a merely-loaded host
    // does not). The raw 22s target is what an idle 16-core box should hit. Only meaningful for a
    // full-suite run — skipped in watch mode (keepSession) where a single journey re-runs.
    if (!keepSession) {
      const target = 22 * timeoutScale;
      if (parseFloat(elapsed) > target) {
        console.warn(`[run] ⚠️  suite slipped past the load-adjusted target of ${target.toFixed(0)}s (took ${elapsed}s, load factor ×${timeoutScale.toFixed(2)}) — flag this`);
      }
    }
  }

  return { passed, total, elapsed, firstFailure, timeoutScale };
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
  const timeoutScale = load.factor;
  const filter = process.env.DPAY_E2E_FILTER ?? '';
  const filterNote = filter
    ? ` matching filter "${filter}" (by journey/id/name/filename/covers)`
    : '';
  const concurrencyNote = auto
    ? `concurrency=${concurrency} (auto: load ${load.load1.toFixed(1)} on ${load.cpus} cores → headroom ${Math.max(0, load.cpus - load.load1).toFixed(1)}, timeout scale ×${timeoutScale.toFixed(2)})`
    : `concurrency=${concurrency} (explicit; timeout scale ×${timeoutScale.toFixed(2)} from load ${load.load1.toFixed(1)} on ${load.cpus} cores)`;
  console.log(
    `[run] running ${tests.length} test(s)${filterNote} in ${process.env.DPAY_E2E_MODE ?? 'local'} mode` +
    ` (parallel, ${concurrencyNote})\n`,
  );

  const { firstFailure } = await runTestsSubset(tests, { concurrency, timeoutScale });
  if (firstFailure) process.exit(1);
}

main().catch((e) => {
  console.error(`[run] FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
