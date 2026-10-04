/**
 * The COMPOSED deposit leg (2026-09-26, design brief §5.4 item 2) — prepare + lifecycle:
 *
 *   order created FIRST (its own deposit address + locked figure known before ANYTHING
 *   signs) → the IC legs + the venue deposit transfer signed in ONE pass → the engine
 *   drives approve → swap (payout row SEEN) → the deposit gate (exact amount re-verified
 *   from the record's frozen bytes, windows checked, balance read) → the transfer submits
 *   ONCE → the venue poll resolves the trade.
 *
 * Pinned here: the quote-changed re-review (before the order exists), the exact-amount
 * refusal (prepare AND gate), signed-once discipline, resume mid-leg by ledger-row
 * evidence (identical bytes, never a re-sign), no-retry after a definitive rejection, the
 * honest hold on an unreadable balance, and the provider completion in the settle asset's
 * own units. The FFI/relay/venue calls are mocked; NO live venue is ever touched.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpSwapMinOut: jest.fn(),
    icpApproveArg: jest.fn(),
    icpDepositAndSwapArg: jest.fn(),
    icpTransferArg: jest.fn(),
    icpLegacyTransferArg: jest.fn(),
    icpSignUpdate: jest.fn(),
    icpPrincipalFromPubkey: jest.fn(),
    icpAccountIdFromPrincipal: jest.fn(),
    icpValidateIcrcAccount: jest.fn(),
    icpValidateAccountId: jest.fn(),
    icpDecodeSwapResult: jest.fn(),
    icpDecodeApproveResult: jest.fn(),
    icpDecodeTransferResult: jest.fn(),
    icpDecodeLegacyTransferResult: jest.fn(),
  },
}));
jest.mock('../services/icp', () => ({icStampExpiry: jest.fn()}));
jest.mock('../services/relay', () => ({relayFetch: jest.fn(), fetchWithTimeout: jest.fn()}));
jest.mock('../services/rail', () => ({
  submitTransfer: jest.fn(),
  railBalanceOf: jest.fn(),
}));
jest.mock('../services/sideshift', () => ({
  sideShiftStatusUrl: (o: string) => `https://sideshift.ai/api/v2/shifts/${o}`,
  SIDESHIFT_STATUS_BASE: 'https://sideshift.ai/api/v2',
  fetchSideShiftQuote: jest.fn(),
  createSideShiftFixedShift: jest.fn(),
}));

import {DpayCore} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {relayFetch, fetchWithTimeout} from '../services/relay';
import {submitTransfer, railBalanceOf} from '../services/rail';
import {createSideShiftFixedShift, fetchSideShiftQuote} from '../services/sideshift';
import {advanceProviderRecord, __resetConvertResumeEngineForTest, startConvertResumeEngine, convertResumeSnapshot} from '../convertResume';
import {
  ComposedQuoteChangedError,
  executeConvert,
  isComposedConvertRecord,
  prepareComposedConvertRecord,
  type ConvertMath,
  type ConvertQuote,
  type ConvertRecord,
} from '../convert';
import {type ComposedConvertRoute} from '../config/convert';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';
import {convertStoreKey} from '../config/convert';
import {EURC_MINT_ADDRESS} from '../solana/tokens';
import {deriveSolanaAddress} from '../solana/identity';
import {sendCefiDepositForRecord} from '../lib/ataSetup';
import {toUnits} from '../lib/format';

const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
const rowOf = (currency: number) => BUNDLED.find(c => c.currency === currency)!;
const VCHF_LEDGER = rowOf(7).ledger!;
const ICP_LEDGER = rowOf(8).ledger!;
const POOL1 = '65mrh-fqaaa-aaaar-qapoa-cai'; // icpswap (VCHF/ICP)
const VENUE_DEPOSIT = 'venue-deposit-principal-cai';
const VENUE_OWNER = 'venue-deposit-principal';
const MY_PRINCIPAL = 'me-principal';
const SECRET = 'aa'.repeat(32);
const PUBLIC = 'bb'.repeat(32);

const fakeRes = (body: unknown, ok = true, status = 200) => ({ok, status, json: async () => body});
const rowsRes = (rows: unknown[]) => fakeRes({transactions: rows});
// Probe fixtures must look NEWER than the record's createdAtMs (the probes' floor).
const NOW = () => Math.floor(Date.now() / 1000) + 3600;
const OPTS = {submitAttempts: 1, poll: {attempts: 1, intervalMs: 0}, settleAttempts: 1, settleIntervalMs: 0};
const SOL_ADDRESS = deriveSolanaAddress(SECRET);
const HUB_FEE = '10000';

const ROUTE: ComposedConvertRoute = {
  kind: 'composed',
  routeId: 'composed:icpswap:sideshift-eurc',
  legs: [{venueId: 'icpswap', pool: POOL1, fromLedger: VCHF_LEDGER, toLedger: ICP_LEDGER}],
  endpoints: [
    {currency: 7, ledger: VCHF_LEDGER, symbol: 'VCHF', decimals: 8, fee: HUB_FEE, network: 'Internet Computer'},
    {currency: 8, ledger: ICP_LEDGER, symbol: 'ICP', decimals: 8, fee: HUB_FEE, network: 'Internet Computer'},
  ],
  cefiVenueId: 'sideshift-eurc',
  settleMint: EURC_MINT_ADDRESS,
  settleSymbol: 'EURC',
  settleDecimals: 6,
};

const quote1 = (over: Partial<ConvertQuote> = {}): ConvertQuote => ({
  venueId: 'icpswap',
  pool: POOL1,
  tokenInLedger: VCHF_LEDGER,
  tokenOutLedger: ICP_LEDGER,
  amountIn: '100000000', // 1 VCHF
  amountOutGross: '120000000', // 1.2 ICP
  zeroForOne: true,
  feeMillionths: 3000,
  fetchedAtMs: 1_000,
  ...over,
});

const math1 = (over: Partial<ConvertMath> = {}): ConvertMath => ({
  amountIn: '100000000',
  grossOut: '120000000',
  minOut: '118800000', // the 1% floor — THE deposit amount
  netOut: '119990000',
  inFee: '10000',
  outFee: '10000',
  slippageBps: 100,
  ...over,
});

/** The venue's own fixed order (verbatim figures): the deposit prices EXACTLY minOut1. */
const ORDER = {
  id: 'shift-1',
  depositAddress: VENUE_DEPOSIT,
  depositMemo: null,
  depositAmount: '1.188', // rawToDecimal(118800000, 8)
  settleAmount: '0.0115',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

const poolRow = {currency: 8, from: POOL1, to: MY_PRINCIPAL, amount: '119900000', block: '11', timestamp: NOW()};
const depositRow = {currency: 8, from: MY_PRINCIPAL, to: VENUE_OWNER, amount: '118800000', block: '12', timestamp: NOW()};

function mockRows(rows: unknown[]): void {
  jest.mocked(relayFetch).mockImplementation(async (_r, url) => {
    const m = /currency=(\d+)/.exec(url ?? '');
    return rowsRes(m && Number(m[1]) === 8 ? rows : []) as never;
  });
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  let signIdx = 0;
  const stampMs = Date.now() + 3_600_000;
  jest.mocked(icStampExpiry).mockResolvedValue((BigInt(stampMs) * 1_000_000n).toString());
  jest.mocked(DpayCore.icpSwapMinOut).mockResolvedValue('118800000');
  jest.mocked(DpayCore.icpApproveArg).mockResolvedValue('approve-arg');
  jest.mocked(DpayCore.icpDepositAndSwapArg).mockResolvedValue('swap-arg');
  jest.mocked(DpayCore.icpTransferArg).mockResolvedValue('deposit-arg');
  jest.mocked(DpayCore.icpLegacyTransferArg).mockResolvedValue('legacy-deposit-arg');
  jest.mocked(DpayCore.icpSignUpdate).mockImplementation(async (_s, canister, method) => {
    signIdx += 1;
    return {envelopeHex: `env-${signIdx}-${method}-${canister}`, requestIdHex: `rid-${signIdx}`};
  });
  jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(MY_PRINCIPAL);
  jest.mocked(DpayCore.icpAccountIdFromPrincipal).mockResolvedValue('me-account-id');
  jest.mocked(DpayCore.icpValidateIcrcAccount).mockResolvedValue({owner: VENUE_OWNER, subaccountHex: ''});
  jest.mocked(DpayCore.icpDecodeSwapResult).mockResolvedValue({ok: true});
  jest.mocked(DpayCore.icpDecodeApproveResult).mockResolvedValue({ok: true});
  jest.mocked(DpayCore.icpDecodeTransferResult).mockResolvedValue({ok: true, blockIndex: '9'});
  jest.mocked(fetchSideShiftQuote).mockResolvedValue({
    venueId: 'sideshift-eurc', quoteId: 'q1', settleAmount: '0.0115', rate: '0.0115', fetchedAtMs: Date.now(),
  });
  jest.mocked(createSideShiftFixedShift).mockResolvedValue({...ORDER});
  jest.mocked(submitTransfer).mockImplementation(async (_p, _s, _o, decode) => {
    // The real rail decodes the ledger's reply through the caller's decoder; the block
    // index it reports is the leg's durable evidence.
    const out = await decode?.('aa');
    return {kind: 'settled', blockIndex: out?.ok ? (out.blockIndex ?? '9') : '9'} as never;
  });
  jest.mocked(railBalanceOf).mockResolvedValue('119000000'); // 1.19 ICP ≥ 1.188 + fee
  mockRows([poolRow]);
});

