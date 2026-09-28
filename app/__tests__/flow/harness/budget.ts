/**
 * budget.ts — the flow tier's load-scaled wait ceilings.
 *
 * WHY THIS EXISTS. Every wait window in this harness (driver defaults, lib sugar, the private-relay
 * health probe, the in-file poll loops) was tuned 10-15s on a QUIET box. On the shared, permanently
 * busy dev box those windows expired under CPU starvation while the app was healthy: the 2026-09-28
 * gate evidence is six full `just flow` runs with ZERO assertion failures, every red a bounded-wait
 * window expiring under load. The fix is the same one `e2e/harness/driver.mjs` `scaled()` already
 * uses for the chrome tier: stretch the POSITIVE transition waits (settle, receipt, quote, poll-tick
 * outcomes) by a host-load factor instead of waiting for a calm window the box will never give.
 *
 * NEGATIVE/refusal waits (honest errors, disabled buttons, refusals) deliberately do NOT stretch:
 * the app must refuse fast, and a stretched refusal bound would only delay catching a real bug.
 * Call sites that assert absence pass `{unscaled: true}` through the driver.
 *
 * THE FORMULA (one definition, here): factor = 1 + max(0, load1min - 3) * 0.5, clamped to [1, 6].
 * Load ≤ 3 (idle-ish 16-core box) → ×1.00, byte-identical to the old ceilings. Each 2 units of
 * load past 3 buys +1 of budget headroom. `DPAY_TEST_BUDGET_MULT` overrides the live computation
 * outright (deterministic experiments; ≥1, sane-clamped).
 *
 * MONOTONE HIGH-WATER. The factor is sampled at first use (≈ worker start) and on EVERY call; the
 * EFFECTIVE factor is the max seen so far in this worker. A burst mid-run must never under-budget
 * the waits after it, and a momentary load dip must not shrink a budget a starved worker still
 * needs. Over-stretching only costs wall time on a genuinely hung surface; under-stretching costs
 * false reds — the expensive failure (e2e/run.mjs's doctrine, same bias).
 */
type BudgetG = {__DPAY_FLOW_BUDGET_BASE_FACTOR__?: number};
const g = globalThis as unknown as BudgetG;

/** The 1-min load average, /proc first (exact), os.loadavg() as the portable fallback. */
function load1(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {readFileSync} = require('node:fs') as typeof import('node:fs');
    const v = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
    if (Number.isFinite(v) && v >= 0) return v;
  } catch { /* not linux, or the read raced — fall through */ }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  return os.loadavg()[0] ?? 0;
}

/** factor(load) — THE formula. Exported for the run log's self-description. */
export function factorOf(load: number): number {
  const f = 1 + Math.max(0, load - 3) * 0.5;
  return Math.min(6, Math.max(1, f));
}

/** The EFFECTIVE multiplier right now: env override wins; otherwise the high-water of every
 *  sample this worker has taken. A fresh worker seeds its high-water at first call, so the
 *  load the box carried when the worker forked counts from the first wait on. */
export function budgetMult(): number {
  const env = process.env.DPAY_TEST_BUDGET_MULT;
  if (env !== undefined && env !== '') {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 1) return Math.min(n, 64);
  }
  const live = factorOf(load1());
  // On globalThis (not module state): setupFiles, setupFilesAfterEnv, and each test file get
  // SEPARATE jest module registries — module state would give every registry its own high-water
  // and let a post-burst registry under-budget. globalThis is the one shared carrier (the same
  // trick the fetch recorder uses, see setupFlow.ts §5).
  const seen = g.__DPAY_FLOW_BUDGET_BASE_FACTOR__ ?? 0;
  const hw = Math.max(seen, live);
  g.__DPAY_FLOW_BUDGET_BASE_FACTOR__ = hw;
  return hw;
}

/** Stretch a wait window by the budget multiplier (positive-transition ceilings only). */
export function scaled(ms: number): number {
  return Math.round(ms * budgetMult());
}

/** A poll-loop deadline for a positive wait: now + scaled(ms). */
export function deadline(ms: number): number {
  return Date.now() + scaled(ms);
}

/** One compact self-description per worker, for the run log: the formula's inputs and result. */
export function describeBudget(): string {
  const env = process.env.DPAY_TEST_BUDGET_MULT;
  const src = env !== undefined && env !== '' ? `env DPAY_TEST_BUDGET_MULT=${env}` : `load1 ${load1().toFixed(2)}`;
  return `[budget] ×${budgetMult().toFixed(2)} (${src})`;
}
