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
 *     the BORN state is pinned (terminal false, payload and venue_order_id null; a
 *     creation answer claiming venue-side facts is a 'shape' failure), and the deposit
 *     address is still REQUIRED and must be an EVM address (the wallet's ERC-20 send path
 *     cannot deliver anywhere else; the real born record's null address → 'shape'). The
 *     local record carries no expiry: expiresAtMs stays null, never invented.
 *   • isValidIban — the mod-97 checksum: golden valid/invalid vectors (lengths, letter
 *     positions, the checksum digit itself).
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import {
  createMtpCashOrder, fetchMtpCashQuote, isValidIban, mtpCashStatusUrl, mtpSellNetworkOf,
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
    iban: 'CH9300762011623852957', holderName: 'Ada Lovelace', clientOrderId: 'abc123',
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

  test('a creation record carrying the venue deposit address parses: header id, born venue facts, no invented expiry', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, bornRecord(ADDRESS), {'x-dpay-order-id': ORDER_ID}));
    const o = await createMtpCashOrder(RELAY, ARGS);
    expect(o.orderId).toBe(ORDER_ID);
    expect(o.venueOrderId).toBeNull(); // born state: dpay creates no venue-side order
    expect(o.offRampAddress).toBe(ADDRESS);
    expect(o.expiresAtMs).toBeNull(); // the local record carries no expiry; never invented
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.clientOrderId).toBe('abc123'); // the locally minted correlation id rides the body
    expect(body.iban).toBe('CH9300762011623852957');
  });

  test('the REAL relay answer (the born record, address null) is a shape failure: the send handoff is refused, never a guessed destination', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, bornRecord(null), {'x-dpay-order-id': ORDER_ID}));
    await expect(createMtpCashOrder(RELAY, ARGS)).rejects.toThrow('shape');
  });

  test('a non-EVM offRampAddress is a shape failure (the ERC-20 send could never deliver)', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, bornRecord('mtpelerin@ln.mtpelerin.com'), {'x-dpay-order-id': ORDER_ID}));
    await expect(createMtpCashOrder(RELAY, ARGS)).rejects.toThrow('shape');
  });

  test('a missing X-Dpay-Order-Id is a shape failure — an unwatchable order is never adopted', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, bornRecord(ADDRESS)));
    await expect(createMtpCashOrder(RELAY, ARGS)).rejects.toThrow('shape');
  });

  test('a record whose order_id disagrees with the header is a shape failure (one correlation pair)', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, bornRecord(ADDRESS, {order_id: 'mtp-other000000000001'}), {'x-dpay-order-id': ORDER_ID}));
    await expect(createMtpCashOrder(RELAY, ARGS)).rejects.toThrow('shape');
  });

  test.each([
    ['a venue id', {venue_order_id: '664369c938b3ca001a3cd44f'}],
    ['a terminal flag', {terminal: true}],
    ['a stored payload', {payload: {id: '664369c938b3ca001a3cd44f', amount: 1}}],
  ])('a creation answer claiming %s (venue-side facts dpay never created) is a shape failure', async (_label, claim) => {
    mockFetch.mockResolvedValue(jsonResponse(200, bornRecord(ADDRESS, claim), {'x-dpay-order-id': ORDER_ID}));
    await expect(createMtpCashOrder(RELAY, ARGS)).rejects.toThrow('shape');
  });

  test('HTTP 503 maps to unconfigured (the fail-closed vocabulary holds on any relay refusal)', async () => {
    mockFetch.mockResolvedValue(jsonResponse(503, {dpayRelayError: 'mtpelerin-unconfigured'}));
    await expect(createMtpCashOrder(RELAY, ARGS)).rejects.toThrow('unconfigured');
  });
});

describe('isValidIban — the mod-97 checksum', () => {
  test('golden valid vectors (spaces tolerated, case-insensitive)', () => {
    expect(isValidIban('CH9300762011623852957')).toBe(true);
    expect(isValidIban('CH93 0076 2011 6238 5295 7')).toBe(true);
    expect(isValidIban('ch93 0076 2011 6238 5295 7')).toBe(true);
    expect(isValidIban('DE89370400440532013000')).toBe(true);
    expect(isValidIban('GB82WEST12345698765432')).toBe(true);
  });

  test('golden invalid vectors: a flipped checksum digit, bad structure, wrong length', () => {
    expect(isValidIban('CH9300762011623852958')).toBe(false); // checksum digit off by one
    expect(isValidIban('ZZ9300762011623852957')).toBe(false); // structure holds, checksum does not
    expect(isValidIban('CH00')).toBe(false); // too short
    expect(isValidIban('CH9300762011623852957EXTRA0123456789')).toBe(false); // over length
    expect(isValidIban('11930076201162385295 7')).toBe(false); // no country code
    expect(isValidIban('')).toBe(false);
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
