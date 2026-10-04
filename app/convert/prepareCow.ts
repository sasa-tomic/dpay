// prepareCow — the CoW Swap convert's confirm-time prepare (the second EVM venue, 2026-10-03).
//
// The red lines every other prepare enforces, in the CoW vocabulary:
//   • the venue row EXISTS, is a mainnet `evm_amm` of the `cowswap` family, and resolves
//     its chain facts (a stored/roaming id that names no row never reaches the venue);
//   • the quote names the pair the row trades (rail-id equality — a cross-chain answer is
//     structurally impossible and still checked);
//   • THE GAS GATE runs a dry probe BEFORE the record is adopted: the CHAIN legs' (approve,
//     plus the native-out unwrap) aggregate worst-case fee must fit the wallet's native
//     balance, or prepare refuses and NOTHING is created. The ORDER is gasless (the venue's
//     solver pays; the venue's own fee figure rides the quote verbatim — the honesty the
//     review card renders), so gas covers the legs only;
//   • dpay never custodies: the device key signs, the order trades from the user's own
//     wallet through the settlement contract.
//
// NOTHING is signed here either: the record freezes FACTS (amounts, floor, validTo,
// appData) and the executor re-signs deterministically (RFC 6979 — identical bytes) at
// drive time, exactly the V3 prepare's discipline with the order in place of the plan.
import {DpayCore} from '../services/native';
import {deriveEvmAddress} from '../evm';
import {
  estimateCowSequenceFee,
  readEvmRailBalance,
} from '../evm';
import {venueOfId, type VenueEntry} from '../config/venues';
import {evmAmmChainOf, evmAmmFamilyOf, evmAmmRailId, type EvmAmmChain} from '../config/evmAmm';
import {dpayCowAppDataHash} from '../evm/cowPlan';
import {type CowQuote} from '../evm/cow';
import {M} from '../i18n';
import {type ConvertRecord, type EvmSwapLeg} from './types';

export type CowConvertPrepareArgs = {
  secretHex: string;
  /** The FRESH CoW quote from the confirm gesture (the sheet re-quotes; prepare re-checks
   *  the pair and freezes the venue's own figures verbatim). */
  quote: {
    venueId: string;
    amountIn: string; // raw — the total the venue may pull (the order's sellAmount)
    buyAmount: string; // raw — the venue's own buy-side figure (before slippage)
    feeAmount: string; // raw — the venue's own fee estimate (sell units)
    protocolFeeBps?: string | null;
    validTo: number; // the venue's own order expiry (absolute unix seconds)
    tokenIn: string; // lowercase address
    tokenOut: string; // lowercase address ('' = native out → the WETH + unwrap path)
    outRailId: string;
  };
  inSymbol: string;
  outSymbol: string;
  inDecimals: number;
  outDecimals: number;
  slippageBps: number;
};

/** Resolve the venue row + chain facts, prove the pair, and freeze the record. Throws the
 *  shared error vocabulary on any red-line breach (nothing adopted, nothing signed). */
