/** The stuck probes' session-local "last checked" log (2026-10-02 POCO P0).
 *
 *  The stuck screen says "dpay keeps watching" — this is what makes that claim VERIFIABLE:
 *  the engine records the wall-clock time of each completed stuck probe here, and the state
 *  panels render it ("Last checked 19:52"). Session-local by design, exactly like the
 *  provider poll's `providerLastCheckedAtMs`: a fresh session honestly knows nothing until
 *  its own first probe lands, and the persisted record stays a state machine, not a poll
 *  log. Never a SLA — a timestamp only.
 */
const STUCK_LAST_CHECKED_MS = new Map<string, number>();

/** Record that ONE stuck probe completed for this record (engine call site). */
export function noteStuckProbeDone(recordId: string, atMs: number): void {
  STUCK_LAST_CHECKED_MS.set(recordId, atMs);
}

/** When did the engine last finish ONE stuck probe for this record? Null = no read this
 *  session (nothing is claimed). */
export function stuckLastCheckedAtMs(recordId: string): number | null {
  return STUCK_LAST_CHECKED_MS.get(recordId) ?? null;
}

/** The log dies with the engine session that earned it (stopEngine / test teardown). */
export function clearStuckProbes(): void {
  STUCK_LAST_CHECKED_MS.clear();
}
