/**
 * The CROSS-RAIL surface of the convert engine (Routes B/C, 2026-09-16 spec update):
 *
 *   ICP →(5 IC legs)→ USDC @ user's EVM address →(CCTP v2 burn, signed by the USER's
 *   wallet — dpay never holds an EVM key)→ USDC @ user's Solana ATA →(Jupiter)→ SOL.
 *
 * Pinned here: the prepared record's crossRail facts + widened legPlan, hydration's
 * cross-rail matrix (parallelism, step vocabulary, mutual-exclusivity relaxations), the
 * executor's phase handoff (withdraw settles → awaiting_external, NEVER done), the
 * handoff bytes (buildCctpHandoff golden facts + the ATA re-derivation refusal), the
 * crossing watcher (complete+verified → sol_ready/done; stall → parked, never a false
 * failure), the final Jupiter leg, and the DEAD-END matrix (every failure names where
 * the funds sit: in-wallet ckUSDC, USDC at the user's EVM address, or USDC at the ATA).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import bs58 from 'bs58';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpPrincipalFromPubkey: jest.fn(),
    icpSwapMinOut: jest.fn(),
    icpApproveArg: jest.fn(),
    icpDepositAndSwapArg: jest.fn(),
    icpWithdrawErc20Arg: jest.fn(),
    icpSignUpdate: jest.fn(),
    icpDecodeSwapResult: jest.fn(),
    icpDecodeApproveResult: jest.fn(),
    icpDecodeMinterOk: jest.fn(),
  },
  sha256: jest.fn(),
}));
jest.mock('../services/icp', () => ({icStampExpiry: jest.fn()}));
jest.mock('../services/relay', () => ({relayFetch: jest.fn()}));
jest.mock('../services/rail', () => ({
  submitTransfer: jest.fn(),
  fetchGasFeeWei: jest.fn(),
  fetchLedgerFee: jest.fn(),
}));
jest.mock('../solana', () => ({
  getSolBlockHeight: jest.fn(),
  getSolNativeCredit: jest.fn(),
  getSolSignatureStatus: jest.fn(),
  getSolTokenCredit: jest.fn(),
  quoteSolMessageFee: jest.fn(),
  submitRawSolTx: jest.fn(),
}));
jest.mock('../solana/tx', () => {
  // Only the venue-tx seams are mocked; the rest of the pure module (codecs, base58,
  // transfer builders) stays REAL — spl.ts and others import from it transitively.
  const actual = jest.requireActual('../solana/tx') as Record<string, unknown>;
  return {
    ...actual,
    decodeVenueSwapTx: jest.fn(),
    signVenueSwapTx: jest.fn(),
    verifyVenueSwapTxBeneficiaries: jest.fn(),
  };
});
jest.mock('../services/jupiter', () => ({
  fetchJupiterQuote: jest.fn(),
  fetchJupiterSwapTx: jest.fn(),
}));

import {DpayCore} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {relayFetch} from '../services/relay';
import {fetchGasFeeWei, fetchLedgerFee, submitTransfer} from '../services/rail';
import {
  getSolBlockHeight,
  getSolNativeCredit,
  getSolSignatureStatus,
  getSolTokenCredit,
  quoteSolMessageFee,
  submitRawSolTx,
} from '../solana';
import {decodeVenueSwapTx, signVenueSwapTx, verifyVenueSwapTxBeneficiaries} from '../solana/tx';
import {fetchJupiterQuote, fetchJupiterSwapTx} from '../services/jupiter';
import {
  attachCctpBurnTx,
  buildCctpHandoff,
  declineCctpHandoff,
  executeConvert,
  executeCrossRailConvert,
  executeCrossRailSolSwap,
  hydrateConvertStore,
  prepareCrossRailSolLeg,
  prepareMultihopConvertRecord,
  type ConvertMath,
  type ConvertQuote,
  type ConvertRecord,
} from '../convert';
import {multihopRoutesFrom} from '../routes';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {deriveSolanaAddress} from '../solana/identity';
import {deriveAta} from '../solana/spl';
import {USDC_MINT_ADDRESS, WRAPPED_SOL_MINT_ADDRESS} from '../solana/tokens';

const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
const POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const DEST = '0xa0b86991c6218b36c1d19d4a2e9eb0cE3606eB48'.toLowerCase();
const SECRET = '00'.repeat(32);
const SOL_ADDRESS = deriveSolanaAddress(SECRET);
const ATA_B58 = bs58.encode(deriveAta(SOL_ADDRESS, USDC_MINT_ADDRESS));

// A FUTURE stamp — expiresAtMs = ns/1e6 must land past `nowMs` or the expiry trichotomy
// fires at executor entry and every run resolves as expired.
const STAMP_NS = String(BigInt(Date.now() + 3_600_000) * 1_000_000n);
const fakeRes = (body: unknown, ok = true, status = 200) => ({ok, status, json: async () => body});
const rowsRes = (rows: unknown[]) => fakeRes({transactions: rows});
// Probe fixtures must look NEWER than any record's createdAtMs (the settlement
// probes ignore rows predating the record — 2026-09-19 live fix).
const NOW = () => Math.floor(Date.now() / 1000) + 3600;
const myPrincipal = 'myprincipal123';
const OPTS = {submitAttempts: 2, poll: {attempts: 1, intervalMs: 0}, settleAttempts: 1, settleIntervalMs: 0};

// Circle's live fees answer (pinned 2026-09-15: fast = 1 bps + med forward fee in subunits).
const FEES_BODY = [
  {finalityThreshold: 1000, minimumFee: 1, forwardFee: {low: 269688, med: 282032, high: 305756}},
  {finalityThreshold: 2000, minimumFee: 0, forwardFee: {low: 269688, med: 282032, high: 305756}},
];
const MIN_OUT = '188100000'; // the mocked icpSwapMinOut — the burn amount is THIS, never the gross
// cctpMaxFee(188100000, {1 bps, med 282032}) = floor((18810 + 282032) × 1.2) = 361010
const MAX_FEE = '361010';

const hopQuote = (over: Partial<ConvertQuote> = {}): ConvertQuote => ({
  venueId: 'icpswap-ckusdc',
  pool: POOL,
  tokenInLedger: BUNDLED.find(c => c.currency === 8)!.ledger!,
  tokenOutLedger: BUNDLED.find(c => c.currency === 2)!.ledger!,
  amountIn: '100000000',
  amountOutGross: '190000000',
  zeroForOne: true,
  feeMillionths: 3000,
  fetchedAtMs: Date.now(),
  ...over,
});

const hopMath = (over: Partial<ConvertMath> = {}): ConvertMath => ({
  amountIn: '100000000',
  grossOut: '190000000',
  minOut: MIN_OUT,
  netOut: '189990000',
  inFee: '10000',
  outFee: '10000',
  slippageBps: 100,
  ...over,
} as ConvertMath);

// The fetch stand-in only ever serves Circle's two read-only GETs; its shape is loose
// on purpose (ok/status/json) — the production code never touches the other Response fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchMock: any;

beforeEach(() => {
  jest.clearAllMocks();
  AsyncStorage.clear();
  fetchMock = jest.fn(async () => fakeRes(FEES_BODY));
  (globalThis as {fetch?: unknown}).fetch = fetchMock;
  jest.mocked(icStampExpiry).mockResolvedValue(STAMP_NS as never);
  jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal);
  jest.mocked(DpayCore.icpSwapMinOut).mockResolvedValue(MIN_OUT);
  jest.mocked(DpayCore.icpApproveArg).mockResolvedValue('approve-arg-hex');
  jest.mocked(DpayCore.icpDepositAndSwapArg).mockResolvedValue('swap-arg-hex');
  jest.mocked(DpayCore.icpWithdrawErc20Arg).mockResolvedValue('withdraw-arg-hex');
  jest.mocked(DpayCore.icpSignUpdate).mockImplementation(async (_s, canister) => ({
    envelopeHex: `env-${canister}`, requestIdHex: `req-${canister}`,
  } as never));
  jest.mocked(DpayCore.icpDecodeSwapResult).mockResolvedValue({ok: true, amountOutGross: '190000000'});
  jest.mocked(DpayCore.icpDecodeMinterOk).mockResolvedValue({ok: true, blockIndex: '77'});
  jest.mocked(fetchGasFeeWei).mockResolvedValue('78000000000000');
  jest.mocked(fetchLedgerFee).mockResolvedValue('2000000000000');
});

afterEach(() => {
  delete (globalThis as {fetch?: unknown}).fetch;
});

/** A freshly prepared Route C record (ICP → SOL): 5 signed IC legs + 2 external plan legs. */
async function plannedCrossRecord(over: Partial<ConvertRecord> = {}): Promise<ConvertRecord> {
  const route = multihopRoutesFrom(BUNDLED, 8)[2]; // :cctp:jupiter
  const rec = await prepareMultihopConvertRecord({
    secretHex: SECRET,
    quote: hopQuote(),
    math: hopMath(),
    route,
    destAddress: DEST,
  });
  return {...rec, ...over};
}

