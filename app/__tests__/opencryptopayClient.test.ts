/**
 * OpenCryptoPay provider client (`services/opencryptopay.ts`) — Unit B of
 * `docs/specs/2026-09-01-opencryptopay-implementation.md`.
 *
 * Every fixture below is a VERBATIM body recorded from the live provider on 2026-09-01 against the
 * public test till `pl_beeddb41cd4b6d9e`, except where a comment says otherwise. No test touches the
 * network: `globalThis.fetch` is replaced at the boundary and restored afterwards, exactly as
 * `relay.test.ts` does for the relay clients (which this file does not otherwise overlap — that
 * suite covers `fetchWithTimeout` itself, this one covers what the OCP client does with its answers).
 *
 * The money-critical case is `submitProof issues EXACTLY ONE request`: the payer's funds are already
 * gone when it runs and the provider spends the attempt either way, so a second request can never
 * succeed and would only delay the honest pending screen.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';

// The IC destination is validated by the REAL core in production; under jest the native module is
// absent, so the base32-CRC parse is stubbed with the one rule this suite depends on — a principal
// either parses to its canonical self or throws. `services/opencryptopay.ts` treats the throw as an
// unusable destination, which is the negative case below.
jest.mock('../services/native', () => ({
  DpayCore: {
    icpValidatePrincipal: (text: string) =>
      /^[a-z0-9]+(-[a-z0-9]+)+$/.test(text) ? Promise.resolve(text) : Promise.reject(new Error(`bad principal: ${text}`)),
  },
}));

import {
  fetchPaymentDetails,
  fetchTransferUri,
  ocpTimeRefusal,
  payAndReport,
  resolveOcpScan,
  submitProof,
  OCP_READ_TIMEOUT_MS,
  OCP_SUBMIT_TIMEOUT_MS,
  type OcpQuoteRef,
} from '../services/opencryptopay';
import {buildSelectableAssets, type SelectableAsset} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {M, applyLocale} from '../i18n';

const realFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------------------------
// Recorded fixtures
// ---------------------------------------------------------------------------------------------

/** `GET https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e?timeout=0` → HTTP 200, verbatim. */
const DETAILS_200 = JSON.parse(
  '{"id":"pl_beeddb41cd4b6d9e","externalId":"TestfürAlle","mode":"Multiple","tag":"payRequest","callback":"https://api.dfx.swiss/v1/lnurlp/cb/pl_beeddb41cd4b6d9e","minSendable":1593000,"maxSendable":1593000,"metadata":"[[\\"text/plain\\",\\"Test Shop - CHF 1\\"]]","displayName":"Test Shop","standard":"OpenCryptoPay","possibleStandards":["OpenCryptoPay"],"displayQr":true,"recipient":{"name":"hier könnte Viktor stehen","address":{"street":"Bahnhofstrasse","houseNumber":"7","city":"Zug","zip":"6300","country":"CH"},"phone":"+41792684224","mail":"mail@ammer.group","website":"https://ammer.group/","registrationNumber":"CHE-429.856.521","storeType":"Physical","merchantCategory":"RetailTradeOthers","goodsType":"Tangible","goodsCategory":"FoodGroceryHealthProducts"},"route":"DFX VM 01","quote":{"id":"plq_ec214dddae51da4d","expiration":"2026-09-01T14:29:42.646Z","payment":"plp_f1ba466e2f1c0a4e"},"requestedAmount":{"asset":"CHF","amount":1},"transferAmounts":[{"method":"Solana","minFee":0,"assets":[{"asset":"USDT","amount":"1.247039"},{"asset":"USDC","amount":"1.247077"},{"asset":"SOL","amount":"0.01221422"}],"available":true},{"method":"InternetComputer","minFee":0,"assets":[{"asset":"VEUR","amount":"1.07480111"},{"asset":"ckBTC","amount":"0.00001596"},{"asset":"VCHF","amount":"1."},{"asset":"ICP","amount":"0.50885919"}],"available":true}]}',
);

/** The provider's error envelope is NestJS's. Recorded for an unknown link id. */
const LINK_NOT_FOUND_404 = {statusCode: 404, message: 'Payment link not found', error: 'Not Found'};

/** CONSTRUCTED, not recorded: the public test till always has a charge on it, so the "no pending
 *  payment" 404 could not be reproduced. Built from the findings doc's measurement that this 404
 *  "still carries the merchant identity" — i.e. the payment-link payload above with the quote and
 *  the transfer amounts absent. What the client keys on is the payload marker (`tag`/`displayName`),
 *  which is present in every recorded payload. */
const NO_PENDING_404 = {
  id: 'pl_beeddb41cd4b6d9e',
  tag: 'payRequest',
  callback: 'https://api.dfx.swiss/v1/lnurlp/cb/pl_beeddb41cd4b6d9e',
  displayName: 'Test Shop',
  standard: 'OpenCryptoPay',
};

/** `GET …/cb/pl_beeddb41cd4b6d9e?quote=…&method=InternetComputer&asset=VCHF` → HTTP 200, verbatim.
 *  Note `amount=1.` — the trailing bare decimal point the findings doc flags. */
const CB_IC_200 = {
  expiryDate: '2026-09-01T14:30:19.292Z',
  blockchain: 'InternetComputer',
  uri: 'icp:ly36x-wiaaa-aaaai-aqj7q-cai/transfer?to=ygf2v-iniac-cojwe-damoz-s4act-k4xft-xgpjy-776wl-wr754-qxkgo-4ae&amount=1.',
  hint: 'Approve the address from the URI for the required amount plus transfer fee using icrc2_approve. Then send your Principal ID as the sender parameter via the endpoint https://api.dfx.swiss/v1/lnurlp/tx/plp_f1ba466e2f1c0a4e.',
};

/** Same call with `method=Solana&asset=SOL` → HTTP 200, verbatim. */
const CB_SOL_200 = {
  expiryDate: '2026-09-01T14:33:09.348Z',
  blockchain: 'Solana',
  uri: 'solana:2eQ2Somiat63oqSPwzQLrrNiceC8F6TH85dt2qDe3z36?amount=0.01221074',
  hint: 'Use this data to create a transaction and sign it. Broadcast the signed transaction to the blockchain and send the transaction hash back via the endpoint https://api.dfx.swiss/v1/lnurlp/tx/plp_f1ba466e2f1c0a4e',
};

/** Same call with an asset the provider does not offer → HTTP 400, verbatim. */
const INVALID_ASSET_400 = {statusCode: 400, message: 'Invalid method or asset', error: 'Bad Request'};