afterEach(async () => {
  __resetConvertResumeEngineForTest();
  jest.restoreAllMocks();
});

/** The prepared composed record via the REAL prepare (every dependency mocked above). */
async function prepared(): Promise<ConvertRecord> {
  return prepareComposedConvertRecord({
    id: 'comp-1',
    secretHex: SECRET,
    publicHex: PUBLIC,
    relayUrl: 'http://relay.test',
    route: ROUTE,
    inDesc: rowOf(7) as CurrencyDescriptor,
    quote1: quote1(),
    math1: math1(),
    reviewedGrossRaw: '120000000',
  });
}

const deps = (onUpdate: (r: ConvertRecord) => void = () => undefined) => ({
  secretHex: SECRET,
  publicHex: PUBLIC,
  relayUrl: 'http://relay.test',
  onUpdate,
});

describe('prepareComposedConvertRecord — order first, then one signing pass', () => {
  test('the venue order is created BEFORE anything is signed, and the review figures gate it', async () => {
    const rec = await prepared();
    // The order creation rode the confirm budget (20s) and carried the user's own derived
    // settle + refund addresses.
    expect(createSideShiftFixedShift).toHaveBeenCalledTimes(1);
    const call = jest.mocked(createSideShiftFixedShift).mock.calls[0];
    expect(call[3]).toBe(20000);
    expect(call[2]).toMatchObject({
      quoteId: 'q1',
      settleAddress: SOL_ADDRESS,
      refundAddress: 'me-account-id',
      depositLedger: ICP_LEDGER,
    });
    // (depositAmountDecimal + clientOrderId are the wrapper's own correlation halves — the
    // sideshift order body has no such fields, the trocador body carries them.)
    // ORDER FIRST: the venue call precedes EVERY signature — the venue's own address and
    // locked figure were known before a byte was signed.
    const createOrder = jest.mocked(createSideShiftFixedShift).mock.invocationCallOrder[0]!;
    const signs = jest.mocked(DpayCore.icpSignUpdate).mock.invocationCallOrder;
    expect(signs.length).toBe(3);
    expect(signs.every(o => o > createOrder)).toBe(true);
    // THREE legs, in execution order, deposit LAST — and the deposit signs to the VENUE's
    // own account for the EXACT order amount, the hub fee on top (never out of the order).
    expect(rec.legs.map(l => [l.canister, l.method])).toEqual([
      [VCHF_LEDGER, 'icrc2_approve'],
      [POOL1, 'depositFromAndSwap'],
      [ICP_LEDGER, 'icrc1_transfer'],
    ]);
    expect(jest.mocked(DpayCore.icpTransferArg).mock.calls[0]).toEqual([
      VENUE_OWNER, '', '', '118800000', HUB_FEE, '',
    ]);
    expect(rec.legPlan!.map(p => p.kind)).toEqual(['approve', 'swap', 'deposit_transfer']);
    expect(isComposedConvertRecord(rec)).toBe(true);
    // The venue's own figures frozen verbatim on the deposit block.
    expect(rec.composedDeposit).toMatchObject({
      venueId: 'sideshift-eurc',
      orderId: 'shift-1',
      depositAddress: VENUE_DEPOSIT,
      depositOwner: VENUE_OWNER,
      amountDecimal: '1.188',
      amountRaw: '118800000',
      fee: HUB_FEE,
      settleSymbol: 'EURC',
      settleDecimals: 6,
      settleAmountDecimal: '0.0115',
      settleAmountRaw: '11500',
    });
    // The record's shape: out* = the settle side (mint-keyed), hop* = the first watchable
    // ledger, the destination the user's own derived SOL address.
    expect(rec.outLedger).toBe(EURC_MINT_ADDRESS);
    expect(rec.outSymbol).toBe('EURC');
    expect(rec.outDecimals).toBe(6);
    expect(rec.hopLedger).toBe(ICP_LEDGER);
    expect(rec.hopCurrency).toBe(8);
    expect(rec.expectedNet).toBe('11500'); // the venue's locked settle figure, raw units
    expect(rec.destAddress).toBe(SOL_ADDRESS);
    expect(rec.destNetwork).toBe('Solana');
    expect(rec.providerRef).toMatchObject({orderId: 'shift-1', statusUrl: 'https://sideshift.ai/api/v2/shifts/shift-1'});
  });

  test('a moved IC quote throws the re-review error BEFORE the order exists — nothing created, nothing signed', async () => {
    await expect(prepareComposedConvertRecord({
      id: 'comp-1',
      secretHex: SECRET,
      publicHex: PUBLIC,
      relayUrl: 'http://relay.test',
      route: ROUTE,
      inDesc: rowOf(7) as CurrencyDescriptor,
      quote1: quote1({amountOutGross: '121000000'}), // the confirm-time re-quote moved
      math1: math1(),
      reviewedGrossRaw: '120000000', // what the review showed
    })).rejects.toBeInstanceOf(ComposedQuoteChangedError);
    expect(createSideShiftFixedShift).not.toHaveBeenCalled(); // no orphaned venue order
    expect(fetchSideShiftQuote).not.toHaveBeenCalled();
    expect(jest.mocked(DpayCore.icpSignUpdate)).not.toHaveBeenCalled();
  });

  test('an order pricing a DIFFERENT deposit than the quoted floor is refused unsigned', async () => {
    jest.mocked(createSideShiftFixedShift).mockResolvedValue({...ORDER, depositAmount: '9.99'});
    await expect(prepared()).rejects.toThrow();
    expect(jest.mocked(DpayCore.icpSignUpdate)).not.toHaveBeenCalled();
  });

  test('the venue echoing its own deposit amount reformatted (not changed) still adopts', async () => {
    jest.mocked(createSideShiftFixedShift).mockResolvedValue({...ORDER, depositAmount: '1.18800000'});
    const rec = await prepared();
    expect(rec.composedDeposit?.amountDecimal).toBe('1.18800000');
  });

  test('the venue deposit address resolving to the USER’S OWN account is refused', async () => {
    jest.mocked(DpayCore.icpValidateIcrcAccount).mockResolvedValue({owner: MY_PRINCIPAL, subaccountHex: ''});
    await expect(prepared()).rejects.toThrow();
    expect(jest.mocked(DpayCore.icpSignUpdate)).not.toHaveBeenCalled();
  });

  test('a 64-hex account identifier deposit address rides the ICP ledger’s legacy transfer', async () => {
    jest.mocked(DpayCore.icpValidateIcrcAccount).mockRejectedValue(new Error('not icrc text'));
    jest.mocked(DpayCore.icpValidateAccountId).mockResolvedValue('a'.repeat(64));
    const rec = await prepared();
    expect(rec.legs[2]!.method).toBe('transfer');
    expect(jest.mocked(DpayCore.icpLegacyTransferArg).mock.calls[0]).toEqual([
      'a'.repeat(64), '', '118800000', HUB_FEE, '0',
    ]);
  });
});

