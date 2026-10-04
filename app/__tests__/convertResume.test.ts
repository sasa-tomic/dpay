/**
 * app/convertResume.ts — the V6 record-advancement engine and its two drivers.
 *
 * The provider driver (advanceProviderRecord + fetchProviderStatus) is pinned here with unit
 * fakes (mock fetch) because NO CeFi venue is registered yet — these tests ARE the venue-kind
 * contract the first CeFi adapter must serve: https-only statusUrl, honest transitions, no
 * fabricated outcomes (a transport failure or an unmappable status word advances NOTHING).
 *
 * The engine is pinned as a scheduler: it drives every live record from start, forwards the
 * cross-record payout dedupe (claimedOutTx) to the executor, re-arms bounded watches at the
 * configured cadence, slow-probes an unacknowledged stuck record and stops when the user
 * acknowledges it, and never drives a terminal record.
 *
 * '../convert' is mocked: this suite is about WHO drives WHEN, never about the state machine
 * itself (convert.test.ts pins that).
 */
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';

const MOCK_ABORT_FLAGS = new Set<string>();
jest.mock('../convert', () => ({
  executeConvert: jest.fn(),
  probeConvertSettlement: jest.fn(),
  probeHopPayout: jest.fn(async () => null),
  loadConvertRecords: jest.fn(async () => ({})),
  saveConvertRecord: jest.fn(async () => undefined),
  isTerminalConvertStep: (step: string) =>
    ['done', 'failed_refunded', 'failed_leg', 'stuck', 'quote_expired', 'provider_refunded', 'aborted'].includes(step),
  requestConvertAbort: jest.fn((id: string) => { MOCK_ABORT_FLAGS.add(id); }),
  convertAborted: (id: string) => MOCK_ABORT_FLAGS.has(id),
  isHubConvertRecord: jest.fn(() => false),
  isComposedConvertRecord: (rec: {composedDeposit?: unknown} | null) => rec?.composedDeposit != null,
  isChainConvertRecord: (rec: {chainRoute?: unknown} | null) => rec?.chainRoute != null,
  crossRailHopDelivered: jest.fn(async () => false),
  prepareCrossRailSolLeg: jest.fn(),
  attachCctpBurnTx: jest.fn(),
  declineCctpHandoff: jest.fn(),
  executeSolanaConvert: jest.fn(),
  executeCrossRailConvert: jest.fn(),
  executeCrossRailSolSwap: jest.fn(),
}));

jest.mock('../services/native', () => ({
  DpayCore: {icpPrincipalFromPubkey: jest.fn()},
}));

jest.mock('../services/relay', () => ({
  fetchWithTimeout: jest.fn(),
}));

jest.mock('../services/rail', () => ({
  railBalanceOf: jest.fn(async () => null),
}));

import {
  prepareCrossRailSolLeg,
  requestConvertAbort,
  executeConvert,
  executeCrossRailConvert,
  executeCrossRailSolSwap,
  executeSolanaConvert,
  loadConvertRecords,
  probeConvertSettlement,
  probeHopPayout,
  crossRailHopDelivered,
  saveConvertRecord,
} from '../convert';
import {DpayCore} from '../services/native';
import {fetchWithTimeout} from '../services/relay';
import {railBalanceOf} from '../services/rail';
import {providerRateLimitedUntilMs} from '../convert/providerStatus';
import {noteStuckProbeDone, stuckLastCheckedAtMs} from '../convert/stuckProbeLog';
import {
  __resetConvertResumeEngineForTest,
  abortConvertRecord,
  acknowledgeStuckRecord,
  advanceProviderRecord,
  confirmCrossRailSolLeg,
  convertResumeSnapshot,
  fetchProviderStatus,
  markConvertDepositSent,
  providerLastCheckedAtMs,
  startConvertResumeEngine,
  subscribeConvertRecords,
} from '../convertResume';
import type {ConvertRecord} from '../convert';

const POOL = '65mrh-fqaaa-aaaaar-qapoa-cai';
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';

const legRecord = (over: Partial<ConvertRecord> = {}): ConvertRecord => ({
  id: 'leg-1',
  createdAtMs: 1,
  step: 'swapping',
  venueId: 'icpswap',
  inCurrency: 8,
  outCurrency: 7,
  inLedger: ICP_LEDGER,
  outLedger: VCHF_LEDGER,
  inSymbol: 'ICP',
  outSymbol: 'CHF',
  amountIn: '100000000',
  expectedGross: '190000000',
  expectedNet: '189990000',
  inFee: '10000',
  outFee: '10000',
  slippageBps: 100,
  legs: [
    {canister: ICP_LEDGER, method: 'icrc2_approve', argHex: 'a', envelopeHex: 'aa', requestIdHex: 'r1', expiresAtMs: Date.now() + 600_000},
    {canister: POOL, method: 'depositFromAndSwap', argHex: 'b', envelopeHex: 'bb', requestIdHex: 'r2', expiresAtMs: Date.now() + 600_000},
  ],
  ...over,
});

const providerRecord = (over: Partial<ConvertRecord> = {}): ConvertRecord => ({
  ...legRecord(),
  id: 'cef-1',
  step: 'awaiting_deposit',
  legs: [],
  providerRef: {orderId: 'ocp-7', statusUrl: 'https://provider.example/o/ocp-7'},
  ...over,
});

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const res = (body: unknown, ok = true) => ({ok, status: 200, json: async () => body});
const CTX = {secretHex: 'sec', publicHex: 'pub', relayUrl: 'http://r'};
const FAST = {rearmMs: 5, stuckWatchMs: 5, providerPollMs: 5, executorOpts: {submitAttempts: 1, poll: {attempts: 1, intervalMs: 0}, settleAttempts: 1, settleIntervalMs: 0}};

beforeEach(() => {
  jest.clearAllMocks();
  MOCK_ABORT_FLAGS.clear();
  jest.mocked(loadConvertRecords).mockResolvedValue({});
  jest.mocked(executeConvert).mockImplementation(async (rec: ConvertRecord) => rec);
  jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue('principal' as never);
  jest.mocked(probeConvertSettlement).mockResolvedValue(null as never);
  jest.mocked(probeHopPayout).mockResolvedValue(null as never);
});

afterEach(async () => {
  __resetConvertResumeEngineForTest();
});

