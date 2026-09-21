/**
 * Delegated conversion (spec 2026-09-07; multi-venue readiness V1/V2) — the standalone
 * wallet-level Convert action.
 *
 * dpay is NEVER a party to the trade: the user's phone signs EVERY value-moving call (today:
 * `icrc2_approve` naming the venue pool as spender, and the pool's `depositFromAndSwap` — one
 * SignedLeg each), and they are submitted through the exact app-signed /api/v2 rail every IC
 * transfer already uses (services/icp.ts → services/rail.ts). The venue's own quote is
 * displayed verbatim, attributed and timestamped — never computed, blended, or ranked here.
 * dpay charges nothing and is paid nothing.
 *
 * A record names its VENUE by the stable `venue_id` (registry: `./config/venues`); venue facts
 * (display name, endpoint) are looked up from it, never imported as constants.
 *
 * The §4 state machine (persisted in AsyncStorage under the identity-scoped key
 * `convertStoreKey(publicHex)` — `dpay.convert.v2.<pub>`, V6; one record per conversion id;
 * v1 and pre-scoping v2 records are MIGRATED on load — per-record salvage: a corrupt record
 * is dropped, never the whole store, and a legacy key is retired only after a fully
 * successful adoption):
 *
 *   quote → confirming → approving → approved → swapping → settling
 *         ├→ done {outAmountNet, outTx}            (output-ledger credit SEEN — never from #ok alone)
 *         ├→ pending_withdrawal                    (pool #ok, output not seen yet — keep watching)
 *         ├→ failed_refunded                       (refused/refunded — user's position named)
 *         └→ stuck                                 (honest unknown — instructions, not a spinner)
 *
 *   CeFi-shaped states (multi-venue readiness V2): awaiting_user_authorization → awaiting_deposit
 *   → provider_processing → done | quote_expired | provider_refunded. A CeFi record carries NO
 *   legs — an empty `legs` + a `providerRef {orderId}` is valid — because nothing on the IC rail
 *   moves. Their DRIVER (V6) polls the provider's statusUrl; see `convertResume.ts` for the
 *   status vocabulary and the honest-transition rules (no fabricated outcomes).
 *
 * Recovery is EXPIRY-HONEST (V6). An unconfirmed leg is a trichotomy, never one rule:
 *   (a) unconfirmed + NOT yet expired → resubmit the SAME signed bytes (spec §4 identical-
 *       envelope discipline; request_id dedup makes it a no-op if it already executed);
 *   (b) unconfirmed + EXPIRED → NEVER resubmit (the ingress rejects the bytes anyway, and they
 *       may already have executed — the outcome is UNKNOWN): probe settlement until it resolves
 *       done/refunded, else park on `stuck` and keep slow-watching until it resolves or the
 *       user acknowledges the stuck state (`acknowledgedStuckAtMs`);
 *   (c) venue refused before value moved → failed_refunded (unchanged).
 *   `quote_expired` is a DIFFERENT event — the provider's own quote/deposit window died before
 *   any value moved (a CeFi driver transition) — and is never set by leg expiry.
 *
 * Retry discipline (offrampRetry heritage): a record carries the SIGNED envelope bytes; every
 * retry re-submits those identical bytes (dedup'd on-chain by request_id) — args are NEVER rebuilt
 * mid-swap. NOTHING NEW IS EVER SIGNED during recovery (red line, spec 2026-09-07 §4). Settlement
 * is detected by the same ledger-watch machinery the merchant reconciliation uses (relay
 * /api/v1/transactions against the user's principal) — the pool's #ok is treated as "the pool
 * pulled the input", NOT as settlement, because the pool's out figure is GROSS and the wallet
 * actually receives it minus the output-ledger fee.
 */
import {DpayCore} from './services/native';
import {relayFetch} from './services/relay';
import {submitTransfer as railSubmitTransfer, railBalanceOf} from './services/rail';
import {randNonceHex} from './lib/format';
import {
  CONVERT_PROBE_WINDOW_ROWS,
  CONVERT_ENGINE_TEST_OPTS,
} from './config/convert';
import {
  venueDisplayName,
  venueEndpointOf,
  venueOfId,
} from './config/venues';
import {saveTxNote} from './services/txNotes';
import {fetchJupiterQuote, fetchJupiterSwapTx, type JupiterQuote} from './services/jupiter';
import {deriveSolanaKeypair} from './solana/identity';
import {deriveAta} from './solana/spl';
import {
  bytesToHex,
  decodeVenueSwapTx,
  hexToBytes,
  signVenueSwapTx,
  verifyVenueSwapTxBeneficiaries,
} from './solana/tx';
import {USDC_MINT_ADDRESS, WRAPPED_SOL_MINT_ADDRESS} from './solana/tokens';
import {type CctpMessageStatus} from './cctp';
import {
  getSolBlockHeight,
  getSolNativeCredit,
  getSolSignatureStatus,
  getSolTokenCredit,
  quoteSolMessageFee,
  submitRawSolTx,
} from './solana';
import {M} from './i18n';

import type {
  ConvertRecord,
  CrossRailInfo,
  LegState,
  SolanaSwapLeg,
} from './convert/types';
import {isTerminalConvertStep} from './convert/types';
export type {
  ConvertRecord,
  ConvertStep,
  CrossRailInfo,
  GasFundPlan,
  GasFundPreLeg,
  LegKind,
  LegPlan,
  LegState,
  ProviderDeposit,
  ProviderRef,
  ResolvedGasFundPlan,
  SignedLeg,
  SolanaSwapLeg,
} from './convert/types';
export {TERMINAL_CONVERT_STEPS, isTerminalConvertStep} from './convert/types';

export type {CeFiQuoteResult, ConvertMath, ConvertQuote, SwapQuoteBody} from './convert/quotes';
export {
  ceFiQuoteFromResult,
  ceFiServiceError,
  createCeFiOrder,
  deriveConvertMath,
  fetchCeFiConvertQuote,
  fetchCeFiQuoteResult,
  fetchConvertQuote,
  isQuoteStale,
  loadVenueRegistry,
} from './convert/quotes';

import {
  convertAborted,
  convertLegsExpired,
  convertRecordMinOut,
  isHubConvertRecord,
  saveConvertRecord,
} from './convert/records';
export type {SalvagedStore} from './convert/records';
export {
  convertAbortFlavor,
  convertAborted,
  convertLegsExpired,
  convertRecordMinOut,
  hydrateConvertStore,
  isHubConvertRecord,
  loadConvertRecords,
  requestConvertAbort,
  salvageConvertStore,
  saveConvertRecord,
} from './convert/records';
export {prepareConvertRecord, prepareCeFiConvertRecord} from './convert/prepare';
export {
  gasFundNeededWei,
  prepareHubConvertRecord,
  prepareMultihopConvertRecord,
  resolveGasFundPlan,
} from './convert/plan';
import {fetchCctpMessageStatus} from './convert/cctp';
export type {CctpHandoff} from './convert/cctp';
export {
  attachCctpBurnTx,
  buildCctpHandoff,
  declineCctpHandoff,
  fetchCctpBurnFee,
  fetchCctpMessageStatus,
} from './convert/cctp';

// --- execute: submit the persisted bytes, watch the output ledger (never trust #ok alone) ---------

export type ConvertExecutorDeps = {
  secretHex: string;
  publicHex: string; // also the identity-scoped STORE key scope (V6)
  relayUrl: string;
  onUpdate: (record: ConvertRecord) => void; // fired on every step change with the persisted record
  /** Row identities other records already claim as their payout — the engine supplies this so
   *  two records expecting the same amount can never both match one ledger row (V6). */
  claimedOutTx?: ReadonlySet<string>;
  /** Row identities other records already claim as THEIR refund — the refund-side twin of
   *  `claimedOutTx`: a refund row one record already consumed as its failed_refunded evidence
   *  never resolves a second record the same way. */
  claimedRefundTx?: ReadonlySet<string>;
};

export type SettleWatch = {kind: 'output'; amount: string; tx: string} | {kind: 'refund'; tx: string} | null;

type TransactionsRowLike = {from?: string; to?: string; amount?: string; currency?: number; timestamp?: number; nonce?: string; block?: number};

/** A ledger row's durable identity (dedupe + outTx/refundTx): the BLOCK INDEX when the row
 *  carries one (every IC-rail row does), else the timestamp, else the nonce — the same
 *  fallback ladder the history list uses. */
function rowIdentity(row: TransactionsRowLike): string {
  return String(row.block ?? row.timestamp ?? row.nonce ?? '');
}

/** A row amount as a positive BigInt, or null (missing / unparseable / non-positive) — a
 *  refund of zero-or-fewer units, or a figure this build cannot read, is nobody's refund. */
function positiveRowAmount(amount: string | undefined): bigint | null {
  if (amount == null) return null;
  let n: bigint;
  try {
    n = BigInt(amount);
  } catch {
    return null;
  }
  return n > 0n ? n : null;
}

