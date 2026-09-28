/**
 * 91-coach-tips — Trip Ready J4: first-use coaching is anchored, dismissible, and remembered.
 *
 *   receiveRequest  → mounts on the Receive request-QR phase; dismiss → new request: gone.
 *   offlineQr       → mounts on the OFFLINE hand-off QR (relay dead, value path alive).
 *   pendingOutcome  → mounts on the pending "Sent — awaiting the merchant's confirmation" view,
 *                     NEVER on the reconciled Paid screen (no false-success coaching).
 *
 * Then the flow-20 close-out: the counterparty submits the captured envelope, the payer comes
 * back online and reconciles to Paid — proving the coaching never blocked the money path.
 */
import {setup, assert, assertIncludes, getBalance, faucetAccount, icpCatalog, onboardWallet, accountOf, goOffline, setRelay, waitForScanner, railPrincipalText} from '../harness/lib.mjs';
import {generateKeypair, buildRequestQR, randNonceHex} from '../harness/wire.mjs';

export const meta = {
  id: 91,
  name: 'coach-tips',
  journey: 'onboard',
  covers: ['coach-receiveRequest', 'coach-offlineQr', 'coach-pendingOutcome',
    'btn-coach-*-dismiss', 'journey-seen-markers', 'one-time-coaching'],
  verifies: 'each coaching tip mounts on its surface exactly once per identity: presence, dismiss, re-entry → absent; the payment review carries none at all; pendingOutcome never appears on a confirmed Paid screen; the offline hand-off still settles (counterparty submit + reconcile)',
  timeoutMs: 90000,
};

const PAY_CENTS = 2500;

