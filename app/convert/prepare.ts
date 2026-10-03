import {DpayCore} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {bytesToHex, randNonceHex, rawToDecimal, toUnits} from '../lib/format';
import {utf8ToBytes} from '../lib/base64url';
import {type CurrencyDescriptor, BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {CONVERT_APPROVE_LIFETIME_S, CONVERT_CEFI_CONFIRM_TIMEOUT_MS, type ChainConvertRoute, type ComposedConvertRoute} from '../config/convert';
import {DPAY_CANISTER_PRINCIPALS, cefiFamilyOf, cefiOtherSide, venueOfId} from '../config/venues';
import {CCTP_DESTINATION_NETWORK} from '../routes';
import {deriveSolanaAddress} from '../solana/identity';
import {sideShiftStatusUrl, type SideShiftFixedShift} from '../services/sideshift';
import {trocadorStatusUrl, type TrocadorTrade} from '../services/trocador';
import {M} from '../i18n';
import {type ConvertRecord, type ChainRouteInfo, type LegPlan, type SignedLeg} from './types';
import {type CeFiQuoteResult, type ConvertMath, type ConvertQuote, ceFiServiceError, createCeFiOrder, deriveConvertMath, fetchCeFiQuoteResult, fetchConvertQuote} from './quotes';
import {sameDecimalAmount} from './records';
import {buildChainDepositLeg} from './chainDeposit';
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
  /** The record id — minted by the CONFIRM PATH before order creation and sent to the
   *  relay as the trade's `clientOrderId` (2026-09-22 partner agreement): the record that
   *  persists locally IS the correlation id the relay logs for the trade. Required so the
   *  compiler pins the two ends of that link — a generated-here id could never match. */
  id: string;
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
  // The relay's own order id (X-Dpay-Order-Id, the agreement's correlation key) — present
  // only on a trocador order answered by the agreement-era relay. Persisted on the
  // providerRef so it survives reload; absent (null / empty / sideshift) persists nothing.
  const relayOrderId = 'relayOrderId' in order && typeof order.relayOrderId === 'string'
    && order.relayOrderId.length > 0
    ? order.relayOrderId
    : null;
  return {
    id: args.id,
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
      ...(relayOrderId != null ? {relayOrderId} : {}),
    },
    providerDeposit: {
      depositAddress: order.depositAddress,
      depositAmount: order.depositAmount,
      ...(order.depositMemo != null ? {depositMemo: order.depositMemo} : {}),
      ...(Number.isSafeInteger(expiresAtMs) && expiresAtMs > 0 ? {expiresAtMs} : {}),
    },
    // destAddress is the payout's durable destination: for the EVM-native settle widening
    // (2026-09-27, outLedger === ETH_NATIVE_RAIL_ID) this is the device's OWN EVM address,
    // EIP-55-checksummed. INBOUND NATIVE ETH HAS NO ERC-20 TRANSFER LOG — a plain value
    // transfer emits no Transfer event, so it intentionally does not appear in the EVM
    // chain-history surface (evm/history.ts reads Transfer logs only). The COMPLETION
    // PROOF is this record (outAmountNet + outTx = the venue's settleHash) plus the
    // native gas balance the EVM receive/send surfaces read (eth_getBalance — useEvmBalances'
    // gas map); the done panel names the payout address (convert-payout-address).
    destAddress: settleAddress,
    destSymbol: args.outSymbol,
  };
}

// --- the composed IC→CeFi prepare (2026-09-26, design brief §5.4 item 2) ----------------------------

/** The review's IC quote moved before the confirm gesture landed — the caller re-reviews
 *  (the sheet shows old then new inline and re-arms the same button). Thrown BEFORE the
 *  venue order is created, so a re-review never orphans a venue-side order. */
export class ComposedQuoteChangedError extends Error {
  readonly reviewedGrossRaw: string;
  readonly freshGrossRaw: string;
  constructor(args: {inSymbol: string; inDecimals: number; reviewedGrossRaw: string; freshGrossRaw: string}) {
    super(M.convert.rateMoved(
      `${rawToDecimal(args.reviewedGrossRaw, args.inDecimals)} ${args.inSymbol}`,
      `${rawToDecimal(args.freshGrossRaw, args.inDecimals)} ${args.inSymbol}`,
    ));
    this.name = 'ComposedQuoteChangedError';
    this.reviewedGrossRaw = args.reviewedGrossRaw;
    this.freshGrossRaw = args.freshGrossRaw;
  }
}