describe('the deposit leg lifecycle — gate, signed once, resume, no-retry', () => {
  test('happy path: approve → swap (payout SEEN) → gate passes → deposit submits ONCE → awaiting_deposit', async () => {
    const rec = await prepared();
    const out = await executeConvert(rec, deps(), OPTS);
    expect(out.step).toBe('awaiting_deposit'); // the venue poll owns the record now
    expect(out.legPlan!.map(p => p.state)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(out.composedDeposit?.sentTx).toBe('9'); // the settled block index
    // Exactly THREE submits in leg order; the deposit's bytes are the frozen ones.
    expect(jest.mocked(submitTransfer)).toHaveBeenCalledTimes(3);
    const ledgers = jest.mocked(submitTransfer).mock.calls.map(c => (c[0] as {ledger: string}).ledger);
    expect(ledgers).toEqual([VCHF_LEDGER, POOL1, ICP_LEDGER]);
    expect(jest.mocked(submitTransfer).mock.calls[2][0]).toMatchObject({
      ledger: ICP_LEDGER,
      envelopeHex: rec.legs[2]!.envelopeHex,
      requestIdHex: rec.legs[2]!.requestIdHex,
    });
    expect(jest.mocked(DpayCore.icpSignUpdate)).toHaveBeenCalledTimes(3); // never re-signed
  });

  test('the gate refuses to sign when the record’s frozen order amount and transfer amount disagree', async () => {
    const rec = await prepared();
    const tampered: ConvertRecord = {
      ...rec,
      composedDeposit: {...rec.composedDeposit!, amountDecimal: '9.99'}, // a hostile write
    };
    const out = await executeConvert(tampered, deps(), OPTS);
    expect(out.step).toBe('failed_leg');
    expect(out.failureCode).toBe('deposit_refused');
    expect(out.legPlan![2]!.state).toBe('failed');
    expect(jest.mocked(submitTransfer)).toHaveBeenCalledTimes(2); // the deposit NEVER left
  });

  test('resume mid-leg: the ledger row proves the transfer executed — no second submit, no second sign', async () => {
    const rec = await prepared();
    // The kill-window shape: the deposit leg was submitted, its state persisted, the
    // outcome never was.
    const parked: ConvertRecord = {
      ...rec,
      legPlan: rec.legPlan!.map((p, i) => (i < 2 ? {...p, state: 'confirmed' as const} : {...p, state: 'sent' as const})),
      hopTx: '11',
    };
    mockRows([poolRow, depositRow]); // the deposit row is ON the ledger
    const out = await executeConvert(parked, deps(), OPTS);
    expect(out.step).toBe('awaiting_deposit');
    expect(out.legPlan![2]!.state).toBe('confirmed');
    expect(out.composedDeposit?.sentTx).toBe('12'); // the ROW's identity, not a new submit
    expect(jest.mocked(submitTransfer)).not.toHaveBeenCalled();
  });

  test('resume mid-leg without row evidence: the IDENTICAL bytes resubmit (dedup-safe), nothing re-signed', async () => {
    const rec = await prepared();
    const parked: ConvertRecord = {
      ...rec,
      legPlan: rec.legPlan!.map((p, i) => (i < 2 ? {...p, state: 'confirmed' as const} : {...p, state: 'sent' as const})),
      hopTx: '11',
    };
    const out = await executeConvert(parked, deps(), OPTS);
    expect(out.step).toBe('awaiting_deposit');
    expect(jest.mocked(submitTransfer)).toHaveBeenCalledTimes(1); // the deposit only
    expect(jest.mocked(submitTransfer).mock.calls[0][0]).toMatchObject({
      ledger: ICP_LEDGER,
      envelopeHex: rec.legs[2]!.envelopeHex, // the SAME bytes
      requestIdHex: rec.legs[2]!.requestIdHex,
    });
  });

  test('a definitive ledger refusal ends the deposit leg ONCE — a re-drive never submits again', async () => {
    const rec = await prepared();
    jest.mocked(submitTransfer)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '2'} as never)
      .mockResolvedValueOnce({kind: 'rejected', reason: 'InsufficientFunds', variant: 'InsufficientFunds'} as never);
    const failed = await executeConvert(rec, deps(), OPTS);
    expect(failed.step).toBe('failed_leg');
    expect(failed.failureCode).toBe('deposit_refused');
    expect(failed.legPlan![2]!.state).toBe('failed');
    expect(jest.mocked(submitTransfer)).toHaveBeenCalledTimes(3);
    // The hub asset (the swap payout) is still in the wallet; the record is terminal and
    // no driver re-enters it — the honest no-retry discipline.
    const again = await executeConvert(failed, deps(), OPTS);
    expect(again).toEqual(failed);
    expect(jest.mocked(submitTransfer)).toHaveBeenCalledTimes(3);
  });

  test('an unreadable hub balance HOLDS the deposit leg (never a blind submit); the re-arm retries the gate', async () => {
    const rec = await prepared();
    jest.mocked(railBalanceOf).mockResolvedValue(null);
    const out = await executeConvert(rec, deps(), OPTS);
    expect(out.step).toBe('approving');
    expect(out.legPlan![2]!.state).toBe('pending');
    expect(jest.mocked(submitTransfer)).toHaveBeenCalledTimes(2); // approve + swap only
  });

  test('a SHORT hub balance refuses the deposit (the venue can never credit a partial order)', async () => {
    const rec = await prepared();
    jest.mocked(railBalanceOf).mockResolvedValue('118800000'); // the amount, but short of +fee
    const out = await executeConvert(rec, deps(), OPTS);
    expect(out.step).toBe('failed_leg');
    expect(out.failureCode).toBe('deposit_refused');
    expect(jest.mocked(submitTransfer)).toHaveBeenCalledTimes(2);
  });

  test('an expired venue order window refuses the deposit before it can leave', async () => {
    const rec = await prepared();
    const expired: ConvertRecord = {
      ...rec,
      composedDeposit: {...rec.composedDeposit!, expiresAtMs: Date.now() - 1_000},
    };
    const out = await executeConvert(expired, deps(), OPTS);
    expect(out.step).toBe('failed_leg');
    expect(out.failureCode).toBe('deposit_refused');
    expect(out.failureDetail).toContain('expired');
    expect(jest.mocked(submitTransfer)).toHaveBeenCalledTimes(2);
  });

  test('the expiry trichotomy: dead envelopes but the deposit row SEEN → the venue owes the trade', async () => {
    const rec = await prepared();
    const dead: ConvertRecord = {
      ...rec,
      legs: rec.legs.map(l => ({...l, expiresAtMs: 1})),
      legPlan: rec.legPlan!.map((p, i) => (i < 2 ? {...p, state: 'confirmed' as const} : {...p, state: 'sent' as const})),
    };
    mockRows([depositRow]);
    const out = await executeConvert(dead, deps(), {...OPTS, nowMs: Date.now() + 1_000_000});
    expect(out.step).toBe('awaiting_deposit'); // the venue poll resolves it honestly
    expect(out.composedDeposit?.sentTx).toBe('12');
    expect(jest.mocked(submitTransfer)).not.toHaveBeenCalled(); // dead bytes never resubmit
  });

  test('the expiry trichotomy: dead envelopes, no deposit row, hub row SEEN → failed_leg (ICP in-wallet)', async () => {
    const rec = await prepared();
    const dead: ConvertRecord = {
      ...rec,
      legs: rec.legs.map(l => ({...l, expiresAtMs: 1})),
    };
    const out = await executeConvert(dead, deps(), {...OPTS, nowMs: Date.now() + 1_000_000});
    expect(out.step).toBe('failed_leg');
    expect(out.failureCode).toBe('unknown');
    expect(out.hopTx).toBe('11');
    expect(jest.mocked(submitTransfer)).not.toHaveBeenCalled();
  });
});