export async function run() {
  const start = Date.now();
  console.log(`[${meta.name}] first-use coaching: anchored, dismissible, remembered`);
  const env = await setup();
  try {
    // The tip cards rise+fade in over ~480ms (220ms delay + 260ms entrance). Screenshots fired
    // straight after findByTestID catch opacity≈0 — wait for the card's own entrance to stop
    // moving before shooting. `waitAtRest` states that in FRAMES (`Animated` is driven by
    // requestAnimationFrame), so it is the same point in the animation on a loaded host as on an
    // idle one; the 700ms sleep it replaces was a bet on the frame rate.
    const settle = (key) => env.driver.waitAtRest(`coach-${key}`, {timeoutMs: 8_000});
    await onboardWallet(env.driver, 'coach');
    const alice = await accountOf(env.driver);
    const bob = await generateKeypair();
    await faucetAccount(env.relayBaseURL, bob.publicHex, 10_000);

    // --- receiveRequest: mounts at the Receive ENTRY form (UX hardening 2026-08-23: was
    // post-Request-only, so first-time receivers never saw it), dismiss persists across
    // remounts AND the request-QR phase. -------------------------------------------------------
    await env.driver.click('tab-receive', {timeoutMs: 4_000});
    await env.driver.findByTestID('coach-receiveRequest', {timeoutMs: 6_000});
    await env.driver.type('amount-input', '42.50', {timeoutMs: 4_000});
    await env.driver.click('btn-request', {timeoutMs: 4_000});
    await env.driver.findByTestID('request-qr', {timeoutMs: 8_000});
    await settle('receiveRequest'); // entrance finish before the shot
    await env.driver.screenshot('91-coach-receive');
    await env.driver.click('btn-coach-receiveRequest-dismiss', {timeoutMs: 4_000});
    await env.driver.waitGone('coach-receiveRequest', {timeoutMs: 6_000});
    // Re-enter the same phase (unmount + fresh request) → the tip stays dismissed.
    // The Pay leg is WAITED FOR, not assumed: `setMode('receive')` is a no-op while the Receive
    // tab is already active, so firing the second tab press before the first one has taken effect
    // leaves ReceiveMode mounted on its request-QR phase — `amount-input` then never appears and
    // the flow dies on an opaque selector timeout four lines later (observed RED, 2026-09-01).
    // Waiting for the Pay surface to actually mount is what makes the round trip a round trip.
    await env.driver.click('tab-pay', {timeoutMs: 4_000});
    await env.driver.findByTestID('pay-scan', {timeoutMs: 8_000});
    await env.driver.click('tab-receive', {timeoutMs: 4_000});
    await env.driver.type('amount-input', '10.00', {timeoutMs: 4_000});
    await env.driver.click('btn-request', {timeoutMs: 4_000});
    await env.driver.findByTestID('request-qr', {timeoutMs: 8_000});
    assert(!(await env.driver.isPresent('coach-receiveRequest')), 'receiveRequest tip must not re-show after dismissal');
    console.log(`[${meta.name}] ✓ receiveRequest: shown once, dismissed, remembered`);
    await env.driver.click('tab-pay', {timeoutMs: 4_000});

    // --- THE PAYMENT REVIEW CARRIES NO TIP AT ALL. There WAS one here ("You approve the exact
    //     payment"), and it restated the 30pt headline it sat under while costing ~180px between
    //     the payment details and the Approve button — dropped 2026-09-09 on the founder's rule
    //     that an element earns its place by adding value the surface does not already carry.
    //     Asserted on the surface it used to occupy, so re-adding it fails here.
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    const payLink = (ref) => `/wallet/pay/${bobPrincipal}?asset=DEMO&network=internet-computer&amount=25&label=bob&ref=${ref}`
      + `&relay=${encodeURIComponent(env.relayBaseURL)}`;
    await env.driver.navigate(env.webBaseURL, payLink(randNonceHex()), {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await env.driver.waitReady({timeoutMs: 10_000});
    await env.driver.waitForText('Pay ∂25.00', {timeoutMs: 6_000});
    assert(await env.driver.isPresent('btn-approve'), 'the payment-link review carries its single Approve (zero-press entry)');
    assert(!(await env.driver.isPresent('coach-payReview')), 'the payment review must carry no coaching card');
    await env.driver.screenshot('91-coach-review');
    await env.driver.click('btn-review-cancel', {timeoutMs: 4_000});
    console.log(`[${meta.name}] ✓ payment review: no coaching card, Approve unobstructed`);

    // --- offlineQr + pendingOutcome: the flow-20 offline hand-off, coached exactly once. -------
    //     (The camera scan AUTO-SIGNS while offline — no review, no btn-approve.)
    await goOffline(env.driver, {keepGateway: true});
    await env.driver.waitForText('approx.', {timeoutMs: 8_000});
    const req3 = buildRequestQR(bob.publicHex, PAY_CENTS, randNonceHex(), Math.floor(Date.now() / 1000) + 600, 0, 'bob');
    await waitForScanner(env.driver);
    await env.driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), req3);
    await env.driver.waitForText('signed on this device ✓', {timeoutMs: 10_000});
    await env.driver.findByTestID('coach-offlineQr', {timeoutMs: 6_000});
    await settle('offlineQr'); // entrance finish before the shot
    await env.driver.screenshot('91-coach-offlineqr');
    const payload = await env.driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof payload === 'string' && payload.length >= 64, 'hand-off QR payload must be the base64url envelope');
    await env.driver.click('btn-coach-offlineQr-dismiss', {timeoutMs: 4_000});
    await env.driver.waitGone('coach-offlineQr', {timeoutMs: 6_000});
    console.log(`[${meta.name}] ✓ offlineQr: shown on the offline hand-off, dismissed`);

    // Hand to the merchant → the honest-pending view carries pendingOutcome.
    await env.driver.click('btn-paid', {timeoutMs: 4_000});
    await env.driver.waitForText('Sent ∂25.00', {timeoutMs: 8_000});
    await env.driver.findByTestID('coach-pendingOutcome', {timeoutMs: 6_000});
    await settle('pendingOutcome'); // entrance finish before the shot
    await env.driver.screenshot('91-coach-pending');
    await env.driver.click('btn-coach-pendingOutcome-dismiss', {timeoutMs: 4_000});
    await env.driver.waitGone('coach-pendingOutcome', {timeoutMs: 6_000});
    console.log(`[${meta.name}] ✓ pendingOutcome: shown on the unresolved view, dismissed`);

    // --- the money path never cared: counterparty submits, payer reconciles to Paid. -----------
    const envelopeBytes = b64urlToBytes(payload);
    const catalog = await icpCatalog(env.relayBaseURL);
    const ledger = catalog.find((c) => c.currency === 0).ledger;
    const submitted = await fetch(`${env.relayBaseURL}/api/v2/canister/${ledger}/call`, {
      method: 'POST',
      headers: {'Content-Type': 'application/cbor'},
      body: envelopeBytes,
    });
    assert(submitted.status === 202, `bob's phone submit must be 202, got ${submitted.status}`);
    assert((await getBalance(env.relayBaseURL, bob.publicHex, 0)) === '12500', 'bob credited 12500');
    await setRelay(env.driver, env.relayBaseURL);
    // (The old `waitForText('Paid')` + `waitForText('∂75.00')` reconcile beats never matched —
    // the settled screen renders neither string — and both results were ignored, so they only
    // burned 22s of budget per run. The reconcile itself is proven relay-side above (bob
    // credited); the header chip re-mounting is the wallet-rebuilt beat this block needs, and the
    // dismissed tip's absence is still asserted on the page as written.)
    await env.driver.findByTestID('balance', {timeoutMs: 12_000});
    assert(!(await env.driver.isPresent('coach-pendingOutcome')), 'confirmed Paid screen never carries the pending tip');
    console.log(`[${meta.name}] ✓ hand-off settled + reconciled — coaching never blocked the money path`);

    // --- all three seen-markers persisted on this identity. ------------------------------------
    const journey = await env.driver.eval(() => localStorage.getItem('dpay.journey.v1'));
    for (const key of ['receiveRequest', 'offlineQr', 'pendingOutcome']) {
      assertIncludes(journey, `"${key}"`, `seen-marker "${key}" persisted`);
    }
    assert(!journey.includes('"payReview"'), 'the retired payReview tip must leave no marker behind');
    assertIncludes(journey, '"recoverySaved"', 'recoverySaved stamp rode along untouched');
    console.log(`[${meta.name}] ✓ all three seen-markers persisted (stamps intact)`);

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[${meta.name}] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[${meta.name}] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