/**
 * The ledger-watch settlement probe (mirror of the merchant reconciliation machinery): read the
 * relay's durable transaction log for the USER's account and look for the venue's transfer. The
 * counterparty principal is the RECORD's own venue endpoint (registry lookup, V1) — settlement
 * matching can never silently follow a module constant while a second venue ships.
 *
 * - `output` match: incoming row on the OUTPUT ledger, from the venue, at the user's principal,
 *   for the recorded expected range — the gross OR net figure exactly (the fake-IC pool credits
 *   the gross; a production pool may send gross-minus-fee), or any amount BETWEEN net and gross
 *   inclusive (V6: a payout anywhere inside the quote the user confirmed is the venue's payout
 *   arriving; the amount SEEN is recorded, never the expected one).
 * - `refund` match: incoming row on the INPUT ledger from the venue, for a POSITIVE amount
 *   ≤ amountIn + inFee (a refund returns the user's OWN input asset — the venue cannot refund
 *   more than it took) — the failed-swap refund path; the matched row's identity becomes the
 *   record's `refundTx` claim.
 * - DEDUPE (V6): a row whose identity another record already claims as ITS payout
 *   (`excludeOutTx`) or as ITS refund (`excludeRefundTx`) is skipped — one ledger row can
 *   settle exactly one conversion; the older claim wins.
 * - No match → null. Still unknown, never optimistic done.
 */
export async function probeConvertSettlement(args: {
  relayUrl: string;
  publicHex: string;
  myPrincipalLower: string;
  record: ConvertRecord;
  /** Row identities other records already claimed as their payout (engine-supplied). */
  excludeOutTx?: ReadonlySet<string>;
  /** Row identities other records already claimed as THEIR refund (engine-supplied) — the
   *  refund-side twin of `excludeOutTx`: one refund row settles exactly one record. */
  excludeRefundTx?: ReadonlySet<string>;
}): Promise<SettleWatch> {
  const {relayUrl, publicHex, myPrincipalLower, record} = args;
  // Solana-shaped records have no numeric catalog currency to key the ledger watch on (and
  // their settlement is the chain's own signature status, watched by the Solana driver). The
  // IC probes fail closed here rather than query a `currency=undefined` window.
  if (record.outCurrency == null || record.inCurrency == null) return null;
  const exclude = args.excludeOutTx ?? new Set<string>();
  const excludeRefund = args.excludeRefundTx ?? new Set<string>();
  try {
    const window = `limit=${CONVERT_PROBE_WINDOW_ROWS}`;
    const r = await relayFetch(
      relayUrl,
      `/api/v1/transactions/${publicHex}?currency=${record.outCurrency}&${window}`,
      undefined,
      6000,
    );
    const refundR = record.inCurrency === record.outCurrency ? null : await relayFetch(
      relayUrl,
      `/api/v1/transactions/${publicHex}?currency=${record.inCurrency}&${window}`,
      undefined,
      6000,
    );
    const parse = async (res: Response | null) => {
      if (res == null || !res.ok) return [] as TransactionsRowLike[];
      const body = await res.json().catch(() => null) as {transactions?: TransactionsRowLike[]} | null;
      return body?.transactions ?? [];
    };
    const pool = venueEndpointOf(record.venueId).toLowerCase();
    // A row OLDER than the record itself is some EARLIER conversion's payout/refund, never this
    // record's: the cross-record dedupe above is memory-bound (records do not survive a
    // restore/reinstall into a fresh record store), but the index's timestamps are absolute.
    // 2026-09-19 live finding: a same-pair same-amount conversion run after a restore claimed
    // the PREVIOUS run's payout row and flipped to done with nothing on-chain. 120s covers
    // block-time lag + client clock skew; a row the probe cannot date proves nothing.
    const floorSec = Math.floor(record.createdAtMs / 1000) - 120;
    const rowNewer = (row: TransactionsRowLike): boolean =>
      row.timestamp != null && Number(row.timestamp) > floorSec;
    // The recorded expected range, inclusive: [net, gross] in the order the record froze them.
    const lo = BigInt(record.expectedNet) < BigInt(record.expectedGross) ? BigInt(record.expectedNet) : BigInt(record.expectedGross);
    const hi = BigInt(record.expectedNet) < BigInt(record.expectedGross) ? BigInt(record.expectedGross) : BigInt(record.expectedNet);
    const matchesExpected = (amount: string): boolean => {
      const n = BigInt(amount);
      return n === lo || n === hi
        || (record.outAmountNet != null && n === BigInt(record.outAmountNet))
        || (n >= lo && n <= hi);
    };
    const outRows = await parse(r);
    for (const row of outRows) {
      const tx = rowIdentity(row);
      if (row.currency === record.outCurrency
        && row.to?.toLowerCase() === myPrincipalLower
        && row.from?.toLowerCase() === pool
        && row.amount != null && matchesExpected(row.amount)
        && rowNewer(row)
        && !exclude.has(tx)) {
        return {kind: 'output', amount: row.amount ?? '', tx};
      }
    }
    const inRows = await parse(refundR);
    // A refund gives the user back THEIR OWN input asset, so the row must carry a POSITIVE
    // amount no larger than what the venue could have taken (amountIn + the input fee the
    // approve covered): a bigger inbound from the venue is some other transfer, never this
    // record's refund, and must not flip a probing record to failed_refunded. DEDUPE: a row
    // another record already claimed as ITS refund (`excludeRefundTx`) is skipped — the mirror
    // of the output-row dedupe above (one ledger row settles exactly one conversion).
    const refundCeiling = BigInt(record.amountIn) + BigInt(record.inFee);
    for (const row of inRows) {
      const tx = rowIdentity(row);
      const amount = positiveRowAmount(row.amount);
      if (row.currency === record.inCurrency
        && row.to?.toLowerCase() === myPrincipalLower
        && row.from?.toLowerCase() === pool
        && amount != null && amount <= refundCeiling
        && rowNewer(row)
        && !excludeRefund.has(tx)) {
        return {kind: 'refund', tx};
      }
    }
  } catch (e) {
    console.warn('convert settlement probe failed:', e instanceof Error ? e.message : String(e));
  }
  return null;
}

/** The HOP-ledger payout probe (multi-hop twin of the settlement probe): the swap leg of a
 *  route pays the out asset to the user's principal FROM THE POOL — that row is the swap
 *  leg's CONFIRMATION (spec §4: never the #ok alone). Range = [minOut .. expectedGross] —
 *  the min you signed is the least you'll receive, so anything the pool actually paid lands
 *  inside; the SEEN amount is recorded, never the expected one. Returns null on no-match or
 *  any failure (an unreadable ledger proves nothing either way).
 *  The hub widening (2026-09-18, spec §11): `swapLeg` says WHICH swap's payout to watch —
 *  1 (the default) is the record's own hop watch, byte-identical behavior to before; 2 is
 *  the SECOND swap's DEST payout, on the hub record's own facts (dest currency, venue2's
 *  endpoint, the [minOut2 .. expectedGross2] window). A record missing any leg-2 fact
 *  proves nothing — null, never a guessed window. */
export async function probeHopPayout(args: {
  relayUrl: string;
  publicHex: string;
  myPrincipalLower: string;
  record: ConvertRecord;
  excludeOutTx?: ReadonlySet<string>;
  swapLeg?: 1 | 2;
}): Promise<{amount: string; tx: string} | null> {
  const {relayUrl, publicHex, myPrincipalLower, record} = args;
  const leg = args.swapLeg ?? 1;
  const outCurrency = leg === 2 ? record.destCurrency : record.outCurrency;
  const venueId = leg === 2 ? record.venue2Id : record.venueId;
  const maxGross = leg === 2 ? record.expectedGross2 : record.expectedGross;
  // Same fail-closed guard as probeConvertSettlement: no numeric currency, no IC ledger window.
  if (outCurrency == null || venueId == null || maxGross == null) return null;
  const exclude = args.excludeOutTx ?? new Set<string>();
  try {
    const minOut = await convertRecordMinOut(record, leg);
    const lo = BigInt(minOut);
    const hi = BigInt(maxGross);
    const r = await relayFetch(
      relayUrl,
      `/api/v1/transactions/${publicHex}?currency=${outCurrency}&limit=${CONVERT_PROBE_WINDOW_ROWS}`,
      undefined,
      6000,
    );
    if (!r.ok) return null;
    const body = await r.json().catch(() => null) as {transactions?: TransactionsRowLike[]} | null;
    const pool = venueEndpointOf(venueId).toLowerCase();
    // Same floor as probeConvertSettlement (2026-09-19 live finding): a row predating the
    // record is an EARLIER conversion's payout — the dedupe set is memory-bound, the index's
    // timestamps are absolute. An undatable row proves nothing.
    const floorSec = Math.floor(record.createdAtMs / 1000) - 120;
    for (const row of body?.transactions ?? []) {
      const tx = rowIdentity(row);
      const n = row.amount == null ? null : BigInt(row.amount);
      if (row.currency === outCurrency
        && row.to?.toLowerCase() === myPrincipalLower
        && row.from?.toLowerCase() === pool
        && n != null && (n === lo || n === hi || (n >= lo && n <= hi))
        && row.timestamp != null && Number(row.timestamp) > floorSec
        && !exclude.has(tx)) {
        return {amount: row.amount ?? '', tx};
      }
    }
  } catch (e) {
    console.warn('hop payout probe failed:', e instanceof Error ? e.message : String(e));
  }
  return null;
}

