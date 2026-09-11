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
 * v1 and pre-scoping v2 records are MIGRATED on load, never discarded):
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
import AsyncStorage from '@react-native-async-storage/async-storage';
import {DpayCore} from './services/native';
import {relayFetch} from './services/relay';
import {submitTransfer as railSubmitTransfer} from './services/rail';
import {icStampExpiry} from './services/icp';
import {randNonceHex} from './lib/format';
import type {CurrencyDescriptor} from './config/catalog';
import {
  CONVERT_APPROVE_LIFETIME_S,
  CONVERT_IMPACT_PRICE_SCALE,
  CONVERT_IMPACT_REF_AMOUNT_IN,
  CONVERT_IMPACT_WARN_BPS,
  CONVERT_LEGACY_STORAGE_KEY,
  CONVERT_PROBE_WINDOW_ROWS,
  CONVERT_STALE_MS,
  CONVERT_UNSCOPED_STORAGE_KEY,
  convertStoreKey,
} from './config/convert';
import {
  DPAY_CANISTER_PRINCIPALS,
  icAmmVenueForPair,
  registeredVenues,
  setRuntimeVenues,
  venueEndpointOf,
  venueOfId,
  type VenueEntry,
} from './config/venues';
import {M} from './i18n';

// --- quote (relay-proxied, read-only; the venue's own number) -------------------------------------

/** The relay's swap_quote body verbatim (A2 contract). `amount_out` is GROSS e8s; `venue_id`
 *  names which venue answered (attributable quotes, multi-venue readiness V4). */
export type SwapQuoteBody = {
  venue_id: string;
  pool: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  amount_out: string;
  /** Direction flag, PRESENT for curve venues (an IC-AMM pool's token0/token1 order is the
   *  venue's own fact, read live per quote). ABSENT for a venue with no AMM direction to
   *  report — a valid answer, not a malformed body (V8): direction-dependent copy hides and
   *  execution fails closed on its absence. */
  zero_for_one?: boolean;
  fee_millionths: number; // the VENUE's own fee tier, off the pool's metadata (3000 = 0.30%)
  fetched_at: number; // unix seconds — the instant the VENUE answered (the relay proxies verbatim)
};

export type ConvertQuote = {
  venueId: string; // which venue answered — the record's venue, looked up facts' key
  pool: string;
  tokenInLedger: string;
  tokenOutLedger: string;
  amountIn: string; // raw e8s decimal
  amountOutGross: string; // raw e8s decimal, GROSS (output fee not yet subtracted)
  /** null = the venue publishes no direction flag (V8); direction-dependent copy hides. */
  zeroForOne: boolean | null;
  feeMillionths: number; // the venue's own fee tier, echoed — dpay never claims a number here
  /** The RELAY's `fetched_at` — the actual venue-read instant, in ms. NOT the device clock:
   *  every timestamp and staleness decision shows when the VENUE answered, not when this
   *  phone happened to receive it (V8 provenance: display what the venue publishes). */
  fetchedAtMs: number;
  /** Measured (IC-AMM curve venues only) as this trade vs the venue's own near-zero reference
   *  through the same curve; null = unmeasured or the venue kind has no curve to measure. */
  impactBps: number | null;
};

async function getSwapQuote(
  venue: VenueEntry,
  relayUrl: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  timeoutMs: number,
): Promise<SwapQuoteBody> {
  const path = `/api/v1/swap_quote?pool=${encodeURIComponent(venue.endpoint)}`
    + `&token_in=${encodeURIComponent(tokenIn)}&token_out=${encodeURIComponent(tokenOut)}`
    + `&amount_in=${encodeURIComponent(amountIn)}`;
  let r: Response;
  try {
    r = await relayFetch(relayUrl, path, undefined, timeoutMs);
  } catch {
    throw new Error(M.convert.errors.quoteUnreachable(venue.display_name));
  }
  if (r.status === 422) throw new Error(M.convert.errors.quoteRefused(venue.display_name));
  if (!r.ok) throw new Error(M.convert.errors.quoteUnavailable(String(r.status)));
  const j = await r.json().catch(() => null) as SwapQuoteBody | null;
  // `zero_for_one` is deliberately NOT required here: a venue without an AMM direction flag
  // is not a malformed venue (V8). `fetched_at` IS required — every provenance claim the
  // screen makes is anchored to it.
  if (j == null || typeof j.venue_id !== 'string' || typeof j.amount_out !== 'string'
    || typeof j.fee_millionths !== 'number' || typeof j.fetched_at !== 'number') {
    throw new Error(M.convert.errors.quoteUnavailable('shape'));
  }
  return j;
}