export async function prepareCowConvertRecord(args: CowConvertPrepareArgs): Promise<{record: ConvertRecord; chain: EvmAmmChain}> {
  const {quote} = args;
  // Red line 1: the venue row, from the adapter table, of the cowswap family.
  const venue: VenueEntry | null = venueOfId(quote.venueId);
  if (venue == null || venue.kind !== 'evm_amm' || venue.testnet
    || evmAmmFamilyOf(venue.venue_id) !== 'cowswap') {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  const chain = evmAmmChainOf(venue.venue_id);
  if (chain == null) throw new Error(M.convert.errors.quoteUnavailable('venue'));
  // Red line 2: the quote names the pair the row trades (rail-id set equality, canonical).
  if (!venue.pair_ledgers.includes(quote.outRailId)
    || !venue.pair_ledgers.some(l => l !== quote.outRailId && l === evmAmmRailId(chain.id, quote.tokenIn))) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  // The venue's own numbers must be the whole truth before anything freezes.
  if (!/^\d+$/.test(quote.amountIn) || BigInt(quote.amountIn) <= 0n
    || !/^\d+$/.test(quote.buyAmount) || BigInt(quote.buyAmount) <= 0n
    || !/^\d+$/.test(quote.feeAmount)
    || !Number.isInteger(quote.validTo) || quote.validTo <= 0 || quote.validTo > 0xffffffff) {
    throw new Error(M.convert.errors.quoteUnavailable('shape'));
  }
  // The SIGNED floor: the venue's own buy figure bitten by the slippage bps (the swap-
  // minimum honesty — the same core arithmetic every venue's floor runs through).
  const minOut = await DpayCore.icpSwapMinOut(quote.buyAmount, args.slippageBps);
  if (!/^\d+$/.test(minOut) || BigInt(minOut) <= 0n) {
    throw new Error(M.convert.errors.quoteUnavailable('shape'));
  }
  // The dry GAS GATE over the CHAIN legs (approve + native-out unwrap): refuse before
  // anything is adopted (the executor re-runs it live).
  const fee = await estimateCowSequenceFee(args.secretHex, {
    chainId: chain.id,
    tokenIn: quote.tokenIn,
    weth: chain.weth,
    pullAmount: BigInt(quote.amountIn),
    nativeOut: quote.tokenOut === '',
    unwrapAmount: BigInt(minOut),
    recipient: deriveEvmAddress(args.secretHex),
  });
  const gasWei = await readEvmRailBalance(chain.id, args.secretHex, null);
  if (gasWei == null) throw new Error(M.convert.errors.gasUnavailable);
  if (BigInt(gasWei) < BigInt(fee.maxFeeWei)) {
    const {EvmGasGateError} = await import('../evm/errors');
    throw new EvmGasGateError({
      requiredWei: fee.maxFeeWei,
      gasBalanceWei: gasWei,
      chainId: chain.id,
      chainName: chain.name,
      nativeSymbol: chain.nativeSymbol,
      address: deriveEvmAddress(args.secretHex),
    });
  }
  // The OUT balance baseline (the realized-credit read's pre-figure; null fails open).
  const preOutRaw = await readEvmRailBalance(chain.id, args.secretHex, quote.tokenOut === '' ? null : quote.tokenOut);

  const leg: EvmSwapLeg = {
    protocol: 'evm',
    chainId: chain.id,
    venueId: venue.venue_id,
    inRailId: evmAmmRailId(chain.id, quote.tokenIn), // canonical (lowercase) — the record's rail id
    outRailId: quote.outRailId,
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    inSymbol: args.inSymbol,
    outSymbol: args.outSymbol,
    inDecimals: args.inDecimals,
    outDecimals: args.outDecimals,
    amountIn: quote.amountIn,
    minOut,
    feeTier: 0, // no AMM pool tier — the venue's own cost facts ride the `cow` block
    deadlineSecs: quote.validTo, // the venue's own order expiry (the UID input + poll bound)
    slippageBps: args.slippageBps,
    cow: {
      buyAmount: quote.buyAmount,
      feeAmount: quote.feeAmount,
      ...(quote.protocolFeeBps != null ? {protocolFeeBps: quote.protocolFeeBps} : {}),
      appData: dpayCowAppDataHash(),
    },
    ...(preOutRaw != null ? {preOutRaw} : {}),
  };
  const record: ConvertRecord = {
    id: (await import('../lib/format')).randNonceHex(),
    createdAtMs: Date.now(),
    step: 'swapping',
    venueId: venue.venue_id,
    inCurrency: undefined,
    outCurrency: undefined,
    inLedger: leg.inRailId,
    outLedger: leg.outRailId,
    inSymbol: leg.inSymbol,
    outSymbol: leg.outSymbol,
    inDecimals: leg.inDecimals,
    outDecimals: leg.outDecimals,
    amountIn: leg.amountIn,
    expectedGross: quote.buyAmount,
    expectedNet: minOut, // the honest floor, exactly like the V3 shape
    inFee: '0',
    outFee: '0',
    slippageBps: args.slippageBps,
    legs: [],
    evmSwap: leg,
  };
  return {record, chain};
}

/**
 * Is the displayed CoW quote still signable AS DISPLAYED? CoW quotes carry the venue's own
 * `validTo` (absolute unix seconds) — an order signed inside that window locks the quoted
 * buyAmount at fulfillment, so the confirm gesture does not re-quote a LIVE quote (the
 * venue's per-fetch fee re-estimate jitters ±0.04%, and re-arming the confirm on that
 * jitter loops the 2-tap grammar — the 2026-10-04 live CoW trip needed 11 confirms in 3
 * minutes). An EXPIRED quote re-quotes and re-arms with the moved note. The
 * order-is-the-lock precedent: the plain-cefi branch (prepare.ts, 2026-09-26).
 */
export function cowQuoteFresh(quote: Pick<CowQuote, 'validTo'>, nowMs: number): boolean {
  if (!Number.isInteger(quote.validTo) || quote.validTo <= 0) return false;
  return quote.validTo * 1000 > nowMs;
}
