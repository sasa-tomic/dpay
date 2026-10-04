// The CoW convert (2026-10-03, the second EVM venue) — the app-layer pins:
//   * PREPARE red lines — the venue row must resolve to a `cowswap` family row (a Uniswap
//     id or a foreign id is refused), the quote must name the row's pair, the venue's own
//     numbers must be whole, and the dry GAS GATE refuses before anything is adopted;
//   * THE RECORD — the frozen facts hydrate (the `cow` widening), the executor freezes the
//     UID at submit and the realized figures at fulfillment, and every resume arm re-enters
//     idempotently (the approve/submit skip on their own frozen identities);
//   * HONEST EDGES — the venue's expired/cancelled is failed_refunded with the real cause
//     (an off-chain order never moved funds); a gas-gate refusal signs nothing.
import {describe, expect, jest, beforeEach, test} from '@jest/globals';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpSwapMinOut: jest.fn(async (gross: string, bps: number) =>
      (BigInt(gross) * BigInt(10_000 - bps) / 10_000n).toString()),
  },
}));
const mockEstimate = jest.fn<() => Promise<{maxFeeWei: string}>>();
const mockBalance = jest.fn<() => Promise<string | null>>();
const mockDrive = jest.fn<(secret: unknown, input: unknown, signal: unknown, onProgress: (p: object) => Promise<void>) => Promise<unknown>>();
const mockUnwrap = jest.fn<() => Promise<string>>();
jest.mock('../evm', () => ({
  deriveEvmAddress: () => '0x18884BC8e867eEf401703b702097220bdAe27668',
  estimateCowSequenceFee: () => mockEstimate(),
  readEvmRailBalance: () => mockBalance(),
  driveCowSequence: (secret: unknown, input: unknown, signal: unknown, onProgress: (p: object) => Promise<void>) => mockDrive(secret, input, signal, onProgress),
  unwrapCowWeth: () => mockUnwrap(),
  estimateUniswapSequenceFee: jest.fn(async () => ({maxFeeWei: '1'})),
  readEvmTokenRaw: jest.fn(async () => null),
  readEvmNativeRaw: jest.fn(async () => null),
  executeUniswapSequence: jest.fn(async () => ({steps: []})),
}));

import {prepareCowConvertRecord} from '../convert/prepareCow';
import {executeEvmConvert} from '../convert/executeEvm';
import {salvageConvertStore} from '../convert/records';
import type {ConvertRecord} from '../convert/types';

const SEED = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const ZCHF = '0xb58e61c3098d85632df34eecfb899a1ed80921cb';
const OUT_RAIL = 'evm:native-eth:1';
const UID = '0x' + 'ab'.repeat(56);

const quote = {
  venueId: 'cowswap-eth',
  amountIn: (10n ** 17n).toString(),
  buyAmount: (387n * 10n ** 12n).toString(),
  feeAmount: (13n * 10n ** 15n).toString(),
  protocolFeeBps: '2',
  validTo: 1_791_021_860,
  tokenIn: ZCHF,
  tokenOut: '',
  outRailId: OUT_RAIL,
};

