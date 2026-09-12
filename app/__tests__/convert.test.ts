/**
 * app/convert.ts — the delegated-conversion §4 state machine, derivations, persistence, and
 * fail-closed venue resolution (spec 2026-09-07 §6). The swap-arg/min-out BYTES and the pool
 * reply decode belong to the compiled core (`crates/dpay-icp`, reached through wasm/FFI) and are
 * pinned by its own goldens; this suite pins the module's own logic with the FFI mocked:
 *   * derivations: net-out, staleness (incl. the test seam);
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
  probeConvertSettlement,
  salvageConvertStore,
  type ConvertQuote,
  type ConvertRecord,
} from '../convert';
import {resolveConvertDirection} from '../config/convert';
import {BUNDLED_VENUES, setRuntimeVenues, venueDisplayName, venueEndpointOf, venuesForPair, type VenueEntry} from '../config/venues';
import {loadTxNotes} from '../services/txNotes';
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

/** A pre-legs (v1 store) record as it was persisted — the migrateLegacyRecord input shape. */
const legacyRecord = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});

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
  });
  test('net floors at zero when the output fee exceeds the gross', async () => {
    jest.mocked(DpayCore.icpSwapMinOut).mockResolvedValue('0' as never);
    const m = await deriveConvertMath(quote({amountOutGross: '5000'}), '10000', '10000', 300);
    expect(m.netOut).toBe('0');
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

describe('fetchConvertQuote — the venue verbatim, ONE call, nothing derived', () => {
  const swapRes = (amountIn: string, amountOut: string, zeroForOne = true) =>
    fakeRes({venue_id: VENUE.venue_id, pool: POOL, token_in: 'a', token_out: 'b', amount_in: amountIn, amount_out: amountOut, zero_for_one: zeroForOne, fee_millionths: 3000, fetched_at: 1});
  // V8 red line (2026-09-11): dpay displays what the venue publishes and derives ONLY what it
  // does not. The venue publishes no price-impact figure, so there is no impact to measure, no
  // second reference quote to fetch, and no impact field on the quote — one venue, ONE call per
  // keystroke for EVERY venue kind. This pin replaces the eight-point live-curve table that used
  // to live here: a re-introduced reference fetch (which would double per-venue quote traffic in
  // the chooser and present a curve-slope estimate as venue fact) is RED on the call count.
  test('echoes the venue quote (attribution included) with exactly ONE relay call — no reference trade', async () => {
    jest.mocked(relayFetch).mockResolvedValueOnce(swapRes('1000000', '1900000') as never);
    const q = await fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '1000000');
    expect(q.venueId).toBe(VENUE.venue_id);
    expect(q.pool).toBe(POOL);
    expect(q.amountIn).toBe('1000000');
    expect(q.amountOutGross).toBe('1900000');
    expect(q.zeroForOne).toBe(true);
    expect(jest.mocked(relayFetch).mock.calls.length).toBe(1); // never a second quote — not for ic_amm either
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
  //     instant, and no venue kind ever pays for a second (derived-figure) quote.
  test('V8: a reply without zero_for_one is valid (null, not malformed); fetchedAtMs is the relay fetched_at, not the device clock', async () => {
    const noDirection = fakeRes({venue_id: VENUE.venue_id, pool: POOL, token_in: 'a', token_out: 'b', amount_in: '100000000', amount_out: '190000000', fee_millionths: 3000, fetched_at: 1});
    jest.mocked(relayFetch).mockResolvedValueOnce(noDirection as never);
    const q = await fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '100000000');
    expect(q.zeroForOne).toBeNull(); // a venue without an AMM direction flag is not "malformed"
    expect(q.fetchedAtMs).toBe(1_000); // fetched_at seconds → ms, the venue-read instant
  });

  test('V8: a cefi venue gets one call — the same one-call rule as every other kind', async () => {
    const cefi: VenueEntry = {venue_id: 'cefi-x', display_name: 'CeFi X', kind: 'cefi', endpoint: 'https://api.cefi.example', pair_ledgers: [ICP_LEDGER, VCHF_LEDGER], testnet: false, disclosure_key: 'cefix'};
    jest.mocked(relayFetch).mockResolvedValueOnce(swapRes('100000000', '190000000') as never);
    await fetchConvertQuote('http://relay', ICP_LEDGER, VCHF_LEDGER, '100000000', {venue: cefi});
    expect(jest.mocked(relayFetch).mock.calls.length).toBe(1); // never a second quote for a derived figure
  });

  test('V8: executing without a published direction fails closed (no guessed zero_for_one)', async () => {
    const math = {amountIn: '100000000', grossOut: '190000000', minOut: '188000000', netOut: '189990000', inFee: '10000', outFee: '10000', slippageBps: 100};
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
  test('corrupt RECORDS are dropped per-record — never a thrown error, never a half-record, never a bricked store', () => {
    // 2026-09-11 honesty fix: this used to pin all-or-nothing hydration — one bad record nulled
    // the WHOLE store (and, on a legacy key, destroyed the source). Salvage is per-record now:
    // each corrupt record below is dropped and nothing else is lost.
    const rec = record();
    for (const bad of [null, [], 'x', {a: 'nope'}]) {
      expect(hydrateConvertStore(bad)).toEqual({}); // nothing salvageable — an empty working set
    }
    const oneBad = [
      {abc123: {...rec, legs: undefined}},
      {abc123: {...rec, legs: rec.legs.slice(0, 1)}}, // two-leg trade minus one leg is not a record
      {abc123: {...rec, step: 'weird'}},
      {abc123: {...rec, failureCode: 'nope'}},
      {otherId: rec}, // record id must match its key
      {abc123: {...rec, createdAtMs: '1'}},
      {abc123: {...rec, legs: []}}, // empty legs = CeFi shape, which requires providerRef
    ];
    for (const bad of oneBad) {
      expect(hydrateConvertStore(bad)).toEqual({}); // the corrupt record alone is dropped
      expect(salvageConvertStore(bad).dropped).toBe(1);
    }
    // The money-adjacent core of the fix: one corrupt record among several kills ONLY itself.
    const mixed = {
      good1: record({id: 'good1'}),
      abc123: {...rec, step: 'weird'},
      good2: record({id: 'good2'}),
    };
    const out = salvageConvertStore(mixed);
    expect(Object.keys(out.records).sort()).toEqual(['good1', 'good2']);
    expect(out.dropped).toBe(1);
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
      expect(hydrateConvertStore({abc123: record({step})})).toEqual({}); // dropped by salvage
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
  test('a legs==0 record at an IC-driver step is REJECTED — the provider driver can never advance it', () => {
    // The mirror hole of the quadrant above: a legless record parked at approving/swapping/
    // settling (…) carries only a providerRef, but the provider driver's transition matrix
    // never touches IC steps and the IC executor has no legs to submit — the resume engine
    // would arm an eternal 10 s no-op poll. Malformed-by-construction → dropped by salvage,
    // same as any other corrupt record.
    for (const step of ['quote', 'confirming', 'approving', 'approved', 'swapping', 'settling', 'pending_withdrawal', 'failed_refunded', 'stuck'] as const) {
      expect(hydrateConvertStore({abc123: record({step, legs: [], providerRef: {orderId: 'ocp-7'}})})).toEqual({});
    }
  });
  test('a legs>0 record at a PROVIDER-only step is REJECTED — the IC executor can never advance it', () => {
    // The closing mirror: a legs-bearing record parked in the provider vocabulary (every step
    // except the shared terminal `done`) is driverless from the other side — the provider
    // driver only picks legless records and the IC executor's transition set never visits
    // those steps. Same eternal no-op poll, same refusal. `done` stays legal: it is the one
    // terminal BOTH drivers share (a settled legs>0 record lives there).
    for (const step of ['awaiting_user_authorization', 'awaiting_deposit', 'provider_processing', 'quote_expired', 'provider_refunded'] as const) {
      expect(hydrateConvertStore({abc123: record({step})})).toEqual({}); // legs intact (2) → dropped
    }
    const settled = record({step: 'done'});
    expect(hydrateConvertStore(JSON.parse(JSON.stringify({abc123: settled})))).toEqual({abc123: settled});
  });
  test('a poisoned SCOPED store is salvaged per-record: valid records load, bytes stay until the next save rewrites clean', async () => {
    // The pre-fix behavior this replaces: poisoned scoped bytes bricked the store (load read
    // {} forever) and the first saveConvertRecord then OVERWROTE the siblings with the one new
    // record — their bytes died with the corruption. Salvage keeps every sibling in the working
    // set; a load rewrites nothing (the bytes stay recoverable on disk); the next save rebuilds
    // the store clean around the survivors — the corrupt record's bytes are the only casualty.
    const PUB = 'ee'.repeat(32);
    const good = record({id: 'good1'});
    const poisoned = JSON.stringify({good1: good, abc123: record({step: 'quote'})});
    await AsyncStorage.setItem(`dpay.convert.v2.${PUB}`, poisoned);
    expect(await loadConvertRecords(PUB)).toEqual({good1: good}); // the sibling survives the poison
    expect(await AsyncStorage.getItem(`dpay.convert.v2.${PUB}`)).toBe(poisoned); // load rewrites nothing
    const {saveConvertRecord} = await import('../convert');
    await saveConvertRecord(PUB, record({id: 'fresh'}));
    const after = await loadConvertRecords(PUB);
    expect(Object.keys(after).sort()).toEqual(['fresh', 'good1']);
    // Clean bytes now: the store on disk is exactly the salvaged working set + the new record —
    // the corrupt record's bytes are gone (structural equality; hydration rebuilds field order).
    expect(JSON.parse((await AsyncStorage.getItem(`dpay.convert.v2.${PUB}`))!)).toEqual(after);
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
  test('the v1 fallback venue id DERIVES from the bundled registry — never the literal it used to be', () => {
    // A pair the registry no longer resolves (a ledger retired since v1) hits the migration
    // fallback. It must derive the bundled MAINNET IC-AMM id — a real registry key, resolved the
    // same way ConvertMode derives its standing disclosure — so the swap leg targets that
    // venue's own endpoint. The literal 'icpswap' this replaces was the only venue id outside
    // the registry in non-test app code: a registry rename would have left it dangling.
    const legacy = {
      id: 'orphan',
      createdAtMs: 1,
      step: 'swapping',
      inCurrency: 8,
      outCurrency: 7,
      inLedger: 'xh3np-hyaaa-aaaaa-aaaqq-cai', // invented — resolves to NO registry venue
      outLedger: 'xh3np-hyaaa-aaaaa-aaarq-cai',
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
    const out = hydrateConvertStore({orphan: legacy});
    expect(out).not.toBeNull();
    const rec = out!.orphan!;
    const bundledMainnet = BUNDLED_VENUES.find(v => v.kind === 'ic_amm' && !v.testnet)!;
    expect(rec.venueId).toBe(bundledMainnet.venue_id);
    // The derived id is a REAL registry key: its own endpoint is where the swap leg lands.
    expect(rec.legs[1]!.canister).toBe(venueEndpointOf(bundledMainnet.venue_id));
    expect(venueEndpointOf(bundledMainnet.venue_id)).not.toBe('');
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
  test('a PARTIALLY corrupt legacy v1 store: valid records migrate, the v1 KEY SURVIVES on disk', async () => {
    // One unreadable record must not destroy its siblings NOR delete the source. The valid
    // records are copied into the scoped store; because salvage was not total, the legacy key
    // STAYS on disk (data preserved for manual recovery) — never removed after a partial copy.
    const PUB = 'aa'.repeat(32);
    await AsyncStorage.setItem('dpay.convert.v1', JSON.stringify({
      good1: legacyRecord({id: 'good1'}),
      bad1: legacyRecord({id: 'bad1', inLedger: undefined}),
    }));
    const loaded = await loadConvertRecords(PUB);
    expect(Object.keys(loaded)).toEqual(['good1']);
    expect(loaded.good1?.legs).toHaveLength(2);
    expect(JSON.parse((await AsyncStorage.getItem(`dpay.convert.v2.${PUB}`))!)).toEqual(loaded); // valid records copied
    expect(await AsyncStorage.getItem('dpay.convert.v1')).not.toBeNull(); // source preserved — salvage was not total
  });
  test('a PARTIALLY corrupt unscoped v2 store: valid records adopt, the unscoped KEY SURVIVES on disk', async () => {
    const PUB = 'aa'.repeat(32);
    const good = record({id: 'good1'});
    await AsyncStorage.setItem('dpay.convert.v2', JSON.stringify({good1: good, abc123: {...record(), step: 'weird'}}));
    expect(await loadConvertRecords(PUB)).toEqual({good1: good});
    expect(JSON.parse((await AsyncStorage.getItem(`dpay.convert.v2.${PUB}`))!)).toEqual({good1: good});
    expect(await AsyncStorage.getItem('dpay.convert.v2')).not.toBeNull(); // kept — salvage was not total
  });
  test('BOTH legacy sources fold in ONE pass: v1 migrated first, unscoped v2 overlays on id collision', async () => {
    // The pre-fix hole: a non-empty unscoped v2 store returned early and orphaned the v1 key —
    // its records were never migrated and never would be (a scoped store now existed). One
    // hydration pass folds both sources: v1 (the older generation) first, unscoped v2
    // OVERLAYING it where ids collide (the newer generation wins), one scoped write, both keys
    // retired — a second identity still inherits nothing.
    const PUB = 'aa'.repeat(32);
    await AsyncStorage.setItem('dpay.convert.v1', JSON.stringify({
      old1: legacyRecord({id: 'old1'}),
      shared: legacyRecord({id: 'shared', approveEnvelopeHex: 'v1env'}),
    }));
    const sharedV2 = record({id: 'shared', step: 'settling'});
    await AsyncStorage.setItem('dpay.convert.v2', JSON.stringify({shared: sharedV2, unscoped1: record({id: 'unscoped1'})}));
    const loaded = await loadConvertRecords(PUB);
    expect(Object.keys(loaded).sort()).toEqual(['old1', 'shared', 'unscoped1']);
    expect(loaded.shared).toEqual(sharedV2); // unscoped v2 wins the collision…
    expect(loaded.shared?.legs[0]?.envelopeHex).toBe('aacc'); // …not v1's 'v1env' bytes
    expect(await AsyncStorage.getItem('dpay.convert.v1')).toBeNull();
    expect(await AsyncStorage.getItem('dpay.convert.v2')).toBeNull();
    expect(Object.keys(JSON.parse((await AsyncStorage.getItem(`dpay.convert.v2.${PUB}`))!)).sort())
      .toEqual(['old1', 'shared', 'unscoped1']);
    expect(await loadConvertRecords('cc'.repeat(32))).toEqual({}); // nobody else inherits them
  });
});

describe('prepareConvertRecord — both envelopes built + signed exactly once, up front', () => {
  test('approve amount = amountIn + input fee, expected_allowance present; legs die at the envelopes\' OWN ingress expiry', async () => {
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
    // The legs' death is the ENVELOPES' own ingress expiry — the exact stamp icStampExpiry
    // returned for signing (the mock pins it at 1_700_000_000_000_000_000 ns), ns → ms. The
    // old pin (now + CONVERT_APPROVE_LIFETIME_S) conflated the 10-min APPROVE-ALLOWANCE death
    // (pinned above on the approve arg) with the envelopes' ~5-min ingress death — two
    // different deaths; the never-resubmit boundary now ends exactly at the real submit-death.
    expect(rec.legs[0]!.expiresAtMs).toBe(1_700_000_000_000);
    expect(rec.legs[1]!.expiresAtMs).toBe(1_700_000_000_000);
  });
  test('each leg\'s ledger decimals are FROZEN on the record — the state screens never guess a literal', async () => {
    jest.mocked(icStampExpiry).mockResolvedValue('1700000000000000000' as never);
    jest.mocked(DpayCore.icpApproveArg).mockResolvedValue('approve-arg-hex' as never);
    jest.mocked(DpayCore.icpDepositAndSwapArg).mockResolvedValue('swap-arg-hex' as never);
    jest.mocked(DpayCore.icpSignUpdate).mockImplementation(async (_s, _ledger, method) =>
      ({envelopeHex: `env-${method}`, requestIdHex: `req-${method}`}) as never);
    jest.mocked(DpayCore.icpSwapMinOut).mockResolvedValue('188000000' as never);
    const math = await deriveConvertMath(quote(), '10000', '10000', 100);
    // Today's IC reality — both legs 8 decimals:
    const rec8 = await prepareConvertRecord({secretHex: 'sec', relayUrl: 'http://r', quote: quote(), math, inDesc: ICP_DESC, outDesc: VCHF_DESC});
    expect(rec8.inDecimals).toBe(8);
    expect(rec8.outDecimals).toBe(8);
    // A future non-e8s output ledger freezes ITS own decimals…
    const rec6 = await prepareConvertRecord({secretHex: 'sec', relayUrl: 'http://r', quote: quote(), math, inDesc: ICP_DESC, outDesc: {...VCHF_DESC, decimals: 6}});
    expect(rec6.inDecimals).toBe(8);
    expect(rec6.outDecimals).toBe(6);
    // …survives the store's per-record salvage untouched…
    const salvaged = salvageConvertStore({[rec6.id]: rec6});
    expect(salvaged.dropped).toBe(0);
    expect(salvaged.records[rec6.id]!.outDecimals).toBe(6);
    // …and a record that predates the field (every legacy/old record — the e8s world) hydrates
    // WITHOUT it: the renderer's 8 fallback owns that, never a smuggled store default.
    const hydrated = hydrateConvertStore({abc123: record()});
    expect(hydrated.abc123!.inDecimals).toBeUndefined();
    expect(hydrated.abc123!.outDecimals).toBeUndefined();
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
    // F6: each leg's submission also left a device-saved venue-name note keyed by THAT leg's own
    // request id hex — the convert rows are venue-named in the log, not principal-prefixed. Pinned
    // here (a venue-pool fixture is beyond the browser harness; see flow 172's header).
    const notes = await loadTxNotes('pub');
    expect(notes.find(n => n.k === 'bbdd')?.who).toBe(venueDisplayName(VENUE.venue_id));
    expect(notes.find(n => n.k === 'ddbb')?.who).toBe(venueDisplayName(VENUE.venue_id));
    expect(notes.find(n => n.k === 'bbdd')?.msg).toBeUndefined(); // venue rows carry a name, never a message
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
    expect(final.refundTx).toBe('3'); // the row identity — the record's CLAIM on that refund row
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
    expect(final.refundTx).toBe('5'); // the claim — a sibling record's probe will refuse this row
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

// --- 2026-09-11: the refund match is CONSTRAINED ---------------------------------------------------
// A refund returns the user's OWN input asset, so an inbound row from the venue proves nothing
// by itself: the amount must be positive and ≤ amountIn + inFee (the venue cannot refund more
// than it took), and a row another record already claimed as ITS refund settles exactly one
// record — one ledger row, one conversion, on both sides of the venue's ledger traffic.
describe('the constrained refund match', () => {
  const refundProbe = async (rows: unknown[], excludeRefundTx?: ReadonlySet<string>) => {
    jest.mocked(relayFetch).mockImplementation(async (_relay: unknown, path: unknown) =>
      (String(path).includes('currency=8') ? rowsRes(rows) : rowsRes([])) as never);
    return probeConvertSettlement({
      relayUrl: 'http://r', publicHex: 'pub', myPrincipalLower: myPrincipal,
      record: record({step: 'settling'}), excludeRefundTx,
    });
  };

  test('a plausible refund matches: positive and ≤ amountIn + inFee (the ceiling itself matches)', async () => {
    expect(await refundProbe([{from: POOL, to: myPrincipal, amount: '100010000', currency: 8, block: 5}]))
      .toEqual({kind: 'refund', tx: '5'}); // exactly amountIn + inFee — the most the venue took
    expect(await refundProbe([{from: POOL, to: myPrincipal, amount: '100000000', currency: 8, block: 6}]))
      .toEqual({kind: 'refund', tx: '6'}); // the plain full refund
    expect(await refundProbe([{from: POOL, to: myPrincipal, amount: '1', currency: 8, block: 7}]))
      .toEqual({kind: 'refund', tx: '7'}); // a partial refund is still a refund
  });

  test('an over-amount / zero / unparseable / amountless inbound from the venue is NOT this record\'s refund', async () => {
    // amountIn + inFee = 100_010_000; one unit over that ceiling is some other transfer.
    expect(await refundProbe([{from: POOL, to: myPrincipal, amount: '100010001', currency: 8, block: 8}])).toBeNull();
    expect(await refundProbe([{from: POOL, to: myPrincipal, amount: '0', currency: 8, block: 9}])).toBeNull();
    expect(await refundProbe([{from: POOL, to: myPrincipal, amount: 'NaN', currency: 8, block: 10}])).toBeNull();
    expect(await refundProbe([{from: POOL, to: myPrincipal, currency: 8, block: 11}])).toBeNull(); // no amount at all
  });

  test('a refund row another record already claimed as ITS refund is skipped — one row, one record', async () => {
    const rows = [
      {from: POOL, to: myPrincipal, amount: '100000000', currency: 8, block: 5},
      {from: POOL, to: myPrincipal, amount: '99999999', currency: 8, block: 6},
    ];
    expect(await refundProbe(rows)).toEqual({kind: 'refund', tx: '5'}); // unclaimed: the row matches
    expect(await refundProbe(rows, new Set(['5']))).toEqual({kind: 'refund', tx: '6'}); // claimed → the free sibling row
    expect(await refundProbe([rows[0]], new Set(['5']))).toBeNull(); // ONLY the claimed row exists → stays unknown
  });

  test('executor level: an over-amount inbound does NOT flip a probing record to refunded — it stays the honest unknown', async () => {
    const d = {secretHex: 'sec', publicHex: 'pub', relayUrl: 'http://r', onUpdate: jest.fn()};
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    jest.mocked(relayFetch).mockImplementation(async (_relay: unknown, path: unknown) =>
      (String(path).includes('currency=8')
        ? rowsRes([{from: POOL, to: myPrincipal, amount: '200000000', currency: 8, timestamp: 3}])
        : rowsRes([])) as never);
    const final = await executeConvert(record({
      step: 'swapping',
      legs: [
        {...record().legs[0]!, expiresAtMs: Date.now() - 60_000},
        {...record().legs[1]!, expiresAtMs: Date.now() - 60_000},
      ],
    }), d, OPTS);
    expect(final.step).toBe('stuck'); // NOT failed_refunded — the venue cannot refund more than it took
    expect(final.failureCode).toBe('unknown');
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
        d.disclosures.byKey.icpswap('V'),
        d.disclosures.generic('V'),
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
