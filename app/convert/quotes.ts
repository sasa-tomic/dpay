import {DpayCore} from '../services/native';
import {relayFetch} from '../services/relay';
import {toUnits, rawToDecimal} from '../lib/format';
import {CONVERT_STALE_MS} from '../config/convert';
import {
  BUNDLED_VENUES,
  cefiFamilyOf,
  cefiOtherSide,
  icAmmVenueForPair,
  registeredVenues,
  setRuntimeVenues,
  type VenueEntry,
} from '../config/venues';
import {
  createSideShiftFixedShift,
  fetchSideShiftQuote,
  type SideShiftFixedShift,
} from '../services/sideshift';
import {
  createTrocadorTrade,
  fetchTrocadorQuote,
  type TrocadorTrade,
} from '../services/trocador';
import {M} from '../i18n';
/** The bundled registry's mainnet IC-AMM venue id — DERIVED, never a literal, so this module
 *  carries no venue id outside the registry (the v1-record migration fallback). Same derivation
 *  ConvertMode uses for its standing single-venue disclosure. */
export const BUNDLED_MAINNET_VENUE_ID = BUNDLED_VENUES.find(v => v.kind === 'ic_amm' && !v.testnet)?.venue_id ?? '';

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
 *  single venue for the pair). The venue's own numbers are displayed verbatim — dpay derives
 *  NOTHING here (V8 "display what the venue publishes, derive only what it does not"): the
 *  venue does not publish a price-impact figure, so none is fetched, computed, or shown.
 *  One venue, ONE call per keystroke, for every venue kind — the second reference quote the
 *  2026-09-07 build fired per ic_amm venue (doubling chooser traffic and presenting a
 *  curve-slope estimate as venue fact) was removed 2026-09-11. The venue's own amounts and
 *  the signed minimum-you'll-receive remain the execution protection. */
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
  const trade = await getSwapQuote(venue, relayUrl, tokenInLedger, tokenOutLedger, amountIn, timeoutMs);
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
  };
}

// --- venue registry (the relay's served list, query-only) ------------------------------------------

/** Fetch ONE CeFi quote through the relay's partner-key proxy (the SideShift widening,
 *  2026-09-15 — founder decision 3). The device sends RAIL ids + the user's amount; the
 *  relay maps them onto the venue's own coin/network codes, attaches the partner
 *  credential server-side, and returns the venue's quote wrapped with attribution. The
 *  venue's settleAmount/rate are carried VERBATIM (V8) — scaled to raw out-units for the
 *  ConvertQuote shape the screen's existing math renders, but never recomputed, never
 *  blended. `feeMillionths` is 0 as a FACT, not a claim: the relay pins commissionRate
 *  "0" (dpay is paid nothing) and the venue's commission lives inside its own rate —
 *  there is no dpay-side fee figure to display. `pool` carries the venue's API base (a
 *  cefi venue has no pool; prepare never reads it as one). Fixed-shift rates are LOCKED
 *  at quote time, so `zeroForOne` is null and the slippage math degenerates honestly
 *  (min-you'll-receive == the quoted settle figure). */
/** Map the sideshift service's fail-closed vocabulary onto the screen's honesty keys —
 *  shared by the quote path and the confirm-time order path so both surfaces name the
 *  same states, including the one no IC venue can be in: the relay holds no partner
 *  credential for this venue, so the venue is simply ABSENT (503 naming the env var). */
export function ceFiServiceError(e: unknown, venueName: string): Error {
  const code = e instanceof Error ? e.message : 'unavailable';
  if (code === 'unreachable') return new Error(M.convert.errors.quoteUnreachable(venueName));
  if (code === 'unconfigured') return new Error(M.convert.errors.quoteUnconfigured(venueName));
  if (code === 'refused') return new Error(M.convert.errors.quoteRefused(venueName));
  return new Error(M.convert.errors.quoteUnavailable(code));
}