/** Fetch the quote for `amountIn` from ONE named venue (default: the bundled registry's
 *  single venue for the pair). The venue's own numbers are displayed verbatim; the only
 *  app-derived figure is price impact, and only for a venue whose model supports the
 *  measurement: an IC-AMM curve, quoted as this trade vs a near-zero reference trade through
 *  the same curve (spec §5). Any other venue kind gets NO impact (absent, never faked) and
 *  no reference quote is fetched for it — one venue, one call per keystroke (V8). The
 *  relay's impact_bps test knob multiplies both quotes equally and cancels in the ratio, so
 *  the measurement is curve-true. */
export async function fetchConvertQuote(
  relayUrl: string,
  tokenInLedger: string,
  tokenOutLedger: string,
  amountIn: string,
  opts: {timeoutMs?: number; venue?: VenueEntry} = {},
): Promise<ConvertQuote> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  // WHICH venue to ask is the caller's registry-informed decision (the chooser passes the
  // user's pick, V5); the bundled single-venue fallback keeps honest the pre-chooser path.
  const venue = opts.venue ?? icAmmVenueForPair(tokenInLedger, tokenOutLedger);
  if (!venue) throw new Error(M.convert.errors.quoteUnavailable('venue'));
  // Both relayFetch calls fire before any await, so call ORDER (trade, then reference) is
  // deterministic — the same order jest's sequential mocks pin.
  const tradePromise = getSwapQuote(venue, relayUrl, tokenInLedger, tokenOutLedger, amountIn, timeoutMs);
  const refPromise = venue.kind === 'ic_amm'
    ? getSwapQuote(venue, relayUrl, tokenInLedger, tokenOutLedger, CONVERT_IMPACT_REF_AMOUNT_IN, timeoutMs)
    : null;
  const trade = await tradePromise;
  const ref = refPromise == null ? null : await refPromise;
  const inN = BigInt(trade.amount_in);
  const refInN = ref == null ? 0n : BigInt(ref.amount_in);
  let impactBps: number | null = null;
  if (ref != null && inN > 0n && refInN > 0n) {
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
    venueId: trade.venue_id,
    pool: trade.pool,
    tokenInLedger: trade.token_in,
    tokenOutLedger: trade.token_out,
    amountIn: trade.amount_in,
    amountOutGross: trade.amount_out,
    zeroForOne: trade.zero_for_one ?? null,
    feeMillionths: trade.fee_millionths,
    fetchedAtMs: trade.fetched_at * 1000,
    impactBps,
  };
}

// --- venue registry (the relay's served list, query-only) ------------------------------------------

/** One load per relay per session — venue identity is not per-keystroke data. */
const VENUE_REGISTRY_CACHE = new Map<string, readonly VenueEntry[]>();

/** `GET /api/v1/venues` — the venues THIS relay serves, in the relay's own ROW ORDER (the
 *  chooser renders that order verbatim and never ranks — V5 red line). On success the list
 *  becomes the runtime overlay (./config/venues lookups consult it) and is cached per relay
 *  for the session; on ANY failure the bundled registry remains the truth — venue identity
 *  fails closed to the drift-alarmed bundled table, never to an empty screen. */