/** The submit closure's contract, shared by both executors (module-level so the planned
 *  executor can be driven under the direct executor's own machinery in tests). */
type SubmitEnvelopeFn = (
  ledger: string, envelopeHex: string, requestIdHex: string,
  decodeReply?: (replyArgHex: string) => Promise<{ok: boolean; errVariant?: string; errDetail?: string}>,
) => Promise<'settled' | {rejected: {variant?: string; detail?: string}} | 'unknown'>;

/** A record copy with legPlan[i]'s state replaced (the plan array is treated immutably —
 *  every other leg's state rides along untouched). */
function withLegState(rec: ConvertRecord, i: number, state: LegState, patch: Partial<ConvertRecord> = {}): ConvertRecord {
  const legPlan = (rec.legPlan ?? []).map((l, idx) => (idx === i ? {...l, state} : l));
  return {...rec, legPlan, ...patch};
}

/** Drive ONE planned (multi-hop) record leg-by-leg to a terminal or honest parking state
 *  (2026-09-14 spec §4). Resumable: the first leg whose plan state is not `confirmed` is
 *  where a resumed run picks up — confirmed legs are NEVER re-signed and never re-submitted;
 *  `sent` and `pending` both resume by re-submitting the identical envelope bytes (request_id
 *  dedup makes that safe on the boundary node and the fake gateway alike).
 *
 *  - swap leg: `#ok` parks the record on `pending_withdrawal` — the leg confirms only when
 *    its payout ROW is seen (probeHopPayout); a resume parked there resolves the row
 *    before touching any later leg. On a HUB record (2026-09-18, spec §11) the watch follows
 *    the first non-confirmed swap: swap1's row confirms the hub leg; swap2's DEST row is the
 *    terminal evidence — done, the SEEN dest amount (the dest asset IS in the wallet, unlike
 *    Route A's "on its way"), with the payout row as destTx.
 *  - withdraw_erc20 leg: the minter's `#ok` block index is the terminal evidence → done,
 *    with the burn amount as outAmountNet ("at least X on its way" — delivery is on Ethereum,
 *    asynchronously; dpay cannot watch it and the copy says so).
 *  - refusals: legs 1–2 refuse exactly like the direct flow (input never left / pool refused
 *    atomically); legs 3–5 refuse into `failed_leg` — the hop asset is in-wallet and the
 *    standalone Withdraw flow is the exit, which the failure screen names. On a hub record,
 *    approve2/swap2 refuse into `failed_leg` the same way (the HUB asset is in-wallet; a
 *    swap2 refusal is never failed_refunded — the input already converted).
 *  - expiry (arm b): a hub record probes the DEST payout first (seen → done, the swap
 *    executed even if its envelope expired), then the HUB payout (seen → failed_leg), else
 *    stuck; every other planned shape probes the hop only.
 *  - unknown outcomes park on `stuck` (the honest unknown; the resume engine's slow watch
 *    resolves a hop row into `failed_leg`, never done — spec §8). */
