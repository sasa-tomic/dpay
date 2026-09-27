#!/usr/bin/env node
// Budget watchdog for the smoke tier (the standing perf mandate's tripwire).
//
//   node scripts/smoke-watch.mjs
//
// Runs `just smoke` ONCE, measures its wall time, parses jest's per-test JSON
// (DPAY_TESTRUNS_TIMING, the same feed `just timing smoke` reads), and compares:
//   - suite total against the 12 s cold budget (the recipe's own `timeout 20s` is the hard kill);
//   - every test against the 250 ms per-test budget.
// Writes /home/sat/projects/dpay/tmp/smoke-watch-status.json (machine-checkable) and prints ONE
// verdict line. Exit 0 = within budget; exit 1 = smoke failed OR over budget — an alert
// condition that must trigger a fix agent (flatten/merge tests, cut setup/teardown cost),
// never a budget raise.
import {spawnSync} from 'node:child_process';
import {writeFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const STATUS_PATH = process.env.DPAY_SMOKE_WATCH_STATUS
  ?? '/home/sat/projects/dpay/tmp/smoke-watch-status.json';
const TOTAL_BUDGET_S = 12;
const PER_TEST_BUDGET_MS = 250;

const tmp = mkdtempSync(join(tmpdir(), 'smoke-watch-'));
const timing = join(tmp, 'smoke-timing.json');
const t0 = Date.now();
// DPAY_SMOKE_TIMING is the recipe's dedicated capture seam (testruns.py owns and deletes
// DPAY_TESTRUNS_TIMING, so the watchdog needs its own path to the same JSON).
const r = spawnSync('just', ['smoke'], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: {...process.env, DPAY_SMOKE_TIMING: timing},
  timeout: 60_000,
});
const wallS = (Date.now() - t0) / 1000;

let tests = [];
try {
  const j = JSON.parse(readFileSync(timing, 'utf8'));
  tests = (j.testResults ?? []).flatMap((tr) => tr.assertionResults ?? []);
} catch { /* parse failure reported below — never silent-ok */ }

const durations = tests
  .filter((t) => typeof t.duration === 'number' && t.status !== 'skipped' && t.status !== 'pending')
  .map((t) => ({name: t.fullName, ms: t.duration}));
const overBudget = durations.filter((t) => t.ms > PER_TEST_BUDGET_MS)
  .sort((a, b) => b.ms - a.ms);
const slowest = [...durations].sort((a, b) => b.ms - a.ms).slice(0, 5);
const failed = tests.filter((t) => t.status === 'failed').length;
const parseOk = r.status === 0 && tests.length > 0;

const problems = [];
if (r.status !== 0) problems.push(`just smoke exited ${r.status}`);
if (!parseOk) problems.push('no parseable jest timing JSON (per-test budget unchecked)');
if (failed > 0) problems.push(`${failed} test(s) failed`);
if (wallS > TOTAL_BUDGET_S) problems.push(`wall ${wallS.toFixed(1)}s > ${TOTAL_BUDGET_S}s total budget`);
if (overBudget.length > 0) {
  problems.push(`${overBudget.length} test(s) over ${PER_TEST_BUDGET_MS}ms: `
    + overBudget.slice(0, 5).map((t) => `${t.name} (${t.ms}ms)`).join(', ')
    + (overBudget.length > 5 ? ` +${overBudget.length - 5} more` : ''));
}
const ok = problems.length === 0;
const verdict = ok
  ? `SMOKE WATCH: OK — wall ${wallS.toFixed(1)}s (budget ${TOTAL_BUDGET_S}s), ${durations.length} tests, slowest ${slowest[0]?.ms ?? 0}ms`
  : `SMOKE WATCH: OVER — ${problems.join('; ')}. Fix agent mandate: merge/flatten, cut setup+teardown cost; NEVER raise the budget.`;

const status = {
  ok,
  verdict,
  ts: new Date().toISOString(),
  suite: 'smoke',
  exitCode: r.status,
  wallSeconds: Number(wallS.toFixed(2)),
  totalBudgetSeconds: TOTAL_BUDGET_S,
  perTestBudgetMs: PER_TEST_BUDGET_MS,
  tests: durations.length,
  failed,
  overBudget,
  slowest,
};
mkdirSync(dirname(STATUS_PATH), {recursive: true});
writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
try { rmSync(tmp, {recursive: true, force: true}); } catch {}

console.log(verdict);
process.exit(ok ? 0 : 1);
