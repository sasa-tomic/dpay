/**
 * The Trocador surface on the phone (the first AGGREGATOR cefi venue, 2026-09-20):
 *
 * 1. services/trocador — the fail-closed client vocabulary (identical to the sideshift
 *    service's: 'unconfigured' | 'unreachable' | 'refused' | 'unavailable' | 'shape'),
 *    the RAIL-ID request bodies, the wrap shape check (venue_id MUST be the exact
 *    registry row this call quoted), and the statusUrl builder — which points AT THE
 *    RELAY, because every Trocador method is key-gated (`API-Key` header) and there is
 *    NO keyless venue host to poll (the live 2026-09-20 probe: every endpoint answers
 *    401 {"error":"Missing API key"} without the key).
 * 2. convert.ts family dispatch — fetchCeFiQuoteResult/createCeFiOrder route by
 *    cefiFamilyOf (venue_id prefix; the PAIR no longer disambiguates a cefi row — the
 *    trocador row trades the same ICP↔SOL pair as the sideshift row), and
 *    prepareCeFiConvertRecord builds a trocador record whose providerRef.statusUrl is
 *    the relay's key-gated status route, refusing at birth when no relay is set (a
 *    trocador record without a relay can never advance).
 *
 * The relay-side halves (key attachment, 503 naming DPAY_TROCADOR_API_KEY, verbatim
 * passthrough, the refund fund-loss guard) are pinned in
 * crates/dpay-relay/tests/trocador_proxy.rs.
 */
import {afterEach, describe, expect, jest, test} from '@jest/globals';

jest.mock('../services/relay', () => ({relayFetch: jest.fn()}));

import {relayFetch} from '../services/relay';
import {
  createTrocadorTrade,
  fetchTrocadorQuote,
  trocadorStatusUrl,
} from '../services/trocador';
import {
  CeFiNoQuoteError,
  createCeFiOrder,
  fetchCeFiConvertQuote,
  fetchCeFiQuoteResult,
  prepareCeFiConvertRecord,
} from '../convert';
import {salvageConvertStore} from '../convert/records';
import {BUNDLED_VENUES, type VenueEntry} from '../config/venues';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const WRAPPED_SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';
const RELAY = 'https://relay.example';

const VENUE: VenueEntry = BUNDLED_VENUES.find(v => v.venue_id === 'trocador')!;
const SIDESHIFT_VENUE: VenueEntry = BUNDLED_VENUES.find(v => v.venue_id === 'sideshift')!;

const relayMock = jest.mocked(relayFetch);

afterEach(() => {
  relayMock.mockRestore();
});

describe('services/trocador — the status URL rides the relay (NO keyless venue surface)', () => {
  test('trocadorStatusUrl points at the relay key-gated status route, id percent-encoded', () => {
    expect(trocadorStatusUrl(RELAY, 'trade-9')).toBe(
      `${RELAY}/api/v1/trocador/trade?id=trade-9`,
    );
    expect(trocadorStatusUrl('https://relay.example/', 'a b/c')).toBe(
      'https://relay.example/api/v1/trocador/trade?id=a%20b%2Fc',
    );
  });
});

