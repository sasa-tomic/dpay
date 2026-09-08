// SOL rail transaction history — "what actually moved in or out of this device's Solana wallet",
// newest-first, native SOL and USDC in ONE list so the SOL rail's ledger reads like the IC rail's
// (`hooks/useTransactionHistory.ts`).
//
// PURE data function over an injected `rpcUrl`: no React, no config constants, no module state, no
// clock. NETWORK module — it statically imports `./rpc`, so like `./rpc` it must only ever be
// reached from the seam (`app/solana.ts`) by dynamic import, and the offline jest/e2e loop drives
// it through the `__DPAY_TEST_SOLANA_RPC_STUB` seam or a mocked `fetch`.
//
// ── RPC shape: exactly 2 + limit calls, no pagination ───────────────────────────────────────────
// `getSignaturesForAddress` is per-ADDRESS, and an INCOMING USDC transfer never names the owner
// wallet — its accounts are the two token accounts plus the *sender's* owner — so one query cannot
// see both rails. We issue TWO signature queries: the owner wallet, and its canonical USDC ATA
// (`deriveAta(owner, USDC_MINT_ADDRESS)`). They are unioned by signature, ordered by SLOT (always
// present and monotonic — `blockTime` can be null), cut to the newest `limit`, and then ONE
// `getTransaction` per surviving signature. Total = 2 + limit, with `limit` defaulting to 20 (the
// IC side's page size). There is deliberately NO `before` cursor / infinite scroll (YAGNI): the
// wallet shows a recent list, and an unbounded walk is an unbounded RPC bill.
//
// ── Direction and amount come from BALANCE DELTAS, never from instruction parsing ───────────────
// SOL: `meta.postBalances[i] - meta.preBalances[i]` at the owner's index in the full account list.
// USDC: `meta.postTokenBalances` − `meta.preTokenBalances`, restricted to the USDC mint and to
// entries whose `owner` is this wallet. Deltas are what the chain actually did; an instruction
// decode is what someone *asked* the chain to do, and the two differ on failure, on partial
// execution, and whenever an unrecognised program is in the mix.
//
// ── Fees: the row reports the NET DELTA, with the fee broken out ────────────────────────────────
// When this wallet is the fee payer, its SOL delta already includes the fee, and that combined
// number is the honest answer to "how much left my wallet". Recovering the bare transfer amount
// would mean parsing instructions — the thing we just refused to do — so the row carries the net
// delta as `amount` and the fee charged to THIS wallet as `feeLamports` ('0' when someone else
// paid). A UI that wants the transfer leg alone can render `amount - feeLamports` from data that is
// on the row; nothing is hidden and nothing is invented.
//
// A USDC transfer costs SOL in fees, so it would otherwise produce two rows for one payment. The
// SOL row is suppressed for a signature that already produced a USDC row IFF the SOL delta is
// EXACTLY the fee we paid. Any other SOL movement — e.g. the ≈0.002 SOL rent when the transfer also
// creates the recipient's token account — still gets its own row, because it really did leave the
// wallet.
//
// ── Failed transactions are INCLUDED, and read as what they are ─────────────────────────────────
// `meta.err != null` ⇒ `ok: false`. No special-casing is needed for the numbers: on a failed
// transaction the chain rolls everything back except the fee, so the balance delta IS the fee, and
// the same delta rule produces an honest "−0.000005 SOL · failed" row instead of a phantom payment.
// A failed transaction we did not pay for moves nothing and therefore produces no row at all.
//
// ── The counterparty is derived, or it is null ──────────────────────────────────────────────────
// It is read off the same deltas: the unique OTHER account (SOL) or OTHER token-account owner
// (USDC) whose balance moved the opposite way. Exactly one candidate ⇒ that address. Zero, or more
// than one (a multi-recipient batch, a swap route), ⇒ `null` — "we don't know" is a state the row
// carries, never a plausible-looking address picked out of the account list.
//
// ── Every failure is loud, and none of them becomes a row ───────────────────────────────────────
// A failing signature query THROWS (the list is unusable; the caller surfaces "couldn't load", not
// an empty ledger). A per-transaction failure — unreachable, `null` detail, malformed balances,
// unstated token-account ownership, wrong mint decimals — is logged with the signature and counted
// in `SolanaHistory.dropped`, so a caller can say "2 transactions couldn't be read" rather than
// quietly showing a shorter list.