async function executePlannedConvert(
  start: ConvertRecord,
  deps: ConvertExecutorDeps,
  opts: {submitAttempts: number; poll: {attempts: number; intervalMs: number}; settleAttempts: number; settleIntervalMs: number; nowMs: number},
  tools: {submitEnvelope: SubmitEnvelopeFn; advance: (rec: ConvertRecord) => Promise<ConvertRecord>},
): Promise<ConvertRecord> {
  let rec: ConvertRecord = {...start};
  if (isTerminalConvertStep(rec.step)) return rec;
  const myPrincipalLower = (await DpayCore.icpPrincipalFromPubkey(deps.publicHex)).toLowerCase();
  const probeHop = (r: ConvertRecord, swapLeg: 1 | 2 = 1) => probeHopPayout({
    relayUrl: deps.relayUrl, publicHex: deps.publicHex, myPrincipalLower, record: r, excludeOutTx: deps.claimedOutTx, swapLeg,
  });
  // The resume cursor counts IC legs ONLY — the cctp_burn/sol_swap tail entries are driven
  // by the cross-rail drivers, never by this loop, so a cross-rail record whose IC legs are
  // all confirmed reads as complete here (the loop body never indexes past `legs`).
  const firstIncomplete = () => (rec.legPlan ?? []).findIndex(l => l.state !== 'confirmed' && l.kind !== 'cctp_burn' && l.kind !== 'sol_swap');
  // A swap leg's ordinal among the plan's swap entries (0-based): 0 = the record's own hop
  // swap (the record's out*/hop* facts), 1 = a HUB record's SECOND swap (the dest* facts).
  // The gas-fund widening (2026-09-20): the PRE-LEGS (gasPre.legs as approve+swap pairs)
  // sit AHEAD of the route's legs, so ordinals count only POST-pre entries — the main swap
  // stays ordinal 0 no matter how many funding legs precede it. A pre-swap itself reads as
  // -1: it is never the record's hop/dest swap (its payout has no out*/hop* facts to probe).
  const preLegCount = rec.gasPre != null ? rec.gasPre.legs.length * 2 : 0;
  const isPreLeg = (idx: number): boolean => idx < preLegCount;
  const swapOrdinalOf = (idx: number): number =>
    idx < preLegCount
      ? -1
      : (rec.legPlan ?? []).slice(preLegCount, idx).filter(l => l.kind === 'swap').length;

  // Parked mid-route on the hop watch: resolve the row FIRST — it is the swap leg's
  // confirmation and the gate every later leg waits behind. The hub widening (2026-09-18):
  // the watch targets the FIRST NON-CONFIRMED swap — on a hub record that can be swap2, and
  // its payout row IS the terminal evidence: the dest asset is in the wallet, done, with the
  // SEEN amount (never the expected) and the payout row as the durable proof (destTx).
  if (rec.step === 'pending_withdrawal') {
    const plan = rec.legPlan ?? [];
    const pendingSwap = plan.findIndex(l => l.kind === 'swap' && l.state !== 'confirmed');
    const swapIdx = pendingSwap >= 0 ? pendingSwap : plan.findIndex(l => l.kind === 'swap');
    const leg: 1 | 2 = swapOrdinalOf(swapIdx) >= 1 ? 2 : 1;
    const seen = await probeHop(rec, leg);
    if (seen == null) {
      if (convertLegsExpired(rec, opts.nowMs)) {
        return tools.advance({...rec, step: 'stuck', failureCode: 'unknown'});
      }
      return tools.advance({...rec, step: 'pending_withdrawal'}); // still watching — re-arm and come back
    }
    if (leg === 2) {
      rec = await tools.advance(withLegState(rec, swapIdx, 'confirmed', {
        step: 'done', outAmountNet: seen.amount, outTx: seen.tx, destTx: seen.tx,
      }));
    } else {
      rec = await tools.advance(withLegState(rec, swapIdx, 'confirmed', {hopTx: seen.tx}));
    }
  }

  // V6 trichotomy arm (b), planned form: an unconfirmed leg whose signed bytes have ALL died
  // is never resubmitted. The one thing that can still resolve is a payout row: SEEN means
  // the swap ran and the remaining legs are dead → failed_leg; UNSEEN means nothing is known
  // → the honest unknown, stuck. The hub record's trichotomy (2026-09-18) probes the DEST
  // payout FIRST — the final swap may have executed even though its envelope expired, and a
  // seen dest row means the dest asset IS in the wallet (done, the SEEN amount). Only then
  // the hub payout: swap1 ran, swap2's bytes are dead — the user holds the hub asset
  // (failed_leg), never done on a mid-route row.
  if (firstIncomplete() >= 0 && convertLegsExpired(rec, opts.nowMs)) {
    if (isHubConvertRecord(rec)) {
      const dest = await probeHop(rec, 2);
      if (dest != null) {
        return tools.advance({...rec, step: 'done', outAmountNet: dest.amount, outTx: dest.tx, destTx: dest.tx});
      }
      const hub = await probeHop(rec, 1);
      return tools.advance(hub != null
        ? {...rec, step: 'failed_leg', failureCode: 'unknown', hopTx: hub.tx}
        : {...rec, step: 'stuck', failureCode: 'unknown'});
    }
    const seen = await probeHop(rec);
    return tools.advance(seen != null
      ? {...rec, step: 'failed_leg', failureCode: 'unknown', hopTx: seen.tx}
      : {...rec, step: 'stuck', failureCode: 'unknown'});
  }

  for (let i = firstIncomplete(); i >= 0; i = firstIncomplete()) {
    const leg = rec.legs[i];
    const plan = rec.legPlan?.[i];
    if (leg == null || plan == null) return rec; // hydration guarantees parallelism; refuse to improvise
    if (convertAborted(rec.id)) return tools.advance(rec); // the user's Stop: freeze, never sign or submit another leg
    // The POST-PRE-LEG RE-CHECK (2026-09-20): before the approve_gas envelope may leave,
    // the ACTUAL in-wallet gas-ledger balance must cover the frozen neededWei. This read is
    // also the funding pre-legs' settlement evidence — a pre-swap #ok only means the pool
    // accepted at its own floor; the BALANCE is what the burn legs will actually spend.
    // Short → the terminal failed card names the shortfall and NOTHING further is
    // submitted: every unit of value sits in-wallet (the funded ckETH included), the hop
    // swap never ran. An UNREADABLE balance is not a pass — the leg stays unsubmitted and
    // the record stays live; the engine's next re-arm re-runs this gate.
    if (plan.kind === 'approve_gas' && rec.gasPre != null) {
      const balRaw = await railBalanceOf(deps.secretHex, leg.canister);
      if (balRaw == null || !/^\d+$/.test(balRaw)) {
        console.warn('gas-fund re-check: gas-ledger balance unreadable — holding the burn legs');
        return rec;
      }
      const needed = BigInt(rec.gasPre.neededWei);
      if (BigInt(balRaw) < needed) {
        return tools.advance({...rec, step: 'failed_leg', failureCode: 'gas_short',
          failureDetail: `gas-fund short: have ${balRaw} need ${rec.gasPre.neededWei}`});
      }
    }
    rec = await tools.advance(withLegState(rec, i, 'sent'));
    // Device-saved annotation for the swap-side legs only — the burn-side legs are the
    // Withdraw flow's own calls and carry no venue row to name (parity with WithdrawSheet).
    // On a hub record legs 3–4 are venue2's business (their ordinal ≥ 1); a Route A record
    // has no venue2Id, so the ?? falls back to the same venue it always named. A gas-fund
    // pre-leg names its OWN venue (pair k = floor(i/2) in the pre-leg list).
    if (plan.kind === 'approve' || plan.kind === 'swap') {
      const venue = isPreLeg(i)
        ? rec.gasPre!.legs[Math.floor(i / 2)]!.venueId
        : swapOrdinalOf(i) >= 1 ? (rec.venue2Id ?? rec.venueId) : rec.venueId;
      void saveTxNote(deps.publicHex, {k: leg.requestIdHex, who: venueDisplayName(venue)}, opts.nowMs);
    }
    let legBlockIndex: string | null = null;
    const decodeReply: ((replyArgHex: string) => Promise<{ok: boolean; errVariant?: string; errDetail?: string}>) | undefined =
      plan.kind === 'swap'
        ? (h: string) => DpayCore.icpDecodeSwapResult(h)
        : plan.kind === 'approve'
          // ApproveError carries variants the transfer decoder cannot read (AllowanceChanged,
          // Expired) — a transfer-shaped decode of an approve refusal THREW on those labels,
          // which is how a refused approve used to die as an endless Approving spinner.
          ? (h: string) => DpayCore.icpDecodeApproveResult(h)
          : plan.kind === 'withdraw_erc20'
            ? async (h: string) => {
                const out = await DpayCore.icpDecodeMinterOk(h);
                if (out.ok && out.blockIndex != null) legBlockIndex = out.blockIndex;
                return out;
              }
            : undefined;
    const outcome = await tools.submitEnvelope(leg.canister, leg.envelopeHex, leg.requestIdHex, decodeReply);
    if (outcome === 'unknown') {
      // Bytes submitted, outcome unknowable: park stuck. The plan keeps the leg at `sent`
      // (it WAS sent); the engine's slow watch can still resolve the hop row later.
      return tools.advance({...rec, step: 'stuck', failureCode: 'unknown'});
    }
    if (outcome !== 'settled') {
      const detail = outcome.rejected.detail || outcome.rejected.variant || '';
      if (isPreLeg(i)) {
        // A GAS-FUND leg refused: the funding did not deliver, the main conversion has NOT
        // started, and the source asset never left the wallet. The honest dead-end is the
        // gas_short failed card naming the refusal — never a phantom refund of a main flow
        // that never ran, and never a push into the gas-less dead end.
        return tools.advance(withLegState(rec, i, 'failed', {step: 'failed_leg', failureCode: 'gas_short', failureDetail: detail}));
      }
      if (plan.kind === 'approve' && leg.canister === rec.inLedger) {
        // The FIRST leg refused: nothing moved, no allowance exists — the direct flow's own
        // dead-end, verbatim.
        return tools.advance(withLegState(rec, i, 'failed', {step: 'failed_refunded', failureCode: 'approve_refused', failureDetail: outcome.rejected.detail}));
      }
      if (plan.kind === 'swap') {
        if (swapOrdinalOf(i) >= 1) {
          // The SECOND swap refused (hub taxonomy, 2026-09-18): the input ALREADY converted —
          // swap1 confirmed and the user holds the HUB asset in-wallet. This is never
          // failed_refunded (there is no input to refund); failed_leg names the position,
          // and the hub asset is the in-wallet exit the copy names.
          return tools.advance(withLegState(rec, i, 'failed', {step: 'failed_leg', failureCode: 'swap_refused', failureDetail: detail}));
        }
        // The pool's atomic refusal: input stays in the wallet, allowance dies at expiry.
        return tools.advance(withLegState(rec, i, 'failed', {step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: detail}));
      }
      // A burn-side leg refused (spec §4 taxonomy): the swap already confirmed, so the user
      // holds the HOP asset in-wallet — failed_leg, and the standalone Withdraw flow is the
      // named exit. (An approve_gas refusal after the hop approve settled is benign: the
      // hop allowance simply dies unused at its expiry.)
      return tools.advance(withLegState(rec, i, 'failed', {step: 'failed_leg', failureCode: 'withdraw_refused', failureDetail: detail}));
    }
    if (plan.kind === 'swap') {
      if (isPreLeg(i)) {
        // The funding swap's #ok: the pool accepted the trade atomically AT its own signed
        // floor — the ckETH is in the wallet or the leg would have refused. The row-watch's
        // settlement question is answered STRONGER by the balance re-check gate before
        // approve_gas (an actual spendable read), so no hop-watch runs here and no
        // pending_withdrawal can park on a funding leg.
        rec = await tools.advance(withLegState(rec, i, 'confirmed'));
        continue;
      }
      // #ok: input spent, output owed — NOT confirmed. Watch the payout ledger before any
      // later leg may run; exhaustion parks on pending_withdrawal (the pool DID accept).
      // The hub widening: WHICH ledger follows the swap's ordinal — leg 1 watches the hub
      // (the record's out* facts), leg 2 watches the DEST, and a seen dest row IS the
      // terminal evidence (dest asset in-wallet: done, the SEEN amount, destTx).
      const leg: 1 | 2 = swapOrdinalOf(i) >= 1 ? 2 : 1;
      let seen: {amount: string; tx: string} | null = null;
      for (let k = 0; k < opts.settleAttempts && seen == null; k += 1) {
        seen = await probeHop(rec, leg);
        if (seen == null && k < opts.settleAttempts - 1 && opts.settleIntervalMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, opts.settleIntervalMs));
        }
      }
      if (seen == null) return tools.advance({...rec, step: 'pending_withdrawal'});
      if (leg === 2) {
        return tools.advance(withLegState(rec, i, 'confirmed', {
          step: 'done', outAmountNet: seen.amount, outTx: seen.tx, destTx: seen.tx,
        }));
      }
      rec = await tools.advance(withLegState(rec, i, 'confirmed', {hopTx: seen.tx}));
      continue;
    }
    if (plan.kind === 'withdraw_erc20') {
      if (rec.crossRail != null) {
        // The CROSS-RAIL fork (2026-09-16, Routes B/C): the minter accepted the burn, so
        // USDC is on its way to the user's EVM address — but the intent does NOT end here.
        // The record parks on `awaiting_external`: the CCTP burn transaction must be signed
        // BY THE USER'S OWN EVM WALLET (dpay never holds EVM keys — the module header's
        // red line). outAmountNet stays unset until the Solana mint is verified; outTx
        // records the minter's #ok block index as the IC-side evidence.
        return tools.advance(withLegState(rec, i, 'confirmed', {
          step: 'awaiting_external',
          outTx: legBlockIndex ?? undefined,
        }));
      }
      // Terminal: the minter accepted the burn. outAmountNet is the BURN amount (the route's
      // floor — "at least X on its way"); outTx is the minter's #ok block index, the durable
      // evidence this record will ever have (delivery itself happens on Ethereum).
      const burnAmount = await convertRecordMinOut(rec);
      return tools.advance(withLegState(rec, i, 'confirmed', {
        step: 'done',
        outAmountNet: burnAmount,
        outTx: legBlockIndex ?? undefined,
      }));
    }
    rec = await tools.advance(withLegState(rec, i, 'confirmed'));
  }
  return rec;
}

/** Drive a persisted record to a terminal state (or a honest non-terminal one). Resumable: call
 *  again with the same record (e.g. after a restart, or while pending_withdrawal) — every submit
 *  re-uses the record's OWN envelope bytes, so a resumed run can never double-spend (request_id
 *  dedup on the boundary node + the fake-IC gateway).
 *
 * V6 trichotomy at entry: an unconfirmed leg whose signed bytes have EXPIRED is never resubmitted
 * (the outcome is unknown — it may already have executed); instead both ledgers are probed for
 * what may have landed, and only an unresolved watch parks the record on `stuck` (the honest
 * unknown, slow-watched by the resume engine until it resolves or the user acknowledges it). */
