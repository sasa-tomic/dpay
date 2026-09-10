/**
 * Delegated conversion (spec 2026-09-07) — the standalone wallet-level Convert action.
 *
 * dpay is NEVER a party to the trade: the user's phone signs BOTH value-moving calls
 * (`icrc2_approve` naming the ICPSwap pool as spender, and the pool's `depositFromAndSwap`), and
 * they are submitted through the exact app-signed /api/v2 rail every IC transfer already uses
 * (services/icp.ts → services/rail.ts). The venue's own quote is displayed verbatim, attributed
 * and timestamped — never computed, blended, or ranked here. dpay charges nothing and is paid
 * nothing.
 *
 * The §4 state machine (persisted in AsyncStorage under `dpay.convert.v1`, one record per swap id):
 *
 *   quote → confirming → approving → approved → swapping → settling
 *         ├→ done {outAmountNet, outTx}            (output-ledger credit SEEN — never from #ok alone)
 *         ├→ pending_withdrawal                    (pool #ok, output not seen yet — keep watching)
 *         ├→ failed_refunded                       (refused/refunded — user's position named)
 *         └→ stuck                                 (honest unknown — instructions, not a spinner)
 *
 * Retry discipline (offrampRetry heritage): a record carries the SIGNED envelope bytes; every
 * retry re-submits those identical bytes (dedup'd on-chain by request_id) — args are NEVER rebuilt
 * mid-swap. Settlement is detected by the same ledger-watch machinery the merchant reconciliation
 * uses (relay /api/v1/transactions against the user's principal) — the pool's #ok is treated as
 * "the pool pulled the input", NOT as settlement, because the pool's out figure is GROSS and the
 * wallet actually receives it minus the output-ledger fee.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {DpayCore} from './services/native';
import {relayFetch} from './services/relay';
import {submitTransfer as railSubmitTransfer} from './services/rail';
import {icStampExpiry} from './services/icp';
import {randNonceHex} from './lib/format';
import type {CurrencyDescriptor} from './config/catalog';
import {
  CONVERT_POOL_PRINCIPAL,
  CONVERT_APPROVE_LIFETIME_S,
  CONVERT_IMPACT_PRICE_SCALE,
  CONVERT_IMPACT_REF_AMOUNT_IN,
  CONVERT_IMPACT_WARN_BPS,
  CONVERT_STALE_MS,
  CONVERT_STORAGE_KEY,
} from './config/convert';
import {M} from './i18n';

// --- quote (relay-proxied, read-only; the venue's own number) -------------------------------------

/** The relay's swap_quote body verbatim (A2 contract). `amount_out` is GROSS e8s. */
export type SwapQuoteBody = {
  pool: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  amount_out: string;
  zero_for_one: boolean;
  fee_millionths: number; // the VENUE's own fee tier, off the pool's metadata (3000 = 0.30%)
  fetched_at: number; // unix seconds
};

export type ConvertQuote = {
  pool: string;
  tokenInLedger: string;
  tokenOutLedger: string;
  amountIn: string; // raw e8s decimal
  amountOutGross: string; // raw e8s decimal, GROSS (output fee not yet subtracted)
  zeroForOne: boolean;
  feeMillionths: number; // the venue's own fee tier, echoed — dpay never claims a number here
  fetchedAtMs: number; // device clock at fetch (staleness display + refresh)
  impactBps: number | null; // measured against the venue's own near-zero reference trade
};

async function getSwapQuote(relayUrl: string, tokenIn: string, tokenOut: string, amountIn: string, timeoutMs: number): Promise<SwapQuoteBody> {
  const path = `/api/v1/swap_quote?pool=${encodeURIComponent(CONVERT_POOL_PRINCIPAL)}`
    + `&token_in=${encodeURIComponent(tokenIn)}&token_out=${encodeURIComponent(tokenOut)}`
    + `&amount_in=${encodeURIComponent(amountIn)}`;
  let r: Response;
  try {
    r = await relayFetch(relayUrl, path, undefined, timeoutMs);
  } catch {
    throw new Error(M.convert.errors.quoteUnreachable());
  }
  if (r.status === 422) throw new Error(M.convert.errors.quoteRefused());
  if (!r.ok) throw new Error(M.convert.errors.quoteUnavailable(String(r.status)));
  const j = await r.json().catch(() => null) as SwapQuoteBody | null;
  if (j == null || typeof j.amount_out !== 'string' || typeof j.zero_for_one !== 'boolean'
    || typeof j.fee_millionths !== 'number') {
    throw new Error(M.convert.errors.quoteUnavailable('shape'));
  }
  return j;
}

