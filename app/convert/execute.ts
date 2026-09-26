import {DpayCore} from '../services/native';
import {relayFetch} from '../services/relay';
import {submitTransfer as railSubmitTransfer, railBalanceOf} from '../services/rail';
import {CONVERT_PROBE_WINDOW_ROWS, CONVERT_ENGINE_TEST_OPTS} from '../config/convert';
import {venueDisplayName, venueEndpointOf} from '../config/venues';
import {saveTxNote} from '../services/txNotes';
import {rawToDecimal} from '../lib/format';
import {type ConvertRecord, type LegState, isTerminalConvertStep} from './types';
import {
  convertAborted,
  convertLegsExpired,
  convertRecordMinOut,
  isComposedConvertRecord,
  isHubConvertRecord,
  sameDecimalAmount,
  saveConvertRecord,
} from './records';
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
  const outCurrency = leg === 2 ? record.destCurrency : (record.hopCurrency ?? record.outCurrency);
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

/**
 * The COMPOSED deposit-leg probe (2026-09-26, brief §5.4 item 2): did the venue's deposit
 * transfer execute? Reads the hub ledger's history at the user's principal and looks for
 * the OUTGOING row the transfer would have created — from the user, to the venue's own
 * deposit account (owner principal or the raw address text, whichever the relay renders),
 * for the EXACT order amount, newer than the record itself (the same -120s clock-skew
 * floor every probe applies). This is the resume evidence for a kill between submit and
 * persist, and the expiry arm's truth-source: the ledger row, never a hope. Returns the
 * row's durable identity, or null (nothing proven either way).
 */
