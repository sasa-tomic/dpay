/**
 * The CHAIN route engine (2026-09-28, the any-pair mandate) — the fail-closed pins:
 *   • HYDRATION: a chain record's two phases (legs empty + solanaLeg + providerRef; legs
 *     2/4 + the plan mirror) survive a store round-trip; any corruption drops the record.
 *   • PHASE 2 (beginChainPhase2): the IC legs sign ONLY from the record's own frozen plan
 *     (venue, pool, ordered pair), quoted on the venue's LOCKED settle figure under the
 *     self-funding rule (floor − 2×fromFee), the amount echo gate, the record rewrite
 *     (venueId becomes the IC pool the probes key on), all-or-nothing.
 *   • THE 1-LEG TERMINAL (resolveChainTerminal): done only on the SEEN payout row.
 *   • THE PROVIDER HOOK: the venue's completed reading drives phase 2 — the record NEVER
 *     lands at `done` carrying the settle asset's units in the dest asset's fields.
 * Every venue call is a mock — no live venue is ever touched (the offline dev-loop rule).
 */
import {describe, expect, jest, test, beforeEach} from '@jest/globals';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpPrincipalFromPubkey: jest.fn(async () => 'principal-text'),
    icpApproveArg: jest.fn(async () => '4449444c0000'),
    icpDepositAndSwapArg: jest.fn(async () => '4449444c0001'),
    icpSignUpdate: jest.fn(async (_secret: string, canister: string, method: string) => ({
      envelopeHex: `ee${method.length.toString(16)}${canister.slice(0, 2)}`,
      requestIdHex: `rr${canister.slice(0, 2)}`,
    })),
    icpSwapMinOut: jest.fn(async (gross: string, bps: number) => {
      const g = BigInt(gross);
      return ((g - (g * BigInt(bps)) / 10_000n)).toString();
    }),
  },
}));
jest.mock('../services/icp', () => ({
  icStampExpiry: jest.fn(async (_secret: string, aheadS?: number) =>
    ((1_700_000_000n + BigInt(aheadS ?? 300)) * 1_000_000n).toString()),
}));
jest.mock('../services/txNotes', () => ({saveTxNote: jest.fn(async () => undefined)}));
jest.mock('../solana', () => ({
  submitRawSolTx: jest.fn(),
  getSolSignatureStatus: jest.fn(),
  getSolBlockHeight: jest.fn(),
  loadRpcForSend: jest.fn(async () => {
    throw new Error('no rpc in this test');
  }),
}));
jest.mock('../convert/quotes', () => ({
  fetchConvertQuote: jest.fn(),
  deriveConvertMath: jest.fn(),
  fetchCeFiQuoteResult: jest.fn(),
  createCeFiOrder: jest.fn(),
}));
jest.mock('../convert/records', () => {
  const actual = jest.requireActual('../convert/records') as Record<string, unknown>;
  return {...actual, saveConvertRecord: jest.fn(async () => undefined)};
});
jest.mock('../convert/execute', () => ({
  probeHopPayout: jest.fn(),
}));

import {DpayCore} from '../services/native';
import {submitRawSolTx, getSolSignatureStatus} from '../solana';
import {fetchConvertQuote, deriveConvertMath} from '../convert/quotes';
import {saveConvertRecord} from '../convert/records';
import {probeHopPayout} from '../convert/execute';
import {beginChainPhase2, driveChainDeposit, resolveChainTerminal} from '../convert/executeChain';
import {prepareChainConvertRecord} from '../convert/prepare';
import {hydrateConvertStore} from '../convert/records';
import {type ConvertRecord} from '../convert/types';
import {EURC_MINT_ADDRESS} from '../solana/tokens';
import bs58 from 'bs58';

// The REAL registry principals — the prepare's fail-closed pair check reads the bundled
// venue row, so the fixtures must name the same rail-canonical ids the registry does.
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';