export async function executeConvert(
  start: ConvertRecord,
  deps: ConvertExecutorDeps,
  opts: {submitAttempts?: number; poll?: {attempts: number; intervalMs: number}; settleAttempts?: number; settleIntervalMs?: number; nowMs?: number} = {},
): Promise<ConvertRecord> {
  const submitAttempts = opts.submitAttempts ?? 2;
  // The settle-watch defaults are e2e-shrinkable wholesale via __DPAY_TEST_CONVERT_ENGINE
  // (config/convert.ts): the honest-pending invariant — the watch must EXHAUST before a record
  // parks, never `done` from a pool #ok — is cadence-independent, so the suite proves it at
  // ~1 s instead of the ~17 s the prod defaults take.
  const poll = opts.poll ?? CONVERT_ENGINE_TEST_OPTS?.executorOpts?.poll ?? {attempts: 12, intervalMs: 400};
  const settleAttempts = opts.settleAttempts ?? CONVERT_ENGINE_TEST_OPTS?.executorOpts?.settleAttempts ?? 14;
  const settleIntervalMs = opts.settleIntervalMs ?? CONVERT_ENGINE_TEST_OPTS?.executorOpts?.settleIntervalMs ?? 1200;
  const nowMs = opts.nowMs ?? Date.now();

  // Local twin of rail.submitTransfer's submit+poll, with the identical-bytes retry discipline and
  // a decodeReply hook (module-level import indirection keeps this jest-mockable).
  const submitEnvelope = async (
    ledger: string, envelopeHex: string, requestIdHex: string,
    decodeReply?: (replyArgHex: string) => Promise<{ok: boolean; errVariant?: string; errDetail?: string}>,
  ): Promise<'settled' | {rejected: {variant?: string; detail?: string}} | 'unknown'> => {
    for (let attempt = 0; attempt < submitAttempts; attempt += 1) {
      const outcome = await railSubmitTransfer({ledger, envelopeHex, requestIdHex}, deps.secretHex, poll, decodeReply);
      if (outcome.kind === 'settled') return 'settled';
      if (outcome.kind === 'rejected') return {rejected: {variant: outcome.variant, detail: outcome.reason}};
      // 'unknown': resubmit the SAME bytes (request_id dedup makes this safe), then re-poll.
    }
    return 'unknown';
  };

  const advance = async (rec: ConvertRecord): Promise<ConvertRecord> => {
    // The abort chokepoint (2026-09-19): once the user taps Stop, every later transition
    // collapses to 'aborted' — no branch has to know the flag exists.
    if (rec.step !== 'aborted' && (rec.abortedAtMs != null || convertAborted(rec.id))) {
      rec = {...rec, step: 'aborted', abortedFromStep: rec.step, abortedAtMs: rec.abortedAtMs ?? nowMs};
    }
    deps.onUpdate(rec);
    await saveConvertRecord(deps.publicHex, rec);
    return rec;
  };

  /** The shared ledger watch: probe both ledgers at the user's principal until something lands
   *  or the attempt budget dies. `onExhausted` decides the honest parking state — settling runs
   *  exhaust into pending_withdrawal (the pool DID accept), the expired-unconfirmed watch runs
   *  exhaust into stuck (nothing is known to have accepted). */
  const watchLedgers = async (
    rec: ConvertRecord, attempts: number, intervalMs: number,
    onExhausted: 'pending_withdrawal' | 'stuck',
  ): Promise<ConvertRecord> => {
    const myPrincipal = (await DpayCore.icpPrincipalFromPubkey(deps.publicHex)).toLowerCase();
    for (let i = 0; i < attempts; i += 1) {
      if (convertAborted(rec.id)) return advance(rec);
      const seen = await probeConvertSettlement({
        relayUrl: deps.relayUrl, publicHex: deps.publicHex, myPrincipalLower: myPrincipal, record: rec,
        excludeOutTx: deps.claimedOutTx,
        excludeRefundTx: deps.claimedRefundTx,
      });
      if (seen?.kind === 'output') {
        return advance({...rec, step: 'done', outAmountNet: seen.amount, outTx: seen.tx});
      }
      if (seen?.kind === 'refund') {
        // The matched row's identity is CLAIMED on the record (`refundTx`) so a sibling
        // record's probe can never consume the same refund row (cross-record refund dedupe).
        return advance({...rec, step: 'failed_refunded', failureCode: 'refunded', refundTx: seen.tx});
      }
      if (i < attempts - 1 && intervalMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    return onExhausted === 'stuck'
      ? advance({...rec, step: 'stuck', failureCode: 'unknown'})
      : advance({...rec, step: 'pending_withdrawal'});
  };

  let rec: ConvertRecord = {...start};

  // The multi-hop branch (2026-09-14 spec §4): a PLANNED record (legPlan present) is driven
  // by its own leg-by-leg executor under this run's own submit/advance machinery — the same
  // identical-bytes discipline, the same #ok-is-not-settlement rule, per-leg instead of
  // per-step. Direct records fall through to the step machine below, untouched.
  if (rec.legPlan != null) {
    return executePlannedConvert(rec, deps, {submitAttempts, poll, settleAttempts, settleIntervalMs, nowMs}, {submitEnvelope, advance});
  }

  // --- V6 trichotomy arm (b): unconfirmed + EXPIRED → NEVER resubmit; watch what may have run --
  // The record sits before its swap's confirmation (approving/approved/swapping) and every leg's
  // authority has died. The signed update may STILL have executed — an ingress past its expiry
  // answers nothing either way. Probe for the outcome; park on stuck only if nothing lands.
  if ((rec.step === 'approving' || rec.step === 'approved' || rec.step === 'swapping')
    && convertLegsExpired(rec, nowMs)) {
    return watchLedgers(rec, settleAttempts, settleIntervalMs, 'stuck');
  }

  // --- approving: the icrc2_approve leg (nothing can move yet — worst case the ledger refuses) --
  if (rec.step === 'approving') {
    // Device-saved annotation (services/txNotes): the conversion legs settle as venue rows whose
    // name was known only here — record it against the leg's request id hex (the per-leg nonce;
    // the row-memo join where the venue ledger echoes one). Best-effort by contract.
    void saveTxNote(deps.publicHex, {k: rec.legs[0].requestIdHex, who: venueDisplayName(rec.venueId)}, nowMs);
    const outcome = await submitEnvelope(rec.legs[0].canister, rec.legs[0].envelopeHex, rec.legs[0].requestIdHex,
      (replyArgHex: string) => DpayCore.icpDecodeApproveResult(replyArgHex));
    if (outcome === 'settled') {
      rec = await advance({...rec, step: 'approved'});
    } else if (outcome === 'unknown') {
      // (a) exhausted its retry budget while the bytes were still valid — the honest unknown.
      return advance({...rec, step: 'stuck', failureCode: 'unknown'});
    } else {
      // Definitive refusal BEFORE anything moved: the user still holds every unit of the input
      // asset; no allowance exists; nothing needs reversing (the failure screen says exactly that).
      return advance({...rec, step: 'failed_refunded', failureCode: 'approve_refused', failureDetail: outcome.rejected.detail});
    }
  }

  // --- approved → swapping: the pool's depositFromAndSwap (this is the call that moves funds) ---
  if (rec.step === 'approved') {
    rec = await advance({...rec, step: 'swapping'});
  }
  if (rec.step === 'swapping') {
    // Same-run expiry check: the legs were live at entry, but the approve round may have consumed
    // the remaining window. Expired bytes are never submitted — same trichotomy, arm (b).
    if (convertLegsExpired(rec, nowMs)) {
      return watchLedgers(rec, settleAttempts, settleIntervalMs, 'stuck');
    }
    // The pool's Result is decoded by the compiled core (dpay_icp::icrc::decode_swap_result), the
    // same bytes-to-outcome the relay and the fake gateway use — never a TS re-read of the wire.
    // Called through a wrapper, not a detached method reference: `DpayCore` is a NativeModules
    // object, and a bare reference would only break on a device (the same shape rail.ts uses).
    const swapLeg = rec.legs[1];
    // Same annotation as the approve leg above, against the swapping leg's own request id.
    void saveTxNote(deps.publicHex, {k: swapLeg.requestIdHex, who: venueDisplayName(rec.venueId)}, nowMs);
    const outcome = await submitEnvelope(
      swapLeg.canister, swapLeg.envelopeHex, swapLeg.requestIdHex,
      (replyArgHex: string) => DpayCore.icpDecodeSwapResult(replyArgHex),
    );
    if (outcome === 'unknown') {
      return advance({...rec, step: 'stuck', failureCode: 'unknown'});
    }
    if (outcome !== 'settled') {
      // The pool's own #err (e.g. "amountOutMinimum not met", InsufficientFunds): an ATOMIC refusal
      // — the pool pulled nothing. Input stays in the wallet; the allowance dies at its expiry.
      return advance({...rec, step: 'failed_refunded', failureCode: 'swap_refused',
        failureDetail: outcome.rejected.detail || outcome.rejected.variant || ''});
    }
    // Pool replied #ok: the INPUT is spent and the OUTPUT is owed — NOT settled (gross ≠ received).
    rec = await advance({...rec, step: 'settling'});
  }

  // --- settling → terminal: watch BOTH ledgers at the user's principal --------------------------
  if (rec.step === 'settling' || rec.step === 'pending_withdrawal') {
    const wasPending = rec.step === 'pending_withdrawal';
    if (wasPending) {
      rec = await advance({...rec, step: 'settling'}); // resume re-enters the watch; same-step runs stay silent
    }
    return watchLedgers(rec, settleAttempts, settleIntervalMs, 'pending_withdrawal');
  }

  return rec;
}

// --- the Solana driver (solana_amm venues — Jupiter, 2026-09-15) -----------------------------------
//
// The ONE record shape with a per-leg protocol discriminator (design decision, 2026-09-15): a
// Solana record is a ConvertRecord with `solanaLeg` set and `legs: []` — no canister/method/
// argHex theater over a tx that has none. Submission goes through the SAME RPC path SOL
// payments use (`app/solana.ts` seams over solanaRpcUrls(), which includes the relay's pure
// RPC proxy — never a bespoke convert submit), and the only authority on outcome is the
// chain's own signature status, read history-aware so a late confirmation is still found.

export type SolanaConvertPrepareArgs = {
  secretHex: string;
  /** The active relay — the swap-tx build dials it (services/jupiter, 2026-09-16). */
  relayUrl: string;
  quote: JupiterQuote; // the verbatim read piped through the relay (services/jupiter)
  inAsset: {symbol: string; mint: string; decimals: number}; // mint: WRAPPED form for native SOL
  outAsset: {symbol: string; mint: string; decimals: number};
};

/** Build + verify + sign the Solana swap and park the record at `swapping` (money has NOT
 *  moved — the only irreversible act so far was quoting). Red lines enforced BEFORE the
 *  signature: the venue row exists and is a mainnet solana_amm; the quote names the pair the
 *  registry says the venue trades; Jupiter's tx is decodable, requires EXACTLY the user's
 *  signature, pays fees from the USER's key, and — for an SPL output — routes the proceeds to
 *  the user's OWN ATA for that mint. Any violation fails closed with the IC prepare's own
 *  error vocabulary; nothing is signed, no record is written. */
export async function prepareSolanaConvertRecord(args: SolanaConvertPrepareArgs): Promise<ConvertRecord> {
  const {secretHex, relayUrl, quote, inAsset, outAsset} = args;
  // Red line 1: the venue row, from the registry — a stored/roaming venueId that names no row
  // (or a non-Solana row) never reaches https.
  const venue = venueOfId(quote.venueId);
  if (venue == null || venue.kind !== 'solana_amm' || venue.testnet) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  // Red line 2: the quote's mints are the pair the REGISTRY says this venue trades (the
  // 'pool' check's mint analog — the venue may only execute what it is registered for).
  const pair = venue.pair_ledgers;
  if (
    quote.inputMint !== inAsset.mint || quote.outputMint !== outAsset.mint
    || !pair.includes(inAsset.mint) || !pair.includes(outAsset.mint)
    || inAsset.mint === outAsset.mint
  ) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  // Who the user is on this rail: the SOL key derived from the same device secret (SLIP-10).
  const kp = deriveSolanaKeypair(secretHex);
  const built = await fetchJupiterSwapTx(relayUrl, quote, kp.address);
  if (!built.ok) {
    if (built.code === 'refused') throw new Error(M.convert.errors.quoteRefused(venue.display_name));
    throw new Error(M.convert.errors.quoteUnavailable(built.code));
  }
  const decoded = decodeVenueSwapTx(built.swap.swapTransaction);
  if (decoded == null) {
    throw new Error(M.convert.errors.quoteUnavailable('shape'));
  }
  // Red line 3 (the beneficiary check — INV-2's Solana analog): the user is the fee payer and
  // the output's destination is the user's OWN ATA (native-SOL output needs no ATA: unwrap
  // lands on the fee payer). Verified against the bytes in hand, before the signature.
  const outIsNativeSol = outAsset.mint === WRAPPED_SOL_MINT_ADDRESS;
  const outAta = outIsNativeSol ? null : deriveAta(kp.address, outAsset.mint);
  const beneficiary = verifyVenueSwapTxBeneficiaries(
    decoded,
    {pubkey: kp.publicKey, outAta},
  );
  if (!beneficiary.ok) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  // The honest fee line, frozen now: the chain's own quote for THIS tx's message. Null (RPC
  // could not compute it) stays absent — no invented figure ever renders.
  let solFeeLamports: string | undefined;
  try {
    const fee = await quoteSolMessageFee(decoded.message);
    if (fee != null) solFeeLamports = fee.toString(10);
  } catch {
    // offline/unreadable fee is not a refusal — the swap can still run; the line just stays absent
  }
  // The signature — the ONLY irreversible-bytes act, over the venue's own message, by the user.
  const signed = signVenueSwapTx(built.swap.swapTransaction, kp.seed);
  if (signed == null || signed.feePayer !== kp.address) {
    throw new Error(M.convert.errors.quoteUnavailable('shape'));
  }
  return {
    id: randNonceHex(),
    createdAtMs: Date.now(),
    step: 'swapping',
    venueId: venue.venue_id,
    // No numeric catalog currency on this shape — mints + symbols are the identifiers.
    inLedger: inAsset.mint,
    outLedger: outAsset.mint,
    inSymbol: inAsset.symbol,
    outSymbol: outAsset.symbol,
    inDecimals: inAsset.decimals,
    outDecimals: outAsset.decimals,
    amountIn: quote.inAmount,
    expectedGross: quote.outAmount, // the venue's estimate, verbatim
    expectedNet: quote.otherAmountThreshold, // the venue's OWN min-out floor for the chosen slippage
    inFee: '0',
    outFee: '0',
    slippageBps: quote.slippageBps,
    legs: [],
    solanaLeg: {
      protocol: 'solana',
      signedTxHex: bytesToHex(signed.raw),
      signature: signed.signature,
      lastValidBlockHeight: built.swap.lastValidBlockHeight,
    },
    ...(solFeeLamports != null ? {solFeeLamports} : {}),
  };
}

export type SolanaExecutorDeps = {
  publicHex: string; // the IC identity (store scope + annotations), same as the IC driver
  /** The user's SOL address — the owner filter for realized token-credit reads. */
  solAddress: string;
  onUpdate: (record: ConvertRecord) => void | Promise<void>;
};

export type SolanaExecutorOpts = {
  /** Submit rounds for the identical bytes (Solana dedups by signature — a repeat is a no-op). */
  submitAttempts?: number;
  /** Confirmation polls before parking `stuck` (the engine's slow watch then takes over). */
  confirmAttempts?: number;
  pollIntervalMs?: number;
  nowMs?: () => number;
};

type SolWatchOutcome =
  | {kind: 'confirmed'}
  | {kind: 'failed'; detail: string}
  | {kind: 'dead'} // blockhash expired with the tx unseen — it can NEVER land
  | {kind: 'unknown'};

/** The chain is the only oracle: poll the signature status (history-aware) and the block
 *  height until one of the four truths holds. Never re-signs; never re-builds. */
async function watchSolTx(
  leg: SolanaSwapLeg,
  attempts: number,
  intervalMs: number,
): Promise<SolWatchOutcome> {
  for (let i = 0; i < attempts; i++) {
    let status = null;
    try {
      status = await getSolSignatureStatus(leg.signature);
    } catch {
      status = null; // an unreadable status proves nothing either way
    }
    if (status != null && status.err != null) {
      return {kind: 'failed', detail: JSON.stringify(status.err).slice(0, 120)};
    }
    if (status != null && status.confirmationStatus != null) {
      return {kind: 'confirmed'};
    }
    let height: number | null = null;
    try {
      height = await getSolBlockHeight();
    } catch {
      height = null;
    }
    if (height != null && height > leg.lastValidBlockHeight) {
      return {kind: 'dead'};
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  return {kind: 'unknown'};
}

/** The realized payout for the done line — never the estimate dressed as fact. Token output:
 *  the user's own post−pre token delta; native-SOL output: the fee payer's post−pre lamports
 *  (payout minus the network fee). Null ⇒ the caller falls back to the venue's own floor. */
async function realizedSolPayout(rec: ConvertRecord, solAddress: string): Promise<string | null> {
  if (rec.outLedger === WRAPPED_SOL_MINT_ADDRESS) {
    return getSolNativeCredit(rec.solanaLeg?.signature ?? '');
  }
  return getSolTokenCredit(rec.solanaLeg?.signature ?? '', solAddress, rec.outLedger);
}

/** Drive a Solana-shaped record one state forward (or to its honest park). The engine calls
 *  this for every non-terminal Solana record and for unacknowledged `stuck` ones — the same
 *  cadence contract the IC executor has. */
export async function executeSolanaConvert(
  start: ConvertRecord,
  deps: SolanaExecutorDeps,
  opts: SolanaExecutorOpts = {},
): Promise<ConvertRecord> {
  const submitAttempts = opts.submitAttempts ?? 2;
  const confirmAttempts = opts.confirmAttempts ?? 12;
  const intervalMs = opts.pollIntervalMs ?? 400;
  let rec = start;
  const leg = rec.solanaLeg;
  if (leg == null) return rec; // not a Solana record — nothing to drive (hydration prevents this)
  const advance = async (patch: Partial<ConvertRecord>): Promise<ConvertRecord> => {
    rec = {...rec, ...patch};
    await saveConvertRecord(deps.publicHex, rec);
    await deps.onUpdate(rec);
    return rec;
  };
  const settle = async (): Promise<ConvertRecord> => {
    const outcome = await watchSolTx(leg, confirmAttempts, intervalMs);
    if (outcome.kind === 'confirmed') {
      const realized = await realizedSolPayout(rec, deps.solAddress).catch(() => null);
      // Honest end state: the REALIZED credit when the chain could be read, else the venue's
      // own min-out floor (a guarantee, not a guess). outTx is the tx signature.
      return advance({
        step: 'done',
        outAmountNet: realized ?? rec.expectedNet,
        outTx: leg.signature,
        ...(realized == null ? {failureDetail: 'payout-floor'} : {}),
      });
    }
    if (outcome.kind === 'failed') {
      // The chain confirmed the tx WITH an error: the route did not run; the input never left
      // the wallet (a failed Solana tx moves nothing but its fee).
      return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: outcome.detail});
    }
    if (outcome.kind === 'dead') {
      // Unseen + past the blockhash's death: the bytes can never execute. Input unmoved.
      return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'blockhash-expired'});
    }
    // Unknown after the full window: park honestly; the engine's stuck-watch keeps re-reading
    // the status (a late confirmation is found via history-aware reads; expiry eventually
    // resolves the other way). Never resubmit NEW bytes past this point — identical bytes only.
    return advance({step: 'stuck', failureCode: 'unknown'});
  };

  // --- stuck (the slow-watch entry): re-read, don't resubmit unless the bytes are still live --
  if (rec.step === 'stuck') {
    const outcome = await watchSolTx(leg, 1, 0);
    if (outcome.kind === 'confirmed') {
      rec = await advance({step: 'settling'});
    } else if (outcome.kind === 'failed') {
      return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: outcome.detail});
    } else if (outcome.kind === 'dead') {
      return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'blockhash-expired'});
    } else {
      return rec; // still genuinely unknown — stays stuck until acknowledged or resolved
    }
  }

  // --- swapping: submit the signed bytes (identical on every retry — the chain dedups them) --
  if (rec.step === 'swapping') {
    const raw = hexToBytes(leg.signedTxHex);
    if (raw == null) {
      return advance({step: 'stuck', failureCode: 'unknown', failureDetail: 'unreadable-signed-bytes'});
    }
    void saveTxNote(deps.publicHex, {k: leg.signature, who: venueDisplayName(rec.venueId)}, Date.now());
    let submitted = false;
    let lastErr: unknown = null;
    for (let i = 0; i < submitAttempts && !submitted; i++) {
      try {
        const nodeSig = await submitRawSolTx(raw);
        // The single-signer tx's identity IS the signature we recorded; anything else means
        // we are not looking at our own bytes — park, never guess.
        submitted = nodeSig === leg.signature;
        if (!submitted) return advance({step: 'stuck', failureCode: 'unknown', failureDetail: 'signature-mismatch'});
      } catch (e) {
        lastErr = e;
        // A throw is NOT a refusal verdict: the tx may already be in flight (or the error was
        // a timeout). Ask the chain before retrying — identical bytes only, never a rebuild.
        const probe = await watchSolTx(leg, 1, 0);
        if (probe.kind === 'confirmed') {
          submitted = true;
        } else if (probe.kind === 'failed') {
          return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: probe.detail});
        } else if (probe.kind === 'dead') {
          return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'blockhash-expired'});
        }
      }
    }
    if (!submitted) {
      // Exhausted identical-byte rounds with no chain answer: honest unknown (lastErr kept in
      // the console only — provider prose never reaches a screen).
      if (lastErr != null) console.warn('solana convert submit: no verdict after retries', lastErr);
      return advance({step: 'stuck', failureCode: 'unknown'});
    }
    rec = await advance({step: 'settling'});
  }

  if (rec.step === 'settling') {
    return settle();
  }
  return rec;
}