/** Run the five IC legs to the phase boundary (submitter + hop ledger cooperate). */
async function runIcLegs(rec: ConvertRecord): Promise<ConvertRecord> {
  jest.mocked(relayFetch).mockResolvedValue(rowsRes([
    {currency: 2, from: POOL, to: myPrincipal, amount: '190000000', block: '7', timestamp: NOW()},
  ]) as never);
  jest.mocked(submitTransfer).mockImplementation(async (_p, _s, _o, decodeReply) => {
    if (decodeReply != null) await decodeReply('reply-hex');
    return {kind: 'settled', blockIndex: '1'} as never;
  });
  return executeConvert(rec, {
    secretHex: SECRET, publicHex: 'aabb', relayUrl: 'http://relay', onUpdate: () => {},
  }, OPTS);
}

describe('prepareMultihopConvertRecord — the crossRail block (Routes B/C)', () => {
  test('Route C freezes the Solana facts + extends the plan with cctp_burn and sol_swap', async () => {
    const rec = await plannedCrossRecord();
    expect(rec.crossRail).toEqual({
      kind: 'cctp_sol',
      solAddress: SOL_ADDRESS,
      mintRecipientAta: ATA_B58,
      maxFeeSubunits: MAX_FEE,
      mintFloorSubunits: (BigInt(MIN_OUT) - BigInt(MAX_FEE)).toString(),
      solVenueId: 'jupiter',
    });
    expect(rec.destSymbol).toBe('SOL');
    expect(rec.destNetwork).toBe('Solana');
    // 5 IC legs signed + 2 external plan entries with no IC canister, all still pending.
    expect(rec.legs).toHaveLength(5);
    expect(rec.legPlan!.map(p => p.kind)).toEqual([
      'approve', 'swap', 'approve', 'approve_gas', 'withdraw_erc20', 'cctp_burn', 'sol_swap',
    ]);
    const tail = rec.legPlan!.slice(5);
    expect(tail.every(p => p.canister === '' && p.state === 'pending')).toBe(true);
  });

  test('Route B (USDC on Solana) has NO sol leg — kind cctp, plan of exactly 6', async () => {
    const route = multihopRoutesFrom(BUNDLED, 8)[1]; // :cctp
    const rec = await prepareMultihopConvertRecord({
      secretHex: SECRET, quote: hopQuote(), math: hopMath(), route, destAddress: DEST,
    });
    expect(rec.crossRail!.kind).toBe('cctp');
    expect(rec.crossRail!.solVenueId).toBeUndefined();
    expect(rec.destSymbol).toBe('USDC');
    expect(rec.destNetwork).toBe('Solana');
    expect(rec.legPlan).toHaveLength(6);
    expect(rec.legPlan!.map(p => p.kind)).toEqual([
      'approve', 'swap', 'approve', 'approve_gas', 'withdraw_erc20', 'cctp_burn',
    ]);
  });

  test('Circle fee unreachable → nothing signed (fail-closed)', async () => {
    fetchMock.mockResolvedValue(fakeRes({}, false, 500));
    await expect(plannedCrossRecord()).rejects.toThrow();
    expect(jest.mocked(DpayCore.icpSignUpdate).mock.calls.length).toBe(0);
  });
});

