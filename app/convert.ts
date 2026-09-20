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
import AsyncStorage from '@react-native-async-storage/async-storage';
import {DpayCore} from './services/native';
import {relayFetch} from './services/relay';
import {submitTransfer as railSubmitTransfer, fetchGasFeeWei, fetchLedgerFee, railBalanceOf} from './services/rail';
import {icStampExpiry} from './services/icp';
import {randNonceHex, rawToDecimal, toUnits} from './lib/format';
import {isValidDestinationAddress, BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from './config/catalog';
import {gasFundRoutes, type GasFundRoute, type HubRoute, type MultihopRoute} from './routes';import {
  CONVERT_APPROVE_LIFETIME_S,
  CONVERT_LEGACY_STORAGE_KEY,
  CONVERT_PROBE_WINDOW_ROWS,
  CONVERT_STALE_MS,
  CONVERT_UNSCOPED_STORAGE_KEY,
  CONVERT_ENGINE_TEST_OPTS,
  convertStoreKey,
} from './config/convert';
import {
  BUNDLED_VENUES,
  DPAY_CANISTER_PRINCIPALS,
  cefiOtherSide,
  icAmmVenueForPair,
  registeredVenues,
  setRuntimeVenues,
  venueDisplayName,
  venueEndpointOf,
  venueOfId,
  type VenueEntry,
} from './config/venues';
import {saveTxNote} from './services/txNotes';
import {fetchJupiterQuote, fetchJupiterSwapTx, type JupiterQuote} from './services/jupiter';
import {
  fetchSideShiftQuote,
  sideShiftStatusUrl,
  type SideShiftFixedShift,
  type SideShiftQuoteResult,
} from './services/sideshift';
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
import bs58 from 'bs58';
import {encodeApprove as encodeErc20Approve} from './cketh';
import {
  CCTP_DOMAIN_SOLANA,
  CCTP_FINALITY_FAST,
  TOKEN_MESSENGER_V2_ADDRESS,
  USDC_ERC20_ADDRESS,
  buildForwardHookData,
  cctpMaxFee,
  cctpMintFloor,
  encodeDepositForBurnWithHook,
  parseCctpBurnFees,
  parseCctpMessageStatus,
  type CctpBurnFee,
  type CctpMessageStatus,
} from './cctp';
import {
  getSolBlockHeight,
  getSolNativeCredit,
  getSolSignatureStatus,
  getSolTokenCredit,
  quoteSolMessageFee,
  submitRawSolTx,
} from './solana';
import {M} from './i18n';

/** The bundled registry's mainnet IC-AMM venue id — DERIVED, never a literal, so this module
 *  carries no venue id outside the registry (the v1-record migration fallback). Same derivation
 *  ConvertMode uses for its standing single-venue disclosure. */
const BUNDLED_MAINNET_VENUE_ID = BUNDLED_VENUES.find(v => v.kind === 'ic_amm' && !v.testnet)?.venue_id ?? '';

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
  result: SideShiftQuoteResult,
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
    result = await fetchSideShiftQuote(
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
              && ((v as VenueEntry).kind === 'ic_amm' || (v as VenueEntry).kind === 'cefi' || (v as VenueEntry).kind === 'solana_amm')
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

// --- the §4 state machine record -------------------------------------------------------------------

export type ConvertStep =
  | 'quote' | 'confirming' | 'approving' | 'approved' | 'swapping' | 'settling'
  | 'done' | 'pending_withdrawal' | 'failed_refunded' | 'failed_leg' | 'stuck'
  // The user's Stop tap (2026-09-19): the record freezes where it is and no driver ever
  // re-enters it. The body copy is derived from the legs (convertAbortFlavor).
  | 'aborted'
  // CeFi-shaped states (multi-venue readiness V2): round-tripped by hydration today; the
  // drivers that move a record INTO them arrive with the CeFi wave. Kept snake_case like
  // the rest of the persisted vocabulary.
  | 'awaiting_user_authorization' | 'awaiting_deposit' | 'provider_processing'
  | 'quote_expired' | 'provider_refunded'
  // The cross-rail widening (2026-09-16, Routes B/C): the CCTP phases that follow the
  // five IC legs. `awaiting_external` = the user's own EVM wallet must sign approve+burn
  // (dpay never holds EVM keys — the record waits on USER action, no driver advances it);
  // `crossing` = the burn tx hash is known and Circle's attestation/mint is being watched;
  // `sol_ready` = the USDC mint landed and is verified at the ATA, and the final Jupiter
  // leg is OFFERED for the user to confirm on a fresh quote (Route C only).
  | 'awaiting_external' | 'crossing' | 'sol_ready';

/** ONE signed IC update, frozen at prepare time. The executor only ever re-submits the
 *  envelope bytes; `argHex` is kept for audit/recovery, not re-signing. */
export type SignedLeg = {
  canister: string; // update target principal (the input ledger for the approve; the venue pool for the swap)
  method: string; // the update method ('icrc2_approve' | 'depositFromAndSwap' today)
  argHex: string; // '' only on legs migrated from a pre-legs record (its envelope froze the args)
  envelopeHex: string; // the SIGNED envelope bytes — the only thing retries re-submit
  requestIdHex: string; // the request id — the on-chain dedup key
  expiresAtMs: number; // ms form of this leg envelope's OWN ingress expiry — the certified-clock submit-death (the failure-screen countdown)
};

/** A CeFi provider's handle on an order it issued (the empty-legs record shape). */
export type ProviderRef = {
  orderId: string;
  statusUrl?: string;
};

/** The CeFi handoff facts (the SideShift widening, 2026-09-15): what the USER must do
 *  with their own funds, frozen at order creation and displayed VERBATIM. This is the
 *  honest CeFi boundary made data: `depositAddress` is the VENUE's own address — the
 *  user sends to it from their wallet, dpay signs nothing and holds nothing mid-trade.
 *  `depositAmount` is the EXACT figure the fixed order prices (a fixed shift settles
 *  only this deposit; anything else refunds). `depositMemo` must ride the deposit when
 *  the venue issues one (their wire: a deposit without its memo is lost). All strings
 *  are the provider's own, never reformatted. */
export type ProviderDeposit = {
  /** The venue's deposit address — where the USER sends. Not a dpay address, ever. */
  depositAddress: string;
  /** The venue's memo/tag when its wire requires one on the deposit. */
  depositMemo?: string;
  /** The exact deposit amount (decimal string, venue units) the fixed order prices. */
  depositAmount: string;
  /** When the order dies unfunded (ms; the venue's own expiresAt, parsed). */
  expiresAtMs?: number;
};

/** ONE signed Solana transaction — the Solana rail's widening of the leg vocabulary (Jupiter,
 *  2026-09-15; the per-leg protocol discriminator design: ONE record shape, per-leg protocol).
 *  A Solana venue does not hand the wallet two update calls to sign — it hands it ONE
 *  pre-assembled transaction around its route, so ONE leg is the whole truth. Field-for-field
 *  the SignedLeg analogs: `signedTxHex` is the envelopeHex (the only bytes retries re-submit —
 *  identical, chain-deduped), `signature` is the requestIdHex (the on-chain identity), and
 *  `lastValidBlockHeight` is the expiresAtMs (the venue-declared death of the tx's
 *  recent-blockhash: past that height the bytes can never land, and recovery NEVER resubmits
 *  them — it only watches). */
export type SolanaSwapLeg = {
  protocol: 'solana';
  /** The SIGNED transaction bytes, lowercase hex. Frozen at prepare; never re-signed. */
  signedTxHex: string;
  /** The transaction's base58 signature — its on-chain identity and dedup key. */
  signature: string;
  /** The last block height at which the tx's blockhash is still valid (Jupiter's own figure). */
  lastValidBlockHeight: number;
};

/** The cross-rail widening (2026-09-16, Routes B/C of the feasibility doc): what the
 *  record knows about the CCTP leg that follows the five IC legs. dpay builds the burn
 *  calldata and renders it for the USER's own EVM wallet to sign — no EVM key ever lives
 *  in dpay (the module header's non-negotiable). Durable facts only; everything else is
 *  re-derived from the record's own frozen numbers or fetched live:
 *  - the burn AMOUNT is the IC route's minOut (convertRecordMinOut — deterministic);
 *  - the mint RECIPIENT is deriveAta(solAddress, USDC mint), re-derived and re-verified
 *    at every handoff render;
 *  - Circle's fee is fetched live (at confirm for the census, again at handoff for the
 *    signed maxFee — the census copy says both). */
export type CrossRailInfo = {
  /** 'cctp' = Route B (ends at USDC on Solana); 'cctp_sol' = Route C (+ the Jupiter leg). */
  kind: 'cctp' | 'cctp_sol';
  /** The device-derived Solana address — the owner whose USDC ATA receives the mint. */
  solAddress: string;
  /** The USDC ATA (base58) the burn names as its mint recipient (display + the credit
   *  verification's account). Frozen at prepare; re-derivation must match or the handoff
   *  refuses to render. */
  mintRecipientAta: string;
  /** Circle's fee census AT CONFIRM (maxFee incl. the 20% buffer, USDC base units) and
   *  the honest mint floor it implies. The signed maxFee is re-fetched live at handoff. */
  maxFeeSubunits?: string;
  mintFloorSubunits?: string;
  /** The Ethereum burn tx hash once the user's wallet has signed (the status-watch key). */
  burnTxHash?: string;
  /** Circle's destination forward tx (a Solana signature) once the mint executed. */
  forwardTxHash?: string;
  /** The VERIFIED USDC credit at the ATA when the mint landed (SOL-rail read). */
  mintSubunits?: string;
  /** Route C's final leg: the registered Jupiter venue id (frozen at prepare from the
   *  route — the record's own `venueId` stays the IC venue the five legs traded on). */
  solVenueId?: string;
  /** The Jupiter leg's own min-out floor (lamports), frozen when the leg is signed.
   *  The native-SOL shape — an SPL-out record freezes `solExpectedSubunits` instead,
   *  and the two shapes are mutually exclusive (hydration refuses both). */
  solExpectedLamports?: string;
  /** The SPL-out widening (2026-09-19, any registered USDC↔token venue — e.g. EURC):
   *  the final leg's OUT mint + its decimals, frozen at prepare from the route. Absent
   *  on a native-SOL record — the out mint is WRAPPED_SOL_MINT_ADDRESS by construction
   *  there. All optional, so native-SOL records keep their exact bytes. */
  solOutMint?: string;
  solOutDecimals?: number;
  /** The Jupiter leg's own min-out floor for an SPL out, in the OUT MINT's base units,
   *  frozen when the leg is signed. Requires solOutMint+solOutDecimals (hydration). */
  solExpectedSubunits?: string;
};

/** ONE gas-FUNDING pre-leg (2026-09-20, the cross-rail gas widening): the frozen facts of
 *  the ordinary approve+swap pair that moves an in-wallet IC asset INTO the gas ledger
 *  (ckETH) ahead of the route's own legs. Exactly the hub-leg shape plus the two signed
 *  amounts — no new leg kind, no new arg builder (the mandate's red line). */
export type GasFundPreLeg = {
  venueId: string;
  pool: string;
  fromLedger: string;
  toLedger: string;
  /** The raw amount the pre-swap pulls (the approve covers this + the from-ledger fee). */
  inAmount: string;
  /** The leg's own slippage floor (raw out-units of `toLedger`) — leg i+1 is QUOTED on
   *  leg i's minOut, the same compounding-floor rule the hub record freezes. */
  minOut: string;
};

/** The record's frozen `gasPre` block: the funding target (fresh feeWei + 20% headroom at
 *  prepare, the CCTP forward-fee buffer convention) and the pre-legs IN ORDER — leg i's
 *  toLedger is leg i+1's fromLedger, the last lands on the burn route's gasLedger. */
export type GasFundPlan = {
  neededWei: string;
  legs: GasFundPreLeg[];
};

/** What resolution hands the SIGNER, on top of the frozen record shape: each pre-leg's
 *  live direction flag (read per quote, never assumed) and the two ledger fees the
 *  approve/swap args carry. The record stores only the frozen `GasFundPlan` subset. */
export type ResolvedGasFundPlan = GasFundPlan & {
  legs: Array<GasFundPreLeg & {zeroForOne: boolean; fromFee: string; toFee: string}>;
};

export type ConvertRecord = {
  id: string;
  createdAtMs: number;
  step: ConvertStep;
  venueId: string; // WHICH venue executes (registry key — facts are looked up, never assumed)
  /** IC-catalog currency ids of the in/out assets. Absent on a Solana-shaped record
   *  (`solanaLeg`): the Solana rail has no numeric catalog currency — `inLedger`/`outLedger`
   *  carry the MINTS and the symbols carry the display. */
  inCurrency?: number;
  outCurrency?: number;
  /** IC records: ledger principals. Solana records: MINTS (wrapped-SOL for native SOL). */
  inLedger: string;
  outLedger: string;
  inSymbol: string; // backing native symbol for copy ("which asset the user holds")
  outSymbol: string;
  /** Each leg's ledger decimals, frozen at prepare (ADDITIVE, 2026-09-11): the state screens
   *  format `amountIn`/payouts/min-out through THEM, never a hardcoded 8. Records prepared
   *  before the field existed (and every legacy-migrated v1 record) carry none — renderers
   *  fall back to 8, the e8s world those records were signed in (every ledger the venue
   *  registry serves today is 8-decimal anyway). */
  inDecimals?: number;
  outDecimals?: number;
  amountIn: string; // raw e8s the venue pulls (raw in-units for Solana — lamports for SOL)
  expectedGross: string; // venue quote at confirm (gross)
  expectedNet: string; // gross − output fee (the end-state line); on Solana: the venue's own min-out floor
  inFee: string;
  outFee: string;
  slippageBps: number;
  legs: SignedLeg[]; // the signed updates, in submission order; EMPTY for a CeFi-shaped record
  /** The Solana widening (2026-09-15): ONE signed Solana swap transaction, present iff the
   *  record is Solana-shaped (mutually exclusive with legs>0, legPlan, and providerRef —
   *  hydration pins all three). `inFee`/`outFee` are '0' on this shape (no ledger fees); the
   *  Solana network fee is a separate fact (`solFeeLamports`, paid in SOL by the fee payer). */
  solanaLeg?: SolanaSwapLeg;
  /** The realized Solana network fee quote for the swap tx (lamports, SOL-paid), frozen at
   *  prepare — the honest fee line on the Solana done/failure screens. */
  solFeeLamports?: string;
  /** The multi-hop widening (2026-09-14 spec §3): a parallel per-leg plan, ADDITIVE — direct
   *  2-leg records carry none and keep their exact historical bytes and behavior. Present
   *  iff the record was prepared as a route; same length as `legs` on an IC-only route
   *  (Route A), or `legs` + the cctp_burn (+ sol_swap) entries on a cross-rail route. */
  legPlan?: LegPlan[];
  /** Route facts a failure/done screen must name (spec §4): the destination address the
   *  burn leg signed, the symbol + network that arrive there, and the hop asset the user
   *  holds in-wallet if the route dies mid-way. */
  destAddress?: string;
  destSymbol?: string;
  destNetwork?: string;
  hopLedger?: string;
  hopSymbol?: string;
  hopCurrency?: number;
  hopDecimals?: number;
  gasSymbol?: string; // the gas token's display symbol (ckETH) — the gas leg's census units
  gasDecimals?: number;
  /** The minter's live gas quote the approve_gas leg signed, plus the swap hop's venue fee
   *  tier (echoed verbatim from the quote — the leg census renders it as the swap leg's fee). */
  gasFeeWei?: string;
  feeMillionths?: number;
  /** Durable identity of the hop-ledger payout row that confirmed the swap leg (the
   *  ledger-watch evidence — never the #ok alone, spec §4). Set when the row is SEEN. */
  hopTx?: string;
  /** The IC hub 2-hop widening (2026-09-18, spec §11): the SECOND swap's facts — its venue,
   *  the destination ledger, and the quote figures its own watch + min-out derive from.
   *  Present iff the record was prepared on a hub route (legPlan = approve/swap/approve/swap).
   *  All optional: direct + Route A/B/C records never carry them (byte-identical history). */
  venue2Id?: string;
  destLedger?: string;
  destCurrency?: number;
  destDecimals?: number;
  destFee?: string; // the DEST ledger's own transfer fee — swap2's out fee
  expectedGross2?: string; // quote2's gross (quoted on minOut1 as its input — the compounding floor)
  expectedNet2?: string; // gross2 − destFee
  feeMillionths2?: number; // venue2's own fee tier, echoed verbatim
  /** Durable identity of the DEST-ledger payout row that confirmed swap2 — `outTx`'s twin
   *  for a hub record (whose `out*` fields name the HUB, the first watchable ledger). */
  destTx?: string;
  providerRef?: ProviderRef; // required when legs is empty; ignored otherwise
  /** The CeFi handoff block — present iff the record was prepared as a CeFi order
   *  (empty legs + providerRef): the venue's deposit facts the state screen shows
   *  verbatim. Hydration validates it exactly like the record's other money fields. */
  providerDeposit?: ProviderDeposit;
  outAmountNet?: string; // actually-received amount (from the ledger row) when done
  outTx?: string; // durable identifier of the incoming output-ledger row when done
  /** Durable identity of the input-ledger refund row a `failed_refunded` resolution consumed —
   *  the record's CLAIM on that row, so a sibling record's probe can never match the same
   *  refund twice (the refund-side twin of `outTx`). */
  refundTx?: string;
  /** Set by the USER's acknowledge tap on a `stuck` record (V6): the outcome is unknown, the
   *  user has read the instructions, and the background watch may stop. Until it is set, an
   *  expired-unconfirmed stuck record keeps being probed at the engine's slow cadence. */
  acknowledgedStuckAtMs?: number;
  /** Set when the USER taps Stop (2026-09-19): the record freezes where it is. What the stop
   *  cost is derived from the legs (convertAbortFlavor), not stored. */
  abortedAtMs?: number;
  /** The step the record sat at when Stop was tapped. The abort rewrites `step` to 'aborted',
   *  which erases the flight position a DIRECT record's stop cost is derived from (its legs
   *  carry no legPlan states — convertAbortFlavor reads this instead). Planned and Solana
   *  records never need it: their flavor reads survive the rewrite untouched. */
  abortedFromStep?: ConvertStep;
  /** The cross-rail block (Routes B/C): present iff the record was prepared on a route with
   *  a CCTP leg; extends the five IC legs with the external-signature burn and (Route C)
   *  the final Jupiter leg. */
  crossRail?: CrossRailInfo;
  /** The gas-fund widening (2026-09-20): present iff the intent was prepared WITH gas
   *  funding — the pre-legs are the FIRST entries of `legs`/`legPlan` (two per pre-leg,
   *  approve then swap), and the executor re-checks the ACTUAL in-wallet gas-ledger
   *  balance against `neededWei` before the approve_gas leg may run. Hydration pins the
   *  whole shape (legs.length === pre-legs×2 + 5, the approve/swap rhythm, the ledger
   *  chain). Absent on every record this build wrote before it — byte-identical history. */
  gasPre?: GasFundPlan;
  failureCode?: 'approve_refused' | 'swap_refused' | 'refunded' | 'withdraw_refused' | 'unknown'
    // The cross-rail additions: the user declined/abandoned the external signing step
    // (funds sit as USDC at their OWN EVM address — the copy names it).
    | 'external_declined'
    // The gas-fund addition: the funding did not deliver (a pre-leg refused, or the
    // post-pre-leg balance re-check came up short) — the MAIN conversion has not started
    // and every source value sits in-wallet. The failed card names the shortfall.
    | 'gas_short';
  failureDetail?: string;
};

/** What one leg of a route DOES (the label key for copy + the executor's decode dispatch).
 *  Wave-1 vocabulary (docs/specs/2026-09-14-multihop-conversion-spec.md §1): the two approve
 *  kinds share 'approve' — which asset is being approved for whom is the leg's canister +
 *  position, never a third kind. The cross-rail widening (2026-09-16): `cctp_burn` is an
 *  EXTERNAL-signature leg (no device signature — it tracks the user's own EVM wallet tx,
 *  its hash, and Circle's mint status; `canister` is '' because no IC canister is called)
 *  and `sol_swap` is the final device-signed Jupiter leg (same shape the standalone Solana
 *  convert signs — `canister` '' likewise). */
export type LegKind = 'approve' | 'swap' | 'approve_gas' | 'withdraw_erc20' | 'cctp_burn' | 'sol_swap';

/** One leg's completion state. `sent` ≠ `pending` only in what the USER sees — both resume
 *  by re-submitting the identical envelope bytes (request_id dedup makes that safe); the
 *  split exists so the progress list can show "sent, waiting" honestly. */
export type LegState = 'pending' | 'sent' | 'confirmed' | 'failed';

/** The executor's parallel per-leg view of a multi-hop record: same length and order as
 *  `legs`, one entry per signed update. `fee` is the leg's OWN transaction fee on its own
 *  ledger (the approve fees; '' where none is charged — the swap's pool tier lives on the
 *  record as `feeMillionths`, the withdraw itself charges nothing). */
export type LegPlan = {
  kind: LegKind;
  canister: string;
  fee: string;
  state: LegState;
};

const CONVERT_STEPS: ConvertStep[] = [
  'quote', 'confirming', 'approving', 'approved', 'swapping', 'settling',
  'done', 'pending_withdrawal', 'failed_refunded', 'failed_leg', 'stuck',
  'awaiting_user_authorization', 'awaiting_deposit', 'provider_processing',
  'quote_expired', 'provider_refunded',
  'awaiting_external', 'crossing', 'sol_ready', 'aborted',
];

/** The steps a cross-rail record (`crossRail`) may sit at: the IC phases (driven by the
 *  planned executor as always), the three cross-rail phases, the shared Solana-swap
 *  phases (Route C's final leg reuses `swapping`/`settling` once `solanaLeg` is set), and
 *  the shared terminals. Hydration pins a crossRail-bearing record to this vocabulary. */
const CROSSRAIL_CONVERT_STEPS: ReadonlySet<ConvertStep> = new Set([
  'approving', 'pending_withdrawal', 'awaiting_external', 'crossing', 'sol_ready',
  'swapping', 'settling', 'done', 'failed_refunded', 'failed_leg', 'stuck',
  'aborted',
]);

/** The steps a legs==0 (CeFi-shaped) record may sit at: the provider driver's own vocabulary,
 *  start to terminal. Every OTHER step is an IC-legs step — a legless record there is
 *  malformed-by-construction (the IC executor has no legs to submit and the provider driver's
 *  transition matrix can never move it), so hydration refuses it rather than arm the resume
 *  engine's eternal no-op poll. */
const PROVIDER_CONVERT_STEPS: ReadonlySet<ConvertStep> = new Set([
  'awaiting_user_authorization', 'awaiting_deposit', 'provider_processing',
  'done', 'quote_expired', 'provider_refunded',
  'aborted',
]);

/** The provider vocabulary WITHOUT `done` (the one terminal shared by both drivers). A
 *  legs-bearing record parked here is malformed-by-construction — see hydrateOneRecord. */
const PROVIDER_ONLY_STEPS: ReadonlySet<ConvertStep> = new Set([
  'awaiting_user_authorization', 'awaiting_deposit', 'provider_processing',
  'quote_expired', 'provider_refunded',
]);

/** The steps a Solana-shaped record (`solanaLeg`) may sit at: the Solana driver's own
 *  vocabulary, start to terminal. There is no approve state (nothing to approve — the venue's
 *  tx is the whole route) and no provider states. Prepare lands at `swapping` with the leg
 *  already signed; anything else driverless fails hydration, same rule as the other two
 *  vocabularies. */
const SOLANA_CONVERT_STEPS: ReadonlySet<ConvertStep> = new Set([
  'swapping', 'settling', 'done', 'pending_withdrawal', 'failed_refunded', 'stuck',
  'aborted',
]);

/** The min-out a record's swap leg signed, re-derived from the record's OWN frozen quote and
 *  slippage through the compiled core — deterministic, so this is the same figure
 *  `prepareConvertRecord` baked into the arg, not a new opinion. The hub widening (2026-09-18,
 *  spec §11) adds the leg discriminator: ONE derivation rule PER swap leg — leg 2's floor is
 *  its OWN frozen gross (`expectedGross2`, quoted on leg 1's min-out) × (1−slippage), floors
 *  only, never an expected gross. A hub record always carries expectedGross2 (hydration
 *  refuses otherwise); anything else is a caller bug and throws fail-closed. */
export async function convertRecordMinOut(record: ConvertRecord, swapLeg: 1 | 2 = 1): Promise<string> {
  const gross = swapLeg === 2 ? record.expectedGross2 : record.expectedGross;
  if (gross == null) throw new Error('record carries no quote for that swap leg');
  return DpayCore.icpSwapMinOut(gross, record.slippageBps);
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
  // the bundled registry's mainnet IC-AMM id as the honest fallback if the registry no longer
  // lists it (derived the same way ConvertMode derives REGISTERED_VENUE_ID — the literal
  // 'icpswap' this line used to carry was the one hardcoded venue id outside the registry).
  const venueId = icAmmVenueForPair(inLedger, outLedger)?.venue_id ?? BUNDLED_MAINNET_VENUE_ID;
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
    // The payout destination facts (planned records set them via the plan; the CEFI record
    // sets them directly — the venue pays out to the user's own settle address).
    destAddress: str('destAddress') ?? undefined,
    destSymbol: str('destSymbol') ?? undefined,
    outAmountNet: str('outAmountNet') ?? undefined,
    outTx: str('outTx') ?? undefined,
    refundTx: str('refundTx') ?? undefined,
    failureDetail: str('failureDetail') ?? undefined,
  };
  if (typeof r.createdAtMs !== 'number') return null;
  rec.createdAtMs = r.createdAtMs;
  // IC records carry numeric catalog currency ids; a Solana-shaped record has none to carry
  // (the Solana rail keys assets by mint + symbol). Parsed when present, REQUIRED below for
  // the IC shapes — the discriminator is `solanaLeg`, parsed after the legs. The CEFI
  // widening (2026-09-15): the two parse INDEPENDENTLY — a cefi provider record legitimately
  // carries the IC deposit side's id and NO out id (SOL is not an IC catalog currency; the
  // provider driver advances it by statusUrl alone). Every non-cefi shape still needs BOTH,
  // enforced where the requirement has always lived (the gate below), so this changes no
  // verdict except the cefi half-pair's survival.
  if (r.inCurrency != null) {
    if (typeof r.inCurrency !== 'number') return null;
    rec.inCurrency = r.inCurrency;
  }
  if (r.outCurrency != null) {
    if (typeof r.outCurrency !== 'number') return null;
    rec.outCurrency = r.outCurrency;
  }
  if (typeof r.slippageBps !== 'number') return null;
  rec.slippageBps = r.slippageBps;
  if (!CONVERT_STEPS.includes(r.step as ConvertStep)) return null;
  rec.step = r.step as ConvertStep;
  if (typeof r.acknowledgedStuckAtMs === 'number') rec.acknowledgedStuckAtMs = r.acknowledgedStuckAtMs;
  if (typeof r.abortedAtMs === 'number') rec.abortedAtMs = r.abortedAtMs;
  if (typeof r.abortedFromStep === 'string' && (CONVERT_STEPS as string[]).includes(r.abortedFromStep)) {
    rec.abortedFromStep = r.abortedFromStep as ConvertStep;
  }
  if (typeof r.inDecimals === 'number') rec.inDecimals = r.inDecimals;
  if (typeof r.outDecimals === 'number') rec.outDecimals = r.outDecimals;
  if (r.failureCode != null && !['approve_refused', 'swap_refused', 'refunded', 'withdraw_refused', 'unknown', 'external_declined', 'gas_short'].includes(r.failureCode as string)) return null;
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
  // The CROSS-RAIL block (2026-09-16, Routes B/C): present iff the route composed a CCTP
  // leg. Parsed before the plan so the plan/legs parallelism check can key on its shape.
  // Durable facts only — kind, the two frozen addresses, and the observed tx hashes /
  // verified credit as they arrive. A record carrying it must live in the cross-rail
  // vocabulary (the IC phases + the three cross-rail phases + the shared terminals), or
  // the resume engine would arm a poll no driver can advance — the same rule every other
  // widening applies.
  let crossRail: CrossRailInfo | undefined;
  if (r.crossRail != null) {
    const c = r.crossRail as Record<string, unknown>;
    if (!c || typeof c !== 'object') return null;
    if (c.kind !== 'cctp' && c.kind !== 'cctp_sol') return null;
    if (typeof c.solAddress !== 'string' || c.solAddress.length === 0) return null;
    if (typeof c.mintRecipientAta !== 'string' || c.mintRecipientAta.length === 0) return null;
    const optStr = (k: string): string | undefined =>
      (typeof c[k] === 'string' && (c[k] as string).length > 0 ? c[k] as string : undefined);
    if (!CROSSRAIL_CONVERT_STEPS.has(rec.step)) return null;
    // The SPL-out widening (2026-09-19): the out mint + its decimals travel TOGETHER,
    // the frozen subunit floor requires both, and the two floor shapes — native lamports
    // vs SPL subunits of the out mint — are mutually exclusive. Any other pairing is a
    // shape this build never wrote (fail closed); every field stays optional, so legacy
    // native-SOL records hydrate byte-identically.
    const solExpectedLamports = optStr('solExpectedLamports');
    const solOutMint = optStr('solOutMint');
    const solOutDecimals =
      typeof c.solOutDecimals === 'number' && Number.isSafeInteger(c.solOutDecimals) && c.solOutDecimals >= 0
        ? c.solOutDecimals
        : undefined;
    const solExpectedSubunits = optStr('solExpectedSubunits');
    if ((solOutMint != null) !== (solOutDecimals != null)) return null;
    if (solExpectedSubunits != null && (solOutMint == null || solExpectedLamports != null)) return null;
    if (solOutMint != null && solExpectedLamports != null) return null;
    crossRail = {
      kind: c.kind,
      solAddress: c.solAddress,
      mintRecipientAta: c.mintRecipientAta,
      maxFeeSubunits: optStr('maxFeeSubunits'),
      mintFloorSubunits: optStr('mintFloorSubunits'),
      burnTxHash: optStr('burnTxHash'),
      forwardTxHash: optStr('forwardTxHash'),
      mintSubunits: optStr('mintSubunits'),
      solVenueId: optStr('solVenueId'),
      solExpectedLamports,
      ...(solOutMint != null && solOutDecimals != null ? {solOutMint, solOutDecimals} : {}),
      ...(solExpectedSubunits != null ? {solExpectedSubunits} : {}),
    };
    rec.crossRail = crossRail;
  }
  // The IC-AMM shape the executor drives is exactly TWO legs — the icrc2_approve on the input
  // ledger, then the venue's depositFromAndSwap. A record with legs but fewer than two cannot be
  // resumed by any driver this build ships, so it fails hydration rather than crash mid-retry.
  // THE MULTI-HOP WIDENING (2026-09-14 spec §3, the line the old comment promised would widen):
  // a PLANNED record carries `legPlan`, a parallel array — one entry per leg, same length,
  // ≥2 — and is driven leg-by-leg by the planned executor. The direct 2-leg shape (legPlan
  // absent) is untouched: same bytes, same behavior, same hydration verdicts as always.
  let legPlan: LegPlan[] | undefined;
  if (r.legPlan != null) {
    if (!Array.isArray(r.legPlan)) return null;
    const kinds: LegKind[] = ['approve', 'swap', 'approve_gas', 'withdraw_erc20', 'cctp_burn', 'sol_swap'];
    const states: LegState[] = ['pending', 'sent', 'confirmed', 'failed'];
    const parsed: LegPlan[] = [];
    for (const p of r.legPlan) {
      if (!p || typeof p !== 'object') return null;
      const q = p as Record<string, unknown>;
      if (typeof q.kind !== 'string' || !kinds.includes(q.kind as LegKind)) return null;
      if (typeof q.state !== 'string' || !states.includes(q.state as LegState)) return null;
      // The IC kinds target an IC canister (non-empty). The cross-rail kinds call NO IC
      // canister — the external-signature leg's "target" is the user's own wallet — so
      // their canister is '' by construction; anything else is a shape this build never
      // wrote.
      const externalKind = q.kind === 'cctp_burn' || q.kind === 'sol_swap';
      if (externalKind ? q.canister !== '' : (typeof q.canister !== 'string' || !q.canister)) return null;
      if (typeof q.fee !== 'string') return null;
      parsed.push({kind: q.kind as LegKind, state: q.state as LegState, canister: q.canister as string, fee: q.fee});
    }
    // The cross-rail block is parsed ABOVE so the plan/legs parallelism can key on
    // its shape: an IC-only plan is exactly parallel to `legs` (same length, ≥2); a
    // cross-rail plan extends it by one cctp_burn entry and (Route C) one sol_swap entry,
    // in that order, after the withdraw_erc20. Any other length pairing is corrupt.
    if (crossRail != null) {
      const expected = legs.length + 1 + (crossRail.kind === 'cctp_sol' ? 1 : 0);
      if (parsed.length !== expected || parsed.length < 3) return null;
      const tail = parsed.slice(legs.length).map(p => p.kind);
      if (tail[0] !== 'cctp_burn') return null;
      if (crossRail.kind === 'cctp_sol' && tail[1] !== 'sol_swap') return null;
    } else if (parsed.length !== legs.length || parsed.length < 2) return null;
    // The HUB shape (2026-09-18, spec §11): exactly four IC legs in the approve/swap/approve/
    // swap order. Its destination is the user's own principal on the dest IC ledger —
    // `destAddress` is NOT part of this shape — but every number its executor, watch, and
    // min-out re-derivation need must be frozen on the record. A swap2 the record cannot
    // watch or re-price is corrupt: refuse the quadrant, never improvise a number.
    const isHubPlan = legs.length === 4
      && parsed[0].kind === 'approve' && parsed[1].kind === 'swap'
      && parsed[2].kind === 'approve' && parsed[3].kind === 'swap';
    // A planned record must be able to name its destination and its hop asset — every state
    // screen it can ever render keys off those facts (spec §4: name what the user holds,
    // where the exit is). A plan that cannot be NAMED fails hydration, like every other
    // shape that would render a nameless screen.
    const hopStr = (k: 'destAddress' | 'destSymbol' | 'destNetwork' | 'hopLedger' | 'hopSymbol' | 'destLedger' | 'venue2Id' | 'expectedGross2' | 'expectedNet2' | 'destFee'): string | null =>
      typeof r[k] === 'string' && (r[k] as string).length > 0 ? r[k] as string : null;
    if (hopStr('destSymbol') == null || hopStr('destNetwork') == null
      || hopStr('hopLedger') == null || hopStr('hopSymbol') == null) return null;
    if (typeof r.hopCurrency !== 'number' || typeof r.hopDecimals !== 'number') return null;
    if (isHubPlan) {
      if (hopStr('destLedger') == null || hopStr('venue2Id') == null
        || hopStr('expectedGross2') == null || hopStr('expectedNet2') == null
        || hopStr('destFee') == null) return null;
      const destCurrency = r.destCurrency;
      const destDecimals = r.destDecimals;
      const feeMillionths2 = r.feeMillionths2;
      if (typeof destCurrency !== 'number' || typeof destDecimals !== 'number'
        || typeof feeMillionths2 !== 'number') return null;
      if (r.destTx != null && (typeof r.destTx !== 'string' || (r.destTx as string).length === 0)) return null;
    } else if (hopStr('destAddress') == null) return null;
    legPlan = parsed;
    rec.legPlan = legPlan;
    if (isHubPlan) {
      rec.destLedger = hopStr('destLedger') ?? undefined;
      rec.destCurrency = r.destCurrency as number;
      rec.destDecimals = r.destDecimals as number;
      rec.destFee = hopStr('destFee') ?? undefined;
      rec.venue2Id = hopStr('venue2Id') ?? undefined;
      rec.expectedGross2 = hopStr('expectedGross2') ?? undefined;
      rec.expectedNet2 = hopStr('expectedNet2') ?? undefined;
      rec.feeMillionths2 = r.feeMillionths2 as number;
      if (r.destTx != null) rec.destTx = r.destTx as string;
    } else {
      rec.destAddress = hopStr('destAddress') ?? undefined;
    }
    rec.destSymbol = hopStr('destSymbol') ?? undefined;
    rec.destNetwork = hopStr('destNetwork') ?? undefined;
    rec.hopLedger = hopStr('hopLedger') ?? undefined;
    rec.hopSymbol = hopStr('hopSymbol') ?? undefined;
    rec.hopCurrency = r.hopCurrency;
    rec.hopDecimals = r.hopDecimals;
    if (typeof r.gasFeeWei === 'string') rec.gasFeeWei = r.gasFeeWei;
    if (typeof r.gasSymbol === 'string') rec.gasSymbol = r.gasSymbol;
    if (typeof r.gasDecimals === 'number') rec.gasDecimals = r.gasDecimals;
    if (typeof r.hopTx === 'string') rec.hopTx = r.hopTx;
    if (typeof r.feeMillionths === 'number') rec.feeMillionths = r.feeMillionths;
    // The GAS-FUND block (2026-09-20), fail-closed: digit strings only, every leg's six
    // facts non-empty, the ledger chain unbroken, and the plan/legs rhythm pinned — the
    // pre-legs are approve+swap PAIRS ahead of the route's five IC legs. A legacy record
    // carries no gasPre at all (byte-identical history); a gasPre without a plan (or any
    // malformed shape) is a shape this build never wrote — dropped below.
    if (r.gasPre != null) {
      const g = r.gasPre as Record<string, unknown>;
      if (g == null || typeof g !== 'object' || Array.isArray(g)) return null;
      if (typeof g.neededWei !== 'string' || !/^\d+$/.test(g.neededWei)) return null;
      if (!Array.isArray(g.legs) || g.legs.length === 0) return null;
      const preLegs: GasFundPreLeg[] = [];
      for (const pl of g.legs) {
        if (pl == null || typeof pl !== 'object' || Array.isArray(pl)) return null;
        const p = pl as Record<string, unknown>;
        for (const k of ['venueId', 'pool', 'fromLedger', 'toLedger', 'inAmount', 'minOut']) {
          if (typeof p[k] !== 'string' || (p[k] as string).length === 0) return null;
        }
        if (!/^\d+$/.test(p.inAmount as string) || !/^\d+$/.test(p.minOut as string)) return null;
        preLegs.push({
          venueId: p.venueId as string, pool: p.pool as string,
          fromLedger: p.fromLedger as string, toLedger: p.toLedger as string,
          inAmount: p.inAmount as string, minOut: p.minOut as string,
        });
      }
      for (let pi = 0; pi < preLegs.length - 1; pi += 1) {
        if (preLegs[pi]!.toLedger !== preLegs[pi + 1]!.fromLedger) return null;
      }
      if (legs.length !== preLegs.length * 2 + 5) return null;
      for (let pi = 0; pi < preLegs.length; pi += 1) {
        if (parsed[pi * 2]?.kind !== 'approve' || parsed[pi * 2 + 1]?.kind !== 'swap') return null;
      }
      rec.gasPre = {neededWei: g.neededWei, legs: preLegs};
    }
  } else if (legs.length > 0 && legs.length !== 2) return null;
  if (r.gasPre != null && rec.gasPre == null) return null; // gasPre rides a PLANNED record only
  // The SOLANA WIDENING (2026-09-15): `solanaLeg` — ONE signed Solana transaction. Mutually
  // exclusive with legs>0, legPlan, and providerRef (a record is exactly ONE of the three
  // shapes); when present, `legs` must be empty and the step must be in the Solana driver's
  // vocabulary, or the resume engine would arm a poll no driver can advance.
  // The CROSS-RAIL exception (2026-09-16, Route C): the record's five IC legs are all
  // confirmed when the final Jupiter leg is signed, so `solanaLeg` coexists WITH legs and
  // the plan — exactly on a crossRail-bearing record (never on Route A, whose terminal is
  // done, and never standalone). The step then lives in the cross-rail vocabulary.
  let solanaLeg: SolanaSwapLeg | undefined;
  if (r.solanaLeg != null) {
    if (legs.length > 0 || legPlan != null) {
      if (crossRail == null) return null;
    }
    const s = r.solanaLeg as Record<string, unknown>;
    if (!s || typeof s !== 'object' || s.protocol !== 'solana') return null;
    if (typeof s.signedTxHex !== 'string' || s.signedTxHex.length === 0) return null;
    if (typeof s.signature !== 'string' || s.signature.length === 0) return null;
    if (typeof s.lastValidBlockHeight !== 'number' || !Number.isSafeInteger(s.lastValidBlockHeight) || s.lastValidBlockHeight <= 0) return null;
    if (crossRail == null && !SOLANA_CONVERT_STEPS.has(rec.step)) return null;
    solanaLeg = {
      protocol: 'solana',
      signedTxHex: s.signedTxHex,
      signature: s.signature,
      lastValidBlockHeight: s.lastValidBlockHeight,
    };
    rec.solanaLeg = solanaLeg;
    if (typeof r.solFeeLamports === 'string' && /^\d+$/.test(r.solFeeLamports)) {
      rec.solFeeLamports = r.solFeeLamports;
    }
  }
  // A legs>0 record parked at `quote`/`confirming` is a shape no driver can advance: the
  // executor only knows approving→approved→swapping→settling→pending_withdrawal, so the resume
  // engine would re-arm a no-op drive forever with no escape (the unreachable-by-construction
  // quadrant — prepare lands at `approving` with legs already signed). Refuse the record like
  // any other malformed one rather than wedge the watcher.
  if (legs.length > 0 && (rec.step === 'quote' || rec.step === 'confirming')) return null;
  // The mirror quadrant: a legs-bearing record at a PROVIDER-only step (every step of the
  // provider vocabulary except the shared terminal `done`) is equally driverless — the IC
  // executor's transition set never visits those steps and the provider driver never picks a
  // record with legs — so the same eternal no-op poll would arm. Refuse it the same way.
  if (legs.length > 0 && PROVIDER_ONLY_STEPS.has(rec.step)) return null;
  if (legs.length === 0 && solanaLeg == null) {
    const pr = r.providerRef;
    if (!pr || typeof pr !== 'object' || typeof (pr as Record<string, unknown>).orderId !== 'string') return null;
    const statusUrl = (pr as Record<string, unknown>).statusUrl;
    rec.providerRef = statusUrl == null
      ? {orderId: (pr as Record<string, unknown>).orderId as string}
      : {orderId: (pr as Record<string, unknown>).orderId as string, statusUrl: String(statusUrl)};
    // The CeFi handoff block (SideShift widening, 2026-09-15): optional but when present
    // it must be the whole truth — a corrupt or half-written deposit block on a record
    // the deposit screen renders verbatim is a money-adjacent lie, so refuse the record.
    // (Persisted by prepareCeFiConvertRecord only, always complete.)
    const pd = r.providerDeposit;
    if (pd != null) {
      if (typeof pd !== 'object') return null;
      const pdR = pd as Record<string, unknown>;
      const addr = pdR.depositAddress;
      const amt = pdR.depositAmount;
      const memo = pdR.depositMemo;
      const exp = pdR.expiresAtMs;
      if (typeof addr !== 'string' || addr.length === 0) return null;
      if (typeof amt !== 'string' || amt.length === 0) return null;
      if (memo != null && typeof memo !== 'string') return null;
      if (exp != null && (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= 0)) return null;
      rec.providerDeposit = {
        depositAddress: addr,
        depositAmount: amt,
        ...(memo != null ? {depositMemo: memo} : {}),
        ...(exp != null ? {expiresAtMs: exp} : {}),
      };
    }
    // A legless record lives ONLY in the provider vocabulary (the driver's transition matrix
    // starts at awaiting_* and ends at done/quote_expired/provider_refunded). At any IC-driver
    // step (approving/swapping/settling/…) it is malformed-by-construction: the IC executor
    // has no legs to submit and the provider driver can never transition those steps, so the
    // resume engine would arm an eternal no-op poll. Refuse it like any other malformed
    // record — salvage drops it, it does not brick the store.
    if (!PROVIDER_CONVERT_STEPS.has(rec.step)) return null;
  }
  for (const k of ['id', 'venueId', 'inSymbol', 'outSymbol', 'inLedger', 'outLedger', 'amountIn',
    'expectedGross', 'expectedNet', 'inFee', 'outFee'] as const) {
    if (rec[k] == null) return null;
  }
  // The IC shapes (legs>0 or providerRef) name their assets by numeric catalog currency — the
  // ledger-watch probes key on those ids. A Solana record is exempt (mint + symbol are its
  // identifiers); every legacy/historical IC record always carried them, so this cannot orphan
  // real history. A cross-rail record carries IC legs too — it always names both currencies.
  // The CEFI widening (2026-09-15): a cefi providerRef record's OUT side may live on another
  // rail entirely (ICP → SOL: there IS no numeric catalog currency for SOL) — and it needs
  // none, because the provider driver advances it by statusUrl alone, never a ledger watch.
  // Its identifiers are the ledger/mint pair + symbols, already enforced above.
  // (venueId was null-checked in the loop above; the `?? ''` is for the type-narrower —
  // venueOfId('') resolves no venue, so the classification is still fail-closed.)
  const cefiProviderRecord = legs.length === 0 && solanaLeg == null
    && venueOfId(rec.venueId ?? '')?.kind === 'cefi';
  if ((solanaLeg == null || crossRail != null) && !cefiProviderRecord
    && (rec.inCurrency == null || rec.outCurrency == null)) return null;
  if (rec.id !== id) return null;
  const full = rec as ConvertRecord;
  out[id] = full;
  return full;
}

/** One store's salvage outcome: the records that survived, and how many were dropped. */
export type SalvagedStore = {records: Record<string, ConvertRecord>; dropped: number};

/** Validate an unknown storage value RECORD BY RECORD (pure; jest-pinned; never throws).
 *  Accepts BOTH store generations in any mix: current-shape records pass through, pre-legs
 *  (v1) records are migrated. A record that fails validation (corrupt bytes, unknown shape,
 *  or a shape no driver can ever advance) is DROPPED and its siblings SURVIVE — one bad
 *  record must not take a whole money-adjacent store with it. Top-level garbage (not an
 *  object) salvages nothing and drops nothing: there were no records to lose. */
export function salvageConvertStore(state: unknown): SalvagedStore {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {records: {}, dropped: 0};
  const records: Record<string, ConvertRecord> = {};
  let dropped = 0;
  for (const [id, v] of Object.entries(state as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') {dropped += 1; continue;}
    const r = v as Record<string, unknown>;
    const record = r.legs == null && typeof r.approveEnvelopeHex === 'string'
      ? migrateLegacyRecord(r, records, id)
      : hydrateOneRecord(r, records, id);
    if (record == null) dropped += 1;
  }
  return {records, dropped};
}

/** The salvaged records alone (the long-standing read shape of a store). */
export function hydrateConvertStore(state: unknown): Record<string, ConvertRecord> {
  return salvageConvertStore(state).records;
}

/** Parse + salvage ONE raw store string. Unparseable bytes salvage nothing and report
 *  dropped=1 — the whole source is unreadable, which the caller treats as a NOT-fully-
 *  successful adoption (a legacy key in that state is never removed from disk). */
function salvageRawStore(raw: string): SalvagedStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {records: {}, dropped: 1};
  }
  return salvageConvertStore(parsed);
}

