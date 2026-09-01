// The OpenCryptoPay merchant till, as a fixture — shared by every OCP flow (111 pays it on the
// Internet Computer rail, 112 on the Solana rail). One till, one stub, one set of measured values:
// two rails paying the same code is the point, and a second copy of the fixture would be a second
// thing to drift.
//
// NO TEST MAY CONTACT THE LIVE PROVIDER. `installTillStub` replaces `window.fetch` — the app's
// single HTTP boundary (`fetchWithTimeout`, `app/services/relay.ts`) — and is FAIL-CLOSED: any
// request to an origin that is not the harness's own relay/web server is served from the fixture
// table or REFUSED and recorded, and each flow asserts nothing was ever refused. A typo in a URL
// therefore fails the test instead of reaching api.dfx.swiss.
//
// The stub is a small state machine rather than a static table because the provider is one: every
// read of the payment details MINTS A NEW QUOTE (measured), and the callback 404s a quote id it did
// not just issue. Reproducing that is what makes the unresolved-outcome leg honest — the app must be
// carrying the live quote through, not replaying a captured one.
//
// FIXTURE PROVENANCE. Every field name, envelope and value below is copied from the findings doc's
// measured recordings (`docs/specs/2026-09-01-opencryptopay-findings.md`): the step-2 field set and
// the string-vs-number amount asymmetry, the `available` flag, `amount=1.` (a trailing bare decimal
// point — the spelling naive parsers reject), the `icp:<ledger>/transfer?to=&amount=` and
// `solana:<address>?amount=` URI shapes, the `{expiryDate, blockchain, uri, hint}` step-3 answer,
// the NestJS `{statusCode, message, error}` error envelope, and the 300-second quote. THREE things
// are deliberately synthetic, because the doc records their SHAPE and not their value: the
// merchant's claimed name, the destination accounts (the doc redacts the principal), and the
// accepted-submission body — no payment has ever been made, so no success body exists to copy. Each
// is marked at its definition.
import { encodeLnurl } from './lnurl.mjs';

/** The live provider. Treated as configuration, not a constant, exactly as the findings doc says. */
export const PROVIDER_HOST = 'api.dfx.swiss';
export const PROVIDER_ORIGIN = `https://${PROVIDER_HOST}`;

// The public test till from the findings doc. Its payment id is the last segment of BOTH the API URL
// the LNURL carries and the callback the provider hands back — which is why `submitProof` can derive
// `/v1/lnurlp/tx/<id>` from the callback by swapping the `/cb/` segment.
export const PAYMENT_ID = 'pl_beeddb41cd4b6d9e';
export const API_URL = `${PROVIDER_ORIGIN}/v1/lnurlp/${PAYMENT_ID}`;
export const CALLBACK_URL = `${PROVIDER_ORIGIN}/v1/lnurlp/cb/${PAYMENT_ID}`;

/** The QR the till actually prints: an app.dfx.swiss URL carrying the LNURL in a `lightning`
 *  parameter, uppercase as QR encoders emit it. Exercises `parseOcpScan`'s URL branch, not just the
 *  bare-LNURL one. The encoder is verified against the published LUD-01 vector (harness/lnurl.mjs). */
export const TILL_QR = `https://app.dfx.swiss/pl/?lightning=${encodeLnurl(API_URL).toUpperCase()}`;

/** SYNTHETIC: the doc records that `displayName` is present and UNVERIFIED, not what this till calls
 *  itself. The name is what a review must mark as claimed. */
export const CLAIMED_MERCHANT = 'Kiosk am Bahnhof';

/** The measured quote lifetime, exactly: 300 seconds. */
export const QUOTE_LIFETIME_MS = 300_000;

/** The till's menu. Assets + amounts are the live 2026-09-01 recordings; see the doc's tables. */
export const TRANSFER_AMOUNTS = [
  {
    method: 'InternetComputer',
    available: true,
    assets: [
      {asset: 'ckBTC', amount: '0.000016'},
      {asset: 'VCHF', amount: '1.'},          // the trailing bare decimal point, verbatim
      {asset: 'ICP', amount: '0.50795551'},
      {asset: 'VEUR', amount: '1.06'},        // amount synthetic; VEUR's presence on the menu is measured
    ],
  },
  {
    method: 'Solana',
    available: true,
    assets: [
      {asset: 'SOL', amount: '0.01219252'},
      {asset: 'USDC', amount: '1.246922'},
      {asset: 'USDT', amount: '1.246922'},    // amount synthetic; USDT's presence is measured
    ],
  },
  // The provider marks methods it cannot settle `available: false` on every response. Its presence
  // and the flag are measured; the asset row under it is synthetic (the doc records neither).
  {method: 'Arkade', available: false, assets: [{asset: 'BTC', amount: '0.000016'}]},
];

/**
 * Install the provider stub over `window.fetch`. See the module header for the fail-closed contract.
 *
 * `cfg` carries what differs per flow: `passOrigins` (the harness's own relay + web servers),
 * `uris` (the step-3 destination per `<method>/<asset>`, so a flow only fixtures the rail it pays),
 * and `detailsDelayMs` (how slow the step-2 read is, when a flow wants to observe the waiting copy).
 */
