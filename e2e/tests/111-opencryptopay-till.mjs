// Flow 111 — paying a real merchant's OpenCryptoPay till, with the LOSS PATH pinned.
//
// OpenCryptoPay is the first payment code in this wallet that dpay did not design: a shop's till
// shows a static LNURL, an outside provider prices it, and the payer moves irreversible funds
// BEFORE the provider is told about them — and is granted exactly ONE chance to tell it
// (`docs/specs/2026-09-01-opencryptopay-findings.md`, "The loss path"). Everything this flow asserts
// follows from that asymmetry.
//
// Four legs, in the order a payer meets them:
//
//   1. REFUSED, with the next action. The till does not take the selected asset (ckUSDC — measured
//      absent from the live provider's menu). The wallet names what it chose, what the till DOES
//      take in the wallet's own words, and where to change it. It also asks the provider exactly
//      ONCE and never requests a destination it could not pay: a refusal must not cost a quote.
//   2. IT NEVER AUTO-SIGNS. A scanned till lands on an explicit review carrying the amount, the FULL
//      destination account, the provider HOST the price came from, the countdown, and the merchant
//      name marked as CLAIMED. Proven by money, not by pixels: the payer's ledger balance is
//      unchanged while that review is on screen.
//   3. PAID. Approve → the funds move on the IC rail → the proof is reported once → the paid state.
//   4. UNRESOLVED — the important one. The transfer settles on-chain and the ONE submission does not
//      come back definitive. That is neither paid nor failed: the outcome screen must show the block
//      index that proves the transfer, must tell the payer not to pay again, and must offer no
//      retry — because the provider burns both the quote and the transaction id on a failed
//      submission, so a second attempt cannot succeed and only destroys the user's ability to claim
//      the payment. The flow asserts the money really left AND that exactly one /tx call was made.
//
// NO TEST MAY CONTACT THE LIVE PROVIDER. The stub below replaces `window.fetch` — the app's single
// HTTP boundary (`fetchWithTimeout`, `app/services/relay.ts`) — and is FAIL-CLOSED: any request to
// an origin that is not this harness's own relay/web server is served from the fixture table or
// REFUSED and recorded, and the flow asserts nothing was ever refused. A typo in a URL therefore
// fails the test instead of reaching api.dfx.swiss.
//
// Fixture provenance. Every field name, envelope and value below is copied from the findings doc's
// measured recordings: the step-2 field set and the string-vs-number amount asymmetry, the
// `available` flag, `amount=1.` (a trailing bare decimal point — the spelling naive parsers reject),
// the `icp:<ledger>/transfer?to=&amount=` URI shape, the `{expiryDate, blockchain, uri, hint}`
// step-3 answer, the NestJS `{statusCode, message, error}` error envelope, and the 300-second quote.
// THREE things are deliberately synthetic, because the doc records their SHAPE and not their value:
// the merchant's claimed name, the destination principal (the doc redacts it), and the accepted-
// submission body — no payment has ever been made, so no success body exists to copy. Each is
// marked at its definition.
//
// Selector contract: `ocp-checking`, `ocp-host`, `ocp-expiry`, `ocp-outcome`, `review-claimed`,
// `pay-amount`, `review-payee`, `btn-approve`, `btn-new`, `btn-start-scan` (via armPayScan).
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency, armPayScan, railPrincipalText,
} from '../harness/lib.mjs';
import { generateKeypair } from '../harness/wire.mjs';
import { encodeLnurl } from '../harness/lnurl.mjs';

// --- the provider, exactly as measured ------------------------------------------------------------
const PROVIDER_HOST = 'api.dfx.swiss';
const PROVIDER_ORIGIN = `https://${PROVIDER_HOST}`;
// The public test till from the findings doc. Its payment id is the last segment of BOTH the API URL
// the LNURL carries and the callback the provider hands back — which is why `submitProof` can derive
// `/v1/lnurlp/tx/<id>` from the callback by swapping the `/cb/` segment.
const PAYMENT_ID = 'pl_beeddb41cd4b6d9e';
const API_URL = `${PROVIDER_ORIGIN}/v1/lnurlp/${PAYMENT_ID}`;
const CALLBACK_URL = `${PROVIDER_ORIGIN}/v1/lnurlp/cb/${PAYMENT_ID}`;
// The QR the till actually prints: an app.dfx.swiss URL carrying the LNURL in a `lightning`
// parameter, uppercase as QR encoders emit it. Exercises `parseOcpScan`'s URL branch, not just the
// bare-LNURL one. The encoder is verified against the published LUD-01 vector (harness/lnurl.mjs).
const TILL_QR = `https://app.dfx.swiss/pl/?lightning=${encodeLnurl(API_URL).toUpperCase()}`;

