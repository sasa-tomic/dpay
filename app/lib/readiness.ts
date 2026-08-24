// readiness.ts — the Trip Readiness passport's PURE logic (Trip Ready J5b, 2026-08-22).
//
// The passport is a PRIVATE capability card (spec: docs/specs/2026-08-22-trip-ready-delight-plan-IMPLEMENTED-UX-HARDENED.md
// Journey 5): four FINITE capability stamps — recovery saved, flow understood, funds ready,
// payment tested. All four ⇒ TRIP READY, then the card collapses into Settings (archived, never
// a dashboard). No counters beyond n/4, no amounts, no streaks, nothing public.
//
// Copy-source decision: PASSPORT_STAMPS lives HERE, colocated with the logic — these are
// capability/state labels + next-step hints, not the model-education copy
// (walkthrough/rehearsal) that education.ts owns. ONE source either way; never duplicated.
import {JOURNEY_STAMPS, awardStamp, hasStamp} from './journey';
import type {Journey} from './journey';
import type {BalanceView} from './assetBalances';

/** The four readiness capability keys (a subset of journey.ts's closed StampKey set). */
export type ReadinessKey =
  | 'recoverySaved'
  | 'flowUnderstood'
  | 'fundsReady'
  | 'paymentTested';

/** One passport stamp: the two-line caps label rendered INSIDE the ring, + the active-voice
  * next-step hint shown while it is missing. `label` uses an explicit \n so every stamp reads
  * as two inked lines like a real passport stamp (never a checklist ✓). `short` is the
  * home TripStrip's one-line phrase ("one payment to go") — the humanized, jargon-free name
  * (the M2 fix: "FLOW UNDERSTOOD" is system-speak; the strip speaks people-speak). */
export type PassportStamp = {key: ReadinessKey; label: string; hint: string; short: string};

/** The passport's stamps + copy. Order = display order AND "next step" order (first missing wins).
 *  Labels are HUMAN (UX hardening 2026-08-23): the stamps read as capabilities a traveler
 *  earned, not system states the app tracked ("FLOW UNDERSTOOD" was system-speak). Two-line
 *  caps (explicit \n) so every stamp reads like inked lines in a real passport. */
export const PASSPORT_STAMPS: readonly PassportStamp[] = [
  {key: 'recoverySaved', label: 'BACKED\nUP', hint: 'Copy your backup words in Settings', short: 'back up to go'},
  {key: 'flowUnderstood', label: 'SAW THE\nFLOW', hint: 'Watch the rehearsal when creating a wallet — or make any payment', short: 'see how it works to go'},
  {key: 'fundsReady', label: 'FUNDS\nLOADED', hint: 'Add any funds — demo funds count', short: 'add funds to go'},
  {key: 'paymentTested', label: 'FIRST\nPAYMENT', hint: 'Complete a payment — pay or receive', short: 'one payment to go'},
];

/** Ordered readiness keys (derived — PASSPORT_STAMPS is the single source of order). */
export const READINESS_STAMPS: readonly ReadinessKey[] = PASSPORT_STAMPS.map(s => s.key);

/** The Balances card's collapse marker (journey.seen) — after Done, the card never returns. */
export const PASSPORT_COLLAPSED_KEY = 'passportCollapsed';

/** The Settings row/modal title (same copy in both places). */
export const PASSPORT_TITLE = 'Trip readiness';

export type Readiness = {
  /** Filled stamps in display order. */
  filled: ReadinessKey[];
  /** Missing stamps in display order. */
  missing: ReadinessKey[];
  /** True iff all four are filled (the capstone condition). */
  complete: boolean;
  /** The FIRST missing stamp + its hint/short (undefined when complete). */
  next?: {key: ReadinessKey; hint: string; short: string};
};

/** Pure readiness projection of a journey (fail-soft: EMPTY journeys read as 0/4). */
export function computeReadiness(journey: Journey): Readiness {
  const filled: ReadinessKey[] = [];
  const missing: ReadinessKey[] = [];
  for (const key of READINESS_STAMPS) {
    (hasStamp(journey, key) ? filled : missing).push(key);
  }
  const nextKey = missing[0];
  return {
    filled,
    missing,
    complete: missing.length === 0,
    next: nextKey ? PASSPORT_STAMPS.find(s => s.key === nextKey)! : undefined,
  };
}

/** True iff ANY asset shows a spendable balance: status 'ok' AND a real display value.
  * DEMO counts (faucet-funded by design), offline `~approx` values count (they are known
  * balances), `—` nulls do NOT (unknown is not funds — offline-first honesty rule). */
export function decideFundsReady(balances: Record<string, BalanceView>): boolean {
  // Accepts any balance-map shape (the Wallet memo is keyed by AssetId; tests/tools pass
  // partial maps) — the decision only reads the VALUES, never the keys.
  return Object.values(balances).some(v => v.status === 'ok' && v.displayText !== '—');
}

/** Award `paymentTested` — call at every CONFIRMED payment success (either direction, either
 * rail). No-op when already stamped (the check reads the passed journey, and awardStamp itself
 * is idempotent). NEVER call on pending/unknown outcomes — confirmed only.
 *
 * A confirmed real payment ALSO awards `flowUnderstood`: a payment the user just made IS the
 * flow, demonstrated live (founder rule 2026-08-23: every trip-prep check auto-detects — the
 * first-run rehearsal is unreachable for wallets created before it existed, so without this
 * co-award SAW THE FLOW would be a permanent dead end for them). */
export function awardPaymentTested(journey: Journey): void {
  if (hasStamp(journey, JOURNEY_STAMPS.paymentTested)) return;
  void awardStamp(JOURNEY_STAMPS.paymentTested);
  if (!hasStamp(journey, JOURNEY_STAMPS.flowUnderstood)) void awardStamp(JOURNEY_STAMPS.flowUnderstood);
}
