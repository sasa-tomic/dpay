import AsyncStorage from '@react-native-async-storage/async-storage';
import type {OfframpStep} from './rail';
import type {RetainedOfframp} from './offrampRetry';

// Persist an IN-FLIGHT offramp (withdrawal) across app restarts — mirrors services/ckerc20Persist.ts
// style. A withdrawal is a multi-step sequence of SIGNED envelopes (icrc2_approve(s) + the minter
// call), submitted one at a time. If the app dies mid-sequence, re-preparing on next open would
// mint fresh request_ids for a withdrawal that may already be in flight = the double-burn class.
// Instead the prepared steps are persisted under the user's pubkey + currency, and the sheet
// RESUMES by re-submitting the SAME envelope bytes (dedup'd by request_id) from the first
// not-yet-settled step.
//
// Record lifecycle: written BEFORE each step's first submission (so a crash mid-submit resumes
// verbatim at that step), advanced after each SETTLED step, and CLEARED once the whole sequence
// settles (or when the user deliberately edits the form = a new withdrawal intent). This module
// is a PURE AsyncStorage wrapper (no @ReactMethod / NativeModules surface). Best-effort: a
// malformed/corrupt value is swallowed (load → null), never thrown — a storage glitch can never
// crash the resume path.

/**
 * The persisted slice of an in-flight offramp. Every field is what the resume path needs to
 * re-submit with NO re-signing:
 *   - `currency`: catalog currency id (redundant with the key; a self-describing sanity check).
 *   - `destination` / `amountRaw`: what the envelopes send (the resume card display + receipt).
 *   - `steps`: the signed envelopes in submit order — `{ledger, envelopeHex, requestIdHex, label}`.
 *   - `nextIdx`: the first NOT-yet-settled step index; the resume submission start point.
 */
export type OfframpRecord = RetainedOfframp & {currency: number};

export function offrampKey(pubkeyHex: string, currency: number): string {
  return `dpay.offramp.${pubkeyHex}.${currency}`;
}

/** Validate an unknown storage value into an OfframpRecord (pure; jest-pinned). */
export function hydrateOfframp(state: unknown): OfframpRecord | null {
  if (!state || typeof state !== 'object') return null;
  const s = state as Record<string, unknown>;
  if (typeof s.destination !== 'string') return null;
  if (typeof s.amountRaw !== 'string') return null;
  if (typeof s.currency !== 'number') return null;
  if (typeof s.nextIdx !== 'number' || !Number.isInteger(s.nextIdx)) return null;
  if (!Array.isArray(s.steps) || s.steps.length === 0) return null;
  const steps: OfframpStep[] = [];
  for (const st of s.steps) {
    if (!st || typeof st !== 'object') return null;
    const r = st as Record<string, unknown>;
    if (typeof r.ledger !== 'string') return null;
    if (typeof r.envelopeHex !== 'string') return null;
    if (typeof r.requestIdHex !== 'string') return null;
    if (typeof r.label !== 'string') return null;
    steps.push({ledger: r.ledger, envelopeHex: r.envelopeHex, requestIdHex: r.requestIdHex, label: r.label});
  }
  // nextIdx must point AT a pending step (a record with nextIdx === steps.length means everything
  // settled — that must never persist; the writer clears the record on completion).
  if (s.nextIdx < 0 || s.nextIdx >= steps.length) return null;
  return {currency: s.currency, destination: s.destination, amountRaw: s.amountRaw, steps, nextIdx: s.nextIdx};
}

export async function loadOfframp(pubkeyHex: string, currency: number): Promise<OfframpRecord | null> {
  try {
    const raw = await AsyncStorage.getItem(offrampKey(pubkeyHex, currency));
    if (raw == null) return null;
    return hydrateOfframp(JSON.parse(raw));
  } catch (e) {
    console.warn(`loadOfframp: ${offrampKey(pubkeyHex, currency)} could not be read or parsed — a resumable withdrawal may be forgotten:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

export async function saveOfframp(pubkeyHex: string, record: OfframpRecord): Promise<void> {
  try {
    await AsyncStorage.setItem(offrampKey(pubkeyHex, record.currency), JSON.stringify(record));
  } catch (e) {
    console.warn(`saveOfframp: writing ${offrampKey(pubkeyHex, record.currency)} failed — this withdrawal will not resume after a restart:`, e instanceof Error ? e.message : String(e));
  }
}

export async function clearOfframp(pubkeyHex: string, currency: number): Promise<void> {
  try {
    await AsyncStorage.removeItem(offrampKey(pubkeyHex, currency));
  } catch (e) {
    console.warn(`clearOfframp: clearing ${offrampKey(pubkeyHex, currency)} failed — a finished withdrawal may offer to resume:`, e instanceof Error ? e.message : String(e));
  }
}
