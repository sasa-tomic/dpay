// prepareEvm — the EVM convert's confirm-time prepare (the any-pair mandate, 2026-09-28).
//
// The red lines every other prepare enforces, in the EVM vocabulary:
//   • the venue row EXISTS and is a mainnet `evm_amm` (resolved via venueOfId — a stored/
//     roaming id that names no row never reaches the chain);
//   • the quote names the pair the row trades (rail-id equality — a cross-chain answer is
//     structurally impossible and still checked);
//   • THE GAS GATE runs a dry probe BEFORE the record is adopted: the sequence's aggregate
//     worst-case fee must fit the wallet's native balance, or prepare refuses and NOTHING is
//     created (the executor re-checks at drive time — prices move; the gate is the honest
//     verdict at both moments, never a stale allowance);
//   • dpay never custodies: the device key signs at execution, gas is the user's own.
//
// Unlike the Solana leg, NOTHING is signed here: EVM legs are signed at drive time (nonces
// move between sessions), so the record freezes FACTS (amounts, floor, tier, deadline) and
// the executor rebuilds the exact byte plan from them.
import {DpayCore} from '../services/native';
import {deriveEvmAddress} from '../evm';
import {
  estimateUniswapSequenceFee,
  readEvmRailBalance,
} from '../evm';
import {venueOfId, type VenueEntry} from '../config/venues';
import {evmAmmChainOf, evmAmmRailId, type EvmAmmChain} from '../config/evmAmm';
import {planTokenToNative, planTokenToToken, planTokenViaWethHub, type UniswapSwapPlan} from '../evm/uniswapPlan';
import {M} from '../i18n';
import {type ConvertRecord, type EvmSwapLeg} from './types';

const SWAP_WINDOW_SECS = 600n; // the seed's ten-minute trade window

export type EvmConvertPrepareArgs = {
  secretHex: string;
  /** The FRESH quote from the confirm gesture (the sheet re-quotes; prepare re-checks). */
  quote: {
    venueId: string;
    feeTier: number;
    amountIn: string; // raw
    amountOut: string; // raw
    tokenIn: string; // lowercase address
    tokenOut: string; // lowercase address ('' = native out → the unwrap path)
    outRailId: string;
    /** The WETH-hub composition facts when the quote was the hub fallback. */
    hub?: {feeTierLeg1: number; feeTierLeg2: number; minOutLeg1: string};
  };
  inSymbol: string;
  outSymbol: string;
  inDecimals: number;
  outDecimals: number;
  slippageBps: number;
};

/** Resolve the venue row + chain facts, prove the pair, and freeze the record. Throws the
 *  shared error vocabulary on any red-line breach (nothing adopted, nothing signed). */
export async function prepareEvmConvertRecord(args: EvmConvertPrepareArgs): Promise<{record: ConvertRecord; plan: UniswapSwapPlan; chain: EvmAmmChain}> {
  const {quote} = args;
  // Red line 1: the venue row, from the registry.
  const venue: VenueEntry | null = venueOfId(quote.venueId);
  if (venue == null || venue.kind !== 'evm_amm' || venue.testnet) {
    throw new Error(M.convert.errors.quoteUnavailable('venue'));
  }
  const chain = evmAmmChainOf(venue.venue_id);
  if (chain == null) throw new Error(M.convert.errors.quoteUnavailable('venue'));
  // Red line 2: the quote names the pair the row trades (rail-id set equality). The compare
  // is RAIL-CANONICAL (evmAmmRailId lowercases): the registry pins chain tokens checksummed
  // (app/evm/chains.ts) while the venue rows derive lowercase - the live ZCHF->ETH D31 trip
  // (2026-10-03) died here at 'pool' with a perfectly quotable pair on the table.
  if (!venue.pair_ledgers.includes(quote.outRailId)
    || !venue.pair_ledgers.some(l => l !== quote.outRailId && l === evmAmmRailId(chain.id, quote.tokenIn))) {
    throw new Error(M.convert.errors.quoteUnavailable('pool'));
  }
  const from = deriveEvmAddress(args.secretHex);
  const deadlineSecs = BigInt(Math.floor(Date.now() / 1000)) + SWAP_WINDOW_SECS;
  const minOut = await DpayCore.icpSwapMinOut(quote.amountOut, args.slippageBps);
  if (!/^\d+$/.test(minOut) || BigInt(minOut) <= 0n) {
    throw new Error(M.convert.errors.quoteUnavailable('shape'));
  }
  const hub = quote.hub;
  const plan = quote.tokenOut === ''
    ? planTokenToNative({chain, tokenIn: quote.tokenIn, amountIn: BigInt(quote.amountIn), minOut: BigInt(minOut), feeTier: quote.feeTier, deadlineSecs})
    : hub != null
      ? planTokenViaWethHub({chain, tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, amountIn: BigInt(quote.amountIn), minOutLeg1: BigInt(hub.minOutLeg1), minOut: BigInt(minOut), feeTierLeg1: hub.feeTierLeg1, feeTierLeg2: hub.feeTierLeg2, deadlineSecs})
      : planTokenToToken({chain, tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, amountIn: BigInt(quote.amountIn), minOut: BigInt(minOut), feeTier: quote.feeTier, deadlineSecs});
  // The dry GAS GATE: refuse before anything is adopted (the executor re-runs it live).
  const fee = await estimateUniswapSequenceFee(args.secretHex, {chainId: chain.id, plan});
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
      address: from,
    });
  }
  // The OUT balance baseline (the realized-credit read's pre-figure; null fails open).
  const preOutRaw = await readEvmRailBalance(chain.id, args.secretHex, quote.tokenOut === '' ? null : quote.tokenOut);

  const leg: EvmSwapLeg = {
    protocol: 'evm',
    chainId: chain.id,
    venueId: venue.venue_id,
    inRailId: evmAmmRailId(chain.id, quote.tokenIn), // canonical (lowercase) - the record's rail id
    outRailId: quote.outRailId,
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    inSymbol: args.inSymbol,
    outSymbol: args.outSymbol,
    inDecimals: args.inDecimals,
    outDecimals: args.outDecimals,
    amountIn: quote.amountIn,
    minOut,
    feeTier: quote.feeTier,
    deadlineSecs: Number(deadlineSecs),
    slippageBps: args.slippageBps,
    ...(hub != null ? {hub} : {}),
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
    expectedGross: quote.amountOut,
    expectedNet: minOut, // the honest floor, exactly like the Solana shape
    inFee: '0',
    outFee: '0',
    slippageBps: args.slippageBps,
    legs: [],
    evmSwap: leg,
  };
  return {record, plan, chain};
}
