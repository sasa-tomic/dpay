/**
 * Flow 07 scan-pay — the jest twin of `e2e/tests/07-scan-pay.mjs` (M1 reference port: proves the
 * camera seam, the auto-sign one-press rule, REAL ed25519 signing via the wasm core, and REAL
 * relay settlement — debit + credit).
 *
 * Wallet A (onboarded payer, ∂100) scans wallet B's request QR via __DPAY_TEST_SCAN → decode
 * AUTO-SIGNS → POST /pay → the FakeLedger verifies + settles. Asserts: "Paid ✓" names Bob, A's
 * balance drops to ∂75.00, B is credited ∂25.00 (read straight off the relay), and the history
 * row names the payee without dumping principals.
 */
import {describe, it, expect} from '@jest/globals';
import {
  armPayScan, assertIncludes, DpayCore, generateKeypair, getBalance, onboardWallet,
  openBalances, railPrincipalText,
} from '../harness/lib';

const PAY_CENTS = '2500'; // ∂25.00, DEMO currency 0 — the wallet's practice asset
const MERCHANT_NAME = 'Bob';

describe('flow 07 — scan → auto-sign → pay (two wallets, real settlement)', () => {
  it('A scans B’s request → Paid ✓ → A −∂25, B +∂25, history names Bob', async () => {
    // --- wallet B: the payee, a fresh keypair of the REAL core, starting at 0. -----------------
    const bob = await generateKeypair();
    expect(await getBalance(bob.publicHex, 0)).toBe('0');

    // --- wallet A: onboarded payer (∂100 by the faucet). ---------------------------------------
    const m = await onboardWallet('jest-alice');

    // --- B's request QR: the plain base64url of the 132-byte request (the app decodes it with
    //     DpayCore.decodeRequest — the same build e2e/harness/wire.mjs mirrors in JS).
    const nonceHex = 'cd'.repeat(16);
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const qr = await DpayCore.encodeRequest(bob.publicHex, PAY_CENTS, nonceHex, expiry, 0, MERCHANT_NAME, '');

    // --- A scans (auto-sign: the "Pay Now" gate that armed the scanner WAS the deliberate press).
    await armPayScan(m);
    const seam = (globalThis as unknown as {__DPAY_TEST_SCAN: (v: string) => void}).__DPAY_TEST_SCAN;
    await m.driver.settleFrames(1);
    seam(qr);

    // --- Paid straight from the scan, naming the real recipient (L6). --------------------------
    const paid = await m.driver.waitForText('Paid', {timeoutMs: 10_000});
    expect(paid).toBe(true);
    const paidBody = m.driver.bodyText();
    assertIncludes(paidBody, 'Bob', 'Paid ✓ confirmation should name the recipient (L6)');
    expect(paidBody).not.toMatch(/\bmerchant\b/i);

    // --- A's practice balance reconciles to ∂75.00 on the accounts route. ----------------------
    await m.driver.click('btn-new', {timeoutMs: 5000});
    await armPayScan(m);
    await openBalances(m);
    expect(await m.driver.waitForText('∂75.00', {timeoutMs: 10_000})).toBe(true);

    // --- B was credited (read straight off the relay — no second wallet app). ------------------
    expect(await getBalance(bob.publicHex, 0)).toBe(PAY_CENTS);

    // --- A's history lists the outgoing payment, named, principal-less. ------------------------
    await m.driver.click('tab-transactions', {timeoutMs: 5000});
    expect(await m.driver.waitForText('Recent', {timeoutMs: 8000})).toBe(true);
    const histBody = m.driver.bodyText();
    assertIncludes(histBody, 'to Bob', 'history row shows the payee name (device-saved annotation)');
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    expect(histBody).not.toContain(bobPrincipal);
    expect(histBody).not.toContain(bob.publicHex);

    await m.unmount();
  }, 90_000);
});