// --- the provider status read: https-only, honest vocabulary --------------------------------------
describe('fetchProviderStatus — the provider status read', () => {
  test('maps the measured spellings; the reading carries the provider\'s own amount/tx', async () => {
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'Completed', settled_amount: '189990000', tx_id: 'p-77'}) as never);
    const reading = await fetchProviderStatus({orderId: 'o', statusUrl: 'https://p.example/s/o'});
    expect(reading).toEqual({kind: 'completed', amount: '189990000', tx: 'p-77'});
    expect(jest.mocked(fetchWithTimeout)).toHaveBeenCalledWith('https://p.example/s/o', undefined, expect.any(Number));
  });
  test('a NON-https statusUrl is refused before any network: unreachable, never fetched', async () => {
    const reading = await fetchProviderStatus({orderId: 'o', statusUrl: 'http://nefarious.example/s'});
    expect(reading.kind).toBe('unreachable');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
  test('transport failure, non-2xx, or an unreadable body is unreachable — no fabricated outcome', async () => {
    jest.mocked(fetchWithTimeout).mockRejectedValueOnce(new Error('net down') as never);
    expect((await fetchProviderStatus({orderId: 'o', statusUrl: 'https://p.example/s'})).kind).toBe('unreachable');
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'processing'}, false) as never);
    expect((await fetchProviderStatus({orderId: 'o', statusUrl: 'https://p.example/s'})).kind).toBe('unreachable');
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce({ok: true, status: 200, json: async () => {throw new Error('bad body');}} as never);
    expect((await fetchProviderStatus({orderId: 'o', statusUrl: 'https://p.example/s'})).kind).toBe('unreachable');
    // a status that is not a string is not a status
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 3}) as never);
    expect((await fetchProviderStatus({orderId: 'o', statusUrl: 'https://p.example/s'})).kind).toBe('unreachable');
  });
  test('an unmappable status word is unknown — present, honest, and NOT a transition', async () => {
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'frobnicating'}) as never);
    const reading = await fetchProviderStatus({orderId: 'o', statusUrl: 'https://p.example/s'});
    expect(reading.kind).toBe('unknown');
  });
  test('the SideShift vocabulary (2026-09-15, first cefi adapter) maps whole', async () => {
    // SideShift's own status words, verified from their live shift examples: waiting (fresh
    // shift), multiple (multi-deposit: first settles, later ones refunded — still in flight),
    // settled (terminal success), refund (refund in progress), refunded (terminal), expired.
    const cases: Array<[string, string]> = [
      ['waiting', 'awaiting_deposit'],
      ['multiple', 'processing'],
      ['settled', 'completed'],
      ['refund', 'refunded'],
      ['refunded', 'refunded'],
      ['expired', 'expired'],
    ];
    for (const [word, kind] of cases) {
      jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: word}) as never);
      const reading = await fetchProviderStatus({orderId: 'o', statusUrl: 'https://sideshift.ai/api/v2/shifts/x'});
      expect(reading.kind).toBe(kind);
    }
  });
  test('SideShift\'s camelCase settleAmount/settleHash carry the provider\'s own amount and tx', async () => {
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(
      res({status: 'settled', settleAmount: '0.0495', settleHash: '5XxSolSig9'}) as never,
    );
    const reading = await fetchProviderStatus({orderId: 'o', statusUrl: 'https://sideshift.ai/api/v2/shifts/x'});
    expect(reading).toEqual({kind: 'completed', amount: '0.0495', tx: '5XxSolSig9'});
  });
  test('no statusUrl → unreachable (nothing to poll is not a claim of anything)', async () => {
    const reading = await fetchProviderStatus({orderId: 'o'});
    expect(reading.kind).toBe('unreachable');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
  test('HTTP 429 is rate_limited — never an error, and the Retry-After hint rides the reading', async () => {
    // The relay's upstream limiter doing its job (partner agreement 2026-09-22): the app
    // waits, it does not surface an error and it does not re-poll into the 429.
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce({
      ok: false, status: 429, json: async () => null,
      headers: {get: (n: string) => (n.toLowerCase() === 'retry-after' ? '1' : null)},
    } as never);
    const reading = await fetchProviderStatus({orderId: 'o', statusUrl: 'https://p.example/s/o'});
    expect(reading).toEqual({kind: 'rate_limited', retryAfterMs: 1000});
    // no header → no hint (the normal cadence governs)
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce({
      ok: false, status: 429, json: async () => null,
      headers: {get: () => null},
    } as never);
    expect(await fetchProviderStatus({orderId: 'o', statusUrl: 'https://p.example/s/o'}))
      .toEqual({kind: 'rate_limited', retryAfterMs: null});
  });
});