describe('hydration — the cross-rail matrix', () => {
  test('a Route C record round-trips through the store byte-for-byte on facts', async () => {
    const rec = await plannedCrossRecord();
    const out = hydrateConvertStore({[rec.id]: JSON.parse(JSON.stringify(rec))});
    expect(Object.keys(out)).toEqual([rec.id]);
    const h = out[rec.id]!;
    expect(h.crossRail).toEqual(rec.crossRail);
    expect(h.legPlan!.map(p => p.kind)).toEqual(rec.legPlan!.map(p => p.kind));
    expect(h.legs).toHaveLength(5);
    expect(h.destAddress).toBe(DEST);
  });

  test('the solanaLeg coexists with legs+legPlan ONLY on a cross-rail record', async () => {
    const rec = await plannedCrossRecord({step: 'swapping'});
    const withLeg = {
      ...rec,
      solanaLeg: {protocol: 'solana' as const, signedTxHex: 'ab', signature: 'sig', lastValidBlockHeight: 300},
    };
    expect(hydrateConvertStore({[withLeg.id]: JSON.parse(JSON.stringify(withLeg))})[withLeg.id]?.solanaLeg).toBeDefined();
  });

  test('plan/legs parallelism is exact: a dropped cctp_burn entry rejects the record', async () => {
    const rec = await plannedCrossRecord();
    const six = {...rec, legPlan: rec.legPlan!.slice(0, 6)};
    expect(hydrateConvertStore({[six.id]: JSON.parse(JSON.stringify(six))})).toEqual({});
  });

  test('external legs must carry NO canister; the tail order is fixed', async () => {
    const rec = await plannedCrossRecord();
    const badCanister = JSON.parse(JSON.stringify(rec));
    badCanister.legPlan[5].canister = 'some-canister';
    expect(hydrateConvertStore({[rec.id]: badCanister})).toEqual({});

    const badTail = JSON.parse(JSON.stringify(rec));
    badTail.legPlan[6].kind = 'cctp_burn'; // two burns, no sol_swap, kind says cctp_sol
    expect(hydrateConvertStore({[rec.id]: badTail})).toEqual({});
  });

  test('cross-rail records live ONLY in the cross-rail step vocabulary', async () => {
    const rec = await plannedCrossRecord();
    expect(hydrateConvertStore({[rec.id]: JSON.parse(JSON.stringify({...rec, step: 'quote'}))})).toEqual({});
    expect(hydrateConvertStore({[rec.id]: JSON.parse(JSON.stringify({...rec, step: 'awaiting_external'}))})[rec.id]?.step).toBe('awaiting_external');
    expect(hydrateConvertStore({[rec.id]: JSON.parse(JSON.stringify({...rec, step: 'crossing'}))})[rec.id]?.step).toBe('crossing');
    expect(hydrateConvertStore({[rec.id]: JSON.parse(JSON.stringify({...rec, step: 'sol_ready'}))})[rec.id]?.step).toBe('sol_ready');
  });

  test('crossRail facts are mandatory: bad kind or empty Solana address drops the record', async () => {
    const rec = await plannedCrossRecord();
    const badKind = JSON.parse(JSON.stringify(rec));
    badKind.crossRail.kind = 'wormhole';
    expect(hydrateConvertStore({[rec.id]: badKind})).toEqual({});
    const noSol = JSON.parse(JSON.stringify(rec));
    noSol.crossRail.solAddress = '';
    expect(hydrateConvertStore({[rec.id]: noSol})).toEqual({});
  });
});

