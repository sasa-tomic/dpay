/**
 * The Mt Pelerin cash-out SERVICE (app/services/mtpelerin.ts) — the relay proxy's device face
 * (plan R2 step 2). The pins, per route:
 *
 *   • quote — GET /api/v1/mtpelerin/quote?…: the relay's attribution envelope is validated
 *     (venue_id must be 'mtpelerin', destAmount a plain decimal, never defaulted) and
 *     `fetched_at` becomes the provenance instant. The fail-closed vocabulary: 503 →
 *     'unconfigured', 400/422 → 'refused', other non-2xx → 'unavailable', transport →
 *     'unreachable', unreadable body → 'shape'.
 *   • conversion (POST /api/v1/mtpelerin/conversion): LOCAL registration since the venue's
 *     API tier closed (2026-10-13). The answer is the record in the status route's shape:
 *     the correlation id rides the X-Dpay-Order-Id header AND the body's `order_id` (the
 *     pair must agree; absent → 'shape': an order that cannot be watched is never adopted),
 *     and the BORN state is pinned (terminal false, payload and venue_order_id null; a
 *     creation answer claiming venue-side facts is a 'shape' failure). The record's
 *     `offRampAddress` parses verbatim when present; null/absent is the BORN state and is
 *     fine (no dpay flow sends to it: the sale completes in the user's own widget
 *     session). The request carries the pair, the network and the amount only: bank
 *     details are the widget session's, never dpay's.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import {
  createMtpCashOrder, fetchMtpCashQuote, mtpCashStatusUrl, mtpSellNetworkOf,
} from '../services/mtpelerin';

const RELAY = 'https://relay.test';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: (n: string) => headers[n.toLowerCase()] ?? null},
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

type FetchMock = jest.Mocked<typeof fetch>;

let mockFetch: FetchMock;

beforeEach(() => {
  mockFetch = jest.fn<typeof fetch>();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchMtpCashQuote — the attribution envelope', () => {
  test('a well-formed relay answer carries the venue figure + the relay read instant', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, {
      venue_id: 'mtpelerin',
      quote: {sourceCurrency: 'ZCHF', destCurrency: 'CHF', sourceAmount: 2, destAmount: '9651.10', fees: {networkFee: '0', fixFee: 0}},
      fetched_at: 1790000000,
    }));
    const q = await fetchMtpCashQuote(RELAY, {sourceCurrency: 'ZCHF', destCurrency: 'CHF', sourceAmount: '2', sourceNetwork: 'mainnet'});
    expect(q.destAmount).toBe('9651.10'); // the venue's own string, untouched
    expect(q.fetchedAtMs).toBe(1790000000 * 1000);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain(`${RELAY}/api/v1/mtpelerin/quote?`);
    expect(url).toContain('sourceCurrency=ZCHF');
    expect(url).toContain('destCurrency=CHF');
    expect(url).toContain('sourceAmount=2');
    expect(url).toContain('sourceNetwork=mainnet');
  });

  test('a foreign venue_id is a shape failure — attribution is checked, not assumed', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, {venue_id: 'someone-else', quote: {destAmount: '1'}, fetched_at: 1}));
    await expect(fetchMtpCashQuote(RELAY, {sourceCurrency: 'ZCHF', destCurrency: 'CHF', sourceAmount: '2'})).rejects.toThrow('shape');
  });

  test('a non-numeric destAmount is a shape failure — nothing is defaulted', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, {venue_id: 'mtpelerin', quote: {destAmount: 'soon'}, fetched_at: 1}));
    await expect(fetchMtpCashQuote(RELAY, {sourceCurrency: 'ZCHF', destCurrency: 'CHF', sourceAmount: '2'})).rejects.toThrow('shape');
  });

  test.each([
    [503, 'unconfigured'],
    [400, 'refused'],
    [422, 'refused'],
    [500, 'unavailable'],
  ])('HTTP %i maps to %s', async (status, word) => {
    mockFetch.mockResolvedValue(jsonResponse(status, {}));
    await expect(fetchMtpCashQuote(RELAY, {sourceCurrency: 'ZCHF', destCurrency: 'CHF', sourceAmount: '2'})).rejects.toThrow(word);
  });

  test('a transport failure is unreachable', async () => {
    mockFetch.mockRejectedValue(new Error('socket'));
    await expect(fetchMtpCashQuote(RELAY, {sourceCurrency: 'ZCHF', destCurrency: 'CHF', sourceAmount: '2'})).rejects.toThrow('unreachable');
  });
});

describe('createMtpCashOrder - the local creation record pins', () => {
  const ARGS = {
    sourceCurrency: 'ZCHF', destCurrency: 'CHF', sourceAmount: '2', sourceNetwork: 'mainnet',
    clientOrderId: 'abc123',
  };
  const ORDER_ID = 'mtp-abc0000000000001';
  const ADDRESS = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';

  /** The relay's real creation answer (status_body): the BORN record, the venue's facts
   *  null until the completion webhook names them. */
  function bornRecord(offRampAddress: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      order_id: ORDER_ID,
      venue_order_id: null,
      offRampAddress,
      terminal: false,
      created_at: 1790000000,
      status_ts: null,
      payload: null,
      ...overrides,
    };
  }

  test('the REAL relay answer (the born record, address null) parses: header id, born venue facts, the address verbatim-null', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, bornRecord(null), {'x-dpay-order-id': ORDER_ID}));
    const o = await createMtpCashOrder(RELAY, ARGS);
    expect(o.orderId).toBe(ORDER_ID);
    expect(o.venueOrderId).toBeNull(); // born state: dpay creates no venue-side order
    expect(o.offRampAddress).toBeNull(); // the born state: no dpay flow sends to it
    expect(o.expiresAtMs).toBeNull(); // the local record carries no expiry; never invented
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.clientOrderId).toBe('abc123'); // the locally minted correlation id rides the body
    expect(body.sourceCurrency).toBe('ZCHF');
    expect(body.sourceNetwork).toBe('mainnet');
    expect(body.iban).toBeUndefined(); // bank details are the widget session's, never dpay's
    expect(body.holderName).toBeUndefined();
  });

  test('a creation record carrying a deposit address parses it verbatim (informational only)', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, bornRecord(ADDRESS), {'x-dpay-order-id': ORDER_ID}));
    const o = await createMtpCashOrder(RELAY, ARGS);
    expect(o.offRampAddress).toBe(ADDRESS);
  });

  test('an empty-string offRampAddress normalizes to null (the born state, never an empty string)', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, bornRecord('   '), {'x-dpay-order-id': ORDER_ID}));
    const o = await createMtpCashOrder(RELAY, ARGS);
    expect(o.offRampAddress).toBeNull();
  });

  test('a missing X-Dpay-Order-Id is a shape failure — an unwatchable order is never adopted', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, bornRecord(null)));
    await expect(createMtpCashOrder(RELAY, ARGS)).rejects.toThrow('shape');
  });

  test('a record whose order_id disagrees with the header is a shape failure (one correlation pair)', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, bornRecord(null, {order_id: 'mtp-other000000000001'}), {'x-dpay-order-id': ORDER_ID}));
    await expect(createMtpCashOrder(RELAY, ARGS)).rejects.toThrow('shape');
  });

  test.each([
    ['a venue id', {venue_order_id: '664369c938b3ca001a3cd44f'}],
    ['a terminal flag', {terminal: true}],
    ['a stored payload', {payload: {id: '664369c938b3ca001a3cd44f', amount: 1}}],
  ])('a creation answer claiming %s (venue-side facts dpay never created) is a shape failure', async (_label, claim) => {
    mockFetch.mockResolvedValue(jsonResponse(200, bornRecord(null, claim), {'x-dpay-order-id': ORDER_ID}));
    await expect(createMtpCashOrder(RELAY, ARGS)).rejects.toThrow('shape');
  });

  test('HTTP 503 maps to unconfigured (the fail-closed vocabulary holds on any relay refusal)', async () => {
    mockFetch.mockResolvedValue(jsonResponse(503, {dpayRelayError: 'mtpelerin-unconfigured'}));
    await expect(createMtpCashOrder(RELAY, ARGS)).rejects.toThrow('unconfigured');
  });
});

describe('route helpers', () => {
  test('the status URL is the relay route keyed on the dpay order id', () => {
    expect(mtpCashStatusUrl('https://relay.test/', 'mtp-x')).toBe('https://relay.test/api/v1/mtpelerin/conversion?id=mtp-x');
  });

  test('the venue network names are the documented spellings, fail-closed off-wired-chains', () => {
    expect(mtpSellNetworkOf(1)).toBe('mainnet');
    expect(mtpSellNetworkOf(42161)).toBe('arbitrum_mainnet');
    expect(mtpSellNetworkOf(31337)).toBeNull();
  });
});
