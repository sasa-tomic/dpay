// Flow 10 — Expired request refused (REAL relay + FakeLedger policy, no debit).
//
// Builds a request with an EXPIRY IN THE PAST, injects it via the camera seam, and has the app
// Approve. The app signs the (expired) authorization and POSTs /api/v1/pay; the FakeLedger's
// `validate` returns `PayError::Expired` (now >= expiry) → the relay responds 422 → the app shows
// the human rejection "The request expired" (payments.ts rejectionMessage) and the balance is
// UNCHANGED. Proves the expiry policy is enforced server-side (the offline payer cannot bind a
// stale request) and that the app surfaces a clear error rather than silently failing.
//
// Selector contract: `pay-amount`, `btn-approve`, `review-err`, `balance`.
import { setup, assert, assertIncludes, onboardWallet } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const PAY_CENTS = 2500; // $25.00

export async function run() {
  const start = Date.now();
  console.log('[10-expired] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    const bob = await generateKeypair();
    console.log('[10-expired] onboarding A…');
    await onboardWallet(driver, 'e2e-expired');

    // A request with an expiry 100s in the PAST — stale on arrival.
    const nonce = randNonceHex();
    const pastExpiry = Math.floor(Date.now() / 1000) - 100;
    const requestQR = buildRequestQR(bob.publicHex, PAY_CENTS, nonce, pastExpiry, 0, 'merchant');

    // A scans the expired request → review shows the amount (client-side doesn't check expiry).
    console.log('[10-expired] injecting an EXPIRED request via the camera seam…');
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });

    // Approve → the app signs + submits; the FakeLedger rejects with Expired (422).
    console.log('[10-expired] clicking btn-approve (sign + submit the expired auth)…');
    await driver.click('btn-approve', { timeoutMs: 5_000 });

    // The app surfaces the human rejection (payments.ts: "expired" → "The request expired").
    const errShown = await driver.waitForText('expired', { timeoutMs: 8_000 });
    const body = await driver.bodyText();
    assert(errShown, `the app should show a clear expiry rejection. body excerpt:\n${body.slice(0, 500)}`);
    // And it stays on the review screen with the error visible (review-err testID).
    const errText = await driver.readText('review-err').catch(() => '');
    assertIncludes((errText || body).toLowerCase(), 'expired', 'review-err should explain the expiry');
    console.log('[10-expired] ✓ app shows "The request expired" (server-side policy, surfaced clearly)');

    // The balance is UNCHANGED — the expired auth debited nothing.
    const unchanged = await driver.waitForText('$100.00', { timeoutMs: 6_000 });
    assert(unchanged, 'balance must be unchanged after the expired refusal ($100.00)');
    console.log('[10-expired] ✓ balance unchanged ($100.00) — no debit on an expired request');

    await driver.screenshot('10-expired');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[10-expired] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[10-expired] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