describe('the executor phase handoff — withdraw settles into the USER\'s wallet, not "done"', () => {
  test('five IC legs confirm; the record parks at awaiting_external with external legs pending', async () => {
    const rec = await runIcLegs(await plannedCrossRecord());
    expect(rec.step).toBe('awaiting_external'); // NOT done — the USDC is at the user's EVM address
    expect(rec.legPlan!.slice(0, 5).every(p => p.state === 'confirmed')).toBe(true);
    expect(rec.legPlan![5].state).toBe('pending'); // cctp_burn waits on the user's wallet
    expect(rec.legPlan![6].state).toBe('pending');
    expect(rec.outTx).toBe('77'); // the minter's block index — the EVM-side receipt
    expect(rec.outAmountNet).toBeUndefined(); // no terminal amount until Solana verifies
  });

  test('Route A (no crossRail) still lands done — the widening changed nothing for it', async () => {
    const route = multihopRoutesFrom(BUNDLED, 8)[0];
    const rec = await prepareMultihopConvertRecord({
      secretHex: SECRET, quote: hopQuote(), math: hopMath(), route, destAddress: DEST,
    });
    const out = await runIcLegs(rec);
    expect(out.step).toBe('done');
    expect(out.outAmountNet).toBe(MIN_OUT);
  });
});

