/**
 * journey.ts — THE single journey/stamp store (Trip Ready Wave 1A, 2026-08-22).
 *
 * The DRY root every later journey wave builds on: the first-run walkthrough's
 * `walkthroughDone` stamp lives here today; the recovery moment, the trip-readiness
 * passport, and the celebration stamps all award through the same `awardStamp` +
 * `useJourney` seam. Shape is `{stamps, at}` — `stamps` is the canonical key list
 * (JOURNEY_STAMPS values only) and `at` records the wall-clock award time per stamp
 * (for later "when did you…" surfaces). Persisted as JSON under JOURNEY_STORAGE_KEY.
 *
 * Fail-soft like every store in the app (see App.tsx persistRelay): a corrupt or
 * unreadable payload logs + yields the EMPTY journey — the journey system is a
 * delight layer, never a gate on money paths.
 */
import {useCallback, useEffect, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {JOURNEY_STORAGE_KEY} from '../config/constants';

/**
 * The canonical stamp keys — the CLOSED key set. ALL of them are defined here on
 * day one so later waves never edit the key set (a rename would orphan every
 * already-persisted journey). Wave 1A awards only `walkthroughDone`; the rest are
 * reserved for their waves:
 *   - walkthroughDone — the first-run model walkthrough was completed or skipped.
 *   - recoverySaved  — the user acknowledged keeping their backup (Journey 2).
 *   - flowUnderstood — payment-flow comprehension stamp (Journey 5 passport).
 *   - fundsReady     — demo/real funds present (Journey 5 passport).
 *   - paymentTested  — a tap-or-scan payment was exercised (Journey 5 passport).
 *   - firstOfflinePayment — the first offline payment landed (celebration).
 *   - tripReady      — the passport's terminal state.
 */
export const JOURNEY_STAMPS = {
  walkthroughDone: 'walkthroughDone',
  recoverySaved: 'recoverySaved',
  flowUnderstood: 'flowUnderstood',
  fundsReady: 'fundsReady',
  paymentTested: 'paymentTested',
  firstOfflinePayment: 'firstOfflinePayment',
  tripReady: 'tripReady',
} as const;

export type StampKey = keyof typeof JOURNEY_STAMPS;

export type Journey = {
  /** Canonical stamp keys (JOURNEY_STAMPS values), award order. */
  stamps: string[];
  /** Wall-clock ms when each stamp was awarded. */
  at: Record<string, number>;
  /**
   * One-time coaching "seen" markers (Trip Ready J2B, 2026-08-22). NOT achievement stamps —
   * a seen marker only records that a first-use explanation was shown+dismissed, so the
   * mature product stays quiet. Keys are free-form surface ids (`COACHING_TIPS` keys).
   * Absent in pre-2B payloads → parsed as [].
   */
  seen: string[];
};

export const EMPTY_JOURNEY: Journey = {stamps: [], at: {}, seen: []};

/** Pure: whether `j` carries `key`. The only read path — never `.includes` ad hoc. */
export function hasStamp(j: Journey, key: StampKey): boolean {
  return j.stamps.includes(JOURNEY_STAMPS[key]);
}

/** Pure: whether the one-time coaching marker `key` was already seen. */
export function hasSeen(j: Journey, key: string): boolean {
  return j.seen.includes(key);
}

/** Parse a persisted payload defensively: any non-object shape or corrupt JSON → empty. */
export function parseJourney(raw: string | null): Journey {
  if (raw == null) return EMPTY_JOURNEY;
  try {
    const v = JSON.parse(raw) as {stamps?: unknown; at?: unknown; seen?: unknown};
    if (v == null || typeof v !== 'object' || !Array.isArray(v.stamps) || v.at == null || typeof v.at !== 'object') {
      return EMPTY_JOURNEY;
    }
    // Keep only well-formed entries (string stamps + numeric at-times); unknown future
    // stamps survive a round-trip so an app downgrade never wipes a journey. `seen` is
    // optional (pre-2B payloads) — a missing or malformed value yields [].
    const stamps = v.stamps.filter((s): s is string => typeof s === 'string');
    const at: Record<string, number> = {};
    for (const [k, t] of Object.entries(v.at as Record<string, unknown>)) {
      if (typeof t === 'number' && Number.isFinite(t)) at[k] = t;
    }
    const seen = Array.isArray(v.seen) ? v.seen.filter((s): s is string => typeof s === 'string') : [];
    return {stamps, at, seen};
  } catch (e) {
    console.warn('journey: corrupt payload, starting empty:', e instanceof Error ? e.message : String(e));
    return EMPTY_JOURNEY;
  }
}

/** Load the journey from AsyncStorage; any failure → the empty journey (logged). */
export async function loadJourney(): Promise<Journey> {
  try {
    return parseJourney(await AsyncStorage.getItem(JOURNEY_STORAGE_KEY));
  } catch (e) {
    console.warn('journey: load failed, starting empty:', e instanceof Error ? e.message : String(e));
    return EMPTY_JOURNEY;
  }
}

/** Persist best-effort (a failed write never blocks the caller — same contract as App.tsx persistRelay). */
async function persistJourney(j: Journey): Promise<void> {
  try {
    await AsyncStorage.setItem(JOURNEY_STORAGE_KEY, JSON.stringify(j));
    notify(j);
  } catch (e) {
    console.warn('journey: persist failed (ignored):', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Live subscription seam (2026-08-23 founder review: "4 trip readiness objectives
 * that don't complete/close"). `useJourney` loads ONCE on mount — a stamp awarded
 * by ANOTHER mounted surface (paymentTested in PayMode, fundsReady via
 * useFundsReady, tripReady by the passport capstone) never reached the TripStrip /
 * passport card until a full remount, so readiness visibly stalled. Every persist
 * now notifies every live subscriber: one store, many live readers, zero staleness.
 */
type Sub = (j: Journey) => void;
const subs = new Set<Sub>();
function notify(j: Journey): void {
  for (const s of subs) s(j);
}
function subscribe(fn: Sub): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/**
 * Write serialization (2026-08-23): awardStamp/markSeen are each a load→merge→persist
 * read-modify-write over AsyncStorage. Two in-flight writes (e.g. a confirmed payment
 * awarding paymentTested + flowUnderstood back-to-back) could interleave loads and lose a
 * stamp to last-write-wins. Every store write now chains on one module-level queue —
 * callers keep the same fire-and-forget ergonomics, the store just never races itself.
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(op, op);
  writeQueue = next.catch(() => {});
  return next;
}

/**
 * Award a stamp: idempotent (an already-held stamp is a no-op that returns the
 * current journey unchanged, without a redundant write), persists, and returns the
 * updated journey so callers can both act on the result and keep their state fresh.
 */
export function awardStamp(key: StampKey): Promise<Journey> {
  return enqueueWrite(async () => {
    const stamp = JOURNEY_STAMPS[key];
    const current = await loadJourney();
    if (current.stamps.includes(stamp)) return current;
    const updated: Journey = {stamps: [...current.stamps, stamp], at: {...current.at, [stamp]: Date.now()}, seen: current.seen};
    await persistJourney(updated);
    return updated;
  });
}

/**
 * Mark a one-time coaching surface as seen: idempotent (an already-seen key is a no-op
 * returning the current journey unchanged, without a redundant write), persists, and
 * returns the updated journey. The seen-list rides along on every stamp write and
 * vice-versa — neither dimension ever clobbers the other.
 */
export function markSeen(key: string): Promise<Journey> {
  return enqueueWrite(async () => {
    const current = await loadJourney();
    if (current.seen.includes(key)) return current;
    const updated: Journey = {...current, seen: [...current.seen, key]};
    await persistJourney(updated);
    return updated;
  });
}

/**
 * React seam: loads the journey once on mount and exposes `{journey, award, loaded}` where
 * `award(key)` updates local state AND persists (idempotent). For Wave 1A only the
 * Onboarding gate needs `hasStamp`-style reads; the hook is the seam later waves
 * (recovery moment, passport) consume so they never re-implement load/persist.
 * `loaded` (Trip Ready J5b) lets first-paint-dependent surfaces (the passport card) hold
 * their render until the real journey arrives — no empty→filled flash mid-frame.
 */
export function useJourney(): {journey: Journey; award: (key: StampKey) => void; loaded: boolean} {
  const [journey, setJourney] = useState<Journey>(EMPTY_JOURNEY);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    loadJourney().then(j => { if (alive) { setJourney(j); setLoaded(true); } }).catch(() => {});
    // Live seam: any persist from ANY surface (awardStamp/markSeen elsewhere) pushes
    // the fresh journey here — stamps complete on screen, no remount needed.
    const unsub = subscribe(j => { if (alive) setJourney(j); });
    return () => { alive = false; unsub(); };
  }, []);
  const award = useCallback((key: StampKey) => {
    // Fail-soft optimistic update: state moves immediately; the persisted store is
    // the source of truth on next mount (awardStamp re-checks idempotency anyway).
    // Spread-first so the seen-markers dimension rides along untouched.
    setJourney(j => j.stamps.includes(JOURNEY_STAMPS[key])
      ? j
      : {...j, stamps: [...j.stamps, JOURNEY_STAMPS[key]], at: {...j.at, [JOURNEY_STAMPS[key]]: Date.now()}});
    void awardStamp(key);
  }, []);
  return {journey, award, loaded};
}