export async function installTillStub(driver, cfg) {
  await driver.eval((c) => {
    const real = window.fetch.bind(window);
    const state = {
      calls: [],        // every provider URL the app requested, in order
      txUrls: [],       // just the /tx submissions — the ONE-SHOT budget
      unexpected: [],   // anything the stub refused: must stay empty
      quoteId: null,    // the quote most recently minted (the provider invalidates the rest)
      quoteSeq: 0,
      txMode: 'accept', // 'accept' | 'indefinite' — flipped between legs by the flow
    };
    window.__OCP = state;

    const json = (body, status) =>
      new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
    // The provider's error envelope is NestJS's, NOT the LNURL `{status,reason}` shape (measured).
    const err = (status, message) =>
      json({statusCode: status, message, error: status === 404 ? 'Not Found' : 'Bad Request'}, status);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const isoIn = (ms) => new Date(Date.now() + ms).toISOString();

    // Step 2 — the payment details. The full top-level field set the doc lists, in its order, with
    // the string-vs-number amount asymmetry preserved: per-asset amounts are STRINGS while
    // `requestedAmount.amount` is a JSON NUMBER.
    const detailsBody = () => {
      state.quoteSeq += 1;
      state.quoteId = `q_e2e_${state.quoteSeq}`;
      return {
        callback: c.callbackUrl,
        displayName: c.merchantName,
        displayQr: true,
        externalId: null,
        id: c.paymentId,
        maxSendable: 100000,
        metadata: '[["text/plain","OpenCryptoPay"]]',
        minSendable: 100000,
        mode: 'Single',
        possibleStandards: ['OpenCryptoPay', 'FrankencoinPay', 'LightningBolt11'],
        quote: {id: state.quoteId, expiration: isoIn(c.quoteLifetimeMs)},
        recipient: {name: c.merchantName},
        requestedAmount: {asset: 'CHF', amount: 1},
        route: c.paymentId,
        standard: 'OpenCryptoPay',
        tag: 'payRequest',
        transferAmounts: c.transferAmounts,
      };
    };

    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      // Relative / blob / data URLs and the harness's own servers are the app's real traffic.
      if (!/^https?:/i.test(url) || c.passOrigins.some((o) => url.startsWith(`${o}/`) || url === o)) {
        return real(input, init);
      }
      state.calls.push(url);
      if (!url.startsWith(`${c.providerOrigin}/`)) {
        state.unexpected.push(url);
        throw new TypeError(`e2e: refused an off-fixture request to ${url}`);
      }
      const u = new URL(url);

      // Step 4 — the ONE-SHOT proof submission. Counted, never retried by anyone.
      if (u.pathname === `/v1/lnurlp/tx/${c.paymentId}`) {
        state.txUrls.push(url);
        if (state.txMode === 'accept') {
          // SYNTHETIC: no payment has ever been made against the live provider, so no accepted-
          // submission body exists to copy. The client requires only a readable JSON body at 2xx.
          return json({}, 200);
        }
        // The loss path: the submission never comes back. `fetchWithTimeout` aborts it and the
        // browser rejects with an AbortError — reproduced here without burning the real 30s bound.
        throw new DOMException('The user aborted a request.', 'AbortError');
      }

      // Step 3 — the destination for one {method, asset} of the LIVE quote.
      if (u.pathname === `/v1/lnurlp/cb/${c.paymentId}`) {
        const quote = u.searchParams.get('quote');
        if (state.quoteId === null || quote !== state.quoteId) {
          return err(404, `No actual quote with ID ${quote} found`);
        }
        const method = u.searchParams.get('method');
        const asset = u.searchParams.get('asset');
        const uri = c.uris[`${method}/${asset}`];
        if (!uri) return err(400, 'Invalid method or asset');
        return json({
          expiryDate: isoIn(c.quoteLifetimeMs),
          blockchain: method, // the echo — the only integrity signal the answer carries
          uri,
          hint: `Send the exact amount, then report the transaction to /v1/lnurlp/tx/${c.paymentId}`,
        }, 200);
      }

      // Step 2 — the payment link itself. Optionally slow: the two provider reads take real time on
      // a screen the payer just pointed at a QR, and a flow may assert the wallet says so.
      if (u.pathname === `/v1/lnurlp/${c.paymentId}`) {
        if (c.detailsDelayMs > 0) await sleep(c.detailsDelayMs);
        return json(detailsBody(), 200);
      }

      state.unexpected.push(url);
      return err(404, 'Payment link not found');
    };
  }, {
    providerOrigin: PROVIDER_ORIGIN,
    paymentId: PAYMENT_ID,
    callbackUrl: CALLBACK_URL,
    merchantName: CLAIMED_MERCHANT,
    transferAmounts: TRANSFER_AMOUNTS,
    quoteLifetimeMs: QUOTE_LIFETIME_MS,
    detailsDelayMs: 0,
    ...cfg,
  });
}

/** Read the stub's recorded state back into Node. */
export const ocpStubState = (driver) => driver.eval(() => ({
  calls: window.__OCP.calls.slice(),
  txUrls: window.__OCP.txUrls.slice(),
  unexpected: window.__OCP.unexpected.slice(),
}));

/** Flip the submission behaviour between legs ('accept' | 'indefinite'). */
export const setOcpTxMode = (driver, mode) => driver.eval((m) => { window.__OCP.txMode = m; }, mode);
