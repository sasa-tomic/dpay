/**
 * 91-coach-tips — Trip Ready J4: first-use coaching is anchored, dismissible, and remembered.
 *
 *   payReview       → mounts on the IC pay review; dismiss → re-enter review (same identity):
 *                     gone (journey seen-marker).
 *   receiveRequest  → mounts on the Receive request-QR phase; dismiss → new request: gone.
 *   offlineQr       → mounts on the OFFLINE hand-off QR (relay dead, value path alive).
 *   pendingOutcome  → mounts on the pending "Sent — awaiting the merchant's confirmation" view,
 *                     NEVER on the reconciled Paid screen (no false-success coaching).
 *
 * Then the flow-20 close-out: the counterparty submits the captured envelope, the payer comes
 * back online and reconciles to Paid — proving the coaching never blocked the money path.
 */
import {setup, assert, assertIncludes, getBalance, faucetAccount, onboardWallet, accountOf, goOffline, setRelay, waitForScanner} from '../harness/lib.mjs';
import {generateKeypair, buildRequestQR, randNonceHex} from '../harness/wire.mjs';

export const meta = {
  id: 91,
  name: 'coach-tips',
  journey: 'onboard',
  covers: ['coach-payReview', 'coach-receiveRequest', 'coach-offlineQr', 'coach-pendingOutcome',
    'btn-coach-*-dismiss', 'journey-seen-markers', 'one-time-coaching'],
  verifies: 'each coaching tip mounts on its surface exactly once per identity: presence, dismiss, re-entry → absent; pendingOutcome never appears on a confirmed Paid screen; the offline hand-off still settles (counterparty submit + reconcile)',
  timeoutMs: 60_000,
};

const PAY_CENTS = 2500;

