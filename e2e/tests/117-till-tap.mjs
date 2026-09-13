// Flow 117 — a dpay payer TAPS a dpay till, and the shop's own charge is credited.
//
// Flow 114 already proves a shop can ring a sale up and be paid for it: a customer resolves the
// till code through the OpenCryptoPay routes and sends a VCHF transfer carrying the charge's `ref`.
// This is the OTHER way that money can arrive at the same charge, and until now it could not: the
// payer never touches a provider endpoint at all. They tap, and the IC protocol-v2 exchange the two
// phones already speak carries the payment.
//
// WHAT MAKES A TAP CREDIT A SALE, and the one link that was missing. The merchant's screen arms the
// reader with a 132-byte request built FROM THE CHARGE — this shop's own account, the price in raw
// VCHF, and the charge's REFERENCE as the request nonce. `prepareNfcTransfer` writes that nonce onto
// the payer's `icrc1_transfer` as its ICRC-1 memo, and the relay's till credits only a transfer
// whose memo is the charge's reference. The reference reaches the merchant on the ring-up they
// SIGNED (`POST /api/v1/till`); before that it existed only inside the payer-facing step-3 URI, so a
// tap built with any other nonce moved the customer's money and credited nothing.
//
// This flow reads the ARMED REQUEST rather than trusting the ring-up body for the nonce — the whole
// claim is that the screen armed the reader with the charge's own reference, so the payment is built
// from what the screen actually asked for.
//
// WHAT IS REAL: the ring-up is a genuine Ed25519 signature from the app's own core; the till routes
// are the relay's; the reader request is built by the real shared core (`DpayCore.buildRequestHex`);
// the payment is a real signed `icrc1_transfer` the fake-IC gateway verifies and settles; and the
// verdict comes from `GET /api/v1/till/{id}`, which re-derives settlement from the merchant's own
// ledger history. WHAT IS NOT: the radio. The DPN2 bundle is delivered through the harness's session
// seam (`__DPAY_TEST_NFC_SESSION`), exactly as flows 86/87 deliver theirs — antenna coupling and
// Android AID routing between two handsets are a physical-device gate and are not claimed here.
//
// Does NOT overlap flow 86 (an NFC bundle settling a dpay REQUEST — there is no charge, no till and
// no reference there) or flow 114 (the same charge paid through the provider routes, no tap).
//
// Selector contract: `btn-code-till`, `amount-input`, `btn-till-ring-up`, `till-qr`,
// `till-tap-hint`, `nfc-status`, `till-paid`, `till-paid-block`.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency, railPrincipalText, icpCatalog,
} from '../harness/lib.mjs';
import {
  generateKeypair, decodeRequest, b64urlEncode, icpPrincipalBytes, icpTransferArgBytes,
  icpSignUpdate, icpSignReadState,
} from '../harness/wire.mjs';

const VCHF = 7;                 // the ONE asset a dpay till takes
const FEE = 10_000;             // the VCHF catalog fee, charged to the SENDER
const PRICE = '4.50';           // what the cashier types, and what the customer's account must move by
const PRICE_RAW = 450_000_000;  // 450 rappen × 10^(8−2) — the price, in raw VCHF
// The SETTLEMENT amount: the price less the ledger fee the shop absorbs. A TAP must ask for this
// and not the price, or the two channels would charge the same customer two different totals for
// the same sale (`LEDGER_FEE_RAW`, crates/dpay-relay/src/till.rs).
const PAY_RAW = PRICE_RAW - FEE;
const PAYER_SEED = 2_000_000_000;

export const meta = {
  id: '117',
  name: 'till-tap',
  journey: 'nfc',
  covers: ['till', 'merchant-till', 'nfc', 'charge-reference', 'observed-settlement', 'vchf', 'settle'],
  verifies: 'A shop rings up CHF 4.50 on its own dpay wallet and the counter ALSO arms the NFC reader from that charge: the 132-byte request it serves names the shop’s own account, the exact raw VCHF, and the CHARGE’s reference as its nonce. A payer’s offline-signed bundle delivered over that reader settles a real icrc1_transfer whose ICRC-1 memo is therefore the charge’s reference, so `GET /api/v1/till/{id}` — which reads the merchant’s own ledger history and knows nothing about taps — flips to paid, names the block, and the shop is credited the exact VCHF. The paid light is the relay’s answer: the tap is given no onSettled, and the merchant’s tap screen is dismissed before the till’s own verdict is read off the counter.',
  timeoutMs: 60_000,
};

/** Keep a copy of every ring-up answer the app receives, without changing what it receives. */
async function observeTillOpens(driver) {
  await driver.eval(() => {
    window.__TILL_OPENS = [];
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await real(input, init);
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\/api\/v1\/till$/.test(url) && response.ok) {
        try {
          window.__TILL_OPENS.push(await response.clone().json());
        } catch (e) {
          window.__TILL_OPENS.push({observerError: String(e)});
        }
      }
      return response;
    };
  });
}

/** GET a till route and parse it, failing loudly with the status and body on anything but 200. */
async function getJson(url) {
  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`GET ${url} answered unparseable JSON (${e.message}): ${text.slice(0, 300)}`);
  }
}

