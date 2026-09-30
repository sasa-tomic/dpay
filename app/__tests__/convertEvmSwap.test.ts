// The EVM convert (2026-09-28, the any-pair mandate) — the app-layer pins:
//   * PREPARE red lines — the venue row must resolve (a roaming id that names no row is
//     refused), the quote must name the row's pair (rail-id set equality), and the DRY GAS
//     GATE refuses before anything is adopted;
//   * THE RECORD — the frozen facts hydrate (the EvmSwapLeg widening, mutually exclusive with
//     every other shape), and the executor turns a gas-gate refusal into the honest
//     failed_refunded state with NOTHING signed.
import {describe, expect, jest, beforeEach, test} from '@jest/globals';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpSwapMinOut: jest.fn(async (gross: string, bps: number) =>
      (BigInt(gross) * BigInt(10_000 - bps) / 10_000n).toString()),
  },
}));
const mockEstimate = jest.fn<() => Promise<{maxFeeWei: string}>>();
const mockBalance = jest.fn<() => Promise<string | null>>();
jest.mock('../evm', () => ({
  deriveEvmAddress: () => '0x18884BC8e867eEf401703b702097220bdAe27668',
  estimateUniswapSequenceFee: () => mockEstimate(),
  readEvmRailBalance: () => mockBalance(),
  executeUniswapSequence: jest.fn(async () => { throw Object.assign(new Error('gas'), {name: 'EvmGasGateError', requiredWei: '1'}); }),
  readEvmTokenRaw: jest.fn(async () => null),
  readEvmNativeRaw: jest.fn(async () => null),
}));

import {prepareEvmConvertRecord} from '../convert/prepareEvm';
import {executeEvmConvert} from '../convert/executeEvm';
import {salvageConvertStore} from '../convert/records';
import type {ConvertRecord} from '../convert';

const SEED = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const ZCHF = '0xb58e61c3098d85632df34eecfb899a1ed80921cb';
const OUT_RAIL = 'evm:native-eth:1';

const quote = {
  venueId: 'uniswapv3-eth',
  feeTier: 3000,
  amountIn: (10n ** 17n).toString(),
  amountOut: (178n * 10n ** 12n).toString(),
  tokenIn: ZCHF,
  tokenOut: '',
  outRailId: OUT_RAIL,
};

describe('prepareEvmConvertRecord — red lines', () => {
  beforeEach(() => {
    mockEstimate.mockReset().mockResolvedValue({maxFeeWei: (10n ** 12n).toString()});
    mockBalance.mockReset().mockResolvedValue((10n ** 15n).toString());
  });

  test('a quote naming a foreign pair is refused (rail-id set equality)', async () => {
    await expect(prepareEvmConvertRecord({
      secretHex: SEED,
      quote: {...quote, outRailId: 'evm:native-eth:42161'},
      inSymbol: 'ZCHF', outSymbol: 'ETH', inDecimals: 18, outDecimals: 18,
      slippageBps: 100,
    })).rejects.toThrow();
  });

  test('an unknown venue id is refused before anything is created', async () => {
    await expect(prepareEvmConvertRecord({
      secretHex: SEED,
      quote: {...quote, venueId: 'roaming-venue'},
      inSymbol: 'ZCHF', outSymbol: 'ETH', inDecimals: 18, outDecimals: 18,
      slippageBps: 100,
    })).rejects.toThrow();
  });

  test('the dry gas gate refuses before the record exists', async () => {
    mockEstimate.mockResolvedValue({maxFeeWei: (10n ** 18n).toString()}); // fee > balance
    mockBalance.mockResolvedValue((10n ** 15n).toString());
    await expect(prepareEvmConvertRecord({
      secretHex: SEED,
      quote,
      inSymbol: 'ZCHF', outSymbol: 'ETH', inDecimals: 18, outDecimals: 18,
      slippageBps: 100,
    })).rejects.toMatchObject({name: 'EvmGasGateError'});
  });

  test('a passing gate freezes the record (floor, tier, rail ids, pre-balance)', async () => {
    const {record} = await prepareEvmConvertRecord({
      secretHex: SEED,
      quote,
      inSymbol: 'ZCHF', outSymbol: 'ETH', inDecimals: 18, outDecimals: 18,
      slippageBps: 100,
    });
    expect(record.step).toBe('swapping');
    expect(record.legs).toEqual([]);
    expect(record.evmSwap).toBeDefined();
    const leg = record.evmSwap!;
    expect(leg.venueId).toBe('uniswapv3-eth');
    expect(leg.tokenOut).toBe(''); // native out → the unwrap path
    expect(leg.inRailId).toBe(`evm:1:${ZCHF}`);
    expect(leg.outRailId).toBe(OUT_RAIL);
    expect(leg.minOut).toBe((BigInt(quote.amountOut) * 9900n / 10_000n).toString());
    expect(leg.preOutRaw).toBeDefined();
    expect(record.expectedNet).toBe(leg.minOut);
  });
});

