// readiness.ts — the Trip Readiness passport's PURE logic (Trip Ready J5b, 2026-08-22).
//
// The passport is a PRIVATE capability card (spec: docs/specs/2026-08-22-trip-ready-delight-plan-IMPLEMENTED-UX-HARDENED.md
// Journey 5): four FINITE capability stamps — recovery saved, flow understood, funds ready,
// payment tested. All four ⇒ TRIP READY, then the card collapses into Settings (archived, never
// a dashboard). No counters beyond n/4, no amounts, no streaks, nothing public.
//
// Copy-source decision: the stamp ORDER lives HERE, colocated with the logic (it is also the
// "next step" order); the WORDS live in the message catalog (`M.education.passport.stamps`).
import {M} from '../i18n';
import {DEMO_ASSET_ID} from '../config/assets';
import {JOURNEY_STAMPS, awardStamp, hasStamp} from './journey';
import type {Journey} from './journey';
import type {BalanceView} from './assetBalances';
import type {AssetId} from './types';

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

/** The four readiness keys in display order — which is ALSO the "next step" order (first missing
 *  wins). Pure structure, so it stays a module constant: order is locale-independent, and this is
 *  the single source both the stamps and computeReadiness iterate. */
export const READINESS_STAMPS: readonly ReadinessKey[] = [
  'recoverySaved', 'flowUnderstood', 'fundsReady', 'paymentTested',
];

/** The passport's stamps + copy, composed PER CALL — never a module constant: a runtime locale
 *  switch replaces `M.education` wholesale, so a captured array (or even a captured sub-object)
 *  would keep rendering the old language forever. Call it during render, like any `M.…` read.
 *  Labels are HUMAN (UX hardening 2026-08-23): the stamps read as capabilities a traveler
 *  earned, not system states the app tracked ("FLOW UNDERSTOOD" was system-speak). Two-line
 *  caps (explicit \n) so every stamp reads like inked lines in a real passport. */
export function passportStamps(): readonly PassportStamp[] {
  return READINESS_STAMPS.map(key => ({key, ...M.education.passport.stamps[key]}));
}

/** The Balances card's collapse marker (journey.seen) — after Done, the card never returns. */
export const PASSPORT_COLLAPSED_KEY = 'passportCollapsed';

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
  if (!nextKey) return {filled, missing, complete: true};
  // The next step's WORDS are read HERE, per call — never captured at module load, for the same
  // reason `passportStamps()` is a function.
  const {hint, short} = M.education.passport.stamps[nextKey];
  return {filled, missing, complete: false, next: {key: nextKey, hint, short}};
}

/** True iff any asset the user could actually SPEND ON A TRIP shows a balance: status 'ok' with
  * the raw amount fact behind it. Offline `~approx` values count (they are known balances); '—'
  * nulls do NOT (unknown is not funds — offline-first honesty rule).
  *
  * The decision reads the RAW amount (`amountRaw`), never `displayText` (2026-10-01 audit F13):
  * the display string is formatting (approx markers, compaction) and must never decide money
  * state — a `BalanceView` without the raw fact behind an 'ok' status fails closed instead.
  *
  * The PRACTICE rail is excluded (X13, UX swarm 2026-09-08). It used to count "by design", and the
  * result was a wallet stamping FUNDS LOADED on a trip-readiness card while every real currency
  * read 0.00 — the card claiming a state it had not verified (anti-scam rule R4). Faucet-minted
  * demo dollars are valueless by construction, so they cannot make anyone ready for anything; the
  * honest reading of that stamp is "you hold money a merchant would take". */
export function decideFundsReady(balances: Partial<Record<AssetId, BalanceView>>): boolean {
  // Keyed by AssetId so the practice rail can be named and skipped — the decision reads keys AND
  // values now, which is why callers must pass the real map rather than an arbitrary-keyed one.
  return Object.entries(balances).some(
    ([id, v]) => id !== DEMO_ASSET_ID && v != null && v.status === 'ok'
      && v.amountRaw != null && v.amountRaw !== '0',
  );
}

/** Award `paymentTested` — call at every CONFIRMED payment success (either direction, either
 * rail). No-op when already stamped (the check reads the passed journey, and awardStamp itself
 * is idempotent). NEVER call on pending/unknown outcomes — confirmed only.
 *
 * A confirmed real payment ALSO awards `flowUnderstood`: a payment the user just made IS the
 * flow, demonstrated live (founder rule 2026-08-23: every trip-prep check auto-detects — the
 * first-run practice payment is unreachable for wallets created before it existed, so without this
 * co-award SAW THE FLOW would be a permanent dead end for them). */
export function awardPaymentTested(journey: Journey): void {
  if (hasStamp(journey, JOURNEY_STAMPS.paymentTested)) return;
  void awardStamp(JOURNEY_STAMPS.paymentTested);
  if (!hasStamp(journey, JOURNEY_STAMPS.flowUnderstood)) void awardStamp(JOURNEY_STAMPS.flowUnderstood);
}