/** Fetch the venue's quote for `amountIn` plus a near-zero reference quote through the same curve,
 *  and measure price impact as the gap between the two — the venue's number is still displayed
 *  verbatim; impact is a SEPARATE disclosed line (spec §5). The relay's impact_bps test knob
 *  multiplies both quotes equally and cancels in the ratio, so the measurement is curve-true. */
export async function fetchConvertQuote(
  relayUrl: string,
  tokenInLedger: string,
  tokenOutLedger: string,
  amountIn: string,
  opts: {timeoutMs?: number} = {},
): Promise<ConvertQuote> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const [trade, ref] = await Promise.all([
    getSwapQuote(relayUrl, tokenInLedger, tokenOutLedger, amountIn, timeoutMs),
    getSwapQuote(relayUrl, tokenInLedger, tokenOutLedger, CONVERT_IMPACT_REF_AMOUNT_IN, timeoutMs),
  ]);
  const inN = BigInt(trade.amount_in);
  const refInN = BigInt(ref.amount_in);
  let impactBps: number | null = null;
  if (inN > 0n && refInN > 0n) {
    // price(this trade) vs price(near-zero trade), both as out-units per in-unit ×1e12.
    const price = (BigInt(trade.amount_out) * CONVERT_IMPACT_PRICE_SCALE) / inN;
    const refPrice = (BigInt(ref.amount_out) * CONVERT_IMPACT_PRICE_SCALE) / refInN;
    if (refPrice > 0n) {
      // A larger trade can never get a BETTER unit price out of the same curve in the same
      // direction, so a negative gap is not a discount — it is the pool's own flooring, bounded at
      // 0.025 bps by the reference size (config/convert.ts). Reporting 0 states what that
      // measurement supports; nulling here would have parked the line on "unmeasurable" for every
      // trade small enough that the noise outweighs an impact of, honestly, zero.
      const drop = refPrice - price;
      impactBps = drop <= 0n ? 0 : Number((drop * 10_000n) / refPrice);
    }
  }
  return {
    pool: trade.pool,
    tokenInLedger: trade.token_in,
    tokenOutLedger: trade.token_out,
    amountIn: trade.amount_in,
    amountOutGross: trade.amount_out,
    zeroForOne: trade.zero_for_one,
    feeMillionths: trade.fee_millionths,
    fetchedAtMs: Date.now(),
    impactBps,
  };
}

// --- derivations (pure-ish; the min-out arithmetic is owned by the compiled core) ------------------

export type ConvertMath = {
  amountIn: string;
  grossOut: string;
  minOut: string; // exact-floor minimum via DpayCore.icpSwapMinOut — never TS arithmetic
  netOut: string; // grossOut − output-ledger fee (the exact end-state number, spec §5)
  inFee: string;
  outFee: string;
  slippageBps: number;
  impactBps: number | null;
  impactWarn: boolean;
};

/** Everything the screen shows derives from (quote, both ledger fees, slippage). The fees come from
 *  the catalog descriptors — the same numbers the deposit sheets show — never literals. */
export async function deriveConvertMath(
  quote: ConvertQuote,
  inFee: string,
  outFee: string,
  slippageBps: number,
): Promise<ConvertMath> {
  const minOut = await DpayCore.icpSwapMinOut(quote.amountOutGross, slippageBps);
  const gross = BigInt(quote.amountOutGross);
  const net = gross - BigInt(outFee);
  return {
    amountIn: quote.amountIn,
    grossOut: quote.amountOutGross,
    minOut,
    netOut: net < 0n ? '0' : net.toString(),
    inFee,
    outFee,
    slippageBps,
    impactBps: quote.impactBps,
    impactWarn: quote.impactBps != null && quote.impactBps > CONVERT_IMPACT_WARN_BPS,
  };
}

/** Is the quote stale (auto-refresh trigger, spec §5: >30s)? Test-shrinkable via
 *  `__DPAY_TEST_CONVERT_STALE_MS` (the e2e flow must not sleep 30 real seconds). */