// --- the wallet side ------------------------------------------------------------------------------
const VCHF = 7;               // the asset that pays: a direct-ICRC row, settled by icrc1_transfer
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai'; // == the OCP menu's VCHF ledger (findings, identity check)
const VCHF_SEED = 500_000_000; // 5.00000000 VCHF — covers two 1.— payments and their fees
const VCHF_FEE = 10_000;       // the VCHF catalog fee, charged to the sender
const PAY_RAW = 100_000_000;   // the till's `1.` VCHF at 8 decimals — the exact amount that must move
const CKUSDC = 2;             // the asset the till does NOT take (leg 1); funded so no fund-gate fires
const CKUSDC_SEED = 5_000_000;

/** The till's menu. Assets + amounts are the live 2026-09-01 recordings; see the doc's tables. */
const TRANSFER_AMOUNTS = [
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

// Synthetic (see the header): the doc records that `displayName` is present and UNVERIFIED, not what
// this till calls itself. The name is what the review must mark as claimed.
const CLAIMED_MERCHANT = 'Kiosk am Bahnhof';

export const meta = {
  id: '111',
  name: 'opencryptopay-till',
  journey: 'pay',
  covers: ['opencryptopay', 'scan-fallback', 'explicit-approve', 'claimed-name', 'loss-path', 'unresolved-outcome', 'one-shot-submit', 'honest-instructions', 'fail-closed'],
  verifies: 'Scanning a merchant OpenCryptoPay till resolves a live quote and lands on an explicit review (provider host, full destination, countdown, claimed merchant name) that never auto-signs; Approve moves the funds and reports the proof once → Paid; a settled transfer whose single proof submission is indefinite renders as UNRESOLVED with the ledger block index, no retry and no "paid"; a till that does not take the selected asset is refused by name with the switch-in-Balances instruction and costs no quote.',
  timeoutMs: 45000, // 4 legs: 3 provider round trips (one deliberately slow) + 2 real IC settlements
};

/**
 * Install the provider stub over `window.fetch` — the app's one HTTP boundary.
 *
 * FAIL-CLOSED by construction: only the harness's own relay/web origins pass through. Everything
 * else must match a fixture route or it is recorded in `unexpected` and rejected, so the flow can
 * assert (at the end) that no request ever escaped toward the real provider.
 *
 * The stub is a small state machine rather than a static table because the provider is one: every
 * read of the payment details MINTS A NEW QUOTE (measured), and the callback 404s a quote id it did
 * not just issue. Reproducing that is what makes leg 4 honest — the app must be carrying the live
 * quote through, not replaying a captured one.
 */
async function installTillStub(driver, cfg) {
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

      // Step 2 — the payment link itself. Deliberately slow: the two provider reads take real time
      // on a screen the payer just pointed at a QR, and the flow asserts the wallet says so.
      if (u.pathname === `/v1/lnurlp/${c.paymentId}`) {
        await sleep(c.detailsDelayMs);
        return json(detailsBody(), 200);
      }

      state.unexpected.push(url);
      return err(404, 'Payment link not found');
    };
  }, cfg);
}

/** Read the stub's recorded state back into Node. */
const stubState = (driver) => driver.eval(() => ({
  calls: window.__OCP.calls.slice(),
  txUrls: window.__OCP.txUrls.slice(),
  unexpected: window.__OCP.unexpected.slice(),
}));

/** Flip the submission behaviour between legs. */
const setTxMode = (driver, mode) => driver.eval((m) => { window.__OCP.txMode = m; }, mode);

