/**
 * The SideShift surface, end to end on the phone (founder decision 3, 2026-09-15):
 *
 * 1. services/sideshift — the fail-closed client vocabulary, the RAIL-ID request bodies
 *    (the relay owns the rail-id→venue-code mapping; the device never speaks coin codes),
 *    and the verbatim result shapes. Quotes and fixed-order creation go THROUGH the relay
 *    proxy (the partner credential lives server-side only); the module exposes the venue's
 *    keyless status URL for the resume engine's device-direct poll.
 * 2. convert.ts cefi helpers — ceFiQuoteFromResult (the ONE decimal→raw scaling, shared by
 *    the live quote and the confirm-time re-quote), fetchCeFiConvertQuote's venue guard +
 *    error mapping, and prepareCeFiConvertRecord's red lines (registered cefi row, pair
 *    match, the order prices the reviewed deposit, non-empty settle address) plus the
 *    record shape the resume engine drives (legs [], providerRef + providerDeposit).
 * 3. hydration — the cefi widening: a legless record on a cefi venue survives WITHOUT
 *    numeric outCurrency (the out side is a mint, not an IC catalog currency), and a
 *    providerDeposit block is validated, not trusted.
 *
 * The relay-side halves (credential attachment, 503 naming the env var, verbatim
 * passthrough) are pinned in crates/dpay-relay/tests/sideshift_proxy.rs.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';

jest.mock('../services/native', () => ({
  DpayCore: {icpSwapMinOut: jest.fn(), icpPrincipalFromPubkey: jest.fn()},
}));
jest.mock('../services/icp', () => ({icStampExpiry: jest.fn()}));
jest.mock('../services/relay', () => ({relayFetch: jest.fn()}));
jest.mock('../services/rail', () => ({submitTransfer: jest.fn()}));

import {relayFetch} from '../services/relay';
import {
  createSideShiftFixedShift,
  fetchSideShiftQuote,
  sideShiftStatusUrl,
} from '../services/sideshift';
import {
  ceFiQuoteFromResult,
  ceFiServiceError,
  fetchCeFiConvertQuote,
  hydrateConvertStore,
  loadConvertRecords,
  prepareCeFiConvertRecord,
  type ConvertQuote,
} from '../convert';
import {BUNDLED_VENUES, cefiOtherSide, cefiVenuesForLedger, venueOfId} from '../config/venues';
import {EURC_MINT_ADDRESS, USDC_MINT_ADDRESS, WRAPPED_SOL_MINT_ADDRESS} from '../solana/tokens';
import {convertEn} from '../i18n/domains/en/convert';

const RELAY = 'http://relay.local';
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai'; // the registered pair's IC side
const VENUE = venueOfId('sideshift')!;

const res = (body: unknown, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => body});
const wrap = (quote: unknown, fetchedAt = 1_757_862_400) =>
  res({venue_id: 'sideshift', quote, fetched_at: fetchedAt}, 201);

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(async () => {
  await AsyncStorage.clear();
});

// --- the client: rail ids in, verbatim venue figures out -------------------------------------------
describe('services/sideshift — the relay-proxied client', () => {
  test('a quote POSTs the RAIL ids and the decimal amount; the wrap comes back as the result', async () => {
    jest.mocked(relayFetch).mockResolvedValueOnce(
      wrap({id: 'q-1', settleAmount: '0.0495', rate: '0.02475'}) as never,
    );
    const out = await fetchSideShiftQuote(RELAY, VENUE, ICP_LEDGER, WRAPPED_SOL_MINT_ADDRESS, '2');
    expect(out).toEqual({
      venueId: 'sideshift',
      quoteId: 'q-1',
      settleAmount: '0.0495',
      rate: '0.02475',
      fetchedAtMs: 1_757_862_400_000,
    });
    const [url, path, init] = jest.mocked(relayFetch).mock.calls[0] as unknown as [
      string, string, {method: string; headers: Record<string, string>; body: string},
    ];
    expect(url).toBe(RELAY);
    expect(path).toBe('/api/v1/sideshift/quotes');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      depositLedger: ICP_LEDGER,
      settleLedger: WRAPPED_SOL_MINT_ADDRESS,
      depositAmount: '2',
    });
    // the device never sends a coin code, a network code, or any credential
    expect(init.body).not.toContain('ICP"');
    expect(Object.keys(init.headers)).not.toContain('x-sideshift-secret');
  });

  test('the fail-closed vocabulary: 503 unconfigured, readable 4xx refused, else unavailable, bad shape shape', async () => {
    const cases: Array<[number, unknown, string]> = [
      [503, {dpayRelayError: 'sideshift-unconfigured'}, 'unconfigured'],
      [400, {error: {message: 'Invalid "affiliateId"', code: 'BAD_USER_INPUT'}}, 'refused'],
      [500, {error: 'boom'}, 'unavailable'],
      [201, {venue_id: 'someone-else', quote: {id: 'q', settleAmount: '1'}}, 'shape'],
      [201, {venue_id: 'sideshift', quote: {settleAmount: '1'}}, 'shape'], // no quote id
    ];
    for (const [status, body, code] of cases) {
      jest.mocked(relayFetch).mockResolvedValueOnce(res(body, status) as never);
      await expect(
        fetchSideShiftQuote(RELAY, VENUE, ICP_LEDGER, WRAPPED_SOL_MINT_ADDRESS, '2'),
      ).rejects.toThrow(code);
    }
  });

  test('attribution is pinned to the ROW quoted: the family\'s other rows answer their own calls', async () => {
    // The venue family is several registry rows (sideshift, sideshift-usdc,
    // sideshift-eurc); the relay wraps each quote with the ROW that answered, and the
    // client accepts exactly that row's id — a sibling's attribution on the wrong call is
    // still a shape failure. (The sideshift-eurc quote — the EUR→IC bridge — is the case
    // the original hardcoded `!== 'sideshift'` check silently broke.)
    const eurcVenue = venueOfId('sideshift-eurc')!;
    jest.mocked(relayFetch).mockResolvedValueOnce(
      res({venue_id: 'sideshift-eurc', quote: {id: 'q-eurc', settleAmount: '1.17'}, fetched_at: 1_757_862_400}, 201) as never,
    );
    const out = await fetchSideShiftQuote(RELAY, eurcVenue, ICP_LEDGER, EURC_MINT_ADDRESS, '3');
    expect(out.venueId).toBe('sideshift-eurc');
    expect(out.settleAmount).toBe('1.17');
    // a sideshift-attributed wrap answering the eurc row's call is a cross-row lie
    jest.mocked(relayFetch).mockResolvedValueOnce(
      res({venue_id: 'sideshift', quote: {id: 'q', settleAmount: '1'}, fetched_at: 1_757_862_400}, 201) as never,
    );
    await expect(
      fetchSideShiftQuote(RELAY, eurcVenue, ICP_LEDGER, EURC_MINT_ADDRESS, '3'),
    ).rejects.toThrow('shape');
  });

  test('a venue row that is not the registered cefi pair is refused BEFORE any network', async () => {
    const hostile = {...VENUE, kind: 'ic_amm' as const};
    await expect(fetchSideShiftQuote(RELAY, hostile, ICP_LEDGER, WRAPPED_SOL_MINT_ADDRESS, '2'))
      .rejects.toThrow('refused');
    expect(relayFetch).not.toHaveBeenCalled();
  });

  test('fixed-order creation POSTs through the relay and returns the venue fields verbatim', async () => {
    jest.mocked(relayFetch).mockResolvedValueOnce(res({
      id: 'shift-9',
      depositAddress: 'dep-addr-01',
      depositMemo: 'mem-7',
      depositAmount: '2',
      settleAmount: '0.0495',
      expiresAt: '2026-09-16T00:00:00.000Z',
    }, 201) as never);
    const order = await createSideShiftFixedShift(RELAY, VENUE, {
      quoteId: 'q-1',
      settleAddress: 'SolSettleAddr',
      refundAddress: 'MyIcPrincipalRefund',
      depositLedger: ICP_LEDGER,
      settleMemo: 'SolSettleMemo',
    });
    expect(order).toEqual({
      id: 'shift-9',
      depositAddress: 'dep-addr-01',
      depositMemo: 'mem-7',
      depositAmount: '2',
      settleAmount: '0.0495',
      expiresAt: '2026-09-16T00:00:00.000Z',
    });
    const [, path, init] = jest.mocked(relayFetch).mock.calls[0] as unknown as [
      string, string, {body: string},
    ];
    expect(path).toBe('/api/v1/sideshift/shifts/fixed');
    expect(JSON.parse(init.body)).toEqual({
      quoteId: 'q-1',
      settleAddress: 'SolSettleAddr',
      refundAddress: 'MyIcPrincipalRefund',
      depositLedger: ICP_LEDGER,
      settleMemo: 'SolSettleMemo',
    });
    // no credential anywhere the device can see
    expect(init.body).not.toContain('secret');
  });

  test('an order WITHOUT the deposit-rail refund address is refused before any network', async () => {
    // The fund-loss class: a refundable order needs the user's OWN address on the
    // DEPOSIT rail. The client refuses the empty form outright — the relay re-checks.
    await expect(
      createSideShiftFixedShift(RELAY, VENUE, {quoteId: 'q-1', settleAddress: 'SolSettleAddr', refundAddress: '', depositLedger: ICP_LEDGER}),
    ).rejects.toThrow('refused');
    expect(relayFetch).not.toHaveBeenCalled();
  });

  test('sideShiftStatusUrl is the venue\'s own keyless GET — the relay is not in the status path', () => {
    expect(sideShiftStatusUrl('shift-9')).toBe('https://sideshift.ai/api/v2/shifts/shift-9');
  });
});

// --- the mapping helpers ----------------------------------------------------------------------------
describe('convert.ts — the cefi mapping helpers', () => {
  test('ceFiQuoteFromResult scales the venue DECIMAL into raw units exactly once, verbatim otherwise', () => {
    const quote = ceFiQuoteFromResult(VENUE, ICP_LEDGER, WRAPPED_SOL_MINT_ADDRESS, '200000000', {
      venueId: 'sideshift',
      quoteId: 'q-1',
      settleAmount: '0.0495',
      rate: '0.02475',
      fetchedAtMs: 5,
    }, 9);
    expect(quote).toEqual({
      venueId: 'sideshift',
      pool: 'https://sideshift.ai/api/v2',
      tokenInLedger: ICP_LEDGER,
      tokenOutLedger: WRAPPED_SOL_MINT_ADDRESS,
      amountIn: '200000000',
      amountOutGross: '49500000', // 0.0495 SOL at 9 decimals — scaled, never re-derived
      zeroForOne: null,
      feeMillionths: 0, // the venue's commission is inside its rate; the relay pins commissionRate "0"
      fetchedAtMs: 5,
    } satisfies ConvertQuote);
  });

  test('ceFiServiceError names the SAME honesty keys as the IC surface, plus unconfigured', () => {
    const name = 'SideShift';
    expect(ceFiServiceError(new Error('unreachable'), name).message)
      .toBe(convertEn.errors.quoteUnreachable(name));
    expect(ceFiServiceError(new Error('unconfigured'), name).message)
      .toBe(convertEn.errors.quoteUnconfigured(name));
    expect(ceFiServiceError(new Error('refused'), name).message)
      .toBe(convertEn.errors.quoteRefused(name));
    expect(ceFiServiceError(new Error('shape'), name).message)
      .toBe(convertEn.errors.quoteUnavailable('shape'));
    expect(ceFiServiceError('not an error', name).message)
      .toBe(convertEn.errors.quoteUnavailable('unavailable'));
  });

  test('fetchCeFiConvertQuote: the deposit goes out as a DECIMAL string, the settle comes back raw', async () => {
    jest.mocked(relayFetch).mockResolvedValueOnce(
      wrap({id: 'q-1', settleAmount: '0.04959689', rate: '0.0247984448'}) as never,
    );
    const quote = await fetchCeFiConvertQuote(
      RELAY, VENUE, ICP_LEDGER, WRAPPED_SOL_MINT_ADDRESS, '200000000',
      {inDecimals: 8, outDecimals: 9},
    );
    expect(quote.amountOutGross).toBe('49596890'); // toUnits('0.04959689', 9)
    const {body} = jest.mocked(relayFetch).mock.calls[0]![2] as {body: string};
    expect(JSON.parse(body).depositAmount).toBe('2'); // rawToDecimal('200000000', 8)
  });

  test('fetchCeFiConvertQuote refuses a pair the registered row does not carry, before any network', async () => {
    await expect(fetchCeFiConvertQuote(
      RELAY, VENUE, ICP_LEDGER, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '1',
      {inDecimals: 8, outDecimals: 6},
    )).rejects.toThrow(convertEn.errors.quoteUnavailable('venue'));
    expect(relayFetch).not.toHaveBeenCalled();
  });
});

// --- the registry helpers ----------------------------------------------------------------------------
describe('config/venues — the cefi registry surface', () => {
  test('the bundled sideshift rows are the cross-rail shape: IC principal + Solana mint, https base', () => {
    const rows = BUNDLED_VENUES.filter(v => v.kind === 'cefi');
    expect(rows).toHaveLength(3);
    const ss = rows[0]!;
    expect(ss.venue_id).toBe('sideshift');
    expect(ss.endpoint).toBe('https://sideshift.ai/api/v2');
    expect(ss.testnet).toBe(false);
    expect(ss.disclosure_key).toBe('sideshift');
    expect([...ss.pair_ledgers].sort()).toEqual([ICP_LEDGER, WRAPPED_SOL_MINT_ADDRESS].sort());
    // The SECOND cefi row (2026-09-16 coverage expansion): same venue family + endpoint +
    // disclosure, on the ICP ↔ USDC(Solana) pair — registry order keeps the sibling second.
    const ssUsdc = rows[1]!;
    expect(ssUsdc.venue_id).toBe('sideshift-usdc');
    expect(ssUsdc.display_name).toBe('SideShift');
    expect(ssUsdc.endpoint).toBe('https://sideshift.ai/api/v2');
    expect(ssUsdc.testnet).toBe(false);
    expect(ssUsdc.disclosure_key).toBe('sideshift');
    expect([...ssUsdc.pair_ledgers].sort()).toEqual([ICP_LEDGER, USDC_MINT_ADDRESS].sort());
    // The THIRD cefi row (2026-09-19, the EUR→IC bridge): same family + endpoint +
    // disclosure, on the ICP ↔ EURC(Solana) pair — the only registered route between the
    // two. Registry order keeps it third, beside its siblings.
    const ssEurc = rows[2]!;
    expect(ssEurc.venue_id).toBe('sideshift-eurc');
    expect(ssEurc.display_name).toBe('SideShift');
    expect(ssEurc.endpoint).toBe('https://sideshift.ai/api/v2');
    expect(ssEurc.testnet).toBe(false);
    expect(ssEurc.disclosure_key).toBe('sideshift');
    expect([...ssEurc.pair_ledgers].sort()).toEqual([ICP_LEDGER, EURC_MINT_ADDRESS].sort());
  });

  test('cefiOtherSide answers only the registered pair, either direction; cefiVenuesForLedger finds the row', () => {
    expect(cefiOtherSide(VENUE, ICP_LEDGER)).toBe(WRAPPED_SOL_MINT_ADDRESS);
    expect(cefiOtherSide(VENUE, WRAPPED_SOL_MINT_ADDRESS)).toBe(ICP_LEDGER);
    expect(cefiOtherSide(VENUE, 'ly36x-wiaaa-aaaai-aqj7q-cai')).toBeNull();
    expect(cefiVenuesForLedger(ICP_LEDGER).map(v => v.venue_id))
      .toEqual(['sideshift', 'sideshift-usdc', 'sideshift-eurc']);
    expect(cefiVenuesForLedger(WRAPPED_SOL_MINT_ADDRESS).map(v => v.venue_id)).toEqual(['sideshift']);
    expect(cefiVenuesForLedger(USDC_MINT_ADDRESS).map(v => v.venue_id)).toEqual(['sideshift-usdc']);
    expect(cefiVenuesForLedger(EURC_MINT_ADDRESS).map(v => v.venue_id)).toEqual(['sideshift-eurc']);
    expect(cefiVenuesForLedger('ly36x-wiaaa-aaaai-aqj7q-cai')).toEqual([]);
    // the IC chooser surface (ic_amm pairs) never sees the cefi rows — rails never cross there
    expect(BUNDLED_VENUES.filter(v => v.kind === 'ic_amm').every(v => v.venue_id !== 'sideshift')).toBe(true);
  });
});

// --- the record: red lines then the exact shape the resume engine drives ----------------------------
describe('prepareCeFiConvertRecord — red lines, then the handoff record', () => {
  const quote: ConvertQuote = {
    venueId: 'sideshift',
    pool: 'https://sideshift.ai/api/v2',
    tokenInLedger: ICP_LEDGER,
    tokenOutLedger: WRAPPED_SOL_MINT_ADDRESS,
    amountIn: '200000000',
    amountOutGross: '49596890',
    zeroForOne: null,
    feeMillionths: 0,
    fetchedAtMs: 5,
  };
  const order = {
    id: 'shift-9',
    depositAddress: 'dep-addr-01',
    depositMemo: null as string | null,
    depositAmount: '2',
    settleAmount: '0.04959689',
    expiresAt: '2026-09-16T00:00:00.000Z',
  };
  const args = {
    quote,
    order,
    settleAddress: 'SolSettleAddr',
    inCurrency: 8,
    inSymbol: 'ICP',
    outSymbol: 'SOL',
    inDecimals: 8,
    outDecimals: 9,
  };

  test('a quote whose venue is not the registered cefi row is refused', () => {
    const hostile: ConvertQuote = {...quote, venueId: 'icpswap'};
    expect(() => prepareCeFiConvertRecord({...args, quote: hostile}))
      .toThrow(convertEn.errors.quoteUnavailable('venue'));
  });

  test('an order that prices a DIFFERENT deposit than the reviewed quote is refused', () => {
    expect(() => prepareCeFiConvertRecord({
      ...args,
      order: {...order, depositAmount: '2.5'},
    })).toThrow(convertEn.errors.quoteUnavailable('deposit'));
  });

  test('an empty settle address or order id is refused — nothing is created half-way', () => {
    expect(() => prepareCeFiConvertRecord({...args, settleAddress: ''}))
      .toThrow(convertEn.errors.quoteUnavailable('order'));
    expect(() => prepareCeFiConvertRecord({...args, order: {...order, id: ''}}))
      .toThrow(convertEn.errors.quoteUnavailable('order'));
  });

  test('the happy record: awaiting_deposit, legless, providerRef + the deposit handoff, no dpay numbers', () => {
    const rec = prepareCeFiConvertRecord(args);
    expect(rec.step).toBe('awaiting_deposit');
    expect(rec.legs).toEqual([]);
    expect(rec.inCurrency).toBe(8);
    expect(rec.outCurrency).toBeUndefined(); // the out side is a mint, not an IC currency
    expect(rec.inFee).toBe('0');
    expect(rec.outFee).toBe('0');
    expect(rec.slippageBps).toBe(0); // a fixed shift is a locked rate
    expect(rec.expectedGross).toBe('49596890');
    expect(rec.expectedNet).toBe('49596890'); // the venue's own settle figure, nothing added
    expect(rec.providerRef).toEqual({
      orderId: 'shift-9',
      statusUrl: 'https://sideshift.ai/api/v2/shifts/shift-9', // keyless device-direct GET
    });
    expect(rec.providerDeposit).toEqual({
      depositAddress: 'dep-addr-01', // the VENUE's address — the user sends, dpay never touches funds
      depositAmount: '2',
      expiresAtMs: Date.parse('2026-09-16T00:00:00.000Z'),
    });
    expect(rec.destAddress).toBe('SolSettleAddr');
    expect(rec.destSymbol).toBe('SOL');
  });

  test('a depositMemo rides along when the venue issues one; a junk expiry is dropped, not guessed', () => {
    const withMemo = prepareCeFiConvertRecord({
      ...args,
      order: {...order, depositMemo: 'mem-7', expiresAt: 'not-a-date'},
    });
    expect(withMemo.providerDeposit!.depositMemo).toBe('mem-7');
    expect(withMemo.providerDeposit!.expiresAtMs).toBeUndefined();
  });
});

// --- hydration: the cefi widening -------------------------------------------------------------------
describe('hydrateConvertStore — the cefi record survives without numeric currencies', () => {
  const cefiRecord = prepareCeFiConvertRecord({
    quote: {
      venueId: 'sideshift',
      pool: 'https://sideshift.ai/api/v2',
      tokenInLedger: ICP_LEDGER,
      tokenOutLedger: WRAPPED_SOL_MINT_ADDRESS,
      amountIn: '200000000',
      amountOutGross: '49596890',
      zeroForOne: null,
      feeMillionths: 0,
      fetchedAtMs: 5,
    },
    order: {
      id: 'shift-9',
      depositAddress: 'dep-addr-01',
      depositMemo: null,
      depositAmount: '2',
      settleAmount: '0.04959689',
      expiresAt: '2026-09-16T00:00:00.000Z',
    },
    settleAddress: 'SolSettleAddr',
    inCurrency: 8,
    inSymbol: 'ICP',
    outSymbol: 'SOL',
    inDecimals: 8,
    outDecimals: 9,
  });

  test('a legless CEFI record hydrates whole (no outCurrency by design) and keeps its handoff', async () => {
    await AsyncStorage.setItem('dpay.convert.v2.pub1', JSON.stringify({[cefiRecord.id]: cefiRecord}));
    const loaded = await loadConvertRecords('pub1');
    expect(loaded[cefiRecord.id]).toEqual(cefiRecord);
    // the engine's provider driver owns it from here — legs==0 routes to the statusUrl poll
  });

  test('a legless record on a NON-cefi venue still needs numeric currencies — the widening is scoped', () => {
    const impostor = {...cefiRecord, venueId: 'icpswap', inCurrency: undefined, outCurrency: undefined};
    const out = hydrateConvertStore({[impostor.id]: impostor});
    expect(out[impostor.id]).toBeUndefined(); // dropped, like before the widening
    // the genuine cefi shape survives the same call
    const kept = hydrateConvertStore({[cefiRecord.id]: cefiRecord});
    expect(kept[cefiRecord.id]).toEqual(cefiRecord);
  });

  test('a corrupted providerDeposit block is refused, not repaired', () => {
    const broken = {...cefiRecord, providerDeposit: {depositAddress: '', depositAmount: '2'}};
    expect(hydrateConvertStore({[broken.id]: broken})[broken.id]).toBeUndefined();
    const noAmount = {...cefiRecord, providerDeposit: {depositAddress: 'dep-addr-01', depositAmount: ''}};
    expect(hydrateConvertStore({[noAmount.id]: noAmount})[noAmount.id]).toBeUndefined();
  });
});
