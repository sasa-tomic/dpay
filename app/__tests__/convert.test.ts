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
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';

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
jest.mock('../services/relay', () => ({relayFetch: jest.fn()}));
jest.mock('../services/rail', () => ({submitTransfer: jest.fn()}));

import {DpayCore} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {relayFetch} from '../services/relay';
import {submitTransfer} from '../services/rail';
import {
  deriveConvertMath,
  executeConvert,
  fetchConvertQuote,
  hydrateConvertStore,
  isQuoteStale,
  loadConvertRecords,
  loadVenueRegistry,
  prepareConvertRecord,
  type ConvertQuote,
  type ConvertRecord,
} from '../convert';
import {
  CONVERT_APPROVE_LIFETIME_S,
  resolveConvertDirection,
} from '../config/convert';
import {BUNDLED_VENUES, setRuntimeVenues, venuesForPair, type VenueEntry} from '../config/venues';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {convertEn} from '../i18n/domains/en/convert';
import {convertDe} from '../i18n/domains/de/convert';
import {convertEs} from '../i18n/domains/es/convert';
import {convertFr} from '../i18n/domains/fr/convert';

const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
const ICP_DESC = BUNDLED.find(c => c.currency === 8)!;
const VCHF_DESC = BUNDLED.find(c => c.currency === 7)!;
// The venue pair is UNORDERED by design (which side the pool calls token0 is the POOL's fact, read
// off its metadata by the relay — see config/venues.ts). So the legs are named from the catalog
// rows, never by indexing into the pair: a test that indexed it would re-introduce the assumption.
const ICP_LEDGER = ICP_DESC.ledger;
const VCHF_LEDGER = VCHF_DESC.ledger;
const VENUE = BUNDLED_VENUES.find(v => v.kind === 'ic_amm' && !v.testnet)!;
const POOL = VENUE.endpoint;