export async function run() {
  const start = Date.now();
  console.log(`[${meta.name}] first-use coaching: anchored, dismissible, remembered`);
  const env = await setup();
  try {
    // The tip cards rise+fade in over ~480ms (220ms delay + 260ms entrance). Screenshots fired
    // straight after findByTestID catch opacity≈0 — settle before shooting.
    const settle = () => new Promise((r) => setTimeout(r, 700));
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
    await settle(); // entrance finish before the shot
    await env.driver.screenshot('91-coach-receive');
    await env.driver.click('btn-coach-receiveRequest-dismiss', {timeoutMs: 4_000});
    await env.driver.waitGone('coach-receiveRequest', {timeoutMs: 6_000});
    // Re-enter the same phase (unmount + fresh request) → the tip stays dismissed.
    await env.driver.click('tab-pay', {timeoutMs: 4_000});
    await env.driver.click('tab-receive', {timeoutMs: 4_000});
    await env.driver.type('amount-input', '10.00', {timeoutMs: 4_000});
    await env.driver.click('btn-request', {timeoutMs: 4_000});
    await env.driver.findByTestID('request-qr', {timeoutMs: 8_000});
    assert(!(await env.driver.isPresent('coach-receiveRequest')), 'receiveRequest tip must not re-show after dismissal');
    console.log(`[${meta.name}] ✓ receiveRequest: shown once, dismissed, remembered`);
    await env.driver.click('tab-pay', {timeoutMs: 4_000});

    // --- payReview: mounts on the review, dismiss, re-enter review → gone. ---------------------
    await waitForScanner(env.driver);
    const req1 = buildRequestQR(bob.publicHex, PAY_CENTS, randNonceHex(), Math.floor(Date.now() / 1000) + 600, 0, 'bob');
    await env.driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), req1);
    await env.driver.waitForText('Pay Đ25.00', {timeoutMs: 6_000});
    await env.driver.findByTestID('coach-payReview', {timeoutMs: 6_000});
    // The tip must never block the primary action.
    const approveEnabled = await env.driver.eval(() => {
      const n = document.querySelector('[data-testid="btn-approve"]');
      return !!n && n.disabled !== true && n.getAttribute('aria-disabled') !== 'true';
    });
    assert(approveEnabled, 'btn-approve stays enabled while the payReview tip is showing');
    await settle(); // let the tip's 480ms rise+fade entrance finish before the shot
    await env.driver.screenshot('91-coach-review');
    await env.driver.click('btn-coach-payReview-dismiss', {timeoutMs: 4_000});
    await env.driver.waitGone('coach-payReview', {timeoutMs: 6_000});
    await env.driver.click('btn-review-cancel', {timeoutMs: 4_000});
    // Same identity, fresh review (new nonce) → absent.
    const req2 = buildRequestQR(bob.publicHex, PAY_CENTS, randNonceHex(), Math.floor(Date.now() / 1000) + 600, 0, 'bob');
    await waitForScanner(env.driver);
    await env.driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), req2);
    await env.driver.waitForText('Pay Đ25.00', {timeoutMs: 6_000});
    assert(!(await env.driver.isPresent('coach-payReview')), 'payReview tip must not re-show after dismissal');
    await env.driver.click('btn-review-cancel', {timeoutMs: 4_000});
    console.log(`[${meta.name}] ✓ payReview: shown once, never blocks approve, remembered`);

    // --- offlineQr + pendingOutcome: the flow-20 offline hand-off, coached exactly once. -------
    await goOffline(env.driver, {keepGateway: true});
    await env.driver.waitForText('approx.', {timeoutMs: 8_000});
    const req3 = buildRequestQR(bob.publicHex, PAY_CENTS, randNonceHex(), Math.floor(Date.now() / 1000) + 600, 0, 'bob');
    await waitForScanner(env.driver);
    await env.driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), req3);
    await env.driver.waitForText('Pay Đ25.00', {timeoutMs: 6_000});
    assert(!(await env.driver.isPresent('coach-payReview')), 'payReview stays dismissed even offline');
    await env.driver.click('btn-approve', {timeoutMs: 4_000});
    await env.driver.waitForText('signed on this device ✓', {timeoutMs: 8_000});
    await env.driver.findByTestID('coach-offlineQr', {timeoutMs: 6_000});
    await settle(); // entrance finish before the shot
    await env.driver.screenshot('91-coach-offlineqr');
    const payload = await env.driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof payload === 'string' && payload.length >= 64, 'hand-off QR payload must be the base64url envelope');
    await env.driver.click('btn-coach-offlineQr-dismiss', {timeoutMs: 4_000});
    await env.driver.waitGone('coach-offlineQr', {timeoutMs: 6_000});
    console.log(`[${meta.name}] ✓ offlineQr: shown on the offline hand-off, dismissed`);

    // Hand to the merchant → the honest-pending view carries pendingOutcome.
    await env.driver.click('btn-paid', {timeoutMs: 4_000});
    await env.driver.waitForText('Sent Đ25.00', {timeoutMs: 8_000});
    await env.driver.findByTestID('coach-pendingOutcome', {timeoutMs: 6_000});
    await settle(); // entrance finish before the shot
    await env.driver.screenshot('91-coach-pending');
    await env.driver.click('btn-coach-pendingOutcome-dismiss', {timeoutMs: 4_000});
    await env.driver.waitGone('coach-pendingOutcome', {timeoutMs: 6_000});
    console.log(`[${meta.name}] ✓ pendingOutcome: shown on the unresolved view, dismissed`);

    // --- the money path never cared: counterparty submits, payer reconciles to Paid. -----------
    const envelopeBytes = b64urlToBytes(payload);
    const catalog = (await (await fetch(`${env.relayBaseURL}/api/v1/currencies`)).json()).currencies;
    const ledger = catalog.find((c) => c.currency === 0).ledger;
    const submitted = await fetch(`${env.relayBaseURL}/api/v2/canister/${ledger}/call`, {
      method: 'POST',
      headers: {'Content-Type': 'application/cbor'},
      body: envelopeBytes,
    });
    assert(submitted.status === 202, `bob's phone submit must be 202, got ${submitted.status}`);
    assert((await getBalance(env.relayBaseURL, bob.publicHex, 0)) === '12500', 'bob credited 12500');
    await setRelay(env.driver, env.relayBaseURL);
    await env.driver.waitForText('Paid', {timeoutMs: 12_000});
    assert(!(await env.driver.isPresent('coach-pendingOutcome')), 'confirmed Paid screen never carries the pending tip');
    await env.driver.waitForText('Đ75.00', {timeoutMs: 10_000});
    console.log(`[${meta.name}] ✓ hand-off settled + reconciled — coaching never blocked the money path`);

    // --- all four seen-markers persisted on this identity. -------------------------------------
    const journey = await env.driver.eval(() => localStorage.getItem('dpay.journey.v1'));
    for (const key of ['payReview', 'receiveRequest', 'offlineQr', 'pendingOutcome']) {
      assertIncludes(journey, `"${key}"`, `seen-marker "${key}" persisted`);
    }
    assertIncludes(journey, '"recoverySaved"', 'recoverySaved stamp rode along untouched');
    console.log(`[${meta.name}] ✓ all four seen-markers persisted (stamps intact)`);

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