/** The step a driver never touches again: done, failed_refunded, failed_leg, stuck,
 *  quote_expired, provider_refunded (V6 — the terminal provider states join the terminal
 *  set). The stuck nuance lives in the ENGINE, not the step: an unacknowledged
 *  expired-unconfirmed stuck record is still slow-watched; this set says only that no STATE
 *  transitions remain. `failed_leg` is the multi-hop dead-end (2026-09-14 spec §4): a burn
 *  leg refused after the swap confirmed — the hop asset is in-wallet, the exit is the
 *  standalone Withdraw flow, so no driver ever re-enters either. */
export const TERMINAL_CONVERT_STEPS: ReadonlySet<ConvertStep> = new Set([
  'done', 'failed_refunded', 'failed_leg', 'stuck', 'quote_expired', 'provider_refunded',
  'aborted',
]);

export function isTerminalConvertStep(step: ConvertStep): boolean {
  return TERMINAL_CONVERT_STEPS.has(step);
}

/** The user's Stop requests, keyed by record id. Module-level so BOTH drivers (the confirm-flow
 *  executor here and the engine's driveOne) honor one flag regardless of adoption timing. */
const ABORT_REQUESTED = new Set<string>();

/** The user tapped Stop on a live record. Idempotent; the next driver checkpoint collapses it. */
export function requestConvertAbort(id: string): void {
  ABORT_REQUESTED.add(id);
}