const quote = (over: Partial<ConvertQuote> = {}): ConvertQuote => ({
  venueId: VENUE.venue_id,
  pool: POOL,
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
  venueId: VENUE.venue_id,
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
    {
      canister: ICP_LEDGER,
      method: 'icrc2_approve',
      argHex: 'approvearg',
      envelopeHex: 'aacc',
      requestIdHex: 'bbdd',
      // Unexpired by default (V6 trichotomy: the resubmit path is the DEFAULT arm; the
      // expired arm is an explicit `over` in the tests that pin it).
      expiresAtMs: Date.now() + 600_000,
    },
    {
      canister: POOL,
      method: 'depositFromAndSwap',
      argHex: 'swaparg',
      envelopeHex: 'ccaa',
      requestIdHex: 'ddbb',
      expiresAtMs: Date.now() + 600_000,
    },
  ],
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
    expect(VENUE.pair_ledgers).toHaveLength(2);
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
    fakeRes({venue_id: VENUE.venue_id, pool: POOL, token_in: 'a', token_out: 'b', amount_in: amountIn, amount_out: amountOut, zero_for_one: zeroForOne, fee_millionths: 3000, fetched_at: 1});
  test('echoes the venue quote (attribution included) and measures impact against the reference trade', async () => {
    jest.mocked(relayFetch)
      .mockResolvedValueOnce(swapRes('1000000', '1900000') as never)
      .mockResolvedValueOnce(swapRes('1000', '1901') as never);
    const q = await fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '1000000');
    expect(q.venueId).toBe(VENUE.venue_id);
    expect(q.pool).toBe(POOL);
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
    jest.mocked(relayFetch).mockImplementation((async (_relay: string, path: string) => {
      const amountIn = new URL(path, 'http://relay.test').searchParams.get('amount_in') ?? '';
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
    jest.mocked(relayFetch)
      .mockResolvedValueOnce(swapRes('50000000', '25829008') as never)
      .mockResolvedValueOnce(swapRes('1000000', '516580') as never);
    expect((await fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '50000000')).impactBps).toBe(0);
  });

  test('a pair whose output dwarfs its input is still measured (no rate ceiling)', async () => {
    // Decimals differ per ledger, so out/in carries no bound dpay may assume: 1 unit in ⇒ ~100 out.
    jest.mocked(relayFetch)
      .mockResolvedValueOnce(swapRes('100000000', '9990000000') as never)
      .mockResolvedValueOnce(swapRes('1000000', '100000000') as never);
    const q = await fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '100000000');
    expect(q.impactBps).toBe(10); // 99.9 vs 100.0 per unit ⇒ 10 bps
  });

  test('impact is unmeasurable ONLY when the venue answers the reference with zero', async () => {
    jest.mocked(relayFetch)
      .mockResolvedValueOnce(swapRes('100000000', '40635577') as never)
      .mockResolvedValueOnce(swapRes('1000000', '0') as never);
    expect((await fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '100000000')).impactBps).toBeNull();
  });

  test('unreachable relay → the localized quoteUnreachable error (venue named from the registry)', async () => {
    jest.mocked(relayFetch).mockRejectedValueOnce(new Error('boom') as never);
    await expect(fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '1')).rejects.toThrow(convertEn.errors.quoteUnreachable(VENUE.display_name));
  });
  test('pool refusal (422) and malformed (400) map to their own copy', async () => {
    jest.mocked(relayFetch).mockResolvedValueOnce(fakeRes({}, false, 422) as never);
    await expect(fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '1')).rejects.toThrow(convertEn.errors.quoteRefused(VENUE.display_name));
    jest.mocked(relayFetch).mockResolvedValueOnce(fakeRes({}, false, 400) as never);
    await expect(fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '1')).rejects.toThrow(convertEn.errors.quoteUnavailable('400'));
  });
  test('a pair with no registered venue fails closed before the relay is asked', async () => {
    await expect(fetchConvertQuote('http://relay', 'i', 'o', '1')).rejects.toThrow(convertEn.errors.quoteUnavailable('venue'));
    expect(relayFetch).not.toHaveBeenCalled();
  });

  // --- V8 provenance rules: direction is optional on the wire, the timestamp is the venue-read
  //     instant, and a non-curve venue never pays for a second (meaningless) reference quote.
  test('V8: a reply without zero_for_one is valid (null, not malformed); fetchedAtMs is the relay fetched_at, not the device clock', async () => {
    const noDirection = fakeRes({venue_id: VENUE.venue_id, pool: POOL, token_in: 'a', token_out: 'b', amount_in: '100000000', amount_out: '190000000', fee_millionths: 3000, fetched_at: 1});
    jest.mocked(relayFetch).mockResolvedValueOnce(noDirection as never);
    const q = await fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '100000000');
    expect(q.zeroForOne).toBeNull(); // a venue without an AMM direction flag is not "malformed"
    expect(q.fetchedAtMs).toBe(1_000); // fetched_at seconds → ms, the venue-read instant
  });

  test('V8: a cefi venue gets NO reference quote — one call per keystroke, impact unmeasured (not faked)', async () => {
    const cefi: VenueEntry = {venue_id: 'cefi-x', display_name: 'CeFi X', kind: 'cefi', endpoint: 'https://api.cefi.example', pair_ledgers: [ICP_LEDGER, VCHF_LEDGER], testnet: false, disclosure_key: 'cefix'};
    jest.mocked(relayFetch).mockResolvedValueOnce(swapRes('100000000', '190000000') as never);
    const q = await fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '100000000', {venue: cefi});
    expect(q.impactBps).toBeNull(); // no curve to measure against — the UI shows no impact line
    expect(jest.mocked(relayFetch).mock.calls.length).toBe(1); // never a second quote for impact
  });

  test('V8: executing without a published direction fails closed (no guessed zero_for_one)', async () => {
    const math = {amountIn: '100000000', grossOut: '190000000', minOut: '188000000', netOut: '189990000', inFee: '10000', outFee: '10000', slippageBps: 100, impactBps: null, impactWarn: false};
    await expect(prepareConvertRecord({
      secretHex: '00'.repeat(32),
      relayUrl: 'http://relay',
      quote: quote({zeroForOne: null}),
      math,
      inDesc: ICP_DESC,
      outDesc: VCHF_DESC,
    })).rejects.toThrow(convertEn.errors.quoteUnavailable('direction'));
  });
});