export function isQuoteStale(quote: ConvertQuote, nowMs: number = Date.now()): boolean {
  const seam = (globalThis as unknown as {__DPAY_TEST_CONVERT_STALE_MS?: number}).__DPAY_TEST_CONVERT_STALE_MS;
  const threshold = seam ?? CONVERT_STALE_MS;
  return nowMs - quote.fetchedAtMs > threshold;
}

// --- the §4 state machine record -------------------------------------------------------------------

export type ConvertStep =
  | 'quote' | 'confirming' | 'approving' | 'approved' | 'swapping' | 'settling'
  | 'done' | 'pending_withdrawal' | 'failed_refunded' | 'stuck';

export type ConvertRecord = {
  id: string;
  createdAtMs: number;
  step: ConvertStep;
  inCurrency: number;
  outCurrency: number;
  inLedger: string;
  outLedger: string;
  inSymbol: string; // backing native symbol for copy ("which asset the user holds")
  outSymbol: string;
  amountIn: string; // raw e8s the pool pulls
  amountOutMin: string; // raw e8s signed into the swap arg
  expectedGross: string; // venue quote at confirm (gross)
  expectedNet: string; // gross − output fee (the end-state line)
  inFee: string;
  outFee: string;
  slippageBps: number;
  zeroForOne: boolean;
  approveEnvelopeHex: string;
  approveRequestIdHex: string;
  approveExpiresAtMs: number; // allowance death — the failure-screen countdown
  swapEnvelopeHex: string;
  swapRequestIdHex: string;
  outAmountNet?: string; // actually-received amount (from the ledger row) when done
  outTx?: string; // durable identifier of the incoming output-ledger row when done
  failureCode?: 'approve_refused' | 'swap_refused' | 'refunded' | 'unknown';
  failureDetail?: string;
};

const CONVERT_STEPS: ConvertStep[] = [
  'quote', 'confirming', 'approving', 'approved', 'swapping', 'settling',
  'done', 'pending_withdrawal', 'failed_refunded', 'stuck',
];

/** Validate an unknown storage value into the record map (pure; jest-pinned; never throws). */
export function hydrateConvertStore(state: unknown): Record<string, ConvertRecord> | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const out: Record<string, ConvertRecord> = {};
  for (const [id, v] of Object.entries(state as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') return null;
    const r = v as Record<string, unknown>;
    const str = (k: string) => (typeof r[k] === 'string' ? r[k] as string : null);
    const rec: Partial<ConvertRecord> = {
      id: str('id') ?? undefined,
      inSymbol: str('inSymbol') ?? undefined,
      outSymbol: str('outSymbol') ?? undefined,
      inLedger: str('inLedger') ?? undefined,
      outLedger: str('outLedger') ?? undefined,
      amountIn: str('amountIn') ?? undefined,
      amountOutMin: str('amountOutMin') ?? undefined,
      expectedGross: str('expectedGross') ?? undefined,
      expectedNet: str('expectedNet') ?? undefined,
      inFee: str('inFee') ?? undefined,
      outFee: str('outFee') ?? undefined,
      approveEnvelopeHex: str('approveEnvelopeHex') ?? undefined,
      approveRequestIdHex: str('approveRequestIdHex') ?? undefined,
      approveExpiresAtMs: typeof r.approveExpiresAtMs === 'number' ? r.approveExpiresAtMs : undefined,
      swapEnvelopeHex: str('swapEnvelopeHex') ?? undefined,
      swapRequestIdHex: str('swapRequestIdHex') ?? undefined,
      outAmountNet: str('outAmountNet') ?? undefined,
      outTx: str('outTx') ?? undefined,
      failureDetail: str('failureDetail') ?? undefined,
    };
    if (typeof r.createdAtMs !== 'number') return null;
    rec.createdAtMs = r.createdAtMs;
    if (typeof r.inCurrency !== 'number' || typeof r.outCurrency !== 'number') return null;
    rec.inCurrency = r.inCurrency;
    rec.outCurrency = r.outCurrency;
    if (typeof r.slippageBps !== 'number' || typeof r.zeroForOne !== 'boolean') return null;
    rec.slippageBps = r.slippageBps;
    rec.zeroForOne = r.zeroForOne;
    if (!CONVERT_STEPS.includes(r.step as ConvertStep)) return null;
    rec.step = r.step as ConvertStep;
    if (r.failureCode != null && !['approve_refused', 'swap_refused', 'refunded', 'unknown'].includes(r.failureCode as string)) return null;
    if (r.failureCode != null) rec.failureCode = r.failureCode as ConvertRecord['failureCode'];
    for (const k of ['id', 'inSymbol', 'outSymbol', 'inLedger', 'outLedger', 'amountIn', 'amountOutMin',
      'expectedGross', 'expectedNet', 'inFee', 'outFee', 'approveEnvelopeHex', 'approveRequestIdHex',
      'approveExpiresAtMs', 'swapEnvelopeHex', 'swapRequestIdHex'] as const) {
      if (rec[k] == null) return null;
    }
    if (rec.id !== id) return null;
    out[id] = rec as ConvertRecord;
  }
  return out;
}

