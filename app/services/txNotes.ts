import AsyncStorage from '@react-native-async-storage/async-storage';
import type {Txn} from '../lib/types';

// Authority: payment-context annotations (peer names + messages) for the transaction log.
// The IC rail carries NO counterparty name on-chain (map_icrc_txn hard-codes from_name/to_name to
// '') and the on-chain memo is the frozen 16-byte nonce — the reconciliation key, never a human
// message. The name and the human message DO exist at payment time, though: the payee's request
// QR carries `toName` + `memo`, a payment link carries `label` + `memo`, a Solana Pay URI carries
// `label` + `message`. This store saves exactly that device-side context at the moment a payment
// (or request) is made, keyed by the value that survives the round trip:
//   - IC rows: the on-chain memo hex (the request nonce) — the relay echoes it back as `memo`.
//   - SOL rows: the transaction signature — known locally from the send result, never re-read
//     (parsing on-chain SPL Memo data for INCOMING rows was rejected: it would re-fetch every
//     transaction on every history tick — the exact behaviour flow 160 pins as forbidden).
// The read side layers these notes UNDER the row's own ledger truth: `who`/`msg` only ever
// REPLACE the display prefix and the memo line; the receipt keeps the full principal and the hex
// reference no matter what. Nothing here is synced, exported, or invented — an annotation exists
// only for a payment this device itself made or requested (plus the address book's own labels on
// the read side, which this module does not own).
//
// PER-IDENTITY storage (key `dpay.txnotes.v1.<publicHex>`, mirrors convertStoreKey): notes about
// money belong to the wallet that moved it.
//
// CLOCK-FREE BY CONTRACT (addressBook convention): `at` is the CALLER's `nowMs`, the sole
// ordering/eviction key — pure functions of the arguments, testable without fake timers.
//
// Best-effort in the house style: corrupt stores salvage to [], writes never throw at callers (a
// display annotation must never crash a payment flow). One difference from addressBook: there is
// NO throwing contract check — invalid input is skipped with a console.warn, because callers
// pass untrusted surface text (request labels) and the store is not the place to hard-fail on it.

/** One saved payment-context annotation. `k` is the join key (see module comment). */
export type TxNote = {
  readonly k: string; // join key, lowercase (IC memo/nonce hex, or a SOL signature)
  readonly who?: string; // peer name known at payment time ('' never stored)
  readonly msg?: string; // human message known at payment time ('' never stored)
  // The GROSS headline + the FEE, both raw digit strings in the row's own asset units (founder
  // rule 2026-09-14: a netted request payment displays the typed price on BOTH devices; the fee
  // rides along ONLY as the log row's annotation line). '' never stored.
  readonly gross?: string;
  readonly fee?: string;
  readonly at: number; // caller's nowMs — the sole ordering/eviction key
};

/** What the read side resolves for one row — a note's display half, address-book label included. */
export type TxAnnotation = {readonly who?: string; readonly msg?: string; readonly gross?: string; readonly fee?: string};

/** How many annotations one identity keeps. Beyond this the oldest (by `at`) is evicted. */
export const MAX_TX_NOTES = 500;

/** The storage key for one identity's notes (`dpay.*` namespace, `.v1` schema-version suffix). */
export function txNotesKey(publicHex: string): string {
  return `dpay.txnotes.v1.${publicHex}`;
}

/** Join keys are compared lowercased (relay memo hex case varies by producer). */
export function normalizeJoinKey(key: string): string {
  return key.trim().toLowerCase();
}

const detail = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Digit strings only: gross/fee are raw amounts in the row's own units — anything else (an
 *  already-formatted string, a decimal, a sign) is a producer bug, dropped at the shape gate. */
const isRawDigits = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v) && v !== '';

/** Shape check for one stored entry. */
export function isTxNote(value: unknown): value is TxNote {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  if (typeof e.k !== 'string' || e.k === '' || typeof e.at !== 'number' || !Number.isFinite(e.at)) return false;
  if (e.who !== undefined && (typeof e.who !== 'string' || e.who === '')) return false;
  if (e.msg !== undefined && (typeof e.msg !== 'string' || e.msg === '')) return false;
  if (e.gross !== undefined && !isRawDigits(e.gross)) return false;
  if (e.fee !== undefined && !isRawDigits(e.fee)) return false;
  return true;
}

/**
 * Validate a parsed blob into salvageable notes. A single corrupt entry is dropped INDIVIDUALLY
 * (logged, like addressBook's `hydrate`) — one bad row must not cost the other annotations.
 * A non-array value has no salvageable rows at all → [].
 */
export function salvageTxNotes(raw: unknown): TxNote[] {
  if (!Array.isArray(raw)) return [];
  const out: TxNote[] = [];
  for (const e of raw) {
    if (isTxNote(e)) out.push(e);
    else console.warn(`txnotes: dropping malformed entry ${JSON.stringify(e)}`);
  }
  return out;
}