describe('services/trocador — the fail-closed quote client', () => {
  test('the quote body speaks RAIL ids (never venue codes) and the wrap is shape-checked', async () => {
    relayMock.mockResolvedValue(new Response(JSON.stringify({
      venue_id: 'trocador',
      fetched_at: 1758400000,
      quote: {
        trade_id: 'rate-1',
        amount_to: '0.0496',
        provider: 'SomeSwap',
        fixed: true,
        status: 'Waiting',
        quotes: [{provider: 'OtherSwap', kycrating: 'A'}],
      },
    }), {status: 200}));
    const r = await fetchTrocadorQuote(RELAY, VENUE, ICP_LEDGER, WRAPPED_SOL_MINT_ADDRESS, '2');
    const [base, path, init] = relayMock.mock.calls[0] as [string, string, RequestInit];
    expect(base).toBe(RELAY);
    expect(path).toBe('/api/v1/trocador/rate');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({depositLedger: ICP_LEDGER, settleLedger: WRAPPED_SOL_MINT_ADDRESS, depositAmount: '2'});
    expect(r).toEqual({
      venueId: 'trocador',
      rateId: 'rate-1',
      provider: 'SomeSwap',
      settleAmount: '0.0496',
      fixed: true,
      fetchedAtMs: 1758400000000,
    });
  });

  test('a foreign attribution (another row echoing the name) is a shape failure', async () => {
    relayMock.mockResolvedValue(new Response(JSON.stringify({
      venue_id: 'sideshift',
      fetched_at: 1758400000,
      quote: {trade_id: 'rate-1', amount_to: '0.0496', provider: 'SomeSwap'},
    }), {status: 200}));
    await expect(fetchTrocadorQuote(RELAY, VENUE, ICP_LEDGER, WRAPPED_SOL_MINT_ADDRESS, '2'))
      .rejects.toThrow('shape');
  });

  test('the error vocabulary matches the sideshift surface exactly', async () => {
    relayMock.mockResolvedValue(new Response('{}', {status: 503}));
    await expect(fetchTrocadorQuote(RELAY, VENUE, ICP_LEDGER, WRAPPED_SOL_MINT_ADDRESS, '2'))
      .rejects.toThrow('unconfigured');
    relayMock.mockResolvedValue(new Response('{}', {status: 400}));
    await expect(fetchTrocadorQuote(RELAY, VENUE, ICP_LEDGER, WRAPPED_SOL_MINT_ADDRESS, '2'))
      .rejects.toThrow('refused');
    relayMock.mockRejectedValue(new Error('network down'));
    await expect(fetchTrocadorQuote(RELAY, VENUE, ICP_LEDGER, WRAPPED_SOL_MINT_ADDRESS, '2'))
      .rejects.toThrow('unreachable');
  });
});

describe('services/trocador — trade creation', () => {
  test('the venue answer maps verbatim: address_provider IS the deposit handoff', async () => {
    relayMock.mockResolvedValue(new Response(JSON.stringify({
      trade_id: 'trade-9',
      amount_from: '2',
      amount_to: '0.0496',
      provider: 'SomeSwap',
      status: 'Waiting',
      address_provider: 'venue-deposit-addr',
      address_provider_memo: null,
      address_user: 'settle-addr',
    }), {status: 200}));
    const t = await createTrocadorTrade(RELAY, VENUE, {
      rateId: 'rate-1',
      provider: 'SomeSwap',
      settleAddress: 'settle-addr',
      refundAddress: ICP_LEDGER,
      depositLedger: ICP_LEDGER,
      settleLedger: WRAPPED_SOL_MINT_ADDRESS,
      depositAmount: '2',
    });
    expect(t).toEqual({
      tradeId: 'trade-9',
      relayOrderId: null, // no X-Dpay-Order-Id header → persisted nothing
      depositAddress: 'venue-deposit-addr',
      depositMemo: null,
      depositAmount: '2',
      settleAmount: '0.0496',
      expiresAt: null,
    });
  });

  test('the trade body carries clientOrderId (the record id) and the X-Dpay-Order-Id answer is read', async () => {
    // The partner agreement (2026-09-22, term 2): the app stamps every trade with its
    // clientOrderId; the relay records it next to ITS OWN order id, echoed in the
    // X-Dpay-Order-Id response header — which the client reads for the record.
    relayMock.mockResolvedValue(new Response(JSON.stringify({
      trade_id: 'trade-10', amount_from: '2', address_provider: 'dep',
    }), {status: 200, headers: {'X-Dpay-Order-Id': 'ord-77'}}));
    const t = await createTrocadorTrade(RELAY, VENUE, {
      rateId: 'rate-1', provider: 'SomeSwap', settleAddress: 's', refundAddress: 'r',
      depositLedger: ICP_LEDGER, settleLedger: WRAPPED_SOL_MINT_ADDRESS, depositAmount: '2',
      clientOrderId: 'rec-abc',
    });
    const [, , init] = relayMock.mock.calls[0] as [string, string, RequestInit];
    expect(JSON.parse(String(init.body)).clientOrderId).toBe('rec-abc');
    expect(t.relayOrderId).toBe('ord-77');
    // an absent header persists nothing (an older relay must not break the flow)
    relayMock.mockResolvedValue(new Response(JSON.stringify({
      trade_id: 'trade-11', amount_from: '2', address_provider: 'dep',
    }), {status: 200}));
    const noHeader = await createTrocadorTrade(RELAY, VENUE, {
      rateId: 'rate-1', provider: 'SomeSwap', settleAddress: 's', refundAddress: 'r',
      depositLedger: ICP_LEDGER, settleLedger: WRAPPED_SOL_MINT_ADDRESS, depositAmount: '2',
      clientOrderId: 'rec-abc',
    });
    expect(noHeader.relayOrderId).toBeNull();
  });

  test('clientOrderId is optional: no id sent means the field is absent from the body', async () => {
    relayMock.mockResolvedValue(new Response(JSON.stringify({
      trade_id: 'trade-12', amount_from: '2', address_provider: 'dep',
    }), {status: 200}));
    await createTrocadorTrade(RELAY, VENUE, {
      rateId: 'rate-1', provider: 'SomeSwap', settleAddress: 's', refundAddress: 'r',
      depositLedger: ICP_LEDGER, settleLedger: WRAPPED_SOL_MINT_ADDRESS, depositAmount: '2',
    });
    const [, , init] = relayMock.mock.calls[0] as [string, string, RequestInit];
    expect('clientOrderId' in JSON.parse(String(init.body))).toBe(false);
  });

  test('an empty required field refuses BEFORE any network call', async () => {
    await expect(createTrocadorTrade(RELAY, VENUE, {
      rateId: '', provider: 'SomeSwap', settleAddress: 's', refundAddress: 'r',
      depositLedger: ICP_LEDGER, settleLedger: WRAPPED_SOL_MINT_ADDRESS, depositAmount: '2',
    })).rejects.toThrow('refused');
    expect(relayMock).not.toHaveBeenCalled();
  });
});