/** Poll a value until it is non-null, or fail with what was seen. */
async function until(what, read, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await read();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${what} never happened within ${timeoutMs}ms (last: ${JSON.stringify(last)})`);
}

export async function run() {
  const start = Date.now();
  console.log('[117-till-tap] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver, relayBaseURL} = env;

    // The counter must believe it has a radio, or the reader never mounts (web defaults to
    // 'unknown', which is the honest web answer and the reason this seam exists).
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    console.log('[117-till-tap] onboarding the shop…');
    await onboardWallet(driver, 'Bahnhof Kiosk');
    const merchant = await accountOf(driver);
    const merchantPrincipal = await railPrincipalText(merchant.publicHex);

    // The customer: an independent key, funded on VCHF only. Nothing about them is in the app.
    const payer = await generateKeypair();
    const funded = await faucetAccount(relayBaseURL, payer.publicHex, PAYER_SEED, {currency: VCHF});
    assert(funded.ok, `the customer must be funded in VCHF, got HTTP ${funded.status}`);
    assertEq(String(await getBalance(relayBaseURL, merchant.publicHex, VCHF)), '0', 'the shop starts with no VCHF');

    // --- the counter -----------------------------------------------------------------------------
    console.log('[117-till-tap] ringing up CHF 4.50…');
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await driver.click('tab-receive', {timeoutMs: 4_000});
    await observeTillOpens(driver);
    await driver.click('btn-code-till', {timeoutMs: 4_000});
    await driver.type('amount-input', PRICE, {timeoutMs: 4_000});
    await driver.click('btn-till-ring-up', {timeoutMs: 4_000});
    await driver.findByTestID('till-qr', {timeoutMs: 15_000});

    // --- UNIT 1: the ring-up the merchant SIGNED tells them the charge's reference ----------------
    const opens = await driver.eval(() => window.__TILL_OPENS);
    assertEq(opens.length, 1, 'exactly one ring-up was sent');
    const open = opens[0];
    assertEq(open.merchant, merchantPrincipal, 'the charge is opened on the shop’s own account');
    assert(/^[0-9a-f]{32}$/.test(open.reference ?? ''),
      `the ring-up must name the charge's reference — that is the whole point of this flow. got ${JSON.stringify(open.reference)}`);
    // The unauthenticated poll must NOT restate it: the charge id is a bearer read token, and the
    // merchant already holds the reference from the request they signed (least authority).
    const idle = await getJson(`${relayBaseURL}/api/v1/till/${open.id}`);
    assertEq(idle.state, 'open', 'nothing is credited before the money moves');
    assert(idle.reference === undefined,
      `the unauthenticated status route must not disclose the reference, got ${JSON.stringify(idle.reference)}`);

    // --- UNIT 2: the counter armed the reader FROM that charge ------------------------------------
    // WAIT for the reader, do not SAMPLE it. This was a bare `eval` fired immediately after the
    // HTTP round trips above, so it raced React's mount of the reader NfcTap and went red under
    // host load on a tree where nothing was wrong. The thing being asserted is "the counter arms a
    // reader", which is a statement about what eventually holds — not about which side of a render
    // the assertion happens to land on.
    await driver.waitForFunction(
      () => window.__DPAY_TEST_NFC_COUNT() >= 1,
      { label: 'the counter mounts a reader NfcTap (>=1 DpayNfcEvent listener)', timeoutMs: 5_000 },
    );
    const listeners = await driver.eval(() => window.__DPAY_TEST_NFC_COUNT());
    assert(listeners >= 1, `the counter must mount a reader NfcTap, got ${listeners} DpayNfcEvent listeners`);
    const armedHex = await until('reader mode arming', () => driver.eval(() => window.__DPAY_TEST_NFC_READER_REQUEST ?? null));
    const req = decodeRequest(b64urlEncode(Uint8Array.from(Buffer.from(armedHex, 'hex'))));
    assertEq(req.toHex, merchant.publicHex, 'the tap request is payable to the SHOP’s own account');
    assertEq(String(req.amount), String(PAY_RAW), 'the tap asks for what the SCAN asks for: the price less the fee the shop absorbs');
    assertEq(req.currency, VCHF, 'a till charge settles in VCHF and nothing else');
    // THE MISSING LINK, asserted: the request's nonce IS the charge's reference, so the memo the
    // payer's transfer will carry is the value the relay credits this sale on.
    assertEq(req.nonceHex, open.reference, 'the tap request’s nonce must be the charge’s own reference');
    // 2026-09-12 link-QR decision: the QR any camera opens, the tap a dpay phone adds on top.
    assertIncludes(await driver.bodyText(), 'any phone camera opens it, and a dpay phone can tap it too', 'the cashier is told the code opens on any camera and taps on a dpay phone');
    await driver.screenshot('117-till-armed');

    // --- the customer taps: an offline-signed bundle over the merchant's reader -------------------
    console.log('[117-till-tap] payer signing offline against the armed request…');
    const catalog = await icpCatalog(relayBaseURL);
    const desc = catalog.find(c => c.currency === VCHF);
    assert(desc?.ledger, 'the relay’s catalog must name the VCHF ledger');
    assertEq(String(desc.fee), String(FEE), 'the VCHF fee this flow subtracts must be the catalog’s own');
    // Built from the DECODED request — the payer's phone has nothing else to go on, and neither
    // does this flow. `memoHex` is `prepareNfcTransfer`'s rule: the request nonce, verbatim.
    const arg = icpTransferArgBytes(icpPrincipalBytes(req.toHex), BigInt(req.amount), {
      fee: BigInt(desc.fee), memoHex: req.nonceHex,
    });
    const expiryNs = BigInt(Date.now() + 240_000) * 1_000_000n;
    const signed = await icpSignUpdate(payer.secretHex, desc.ledger, 'icrc1_transfer', arg, expiryNs);
    const readState = await icpSignReadState(payer.secretHex, [
      [Buffer.from('request_status'), Buffer.from(signed.requestIdHex, 'hex')],
    ], expiryNs + 60_000_000_000n);

    // Native ordering: the transport reaches Settling, then hands over the immutable bundle. The
    // merchant alone submits and polls it — the payer never needs a network.
    await driver.eval(() => window.__DPAY_TEST_NFC_SESSION({type: 'phase', role: 'reader', phase: 'settling'}));
    await driver.eval((bundle) => window.__DPAY_TEST_NFC_SESSION({
      type: 'done', role: 'reader',
      envelopeHex: bundle.envelopeHex,
      readStateEnvelopeHex: bundle.readStateEnvelopeHex,
      requestIdHex: bundle.requestIdHex,
    }), {envelopeHex: signed.envelopeHex, readStateEnvelopeHex: readState.envelopeHex, requestIdHex: signed.requestIdHex});

    // The tap OWNS the screen while it is in flight: one settlement surface at a time.
    await driver.findByTestID('nfc-status', {timeoutMs: 5_000});
    assert(!(await driver.isPresent('till-qr')), 'a tap in flight must own the screen, not sit beside the code');

    const queued = await until('the merchant queueing a signed result', () => driver.eval(() => window.__DPAY_TEST_NFC_RESULT ?? null));
    assertEq(queued.status, 0, `the merchant must reach a settled verdict from exact ledger history, got ${JSON.stringify(queued)}`);
    assertEq(queued.requestIdHex, signed.requestIdHex, 'the returned result binds the payer’s own update');
    assertEq(queued.nonceHex, open.reference, 'the result is bound to the charge’s reference, the nonce the request carried');
    await driver.eval(() => window.__DPAY_TEST_NFC_SESSION({type: 'confirmed', role: 'reader'}));
    assert(await driver.waitForText('Received', {timeoutMs: 20_000}), 'the tap resolves for the merchant once the payer accepts the result');
    await driver.screenshot('117-till-tapped');

    // --- UNIT 3: THE RELAY credits the sale, knowing nothing about the tap ------------------------
    // The till decides settlement by reading the merchant's own incoming VCHF history for a row
    // whose memo is this charge's reference. A tap is invisible to it; a matching transfer is not.
    console.log('[117-till-tap] waiting for the till to observe the transfer…');
    const paid = await until('the till observing the transfer', async () => {
      const s = await getJson(`${relayBaseURL}/api/v1/till/${open.id}`);
      return s.state === 'paid' ? s : null;
    });
    assertEq(paid.paid.amount_raw, String(PAY_RAW), 'the sale is credited the exact raw VCHF it was priced at');
    assert(Number.isInteger(paid.paid.block), `the settlement names the ledger row that paid it: ${JSON.stringify(paid.paid)}`);

    // …and the money really moved, exactly once.
    assertEq(String(await getBalance(relayBaseURL, merchant.publicHex, VCHF)), String(PAY_RAW), 'the shop was credited the exact VCHF');
    // THE FOUNDER'S RULE, over the radio: tapping a CHF 4.50 charge moved the customer's account
    // by exactly CHF 4.50, the same as scanning it would have.
    assertEq(String(await getBalance(relayBaseURL, payer.publicHex, VCHF)), String(PAYER_SEED - PRICE_RAW), 'the customer was debited the price and not one unit more');

    // --- the counter's own light is the RELAY's answer, not the tap's ------------------------------
    // Dismissing the tap screen reveals the till's verdict underneath it. Nothing about the tap set
    // it: `TillCharge` passes `NfcTap` no `onSettled`, so the only thing that can turn this green is
    // the poll of the route asserted above.
    await driver.eval(() => {
      const btn = document.querySelector('button[aria-label="Done"]');
      if (!btn) throw new Error('the finished tap must offer Done');
      btn.click();
    });
    await driver.findByTestID('till-paid', {timeoutMs: 15_000});
    const counter = await driver.bodyText();
    assertIncludes(counter, 'Paid 4.50 CHF', 'the counter reports the sale in the francs the cashier rang up');
    assertIncludes(counter, `Ledger block ${paid.paid.block}`, 'and names the ledger row the RELAY credited it from');
    await driver.screenshot('117-till-paid');

    console.log(`[117-till-tap] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('117-till-tap RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