import bs58 from 'bs58';
import {
  getSignaturesForAddress,
  getTransaction,
  type SolanaRpcOpts,
  type SolanaSignatureInfo,
  type SolanaTransactionDetail,
  type SolanaTransactionMeta,
} from './rpc';
import {deriveAta, USDC_MINT_ADDRESS, USDC_DECIMALS} from './spl';

/** Page size, matching the IC rail's `limit=20`. */
export const SOL_HISTORY_LIMIT = 20;

/**
 * Confirmed transaction DETAILS, cached by signature. A confirmed transaction's detail is
 * immutable, and the 15s history poll used to re-read the same ≤20 of them for as long as the app
 * was open — 80 `getTransaction` calls a minute from a wallet nobody was touching (measured
 * 2026-09-08, alongside the HTTP 429 the shipped RPC key now answers with). Reading each one once
 * is the whole fix.
 *
 * This cannot pin a rolled-back transaction on screen: the SIGNATURE LIST is still fetched fresh
 * every cycle, and the cache is only ever consulted for signatures that list still returns — a
 * transaction that disappears from the chain disappears from the list, and with it from the rows.
 * A `null` detail (the node does not have the transaction yet) is deliberately NOT cached; that is
 * a state that changes.
 */
const detailCache = new Map<string, SolanaTransactionDetail>();
/** Cache ceiling: an app session reads one wallet's recent page, so this is generous — bounded
 *  only so a long-lived session can never grow it without limit. Oldest insertion is evicted
 *  first (Map iterates in insertion order). */
const DETAIL_CACHE_MAX = 200;

function rememberDetail(signature: string, detail: SolanaTransactionDetail): void {
  detailCache.set(signature, detail);
  while (detailCache.size > DETAIL_CACHE_MAX) {
    const oldest = detailCache.keys().next();
    if (oldest.done === true) return;
    detailCache.delete(oldest.value);
  }
}

/** Drop every cached detail. The ONE caller is the test suite, which must not carry one case's
 *  transaction bodies into the next; production never invalidates, because the cached fact cannot
 *  go stale (see `detailCache`). */
export function resetSolanaHistoryCache(): void {
  detailCache.clear();
}

export type SolanaHistoryToken = 'SOL' | 'USDC';

/** One movement of ONE token in ONE transaction. A transaction can produce two rows (a USDC
 *  transfer that also pays token-account rent in SOL); it never produces two rows for one token. */
export interface SolanaHistoryRow {
  /** base58 transaction signature — unique per transaction, the row's stable key with `token`. */
  readonly signature: string;
  /** Confirmation slot. Always present, monotonic — the ORDERING key (newest-first). */
  readonly slot: number;
  /** Unix SECONDS, or null when the node has no time for the block. NEVER substituted with `now`. */
  readonly blockTime: number | null;
  readonly token: SolanaHistoryToken;
  readonly direction: 'out' | 'in';
  /** |net balance delta| in raw units (lamports for SOL, 1e-6 for USDC) as a decimal-digit STRING. */
  readonly amount: string;
  /** Transaction fee charged to THIS wallet, in lamports; '0' when another account paid it. */
  readonly feeLamports: string;
  /** The other side, base58, or null when it is not uniquely determinable. For USDC this is the
   *  OWNER wallet behind the destination token account; for SOL it is literally the account the
   *  lamports moved to/from — which for a rent payment is a token account, not a wallet. */
  readonly counterparty: string | null;
  /** false when the transaction failed on-chain: nothing transferred, only the fee was charged. */
  readonly ok: boolean;
}

export interface SolanaHistoryOpts extends SolanaRpcOpts {
  /** Signatures considered, per queried address, and the hard cap on `getTransaction` calls. */
  limit?: number;
}

export interface SolanaHistory {
  readonly rows: readonly SolanaHistoryRow[];
  /** Transactions we could not read. Each one was logged with its signature and a reason. */
  readonly dropped: number;
}

/** A lamport balance off the wire. Rejects anything that is not an exact non-negative integer —
 *  above 2^53 a JSON number has already lost precision, and a silently-wrong delta is a wrong row. */
function lamports(v: unknown, ctx: string): bigint {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new Error(`${ctx} is not a safe lamport integer (${String(v)})`);
  }
  return BigInt(v);
}

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/** The FULL account list the balance arrays are indexed over: static message keys, then the
 *  lookup-table addresses a versioned (v0) transaction loaded — writable first, then readonly. */
