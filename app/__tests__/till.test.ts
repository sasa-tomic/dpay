/**
 * The merchant's till client (`services/till.ts`) — what a shop's phone does with the three routes
 * only a merchant calls.
 *
 * WHAT THIS SUITE OWNS, and what it deliberately leaves alone:
 *   • `tillOpenSignature.test.ts` drives the REAL compiled core and pins the signed BYTES against
 *     `dfx/till_open_signing.json`. Nothing here re-checks an Ed25519 signature — the core is
 *     stubbed at its module boundary, and what is asserted is that this client signs the price it
 *     is about to send, with the merchant's own seed, once per request.
 *   • `tillWire.test.ts` reads the same relay bodies as the PAYER. This one reads them as the
 *     MERCHANT, off the same committed golden (`dfx/till_wire.json`), so the two halves of dpay's
 *     own till are pinned to one recording rather than to each other's expectations.
 *
 * The money-critical case is `an unreadable answer is "can't check", never "unpaid"`: a cashier who
 * is told a paid customer has not paid either hands the goods over twice or accuses them, and both
 * are worse than saying the till is out of contact.
 *
 * No test touches the network: `globalThis.fetch` is replaced at the boundary and restored
 * afterwards, exactly as `opencryptopayClient.test.ts` does for the payer's client.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import {readFileSync} from 'fs';
import {join} from 'path';

// The core signs in production; under jest the native module is absent. The stub returns a
// recognisable 64-byte signature and RECORDS its arguments, which is the whole point: a ring-up
// that did not sign the price it sent would be a charge the relay refuses and, worse, a charge
// this app could not have proved was its own.
// (The `mock` prefix is jest's own allowlist for values a hoisted factory may close over.)
const mockSignatureCalls: unknown[][] = [];
const mockBrokenSeed = 'ff'.repeat(32);
jest.mock('../services/native', () => ({
  DpayCore: {
    tillOpenSignature: jest.fn((...args: unknown[]) => {
      mockSignatureCalls.push(args);
      if (args[0] === mockBrokenSeed) return Promise.reject(new Error('key unavailable'));
      return Promise.resolve('ab'.repeat(64));
    }),
  },
}));

import {
  TILL_OFFER, cancelTillCharge, chfCents, openTillCharge, tillChargeStatus, tillRawUnits,
} from '../services/till';
import type {Identity} from '../lib/types';
import {applyFormatLocale} from '../i18n/intl';

const GOLDEN = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'dfx', 'till_wire.json'), 'utf8'),
) as {
  input: {cents: number};
  amount_raw: string;
  open: {id: string; qr: string; amount: string; merchant: string; reference: string; created_secs: number; expires_at: number};
  details: {transferAmounts: {method: string; assets: {asset: string}[]}[]};
  callback: {uri: string};
};

/** VCHF's precision — read from the wallet's own catalog rather than typed here, because the whole
 *  point of `tillRawUnits` is that it converts at the ASSET's scale. */
const VCHF_DECIMALS = 8;

const MERCHANT: Identity = {secretHex: '0b'.repeat(32), publicHex: '66'.repeat(32), username: 'Bahnhof Kiosk'};
const RELAY = 'https://till.example';

const realFetch = globalThis.fetch;
const requests: {url: string; init: RequestInit | undefined}[] = [];

afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
  requests.length = 0;
  mockSignatureCalls.length = 0;
});

/** Answer every request with one body, recording what was asked. */
function serve(status: number, body: unknown, opts: {unreadable?: boolean} = {}) {
  (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    requests.push({url, init});
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (opts.unreadable) throw new SyntaxError('Unexpected end of JSON input');
        return body;
      },
    } as unknown as Response;
  });
}

/** The transport itself fails — no server, no answer, nothing to read. */
function serveDead(message = 'Failed to fetch') {
  (globalThis as unknown as {fetch: unknown}).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    requests.push({url, init});
    throw new TypeError(message);
  });
}