describe('executeEvmConvert — the honest edges', () => {
  test('a drive-time gas-gate refusal parks failed_refunded (gas_short), nothing signed', async () => {
    const record: ConvertRecord = {
      id: 'testrec', createdAtMs: Date.now(), step: 'swapping', venueId: 'uniswapv3-eth',
      inLedger: `evm:1:${ZCHF}`, outLedger: OUT_RAIL, inSymbol: 'ZCHF', outSymbol: 'ETH',
      inDecimals: 18, outDecimals: 18, amountIn: quote.amountIn, expectedGross: quote.amountOut,
      expectedNet: quote.amountOut, inFee: '0', outFee: '0', slippageBps: 100, legs: [],
      evmSwap: {
        protocol: 'evm', chainId: 1, venueId: 'uniswapv3-eth',
        inRailId: `evm:1:${ZCHF}`, outRailId: OUT_RAIL, tokenIn: ZCHF, tokenOut: '',
        inSymbol: 'ZCHF', outSymbol: 'ETH', inDecimals: 18, outDecimals: 18,
        amountIn: quote.amountIn, minOut: quote.amountOut, feeTier: 3000,
        deadlineSecs: 387420489, slippageBps: 100,
      },
    };
    const updates: ConvertRecord[] = [];
    const next = await executeEvmConvert(record, {publicHex: 'pub', secretHex: SEED, onUpdate: r => { updates.push(r); }});
    expect(next.step).toBe('failed_refunded');
    expect(next.failureCode).toBe('gas_short');
  });
});

describe('hydration — the EvmSwapLeg widening', () => {
  test('an EVM record hydrates; mixing shapes refuses', () => {
    const rec = {
      id: 'r1', createdAtMs: 1, step: 'swapping', venueId: 'uniswapv3-eth',
      inLedger: `evm:1:${ZCHF}`, outLedger: OUT_RAIL, inSymbol: 'ZCHF', outSymbol: 'ETH',
      inDecimals: 18, outDecimals: 18, amountIn: '1', expectedGross: '2', expectedNet: '1',
      inFee: '0', outFee: '0', slippageBps: 100, legs: [],
      evmSwap: {
        protocol: 'evm', chainId: 1, venueId: 'uniswapv3-eth',
        inRailId: `evm:1:${ZCHF}`, outRailId: OUT_RAIL, tokenIn: ZCHF, tokenOut: '',
        inSymbol: 'ZCHF', outSymbol: 'ETH', inDecimals: 18, outDecimals: 18,
        amountIn: '1', minOut: '1', feeTier: 3000, deadlineSecs: 9, slippageBps: 100,
      },
    };
    const store = JSON.stringify({r1: rec});
    const out = salvageConvertStore(JSON.parse(store));
    expect(Object.keys(out.records)).toEqual(['r1']);
    // A bad step for the shape refuses.
    const bad = JSON.parse(JSON.stringify({r1: {...rec, step: 'awaiting_deposit'}}));
    expect(Object.keys(salvageConvertStore(bad).records)).toEqual([]);
    // A numeric-garbage amount refuses.
    const bad2 = JSON.parse(JSON.stringify({r1: {...rec, evmSwap: {...(rec as {evmSwap: object}).evmSwap, amountIn: 'x'}}}));
    expect(Object.keys(salvageConvertStore(bad2).records)).toEqual([]);
  });
});
