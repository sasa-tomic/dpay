// Opt-in run profiler — `DPAY_E2E_PROFILE=1 node run.mjs` (or =<path> to choose the output file).
//
// WHY: the suite's wall time was a black box (per-flow wall times existed, but nothing said WHERE a
// flow's seconds went: browser boot vs app boot vs the waits inside the flow vs teardown). This
// module is the shared sink for the two instrumentation points:
//   • phases  — one-shot spans measured in lib.mjs / relay.mjs / web.mjs / driver.mjs (session
//               build, context create, app-boot navigate/waitReady, teardown, …)
//   • ops     — per-Driver-method spans (findByTestID, waitForText, click, screenshot, …)
//             aggregated per flow file, so a flow's cost profile is readable at a glance.
//
// Overhead when DISABLED is one boolean check per record call and one `process.env` read at import
// — nothing else. When enabled, the driver wraps its public methods (driver.mjs installDriverProfiler)
// and lib/relay/web wrap their build steps; run.mjs dumps the aggregate JSON + prints the summary.
//
// Zero imports (a leaf) so lib.mjs ↔ driver.mjs can both use it without a new cycle.

export const PROFILING = process.env.DPAY_E2E_PROFILE != null && process.env.DPAY_E2E_PROFILE !== '0';

// ── phases: one-shot spans ──────────────────────────────────────────────────────────
const phases = [];

/** Record a completed span. `file` attributes the span to a flow when known (setup/boot/teardown
 *  happen under a flow's AsyncLocalStorage); session-level spans pass null. */
export function profPhase(name, ms, file = null) {
  if (!PROFILING) return;
  phases.push({ at: Date.now(), kind: 'phase', name, ms: Math.round(ms), file });
}

/** Start a span; returns the stop() that records it. `const stop = profSpan('x')` … `stop()`. */
export function profSpan(name, file = null) {
  if (!PROFILING) return () => {};
  const t0 = performance.now();
  return () => profPhase(name, performance.now() - t0, file);
}

// ── ops: per-(flow, method) aggregation ─────────────────────────────────────────────
const ops = new Map(); // `${file}\u0000${op}` -> {file, op, count, totalMs, maxMs}
const opOrder = [];

/** Record one completed driver-op span. Called by the driver's wrapper (which measured it). */
export function profOp(file, op, ms) {
  if (!PROFILING) return;
  const key = `${file ?? '(standalone)'}\u0000${op}`;
  let e = ops.get(key);
  if (!e) {
    e = { file: file ?? '(standalone)', op, count: 0, totalMs: 0, maxMs: 0 };
    ops.set(key, e);
    opOrder.push(key);
  }
  e.count += 1;
  e.totalMs += ms;
  if (ms > e.maxMs) e.maxMs = ms;
}

/** Snapshot for the end-of-run dump. Ops returned sorted by totalMs desc (the "where did the
 *  seconds go" order); phases in insertion order. */
export function profileSnapshot() {
  return {
    phases: phases.map((p) => ({ ...p })),
    ops: opOrder.map((k) => ops.get(k)).sort((a, b) => b.totalMs - a.totalMs)
      .map((e) => ({ file: e.file, op: e.op, count: e.count, totalMs: Math.round(e.totalMs), maxMs: Math.round(e.maxMs) })),
  };
}

/** Roll the per-(flow,op) aggregation up to per-op totals across the whole run — the suite-level
 *  "which op class eats the most wall time" table. */
export function profileOpTotals() {
  const byOp = new Map();
  for (const e of ops.values()) {
    let t = byOp.get(e.op);
    if (!t) { t = { op: e.op, count: 0, totalMs: 0, maxMs: 0 }; byOp.set(e.op, t); }
    t.count += e.count;
    t.totalMs += e.totalMs;
    if (e.maxMs > t.maxMs) t.maxMs = e.maxMs;
  }
  return [...byOp.values()].sort((a, b) => b.totalMs - a.totalMs)
    .map((t) => ({ op: t.op, count: t.count, totalMs: Math.round(t.totalMs), maxMs: Math.round(t.maxMs) }));
}

/** Phase totals grouped by phase NAME across the run (e.g. how long every flow's context create
 *  took together). Sorted by total desc. */
export function profilePhaseTotals() {
  const byName = new Map();
  for (const p of phases) {
    let t = byName.get(p.name);
    if (!t) { t = { name: p.name, count: 0, totalMs: 0, maxMs: 0 }; byName.set(p.name, t); }
    t.count += 1;
    t.totalMs += p.ms;
    if (p.ms > t.maxMs) t.maxMs = p.ms;
  }
  return [...byName.values()].sort((a, b) => b.totalMs - a.totalMs)
    .map((t) => ({ ...t, totalMs: Math.round(t.totalMs) }));
}
