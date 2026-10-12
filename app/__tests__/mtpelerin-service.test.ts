/**
 * The Mt Pelerin cash-out SERVICE (app/services/mtpelerin.ts) — the relay proxy's device face
 * (plan R2 step 2). The pins, per route:
 *
 *   • quote — GET /api/v1/mtpelerin/quote?…: the relay's attribution envelope is validated
 *     (venue_id must be 'mtpelerin', destAmount a plain decimal, never defaulted) and
 *     `fetched_at` becomes the provenance instant. The fail-closed vocabulary: 503 →
 *     'unconfigured', 400/422 → 'refused', other non-2xx → 'unavailable', transport →
 *     'unreachable', unreadable body → 'shape'.
 *   • conversion — POST /api/v1/mtpelerin/conversion: the correlation id rides the
 *     X-Dpay-Order-Id header (absent → 'shape': an order that cannot be watched is never
 *     adopted), the deposit address must be an EVM address (the wallet's ERC-20 send path
 *     cannot deliver anywhere else), the venue's expirationDate parses when present and
 *     stays null when absent/garbage (never invented).
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

describe('createMtpCashOrder — the correlation + deposit-address pins', () => {
  const ARGS = {
    sourceCurrency: 'ZCHF', destCurrency: 'CHF', sourceAmount: '2', sourceNetwork: 'mainnet',
    iban: 'CH9300762011623852957', holderName: 'Ada Lovelace', clientOrderId: 'abc123',
  };

  test('the dpay order id rides X-Dpay-Order-Id; offRampAddress + expiry normalize', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, {
      id: 42, offRampAddress: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01', type: 'sell',
      expirationDate: '2026-10-13T12:00:00.000Z',
    }, {'x-dpay-order-id': 'mtp-abc0000000000001'}));
    const o = await createMtpCashOrder(RELAY, ARGS);
    expect(o.orderId).toBe('mtp-abc0000000000001');
    expect(o.venueOrderId).toBe('42');
    expect(o.offRampAddress).toBe('0xAbCdEf0123456789AbCdEf0123456789AbCdEf01');
    expect(o.expiresAtMs).toBe(Date.parse('2026-10-13T12:00:00.000Z'));
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.clientOrderId).toBe('abc123'); // the locally minted correlation id rides the body
    expect(body.iban).toBe('CH9300762011623852957');
  });

  test('a non-EVM offRampAddress is a shape failure (the ERC-20 send could never deliver)', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, {offRampAddress: 'mtpelerin@ln.mtpelerin.com'}, {'x-dpay-order-id': 'mtp-abc'}));
    await expect(createMtpCashOrder(RELAY, ARGS)).rejects.toThrow('shape');
  });

  test('a missing X-Dpay-Order-Id is a shape failure — an unwatchable order is never adopted', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, {offRampAddress: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01'}));
    await expect(createMtpCashOrder(RELAY, ARGS)).rejects.toThrow('shape');
  });

  test('no expirationDate → expiresAtMs stays null (never invented)', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, {offRampAddress: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01'}, {'x-dpay-order-id': 'mtp-abc'}));
    const o = await createMtpCashOrder(RELAY, ARGS);
    expect(o.expiresAtMs).toBeNull();
  });

  test('HTTP 503 maps to unconfigured (the CTKN tripwire)', async () => {
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
