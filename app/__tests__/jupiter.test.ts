// Pins for the relay-proxied Jupiter client (services/jupiter.ts; 2026-09-16 founder ask —
// "get live quotes from them … possibly through our relay (for caching etc)"). The contract
// under test:
//   - the DEFAULT dial target is the WALLET'S RELAY (`/api/v1/jupiter/*`, relayFetch's R1
//     walk) — the venue row's `endpoint` (lite-api.jup.ag) is identity/attribution and is
//     never dialed by this module;
//   - the operator override (`setJupiterEndpoint`, the R2 escape hatch) dials
//     `{origin}/swap/v1/*` device-direct and WINS over the relay path; a malformed override
//     fails closed ('shape'), never silently falls back;
//   - the failure vocabulary stays {refused, unavailable, unreachable, shape}; the relay's
//     504 transport-death marker `jupiter-upstream-unreachable` maps to 'unreachable' while
//     a bare 5xx stays 'unavailable' (the venue's own gateway, not our relay, said so);
//   - the POST body carries Jupiter's OWN quoteResponse verbatim — the relay never touches
//     it, and the swap POST is never cached.
import {beforeEach, describe, expect, jest, test} from '@jest/globals';
import {
  fetchJupiterQuote,
  fetchJupiterSwapTx,
  setJupiterEndpoint,
  jupiterEndpoint,
  JUPITER_QUOTE_PATH,
  JUPITER_SWAP_PATH,
  type JupiterQuote,
} from '../services/jupiter';
import type {VenueEntry} from '../config/venues';
import {fetchWithTimeout, relayFetch} from '../services/relay';

jest.mock('../services/relay', () => ({relayFetch: jest.fn(), fetchWithTimeout: jest.fn()}));

const RELAY = 'http://relay.test';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const venue: VenueEntry = {
  venue_id: 'jupiter',
  display_name: 'Jupiter',
  kind: 'solana_amm',
  endpoint: 'https://lite-api.jup.ag',
  pair_ledgers: [SOL, USDC],
  testnet: false,
  disclosure_key: 'jupiter',
};

const quoteBody = {
  inputMint: SOL,
  outputMint: USDC,
  inAmount: '1000000000',
  outAmount: '10360000',
  otherAmountThreshold: '10250000',
  priceImpact: '0.003',
  slippageBps: 100,
  platformFee: null,
};

const quoted = (): JupiterQuote => {
  const r = {
    ok: true as const,
    quote: {
      venueId: 'jupiter',
      inputMint: SOL,
      outputMint: USDC,
      inAmount: '1000000000',
      outAmount: '10360000',
      otherAmountThreshold: '10250000',
      priceImpactPct: '0.003',
      slippageBps: 100,
      platformFeeBps: null,
      raw: quoteBody as unknown,
      fetchedAtMs: 1,
    },
  };
  return r.quote;
};

const res = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const errRes = (status: number, text: string) => ({
  ok: false,
  status,
  json: async () => {
    throw new Error('not json');
  },
  text: async () => text,
});

const MARKER = JSON.stringify({dpayRelayError: 'jupiter-upstream-unreachable', detail: 'timed out'});

beforeEach(() => {
  jest.clearAllMocks();
  setJupiterEndpoint(null);
});

describe('fetchJupiterQuote — the default dial is the relay proxy', () => {
  test('the relay path carries the canonical query; the venue endpoint is never dialed', async () => {
    jest.mocked(relayFetch).mockResolvedValueOnce(res(quoteBody) as never);
    const r = await fetchJupiterQuote(RELAY, venue, SOL, USDC, '1000000000', 100);
    expect(r.ok).toBe(true);
    const call = jest.mocked(relayFetch).mock.calls[0]!;
    expect(call[0]).toBe(RELAY);
    expect(call[1]).toBe(
      `${JUPITER_QUOTE_PATH}?inputMint=${SOL}&outputMint=${USDC}&amount=1000000000&slippageBps=100`,
    );
    expect(call[2]).toBeUndefined();
    expect(jest.mocked(fetchWithTimeout)).not.toHaveBeenCalled();
  });

  test('query values are percent-encoded (mints/amount are data, never query syntax)', async () => {
    jest.mocked(relayFetch).mockResolvedValueOnce(res(quoteBody) as never);
    await fetchJupiterQuote(RELAY, venue, 'mint with space', USDC, '1000000000', 100);
    expect(jest.mocked(relayFetch).mock.calls[0]![1]).toContain('inputMint=mint%20with%20space');
  });

  test('a successful quote carries the venue figures verbatim and the raw body', async () => {
    jest.mocked(relayFetch).mockResolvedValueOnce(res(quoteBody) as never);
    const r = await fetchJupiterQuote(RELAY, venue, SOL, USDC, '1000000000', 100);
    if (!r.ok) throw new Error('expected a quote');
    expect(r.quote.venueId).toBe('jupiter');
    expect(r.quote.inAmount).toBe('1000000000');
    expect(r.quote.outAmount).toBe('10360000');
    expect(r.quote.otherAmountThreshold).toBe('10250000');
    expect(r.quote.priceImpactPct).toBe('0.003');
    expect(r.quote.slippageBps).toBe(100);
    expect(r.quote.platformFeeBps).toBeNull();
    expect(r.quote.raw).toEqual(quoteBody);
  });

  test('a quoted platformFee lands in platformFeeBps', async () => {
    jest.mocked(relayFetch).mockResolvedValueOnce(res({...quoteBody, platformFee: {bps: 0}}) as never);
    const r = await fetchJupiterQuote(RELAY, venue, SOL, USDC, '1000000000', 100);
    if (!r.ok) throw new Error('expected a quote');
    expect(r.quote.platformFeeBps).toBe(0);
  });
});