/** The ICP ledger is the ONE IC ledger whose legacy `transfer` reaches a 64-hex account
 *  identifier — derived from the catalog row, never a literal here. */
const ICP_MAINNET_LEDGER = icpCatalogOf(BUNDLED_NETWORKS).find(c => c.currency === 8 && !c.testnet)?.ledger ?? '';

/**
 * Prepare ONE COMPOSED IC→CeFi intent as a single signed record (brief §5.4 item 2): the
 * IC legs (one direct pool leg, or a 2-leg hub composition) land the hub asset in the
 * wallet, and a REGISTERED cefi venue's order carries it the rest of the way — with the
 * venue's deposit transfer signed HERE as the LAST leg of the SAME intent.
 *
 * Order of operations is the whole point: the venue order is created FIRST (steps 3-4), so
 * the venue's OWN deposit address and locked figure are known before ANYTHING is signed
 * (step 5). The transfer then signs to the venue's own address for the EXACT order amount —
 * the amount the IC chain is floored to deliver (its last leg's min-out) — and the user
 * consents to all of it on the ONE review. dpay is never a party: the order is the user's,
 * the transfer is the user's signature, the payout lands at the user's own settle address.
 *
 * Red lines, every leg (the phone signs, so the phone enforces): each quote's venue
 * registered with its endpoint AS the quoted pool, each quote FOR its route leg, no
 * dpay-owned canister anywhere in the target set, the deposit address resolved through the
 * core's own validators (ICRC-1 text or the ICP ledger's account identifier — never
 * guessed), and the venue's deposit address never the user's own account.
 */
