/**
 * app/routes.ts + the multi-hop widening of app/convert.ts (spec 2026-09-14): the pure
 * route walk over the REGISTERED surfaces, the 5-leg prepare (single intent, one signing
 * pass, burn amount = the swap's min-you'll-receive), record hydration for BOTH shapes
 * (the shipped v2 two-leg record MUST keep hydrating byte-identically), and the planned
 * executor: per-leg progress, the hop-payout gate between swap and burn, the per-leg
 * failure taxonomy (approve/swap → failed_refunded, burn legs → failed_leg with the hop
 * asset in-wallet), and resume-at-first-incomplete-leg.
 * The arg/envelope BYTES are the compiled core's; the FFI is mocked and its CALLS pinned.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpSwapMinOut: jest.fn(),
    icpApproveArg: jest.fn(),
    icpDepositAndSwapArg: jest.fn(),
    icpWithdrawErc20Arg: jest.fn(),
    icpSignUpdate: jest.fn(),
    icpPrincipalFromPubkey: jest.fn(),
    icpDecodeSwapResult: jest.fn(),
    icpDecodeApproveResult: jest.fn(),
    icpDecodeMinterOk: jest.fn(),
  },
}));
jest.mock('../services/icp', () => ({icStampExpiry: jest.fn()}));
jest.mock('../services/relay', () => ({relayFetch: jest.fn()}));
jest.mock('../services/rail', () => ({
  submitTransfer: jest.fn(),
  fetchGasFeeWei: jest.fn(),
  fetchLedgerFee: jest.fn(),
}));

import {DpayCore} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {relayFetch} from '../services/relay';
import {fetchGasFeeWei, fetchLedgerFee, submitTransfer} from '../services/rail';
import {
  executeConvert,
  hydrateConvertStore,
  loadConvertRecords,
  prepareMultihopConvertRecord,
  requestConvertAbort,
  type ConvertMath,
  type ConvertQuote,
  type ConvertRecord,
} from '../convert';
import {multihopRoutesFrom} from '../routes';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';

const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
const ICP = BUNDLED.find(c => c.currency === 8)!;
const CKUSDC = BUNDLED.find(c => c.currency === 2)!;
const CKETH = BUNDLED.find(c => c.currency === 6)!;
const ICP_LEDGER = ICP.ledger!;
const CKUSDC_LEDGER = CKUSDC.ledger!;
const CKETH_LEDGER = CKETH.ledger!;
const POOL = 'mohjv-bqaaa-aaaag-qjyia-cai'; // the icpswap-ckusdc venue endpoint (registry's own)
const MINTER = CKUSDC.minter!;
const VENUE_ID = 'icpswap-ckusdc';
const DEST = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase();

const fakeRes = (body: unknown, ok = true, status = 200) => ({ok, status, json: async () => body});
const rowsRes = (rows: unknown[]) => fakeRes({transactions: rows});
// Probe fixtures must look NEWER than any record's createdAtMs (the settlement
// probes ignore rows predating the record — 2026-09-19 live fix).
const NOW = () => Math.floor(Date.now() / 1000) + 3600;
const myPrincipal = 'myprincipal123';
const OPTS = {submitAttempts: 2, poll: {attempts: 1, intervalMs: 0}, settleAttempts: 1, settleIntervalMs: 0};
// The mocked ingress stamp (set per-test to a future instant; pinned in the approve-args assert).
let STAMP_NS = '0';

const hopQuote = (over: Partial<ConvertQuote> = {}): ConvertQuote => ({
  venueId: VENUE_ID,
  pool: POOL,
  tokenInLedger: ICP_LEDGER,
  tokenOutLedger: CKUSDC_LEDGER,
  amountIn: '100000000', // 1 ICP
  amountOutGross: '190000000', // 190 ckUSDC (6 dec)
  zeroForOne: true,
  feeMillionths: 3000,
  fetchedAtMs: 1_000,
  ...over,
});

const hopMath = (over: Partial<ConvertMath> = {}): ConvertMath => ({
  amountIn: '100000000',
  grossOut: '190000000',
  minOut: '188100000',
  netOut: '189990000',
  inFee: '10000',
  outFee: '10000',
  slippageBps: 100,
  ...over,
});

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  // A FUTURE stamp: expiresAtMs = ns/1e6 must land past `nowMs`, or arm (b) of the V6
  // trichotomy fires at entry and every run resolves as expired.
  STAMP_NS = String(BigInt(Date.now() + 3_600_000) * 1_000_000n);
  jest.mocked(icStampExpiry).mockResolvedValue(STAMP_NS);
  jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal);
  jest.mocked(DpayCore.icpSwapMinOut).mockResolvedValue('188100000');
  jest.mocked(DpayCore.icpApproveArg).mockResolvedValue('approve-arg-hex');
  jest.mocked(DpayCore.icpDepositAndSwapArg).mockResolvedValue('swap-arg-hex');
  jest.mocked(DpayCore.icpWithdrawErc20Arg).mockResolvedValue('withdraw-arg-hex');
  jest.mocked(DpayCore.icpSignUpdate).mockImplementation(async (_s, canister) => ({
    envelopeHex: `env-${canister}`,
    requestIdHex: `rid-${canister}`,
  }));
  jest.mocked(DpayCore.icpDecodeSwapResult).mockResolvedValue({ok: true, amountOutGross: '190000000'});
  jest.mocked(DpayCore.icpDecodeMinterOk).mockResolvedValue({ok: true, blockIndex: '77'});
  jest.mocked(fetchGasFeeWei).mockResolvedValue('78000000000000');
  jest.mocked(fetchLedgerFee).mockResolvedValue('2000000000000');
});

afterEach(() => {});

/** prepareMultihopConvertRecord output with every leg still pending. */
async function plannedRecord(over: Partial<ConvertRecord> = {}): Promise<ConvertRecord> {
  const route = multihopRoutesFrom(BUNDLED, 8)[0];
  const rec = await prepareMultihopConvertRecord({
    secretHex: '00'.repeat(32),
    quote: hopQuote(),
    math: hopMath(),
    route,
    destAddress: DEST,
  });
  return {...rec, ...over};
}