// --- the cross-rail drivers (Routes B/C, 2026-09-16) -------------------------------------------------
//
// Everything past the five IC legs. The signing boundary is the design: the CCTP burn is
// the USER's own EVM wallet's transaction (dpay builds the calldata, renders it, and never
// holds an EVM key), so `awaiting_external` advances only on USER action (attach or
// decline); the mint watch keys on Circle's own status API by the burn hash and NEVER
// manufactures a failure (a stall stays a pending with the Circle/Etherscan links); and
// Route C's final Jupiter leg re-uses the wave-3a machine verbatim (fresh quote, verify
// beneficiaries, device signature) — only its payout reads key on the cross-rail facts.

export type CrossRailDeps = {
  secretHex: string;
  publicHex: string;
  onUpdate: (record: ConvertRecord) => void | Promise<void>;
};

export type CrossRailOpts = {
  /** How many status polls one drive performs before parking back on `crossing`. */
  watchAttempts?: number;
  watchIntervalMs?: number;
};

/** Drive the `crossing` phase: poll Circle's message status by the burn hash; when Circle
 *  says complete (the forward tx executed the Solana mint), corroborate the credit at the
 *  user's USDC ATA through the SOL rail before anything downstream is offered. A pending
 *  or attested-but-unminted message parks back on `crossing` — an attestation stall is a
 *  PENDING with links (the mission's rule: never a false failure). A transport error also
 *  parks: the engine re-arms at its cadence. */