/** Scale a verbatim SideShift quote result into the ConvertQuote shape the screen's math
 *  renders — the ONE mapping, used by both the live fetch and the confirm-time re-quote so
 *  the reviewed figure and the executed figure can never be built two different ways. */
export function ceFiQuoteFromResult(
  venue: VenueEntry,
  tokenInLedger: string,
  tokenOutLedger: string,
  amountIn: string,
  result: {settleAmount: string; fetchedAtMs: number},
  outDecimals: number,
): ConvertQuote {
  return {
    venueId: venue.venue_id,
    pool: venue.endpoint,
    tokenInLedger,
    tokenOutLedger,
    amountIn,
    amountOutGross: toUnits(result.settleAmount, outDecimals),
    zeroForOne: null,
    feeMillionths: 0,
    fetchedAtMs: result.fetchedAtMs,
  };
}

/** The raw quote a cefi family's service returned, normalized for the confirm path:
 *  `quoteId` is SideShift's order-creation key; `rateId` + `provider` are Trocador's
 *  (the aggregator names the backend the trade must name back). Exactly one family's
 *  key is non-null — the dispatchers below guarantee it. */
export type CeFiQuoteResult = {
  readonly settleAmount: string;
  readonly rate: string | null;
  readonly fetchedAtMs: number;
  readonly quoteId: string | null;
  readonly rateId: string | null;
  readonly provider: string | null;
};

/** Fetch ONE cefi quote through the family's own service — the ONE dispatch point for
 *  the confirm-time re-quote (the review quote flows through fetchCeFiConvertQuote).
 *  Unknown cefi family: refused, never defaulted. */
export async function fetchCeFiQuoteResult(
  relayUrl: string,
  venue: VenueEntry,
  depositLedger: string,
  settleLedger: string,
  depositAmountDecimal: string,
  timeoutMs?: number,
): Promise<CeFiQuoteResult> {
  switch (cefiFamilyOf(venue)) {
    case 'sideshift': {
      const r = await fetchSideShiftQuote(
        relayUrl, venue, depositLedger, settleLedger, depositAmountDecimal, timeoutMs,
      );
      return {
        settleAmount: r.settleAmount,
        rate: r.rate,
        fetchedAtMs: r.fetchedAtMs,
        quoteId: r.quoteId,
        rateId: null,
        provider: null,
      };
    }
    case 'trocador': {
      const r = await fetchTrocadorQuote(
        relayUrl, venue, depositLedger, settleLedger, depositAmountDecimal, timeoutMs,
      );
      return {
        settleAmount: r.settleAmount,
        rate: null,
        fetchedAtMs: r.fetchedAtMs,
        quoteId: null,
        rateId: r.rateId,
        provider: r.provider,
      };
    }
    default:
      throw new Error('refused');
  }
}

/** Create ONE cefi order through the family's own service — the ONE dispatch point for
 *  the confirm path. Both families refuse an order without the user's OWN refund
 *  address (the relay re-validates it rail-scoped; the fund-loss guard). */
export async function createCeFiOrder(
  relayUrl: string,
  venue: VenueEntry,
  quote: CeFiQuoteResult,
  args: {
    settleAddress: string;
    refundAddress: string;
    depositLedger: string;
    settleLedger: string;
    depositAmountDecimal: string;
  },
  timeoutMs?: number,
): Promise<SideShiftFixedShift | TrocadorTrade> {
  switch (cefiFamilyOf(venue)) {
    case 'sideshift':
      return createSideShiftFixedShift(relayUrl, venue, {
        quoteId: quote.quoteId ?? '',
        settleAddress: args.settleAddress,
        refundAddress: args.refundAddress,
        depositLedger: args.depositLedger,
      }, timeoutMs);
    case 'trocador': {
      if (quote.rateId == null || quote.provider == null) throw new Error('shape');
      return createTrocadorTrade(relayUrl, venue, {
        rateId: quote.rateId,
        provider: quote.provider,
        settleAddress: args.settleAddress,
        refundAddress: args.refundAddress,
        depositLedger: args.depositLedger,
        settleLedger: args.settleLedger,
        depositAmount: args.depositAmountDecimal,
      }, timeoutMs);
    }
    default:
      throw new Error('refused');
  }
}