export async function prepareComposedConvertRecord(args: {
  /** The record id — minted by the CONFIRM PATH before order creation and sent to the
   *  relay as the trade's `clientOrderId` (the cefi prepare's correlation rule). */
  id: string;
  secretHex: string;
  publicHex: string;
  relayUrl: string;
  route: ComposedConvertRoute;
  inDesc: CurrencyDescriptor;
  /** Leg 1's quote — FRESH at confirm (the caller re-quotes; the engine re-verifies). */
  quote1: ConvertQuote;
  math1: ConvertMath;
  /** Leg 2's quote + math for a hub-composed IC phase (`route.legs.length === 2`), quoted
   *  on `math1.minOut` — enforced below. Absent for a direct IC leg. */
  quote2?: ConvertQuote;
  math2?: ConvertMath;
  /** The reviewed IC gross (the review card's figure). A fresh gross that differs throws
   *  ComposedQuoteChangedError — re-review, nothing created, nothing signed. */
  reviewedGrossRaw: string;
}): Promise<ConvertRecord> {
  const {route, quote1, math1} = args;
  const quote2 = args.quote2;
  const math2 = args.math2;
  const icLegs = route.legs.length;
  if ((icLegs !== 1 && icLegs !== 2) || route.endpoints.length !== icLegs + 1) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  if (icLegs === 2 && (quote2 == null || math2 == null)) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  const depositEp = route.endpoints[icLegs]!;
  if (depositEp.fee == null || depositEp.decimals == null) {
    throw new Error(M.convert.errors.quoteUnavailable('symbol'));
  }
  const inSymbol = args.inDesc.backing_symbol ?? args.inDesc.symbol;
  if (inSymbol == null) throw new Error(M.convert.errors.quoteUnavailable('symbol'));
  if (quote1.zeroForOne == null || (icLegs === 2 && quote2!.zeroForOne == null)) {
    throw new Error(M.convert.errors.quoteUnavailable('direction'));
  }
  // (1) Signing-boundary red lines, per IC leg: the quote's own venue registered with its
  // endpoint AS the quoted pool, and each quote FOR its route leg.
  const leg1 = route.legs[0]!;
  const venue1 = venueOfId(quote1.venueId);
  if (venue1 == null || venue1.endpoint !== quote1.pool || quote1.pool !== leg1.pool
    || quote1.tokenInLedger !== leg1.fromLedger || quote1.tokenOutLedger !== leg1.toLedger
    || leg1.fromLedger !== route.endpoints[0]!.ledger || leg1.toLedger !== route.endpoints[1]!.ledger) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  if (icLegs === 2) {
    const leg2 = route.legs[1]!;
    if (quote2 == null) throw new Error(M.convert.errors.quoteUnavailable('pool'));
    const venue2 = venueOfId(quote2.venueId);
    if (venue2 == null || venue2.endpoint !== quote2.pool || quote2.pool !== leg2.pool
      || quote2.tokenInLedger !== leg2.fromLedger || quote2.tokenOutLedger !== leg2.toLedger
      || leg2.fromLedger !== route.endpoints[1]!.ledger || leg2.toLedger !== depositEp.ledger) {
      throw new Error(M.convert.errors.quoteUnavailable('pool'));
    }
    // The composition floor: leg 2 must be quoted on EXACTLY leg 1's min-you'll-receive.
    if (quote2.amountIn !== math1.minOut) {
      throw new Error(M.convert.errors.quoteUnavailable('pool'));
    }
  }
  for (const target of [...route.endpoints.map(e => e.ledger), ...route.legs.map(l => l.pool)]) {
    if (DPAY_CANISTER_PRINCIPALS.includes(target)) {
      throw new Error(M.convert.errors.quoteUnavailable('venue'));
    }
  }
  // (2) THE QUOTE-CHANGED GATE — before the venue order exists, so a re-review never
  // orphans one. (The CeFi settle figure gets NO exact-match gate: a ticking venue rate
  // can never be matched and the gate would livelock — the ORDER is the lock, the standing
  // cefi rule; its locked figures freeze onto the record verbatim.)
  if (args.reviewedGrossRaw !== quote1.amountOutGross) {
    throw new ComposedQuoteChangedError({
      inSymbol, inDecimals: args.inDesc.decimals ?? 8,
      reviewedGrossRaw: args.reviewedGrossRaw, freshGrossRaw: quote1.amountOutGross,
    });
  }
  // (3) The cefi venue must be a real registered row serving exactly this deposit→settle.
  const cefiVenue = venueOfId(route.cefiVenueId);
  if (cefiVenue == null || cefiVenue.kind !== 'cefi' || cefiVenue.testnet
    || cefiOtherSide(cefiVenue, depositEp.ledger) !== route.settleMint) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  // (4) The deposit amount is the IC chain's GUARANTEED minimum (its last leg's floor):
  // the swap can deliver more (the surplus stays in-wallet) but never less, so the venue's
  // locked order prices an amount the chain is floored to fund.
  const minOut1 = await DpayCore.icpSwapMinOut(quote1.amountOutGross, math1.slippageBps);
  if (!/^\d+$/.test(minOut1) || BigInt(minOut1) <= 0n) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  const minOutFinal = icLegs === 2 ? math2!.minOut : minOut1;
  if (!/^\d+$/.test(minOutFinal) || BigInt(minOutFinal) <= 0n) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  const depositAmountDecimal = rawToDecimal(minOutFinal, depositEp.decimals);
  // (5) THE ORDER FIRST — the venue's own deposit address + locked figure are known before
  // anything signs. The settle address is the user's own derived address (never typed);
  // the refund address is the user's own account ON THE DEPOSIT RAIL (the fund-loss guard,
  // the account-identifier form the venue's ICP payout layer requires).
  const settleAddress = deriveSolanaAddress(args.secretHex);
  const refundPrincipal = await DpayCore.icpPrincipalFromPubkey(args.publicHex);
  const refundAddress = await DpayCore.icpAccountIdFromPrincipal(refundPrincipal, '');
  let quoteRes: CeFiQuoteResult;
  try {
    quoteRes = await fetchCeFiQuoteResult(
      args.relayUrl, cefiVenue, depositEp.ledger, route.settleMint,
      depositAmountDecimal, CONVERT_CEFI_CONFIRM_TIMEOUT_MS,
    );
  } catch (e) {
    throw ceFiServiceError(e, cefiVenue.display_name);
  }
  let order: SideShiftFixedShift | TrocadorTrade;
  try {
    order = await createCeFiOrder(args.relayUrl, cefiVenue, quoteRes, {
      settleAddress,
      refundAddress,
      depositLedger: depositEp.ledger,
      settleLedger: route.settleMint,
      depositAmountDecimal,
      clientOrderId: args.id,
    }, CONVERT_CEFI_CONFIRM_TIMEOUT_MS);
  } catch (e) {
    throw ceFiServiceError(e, cefiVenue.display_name);
  }
  // (6) The order's own verdict, verified before a byte is signed: same-amount deposit
  // (decimal-value compare — a venue that reformats its own echo still adopts; a DIFFERENT
  // amount is a different trade and refuses, the standing cefi rule), a real order id, a
  // real deposit address.
  const orderId = 'id' in order ? order.id : order.tradeId;
  if (orderId.length === 0 || order.depositAddress.length === 0) {
    throw new Error(M.convert.errors.quoteUnavailable('order'));
  }
  if (!sameDecimalAmount(order.depositAmount, depositAmountDecimal)) {
    throw new Error(M.convert.errors.quoteUnavailable('deposit'));
  }
  // (7) The deposit destination, resolved through the core's own validators — ICRC-1
  // account text first, else the ICP ledger's 64-hex account identifier (the one namespace
  // only the ICP ledger's legacy transfer reaches, and its memo is a bare nat64, so a
  // venue memo cannot ride there — refuse rather than drop it). Anything else is refused,
  // never guessed. The venue's address must never be a dpay canister or the user's own
  // account (a hostile registry must not turn the deposit into a self-transfer).
  const memoHex = order.depositMemo != null && order.depositMemo.length > 0
    ? bytesToHex(utf8ToBytes(order.depositMemo))
    : '';
  let depositMethod: 'icrc1_transfer' | 'transfer';
  let depositOwner: string;
  let depositArgHex: string;
  let icrc: {owner: string; subaccountHex: string} | null = null;
  try {
    icrc = await DpayCore.icpValidateIcrcAccount(order.depositAddress);
  } catch {
    icrc = null;
  }
  if (icrc != null) {
    depositMethod = 'icrc1_transfer';
    depositOwner = icrc.owner;
    depositArgHex = await DpayCore.icpTransferArg(icrc.owner, icrc.subaccountHex, '', minOutFinal, depositEp.fee, memoHex);
  } else {
    let acct: string | null = null;
    try {
      acct = await DpayCore.icpValidateAccountId(order.depositAddress);
    } catch {
      acct = null;
    }
    const memo = order.depositMemo;
    if (acct == null || depositEp.ledger !== ICP_MAINNET_LEDGER || (memo != null && memo.length > 0)) {
      throw new Error(M.convert.errors.quoteUnavailable('order'));
    }
    depositMethod = 'transfer';
    depositOwner = acct;
    depositArgHex = await DpayCore.icpLegacyTransferArg(acct, '', minOutFinal, depositEp.fee, '0');
  }
  if (DPAY_CANISTER_PRINCIPALS.includes(depositOwner.toLowerCase())) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  if (depositOwner.toLowerCase() === refundPrincipal.toLowerCase()) {
    throw new Error(M.convert.errors.quoteUnavailable('order'));
  }
  // (8) ALL the signing, one pass, one shared envelope window: the IC legs (the direct
  // flow's exact approve+swap pair, per leg), then the deposit transfer LAST — to the
  // venue's own address, for the EXACT order amount, hub fee on top (never out of the
  // order figure).
  const allowanceExpiryNs = await icStampExpiry(args.secretHex, CONVERT_APPROVE_LIFETIME_S);
  const envExpiry = await icStampExpiry(args.secretHex);
  const expiresAtMs = Number(BigInt(envExpiry) / 1_000_000n);
  const legs: SignedLeg[] = [];
  const legPlan: LegPlan[] = [];
  for (let k = 0; k < icLegs; k += 1) {
    const q = k === 0 ? quote1 : quote2!;
    const m = k === 0 ? math1 : math2!;
    const fromEp = route.endpoints[k]!;
    const toEp = route.endpoints[k + 1]!;
    const floor = k === 0 ? minOut1 : minOutFinal;
    const approveAmount = (BigInt(q.amountIn) + BigInt(m.inFee)).toString();
    const approveArgHex = await DpayCore.icpApproveArg(q.pool, '', '', approveAmount, '', allowanceExpiryNs, '', m.inFee);
    const approveSigned = await DpayCore.icpSignUpdate(args.secretHex, fromEp.ledger, 'icrc2_approve', approveArgHex, envExpiry);
    legs.push({canister: fromEp.ledger, method: 'icrc2_approve', argHex: approveArgHex, envelopeHex: approveSigned.envelopeHex, requestIdHex: approveSigned.requestIdHex, expiresAtMs});
    legPlan.push({kind: 'approve', canister: fromEp.ledger, fee: m.inFee, state: 'pending'});
    const swapArgHex = await DpayCore.icpDepositAndSwapArg(q.amountIn, floor, m.inFee, toEp.fee, q.zeroForOne as boolean);
    const swapSigned = await DpayCore.icpSignUpdate(args.secretHex, q.pool, 'depositFromAndSwap', swapArgHex, envExpiry);
    legs.push({canister: q.pool, method: 'depositFromAndSwap', argHex: swapArgHex, envelopeHex: swapSigned.envelopeHex, requestIdHex: swapSigned.requestIdHex, expiresAtMs});
    legPlan.push({kind: 'swap', canister: q.pool, fee: '', state: 'pending'});
  }
  const depositSigned = await DpayCore.icpSignUpdate(args.secretHex, depositEp.ledger, depositMethod, depositArgHex, envExpiry);
  legs.push({canister: depositEp.ledger, method: depositMethod, argHex: depositArgHex, envelopeHex: depositSigned.envelopeHex, requestIdHex: depositSigned.requestIdHex, expiresAtMs});
  legPlan.push({kind: 'deposit_transfer', canister: depositEp.ledger, fee: depositEp.fee, state: 'pending'});

  const orderExpiresAtMs = order.expiresAt != null ? Date.parse(order.expiresAt) : NaN;
  const settleAmountRaw = order.settleAmount != null ? toUnits(order.settleAmount, route.settleDecimals) : null;
  const relayOrderId = 'relayOrderId' in order && typeof order.relayOrderId === 'string'
    && order.relayOrderId.length > 0
    ? order.relayOrderId
    : null;
  const firstHub = route.endpoints[1]!;
  return {
    id: args.id,
    createdAtMs: Date.now(),
    step: 'approving',
    venueId: quote1.venueId,
    ...(icLegs === 2 ? {venue2Id: quote2!.venueId} : {}),
    inCurrency: args.inDesc.currency,
    inLedger: args.inDesc.ledger,
    inSymbol,
    inDecimals: args.inDesc.decimals ?? undefined,
    // The OUT side is the SETTLE (final destination) — mint-keyed, the cefi precedent. The
    // first watchable ledger (swap1's payout) lives on hop*; a second IC leg's facts on the
    // hub record's dest*/venue2Id fields (the leg-2 watch keys on exactly those).
    outLedger: route.settleMint,
    outSymbol: route.settleSymbol,
    outDecimals: route.settleDecimals,
    hopLedger: firstHub.ledger,
    hopSymbol: firstHub.symbol,
    hopCurrency: firstHub.currency,
    hopDecimals: firstHub.decimals,
    ...(icLegs === 2 ? {
      destLedger: depositEp.ledger,
      destCurrency: depositEp.currency,
      destDecimals: depositEp.decimals,
      destFee: depositEp.fee,
      expectedGross2: quote2!.amountOutGross,
      expectedNet2: math2!.netOut,
      feeMillionths2: quote2!.feeMillionths,
    } : {}),
    amountIn: quote1.amountIn,
    expectedGross: quote1.amountOutGross,
    // The end-state line is the venue's OWN locked settle figure, in the OUT (settle)
    // asset's units — the IC hub fees are the legs' own census, never blended into it.
    expectedNet: settleAmountRaw ?? '0',
    inFee: math1.inFee,
    outFee: '0', // the settle side carries no IC ledger fee (a mint) — nothing dpay-derived
    slippageBps: math1.slippageBps,
    legs,
    legPlan,
    destAddress: settleAddress,
    destSymbol: route.settleSymbol,
    destNetwork: CCTP_DESTINATION_NETWORK,
    providerRef: {
      orderId,
      statusUrl: cefiFamilyOf(cefiVenue) === 'trocador'
        ? trocadorStatusUrl(args.relayUrl, orderId)
        : sideShiftStatusUrl(orderId),
      ...(relayOrderId != null ? {relayOrderId} : {}),
    },
    composedDeposit: {
      venueId: cefiVenue.venue_id,
      orderId,
      depositAddress: order.depositAddress,
      depositOwner,
      amountDecimal: order.depositAmount,
      amountRaw: minOutFinal,
      fee: depositEp.fee,
      settleSymbol: route.settleSymbol,
      settleDecimals: route.settleDecimals,
      ...(order.depositMemo != null && order.depositMemo.length > 0 ? {depositMemo: order.depositMemo} : {}),
      ...(order.settleAmount != null && settleAmountRaw != null
        ? {settleAmountDecimal: order.settleAmount, settleAmountRaw}
        : {}),
      ...(Number.isSafeInteger(orderExpiresAtMs) && orderExpiresAtMs > 0 ? {expiresAtMs: orderExpiresAtMs} : {}),
    },
  };
}

