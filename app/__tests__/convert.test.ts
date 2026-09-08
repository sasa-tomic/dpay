/**
 * app/convert.ts — the delegated-conversion §4 state machine, derivations, persistence, and
 * fail-closed venue resolution (spec 2026-09-07 §6). The swap-arg/min-out BYTES and the pool
 * reply decode belong to the compiled core (`crates/dpay-icp`, reached through wasm/FFI) and are
 * pinned by its own goldens; this suite pins the module's own logic with the FFI mocked:
 *   * derivations: net-out, impact warn threshold, staleness (incl. the test seam);
 *   * the state machine happy path, identical-envelope retry, every failure branch, resume;
 *   * the persisted-record round-trip (dpay.convert.v1) and corrupt-storage fail-safe;
 *   * resolveConvertDirection fail-closed behavior + all four locales carrying the copy.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {beforeEach, describe, expect, jest, test} from '@jest/globals';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpSwapMinOut: jest.fn(),
    icpApproveArg: jest.fn(),
    icpDepositAndSwapArg: jest.fn(),
    icpSignUpdate: jest.fn(),
    icpPrincipalFromPubkey: jest.fn(),
  },
}));
jest.mock('../services/icp', () => ({icStampExpiry: jest.fn()}));
jest.mock('../services/relay', () => ({fetchWithTimeout: jest.fn()}));
jest.mock('../services/rail', () => ({submitTransfer: jest.fn()}));

import {DpayCore} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {fetchWithTimeout} from '../services/relay';
import {submitTransfer} from '../services/rail';
import {
  deriveConvertMath,
  executeConvert,
  fetchConvertQuote,
  hydrateConvertStore,
  isQuoteStale,
  loadConvertRecords,
  prepareConvertRecord,
  type ConvertQuote,
  type ConvertRecord,
} from '../convert';
import {
  CONVERT_APPROVE_LIFETIME_S,
  CONVERT_POOL_PRINCIPAL,
  CONVERT_VENUE_LEDGERS,
  resolveConvertDirection,
} from '../config/convert';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {convertEn} from '../i18n/domains/en/convert';
import {convertDe} from '../i18n/domains/de/convert';
import {convertEs} from '../i18n/domains/es/convert';
import {convertFr} from '../i18n/domains/fr/convert';

const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
const ICP_DESC = BUNDLED.find(c => c.currency === 8)!;
const VCHF_DESC = BUNDLED.find(c => c.currency === 7)!;
// The venue pair is UNORDERED by design (which side the pool calls token0 is the POOL's fact, read
// off its metadata by the relay — see config/convert.ts). So the legs are named from the catalog
// rows, never by indexing into the pair: a test that indexed it would re-introduce the assumption.
const ICP_LEDGER = ICP_DESC.ledger;
const VCHF_LEDGER = VCHF_DESC.ledger;

const quote = (over: Partial<ConvertQuote> = {}): ConvertQuote => ({
  pool: CONVERT_POOL_PRINCIPAL,
  tokenInLedger: ICP_LEDGER,
  tokenOutLedger: VCHF_LEDGER,
  amountIn: '100000000', // 1 ICP
  amountOutGross: '190000000',
  zeroForOne: true,
  feeMillionths: 3000,
  fetchedAtMs: 1_000,
  impactBps: null,
  ...over,
});

const record = (over: Partial<ConvertRecord> = {}): ConvertRecord => ({
  id: 'abc123',
  createdAtMs: 1,
  step: 'approving',
  inCurrency: 8,
  outCurrency: 7,
  inLedger: ICP_LEDGER,
  outLedger: VCHF_LEDGER,
  inSymbol: 'ICP',
  outSymbol: 'CHF',
  amountIn: '100000000',
  amountOutMin: '188000000',
  expectedGross: '190000000',
  expectedNet: '189990000',
  inFee: '10000',
  outFee: '10000',
  slippageBps: 100,
  zeroForOne: true,
  approveEnvelopeHex: 'aacc',
  approveRequestIdHex: 'bbdd',
  approveExpiresAtMs: 601_000,
  swapEnvelopeHex: 'ccaa',
  swapRequestIdHex: 'ddbb',
  ...over,
});

const fakeRes = (body: unknown, ok = true, status = 200) => ({ok, status, json: async () => body});
const rowsRes = (rows: unknown[]) => fakeRes({transactions: rows});
const myPrincipal = 'myprincipal123';
const OPTS = {submitAttempts: 2, poll: {attempts: 1, intervalMs: 0}, settleAttempts: 2, settleIntervalMs: 0};

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

describe('resolveConvertDirection — venue resolution fails closed', () => {
  test('either side of the pair resolves to the OTHER side, and to nothing else', () => {
    expect(resolveConvertDirection(ICP_LEDGER, false)).toEqual({otherLedger: VCHF_LEDGER});
    expect(resolveConvertDirection(VCHF_LEDGER, false)).toEqual({otherLedger: ICP_LEDGER});
    // No direction flag is returned at all: `zero_for_one` is the POOL's fact and reaches the app
    // only as the relay's echo on the quote. A pinned order here is what shipped a ~5.9×-wrong rate.
    expect(Object.keys(resolveConvertDirection(ICP_LEDGER, false)!)).toEqual(['otherLedger']);
    expect(CONVERT_VENUE_LEDGERS).toHaveLength(2);
  });
  test('unknown ledger, missing ledger, or any testnet row → null (no venue today)', () => {
    expect(resolveConvertDirection('ryjl3-tyaaa-aaaaa-aaaba-cax', false)).toBeNull();
    expect(resolveConvertDirection(undefined, false)).toBeNull();
    expect(resolveConvertDirection(ICP_LEDGER, true)).toBeNull();
  });
});

describe('deriveConvertMath — every number the screen shows', () => {
  test('min-out comes from the compiled core; net = gross − output fee', async () => {
    jest.mocked(DpayCore.icpSwapMinOut).mockResolvedValue('188000000' as never);
    const m = await deriveConvertMath(quote(), '10000', '10000', 100);
    expect(m.minOut).toBe('188000000');
    expect(m.netOut).toBe('189990000');
    expect(DpayCore.icpSwapMinOut).toHaveBeenCalledWith('190000000', 100);
    expect(m.impactWarn).toBe(false);
  });
  test('net floors at zero; impact warns above 500 bps', async () => {
    jest.mocked(DpayCore.icpSwapMinOut).mockResolvedValue('0' as never);
    const m = await deriveConvertMath(quote({amountOutGross: '5000', impactBps: 600}), '10000', '10000', 300);
    expect(m.netOut).toBe('0');
    expect(m.impactWarn).toBe(true);
    const edge = await deriveConvertMath(quote({impactBps: 500}), '10000', '10000', 300);
    expect(edge.impactWarn).toBe(false); // warn strictly above 5%
  });
});

describe('isQuoteStale — 30 s threshold, test-shrinkable', () => {
  test('fresh vs stale at the default threshold', () => {
    expect(isQuoteStale(quote({fetchedAtMs: 10_000}), 40_000)).toBe(false);
    expect(isQuoteStale(quote({fetchedAtMs: 10_000}), 40_001)).toBe(true);
  });
  test('__DPAY_TEST_CONVERT_STALE_MS seam overrides the threshold', () => {
    (globalThis as unknown as {__DPAY_TEST_CONVERT_STALE_MS?: number}).__DPAY_TEST_CONVERT_STALE_MS = 100;
    try {
      expect(isQuoteStale(quote({fetchedAtMs: 0}), 100)).toBe(false);
      expect(isQuoteStale(quote({fetchedAtMs: 0}), 101)).toBe(true);
    } finally {
      delete (globalThis as unknown as {__DPAY_TEST_CONVERT_STALE_MS?: number}).__DPAY_TEST_CONVERT_STALE_MS;
    }
  });
});

describe('fetchConvertQuote — the venue verbatim + a separate impact measurement', () => {
  const swapRes = (amountIn: string, amountOut: string, zeroForOne = true) =>
    fakeRes({pool: CONVERT_POOL_PRINCIPAL, token_in: 'a', token_out: 'b', amount_in: amountIn, amount_out: amountOut, zero_for_one: zeroForOne, fee_millionths: 3000, fetched_at: 1});
  test('echoes the venue quote and measures impact against the reference trade', async () => {
    jest.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(swapRes('1000000', '1900000') as never)
      .mockResolvedValueOnce(swapRes('1000', '1901') as never);
    const q = await fetchConvertQuote('http://relay', 'in-ledger', 'out-ledger', '1000000');
    expect(q.amountIn).toBe('1000000');
    expect(q.amountOutGross).toBe('1900000');
    expect(q.zeroForOne).toBe(true);
    expect(q.impactBps).toBe(5); // price 19000 vs ref 19010, floored bps
  });
  // The venue's OWN curve, measured read-only against
  // https://dpay.kalaj.org/api/v1/swap_quote?pool=65mrh-fqaaa-aaaar-qapoa-cai
  // &token_in=ryjl3-tyaaa-aaaaa-aaaba-cai&token_out=ly36x-wiaaa-aaaai-aqj7q-cai on 2026-09-08.
  // Eight sizes, the pool's replies verbatim — so the arithmetic below is pinned to a REAL curve
  // (including its floor quantization), not to a hand-picked pair of numbers that happens to work.
  // These are the answers the DEPLOYED relay gave (it echoed `zero_for_one: true` for this request,
  // where the corrected pair in the working tree derives `false`), so the table is "the curve the
  // relay served", not a claim about which leg of the pool served it. That distinction cannot reach
  // this arithmetic: both quotes ride the same curve in the same direction, and impact is their
  // ratio.
  // The stub answers by the amount the CODE asks for, which is what makes the reference-trade
  // constant part of the test: a reference too narrow to resolve the gap is a RED here.
  const LIVE_ICP_TO_VCHF: Record<string, string> = {
    '1000': '406', // 0.00001 ICP — 3 significant digits: 0.23% below the true rate
    '1000000': '406356', // 0.01 ICP — the reference trade
    '100000000': '40635577', // 1 ICP
    '1000000000': '406352466', // 10 ICP
    '10000000000': '4063193580', // 100 ICP
    '100000000000': '40598856927', // 1 000 ICP
    '1000000000000': '402710065564', // 10 000 ICP
    '10000000000000': '3726151260700', // 100 000 ICP
  };
  const liveCurve = () => {
    jest.mocked(fetchWithTimeout).mockImplementation((async (url: string) => {
      const amountIn = new URL(url).searchParams.get('amount_in') ?? '';
      const amountOut = LIVE_ICP_TO_VCHF[amountIn];
      if (amountOut == null) throw new Error(`test curve has no live measurement for amount_in=${amountIn}`);
      return swapRes(amountIn, amountOut);
    }) as never);
  };

  test('a 1 ICP trade through the live curve measures 0 bps — a number, never the unavailable line', async () => {
    liveCurve();
    const q = await fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '100000000');
    // 0.40635577 vs the reference's 0.406356 ⇒ 0.0057 bps of impact: real, and below 1 bp.
    expect(q.impactBps).toBe(0);
  });

  test('impact is resolution-true at the sizes where it matters (9 bps / 830 bps, both measured)', async () => {
    liveCurve();
    // 1 000 ICP: (0.406356 − 0.4059885693) / 0.406356 = 9.04 bps.
    expect((await fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '100000000000')).impactBps).toBe(9);
    // 100 000 ICP: (0.406356 − 0.37261512607) / 0.406356 = 830.3 bps — past the 5% warn threshold.
    const deep = await fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '10000000000000');
    expect(deep.impactBps).toBe(830);
    expect((await deriveConvertMath(quote({impactBps: deep.impactBps}), '10000', '10000', 100)).impactWarn).toBe(true);
  });

  test('a dust trade reports the pool\'s own flooring, because the user really pays it', async () => {
    liveCurve();
    // 0.00001 ICP quotes 406 where the reference rate says 406.36: 8.7 bps the user genuinely
    // does not receive. The line measures the gap to the near-zero rate, whatever causes it.
    expect((await fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '1000')).impactBps).toBe(8);
  });

  test('a quote that floors in the user\'s favour reads 0 bps — never "unmeasurable"', async () => {
    // The reference lost more to flooring than this trade did, so the raw gap is NEGATIVE. A
    // bigger trade cannot get a better unit price out of the same curve, so the honest reading of
    // sub-resolution noise is zero impact — the state the old `price <= refPrice` guard nulled.
    jest.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(swapRes('50000000', '25829008') as never)
      .mockResolvedValueOnce(swapRes('1000000', '516580') as never);
    expect((await fetchConvertQuote('http://relay', 'in', 'out', '50000000')).impactBps).toBe(0);
  });

  test('a pair whose output dwarfs its input is still measured (no rate ceiling)', async () => {
    // Decimals differ per ledger, so out/in carries no bound dpay may assume: 1 unit in ⇒ ~100 out.
    jest.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(swapRes('100000000', '9990000000') as never)
      .mockResolvedValueOnce(swapRes('1000000', '100000000') as never);
    const q = await fetchConvertQuote('http://relay', 'in', 'out', '100000000');
    expect(q.impactBps).toBe(10); // 99.9 vs 100.0 per unit ⇒ 10 bps
  });

  test('impact is unmeasurable ONLY when the venue answers the reference with zero', async () => {
    jest.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(swapRes('100000000', '40635577') as never)
      .mockResolvedValueOnce(swapRes('1000000', '0') as never);
    expect((await fetchConvertQuote('http://relay', 'in', 'out', '100000000')).impactBps).toBeNull();
  });

  test('unreachable relay → the localized quoteUnreachable error', async () => {
    jest.mocked(fetchWithTimeout).mockRejectedValueOnce(new Error('boom') as never);
    await expect(fetchConvertQuote('http://relay', 'i', 'o', '1')).rejects.toThrow(convertEn.errors.quoteUnreachable());
  });
  test('pool refusal (422) and malformed (400) map to their own copy', async () => {
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(fakeRes({}, false, 422) as never);
    await expect(fetchConvertQuote('http://relay', 'i', 'o', '1')).rejects.toThrow(convertEn.errors.quoteRefused());
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(fakeRes({}, false, 400) as never);
    await expect(fetchConvertQuote('http://relay', 'i', 'o', '1')).rejects.toThrow(convertEn.errors.quoteUnavailable('400'));
  });
});

describe('hydrateConvertStore — the dpay.convert.v1 record round-trip', () => {
  test('a full record survives JSON round-trip byte-for-byte', () => {
    const rec = record({step: 'done', outAmountNet: '189990000', outTx: '77'});
    const out = hydrateConvertStore(JSON.parse(JSON.stringify({abc123: rec})));
    expect(out).toEqual({abc123: rec});
  });
  test('corrupt storage yields null — never a thrown error, never a half-record', () => {
    const rec = record();
    for (const bad of [
      null,
      [],
      'x',
      {a: 'nope'},
      {abc123: {...rec, approveEnvelopeHex: undefined}},
      {abc123: {...rec, step: 'weird'}},
      {abc123: {...rec, failureCode: 'nope'}},
      {otherId: rec}, // record id must match its key
      {abc123: {...rec, createdAtMs: '1'}},
    ]) {
      expect(hydrateConvertStore(bad)).toBeNull();
    }
  });
  test('saveConvertRecord → loadConvertRecords round-trip via AsyncStorage', async () => {
    await AsyncStorage.setItem('dpay.convert.v1', 'not json at all');
    expect(await loadConvertRecords()).toEqual({}); // corrupt store is empty, not fatal
    const rec = record({step: 'stuck', failureCode: 'unknown'});
    const {saveConvertRecord} = await import('../convert');
    await saveConvertRecord(rec);
    expect(await loadConvertRecords()).toEqual({abc123: rec});
  });
});

describe('prepareConvertRecord — both envelopes built + signed exactly once, up front', () => {
  test('approve amount = amountIn + input fee, expected_allowance present, 10-min expiry', async () => {
    jest.mocked(icStampExpiry).mockResolvedValue('1700000000000000000' as never);
    jest.mocked(DpayCore.icpApproveArg).mockResolvedValue('approve-arg-hex' as never);
    jest.mocked(DpayCore.icpDepositAndSwapArg).mockResolvedValue('swap-arg-hex' as never);
    jest.mocked(DpayCore.icpSignUpdate).mockImplementation(async (_s, _ledger, method) =>
      ({envelopeHex: `env-${method}`, requestIdHex: `req-${method}`}) as never);
    jest.mocked(DpayCore.icpSwapMinOut).mockResolvedValue('188000000' as never);
    const math = await deriveConvertMath(quote(), '10000', '10000', 100);
    const rec = await prepareConvertRecord({secretHex: 'sec', relayUrl: 'http://r', quote: quote(), math, inDesc: ICP_DESC, outDesc: VCHF_DESC});
    expect(DpayCore.icpApproveArg).toHaveBeenCalledWith(
      CONVERT_POOL_PRINCIPAL, '', '', '100010000', '100010000', '1700000000000000000', '', '10000',
    );
    expect(DpayCore.icpDepositAndSwapArg).toHaveBeenCalledWith('100000000', '188000000', '10000', '10000', true);
    expect(DpayCore.icpSignUpdate).toHaveBeenCalledWith('sec', ICP_DESC.ledger, 'icrc2_approve', 'approve-arg-hex', '1700000000000000000');
    expect(DpayCore.icpSignUpdate).toHaveBeenCalledWith('sec', CONVERT_POOL_PRINCIPAL, 'depositFromAndSwap', 'swap-arg-hex', '1700000000000000000');
    expect(rec.step).toBe('approving');
    expect(rec.approveEnvelopeHex).toBe('env-icrc2_approve');
    expect(rec.swapEnvelopeHex).toBe('env-depositFromAndSwap');
    expect(rec.inSymbol).toBe('ICP');
    // Backing symbol straight from the catalog — the relay's compiled catalog pins VCHF's
    // backing_symbol to 'VCHF' intentionally (issuer token, same rule as VEUR), so the record
    // carries the catalog's own words, never a hardcoded CHF/ledger id.
    expect(rec.outSymbol).toBe(VCHF_DESC.backing_symbol ?? VCHF_DESC.symbol);
    expect(rec.approveExpiresAtMs).toBeGreaterThan(Date.now() + (CONVERT_APPROVE_LIFETIME_S - 5) * 1000);
  });
});

describe('executeConvert — the §4 state machine', () => {
  const deps = () => ({secretHex: 'sec', publicHex: 'pub', relayUrl: 'http://r', onUpdate: jest.fn()});

  test('happy path: approving → approved → swapping → settling → done from the SEEN ledger row', async () => {
    const d = deps();
    jest.mocked(submitTransfer)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '2'} as never);
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    jest.mocked(fetchWithTimeout).mockImplementation(async (url: unknown) =>
      (String(url).includes('currency=7') ? rowsRes([{from: CONVERT_POOL_PRINCIPAL, to: myPrincipal, amount: '190000000', currency: 7, timestamp: 77}]) : rowsRes([])) as never);
    const final = await executeConvert(record(), d, OPTS);
    expect(final.step).toBe('done');
    expect(final.outAmountNet).toBe('190000000');
    expect(final.outTx).toBe('77');
    // identical persisted bytes, in order: approve on the input ledger, swap on the pool.
    expect(jest.mocked(submitTransfer).mock.calls[0]![0]).toEqual({ledger: ICP_LEDGER, envelopeHex: 'aacc', requestIdHex: 'bbdd'});
    expect(jest.mocked(submitTransfer).mock.calls[1]![0]).toEqual({ledger: CONVERT_POOL_PRINCIPAL, envelopeHex: 'ccaa', requestIdHex: 'ddbb'});
    // every step change was surfaced + persisted
    const steps = d.onUpdate.mock.calls.map((c: unknown[]) => (c[0] as ConvertRecord).step);
    expect(steps).toEqual(['approved', 'swapping', 'settling', 'done']);
    expect((await loadConvertRecords()).abc123?.step).toBe('done');
  });

  test("a 'unknown' submit retries the SAME signed bytes, never rebuilds args", async () => {
    const d = deps();
    jest.mocked(submitTransfer)
      .mockResolvedValueOnce({kind: 'unknown'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never) // approve, attempt 2
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '2'} as never); // swap
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    jest.mocked(fetchWithTimeout).mockResolvedValue(rowsRes([{from: CONVERT_POOL_PRINCIPAL, to: myPrincipal, amount: '190000000', currency: 7, timestamp: 9}]) as never);
    const final = await executeConvert(record(), d, OPTS);
    expect(final.step).toBe('done');
    const first = jest.mocked(submitTransfer).mock.calls[0]![0] as {envelopeHex: string; requestIdHex: string};
    const second = jest.mocked(submitTransfer).mock.calls[1]![0] as {envelopeHex: string; requestIdHex: string};
    expect(second).toEqual(first); // byte-identical envelope + request id
    expect(DpayCore.icpApproveArg).not.toHaveBeenCalled(); // args were NEVER rebuilt
  });

  test('approve refused (definitively, before anything moved) → failed_refunded/approve_refused', async () => {
    const d = deps();
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'rejected', reason: 'bad fee', variant: 'TxTooOld'} as never);
    const final = await executeConvert(record(), d, OPTS);
    expect(final.step).toBe('failed_refunded');
    expect(final.failureCode).toBe('approve_refused');
    expect(submitTransfer).toHaveBeenCalledTimes(1); // the swap was never submitted
  });

  test("pool #err (e.g. amountOutMinimum not met) → failed_refunded/swap_refused with the pool's text", async () => {
    const d = deps();
    jest.mocked(submitTransfer)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never)
      .mockResolvedValueOnce({kind: 'rejected', reason: 'amountOutMinimum not met', variant: 'InternalError'} as never);
    const final = await executeConvert(record(), d, OPTS);
    expect(final.step).toBe('failed_refunded');
    expect(final.failureCode).toBe('swap_refused');
    expect(final.failureDetail).toBe('amountOutMinimum not met');
  });

  test('swap submit unknown after retries → stuck (honest unknown, instructions not a spinner)', async () => {
    const d = deps();
    jest.mocked(submitTransfer)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never)
      .mockResolvedValue({kind: 'unknown'} as never);
    const final = await executeConvert(record(), d, OPTS);
    expect(final.step).toBe('stuck');
    expect(final.failureCode).toBe('unknown');
    expect(jest.mocked(submitTransfer).mock.calls.filter((c) => c[0].ledger === CONVERT_POOL_PRINCIPAL)).toHaveLength(2); // retried same bytes
  });

  test('no output row in budget → pending_withdrawal; resume only re-watches (no resubmission)', async () => {
    const d = deps();
    jest.mocked(submitTransfer)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '2'} as never);
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    jest.mocked(fetchWithTimeout).mockResolvedValue(rowsRes([]) as never);
    const pending = await executeConvert(record(), d, OPTS);
    expect(pending.step).toBe('pending_withdrawal');
    const submitsBefore = jest.mocked(submitTransfer).mock.calls.length;

    // the payout lands; a resumed run (screen open, executor re-armed) flips it to done
    jest.mocked(fetchWithTimeout).mockImplementation(async (url: unknown) =>
      (String(url).includes('currency=7') ? rowsRes([{from: CONVERT_POOL_PRINCIPAL, to: myPrincipal, amount: '190000000', currency: 7, timestamp: 55}]) : rowsRes([])) as never);
    const done = await executeConvert(pending, d, OPTS);
    expect(done.step).toBe('done');
    expect(done.outAmountNet).toBe('190000000');
    expect(jest.mocked(submitTransfer).mock.calls.length).toBe(submitsBefore); // identical-envelope discipline: never resubmitted
  });

  test('pool refund on the input ledger → failed_refunded/refunded', async () => {
    const d = deps();
    jest.mocked(submitTransfer)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '2'} as never);
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    jest.mocked(fetchWithTimeout).mockImplementation(async (url: unknown) =>
      (String(url).includes('currency=8') ? rowsRes([{from: CONVERT_POOL_PRINCIPAL, to: myPrincipal, amount: '100000000', currency: 8, timestamp: 3}]) : rowsRes([])) as never);
    const final = await executeConvert(record(), d, OPTS);
    expect(final.step).toBe('failed_refunded');
    expect(final.failureCode).toBe('refunded');
  });
});

describe('fail-closed copy — all four locales carry it', () => {
  const domains = {en: convertEn, de: convertDe, es: convertEs, fr: convertFr};
  test.each(Object.entries(domains))('%s: counterparty names the pool; venue-less copy is honest', (_locale: string, d: typeof convertEn) => {
    expect(d.counterparty).toContain('ICPSwap');
    // The principal itself is NOT spelled in any locale — it has ONE home (config/convert.ts) and
    // the screen renders it on its own line (convertMode.test.tsx pins that). A copy of a canister
    // id in four translations is four places to drift.
    expect(d.counterparty).not.toContain(CONVERT_POOL_PRINCIPAL);
    expect(d.unavailableTitle('X')).toContain('X');
    expect(d.unavailableBody('ICP ↔ Swiss francs (VCHF)')).toContain('ICPSwap');
    expect(d.unavailableCkusdc.length).toBeGreaterThan(0); // the saturated direct-pool refusal (spec §1)
    expect(d.dpayFeeLine.length).toBeGreaterThan(0); // "dpay charges nothing and is paid nothing"
  });
});