describe('prepareCowConvertRecord — red lines', () => {
  beforeEach(() => {
    mockEstimate.mockReset().mockResolvedValue({maxFeeWei: (10n ** 12n).toString()});
    mockBalance.mockReset().mockResolvedValue((10n ** 15n).toString());
  });

  test('a Uniswap venue id is refused (family dispatch, never defaulted)', async () => {
    await expect(prepareCowConvertRecord({
      secretHex: SEED,
      quote: {...quote, venueId: 'uniswapv3-eth'},
      inSymbol: 'ZCHF', outSymbol: 'ETH', inDecimals: 18, outDecimals: 18,
      slippageBps: 100,
    })).rejects.toThrow();
  });

  test('a foreign pair is refused (rail-id set equality)', async () => {
    await expect(prepareCowConvertRecord({
      secretHex: SEED,
      quote: {...quote, outRailId: 'evm:native-eth:42161'},
      inSymbol: 'ZCHF', outSymbol: 'ETH', inDecimals: 18, outDecimals: 18,
      slippageBps: 100,
    })).rejects.toThrow();
  });

  test('a partial venue answer is refused (the whole truth or nothing)', async () => {
    await expect(prepareCowConvertRecord({
      secretHex: SEED,
      quote: {...quote, validTo: 0},
      inSymbol: 'ZCHF', outSymbol: 'ETH', inDecimals: 18, outDecimals: 18,
      slippageBps: 100,
    })).rejects.toThrow();
    await expect(prepareCowConvertRecord({
      secretHex: SEED,
      quote: {...quote, buyAmount: 'x'},
      inSymbol: 'ZCHF', outSymbol: 'ETH', inDecimals: 18, outDecimals: 18,
      slippageBps: 100,
    })).rejects.toThrow();
  });

  test('the dry gas gate refuses before the record exists', async () => {
    mockEstimate.mockResolvedValue({maxFeeWei: (10n ** 18n).toString()});
    await expect(prepareCowConvertRecord({
      secretHex: SEED,
      quote,
      inSymbol: 'ZCHF', outSymbol: 'ETH', inDecimals: 18, outDecimals: 18,
      slippageBps: 100,
    })).rejects.toMatchObject({name: 'EvmGasGateError'});
  });

  test('a passing gate freezes the venue facts verbatim (floor, validTo, appData, pre-balance)', async () => {
    const {record} = await prepareCowConvertRecord({
      secretHex: SEED,
      quote,
      inSymbol: 'ZCHF', outSymbol: 'ETH', inDecimals: 18, outDecimals: 18,
      slippageBps: 100,
    });
    expect(record.step).toBe('swapping');
    expect(record.legs).toEqual([]);
    const leg = record.evmSwap!;
    expect(leg.venueId).toBe('cowswap-eth');
    expect(leg.amountIn).toBe(quote.amountIn); // the order's sellAmount == the total debited
    expect(leg.inRailId).toBe(`evm:1:${ZCHF}`);
    expect(leg.outRailId).toBe(OUT_RAIL);
    expect(leg.minOut).toBe((BigInt(quote.buyAmount) * 9900n / 10_000n).toString()); // the signed floor
    expect(leg.cow!.buyAmount).toBe(quote.buyAmount); // the venue's own figure, verbatim
    expect(leg.cow!.feeAmount).toBe(quote.feeAmount); // the venue's own cost, never hidden
    expect(leg.cow!.protocolFeeBps).toBe('2');
    expect(leg.deadlineSecs).toBe(quote.validTo); // the venue's own expiry = the UID input
    expect(leg.cow!.appData).toMatch(/^0x[0-9a-f]{64}$/);
    expect(leg.cow!.uid).toBeUndefined(); // frozen at SUBMIT, not at prepare
    expect(leg.preOutRaw).toBeDefined();
    expect(record.expectedNet).toBe(leg.minOut);
  });
});

function cowRecord(overrides: Partial<Record<string, unknown>> = {}, cow: Record<string, unknown> = {}): ConvertRecord {
  return {
    id: 'cowrec', createdAtMs: Date.now(), step: 'swapping', venueId: 'cowswap-eth',
    inLedger: `evm:1:${ZCHF}`, outLedger: OUT_RAIL, inSymbol: 'ZCHF', outSymbol: 'ETH',
    inDecimals: 18, outDecimals: 18, amountIn: quote.amountIn,
    expectedGross: quote.buyAmount,
    expectedNet: (BigInt(quote.buyAmount) * 9900n / 10_000n).toString(),
    inFee: '0', outFee: '0', slippageBps: 100, legs: [],
    evmSwap: {
      protocol: 'evm', chainId: 1, venueId: 'cowswap-eth',
      inRailId: `evm:1:${ZCHF}`, outRailId: OUT_RAIL, tokenIn: ZCHF, tokenOut: '',
      inSymbol: 'ZCHF', outSymbol: 'ETH', inDecimals: 18, outDecimals: 18,
      amountIn: quote.amountIn, minOut: (BigInt(quote.buyAmount) * 9900n / 10_000n).toString(),
      feeTier: 0, deadlineSecs: 1_791_021_860, slippageBps: 100,
      cow: {
        buyAmount: quote.buyAmount,
        feeAmount: quote.feeAmount,
        protocolFeeBps: '2',
        appData: '0x' + 'cd'.repeat(32),
        ...cow,
      },
      preOutRaw: '1000',
      ...overrides,
    },
    ...overrides,
  } as ConvertRecord;
}

