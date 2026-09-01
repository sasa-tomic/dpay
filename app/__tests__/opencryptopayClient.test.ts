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
import {
  fetchPaymentDetails,
  fetchTransferUri,
  submitProof,
  OCP_READ_TIMEOUT_MS,
  OCP_SUBMIT_TIMEOUT_MS,
  type OcpDetails,
  type OcpParseDetails,
} from '../services/opencryptopay';

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

const DETAILS: OcpDetails = {
  quoteId: 'plq_ec214dddae51da4d',
  callbackUrl: 'https://api.dfx.swiss/v1/lnurlp/cb/pl_beeddb41cd4b6d9e',
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

/** The pure half's parser, stubbed. Records what it was handed so the round trip is checkable. */
type ParsedDetails = OcpDetails & {claimedMerchantName: string};
function parserOk(seen: unknown[]): OcpParseDetails<ParsedDetails> {
  return json => {
    seen.push(json);
    return {ok: true, details: {...DETAILS, claimedMerchantName: 'Test Shop'}};
  };
}
const parserRefusing: OcpParseDetails<ParsedDetails> = () => ({ok: false, reason: 'quote-expired'});

// ---------------------------------------------------------------------------------------------
// fetchPaymentDetails
// ---------------------------------------------------------------------------------------------

describe('fetchPaymentDetails', () => {
  test('a live 200 payload is handed to the injected parser and its details returned verbatim', async () => {
    const mock = installResponse(200, DETAILS_200);
    const seen: unknown[] = [];
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e', parserOk(seen));

    expect(out).toEqual({kind: 'ok', details: {...DETAILS, claimedMerchantName: 'Test Shop'}});
    // The whole body reaches the parser — this module narrows nothing itself.
    expect(seen).toEqual([DETAILS_200]);
    // `timeout=0` asks for the charge that exists now instead of long-polling for one.
    expect(calledUrl(mock).searchParams.get('timeout')).toBe('0');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  test('a query already on the scanned URL survives, and timeout is forced to 0', async () => {
    const mock = installResponse(200, DETAILS_200);
    await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e?timeout=90&lightning=x', parserOk([]));
    const u = calledUrl(mock);
    expect(u.searchParams.get('timeout')).toBe('0');
    expect(u.searchParams.get('lightning')).toBe('x');
  });

  test('the 404 that still carries the merchant identity is no-pending, with the name marked claimed', async () => {
    installResponse(404, NO_PENDING_404);
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e', parserOk([]));
    expect(out).toEqual({kind: 'no-pending', claimedMerchantName: 'Test Shop'});
  });

  test('the OTHER 404 — an unknown payment link — is an error carrying the provider sentence, not no-pending', async () => {
    installResponse(404, LINK_NOT_FOUND_404);
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_0000000000000000', parserOk([]));
    expect(out).toEqual({kind: 'error', message: 'Payment link not found'});
  });

  test('a non-https provider URL is refused BEFORE any request leaves the device', async () => {
    const mock = installResponse(200, DETAILS_200);
    const out = await fetchPaymentDetails('http://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e', parserOk([]));
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('must be https');
    expect(mock).not.toHaveBeenCalled();
  });

  test('a string that is not a URL at all is refused without a request', async () => {
    const mock = installResponse(200, DETAILS_200);
    const out = await fetchPaymentDetails('not-a-url', parserOk([]));
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('Not a usable provider address');
    expect(mock).not.toHaveBeenCalled();
  });

  test('a transport failure is an error naming the host (nothing has been paid yet)', async () => {
    installTransportFailure();
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e', parserOk([]));
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('api.dfx.swiss');
    expect(out.kind === 'error' && out.message).toContain('Network request failed');
  });

  test('a hung provider aborts at OCP_READ_TIMEOUT_MS and returns an error', async () => {
    jest.useFakeTimers();
    const mock = installHangingFetch();
    const p = fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e', parserOk([]));
    expect(mock).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(OCP_READ_TIMEOUT_MS);
    const out = await p;
    expect(out.kind).toBe('error');
  });

  test('a 200 whose body is not JSON is an error — never a half-built details object', async () => {
    installUnreadableBody(200);
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e', parserOk([]));
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('unreadable body');
  });

  test('a 5xx with no readable body names the status and the host rather than inventing a reason', async () => {
    installUnreadableBody(502);
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e', parserOk([]));
    expect(out).toEqual({kind: 'error', message: 'api.dfx.swiss answered HTTP 502 with an unreadable body.'});
  });

  test("the parser's own refusal reason is surfaced unchanged", async () => {
    installResponse(200, DETAILS_200);
    const out = await fetchPaymentDetails('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e', parserRefusing);
    expect(out).toEqual({kind: 'error', message: 'quote-expired'});
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
    expect(out).toEqual({kind: 'error', message: 'Invalid method or asset'});
  });

  test('a blockchain echo that disagrees with the requested method is refused, not reconciled', async () => {
    // The URI names no asset, so this echo is the only integrity signal the answer carries: paying
    // a Solana address against an InternetComputer choice would send real money to the wrong chain.
    installResponse(200, {...CB_SOL_200, blockchain: 'Solana'});
    const out = await fetchTransferUri(DETAILS, 'InternetComputer', 'VCHF');
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('answered for Solana when InternetComputer was requested');
  });

  test('a 200 with no uri is an error rather than an empty destination', async () => {
    installResponse(200, {expiryDate: CB_IC_200.expiryDate, blockchain: 'InternetComputer'});
    const out = await fetchTransferUri(DETAILS, 'InternetComputer', 'VCHF');
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('gave no payment address');
  });

  test('an unreadable expiry is an error rather than a NaN countdown', async () => {
    installResponse(200, {...CB_IC_200, expiryDate: 'soon'});
    const out = await fetchTransferUri(DETAILS, 'InternetComputer', 'VCHF');
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('unreadable expiry');
  });

  test('a missing expiry is an error', async () => {
    const {expiryDate: _drop, ...noExpiry} = CB_IC_200;
    installResponse(200, noExpiry);
    const out = await fetchTransferUri(DETAILS, 'InternetComputer', 'VCHF');
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('gave no expiry');
  });

  test('a provider-supplied http callback is refused before any request leaves the device', async () => {
    const mock = installResponse(200, CB_IC_200);
    const out = await fetchTransferUri(
      {...DETAILS, callbackUrl: 'http://api.dfx.swiss/v1/lnurlp/cb/pl_beeddb41cd4b6d9e'},
      'InternetComputer',
      'VCHF',
    );
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('must be https');
    expect(mock).not.toHaveBeenCalled();
  });

  test('a transport failure is an error naming the host', async () => {
    installTransportFailure();
    const out = await fetchTransferUri(DETAILS, 'InternetComputer', 'VCHF');
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('api.dfx.swiss');
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
    expect(out.kind === 'unknown' && out.message).toContain('8168');
    expect(out.kind === 'unknown' && out.message).toContain("Don't send it again");
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
      message: 'Transaction 999999999999 not confirmed in blockchain InternetComputer',
    });
  });

  test('the burned-quote 404 is a refusal too — a 4xx with a body is definitive', async () => {
    installResponse(404, QUOTE_BURNED_404);
    const out = await submitProof(DETAILS, 'InternetComputer', 'VCHF', '999999999999');
    expect(out).toEqual({kind: 'rejected', message: QUOTE_BURNED_404.message});
  });

  test('a 4xx whose body gives no reason still refuses, and names the status instead of inventing one', async () => {
    installResponse(403, {statusCode: 403});
    const out = await submitProof(DETAILS, 'InternetComputer', 'VCHF', '8168');
    expect(out).toEqual({kind: 'rejected', message: 'api.dfx.swiss refused the payment with HTTP 403 and gave no reason.'});
  });

  test('a 200 whose body cannot be read is unknown, NOT accepted', async () => {
    // The asymmetry is deliberate: a false pending costs a conversation with the merchant, a false
    // "paid" costs the goods.
    const mock = installUnreadableBody(200);
    const out = await submitProof(DETAILS, 'InternetComputer', 'VCHF', '8168');
    expect(out.kind).toBe('unknown');
    expect(out.kind === 'unknown' && out.message).toContain('8168');
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
    expect(out.kind === 'unknown' && out.message).toContain('HTTP 503');
  });

  test('a callback URL with no /cb/ segment is unknown with the transaction id to quote, and sends nothing', async () => {
    const mock = installResponse(200, {});
    const out = await submitProof(
      {...DETAILS, callbackUrl: 'https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e'},
      'InternetComputer',
      'VCHF',
      '8168',
    );
    expect(out.kind).toBe('unknown');
    expect(out.kind === 'unknown' && out.message).toContain('no /cb/ segment');
    expect(out.kind === 'unknown' && out.message).toContain('8168');
    expect(mock).not.toHaveBeenCalled();
  });

  test('a non-https callback is unknown with the transaction id to quote, and sends nothing', async () => {
    const mock = installResponse(200, {});
    const out = await submitProof(
      {...DETAILS, callbackUrl: 'http://api.dfx.swiss/v1/lnurlp/cb/pl_beeddb41cd4b6d9e'},
      'InternetComputer',
      'VCHF',
      '8168',
    );
    expect(out.kind).toBe('unknown');
    expect(out.kind === 'unknown' && out.message).toContain('must be https');
    expect(out.kind === 'unknown' && out.message).toContain('8168');
    expect(mock).not.toHaveBeenCalled();
  });
});
