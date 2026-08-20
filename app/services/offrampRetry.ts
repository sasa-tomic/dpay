import type {OfframpStep} from './rail';

// Pure retry-decision logic for the offramp (withdraw) flow — extracted from WithdrawSheet so the
// double-burn guard is pinnable by jest without rendering the component. The rule is rail-wide
// discipline: EVERY envelope is resubmitted VERBATIM once any part of it may be in flight;
// re-signing a submitted envelope is forbidden (a fresh signature = fresh request_id = the SAME
// withdrawal can execute twice — the double-burn class this module exists to prevent).

/** A prepared offramp retained across retries and app restarts. */
export type RetainedOfframp = {
  /** The signed envelopes, in submit order (approve(s) first, minter call last). Immutable once prepared. */
  steps: OfframpStep[];
  /** Index of the first step NOT yet settled — the retry resume point. */
  nextIdx: number;
  /** The native destination baked into the envelopes (display on the resume card). */
  destination: string;
  /** The raw smallest-units amount baked into the envelopes (display on the resume card). */
  amountRaw: string;
};

export type OfframpPlan =
  | {kind: 'prepare'} // sign fresh envelopes — safe only when nothing is in flight
  | {kind: 'resume'; record: RetainedOfframp; from: number}; // re-submit the SAME bytes from `from`

/**
 * Decide what a Confirm press must do given the retained offramp state.
 *
 * - `retained == null` (or empty steps) → PREPARE fresh envelopes. This is only reached when no
 *   envelope exists yet (first attempt, or a clean pre-submit failure such as the gas-fee fetch
 *   throwing before anything was signed/submitted) — re-preparing is safe because nothing is in
 *   flight.
 * - `retained != null` → the prepared envelopes exist and any of them may already be in flight.
 *   RESUME: re-submit the SAME bytes starting at `nextIdx`, the first not-yet-settled step.
 *   `nextIdx` only ever advances past a SETTLED step, so a failed/unknown step is retried
 *   verbatim (identical-byte resubmission is dedup'd server-side by request_id, or re-executes
 *   the one intended withdrawal), and later steps are never reached early.
 *
 * The caller invalidates `retained` (sets it back to null) only when the user deliberately edits
 * the destination/amount — that is a NEW withdrawal intent, and the old envelopes (if any land)
 * settle independently, visible via the balance refresh.
 */
export function planOfframpConfirm(retained: RetainedOfframp | null): OfframpPlan {
  if (!retained || retained.steps.length === 0) return {kind: 'prepare'};
  const from = Math.min(Math.max(retained.nextIdx, 0), retained.steps.length - 1);
  return {kind: 'resume', record: retained, from};
}