// --- the provider driver: one honest transition matrix, never backwards ----------------------------
describe('advanceProviderRecord — the providerRef driver', () => {
  // The driver persists through the ENGINE's identity scope, so a unit drive needs the engine
  // context armed (empty store: nothing else is driven).
  let stopEngine: () => void = () => {};
  beforeEach(() => {
    stopEngine = startConvertResumeEngine(CTX, FAST);
  });
  afterEach(() => {
    stopEngine();
  });

  test('awaiting_deposit + deposit seen → provider_processing (persisted)', async () => {
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'deposit_received'}) as never);
    const next = await advanceProviderRecord(providerRecord());
    expect(next.step).toBe('provider_processing');
    expect(saveConvertRecord).toHaveBeenCalledWith('pub', expect.objectContaining({step: 'provider_processing'}));
  });
  test('provider_processing + completed → done with the provider\'s own amount and tx', async () => {
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'completed', amount_out: '189990000', transaction_id: 'p-9'}) as never);
    const next = await advanceProviderRecord(providerRecord({step: 'provider_processing'}));
    expect(next.step).toBe('done');
    expect(next.outAmountNet).toBe('189990000');
    expect(next.outTx).toBe('p-9');
  });
  test('completed WITHOUT an amount settles at the record\'s expected net — the quote bounds it', async () => {
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'completed'}) as never);
    const next = await advanceProviderRecord(providerRecord({step: 'provider_processing'}));
    expect(next.step).toBe('done');
    expect(next.outAmountNet).toBe('189990000'); // expectedNet — attributed, never invented
    expect(next.outTx).toBeUndefined();
  });
  test('the cefi handoff normalizes a DECIMAL settleAmount into raw units (SideShift, 2026-09-15)', async () => {
    // SideShift speaks "settleAmount": "0.0495" — SOL in its own units. outAmountNet is raw
    // units like every other record money field, so the boundary converts: 0.0495 SOL at
    // 9 decimals = 49500000 raw. Scoped to the cefi handoff shape (providerDeposit present)
    // so the legacy provider records change behavior by exactly nothing.
    const rec = providerRecord({
      step: 'provider_processing',
      outSymbol: 'SOL',
      outDecimals: 9,
      expectedNet: '48000000',
      providerDeposit: {depositAddress: 'e2e-deposit-address-01', depositAmount: '2'},
    });
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(
      res({status: 'settled', settleAmount: '0.0495', settleHash: '5XxSolSig9'}) as never,
    );
    const next = await advanceProviderRecord(rec);
    expect(next.step).toBe('done');
    expect(next.outAmountNet).toBe('49500000'); // toUnits('0.0495', 9) — converted, never echoed
    expect(next.outTx).toBe('5XxSolSig9');
    // The legacy shape (no providerDeposit) still carries the provider string untouched —
    // OCP-style records are raw-unit speakers by construction.
    const legacy = providerRecord({step: 'provider_processing'});
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'completed', amount_out: '189990000'}) as never);
    expect((await advanceProviderRecord(legacy)).outAmountNet).toBe('189990000');
  });
  test('quote_expired is the PROVIDER\'s verdict (expired before the deposit) — never leg expiry', async () => {
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'expired'}) as never);
    const next = await advanceProviderRecord(providerRecord());
    expect(next.step).toBe('quote_expired');
  });
  test('refunded → provider_refunded, from either held state', async () => {
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'refunded'}) as never);
    expect((await advanceProviderRecord(providerRecord({step: 'provider_processing'}))).step).toBe('provider_refunded');
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'refunded'}) as never);
    expect((await advanceProviderRecord(providerRecord())).step).toBe('provider_refunded');
  });
  test('unreachable/unknown/unmapped advance NOTHING — the record stays where it is', async () => {
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'processing'}) as never);
    expect((await advanceProviderRecord(providerRecord())).step).toBe('provider_processing');
    jest.mocked(fetchWithTimeout).mockRejectedValueOnce(new Error('down') as never);
    expect((await advanceProviderRecord(providerRecord({step: 'provider_processing'}))).step).toBe('provider_processing');
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'frobnicating'}) as never);
    expect((await advanceProviderRecord(providerRecord({step: 'provider_processing'}))).step).toBe('provider_processing');
  });
  test('never backwards: a held record ignores a still-awaiting status', async () => {
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'waiting_for_deposit'}) as never);
    const next = await advanceProviderRecord(providerRecord({step: 'provider_processing'}));
    expect(next.step).toBe('provider_processing'); // the deposit cannot un-arrive
  });
  test('a leg-based record is not the provider driver\'s to touch', async () => {
    const rec = legRecord();
    const next = await advanceProviderRecord(rec);
    expect(next).toBe(rec); // untouched, byte-for-byte the same object
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
  test('completed is TERMINAL from awaiting_deposit too — the first observed terminal word lands (term 4)', async () => {
    // Webhook-first status: the relay-side state can already be settled the first time the
    // fallback poll looks. The record must LAND (done) and never poll the trade again — the
    // old shape (awaiting_deposit ignores completed) polled a settled trade forever.
    const rec = providerRecord({
      outSymbol: 'SOL',
      outDecimals: 9,
      providerDeposit: {depositAddress: 'e2e-deposit-address-01', depositAmount: '2'},
    });
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(
      res({status: 'Completed', amount_to: '0.0496', details: {hashout: 'h-out-1'}}) as never,
    );
    const next = await advanceProviderRecord(rec);
    expect(next.step).toBe('done');
    expect(next.outAmountNet).toBe('49600000'); // toUnits('0.0496', 9) — the venue's own figure
    expect(next.outTx).toBe('h-out-1');
  });
  test('the late-deposit watch (2026-09-24): from quote_expired the venue\'s later words stay true', async () => {
    // expired-from-awaiting_deposit lands the record at quote_expired, but a LATE deposit
    // can still land at the venue and be refunded (or even honored) — only the venue knows,
    // so the venue's OWN later words must stay able to move the record. Never backwards: a
    // repeated 'expired' or an awaiting status resurrects nothing.
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'refunded'}) as never);
    expect((await advanceProviderRecord(providerRecord({step: 'quote_expired'}))).step).toBe('provider_refunded');
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'deposit_received'}) as never);
    expect((await advanceProviderRecord(providerRecord({step: 'quote_expired'}))).step).toBe('provider_processing');
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'Completed', amount_out: '189990000'}) as never);
    expect((await advanceProviderRecord(providerRecord({step: 'quote_expired'}))).step).toBe('done');
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'expired'}) as never);
    expect((await advanceProviderRecord(providerRecord({step: 'quote_expired'}))).step).toBe('quote_expired');
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res({status: 'waiting'}) as never);
    expect((await advanceProviderRecord(providerRecord({step: 'quote_expired'}))).step).toBe('quote_expired');
  });
  test('a 429 advances NOTHING and registers the Retry-After backoff for the engine', async () => {
    expect(providerRateLimitedUntilMs('cef-1')).toBeNull();
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce({
      ok: false, status: 429, json: async () => null,
      headers: {get: (n: string) => (n.toLowerCase() === 'retry-after' ? '1' : null)},
    } as never);
    const next = await advanceProviderRecord(providerRecord());
    expect(next.step).toBe('awaiting_deposit'); // wait-and-retry, not a verdict, not an error
    const until = providerRateLimitedUntilMs('cef-1');
    expect(until).not.toBeNull();
    expect(until!).toBeGreaterThan(Date.now());
    // an absent Retry-After registers nothing — the normal cadence governs the next tick
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce({
      ok: false, status: 429, json: async () => null,
      headers: {get: () => null},
    } as never);
    await advanceProviderRecord(providerRecord({id: 'cef-2'}));
    expect(providerRateLimitedUntilMs('cef-2')).toBeNull();
  });
});

