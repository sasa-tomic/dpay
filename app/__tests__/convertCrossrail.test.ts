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
  railBalanceOf: jest.fn(),
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
// The device-signed burn (stage 2) drives the EVM rail through the same endpoints module the
// send path uses — the unit tier re-points it at a stub URL the per-test fetch router serves.
jest.mock('../evm/endpoints', () => {
  const actual = jest.requireActual('../evm/endpoints') as Record<string, unknown>;
  return {...actual, evmRpcUrls: () => ['https://evm-stub.test/rpc'], evmRpcUrl: () => 'https://evm-stub.test/rpc'};
});

import {DpayCore} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {relayFetch} from '../services/relay';
import {fetchGasFeeWei, fetchLedgerFee, railBalanceOf, submitTransfer} from '../services/rail';
import {fetchEthBalance} from '../cctp';
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
  resolveGasFundPlan,
  type ConvertMath,
  type ConvertQuote,
  type ConvertRecord,
} from '../convert';
import {multihopRoutesFrom} from '../routes';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {deriveSolanaAddress} from '../solana/identity';
import {deriveAta} from '../solana/spl';
import {USDC_MINT_ADDRESS, WRAPPED_SOL_MINT_ADDRESS, EURC_MINT_ADDRESS} from '../solana/tokens';

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
      burnSigner: 'external', // the typed DEST is not the device's own address
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
    expect(rec.crossRail!.burnSigner).toBe('external');
    expect(rec.crossRail!.solVenueId).toBeUndefined();
    expect(rec.destSymbol).toBe('USDC');
    expect(rec.destNetwork).toBe('Solana');
    expect(rec.legPlan).toHaveLength(6);
    expect(rec.legPlan!.map(p => p.kind)).toEqual([
      'approve', 'swap', 'approve', 'approve_gas', 'withdraw_erc20', 'cctp_burn',
    ]);
  });

  test('stage 2: the device-derived EVM address as destination freezes burnSigner device', async () => {
    const {deriveEvmKeypair, toChecksumAddress} = await import('../evm/identity');
    const own = deriveEvmKeypair(SECRET).address;
    const route = multihopRoutesFrom(BUNDLED, 8)[2];
    const rec = await prepareMultihopConvertRecord({
      secretHex: SECRET, quote: hopQuote(), math: hopMath(), route, destAddress: own,
    });
    expect(rec.crossRail!.burnSigner).toBe('device');
    // The upper-case checksummed spelling of the SAME address is still the device (the
    // compare is case-insensitive) — a display convention never changes who signs.
    const rec2 = await prepareMultihopConvertRecord({
      secretHex: SECRET, quote: hopQuote(), math: hopMath(), route, destAddress: toChecksumAddress(own),
    });
    expect(rec2.crossRail!.burnSigner).toBe('device');
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

  test('stage 2: the frozen signer round-trips; absent stays byte-identical; bad values drop', async () => {
    const rec = await plannedCrossRecord(); // external (typed DEST)
    expect(rec.crossRail!.burnSigner).toBe('external');
    expect(hydrateConvertStore({[rec.id]: JSON.parse(JSON.stringify(rec))})[rec.id]?.crossRail?.burnSigner).toBe('external');
    // A pre-stage-2 record (no burnSigner) hydrates with the field ABSENT — byte-identical.
    const legacy = JSON.parse(JSON.stringify(rec));
    delete legacy.crossRail.burnSigner;
    const h = hydrateConvertStore({[rec.id]: legacy})[rec.id]!;
    expect(h.crossRail).not.toHaveProperty('burnSigner');
    // A value this build never wrote is a corrupt shape — the record is dropped, never
    // improvised into a signer.
    const bad = JSON.parse(JSON.stringify(rec));
    bad.crossRail.burnSigner = 'metamask';
    expect(hydrateConvertStore({[rec.id]: bad})).toEqual({});
  });

  test('stage 2: the frozen burn maxFee round-trips on the device path; garbage drops the record', async () => {
    const rec = await plannedCrossRecord();
    const withFee = JSON.parse(JSON.stringify({...rec, crossRail: {...rec.crossRail, burnMaxFeeSubunits: MAX_FEE}}));
    const h = hydrateConvertStore({[rec.id]: withFee})[rec.id]!;
    expect(h.crossRail!.burnMaxFeeSubunits).toBe(MAX_FEE);
    const bad = JSON.parse(JSON.stringify(withFee));
    bad.crossRail.burnMaxFeeSubunits = 'lots';
    expect(hydrateConvertStore({[rec.id]: bad})).toEqual({});
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

  test('a DEVICE-signed record never builds a handoff (stage 2: the device signs its own burn)', async () => {
    const {deriveEvmKeypair} = await import('../evm/identity');
    const own = deriveEvmKeypair(SECRET).address;
    const route = multihopRoutesFrom(BUNDLED, 8)[2];
    const rec = await prepareMultihopConvertRecord({
      secretHex: SECRET, quote: hopQuote(), math: hopMath(), route, destAddress: own,
    });
    const parked = {...rec, step: 'awaiting_external' as const};
    await expect(buildCctpHandoff(SECRET, parked)).rejects.toThrow('device-signed');
  });
});

// ── stage 2: the DEVICE-signed burn (swap-typing, 2026-10-03) ──────────────────────────────────
// A record whose frozen destination IS the device's own derived EVM address never parks at
// `awaiting_external`: the executor signs approve + depositForBurnWithHook ITSELF (the device
// has held its EVM key since D31) and the record walks straight to `crossing`. The safety
// order is the mission's order: Circle's live fee first (unreachable → nothing signed, the
// engine re-arms), the maxFee FROZEN on the record before any signature (a resume re-derives
// IDENTICAL burn bytes — EVM dedups by hash, so a crash between broadcast and persist can
// never double-burn), then the aggregate gas gate, then sign/broadcast/receipt per leg.
describe('the DEVICE-signed burn — the executor signs the crossing itself (stage 2)', () => {
  const deps = {secretHex: SECRET, publicHex: 'aabb', onUpdate: () => {}};
  const APPROVE_HASH = '0x' + '11'.repeat(32);
  const BURN_HASH = '0x' + '22'.repeat(32);
  const ETH_BAL = '0x56bc75e2d63100000'; // 100 ETH

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let evmRpcCalls: Array<{method: string; params: unknown[]}> = [];
  let sentKinds: string[] = [];

  /** Install a fetch mock that routes JSON-RPC POSTs (the EVM rail, module-mocked onto the
   *  stub URL) by method and serves Circle's two GETs verbatim. Receipt answers are seeded
   *  per broadcast (kind → the test's verdict) so the executor's hash-keyed polls resolve;
   *  `receiptForAny` pre-seeds EVERY hash (the resume-adoption shape) and `circleFail`
   *  refuses the fee census. */
  function installEvmRpc(opts: {
    receipts?: {approve?: {status: string} | null; burn?: {status: string} | null};
    receiptForAny?: {status: string};
    balance?: string;
    circleFail?: boolean;
    ethCall?: string;
  } = {}): void {
    const {receipts = {}, receiptForAny, balance = ETH_BAL, circleFail = false, ethCall} = opts;
    evmRpcCalls = [];
    sentKinds = [];
    // Receipt verdicts bind to the hash ASKED after each kind's broadcast (the executor
    // polls the LOCALLY signed hash, which the stub cannot precompute): an unbound entry
    // binds to the next hash asked; a bound entry answers only its own hash.
    const pending: Array<{hash: string | null; verdict: {status: string} | null}> = [];
    fetchMock = jest.fn(async (url: unknown, init?: {body?: string; method?: string}) => {
      const raw = init?.body;
      if (raw != null && typeof raw === 'string' && raw.includes('"method"')) {
        const body = JSON.parse(raw) as {method?: string; params?: unknown[]; id?: number};
        if (body.method != null) {
          evmRpcCalls.push({method: body.method, params: body.params ?? []});
          if (body.method === 'eth_sendRawTransaction') {
            const hex = String(body.params?.[0] ?? '');
            const kind = hex.includes('095ea7b3') ? 'approve' : 'burn';
            sentKinds.push(kind);
            const verdict = receipts[kind] !== undefined ? receipts[kind] : {status: '0x1'};
            pending.push({hash: null, verdict});
            return fakeRes({jsonrpc: '2.0', id: body.id ?? 1, result: kind === 'approve' ? APPROVE_HASH : BURN_HASH});
          }
          if (body.method === 'eth_getTransactionReceipt') {
            if (receiptForAny != null) return fakeRes({jsonrpc: '2.0', id: body.id ?? 1, result: receiptForAny});
            const asked = String(body.params?.[0]);
            for (const entry of pending) {
              if (entry.hash === null) {
                entry.hash = asked;
                return fakeRes({jsonrpc: '2.0', id: body.id ?? 1, result: entry.verdict});
              }
              if (entry.hash === asked) return fakeRes({jsonrpc: '2.0', id: body.id ?? 1, result: entry.verdict});
            }
            return fakeRes({jsonrpc: '2.0', id: body.id ?? 1, result: null});
          }
          if (body.method === 'eth_getBalance') {
            return fakeRes({jsonrpc: '2.0', id: body.id ?? 1, result: balance});
          }
          if (body.method === 'eth_call' && ethCall != null) {
            return fakeRes({jsonrpc: '2.0', id: body.id ?? 1, result: ethCall});
          }
          const defaults: Record<string, unknown> = {
            eth_chainId: '0x1',
            eth_gasPrice: '0x77359400', // 2 gwei
            eth_maxPriorityFeePerGas: '0x0',
            eth_estimateGas: '0xc350', // 50k units
            eth_getTransactionCount: '0x7',
          };
          if (!(body.method in defaults)) {
            return fakeRes({jsonrpc: '2.0', id: body.id ?? 1, error: {code: -32000, message: `unrouted: ${body.method}`}});
          }
          return fakeRes({jsonrpc: '2.0', id: body.id ?? 1, result: defaults[body.method]});
        }
      }
      if (circleFail && String(url).includes('/v2/burn/USDC/fees')) return fakeRes({}, false, 500);
      if (String(url).includes('/v2/messages/')) return fakeRes({error: 'Message not found for provided parameters'}, false, 404);
      return fakeRes(FEES_BODY);
    });
    (globalThis as {fetch?: unknown}).fetch = fetchMock;
  }

  /** A Route C record whose destination IS the device's own derived EVM address. */
  async function plannedDeviceRecord(): Promise<ConvertRecord> {
    const {deriveEvmKeypair} = await import('../evm/identity');
    const route = multihopRoutesFrom(BUNDLED, 8)[2];
    return prepareMultihopConvertRecord({
      secretHex: SECRET, quote: hopQuote(), math: hopMath(), route, destAddress: deriveEvmKeypair(SECRET).address,
    });
  }

  const burnOpts = {watchAttempts: 1, watchIntervalMs: 0, burnReceiptAttempts: 1, burnReceiptIntervalMs: 0};

  test('the withdraw lands a device record on CROSSING (never the external park)', async () => {
    const rec = await runIcLegs(await plannedDeviceRecord());
    expect(rec.crossRail!.burnSigner).toBe('device');
    expect(rec.step).toBe('crossing'); // NOT awaiting_external — no external wallet exists here
    expect(rec.crossRail!.burnTxHash).toBeUndefined();
    expect(rec.legPlan![5].state).toBe('pending'); // the burn is the crossing drive's job now
    expect(rec.outTx).toBe('77'); // the minter's block index, same evidence as Route A
  });

  test('a withdraw REFUSAL is verified at the destination before it is believed: delivered → crossing (2026-10-03 live finding)', async () => {
    const rec = await plannedDeviceRecord();
    jest.mocked(relayFetch).mockResolvedValue(rowsRes([
      {currency: 2, from: POOL, to: myPrincipal, amount: '190000000', block: '7', timestamp: NOW()},
    ]) as never);
    jest.mocked(submitTransfer)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '2'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '3'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '4'} as never)
      // The live trip's exact shape: the minter's withdraw answered refused with NO decodable
      // reason - yet the ckUSDC debit and the Ethereum credit both happened on-chain.
      .mockResolvedValue({kind: 'rejected', reason: '', variant: undefined} as never);
    // The destination answers: the burn floor IS there (>= MIN_OUT raw).
    installEvmRpc({ethCall: '0x' + BigInt(MIN_OUT).toString(16)});
    const out = await executeConvert(rec, {
      secretHex: SECRET, publicHex: 'aabb', relayUrl: 'http://relay', onUpdate: () => {},
    }, OPTS);
    expect(out.step).toBe('crossing'); // the money moved - the crossing continues, never a false refused
    expect(out.legPlan![4].state).toBe('confirmed');
    expect(out.failureCode).toBeUndefined();
  });

  test('a withdraw refusal with NOTHING at the destination stays an honest refused leg', async () => {
    const rec = await plannedDeviceRecord();
    jest.mocked(relayFetch).mockResolvedValue(rowsRes([
      {currency: 2, from: POOL, to: myPrincipal, amount: '190000000', block: '7', timestamp: NOW()},
    ]) as never);
    jest.mocked(submitTransfer)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '2'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '3'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '4'} as never)
      .mockResolvedValue({kind: 'rejected', reason: 'insufficient allowance', variant: 'InsufficientAllowance'} as never);
    installEvmRpc({ethCall: '0x0'});
    const out = await executeConvert(rec, {
      secretHex: SECRET, publicHex: 'aabb', relayUrl: 'http://relay', onUpdate: () => {},
    }, OPTS);
    expect(out.step).toBe('failed_leg');
    expect(out.failureCode).toBe('withdraw_refused');
    expect(out.failureDetail).toContain('insufficient allowance');
    expect(out.legPlan![4].state).toBe('failed');
  });

  test('the crossing drive signs approve + depositForBurnWithHook with the DEVICE key and parks back on crossing', async () => {
    const rec = await runIcLegs(await plannedDeviceRecord());
    installEvmRpc();
    const out = await executeCrossRailConvert(rec, deps, burnOpts);
    expect(out.step).toBe('crossing');
    expect(out.crossRail!.burnTxHash).toMatch(/^0x[0-9a-f]{64}$/); // the locally signed bytes' hash — durable identity
    expect(out.crossRail!.burnMaxFeeSubunits).toBe(MAX_FEE); // frozen at the Census arithmetic
    expect(out.legPlan![5].state).toBe('sent');
    // Gate order: chain proof → fee probe → gas gate → ONE nonce read → two broadcasts.
    expect(evmRpcCalls[0]!.method).toBe('eth_chainId');
    const sendIdx = evmRpcCalls.findIndex(c => c.method === 'eth_sendRawTransaction');
    const gateIdx = evmRpcCalls.findIndex(c => c.method === 'eth_getBalance');
    expect(gateIdx).toBeGreaterThan(0);
    expect(gateIdx).toBeLessThan(sendIdx);
    expect(evmRpcCalls.filter(c => c.method === 'eth_getTransactionCount')).toHaveLength(1);
    expect(sentKinds).toEqual(['approve', 'burn']);
  });

  test('the device signs the EXACT bytes the handoff would have rendered (one signer, one calldata)', async () => {
    const ext = await runIcLegs(await plannedCrossRecord()); // external record, same device key
    const handoff = await buildCctpHandoff(SECRET, ext);
    const rec = await runIcLegs(await plannedDeviceRecord());
    installEvmRpc();

    await executeCrossRailConvert(rec, deps, burnOpts);
    const estimates = evmRpcCalls.filter(c => c.method === 'eth_estimateGas').map(c => c.params[0] as {to: string; data: string});
    expect(estimates).toHaveLength(2);
    expect(estimates[0]!.data).toBe(handoff.approveCalldata);
    expect(estimates[0]!.to.toLowerCase()).toBe(handoff.burnToken.toLowerCase());
    expect(estimates[1]!.data).toBe(handoff.burnCalldata);
    expect(estimates[1]!.to.toLowerCase()).toBe(handoff.tokenMessenger.toLowerCase());
  });

  test('the gas gate refuses BEFORE any signature when the device address cannot cover both legs', async () => {
    const rec = await runIcLegs(await plannedDeviceRecord());
    installEvmRpc({balance: '0x01'}); // 1 wei
    const out = await executeCrossRailConvert(rec, deps, burnOpts);
    expect(out.step).toBe('failed_leg');
    expect(out.failureCode).toBe('burn_refused');
    expect(out.failureDetail).toMatch(/wei/); // the instructive gate copy, numbers included
    expect(sentKinds).toEqual([]); // nothing signed, nothing broadcast
    expect(out.legPlan![5].state).toBe('failed');
  });

  test('a reverted APPROVE stops dead: failed_leg, the burn never signs', async () => {
    const rec = await runIcLegs(await plannedDeviceRecord());
    installEvmRpc({receipts: {approve: {status: '0x0'}}});
    const out = await executeCrossRailConvert(rec, deps, burnOpts);
    expect(out.step).toBe('failed_leg');
    expect(out.failureCode).toBe('burn_refused');
    expect(sentKinds).toEqual(['approve']);
  });

  test('a reverted BURN is an honest dead end: failed_leg with the hash in the detail', async () => {
    const rec = await runIcLegs(await plannedDeviceRecord());
    installEvmRpc({receipts: {burn: {status: '0x0'}}});
    const out = await executeCrossRailConvert(rec, deps, burnOpts);
    expect(out.step).toBe('failed_leg');
    expect(out.failureCode).toBe('burn_refused');
    expect(sentKinds).toEqual(['approve', 'burn']);
  });

  test('a burn whose receipt never lands still freezes the hash and parks on crossing (never a false failure)', async () => {
    const rec = await runIcLegs(await plannedDeviceRecord());
    installEvmRpc({receipts: {burn: null}});
    const out = await executeCrossRailConvert(rec, deps, burnOpts);
    expect(out.step).toBe('crossing'); // the Circle watch continues by the frozen hash
    expect(out.crossRail!.burnTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out.legPlan![5].state).toBe('sent');
  });

  test('Circle unreachable at burn time → THROWS (nothing signed; the engine re-arms)', async () => {
    const rec = await runIcLegs(await plannedDeviceRecord());
    installEvmRpc({circleFail: true});
    await expect(executeCrossRailConvert(rec, deps, burnOpts)).rejects.toThrow();
    expect(evmRpcCalls).toHaveLength(0); // not even the chain proof ran — fee honesty comes first
  });

  test('resume after a crash mid-burn: mined txs are ADOPTED by receipt, never re-broadcast', async () => {
    const rec = await runIcLegs(await plannedDeviceRecord());
    installEvmRpc({receiptForAny: {status: '0x1'}}); // both legs already mined (the crash happened post-broadcast)
    const out = await executeCrossRailConvert(rec, deps, burnOpts);
    expect(out.step).toBe('crossing');
    expect(out.crossRail!.burnTxHash).toMatch(/^0x[0-9a-f]{64}$/); // the LOCALLY signed hash, adopted via receipt
    expect(sentKinds).toEqual([]); // ZERO broadcasts — the receipt probe adopted what mined
    expect(out.legPlan![5].state).toBe('sent');
  });

  test('resume byte-identity: a frozen maxFee re-derives the IDENTICAL burn calldata', async () => {
    const rec = await runIcLegs(await plannedDeviceRecord());
    installEvmRpc();

    const first = await executeCrossRailConvert(rec, deps, burnOpts);
    const firstBurn = evmRpcCalls.filter(c => c.method === 'eth_estimateGas').map(c => (c.params[0] as {data: string}).data)[1];
    // Simulate the crash-after-freeze state: hash unknown again, freeze intact.
    const crashed: ConvertRecord = {
      ...first,
      crossRail: {...first.crossRail!, burnTxHash: undefined},
      legPlan: first.legPlan!.map((p, i) => (i === 5 ? {...p, state: 'pending' as const} : p)),
    };
    installEvmRpc();

    const second = await executeCrossRailConvert(crashed, deps, burnOpts);
    const secondBurn = evmRpcCalls.filter(c => c.method === 'eth_estimateGas').map(c => (c.params[0] as {data: string}).data)[1];
    expect(second.crossRail!.burnTxHash).toBe(first.crossRail!.burnTxHash); // identical bytes → identical hash
    expect(secondBurn).toBe(firstBurn); // identical bytes — EVM dedup makes the re-drive safe
  });

  test('a hashless EXTERNAL crossing record parks untouched: no signer is improvised', async () => {
    // The corrupt-shape rule: an external record reaches crossing only THROUGH attach (which
    // freezes the hash in the same write), so crossing + external + no hash is a shape this
    // build never wrote — the drive must park it exactly as-is, sign nothing. (The engine's
    // re-arm keeps it watchable; the boot-sweep drive itself is pinned in convertResume.)
    const rec = await runIcLegs(await plannedCrossRecord()); // burnSigner: external
    const hashless: ConvertRecord = {...rec, step: 'crossing', crossRail: {...rec.crossRail!, burnTxHash: undefined}};
    installEvmRpc();
    const out = await executeCrossRailConvert(hashless, deps, burnOpts);
    expect(out).toBe(hashless); // byte-identical, same object — nothing advanced
    expect(evmRpcCalls).toHaveLength(0); // nothing signed, nothing broadcast, nothing read
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

// =================================================================================================
// The EURC widening (2026-09-19): Route C composes to ANY registered USDC-pair Solana
// token — jupiter-usdc-eurc turns CHF→EUR and USD(IC)→EUR into ONE intent. Pinned here:
// the route row BESIDE the original (registry order, per-venue routeId), the optional-only
// record widening (a native-SOL record carries none of the new fields), the fail-closed
// hydration shape sets (mint+decimals travel together, the two floor shapes are mutually
// exclusive, legacy hydrates byte-identically), the final leg's USDC→EURC quote with the
// ATA-OWNER beneficiary check, and the done panel reading the realized credit in the OUT
// MINT's base units (token credit at the ATA — never the native-lamports read).
// =================================================================================================
describe('the EURC widening — Route C to a registered USDC-pair SPL out', () => {
  const deps = {secretHex: SECRET, publicHex: 'aabb', onUpdate: () => {}};
  const EURC_OUT = '10300000';   // 10.3 EURC — the fresh quote's estimate (6 decimals)
  const EURC_FLOOR = '10200000'; // the leg's own min-out — the compounded floor's tail

  beforeEach(() => {
    jest.mocked(fetchJupiterSwapTx).mockResolvedValue({
      ok: true, swap: {swapTransaction: new Uint8Array([9, 9, 9]), lastValidBlockHeight: 300_000_000},
    } as never);
    jest.mocked(decodeVenueSwapTx).mockReturnValue({feePayer: SOL_ADDRESS} as never);
    jest.mocked(verifyVenueSwapTxBeneficiaries).mockReturnValue({ok: true} as never);
    jest.mocked(quoteSolMessageFee).mockResolvedValue(5000n);
    // Synchronous seam (pure signer) — a resolved Promise here would read as `feePayer: undefined`.
    jest.mocked(signVenueSwapTx).mockReturnValue({feePayer: SOL_ADDRESS, raw: new Uint8Array([1, 2, 3, 4])} as never);
  });

  function mockEurcQuote(): void {
    jest.mocked(fetchJupiterQuote).mockResolvedValue({
      ok: true,
      quote: {
        venueId: 'jupiter-usdc-eurc', inputMint: USDC_MINT_ADDRESS, outputMint: EURC_MINT_ADDRESS,
        inAmount: '187700000', outAmount: EURC_OUT, otherAmountThreshold: EURC_FLOOR,
        priceImpactPct: '0.002', slippageBps: 100, platformFeeBps: null, raw: {},
        fetchedAtMs: Date.now(),
      },
    } as never);
  }

  async function plannedEurcRecord(over: Partial<ConvertRecord> = {}): Promise<ConvertRecord> {
    const route = multihopRoutesFrom(BUNDLED, 8)[3]; // :cctp:jupiter-usdc-eurc
    const rec = await prepareMultihopConvertRecord({
      secretHex: SECRET, quote: hopQuote(), math: hopMath(), route, destAddress: DEST,
    });
    return {...rec, ...over};
  }

  /** The full chain to the final leg: prepare → IC legs → burn attached → mint verified →
   *  the EURC leg signed (quotes the VERIFIED mint credit, freezes the EURC floor). */
  async function eurcSwappingRecord(): Promise<ConvertRecord> {
    mockEurcQuote();
    const eurc = await plannedEurcRecord();
    const ready = attachCctpBurnTx(await runIcLegs(eurc), '0x' + 'cd'.repeat(32));
    fetchMock.mockResolvedValueOnce(fakeRes({messages: [{forwardTxHash: '5KqxTAk9'}]}));
    jest.mocked(getSolTokenCredit).mockResolvedValue('187700000');
    const solReady = await executeCrossRailConvert(ready, deps, {watchAttempts: 1, watchIntervalMs: 0});
    expect(solReady.step).toBe('sol_ready');
    return prepareCrossRailSolLeg(SECRET, solReady, 'http://relay');
  }

  test('route composition: the EURC venue composes BESIDE the SOL one — registry order, per-venue routeId', () => {
    const routes = multihopRoutesFrom(BUNDLED, 8);
    expect(routes[2]!.routeId).toBe('multihop:icpswap-ckusdc:2:cctp:jupiter');
    expect(routes[2]!.crossRail!.sol!.outMint).toBe(WRAPPED_SOL_MINT_ADDRESS); // the original row, untouched
    expect(routes[3]!.routeId).toBe('multihop:icpswap-ckusdc:2:cctp:jupiter-usdc-eurc');
    expect(routes[3]!.crossRail!.sol).toEqual({
      venueId: 'jupiter-usdc-eurc', outMint: EURC_MINT_ADDRESS, outSymbol: 'EURC', outDecimals: 6,
    });
    expect(routes[3]!.dest).toEqual({symbol: 'EURC', network: 'Solana'});
  });

  test('prepare freezes the out mint + decimals on the EURC route; the native-SOL record carries NONE of the new fields', async () => {
    const eurc = await plannedEurcRecord();
    expect(eurc.crossRail).toEqual({
      kind: 'cctp_sol',
      burnSigner: 'external',
      solAddress: SOL_ADDRESS,
      mintRecipientAta: ATA_B58,
      maxFeeSubunits: MAX_FEE,
      mintFloorSubunits: (BigInt(MIN_OUT) - BigInt(MAX_FEE)).toString(),
      solVenueId: 'jupiter-usdc-eurc',
      solOutMint: EURC_MINT_ADDRESS,
      solOutDecimals: 6,
    });
    expect(eurc.destSymbol).toBe('EURC');
    expect(eurc.destNetwork).toBe('Solana');
    expect(eurc.legPlan!.map(p => p.kind)).toEqual([
      'approve', 'swap', 'approve', 'approve_gas', 'withdraw_erc20', 'cctp_burn', 'sol_swap',
    ]);
    // The compounded floor: the burn floor IS the IC minOut; the mint floor is what
    // survives Circle's fee; the EURC leg's own floor (frozen later, at sol_ready)
    // compounds from THAT — min from the previous leg's floor, never re-derived.
    expect(BigInt(eurc.crossRail!.mintFloorSubunits!)).toBeLessThan(BigInt(MIN_OUT));

    const sol = await plannedCrossRecord();
    expect(sol.crossRail).toEqual({
      kind: 'cctp_sol',
      burnSigner: 'external',
      solAddress: SOL_ADDRESS,
      mintRecipientAta: ATA_B58,
      maxFeeSubunits: MAX_FEE,
      mintFloorSubunits: (BigInt(MIN_OUT) - BigInt(MAX_FEE)).toString(),
      solVenueId: 'jupiter',
    });
  });

  test('hydration: the SPL-out widening round-trips; broken shape sets are refused; a legacy record stays byte-identical', async () => {
    const eurc = await plannedEurcRecord();

    const ok = hydrateConvertStore({[eurc.id]: JSON.parse(JSON.stringify(eurc))})[eurc.id]!;
    expect(ok.crossRail).toEqual(eurc.crossRail);

    // Mint WITHOUT decimals (or the reverse) is a shape this build never wrote — dropped.
    const halfMint = JSON.parse(JSON.stringify(eurc));
    delete halfMint.crossRail.solOutDecimals;
    expect(hydrateConvertStore({[eurc.id]: halfMint})).toEqual({});

    // The subunit floor REQUIRES the mint facts, and NEVER coexists with the lamports floor.
    const subNoMint = JSON.parse(JSON.stringify(eurc));
    subNoMint.crossRail.solExpectedSubunits = '10200000';
    delete subNoMint.crossRail.solOutMint;
    delete subNoMint.crossRail.solOutDecimals;
    expect(hydrateConvertStore({[eurc.id]: subNoMint})).toEqual({});
    const bothFloors = JSON.parse(JSON.stringify(eurc));
    bothFloors.crossRail.solExpectedSubunits = '10200000';
    bothFloors.crossRail.solExpectedLamports = '1025000000';
    expect(hydrateConvertStore({[eurc.id]: bothFloors})).toEqual({});

    // A legacy native-SOL record (solExpectedLamports, none of the new fields) hydrates
    // byte-identically — the widening is optional-only.
    const legacy = await plannedCrossRecord();
    legacy.crossRail!.solExpectedLamports = '1025000000';
    const legHyd = hydrateConvertStore({[legacy.id]: JSON.parse(JSON.stringify(legacy))})[legacy.id]!;
    expect(legHyd.crossRail).toEqual(legacy.crossRail);
  });

  test('sol_ready signs against a FRESH USDC→EURC quote; the beneficiary check pins the DEVICE\'S OWN EURC ATA', async () => {
    const ready = await eurcSwappingRecord();
    const q = jest.mocked(fetchJupiterQuote).mock.calls[0]!;
    expect(q[0]).toBe('http://relay');
    expect(q[2]).toBe(USDC_MINT_ADDRESS);
    expect(q[3]).toBe(EURC_MINT_ADDRESS);
    expect(q[4]).toBe('187700000'); // the VERIFIED mint credit, never an estimate
    expect(q[5]).toBe(100);
    // The out floor is frozen in the OUT MINT's base units — and the native lamports
    // field stays ABSENT (the two shapes are mutually exclusive on one record).
    expect(ready.crossRail!.solExpectedSubunits).toBe(EURC_FLOOR);
    expect(ready.crossRail!.solExpectedLamports).toBeUndefined();
    // The beneficiary red line: the tx MUST pay out at the device's own EURC ATA.
    const beneficiary = jest.mocked(verifyVenueSwapTxBeneficiaries).mock.calls[0]!;
    expect(bs58.encode(beneficiary[1].pubkey)).toBe(SOL_ADDRESS);
    expect(bs58.encode(beneficiary[1].outAta!)).toBe(bs58.encode(deriveAta(SOL_ADDRESS, EURC_MINT_ADDRESS)));
    expect(ready.step).toBe('swapping');
    expect(ready.legPlan!.map(p => p.state)).toEqual([
      'confirmed', 'confirmed', 'confirmed', 'confirmed', 'confirmed', 'confirmed', 'sent',
    ]);
  });

  test('execute: the realized credit is the OUT-MINT token credit at the ATA (EURC units, never the lamports read)', async () => {
    const ready = await eurcSwappingRecord();
    jest.mocked(submitRawSolTx).mockResolvedValue(ready.solanaLeg!.signature);
    jest.mocked(getSolSignatureStatus).mockResolvedValue({err: null, confirmationStatus: 'confirmed'} as never);
    jest.mocked(getSolNativeCredit).mockResolvedValue('999999999'); // a native read would be a UNIT BUG
    jest.mocked(getSolTokenCredit).mockResolvedValue(EURC_OUT);
    const out = await executeCrossRailSolSwap(ready, deps, {submitAttempts: 1, confirmAttempts: 1, pollIntervalMs: 0});
    expect(out.step).toBe('done');
    expect(out.outAmountNet).toBe(EURC_OUT);
    expect(out.outTx).toBe(ready.solanaLeg!.signature);
    const c = jest.mocked(getSolTokenCredit).mock.calls.at(-1)!;
    expect(c[0]).toBe(ready.solanaLeg!.signature);
    expect(c[1]).toBe(SOL_ADDRESS);
    expect(c[2]).toBe(EURC_MINT_ADDRESS);
    expect(out.legPlan!.map(p => p.state)).toEqual([
      'confirmed', 'confirmed', 'confirmed', 'confirmed', 'confirmed', 'confirmed', 'confirmed',
    ]);
  });

  test('unreadable payout falls back to the leg\'s OWN EURC floor (payout-floor honesty, right units)', async () => {
    const ready = await eurcSwappingRecord();
    jest.mocked(submitRawSolTx).mockResolvedValue(ready.solanaLeg!.signature);
    jest.mocked(getSolSignatureStatus).mockResolvedValue({err: null, confirmationStatus: 'confirmed'} as never);
    jest.mocked(getSolTokenCredit).mockResolvedValue(null);
    const out = await executeCrossRailSolSwap(ready, deps, {submitAttempts: 1, confirmAttempts: 1, pollIntervalMs: 0});
    expect(out.step).toBe('done');
    expect(out.outAmountNet).toBe(EURC_FLOOR);
    expect(out.failureDetail).toBe('payout-floor');
  });
});

// =================================================================================================
// The GAS-FUND widening (2026-09-20, founder-approved): when a route's burn legs need ckETH
// the wallet does not have, the intent PREPENDS ordinary device-signed approve+swap legs
// funding the user's OWN in-wallet ckETH. Pinned here: the route-resolution matrix (1-hop
// direct vs 2-hop hub, largest-net pick, unquotable fallback, the same-asset squeeze rule
// that NEVER shrinks the main amount), the chained-floor sizing (leg i+1 quoted on leg i's
// minOut, final floor ≥ feeWei+20%), the double-gas guard at prepare, the frozen record
// block, hydration compat (legacy byte-identical, malformed shapes dropped), and the
// executor's post-pre-leg re-check (actual balance before approve_gas — short terminates
// failed_leg/gas_short with nothing further submitted).
// =================================================================================================

describe('the gas-fund widening — resolution, prepare, hydration, execution', () => {
  const NEEDED = 93600000000000n; // gasFundNeededWei('78000000000000') = fee × 1.2
  const LED = (n: number): string => BUNDLED.find(c => c.currency === n)!.ledger!;
  const MINTER = BUNDLED.find(c => c.currency === 2)!.minter!;
  const ANGXA_POOL = 'angxa-baaaa-aaaag-qcvnq-cai'; // icpswap-cketh (ICP ↔ ckETH)
  const ICPSWAP_POOL = '65mrh-fqaaa-aaaar-qapoa-cai'; // icpswap (VCHF ↔ ICP)
  const AKBTC_POOL = 'akhru-myaaa-aaaag-qcvna-cai'; // icpswap-ckbtc-cketh (ckBTC ↔ ckETH)
  const ROUTE = () => multihopRoutesFrom(BUNDLED, 8)[1]; // :cctp — ICP → ckUSDC → USDC@Sol

  beforeEach(() => {
    // The real floor arithmetic (1% slippage at the record's 100 bps) — the file default
    // (a constant MIN_OUT) cannot express a CHAIN that shrinks per leg.
    jest.mocked(DpayCore.icpSwapMinOut).mockImplementation(async (gross: unknown, bps: unknown) =>
      ((BigInt(gross as string) * BigInt(10000 - (bps as number))) / 10000n).toString() as never);
    jest.mocked(DpayCore.icpDecodeApproveResult).mockResolvedValue({ok: true} as never);
  });

  const CUR_OF_LEDGER: Record<string, number> = Object.fromEntries(
    BUNDLED.filter(c => c.ledger != null).map(c => [c.ledger!, c.currency]),
  );
  const PAIR_META: Record<string, {venueId: string; pool: string}> = {
    '8>6': {venueId: 'icpswap-cketh', pool: ANGXA_POOL}, '6>8': {venueId: 'icpswap-cketh', pool: ANGXA_POOL},
    '7>8': {venueId: 'icpswap', pool: ICPSWAP_POOL}, '8>7': {venueId: 'icpswap', pool: ICPSWAP_POOL},
    '1>6': {venueId: 'icpswap-ckbtc-cketh', pool: AKBTC_POOL}, '6>1': {venueId: 'icpswap-ckbtc-cketh', pool: AKBTC_POOL},
    '8>2': {venueId: 'icpswap-ckusdc', pool: POOL}, '2>8': {venueId: 'icpswap-ckusdc', pool: POOL},
  };
  /** The relay's swap_quote stand-in: deterministic linear rates by currency pair; a pair
   *  with no rate answers 422 (unquotable — the resolver must skip that route). */
  function mockSwapQuotes(rates: Record<string, bigint>): string[] {
    const amounts: string[] = [];
    jest.mocked(relayFetch).mockImplementation(async (_u: unknown, rawPath: unknown) => {
      const u = new URL('http://x' + String(rawPath));
      if (u.pathname !== '/api/v1/swap_quote') return rowsRes([]) as never;
      const tin = u.searchParams.get('token_in') ?? '';
      const tout = u.searchParams.get('token_out') ?? '';
      const amountIn = u.searchParams.get('amount_in') ?? '0';
      amounts.push(amountIn);
      const key = `${CUR_OF_LEDGER[tin]}>${CUR_OF_LEDGER[tout]}`;
      const meta = PAIR_META[key];
      const rate = rates[key];
      if (meta == null || rate == null) return fakeRes({}, false, 422) as never;
      return fakeRes({
        venue_id: meta.venueId, pool: meta.pool, token_in: tin, token_out: tout,
        amount_in: amountIn, amount_out: (BigInt(amountIn) * rate).toString(),
        zero_for_one: true, fee_millionths: 3000, fetched_at: Math.floor(Date.now() / 1000),
      }) as never;
    });
    return amounts;
  }

  async function plannedGasRecord(balances: Record<number, string>, have: string | null): Promise<ConvertRecord> {
    jest.mocked(railBalanceOf).mockResolvedValueOnce(have as never);
    return prepareMultihopConvertRecord({
      secretHex: SECRET, quote: hopQuote(), math: hopMath(), route: ROUTE(), destAddress: DEST,
      gasFund: {relayUrl: 'http://relay', balances},
    });
  }

  async function execGas(rec: ConvertRecord, have: string | null): Promise<ConvertRecord> {
    jest.mocked(railBalanceOf).mockResolvedValue(have as never);
    jest.mocked(relayFetch).mockResolvedValue(rowsRes([
      {currency: 2, from: POOL, to: myPrincipal, amount: '190000000', block: '7', timestamp: NOW()},
    ]) as never);
    const submittedCanisters: string[] = [];
    jest.mocked(submitTransfer).mockImplementation(async (
      prepared: unknown, _s: unknown, _o: unknown, decodeReply?: (h: string) => Promise<unknown>,
    ) => {
      submittedCanisters.push(String((prepared as {ledger?: string}).ledger));
      if (decodeReply != null) await decodeReply('reply-hex');
      return {kind: 'settled', blockIndex: '1'} as never;
    });
    const out = await executeConvert(rec, {
      secretHex: SECRET, publicHex: 'aabb', relayUrl: 'http://relay', onUpdate: () => {},
    }, OPTS);
    (out as ConvertRecord & {submittedCanisters?: string[]}).submittedCanisters = submittedCanisters;
    return out;
  }

  test('resolution — 2-hop hub route with chained floors: leg2 quoted on leg1 minOut, final floor covers fee+20%', async () => {
    mockSwapQuotes({'7>8': 4n, '8>6': 320000n});
    const plan = await resolveGasFundPlan({
      secretHex: SECRET, relayUrl: 'http://relay', route: ROUTE(),
      balances: {7: '1000000000'}, mainAmountIn: hopMath().amountIn, slippageBps: 100,
    });
    expect(plan).not.toBeNull();
    expect(plan!.neededWei).toBe(NEEDED.toString());
    expect(plan!.legs).toHaveLength(2);
    expect(plan!.legs[0]!.venueId).toBe('icpswap');
    expect(plan!.legs[0]!.fromLedger).toBe(LED(7));
    expect(plan!.legs[1]!.venueId).toBe('icpswap-cketh');
    expect(plan!.legs[1]!.inAmount).toBe(plan!.legs[0]!.minOut); // the compounding floor
    expect(plan!.legs[1]!.toLedger).toBe(LED(6));
    expect(BigInt(plan!.legs[1]!.minOut)).toBeGreaterThanOrEqual(NEEDED);
    expect(BigInt(plan!.legs[0]!.inAmount)).toBeLessThanOrEqual(1000000000n);
  });

  test('resolution — largest-NET wins: a bigger direct floor beats the hub; unquotable direct falls back', async () => {
    mockSwapQuotes({'7>8': 4n, '8>6': 320000n, '1>6': 400000n});
    const best = await resolveGasFundPlan({
      secretHex: SECRET, relayUrl: 'http://relay', route: ROUTE(),
      balances: {1: '10000000000', 7: '1000000000'}, mainAmountIn: hopMath().amountIn, slippageBps: 100,
    });
    expect(best!.legs).toHaveLength(1); // ckBTC direct: ~3.96e15 floor > the VCHF hub's ~1.25e15
    expect(best!.legs[0]!.venueId).toBe('icpswap-ckbtc-cketh');

    delete PAIR_META['1>6']; // ckBTC→ckETH unquotable → the hub route must take over
    const fallback = await resolveGasFundPlan({
      secretHex: SECRET, relayUrl: 'http://relay', route: ROUTE(),
      balances: {1: '10000000000', 7: '1000000000'}, mainAmountIn: hopMath().amountIn, slippageBps: 100,
    });
    PAIR_META['1>6'] = {venueId: 'icpswap-ckbtc-cketh', pool: AKBTC_POOL};
    expect(fallback!.legs).toHaveLength(2);
    expect(fallback!.legs[0]!.venueId).toBe('icpswap');
  });

  test('resolution — the same-asset squeeze: a barely-covering main source is NEVER drawn down; nothing shrinks the main amount', async () => {
    // 1.01 ICP vs a 1 ICP main intent: it covers main + fees, so the coarse gate passes,
    // but the leftover budget (~7.98e5 raw) cannot POSSIBLY reach 9.36e13 wei of ckETH —
    // the route must die, not shrink the main amount. Every quote the resolver fires stays
    // at the leftover scale, never near the main amount.
    const amounts = mockSwapQuotes({'8>6': 320000n});
    const plan = await resolveGasFundPlan({
      secretHex: SECRET, relayUrl: 'http://relay', route: ROUTE(),
      balances: {8: '101000000'}, mainAmountIn: hopMath().amountIn, slippageBps: 100,
    });
    expect(plan).toBeNull();
    expect(amounts.length).toBeGreaterThan(0);
    for (const a of amounts) expect(BigInt(a)).toBeLessThanOrEqual(6000000n);

    // 300 ICP covers everything → the shared source funds the gas over the DIRECT venue.
    const ok = await resolveGasFundPlan({
      secretHex: SECRET, relayUrl: 'http://relay', route: ROUTE(),
      balances: {8: '30000000000'}, mainAmountIn: hopMath().amountIn, slippageBps: 100,
    });
    expect(ok).not.toBeNull();
    expect(ok!.legs).toHaveLength(1);
    expect(ok!.legs[0]!.venueId).toBe('icpswap-cketh');
    expect(ok!.legs[0]!.fromLedger).toBe(LED(8));
    expect(BigInt(ok!.legs[0]!.minOut)).toBeGreaterThanOrEqual(NEEDED);
  });

  test('prepare — the record freezes the gasPre block, prepends approve+swap pairs, and keeps the plan rhythm', async () => {
    mockSwapQuotes({'8>6': 320000n});
    const rec = await plannedGasRecord({8: '30000000000'}, '1000000000'); // 1e9 wei < needed → fund
    expect(rec.legPlan!.map(p => p.kind)).toEqual([
      'approve', 'swap', // the funding pair, FIRST
      'approve', 'swap', 'approve', 'approve_gas', 'withdraw_erc20', 'cctp_burn',
    ]);
    expect(rec.legs).toHaveLength(7); // 2 funding legs + the route's own five
    expect(rec.legs[0]).toMatchObject({canister: LED(8), method: 'icrc2_approve'});
    expect(rec.legs[1]).toMatchObject({canister: ANGXA_POOL, method: 'depositFromAndSwap'});
    // The frozen block carries EXACTLY the six contract fields — the signer-side extras
    // (zeroForOne, per-leg fees) live only in memory, never serialized.
    expect(rec.gasPre!.neededWei).toBe(NEEDED.toString());
    expect(rec.gasPre!.legs[0]).toEqual({
      venueId: 'icpswap-cketh', pool: ANGXA_POOL, fromLedger: LED(8), toLedger: LED(6),
      inAmount: rec.gasPre!.legs[0]!.inAmount, minOut: rec.gasPre!.legs[0]!.minOut,
    });
    expect(BigInt(rec.gasPre!.legs[0]!.minOut)).toBeGreaterThanOrEqual(NEEDED);
    expect(BigInt(rec.gasPre!.legs[0]!.inAmount)).toBeLessThanOrEqual(30000000000n - 20000n);
    // The pre-swap arg: (inAmount, minOut, fromFee, toFee, live direction) — the direct
    // flow's exact builder, real catalog fees.
    const swapCall = jest.mocked(DpayCore.icpDepositAndSwapArg).mock.calls[0]!;
    expect(swapCall[0]).toBe(rec.gasPre!.legs[0]!.inAmount);
    expect(swapCall[1]).toBe(rec.gasPre!.legs[0]!.minOut);
    expect(swapCall[2]).toBe(BUNDLED.find(c => c.currency === 8)!.fee!);
    expect(swapCall[3]).toBe(BUNDLED.find(c => c.currency === 6)!.fee!);
    expect(swapCall[4]).toBe(true);
  });

  test('prepare — the DOUBLE-GAS guard: an already-funded wallet (or an unreadable one) yields a byte-compatible unfunded record', async () => {
    mockSwapQuotes({'8>6': 320000n});
    const atTarget = await plannedGasRecord({8: '30000000000'}, NEEDED.toString()); // exactly the target
    expect(atTarget.gasPre).toBeUndefined();
    expect(atTarget.legPlan).toHaveLength(6);
    const unreadable = await plannedGasRecord({8: '30000000000'}, null);
    expect(unreadable.gasPre).toBeUndefined();
    expect(unreadable.legPlan).toHaveLength(6);
  });

  test('prepare — gas funding requested but unresolvable THROWS: nothing signed, no gas-less record', async () => {
    mockSwapQuotes({'8>6': 320000n});
    await expect(plannedGasRecord({8: '101000000'}, '1000000000')).rejects.toThrow();
    expect(jest.mocked(DpayCore.icpSignUpdate).mock.calls.length).toBe(0);
  });

  test('hydration — the gasPre block round-trips; malformed shapes drop; legacy stays byte-identical', async () => {
    mockSwapQuotes({'8>6': 320000n});
    const rec = await plannedGasRecord({8: '30000000000'}, '1000000000');
    const raw = JSON.parse(JSON.stringify(rec));
    const ok = hydrateConvertStore({[rec.id]: raw})[rec.id]!;
    expect(ok.gasPre).toEqual(rec.gasPre);
    expect(ok.legPlan!.map(p => p.kind)).toEqual(rec.legPlan!.map(p => p.kind));

    const drop = (mutate: (r: ConvertRecord) => void): unknown => {
      const bad = JSON.parse(JSON.stringify(rec));
      mutate(bad);
      return hydrateConvertStore({[rec.id]: bad});
    };
    expect(drop(r => { r.gasPre!.legs[0].pool = ''; })).toEqual({}); // an empty fact
    expect(drop(r => { r.gasPre!.legs[0].inAmount = '12x'; })).toEqual({}); // not a digit string
    expect(drop(r => { r.legs = r.legs.slice(0, 5); })).toEqual({}); // rhythm: 5 ≠ 1×2+5
    expect(drop(r => { r.legPlan![1].kind = 'approve'; })).toEqual({}); // the pair rhythm
    expect(drop(r => { delete r.legPlan; })).toEqual({}); // gasPre rides a PLANNED record only

    // The LEDGER CHAIN needs two legs to break: the hub-funded record (VCHF → ICP → ckETH).
    mockSwapQuotes({'7>8': 4n, '8>6': 320000n});
    const hub = await plannedGasRecord({7: '1000000000'}, '1000000000');
    expect(hub.gasPre!.legs).toHaveLength(2);
    const hubOk = hydrateConvertStore({[hub.id]: JSON.parse(JSON.stringify(hub))})[hub.id]!;
    expect(hubOk.gasPre).toEqual(hub.gasPre);
    const broken = JSON.parse(JSON.stringify(hub));
    broken.gasPre.legs[0].toLedger = LED(2); // ≠ legs[1].fromLedger — a chain this build never signed
    expect(hydrateConvertStore({[hub.id]: broken})).toEqual({});

    const short = JSON.parse(JSON.stringify(rec));
    short.failureCode = 'gas_short';
    expect(hydrateConvertStore({[rec.id]: short})[rec.id]!.failureCode).toBe('gas_short');

    const legacy = JSON.parse(JSON.stringify(await plannedCrossRecord()));
    expect(hydrateConvertStore({[legacy.id]: legacy})[legacy.id]!.gasPre).toBeUndefined();
  });

  test('execution — funding legs confirm, the re-check passes, and the route runs to awaiting_external', async () => {
    mockSwapQuotes({'8>6': 320000n});
    const rec = await plannedGasRecord({8: '30000000000'}, '1000000000');
    const out = await execGas(rec, '100000000000000'); // 1e14 ≥ 9.36e13 → the burn legs may run
    expect(out.step).toBe('awaiting_external');
    expect(out.legPlan!.slice(0, 6).every(p => p.state === 'confirmed')).toBe(true);
    expect(out.legPlan![7].state).toBe('pending'); // the external burn still waits on the user
    const cans = (out as ConvertRecord & {submittedCanisters?: string[]}).submittedCanisters ?? [];
    expect(cans).toEqual([LED(8), ANGXA_POOL, LED(8), POOL, LED(2), LED(6), MINTER]);
  });

  test('execution — the re-check SHORT: terminal gas_short naming the shortfall, nothing further submitted', async () => {
    mockSwapQuotes({'8>6': 320000n});
    const rec = await plannedGasRecord({8: '30000000000'}, '1000000000');
    const out = await execGas(rec, '93000000000000'); // 9.3e13 < 9.36e13
    expect(out.step).toBe('failed_leg');
    expect(out.failureCode).toBe('gas_short');
    expect(out.failureDetail).toContain('have 93000000000000');
    expect(out.failureDetail).toContain('93600000000000');
    const cans = (out as ConvertRecord & {submittedCanisters?: string[]}).submittedCanisters ?? [];
    // The funding legs ran; the main swap + hop approve ran; the BURN triple never did.
    expect(cans).toEqual([LED(8), ANGXA_POOL, LED(8), POOL, LED(2)]);
    expect(out.legPlan![5].state).toBe('pending');
    expect(out.outTx).toBeUndefined();
  });

  test('execution — an UNREADABLE balance is not a pass: the burn legs are held and the record stays live', async () => {
    mockSwapQuotes({'8>6': 320000n});
    const rec = await plannedGasRecord({8: '30000000000'}, '1000000000');
    const out = await execGas(rec, null);
    expect(out.step).toBe('approving'); // non-terminal — the engine re-arms and re-checks
    expect(out.legPlan![5].state).toBe('pending'); // the approve_gas was never submitted
    expect(out.legPlan![6].state).toBe('pending'); // and nothing after it either
  });

  test('execution — a refused FUNDING swap terminates gas_short before the main flow starts', async () => {
    mockSwapQuotes({'8>6': 320000n});
    const rec = await plannedGasRecord({8: '30000000000'}, '1000000000');
    jest.mocked(railBalanceOf).mockResolvedValue('100000000000000');
    jest.mocked(relayFetch).mockResolvedValue(rowsRes([]) as never);
    jest.mocked(submitTransfer).mockImplementation(async (prepared: unknown) =>
      ((prepared as {ledger: string}).ledger === ANGXA_POOL
        ? {kind: 'rejected' as const, variant: 'refunded', reason: 'slippage: min out not met'}
        : {kind: 'settled' as const, blockIndex: '1'}) as never);
    const out = await executeConvert(rec, {
      secretHex: SECRET, publicHex: 'aabb', relayUrl: 'http://relay', onUpdate: () => {},
    }, OPTS);
    expect(out.step).toBe('failed_leg');
    expect(out.failureCode).toBe('gas_short');
    expect(out.failureDetail).toBe('slippage: min out not met');
    expect(out.legPlan![1].state).toBe('failed');
    expect(out.legPlan![2].state).toBe('pending'); // the main flow never started
  });

  test('fetchEthBalance — the external wallet read: hex-wei decoded, unreachable → null, malformed → null', async () => {
    fetchMock.mockResolvedValue(fakeRes({jsonrpc: '2.0', id: 1, result: '0x1bc16d674ec80000'}));
    await expect(fetchEthBalance(DEST)).resolves.toBe('2000000000000000000');
    fetchMock.mockResolvedValue(fakeRes({jsonrpc: '2.0', id: 1, result: '0x0'}));
    await expect(fetchEthBalance(DEST)).resolves.toBe('0');
    fetchMock.mockResolvedValue(fakeRes({}, false, 503));
    await expect(fetchEthBalance(DEST)).resolves.toBeNull();
    fetchMock.mockResolvedValue(fakeRes({result: 'not-hex'}));
    await expect(fetchEthBalance(DEST)).resolves.toBeNull();
    fetchMock.mockClear();
    await expect(fetchEthBalance('not-an-address')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled(); // malformed input never dials
  });
});