export async function loadConvertRecords(): Promise<Record<string, ConvertRecord>> {
  try {
    const raw = await AsyncStorage.getItem(CONVERT_STORAGE_KEY);
    if (raw == null) return {};
    return hydrateConvertStore(JSON.parse(raw)) ?? {};
  } catch (e) {
    console.warn('convert records load failed:', e instanceof Error ? e.message : String(e));
    return {};
  }
}

export async function saveConvertRecord(record: ConvertRecord): Promise<void> {
  try {
    const all = await loadConvertRecords();
    all[record.id] = record;
    await AsyncStorage.setItem(CONVERT_STORAGE_KEY, JSON.stringify(all));
  } catch (e) {
    console.warn('convert record save failed:', e instanceof Error ? e.message : String(e));
  }
}

// --- prepare (confirming): build + sign BOTH envelopes once — never rebuild after this --------------

/** Approval = exact swap amount + input-ledger fee (spec §3), `expected_allowance` present, expiry
 *  = certified-now + 10 min. Both signed envelopes are built HERE and persisted verbatim; the
 *  executor only ever re-submits these bytes. */
export async function prepareConvertRecord(args: {
  secretHex: string;
  relayUrl: string;
  quote: ConvertQuote;
  math: ConvertMath;
  inDesc: CurrencyDescriptor;
  outDesc: CurrencyDescriptor;
}): Promise<ConvertRecord> {
  const {secretHex, quote, math, inDesc, outDesc} = args;
  const amountIn = quote.amountIn;
  // The approve amount covers the swap pull AND the ledger's own approve fee (caller-side rule).
  const approveAmount = (BigInt(amountIn) + BigInt(math.inFee)).toString();
  const allowanceExpiryNs = await icStampExpiry(secretHex, CONVERT_APPROVE_LIFETIME_S);
  const approveArgHex = await DpayCore.icpApproveArg(
    CONVERT_POOL_PRINCIPAL, '', '', approveAmount, approveAmount, allowanceExpiryNs, '', math.inFee,
  );
  const swapArgHex = await DpayCore.icpDepositAndSwapArg(
    amountIn, math.minOut, math.inFee, math.outFee, quote.zeroForOne,
  );
  const envExpiry = await icStampExpiry(secretHex);
  const approveSigned = await DpayCore.icpSignUpdate(secretHex, inDesc.ledger, 'icrc2_approve', approveArgHex, envExpiry);
  const swapSigned = await DpayCore.icpSignUpdate(secretHex, CONVERT_POOL_PRINCIPAL, 'depositFromAndSwap', swapArgHex, envExpiry);
  // Fail closed: a currency row without ANY display symbol cannot be named honestly on the state
  // screen (spec §4: every non-done state names which asset the user holds) — refuse to build.
  const inSymbol = inDesc.backing_symbol ?? inDesc.symbol;
  const outSymbol = outDesc.backing_symbol ?? outDesc.symbol;
  if (inSymbol == null || outSymbol == null) {
    throw new Error(M.convert.errors.quoteUnavailable('symbol'));
  }
  return {
    id: randNonceHex(),
    createdAtMs: Date.now(),
    step: 'approving',
    inCurrency: inDesc.currency,
    outCurrency: outDesc.currency,
    inLedger: inDesc.ledger,
    outLedger: outDesc.ledger,
    inSymbol,
    outSymbol,
    amountIn,
    amountOutMin: math.minOut,
    expectedGross: quote.amountOutGross,
    expectedNet: math.netOut,
    inFee: math.inFee,
    outFee: math.outFee,
    slippageBps: math.slippageBps,
    zeroForOne: quote.zeroForOne,
    approveEnvelopeHex: approveSigned.envelopeHex,
    approveRequestIdHex: approveSigned.requestIdHex,
    approveExpiresAtMs: Date.now() + CONVERT_APPROVE_LIFETIME_S * 1000,
    swapEnvelopeHex: swapSigned.envelopeHex,
    swapRequestIdHex: swapSigned.requestIdHex,
  };
}