/** `GET …/tx/pl_beeddb41cd4b6d9e?quote=…&tx=999999999999` → HTTP 400, verbatim. */
const TX_NOT_CONFIRMED_400 = {
  statusCode: 400,
  message: 'Transaction 999999999999 not confirmed in blockchain InternetComputer',
  error: 'Bad Request',
};

/** The same submission repeated after the first attempt burned the quote → HTTP 404, verbatim. */
const QUOTE_BURNED_404 = {
  statusCode: 404,
  message: 'No actual quote with ID plq_a6a0ccca07387f91 found',
  error: 'Not Found',
};

const DETAILS: OcpQuoteRef = {
  quoteId: 'plq_ec214dddae51da4d',
  callbackUrl: 'https://api.dfx.swiss/v1/lnurlp/cb/pl_beeddb41cd4b6d9e',
  // Derived by `parsePaymentDetails` from the callback above (proved in `opencryptopay.test.ts`);
  // carried here as the parser hands it over, never re-derived at submission time.
  submitUrl: 'https://api.dfx.swiss/v1/lnurlp/tx/pl_beeddb41cd4b6d9e',
};

// ---------------------------------------------------------------------------------------------
// fetch doubles
// ---------------------------------------------------------------------------------------------

type FetchMock = jest.Mock<(url: string, init?: RequestInit) => Promise<Response>>;

function installResponse(status: number, body: unknown): FetchMock {
  const mock = jest.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response),
  ) as unknown as FetchMock;
  (globalThis as unknown as {fetch: FetchMock}).fetch = mock;
  return mock;
}

/** A response whose body is not JSON (the provider fronted by a proxy error page, a truncated
 *  answer, an empty 200 — all of which `r.json()` surfaces as a throw). */
function installUnreadableBody(status: number): FetchMock {
  const mock = jest.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
    } as unknown as Response),
  ) as unknown as FetchMock;
  (globalThis as unknown as {fetch: FetchMock}).fetch = mock;
  return mock;
}

function installTransportFailure(): FetchMock {
  const mock = jest.fn((_url: string, _init?: RequestInit) =>
    Promise.reject(new TypeError('Network request failed')),
  ) as unknown as FetchMock;
  (globalThis as unknown as {fetch: FetchMock}).fetch = mock;
  return mock;
}

/** Never settles on its own — only the module's own timeout can end it (mirrors a real hung host).
 *  Rejects on abort exactly as `fetch` does. */
function installHangingFetch(): FetchMock {
  const mock = jest.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) {
          reject(new Error('Aborted'));
          return;
        }
        sig?.addEventListener('abort', () => reject(new Error('Aborted')), {once: true});
      }),
  ) as unknown as FetchMock;
  (globalThis as unknown as {fetch: FetchMock}).fetch = mock;
  return mock;
}

function calledUrl(mock: FetchMock, i = 0): URL {
  return new URL(mock.mock.calls[i][0]);
}

// ---------------------------------------------------------------------------------------------
// fetchPaymentDetails
// ---------------------------------------------------------------------------------------------