describe('fetchJupiterQuote — failure vocabulary on the relay path', () => {
  test.each([
    ['400 → refused (the venue said no)', 400, MARKER, 'refused'],
    ['504 + relay marker → unreachable (the PATH died)', 504, MARKER, 'unreachable'],
    ['504 without the marker → unavailable (the venue gateway said so)', 504, 'upstream timeout', 'unavailable'],
    ['503 → unavailable', 503, 'gone', 'unavailable'],
  ])('%s', async (_name, status, text, code) => {
    jest.mocked(relayFetch).mockResolvedValueOnce(errRes(status, text) as never);
    const r = await fetchJupiterQuote(RELAY, venue, SOL, USDC, '1000000000', 100);
    expect(r).toEqual({ok: false, code, status});
  });

  test('relay transport death (relayFetch throws) → unreachable', async () => {
    jest.mocked(relayFetch).mockRejectedValueOnce(new Error('all relay addresses failed') as never);
    const r = await fetchJupiterQuote(RELAY, venue, SOL, USDC, '1000000000', 100);
    expect(r).toEqual({ok: false, code: 'unreachable'});
  });

  test('a 2xx body off the pinned shape → shape, never a defaulted quote', async () => {
    jest.mocked(relayFetch).mockResolvedValueOnce(res({...quoteBody, outAmount: 10360000}) as never);
    const r = await fetchJupiterQuote(RELAY, venue, SOL, USDC, '1000000000', 100);
    expect(r).toEqual({ok: false, code: 'shape', status: 200});
  });

  test('a non-numeric platformFee.bps → shape', async () => {
    jest.mocked(relayFetch).mockResolvedValueOnce(res({...quoteBody, platformFee: {bps: '0'}}) as never);
    const r = await fetchJupiterQuote(RELAY, venue, SOL, USDC, '1000000000', 100);
    expect(r).toEqual({ok: false, code: 'shape', status: 200});
  });

  test('a blank relayUrl fails closed without dialing anything', async () => {
    const r = await fetchJupiterQuote('   ', venue, SOL, USDC, '1000000000', 100);
    expect(r).toEqual({ok: false, code: 'shape'});
    expect(jest.mocked(relayFetch)).not.toHaveBeenCalled();
  });
});

describe('fetchJupiterQuote — the operator override (R2 escape hatch)', () => {
  test('an https override dials {origin}/swap/v1/quote directly and wins over the relay', async () => {
    setJupiterEndpoint('https://jup.example.com');
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(res(quoteBody) as never);
    const r = await fetchJupiterQuote(RELAY, venue, SOL, USDC, '1000000000', 100);
    expect(r.ok).toBe(true);
    const call = jest.mocked(fetchWithTimeout).mock.calls[0]!;
    expect(call[0]).toBe(
      `https://jup.example.com/swap/v1/quote?inputMint=${SOL}&outputMint=${USDC}&amount=1000000000&slippageBps=100`,
    );
    expect(jest.mocked(relayFetch)).not.toHaveBeenCalled();
  });

  test.each([
    ['plain http', 'http://jup.example.com'],
    ['a path-bearing base', 'https://jup.example.com/api'],
    ['a base with a query', 'https://jup.example.com/?x=1'],
    ['not a URL', 'nonsense'],
  ])('a malformed override (%s) fails closed as shape — never a silent relay fallback', async (_n, bad) => {
    setJupiterEndpoint(bad);
    const r = await fetchJupiterQuote(RELAY, venue, SOL, USDC, '1000000000', 100);
    expect(r).toEqual({ok: false, code: 'shape'});
    expect(jest.mocked(fetchWithTimeout)).not.toHaveBeenCalled();
    expect(jest.mocked(relayFetch)).not.toHaveBeenCalled();
  });

  test('an override refusal maps like the venue path (4xx refused, 5xx unavailable)', async () => {
    setJupiterEndpoint('https://jup.example.com');
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(errRes(400, 'no route') as never);
    expect(await fetchJupiterQuote(RELAY, venue, SOL, USDC, '1000000000', 100)).toEqual({
      ok: false,
      code: 'refused',
      status: 400,
    });
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(errRes(502, 'bad gateway') as never);
    expect(await fetchJupiterQuote(RELAY, venue, SOL, USDC, '1000000000', 100)).toEqual({
      ok: false,
      code: 'unavailable',
      status: 502,
    });
  });

  test('override transport death → unreachable', async () => {
    setJupiterEndpoint('https://jup.example.com');
    jest.mocked(fetchWithTimeout).mockRejectedValueOnce(new Error('dead') as never);
    const r = await fetchJupiterQuote(RELAY, venue, SOL, USDC, '1000000000', 100);
    expect(r).toEqual({ok: false, code: 'unreachable'});
  });

  test('jupiterEndpoint round-trips the setter (trim; empty clears)', () => {
    expect(jupiterEndpoint()).toBeNull();
    setJupiterEndpoint('  https://jup.example.com  ');
    expect(jupiterEndpoint()).toBe('https://jup.example.com');
    setJupiterEndpoint('');
    expect(jupiterEndpoint()).toBeNull();
    setJupiterEndpoint(null);
    expect(jupiterEndpoint()).toBeNull();
  });
});