export async function executeCrossRailConvert(
  start: ConvertRecord,
  deps: CrossRailDeps,
  opts: CrossRailOpts = {},
): Promise<ConvertRecord> {
  const watchAttempts = opts.watchAttempts ?? 1;
  const watchIntervalMs = opts.watchIntervalMs ?? 0;
  let rec = start;
  const cross = rec.crossRail;
  if (cross == null || rec.step !== 'crossing' || cross.burnTxHash == null) return rec;
  const advance = async (patch: Partial<ConvertRecord>, crossPatch?: Partial<CrossRailInfo>): Promise<ConvertRecord> => {
    rec = {...rec, ...patch, ...(crossPatch != null ? {crossRail: {...(rec.crossRail as CrossRailInfo), ...crossPatch}} : {})};
    await saveConvertRecord(deps.publicHex, rec);
    await deps.onUpdate(rec);
    return rec;
  };

  let status: CctpMessageStatus | null = null;
  for (let i = 0; i < watchAttempts; i++) {
    try {
      status = await fetchCctpMessageStatus(cross.burnTxHash);
    } catch {
      status = null; // transport-class: proves nothing either way — park, retry next cadence
    }
    if (status != null && status.state === 'complete') break;
    if (i < watchAttempts - 1 && watchIntervalMs > 0) await new Promise(r => setTimeout(r, watchIntervalMs));
  }
  if (status == null || status.state !== 'complete') {
    return rec; // still attesting/minting — the pending-with-links screen stays up
  }
  // Circle executed the destination mint. Corroborate through the SOL rail before the
  // record claims a credit: the forward tx's USDC token delta AT THE USER'S ATA.
  let credit: string | null = null;
  try {
    credit = await getSolTokenCredit(status.forwardTxHash, cross.solAddress, USDC_MINT_ADDRESS);
  } catch {
    credit = null;
  }
  if (credit == null) {
    // forwardTxHash present but the rail read did not corroborate YET — freeze the hash,
    // park on crossing, and let the next cadence retry the read. Never claim unverified.
    return advance({}, {forwardTxHash: status.forwardTxHash});
  }
  const planIdx = rec.legPlan?.findIndex(p => p.kind === 'cctp_burn') ?? -1;
  const legPlan = rec.legPlan?.map((p, i) => (i === planIdx ? {...p, state: 'confirmed' as const} : p));
  if (cross.kind === 'cctp') {
    // Route B terminal: USDC at the user's own ATA, verified. outAmountNet is the REALIZED
    // credit; outTx is Circle's forward signature (the durable Solana-side evidence).
    return advance({step: 'done', outAmountNet: credit, outTx: status.forwardTxHash, legPlan},
      {forwardTxHash: status.forwardTxHash, mintSubunits: credit});
  }
  // Route C: the swap offer unlocks — the user confirms the final leg on a FRESH quote.
  return advance({step: 'sol_ready', legPlan}, {forwardTxHash: status.forwardTxHash, mintSubunits: credit});
}

/** Build + verify + sign Route C's final Jupiter leg and move `sol_ready` → `swapping`.
 *  The wave-3a red lines verbatim: the venue row is a registered mainnet solana_amm; the
 *  fresh quote names the registry pair (USDC mint → the record's own out mint — wrapped
 *  SOL on the original Route C, any registered USDC-pair SPL token such as EURC on the
 *  generalized one); the venue's tx is decodable, fee-payer IS the user, and the proceeds
 *  land at the user's OWN destination — the fee payer for a native-SOL unwrap (no ATA
 *  needed), the user's own ATA for the out mint on an SPL out; the message fee is quoted
 *  honestly; the device signs. The input is the VERIFIED mint credit — never an estimate. */
