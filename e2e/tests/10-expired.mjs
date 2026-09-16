// Flow 10 — Expired request refused (client-side gate, no debit).
//
// Builds a request with an EXPIRY IN THE PAST and injects it via the camera seam. The scan
// AUTO-SIGNS (one-press rule: the "Pay Now" gate press armed the scanner), and the app's
// client-side expiry gate — the FIRST check inside the sign path, before any envelope is built
// or submitted — refuses the stale request with the honest "This request expired — ask the
// merchant for a fresh QR" on the sign-status surface (testID `review-err`) + a Cancel back to
// the gated scan. Nothing is signed, nothing is POSTed, and the balance is UNCHANGED.
// (The server-side FakeLedger `validate` Expired policy remains the backstop for offline-signed
// stale auths; this flow pins the payer-side refusal the user actually sees.)
//
// Selector contract: `review-err`, `btn-review-cancel`, `balance`.
import { setup, assert, assertIncludes, onboardWallet, armPayScan} from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const PAY_CENTS = 2500; // ∂25.00 (DEMO_USD = currency 0)

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '10',
  name: 'expired',
  journey: 'pay',
  covers: ['expiry', 'honest-error', 'no-sign'],
  verifies: 'Payer scans an already-expired request → auto-sign refused client-side, honest error, no leaked nonce.',
  timeoutMs: 31000,
};

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

    // A scans the expired request → the auto-sign's client-side expiry gate refuses it outright.
    console.log('[10-expired] injecting an EXPIRED request via the camera seam (auto-sign attempt)…');
    await armPayScan(driver); // pay-intent gate: arm the scan surface (no-op when already armed)
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);

    // The app surfaces the honest refusal on the sign-status surface (review-err testID).
    const errShown = await driver.waitForText('expired', { timeoutMs: 8_000 });
    const body = await driver.bodyText();
    assert(errShown, `the app should show a clear expiry refusal. body excerpt:\n${body.slice(0, 500)}`);
    const errText = await driver.readText('review-err').catch(() => '');
    assertIncludes((errText || body).toLowerCase(), 'expired', 'review-err should explain the expiry');
    console.log('[10-expired] app shows the expiry refusal (client-side gate, before any sign)');

    // L5: the raw request nonce ("request 9612e903fe03...") must NOT leak to the user-facing sign
    // screen - it is internal protocol data.
    const bodyNow = await driver.bodyText();
    assert(!/request [0-9a-f]{6,}/i.test(bodyNow),
      `sign screen must NOT leak the raw hex request nonce (L5). body excerpt:\n${bodyNow.slice(0, 500)}`);
    console.log('[10-expired] no raw request nonce leaked on the sign screen (L5)');

    // C1, one-press edition: the refused payment offers NO way to sign — there is no sign button
    // at all, only the Cancel back to the gated scan (a doomed payment cannot be re-tapped).
    const hasApprove = await driver.isPresent('btn-approve');
    assert(!hasApprove, 'no sign button may exist once the expiry refusal shows (C1: no doomed re-tap)');
    await driver.findByTestID('btn-review-cancel', { timeoutMs: 4_000 });
    console.log('[10-expired] no sign button; Cancel is the only way out (C1, structural)');

    // The balance is UNCHANGED — nothing was signed or debited.
    const unchanged = await driver.waitForText('∂100.00', { timeoutMs: 6_000 });
    assert(unchanged, 'balance must be unchanged after the expired refusal (∂100.00)');
    console.log('[10-expired] ✓ balance unchanged (∂100.00) — no debit on an expired request');

    await driver.screenshot('10-expired');

    const elapsed = ((Date.now() - start) / 1_000).toFixed(2);
    console.log(`[10-expired] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[10-expired] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