// --- the chain prepare (2026-09-28, the any-pair mandate) -------------------------------------------

/** ONE IC leg's input, under the chain's SELF-FUNDING fee rule: the venue's payout floor
 *  pays every IC fee, so leg k trades floor − 2×(its from-ledger fee) — the approve call's
 *  fee and the pull's on-top fee both come out of the landed mid asset, never out of a
 *  pre-held balance (a wallet may hold ZERO of the mid asset). Null when the floor cannot
 *  cover its own rails — a route whose legs cannot be funded is not a route. */
function chainLegInput(floor: string, fromFee: string): string | null {
  const net = BigInt(floor) - 2n * BigInt(fromFee);
  return net > 0n ? net.toString() : null;
}

/**
 * Prepare ONE CHAIN intent as a single record (the any-pair mandate, 2026-09-28): the cefi
 * venue's order is created FIRST (its deposit address + locked settle figure are known
 * before anything signs), the device signs ONE Solana deposit transfer funding it (frozen
 * bytes — the engine submits them; nothing here broadcasts), and the IC legs are planned
 * but NOT signed: an IC envelope dies at its own +300 s ingress expiry and a venue settles
 * on minutes, so phase 2 signs later from the record's own frozen leg plan, on a fresh
 * quote, when the venue's completion names the settle. The ONE consent at the CTA covers
 * the whole chain: the review showed both legs' venues and the plan's floor; slippage is
 * the consent axis phase 2 re-applies.
 *
 * Red lines, every leg: the venue's own locked deposit EXACTLY equals the reviewed amount
 * (the fixed order settles only its exact figure); the settle side is fully priced; no
 * dpay-owned canister anywhere in the plan; the deposit address is the venue's own, shape-
 * verified on-chain before the transfer signs (chainDeposit). dpay is never a party.
 */