export async function fetchCeFiConvertQuote(
  relayUrl: string,
  venue: VenueEntry,
  tokenInLedger: string,
  tokenOutLedger: string,
  amountIn: string,
  opts: {timeoutMs?: number; inDecimals: number; outDecimals: number} ,
): Promise<ConvertQuote> {
  const venueName = venue.display_name;
  if (venue.kind !== 'cefi' || venue.testnet
    || cefiOtherSide(venue, tokenInLedger) !== tokenOutLedger) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  let result;
  try {
    result = await fetchCeFiQuoteResult(
      relayUrl, venue, tokenInLedger, tokenOutLedger,
      rawToDecimal(amountIn, opts.inDecimals), opts.timeoutMs,
    );
  } catch (e) {
    throw ceFiServiceError(e, venueName);
  }
  return ceFiQuoteFromResult(venue, tokenInLedger, tokenOutLedger, amountIn, result, opts.outDecimals);
}

/** One load per relay per session — venue identity is not per-keystroke data. */
const VENUE_REGISTRY_CACHE = new Map<string, readonly VenueEntry[]>();

/** Settlement health (2026-09-20 SLA gate) is optional relay data: only a well-formed block
 *  is carried — absent or malformed is "never measured" (healthy by default, never invented). */
function sanitizeVenueHealth(h: unknown): VenueEntry['health'] {
  if (h == null || typeof h !== 'object') return undefined;
  const status = (h as {status?: unknown}).status;
  if (status !== 'ok' && status !== 'degraded') return undefined;
  const o = h as Record<string, unknown>;
  return {
    status,
    settle_seconds: typeof o.settle_seconds === 'number' ? o.settle_seconds : undefined,
    measured_at:
      typeof o.measured_at === 'number' || typeof o.measured_at === 'string' ? o.measured_at : undefined,
  };
}

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
      const rows = j.venues.filter(
        (v): v is VenueEntry =>
          v != null && typeof v === 'object'
            && typeof (v as VenueEntry).venue_id === 'string'
            && typeof (v as VenueEntry).display_name === 'string'
            && ((v as VenueEntry).kind === 'ic_amm' || (v as VenueEntry).kind === 'cefi' || (v as VenueEntry).kind === 'solana_amm')
            && typeof (v as VenueEntry).endpoint === 'string'
            && Array.isArray((v as VenueEntry).pair_ledgers)
            && (v as VenueEntry).pair_ledgers.length === 2
            && (v as VenueEntry).pair_ledgers.every(p => typeof p === 'string')
            && typeof (v as VenueEntry).testnet === 'boolean'
            && typeof (v as VenueEntry).disclosure_key === 'string',
      );
        // Health is OPTIONAL relay data (2026-09-20 settlement-SLA gate): only a well-formed
        // block is carried — anything else is "never measured". The demotion itself is the
        // relay's ROW ORDER (V5: the app never re-sorts); this flag feeds the slow line only.
        const venues = rows.map(v => ({...v, health: sanitizeVenueHealth((v as {health?: unknown}).health)}));
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
  };
}

/** Is the quote stale (auto-refresh trigger, spec §5: >30s)? Test-shrinkable via
 *  `__DPAY_TEST_CONVERT_STALE_MS` (the e2e flow must not sleep 30 real seconds). */
/** Staleness is a property of the ATTRIBUTION INSTANT, whatever the venue — the param is the
 *  structural minimum so the Solana surface (JupiterQuote) reuses the same clock + test seam. */
export function isQuoteStale(quote: {fetchedAtMs: number}, nowMs: number = Date.now()): boolean {
  const seam = (globalThis as unknown as {__DPAY_TEST_CONVERT_STALE_MS?: number}).__DPAY_TEST_CONVERT_STALE_MS;
  const threshold = seam ?? CONVERT_STALE_MS;
  return nowMs - quote.fetchedAtMs > threshold;
}