const MOCK_CHAIN: ConvertRecord = {
  id: 'chain-1',
  createdAtMs: 1_700_000_000_000,
  step: 'awaiting_deposit',
  venueId: 'sideshift-eurc',
  inLedger: EURC_MINT_ADDRESS,
  inSymbol: 'EURC',
  inDecimals: 6,
  hopLedger: ICP_LEDGER,
  hopSymbol: 'ICP',
  hopCurrency: 8,
  hopDecimals: 8,
  outLedger: 'vchf-ledger',
  outSymbol: 'VCHF',
  outCurrency: 7,
  outDecimals: 8,
  amountIn: '10000000', // 10 EURC
  expectedGross: '250000000', // 2.5 ICP (mid units)
  expectedNet: '490000000', // plan net, VCHF units
  inFee: '0',
  outFee: '10000',
  slippageBps: 100,
  legs: [],
  solanaLeg: {
    protocol: 'solana',
    signedTxHex: 'aabb',
    signature: 'sig-1',
    lastValidBlockHeight: 12345,
  },
  destAddress: 'account-id-text',
  destSymbol: 'VCHF',
  destNetwork: 'Internet Computer',
  providerRef: {orderId: 'order-1', statusUrl: 'https://sideshift.ai/api/v2/shifts/order-1'},
  chainRoute: {
    venueId: 'sideshift-eurc',
    orderId: 'order-1',
    depositAddress: 'VenueSolanaAddress11111111111111111111111111',
    amountDecimal: '10',
    amountRaw: '10000000',
    settleAmountDecimal: '2.5',
    settleAmountRaw: '250000000',
    icLegs: [{venueId: 'icpswap', pool: 'pool-principal', fromLedger: ICP_LEDGER, toLedger: 'vchf-ledger'}],
    icFromFees: ['10000'],
  },
};

