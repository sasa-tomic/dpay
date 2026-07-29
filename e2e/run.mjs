// Top-level orchestrator — runs every `tests/NN-name.mjs` in order, sequentially, each in its own
// process tree (relay + web + browser per setup; teardown stops them all). The first RED test exits
// non-zero so the orchestrator (justfile/CI) fails fast. Tail output is the suite summary.
//
// Usage: `node run.mjs` (local, default) | `DPAY_E2E_MODE=live node run.mjs` (live).
//
// Add a flow = add `tests/NN-name.mjs` exporting `async function run()`. No other change needed.
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = join(__dirname, 'tests');

async function loadTests() {
  const files = (await readdir(TESTS_DIR)).filter((f) => /^\d{2}-.+\.mjs$/.test(f)).sort();
  return files.map((f) => join(TESTS_DIR, f));
}

async function runOne(path) {
  const mod = await import(`file://${path}`);
  if (typeof mod.run !== 'function') throw new Error(`${path}: no \`run\` export`);
  await mod.run();
}

async function main() {
  const startedAt = Date.now();
  const tests = await loadTests();
  if (tests.length === 0) {
    console.error('[run] no tests found under e2e/tests/');
    process.exit(1);
  }
  console.log(`[run] running ${tests.length} test(s) in ${process.env.DPAY_E2E_MODE ?? 'local'} mode\n`);

  let passed = 0;
  let failed = null;
  for (const t of tests) {
    const name = t.split('/').pop();
    const tStart = Date.now();
    process.stdout.write(`→ ${name}\n`);
    try {
      await runOne(t);
      passed++;
      console.log(`  ✓ ${((Date.now() - tStart) / 1000).toFixed(2)}s\n`);
    } catch (e) {
      failed = { name, err: e };
      console.error(`  ✗ RED: ${e.stack || e.message || e}\n`);
      break; // fail fast — the first RED test surfaces a bug to fix, not bury
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  if (failed) {
    console.error(`[run] FAILED in ${elapsed}s (${failed.name})`);
    process.exit(1);
  }
  console.log(`[run] ${passed}/${tests.length} GREEN in ${elapsed}s`);
  if (parseFloat(elapsed) > 15) {
    console.warn(`[run] ⚠️  suite slipped past the 15s target (took ${elapsed}s) — flag this`);
  }
}

main().catch((e) => {
  console.error(`[run] FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