/**
 * The ONE place replace-by-key and the cap are applied. A note whose `k` already exists REPLACES
 * the old entry (a second payment against the same request nonce/link ref re-annotates it with the
 * freshest context); otherwise it is appended. Over-cap, the oldest by `at` drops — stable for
 * ties (sort is stable in V8/Hermes; ties keep insertion order).
 */
export function mergeTxNote(entries: readonly TxNote[], note: TxNote): TxNote[] {
  const kept = entries.filter(e => e.k !== note.k);
  kept.push(note);
  if (kept.length <= MAX_TX_NOTES) return kept;
  return kept.slice().sort((a, b) => b.at - a.at).slice(0, MAX_TX_NOTES);
}

/** The read-side lookup: join key → note. Keys are NORMALIZED here (the one seam both ends meet
 *  at), so an entry that entered the store through any path still matches the resolver's
 *  lowercased lookup. */
export function txNoteIndex(entries: readonly TxNote[]): ReadonlyMap<string, TxNote> {
  return new Map(entries.map(e => [normalizeJoinKey(e.k), e] as const));
}

/**
 * The read-side resolver Wallet mounts: one row → its annotation, or undefined when neither a
 * note nor a saved-address label exists (the row then renders exactly its ledger truth). PURE, so
 * the precedence is unit-testable without a component tree:
 *   who = note.who (what the user SAW when they paid) || address-book label — never the row's
 *   principal prefix, which stays the fallback the renderer applies when this returns undefined.
 * Join key: the IC row's memo hex (the request nonce) / the SOL row's signature, normalized the
 * same way `saveTxNote` normalized it at write time (both ends lowercase).
 */
export function annotateTxn(
  t: Pick<Txn, 'assetId' | 'memo' | 'nonce' | 'counterparty'>,
  notes: ReadonlyMap<string, TxNote>,
  labels: ReadonlyMap<string, ReadonlyMap<string, string>>,
): TxAnnotation | undefined {
  const key = t.assetId.startsWith('solana:') ? t.nonce.toLowerCase() : t.memo.toLowerCase();
  // An IC row with no memo has NO join key — there is nothing to annotate it by, whatever the
  // store holds (the write path never saves an empty key; the read side stays total anyway).
  if (key === '') return undefined;
  const note = notes.get(key);
  const label = labels.get(t.assetId)?.get(t.counterparty);
  const who = note?.who || label;
  const msg = note?.msg;
  const gross = note?.gross;
  const fee = note?.fee;
  return who !== undefined || msg !== undefined || gross !== undefined || fee !== undefined
    ? {who, msg, gross, fee}
    : undefined;
}

// A tiny module-level emitter: `saveTxNote` announces which identity's store changed so a mounted
// `useTxNotes` can re-read. Component-level listeners come and go; the module singleton survives.
type TxNotesListener = (publicHex: string) => void;
const listeners = new Set<TxNotesListener>();

/** Subscribe to store changes. Returns the unsubscribe fn. */
export function subscribeTxNotes(fn: TxNotesListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function notify(publicHex: string): void {
  for (const fn of listeners) {
    try { fn(publicHex); } catch (e) { console.warn(`txnotes: listener failed: ${detail(e)}`); }
  }
}

/** Best-effort read: missing key, corrupt JSON, or storage failure all degrade to []. */
export async function loadTxNotes(publicHex: string): Promise<TxNote[]> {
  const key = txNotesKey(publicHex);
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null) return [];
    return salvageTxNotes(JSON.parse(raw));
  } catch (e) {
    console.warn(`txnotes ${key} load failed: ${detail(e)}`);
    return [];
  }
}

/**
 * Record one annotation. Empty `who`/`msg` are dropped; `gross`/`fee` survive only as raw digit
 * strings (anything else is dropped too — the renderer must never receive a formatted string
 * where an amount belongs). If NOTHING survives there is no annotation and the call is a no-op
 * (an annotation without displayable content would only evict a real note). Never throws at the
 * caller: load/persist failures are caught and logged.
 */
export async function saveTxNote(
  publicHex: string,
  input: {k: string; who?: string; msg?: string; gross?: string; fee?: string},
  nowMs: number,
): Promise<void> {
  try {
    const k = normalizeJoinKey(input.k);
    const who = input.who?.trim() || undefined;
    const msg = input.msg?.trim() || undefined;
    const gross = isRawDigits(input.gross) ? input.gross : undefined;
    const fee = isRawDigits(input.fee) ? input.fee : undefined;
    if (k === '' || (who === undefined && msg === undefined && gross === undefined && fee === undefined)) return;
    const entries = await loadTxNotes(publicHex);
    const next = mergeTxNote(entries, {k, who, msg, gross, fee, at: nowMs});
    await AsyncStorage.setItem(txNotesKey(publicHex), JSON.stringify(next));
    notify(publicHex);
  } catch (e) {
    console.warn(`txnotes save failed: ${detail(e)}`);
  }
}