describe('multihopRoutesFrom — the pure registry walk', () => {
  test('ICP walks to exactly THREE routes: A (ckUSDC burn-withdraw), B (+CCTP), C (+CCTP+Jupiter)', () => {
    const routes = multihopRoutesFrom(BUNDLED, 8);
    expect(routes).toHaveLength(3);
    const r = routes[0];
    expect(r.swapVenueId).toBe(VENUE_ID);
    expect(r.pool).toBe(POOL);
    expect(r.from).toEqual({currency: 8, ledger: ICP_LEDGER, symbol: 'ICP', decimals: 8, fee: '10000'});
    expect(r.hop).toEqual({currency: 2, ledger: CKUSDC_LEDGER, symbol: 'USDC', decimals: 6, fee: '10000'});
    expect(r.burn.minter).toBe(MINTER);
    expect(r.burn.gasLedger).toBe(CKETH_LEDGER);
    expect(r.burn.gasCurrency).toBe(6);
    expect(r.dest).toEqual({symbol: 'USDC', network: 'Ethereum'});
    expect(r.crossRail).toBeUndefined(); // Route A: nothing beyond the EVM address
    // Route B: the same IC machinery + the CCTP burn to Solana (domain 5, fast finality).
    const b = routes[1];
    expect(b.routeId).toBe('multihop:icpswap-ckusdc:2:cctp');
    expect(b.crossRail).toEqual({
      cctp: {
        tokenContract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        destinationDomain: 5,
        finalityThreshold: 1000,
      },
    });
    expect(b.crossRail!.sol).toBeUndefined();
    expect(b.dest).toEqual({symbol: 'USDC', network: 'Solana'});
    // Route C: B + the registered Jupiter leg USDC(SOL) → SOL at the device's own address.
    const c = routes[2];
    expect(c.routeId).toBe('multihop:icpswap-ckusdc:2:cctp:jupiter');
    expect(c.crossRail!.cctp).toEqual(b.crossRail!.cctp);
    expect(c.crossRail!.sol).toEqual({
      venueId: 'jupiter',
      outMint: 'So11111111111111111111111111111111111111112',
      outSymbol: 'SOL',
      outDecimals: 9,
    });
    expect(c.dest).toEqual({symbol: 'SOL', network: 'Solana'});
    // The IC facts are identical across the three — cross-rail routes EXTEND A, never fork it.
    for (const x of routes.slice(1)) {
      expect(x.from).toEqual(r.from);
      expect(x.hop).toEqual(r.hop);
      expect(x.burn).toEqual(r.burn);
      expect(x.pool).toBe(r.pool);
    }
  });

  test('ckETH itself is NOT a route hop (native-ETH withdraw is a different rail — token_contract null)', () => {
    // The ICP↔ckETH venue exists in the registry; the walk must not compose it.
    const routes = multihopRoutesFrom(BUNDLED, 8);
    expect(routes.some(r => r.hop.currency === 6)).toBe(false);
  });

  test('an asset with no CkEthErc20-paired venue gets NO routes (fail closed, not empty-shaped)', () => {
    expect(multihopRoutesFrom(BUNDLED, 2)).toEqual([]); // ckUSDC: its pair side is ICP
    expect(multihopRoutesFrom(BUNDLED, 0)).toEqual([]); // DEMO: no venue at all
  });
});