export async function prepareChainConvertRecord(args: {
  /** The record id — minted by the CONFIRM PATH before order creation and sent to the
   *  relay as the trade's `clientOrderId` (the cefi prepare's correlation rule). */
  id: string;
  secretHex: string;
  publicHex: string;
  relayUrl: string;
  route: ChainConvertRoute;
  /** The reviewed source amount, raw mint units. */
  amountRaw: string;
  slippageBps: number;
  /** The user's own IC account id — the venue's settle address (never typed free-hand). */
  settleAddressIc: string;
}): Promise<ConvertRecord> {
  const {route} = args;
  if (route.legs.length !== 1 && route.legs.length !== 2) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  const midEp = route.endpoints[0]!;
  const destEp = route.endpoints[route.legs.length]!;
  if (midEp.fee == null || midEp.decimals == null || destEp.fee == null || destEp.decimals == null) {
    throw new Error(M.convert.errors.quoteUnavailable('symbol'));
  }
  // (1) The cefi venue must be a real registered row serving exactly deposit→settle.
  const cefiVenue = venueOfId(route.cefiVenueId);
  if (cefiVenue == null || cefiVenue.kind !== 'cefi' || cefiVenue.testnet
    || cefiOtherSide(cefiVenue, route.depositMint) !== midEp.ledger) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  // (2) No dpay-owned canister anywhere in the plan (the pools are the only IC targets).
  for (const leg of route.legs) {
    if (DPAY_CANISTER_PRINCIPALS.includes(leg.pool)) {
      throw new Error(M.convert.errors.quoteUnavailable('venue'));
    }
  }
  const depositDecimal = rawToDecimal(args.amountRaw, route.depositDecimals);
  // (3) THE ORDER FIRST — the venue's deposit address + locked figures exist before any
  // byte is signed. The settle address is the user's own IC account; the refund address is
  // the user's own account ON THE DEPOSIT RAIL (their Solana address).
  const refundSolAddress = deriveSolanaAddress(args.secretHex);
  let quoteRes: CeFiQuoteResult;
  try {
    quoteRes = await fetchCeFiQuoteResult(
      args.relayUrl, cefiVenue, route.depositMint, midEp.ledger,
      depositDecimal, CONVERT_CEFI_CONFIRM_TIMEOUT_MS,
    );
  } catch (e) {
    throw ceFiServiceError(e, cefiVenue.display_name);
  }
  let order: SideShiftFixedShift | TrocadorTrade;
  try {
    order = await createCeFiOrder(args.relayUrl, cefiVenue, quoteRes, {
      settleAddress: args.settleAddressIc,
      refundAddress: refundSolAddress,
      depositLedger: route.depositMint,
      settleLedger: midEp.ledger,
      depositAmountDecimal: depositDecimal,
      clientOrderId: args.id,
    }, CONVERT_CEFI_CONFIRM_TIMEOUT_MS);
  } catch (e) {
    throw ceFiServiceError(e, cefiVenue.display_name);
  }
  const orderId = 'id' in order ? order.id : order.tradeId;
  if (orderId.length === 0 || order.depositAddress.length === 0) {
    throw new Error(M.convert.errors.quoteUnavailable('order'));
  }
  // (4) THE EXACT-AMOUNT GATE: the fixed order settles only its exact deposit — anything
  // else is a different trade than the one the review showed (the standing cefi rule,
  // decimal-value compared so a reformatting venue still adopts its own echo).
  if (!sameDecimalAmount(order.depositAmount, depositDecimal)) {
    throw new Error(M.convert.errors.quoteUnavailable('deposit'));
  }
  // (5) The venue's locked settle figure IS phase 2's input — a chain route without one
  // cannot plan its IC legs and refuses (fail closed, never a guessed floor).
  const settleDecimal = order.settleAmount;
  if (settleDecimal == null || settleDecimal.length === 0) {
    throw new Error(M.convert.errors.quoteUnavailable('order'));
  }
  const settleRaw = toUnits(settleDecimal, midEp.decimals);
  if (!/^\d+$/.test(settleRaw) || BigInt(settleRaw) <= 0n) {
    throw new Error(M.convert.errors.quoteUnavailable('order'));
  }
  // (6) The IC leg plan: quote each leg on the SELF-FUNDED input (the previous floor minus
  // its own rails' fees), each quote through the plan's own registered pool.
  const icLegs = route.legs;
  const leg1In = chainLegInput(settleRaw, midEp.fee);
  if (leg1In == null) throw new Error(M.convert.errors.quoteUnavailable('pool'));
  const leg1 = icLegs[0]!;
  // The plan leg's OWN venue, fail-closed (audit F9): a registry miss refuses here - never a
  // bundled first-venue fallback whose answer could only die at the echo gate below.
  const leg1Venue = venueOfId(leg1.venueId);
  if (leg1Venue == null) throw new Error(M.convert.errors.quoteUnavailable('venue'));
  const quote1 = await fetchConvertQuote(args.relayUrl, leg1.fromLedger, leg1.toLedger, leg1In,
    {venue: leg1Venue});
  // The quote must BE the plan leg's own trade (venue, pool, ordered pair) — a relay
  // answer naming anything else is not this route's leg, and the disclosure figure would
  // not be the plan's. Fail before the deposit signs.
  if (quote1.venueId !== leg1.venueId || quote1.pool !== leg1.pool
    || quote1.tokenInLedger !== leg1.fromLedger || quote1.tokenOutLedger !== leg1.toLedger) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  if (quote1.zeroForOne == null) throw new Error(M.convert.errors.quoteUnavailable('direction'));
  const math1 = await deriveConvertMath(quote1, midEp.fee, route.endpoints[1]!.fee, args.slippageBps);
  let quote2: ConvertQuote | null = null;
  let math2: ConvertMath | null = null;
  if (icLegs.length === 2) {
    const leg2 = icLegs[1]!;
    const hubEp = route.endpoints[1]!;
    if (leg2.fromLedger !== hubEp.ledger || leg1.toLedger !== hubEp.ledger) {
      throw new Error(M.convert.errors.quoteUnavailable('pool'));
    }
    const leg2In = chainLegInput(math1.minOut, hubEp.fee);
    if (leg2In == null) throw new Error(M.convert.errors.quoteUnavailable('pool'));
    if (leg2.toLedger !== destEp.ledger) throw new Error(M.convert.errors.quoteUnavailable('pool'));
    const leg2Venue = venueOfId(leg2.venueId);
    if (leg2Venue == null) throw new Error(M.convert.errors.quoteUnavailable('venue'));
    quote2 = await fetchConvertQuote(args.relayUrl, leg2.fromLedger, leg2.toLedger, leg2In,
      {venue: leg2Venue});
    if (quote2.venueId !== leg2.venueId || quote2.pool !== leg2.pool
      || quote2.tokenInLedger !== leg2.fromLedger || quote2.tokenOutLedger !== leg2.toLedger) {
      throw new Error(M.convert.errors.quoteUnavailable('pool'));
    }
    if (quote2.zeroForOne == null) throw new Error(M.convert.errors.quoteUnavailable('direction'));
    math2 = await deriveConvertMath(quote2, hubEp.fee, destEp.fee, args.slippageBps);
  }
  // (7) THE DEPOSIT LEG — the venue's address shape is read off the chain, the transfer is
  // built + verified + signed, and NOTHING broadcasts: the frozen bytes ride the record.
  const depositLeg = await buildChainDepositLeg({
    secretHex: args.secretHex,
    cefiVenueId: route.cefiVenueId,
    depositAddress: order.depositAddress,
    depositMint: route.depositMint,
    amountRaw: args.amountRaw,
    ...(order.depositMemo != null && order.depositMemo.length > 0 ? {depositMemo: order.depositMemo} : {}),
  });
  const orderExpiresAtMs = order.expiresAt != null ? Date.parse(order.expiresAt) : NaN;
  const relayOrderId = 'relayOrderId' in order && typeof order.relayOrderId === 'string'
    && order.relayOrderId.length > 0
    ? order.relayOrderId
    : null;
  const chainRoute: ChainRouteInfo = {
    venueId: route.cefiVenueId,
    orderId,
    depositAddress: order.depositAddress,
    amountDecimal: order.depositAmount,
    amountRaw: args.amountRaw,
    settleAmountDecimal: settleDecimal,
    settleAmountRaw: settleRaw,
    icLegs: icLegs.map(l => ({venueId: l.venueId, pool: l.pool, fromLedger: l.fromLedger, toLedger: l.toLedger})),
    icFromFees: icLegs.map((_, k) => route.endpoints[k]!.fee!),
    ...(order.depositMemo != null && order.depositMemo.length > 0 ? {depositMemo: order.depositMemo} : {}),
    ...(Number.isSafeInteger(orderExpiresAtMs) && orderExpiresAtMs > 0 ? {expiresAtMs: orderExpiresAtMs} : {}),
  };
  return {
    id: args.id,
    createdAtMs: Date.now(),
    step: 'swapping',
    venueId: route.cefiVenueId,
    ...(icLegs.length === 2 ? {venue2Id: icLegs[1]!.venueId} : {}),
    // The IN side is the DEPOSIT (mint-keyed, the Solana record's own convention — no IC
    // catalog currency); the OUT side is the FINAL IC target. The hop is the venue's
    // settle ledger: the asset in-wallet once phase 1 lands, the phase-2 input.
    inLedger: route.depositMint,
    inSymbol: route.depositSymbol,
    inDecimals: route.depositDecimals,
    hopLedger: midEp.ledger,
    hopSymbol: midEp.symbol,
    hopCurrency: midEp.currency,
    hopDecimals: midEp.decimals,
    outLedger: destEp.ledger,
    outSymbol: destEp.symbol,
    outCurrency: destEp.currency,
    outDecimals: destEp.decimals,
    ...(icLegs.length === 2 ? {
      destLedger: destEp.ledger,
      destCurrency: destEp.currency,
      destDecimals: destEp.decimals,
      destFee: destEp.fee,
    } : {}),
    destNetwork: destEp.network,
    amountIn: args.amountRaw,
    expectedGross: toUnits(quoteRes.settleAmount, midEp.decimals),
    // The end-state line is the plan's final leg net (the OUT asset's units) — the
    // disclosure figure phase 2 re-derives on the venue's locked settle figure.
    expectedNet: math2 != null ? math2.netOut : math1.netOut,
    inFee: '0', // the deposit rail's fee is the transfer's own (solFeeLamports); no IC in-fee
    outFee: destEp.fee,
    slippageBps: args.slippageBps,
    legs: [],
    solanaLeg: {
      protocol: 'solana',
      signedTxHex: depositLeg.signedTxHex,
      signature: depositLeg.signature,
      lastValidBlockHeight: depositLeg.lastValidBlockHeight,
    },
    ...(depositLeg.feeLamports != null ? {solFeeLamports: depositLeg.feeLamports} : {}),
    destAddress: args.settleAddressIc,
    destSymbol: destEp.symbol,
    providerRef: {
      orderId,
      statusUrl: cefiFamilyOf(cefiVenue) === 'trocador'
        ? trocadorStatusUrl(args.relayUrl, orderId)
        : sideShiftStatusUrl(orderId),
      ...(relayOrderId != null ? {relayOrderId} : {}),
    },
    chainRoute,
  };
}