function accountKeys(tx: SolanaTransactionDetail, meta: SolanaTransactionMeta): string[] {
  const statics = tx.transaction?.message?.accountKeys;
  if (!Array.isArray(statics)) throw new Error('transaction.message.accountKeys is not an array');
  const loaded = meta.loadedAddresses;
  const keys = [...statics, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  for (const k of keys) {
    if (typeof k !== 'string') throw new Error(`account key ${String(k)} is not a base58 string`);
  }
  return keys;
}

/** Per-account lamport deltas, positionally aligned with `keys`. The length agreement between the
 *  account list and both balance arrays is the invariant that makes index-based attribution safe —
 *  a mismatch means we cannot say whose money moved, so it fails rather than guesses. */
function lamportDeltas(keys: string[], meta: SolanaTransactionMeta): bigint[] {
  if (keys.length !== meta.preBalances?.length || keys.length !== meta.postBalances?.length) {
    throw new Error(
      `account/balance length mismatch (keys=${keys.length} pre=${meta.preBalances?.length} post=${meta.postBalances?.length})`,
    );
  }
  return keys.map((_, i) =>
    lamports(meta.postBalances[i], `postBalances[${i}]`) - lamports(meta.preBalances[i], `preBalances[${i}]`));
}

/** Net USDC delta per OWNER wallet across the transaction. Validates every USDC entry it sees:
 *  ownership must be stated (an unattributable balance would make our own delta a guess) and the
 *  mint's decimals must be the USDC decimals (a wrong scale is a 1000x wrong amount). */
function usdcDeltasByOwner(meta: SolanaTransactionMeta): Map<string, bigint> {
  const deltas = new Map<string, bigint>();
  const apply = (entries: SolanaTransactionMeta['preTokenBalances'], sign: bigint) => {
    for (const b of entries ?? []) {
      if (b?.mint !== USDC_MINT_ADDRESS) continue;
      if (typeof b.owner !== 'string' || b.owner.length === 0) {
        throw new Error(`USDC token balance at accountIndex ${String(b.accountIndex)} states no owner`);
      }
      const raw = b.uiTokenAmount?.amount;
      if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
        throw new Error(`USDC token balance for ${b.owner} has a malformed amount (${String(raw)})`);
      }
      if (b.uiTokenAmount?.decimals !== USDC_DECIMALS) {
        throw new Error(`USDC token balance for ${b.owner} claims ${String(b.uiTokenAmount?.decimals)} decimals, expected ${USDC_DECIMALS}`);
      }
      deltas.set(b.owner, (deltas.get(b.owner) ?? 0n) + sign * BigInt(raw));
    }
  };
  apply(meta.preTokenBalances, -1n);
  apply(meta.postTokenBalances, 1n);
  return deltas;
}

/** The unique account that moved the OPPOSITE way to `ourDelta`, or null when there is not exactly
 *  one (nothing else moved; or a batch/swap where naming one party would be a lie). */
function uniqueCounterparty(candidates: Iterable<[string, bigint]>, ourDelta: bigint): string | null {
  let found: string | null = null;
  for (const [address, delta] of candidates) {
    if (delta === 0n) continue;
    if (ourDelta > 0n ? delta > 0n : delta < 0n) continue;
    if (found !== null) return null; // more than one opposite party — not determinable
    found = address;
  }
  return found;
}

/** Rows for one transaction. THROWS with a reason on anything unreadable — the caller turns that
 *  into one logged, counted drop. Returns `[]` for a transaction that moved nothing of ours (we
 *  were a read-only account, or it was a memo-only transaction): readable, just not a movement. */