describe('convert.ts — the trocador family dispatch', () => {
  test('fetchCeFiQuoteResult normalizes the trocador quote (rateId + provider set, quoteId null)', async () => {
    relayMock.mockResolvedValue(new Response(JSON.stringify({
      venue_id: 'trocador',
      fetched_at: 1758400000,
      quote: {trade_id: 'rate-2', amount_to: '0.0496', provider: 'SomeSwap'},
    }), {status: 200}));
    const r = await fetchCeFiQuoteResult(RELAY, VENUE, ICP_LEDGER, WRAPPED_SOL_MINT_ADDRESS, '2');
    expect(r.rateId).toBe('rate-2');
    expect(r.provider).toBe('SomeSwap');
    expect(r.quoteId).toBeNull();
    expect(r.settleAmount).toBe('0.0496');
  });

  test('the LISTED-BUT-UNQUOTED body ("no resulting quote", live-measured 2026-09-22) is a typed no-quote verdict, not a refusal', async () => {
    // The venue's own 400 body, passed through the relay verbatim (the 401 shape's
    // vocabulary: {"error": …}). A fresh Response per call — a Response body reads once.
    const noQuoteBody = () => new Response(JSON.stringify({error: 'no resulting quote'}), {status: 400});
    relayMock.mockImplementation(() => Promise.resolve(noQuoteBody()));
    await expect(fetchTrocadorQuote(RELAY, VENUE, ICP_LEDGER, WRAPPED_SOL_MINT_ADDRESS, '2'))
      .rejects.toThrow('noquote');
    // Through the convert dispatch the typed error carries the venue's display name and
    // the honest attributed copy — the surfaces render it as a state, never a red error.
    let caught: unknown = null;
    try {
      await fetchCeFiConvertQuote(RELAY, VENUE, ICP_LEDGER, WRAPPED_SOL_MINT_ADDRESS, '200000000', {
        inDecimals: 8, outDecimals: 9,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CeFiNoQuoteError);
    const noQuote = caught as CeFiNoQuoteError;
    expect(noQuote.venueName).toBe('Trocador');
    // The copy law (spec 2026-10-04 §3): the verdict's message is venue-less - the venue
    // rides the error object (above) and the Details fold, never the primary line.
    expect(noQuote.message).toContain('no live market right now');
    expect(noQuote.message).toContain('Nothing was sent');
    expect(noQuote.message).not.toContain('Trocador');
  });

  test('createCeFiOrder routes to the trocador service and refuses a quote missing the provider', async () => {
    relayMock.mockResolvedValue(new Response(JSON.stringify({
      trade_id: 'trade-9', amount_from: '2', address_provider: 'dep', address_provider_memo: null,
    }), {status: 200}));
    const order = await createCeFiOrder(RELAY, VENUE, {
      settleAmount: '0.0496', rate: null, fetchedAtMs: 1,
      quoteId: null, rateId: 'rate-2', provider: 'SomeSwap',
    }, {
      settleAddress: 'settle-addr', refundAddress: ICP_LEDGER,
      depositLedger: ICP_LEDGER, settleLedger: WRAPPED_SOL_MINT_ADDRESS,
      depositAmountDecimal: '2',
    });
    expect(order).toMatchObject({tradeId: 'trade-9'});
    await expect(createCeFiOrder(RELAY, VENUE, {
      settleAmount: '0.0496', rate: null, fetchedAtMs: 1,
      quoteId: null, rateId: null, provider: null,
    }, {
      settleAddress: 's', refundAddress: 'r', depositLedger: ICP_LEDGER,
      settleLedger: WRAPPED_SOL_MINT_ADDRESS, depositAmountDecimal: '2',
    })).rejects.toThrow('shape');
  });

  test('the sideshift family still dispatches to its own service (same pair, different row)', async () => {
    relayMock.mockResolvedValue(new Response(JSON.stringify({
      venue_id: 'sideshift', fetched_at: 1758400000,
      quote: {id: 'q-1', settleAmount: '0.04959689', rate: '0.0248'},
    }), {status: 200}));
    const r = await fetchCeFiQuoteResult(RELAY, SIDESHIFT_VENUE, ICP_LEDGER, WRAPPED_SOL_MINT_ADDRESS, '2');
    expect(r.quoteId).toBe('q-1');
    expect(r.rateId).toBeNull();
  });
});

describe('prepareCeFiConvertRecord — the trocador record shape', () => {
  const quote = {
    venueId: 'trocador',
    pool: VENUE.endpoint,
    tokenInLedger: ICP_LEDGER,
    tokenOutLedger: WRAPPED_SOL_MINT_ADDRESS,
    amountIn: '200000000',
    amountOutGross: '49600000',
    zeroForOne: null,
    feeMillionths: 0,
    fetchedAtMs: 5,
  };
  const order = {
    tradeId: 'trade-9',
    relayOrderId: null as string | null,
    depositAddress: 'venue-deposit-addr',
    depositMemo: null as string | null,
    depositAmount: '2',
    settleAmount: '0.0496',
    expiresAt: null,
  };
  const args = {
    id: 'rec-1', // the clientOrderId twin — minted by the confirm path before the trade
    quote,
    order,
    relayUrl: RELAY,
    settleAddress: 'IcSettlePrincipal',
    inCurrency: 8,
    inSymbol: 'ICP',
    outSymbol: 'SOL',
    inDecimals: 8,
    outDecimals: 9,
  };

  test('the record lands at awaiting_deposit with the RELAY statusUrl and the handoff block', () => {
    const rec = prepareCeFiConvertRecord(args);
    expect(rec.step).toBe('awaiting_deposit');
    expect(rec.id).toBe('rec-1'); // the record id IS the clientOrderId sent at trade creation
    expect(rec.venueId).toBe('trocador');
    expect(rec.legs).toEqual([]);
    expect(rec.providerRef).toEqual({
      orderId: 'trade-9',
      statusUrl: `${RELAY}/api/v1/trocador/trade?id=trade-9`,
    });
    expect(rec.providerDeposit).toMatchObject({
      depositAddress: 'venue-deposit-addr',
      depositAmount: '2',
    });
    expect(rec.expectedNet).toBe(rec.expectedGross); // dpay adds nothing
  });

  test('the relay\'s X-Dpay-Order-Id order id persists on the providerRef (agreement term 2)', () => {
    const rec = prepareCeFiConvertRecord({...args, order: {...order, relayOrderId: 'ord-77'}});
    expect(rec.providerRef).toEqual({
      orderId: 'trade-9',
      statusUrl: `${RELAY}/api/v1/trocador/trade?id=trade-9`,
      relayOrderId: 'ord-77',
    });
    // and it survives the store round-trip (hydrate parses it back)
    const salvaged = salvageConvertStore({[rec.id]: JSON.parse(JSON.stringify(rec))});
    expect(salvaged.dropped).toBe(0);
    expect(salvaged.records[rec.id]!.providerRef).toEqual(rec.providerRef);
  });

  test('a record persisted WITHOUT a relayOrderId (pre-agreement shape) still hydrates byte-identically', () => {
    const rec = prepareCeFiConvertRecord(args);
    const raw = JSON.parse(JSON.stringify(rec)) as Record<string, unknown>;
    const pr = raw.providerRef as Record<string, unknown>;
    delete pr.relayOrderId;
    const salvaged = salvageConvertStore({[rec.id]: raw});
    expect(salvaged.dropped).toBe(0);
    expect(salvaged.records[rec.id]!.providerRef).toEqual({orderId: 'trade-9', statusUrl: rec.providerRef!.statusUrl});
  });

  test('a trocador record without a relay is refused at birth (it could never advance)', () => {
    expect(() => prepareCeFiConvertRecord({...args, relayUrl: ''}))
      .toThrow();
  });
});
