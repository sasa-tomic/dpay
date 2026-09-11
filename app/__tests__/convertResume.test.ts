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

jest.mock('../convert', () => ({
  executeConvert: jest.fn(),
  probeConvertSettlement: jest.fn(),
  loadConvertRecords: jest.fn(async () => ({})),
  saveConvertRecord: jest.fn(async () => undefined),
  isTerminalConvertStep: (step: string) =>
    ['done', 'failed_refunded', 'stuck', 'quote_expired', 'provider_refunded'].includes(step),
}));

jest.mock('../services/native', () => ({
  DpayCore: {icpPrincipalFromPubkey: jest.fn()},
}));

jest.mock('../services/relay', () => ({
  fetchWithTimeout: jest.fn(),
}));

import {executeConvert, loadConvertRecords, probeConvertSettlement, saveConvertRecord} from '../convert';
import {DpayCore} from '../services/native';
import {fetchWithTimeout} from '../services/relay';
import {
  __resetConvertResumeEngineForTest,
  acknowledgeStuckRecord,
  advanceProviderRecord,
  convertResumeSnapshot,
  fetchProviderStatus,
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
  jest.mocked(loadConvertRecords).mockResolvedValue({});
  jest.mocked(executeConvert).mockImplementation(async (rec: ConvertRecord) => rec);
  jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue('principal' as never);
  jest.mocked(probeConvertSettlement).mockResolvedValue(null as never);
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
  test('no statusUrl → unreachable (nothing to poll is not a claim of anything)', async () => {
    const reading = await fetchProviderStatus({orderId: 'o'});
    expect(reading.kind).toBe('unreachable');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
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
});

// --- the engine: who drives, when, and with what bounds --------------------------------------------
describe('the engine — every live record driven from wallet load, mounted screen or not', () => {
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