// --- the engine: who drives, when, and with what bounds --------------------------------------------
describe('the engine — every live record driven from wallet load, mounted screen or not', () => {
  test('a PREVIOUS session\'s in-flight drive never silences the restarted engine\'s boot sweep (2026-10-03 P0 remount strand)', async () => {
    // The wallet kill + remount: session 1's driveOne for the record is STILL IN FLIGHT when
    // the wallet unmounts (its provider poll hung) and a fresh session starts. The boot sweep
    // of the new session must DRIVE the record anyway - and complete it on the venue's own
    // verdict. Under a session-global in-flight flag the new session's driveOne early-returned
    // on the GHOST's flag, no timer was ever armed, and the record sat live in the map with no
    // driver at all: the silent strand the flow tier's 214 kill arm caught four generations
    // running (store stuck at awaiting_deposit, the venue never polled once).
    jest.mocked(loadConvertRecords).mockResolvedValue({'cef-1': providerRecord()});
    // Session 1's boot drive: its provider poll NEVER returns (the kill caught it mid-flight;
    // a real drive's awaits are bounded, but the session can die long before they drain).
    jest.mocked(fetchWithTimeout).mockImplementationOnce(() => new Promise<Response>(() => undefined));
    const stop1 = startConvertResumeEngine(CTX, FAST);
    await sleep(20); // the ghost drive is in flight, parked inside its hung poll
    stop1(); // THE KILL: the wallet unmounted; the ghost drive keeps draining in the background
    // THE REMOUNT: a fresh engine for the SAME wallet. The boot sweep must drive the record
    // and the venue's settled verdict must land the record - one poll, one completion.
    jest.mocked(fetchWithTimeout).mockResolvedValue(res({status: 'settled', settleAmount: '0.0495', settleHash: 'sol-1'}) as never);
    const stop2 = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      expect(fetchWithTimeout).toHaveBeenCalledTimes(2); // the restarted engine polled ONCE
      expect(convertResumeSnapshot()['cef-1']?.step).toBe('done');
      expect(jest.mocked(saveConvertRecord)).toHaveBeenCalledWith('pub', expect.objectContaining({id: 'cef-1', step: 'done'}));
    } finally {
      stop2();
    }
  });

  test('a parked pre-burn crossing record is DRIVEN at boot: crossing + device + no hash → the sign flow, not a no-op (the D31 resume gap)', async () => {
    // The device-sign step never completed (the app died mid-trip, 2026-10-03 live finding):
    // the persisted record sits at `crossing` with crossRail.burnTxHash absent. The boot
    // sweep must hand it to the crossing executor — which signs the burn itself for a
    // device-signed record (the executor contract is pinned in convertCrossrail.test.ts:
    // byte-identical re-drive, receipt adoption) — never leave it driverless. The
    // pre-810d1a7c watcher returned early on the missing hash and nothing re-armed the
    // sign drive: this pin is the guard that the engine always re-adopts the record.
    jest.mocked(loadConvertRecords).mockResolvedValue({
      'xr-1': legRecord({
        id: 'xr-1',
        step: 'crossing',
        crossRail: {kind: 'cctp_sol', burnSigner: 'device', solAddress: 'SolAddr1', mintRecipientAta: 'AtaAddr1'},
      }),
    });
    jest.mocked(executeCrossRailConvert).mockImplementation(async (rec: ConvertRecord) => rec);
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(20);
      // Driven means: the crossing executor received THIS record (the sign flow, executor
      // contract pinned in convertCrossrail) — and the drive re-arms while the record stays
      // crossing (the mock never advances it, so >1 drive on the FAST clock is the re-arm
      // working). Zero calls would be the pre-810d1a7c no-op the gap was.
      const calls = jest.mocked(executeCrossRailConvert).mock.calls.filter(c => (c[0] as ConvertRecord).id === 'xr-1');
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]![0]).toMatchObject({id: 'xr-1', step: 'crossing'});
      expect(calls[0]![1]).toMatchObject({secretHex: 'sec', publicHex: 'pub'});
    } finally {
      stop();
    }
  });

  test('start drives EVERY live record: the leg record via executeConvert, the provider record via its statusUrl', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({
      'leg-1': legRecord(),
      'cef-1': providerRecord(),
      'done-1': legRecord({id: 'done-1', step: 'done', outAmountNet: '1', outTx: '2'}),
    });
    // The leg drive LANDS (terminal) — a record that stays live is re-driven at the cadence by
    // design; landing it pins "exactly one drive per completed advancement".
    jest.mocked(executeConvert).mockImplementation(async (rec: ConvertRecord) => ({...rec, step: 'done', outAmountNet: '1', outTx: '9'}));
    jest.mocked(fetchWithTimeout).mockResolvedValue(res({status: 'waiting_for_deposit'}) as never);
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      expect(jest.mocked(executeConvert).mock.calls.filter((c: unknown[]) => (c[0] as ConvertRecord).id === 'leg-1'))
        .toHaveLength(1);
      expect(fetchWithTimeout).toHaveBeenCalledWith('https://provider.example/o/ocp-7', undefined, expect.any(Number));
      // the terminal record was never driven
      expect(jest.mocked(executeConvert).mock.calls.every((c: unknown[]) => (c[0] as ConvertRecord).id !== 'done-1')).toBe(true);
    } finally {
      stop();
    }
  });

  test('the executor receives the CROSS-RECORD payout dedupe: other records\' outTx claims', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({
      'leg-1': legRecord(),
      'done-1': legRecord({id: 'done-1', step: 'done', outAmountNet: '1', outTx: '555'}),
    });
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      const deps = jest.mocked(executeConvert).mock.calls[0]![1] as {claimedOutTx?: ReadonlySet<string>};
      expect(deps.claimedOutTx).toEqual(new Set(['555']));
    } finally {
      stop();
    }
  });

  test('the executor also receives the CROSS-RECORD refund dedupe: other records\' refundTx claims', async () => {
    // The refund-side twin of the test above: a refund row one record already consumed as its
    // failed_refunded evidence is never a second record's refund (one ledger row, one record).
    jest.mocked(loadConvertRecords).mockResolvedValue({
      'leg-1': legRecord(),
      'failed-1': legRecord({id: 'failed-1', step: 'failed_refunded', failureCode: 'refunded', refundTx: '77'}),
    });
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      const deps = jest.mocked(executeConvert).mock.calls[0]![1] as {claimedRefundTx?: ReadonlySet<string>};
      expect(deps.claimedRefundTx).toEqual(new Set(['77']));
    } finally {
      stop();
    }
  });

  test('the stuck watch probe honors BOTH cross-record dedupes (payout rows and refund rows)', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({
      'leg-1': legRecord({step: 'stuck', failureCode: 'unknown'}),
      'done-1': legRecord({id: 'done-1', step: 'done', outAmountNet: '1', outTx: '555'}),
      'failed-1': legRecord({id: 'failed-1', step: 'failed_refunded', failureCode: 'refunded', refundTx: '77'}),
    });
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      const call = jest.mocked(probeConvertSettlement).mock.calls
        .find((c: unknown[]) => (c[0] as {record: ConvertRecord}).record.id === 'leg-1');
      expect(call).toBeDefined();
      expect(call![0]).toEqual(expect.objectContaining({
        excludeOutTx: new Set(['555']),
        excludeRefundTx: new Set(['77']),
      }));
    } finally {
      stop();
    }
  });

  test('a pending_withdrawal record re-arms: the executor is called again at the cadence', async () => {
    let calls = 0;
    jest.mocked(loadConvertRecords).mockResolvedValue({'leg-1': legRecord({step: 'pending_withdrawal'})});
    jest.mocked(executeConvert).mockImplementation(async (rec: ConvertRecord) => {
      calls += 1;
      return rec;
    });
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(40);
      expect(calls).toBeGreaterThanOrEqual(2); // re-armed, bounded by one in-flight drive
    } finally {
      stop();
    }
  });

  test('an unacknowledged stuck record is slow-probed; acknowledging stops the watch', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({'leg-1': legRecord({step: 'stuck', failureCode: 'unknown'})});
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      expect(probeConvertSettlement).toHaveBeenCalled(); // the background watch is live
      const before = jest.mocked(probeConvertSettlement).mock.calls.length;
      await acknowledgeStuckRecord('leg-1');
      expect(saveConvertRecord).toHaveBeenCalledWith('pub', expect.objectContaining({acknowledgedStuckAtMs: expect.any(Number)}));
      await sleep(30);
      expect(jest.mocked(probeConvertSettlement).mock.calls.length).toBe(before); // stopped for good
    } finally {
      stop();
    }
  });

  test('the stuck watch resolves: an output row found by the probe flips the record to done', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({'leg-1': legRecord({step: 'stuck', failureCode: 'unknown'})});
    jest.mocked(probeConvertSettlement).mockResolvedValue({kind: 'output', amount: '190000000', tx: '77'} as never);
    const seen: ConvertRecord[] = [];
    const unsub = subscribeConvertRecords((records) => {
      const r = records['leg-1'];
      if (r != null) seen.push(r);
    });
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      expect(seen.some(r => r.step === 'done' && r.outTx === '77')).toBe(true);
      expect(saveConvertRecord).toHaveBeenCalledWith('pub', expect.objectContaining({step: 'done', outTx: '77'}));
    } finally {
      stop();
      unsub();
    }
  });

  // --- the cross-rail stuck watch (phantom-refusal instance 3, 2026-10-04) ----------------------
  // A cross-rail record stuck on its withdraw leg resolves at the DESTINATION, never by the
  // hop-row probe: the hop row is the record's OWN already-consumed confirmation (hopTx), and
  // the withdraw's payout never lands on any IC ledger. Re-matching the consumed row is the
  // live mis-mark: a delivered withdraw flipped failed_leg/unknown before the crossing.
  const crossRailStuckRecord = (): ConvertRecord => ({
    ...legRecord({step: 'stuck', failureCode: 'unknown'}),
    destAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    crossRail: {kind: 'cctp_sol', burnSigner: 'device', solAddress: 'sol', mintRecipientAta: 'ata', maxFeeSubunits: '1', mintFloorSubunits: '1', solVenueId: 'jupiter'},
    legPlan: [
      {kind: 'approve', state: 'confirmed'},
      {kind: 'swap', state: 'confirmed'},
      {kind: 'approve', state: 'confirmed'},
      {kind: 'approve_gas', state: 'confirmed'},
      {kind: 'withdraw_erc20', state: 'sent'},
      {kind: 'cctp_burn', state: 'pending', canister: ''},
    ],
  } as unknown as ConvertRecord);

  test('a cross-rail withdraw stuck UNKNOWN resolves at the destination: delivered → the crossing continues', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({'leg-1': crossRailStuckRecord()});
    jest.mocked(probeHopPayout).mockResolvedValue({amount: '190000000', tx: 'stale-hop-row'} as never); // the record's OWN consumed row sits there
    jest.mocked(crossRailHopDelivered).mockResolvedValue(true as never);
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      expect(saveConvertRecord).toHaveBeenCalledWith('pub', expect.objectContaining({step: 'crossing'}));
      expect(saveConvertRecord).not.toHaveBeenCalledWith('pub', expect.objectContaining({step: 'failed_leg'}));
      expect(probeHopPayout).not.toHaveBeenCalled(); // the stale row is never even consulted
    } finally {
      stop();
    }
  });

  test('a cross-rail withdraw stuck UNKNOWN with nothing at the destination stays stuck — the stale hop row never marks failed_leg', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({'leg-1': crossRailStuckRecord()});
    jest.mocked(probeHopPayout).mockResolvedValue({amount: '190000000', tx: 'stale-hop-row'} as never);
    jest.mocked(crossRailHopDelivered).mockResolvedValue(false as never);
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      expect(saveConvertRecord).not.toHaveBeenCalledWith('pub', expect.objectContaining({step: 'failed_leg'}));
      expect(probeHopPayout).not.toHaveBeenCalled(); // the consumed row cannot re-mark anything it never reads
      expect(convertResumeSnapshot()['leg-1']?.step).toBe('stuck'); // the honest unknown, slow-watched
    } finally {
      stop();
    }
  });


  test('a record landing terminal fires onTerminal once (the ledger refresh seam)', async () => {
    const onTerminal = jest.fn();
    jest.mocked(loadConvertRecords).mockResolvedValue({'leg-1': legRecord()});
    jest.mocked(executeConvert).mockImplementation(async (rec: ConvertRecord, deps: {onUpdate: (r: ConvertRecord) => void}) => {
      deps.onUpdate({...rec, step: 'done', outAmountNet: '1', outTx: '2'});
      return {...rec, step: 'done', outAmountNet: '1', outTx: '2'};
    });
    const stop = startConvertResumeEngine({...CTX, onTerminal}, FAST);
    try {
      await sleep(30);
      expect(onTerminal).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  test('stop halts everything: no more re-arms after the engine is stopped', async () => {
    let calls = 0;
    jest.mocked(loadConvertRecords).mockResolvedValue({'leg-1': legRecord({step: 'pending_withdrawal'})});
    jest.mocked(executeConvert).mockImplementation(async (rec: ConvertRecord) => {
      calls += 1;
      return rec;
    });
    const stop = startConvertResumeEngine(CTX, FAST);
    await sleep(20);
    stop();
    const at = calls;
    await sleep(40);
    expect(calls).toBe(at); // nothing further fired
  });

  test('re-start with a different identity switches stores: the old record is not driven', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({'leg-1': legRecord()});
    const stop = startConvertResumeEngine(CTX, FAST);
    await sleep(20);
    stop();
    jest.mocked(loadConvertRecords).mockClear();
    jest.mocked(loadConvertRecords).mockResolvedValue({});
    const stop2 = startConvertResumeEngine({...CTX, publicHex: 'other'}, FAST);
    try {
      await sleep(20);
      expect(jest.mocked(loadConvertRecords).mock.calls[0]![0]).toBe('other');
    } finally {
      stop2();
    }
  });

  test('an in-flight drive from identity A never touches identity B\'s state (D2 switch race)', async () => {
    // A's executor drive parks on a deferred and is released only AFTER the engine re-keys to
    // identity B — the exact mid-drive switch window. The stale drive then fires its onUpdate,
    // returns a live (non-terminal) record, and (unfixed) would write A's record into B's
    // in-memory records map, arm B's re-arm timer for it, and drive it again under B's ctx —
    // persisting A's record into B's scoped store dpay.convert.v2.<B>.
    let release: () => void = () => {};
    const parked = new Promise<void>(resolve => { release = resolve; });
    jest.mocked(loadConvertRecords)
      .mockResolvedValueOnce({'leg-1': legRecord({step: 'swapping'})})
      .mockResolvedValueOnce({}); // B's store: empty
    jest.mocked(executeConvert).mockImplementation(async (rec: ConvertRecord, deps: {publicHex: string; onUpdate: (r: ConvertRecord) => void}) => {
      await parked; // the identity switch happens while the drive is parked here
      deps.onUpdate({...rec, step: 'swapping'}); // a STALE onUpdate landing after the switch
      await saveConvertRecord(deps.publicHex, {...rec, step: 'pending_withdrawal'}); // the executor's own persist, scoped to ITS ctx
      return {...rec, step: 'pending_withdrawal'}; // live and non-terminal — re-armable
    });
    const stopA = startConvertResumeEngine({...CTX, publicHex: 'pub-a'}, FAST);
    await sleep(20); // A's drive is in flight, parked
    const stopB = startConvertResumeEngine({...CTX, publicHex: 'pub-b'}, FAST); // the re-key: A is stopped, B owns the engine
    await sleep(20);
    release(); // A's stale drive completes under B's engine
    await sleep(40); // long enough for a wrongly-armed 5 ms re-arm timer to fire (and re-arm again)
    try {
      // B's in-memory records map never received A's record…
      expect(convertResumeSnapshot()['leg-1']).toBeUndefined();
      // …B's timers were never armed for it (the drive count stays at A's single entry drive)…
      expect(jest.mocked(executeConvert).mock.calls.filter((c: unknown[]) => (c[0] as ConvertRecord).id === 'leg-1'))
        .toHaveLength(1);
      // …and B's scoped store never received it (the only B-scoped persist would be the stale
      // drive's own executor echo, or B's engine driving A's leaked record).
      const bSaves = jest.mocked(saveConvertRecord).mock.calls
        .filter((c: unknown[]) => c[0] === 'pub-b')
        .map(c => (c[1] as ConvertRecord).id);
      expect(bSaves).not.toContain('leg-1');
    } finally {
      stopA();
      stopB();
    }
  });
});

