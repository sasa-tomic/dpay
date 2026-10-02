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
 * THE FORMULA (one definition, here): the WORSE of two contention terms, clamped to [1, 6]:
 *   load: 1 + max(0, load1min - 3) * 1.0   (the trailing view — a sustained busy box)
 *   psi:  1 + cpuPSI.some.avg10 / 20       (the INSTANT view — burst contention)
 * Load ≤ 3 with a quiet CPU → ×1.00, byte-identical to the old ceilings; the clamp bounds a
 * genuine hang's worst-case wait at 6×. `DPAY_TEST_BUDGET_MULT` overrides both outright
 * (deterministic experiments; ≥1, sane-clamped).
 *
 * WHY PSI (2026-09-29 night): the shared box's other agents run bursty single-file jest probes
 * that spin up full worker pools for ~a minute; the 1-min load average reads ~4 through such a
 * burst (factor ×2.2) while the INSTANT runqueue pressure is 40-90% — every window in the burst's
 * path expired at ×2.2 (25 suites red) and passed at ×1 seconds later in a quiet gap (32 straight
 * green). PSI `some` avg10 is the scheduler's own "tasks waited on CPU in the last 10s" number:
 * it sees the burst within seconds, loadavg sees it a minute late. /20: 20% pressure → ×2,
 * 80% → ×5 — calibrated against those observed bursts.
 *
 * MONOTONE HIGH-WATER. The factor is sampled at first use (≈ worker start) and on EVERY call; the
 * EFFECTIVE factor is the max seen so far in this worker. A burst mid-run must never under-budget
 * the waits after it, and a momentary load dip must not shrink a budget a starved worker still
 * needs. Over-stretching only costs wall time on a genuinely hung surface; under-stretching costs
 * false reds — the expensive failure (e2e/run.mjs's doctrine, same bias).
 */
/** The 1-min load average, /proc first (exact), os.loadavg() as the portable fallback. */
type BudgetG = {__DPAY_FLOW_BUDGET_BASE_FACTOR__?: number};
const g = globalThis as unknown as BudgetG;

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

/** CPU PSI `some` avg10 (percent 0-100) — "tasks waited on CPU in the last 10s". The instant
 *  contention view the 1-min load average lags by a minute. 0 when PSI is absent (old kernel). */
function cpuPsiAvg10(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {readFileSync} = require('node:fs') as typeof import('node:fs');
    const line = readFileSync('/proc/pressure/cpu', 'utf8').split('\n').find((l) => l.startsWith('some '));
    const m = line?.match(/avg10=([\d.]+)/);
    const v = m ? Number(m[1]) : 0;
    return Number.isFinite(v) && v >= 0 ? v : 0;
  } catch { return 0; }
}

/** The single clamp constant both terms respect: any scaled wait is base x BUDGET_MAX at worst.
 *  The flow tier's per-test jest ceiling (harness/setupFlow.ts) is DERIVED from this so the
 *  ceiling can never lose the race to a max-stretched wait (observed 2026-10-02, flow 31: the
 *  ceiling was seeded at the file-install factor x5 = 150s, the wait later scaled at the
 *  worker's x6 high-water = 150s - the ceiling fired on a healthy wait). */
export const BUDGET_MAX = 6;

/** factor(load) — the load term of THE formula (the trailing view). */
export function factorOf(load: number): number {
  const f = 1 + Math.max(0, load - 3) * 1.0;
  return Math.min(BUDGET_MAX, Math.max(1, f));
}

/** factorFromPsi(psiPercent) — the instant term: 20% pressure → ×2, 80% → ×5. */
export function psiFactorOf(psi: number): number {
  const f = 1 + psi / 20;
  return Math.min(BUDGET_MAX, Math.max(1, f));
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
  // HERMETIC MODEL: the stretch is BACK, load/PSI-scaled as before. Hermeticity fixed the STATE
  // (one relay + fresh world per file — no cross-file wave), but at high worker counts the box
  // still runs hot (N full-app jest workers + N relays + everything else the shared box runs),
  // and a 16-worker ×1 run failed 26 suites on pure scheduling starvation (bodyChanged both
  // ways, healthy relays, zero transport failures). The load/PSI term measures exactly that.
  // The hermetic fix and the stretch are ORTHOGONAL: state by construction, time by measurement.
  const live = Math.max(factorOf(load1()), psiFactorOf(cpuPsiAvg10()));
  const hw = Math.max(g.__DPAY_FLOW_BUDGET_BASE_FACTOR__ ?? 0, live);
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
  const src = env !== undefined && env !== ''
    ? `env DPAY_TEST_BUDGET_MULT=${env}`
    : `load1 ${load1().toFixed(2)} psi ${cpuPsiAvg10().toFixed(1)}%`;
  return `[budget] ×${budgetMult().toFixed(2)} (${src})`;
}