const deps = {
  secretHex: 'aa',
  publicHex: 'bb',
  relayUrl: 'https://relay.test',
  onUpdate: jest.fn(async () => undefined),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('chain hydration', () => {
  test('phase 1 (legs empty + deposit leg + providerRef) survives a store round-trip', () => {
    const out = hydrateConvertStore({['chain-1']: JSON.parse(JSON.stringify(MOCK_CHAIN))});
    expect(out['chain-1']).toBeDefined();
    expect(out['chain-1']!.chainRoute?.orderId).toBe('order-1');
    expect(out['chain-1']!.providerRef?.orderId).toBe('order-1');
    expect(out['chain-1']!.solanaLeg?.signature).toBe('sig-1');
  });

  test('phase 2 (2 legs + the approve/swap plan mirror) survives; a plan/legs mismatch drops', () => {
    const phase2: ConvertRecord = {
      ...MOCK_CHAIN,
      step: 'approving',
      venueId: 'icpswap',
      inCurrency: 8,
      amountIn: '249980000',
      legs: [
        {canister: ICP_LEDGER, method: 'icrc2_approve', argHex: 'aa', envelopeHex: 'ee', requestIdHex: 'r1', expiresAtMs: 1},
        {canister: 'pool-principal', method: 'depositFromAndSwap', argHex: 'aa', envelopeHex: 'ee', requestIdHex: 'r2', expiresAtMs: 1},
      ],
      legPlan: [
        {kind: 'approve', canister: ICP_LEDGER, fee: '10000', state: 'pending'},
        {kind: 'swap', canister: 'pool-principal', fee: '', state: 'pending'},
      ],
    };
    const out = hydrateConvertStore({['chain-1']: JSON.parse(JSON.stringify(phase2))});
    expect(out['chain-1']).toBeDefined();
    // A legs/plan disagreement is a shape this build never wrote — dropped, never guessed.
    const corrupt = {...phase2, legPlan: phase2.legPlan!.slice(0, 1)} as unknown as Record<string, unknown>;
    const dropped = hydrateConvertStore({['chain-1']: corrupt});
    expect(dropped['chain-1']).toBeUndefined();
  });

  test('the providerRef orderId MUST be the chain block\u2019s (one order, one id)', () => {
    const corrupt = {...MOCK_CHAIN, providerRef: {orderId: 'other-order', statusUrl: 'https://x.test'}};
    const out = hydrateConvertStore({['chain-1']: JSON.parse(JSON.stringify(corrupt))});
    expect(out['chain-1']).toBeUndefined();
  });
});

describe('phase 2 — the frozen plan signs, all-or-nothing', () => {
  test('legs quote on settle − 2×fromFee, the echo gate holds, the record rewrites to the IC pool', async () => {
    const mockedQuote = jest.mocked(fetchConvertQuote);
    const mockedMath = jest.mocked(deriveConvertMath);
    // settle 2.5 ICP = 250000000; fromFee 10000 → input 250000000 − 20000 = 249980000.
    mockedQuote.mockImplementation(async (_r, from, to, amount) => ({
      venueId: 'icpswap',
      pool: 'pool-principal',
      tokenInLedger: from,
      tokenOutLedger: to,
      amountIn: amount,
      amountOutGross: (BigInt(amount) * 2n).toString(),
      feeMillionths: 3000,
      zeroForOne: true,
      fetchedAtMs: Date.now(),
    }) as Awaited<ReturnType<typeof fetchConvertQuote>>);
    mockedMath.mockImplementation(async (q, inFee, outFee, bps) => {
      const gross = BigInt(q.amountOutGross);
      const minOut = gross - (gross * BigInt(bps)) / 10_000n;
      return {
        amountIn: q.amountIn,
        grossOut: q.amountOutGross,
        minOut: minOut.toString(),
        netOut: (gross > BigInt(outFee) ? gross - BigInt(outFee) : 0n).toString(),
        inFee,
        outFee,
        slippageBps: bps,
      };
    });
    const next = await beginChainPhase2(MOCK_CHAIN, deps);
    expect(next.step).toBe('approving');
    // The self-funding input: the venue's locked settle minus the leg's own rails.
    expect(mockedQuote.mock.calls[0]![3]).toBe('249980000');
    expect(mockedQuote.mock.calls[0]![1]).toBe(ICP_LEDGER);
    expect(mockedQuote.mock.calls[0]![2]).toBe('vchf-ledger');
    // The record's probe key becomes the IC pool; the mid asset becomes the input.
    expect(next.venueId).toBe('icpswap');
    expect(next.inLedger).toBe(ICP_LEDGER);
    expect(next.inCurrency).toBe(8);
    expect(next.legs).toHaveLength(2);
    expect(next.legPlan!.map(l => l.kind)).toEqual(['approve', 'swap']);
    expect(next.solanaLeg?.signature).toBe('sig-1'); // the deposit leg rides along
    expect(next.chainRoute?.orderId).toBe('order-1');
    // The approve covers the pull + its fee (the exact-amount convention).
    const approveArg = jest.mocked(DpayCore.icpApproveArg).mock.calls[0]!;
    expect(approveArg[3]).toBe('249990000'); // 249980000 + 10000 inFee
  });

  test('a quote that echoes a DIFFERENT amount is a different trade: terminal failed_leg, no legs', async () => {
    const mockedQuote = jest.mocked(fetchConvertQuote);
    mockedQuote.mockImplementation(async (_r, _from, _to, _amount) => ({
      venueId: 'icpswap',
      pool: 'pool-principal',
      tokenInLedger: _from,
      tokenOutLedger: _to,
      amountIn: '999', // NOT the plan figure — the echo gate must refuse
      amountOutGross: '1000',
      feeMillionths: 3000,
      zeroForOne: true,
      fetchedAtMs: Date.now(),
    }) as Awaited<ReturnType<typeof fetchConvertQuote>>);
    const next = await beginChainPhase2(MOCK_CHAIN, deps);
    expect(next.step).toBe('failed_leg');
    expect(next.legs).toHaveLength(0); // all-or-nothing: no partial plan persists
  });
});

describe('phase 1 — the frozen deposit bytes, identical-bytes discipline', () => {
  test('submit + chain confirm → awaiting_deposit; the bytes are NEVER rebuilt', async () => {
    jest.mocked(submitRawSolTx).mockResolvedValue('sig-1');
    jest.mocked(getSolSignatureStatus).mockResolvedValue({confirmationStatus: 'confirmed', err: null});
    const next = await driveChainDeposit({...MOCK_CHAIN, step: 'swapping'}, deps);
    expect(next.step).toBe('awaiting_deposit');
    expect(jest.mocked(submitRawSolTx).mock.calls[0]![0]).toEqual(new Uint8Array([0xaa, 0xbb]));
  });

  test('a chain failure verdict refunds honestly (the deposit never landed)', async () => {
    jest.mocked(submitRawSolTx).mockResolvedValue('sig-1');
    jest.mocked(getSolSignatureStatus).mockResolvedValue({confirmationStatus: 'confirmed', err: {InstructionError: [0, 'Custom']}});
    const next = await driveChainDeposit({...MOCK_CHAIN, step: 'swapping'}, deps);
    expect(next.step).toBe('failed_refunded');
    expect(next.failureCode).toBe('swap_refused');
  });

  test('a signature mismatch parks stuck (never our bytes, never guessed)', async () => {
    jest.mocked(submitRawSolTx).mockResolvedValue('different-sig');
    const next = await driveChainDeposit({...MOCK_CHAIN, step: 'swapping'}, deps);
    expect(next.step).toBe('stuck');
    expect(next.failureDetail).toBe('signature-mismatch');
  });
});

describe('the 1-leg terminal', () => {
  test('done lands ONLY on the SEEN payout row (the amount is the row\u2019s, never the quote\u2019s)', async () => {
    const allConfirmed: ConvertRecord = {
      ...MOCK_CHAIN,
      step: 'pending_withdrawal',
      venueId: 'icpswap',
      legs: [
        {canister: ICP_LEDGER, method: 'icrc2_approve', argHex: 'aa', envelopeHex: 'ee', requestIdHex: 'r1', expiresAtMs: 1},
        {canister: 'pool-principal', method: 'depositFromAndSwap', argHex: 'aa', envelopeHex: 'ee', requestIdHex: 'r2', expiresAtMs: 1},
      ],
      legPlan: [
        {kind: 'approve', canister: ICP_LEDGER, fee: '10000', state: 'confirmed'},
        {kind: 'swap', canister: 'pool-principal', fee: '', state: 'confirmed'},
      ],
    };
    jest.mocked(probeHopPayout).mockResolvedValueOnce({amount: '489900000', tx: 'row-tx-9'});
    const resolved = await resolveChainTerminal(allConfirmed, deps);
    expect(resolved?.step).toBe('done');
    expect(resolved?.outAmountNet).toBe('489900000');
    expect(resolved?.outTx).toBe('row-tx-9');
    // No row seen → the record stays exactly as it was (the engine re-arms).
    jest.mocked(probeHopPayout).mockResolvedValueOnce(null);
    expect(await resolveChainTerminal(allConfirmed, deps)).toBeNull();
  });
});

describe('the chain prepare (confirm path) — order first, exact deposit', () => {
  test('the venue\u2019s order figures freeze verbatim; the deposit transfer signs LAST', async () => {
    const {fetchCeFiQuoteResult, createCeFiOrder} = await import('../convert/quotes');
    jest.mocked(fetchCeFiQuoteResult).mockResolvedValue({
      settleAmount: '2.5', rate: null, fetchedAtMs: 1, quoteId: 'q1', rateId: null, provider: null,
    });
    jest.mocked(createCeFiOrder).mockResolvedValue({
      id: 'order-9',
      depositAddress: '11111111111111111111111111111111',
      depositAmount: '10.000000',
      settleAmount: '2.5',
      expiresAt: '2026-09-28T12:00:00Z',
    } as never);
    // The deposit leg builder is driven through loadRpcForSend — stub the whole RPC seam.
    const {loadRpcForSend} = await import('../solana');
    const quoteMock = jest.mocked(fetchConvertQuote);
    quoteMock.mockImplementation(async (_r, from, to, amount) => ({
      venueId: 'icpswap', pool: 'pool-principal', tokenInLedger: from, tokenOutLedger: to,
      amountIn: amount, amountOutGross: (BigInt(amount) * 2n).toString(),
      feeMillionths: 3000, zeroForOne: true, fetchedAtMs: 1,
    }) as Awaited<ReturnType<typeof fetchConvertQuote>>);
    const mathMock = jest.mocked(deriveConvertMath);
    mathMock.mockImplementation(async (q, inFee, outFee, bps) => {
      const gross = BigInt(q.amountOutGross);
      const minOut = gross - (gross * BigInt(bps)) / 10_000n;
      return {amountIn: q.amountIn, grossOut: q.amountOutGross, minOut: minOut.toString(),
        netOut: gross.toString(), inFee, outFee, slippageBps: bps};
    });
    jest.mocked(loadRpcForSend).mockImplementation(async () => {
      // Enough of the rpc module for the deposit builder: the venue deposit account reads
      // as a wallet (System owner), the sender ATA holds the amount, the recipient ATA
      // exists, the balance covers rent, and one blockhash answers.
      const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const mintBytes = bs58.decode(EURC_MINT_ADDRESS);
      const info = () => {
        const raw = new Uint8Array(165);
        raw.set(mintBytes, 0); // SPL account layout: mint at 0..32
        // amount is bytes 64..72, big-endian read — 10_000_000 (10 EURC).
        raw.set([0, 0, 0, 0, 0, 0x98, 0x96, 0x80], 64);
        return {lamports: 1, owner: tokenProgram, data: [Buffer.from(raw).toString('base64'), 'base64']};
      };
      return {
        getMultipleAccounts: jest.fn(async (_u: unknown, addrs: string[]) => addrs.map((a) => {
          // The venue deposit address reads as a never-funded wallet (System-owned by
          // absence); every derived ATA reads as an existing funded token account.
          if (a === '11111111111111111111111111111111') return null;
          return info();
        })),
        getBalance: jest.fn(async () => '100000000'),
        getLatestBlockhash: jest.fn(async () => ({
          blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 777, slot: 1, contextSlot: 1,
        })),
      } as never;
    });
    const rec = await prepareChainConvertRecord({
      id: 'rec-1',
      secretHex: 'aa',
      publicHex: 'bb',
      relayUrl: 'https://relay.test',
      route: {
        kind: 'chain',
        routeId: 'chain:sideshift-eurc:icpswap',
        cefiVenueId: 'sideshift-eurc',
        depositMint: EURC_MINT_ADDRESS,
        depositSymbol: 'EURC',
        depositDecimals: 6,
        legs: [{venueId: 'icpswap', pool: 'pool-principal', fromLedger: ICP_LEDGER, toLedger: 'vchf-ledger'}],
        endpoints: [
          {currency: 8, ledger: ICP_LEDGER, symbol: 'ICP', decimals: 8, fee: '10000', network: 'Internet Computer'},
          {currency: 7, ledger: 'vchf-ledger', symbol: 'VCHF', decimals: 8, fee: '10000', network: 'Internet Computer'},
        ],
      },
      amountRaw: '10000000',
      slippageBps: 100,
      settleAddressIc: 'account-id-text',
    });
    // ORDER FIRST: the venue's own figures froze verbatim (never reformatted).
    expect(rec.chainRoute?.orderId).toBe('order-9');
    expect(rec.chainRoute?.amountDecimal).toBe('10.000000');
    expect(rec.chainRoute?.settleAmountDecimal).toBe('2.5');
    // The record is born at the deposit flight, legs empty, the plan frozen.
    expect(rec.step).toBe('swapping');
    expect(rec.legs).toHaveLength(0);
    expect(rec.solanaLeg?.lastValidBlockHeight).toBe(777);
    expect(rec.providerRef?.orderId).toBe('order-9');
    expect(rec.chainRoute?.icLegs[0]!.venueId).toBe('icpswap');
    // The plan leg quoted on the ESTIMATE (the review figure) — prepare's own discipline.
    expect(quoteMock.mock.calls[0]![3]).toBe('249980000');
    expect(saveConvertRecord).not.toHaveBeenCalled(); // prepare never persists — the adopt does
  });
});