export async function probeDepositRow(args: {
  relayUrl: string;
  publicHex: string;
  myPrincipalLower: string;
  record: ConvertRecord;
}): Promise<string | null> {
  const {relayUrl, publicHex, myPrincipalLower, record} = args;
  const cd = record.composedDeposit;
  const hubCurrency = record.destCurrency ?? record.hopCurrency;
  if (cd == null || hubCurrency == null) return null; // not a composed record / unwatchable — prove nothing
  try {
    const r = await relayFetch(
      relayUrl,
      `/api/v1/transactions/${publicHex}?currency=${hubCurrency}&limit=${CONVERT_PROBE_WINDOW_ROWS}`,
      undefined,
      6000,
    );
    if (!r.ok) return null;
    const body = await r.json().catch(() => null) as {transactions?: TransactionsRowLike[]} | null;
    const owner = cd.depositOwner.toLowerCase();
    const address = cd.depositAddress.toLowerCase();
    const floorSec = Math.floor(record.createdAtMs / 1000) - 120;
    for (const row of body?.transactions ?? []) {
      const tx = rowIdentity(row);
      const to = row.to?.toLowerCase();
      if (row.currency === hubCurrency
        && row.from?.toLowerCase() === myPrincipalLower
        && (to === owner || to === address)
        && row.amount === cd.amountRaw
        && row.timestamp != null && Number(row.timestamp) > floorSec) {
        return tx;
      }
    }
  } catch (e) {
    console.warn('deposit row probe failed:', e instanceof Error ? e.message : String(e));
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
  // The COMPOSED widening (2026-09-26, brief §5.4 item 2): a deposit_transfer leg FOLLOWS
  // the IC swaps — a second swap's payout row is then NOT the terminal evidence (the hub
  // record's done-rule); it only opens the gate for the deposit leg, which the venue poll
  // after it resolves to a terminal state.
  const composedTail = isComposedConvertRecord(rec);
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
    if (leg === 2 && !composedTail) {
      rec = await tools.advance(withLegState(rec, swapIdx, 'confirmed', {
        step: 'done', outAmountNet: seen.amount, outTx: seen.tx, destTx: seen.tx,
      }));
    } else {
      // leg 1 confirms the hop; a COMPOSED second swap only opens the deposit leg's gate
      // (its row is evidence, not completion — the deposit leg + venue poll finish the route).
      rec = await tools.advance(withLegState(rec, swapIdx, 'confirmed', leg === 2 ? {destTx: seen.tx} : {hopTx: seen.tx}));
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
  // The COMPOSED trichotomy (2026-09-26) probes the DEPOSIT row first — a dead envelope can
  // still have executed before it died, and a seen deposit row means the venue owes the
  // trade (the venue poll resolves it: awaiting_deposit). Then the IC rows: the LAST swap's
  // payout → failed_leg (the hub asset is in-wallet, the deposit never went), else stuck.
  if (firstIncomplete() >= 0 && convertLegsExpired(rec, opts.nowMs)) {
    if (composedTail) {
      const sentTx = await probeDepositRow({
        relayUrl: deps.relayUrl, publicHex: deps.publicHex, myPrincipalLower, record: rec,
      });
      if (sentTx != null) {
        const cd = rec.composedDeposit;
        return tools.advance(withLegState(rec, rec.legs.length - 1, 'confirmed', {
          step: 'awaiting_deposit',
          ...(cd != null ? {composedDeposit: {...cd, sentTx}} : {}),
        }));
      }
      const lastSwap = (rec.legPlan ?? []).reduce((acc, l, i) => (l.kind === 'swap' ? i : acc), -1);
      if (lastSwap >= 0 && swapOrdinalOf(lastSwap) >= 1) {
        const dest = await probeHop(rec, 2);
        if (dest != null) {
          return tools.advance(withLegState(rec, lastSwap, 'confirmed', {
            step: 'failed_leg', failureCode: 'unknown', destTx: dest.tx,
          }));
        }
      }
      const hub = await probeHop(rec, 1);
      return tools.advance(hub != null
        ? {...rec, step: 'failed_leg', failureCode: 'unknown', hopTx: hub.tx}
        : {...rec, step: 'stuck', failureCode: 'unknown'});
    }
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
    // THE DEPOSIT GATE (composed, 2026-09-26): re-verified from the record's OWN frozen
    // bytes at EVERY entry — never from memory, so a resume can never sign from stale
    // state. Order matters: (1) the exact-amount invariant (the frozen transfer must BE
    // the frozen order amount — a mismatch means the record is corrupt and must never
    // sign); (2) the LEDGER ROW — a kill between submit and persist leaves the leg `sent`
    // with the transfer possibly already on-chain, and the row is the truth (never a
    // re-sign, never a double-send: identical bytes are deduped anyway); (3) the windows —
    // the envelope's own ingress death and the venue's deposit window, past either of
    // which the venue cannot credit the order so the transfer must never leave; (4) the
    // ACTUAL hub-ledger balance (the swap's payout is in it) must cover transfer + fee —
    // an unreadable balance is NOT a pass: hold, the re-arm re-runs the gate.
    if (plan.kind === 'deposit_transfer') {
      const cd = rec.composedDeposit;
      if (cd == null) {
        return tools.advance(withLegState(rec, i, 'failed', {step: 'failed_leg', failureCode: 'deposit_refused',
          failureDetail: 'composed record carries no deposit block'}));
      }
      const depositDecimals = rec.destDecimals ?? rec.hopDecimals ?? 8;
      if (!sameDecimalAmount(cd.amountDecimal, rawToDecimal(cd.amountRaw, depositDecimals))) {
        return tools.advance(withLegState(rec, i, 'failed', {step: 'failed_leg', failureCode: 'deposit_refused',
          failureDetail: `order amount ${cd.amountDecimal} != signed transfer amount`}));
      }
      const sentTx = await probeDepositRow({
        relayUrl: deps.relayUrl, publicHex: deps.publicHex, myPrincipalLower, record: rec,
      });
      if (sentTx != null) {
        // The transfer already executed (an earlier life of this record): the venue owes
        // the trade — straight to the provider poll, never a second signature.
        return tools.advance(withLegState(rec, i, 'confirmed', {
          step: 'awaiting_deposit',
          composedDeposit: {...cd, sentTx},
        }));
      }
      if (leg.expiresAtMs <= opts.nowMs) {
        return tools.advance(withLegState(rec, i, 'failed', {step: 'failed_leg', failureCode: 'deposit_refused',
          failureDetail: 'the signed deposit transfer expired before it could be submitted'}));
      }
      if (cd.expiresAtMs != null && opts.nowMs >= cd.expiresAtMs) {
        return tools.advance(withLegState(rec, i, 'failed', {step: 'failed_leg', failureCode: 'deposit_refused',
          failureDetail: 'the venue order expired before the deposit could be sent'}));
      }
      const balRaw = await railBalanceOf(deps.secretHex, leg.canister);
      if (balRaw == null || !/^\d+$/.test(balRaw)) {
        console.warn('deposit gate: hub-ledger balance unreadable — holding the deposit leg');
        return rec;
      }
      const needed = BigInt(cd.amountRaw) + BigInt(cd.fee);
      if (BigInt(balRaw) < needed) {
        return tools.advance(withLegState(rec, i, 'failed', {step: 'failed_leg', failureCode: 'deposit_refused',
          failureDetail: `hub balance ${balRaw} short of ${cd.amountRaw}+${cd.fee}`}));
      }
      // gate passed — fall through to the generic submit below
    }
    rec = await tools.advance(withLegState(rec, i, 'sent'));
    // Device-saved annotation for the swap-side legs only — the burn-side legs are the
    // Withdraw flow's own calls and carry no venue row to name (parity with WithdrawSheet).
    // On a hub record legs 3–4 are venue2's business (their ordinal ≥ 1); a Route A record
    // has no venue2Id, so the ?? falls back to the same venue it always named. A gas-fund
    // pre-leg names its OWN venue (pair k = floor(i/2) in the pre-leg list). The composed
    // deposit transfer names the CEFI venue (it funds that venue's order).
    if (plan.kind === 'approve' || plan.kind === 'swap' || plan.kind === 'deposit_transfer') {
      const venue = plan.kind === 'deposit_transfer'
        ? (rec.composedDeposit?.venueId ?? rec.venueId)
        : isPreLeg(i)
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
            // The composed deposit transfer: the ledger's own reply, decoded by the method
            // the leg signed (ICRC-1 transfer, or the ICP ledger's legacy transfer when the
            // venue's deposit address is an account identifier). The settled block index is
            // the durable sent-evidence.
            : plan.kind === 'deposit_transfer'
              ? async (h: string) => {
                  const out = leg.method === 'icrc1_transfer'
                    ? await DpayCore.icpDecodeTransferResult(h)
                    : await DpayCore.icpDecodeLegacyTransferResult(h);
                  if (out.ok && out.blockIndex != null) legBlockIndex = out.blockIndex;
                  return out;
                }
              : undefined;
    const outcome = await tools.submitEnvelope(leg.canister, leg.envelopeHex, leg.requestIdHex, decodeReply);
    if (outcome === 'unknown') {
      // Bytes submitted, outcome unknowable: park stuck. The plan keeps the leg at `sent`
      // (it WAS sent); the engine's slow watch can still resolve the hop row later.
      // THE COMPOSED EXCEPTION: the venue is now the source of truth — if the transfer
      // executed, the order completes; if not, the venue expires it honestly (nothing left
      // the wallet). Either way the provider poll resolves it; never a second signature.
      if (plan.kind === 'deposit_transfer') {
        return tools.advance(withLegState(rec, i, 'sent', {step: 'awaiting_deposit'}));
      }
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
      if (plan.kind === 'deposit_transfer') {
        // The ledger refused the deposit transfer DEFINITIVELY: single attempt — a failed
        // deposit is NEVER retried and NEVER re-signed (the agent-float red line). The IC
        // phase's payout (the hub asset) is still in the wallet; the venue order dies
        // unfunded at its expiry, which the failure copy names.
        return tools.advance(withLegState(rec, i, 'failed', {step: 'failed_leg', failureCode: 'deposit_refused', failureDetail: detail}));
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
      if (leg === 2 && !composedTail) {
        return tools.advance(withLegState(rec, i, 'confirmed', {
          step: 'done', outAmountNet: seen.amount, outTx: seen.tx, destTx: seen.tx,
        }));
      }
      rec = await tools.advance(withLegState(rec, i, 'confirmed', leg === 2 ? {destTx: seen.tx} : {hopTx: seen.tx}));
      continue;
    }
    if (plan.kind === 'deposit_transfer') {
      // The venue's order is funded: the record hands off to the provider poll (the
      // engine's driver dispatch keys on the composed shape + this step). The settled
      // block index is the durable sent-evidence frozen on the deposit block.
      const cd = rec.composedDeposit;
      const sentTx = legBlockIndex ?? cd?.sentTx ?? null;
      return tools.advance(withLegState(rec, i, 'confirmed', {
        step: 'awaiting_deposit',
        ...(cd != null && sentTx != null ? {composedDeposit: {...cd, sentTx}} : {}),
      }));
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