function toHistoryRows(
  tx: SolanaTransactionDetail,
  info: SolanaSignatureInfo,
  ownerAddress: string,
): SolanaHistoryRow[] {
  const meta = tx.meta;
  if (meta === null || meta === undefined) throw new Error('transaction has no meta (balances unknown)');
  const keys = accountKeys(tx, meta);
  const deltas = lamportDeltas(keys, meta);
  const ownerIndex = keys.indexOf(ownerAddress);
  // Index 0 is the fee payer. A transaction that only touches our token account (an incoming USDC
  // transfer) does not list the wallet at all — no SOL delta, no fee charged to us.
  const feeCharged = ownerIndex === 0 ? lamports(meta.fee, 'meta.fee') : 0n;
  const solDelta = ownerIndex >= 0 ? deltas[ownerIndex] : 0n;

  const usdcDeltas = usdcDeltasByOwner(meta);
  const usdcDelta = usdcDeltas.get(ownerAddress) ?? 0n;

  // A time we cannot read is refused, not quietly turned into "unknown time" — `null` means the
  // NODE has no time for the block, and that distinction has to stay true to be worth rendering.
  if (tx.blockTime !== null && !Number.isSafeInteger(tx.blockTime)) {
    throw new Error(`blockTime is neither null nor a unix second (${String(tx.blockTime)})`);
  }

  const shared = {
    signature: info.signature,
    slot: info.slot,
    blockTime: tx.blockTime,
    feeLamports: feeCharged.toString(),
    ok: meta.err === null || meta.err === undefined,
  };

  const rows: SolanaHistoryRow[] = [];
  if (usdcDelta !== 0n) {
    usdcDeltas.delete(ownerAddress);
    rows.push({
      ...shared,
      token: 'USDC',
      direction: usdcDelta > 0n ? 'in' : 'out',
      amount: abs(usdcDelta).toString(),
      counterparty: uniqueCounterparty(usdcDeltas, usdcDelta),
    });
  }
  // Suppress the SOL row only when it is EXACTLY the fee for a transaction already shown as USDC.
  const solIsOnlyTheUsdcFee = usdcDelta !== 0n && solDelta === -feeCharged;
  if (solDelta !== 0n && !solIsOnlyTheUsdcFee) {
    rows.push({
      ...shared,
      token: 'SOL',
      direction: solDelta > 0n ? 'in' : 'out',
      amount: abs(solDelta).toString(),
      counterparty: uniqueCounterparty(
        deltas.flatMap((d, i) => (i === ownerIndex ? [] : [[keys[i], d] as [string, bigint]])),
        solDelta,
      ),
    });
  }
  return rows;
}

/**
 * Recent SOL + USDC movements for `ownerAddress`, newest-first.
 *
 * Throws when the signature queries fail (an unreadable list is an error state, never an empty
 * ledger). Individual unreadable transactions are logged and counted in `dropped`.
 */
export async function fetchSolanaHistory(
  rpcUrl: string,
  ownerAddress: string,
  opts?: SolanaHistoryOpts,
): Promise<SolanaHistory> {
  const limit = opts?.limit ?? SOL_HISTORY_LIMIT;
  const usdcAta = bs58.encode(deriveAta(ownerAddress, USDC_MINT_ADDRESS));
  const [walletSigs, ataSigs] = await Promise.all([
    getSignaturesForAddress(rpcUrl, ownerAddress, limit, opts),
    getSignaturesForAddress(rpcUrl, usdcAta, limit, opts),
  ]);

  // Union the two pages, newest-first by slot. Array#sort is stable, so signatures sharing a slot
  // keep the RPC's own (newest-first) relative order. Cut to `limit` BEFORE fetching details, so a
  // detail fetch is issued at most `limit` times regardless of how the two pages overlap.
  const bySignature = new Map<string, SolanaSignatureInfo>();
  for (const info of [...walletSigs, ...ataSigs]) {
    if (!bySignature.has(info.signature)) bySignature.set(info.signature, info);
  }
  const recent = [...bySignature.values()].sort((a, b) => b.slot - a.slot).slice(0, limit);

  const details = await Promise.all(recent.map(async (info) => {
    const cached = detailCache.get(info.signature);
    if (cached !== undefined) return cached;
    try {
      const detail = await getTransaction(rpcUrl, info.signature, opts);
      if (detail !== null) rememberDetail(info.signature, detail);
      return detail;
    } catch (e) {
      console.warn(`fetchSolanaHistory: getTransaction failed for ${info.signature}: `, e);
      return undefined; // already logged; counted as dropped below
    }
  }));

  const rows: SolanaHistoryRow[] = [];
  let dropped = 0;
  for (let i = 0; i < recent.length; i++) {
    const info = recent[i];
    const tx = details[i];
    if (tx === undefined) { dropped++; continue; }
    if (tx === null) {
      console.warn(`fetchSolanaHistory: no transaction detail for ${info.signature} (unknown to the node or pruned)`);
      dropped++;
      continue;
    }
    try {
      rows.push(...toHistoryRows(tx, info, ownerAddress));
    } catch (e) {
      console.warn(`fetchSolanaHistory: unreadable transaction ${info.signature}: `, e);
      dropped++;
    }
  }
  return {rows, dropped};
}