describe('markConvertDepositSent — the once-only cefi-deposit handoff marker (2026-10-02 P0)', () => {
  test('persists the marker on the engine copy AND the store, and notifies subscribers', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({'cef-1': providerRecord()});
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(20);
      const seen: ConvertRecord[] = [];
      const unsub = subscribeConvertRecords(records => {
        const r = records['cef-1'];
        if (r?.depositSentAtMs != null) seen.push(r);
      });
      const ok = await markConvertDepositSent('cef-1', 1727870400000);
      unsub();
      expect(ok).toBe(true);
      expect(saveConvertRecord).toHaveBeenCalledWith('pub', expect.objectContaining({id: 'cef-1', depositSentAtMs: 1727870400000}));
      expect(convertResumeSnapshot()['cef-1']?.depositSentAtMs).toBe(1727870400000);
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  test('a SECOND mark is a no-op — exactly once per record, whatever fires the handoff', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({'cef-1': providerRecord()});
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(20);
      expect(await markConvertDepositSent('cef-1', 1111)).toBe(true);
      const savesAfterFirst = jest.mocked(saveConvertRecord).mock.calls.length;
      expect(await markConvertDepositSent('cef-1', 2222)).toBe(false);
      expect(jest.mocked(saveConvertRecord).mock.calls.length).toBe(savesAfterFirst);
      // The FIRST marker stands (never overwritten by a second taker).
      expect(convertResumeSnapshot()['cef-1']?.depositSentAtMs).toBe(1111);
    } finally {
      stop();
    }
  });

  test('an unknown record id (or a stopped engine) marks nothing', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({});
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(10);
      expect(await markConvertDepositSent('nope', 1111)).toBe(false);
      expect(saveConvertRecord).not.toHaveBeenCalled();
    } finally {
      stop();
    }
    expect(await markConvertDepositSent('nope', 1111)).toBe(false);
  });
});

