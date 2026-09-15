import AsyncStorage from '@react-native-async-storage/async-storage';

// Authority: the PERSISTED outbox of payments handed off UNCONFIRMED (offline QR, offline NFC tap,
// a SOL offline sign) — founder requirements 2026-09-15:
//   1. an offline payment appears in the LOCAL transaction list with the balance deducted (we
//      ASSUME the transfer completed — the merchant's phone settles it);
//   3. the deduction and the row SURVIVE an app restart (funded at home, paid in the city).
// The tx-note store (services/txNotes) already persists each hand-off's NAME/message/price keyed by
// the payment's join key, but a note is display metadata: it cannot subtract from a balance and it
// has no lifetime — it annotates whatever row later lands. This store is the operational record:
// each entry says "money PROBABLY left this account at ts, for this much, and no ledger has
// confirmed it yet". It is written at the SAME seams, under the SAME key, so the pending row, the
// future settled row and the note all reconcile as ONE payment.
//
// JOIN KEYS — deliberately identical to the tx-note key of the same seam (annotateTxn's rule):
//   • IC QR hand-off + IC NFC tap: the request's nonceHex = the on-chain memo the relay echoes
//     back in `TransactionsRow.memo`.
//   • SOL QR hand-off + SOL NFC tap: the base58 transaction signature the settling row carries in
//     `SolanaHistoryRow.signature` (a SOL row's `Txn.nonce`).
// Reconciliation (Wallet) drops a record the moment its key appears in either rail's history —
// until then the row renders as pending and the balance carries the deduction.
//
// LIFETIME of the DEDUCTION vs the ROW, which are different and stay different:
//   • the SUBTRACTION ends when a successful balance poll for that asset lands after the hand-off
//     (the authoritative balance replaces the optimistic view — the existing useBalancePoll reset
//     semantics, now read off the poll's own success timestamps instead of an ephemeral map).
//     That is DERIVED, not stored: `useBalancePoll` exposes `balanceAt`/`assetAt`, and a record
//     subtracts only while the asset's last success predates the record's `ts`.
//   • the ROW ends only at history reconciliation (the ledger's own row is the durable truth).
//     Un-reconciled records are cap-bounded below, so a hand-off that never settles (the merchant
//     never scanned it) eventually ages out of the list rather than accumulating forever.
//
// Best-effort in the house style (txNotes/ledgerFees): per-record salvage on load, reads and
// writes never throw at a caller — an outbox must never crash the payment flow that fills it.

/** The storage key prefix (`dpay.*` namespace, `.v1` schema-version suffix). */
const PENDING_PAYS_PREFIX = 'dpay.pendingpays.v1';

/** The per-identity storage key. */
export const pendingPaysKey = (publicHex: string): string => `${PENDING_PAYS_PREFIX}.${publicHex}`;

/**
 * How many records one identity keeps. txNotes caps at 500 because notes annotate rows FOREVER;
 * these records self-destruct on reconciliation, so the cap only bounds the pathological case
 * (many never-settling hand-offs). 50 is months of offline payments at any honest rate.
 */
export const MAX_PENDING_PAYS = 50;

/** Which seam wrote the record — IC vs SOL, QR hand-off vs NFC tap. Render-neutral today; kept
 *  because the two rails reconcile against different history keys and a debugging session wants
 *  the distinction without re-deriving it from the assetId. */
export type PendingPayKind = 'ic-nfc' | 'ic-qr' | 'sol-nfc' | 'sol-qr';

/**
 * One handed-off-unconfirmed payment. Raw amounts are decimal-digit STRINGS (BigInt-only math —
 * MC1). `gross` = wire + fee = what the account actually moves; it is the DEDUCTION and the ROW
 * headline when the fee chain answered (founder rule 2026-09-14), with `wireAmount` the fallback —
 * never a guessed fee.
 */
export type PendingPay = {
  /** The join key (see module doc) — SAME key the seam's txNote carries. */
  readonly k: string;
  /** The asset the payment leaves: `ic:<currency>` | `solana:SOL` | `solana:<token>`. */
  readonly assetId: string;
  /** The IC currency id, or null on the SOL rail (the assetId carries it there). */
  readonly currency: number | null;
  /** The wire the signed envelope moves (raw units). */
  readonly wireAmount: string;
  /** The ledger fee (raw units), when the fee chain answered. */
  readonly fee?: string;
  /** wire + fee (raw units), when the fee is known. */
  readonly gross?: string;
  /** The payee's claimed name / the human memo, exactly what the seam's txNote saves. */
  readonly who?: string;
  readonly msg?: string;
  /** Hand-off time (Date.now() ms). Drives row order and the deduction's poll-freshness test. */
  readonly ts: number;
  readonly kind: PendingPayKind;
};

/** Trim + lowercase — the same normalization `normalizeJoinKey` applies in txNotes, so a record
 *  written beside a note under one spelling reconciles against history under the other. */
export function normalizePendingKey(key: string): string {
  return key.trim().toLowerCase();
}

/** Digit strings only (a raw amount in the asset's own units) — anything else is a producer bug,
 *  dropped at the shape gate. */
const isRawDigits = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v) && v !== '';