// --- execute: submit the persisted bytes, watch the output ledger (never trust #ok alone) ---------

export type ConvertExecutorDeps = {
  secretHex: string;
  publicHex: string;
  relayUrl: string;
  onUpdate: (record: ConvertRecord) => void; // fired on every step change with the persisted record
};

export type SettleWatch = {kind: 'output'; amount: string; tx: string} | {kind: 'refund'} | null;

type TransactionsRowLike = {from?: string; to?: string; amount?: string; currency?: number; timestamp?: number; nonce?: string};

/**
 * The ledger-watch settlement probe (mirror of the merchant reconciliation machinery): read the
 * relay's durable transaction log for the USER's account and look for the pool's transfer.
 *
 * - `output` match: incoming row on the OUTPUT ledger, from the pool, at the user's principal,
 *   for the gross OR net amount (the fake-IC pool credits the gross figure; a production pool may
 *   send gross-minus-fee — both are "the pool's payout arrived", and the amount SEEN is recorded).
 * - `refund` match: incoming row on the INPUT ledger from the pool — the failed-swap refund path.
 */
export async function probeConvertSettlement(args: {
  relayUrl: string;
  publicHex: string;
  myPrincipalLower: string;
  record: ConvertRecord;
}): Promise<SettleWatch> {
  const {relayUrl, publicHex, myPrincipalLower, record} = args;
  try {
    const r = await relayFetch(
      relayUrl,
      `/api/v1/transactions/${publicHex}?currency=${record.outCurrency}&limit=10`,
      undefined,
      6000,
    );
    const refundR = record.inCurrency === record.outCurrency ? null : await relayFetch(
      relayUrl,
      `/api/v1/transactions/${publicHex}?currency=${record.inCurrency}&limit=10`,
      undefined,
      6000,
    );
    const parse = async (res: Response | null) => {
      if (res == null || !res.ok) return [] as TransactionsRowLike[];
      const body = await res.json().catch(() => null) as {transactions?: TransactionsRowLike[]} | null;
      return body?.transactions ?? [];
    };
    const pool = CONVERT_POOL_PRINCIPAL.toLowerCase();
    const outRows = await parse(r);
    for (const row of outRows) {
      if (row.currency === record.outCurrency
        && row.to?.toLowerCase() === myPrincipalLower
        && row.from?.toLowerCase() === pool
        && (row.amount === record.expectedGross || row.amount === record.expectedNet || row.amount === record.outAmountNet)) {
        return {kind: 'output', amount: row.amount ?? '', tx: String(row.timestamp ?? row.nonce ?? '')};
      }
    }
    const inRows = await parse(refundR);
    for (const row of inRows) {
      if (row.currency === record.inCurrency
        && row.to?.toLowerCase() === myPrincipalLower
        && row.from?.toLowerCase() === pool) {
        return {kind: 'refund'};
      }
    }
  } catch (e) {
    console.warn('convert settlement probe failed:', e instanceof Error ? e.message : String(e));
  }
  return null;
}

/** Drive a persisted record to a terminal state (or a honest non-terminal one). Resumable: call
 *  again with the same record (e.g. after a restart, or while pending_withdrawal) — every submit
 *  re-uses the record's OWN envelope bytes, so a resumed run can never double-spend (request_id
 *  dedup on the boundary node + the fake-IC gateway). */