// --- V5: the relay's served venue list — the chooser's data source --------------------------------
// loadVenueRegistry is the ONE wire read of GET /api/v1/venues per relay per session; its output
// arms the runtime overlay (`setRuntimeVenues`) that `venuesForPair` reads. Failure of any kind
// falls back to the bundled (drift-alarmed) registry — the chooser never invents a venue.
describe('loadVenueRegistry — cache + bundled fallback (V5)', () => {
  const FIXTURE_POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7';
  const servedBodies = (second: boolean) => fakeRes({
    venues: [
      {venue_id: 'icpswap', display_name: 'ICPSwap', kind: 'ic_amm', endpoint: POOL, pair_ledgers: [ICP_LEDGER, VCHF_LEDGER], testnet: false, disclosure_key: 'icpswap'},
      ...(second ? [{venue_id: 'icpswap-fixture-b', display_name: 'ICPSwap (offline fixture)', kind: 'ic_amm', endpoint: FIXTURE_POOL_B, pair_ledgers: [VCHF_LEDGER, ICP_LEDGER], testnet: true, disclosure_key: 'icpswap'}] : []),
    ],
  });

  afterEach(() => {
    setRuntimeVenues(null); // never leak a served overlay into the other suites
  });

  test('success: caches per relay and arms the runtime overlay (venuesForPair widens)', async () => {
    jest.mocked(relayFetch).mockResolvedValueOnce(servedBodies(true) as never);
    const list = await loadVenueRegistry('http://venues-a');
    expect(list).toHaveLength(2);
    expect(list[1].venue_id).toBe('icpswap-fixture-b');
    // the overlay is what the chooser's row builder reads:
    expect(venuesForPair(ICP_LEDGER, VCHF_LEDGER).map(v => v.venue_id)).toEqual(['icpswap', 'icpswap-fixture-b']);
    // cached: a second load on the same relay never touches the wire again
    await loadVenueRegistry('http://venues-a');
    expect(jest.mocked(relayFetch).mock.calls.length).toBe(1);
    // a different relay is a different cache entry
    jest.mocked(relayFetch).mockResolvedValueOnce(servedBodies(false) as never);
    expect(await loadVenueRegistry('http://venues-b')).toHaveLength(1);
    expect(jest.mocked(relayFetch).mock.calls.length).toBe(2);
  });

  test('relay failure, bad shape, or an empty list → the bundled registry, never a guess', async () => {
    jest.mocked(relayFetch).mockRejectedValueOnce(new Error('down') as never);
    expect(await loadVenueRegistry('http://venues-err1')).toEqual([...BUNDLED_VENUES]);
    jest.mocked(relayFetch).mockResolvedValueOnce(fakeRes({}, false, 500) as never);
    expect(await loadVenueRegistry('http://venues-err2')).toEqual([...BUNDLED_VENUES]);
    // one malformed row poisons the whole list: partial truths are worse than the bundled truth
    jest.mocked(relayFetch).mockResolvedValueOnce(fakeRes({venues: [{venue_id: 'x'}]}) as never);
    expect(await loadVenueRegistry('http://venues-err3')).toEqual([...BUNDLED_VENUES]);
    jest.mocked(relayFetch).mockResolvedValueOnce(fakeRes({venues: []}) as never);
    expect(await loadVenueRegistry('http://venues-err4')).toEqual([...BUNDLED_VENUES]);
    expect(venuesForPair('i', 'o')).toEqual([]);
  });
});