describe('fetchPaymentDetails', () => {
  test('the VERBATIM recorded 200 body narrows through the real parser — the key names are pinned here', async () => {
    // This is the ONE place a body recorded from the live provider meets `parsePaymentDetails`, so
    // it is what proves the field names the parser reads are the ones DFX actually sends. The pure
    // suite's own cases run on hand-written bodies and cannot establish that.
    const mock = installResponse(200, DETAILS_200);
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e');

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.details.quoteId).toBe(DETAILS.quoteId);
    expect(out.details.callbackUrl).toBe(DETAILS.callbackUrl);
    expect(out.details.claimedMerchantName).toBe('Test Shop');
    expect(out.details.quoteExpiresAt).toBe(Date.parse('2026-09-01T14:29:42.646Z'));
    // The trailing bare decimal point survives the whole round trip, exactly as sent.
    expect(out.details.transferAmounts.find(t => t.method === 'InternetComputer')?.assets)
      .toContainEqual({asset: 'VCHF', amount: '1.'});
    // `timeout=0` asks for the charge that exists now instead of long-polling for one.
    expect(calledUrl(mock).searchParams.get('timeout')).toBe('0');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  test('a query already on the scanned URL survives, and timeout is forced to 0', async () => {
    const mock = installResponse(200, DETAILS_200);
    await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e?timeout=90&lightning=x');
    const u = calledUrl(mock);
    expect(u.searchParams.get('timeout')).toBe('0');
    expect(u.searchParams.get('lightning')).toBe('x');
  });

  test('the 404 that still carries the merchant identity is no-pending, with the name marked claimed', async () => {
    installResponse(404, NO_PENDING_404);
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e');
    expect(out).toEqual({kind: 'no-pending', claimedMerchantName: 'Test Shop'});
  });

  test('the OTHER 404 — an unknown payment link — quotes the provider sentence inside localized framing', async () => {
    installResponse(404, LINK_NOT_FOUND_404);
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_0000000000000000');
    expect(out).toEqual({kind: 'error', message: M.pay.ocp.providerRefused('api.dfx.swiss', 'Payment link not found')});
    // The provider's own words survive — they are what the payer repeats to the merchant — but they
    // are a QUOTED detail, never the whole message: the instruction around them is dpay's, and
    // localized (the app has four locales and no runtime fallback).
    expect(out.kind === 'error' && out.message).toContain('Payment link not found');
    expect(out.kind === 'error' && out.message).not.toBe('Payment link not found');
  });

  test('the quoted provider sentence cannot scroll dpay’s own instruction off the screen', async () => {
    // The refusal a scanned code produces is written by whatever host that code named, and it is
    // rendered — quoted — inside dpay's localized framing. React Native `Text` renders newlines and
    // honours the bidi overrides, so an unsanitised sentence could push the instruction beside it
    // out of view or reorder the words around it. Same weapon, same helper as the merchant name.
    installResponse(400, {statusCode: 400, message: `${'\n'.repeat(60)}Invalid‮ method​ or asset`});
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e');
    // Kept whole — it is the one thing the payer can repeat to the merchant — only neutralised.
    expect(out).toEqual({kind: 'error', message: M.pay.ocp.providerRefused('api.dfx.swiss', 'Invalid method or asset')});
    expect(out.kind === 'error' && out.message).not.toContain('\n');
  });

  test('a non-https provider URL is refused BEFORE any request leaves the device', async () => {
    const mock = installResponse(200, DETAILS_200);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await fetchPaymentDetails('http://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e');
    // The SAME sentence the Pay screens show when `parseOcpScan` refuses a scanned http code: one
    // fact, one sentence, whichever side of the boundary noticed it.
    expect(out).toEqual({kind: 'error', message: M.pay.ocp.notHttps});
    expect(mock).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('not-https');
    warn.mockRestore();
  });

  test('a string that is not a URL at all is refused without a request', async () => {
    const mock = installResponse(200, DETAILS_200);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await fetchPaymentDetails('not-a-url');
    expect(out).toEqual({kind: 'error', message: M.pay.ocp.badCode});
    expect(mock).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('not-a-url');
    warn.mockRestore();
  });

  test('a transport failure is the localized "nothing has been paid" instruction, not a transport string', async () => {
    // NEVER reached the provider ⇒ nothing quoted, nothing paid. The user gets an instruction they
    // can act on; the transport detail is a console diagnostic, not screen copy.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    installTransportFailure();
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e');
    expect(out).toEqual({kind: 'error', message: M.pay.ocp.providerUnreachable});
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('Network request failed');
    warn.mockRestore();
  });

  test('a hung provider aborts at OCP_READ_TIMEOUT_MS and returns an error', async () => {
    jest.useFakeTimers();
    const mock = installHangingFetch();
    const p = fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e');
    expect(mock).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(OCP_READ_TIMEOUT_MS);
    const out = await p;
    expect(out.kind).toBe('error');
  });

  test('a 200 whose body is not JSON is an error — never a half-built details object', async () => {
    installUnreadableBody(200);
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e');
    expect(out).toEqual({kind: 'error', message: M.pay.ocp.badAnswer('api.dfx.swiss', M.pay.ocp.answerPart.body)});
  });

  test('a 5xx with no readable body names the status and the host rather than inventing a reason', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    installUnreadableBody(502);
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e');
    expect(out).toEqual({kind: 'error', message: M.pay.ocp.providerFailed('api.dfx.swiss', '502')});
    // The status reaches the catalog ALREADY a string: a locale-aware number formatter would spell
    // an HTTP status with a group separator, and "error 1.502" names nothing.
    expect(out.kind === 'error' && out.message).toContain('502');
    warn.mockRestore();
  });

  test('a callback on ANOTHER host is refused: one payment cannot answer to two companies', async () => {
    // The scanned code names the host that quotes the price. That host's own JSON body then names
    // the `callback` — a different string from a different source — and the callback host is where
    // the destination address comes from AND where the proof of an irreversible transfer goes. The
    // review can only show one host, so a payment whose two hosts differ would show the payer one
    // company while another one collects the money's proof. Refused BEFORE consent instead, which
    // is what makes the host on the review the host that matters.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    installResponse(200, {...DETAILS_200, callback: 'https://cb.evil.example/v1/lnurlp/cb/pl_beeddb41cd4b6d9e'});
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e');

    expect(out).toEqual({kind: 'error', message: M.pay.ocp.proofElsewhere('api.dfx.swiss', 'cb.evil.example')});
    // BOTH hosts are named on screen — which two they are is the entire content of the warning.
    expect(out.kind === 'error' && out.message).toContain('api.dfx.swiss');
    expect(out.kind === 'error' && out.message).toContain('cb.evil.example');
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('named cb.evil.example as its callback host');
    warn.mockRestore();

    // The measured provider serves both from one host, so the rule costs a real payment nothing.
    installResponse(200, DETAILS_200);
    const same = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e');
    expect(same.kind).toBe('ok');
    expect(same.kind === 'ok' && same.details.proofHost).toBe('api.dfx.swiss');
  });

  test("a 200 the parser refuses surfaces the parser's own reason, never a half-built payment", async () => {
    // A body that is JSON and HTTP-fine but has no quote on it: the narrowing refusal is the answer.
    const noQuote = {...DETAILS_200} as Record<string, unknown>;
    delete noQuote.quote;
    installResponse(200, noQuote);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e');
    // The parser's refusal is a machine CODE. It goes to the console; the payer gets a sentence.
    expect(out).toEqual({kind: 'error', message: M.pay.ocp.badAnswer('api.dfx.swiss', M.pay.ocp.answerPart.details)});
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('malformed-details');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
// fetchTransferUri
// ---------------------------------------------------------------------------------------------

describe('fetchTransferUri', () => {
  test('the Internet Computer answer yields the URI verbatim (trailing bare decimal point intact) and an epoch expiry', async () => {
    const mock = installResponse(200, CB_IC_200);
    const out = await fetchTransferUri(DETAILS, 'InternetComputer', 'VCHF');

    expect(out).toEqual({kind: 'ok', uri: CB_IC_200.uri, expiresAt: Date.parse('2026-09-01T14:30:19.292Z')});
    // The URI is passed through untouched — parsing it belongs to the pure half.
    expect(out.kind === 'ok' && out.uri.endsWith('amount=1.')).toBe(true);

    const u = calledUrl(mock);
    expect(u.pathname).toBe('/v1/lnurlp/cb/pl_beeddb41cd4b6d9e');
    expect(u.searchParams.get('quote')).toBe(DETAILS.quoteId);
    expect(u.searchParams.get('method')).toBe('InternetComputer');
    expect(u.searchParams.get('asset')).toBe('VCHF');
  });

  test('the Solana answer works through the same path (no per-rail special case)', async () => {
    installResponse(200, CB_SOL_200);
    const out = await fetchTransferUri(DETAILS, 'Solana', 'SOL');
    expect(out).toEqual({kind: 'ok', uri: CB_SOL_200.uri, expiresAt: Date.parse('2026-09-01T14:33:09.348Z')});
  });

  test('an asset the provider does not offer surfaces its own sentence', async () => {
    installResponse(400, INVALID_ASSET_400);
    const out = await fetchTransferUri(DETAILS, 'InternetComputer', 'ckUSDC');
    expect(out).toEqual({kind: 'error', message: M.pay.ocp.providerRefused('api.dfx.swiss', 'Invalid method or asset')});
    expect(out.kind === 'error' && out.message).toContain('Invalid method or asset');
  });

  test('a blockchain echo that disagrees with the requested method is refused, not reconciled', async () => {
    // The URI names no asset, so this echo is the only integrity signal the answer carries: paying
    // a Solana address against an InternetComputer choice would send real money to the wrong chain.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    installResponse(200, {...CB_SOL_200, blockchain: 'Solana'});
    const out = await fetchTransferUri(DETAILS, 'InternetComputer', 'VCHF');
    // Answering for another chain IS answering with a destination the payer did not choose.
    expect(out).toEqual({kind: 'error', message: M.pay.ocp.badDestination('api.dfx.swiss')});
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('answered for Solana when InternetComputer/VCHF');
    warn.mockRestore();
  });

  test('a 200 with no uri is an error rather than an empty destination', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    installResponse(200, {expiryDate: CB_IC_200.expiryDate, blockchain: 'InternetComputer'});
    const out = await fetchTransferUri(DETAILS, 'InternetComputer', 'VCHF');
    expect(out).toEqual({kind: 'error', message: M.pay.ocp.badAnswer('api.dfx.swiss', M.pay.ocp.answerPart.destination)});
    warn.mockRestore();
  });

  test('a missing or unreadable expiry is one fact for the payer, with the raw value logged', async () => {
    // Both mean the same thing on screen — dpay cannot tell how long this price is good for, so it
    // will not sign against it. The unusable value itself is a console diagnostic, not copy.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const expected = {kind: 'error', message: M.pay.ocp.badAnswer('api.dfx.swiss', M.pay.ocp.answerPart.expiry)};

    installResponse(200, {...CB_IC_200, expiryDate: 'soon'});
    expect(await fetchTransferUri(DETAILS, 'InternetComputer', 'VCHF')).toEqual(expected);

    const noExpiry = {...CB_IC_200} as Record<string, unknown>;
    delete noExpiry.expiryDate;
    installResponse(200, noExpiry);
    expect(await fetchTransferUri(DETAILS, 'InternetComputer', 'VCHF')).toEqual(expected);

    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('(soon)');
    warn.mockRestore();
  });

  test('an expiry without a UTC zone is unreadable, not read as device-local time', async () => {
    // The transfer instruction's deadline gets the SAME strict parser as the quote's own expiry.
    // `Date.parse("2026-09-01 14:30:19")` succeeds and V8 reads it in the DEVICE's zone, so a phone
    // in UTC+14 would believe a dead price is live and spend the one-shot submission on it. The
    // oracle is asserted rather than assumed.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(Number.isFinite(Date.parse('2026-09-01 14:30:19'))).toBe(true);
    installResponse(200, {...CB_IC_200, expiryDate: '2026-09-01 14:30:19'});
    expect(await fetchTransferUri(DETAILS, 'InternetComputer', 'VCHF')).toEqual({
      kind: 'error',
      message: M.pay.ocp.badAnswer('api.dfx.swiss', M.pay.ocp.answerPart.expiry),
    });
    // The recorded spelling still reads, to the exact millisecond — this is a narrowing, not a ban.
    installResponse(200, CB_IC_200);
    expect(await fetchTransferUri(DETAILS, 'InternetComputer', 'VCHF')).toEqual({
      kind: 'ok',
      uri: CB_IC_200.uri,
      expiresAt: Date.UTC(2026, 8, 1, 14, 30, 19, 292),
    });
    warn.mockRestore();
  });

  test('a provider-supplied http callback is refused before any request leaves the device', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mock = installResponse(200, CB_IC_200);
    const out = await fetchTransferUri(
      {...DETAILS, callbackUrl: 'http://api.dfx.swiss/v1/lnurlp/cb/pl_beeddb41cd4b6d9e'},
      'InternetComputer',
      'VCHF',
    );
    // The callback is a SECOND, independent downgrade hole (it arrives inside the provider's JSON,
    // not off the sticker) and gets the same refusal the scanned code gets.
    expect(out).toEqual({kind: 'error', message: M.pay.ocp.notHttps});
    expect(mock).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('not-https');
    warn.mockRestore();
  });

  test('a transport failure is the same localized "nothing has been paid" instruction as step 2', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    installTransportFailure();
    const out = await fetchTransferUri(DETAILS, 'InternetComputer', 'VCHF');
    expect(out).toEqual({kind: 'error', message: M.pay.ocp.providerUnreachable});
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
// submitProof — one-shot
// ---------------------------------------------------------------------------------------------

describe('submitProof', () => {
  // THE money-critical invariant. The transfer is already on-chain when this runs and the provider
  // spends the attempt whether or not it answers: a second call gets `404 No actual quote…` and the
  // transaction id is already bound, so a retry cannot succeed and would only delay the honest
  // pending screen. A timeout must therefore end in `unknown` after EXACTLY ONE request.
  test('a timing-out submission returns unknown and issues EXACTLY ONE request', async () => {
    jest.useFakeTimers();
    const mock = installHangingFetch();

    const p = submitProof(DETAILS, 'InternetComputer', 'VCHF', '8168');
    expect(mock).toHaveBeenCalledTimes(1); // the single request is in flight

    jest.advanceTimersByTime(OCP_SUBMIT_TIMEOUT_MS);
    const out = await p;

    expect(out.kind).toBe('unknown');
    expect(mock).toHaveBeenCalledTimes(1); // and no second attempt was ever made
    expect(out.kind === 'unknown' && out.detail).toContain('8168');
  });

  test('a transport failure is unknown after exactly one request, never a failure', async () => {
    const mock = installTransportFailure();
    const out = await submitProof(DETAILS, 'InternetComputer', 'VCHF', '8168');
    expect(out.kind).toBe('unknown');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  test('a 200 with a readable body is accepted, and the request is /tx/ carrying quote, method, asset and tx', async () => {
    const mock = installResponse(200, {});
    const out = await submitProof(DETAILS, 'InternetComputer', 'VCHF', '8168');

    expect(out).toEqual({kind: 'accepted'});
    expect(mock).toHaveBeenCalledTimes(1);
    const u = calledUrl(mock);
    expect(u.origin).toBe('https://api.dfx.swiss');
    expect(u.pathname).toBe('/v1/lnurlp/tx/pl_beeddb41cd4b6d9e'); // the callback's /cb/ became /tx/
    expect(u.searchParams.get('quote')).toBe(DETAILS.quoteId);
    expect(u.searchParams.get('method')).toBe('InternetComputer');
    expect(u.searchParams.get('asset')).toBe('VCHF');
    expect(u.searchParams.get('tx')).toBe('8168');
  });

  test('a 400 is a definitive refusal carrying the provider sentence', async () => {
    installResponse(400, TX_NOT_CONFIRMED_400);
    const out = await submitProof(DETAILS, 'InternetComputer', 'VCHF', '999999999999');
    expect(out).toEqual({
      kind: 'rejected',
      detail: 'Transaction 999999999999 not confirmed in blockchain InternetComputer',
    });
  });

  test('the burned-quote 404 is a refusal too — a 4xx with a body is definitive', async () => {
    installResponse(404, QUOTE_BURNED_404);
    const out = await submitProof(DETAILS, 'InternetComputer', 'VCHF', '999999999999');
    expect(out).toEqual({kind: 'rejected', detail: QUOTE_BURNED_404.message});
  });

  test('a 4xx whose body gives no reason still refuses, and names the status instead of inventing one', async () => {
    installResponse(403, {statusCode: 403});
    const out = await submitProof(DETAILS, 'InternetComputer', 'VCHF', '8168');
    expect(out).toEqual({kind: 'rejected', detail: 'api.dfx.swiss refused transfer 8168 with HTTP 403 and gave no reason'});
  });

  test('a 200 whose body cannot be read is unknown, NOT accepted', async () => {
    // The asymmetry is deliberate: a false pending costs a conversation with the merchant, a false
    // "paid" costs the goods.
    const mock = installUnreadableBody(200);
    const out = await submitProof(DETAILS, 'InternetComputer', 'VCHF', '8168');
    expect(out.kind).toBe('unknown');
    expect(out.kind === 'unknown' && out.detail).toContain('8168');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  test('a 4xx whose body cannot be read is unknown, NOT rejected — a refusal must be readable to be definitive', async () => {
    installUnreadableBody(400);
    const out = await submitProof(DETAILS, 'InternetComputer', 'VCHF', '8168');
    expect(out.kind).toBe('unknown');
  });

  test('a 5xx is unknown — a provider fault says nothing about whether the payment landed', async () => {
    installResponse(503, {statusCode: 503, message: 'Service Unavailable', error: 'Service Unavailable'});
    const out = await submitProof(DETAILS, 'InternetComputer', 'VCHF', '8168');
    expect(out.kind).toBe('unknown');
    expect(out.kind === 'unknown' && out.detail).toContain('HTTP 503');
  });

  // This used to pin the DEFECT: the `/cb/` check that decides whether a proof can be reported AT
  // ALL ran HERE, after the transfer. A provider whose callback carries no `/cb/` therefore made
  // the funds move irreversibly and then issued no request at all. The check now lives in
  // `parsePaymentDetails`, before consent (pinned in `opencryptopay.test.ts`, and end to end by
  // `resolveOcpScan` below); what is left to pin here is that this function submits to the URL it
  // was HANDED and re-derives nothing.
  test('the submission goes to the URL the parser derived, and http on it still sends nothing', async () => {
    // The submission URL is carried, not rebuilt — so a hand-written one is what gets called…
    const mock = installResponse(200, {});
    await submitProof({...DETAILS, submitUrl: 'https://api.dfx.swiss/other/place/tx/xyz'}, 'InternetComputer', 'VCHF', '8168');
    expect(calledUrl(mock).pathname).toBe('/other/place/tx/xyz');

    // …and the https rule is still enforced at this boundary, because `OcpQuoteRef` is a plain
    // structural input and this is the last point before an irreversible transfer is reported.
    const blocked = installResponse(200, {});
    const out = await submitProof(
      {...DETAILS, submitUrl: 'http://api.dfx.swiss/v1/lnurlp/tx/pl_beeddb41cd4b6d9e'},
      'InternetComputer',
      'VCHF',
      '8168',
    );
    expect(out.kind).toBe('unknown');
    expect(out.kind === 'unknown' && out.detail).toContain('not-https');
    expect(out.kind === 'unknown' && out.detail).toContain('8168');
    expect(blocked).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// resolveOcpScan — everything before the payer approves
// ---------------------------------------------------------------------------------------------

/** Answer per URL, so one test can serve the payment-details read AND the transfer-details read.
 *  Routes are matched by substring, first match wins; an unmatched URL fails the test loudly rather
 *  than silently returning something plausible. */
function installRoutes(routes: Array<{match: string; status: number; body: unknown}>): FetchMock {
  const mock = jest.fn((url: string, _init?: RequestInit) => {
    const route = routes.find(r => url.includes(r.match));
    if (!route) return Promise.reject(new Error(`unrouted request: ${url}`));
    return Promise.resolve({
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: () => Promise.resolve(route.body),
    } as unknown as Response);
  }) as unknown as FetchMock;
  (globalThis as unknown as {fetch: FetchMock}).fetch = mock;
  return mock;
}

const SCAN = {apiUrl: 'https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e', host: 'api.dfx.swiss'};
/** The wallet's REAL shipped rows, so the assets under test are the ones the app actually offers. */
const WALLET_ASSETS = buildSelectableAssets(icpCatalogOf(BUNDLED_NETWORKS), {
  showTestnet: false,
  solanaEnabled: true,
  solanaUsdc: true,
});
const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
/** Inside the recorded quote's 300s window (it expires at 14:29:42.646Z), with room to spare for
 *  the whole sequence: 102s of quote left against the 90s budget the tests below use. */
const NOW = Date.parse('2026-09-01T14:28:00.000Z');
/** A rail's worst case from Approve to a confirmed on-chain reference. 60s stands in for the SOL
 *  rail's `SOL_SEND_TIMEOUT_MS`; the real value is the caller's, which is the point of the
 *  parameter — the resolver adds `OCP_SUBMIT_TIMEOUT_MS` (30s) on top, so 90s is required here. */
const SEQUENCE_MS = 60_000;

function assetById(id: string): SelectableAsset {
  const a = WALLET_ASSETS.find(x => x.id === id);
  if (a === undefined) throw new Error(`the bundled catalog must carry ${id}`);
  return a;
}

function ctx(id: string, nowMs = NOW) {
  return {selected: assetById(id), assets: WALLET_ASSETS, catalog: CATALOG, nowMs, sequenceBudgetMs: SEQUENCE_MS};
}

describe('resolveOcpScan', () => {
  test('the recorded till + the selected asset produce the exact transfer the payer will approve', async () => {
    const mock = installRoutes([
      {match: '/lnurlp/cb/', status: 200, body: CB_IC_200},
      {match: '/lnurlp/pl_', status: 200, body: DETAILS_200},
    ]);
    const out = await resolveOcpScan(SCAN, ctx('ic:7')); // VCHF

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.target.method).toBe('InternetComputer');
    expect(out.target.asset).toBe('VCHF');
    expect(out.target.assetId).toBe('ic:7');
    expect(out.target.to).toBe('ygf2v-iniac-cojwe-damoz-s4act-k4xft-xgpjy-776wl-wr754-qxkgo-4ae');
    // `1.` — the trailing bare decimal point — at VCHF's 8 decimals, converted exactly once.
    expect(out.target.rawAmount).toBe('100000000');
    // The EARLIER of the two deadlines the provider stated (here the quote's).
    expect(out.target.expiresAt).toBe(Date.parse('2026-09-01T14:29:42.646Z'));
    // …minus the whole sequence's worst case: the rail's own budget plus the one-shot submission's
    // timeout. This is the deadline the countdown shows and Approve is gated on.
    expect(out.target.payableUntil).toBe(out.target.expiresAt - SEQUENCE_MS - OCP_SUBMIT_TIMEOUT_MS);
    expect(out.target.host).toBe('api.dfx.swiss');
    expect(out.target.details.claimedMerchantName).toBe('Test Shop');
    // The chosen method + asset are echoed back verbatim on the transfer-details call.
    const cb = new URL(mock.mock.calls[1][0]);
    expect(cb.searchParams.get('method')).toBe('InternetComputer');
    expect(cb.searchParams.get('asset')).toBe('VCHF');
    expect(cb.searchParams.get('quote')).toBe('plq_ec214dddae51da4d');
  });

  test('a destination on ANOTHER ledger is refused — never paid because the amount looked right', async () => {
    // ICP is on the till's list and is a wallet asset, but the provider answers with the VCHF
    // ledger's address. Paying it would send ICP to a VCHF ledger account: a different asset.
    installRoutes([
      {match: '/lnurlp/cb/', status: 200, body: CB_IC_200},
      {match: '/lnurlp/pl_', status: 200, body: DETAILS_200},
    ]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await resolveOcpScan(SCAN, ctx('ic:8')); // ICP
    expect(out).toEqual({kind: 'refused', message: M.pay.ocp.badDestination('api.dfx.swiss')});
    warn.mockRestore();
  });

  test('an amount that disagrees with the quoted one is refused, not signed', async () => {
    installRoutes([
      {match: '/lnurlp/cb/', status: 200, body: {...CB_IC_200, uri: CB_IC_200.uri.replace('amount=1.', 'amount=2')}},
      {match: '/lnurlp/pl_', status: 200, body: DETAILS_200},
    ]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await resolveOcpScan(SCAN, ctx('ic:7'));
    expect(out).toEqual({kind: 'refused', message: M.pay.ocp.badDestination('api.dfx.swiss')});
    // The refusal is diagnosable: both numbers reach the console.
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('expected 100000000 raw');
    warn.mockRestore();
  });

  test('an unusable destination address is refused by the core validator, before the payer sees it', async () => {
    installRoutes([
      {match: '/lnurlp/cb/', status: 200, body: {...CB_IC_200, uri: CB_IC_200.uri.replace(/to=[^&]+/, 'to=Not_A_Principal')}},
      {match: '/lnurlp/pl_', status: 200, body: DETAILS_200},
    ]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await resolveOcpScan(SCAN, ctx('ic:7'));
    expect(out).toEqual({kind: 'refused', message: M.pay.ocp.badDestination('api.dfx.swiss')});
    warn.mockRestore();
  });

  test('a Solana target resolves through the same path, with the amount in lamports', async () => {
    // The recorded `CB_SOL_200` came from a DIFFERENT quote than `DETAILS_200` (every read mints a
    // new one), so its amount is a few lamports off. Aligned here to the quoted SOL amount, which
    // is what a single quote's two reads must agree on.
    const cb = {...CB_SOL_200, uri: CB_SOL_200.uri.replace('amount=0.01221074', 'amount=0.01221422')};
    installRoutes([
      {match: '/lnurlp/cb/', status: 200, body: cb},
      {match: '/lnurlp/pl_', status: 200, body: DETAILS_200},
    ]);
    const out = await resolveOcpScan(SCAN, ctx('solana:SOL'));
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.target.method).toBe('Solana');
    expect(out.target.to).toBe('2eQ2Somiat63oqSPwzQLrrNiceC8F6TH85dt2qDe3z36');
    expect(out.target.rawAmount).toBe('12214220');
  });

  test('an asset the till does not take is refused by name, with the ones it does take', async () => {
    installRoutes([{match: '/lnurlp/pl_', status: 200, body: DETAILS_200}]);
    const out = await resolveOcpScan(SCAN, ctx('ic:2')); // ckUSDC — dpay's launch rail, not accepted
    expect(out).toEqual({
      kind: 'refused',
      // Named as the WALLET names them, in the order the till listed them.
      message: M.pay.ocp.assetNotAccepted('USDC', 'SOL, BTC, VCHF, ICP'),
    });
  });

  test('a till whose every asset is unpayable here says so, instead of pointing at Balances', async () => {
    // "Switch asset in Balances" is only an instruction when there IS one to switch to.
    const onlyForeign = {
      ...DETAILS_200,
      transferAmounts: [{method: 'Solana', assets: [{asset: 'USDT', amount: '1.24'}], available: true}],
    };
    installRoutes([{match: '/lnurlp/pl_', status: 200, body: onlyForeign}]);
    const out = await resolveOcpScan(SCAN, ctx('ic:7'));
    expect(out).toEqual({kind: 'refused', message: M.pay.ocp.noPayableAsset('USDT')});
  });

  test('a method the provider marks unavailable is refused as that, with what the till can still take', async () => {
    // MEASURED: `transferAmounts[].available` is false for methods the provider currently cannot
    // service. "This till doesn't take VCHF" would be a lie here — it does; the provider just
    // can't settle it right now — so the copy has to say that and name the way out.
    const icDown = {
      ...DETAILS_200,
      transferAmounts: DETAILS_200.transferAmounts.map((t: {method: string}) =>
        t.method === 'InternetComputer' ? {...t, available: false} : t,
      ),
    };
    installRoutes([{match: '/lnurlp/pl_', status: 200, body: icDown}]);
    expect(await resolveOcpScan(SCAN, ctx('ic:7'))).toEqual({
      kind: 'refused',
      message: M.pay.ocp.methodUnavailable('VCHF', 'SOL'),
    });

    // With every method down there is nothing to switch to, so the instruction changes: pointing at
    // Balances would send the payer looking for an asset that cannot help.
    const allDown = {
      ...DETAILS_200,
      transferAmounts: DETAILS_200.transferAmounts.map((t: object) => ({...t, available: false})),
    };
    installRoutes([{match: '/lnurlp/pl_', status: 200, body: allDown}]);
    expect(await resolveOcpScan(SCAN, ctx('ic:7'))).toEqual({
      kind: 'refused',
      message: M.pay.ocp.methodUnavailable('VCHF', null),
    });
  });

  test('an unavailable method is not blamed for an asset the till never offered', async () => {
    // The refusal must be matched to the SELECTED asset. The live provider marks methods this
    // wallet has no rail for unavailable on every response, so an unmatched check would tell a
    // ckUSDC payer their asset was blocked when the till simply does not take it.
    const solDown = {
      ...DETAILS_200,
      transferAmounts: DETAILS_200.transferAmounts.map((t: {method: string}) =>
        t.method === 'Solana' ? {...t, available: false} : t,
      ),
    };
    installRoutes([{match: '/lnurlp/pl_', status: 200, body: solDown}]);
    expect(await resolveOcpScan(SCAN, ctx('ic:2'))).toEqual({
      kind: 'refused',
      message: M.pay.ocp.assetNotAccepted('USDC', 'BTC, VCHF, ICP'),
    });
  });

  test('Solana USDC is refused BY NAME rather than dropped from the list', async () => {
    installRoutes([{match: '/lnurlp/pl_', status: 200, body: DETAILS_200}]);
    const out = await resolveOcpScan(SCAN, ctx('solana:USDC'));
    expect(out).toEqual({kind: 'refused', message: M.pay.ocp.solanaUsdcUnsupported});
  });

  test('an expired quote is the whole story — no per-asset advice on top of it', async () => {
    installRoutes([{match: '/lnurlp/pl_', status: 200, body: DETAILS_200}]);
    const out = await resolveOcpScan(SCAN, ctx('ic:7', Date.parse('2026-09-01T14:29:42.646Z')));
    expect(out).toEqual({kind: 'refused', message: M.pay.ocp.quoteExpired});
  });

  // THE money-critical deadline. "Has it expired yet" is the wrong question for a one-shot: the
  // funds move first and the single submission has to reach a LIVE quote, so a payment started with
  // less than the sequence's worst case left spends everything and buys nothing. The countdown on
  // the review invites exactly that press, which is why the runway — not the expiry — is the gate.
  test('a quote that cannot fit the whole sequence is refused even though it has not expired', async () => {
    const expiry = Date.parse('2026-09-01T14:29:42.646Z');
    installRoutes([
      {match: '/lnurlp/cb/', status: 200, body: CB_IC_200},
      {match: '/lnurlp/pl_', status: 200, body: DETAILS_200},
    ]);
    // Exactly 90s left of a 300s quote: still ticking, but the sequence's worst case would end at
    // the very instant the price dies, so it is refused rather than started.
    const out = await resolveOcpScan(SCAN, ctx('ic:7', expiry - SEQUENCE_MS - OCP_SUBMIT_TIMEOUT_MS));
    // NOT "expired" — the payer can see the price still counting down, so that word would be a
    // visible lie. Its own sentence, with the same next action.
    expect(out).toEqual({kind: 'refused', message: M.pay.ocp.notEnoughTime});
    expect(M.pay.ocp.notEnoughTime).not.toBe(M.pay.ocp.quoteExpired);

    // One millisecond more of runway and the same quote is payable: the boundary is exact, not a
    // rounded cushion.
    installRoutes([
      {match: '/lnurlp/cb/', status: 200, body: CB_IC_200},
      {match: '/lnurlp/pl_', status: 200, body: DETAILS_200},
    ]);
    const ok = await resolveOcpScan(SCAN, ctx('ic:7', expiry - SEQUENCE_MS - OCP_SUBMIT_TIMEOUT_MS - 1));
    expect(ok.kind).toBe('ok');
  });

  test('the required runway tracks the rail budget it is given, not a fixed number', async () => {
    // The whole point of `sequenceBudgetMs`: the IC rail's worst case is minutes longer than the
    // Solana rail's, so a deadline hard-coded here would be wrong for one of them — and would stay
    // wrong the day a timeout constant changes.
    const expiry = Date.parse('2026-09-01T14:29:42.646Z');
    const at = expiry - 120_000; // two minutes of quote left
    installRoutes([
      {match: '/lnurlp/cb/', status: 200, body: CB_IC_200},
      {match: '/lnurlp/pl_', status: 200, body: DETAILS_200},
    ]);
    expect((await resolveOcpScan(SCAN, {...ctx('ic:7', at), sequenceBudgetMs: 60_000})).kind).toBe('ok');
    installRoutes([
      {match: '/lnurlp/cb/', status: 200, body: CB_IC_200},
      {match: '/lnurlp/pl_', status: 200, body: DETAILS_200},
    ]);
    expect(await resolveOcpScan(SCAN, {...ctx('ic:7', at), sequenceBudgetMs: 100_000}))
      .toEqual({kind: 'refused', message: M.pay.ocp.notEnoughTime});
  });

  test('a till whose callback yields no submission URL never reaches the payer at all', async () => {
    // Finding 1, end to end: the funds must not move for a provider that could never be told about
    // them. Refused BEFORE the review, with its own instruction — another scan gets the same
    // callback, so "scan again" would be a dead end; the way out is another payment method.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    installRoutes([
      {match: '/lnurlp/pl_', status: 200, body: {...DETAILS_200, callback: 'https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e'}},
    ]);
    const out = await resolveOcpScan(SCAN, ctx('ic:7'));
    expect(out).toEqual({kind: 'refused', message: M.pay.ocp.unreportable('api.dfx.swiss')});
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('unreportable-callback');
    warn.mockRestore();
  });

  test('a till whose callback points at another host never reaches the destination call', async () => {
    // End to end: the divergence stops the sequence at the FIRST read. The `/cb/` route below is
    // fixtured and must stay untouched — asking that host for a destination address would already
    // be following the redirect this refusal exists to stop.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mock = installRoutes([
      {match: '/lnurlp/cb/', status: 200, body: CB_IC_200},
      {match: '/lnurlp/pl_', status: 200, body: {...DETAILS_200, callback: 'https://cb.evil.example/v1/lnurlp/cb/pl_beeddb41cd4b6d9e'}},
    ]);
    const out = await resolveOcpScan(SCAN, ctx('ic:7'));
    expect(out).toEqual({kind: 'refused', message: M.pay.ocp.proofElsewhere('api.dfx.swiss', 'cb.evil.example')});
    expect(mock).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('a till with no charge on it names the merchant and what the cashier must do', async () => {
    installRoutes([{match: '/lnurlp/pl_', status: 404, body: NO_PENDING_404}]);
    const out = await resolveOcpScan(SCAN, ctx('ic:7'));
    expect(out).toEqual({kind: 'refused', message: M.pay.ocp.noPendingCharge('Test Shop')});
  });

  test('the transfer-details call failing stops the sequence with the provider’s own reason', async () => {
    installRoutes([
      {match: '/lnurlp/cb/', status: 400, body: INVALID_ASSET_400},
      {match: '/lnurlp/pl_', status: 200, body: DETAILS_200},
    ]);
    const out = await resolveOcpScan(SCAN, ctx('ic:7'));
    expect(out).toEqual({kind: 'refused', message: M.pay.ocp.providerRefused('api.dfx.swiss', 'Invalid method or asset')});
  });
});

// ---------------------------------------------------------------------------------------------
// ocpTimeRefusal — the ONE approve gate, shared by the resolver, both rails and the countdown
// ---------------------------------------------------------------------------------------------

describe('ocpTimeRefusal', () => {
  const AT = 1_800_000_000_000;

  test('answers null only while the whole sequence still fits, and names which deadline passed', () => {
    const target = {expiresAt: AT, payableUntil: AT - 90_000};
    expect(ocpTimeRefusal(target, AT - 90_001)).toBeNull();
    // The instant the runway is gone the press is refused, one full sequence BEFORE the quote dies.
    expect(ocpTimeRefusal(target, AT - 90_000)).toBe(M.pay.ocp.notEnoughTime);
    expect(ocpTimeRefusal(target, AT - 1)).toBe(M.pay.ocp.notEnoughTime);
    // Past the quote itself, the honest word changes: nothing about this price is live any more.
    expect(ocpTimeRefusal(target, AT)).toBe(M.pay.ocp.quoteExpired);
  });

  test('an expired quote is never reported as merely short of time', () => {
    // Reachable when the provider's transfer instruction expires before the quote does: the two
    // deadlines come from two different calls, and `expiresAt` is the earlier of them.
    expect(ocpTimeRefusal({expiresAt: AT, payableUntil: AT - 90_000}, AT + 60_000)).toBe(M.pay.ocp.quoteExpired);
  });
});

// ---------------------------------------------------------------------------------------------
// payAndReport — the binding order
// ---------------------------------------------------------------------------------------------

describe('payAndReport', () => {
  const REFERENCE = M.pay.ocp.ref.icBlock('8168');
  const settled = () => Promise.resolve({kind: 'settled' as const, txId: '8168', reference: REFERENCE});

  test('a confirmed transfer is reported EXACTLY once, and a 2xx is paid', async () => {
    const mock = installResponse(200, {});
    const out = await payAndReport(DETAILS, 'InternetComputer', 'VCHF', settled);
    expect(out).toEqual({kind: 'paid'});
    expect(mock).toHaveBeenCalledTimes(1);
    expect(calledUrl(mock).searchParams.get('tx')).toBe('8168');
  });

  // THE money-critical case. A transfer whose outcome is unknown must not be reported: the provider
  // grants one submission and binds the transaction id to the quote even when it FAILS, so guessing
  // costs the payer the ability to claim the payment at all.
  test('an UNKNOWN transfer is never reported — no request leaves the device', async () => {
    const mock = installResponse(200, {});
    const out = await payAndReport(DETAILS, 'InternetComputer', 'VCHF', () =>
      Promise.resolve({kind: 'unknown' as const}),
    );
    expect(out).toEqual({kind: 'unresolved', message: M.pay.ocp.transferUnknown});
    expect(mock).not.toHaveBeenCalled();
  });

  test('a transfer that definitively did not happen is not reported either, and stays retryable', async () => {
    const mock = installResponse(200, {});
    const out = await payAndReport(DETAILS, 'InternetComputer', 'VCHF', () =>
      Promise.resolve({kind: 'refused' as const, message: 'Not enough balance'}),
    );
    expect(out).toEqual({kind: 'not-paid', message: 'Not enough balance'});
    expect(mock).not.toHaveBeenCalled();
  });

  test('a provider refusal AFTER the money moved is unresolved, and hands over the reference', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    installResponse(400, TX_NOT_CONFIRMED_400);
    const out = await payAndReport(DETAILS, 'InternetComputer', 'VCHF', settled);
    expect(out).toEqual({kind: 'unresolved', message: M.pay.ocp.submitRejected(REFERENCE)});
    // The provider's own sentence is diagnostic, and stays out of the user's instruction.
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('not confirmed in blockchain');
    warn.mockRestore();
  });

  test('a provider that never answers is unresolved too — neither paid nor failed', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    installTransportFailure();
    const out = await payAndReport(DETAILS, 'InternetComputer', 'VCHF', settled);
    expect(out).toEqual({kind: 'unresolved', message: M.pay.ocp.submitUnknown(REFERENCE)});
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
// The copy boundary — four locales, no runtime fallback
// ---------------------------------------------------------------------------------------------

describe('provider failures are localized, and the provider’s own sentence survives as a quote', () => {
  // The bug this pins: a message assembled from inline English reaches a German payer in English,
  // because the catalog has no runtime fallback to fall back FROM. Asserted without copying a word
  // of any catalog into this file — the two locales' answers are compared to each other.
  afterEach(() => { applyLocale('en', 'en-US'); });

  test('the same provider refusal reads differently per locale and quotes the provider either way', async () => {
    installResponse(404, LINK_NOT_FOUND_404);
    const url = 'https://api.dfx.swiss/v1/lnurlp/pl_0000000000000000';
    const said = LINK_NOT_FOUND_404.message;

    applyLocale('en', 'en-US');
    const english = await fetchPaymentDetails(url);
    applyLocale('de', 'de-DE');
    const german = await fetchPaymentDetails(url);

    expect(english.kind).toBe('error');
    expect(german.kind).toBe('error');
    expect(english.kind === 'error' && english.message).not.toBe(german.kind === 'error' && german.message);
    for (const out of [english, german]) {
      // The provider's diagnostic sentence is kept — it is what the payer repeats to the merchant —
      // but it is never the whole message on either side of the switch.
      expect(out.kind === 'error' && out.message).toContain(said);
      expect(out.kind === 'error' && out.message).not.toBe(said);
    }
  });
});