describe('buildCctpHandoff — the exact bytes the user\'s wallet signs', () => {
  test('approve targets TokenMessenger; burn carries the ATA, domain 5, fast finality, live maxFee', async () => {
    const rec = await runIcLegs(await plannedCrossRecord());
    const handoff = await buildCctpHandoff(SECRET, rec);
    expect(handoff.approveCalldata.startsWith('0x095ea7b3')).toBe(true); // approve(address,uint256)
    expect(handoff.approveCalldata).toContain('28b5a0e9c621a5badaa536219b3a228c8168cf5d'); // TokenMessengerV2
    expect(handoff.burnCalldata.startsWith('0x779b432d')).toBe(true); // depositForBurnWithHook
    // mintRecipient (word 2) = the user's USDC ATA, re-derived and re-verified here
    const ataHex = Array.from(bs58.decode(ATA_B58), b => b.toString(16).padStart(2, '0')).join('');
    expect(handoff.burnCalldata.slice(2 + 8 + 2 * 64, 2 + 8 + 3 * 64)).toBe(ataHex);
    expect(handoff.amountSubunits).toBe(MIN_OUT);
    expect(handoff.maxFeeSubunits).toBe(MAX_FEE);
    expect(handoff.minFinalityThreshold).toBe(1000);
    expect(handoff.destinationDomain).toBe(5);
  });

  test('a mutated solAddress is refused — the handoff NEVER re-targets', async () => {
    const rec = await runIcLegs(await plannedCrossRecord());
    const other = deriveSolanaAddress('11'.repeat(32));
    const mutated = {...rec, crossRail: {...rec.crossRail!, solAddress: other}};
    await expect(buildCctpHandoff(SECRET, mutated)).rejects.toThrow();
  });

  test('only an awaiting_external record builds a handoff', async () => {
    const rec = await plannedCrossRecord(); // still 'approving'
    await expect(buildCctpHandoff(SECRET, rec)).rejects.toThrow();
  });
});

describe('attachCctpBurnTx / declineCctpHandoff — the two user exits from the handoff', () => {
  test('a valid EVM hash moves the record to crossing with the leg sent', async () => {
    const rec = await runIcLegs(await plannedCrossRecord());
    const hash = '0x' + 'ab'.repeat(32);
    const out = attachCctpBurnTx(rec, hash);
    expect(out.step).toBe('crossing');
    expect(out.crossRail!.burnTxHash).toBe(hash);
    expect(out.legPlan![5].state).toBe('sent');
    expect(() => attachCctpBurnTx(rec, 'not-a-hash')).toThrow();
  });

  test('declining names the honest dead end: USDC at the USER\'s own EVM address', async () => {
    const rec = await runIcLegs(await plannedCrossRecord());
    const out = declineCctpHandoff(rec);
    expect(out.step).toBe('failed_leg');
    expect(out.failureCode).toBe('external_declined');
    expect(out.legPlan![5].state).toBe('failed');
    // The dead-end copy keys off these facts: funds sit at destAddress, user-controlled.
    expect(out.destAddress).toBe(DEST);
  });
});