describe('hydrateConvertStore — the dpay.convert.v2 record round-trip', () => {
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
      {abc123: {...rec, legs: undefined}},
      {abc123: {...rec, legs: rec.legs.slice(0, 1)}}, // two-leg trade minus one leg is not a record
      {abc123: {...rec, step: 'weird'}},
      {abc123: {...rec, failureCode: 'nope'}},
      {otherId: rec}, // record id must match its key
      {abc123: {...rec, createdAtMs: '1'}},
      {abc123: {...rec, legs: [], }}, // empty legs = CeFi shape, which requires providerRef
    ]) {
      expect(hydrateConvertStore(bad)).toBeNull();
    }
  });
  test('a record naming a venue this registry does not know is KEPT, not discarded', () => {
    // A downgrade can read a v2 store written by a newer build that knew more venues. Dropping the
    // record would hide an in-flight swap entirely; keeping it is fail-closed — the display name
    // falls back to the raw id, the endpoint lookup returns nothing, so settlement matches nothing
    // and the record can only age into its honest pending/failed states.
    const out = hydrateConvertStore({abc123: record({venueId: 'venue-from-a-newer-build'})});
    expect(out?.abc123.venueId).toBe('venue-from-a-newer-build');
    expect(out?.abc123.legs).toHaveLength(2);
  });
  test('a legs>0 record at quote/confirming is REJECTED — the no-op quadrant no driver can advance', async () => {
    // Legs signed but parked before `approving` is a shape nothing produces (prepare lands at
    // approving) and nothing can advance (the executor knows approving→…→pending_withdrawal):
    // hydration refuses it like any other malformed record instead of arming a forever no-op
    // re-arm. The refusal is read-level only — the persisted store is never nuked: a load
    // reads the store as empty and leaves the bytes on disk untouched.
    for (const step of ['quote', 'confirming'] as const) {
      expect(hydrateConvertStore({abc123: record({step})})).toBeNull();
    }
    // Every step a legs>0 record may legitimately sit at still round-trips…
    for (const step of ['approving', 'approved', 'swapping', 'settling', 'pending_withdrawal', 'done', 'failed_refunded', 'stuck'] as const) {
      const rec = record({step});
      expect(hydrateConvertStore(JSON.parse(JSON.stringify({abc123: rec})))).toEqual({abc123: rec});
    }
    // …and the rejection deletes/rewrites nothing: the poisoned store's raw bytes survive a
    // load verbatim (no removeItem, no re-setItem — the record stays recoverable on disk).
    const PUB = 'cc'.repeat(32);
    const poisoned = JSON.stringify({abc123: record({step: 'quote'})});
    await AsyncStorage.setItem(`dpay.convert.v2.${PUB}`, poisoned);
    expect(await loadConvertRecords(PUB)).toEqual({});
    expect(await AsyncStorage.getItem(`dpay.convert.v2.${PUB}`)).toBe(poisoned);
  });
  test('a CeFi-shaped record — empty legs + providerRef — round-trips', () => {
    const rec = record({
      step: 'awaiting_deposit',
      legs: [],
      providerRef: {orderId: 'ocp-7', statusUrl: 'https://provider.example/o/ocp-7'},
    });
    const out = hydrateConvertStore(JSON.parse(JSON.stringify({abc123: rec})));
    expect(out).toEqual({abc123: rec});
  });
  test('the CeFi-shaped states all round-trip (hydration today; drivers are a later wave)', () => {
    for (const step of ['awaiting_user_authorization', 'awaiting_deposit', 'provider_processing', 'quote_expired', 'provider_refunded'] as const) {
      const rec = record({step, legs: [], providerRef: {orderId: 'ocp-7'}});
      expect(hydrateConvertStore(JSON.parse(JSON.stringify({abc123: rec})))).toEqual({abc123: rec});
    }
  });
  test('a legacy dpay.convert.v1 record migrates — two envelopes become two legs, nothing is lost', () => {
    const legacy = {
      id: 'abc123',
      createdAtMs: 1,
      step: 'swapping',
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
    };
    const out = hydrateConvertStore({abc123: legacy});
    expect(out).not.toBeNull();
    const rec = out!.abc123!;
    // The two signed updates become legs IN SUBMISSION ORDER, bytes frozen verbatim.
    expect(rec.legs).toEqual([
      {canister: ICP_LEDGER, method: 'icrc2_approve', argHex: '', envelopeHex: 'aacc', requestIdHex: 'bbdd', expiresAtMs: 601_000},
      {canister: POOL, method: 'depositFromAndSwap', argHex: '', envelopeHex: 'ccaa', requestIdHex: 'ddbb', expiresAtMs: 601_000},
    ]);
    // venueId is derived from the record's own pair via the registry; nothing else changes shape.
    expect(rec.venueId).toBe(VENUE.venue_id);
    expect(rec.amountIn).toBe('100000000');
    expect(rec.expectedGross).toBe('190000000');
    expect(rec.step).toBe('swapping');
    // The v1-only fields are gone: the migrated record IS the v2 shape (no amountOutMin/zeroForOne
    // dangling to confuse a future reader).
    expect('amountOutMin' in rec).toBe(false);
    expect('zeroForOne' in rec).toBe(false);
    expect('approveEnvelopeHex' in rec).toBe(false);
  });
  test('saveConvertRecord → loadConvertRecords round-trip via the IDENTITY-SCOPED key', async () => {
    const PUB = 'aa'.repeat(32);
    await AsyncStorage.setItem(`dpay.convert.v2.${PUB}`, 'not json at all');
    expect(await loadConvertRecords(PUB)).toEqual({}); // corrupt store is empty, not fatal
    const rec = record({step: 'stuck', failureCode: 'unknown'});
    const {saveConvertRecord} = await import('../convert');
    await saveConvertRecord(PUB, rec);
    expect(await loadConvertRecords(PUB)).toEqual({abc123: rec});
    // The store is scoped: a DIFFERENT identity sees none of it (V6 — the only per-wallet store
    // that used to be unscoped).
    expect(await loadConvertRecords('bb'.repeat(32))).toEqual({});
  });
  test('loadConvertRecords migrates a legacy v1 store: persisted as scoped v2, v1 key removed', async () => {
    const PUB = 'aa'.repeat(32);
    const legacy = {
      id: 'abc123',
      createdAtMs: 1,
      step: 'swapping',
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
    };
    await AsyncStorage.setItem('dpay.convert.v1', JSON.stringify({abc123: legacy}));
    const loaded = await loadConvertRecords(PUB);
    expect(loaded.abc123?.venueId).toBe(VENUE.venue_id);
    expect(loaded.abc123?.legs).toHaveLength(2);
    // The SCOPED v2 store now holds the migrated record and the v1 key is GONE (one-time migration).
    const v2raw = await AsyncStorage.getItem(`dpay.convert.v2.${PUB}`);
    expect(JSON.parse(v2raw!).abc123.legs).toHaveLength(2);
    expect(await AsyncStorage.getItem('dpay.convert.v1')).toBeNull();
    // A second load reads the scoped store directly — the migration never runs twice.
    expect(await loadConvertRecords(PUB)).toEqual(loaded);
  });
  test('the pre-scoping unscoped v2 store is ADOPTED into the loading identity\'s scoped key, then retired', async () => {
    // The founder device's real records (V6): every record lived under one unscoped key written
    // by the single active identity. The first load under the scoped schema copies them into the
    // identity-scoped key and removes the unscoped one — the same one-time-migration shape the
    // v1 key uses — so a second identity cannot inherit (and later drive with the wrong keys)
    // records it never signed.
    const PUB = 'aa'.repeat(32);
    const rec = record({step: 'swapping'});
    await AsyncStorage.setItem('dpay.convert.v2', JSON.stringify({abc123: rec}));
    const loaded = await loadConvertRecords(PUB);
    expect(loaded.abc123?.id).toBe('abc123');
    expect(JSON.parse((await AsyncStorage.getItem(`dpay.convert.v2.${PUB}`))!)).toEqual({abc123: rec});
    expect(await AsyncStorage.getItem('dpay.convert.v2')).toBeNull(); // retired, not left behind
    expect(await loadConvertRecords('cc'.repeat(32))).toEqual({}); // nobody else inherits them
    // An empty unscoped store adopts nothing and still falls through to the v1 check.
    await AsyncStorage.setItem('dpay.convert.v2', JSON.stringify({}));
    expect(await loadConvertRecords('dd'.repeat(32))).toEqual({});
    expect(await AsyncStorage.getItem('dpay.convert.v2')).toBeNull();
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
      POOL, '', '', '100010000', '100010000', '1700000000000000000', '', '10000',
    );
    expect(DpayCore.icpDepositAndSwapArg).toHaveBeenCalledWith('100000000', '188000000', '10000', '10000', true);
    expect(DpayCore.icpSignUpdate).toHaveBeenCalledWith('sec', ICP_DESC.ledger, 'icrc2_approve', 'approve-arg-hex', '1700000000000000000');
    expect(DpayCore.icpSignUpdate).toHaveBeenCalledWith('sec', POOL, 'depositFromAndSwap', 'swap-arg-hex', '1700000000000000000');
    expect(rec.step).toBe('approving');
    // The signed updates live as legs, in submission order, carrying their own targets.
    expect(rec.venueId).toBe(VENUE.venue_id);
    expect(rec.legs).toHaveLength(2);
    expect(rec.legs[0]).toEqual({
      canister: ICP_DESC.ledger,
      method: 'icrc2_approve',
      argHex: 'approve-arg-hex',
      envelopeHex: 'env-icrc2_approve',
      requestIdHex: 'req-icrc2_approve',
      expiresAtMs: expect.any(Number),
    });
    expect(rec.legs[1]).toEqual({
      canister: POOL,
      method: 'depositFromAndSwap',
      argHex: 'swap-arg-hex',
      envelopeHex: 'env-depositFromAndSwap',
      requestIdHex: 'req-depositFromAndSwap',
      expiresAtMs: expect.any(Number),
    });
    expect(rec.inSymbol).toBe('ICP');
    // Backing symbol straight from the catalog — the relay's compiled catalog pins VCHF's
    // backing_symbol to 'VCHF' intentionally (issuer token, same rule as VEUR), so the record
    // carries the catalog's own words, never a hardcoded CHF/ledger id.
    expect(rec.outSymbol).toBe(VCHF_DESC.backing_symbol ?? VCHF_DESC.symbol);
    expect(rec.legs[0]!.expiresAtMs).toBeGreaterThan(Date.now() + (CONVERT_APPROVE_LIFETIME_S - 5) * 1000);
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
    jest.mocked(relayFetch).mockImplementation(async (_relay: unknown, path: unknown) =>
    (String(path).includes('currency=7') ? rowsRes([{from: POOL, to: myPrincipal, amount: '190000000', currency: 7, timestamp: 77}]) : rowsRes([])) as never);
    const final = await executeConvert(record(), d, OPTS);
    expect(final.step).toBe('done');
    expect(final.outAmountNet).toBe('190000000');
    expect(final.outTx).toBe('77');
    // identical persisted bytes, in order: approve on the input ledger, swap on the pool.
    expect(jest.mocked(submitTransfer).mock.calls[0]![0]).toEqual({ledger: ICP_LEDGER, envelopeHex: 'aacc', requestIdHex: 'bbdd'});
    expect(jest.mocked(submitTransfer).mock.calls[1]![0]).toEqual({ledger: POOL, envelopeHex: 'ccaa', requestIdHex: 'ddbb'});
    // every step change was surfaced + persisted (under the executor's OWN identity scope)
    const steps = d.onUpdate.mock.calls.map((c: unknown[]) => (c[0] as ConvertRecord).step);
    expect(steps).toEqual(['approved', 'swapping', 'settling', 'done']);
    expect((await loadConvertRecords('pub')).abc123?.step).toBe('done');
  });

  test("a 'unknown' submit retries the SAME signed bytes, never rebuilds args", async () => {
    const d = deps();
    jest.mocked(submitTransfer)
      .mockResolvedValueOnce({kind: 'unknown'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never) // approve, attempt 2
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '2'} as never); // swap
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    jest.mocked(relayFetch).mockResolvedValue(rowsRes([{from: POOL, to: myPrincipal, amount: '190000000', currency: 7, timestamp: 9}]) as never);
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
    expect(jest.mocked(submitTransfer).mock.calls.filter((c) => c[0].ledger === POOL)).toHaveLength(2); // retried same bytes
  });

  test('no output row in budget → pending_withdrawal; resume only re-watches (no resubmission)', async () => {
    const d = deps();
    jest.mocked(submitTransfer)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '2'} as never);
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    jest.mocked(relayFetch).mockResolvedValue(rowsRes([]) as never);
    const pending = await executeConvert(record(), d, OPTS);
    expect(pending.step).toBe('pending_withdrawal');
    const submitsBefore = jest.mocked(submitTransfer).mock.calls.length;

    // the payout lands; a resumed run (screen open, executor re-armed) flips it to done
    jest.mocked(relayFetch).mockImplementation(async (_relay: unknown, path: unknown) =>
    (String(path).includes('currency=7') ? rowsRes([{from: POOL, to: myPrincipal, amount: '190000000', currency: 7, timestamp: 55}]) : rowsRes([])) as never);
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
    jest.mocked(relayFetch).mockImplementation(async (_relay: unknown, path: unknown) =>
    (String(path).includes('currency=8') ? rowsRes([{from: POOL, to: myPrincipal, amount: '100000000', currency: 8, timestamp: 3}]) : rowsRes([])) as never);
    const final = await executeConvert(record(), d, OPTS);
    expect(final.step).toBe('failed_refunded');
    expect(final.failureCode).toBe('refunded');
  });
});