describe('prepareMultihopConvertRecord — one intent, five legs, signed once up front', () => {
  test('five legs in execution order with the exact canisters/methods, and a parallel legPlan', async () => {
    const rec = await plannedRecord();
    expect(rec.legs).toHaveLength(5);
    expect(rec.legs.map(l => [l.canister, l.method])).toEqual([
      [ICP_LEDGER, 'icrc2_approve'], // approve the pool to pull ICP
      [POOL, 'depositFromAndSwap'], // the swap hop
      [CKUSDC_LEDGER, 'icrc2_approve'], // approve the burn
      [CKETH_LEDGER, 'icrc2_approve'], // approve the gas
      [MINTER, 'withdraw_erc20'], // the burn itself
    ]);
    expect(rec.legPlan!.map(p => p.kind)).toEqual(['approve', 'swap', 'approve', 'approve_gas', 'withdraw_erc20']);
    expect(rec.legPlan!.every(p => p.state === 'pending')).toBe(true);
    expect(rec.legPlan![1].fee).toBe(''); // the swap leg's cost is the pool tier, not a ledger fee
    expect(rec.legPlan![4].fee).toBe(''); // the withdraw leg charges nothing; gas is its own leg
    expect(rec.destAddress).toBe(DEST);
    expect(rec.destSymbol).toBe('USDC');
    expect(rec.destNetwork).toBe('Ethereum');
    expect(rec.hopCurrency).toBe(2);
    expect(rec.hopLedger).toBe(CKUSDC_LEDGER);
    expect(rec.gasFeeWei).toBe('78000000000000');
    expect(rec.feeMillionths).toBe(3000);
    expect(rec.outCurrency).toBe(2); // the watchable ledger is the HOP ledger
    expect(rec.outLedger).toBe(CKUSDC_LEDGER);
  });

  test('the burn amount is the swap min-you\'ll-receive; every approve is arg-built exactly once', async () => {
    await plannedRecord();
    const approve = jest.mocked(DpayCore.icpApproveArg).mock.calls;
    expect(approve).toHaveLength(3);
    // Leg 1 — pool pull: amountIn + input fee + allowance expiry; expected_allowance ABSENT
    // (ICRC-2 compares it with the CURRENT allowance — any value refuses AllowanceChanged).
    expect(approve[0]).toEqual([POOL, '', '', '100010000', '', STAMP_NS, '', '10000']);
    // Leg 3 — burn approval on ckUSDC: min-out, minter shape (no expected allowance, no expiry).
    expect(approve[1]).toEqual([MINTER, '', '', '188100000', '', '', '', '10000']);
    // Leg 4 — gas approval on ckETH: the minter's live gas figure + the gas ledger's own fee.
    expect(approve[2]).toEqual([MINTER, '', '', '78000000000000', '', '', '', '2000000000000']);
    expect(jest.mocked(DpayCore.icpDepositAndSwapArg).mock.calls).toEqual([
      ['100000000', '188100000', '10000', '10000', true],
    ]);
    expect(jest.mocked(DpayCore.icpWithdrawErc20Arg).mock.calls).toEqual([
      ['188100000', CKUSDC_LEDGER, DEST, '', ''],
    ]);
  });

  test('an unvalidated destination address is never signed', async () => {
    const route = multihopRoutesFrom(BUNDLED, 8)[0];
    await expect(prepareMultihopConvertRecord({
      secretHex: '00'.repeat(32), quote: hopQuote(), math: hopMath(), route, destAddress: '0x1234',
    })).rejects.toThrow();
    expect(jest.mocked(DpayCore.icpSignUpdate)).not.toHaveBeenCalled();
  });

  test('a gas quote the minter will not give → the localized error, nothing signed', async () => {
    jest.mocked(fetchGasFeeWei).mockResolvedValue(null);
    const route = multihopRoutesFrom(BUNDLED, 8)[0];
    await expect(prepareMultihopConvertRecord({
      secretHex: '00'.repeat(32), quote: hopQuote(), math: hopMath(), route, destAddress: DEST,
    })).rejects.toThrow();
    expect(jest.mocked(DpayCore.icpSignUpdate)).not.toHaveBeenCalled();
  });
});