/** Point the camera at the till code (arming the pay-intent gate first — the shared choke point). */
async function scanTill(driver) {
  await armPayScan(driver);
  await driver.eval((qr) => { window.__DPAY_TEST_SCAN(qr); }, TILL_QR);
}

export async function run() {
  const start = Date.now();
  console.log('[111-opencryptopay-till] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver, relayBaseURL, webBaseURL} = env;

    console.log('[111-opencryptopay-till] onboarding…');
    await onboardWallet(driver, 'e2e-ocp');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64,
      `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);

    // The till's destination. SYNTHETIC (see the header): the findings doc redacts the middle of the
    // principal it recorded, so the fixture uses a real, CRC-valid principal of the same form — the
    // app runs it through the core validator (`icpValidatePrincipal`) before the payer sees it.
    const merchant = await generateKeypair();
    const merchantPrincipal = await railPrincipalText(merchant.publicHex);
    console.log(`[111-opencryptopay-till] till destination: ${merchantPrincipal}`);

    for (const [currency, amount] of [[VCHF, VCHF_SEED], [CKUSDC, CKUSDC_SEED]]) {
      const fund = await faucetAccount(relayBaseURL, accountHex, amount, {currency});
      assert(fund.ok, `faucet funding of currency ${currency} must succeed, got HTTP ${fund.status}: ${JSON.stringify(fund.body)}`);
    }

    await installTillStub(driver, {
      providerOrigin: PROVIDER_ORIGIN,
      passOrigins: [new URL(relayBaseURL).origin, new URL(webBaseURL).origin],
      paymentId: PAYMENT_ID,
      callbackUrl: CALLBACK_URL,
      merchantName: CLAIMED_MERCHANT,
      transferAmounts: TRANSFER_AMOUNTS,
      // The measured quote lifetime, exactly: 300 seconds.
      quoteLifetimeMs: 300_000,
      detailsDelayMs: 1_000,
      uris: {
        // `icp:<LEDGER>/transfer?to=<PRINCIPAL>&amount=<DECIMAL>` — the live shape, NOT the README's.
        // The amount is the same `1.` the menu quoted: the provider does not re-price inside a quote,
        // so the wallet treats any disagreement as a hard refusal.
        'InternetComputer/VCHF': `icp:${VCHF_LEDGER}/transfer?to=${merchantPrincipal}&amount=1.`,
      },
    });

    // --- 1. the till does not take the selected asset ------------------------------------------
    // ckUSDC is dpay's stated launch rail and the live provider does NOT accept it — the refusal a
    // real payer will actually hit. It must name what was chosen, what the till takes in the
    // WALLET's words, and the one action available (founder rule 2026-08-29).
    console.log('[111-opencryptopay-till] leg 1 — scanning the till with ckUSDC selected…');
    await openBalances(driver);
    await selectCurrency(driver, 'ckusdc');
    // The header carries the ACTIVE asset's balance, so this is the gate that the app has seen the
    // seed — without it a zero balance would park the Pay tab on the fund panel and there would be
    // no scanner to point at the till (a green flow that proved nothing about the refusal).
    assert(await driver.waitForText('5.00 USDC', {timeoutMs: 10_000}), 'the app must see the ckUSDC seed before the Pay tab can scan');
    await driver.click('tab-pay');
    assert(!(await driver.isPresent('pay-fund')), 'a funded asset must reach the scan surface, not the fund-first panel');
    await scanTill(driver);

    assert(await driver.waitForText('This till doesn’t take USDC.', {timeoutMs: 12_000}),
      'the refusal must name the asset the payer chose');
    let body = await driver.bodyText();
    // Every offer this wallet could actually pay, named as the WALLET names it (not the provider's
    // spelling) so "switch in Balances" points at rows the payer can see. SOL is in the list because
    // the till's Solana offer is payable on the device-key rail; Solana USDC is NOT, and is absent
    // for the measured reason (its URI names no token account) rather than silently dropped.
    assertIncludes(body, 'It takes BTC, VCHF, ICP, SOL.', 'the refusal must name what the till takes, in the wallet\'s own asset names');
    assertIncludes(body, 'dpay never swaps', 'the refusal must state why no substitute is offered');
    assertIncludes(body, 'switch to one of those in Balances and scan again', 'the refusal must name the next action');
    assert(!(await driver.isPresent('pay-amount')), 'a refused till must never render a payment review');
    assert(!(await driver.isPresent('btn-approve')), 'a refused till must never render an Approve button');

    // A refusal must be CHEAP: one read, and no request for a destination the wallet could not pay.
    let seen = await stubState(driver);
    assertEq(String(seen.calls.length), '1', 'an unpayable till costs exactly one provider read');
    assertIncludes(seen.calls[0], 'timeout=0', 'the details read asks for the current charge, never a long poll');
    assertEq(String(seen.txUrls.length), '0', 'a refusal before any funds move must never touch the submission endpoint');
    console.log('[111-opencryptopay-till] ✓ refused by name, one read, no quote spent');
    await driver.screenshot('111-ocp-refused');

    // --- 2. the review: never auto-signs, and says who priced it -------------------------------
    console.log('[111-opencryptopay-till] leg 2 — scanning the till with VCHF selected…');
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    assert(await driver.waitForText('5.00 VCHF', {timeoutMs: 10_000}), 'the app must see the VCHF seed before the Pay tab can scan');
    await driver.click('tab-pay');
    assert(!(await driver.isPresent('pay-fund')), 'a funded asset must reach the scan surface, not the fund-first panel');
    await scanTill(driver);

    // Two provider reads take real time. The wallet says what it is doing rather than freezing.
    assert(await driver.findByTestID('ocp-checking', {timeoutMs: 8_000}) != null,
      'the wallet must say it is checking with the provider while the reads are in flight');
    assertIncludes(await driver.readText('ocp-checking'), 'payment provider',
      'the waiting message names who is being asked');

    await driver.findByTestID('pay-amount', {timeoutMs: 15_000});
    assertEq(await driver.readText('pay-amount'), 'Pay 1.00000000 VCHF',
      'the review shows the till\'s exact quoted amount, converted at VCHF\'s own precision');
    assertEq(await driver.readText('review-payee'), merchantPrincipal,
      'the review shows the FULL destination account — the one thing on screen the payer can check');
    assertEq(await driver.readText('ocp-host'), `Price from ${PROVIDER_HOST}`,
      'the review names the host the price came from (an LNURL can name any host on earth)');
    assertIncludes(await driver.readText('review-claimed'), 'Name given by the code',
      'the merchant name is marked as claimed, never as verified');
    const expiry = await driver.readText('ocp-expiry');
    assert(/^Valid for ~\d+ min$/.test(expiry), `the review counts the 300s quote down, got ${JSON.stringify(expiry)}`);
    assertIncludes(await driver.bodyText(), CLAIMED_MERCHANT, 'the review shows the name the till claims');

    // NEVER AUTO-SIGNS — proven with money, not pixels: the Approve press is still pending and the
    // payer's ledger balance has not moved. (A scanned dpay REQUEST does auto-sign, by design; this
    // code came from a stranger, so it may not.)
    assert(await driver.isPresent('btn-approve'), 'a scanned till must still require an explicit Approve press');
    assertEq(await getBalance(relayBaseURL, accountHex, VCHF), String(VCHF_SEED),
      'nothing may leave the wallet before the payer approves');
    await driver.screenshot('111-ocp-review');
    console.log('[111-opencryptopay-till] ✓ explicit review, host + claimed name + countdown, no auto-sign');

    // --- 3. paid ------------------------------------------------------------------------------
    console.log('[111-opencryptopay-till] leg 3 — approving…');
    await driver.click('btn-approve', {timeoutMs: 5_000});
    assert(await driver.waitForText('Paid ✓ 1.00000000 VCHF', {timeoutMs: 20_000}),
      'an accepted submission renders the paid state with the exact amount');
    assert(!(await driver.isPresent('ocp-outcome')),
      'a clean payment carries no unresolved note — that surface is for the loss path alone');
    assertEq(await getBalance(relayBaseURL, accountHex, VCHF), String(VCHF_SEED - PAY_RAW - VCHF_FEE),
      'the payer is debited the till\'s exact amount plus the ledger fee');

    seen = await stubState(driver);
    assertEq(String(seen.txUrls.length), '1', 'the proof is reported EXACTLY once — the provider grants one attempt');
    const submitted = new URL(seen.txUrls[0]);
    assertEq(submitted.pathname, `/v1/lnurlp/tx/${PAYMENT_ID}`,
      'the submission goes to the /tx path derived from the callback\'s /cb/ segment');
    assertEq(submitted.searchParams.get('method'), 'InternetComputer', 'the submission echoes the provider\'s method spelling');
    assertEq(submitted.searchParams.get('asset'), 'VCHF', 'the submission echoes the provider\'s asset spelling');
    assert(/^\d+$/.test(submitted.searchParams.get('tx') ?? ''),
      `the submission reports a real ledger block index, got ${submitted.searchParams.get('tx')}`);
    console.log(`[111-opencryptopay-till] ✓ paid; proof reported once as block ${submitted.searchParams.get('tx')}`);
    await driver.screenshot('111-ocp-paid');

    // --- 4. UNRESOLVED: the money moved, the sale is not credited ------------------------------
    // The single submission comes back indefinite. This is neither paid nor failed, and the payer's
    // only remaining asset is the block index — so it must be on screen, with an instruction NOT to
    // pay again (the quote and the transaction id are both spent; a retry cannot succeed).
    console.log('[111-opencryptopay-till] leg 4 — the submission never answers…');
    await setTxMode(driver, 'indefinite');
    await driver.click('btn-new', {timeoutMs: 5_000});
    await scanTill(driver);
    await driver.findByTestID('pay-amount', {timeoutMs: 15_000});
    await driver.click('btn-approve', {timeoutMs: 5_000});

    const note = await driver.findByTestID('ocp-outcome', {timeoutMs: 25_000});
    assert(note != null, 'an indefinite submission must render the unresolved outcome, not an error toast');
    const outcome = await driver.readText('ocp-outcome');
    assertIncludes(outcome, 'neither paid nor failed', 'the outcome is stated as neither paid nor failed');
    assertIncludes(outcome, 'don’t pay again', 'the payer is told NOT to pay again');
    const ref = /ledger block (\d+)/.exec(outcome);
    assert(ref != null, `the outcome must show the on-chain reference that proves the transfer, got ${JSON.stringify(outcome)}`);

    body = await driver.bodyText();
    assert(!body.includes('Paid ✓'), 'an unresolved payment must NEVER render as paid');
    assertIncludes(body, 'Sent 1.00000000 VCHF', 'the unresolved outcome is the honest pending headline');
    assertIncludes(body, 'awaiting the merchant’s confirmation', 'the unresolved outcome says what it is waiting on');
    // Not invited to pay again: no Approve, no review, and no receipt to hand back (there is no
    // accepted payment to share). `btn-new` starts a DIFFERENT payment; it does not retry this one.
    assert(!(await driver.isPresent('btn-approve')), 'the unresolved outcome must not offer an Approve to press again');
    assert(!(await driver.isPresent('pay-amount')), 'the unresolved outcome must not fall back to a re-payable review');
    assert(!(await driver.isPresent('btn-share-receipt')), 'there is no settlement receipt to share for an uncredited payment');

    // The money REALLY left — that is what makes "don't pay again" the honest instruction — and the
    // one submission was spent, not retried by any caller.
    assertEq(await getBalance(relayBaseURL, accountHex, VCHF), String(VCHF_SEED - 2 * (PAY_RAW + VCHF_FEE)),
      'the unresolved transfer really settled on-chain: the funds left the wallet');
    seen = await stubState(driver);
    assertEq(String(seen.txUrls.length), '2', 'the indefinite submission is attempted ONCE and never retried');
    assertEq(new URL(seen.txUrls[1]).searchParams.get('tx'), ref[1],
      'the block index shown to the payer is the one that was reported');
    console.log(`[111-opencryptopay-till] ✓ unresolved, block ${ref[1]} shown, no retry offered`);
    await driver.screenshot('111-ocp-unresolved');

    // Nothing ever escaped toward the real provider.
    assertEq(JSON.stringify(seen.unexpected), '[]', 'no request may reach an origin outside the fixture table');

    console.log(`[111-opencryptopay-till] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(`\n[111-opencryptopay-till] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