// --- V6: the expiry-honest recovery trichotomy ------------------------------------------------------
// (a) unconfirmed + unexpired → resubmit the SAME bytes (pinned above); (b) unconfirmed +
// EXPIRED → NEVER resubmit (resubmitting dead bytes is pointless AND the signed update may
// already have executed — outcome UNKNOWN): probe the ledgers, resolve what resolves, else park
// on `stuck` (never `quote_expired` — quote staleness is a provider-quote event, not leg
// expiry); (c) venue-refused before value moved → failed_refunded (pinned above).
describe('executeConvert — expiry-honest recovery (V6 trichotomy arm b)', () => {
  const deps = (claimedOutTx?: ReadonlySet<string>) =>
    ({secretHex: 'sec', publicHex: 'pub', relayUrl: 'http://r', onUpdate: jest.fn(), claimedOutTx});
  const expiredLegs = () => [
    {...record().legs[0]!, expiresAtMs: Date.now() - 60_000},
    {...record().legs[1]!, expiresAtMs: Date.now() - 60_000},
  ];
  const rowsFor = (out: unknown[], inn: unknown[]) =>
    jest.mocked(relayFetch).mockImplementation(async (_relay: unknown, path: unknown) =>
      (String(path).includes('currency=7') ? rowsRes(out) : rowsRes(inn)) as never);

  test('expired unconfirmed legs are NEVER resubmitted — the executor goes straight to watching', async () => {
    const d = deps();
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'settled', blockIndex: '9'} as never);
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    rowsFor([], []);
    const final = await executeConvert(record({step: 'swapping', legs: expiredLegs()}), d, OPTS);
    expect(final.step).toBe('stuck'); // honest unknown — NOT quote_expired (different event)
    expect(final.failureCode).toBe('unknown');
    expect(submitTransfer).not.toHaveBeenCalled(); // the red line: dead bytes are dead
    expect((await loadConvertRecords('pub')).abc123?.step).toBe('stuck'); // persisted, scoped
  });

  test('expired + the payout already landed → done (the signed update DID execute)', async () => {
    const d = deps();
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    rowsFor([{from: POOL, to: myPrincipal, amount: '190000000', currency: 7, block: 555, timestamp: 77}], []);
    const final = await executeConvert(record({step: 'swapping', legs: expiredLegs()}), d, OPTS);
    expect(final.step).toBe('done');
    expect(final.outAmountNet).toBe('190000000');
    expect(final.outTx).toBe('555'); // the BLOCK identity — durable, not the display timestamp
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  test('expired + refund row on the input ledger → failed_refunded (the venue refused after all)', async () => {
    const d = deps();
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    rowsFor([], [{from: POOL, to: myPrincipal, amount: '100000000', currency: 8, timestamp: 5}]);
    const final = await executeConvert(record({step: 'approving', legs: expiredLegs()}), d, OPTS);
    expect(final.step).toBe('failed_refunded');
    expect(final.failureCode).toBe('refunded');
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  test('an amount BETWEEN net and gross still matches — the payout RANGE, not one exact figure (V6 widening)', async () => {
    const d = deps();
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    // 189 995 000 sits between expectedNet (189 990 000) and expectedGross (190 000 000):
    // a production pool deducting part of the output fee lands here, and the PoC's
    // exact-figure-only probe would have called it "unknown".
    rowsFor([{from: POOL, to: myPrincipal, amount: '189995000', currency: 7, block: 9, timestamp: 9}], []);
    const final = await executeConvert(record({step: 'swapping', legs: expiredLegs()}), d, OPTS);
    expect(final.step).toBe('done');
    expect(final.outAmountNet).toBe('189995000');
  });

  test('a payout BELOW the recorded net never matches (fail-closed posture unchanged)', async () => {
    const d = deps();
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    rowsFor([{from: POOL, to: myPrincipal, amount: '189000000', currency: 7, block: 4, timestamp: 4}], []);
    const final = await executeConvert(record({step: 'swapping', legs: expiredLegs()}), d, OPTS);
    expect(final.step).toBe('stuck'); // unknown, never optimistic done
  });

  test('a row another record already claimed as ITS payout is skipped (one row settles one conversion)', async () => {
    const d = deps(new Set(['555']));
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    rowsFor([
      {from: POOL, to: myPrincipal, amount: '190000000', currency: 7, block: 555, timestamp: 1},
      {from: POOL, to: myPrincipal, amount: '189990000', currency: 7, block: 556, timestamp: 2},
    ], []);
    const final = await executeConvert(record({step: 'swapping', legs: expiredLegs()}), d, OPTS);
    expect(final.step).toBe('done');
    expect(final.outTx).toBe('556'); // the claimed row was refused; the free one settled it
  });
});

describe('fail-closed copy — all four locales carry it', () => {
  const domains = {en: convertEn, de: convertDe, es: convertEs, fr: convertFr};
  test.each(Object.entries(domains))('%s: counterparty names the venue that was passed in; venue-less copy is honest', (_locale: string, d: typeof convertEn) => {
    // The venue NAME is an argument (the registry's display name), so a locale renders whichever
    // venue the quote is attributed to — no locale may hardcode it (V1).
    expect(d.counterparty(VENUE.display_name)).toContain(VENUE.display_name);
    expect(d.counterparty(VENUE.display_name)).not.toContain(POOL); // the principal is not copy
    expect(d.unavailableTitle('X')).toContain('X');
    expect(d.unavailableBody('ICP ↔ Swiss francs (VCHF)', VENUE.display_name)).toContain(VENUE.display_name);
    // The saturated direct-pool refusal (spec §1) — parameterized by venue (Wave-2): the line
    // names WHOSE saturated pool it is, in every locale.
    expect(d.unavailableCkusdc('SomeFutureVenue')).toContain('SomeFutureVenue');
    expect(d.dpayFeeLine.length).toBeGreaterThan(0); // "dpay charges nothing and is paid nothing"
    // The parameterized copy still speaks the passed-in venue, not a baked one.
    expect(d.quoteSource('12:00', 'SomeFutureVenue')).toContain('SomeFutureVenue');
    expect(d.errors.quoteRefused('SomeFutureVenue')).toContain('SomeFutureVenue');
  });
  test('no locale hardcodes a venue display name anymore (ICPSwap appears in no copy source)', () => {
    for (const d of Object.values(domains)) {
      const samples = [
        d.counterparty('V'),
        d.unavailableBody('pair', 'V'),
        d.quoteSource('now', 'V'),
        d.poolFeeTier('0.30%', 'V'),
        d.impactUnavailable('V'),
        d.swappingBody('V'),
        d.failedSwapBody('why', 'SYM', 'V'),
        d.stuckSigned('1', '2', 'V'),
        d.errors.quoteUnreachable('V'),
        d.errors.quoteRefused('V'),
      ];
      for (const s of samples) expect(s).not.toContain('ICPSwap');
    }
  });
});