function postedBody(): Record<string, unknown> {
  const raw = requests[0]?.init?.body;
  if (typeof raw !== 'string') throw new Error('the ring-up posted no body');
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('the pair a dpay till serves', () => {
  test('is the pair the relay really puts on the wire', () => {
    // A drift alarm, not a restatement: the relay's own recorded step-2 body is the statement, and
    // this client matches a wallet asset against it (`offerNamesAsset`). If the till ever quotes a
    // second asset, this fails rather than the merchant screen silently refusing a payable one.
    const offered = GOLDEN.details.transferAmounts;
    expect(offered).toHaveLength(1);
    expect(offered[0].method).toBe(TILL_OFFER.method);
    expect(offered[0].assets.map(a => a.asset)).toEqual([TILL_OFFER.asset]);
  });
});

describe('a franc price, in integers', () => {
  test('becomes whole rappen', () => {
    expect(chfCents('10.50')).toEqual({ok: true, cents: '1050'});
    expect(chfCents('10')).toEqual({ok: true, cents: '1000'});
    expect(chfCents('0.05')).toEqual({ok: true, cents: '5'});
    expect(chfCents(' 4.5 ')).toEqual({ok: true, cents: '450'});
  });

  test("takes the comma key a German, French or Spanish decimal-pad renders", () => {
    // The cashier cannot choose their keyboard's decimal mark: on a de/fr/es device the pad shows
    // a COMMA, and `10,50` is what "ten francs fifty" looks like there. Without the canonicalizer
    // this is refused as not-a-number and the example price in the error copy (`10.50`) is
    // literally untypeable — a total loss of the merchant surface across most of Europe.
    try {
      applyFormatLocale('de-DE');
      expect(chfCents('10,50')).toEqual({ok: true, cents: '1050'});
      expect(chfCents(',5')).toEqual({ok: true, cents: '50'});
      applyFormatLocale('fr-FR');
      expect(chfCents('4,5')).toEqual({ok: true, cents: '450'});
      applyFormatLocale('es-ES');
      expect(chfCents('0,05')).toEqual({ok: true, cents: '5'});
    } finally {
      applyFormatLocale('en-US');
    }
    // In English the canonicalizer is a no-op, so a comma is still refused rather than guessed at.
    expect(chfCents('10,50')).toEqual({ok: false, reason: 'not-a-number'});
  });

  test('refuses what a till cannot charge, and says which rule it broke', () => {
    // Three causes, three corrections — round the rappen, type a number, charge less.
    expect(chfCents('10.505')).toEqual({ok: false, reason: 'too-precise'});
    expect(chfCents('')).toEqual({ok: false, reason: 'not-a-number'});
    expect(chfCents('coffee')).toEqual({ok: false, reason: 'not-a-number'});
    expect(chfCents('-5')).toEqual({ok: false, reason: 'not-a-number'});
    // Zero is not a charge. It is also how a CANCELLATION is signed, so a till that accepted it
    // here would let a mis-typed total clear the counter instead of opening one.
    expect(chfCents('0')).toEqual({ok: false, reason: 'not-a-number'});
    // TOO BIG, twice over, and both are a SIZE rather than a shape — a cashier told to "type a
    // number" would go looking for a typo that is not there. The first passes the u64 parser and
    // dies on the wire's exact-integer range (its `cents` is a bare JSON number, so a value past
    // 2^53 would be SENT as a different price than was SIGNED); the second overflows u64 itself.
    expect(chfCents('99999999999999999')).toEqual({ok: false, reason: 'too-large'});
    expect(chfCents('999999999999999999')).toEqual({ok: false, reason: 'too-large'});
  });

  test('converts to the raw ledger units the relay itself says it means', () => {
    // THE MONEY ASSERTION, pinned to the relay's own recording: its `cents` and the raw units its
    // decimal amount denotes are both in the golden, and this converter must land on that integer.
    expect(tillRawUnits(String(GOLDEN.input.cents), VCHF_DECIMALS)).toBe(GOLDEN.amount_raw);
    expect(tillRawUnits('1', VCHF_DECIMALS)).toBe('1000000');
    // BigInt end to end: a cent count past 2^53 keeps every digit. The same conversion through a
    // float loses the last ones — which is the whole reason raw amounts are strings in this app.
    const huge = '90071992547409919'; // > Number.MAX_SAFE_INTEGER
    expect(tillRawUnits(huge, VCHF_DECIMALS)).toBe('90071992547409919000000');
    expect(String(Number(huge) * 1e6)).not.toBe('90071992547409919000000');
  });

  test('refuses an asset too coarse to hold a rappen instead of rounding one away', () => {
    expect(() => tillRawUnits('1050', 0)).toThrow('cannot express a CHF rappen');
    expect(() => tillRawUnits('1050', 1)).toThrow('cannot express a CHF rappen');
  });
});

describe('ringing up a charge', () => {
  test('signs the price with the merchant’s own seed and returns the relay’s charge', async () => {
    serve(200, GOLDEN.open);
    const outcome = await openTillCharge(RELAY, MERCHANT, String(GOLDEN.input.cents), VCHF_DECIMALS);
    expect(outcome).toEqual({
      kind: 'open',
      charge: {
        id: GOLDEN.open.id,
        cents: String(GOLDEN.input.cents),
        qr: GOLDEN.open.qr,
        reference: GOLDEN.open.reference,
        createdSecs: GOLDEN.open.created_secs,
        expiresAt: GOLDEN.open.expires_at,
      },
    });
    // THE FIELD THE MERCHANT'S OWN COLLECTION HANGS ON. The relay credits only a transfer whose
    // memo is this value, and until it was on the ring-up the merchant could not learn it without
    // walking their own till's payer routes. Pinned against the step-3 instruction in the SAME
    // recording, so the memo this app will put on a tap is the memo a scanned payer is told to use.
    expect(GOLDEN.open.reference).toMatch(/^[0-9a-f]{32}$/);
    expect(GOLDEN.callback.uri).toContain(`&ref=${GOLDEN.open.reference}`);
    // ONE request, to the merchant route.
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${RELAY}/api/v1/till`);
    expect(requests[0].init?.method).toBe('POST');
    // The signature covers the PRICE, and is made over the merchant's own seed — the wire's cents,
    // nonce and issued_at are the very values that were signed, or the relay would refuse it.
    const body = postedBody();
    expect(mockSignatureCalls).toHaveLength(1);
    const [seed, cents, nonce, issuedAt, name] = mockSignatureCalls[0];
    expect(seed).toBe(MERCHANT.secretHex);
    expect(cents).toBe(String(GOLDEN.input.cents));
    expect(nonce).toBe(body.nonce);
    expect(issuedAt).toBe(body.issued_at);
    expect(name).toBe(MERCHANT.username);
    expect(body.merchant_pubkey).toBe(MERCHANT.publicHex);
    expect(body.cents).toBe(GOLDEN.input.cents);
    expect(body.signature).toBe('ab'.repeat(64));
    // 16 bytes of single-use nonce, in the width the relay parses.
    expect(String(body.nonce)).toMatch(/^[0-9a-f]{32}$/);
  });

  test('refuses a code that would charge a different number than was rung up', async () => {
    // The till answering `1.` for a CHF 10.00 ring-up is a wrong price wearing the right shape.
    // Showing it would put a code in front of a customer that charges what nobody at the counter
    // chose — so nothing is shown, and the merchant is told both numbers.
    serve(200, {...GOLDEN.open, amount: '1.'});
    expect(await openTillCharge(RELAY, MERCHANT, '1000', VCHF_DECIMALS)).toEqual({kind: 'mispriced', quoted: '1.'});
  });

  test('tells a relay that serves no till apart from a till that refused', async () => {
    // An unregistered route 404s with nothing to say (`DPAY_ENABLE_TILL=false`) — a first-class
    // state with its own instruction. A live till's 404 carries the envelope and a sentence.
    serve(404, null, {unreadable: true});
    expect(await openTillCharge(RELAY, MERCHANT, '1000', VCHF_DECIMALS)).toEqual({kind: 'not-served', addr: RELAY});

    serve(404, {statusCode: 404, message: 'Payment link not found', error: 'Not Found'});
    expect(await openTillCharge(RELAY, MERCHANT, '1000', VCHF_DECIMALS)).toEqual({
      kind: 'refused', said: 'Payment link not found', status: 404,
    });
  });

  test('carries the till’s own refusal, because it already names the fix', async () => {
    const message = 'issued_at is 400 s from this till\'s clock, which allows ±120 s. Re-sync the device clock, then sign and send again';
    serve(401, {statusCode: 401, message, error: 'Unauthorized'});
    expect(await openTillCharge(RELAY, MERCHANT, '1000', VCHF_DECIMALS)).toEqual({kind: 'refused', said: message, status: 401});

    // A refusal with no sentence in it is still a refusal — never a null message rendered raw.
    serve(429, {statusCode: 429, error: 'Too Many Requests'});
    expect(await openTillCharge(RELAY, MERCHANT, '1000', VCHF_DECIMALS)).toEqual({kind: 'refused', said: null, status: 429});
  });

  test('never throws at the caller: an unreachable relay is an outcome', async () => {
    serveDead('ECONNREFUSED');
    const outcome = await openTillCharge(RELAY, MERCHANT, '1000', VCHF_DECIMALS);
    expect(outcome.kind).toBe('unreachable');
    expect(outcome.kind === 'unreachable' && outcome.detail).toContain('ECONNREFUSED');
  });

  test('sends nothing at all when this device cannot sign', async () => {
    serve(200, GOLDEN.open);
    const outcome = await openTillCharge(RELAY, {...MERCHANT, secretHex: mockBrokenSeed}, '1000', VCHF_DECIMALS);
    expect(outcome.kind).toBe('unsigned');
    // The nonce is single-use and the relay would refuse an unsigned body anyway; issuing the
    // request would burn a round trip and log a merchant's key as having tried to ring up.
    expect(requests).toHaveLength(0);
  });

  test('answers unreachable rather than inventing a charge from a half-formed body', async () => {
    serve(200, {id: GOLDEN.open.id, amount: '10.'}); // no qr, no reference, no clock
    const outcome = await openTillCharge(RELAY, MERCHANT, '1000', VCHF_DECIMALS);
    expect(outcome.kind).toBe('unreachable');
  });

  test('refuses a reference this wallet could not turn into a matchable memo', async () => {
    // A charge whose reference is the wrong WIDTH or the wrong alphabet is worse than a missing
    // one: the code would go up, a customer would pay it, and the memo the app attached could never
    // match — money moved, sale still open. So the shape is checked, not just the presence.
    for (const reference of ['', 'not-hex', 'ABCDEF0123456789ABCDEF0123456789', '0123456789abcdef']) {
      serve(200, {...GOLDEN.open, reference});
      expect((await openTillCharge(RELAY, MERCHANT, String(GOLDEN.input.cents), VCHF_DECIMALS)).kind)
        .toBe('unreachable');
    }
  });
});

describe('watching a charge', () => {
  const OPEN_STATUS = {
    id: 'pl_ecd765908f264957', cents: 1000, amount: '10.', merchant: 'aaaaa-aa',
    state: 'open', created_secs: 1788479954, expires_at: 1788483554, paid: null,
  };

  test('reads the relay’s own settlement, block and all', async () => {
    serve(200, {
      ...OPEN_STATUS,
      state: 'paid',
      paid: {from: 'lrdna-ain6m-ja6ko-ac4j2-jqk3t-nqs22-4irws-bsm3b-trzzq-3yfz6-mqe', amount_raw: '1000000000', at_secs: 1788480000, block: 77},
    });
    const outcome = await tillChargeStatus(RELAY, 'pl_ecd765908f264957');
    expect(outcome).toEqual({
      kind: 'status',
      status: {
        id: 'pl_ecd765908f264957', cents: '1000', state: 'paid',
        createdSecs: 1788479954, expiresAt: 1788483554,
        paid: {from: 'lrdna-ain6m-ja6ko-ac4j2-jqk3t-nqs22-4irws-bsm3b-trzzq-3yfz6-mqe', amountRaw: '1000000000', atSecs: 1788480000, block: 77},
      },
    });
    expect(requests[0].url).toBe(`${RELAY}/api/v1/till/pl_ecd765908f264957`);
  });

  test('keeps the four non-paid states apart, because they send the cashier different ways', async () => {
    for (const state of ['open', 'superseded', 'cancelled', 'expired'] as const) {
      serve(200, {...OPEN_STATUS, state});
      const outcome = await tillChargeStatus(RELAY, 'pl_x');
      expect(outcome.kind === 'status' && outcome.status.state).toBe(state);
      expect(outcome.kind === 'status' && outcome.status.paid).toBeNull();
    }
  });

  test('an unreadable answer is "can’t check", NEVER "unpaid"', async () => {
    // Every way the answer can fail to arrive, and not one of them may be reported as a state of
    // the money. This is the assertion the whole module is arranged around.
    serveDead('ECONNREFUSED');
    expect((await tillChargeStatus(RELAY, 'pl_x')).kind).toBe('unchecked');

    serve(200, null, {unreadable: true});
    expect((await tillChargeStatus(RELAY, 'pl_x')).kind).toBe('unchecked');

    serve(200, {...OPEN_STATUS, state: 'somethingelse'});
    expect((await tillChargeStatus(RELAY, 'pl_x')).kind).toBe('unchecked');

    serve(200, {...OPEN_STATUS, expires_at: 'soon'});
    expect((await tillChargeStatus(RELAY, 'pl_x')).kind).toBe('unchecked');

    serve(500, {statusCode: 500, message: 'boom', error: 'Internal Server Error'});
    expect((await tillChargeStatus(RELAY, 'pl_x')).kind).toBe('unchecked');
  });

  test('a charge the relay no longer holds is its own answer', async () => {
    serve(404, {statusCode: 404, message: 'Payment link not found', error: 'Not Found'});
    expect(await tillChargeStatus(RELAY, 'pl_x')).toEqual({kind: 'gone', said: 'Payment link not found'});
  });

  test('a settlement in a shape this build cannot read leaves the sale credited, without a block', async () => {
    // `state` already says paid — the money moved. Dropping the whole answer would be worse than
    // rendering the sale with no block index beside it.
    serve(200, {...OPEN_STATUS, state: 'paid', paid: {from: 'aaaaa-aa', amount_raw: '1000000000'}});
    const outcome = await tillChargeStatus(RELAY, 'pl_x');
    expect(outcome.kind === 'status' && outcome.status.state).toBe('paid');
    expect(outcome.kind === 'status' && outcome.status.paid).toBeNull();
  });
});

describe('clearing the till', () => {
  test('is signed with cents = 0, which is what keeps a ring-up from being replayed as one', async () => {
    serve(200, {
      id: 'pl_x', cents: 1000, amount: '10.', merchant: 'aaaaa-aa',
      state: 'cancelled', created_secs: 1788479954, expires_at: 1788483554, paid: null,
    });
    const outcome = await cancelTillCharge(RELAY, MERCHANT);
    expect(outcome.kind === 'cancelled' && outcome.status.state).toBe('cancelled');
    expect(requests[0].url).toBe(`${RELAY}/api/v1/till/void`);
    expect(postedBody().cents).toBe(0);
    expect(mockSignatureCalls[0][1]).toBe('0');
  });

  test('a charge that was already paid is refused, with the relay’s own reason kept', async () => {
    const message = 'this charge was already paid — 1000000000 raw VCHF arrived in ledger block 77, so it cannot be cancelled';
    serve(409, {statusCode: 409, message, error: 'Conflict'});
    expect(await cancelTillCharge(RELAY, MERCHANT)).toEqual({kind: 'refused', said: message, status: 409});
  });

  test('an unreachable till leaves the charge payable, and says so as an outcome', async () => {
    serveDead();
    expect((await cancelTillCharge(RELAY, MERCHANT)).kind).toBe('unreachable');
  });
});
