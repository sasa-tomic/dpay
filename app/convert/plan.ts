import {DpayCore} from '../services/native';
import {fetchGasFeeWei, fetchLedgerFee, railBalanceOf} from '../services/rail';
import {icStampExpiry} from '../services/icp';
import {randNonceHex} from '../lib/format';
import {
  isValidDestinationAddress,
  BUNDLED_NETWORKS,
  icpCatalogOf,
  type CurrencyDescriptor,
} from '../config/catalog';
import {gasFundRoutes, type GasFundRoute, type HubRoute, type MultihopRoute} from '../routes';
import {CONVERT_APPROVE_LIFETIME_S} from '../config/convert';
import {DPAY_CANISTER_PRINCIPALS, venueOfId} from '../config/venues';
import {deriveSolanaKeypair} from '../solana/identity';
import {deriveAta} from '../solana/spl';
import bs58 from 'bs58';
import {USDC_MINT_ADDRESS, WRAPPED_SOL_MINT_ADDRESS} from '../solana/tokens';
import {CCTP_FINALITY_FAST, cctpMaxFee, cctpMintFloor, resolveCctpBurnSigner} from '../cctp';
import {deriveEvmKeypair} from '../evm/identity';
import {M} from '../i18n';
import {
  type ConvertRecord,
  type CrossRailInfo,
  type GasFundPlan,
  type LegPlan,
  type ResolvedGasFundPlan,
} from './types';
import {type ConvertMath, type ConvertQuote, fetchConvertQuote} from './quotes';
import {fetchCctpBurnFee} from './cctp';
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
      console.warn('gas-fund: gas-ledger balance unreadable - refusing to prepend funding legs');
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
  // burn leg (+ Route C's final Jupiter leg). The burn's SIGNER is frozen here (swap-typing
  // stage 2, 2026-10-03): a destination that IS the device's own derived EVM address means
  // the device key signs the burn itself (burnSigner 'device' - the executor drives approve +
  // depositForBurnWithHook through the EVM rail; no handoff, no typed field); any other
  // destination freezes 'external' and the WalletConnect handoff stays the advanced override.
  // The device-derived SOL address + its USDC ATA (the mint recipient) are frozen either way,
  // and the census is priced with Circle's live fee. The calldata itself is built at burn
  // time (device path) or handoff time (external path) from this record.
  // FEE-BEFORE-SIGNING (honest order): the fee is fetched BEFORE any leg is signed, so an
  // unreachable Circle census leaves NOTHING signed - same fail-closed rule as route gas.
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
      // The signer decision: a pure compare against the device's own derivation, frozen so
      // every later driver (executor, handoff, hydration) agrees on who owns the burn.
      burnSigner: resolveCctpBurnSigner(destAddress, deriveEvmKeypair(secretHex).address),
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
      // The cross-rail tail: the CCTP burn (no IC canister — device-signed when the
      // destination is the device's own EVM address, the WalletConnect handoff otherwise)
      // and, on Route C, the final device-signed Jupiter leg. Both start pending; the
      // executor never submits them via the IC rail.
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