describe('fetchJupiterSwapTx', () => {
  test('the POST rides the relay swap path carrying Jupiter\'s quoteResponse VERBATIM', async () => {
    const quote = quoted();
    jest.mocked(relayFetch).mockResolvedValueOnce(
      res({swapTransaction: 'AQIDBA==', lastValidBlockHeight: 300000000}) as never,
    );
    const r = await fetchJupiterSwapTx(RELAY, quote, 'UserPk8888');
    expect(r.ok).toBe(true);
    const call = jest.mocked(relayFetch).mock.calls[0]!;
    expect(call[0]).toBe(RELAY);
    expect(call[1]).toBe(JUPITER_SWAP_PATH);
    const init = call[2] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      quoteResponse: quoteBody, // verbatim — the raw body the quote returned
      userPublicKey: 'UserPk8888',
      wrapAndUnwrapSol: true,
      asLegacyTransaction: true,
    });
    if (!r.ok) throw new Error('expected a swap tx');
    expect([...r.swap.swapTransaction]).toEqual([1, 2, 3, 4]);
    expect(r.swap.lastValidBlockHeight).toBe(300000000);
  });

  test('relay failures: marker 504 → unreachable, 4xx → refused, 5xx → unavailable', async () => {
    const quote = quoted();
    jest.mocked(relayFetch).mockResolvedValueOnce(errRes(504, MARKER) as never);
    expect(await fetchJupiterSwapTx(RELAY, quote, 'UserPk8888')).toEqual({
      ok: false,
      code: 'unreachable',
      status: 504,
    });
    jest.mocked(relayFetch).mockResolvedValueOnce(errRes(400, 'bad quote') as never);
    expect(await fetchJupiterSwapTx(RELAY, quote, 'UserPk8888')).toEqual({
      ok: false,
      code: 'refused',
      status: 400,
    });
    jest.mocked(relayFetch).mockRejectedValueOnce(new Error('all relay addresses failed') as never);
    expect(await fetchJupiterSwapTx(RELAY, quote, 'UserPk8888')).toEqual({ok: false, code: 'unreachable'});
  });

  test('a 2xx reply off the pinned shape (bad base64, zero blockhash) → shape', async () => {
    const quote = quoted();
    jest.mocked(relayFetch).mockResolvedValueOnce(res({swapTransaction: '!!!', lastValidBlockHeight: 1}) as never);
    expect(await fetchJupiterSwapTx(RELAY, quote, 'UserPk8888')).toEqual({ok: false, code: 'shape', status: 200});
    jest.mocked(relayFetch).mockResolvedValueOnce(res({swapTransaction: '', lastValidBlockHeight: 1}) as never);
    expect(await fetchJupiterSwapTx(RELAY, quote, 'UserPk8888')).toEqual({ok: false, code: 'shape', status: 200});
    jest.mocked(relayFetch).mockResolvedValueOnce(res({swapTransaction: 'AQIDBA=='}) as never);
    expect(await fetchJupiterSwapTx(RELAY, quote, 'UserPk8888')).toEqual({ok: false, code: 'shape', status: 200});
  });

  test('an https override POSTs {origin}/swap/v1/swap and wins over the relay', async () => {
    setJupiterEndpoint('https://jup.example.com');
    const quote = quoted();
    jest.mocked(fetchWithTimeout).mockResolvedValueOnce(
      res({swapTransaction: 'AQIDBA==', lastValidBlockHeight: 300000000}) as never,
    );
    const r = await fetchJupiterSwapTx(RELAY, quote, 'UserPk8888');
    expect(r.ok).toBe(true);
    expect(jest.mocked(fetchWithTimeout).mock.calls[0]![0]).toBe('https://jup.example.com/swap/v1/swap');
    expect(jest.mocked(relayFetch)).not.toHaveBeenCalled();
  });

  test('a blank relayUrl fails closed without dialing anything', async () => {
    const r = await fetchJupiterSwapTx('  ', quoted(), 'UserPk8888');
    expect(r).toEqual({ok: false, code: 'shape'});
    expect(jest.mocked(relayFetch)).not.toHaveBeenCalled();
  });
});