/** Internal: has the user asked this record to stop? */
export function convertAborted(id: string): boolean {
  return ABORT_REQUESTED.has(id);
}

/** What the user gave up — the aborted panel's one-line body flavor.
 *  'watching': a swap was already submitted — it may still go through.
 *  'fee': an approve confirmed — its tiny network fee is spent, principal untouched.
 *  'clean': nothing left the wallet at all. */
export function convertAbortFlavor(rec: ConvertRecord): 'clean' | 'fee' | 'watching' {
  if (rec.solanaLeg != null) return 'watching';
  const plan = rec.legPlan ?? [];
  if (plan.some(l => l.kind === 'swap' && l.state !== 'pending')) return 'watching';
  if (plan.some(l => l.kind === 'approve' && l.state === 'confirmed')) return 'fee';
  // DIRECT records carry no legPlan at all (hydration: "The direct 2-leg shape (legPlan
  // absent)"), so the plan-based reads above never fire for them — and the abort rewrite of
  // `step` erases the flight position, which made an abort mid-flight read as "nothing left
  // the wallet" while the swap envelope was already on the wire. The step machine's own
  // vocabulary carries the facts: from 'swapping' on, the depositFromAndSwap bytes are
  // submitted (watching); 'approved' means the approve settled and its fee is spent (fee);
  // anything earlier is genuinely clean. `abortedFromStep` preserves that position through
  // the abort rewrite, so the terminal aborted card keeps the honest flavor.
  const flown = rec.step === 'aborted' ? rec.abortedFromStep : rec.legPlan == null ? rec.step : undefined;
  if (flown === 'swapping' || flown === 'settling' || flown === 'pending_withdrawal') return 'watching';
  if (flown === 'approved') return 'fee';
  return 'clean';
}