/** Shape check for one stored record. Accepts the optional fields only in their honest shapes
 *  (digit-string amounts; a known gross without a fee would be un-derivable, but it is stored
 *  verbatim rather than re-derived — the writer computed it, the reader trusts nobody). */
export function isPendingPay(value: unknown): value is PendingPay {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (typeof r.k !== 'string' || r.k.trim().length === 0) return false;
  if (typeof r.assetId !== 'string' || r.assetId.length === 0) return false;
  if (r.currency !== null && typeof r.currency !== 'number') return false;
  if (!isRawDigits(r.wireAmount)) return false;
  if (r.fee !== undefined && !isRawDigits(r.fee)) return false;
  if (r.gross !== undefined && !isRawDigits(r.gross)) return false;
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return false;
  return r.kind === 'ic-nfc' || r.kind === 'ic-qr' || r.kind === 'sol-nfc' || r.kind === 'sol-qr';
}

/**
 * Validate a parsed blob into a salvageable list. A single corrupt record is dropped INDIVIDUALLY
 * (logged — the `salvageTxNotes` convention) so one bad write never costs the other hand-offs
 * their row or their deduction. A non-array (corrupt JSON, a legacy shape) has nothing salvageable.
 */
export function salvagePendingPays(raw: unknown): PendingPay[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingPay[] = [];
  for (const v of raw) {
    if (isPendingPay(v)) out.push(v);
    else console.warn(`pendingpays: dropping malformed record: ${JSON.stringify(v)}`);
  }
  return out;
}

/** In-memory change listeners — the same announce pattern txNotes uses, so `usePendingPays` (and
 *  any second subscriber, e.g. a future Wallet-level reconciler) re-reads the moment ANY seam
 *  writes, without the seams holding hook handles. */
const listeners = new Set<(publicHex: string) => void>();

export function subscribePendingPays(fn: (publicHex: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function notify(publicHex: string): void {
  for (const fn of listeners) { try { fn(publicHex); } catch { /* a listener's bug never blocks the write */ } }
}

/** Best-effort read of one identity's records: missing key, corrupt JSON, or a storage failure all
 *  degrade to [] (logged) — an unreadable outbox is an empty one, never a crash. */
export async function listPendingPays(publicHex: string): Promise<PendingPay[]> {
  try {
    const raw = await AsyncStorage.getItem(pendingPaysKey(publicHex));
    if (raw === null) return [];
    return salvagePendingPays(JSON.parse(raw));
  } catch (e) {
    console.warn(`pendingpays ${pendingPaysKey(publicHex)} load failed:`, e instanceof Error ? e.message : String(e));
    return [];
  }
}

/**
 * Add hand-off records (a batch, because a seam writes exactly one but the signature costs
 * nothing). Replace-by-key: the double-pay guard's re-approve path re-displays the SAME envelope
 * (PayMode's `submittedEnv`), and re-writing it under the same join key must refresh — not
 * duplicate — the record. The cap drops the OLDEST by `ts` (stable sort, so equal timestamps keep
 * insertion order). Never throws at the caller; announces the identity on any persisted change.
 */
export async function addPendingPays(publicHex: string, recs: PendingPay[]): Promise<void> {
  try {
    const valid = recs.filter(r => {
      if (!isPendingPay(r)) { console.warn(`pendingpays: refusing malformed record: ${JSON.stringify(r)}`); return false; }
      return true;
    });
    if (valid.length === 0) return;
    const prior = await listPendingPays(publicHex);
    const byKey = new Map<string, PendingPay>();
    for (const r of prior) byKey.set(normalizePendingKey(r.k), r);
    for (const r of valid) byKey.set(normalizePendingKey(r.k), r);
    let next = [...byKey.values()];
    if (next.length > MAX_PENDING_PAYS) {
      const sorted = [...next].sort((a, b) => a.ts - b.ts); // oldest first
      const keep = new Set(sorted.slice(next.length - MAX_PENDING_PAYS));
      // Stable-filter the ORIGINAL order: eviction must not reorder what survives.
      next = next.filter(r => keep.has(r));
    }
    await AsyncStorage.setItem(pendingPaysKey(publicHex), JSON.stringify(next));
    notify(publicHex);
  } catch (e) {
    console.warn(`pendingpays save failed:`, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Drop records by join key — the reconciliation write (history showed the settled row) and the
 * confirmed-outcome writes (NFC RESULT_SETTLED / RESULT_REJECTED: the tap itself answered). Keys
 * are normalized here, so callers pass whatever shape they hold. Never throws; announces on change.
 */
export async function removePendingPays(publicHex: string, keys: string[]): Promise<void> {
  try {
    if (keys.length === 0) return;
    const drop = new Set(keys.map(normalizePendingKey));
    const prior = await listPendingPays(publicHex);
    const next = prior.filter(r => !drop.has(normalizePendingKey(r.k)));
    if (next.length === prior.length) return;
    await AsyncStorage.setItem(pendingPaysKey(publicHex), JSON.stringify(next));
    notify(publicHex);
  } catch (e) {
    console.warn(`pendingpays remove failed:`, e instanceof Error ? e.message : String(e));
  }
}
