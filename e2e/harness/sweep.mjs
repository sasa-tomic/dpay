#!/usr/bin/env node
// `just e2e-sweep` — reap the machine-global chrome gate. Stdlib-only (the gate library in
// browser.mjs lazy-imports puppeteer-core, so this runs even before `npm install` has ever run).
//
// What it does, in order:
//   1. removes discovery files whose shell is dead (probe fails), killing a WEDGED gate shell
//      (alive but devtools-silent) that a discovery file still names;
//   2. kills gate shells that are older than the idle threshold AND have zero client targets
//      (the spec's "zero websocket clients" heuristic) — referenced by a discovery file or
//      found unreferenced via pgrep;
//   3. drops a stale browser lock whose holder pid is dead.
//
// Safety scope (the box runs other projects' browsers and a production relay): only processes
// whose /proc cmdline names chrome-headless-shell AND carries this gate's
// /tmp/opencode/dpay-chrome-* user-data-dir are ever killed. Anything else is counted as
// foreign and left untouched. A shell with live client targets is never killed.
//
// Knobs: DPAY_E2E_SWEEP_MIN_IDLE_MS (default 10min), DPAY_E2E_LOCK_WAIT_MS (n/a here).
import { sweepChromeGate } from './browser.mjs';

const actions = await sweepChromeGate();
if (actions.length === 0) {
  console.log('e2e-sweep: nothing to do (no discovery files, no gate shells, no lock).');
} else {
  for (const a of actions) console.log(`e2e-sweep: ${a}`);
}