export async function loadVenueRegistry(
  relayUrl: string,
  timeoutMs = 8000,
): Promise<readonly VenueEntry[]> {
  const cached = VENUE_REGISTRY_CACHE.get(relayUrl);
  if (cached) return cached;
  try {
    const r = await relayFetch(relayUrl, '/api/v1/venues', undefined, timeoutMs);
    if (r.ok) {
      const j = await r.json().catch(() => null) as {venues?: unknown} | null;
      if (j && Array.isArray(j.venues)) {
        const venues = j.venues.filter(
          (v): v is VenueEntry =>
            v != null && typeof v === 'object'
              && typeof (v as VenueEntry).venue_id === 'string'
              && typeof (v as VenueEntry).display_name === 'string'
              && ((v as VenueEntry).kind === 'ic_amm' || (v as VenueEntry).kind === 'cefi')
              && typeof (v as VenueEntry).endpoint === 'string'
              && Array.isArray((v as VenueEntry).pair_ledgers)
              && (v as VenueEntry).pair_ledgers.length === 2
              && (v as VenueEntry).pair_ledgers.every(p => typeof p === 'string')
              && typeof (v as VenueEntry).testnet === 'boolean'
              && typeof (v as VenueEntry).disclosure_key === 'string',
        );
        if (venues.length > 0) {
          VENUE_REGISTRY_CACHE.set(relayUrl, venues);
          setRuntimeVenues(venues);
          return venues;
        }
      }
    }
  } catch {
    // unreachable relay — the bundled registry below IS the answer
  }
  return registeredVenues();
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
  | 'done' | 'pending_withdrawal' | 'failed_refunded' | 'stuck'
  // CeFi-shaped states (multi-venue readiness V2): round-tripped by hydration today; the
  // drivers that move a record INTO them arrive with the CeFi wave. Kept snake_case like the
  // rest of the persisted vocabulary.
  | 'awaiting_user_authorization' | 'awaiting_deposit' | 'provider_processing'
  | 'quote_expired' | 'provider_refunded';

/** ONE signed IC update, frozen at prepare time. The executor only ever re-submits the
 *  envelope bytes; `argHex` is kept for audit/recovery, not re-signing. */
export type SignedLeg = {
  canister: string; // update target principal (the input ledger for the approve; the venue pool for the swap)
  method: string; // the update method ('icrc2_approve' | 'depositFromAndSwap' today)
  argHex: string; // '' only on legs migrated from a pre-legs record (its envelope froze the args)
  envelopeHex: string; // the SIGNED envelope bytes — the only thing retries re-submit
  requestIdHex: string; // the request id — the on-chain dedup key
  expiresAtMs: number; // device-clock death of this leg's authority (the failure-screen countdown)
};

/** A CeFi provider's handle on an order it issued (the empty-legs record shape). */
export type ProviderRef = {
  orderId: string;
  statusUrl?: string;
};

export type ConvertRecord = {
  id: string;
  createdAtMs: number;
  step: ConvertStep;
  venueId: string; // WHICH venue executes (registry key — facts are looked up, never assumed)
  inCurrency: number;
  outCurrency: number;
  inLedger: string;
  outLedger: string;
  inSymbol: string; // backing native symbol for copy ("which asset the user holds")
  outSymbol: string;
  amountIn: string; // raw e8s the venue pulls
  expectedGross: string; // venue quote at confirm (gross)
  expectedNet: string; // gross − output fee (the end-state line)
  inFee: string;
  outFee: string;
  slippageBps: number;
  legs: SignedLeg[]; // the signed updates, in submission order; EMPTY for a CeFi-shaped record
  providerRef?: ProviderRef; // required when legs is empty; ignored otherwise
  outAmountNet?: string; // actually-received amount (from the ledger row) when done
  outTx?: string; // durable identifier of the incoming output-ledger row when done
  /** Set by the USER's acknowledge tap on a `stuck` record (V6): the outcome is unknown, the
   *  user has read the instructions, and the background watch may stop. Until it is set, an
   *  expired-unconfirmed stuck record keeps being probed at the engine's slow cadence. */
  acknowledgedStuckAtMs?: number;
  failureCode?: 'approve_refused' | 'swap_refused' | 'refunded' | 'unknown';
  failureDetail?: string;
};

const CONVERT_STEPS: ConvertStep[] = [
  'quote', 'confirming', 'approving', 'approved', 'swapping', 'settling',
  'done', 'pending_withdrawal', 'failed_refunded', 'stuck',
  'awaiting_user_authorization', 'awaiting_deposit', 'provider_processing',
  'quote_expired', 'provider_refunded',
];

/** The min-out a record's swap leg signed, re-derived from the record's OWN frozen quote and
 *  slippage through the compiled core — deterministic, so this is the same figure
 *  `prepareConvertRecord` baked into the arg, not a new opinion. */
export async function convertRecordMinOut(record: ConvertRecord): Promise<string> {
  return DpayCore.icpSwapMinOut(record.expectedGross, record.slippageBps);
}

/** Migrate a pre-legs (v1 store) record to the legs schema: the two old envelope pairs become
 *  two SignedLegs against the venue the record's pair resolves to. The founder's device holds
 *  REAL v1 records — they must survive this, byte-frozen, never rebuilt. */
function migrateLegacyRecord(r: Record<string, unknown>, out: Record<string, ConvertRecord>, id: string): ConvertRecord | null {
  const str = (k: string) => (typeof r[k] === 'string' ? r[k] as string : null);
  const inLedger = str('inLedger');
  const outLedger = str('outLedger');
  if (!inLedger || !outLedger) return null;
  // v1 records were all ICPSwap trades — resolve the venue from the record's OWN pair, with
  // the id as an honest fallback if the registry no longer lists it.
  const venueId = icAmmVenueForPair(inLedger, outLedger)?.venue_id ?? 'icpswap';
  const expiresAtMs = typeof r.approveExpiresAtMs === 'number' ? r.approveExpiresAtMs : 0;
  const legs: SignedLeg[] = [
    {
      canister: inLedger,
      method: 'icrc2_approve',
      argHex: '',
      envelopeHex: str('approveEnvelopeHex') ?? '',
      requestIdHex: str('approveRequestIdHex') ?? '',
      expiresAtMs,
    },
    {
      canister: venueEndpointOf(venueId),
      method: 'depositFromAndSwap',
      argHex: '',
      envelopeHex: str('swapEnvelopeHex') ?? '',
      requestIdHex: str('swapRequestIdHex') ?? '',
      expiresAtMs,
    },
  ];
  const rec: Record<string, unknown> = {...r};
  delete rec.approveEnvelopeHex;
  delete rec.approveRequestIdHex;
  delete rec.approveExpiresAtMs;
  delete rec.swapEnvelopeHex;
  delete rec.swapRequestIdHex;
  delete rec.amountOutMin;
  delete rec.zeroForOne;
  rec.venueId = venueId;
  rec.legs = legs;
  return hydrateOneRecord(rec, out, id);
}

/** Validate ONE already-current-shape record (pure). */
function hydrateOneRecord(r: Record<string, unknown>, out: Record<string, ConvertRecord>, id: string): ConvertRecord | null {
  const str = (k: string) => (typeof r[k] === 'string' ? r[k] as string : null);
  const rec: Partial<ConvertRecord> = {
    id: str('id') ?? undefined,
    venueId: str('venueId') ?? undefined,
    inSymbol: str('inSymbol') ?? undefined,
    outSymbol: str('outSymbol') ?? undefined,
    inLedger: str('inLedger') ?? undefined,
    outLedger: str('outLedger') ?? undefined,
    amountIn: str('amountIn') ?? undefined,
    expectedGross: str('expectedGross') ?? undefined,
    expectedNet: str('expectedNet') ?? undefined,
    inFee: str('inFee') ?? undefined,
    outFee: str('outFee') ?? undefined,
    outAmountNet: str('outAmountNet') ?? undefined,
    outTx: str('outTx') ?? undefined,
    failureDetail: str('failureDetail') ?? undefined,
  };
  if (typeof r.createdAtMs !== 'number') return null;
  rec.createdAtMs = r.createdAtMs;
  if (typeof r.inCurrency !== 'number' || typeof r.outCurrency !== 'number') return null;
  rec.inCurrency = r.inCurrency;
  rec.outCurrency = r.outCurrency;
  if (typeof r.slippageBps !== 'number') return null;
  rec.slippageBps = r.slippageBps;
  if (!CONVERT_STEPS.includes(r.step as ConvertStep)) return null;
  rec.step = r.step as ConvertStep;
  if (typeof r.acknowledgedStuckAtMs === 'number') rec.acknowledgedStuckAtMs = r.acknowledgedStuckAtMs;
  if (r.failureCode != null && !['approve_refused', 'swap_refused', 'refunded', 'unknown'].includes(r.failureCode as string)) return null;
  if (r.failureCode != null) rec.failureCode = r.failureCode as ConvertRecord['failureCode'];
  // The legs: every signed update must be complete. An EMPTY legs list is the CeFi shape and
  // requires a providerRef with an orderId — a legless, providerless record is meaningless.
  if (!Array.isArray(r.legs)) return null;
  const legs: SignedLeg[] = [];
  for (const l of r.legs) {
    if (!l || typeof l !== 'object') return null;
    const leg = l as Record<string, unknown>;
    const canister = typeof leg.canister === 'string' ? leg.canister : null;
    const method = typeof leg.method === 'string' ? leg.method : null;
    const argHex = typeof leg.argHex === 'string' ? leg.argHex : null;
    const envelopeHex = typeof leg.envelopeHex === 'string' ? leg.envelopeHex : null;
    const requestIdHex = typeof leg.requestIdHex === 'string' ? leg.requestIdHex : null;
    const expiresAtMs = typeof leg.expiresAtMs === 'number' ? leg.expiresAtMs : null;
    if (!canister || !method || argHex == null || !envelopeHex || !requestIdHex || expiresAtMs == null) return null;
    legs.push({canister, method, argHex, envelopeHex, requestIdHex, expiresAtMs});
  }
  rec.legs = legs;
  // The IC-AMM shape the executor drives is exactly TWO legs — the icrc2_approve on the input
  // ledger, then the venue's depositFromAndSwap. A record with legs but fewer than two cannot be
  // resumed by any driver this build ships, so it fails hydration rather than crash mid-retry.
  // (More legs than two is a later wave's multi-hop shape; when it ships, this is the line it
  // widens — deliberately, not by silence.)
  if (legs.length > 0 && legs.length !== 2) return null;
  // A legs>0 record parked at `quote`/`confirming` is a shape no driver can advance: the
  // executor only knows approving→approved→swapping→settling→pending_withdrawal, so the resume
  // engine would re-arm a no-op drive forever with no escape (the unreachable-by-construction
  // quadrant — prepare lands at `approving` with legs already signed). Refuse the record like
  // any other malformed one rather than wedge the watcher.
  if (legs.length > 0 && (rec.step === 'quote' || rec.step === 'confirming')) return null;
  if (legs.length === 0) {
    const pr = r.providerRef;
    if (!pr || typeof pr !== 'object' || typeof (pr as Record<string, unknown>).orderId !== 'string') return null;
    const statusUrl = (pr as Record<string, unknown>).statusUrl;
    rec.providerRef = statusUrl == null
      ? {orderId: (pr as Record<string, unknown>).orderId as string}
      : {orderId: (pr as Record<string, unknown>).orderId as string, statusUrl: String(statusUrl)};
  }
  for (const k of ['id', 'venueId', 'inSymbol', 'outSymbol', 'inLedger', 'outLedger', 'amountIn',
    'expectedGross', 'expectedNet', 'inFee', 'outFee'] as const) {
    if (rec[k] == null) return null;
  }
  if (rec.id !== id) return null;
  const full = rec as ConvertRecord;
  out[id] = full;
  return full;
}

/** Validate an unknown storage value into the record map (pure; jest-pinned; never throws).
 *  Accepts BOTH store generations: current-shape records pass through; pre-legs (v1) records
 *  are migrated — never discarded. */
export function hydrateConvertStore(state: unknown): Record<string, ConvertRecord> | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const out: Record<string, ConvertRecord> = {};
  for (const [id, v] of Object.entries(state as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') return null;
    const r = v as Record<string, unknown>;
    const record = r.legs == null && typeof r.approveEnvelopeHex === 'string'
      ? migrateLegacyRecord(r, out, id)
      : hydrateOneRecord(r, out, id);
    if (record == null) return null;
  }
  return out;
}

/** The step a driver never touches again: done, failed_refunded, stuck, quote_expired,
 *  provider_refunded (V6 — the terminal provider states join the terminal set). The stuck
 *  nuance lives in the ENGINE, not the step: an unacknowledged expired-unconfirmed stuck
 *  record is still slow-watched; this set says only that no STATE transitions remain. */
export const TERMINAL_CONVERT_STEPS: ReadonlySet<ConvertStep> = new Set([
  'done', 'failed_refunded', 'stuck', 'quote_expired', 'provider_refunded',
]);

export function isTerminalConvertStep(step: ConvertStep): boolean {
  return TERMINAL_CONVERT_STEPS.has(step);
}

/** Has EVERY leg's submission authority died (device-clock death of the signed envelope)?
 *  An unconfirmed leg past this point may STILL have executed — the outcome is unknown, the
 *  bytes must never be re-submitted (V6 trichotomy arm (b)). */
export function convertLegsExpired(record: ConvertRecord, nowMs: number = Date.now()): boolean {
  return record.legs.length > 0 && record.legs.every(l => l.expiresAtMs <= nowMs);
}

export async function loadConvertRecords(publicHex: string): Promise<Record<string, ConvertRecord>> {
  const scopedKey = convertStoreKey(publicHex);
  try {
    const raw = await AsyncStorage.getItem(scopedKey);
    if (raw != null) return hydrateConvertStore(JSON.parse(raw)) ?? {};
    // Pre-scoping v2 store (founder device): the identity adopting it is the one that wrote it
    // (single-active-identity deployment) — copy into THIS identity's scoped key, then retire
    // the unscoped key, the same one-time-migration shape the v1 key uses below. A record must
    // survive an app upgrade, byte-frozen.
    const unscopedRaw = await AsyncStorage.getItem(CONVERT_UNSCOPED_STORAGE_KEY);
    if (unscopedRaw != null) {
      const adopted = hydrateConvertStore(JSON.parse(unscopedRaw)) ?? {};
      await AsyncStorage.setItem(scopedKey, JSON.stringify(adopted));
      await AsyncStorage.removeItem(CONVERT_UNSCOPED_STORAGE_KEY);
      if (Object.keys(adopted).length > 0) return adopted;
      // An empty adopted store is not an answer — fall through and check v1 too.
    }
    // The pre-legs store: migrate whatever is there into the v2 shape (scoped key) and retire
    // the old key.
    const legacyRaw = await AsyncStorage.getItem(CONVERT_LEGACY_STORAGE_KEY);
    if (legacyRaw == null) return {};
    const migrated = hydrateConvertStore(JSON.parse(legacyRaw)) ?? {};
    await AsyncStorage.setItem(scopedKey, JSON.stringify(migrated));
    await AsyncStorage.removeItem(CONVERT_LEGACY_STORAGE_KEY);
    return migrated;
  } catch (e) {
    console.warn('convert records load failed:', e instanceof Error ? e.message : String(e));
    return {};
  }
}

export async function saveConvertRecord(publicHex: string, record: ConvertRecord): Promise<void> {
  try {
    const all = await loadConvertRecords(publicHex);
    all[record.id] = record;
    await AsyncStorage.setItem(convertStoreKey(publicHex), JSON.stringify(all));
  } catch (e) {
    console.warn('convert record save failed:', e instanceof Error ? e.message : String(e));
  }
}

// --- prepare (confirming): build + sign BOTH envelopes once — never rebuild after this --------------

/** Approval = exact swap amount + input-ledger fee (spec §3), `expected_allowance` present, expiry
 *  = certified-now + 10 min. The signed legs are built HERE and persisted verbatim; the executor
 *  only ever re-submits those bytes. The approve's spender and the swap's target are the QUOTE's
 *  own pool echo — the venue the quote is attributed to, never a module constant. */
export async function prepareConvertRecord(args: {
  secretHex: string;
  relayUrl: string;
  quote: ConvertQuote;
  math: ConvertMath;
  inDesc: CurrencyDescriptor;
  outDesc: CurrencyDescriptor;
}): Promise<ConvertRecord> {
  const {secretHex, quote, math, inDesc, outDesc} = args;
  // The swap arg carries the VENUE's own direction flag — a venue that publishes none cannot
  // be executed through the IC-AMM rail, so fail closed rather than guess a direction (V8:
  // absent is a valid quote, but not an executable one).
  if (quote.zeroForOne == null) throw new Error(M.convert.errors.quoteUnavailable('direction'));
  const amountIn = quote.amountIn;
  const pool = quote.pool;
  // --- the signing-boundary red lines (multi-venue readiness V9) — checked before ANY arg is
  // built. The phone is the enforcement point for §0 because the phone is what signs.
  //
  // (1) The quote's OWN venue must be registered AND its endpoint must BE the pool the quote
  // carries. The executor submits the swap leg to `quote.pool` while settlement matches ledger
  // rows from `venueEndpointOf(quote.venueId)` — a quote whose attribution and target disagreed
  // (a misconfigured or hostile relay echoing venue A's name on venue B's principal) would sign
  // one principal and watch another, parking the record on a false unknown forever.
  const venue = venueOfId(quote.venueId);
  if (venue == null || venue.endpoint !== pool) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  // (2) A dpay-owned canister is never a conversion execution target — not as the swap target,
  // not as the approve's spender (the denylist IS the same `pool`). Pinned parametrically over
  // hostile venue registries by `app/__tests__/venueInvariants.test.ts`; the relay-side twin is
  // the `venue_of_endpoint` allowlist (`crates/dpay-relay/src/catalog.rs`).
  if (DPAY_CANISTER_PRINCIPALS.includes(pool)) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  // The approve amount covers the swap pull AND the ledger's own approve fee (caller-side rule).
  const approveAmount = (BigInt(amountIn) + BigInt(math.inFee)).toString();
  const allowanceExpiryNs = await icStampExpiry(secretHex, CONVERT_APPROVE_LIFETIME_S);
  const approveArgHex = await DpayCore.icpApproveArg(
    pool, '', '', approveAmount, approveAmount, allowanceExpiryNs, '', math.inFee,
  );
  const swapArgHex = await DpayCore.icpDepositAndSwapArg(
    amountIn, math.minOut, math.inFee, math.outFee, quote.zeroForOne,
  );
  const envExpiry = await icStampExpiry(secretHex);
  const approveSigned = await DpayCore.icpSignUpdate(secretHex, inDesc.ledger, 'icrc2_approve', approveArgHex, envExpiry);
  const swapSigned = await DpayCore.icpSignUpdate(secretHex, pool, 'depositFromAndSwap', swapArgHex, envExpiry);
  // Fail closed: a currency row without ANY display symbol cannot be named honestly on the state
  // screen (spec §4: every non-done state names which asset the user holds) — refuse to build.
  const inSymbol = inDesc.backing_symbol ?? inDesc.symbol;
  const outSymbol = outDesc.backing_symbol ?? outDesc.symbol;
  if (inSymbol == null || outSymbol == null) {
    throw new Error(M.convert.errors.quoteUnavailable('symbol'));
  }
  const expiresAtMs = Date.now() + CONVERT_APPROVE_LIFETIME_S * 1000;
  return {
    id: randNonceHex(),
    createdAtMs: Date.now(),
    step: 'approving',
    venueId: quote.venueId,
    inCurrency: inDesc.currency,
    outCurrency: outDesc.currency,
    inLedger: inDesc.ledger,
    outLedger: outDesc.ledger,
    inSymbol,
    outSymbol,
    amountIn,
    expectedGross: quote.amountOutGross,
    expectedNet: math.netOut,
    inFee: math.inFee,
    outFee: math.outFee,
    slippageBps: math.slippageBps,
    legs: [
      {
        canister: inDesc.ledger,
        method: 'icrc2_approve',
        argHex: approveArgHex,
        envelopeHex: approveSigned.envelopeHex,
        requestIdHex: approveSigned.requestIdHex,
        expiresAtMs,
      },
      {
        canister: pool,
        method: 'depositFromAndSwap',
        argHex: swapArgHex,
        envelopeHex: swapSigned.envelopeHex,
        requestIdHex: swapSigned.requestIdHex,
        expiresAtMs,
      },
    ],
  };
}

// --- execute: submit the persisted bytes, watch the output ledger (never trust #ok alone) ---------

export type ConvertExecutorDeps = {
  secretHex: string;
  publicHex: string; // also the identity-scoped STORE key scope (V6)
  relayUrl: string;
  onUpdate: (record: ConvertRecord) => void; // fired on every step change with the persisted record
  /** Row identities other records already claim as their payout — the engine supplies this so
   *  two records expecting the same amount can never both match one ledger row (V6). */
  claimedOutTx?: ReadonlySet<string>;
};

export type SettleWatch = {kind: 'output'; amount: string; tx: string} | {kind: 'refund'} | null;

type TransactionsRowLike = {from?: string; to?: string; amount?: string; currency?: number; timestamp?: number; nonce?: string; block?: number};

/** A ledger row's durable identity (dedupe + outTx): the BLOCK INDEX when the row carries one
 *  (every IC-rail row does), else the timestamp, else the nonce — the same fallback ladder the
 *  history list uses. */
function rowIdentity(row: TransactionsRowLike): string {
  return String(row.block ?? row.timestamp ?? row.nonce ?? '');
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
 * - `refund` match: incoming row on the INPUT ledger from the venue — the failed-swap refund path.
 * - DEDUPE (V6): a row whose identity another record already claims as ITS payout (`excludeOutTx`)
 *   is skipped — one ledger row can settle exactly one conversion; the older claim wins.
 * - No match → null. Still unknown, never optimistic done.
 */
export async function probeConvertSettlement(args: {
  relayUrl: string;
  publicHex: string;
  myPrincipalLower: string;
  record: ConvertRecord;
  /** Row identities other records already claimed as their payout (engine-supplied). */
  excludeOutTx?: ReadonlySet<string>;
}): Promise<SettleWatch> {
  const {relayUrl, publicHex, myPrincipalLower, record} = args;
  const exclude = args.excludeOutTx ?? new Set<string>();
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
        && !exclude.has(tx)) {
        return {kind: 'output', amount: row.amount ?? '', tx};
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
  const poll = opts.poll ?? {attempts: 12, intervalMs: 400};
  const settleAttempts = opts.settleAttempts ?? 14;
  const settleIntervalMs = opts.settleIntervalMs ?? 1200;
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
      const seen = await probeConvertSettlement({
        relayUrl: deps.relayUrl, publicHex: deps.publicHex, myPrincipalLower: myPrincipal, record: rec,
        excludeOutTx: deps.claimedOutTx,
      });
      if (seen?.kind === 'output') {
        return advance({...rec, step: 'done', outAmountNet: seen.amount, outTx: seen.tx});
      }
      if (seen?.kind === 'refund') {
        return advance({...rec, step: 'failed_refunded', failureCode: 'refunded'});
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
    const outcome = await submitEnvelope(rec.legs[0].canister, rec.legs[0].envelopeHex, rec.legs[0].requestIdHex);
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
