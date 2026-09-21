import {DpayCore} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {randNonceHex, rawToDecimal} from '../lib/format';
import {type CurrencyDescriptor} from '../config/catalog';
import {CONVERT_APPROVE_LIFETIME_S} from '../config/convert';
import {DPAY_CANISTER_PRINCIPALS, cefiFamilyOf, cefiOtherSide, venueOfId} from '../config/venues';
import {
  sideShiftStatusUrl,
  type SideShiftFixedShift,
} from '../services/sideshift';
import {
  trocadorStatusUrl,
  type TrocadorTrade,
} from '../services/trocador';
import {M} from '../i18n';
import {type ConvertRecord} from './types';
import {type ConvertMath, type ConvertQuote} from './quotes';
import {sameDecimalAmount} from './records';
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
  /** The family's own order — SideShiftFixedShift (id) or TrocadorTrade (tradeId);
   *  normalized below. */
  order: SideShiftFixedShift | TrocadorTrade;
  /** The relay this phone talks to — the TROCADOR family's statusUrl points AT the relay
   *  (its status read is key-gated; there is no keyless venue host to poll). Unused for
   *  the sideshift family (its status host is keyless device-direct). */
  relayUrl: string;
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
  // the one the user approved). Compared as DECIMAL VALUES (sameDecimalAmount): a venue
  // that reformats its own echo ('1' → '1.00000000') must still ADOPT the order it
  // already created — a string-spelling refusal here would orphan a real venue-side
  // order and leave the record unadopted (the live attempt-#3 non-adoption class).
  const quotedDeposit = rawToDecimal(quote.amountIn, args.inDecimals ?? 8);
  if (!sameDecimalAmount(order.depositAmount, quotedDeposit)) {
    throw new Error(M.convert.errors.quoteUnavailable('deposit'));
  }
  const orderId = 'id' in order ? order.id : order.tradeId;
  if (settleAddress.length === 0 || orderId.length === 0) {
    throw new Error(M.convert.errors.quoteUnavailable('order'));
  }
  if (cefiFamilyOf(venue) === 'trocador' && args.relayUrl.length === 0) {
    // A trocador record without a relay to poll can never advance: refuse at birth
    // rather than strand the user in awaiting_deposit forever.
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
      orderId,
      // The sideshift family's status read is the venue's own KEYLESS device-direct GET
      // (the relay is not in the status path). The trocador family has NO keyless surface
      // — its status rides the relay's key-gated proxy, so the URL points there; the
      // resume engine allows that one http shape only when it matches the relay origin.
      statusUrl: cefiFamilyOf(venue) === 'trocador'
        ? trocadorStatusUrl(args.relayUrl, orderId)
        : sideShiftStatusUrl(orderId),
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