describe('abortConvertRecord — the user\'s Stop through the resume engine', () => {
  test('a live record freezes at aborted; a late driver commit cannot un-abort it', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({
      'leg-1': legRecord({step: 'sol_ready', crossRail: {kind: 'cctp_sol', solAddress: 'SolAddr1', mintRecipientAta: 'AtaAddr1'}}),
    });
    let release: () => void = () => {};
    const parked = new Promise<void>(resolve => {
      release = resolve;
    });
    jest.mocked(prepareCrossRailSolLeg).mockImplementation(async (_secretHex: string, rec: ConvertRecord) => {
      await parked; // the driver is mid-prepare when the user taps Stop
      return {...rec, step: 'swapping', solanaLeg: {protocol: 'solana', signedTxHex: 'aa', signature: 'sig', lastValidBlockHeight: 5}};
    });
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(20);
      const driven = confirmCrossRailSolLeg('leg-1'); // captures rec at sol_ready, parks inside prepare
      await abortConvertRecord('leg-1');
      expect(jest.mocked(requestConvertAbort)).toHaveBeenCalledWith('leg-1');
      expect(convertResumeSnapshot()['leg-1']?.step).toBe('aborted');
      expect(convertResumeSnapshot()['leg-1']?.abortedAtMs).toEqual(expect.any(Number));
      expect(saveConvertRecord).toHaveBeenCalledWith(
        'pub',
        expect.objectContaining({step: 'aborted', abortedAtMs: expect.any(Number)}),
      );
      release();
      await driven; // the late driver commit arrives — and must not resurrect the record
      expect(convertResumeSnapshot()['leg-1']?.step).toBe('aborted');
      const saves = jest
        .mocked(saveConvertRecord)
        .mock.calls.filter(c => (c[1] as ConvertRecord).id === 'leg-1');
      expect((saves[saves.length - 1]![1] as ConvertRecord).step).toBe('aborted');
    } finally {
      stop();
    }
  });

  test('abortConvertRecord on an already-terminal record is a no-op (step unchanged, nothing persisted)', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({
      'leg-1': legRecord({step: 'done', outAmountNet: '1', outTx: '2'}),
    });
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(20);
      jest.mocked(saveConvertRecord).mockClear();
      await abortConvertRecord('leg-1');
      // The abort flag is still raised — the executor may be mid-drive on its own copy...
      expect(jest.mocked(requestConvertAbort)).toHaveBeenCalledWith('leg-1');
      // ...but the engine record is untouched.
      expect(convertResumeSnapshot()['leg-1']?.step).toBe('done');
      expect(convertResumeSnapshot()['leg-1']?.abortedAtMs).toBeUndefined();
      expect(saveConvertRecord).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  test('abortConvertRecord for an unknown id does not throw and touches nothing', async () => {
    await expect(abortConvertRecord('no-such-record')).resolves.toBeUndefined();
    expect(jest.mocked(requestConvertAbort)).toHaveBeenCalledWith('no-such-record');
    expect(Object.keys(convertResumeSnapshot())).toEqual([]);
    expect(saveConvertRecord).not.toHaveBeenCalled();
  });
});

// --- the late-deposit watch: an expired quote keeps a SLOW provider poll (2026-09-24) -------------
describe('the late-deposit watch — quote_expired is a watch, not the end', () => {  test('an expired quote keeps polling; the venue\'s refunded word flips it to provider_refunded', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({
      'cef-1': providerRecord({step: 'quote_expired'}),
    });
    // The first slow poll still reads expired, then the venue notices the late deposit
    // and refunds it — the dead record must observe that, not assert it never happens.
    jest.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(res({status: 'expired'}) as never)
      .mockResolvedValueOnce(res({status: 'refunded'}) as never);
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(40);
      expect(fetchWithTimeout).toHaveBeenCalled(); // the watch is live past the expiry
      expect(convertResumeSnapshot()['cef-1']?.step).toBe('provider_refunded');
      expect(saveConvertRecord).toHaveBeenCalledWith('pub', expect.objectContaining({step: 'provider_refunded'}));
    } finally {
      stop();
    }
  });

  test('the user\'s abort flag retires the watch: no further polls, the step stays quote_expired', async () => {
    // quote_expired is TERMINAL, so Stop does not rewrite the step (an abort must never
    // un-terminal a record) — the flag alone retires the slow watch.
    jest.mocked(loadConvertRecords).mockResolvedValue({
      'cef-1': providerRecord({step: 'quote_expired'}),
    });
    jest.mocked(fetchWithTimeout).mockResolvedValue(res({status: 'expired'}) as never);
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      await abortConvertRecord('cef-1');
      expect(convertResumeSnapshot()['cef-1']?.step).toBe('quote_expired'); // never un-terminal
      await sleep(5); // let any in-flight poll land
      const polls = jest.mocked(fetchWithTimeout).mock.calls.length;
      await sleep(40);
      expect(jest.mocked(fetchWithTimeout).mock.calls.length).toBe(polls); // the watch is dead
    } finally {
      stop();
    }
  });

  test('the engine remembers the LAST completed read — the panel\'s "last checked" fact', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({
      'cef-1': providerRecord({step: 'provider_processing'}),
    });
    jest.mocked(fetchWithTimeout).mockResolvedValue(res({status: 'processing'}) as never);
    expect(providerLastCheckedAtMs('cef-1')).toBeNull(); // no read yet — nothing is claimed
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      const at = providerLastCheckedAtMs('cef-1');
      expect(at).not.toBeNull();
      expect(at!).toBeLessThanOrEqual(Date.now());
    } finally {
      stop();
    }
  });
});

