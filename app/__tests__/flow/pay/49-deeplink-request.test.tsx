/**
 * Flow 49 — the jest twin of `e2e/tests/49-deeplink-request.mjs` (a shared PAYMENT LINK pre-fills
 * the pay review and settles for real).
 *
 * `/<origin>/wallet/pay/<recipient>?asset=…&network=…&amount=…` is THE URL format for "pay me".
 * The port drives the real cold-load URL surface through the harness location stub: identity is
 * persisted first (AsyncStorage — the browser's "identity survives navigation" contract), then the
 * app is mounted WITH the link in the location, so Wallet's link effect reads it off `location`,
 * resolves the asset against the catalog, validates the recipient principal through the core, and
 * PayMode reviews it. Approve settles on the REAL ledger.
 *
 * Asserts: the review is REACHED but NOT paid (a link is a zero-press entry, never an auto-sign);
 * the FULL destination account is on screen; the amount is converted at the asset's own decimals;
 * Approve settles (payer ∂100 → ∂75, payee ∂25).
 */
import {describe, it, expect} from '@jest/globals';
import {
  assert, assertIncludes, faucetAccount, generateKeypair, getBalance,
  onboardSeededUnfunded, openBalances, railPrincipalText,
} from '../harness/lib';
import {mountApp} from '../harness/mount';

const PAY_AMOUNT = '25'; // decimal display units — what the link carries
const PAY_CENTS = '2500'; // the same amount in raw units (DEMO has 2 decimals)
const MERCHANT_NAME = 'Bob';
const REF = 'ab'.repeat(16);

describe('flow 49 — a /wallet/pay link opens the review pre-filled and settles on Approve', () => {
  it('cold-loads the link → review (no auto-pay) → Approve settles ∂25 to B', async () => {
    // --- wallet B: a fresh keypair generated in-test (the payee). -----------------------------
    const bob = await generateKeypair();
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    expect(await getBalance(bob.publicHex, 0)).toBe('0');

    // --- wallet A: persisted identity (the payer, funded ∂100) — then the link cold-load. ------
    // (The e2e twin navigates the SAME browser context to the link with storage intact; here the
    // identity is seeded + the app mounted once to answer the home-currency question, then the
    // LINK is cold-loaded — mountApp({url}) rewinds the location stub before the fresh mount.)
    const m0 = await onboardSeededUnfunded('jest-deeplink', {fund: true});
    await m0.unmount();
    const link = `/wallet/pay/${bobPrincipal}`
      + `?asset=DEMO&network=internet-computer&amount=${PAY_AMOUNT}`
      + `&label=${encodeURIComponent(MERCHANT_NAME)}&ref=${REF}`;
    const m = await mountApp({url: link});
    await m.driver.findByTestID('tab-home', {timeoutMs: 10_000});

    // --- Review pre-filled from the link: reached, NOT paid. ------------------------------------
    await m.driver.findByTestID('pay-amount', {timeoutMs: 6000});
    const payAmt = m.driver.readText('pay-amount');
    assertIncludes(payAmt, '∂25.00', `review should show "Pay ∂25.00" (25 at DEMO's 2 decimals), got "${payAmt}"`);
    assertIncludes(m.driver.bodyText(), MERCHANT_NAME, 'review should show the label the link carried');
    // The destination account IN FULL — the account (not the sender-supplied name) is the identity.
    const reviewPayee = m.driver.readText('review-payee');
    assert(reviewPayee === bobPrincipal,
      `review must show the full destination account: expected ${bobPrincipal}, got "${reviewPayee}"`);
    expect(m.driver.isPresent('review-claimed')).toBe(false); // no unactionable name caveat
    expect(m.driver.bodyText()).not.toMatch(/\bPaid\b/); // SECURITY: a link must NOT auto-pay
    await m.driver.findByTestID('btn-approve', {timeoutMs: 4000});

    // --- Approve → sign + settle on the REAL ledger (the same path a scanned request uses). -----
    await m.driver.click('btn-approve', {timeoutMs: 5000});
    assert(await m.driver.waitForText('Paid', {timeoutMs: 10_000}), 'payer should reach the Paid screen');
    // The Paid card locks the pay surface — release through "New payment", then read the balance.
    await m.driver.click('btn-new', {timeoutMs: 8000});
    await openBalances(m);
    assert(await m.driver.waitForText('∂75.00', {timeoutMs: 10_000}), 'payer balance should be ∂75.00');
    expect(await getBalance(bob.publicHex, 0)).toBe(PAY_CENTS);

    await m.unmount();
  }, 120_000);
});