/** Has EVERY leg's submission authority died (device-clock death of the signed envelope)?
 *  An unconfirmed leg past this point may STILL have executed — the outcome is unknown, the
 *  bytes must never be re-submitted (V6 trichotomy arm (b)). */
export function convertLegsExpired(record: ConvertRecord, nowMs: number = Date.now()): boolean {
  return record.legs.length > 0 && record.legs.every(l => l.expiresAtMs <= nowMs);
}

/** The IC hub 2-hop record shape (2026-09-18, spec §11): planned, non-cross-rail, four IC
 *  legs in the approve/swap/approve/swap order, with the dest ledger named. Hydration
 *  enforces exactly this shape AND its frozen facts; this predicate is the executor's and
 *  resume engine's cheap discriminator for the hub-specific state machine. */
export function isHubConvertRecord(rec: ConvertRecord): boolean {
  const plan = rec.legPlan;
  return rec.destLedger != null && rec.crossRail == null && plan != null && plan.length === 4
    && plan[0].kind === 'approve' && plan[1].kind === 'swap'
    && plan[2].kind === 'approve' && plan[3].kind === 'swap';
}

export async function loadConvertRecords(publicHex: string): Promise<Record<string, ConvertRecord>> {
  const scopedKey = convertStoreKey(publicHex);
  try {
    const raw = await AsyncStorage.getItem(scopedKey);
    // Scoped-first short-circuit: THIS identity's own store is the answer, healthy or not —
    // legacy keys are never consulted once a scoped store exists. Salvage is PER-RECORD: valid
    // records load, corrupt ones are dropped from the working set; the bytes stay on disk
    // untouched (nothing is rewritten on a load) and the next saveConvertRecord rebuilds the
    // store clean around the survivors.
    if (raw != null) {
      const salvaged = salvageRawStore(raw);
      if (salvaged.dropped > 0) {
        console.warn(`convert store ${scopedKey}: ${salvaged.dropped} record(s) unreadable — dropped from the working set (bytes left on disk until the next save)`);
      }
      return salvaged.records;
    }
    // No scoped store yet: fold BOTH legacy sources into ONE pass — the pre-legs v1 store
    // first (the older generation), the pre-scoping unscoped v2 store OVERLAYING it on id
    // collision (the newer generation wins; the unscoped branch used to return early and
    // orphan v1 records whenever a non-empty unscoped v2 store existed). One scoped write,
    // then each legacy key is retired ONLY if its own salvage was total: a key that lost
    // records to corruption STAYS on disk (source preserved for manual recovery) while its
    // valid records still land in the scoped store. The adopting identity is the one that
    // wrote the unscoped stores (single-active-identity deployment) and a record must
    // survive an app upgrade, byte-frozen.
    const legacy: Array<{key: string; raw: string | null}> = [
      {key: CONVERT_LEGACY_STORAGE_KEY, raw: await AsyncStorage.getItem(CONVERT_LEGACY_STORAGE_KEY)},
      {key: CONVERT_UNSCOPED_STORAGE_KEY, raw: await AsyncStorage.getItem(CONVERT_UNSCOPED_STORAGE_KEY)},
    ];
    if (legacy.every(s => s.raw == null)) return {};
    const merged: Record<string, ConvertRecord> = {};
    const adopted: Array<{key: string; dropped: number}> = [];
    for (const s of legacy) {
      if (s.raw == null) continue;
      const salvaged = salvageRawStore(s.raw);
      Object.assign(merged, salvaged.records);
      adopted.push({key: s.key, dropped: salvaged.dropped});
    }
    await AsyncStorage.setItem(scopedKey, JSON.stringify(merged));
    for (const s of adopted) {
      if (s.dropped === 0) {
        await AsyncStorage.removeItem(s.key); // fully copied — retire the legacy key
      } else {
        console.warn(`convert legacy store ${s.key}: ${s.dropped} record(s) unreadable — valid records were copied to ${scopedKey}; the legacy key is KEPT on disk (source preserved)`);
      }
    }
    return merged;
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
  // expected_allowance stays ABSENT: ICRC-2 compares it with the CURRENT allowance, so any
  // value here refuses with AllowanceChanged whenever it differs — the first-ever approve
  // included (current 0 ≠ amount): every conversion on a real ledger (2026-09-19 live defect;
  // the fake gateway ignored the field, which is why offline never saw it).
  const approveArgHex = await DpayCore.icpApproveArg(
    pool, '', '', approveAmount, '', allowanceExpiryNs, '', math.inFee,
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
  // The legs' death is the ENVELOPES' OWN ingress expiry — the exact stamp `envExpiry` just
  // signed into both envelopes (certified IC now + INGRESS_AHEAD_S), ns → ms. NOT the 10-min
  // approve-allowance lifetime (that is the ALLOWANCE's death — a different event): recording
  // `now + CONVERT_APPROVE_LIFETIME_S` here used to run the never-resubmit boundary ~5 min
  // past the envelopes' true submit-death. The recorded value is exactly the real death —
  // never later, never a device-clock guess.
  const expiresAtMs = Number(BigInt(envExpiry) / 1_000_000n);
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
    inDecimals: inDesc.decimals ?? undefined,
    outDecimals: outDesc.decimals ?? undefined,
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

/** Prepare ONE CeFi order as a legless provider record (the SideShift widening, 2026-09-15,
 *  founder decision 3). NOTHING is signed here — that is the point of the shape: the venue
 *  holds the funds mid-trade and the user's own deposit is the value movement (the
 *  disclosures say so; the record's providerDeposit block IS the handoff screen's data).
 *  The record lands at `awaiting_deposit` and the resume engine's provider driver advances
 *  it from there by the venue's own status reads.
 *
 *  Signing-boundary red lines, the cefi analog of prepareConvertRecord's: the quote's OWN
 *  venue must be registered, kind cefi, non-testnet, and its registry pair — matched as an
 *  unordered rail-id set — must be exactly the quote's in/out ids. The settle address is
 *  the user's own derived address (never typed free-hand, never a third party's), and the
 *  statusUrl is the venue's keyless device-direct GET — the relay is not in the status
 *  path, so a relay outage cannot blind an in-flight order. */
export function prepareCeFiConvertRecord(args: {
  quote: ConvertQuote;
  order: SideShiftFixedShift;
  settleAddress: string;
  /** The IC catalog currency of the INPUT — null when the input lives on ANOTHER rail
   *  (the SOL-side cefi surface converts a SPL asset; hydration's cefi exemption covers
   *  the absent field exactly like the out side). */
  inCurrency: number | null;
  inSymbol: string;
  outSymbol: string;
  inDecimals?: number;
  outDecimals?: number;
}): ConvertRecord {
  const {quote, order, settleAddress} = args;
  // (1) The quote's OWN venue must be a real registered cefi row, and the quote's pair
  // must be exactly that row's pair (unordered) — a misconfigured or hostile relay
  // echoing venue A's name over venue B's pair cannot ride this surface.
  const venue = venueOfId(quote.venueId);
  if (venue == null || venue.kind !== 'cefi' || venue.testnet
    || cefiOtherSide(venue, quote.tokenInLedger) !== quote.tokenOutLedger) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  // (2) The order the venue issued must price the SAME deposit the quote carried (the
  // relay already refused pair drift upstream; this is the phone-side twin — the fixed
  // shift settles only its exact depositAmount, so a mismatch is a different trade than
  // the one the user approved).
  const quotedDeposit = rawToDecimal(quote.amountIn, args.inDecimals ?? 8);
  if (order.depositAmount !== quotedDeposit) {
    throw new Error(M.convert.errors.quoteUnavailable('deposit'));
  }
  if (settleAddress.length === 0 || order.id.length === 0) {
    throw new Error(M.convert.errors.quoteUnavailable('order'));
  }
  const expiresAtMs = order.expiresAt != null ? Date.parse(order.expiresAt) : NaN;
  return {
    id: randNonceHex(),
    createdAtMs: Date.now(),
    step: 'awaiting_deposit',
    venueId: quote.venueId,
    // Null (another-rail input, the SOL-side cefi surface) is stored ABSENT — hydration
    // already treats the field as optional and the cefi exemption covers the both-null shape.
    inCurrency: args.inCurrency ?? undefined,
    // outCurrency deliberately ABSENT: the out side lives on another rail (SOL is not an
    // IC catalog currency) — the cefi hydration exemption pins why that is sound.
    inLedger: quote.tokenInLedger,
    outLedger: quote.tokenOutLedger,
    inSymbol: args.inSymbol,
    outSymbol: args.outSymbol,
    inDecimals: args.inDecimals,
    outDecimals: args.outDecimals,
    amountIn: quote.amountIn,
    expectedGross: quote.amountOutGross,
    expectedNet: quote.amountOutGross, // the fixed order's own settle figure — dpay adds/subtracts nothing
    inFee: '0', // the user's deposit is sent by the user; its network fee is theirs, named in the handoff copy
    outFee: '0', // the venue's commission is INSIDE its quoted rate (commissionRate "0" relay-side)
    slippageBps: 0, // a fixed shift is a locked rate — there is no slippage axis
    legs: [],
    providerRef: {
      orderId: order.id,
      statusUrl: sideShiftStatusUrl(order.id),
    },
    providerDeposit: {
      depositAddress: order.depositAddress,
      depositAmount: order.depositAmount,
      ...(order.depositMemo != null ? {depositMemo: order.depositMemo} : {}),
      ...(Number.isSafeInteger(expiresAtMs) && expiresAtMs > 0 ? {expiresAtMs} : {}),
    },
    destAddress: settleAddress,
    destSymbol: args.outSymbol,
  };
}

/** Prepare ONE multi-hop intent as a single signed record (2026-09-14 spec §1/§3): ALL legs
 *  are signed here, up front, with the freshest live facts — the re-quoted swap hop, and the
 *  minter's LIVE gas price queried at confirm time (the same `fetchGasFeeWei` the standalone
 *  Withdraw flow uses; never a cached figure, never a dpay number). Every arg builder is the
 *  exact one the single-swap record or the Withdraw flow already signs — zero new signing
 *  surface, the mandate's red line.
 *
 *  The BURN amount is the swap's min-you'll-receive (`math.minOut`, spec §5): a route that
 *  cannot deliver its floor should refuse at its own leg, not fail designed-to-fail at the
 *  burn. Any surplus above the floor stays in-wallet as the hop asset — the confirm screen
 *  says so before anything is signed. */

// --- the gas-fund resolution (2026-09-20, the cross-rail gas widening) -------------------------------

/** The funding target: the minter's LIVE feeWei + 20% headroom — the SAME buffer convention
 *  `cctpMaxFee` applies to Circle's forward fee. The pre-leg chain's final floor must reach
 *  THIS number, and the executor's post-pre-leg re-check compares the ACTUAL in-wallet
 *  gas-ledger balance against the frozen copy of it. */
export function gasFundNeededWei(gasFeeWei: string): bigint {
  return (BigInt(gasFeeWei) * 120n) / 100n;
}

/** Quote + size ONE candidate funding route. Legs chain exactly like the hub record:
 *  leg i+1 is QUOTED on leg i's minOut (the compounding floor — `icpSwapMinOut`, the same
 *  machinery `convertRecordMinOut` re-derives from), and the final leg's floor must cover
 *  `neededWei`. Sizing starts at the whole spendable budget and SHRINKS toward the smallest
 *  input that still covers (≤4 re-quotes, +5% margin) — never up past the budget. Every
 *  quote must name its route leg exactly (venue, pool, pair, live direction) or the route
 *  is unusable. Null = this route cannot fund the target (or cannot be quoted at all);
 *  otherwise the winner carries `probeFloor` — the first pass's floor at the FULL budget,
 *  the route's honest deliverability, which ranking compares (the shrunk plan's floor is
 *  ~equal for every fundable route by construction, so ranking on it would be a tie-break
 *  of margin noise, not of net). */
async function resolveGasFundRoute(args: {
  relayUrl: string;
  route: GasFundRoute;
  slippageBps: number;
  budget: bigint;
  neededWei: bigint;
}): Promise<{plan: ResolvedGasFundPlan; probeFloor: bigint} | null> {
  const {relayUrl, route: r, slippageBps, budget, neededWei} = args;
  const endpoints = r.hub != null ? [r.from, r.hub, r.dest] : [r.from, r.dest];
  const chainOnce = async (input: bigint): Promise<ResolvedGasFundPlan['legs'] | null> => {
    const legs: ResolvedGasFundPlan['legs'] = [];
    let carry = input;
    for (let li = 0; li < r.legs.length; li += 1) {
      const leg = r.legs[li]!;
      const fromEp = endpoints[li]!;
      const toEp = endpoints[li + 1]!;
      if (leg.fromLedger !== fromEp.ledger || leg.toLedger !== toEp.ledger) return null;
      const venue = venueOfId(leg.venueId);
      if (venue == null || venue.endpoint !== leg.pool) return null;
      let q: ConvertQuote;
      try {
        q = await fetchConvertQuote(relayUrl, leg.fromLedger, leg.toLedger, carry.toString(), {venue});
      } catch {
        return null; // an unquotable leg is not a funding route — try the next candidate
      }
      if (q.venueId !== leg.venueId || q.pool !== leg.pool
        || q.tokenInLedger !== leg.fromLedger || q.tokenOutLedger !== leg.toLedger
        || q.zeroForOne == null) return null;
      const minOut = await DpayCore.icpSwapMinOut(q.amountOutGross, slippageBps);
      if (typeof minOut !== 'string' || !/^\d+$/.test(minOut) || BigInt(minOut) <= 0n) return null;
      legs.push({
        venueId: leg.venueId, pool: leg.pool, fromLedger: leg.fromLedger, toLedger: leg.toLedger,
        inAmount: carry.toString(), minOut,
        zeroForOne: q.zeroForOne, fromFee: fromEp.fee, toFee: toEp.fee,
      });
      carry = BigInt(minOut);
    }
    return legs;
  };
  let best: ResolvedGasFundPlan | null = null;
  let probeFloor = 0n; // the FIRST pass's floor at the full budget — the route's deliverability
  let input = budget;
  for (let k = 0; k < 4; k += 1) {
    const legs = await chainOnce(input);
    if (legs == null) break;
    const floor = BigInt(legs[legs.length - 1]!.minOut);
    if (floor < neededWei) break; // under target — a smaller input never covers either
    if (k === 0) probeFloor = floor;
    best = {neededWei: neededWei.toString(), legs};
    const scaled = (input * neededWei * 105n) / (floor * 100n) + 1n; // shrink toward the target
    if (scaled >= input) break; // converged at the floor's own resolution
    input = scaled;
  }
  return best == null ? null : {plan: best, probeFloor};
}

/** Resolve the gas-fund plan for one cross-rail intent (2026-09-20): which in-wallet IC
 *  asset funds the ckETH the burn legs will spend, over WHICH route, at WHAT size. The
 *  candidate walk is the contract's: every catalog asset with a MEASURED balance is a
 *  source (1-hop direct venue else 2-hop hub into the gas ledger); the MAIN route's own
 *  input ledger is a source ONLY if its measured balance covers the main amount + both
 *  flows' fees + the target — the ONE shared balance rule — so the main amount is never
 *  silently shrunk to make room for gas. Among fundable routes the LARGEST net ckETH floor
 *  wins (the contract's explicit pick; this is routing for one intent, not venue display).
 *  Null = nothing in the wallet can fund the target — the caller refuses to sign a
 *  gas-less intent rather than build a record designed to strand. */
export async function resolveGasFundPlan(args: {
  secretHex: string;
  relayUrl: string;
  route: MultihopRoute;
  /** Raw spendable balances by CATALOG CURRENCY id (the wallet's assetBalances, verbatim).
   *  A currency nobody measured is NOT a candidate — an unmeasured balance funds nothing. */
  balances: Record<number, string>;
  mainAmountIn: string;
  slippageBps: number;
  catalog?: CurrencyDescriptor[];
}): Promise<ResolvedGasFundPlan | null> {
  const {secretHex, relayUrl, route, balances, mainAmountIn, slippageBps} = args;
  const catalog = args.catalog ?? icpCatalogOf(BUNDLED_NETWORKS);
  const feeWei = await fetchGasFeeWei(secretHex, route.burn.minter, route.hop.ledger);
  if (feeWei == null) throw new Error(M.convert.errors.gasUnavailable);
  const neededWei = gasFundNeededWei(feeWei);
  if (neededWei <= 0n) return null;
  const mainIn = BigInt(mainAmountIn);
  const mainInFee = BigInt(route.from.fee);
  let best: {plan: ResolvedGasFundPlan; floor: bigint} | null = null;
  for (const row of catalog) {
    if (row.testnet || row.ledger == null) continue;
    if (row.currency === route.burn.gasCurrency) continue; // the gas asset is not a source
    const balRaw = balances[row.currency];
    if (balRaw == null || !/^\d+$/.test(balRaw)) continue;
    const bal = BigInt(balRaw);
    if (bal <= 0n) continue;
    const sameLedger = row.ledger === route.from.ledger;
    // The one-shared-balance rule, coarse pre-quote half: a source that cannot even cover
    // the MAIN intent's own draw (amount + both approves' fees) is out before any quote.
    // The "+gasNeed +floors" half is enforced EXACTLY by the budget cap below — sizing
    // quotes in the source's own units (a raw cross-ledger comparison here would be
    // unit-blind), and a budget that cannot reach the target kills the route instead of
    // ever shrinking the main amount.
    if (sameLedger && bal < mainIn + mainInFee * 2n) continue;
    for (const r of gasFundRoutes(catalog, row.ledger, route.burn.gasLedger)) {
      // Spendable for the funding flow: the balance minus the funding approve's own fee,
      // and for the shared source minus the main intent's own draw (amount + its fee).
      let budget = bal - BigInt(r.from.fee);
      if (sameLedger) budget -= mainIn + mainInFee;
      if (budget <= 0n) continue;
      const plan = await resolveGasFundRoute({relayUrl, route: r, slippageBps, budget, neededWei});
      if (plan == null) continue;
      if (best == null || plan.probeFloor > best.floor) best = {plan: plan.plan, floor: plan.probeFloor};
    }
  }
  return best?.plan ?? null;
}

export async function prepareMultihopConvertRecord(args: {
  secretHex: string;
  /** The re-quoted SWAP-hop quote (input ledger → hop ledger), verbatim from the venue. */
  quote: ConvertQuote;
  /** Swap-hop math; `minOut` doubles as the burn amount (see above). */
  math: ConvertMath;
  route: MultihopRoute;
  /** The user's own self-custodial destination address (validated — never signed blind). */
  destAddress: string;
  /** The gas-fund widening (2026-09-20): the wallet's measured IC balances by catalog
   *  currency id + the relay to quote the funding legs on. When present, prepare FIRST
   *  re-measures the gas-ledger balance (the double-gas guard) and only prepends funding
   *  legs when the wallet is STILL short — an earlier abandoned intent that already funded
   *  the gas yields a record byte-identical to the unfunded shape. */
  gasFund?: {relayUrl: string; balances: Record<number, string>};
}): Promise<ConvertRecord> {
  const {secretHex, quote, math, route, destAddress} = args;
  // Same signing-boundary red lines as the direct record, extended to EVERY leg target this
  // intent will sign against (the phone is the enforcement point because the phone signs):
  // the quote's own venue must be registered with its endpoint AS the quoted pool, AND the
  // quote must be FOR this route (in/out ledgers match the route's composition), AND no
  // dpay-owned canister may appear anywhere in the leg target set.
  if (quote.zeroForOne == null) throw new Error(M.convert.errors.quoteUnavailable('direction'));
  const venue = venueOfId(quote.venueId);
  if (venue == null || venue.endpoint !== quote.pool || quote.pool !== route.pool) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  if (quote.tokenInLedger !== route.from.ledger || quote.tokenOutLedger !== route.hop.ledger) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  for (const target of [route.from.ledger, route.pool, route.hop.ledger, route.burn.gasLedger, route.burn.minter]) {
    if (DPAY_CANISTER_PRINCIPALS.includes(target)) {
      throw new Error(M.convert.errors.quoteUnavailable('venue'));
    }
  }
  if (!isValidDestinationAddress('CkEthErc20', destAddress)) {
    throw new Error(M.convert.multihop.destAddressInvalid);
  }
  // The minter's live gas quote at confirm time — the number the approve_gas leg signs and
  // the census shows. Unreachable minter → the intent cannot be priced honestly → refuse.
  const gasFeeWei = await fetchGasFeeWei(secretHex, route.burn.minter, route.hop.ledger);
  if (gasFeeWei == null) throw new Error(M.convert.errors.gasUnavailable);
  const gasLedgerFee = await fetchLedgerFee(secretHex, route.burn.gasLedger);

  // The GAS-FUND WIDENING (2026-09-20): a wallet short on ckETH funds its OWN gas by
  // PREPENDING ordinary device-signed approve+swap legs (in-wallet asset → ckETH) ahead
  // of the route's legs. Order of guards, both re-run at EVERY prepare:
  //   1. DOUBLE-GAS guard — a fresh signed balance read on the gas ledger; at or above the
  //      fresh target (feeWei + 20%) there is nothing to fund (an abandoned intent's gas
  //      already landed) → no gasPre, byte-identical to the unfunded record.
  //   2. An unmeasurable balance NEVER triggers funding (never sign a sizing blind) — the
  //      unfunded record proceeds and the on-chain refusal, if any, is the honest verdict.
  //   3. Still short → resolve the plan fresh (neededWei re-derivation + live quotes).
  //      Requested but unresolvable → THROW, nothing signed: an unfunded record here would
  //      run the main conversion into the gas-less dead end.
  let gasPre: ResolvedGasFundPlan | undefined;
  if (args.gasFund != null) {
    const haveRaw = await railBalanceOf(secretHex, route.burn.gasLedger);
    const neededMin = gasFundNeededWei(gasFeeWei);
    if (haveRaw == null || !/^\d+$/.test(haveRaw)) {
      console.warn('gas-fund: gas-ledger balance unreadable — refusing to prepend funding legs');
    } else if (BigInt(haveRaw) >= neededMin) {
      // The double-gas guard: already funded, nothing to prepend.
    } else {
      gasPre = (await resolveGasFundPlan({
        secretHex, relayUrl: args.gasFund.relayUrl, route,
        balances: args.gasFund.balances, mainAmountIn: math.amountIn, slippageBps: math.slippageBps,
      })) ?? undefined;
      if (gasPre == null) throw new Error(M.convert.errors.gasUnavailable);
    }
  }

  const amountIn = quote.amountIn;
  const pool = quote.pool;
  const burnAmount = math.minOut;

  // The CROSS-RAIL WIDENING (2026-09-16, Routes B/C): when the route composes a CCTP leg,
  // the five IC legs land USDC at the user's EVM address and the record EXTENDS with the
  // external-signature burn leg (+ Route C's final Jupiter leg). Nothing here signs: the
  // burn is the USER's own EVM wallet's transaction — dpay only freezes the facts (the
  // device-derived SOL address, its USDC ATA as the mint recipient) and prices the census
  // with Circle's live fee. The calldata itself is built at handoff time from this record.
  // FEE-BEFORE-SIGNING (honest order): the fee is fetched BEFORE any leg is signed, so an
  // unreachable Circle census leaves NOTHING signed — same fail-closed rule as route gas.
  let crossRail: CrossRailInfo | undefined;
  if (route.crossRail != null) {
    if (route.crossRail.cctp.finalityThreshold !== CCTP_FINALITY_FAST) {
      // The fee fetch below is pinned to FAST; an unknown finality shape is a registry
      // this build did not compose — refuse rather than mis-price.
      throw new Error(M.convert.errors.cctpFeeUnavailable);
    }
    const kp = deriveSolanaKeypair(secretHex);
    const ataB58 = bs58.encode(deriveAta(kp.address, USDC_MINT_ADDRESS));
    const fee = await fetchCctpBurnFee();
    const maxFee = cctpMaxFee(BigInt(burnAmount), fee);
    crossRail = {
      kind: route.crossRail.sol != null ? 'cctp_sol' : 'cctp',
      solAddress: kp.address,
      mintRecipientAta: ataB58,
      maxFeeSubunits: maxFee.toString(),
      mintFloorSubunits: cctpMintFloor(BigInt(burnAmount), maxFee).toString(),
      ...(route.crossRail.sol != null
        ? {
            solVenueId: route.crossRail.sol.venueId,
            // The SPL-out widening: a non-wrapped-SOL out mint is frozen WITH its decimals —
            // the final leg quotes/pays out in the out mint, the done screen formats through
            // them, and the payout read keys on the mint. Native-SOL records stay byte-stable.
            ...(route.crossRail.sol.outMint !== WRAPPED_SOL_MINT_ADDRESS
              ? {solOutMint: route.crossRail.sol.outMint, solOutDecimals: route.crossRail.sol.outDecimals}
              : {}),
          }
        : {}),
    };
  }

  const approveAmount = (BigInt(amountIn) + BigInt(math.inFee)).toString();
  const allowanceExpiryNs = await icStampExpiry(secretHex, CONVERT_APPROVE_LIFETIME_S);
  const envExpiry = await icStampExpiry(secretHex);
  const expiresAtMs = Number(BigInt(envExpiry) / 1_000_000n);

  // Legs 0a: the GAS-FUND pre-legs (2026-09-20) — ordinary approve+swap pairs, signed FIRST
  // so the funding completes before the route's own legs run. Same signing-boundary red
  // lines per leg: the venue registered with its endpoint AS the pool, and no dpay-owned
  // canister anywhere in the pre-leg target set. The approve sizes on inAmount + the
  // from-ledger's fee (the direct flow's exact convention); the swap's floor is the
  // resolution's own minOut, leg i+1 quoted on leg i's floor.
  const preSigned: {canister: string; method: 'icrc2_approve' | 'depositFromAndSwap'; argHex: string; envelopeHex: string; requestIdHex: string; expiresAtMs: number}[] = [];
  const prePlan: LegPlan[] = [];
  for (const leg of gasPre?.legs ?? []) {
    const pv = venueOfId(leg.venueId);
    if (pv == null || pv.endpoint !== leg.pool) throw new Error(M.convert.errors.quoteUnavailable('pool'));
    for (const target of [leg.pool, leg.fromLedger, leg.toLedger]) {
      if (DPAY_CANISTER_PRINCIPALS.includes(target)) throw new Error(M.convert.errors.quoteUnavailable('venue'));
    }
    const preApproveAmount = (BigInt(leg.inAmount) + BigInt(leg.fromFee)).toString();
    const preApproveArg = await DpayCore.icpApproveArg(leg.pool, '', '', preApproveAmount, '', allowanceExpiryNs, '', leg.fromFee);
    const preApproveSigned = await DpayCore.icpSignUpdate(secretHex, leg.fromLedger, 'icrc2_approve', preApproveArg, envExpiry);
    preSigned.push({canister: leg.fromLedger, method: 'icrc2_approve', argHex: preApproveArg, envelopeHex: preApproveSigned.envelopeHex, requestIdHex: preApproveSigned.requestIdHex, expiresAtMs});
    prePlan.push({kind: 'approve', canister: leg.fromLedger, fee: leg.fromFee, state: 'pending'});
    const preSwapArg = await DpayCore.icpDepositAndSwapArg(leg.inAmount, leg.minOut, leg.fromFee, leg.toFee, leg.zeroForOne);
    const preSwapSigned = await DpayCore.icpSignUpdate(secretHex, leg.pool, 'depositFromAndSwap', preSwapArg, envExpiry);
    preSigned.push({canister: leg.pool, method: 'depositFromAndSwap', argHex: preSwapArg, envelopeHex: preSwapSigned.envelopeHex, requestIdHex: preSwapSigned.requestIdHex, expiresAtMs});
    prePlan.push({kind: 'swap', canister: leg.pool, fee: '', state: 'pending'});
  }

  // Legs 1–2: the direct flow's exact approve+swap pair (spender/pull semantics identical).
  // Same absent expected_allowance rule as the direct flow above.
  const approveInArgHex = await DpayCore.icpApproveArg(
    pool, '', '', approveAmount, '', allowanceExpiryNs, '', math.inFee,
  );
  const approveInSigned = await DpayCore.icpSignUpdate(secretHex, route.from.ledger, 'icrc2_approve', approveInArgHex, envExpiry);
  const swapArgHex = await DpayCore.icpDepositAndSwapArg(
    amountIn, burnAmount, math.inFee, route.hop.fee, quote.zeroForOne,
  );
  const swapSigned = await DpayCore.icpSignUpdate(secretHex, pool, 'depositFromAndSwap', swapArgHex, envExpiry);
  // Legs 3–5: the Withdraw flow's exact burn triple (rail.prepareErc20Withdrawal, not forked):
  // minter-shape approves (no expected allowance, no allowance expiry — single-use burns)
  // then the minter's withdraw_erc20 carrying the user's own destination.
  const approveHopArgHex = await DpayCore.icpApproveArg(
    route.burn.minter, '', '', burnAmount, '', '', '', route.hop.fee,
  );
  const approveHopSigned = await DpayCore.icpSignUpdate(secretHex, route.hop.ledger, 'icrc2_approve', approveHopArgHex, envExpiry);
  const approveGasArgHex = await DpayCore.icpApproveArg(
    route.burn.minter, '', '', gasFeeWei, '', '', '', gasLedgerFee,
  );
  const approveGasSigned = await DpayCore.icpSignUpdate(secretHex, route.burn.gasLedger, 'icrc2_approve', approveGasArgHex, envExpiry);
  const withdrawArgHex = await DpayCore.icpWithdrawErc20Arg(burnAmount, route.hop.ledger, destAddress, '', '');
  const withdrawSigned = await DpayCore.icpSignUpdate(secretHex, route.burn.minter, 'withdraw_erc20', withdrawArgHex, envExpiry);

  return {
    id: randNonceHex(),
    createdAtMs: Date.now(),
    step: 'approving',
    venueId: quote.venueId,
    inCurrency: route.from.currency,
    outCurrency: route.hop.currency,
    inLedger: route.from.ledger,
    outLedger: route.hop.ledger,
    inSymbol: route.from.symbol,
    outSymbol: route.hop.symbol,
    inDecimals: route.from.decimals,
    outDecimals: route.hop.decimals,
    amountIn,
    expectedGross: quote.amountOutGross,
    expectedNet: math.netOut,
    inFee: math.inFee,
    outFee: route.hop.fee,
    slippageBps: math.slippageBps,
    legs: [
      ...preSigned.map(s => ({canister: s.canister, method: s.method, argHex: s.argHex, envelopeHex: s.envelopeHex, requestIdHex: s.requestIdHex, expiresAtMs: s.expiresAtMs})),
      {canister: route.from.ledger, method: 'icrc2_approve', argHex: approveInArgHex, envelopeHex: approveInSigned.envelopeHex, requestIdHex: approveInSigned.requestIdHex, expiresAtMs},
      {canister: pool, method: 'depositFromAndSwap', argHex: swapArgHex, envelopeHex: swapSigned.envelopeHex, requestIdHex: swapSigned.requestIdHex, expiresAtMs},
      {canister: route.hop.ledger, method: 'icrc2_approve', argHex: approveHopArgHex, envelopeHex: approveHopSigned.envelopeHex, requestIdHex: approveHopSigned.requestIdHex, expiresAtMs},
      {canister: route.burn.gasLedger, method: 'icrc2_approve', argHex: approveGasArgHex, envelopeHex: approveGasSigned.envelopeHex, requestIdHex: approveGasSigned.requestIdHex, expiresAtMs},
      {canister: route.burn.minter, method: 'withdraw_erc20', argHex: withdrawArgHex, envelopeHex: withdrawSigned.envelopeHex, requestIdHex: withdrawSigned.requestIdHex, expiresAtMs},
    ],
    legPlan: [
      ...prePlan,
      {kind: 'approve', canister: route.from.ledger, fee: math.inFee, state: 'pending'},
      {kind: 'swap', canister: pool, fee: '', state: 'pending'},
      {kind: 'approve', canister: route.hop.ledger, fee: route.hop.fee, state: 'pending'},
      {kind: 'approve_gas', canister: route.burn.gasLedger, fee: gasLedgerFee, state: 'pending'},
      {kind: 'withdraw_erc20', canister: route.burn.minter, fee: '', state: 'pending'},
      // The cross-rail tail: the external-signature burn (no IC canister — the user's own
      // wallet is the counterparty) and, on Route C, the final device-signed Jupiter leg.
      // Both start pending; the executor never submits them via the IC rail.
      ...(crossRail != null ? [{kind: 'cctp_burn' as const, canister: '', fee: '', state: 'pending' as const}] : []),
      ...(crossRail?.kind === 'cctp_sol' ? [{kind: 'sol_swap' as const, canister: '', fee: '', state: 'pending' as const}] : []),
    ],
    destAddress,
    destSymbol: route.dest.symbol,
    destNetwork: route.dest.network,
    hopLedger: route.hop.ledger,
    hopSymbol: route.hop.symbol,
    hopCurrency: route.hop.currency,
    hopDecimals: route.hop.decimals,
    gasSymbol: route.burn.gasSymbol,
    gasDecimals: route.burn.gasDecimals,
    gasFeeWei,
    feeMillionths: quote.feeMillionths,
    // The frozen gas-fund block (the FROZEN record shape — venue/pool/ledgers/amounts only;
    // the signing-side extras live only on the in-memory resolution, never serialized).
    ...(gasPre != null ? {gasPre: {neededWei: gasPre.neededWei, legs: gasPre.legs.map(l => ({venueId: l.venueId, pool: l.pool, fromLedger: l.fromLedger, toLedger: l.toLedger, inAmount: l.inAmount, minOut: l.minOut}))} satisfies GasFundPlan} : {}),
    ...(crossRail != null ? {crossRail} : {}),
  };
}

/** Prepare ONE IC hub 2-hop intent as a single signed record (2026-09-18, spec §11): from →
 *  hub → dest over TWO registered ic_amm venues — approve+swap on venue1, approve+swap on
 *  venue2 — ALL FOUR legs signed here, in one pass, with frozen args and one shared
 *  envExpiry + allowanceExpiryNs. No destAddress: the destination is the user's OWN
 *  principal on the dest IC ledger (funds never touch a dpay-controlled address).
 *  The floors compound with one derivation rule per swap leg (spec §5 honesty): quote2 is
 *  quoted on math1.minOut — the least leg 1 can deliver, enforced below — and swap2's signed
 *  minimum is math2.minOut, quote2's own slippage floor. Floors only, never expected gross.
 *  Same red lines as every prepare, per leg (the phone signs, so the phone enforces): each
 *  quote's venue registered with its endpoint AS the quoted pool, each quote FOR its route
 *  leg, and no dpay-owned canister anywhere in the five-leg-target set. */
export async function prepareHubConvertRecord(args: {
  secretHex: string;
  /** Leg 1's re-quoted quote (from → hub), verbatim from the venue. */
  quote1: ConvertQuote;
  /** Leg 2's quote (hub → dest), quoted on `math1.minOut` — enforced below. */
  quote2: ConvertQuote;
  /** Leg 1's math; `minOut` is the hub floor legs 3–4 are sized on. */
  math1: ConvertMath;
  /** Leg 2's math (derived on quote2 with the hub + dest ledger fees). */
  math2: ConvertMath;
  route: HubRoute;
}): Promise<ConvertRecord> {
  const {secretHex, quote1, quote2, math1, math2, route} = args;
  if (quote1.zeroForOne == null || quote2.zeroForOne == null) {
    throw new Error(M.convert.errors.quoteUnavailable('direction'));
  }
  const venue1 = venueOfId(quote1.venueId);
  const venue2 = venueOfId(quote2.venueId);
  if (venue1 == null || venue1.endpoint !== quote1.pool || quote1.pool !== route.legs[0].pool
    || venue2 == null || venue2.endpoint !== quote2.pool || quote2.pool !== route.legs[1].pool) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  if (quote1.tokenInLedger !== route.from.ledger || quote1.tokenOutLedger !== route.hub.ledger
    || quote2.tokenInLedger !== route.hub.ledger || quote2.tokenOutLedger !== route.dest.ledger) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  // The composition floor: leg 2's quote must be quoted on EXACTLY leg 1's min-you'll-receive —
  // swap2 pulls whatever swap1's floor delivers, so a differently-sized quote2 is a
  // different trade than the one the user confirmed.
  if (quote2.amountIn !== math1.minOut) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  for (const target of [route.from.ledger, route.legs[0].pool, route.hub.ledger, route.legs[1].pool, route.dest.ledger]) {
    if (DPAY_CANISTER_PRINCIPALS.includes(target)) {
      throw new Error(M.convert.errors.quoteUnavailable('venue'));
    }
  }

  const amountIn = quote1.amountIn;
  // Approve sizing follows the direct flow's caller-side rule, one hop over: approve1 covers
  // the swap input + the from-ledger's own approve fee; approve2 covers the hub FLOOR (what
  // swap2 will actually pull) + the hub ledger's own approve fee.
  const approve1Amount = (BigInt(amountIn) + BigInt(math1.inFee)).toString();
  const approve2Amount = (BigInt(math1.minOut) + BigInt(route.hub.fee)).toString();
  const allowanceExpiryNs = await icStampExpiry(secretHex, CONVERT_APPROVE_LIFETIME_S);
  const envExpiry = await icStampExpiry(secretHex);
  const expiresAtMs = Number(BigInt(envExpiry) / 1_000_000n);

  // Legs 1–2: the direct flow's exact approve+swap pair, on route leg 1.
  const approve1ArgHex = await DpayCore.icpApproveArg(
    route.legs[0].pool, '', '', approve1Amount, '', allowanceExpiryNs, '', math1.inFee,
  );
  const approve1Signed = await DpayCore.icpSignUpdate(secretHex, route.from.ledger, 'icrc2_approve', approve1ArgHex, envExpiry);
  const swap1ArgHex = await DpayCore.icpDepositAndSwapArg(
    amountIn, math1.minOut, math1.inFee, route.hub.fee, quote1.zeroForOne,
  );
  const swap1Signed = await DpayCore.icpSignUpdate(secretHex, route.legs[0].pool, 'depositFromAndSwap', swap1ArgHex, envExpiry);
  // Legs 3–4: the same pair again, on route leg 2 — pool-pull approve shape (the hub floor
  // is spendable by venue2's pool), then swap2 with its own compounding floor.
  const approve2ArgHex = await DpayCore.icpApproveArg(
    route.legs[1].pool, '', '', approve2Amount, '', allowanceExpiryNs, '', route.hub.fee,
  );
  const approve2Signed = await DpayCore.icpSignUpdate(secretHex, route.hub.ledger, 'icrc2_approve', approve2ArgHex, envExpiry);
  const swap2ArgHex = await DpayCore.icpDepositAndSwapArg(
    math1.minOut, math2.minOut, route.hub.fee, route.dest.fee, quote2.zeroForOne,
  );
  const swap2Signed = await DpayCore.icpSignUpdate(secretHex, route.legs[1].pool, 'depositFromAndSwap', swap2ArgHex, envExpiry);

  return {
    id: randNonceHex(),
    createdAtMs: Date.now(),
    step: 'approving',
    venueId: quote1.venueId,
    venue2Id: quote2.venueId,
    inCurrency: route.from.currency,
    // The FIRST watchable ledger is the hub (swap1's payout) — the record's out* fields name
    // it, exactly as a direct record's out* names its swap output; the DEST lives in dest*.
    outCurrency: route.hub.currency,
    inLedger: route.from.ledger,
    outLedger: route.hub.ledger,
    inSymbol: route.from.symbol,
    outSymbol: route.hub.symbol,
    inDecimals: route.from.decimals,
    outDecimals: route.hub.decimals,
    amountIn,
    expectedGross: quote1.amountOutGross,
    expectedNet: math1.netOut,
    inFee: math1.inFee,
    outFee: route.hub.fee,
    slippageBps: math1.slippageBps,
    legs: [
      {canister: route.from.ledger, method: 'icrc2_approve', argHex: approve1ArgHex, envelopeHex: approve1Signed.envelopeHex, requestIdHex: approve1Signed.requestIdHex, expiresAtMs},
      {canister: route.legs[0].pool, method: 'depositFromAndSwap', argHex: swap1ArgHex, envelopeHex: swap1Signed.envelopeHex, requestIdHex: swap1Signed.requestIdHex, expiresAtMs},
      {canister: route.hub.ledger, method: 'icrc2_approve', argHex: approve2ArgHex, envelopeHex: approve2Signed.envelopeHex, requestIdHex: approve2Signed.requestIdHex, expiresAtMs},
      {canister: route.legs[1].pool, method: 'depositFromAndSwap', argHex: swap2ArgHex, envelopeHex: swap2Signed.envelopeHex, requestIdHex: swap2Signed.requestIdHex, expiresAtMs},
    ],
    legPlan: [
      {kind: 'approve', canister: route.from.ledger, fee: math1.inFee, state: 'pending'},
      {kind: 'swap', canister: route.legs[0].pool, fee: '', state: 'pending'},
      {kind: 'approve', canister: route.hub.ledger, fee: route.hub.fee, state: 'pending'},
      {kind: 'swap', canister: route.legs[1].pool, fee: '', state: 'pending'},
    ],
    destSymbol: route.dest.symbol,
    destNetwork: route.dest.network,
    hopLedger: route.hub.ledger,
    hopSymbol: route.hub.symbol,
    hopCurrency: route.hub.currency,
    hopDecimals: route.hub.decimals,
    destLedger: route.dest.ledger,
    destCurrency: route.dest.currency,
    destDecimals: route.dest.decimals,
    destFee: route.dest.fee,
    expectedGross2: quote2.amountOutGross,
    expectedNet2: math2.netOut,
    feeMillionths: quote1.feeMillionths,
    feeMillionths2: quote2.feeMillionths,
  };
}

// --- the CCTP leg: build the burn for the USER's wallet, then watch Circle attest and mint ---

/** Circle's published fee endpoints (CCTP V2). The burn lane is fixed by the route: USDC
 *  from Ethereum (domain 0) to Solana (domain 5), FAST finality, Forwarding Service ON
 *  with recipient setup included — so the URL is composed once, here, not per call. */
const CCTP_BURN_FEES_URL =
  'https://iris-api.circle.com/v2/burn/USDC/fees/0/5?forward=true&includeRecipientSetup=true';
const CCTP_MESSAGES_BASE_URL = 'https://iris-api.circle.com/v2/messages/0?transactionHash=';

/** Circle's live fee numbers for the USDC Ethereum→Solana burn at FAST finality: the
 *  protocol bps plus the Forwarding Service's fee (med) — the census's own numbers and
 *  the base of the signed maxFee. Fail-closed, exactly like the minter's gas quote: an
 *  unreachable fee API means the cross-rail intent cannot be priced honestly, so prepare
 *  and the handoff both refuse rather than sign a stale guess. */
export async function fetchCctpBurnFee(timeoutMs = 8000): Promise<CctpBurnFee> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(CCTP_BURN_FEES_URL, {signal: ctl.signal});
    if (!res.ok) throw new Error(M.convert.errors.cctpFeeUnavailable);
    const fee = parseCctpBurnFees(await res.json(), CCTP_FINALITY_FAST);
    if (fee == null) throw new Error(M.convert.errors.cctpFeeUnavailable);
    return fee;
  } catch {
    throw new Error(M.convert.errors.cctpFeeUnavailable);
  } finally {
    clearTimeout(timer);
  }
}

/** Circle's CCTP V2 message status, keyed by the BURN tx hash (the watch the mission spec
 *  names). A 404 is Circle's "not attested yet" — a PENDING, never a failure. Only a
 *  transport-class error throws; the caller parks and retries at the engine's cadence. */
export async function fetchCctpMessageStatus(burnTxHash: string, timeoutMs = 8000): Promise<CctpMessageStatus> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(CCTP_MESSAGES_BASE_URL + encodeURIComponent(burnTxHash), {signal: ctl.signal});
    if (res.status === 404) return {state: 'pending'};
    if (!res.ok) throw new Error('cctp status unreachable');
    return parseCctpMessageStatus(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/** Everything the handoff screen renders and the user's EVM wallet needs: the two exact
 *  transactions (USDC approve → TokenMessengerV2, then depositForBurnWithHook to it), the
 *  honest fee numbers behind them, and the frozen destination facts for the copy. The fee
 *  is fetched LIVE (again) — the confirm-time census is display history by now; what is
 *  signed is what Circle charges right now. */
export type CctpHandoff = {
  /** The token the approve pulls and the burn burns: canonical mainnet USDC. */
  burnToken: string;
  /** The spender of BOTH txs: TokenMessengerV2. */
  tokenMessenger: string;
  approveCalldata: string;
  burnCalldata: string;
  /** The burn amount in USDC base units — the record's own minOut, deterministic. */
  amountSubunits: string;
  /** Circle's live fee numbers at handoff (the maxFee is what the burn signs). */
  minimumFeeBps: string;
  maxFeeSubunits: string;
  mintFloorSubunits: string;
  mintRecipientAta: string;
  destinationDomain: number;
  minFinalityThreshold: number;
};

/** Build the handoff for a record parked at `awaiting_external`. Refuses (never renders a
 *  stale screen) if the record is not in the handoff phase, or if the re-derived mint
 *  recipient does not match the one frozen at prepare — the derivation changing is a
 *  refuse-and-rebuild situation, not a render-what-we-can. */
export async function buildCctpHandoff(secretHex: string, rec: ConvertRecord): Promise<CctpHandoff> {
  if (rec.crossRail == null || rec.step !== 'awaiting_external') {
    throw new Error('record is not awaiting the external signature');
  }
  const burnAmount = BigInt(await convertRecordMinOut(rec));
  const kp = deriveSolanaKeypair(secretHex);
  const ata = deriveAta(kp.address, USDC_MINT_ADDRESS);
  if (bs58.encode(ata) !== rec.crossRail.mintRecipientAta || kp.address !== rec.crossRail.solAddress) {
    // Deterministic derivation drifted from the frozen facts — do not offer a burn whose
    // recipient this build cannot vouch for. Honest refusal; the user re-prepares.
    throw new Error('cross-rail destination derivation mismatch');
  }
  const fee = await fetchCctpBurnFee();
  const maxFee = cctpMaxFee(burnAmount, fee);
  return {
    burnToken: USDC_ERC20_ADDRESS,
    tokenMessenger: TOKEN_MESSENGER_V2_ADDRESS,
    approveCalldata: encodeErc20Approve(TOKEN_MESSENGER_V2_ADDRESS, burnAmount),
    burnCalldata: encodeDepositForBurnWithHook({
      amount: burnAmount,
      destinationDomain: CCTP_DOMAIN_SOLANA,
      mintRecipientHex64: bytesToHex(ata),
      burnToken: USDC_ERC20_ADDRESS,
      maxFee,
      minFinalityThreshold: CCTP_FINALITY_FAST,
      hookDataHex: buildForwardHookData(bytesToHex(kp.publicKey)),
    }),
    amountSubunits: burnAmount.toString(),
    minimumFeeBps: fee.minimumFeeBps.toString(),
    maxFeeSubunits: maxFee.toString(),
    mintFloorSubunits: cctpMintFloor(burnAmount, maxFee).toString(),
    mintRecipientAta: bs58.encode(ata),
    destinationDomain: CCTP_DOMAIN_SOLANA,
    minFinalityThreshold: CCTP_FINALITY_FAST,
  };
}

/** The user's wallet signed and reported the burn tx hash: freeze it, mark the cctp_burn
 *  leg sent, and move to `crossing` — the mint-watch state. Pure store mutation; the
 *  resume engine picks the record up from here. Exported for the handoff UI (and the e2e
 *  seam behind it). */
export function attachCctpBurnTx(rec: ConvertRecord, burnTxHash: string): ConvertRecord {
  if (rec.crossRail == null || rec.step !== 'awaiting_external') return rec;
  // A malformed hash is a caller bug (the UI gates the button on non-empty input and the
  // engine wrapper surfaces this message) — throw, never silently no-op the user's report.
  if (!/^0x[0-9a-fA-F]{64}$/.test(burnTxHash)) throw new Error(M.convert.crossrail.burnTxInvalid);
  const planIdx = rec.legPlan?.findIndex(p => p.kind === 'cctp_burn') ?? -1;
  const legPlan = rec.legPlan?.map((p, i) => (i === planIdx ? {...p, state: 'sent' as const} : p));
  return {...rec, step: 'crossing', legPlan, crossRail: {...rec.crossRail, burnTxHash}};
}

/** The user declines to sign in their wallet: an honest DEAD-END, not a failure of the
 *  chain — the five IC legs completed, so the funds sit as USDC AT THE USER'S OWN EVM
 *  ADDRESS, spendable by that wallet. The copy names exactly that. */
export function declineCctpHandoff(rec: ConvertRecord): ConvertRecord {
  if (rec.crossRail == null || rec.step !== 'awaiting_external') return rec;
  const planIdx = rec.legPlan?.findIndex(p => p.kind === 'cctp_burn') ?? -1;
  const legPlan = rec.legPlan?.map((p, i) => (i === planIdx ? {...p, state: 'failed' as const} : p));
  return {
    ...rec,
    step: 'failed_leg',
    legPlan,
    failureCode: 'external_declined',
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