describe('hydrateConvertStore — both record shapes load; the shipped one unchanged', () => {
  test('BACKWARD COMPAT: a v2 two-leg record (no legPlan) hydrates byte-identically', () => {
    const direct: ConvertRecord = {
      id: 'direct1',
      createdAtMs: 1,
      step: 'approving',
      venueId: VENUE_ID,
      inCurrency: 8,
      outCurrency: 2,
      inLedger: ICP_LEDGER,
      outLedger: CKUSDC_LEDGER,
      inSymbol: 'ICP',
      outSymbol: 'USDC',
      amountIn: '100000000',
      expectedGross: '190000000',
      expectedNet: '189990000',
      inFee: '10000',
      outFee: '10000',
      slippageBps: 100,
      legs: [
        {canister: ICP_LEDGER, method: 'icrc2_approve', argHex: 'a', envelopeHex: 'e1', requestIdHex: 'r1', expiresAtMs: Date.now() + 600_000},
        {canister: POOL, method: 'depositFromAndSwap', argHex: 'b', envelopeHex: 'e2', requestIdHex: 'r2', expiresAtMs: Date.now() + 600_000},
      ],
    };
    const out = hydrateConvertStore(JSON.parse(JSON.stringify({direct1: direct})));
    expect(out).toEqual({direct1: direct});
  });

  test('a five-leg planned record survives JSON round-trip byte-for-byte', async () => {
    const rec = await plannedRecord({step: 'done', outAmountNet: '188100000', outTx: '77'});
    const out = hydrateConvertStore(JSON.parse(JSON.stringify({[rec.id]: rec})));
    expect(out).toEqual({[rec.id]: rec});
  });

  test('legPlan/legs length mismatch → REJECTED (a parallel array that is not parallel is corrupt)', async () => {
    const rec = await plannedRecord();
    const broken = JSON.parse(JSON.stringify(rec)) as ConvertRecord;
    broken.legPlan!.pop();
    expect(hydrateConvertStore({[rec.id]: broken})).toEqual({});
  });

  test('legPlan without its destination facts → REJECTED (a route with no destination is not an intent)', async () => {
    const rec = await plannedRecord();
    const broken = JSON.parse(JSON.stringify(rec)) as Record<string, unknown>;
    delete broken.destAddress;
    expect(hydrateConvertStore({[rec.id]: broken})).toEqual({});
  });

  test('three legs with NO legPlan still refuse — the old rule stands for plan-less records', () => {
    const rec = {
      id: 'x', createdAtMs: 1, step: 'approving', venueId: VENUE_ID,
      inCurrency: 8, outCurrency: 2, inLedger: ICP_LEDGER, outLedger: CKUSDC_LEDGER,
      inSymbol: 'ICP', outSymbol: 'USDC', amountIn: '1', expectedGross: '1', expectedNet: '1',
      inFee: '1', outFee: '1', slippageBps: 100,
      legs: [
        {canister: ICP_LEDGER, method: 'icrc2_approve', argHex: '', envelopeHex: 'e', requestIdHex: 'r', expiresAtMs: 2},
        {canister: POOL, method: 'depositFromAndSwap', argHex: '', envelopeHex: 'e', requestIdHex: 'r', expiresAtMs: 2},
        {canister: MINTER, method: 'withdraw_erc20', argHex: '', envelopeHex: 'e', requestIdHex: 'r', expiresAtMs: 2},
      ],
    };
    expect(hydrateConvertStore({x: rec})).toEqual({});
  });
});