export async function executeConvert(
  start: ConvertRecord,
  deps: ConvertExecutorDeps,
  opts: {submitAttempts?: number; poll?: {attempts: number; intervalMs: number}; settleAttempts?: number; settleIntervalMs?: number} = {},
): Promise<ConvertRecord> {
  const submitAttempts = opts.submitAttempts ?? 2;
  const poll = opts.poll ?? {attempts: 12, intervalMs: 400};
  const settleAttempts = opts.settleAttempts ?? 14;
  const settleIntervalMs = opts.settleIntervalMs ?? 1200;

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

  let rec: ConvertRecord = {...start};

  // --- approving: the icrc2_approve (nothing can move yet — worst case the ledger refuses) ------
  if (rec.step === 'approving') {
    const outcome = await submitEnvelope(rec.inLedger, rec.approveEnvelopeHex, rec.approveRequestIdHex);
    if (outcome === 'settled') {
      rec = {...rec, step: 'approved'};
      deps.onUpdate(rec);
      await saveConvertRecord(rec);
    } else if (outcome === 'unknown') {
      rec = {...rec, step: 'stuck', failureCode: 'unknown'};
      deps.onUpdate(rec);
      await saveConvertRecord(rec);
      return rec;
    } else {
      // Definitive refusal BEFORE anything moved: the user still holds every unit of the input
      // asset; no allowance exists; nothing needs reversing (the failure screen says exactly that).
      rec = {...rec, step: 'failed_refunded', failureCode: 'approve_refused', failureDetail: outcome.rejected.detail};
      deps.onUpdate(rec);
      await saveConvertRecord(rec);
      return rec;
    }
  }

  // --- approved → swapping: the pool's depositFromAndSwap (this is the call that moves funds) ---
  if (rec.step === 'approved') {
    rec = {...rec, step: 'swapping'};
    deps.onUpdate(rec);
    await saveConvertRecord(rec);
  }
  if (rec.step === 'swapping') {
    // The pool's Result is decoded by the compiled core (dpay_icp::icrc::decode_swap_result), the
    // same bytes-to-outcome the relay and the fake gateway use — never a TS re-read of the wire.
    // Called through a wrapper, not a detached method reference: `DpayCore` is a NativeModules
    // object, and a bare reference would only break on a device (the same shape rail.ts uses).
    const outcome = await submitEnvelope(
      CONVERT_POOL_PRINCIPAL, rec.swapEnvelopeHex, rec.swapRequestIdHex,
      (replyArgHex: string) => DpayCore.icpDecodeSwapResult(replyArgHex),
    );
    if (outcome === 'unknown') {
      rec = {...rec, step: 'stuck', failureCode: 'unknown'};
      deps.onUpdate(rec);
      await saveConvertRecord(rec);
      return rec;
    }
    if (outcome !== 'settled') {
      // The pool's own #err (e.g. "amountOutMinimum not met", InsufficientFunds): an ATOMIC refusal
      // — the pool pulled nothing. Input stays in the wallet; the allowance dies at its expiry.
      rec = {...rec, step: 'failed_refunded', failureCode: 'swap_refused',
        failureDetail: outcome.rejected.detail || outcome.rejected.variant || ''};
      deps.onUpdate(rec);
      await saveConvertRecord(rec);
      return rec;
    }
    // Pool replied #ok: the INPUT is spent and the OUTPUT is owed — NOT settled (gross ≠ received).
    rec = {...rec, step: 'settling'};
    deps.onUpdate(rec);
    await saveConvertRecord(rec);
  }

  // --- settling → terminal: watch BOTH ledgers at the user's principal --------------------------
  if (rec.step === 'settling' || rec.step === 'pending_withdrawal') {
    const myPrincipal = (await DpayCore.icpPrincipalFromPubkey(deps.publicHex)).toLowerCase();
    const wasPending = rec.step === 'pending_withdrawal';
    rec = {...rec, step: 'settling'};
    if (wasPending) deps.onUpdate(rec); // resume re-enters the watch; same-step runs stay silent
    for (let i = 0; i < settleAttempts; i += 1) {
      const seen = await probeConvertSettlement({
        relayUrl: deps.relayUrl, publicHex: deps.publicHex, myPrincipalLower: myPrincipal, record: rec,
      });
      if (seen?.kind === 'output') {
        rec = {...rec, step: 'done', outAmountNet: seen.amount, outTx: seen.tx};
        deps.onUpdate(rec);
        await saveConvertRecord(rec);
        return rec;
      }
      if (seen?.kind === 'refund') {
        rec = {...rec, step: 'failed_refunded', failureCode: 'refunded'};
        deps.onUpdate(rec);
        await saveConvertRecord(rec);
        return rec;
      }
      if (i < settleAttempts - 1 && settleIntervalMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, settleIntervalMs));
      }
    }
    // Pool #ok but no output row in budget: the honest pending screen (keeps watching while shown).
    rec = {...rec, step: 'pending_withdrawal'};
    deps.onUpdate(rec);
    await saveConvertRecord(rec);
    return rec;
  }

  return rec;
}
