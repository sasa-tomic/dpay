// Smoke-tier budget wrapper — active ONLY when DPAY_SMOKE=1 (what `just smoke` sets). Two jobs:
//
// 1. THE GUARD: admission is discovery-gated in jest.config.js — the smoke project only discovers
//    test files when DPAY_SMOKE=1 is set, and `just smoke` passes EXPLICITLY the manifest files
//    (scripts/smoke-files.mjs). A bare `npx jest --selectProjects smoke` therefore finds no tests
//    and FAILS (exit 1) instead of silently running the whole __tests__ tree under the smoke
//    name. (An argv check here cannot work: setupFiles run in jest workers whose argv does not
//    carry the CLI file list.)
// 2. THE BUDGET: every it/test is wrapped with an hrtime wall measure; a test over 250 ms is
//    RED with a message naming it. The budget is a design constant of the tier (founder: smoke
//    must be seconds-fast forever) — the fix for a slow test is moving/splitting its file out of
//    the manifest, never raising this number.

const BUDGET_MS = 250;

if (process.env.DPAY_SMOKE === '1') {
  // Wrap one `it`-like callable. Recursively re-wraps the modifier chain (.only/.skip/.each/…)
  // so every admission shape is measured, with a WeakSet guard against cycles.
  const seen = new WeakSet();
  function timed(base) {
    if (typeof base !== 'function' || seen.has(base)) return base;
    seen.add(base);
    const wrapped = function (name, fn, ...rest) {
      if (typeof fn !== 'function') return base.call(this, name, fn, ...rest);
      return base.call(this, name, function measured(...args) {
        const t0 = process.hrtime.bigint();
        const tookMs = () => Number(process.hrtime.bigint() - t0) / 1e6;
        const check = () => {
          const took = tookMs();
          if (took > BUDGET_MS) {
            throw new Error(`smoke budget exceeded: ${name} took ${took.toFixed(0)}ms (budget ${BUDGET_MS})`);
          }
        };
        // done-callback style: measure at the (first) done call.
        if (fn.length > 0) {
          let called = false;
          const done = (err) => {
            if (called) return;
            called = true;
            check();
            if (err) throw err;
          };
          return fn.call(this, done, ...args);
        }
        const out = fn.apply(this, args);
        if (out && typeof out.then === 'function') {
          return out.then(
            () => check(),
            (e) => { try { check(); } catch { /* the original failure is the one to report */ } throw e; },
          );
        }
        check();
        return out;
      }, ...rest);
    };
    for (const key of Object.keys(base)) {
      try { wrapped[key] = timed(base[key]); } catch { /* non-writable modifier — leave it */ }
    }
    return wrapped;
  }

  global.it = timed(global.it);
  global.test = timed(global.test);
}