// --- C2: the Stop on a provider-held order retires the poll loop (2026-09-24) ---------------------
describe('C2 — aborting a provider record stops the venue watch', () => {
  test('Stop on awaiting_deposit freezes the record at aborted; fetchProviderStatus is never called again', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({'cef-1': providerRecord()});
    jest.mocked(fetchWithTimeout).mockResolvedValue(res({status: 'waiting'}) as never);
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      expect(fetchWithTimeout).toHaveBeenCalled(); // the venue is being watched
      await abortConvertRecord('cef-1');
      expect(convertResumeSnapshot()['cef-1']?.step).toBe('aborted');
      expect(convertResumeSnapshot()['cef-1']?.abortedFromStep).toBe('awaiting_deposit');
      await sleep(5); // let any in-flight poll land
      const polls = jest.mocked(fetchWithTimeout).mock.calls.length;
      await sleep(40);
      expect(jest.mocked(fetchWithTimeout).mock.calls.length).toBe(polls); // never polled again
    } finally {
      stop();
    }
  });
});

// --- C4: the resume driver never re-enters an aborted record, whatever its shape (2026-09-24) -----
describe('C4 — aborted records are skipped by every driver (parametric over record shapes)', () => {
  const mkPlan = (states: Array<'pending' | 'sent' | 'confirmed'>) =>
    states.map((s, i) => ({kind: i % 2 === 0 ? 'approve' as const : 'swap' as const, canister: `c${i}`, fee: '0', state: s}));
  const shapes = (): Array<[string, ConvertRecord]> => [
    ['direct', legRecord({step: 'aborted', abortedFromStep: 'swapping', abortedAtMs: 1})],
    ['planned', legRecord({id: 'planned-1', step: 'aborted', legPlan: mkPlan(['confirmed', 'sent']), abortedFromStep: 'swapping', abortedAtMs: 1})],
    ['hub', legRecord({id: 'hub-1', step: 'aborted', legPlan: mkPlan(['confirmed', 'confirmed', 'confirmed', 'pending']), venue2Id: 'icpswap', destLedger: VCHF_LEDGER, abortedFromStep: 'swapping', abortedAtMs: 1})],
    ['cefi', providerRecord({step: 'aborted', abortedFromStep: 'awaiting_deposit', abortedAtMs: 1})],
    ['crossrail', legRecord({id: 'xr-1', step: 'aborted', crossRail: {kind: 'cctp_sol', solAddress: 'SolAddr1', mintRecipientAta: 'AtaAddr1'}, legPlan: mkPlan(['confirmed', 'confirmed']), abortedFromStep: 'crossing', abortedAtMs: 1})],
    ['solana', legRecord({id: 'sol-1', step: 'aborted', legs: [], solanaLeg: {protocol: 'solana', signedTxHex: 'aa', signature: 'sig', lastValidBlockHeight: 9}, abortedFromStep: 'swapping', abortedAtMs: 1})],
  ];
  test.each(shapes())('%s', async (_name, rec) => {
    jest.mocked(loadConvertRecords).mockResolvedValue({[rec.id]: rec});
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(40); // several re-arm windows: a wrongly-armed record would be re-driven
      const callsFor = (m: {mock: {calls: Array<unknown[]>}}) =>
        m.mock.calls.filter((c) => (c[0] as ConvertRecord).id === rec.id);
      expect(callsFor(jest.mocked(executeConvert))).toHaveLength(0);
      expect(callsFor(jest.mocked(executeSolanaConvert))).toHaveLength(0);
      expect(callsFor(jest.mocked(executeCrossRailConvert))).toHaveLength(0);
      expect(callsFor(jest.mocked(executeCrossRailSolSwap))).toHaveLength(0);
      expect(probeConvertSettlement).not.toHaveBeenCalled(); // no stuck probe either
      expect(fetchWithTimeout).not.toHaveBeenCalled(); // and no provider poll
    } finally {
      stop();
    }
  });
});