describe('executeEvmConvert — the CoW family dispatch', () => {
  beforeEach(() => {
    mockEstimate.mockReset().mockResolvedValue({maxFeeWei: (10n ** 12n).toString()});
    mockBalance.mockReset().mockResolvedValue('2000');
    mockDrive.mockReset();
    mockUnwrap.mockReset().mockResolvedValue('0x' + 'ee'.repeat(32));
  });

  test('the happy drive: uid frozen at submit, settled at done with the venue realized figure', async () => {
    mockBalance.mockResolvedValue((1000n + 386000000000000n).toString()); // pre + the venue's realized buy
    mockDrive.mockImplementation(async (_secret: unknown, rawInput: unknown, _s: unknown, onProgress: (p: object) => Promise<void>) => {
    const input = rawInput as {uid: string | null; approveTxHash: string | null};
      expect(input.uid).toBeNull();
      expect(input.approveTxHash).toBeNull();
      await onProgress({kind: 'approved', txHash: '0x' + '11'.repeat(32)});
      await onProgress({kind: 'submitted', uid: UID});
      return {kind: 'fulfilled', status: {uid: UID, status: 'fulfilled', executedSellAmount: quote.amountIn, executedBuyAmount: '386000000000000', executedFeeAmount: '0'}};
    });
    const rec = cowRecord();
    const updates: ConvertRecord[] = [];
    const next = await executeEvmConvert(rec, {publicHex: 'pub', secretHex: SEED, relayUrl: 'http://relay', onUpdate: r => { updates.push(r); }});
    expect(next.step).toBe('done');
    // The realized OUT credit (pre 1000 + bought) decides the done line, and the record
    // carries the venue's own durable identities (uid + the unwrap hash + sold/bought).
    expect(next.outAmountNet).toBe('386000000000000'); // the measured delta (pre + bought - pre)
    expect(next.outTx).toBe(UID);
    expect(next.evmSwap!.cow!.uid).toBe(UID);
    expect(next.evmSwap!.cow!.sold).toBe(quote.amountIn);
    expect(next.evmSwap!.cow!.bought).toBe('386000000000000');
    expect(next.evmSwap!.txHashes).toEqual(['0x' + 'ee'.repeat(32)]); // the native-out unwrap
    // The uid was frozen AT SUBMIT (an interim update), not only at done.
    expect(updates.some(u => u.evmSwap?.cow?.uid === UID && u.step === 'settling')).toBe(true);
  });

  test('a resume with the uid frozen skips the approve+submit and polls straight to done', async () => {
    mockDrive.mockImplementation(async (_secret: unknown, rawInput: unknown) => {
    const input = rawInput as {uid: string | null; approveTxHash: string | null};
      expect(input.uid).toBe(UID);
      expect(input.approveTxHash).toBe('0x' + '11'.repeat(32));
      return {kind: 'fulfilled', status: {uid: UID, status: 'fulfilled', executedSellAmount: quote.amountIn, executedBuyAmount: '386000000000000', executedFeeAmount: '0'}};
    });
    const rec = cowRecord({step: 'settling'}, {uid: UID, approveTxHash: '0x' + '11'.repeat(32)});
    const next = await executeEvmConvert(rec, {publicHex: 'pub', secretHex: SEED, relayUrl: 'http://relay', onUpdate: () => {}});
    expect(next.step).toBe('done');
  });

  test('a still-open order leaves the record untouched (the engine re-arms, nothing faked)', async () => {
    mockDrive.mockResolvedValue(null);
    // The submitted world: the record sits at `settling` with its uid frozen (the submit's
    // own advance) — a drive that answers nothing returns the SAME record, unchanged.
    const rec = cowRecord({step: 'settling'}, {uid: UID, approveTxHash: '0x' + '11'.repeat(32)});
    const next = await executeEvmConvert(rec, {publicHex: 'pub', secretHex: SEED, relayUrl: 'http://relay', onUpdate: () => {}});
    expect(next).toBe(rec);
    expect(next.step).toBe('settling');
  });

  test('the venue expiry is the honest terminal with its real cause', async () => {
    mockDrive.mockResolvedValue({kind: 'terminal', status: {uid: UID, status: 'expired', executedSellAmount: null, executedBuyAmount: null, executedFeeAmount: null}});
    const rec = cowRecord({}, {uid: UID, approveTxHash: '0x' + '11'.repeat(32)});
    const next = await executeEvmConvert(rec, {publicHex: 'pub', secretHex: SEED, relayUrl: 'http://relay', onUpdate: () => {}});
    expect(next.step).toBe('failed_refunded');
    expect(next.failureCode).toBe('swap_refused');
    expect(next.failureDetail).toContain('expired');
  });

  test('a drive-time gas-gate refusal parks failed_refunded (gas_short), nothing signed', async () => {
    mockDrive.mockRejectedValue(Object.assign(new Error('gas'), {name: 'EvmGasGateError', requiredWei: '1'}));
    const rec = cowRecord();
    const next = await executeEvmConvert(rec, {publicHex: 'pub', secretHex: SEED, relayUrl: 'http://relay', onUpdate: () => {}});
    expect(next.step).toBe('failed_refunded');
    expect(next.failureCode).toBe('gas_short');
  });

  test('a failed native-out unwrap names the WETH exit, never a silent loss', async () => {
    mockDrive.mockImplementation(async (_secret: unknown, _input: unknown, _s: unknown, onProgress: (p: object) => Promise<void>) => {
      await onProgress({kind: 'approved', txHash: '0x' + '11'.repeat(32)});
      await onProgress({kind: 'submitted', uid: UID});
      return {kind: 'fulfilled', status: {uid: UID, status: 'fulfilled', executedSellAmount: quote.amountIn, executedBuyAmount: '386000000000000', executedFeeAmount: '0'}};
    });
    mockUnwrap.mockRejectedValue(new Error('cow: 0xaaa leg 0xbbb reverted on-chain — nothing retried'));
    const rec = cowRecord();
    const next = await executeEvmConvert(rec, {publicHex: 'pub', secretHex: SEED, relayUrl: 'http://relay', onUpdate: () => {}});
    expect(next.step).toBe('failed_leg');
    expect(next.failureCode).toBe('withdraw_refused');
    expect(next.failureDetail).toContain('WETH');
  });
});