describe('the composed record’s provider phase — the venue poll finishes the trade', () => {
  test('a completed venue status lands done in the SETTLE asset’s own units', async () => {
    const rec = await prepared();
    const sent = await executeConvert(rec, deps(), OPTS);
    expect(sent.step).toBe('awaiting_deposit');
    jest.mocked(fetchWithTimeout).mockResolvedValue(fakeRes({
      status: 'completed', settleAmount: '0.0119', settleHash: 'sol-sig-1',
    }) as never);
    const done = await advanceProviderRecord(sent, () => true, 'http://relay.test');
    expect(done.step).toBe('done');
    expect(done.outAmountNet).toBe(toUnits('0.0119', 6)); // '11900' — EURC raw units, not ICP's
    expect(done.outTx).toBe('sol-sig-1');
  });

  test('the engine drives the composed record’s provider phase to done and stops', async () => {
    const rec = await prepared();
    const sent = await executeConvert(rec, deps(), OPTS);
    await AsyncStorage.setItem(convertStoreKey(PUBLIC), JSON.stringify({[sent.id]: sent}));
    let poll = 0;
    jest.mocked(fetchWithTimeout).mockImplementation(async () => {
      poll += 1;
      return fakeRes(poll === 1
        ? {status: 'deposit_received'}
        : {status: 'completed', settleAmount: '0.0115', settleHash: 'sol-sig-2'}) as never;
    });
    const stop = startConvertResumeEngine(
      {secretHex: SECRET, publicHex: PUBLIC, relayUrl: 'http://relay.test'},
      {rearmMs: 5, stuckWatchMs: 5, providerPollMs: 5, executorOpts: OPTS},
    );
    for (let i = 0; i < 200 && convertResumeSnapshot()[sent.id]?.step !== 'done'; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    stop();
    expect(convertResumeSnapshot()[sent.id]?.step).toBe('done');
    expect(convertResumeSnapshot()[sent.id]?.outAmountNet).toBe('11500');
  });
});

// --- THE HOP-SKIP (2026-10-04 founder finding) ------------------------------------------------------
// The founder's device held BOTH VCHF and ICP; Convert VCHF → EURC still signed the
// VCHF→ICP pool swap even though the wallet's ICP already covered the cefi leg's exact
// deposit requirement. Money rule: a swap the existing balance makes unnecessary is never
// signed. When the wallet's balance of the DEPOSIT (hop) asset covers the order's exact
// deposit + its transfer fee — the executor's own deposit-gate arithmetic (amountRaw + fee)
// — the record must be born as the LEGLESS cefi record (inCurrency = the hop asset) the
// deposit watcher auto-funds from balance. Fail-open: an unreadable balance never proves
// coverage, and the composed route signs exactly as before.

/** The covered prepare: the same reviewed quote, plus the wallet's hop balance. */
async function preparedWithHopBalance(hopBalanceRaw: string | null | undefined): Promise<ConvertRecord> {
  return prepareComposedConvertRecord({
    id: 'hop-1',
    secretHex: SECRET,
    publicHex: PUBLIC,
    relayUrl: 'http://relay.test',
    route: ROUTE,
    inDesc: rowOf(7) as CurrencyDescriptor,
    quote1: quote1(),
    math1: math1(),
    reviewedGrossRaw: '120000000',
    ...(hopBalanceRaw !== undefined ? {hopBalanceRaw} : {}),
  });
}

describe('the hop-skip — existing balance of the deposit asset retires the swap', () => {
  test('a wallet balance covering deposit + fee builds the LEGLESS cefi record — nothing signed', async () => {
    const rec = await preparedWithHopBalance('200000000'); // 2 ICP ≥ 1.188 + 0.0001
    // The truth, named: a plain cefi record. ICP in (the hop asset), the venue's order
    // carried verbatim, awaiting the deposit the watcher sends from the wallet.
    expect(rec.step).toBe('awaiting_deposit');
    expect(rec.venueId).toBe('sideshift-eurc'); // the CEFI venue, never the pool
    expect(rec.legs).toEqual([]);
    expect(rec.legPlan).toBeUndefined();
    expect(rec.composedDeposit).toBeUndefined();
    expect(rec.hopLedger).toBeUndefined(); // no hop: the input IS the deposit asset
    expect(rec.inCurrency).toBe(8);
    expect(rec.inLedger).toBe(ICP_LEDGER);
    expect(rec.inSymbol).toBe('ICP');
    expect(rec.inDecimals).toBe(8);
    expect(rec.amountIn).toBe('118800000'); // the order's EXACT deposit figure
    expect(rec.outLedger).toBe(EURC_MINT_ADDRESS);
    expect(rec.outSymbol).toBe('EURC');
    expect(rec.providerDeposit).toMatchObject({depositAddress: VENUE_DEPOSIT, depositAmount: '1.188'});
    expect(rec.providerRef).toMatchObject({orderId: 'shift-1'});
    // ORDER FIRST still holds — and NOTHING was signed: no approve, no depositFromAndSwap.
    expect(createSideShiftFixedShift).toHaveBeenCalledTimes(1);
    expect(jest.mocked(DpayCore.icpSignUpdate)).not.toHaveBeenCalled();
    expect(jest.mocked(DpayCore.icpApproveArg)).not.toHaveBeenCalled();
    expect(jest.mocked(DpayCore.icpDepositAndSwapArg)).not.toHaveBeenCalled();
  });

  test('the balance boundary is the executor\'s own gate arithmetic: amount + fee, inclusive', async () => {
    // Exactly amountRaw + fee → covered (the executor's gate is `>=`, never `>`).
    const exact = await preparedWithHopBalance('118810000');
    expect(exact.legs).toEqual([]);
    // One raw unit short → the swap is NOT provably unnecessary: the composed route signs.
    const short = await preparedWithHopBalance('118809999');
    expect(short.legs.map(l => l.method)).toEqual(['icrc2_approve', 'depositFromAndSwap', 'icrc1_transfer']);
    expect(jest.mocked(DpayCore.icpSignUpdate)).toHaveBeenCalledTimes(3);
  });

  test('an unreadable balance never invents a skip — the composed route signs as before', async () => {
    for (const unreadable of [null, 'abc', ''] as const) {
      const rec = await preparedWithHopBalance(unreadable);
      expect(rec.legs.map(l => l.method)).toEqual(['icrc2_approve', 'depositFromAndSwap', 'icrc1_transfer']);
      expect(rec.composedDeposit).not.toBeUndefined();
    }
  });

  test('the covered record drives to done with ZERO ICPSwap calls — the engine never signs a leg', async () => {
    const rec = await preparedWithHopBalance('200000000');
    await AsyncStorage.setItem(convertStoreKey(PUBLIC), JSON.stringify({[rec.id]: rec}));
    jest.mocked(fetchWithTimeout).mockResolvedValue(fakeRes({status: 'waiting'}) as never);
    const stop = startConvertResumeEngine(
      {secretHex: SECRET, publicHex: PUBLIC, relayUrl: 'http://relay.test'},
      {rearmMs: 5, stuckWatchMs: 5, providerPollMs: 5, executorOpts: OPTS},
    );
    await new Promise((r) => setTimeout(r, 60)); // several engine ticks
    stop();
    // The venue poll owns the record; no IC envelope was ever submitted: zero approves to
    // the VCHF ledger, zero swaps to the pool — the wallet's ICP is the only money that moves.
    expect(convertResumeSnapshot()[rec.id]?.step).toBe('awaiting_deposit');
    expect(jest.mocked(submitTransfer)).not.toHaveBeenCalled();
    expect(jest.mocked(DpayCore.icpSignUpdate)).not.toHaveBeenCalled();
  });

  test('the watcher\'s deposit send draws the EXACT order amount from the hop balance', async () => {
    const rec = await preparedWithHopBalance('200000000');
    // The legacy ICP shape (SideShift's live deposit address form): the watcher's dispatch
    // on the venue's address, amount = the order's exact deposit, fee = the ledger's own.
    const legacyRec = {...rec, providerDeposit: {...rec.providerDeposit!, depositAddress: 'c'.repeat(64)}};
    const preparedLegacy: Array<{ledger: string; toAccountId: string; amountE8s: string; feeE8s: string}> = [];
    const outcome = await sendCefiDepositForRecord(legacyRec as never, {
      catalog: {currencies: [{currency: 8, ledger: ICP_LEDGER, fee: HUB_FEE}]},
      secretHex: SECRET,
      prepareTransfer: async () => { throw new Error('icrc path must not fire for a legacy address'); },
      prepareLegacyTransfer: async (_s, req) => {
        preparedLegacy.push(req);
        return {ledger: ICP_LEDGER, envelopeHex: 'env-dep', requestIdHex: 'rid-dep'};
      },
      decodeLegacyReply: async () => ({ok: true, blockIndex: '77'}),
      submitTransfer: async (p) => {
        expect(p.ledger).toBe(ICP_LEDGER);
        return {kind: 'settled', blockIndex: '77'};
      },
    });
    expect(outcome).toEqual({kind: 'sent', blockIndex: '77'});
    expect(preparedLegacy).toEqual([
      {ledger: ICP_LEDGER, toAccountId: 'c'.repeat(64), amountE8s: '118800000', feeE8s: HUB_FEE},
    ]);
  });
});