describe('executeCrossRailConvert — watching Circle attest and mint', () => {
  const deps = {secretHex: SECRET, publicHex: 'aabb', onUpdate: () => {}};
  const completeBody = {messages: [{forwardTxHash: '5KqxTAk9'}]};

  async function crossingRecord(): Promise<ConvertRecord> {
    return attachCctpBurnTx(await runIcLegs(await plannedCrossRecord()), '0x' + 'cd'.repeat(32));
  }

  test('attestation pending → the record STAYS crossing (a stall is never a false failure)', async () => {
    const rec = await crossingRecord();
    fetchMock.mockResolvedValueOnce(fakeRes({error: 'Message not found for provided parameters'}, false, 404));
    const out = await executeCrossRailConvert(rec, deps, {watchAttempts: 1, watchIntervalMs: 0});
    expect(out.step).toBe('crossing');
    expect(out.crossRail!.forwardTxHash).toBeUndefined();
  });

  test('complete but UNVERIFIED on Solana → crossing with the hash frozen (never claim unverified)', async () => {
    const rec = await crossingRecord();
    fetchMock.mockResolvedValueOnce(fakeRes(completeBody));
    jest.mocked(getSolTokenCredit).mockResolvedValue(null);
    const out = await executeCrossRailConvert(rec, deps, {watchAttempts: 1, watchIntervalMs: 0});
    expect(out.step).toBe('crossing');
    expect(out.crossRail!.forwardTxHash).toBe('5KqxTAk9'); // frozen — the Circle txn link is actionable
  });

  test('Route C: complete + verified credit → sol_ready with the mint frozen', async () => {
    const rec = await crossingRecord();
    fetchMock.mockResolvedValueOnce(fakeRes(completeBody));
    jest.mocked(getSolTokenCredit).mockResolvedValue('187700000');
    const out = await executeCrossRailConvert(rec, deps, {watchAttempts: 1, watchIntervalMs: 0});
    expect(out.step).toBe('sol_ready');
    expect(out.legPlan![5].state).toBe('confirmed');
    expect(out.crossRail!.mintSubunits).toBe('187700000');
    expect(out.crossRail!.forwardTxHash).toBe('5KqxTAk9');
  });

  test('Route B: complete + verified credit → done, the terminal amount is the VERIFIED credit', async () => {
    const route = multihopRoutesFrom(BUNDLED, 8)[1];
    const base = await prepareMultihopConvertRecord({
      secretHex: SECRET, quote: hopQuote(), math: hopMath(), route, destAddress: DEST,
    });
    const rec = attachCctpBurnTx(await runIcLegs(base), '0x' + 'ef'.repeat(32));
    fetchMock.mockResolvedValueOnce(fakeRes(completeBody));
    jest.mocked(getSolTokenCredit).mockResolvedValue('187700000');
    const out = await executeCrossRailConvert(rec, deps, {watchAttempts: 1, watchIntervalMs: 0});
    expect(out.step).toBe('done');
    expect(out.outAmountNet).toBe('187700000');
    expect(out.outTx).toBe('5KqxTAk9');
  });
});