export async function prepareCrossRailSolLeg(secretHex: string, rec: ConvertRecord, relayUrl: string): Promise<ConvertRecord> {
  const cross = rec.crossRail;
  if (cross == null || rec.step !== 'sol_ready' || cross.kind !== 'cctp_sol') {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  if (cross.mintSubunits == null || cross.solVenueId == null) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  const venue = venueOfId(cross.solVenueId);
  if (venue == null || venue.kind !== 'solana_amm' || venue.testnet) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  // The record's own out mint (frozen at prepare): wrapped SOL unless the record names
  // an SPL token. The venue must actually serve the USDC→outMint pair — a record whose
  // venue stopped pairing it is refused, never re-routed.
  const outMint = cross.solOutMint ?? WRAPPED_SOL_MINT_ADDRESS;
  if (!venue.pair_ledgers.includes(USDC_MINT_ADDRESS) || !venue.pair_ledgers.includes(outMint)) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  const kp = deriveSolanaKeypair(secretHex);
  if (kp.address !== cross.solAddress) {
    // The derivation no longer matches the frozen recipient — refuse, never re-target.
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  const quoted = await fetchJupiterQuote(relayUrl, venue, USDC_MINT_ADDRESS, outMint, cross.mintSubunits, rec.slippageBps);
  if (!quoted.ok) {
    if (quoted.code === 'refused') throw new Error(M.convert.errors.quoteRefused(venue.display_name));
    throw new Error(M.convert.errors.quoteUnavailable(quoted.code));
  }
  const built = await fetchJupiterSwapTx(relayUrl, quoted.quote, kp.address);
  if (!built.ok) {
    if (built.code === 'refused') throw new Error(M.convert.errors.quoteRefused(venue.display_name));
    throw new Error(M.convert.errors.quoteUnavailable(built.code));
  }
  const decoded = decodeVenueSwapTx(built.swap.swapTransaction);
  if (decoded == null) {
    throw new Error(M.convert.errors.quoteUnavailable('shape'));
  }
  // Output destination (the beneficiary red line, both shapes): a native-SOL unwrap lands
  // on the fee payer — no SPL destination to pin; an SPL out (e.g. EURC) MUST arrive at
  // the USER'S OWN ATA for the out mint — the device's address, the same rule the
  // standalone Solana swap applies. Anything else is refused before anything signs.
  const beneficiary = verifyVenueSwapTxBeneficiaries(decoded, {
    pubkey: kp.publicKey,
    outAta: outMint === WRAPPED_SOL_MINT_ADDRESS ? null : deriveAta(kp.address, outMint),
  });
  if (!beneficiary.ok) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  let solFeeLamports: string | undefined;
  try {
    const fee = await quoteSolMessageFee(decoded.message);
    if (fee != null) solFeeLamports = fee.toString(10);
  } catch {
    // offline/unreadable fee is not a refusal — the line stays absent
  }
  const signed = signVenueSwapTx(built.swap.swapTransaction, kp.seed);
  if (signed == null || signed.feePayer !== kp.address) {
    throw new Error(M.convert.errors.quoteUnavailable('shape'));
  }
  const planIdx = rec.legPlan?.findIndex(p => p.kind === 'sol_swap') ?? -1;
  const legPlan = rec.legPlan?.map((p, i) => (i === planIdx ? {...p, state: 'sent' as const} : p));
  return {
    ...rec,
    step: 'swapping',
    legPlan,
    solanaLeg: {
      protocol: 'solana',
      signedTxHex: bytesToHex(signed.raw),
      signature: signed.signature,
      lastValidBlockHeight: built.swap.lastValidBlockHeight,
    },
    ...(solFeeLamports != null ? {solFeeLamports} : {}),
    crossRail: {
      ...cross,
      // The floor is frozen in the OUT ASSET's own units: lamports for native SOL (the
      // original field, byte-stable), the out mint's base subunits for an SPL token.
      ...(outMint === WRAPPED_SOL_MINT_ADDRESS
        ? {solExpectedLamports: quoted.quote.otherAmountThreshold}
        : {solExpectedSubunits: quoted.quote.otherAmountThreshold}),
    },
  };
}

/** Drive the cross-rail Jupiter leg (`swapping`/`settling`/its `stuck`): the wave-3a
 *  machine's exact transitions, with the payout reads keyed on the cross-rail facts —
 *  the realized credit is the fee payer's lamports delta for a native-SOL out, the
 *  out-mint token credit at the user's ATA for an SPL out (expected and realized both
 *  in the out mint's base units); the fallback floor is the leg's own signed min-out,
 *  NOT the record's IC-hop figures — different asset, different units. A refusal leaves
 *  the USDC(SOL) AT THE USER'S ATA — the failed copy names it and the exit (a standalone
 *  Solana convert, or holding the USDC). */
export async function executeCrossRailSolSwap(
  start: ConvertRecord,
  deps: CrossRailDeps,
  opts: SolanaExecutorOpts = {},
): Promise<ConvertRecord> {
  const submitAttempts = opts.submitAttempts ?? 2;
  const confirmAttempts = opts.confirmAttempts ?? 12;
  const intervalMs = opts.pollIntervalMs ?? 400;
  let rec = start;
  const leg = rec.solanaLeg;
  const cross = rec.crossRail;
  if (leg == null || cross == null) return rec;
  // The out asset (the record's own frozen mint): native SOL on the original Route C,
  // the SPL token (e.g. EURC) on the generalized one. Every payout read + floor
  // fallback below keys on it — expected vs realized compare in the SAME base units.
  const outMint = cross.solOutMint ?? WRAPPED_SOL_MINT_ADDRESS;
  const nativeOut = outMint === WRAPPED_SOL_MINT_ADDRESS;
  const advance = async (patch: Partial<ConvertRecord>): Promise<ConvertRecord> => {
    rec = {...rec, ...patch};
    await saveConvertRecord(deps.publicHex, rec);
    await deps.onUpdate(rec);
    return rec;
  };
  // The final leg's own plan entry follows the tx it represents: confirmed when the watch says
  // so (the leg list IS the progress UI — a done record with a 'Sent' tail would lie).
  const confirmSolLeg = (r: ConvertRecord): ConvertRecord => {
    if (r.legPlan == null) return r;
    const idx = r.legPlan.findIndex(l => l.kind === 'sol_swap');
    if (idx < 0 || r.legPlan[idx].state === 'confirmed') return r;
    const legPlan = r.legPlan.slice();
    legPlan[idx] = {...legPlan[idx], state: 'confirmed'};
    return {...r, legPlan};
  };
  const settle = async (): Promise<ConvertRecord> => {
    const outcome = await watchSolTx(leg, confirmAttempts, intervalMs);
    if (outcome.kind === 'confirmed') {
      const realized = await (nativeOut
        ? getSolNativeCredit(leg.signature)
        : getSolTokenCredit(leg.signature, cross.solAddress, outMint)
      ).catch(() => null);
      rec = confirmSolLeg(rec);
      return advance({
        step: 'done',
        outAmountNet: realized ?? (nativeOut ? cross.solExpectedLamports : cross.solExpectedSubunits) ?? '',
        outTx: leg.signature,
        ...(realized == null ? {failureDetail: 'payout-floor'} : {}),
      });
    }
    if (outcome.kind === 'failed') {
      return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: outcome.detail});
    }
    if (outcome.kind === 'dead') {
      return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'blockhash-expired'});
    }
    return advance({step: 'stuck', failureCode: 'unknown'});
  };
  if (rec.step === 'stuck') {
    const outcome = await watchSolTx(leg, 1, 0);
    if (outcome.kind === 'confirmed') {
      rec = await advance({step: 'settling'});
    } else if (outcome.kind === 'failed') {
      return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: outcome.detail});
    } else if (outcome.kind === 'dead') {
      return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'blockhash-expired'});
    } else {
      return rec;
    }
  }
  if (rec.step === 'swapping') {
    const raw = hexToBytes(leg.signedTxHex);
    if (raw == null) {
      return advance({step: 'stuck', failureCode: 'unknown', failureDetail: 'unreadable-signed-bytes'});
    }
    void saveTxNote(deps.publicHex, {k: leg.signature, who: venueDisplayName(cross.solVenueId ?? rec.venueId)}, Date.now());
    let submitted = false;
    let lastErr: unknown = null;
    for (let i = 0; i < submitAttempts && !submitted; i++) {
      try {
        const nodeSig = await submitRawSolTx(raw);
        submitted = nodeSig === leg.signature;
        if (!submitted) return advance({step: 'stuck', failureCode: 'unknown', failureDetail: 'signature-mismatch'});
      } catch (e) {
        lastErr = e;
        const probe = await watchSolTx(leg, 1, 0);
        if (probe.kind === 'confirmed') {
          submitted = true;
        } else if (probe.kind === 'failed') {
          return advance({step: 'failed_refunded', failureCode: 'swap_refused', failureDetail: probe.detail});
        } else if (probe.kind === 'dead') {
          return advance({step: 'failed_refunded', failureCode: 'unknown', failureDetail: 'blockhash-expired'});
        }
      }
    }
    if (!submitted) {
      if (lastErr != null) console.warn('cross-rail sol submit: no verdict after retries', lastErr);
      return advance({step: 'stuck', failureCode: 'unknown'});
    }
    rec = await advance({step: 'settling'});
  }
  if (rec.step === 'settling') {
    return settle();
  }
  return rec;
}
