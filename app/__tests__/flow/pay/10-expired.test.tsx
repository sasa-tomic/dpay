/**
 * Flow 10 — the jest twin of `e2e/tests/10-expired.mjs` (client-side expiry gate, no debit).
 *
 * A request with an EXPIRY IN THE PAST is injected via the camera seam. The scan AUTO-SIGNS (the
 * "Pay Now" gate press armed the scanner) and the app's client-side expiry gate — the FIRST check
 * inside the sign path — refuses the stale request with the honest "This request expired — ask the
 * merchant for a fresh QR" on the sign-status surface (`review-err`) + a Cancel back to the gated
 * scan. Nothing is signed, nothing is POSTed, the balance is UNCHANGED, and the raw request nonce
 * never leaks onto the screen (L5).
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  armPayScan, assert, assertIncludes, generateKeypair, onboardWallet, openBalances,
} from '../harness/lib';
import {DpayCore} from '../harness/lib';
import {scanSeam} from './local';

const PAY_CENTS = '2500'; // ∂25.00 (DEMO = currency 0)

hermeticDescribe('flow 10 — expired request refused client-side, no debit', () => {
  it('an already-expired request surfaces the honest refusal and never signs', async () => {
    const bob = await generateKeypair();
    const m = await onboardWallet('jest-expired');

    // A request with an expiry 100s in the PAST — stale on arrival.
    const nonce = '9612e903fe03a1b2c3d4e5f60718293a';
    const pastExpiry = Math.floor(Date.now() / 1000) - 100;
    const requestQR = await DpayCore.encodeRequest(bob.publicHex, PAY_CENTS, nonce, pastExpiry, 0, 'merchant', '');

    // A scans the expired request → the auto-sign's client-side expiry gate refuses it outright.
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(requestQR);

    // The honest refusal on the sign-status surface (review-err).
    expect(await m.driver.waitForText('expired', {timeoutMs: 8000})).toBe(true);
    const errText = m.driver.readTextSafe('review-err') ?? '';
    assertIncludes((errText || m.driver.bodyText()).toLowerCase(), 'expired', 'review-err should explain the expiry');

    // L5: the raw request nonce must NOT leak to the user-facing sign screen.
    const bodyNow = m.driver.bodyText();
    expect(bodyNow).not.toMatch(/request [0-9a-f]{6,}/i);

    // C1 (one-press edition): the refused payment offers NO way to sign — only Cancel back to the
    // gated scan (a doomed payment cannot be re-tapped).
    expect(m.driver.isPresent('btn-approve')).toBe(false);
    await m.driver.findByTestID('btn-review-cancel', {timeoutMs: 4000});

    // The balance is UNCHANGED — nothing was signed or debited. Release the review first, then
    // read the settled practice balance on the accounts route.
    await m.driver.click('btn-review-cancel', {timeoutMs: 4000});
    await m.driver.findByTestID('pay-scan', {timeoutMs: 5000});
    await openBalances(m);
    assert(await m.driver.waitForText('∂100.00', {timeoutMs: 6000}),
      'balance must be unchanged after the expired refusal (∂100.00)');

    await m.unmount();
  }, 90_000);
});
