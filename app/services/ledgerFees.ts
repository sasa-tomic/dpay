import AsyncStorage from '@react-native-async-storage/async-storage';

// Authority: the DISPLAY half of the ledger-fee story (founder rule 2026-09-14). Every
// user-facing amount for a netted request payment shows the GROSS (typed price = wire + fee),
// and the payer is offline exactly when that display used to regress to the netted wire —
// signature NFC/QR IS the offline use case, and the live `icrc1_fee` query cannot run there.
// The LIVE answer stays authoritative (`services/rail.ts` `fetchLedgerFee`) and is the ONLY
// value a signing path may ever see: the offramp prepares and every ICRC-2 approve carry
// `fetchLedgerFee`'s own return verbatim, because a wrong fee in a signed approve is
// BadFee-rejected — a cached or catalog fee must NEVER flow into a signature. This module owns
// the two LOCAL answers the DISPLAY seams (NfcTap card side, PayMode review/note) fall back to
// when the live query fails:
//   1. the fee the ledger ITSELF last answered for this exact ledger, persisted here by the
//      write-through in `fetchLedgerFee` — a past authoritative answer, never an estimate;
//   2. the bundled catalog row's `fee` (config/catalog) — drift-alarmed display metadata the
//      relay composes from the canister's own registration.
// Both are the ledger's own fact by another road; neither is a guess. When neither knows
// (ckBTC/DEMO register no fee anywhere) the caller falls back to the wire — the honest last
// resort, never a guessed 0.
//
// GLOBAL store (key `dpay.ledgerfees.v1`, NOT per-identity — unlike txNotes): a ledger's fee is
// a property of the LEDGER, not of the wallet reading it, so every identity on this device
// shares the answer. Fees are few (one per ledger, a handful of ledgers): no cap, no eviction.
// `at` is an informational freshness stamp only — nothing orders or evicts on it. Concurrent
// writes race last-write-wins and may drop a sibling's entry; benign, because the next
// successful live query re-writes it and the store is display-only.
//
// Best-effort in the house style (txNotes/addressBook): corrupt stores salvage per-entry, reads
// and writes never throw at a caller — a display cache must never crash a payment flow.

/** The storage key (`dpay.*` namespace, `.v1` schema-version suffix). */
export const LEDGER_FEES_KEY = 'dpay.ledgerfees.v1';

/** One persisted answer: the raw-fee digit string + when it was heard (informational only). */
export type LedgerFeeEntry = {readonly fee: string; readonly at: number};

/** The whole store: ledger principal text (canonical) → its latest answer. */
export type LedgerFeeStore = Readonly<Record<string, LedgerFeeEntry>>;

const detail = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Digit strings only: a fee is a raw amount in the ledger's own units — anything else (a
 *  formatted string, a decimal, a sign) is a producer bug, dropped at the shape gate. */
const isRawDigits = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v) && v !== '';

/** Shape check for one stored entry. */
export function isLedgerFeeEntry(value: unknown): value is LedgerFeeEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return isRawDigits(e.fee) && typeof e.at === 'number' && Number.isFinite(e.at);
}

/**
 * Validate a parsed blob into a salvageable store. A single corrupt entry is dropped
 * INDIVIDUALLY (logged — the txNotes `salvageTxNotes` convention) so one bad ledger never costs
 * the others their answers. A non-object (corrupt JSON salvaged, a legacy shape) has no
 * salvageable entries → {}.
 */
export function salvageLedgerFees(raw: unknown): LedgerFeeStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, LedgerFeeEntry> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === '') continue; // no ledger at all — unkeyable, unusable
    if (isLedgerFeeEntry(v)) out[k] = v;
    else console.warn(`ledgerfees: dropping malformed entry for ${k}: ${JSON.stringify(v)}`);
  }
  return out;
}

/** Best-effort read of the whole store: missing key, corrupt JSON, or a storage failure all
 *  degrade to {} (logged) — an unreadable cache is no cache, never a crash. */
async function loadLedgerFees(): Promise<LedgerFeeStore> {
  try {
    const raw = await AsyncStorage.getItem(LEDGER_FEES_KEY);
    if (raw === null) return {};
    return salvageLedgerFees(JSON.parse(raw));
  } catch (e) {
    console.warn(`ledgerfees ${LEDGER_FEES_KEY} load failed: ${detail(e)}`);
    return {};
  }
}

/**
 * Record one ledger's latest live answer — the write-through `fetchLedgerFee` performs on every
 * successful query. Fire-and-forget: MERGES into the store (other ledgers keep their answers; a
 * re-answer for the same ledger replaces it). A non-digit fee or an empty ledger is skipped
 * with a warn (a producer bug, not a cacheable answer). Never throws at the caller — the cache
 * write must never crash the payment flow that produced the answer.
 */
export async function rememberLedgerFee(ledger: string, fee: string): Promise<void> {
  try {
    if (ledger.length === 0 || !isRawDigits(fee)) {
      console.warn(`ledgerfees: refusing to cache ledger=${JSON.stringify(ledger)} fee=${JSON.stringify(fee)}`);
      return;
    }
    const store = await loadLedgerFees();
    await AsyncStorage.setItem(LEDGER_FEES_KEY, JSON.stringify({...store, [ledger]: {fee, at: Date.now()}}));
  } catch (e) {
    console.warn(`ledgerfees save failed: ${detail(e)}`);
  }
}

/** The persisted answer for one ledger, or null when nothing (honestly) is cached. An empty
 *  ledger text has no cache entry by construction and never matches. */
export async function cachedLedgerFee(ledger: string): Promise<string | null> {
  if (ledger.length === 0) return null;
  const entry = (await loadLedgerFees())[ledger];
  return entry ? entry.fee : null;
}

/**
 * The bundled catalog row's registered fee, as a raw digit string — or null when the currency
 * is unknown or the row registers none (DEMO is play money; the bundled ckBTC row carries no
 * fee). PURE. Structural on purpose (the rail-style `{currency, fee}` shape, like
 * `prepareTransfer`'s catalog param): the caller passes whatever catalog it holds, and the
 * drift-alarmed bundled/relay catalog both fit without a second mapping.
 */
export function catalogLedgerFee(
  catalog: readonly {currency: number; fee: string | null}[],
  currency: number,
): string | null {
  const fee = catalog.find(c => c.currency === currency)?.fee ?? null;
  return fee != null && isRawDigits(fee) ? fee : null;
}

/**
 * The LOCAL half of the display chain: the persisted ledger answer first, then the catalog row.
 * Never rejects (every leg is caught — a display fallback must not crash a payment flow); null
 * means NEITHER local source knows and the caller renders the wire alone. The display seams
 * (NfcTap card side, PayMode review/note) compose this as the `.catch` arm of the LIVE
 * `fetchLedgerFee`, so the live answer always wins over both whenever it can be had.
 */
export async function fallbackLedgerFee(
  ledger: string,
  catalog: readonly {currency: number; fee: string | null}[],
  currency: number,
): Promise<string | null> {
  try {
    const cached = await cachedLedgerFee(ledger);
    return cached ?? catalogLedgerFee(catalog, currency);
  } catch {
    return null;
  }
}