// --- the stuck expiry resolution (2026-10-02 POCO P0) ----------------------------------------------
// A stuck record whose leg window has PASSED and whose probe still answers unknown must
// RESOLVE to its honest terminal state — the engine never slow-probes a dead window forever.
describe('the stuck expiry resolution — an expired unknown resolves, it never probes forever', () => {
  const expiredLegs = () => [
    {canister: ICP_LEDGER, method: 'icrc2_approve', argHex: 'a', envelopeHex: 'aa', requestIdHex: 'r1', expiresAtMs: Date.now() - 60_000},
    {canister: POOL, method: 'depositFromAndSwap', argHex: 'b', envelopeHex: 'bb', requestIdHex: 'r2', expiresAtMs: Date.now() - 60_000},
  ];
  // The founder's canonical shape (2026-10-02 POCO): a COMPOSED record — the IC pool swap
  // (leg-1: approve+swap) settled on-chain, the venue deposit leg sent, outcome unknown.
  const expiredComposed = (): ConvertRecord => legRecord({
    id: 'comp-1',
    step: 'stuck',
    failureCode: 'unknown',
    legs: [
      {canister: VCHF_LEDGER, method: 'icrc2_approve', argHex: 'a', envelopeHex: 'aa', requestIdHex: 'c1', expiresAtMs: Date.now() - 60_000},
      {canister: POOL, method: 'depositFromAndSwap', argHex: 'b', envelopeHex: 'bb', requestIdHex: 'c2', expiresAtMs: Date.now() - 60_000},
      {canister: ICP_LEDGER, method: 'icrc1_transfer', argHex: 'c', envelopeHex: 'cc', requestIdHex: 'c3', expiresAtMs: Date.now() - 60_000},
    ],
    legPlan: [
      {kind: 'approve', canister: VCHF_LEDGER, fee: '10000', state: 'confirmed'},
      {kind: 'swap', canister: POOL, fee: '', state: 'confirmed'},
      {kind: 'deposit_transfer', canister: ICP_LEDGER, fee: '10000', state: 'sent'},
    ],
    hopLedger: ICP_LEDGER,
    hopSymbol: 'ICP',
    hopCurrency: 7,
    composedDeposit: {
      venueId: 'sideshift', orderId: 'ord-9', depositAddress: 'venue-acct', depositOwner: 'venue-p',
      amountDecimal: '0.9', amountRaw: '90000000', fee: '10000',
      settleSymbol: 'SOL', settleDecimals: 9,
    },
    providerRef: {orderId: 'ord-9'},
  });

  test('window OPEN: the record stays stuck, keeps probing, and never reads a balance', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({'leg-1': legRecord({step: 'stuck', failureCode: 'unknown'})});
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      expect(probeConvertSettlement).toHaveBeenCalled(); // the slow watch is live while the window is open
      expect(railBalanceOf).not.toHaveBeenCalled(); // no expiry resolution while the window can still land
      expect(convertResumeSnapshot()['leg-1']?.step).toBe('stuck');
      const probes = jest.mocked(probeConvertSettlement).mock.calls.length;
      await sleep(15);
      expect(jest.mocked(probeConvertSettlement).mock.calls.length).toBeGreaterThan(probes); // still probing
    } finally {
      stop();
    }
  });

  test('expired + unknown + input still in wallet → failed_refunded (window_closed) with the cause', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({'leg-1': legRecord({step: 'stuck', failureCode: 'unknown', legs: expiredLegs()})});
    jest.mocked(railBalanceOf).mockResolvedValue('100000000' as never); // == amountIn: the swap never pulled
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      const rec = convertResumeSnapshot()['leg-1'];
      expect(rec?.step).toBe('failed_refunded');
      expect(rec?.failureCode).toBe('window_closed');
      expect(rec?.failureDetail ?? '').toContain('window');
      expect(saveConvertRecord).toHaveBeenCalledWith('pub', expect.objectContaining({step: 'failed_refunded', failureCode: 'window_closed'}));
    } finally {
      stop();
    }
  });

  test('the founder shape: expired + unknown + the leg-1 output spent elsewhere → failed_leg, balance is the truth', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({'comp-1': expiredComposed()});
    jest.mocked(railBalanceOf).mockResolvedValue('0' as never); // the ICP is gone (moved by another route)
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      const rec = convertResumeSnapshot()['comp-1'];
      expect(rec?.step).toBe('failed_leg');
      expect(rec?.failureDetail ?? '').toContain('window');
      expect(saveConvertRecord).toHaveBeenCalledWith('pub', expect.objectContaining({step: 'failed_leg'}));
    } finally {
      stop();
    }
  });

  test('expired + unknown + balance UNREADABLE → failed_leg (not verifiable is not "still there")', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({'leg-1': legRecord({step: 'stuck', failureCode: 'unknown', legs: expiredLegs()})});
    jest.mocked(railBalanceOf).mockResolvedValue(null as never);
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      expect(convertResumeSnapshot()['leg-1']?.step).toBe('failed_leg');
    } finally {
      stop();
    }
  });

  test('expired + probe finds the payout → done (on-chain evidence outranks the expiry)', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({'leg-1': legRecord({step: 'stuck', failureCode: 'unknown', legs: expiredLegs()})});
    jest.mocked(probeConvertSettlement).mockResolvedValue({kind: 'output', amount: '190000000', tx: '77'} as never);
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      const rec = convertResumeSnapshot()['leg-1'];
      expect(rec?.step).toBe('done');
      expect(rec?.outTx).toBe('77');
      expect(railBalanceOf).not.toHaveBeenCalled(); // resolved by evidence, no balance read needed
    } finally {
      stop();
    }
  });

  test('an ACKNOWLEDGED expired stuck record still resolves (the deadline, not the ack, ends it)', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({'leg-1': legRecord({step: 'stuck', failureCode: 'unknown', legs: expiredLegs()})});
    jest.mocked(railBalanceOf).mockResolvedValue('100000000' as never);
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(20);
      await acknowledgeStuckRecord('leg-1'); // the user read the screen — the record must STILL resolve
      await sleep(20);
      expect(convertResumeSnapshot()['leg-1']?.step).toBe('failed_refunded');
    } finally {
      stop();
    }
  });

  test('each completed probe records the last-checked fact the panels render', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({'leg-1': legRecord({step: 'stuck', failureCode: 'unknown'})});
    expect(stuckLastCheckedAtMs('leg-1')).toBeNull();
    noteStuckProbeDone('leg-1', 1234);
    expect(stuckLastCheckedAtMs('leg-1')).toBe(1234);
    const stop = startConvertResumeEngine(CTX, FAST);
    try {
      await sleep(30);
      const at = stuckLastCheckedAtMs('leg-1');
      expect(at).not.toBe(1234); // the engine's own probes re-record it
      expect(at!).toBeLessThanOrEqual(Date.now());
    } finally {
      stop();
    }
  });
});

// --- the TROCADOR poll floor + the 429 wait-and-retry (partner agreement 2026-09-22, term 4) ------
describe('the TROCADOR poll floor — one status request per trade id per 60 s, never faster', () => {
  const TROC_URL = 'http://r/api/v1/trocador/trade?id=t-1'; // relay-origin: the allowed http shape
  const SIDE_URL = 'https://provider.example/o/s-1';
  const FLOOR_OPTS = {
    rearmMs: 5,
    stuckWatchMs: 5,
    providerPollMs: 20,
    providerPollFloorMs: 400, // the agreement's floor, shrunk for the test clock
    executorOpts: {submitAttempts: 1, poll: {attempts: 1, intervalMs: 0}, settleAttempts: 1, settleIntervalMs: 0},
  };
  const callsFor = (url: string): number =>
    jest.mocked(fetchWithTimeout).mock.calls.filter(c => c[0] === url).length;

  test('a trocador-family record polls at the floor; a sideshift record keeps the engine cadence', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({
      'troc-1': providerRecord({id: 'troc-1', venueId: 'trocador', providerRef: {orderId: 't-1', statusUrl: TROC_URL}}),
      'side-1': providerRecord({id: 'side-1', venueId: 'sideshift', providerRef: {orderId: 's-1', statusUrl: SIDE_URL}}),
    });
    jest.mocked(fetchWithTimeout).mockResolvedValue(res({status: 'waiting'}) as never);
    const stop = startConvertResumeEngine(CTX, FLOOR_OPTS);
    try {
      await sleep(900); // ~45 engine cadences; a floored record may tick only ~3 times
      const side = callsFor(SIDE_URL);
      const troc = callsFor(TROC_URL);
      expect(side).toBeGreaterThanOrEqual(20); // the un-floored family ran at the engine cadence
      // The floored family is BOUNDED by the floor (first poll at t=0, then ≥400 ms apart:
      // at most 3 in the window) — an unfloored record would show ~45 here. Lower bound ≥2
      // proves the record is still LIVE under the floor (not stalled, just slow).
      expect(troc).toBeLessThanOrEqual(3);
      expect(troc).toBeGreaterThanOrEqual(2);
    } finally {
      stop();
    }
  });

  test('a 429 Retry-After pushes the next poll past the hint — wait-and-retry, never an error', async () => {
    jest.mocked(loadConvertRecords).mockResolvedValue({
      'cef-1': providerRecord({providerRef: {orderId: 'ocp-7', statusUrl: SIDE_URL}}),
    });
    // FIRST poll answers 429 with Retry-After: 1 (1 s) — longer than the observation window.
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce({
      ok: false, status: 429, json: async () => null,
      headers: {get: (n: string) => (n.toLowerCase() === 'retry-after' ? '1' : null)},
    } as never);
    const stop = startConvertResumeEngine(CTX, FLOOR_OPTS);
    try {
      await sleep(250); // ~12 cadences after the 429 — every one must be refused by the hint
      expect(callsFor(SIDE_URL)).toBe(1);
    } finally {
      stop();
    }
  });
});
