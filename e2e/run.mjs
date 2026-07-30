// Top-level orchestrator — runs every `tests/NN-name.mjs` in a BOUNDED PARALLEL pool, each driving
// the shared relay + web + browser (one process) through a FRESH incognito context (fresh identity).
// The first RED test stops the pool from STARTING new tests (fail-fast); in-flight tests drain so no
// context is orphaned, then the run exits non-zero with the first failure. Tail output is the suite
// summary with per-test timing.
//
// Usage: `node run.mjs` (local, default) | `DPAY_E2E_MODE=live node run.mjs` (live).
// Concurrency: `DPAY_E2E_CONCURRENCY=N` (default 6; `1` = sequential, useful for debugging).
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
// Add a flow = add `tests/NN-name.mjs` exporting `async function run()`. No other change needed.
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stopSession } from './harness/lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = join(__dirname, 'tests');

// Default concurrency: 10. The host has 16 cores; each parallel test is one chrome context + the
// shared relay. 10 leaves headroom for the relay/web/V8 and is the measured sweet spot (16 tests in
// ~10s). Tunable via env; `DPAY_E2E_CONCURRENCY=1` runs sequentially (debugging).
const DEFAULT_CONCURRENCY = 10;

function resolveConcurrency() {
  const raw = parseInt(process.env.DPAY_E2E_CONCURRENCY ?? String(DEFAULT_CONCURRENCY), 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_CONCURRENCY;
  return raw;
}

async function loadTests() {
  const files = (await readdir(TESTS_DIR)).filter((f) => /^\d{2}-.+\.mjs$/.test(f)).sort();
  return files.map((f) => ({ name: f, path: join(TESTS_DIR, f) }));
}

async function runOne(path) {
  const mod = await import(`file://${path}`);
  if (typeof mod.run !== 'function') throw new Error(`${path}: no \`run\` export`);
  await mod.run();
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
    const { name, path } = tests[idx];
    activeWorkers++;
    const tStart = Date.now();
    try {
      await runOne(path);
      results.set(name, { ok: true, ms: Date.now() - tStart });
      console.log(`  ✓ ${name}  ${((Date.now() - tStart) / 1000).toFixed(2)}s`);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      results.set(name, { ok: false, ms: Date.now() - tStart, err });
      if (!firstFailure) firstFailure = { name, err };
      console.error(`  ✗ ${name}  RED after ${((Date.now() - tStart) / 1000).toFixed(2)}s: ${err.stack || err.message || err}`);
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
    console.error('[run] no tests found under e2e/tests/');
    process.exit(1);
  }
  const concurrency = resolveConcurrency();
  console.log(
    `[run] running ${tests.length} test(s) in ${process.env.DPAY_E2E_MODE ?? 'local'} mode` +
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
  for (const { name } of tests) {
    const r = results.get(name);
    if (!r) { console.log(`  · ${name}  (not run — fail-fast)`); continue; }
    const mark = r.ok ? '✓' : '✗';
    console.log(`  ${mark} ${name}  ${(r.ms / 1000).toFixed(2)}s`);
  }

  if (firstFailure) {
    console.error(`\n[run] FAILED in ${elapsed}s (first RED: ${firstFailure.name})`);
    process.exit(1);
  }
  console.log(`\n[run] ${passed}/${total} GREEN in ${elapsed}s`);
  if (parseFloat(elapsed) > 15) {
    console.warn(`[run] ⚠️  suite slipped past the 15s target (took ${elapsed}s) — flag this`);
  }
}

main().catch((e) => {
  console.error(`[run] FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