describe('hydration — the cow widening', () => {
  test('a CoW record hydrates; garbage in the block refuses', () => {
    const rec = cowRecord({}, {uid: UID, approveTxHash: '0x' + '11'.repeat(32), bought: '5', sold: '6'});
    const store = JSON.parse(JSON.stringify({cowrec: rec}));
    const out = salvageConvertStore(store);
    expect(Object.keys(out.records)).toEqual(['cowrec']);
    expect(out.records['cowrec']!.evmSwap!.cow!.uid).toBe(UID);

    const badUid = JSON.parse(JSON.stringify({cowrec: {...rec, evmSwap: {...rec.evmSwap!, cow: {...rec.evmSwap!.cow!, uid: '0xdead'}}}}));
    expect(Object.keys(salvageConvertStore(badUid).records)).toEqual([]);
    const badAmount = JSON.parse(JSON.stringify({cowrec: {...rec, evmSwap: {...rec.evmSwap!, cow: {...rec.evmSwap!.cow!, buyAmount: '-5'}}}}));
    expect(Object.keys(salvageConvertStore(badAmount).records)).toEqual([]);
    const badAppData = JSON.parse(JSON.stringify({cowrec: {...rec, evmSwap: {...rec.evmSwap!, cow: {...rec.evmSwap!.cow!, appData: '0x1234'}}}}));
    expect(Object.keys(salvageConvertStore(badAppData).records)).toEqual([]);
  });
});

describe('cowQuoteFresh - the confirm gesture signs a LIVE quote as displayed (the order is the lock)', () => {
  test('a quote inside its validTo window is fresh - no re-quote, no confirm loop', async () => {
    const {cowQuoteFresh} = await import('../convert/prepareCow');
    expect(cowQuoteFresh({validTo: Math.floor(1_700_000_000) + 300}, 1_700_000_000_000)).toBe(true);
  });
  test('an expired (or malformed) validTo re-quotes and re-arms with the moved note', async () => {
    const {cowQuoteFresh} = await import('../convert/prepareCow');
    expect(cowQuoteFresh({validTo: Math.floor(1_700_000_000) - 1}, 1_700_000_000_000)).toBe(false);
    expect(cowQuoteFresh({validTo: 0}, 1)).toBe(false);
    expect(cowQuoteFresh({validTo: 1.5}, 1)).toBe(false);
  });
});