describe('executeConvert (planned) — per-leg progress, the hop gate, the failure taxonomy', () => {
  const hopRow = (amount: string) => rowsRes([
    {currency: 2, from: POOL, to: myPrincipal, amount, block: '7', timestamp: NOW()},
  ]);
  const deps = (onUpdate: (r: ConvertRecord) => void) => ({
    secretHex: '00'.repeat(32),
    publicHex: 'aabb',
    relayUrl: 'http://relay',
    onUpdate,
  });

  test('happy path: five legs confirm in order; swap waits for the hop payout; done names the BURN amount', async () => {
    const rec = await plannedRecord();
    const updates: ConvertRecord[] = [];
    // The hop payout must appear on the ledger between the swap #ok and any burn leg.
    jest.mocked(relayFetch).mockResolvedValue(hopRow('190000000') as never);
    // The mock honors the REAL rail contract: a reply that arrives gets decoded through the
    // hook (that decode is where the minter's #ok block index is read from).
    jest.mocked(submitTransfer).mockImplementation(async (_p, _s, _o, decodeReply) => {
      if (decodeReply != null) await decodeReply('reply-hex');
      return {kind: 'settled', blockIndex: '1'} as never;
    });
    const out = await executeConvert(rec, deps(r => updates.push(r)), OPTS);
    expect(out.step).toBe('done');
    expect(out.legPlan!.every(p => p.state === 'confirmed')).toBe(true);
    // The terminal amount is the min-you'll-receive that was burned — "at least", never the gross.
    expect(out.outAmountNet).toBe('188100000');
    expect(out.outTx).toBe('77'); // the minter's own #ok block index, decoded from the reply
    expect(out.hopTx).toBe('7'); // the ledger row that gated the swap leg's confirmation
    // Leg-by-leg progress: five sent transitions, five confirmed.
    const sentAt = updates.filter(u => u.legPlan!.some(p => p.state === 'sent')).length;
    expect(sentAt).toBe(5);
    // Submission order followed the leg order — identical bytes per leg, one submit each.
    const ledgers = jest.mocked(submitTransfer).mock.calls.map(c => (c[0] as {ledger: string}).ledger);
    expect(ledgers).toEqual([ICP_LEDGER, POOL, CKUSDC_LEDGER, CKETH_LEDGER, MINTER]);
  });

  test('swap #ok but NO hop row in budget → parked pending_withdrawal; resume completes the burn legs', async () => {
    const rec = await plannedRecord();
    jest.mocked(relayFetch).mockResolvedValueOnce(rowsRes([]) as never); // first watch: nothing
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'settled', blockIndex: '1'} as never);
    const parked = await executeConvert(rec, deps(() => {}), OPTS);
    expect(parked.step).toBe('pending_withdrawal');
    // Only the input approve + swap were submitted; the burn legs NEVER ran.
    expect(jest.mocked(submitTransfer)).toHaveBeenCalledTimes(2);
    expect(parked.legPlan![1].state).toBe('sent');

    // Resume: the payout row has landed; the first INCOMPLETE leg is the burn approve.
    jest.mocked(relayFetch).mockResolvedValue(hopRow('189000000') as never);
    const done = await executeConvert(parked, deps(() => {}), OPTS);
    expect(done.step).toBe('done');
    expect(jest.mocked(submitTransfer)).toHaveBeenCalledTimes(5);
    expect(done.legPlan!.every(p => p.state === 'confirmed')).toBe(true);
  });

  test('the withdraw leg refused → failed_leg/withdraw_refused; the hop asset is in-wallet (the copy\'s fact)', async () => {
    const rec = await plannedRecord();
    jest.mocked(relayFetch).mockResolvedValue(hopRow('190000000') as never);
    jest.mocked(submitTransfer)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '2'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '3'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '4'} as never)
      .mockResolvedValueOnce({kind: 'rejected', reason: 'insufficient allowance', variant: 'InsufficientAllowance'} as never);
    const out = await executeConvert(rec, deps(() => {}), OPTS);
    expect(out.step).toBe('failed_leg');
    expect(out.failureCode).toBe('withdraw_refused');
    expect(out.failureDetail).toContain('insufficient allowance');
    expect(out.legPlan![4].state).toBe('failed');
    expect(out.legPlan!.slice(0, 4).every(p => p.state === 'confirmed')).toBe(true);
  });

  test('the swap refused → the direct shape\'s own dead-end (failed_refunded/swap_refused)', async () => {
    const rec = await plannedRecord();
    jest.mocked(submitTransfer)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never)
      .mockResolvedValueOnce({kind: 'rejected', reason: 'amountOutMinimum not met', variant: 'InternalError'} as never);
    const out = await executeConvert(rec, deps(() => {}), OPTS);
    expect(out.step).toBe('failed_refunded');
    expect(out.failureCode).toBe('swap_refused');
  });

  test('expired mid-route with the hop payout SEEN → failed_leg (dead envelopes, funds = hop asset)', async () => {
    const rec = await plannedRecord();
    for (const l of rec.legs) l.expiresAtMs = 1;
    jest.mocked(relayFetch).mockResolvedValue(hopRow('190000000') as never);
    const out = await executeConvert(rec, deps(() => {}), {...OPTS, nowMs: 5_000});
    expect(out.step).toBe('failed_leg');
    expect(out.hopTx).toBe('7');
  });

  test('expired with NO payout row → stuck (the honest unknown, same as today)', async () => {
    const rec = await plannedRecord();
    for (const l of rec.legs) l.expiresAtMs = 1;
    jest.mocked(relayFetch).mockResolvedValue(rowsRes([]) as never);
    const out = await executeConvert(rec, deps(() => {}), {...OPTS, nowMs: 5_000});
    expect(out.step).toBe('stuck');
  });

  test('abort requested as leg 0 settles: the freeze — later legs are never signed or submitted', async () => {
    const rec = await plannedRecord({id: 'abort-plan'});
    jest.mocked(relayFetch).mockResolvedValue(hopRow('190000000') as never);
    jest.mocked(submitTransfer).mockImplementation(async (_p, _s, _o, decodeReply) => {
      const out = {kind: 'settled', blockIndex: '1'} as never;
      if (decodeReply != null) await decodeReply('reply-hex');
      // The user taps Stop the moment the input approve settles.
      requestConvertAbort(rec.id);
      return out;
    });
    const out = await executeConvert(rec, deps(() => {}), {...OPTS, nowMs: 5_000});
    expect(out.step).toBe('aborted');
    expect(out.abortedAtMs).toBe(5_000);
    // The approve was submitted; the swap and every burn leg NEVER went on-chain.
    const ledgers = jest.mocked(submitTransfer).mock.calls.map(c => (c[0] as {ledger: string}).ledger);
    expect(ledgers).toEqual([ICP_LEDGER]);
    expect(out.legPlan!.map(p => p.state)).toEqual(['confirmed', 'pending', 'pending', 'pending', 'pending']);
    // The frozen record persisted exactly as aborted.
    expect((await loadConvertRecords('aabb'))[rec.id]?.step).toBe('aborted');
    jest.mocked(submitTransfer).mockReset();
  });
});
