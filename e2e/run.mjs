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
import { stopSession } from './harness/lib.mjs';
import { loadTestsMeta, filterByToken, JOURNEYS } from './harness/meta.mjs';

// Default concurrency: 12. The host has 16 cores; each parallel test is one chrome incognito context
// against the shared relay + web + browser process. 12 leaves headroom for the relay/web/V8 and is
// the measured sweet spot (the suite is bounded by the slowest test on the critical path, not raw
// throughput, so going higher yields diminishing returns and risks CPU contention thrash). Tunable
// via env; `DPAY_E2E_CONCURRENCY=1` runs sequentially (debugging).
const DEFAULT_CONCURRENCY = 12;

function resolveConcurrency() {
  const raw = parseInt(process.env.DPAY_E2E_CONCURRENCY ?? String(DEFAULT_CONCURRENCY), 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_CONCURRENCY;
  return raw;
}

/**
 * Discover + filter the tests via the shared metadata loader. A token matches on filename (legacy),
 * meta.id, meta.name, meta.journey, or a covers slug — so `DPAY_E2E_FILTER=pay` runs the whole pay
 * journey, `=07` runs flow 07, `=scan-pay` runs by slug, `=receipt` runs every flow covering receipts.
 * Comma-separated for several. Empty = all. Returns objects with `{file, id, name, path, meta}`.
 */
async function loadTests() {
  const all = await loadTestsMeta();
  return filterByToken(all, process.env.DPAY_E2E_FILTER ?? '');
}

/** Race `promise` against a hard timeout; reject with a labeled, debuggable error on expiry. */
function withTimeout(promise, timeoutMs, label) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[${label}] exceeded its per-test timeout of ${timeoutMs}ms — likely hung (the suite is ~17s, so this is a genuine stall, not slow hardware)`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

async function runOne(test) {
  const mod = await import(`file://${test.path}`);
  if (typeof mod.run !== 'function') throw new Error(`${test.file}: no \`run\` export`);
  const timeoutMs = test.meta?.timeoutMs ?? 60_000;
  await withTimeout(mod.run(), timeoutMs, test.file);
}

/**
 * A bounded parallel pool that preserves FAIL-FAST: as soon as one test fails, no further tests are
 * STARTED; in-flight tests are allowed to finish (so their contexts tear down cleanly), then the
 * pool drains. Returns the ordered results + the first failure (if any).
 */
async function runPool(tests, concurrency) {
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
      await runOne(test);
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

async function main() {
  const startedAt = Date.now();
  const tests = await loadTests();
  if (tests.length === 0) {
    console.error('[run] no tests matched (check DPAY_E2E_FILTER — try a journey/id/name/covers slug)');
    process.exit(1);
  }
  const concurrency = resolveConcurrency();
  const filter = process.env.DPAY_E2E_FILTER ?? '';
  const filterNote = filter
    ? ` matching filter "${filter}" (by journey/id/name/filename/covers)`
    : '';
  console.log(
    `[run] running ${tests.length} test(s)${filterNote} in ${process.env.DPAY_E2E_MODE ?? 'local'} mode` +
    ` (parallel, concurrency=${concurrency})\n`,
  );

  const { results, firstFailure } = await runPool(tests, concurrency);

  // Tear down the shared relay + web server + browser once the run is done (pass OR fail).
  await stopSession();

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
    process.exit(1);
  }
  console.log(`\n[run] ${passed}/${total} GREEN in ${elapsed}s`);
  // The target scales with suite size: 18 flows → 15s; the Wave-E expansion to 24 flows → 20s; wire-
  // format v2 (flow 26 + per-payment name encoding) → 22s. The suite runs real-browser flows in a
  // bounded-parallel pool; CPU contention adds ±3s variance.
  if (parseFloat(elapsed) > 22) {
    console.warn(`[run] ⚠️  suite slipped past the 22s target (took ${elapsed}s) — flag this`);
  }
}

main().catch((e) => {
  console.error(`[run] FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
