// Shared flow-step helpers — the multi-step navigation/assertion idioms that flows used to
// hand-roll inline. Split from lib.mjs (which owns session/process lifecycle); these are pure
// driver step sequences. `nfcPhase`/`nfcPhaseWalk` walk the NFC card phase machine (dispatch a
// `phase` event through the flow's own `dispatch` seam closure, wait for the status surface and
// its human-readable status text); `openHistory` navigates to the Transactions tab and waits for
// the ledger to paint.
import { assert } from './lib.mjs';

/** The app's phase → status-line contract (NfcView). `awaitingApproval` maps to the exchanging
 *  line (auto-sign retires the review park). */
export const NFC_PHASE_TEXT = {
  linking: 'Connecting',
  exchanging: 'Communicating',
  awaitingApproval: 'Communicating',
  settling: 'Confirming',
  success: 'Paid ✓',
  pending: 'Not confirmed',
  declined: 'Declined',
};

/**
 * Dispatch one NFC phase event through `dispatch` (the flow's seam closure — IC
 * `__DPAY_TEST_NFC_SESSION` / SOL `__DPAY_TEST_SOL_NFC_SESSION` — differs per rail, so the flow
 * owns it), then wait for the status surface (`opts.statusId` + `opts.mount`, the session-opener
 * step) and its status text. `opts.text` overrides the phase→text contract; `null` skips the
 * wait entirely (for openers that go straight to a request/error). Returns the `waitForText`
 * boolean (false on timeout — the driver's soft-probe contract), so the caller decides whether
 * the wait is a gate (`assert(await nfcPhase(...))`) or a bare beat (`await nfcPhase(...)`).
 */
export async function nfcPhase(driver, dispatch, phase, opts = {}) {
  const role = opts.role ?? 'card';
  const timeoutMs = opts.timeoutMs ?? 4_000;
  const text = 'text' in opts ? opts.text : NFC_PHASE_TEXT[phase] ?? null;
  await dispatch({ type: 'phase', role, phase });
  if (opts.mount && opts.statusId) await driver.findByTestID(opts.statusId, { timeoutMs });
  if (text === null) return true;
  return driver.waitForText(text, { timeoutMs });
}

/**
 * Walk `phases` in order (session opener → terminal). Mounts `opts.statusId` right after the
 * first dispatch (the status surface only exists once the first phase lands) and asserts each
 * step's status text against the phase→text contract (`opts.text`, or `null` for dispatch-only
 * steps). Every wait is a gate here — irregular walks (bare waits, bespoke messages, interleaved
 * asserts) should call `nfcPhase` per step instead.
 */
export async function nfcPhaseWalk(driver, dispatch, phases, opts = {}) {
  const results = [];
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const ok = await nfcPhase(driver, dispatch, phase, { ...opts, mount: i === 0 && Boolean(opts.statusId) });
    if (ok === false) assert(false, `${phase} should show "${opts.text ?? NFC_PHASE_TEXT[phase]}…"`);
    results.push(ok);
  }
  return results;
}

/**
 * Open the history surface: tap the Transactions tab, then wait for the ledger's RECENT heading
 * (the surface-readiness anchor). Returns the `waitForText` boolean — assert it where the flow
 * gates on history rendering, or discard where the row waits that follow are the real gate.
 */
export async function openHistory(driver, opts = {}) {
  await driver.click('tab-transactions', { timeoutMs: opts.timeoutMs ?? 4_000 });
  return driver.waitForText('Recent', { timeoutMs: opts.recentMs ?? 8_000 });
}