describe('prepareCrossRailSolLeg + executeCrossRailSolSwap — the final Jupiter leg', () => {
  const deps = {secretHex: SECRET, publicHex: 'aabb', onUpdate: () => {}};

  async function solReadyRecord(): Promise<ConvertRecord> {
    const rec = attachCctpBurnTx(await runIcLegs(await plannedCrossRecord()), '0x' + 'cd'.repeat(32));
    fetchMock.mockResolvedValueOnce(fakeRes({messages: [{forwardTxHash: '5KqxTAk9'}]}));
    jest.mocked(getSolTokenCredit).mockResolvedValue('187700000');
    return executeCrossRailConvert(rec, deps, {watchAttempts: 1, watchIntervalMs: 0});
  }

  beforeEach(() => {
    jest.mocked(fetchJupiterQuote).mockResolvedValue({
      ok: true,
      quote: {
        venueId: 'jupiter', inputMint: USDC_MINT_ADDRESS, outputMint: 'So11111111111111111111111111111111111111112',
        inAmount: '187700000', outAmount: '1036000000', otherAmountThreshold: '1025000000',
        priceImpactPct: '0.003', slippageBps: 100, platformFeeBps: null, raw: {},
        fetchedAtMs: Date.now(),
      },
    } as never);
    jest.mocked(fetchJupiterSwapTx).mockResolvedValue({
      ok: true, swap: {swapTransaction: new Uint8Array([9, 9, 9]), lastValidBlockHeight: 300_000_000},
    } as never);
    jest.mocked(decodeVenueSwapTx).mockReturnValue({feePayer: SOL_ADDRESS} as never);
    jest.mocked(verifyVenueSwapTxBeneficiaries).mockReturnValue({ok: true} as never);
    jest.mocked(quoteSolMessageFee).mockResolvedValue(5000n);
    // Synchronous seam (pure signer) — a resolved Promise here would read as `feePayer: undefined`.
    jest.mocked(signVenueSwapTx).mockReturnValue({feePayer: SOL_ADDRESS, raw: new Uint8Array([1, 2, 3, 4])} as never);
  });

  test('sol_ready signs the final leg against a FRESH quote, at the frozen Solana address', async () => {
    const rec = await solReadyRecord();
    const out = await prepareCrossRailSolLeg(SECRET, rec, 'http://relay');
    expect(out.step).toBe('swapping');
    expect(out.legPlan![6].state).toBe('sent');
    expect(out.solanaLeg).toBeDefined();
    expect(out.crossRail!.solExpectedLamports).toBe('1025000000');
    // The quote was for the VERIFIED mint amount at the record's own slippage.
    const q = jest.mocked(fetchJupiterQuote).mock.calls[0]!;
    expect(q[0]).toBe('http://relay'); // the quote dials the wallet's relay
    expect(q[2]).toBe(USDC_MINT_ADDRESS);
    expect(q[3]).toBe(WRAPPED_SOL_MINT_ADDRESS);
    expect(q[4]).toBe('187700000');
    expect(q[5]).toBe(100);
  });

  test('happy path: submit + confirm → done at the user\'s Solana address with realized lamports', async () => {
    const ready = await prepareCrossRailSolLeg(SECRET, await solReadyRecord(), 'http://relay');
    const sig = ready.solanaLeg!.signature;
    jest.mocked(submitRawSolTx).mockResolvedValue(sig);
    jest.mocked(getSolSignatureStatus).mockResolvedValue({err: null, confirmationStatus: 'confirmed'} as never);
    jest.mocked(getSolNativeCredit).mockResolvedValue('1029000000');
    const out = await executeCrossRailSolSwap(ready, deps, {submitAttempts: 1, confirmAttempts: 1, pollIntervalMs: 0});
    expect(out.step).toBe('done');
    expect(out.outAmountNet).toBe('1029000000');
    expect(out.outTx).toBe(sig);
    expect(out.crossRail!.solAddress).toBe(SOL_ADDRESS); // the done copy names THIS address
    const solLeg = out.legPlan!.find(l => l.kind === 'sol_swap');
    expect(solLeg?.state).toBe('confirmed'); // the leg list IS the progress UI — done never shows a Sent tail
  });

  test('DEAD END — Jupiter refuses: USDC stays safe at the ATA (the record keeps naming it)', async () => {
    const ready = await prepareCrossRailSolLeg(SECRET, await solReadyRecord(), 'http://relay');
    jest.mocked(submitRawSolTx).mockResolvedValue(ready.solanaLeg!.signature);
    jest.mocked(getSolSignatureStatus).mockResolvedValue({err: {InstructionFailed: []}, confirmationStatus: null} as never);
    const out = await executeCrossRailSolSwap(ready, deps, {submitAttempts: 1, confirmAttempts: 1, pollIntervalMs: 0});
    expect(out.step).toBe('failed_refunded');
    expect(out.failureCode).toBe('swap_refused');
    expect(out.crossRail!.mintRecipientAta).toBe(ATA_B58); // funds are HERE — the copy must say so
  });

  test('DEAD END — blockhash expired: failed_refunded/unknown, never stuck-forever', async () => {
    const ready = await prepareCrossRailSolLeg(SECRET, await solReadyRecord(), 'http://relay');
    jest.mocked(submitRawSolTx).mockResolvedValue(ready.solanaLeg!.signature);
    jest.mocked(getSolSignatureStatus).mockResolvedValue(null);
    jest.mocked(getSolBlockHeight).mockResolvedValue(300_000_001);
    const out = await executeCrossRailSolSwap(ready, deps, {submitAttempts: 1, confirmAttempts: 1, pollIntervalMs: 0});
    expect(out.step).toBe('failed_refunded');
    expect(out.failureCode).toBe('unknown');
    expect(out.failureDetail).toContain('blockhash');
  });
});
