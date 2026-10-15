/**
 * Flow 54 - WalletConnect's ONE entry is the camera (the founder's lean-UI call 2026-10-15: the
 * entry row + instruction sheet are gone; scanning a `wc:` code on the pay tab is the whole
 * wallet side, exactly as it was before the entry wave).
 *
 * WRITTEN, NOT YET RUN: this file joins the flow suite at the next `just flow`. What it pins,
 * over the fake relay and the EVM harness:
 *
 *   • The IC Pay scan card carries exactly ONE line of WC education (`wc-scan-hint`, under the
 *     camera privacy line in the permission empty state) and NO entry row (`btn-pay-wc` exists
 *     nowhere). The Solana scan card stays bare: no hint, no row (education is IC-pay-only).
 *   • A scanned `wc:` payload routes through the pre-existing classifier path (lib/scan.ts
 *     kind=walletconnect → Wallet.pairWc) via the `__DPAY_TEST_SCAN` camera seam - no real
 *     pairing. The jest env is doubly disabled (`Platform.OS === 'web'` + the project-id
 *     override ''), so `walletkit.pair()` refuses with `false` and the routing surfaces as the
 *     honest link-error card (pay-link-error naming the mobile app) - never as "isn't a dpay
 *     payment code".
 *   • The old `__DPAY_TEST_WC_NATIVE` arm is RETIRED with the entry row: the gate that read it
 *     is deleted and the scan path never read it (nothing does anymore - this file is the
 *     proof: it drives the full `wc:` route without touching the flag).
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {evmEnv} from '../evm/env';
import {scanSeam} from './local';

hermeticDescribe('flow 54 - the Pay scan card: the WC hint line and the wc: classifier route', () => {
  it('the hint line sits in the IC scan card, no entry row exists, and a scanned wc: payload routes to pairing', async () => {
    const {onboardWallet, waitForWallet, armPayScan} = await evmEnv();
    const m = await onboardWallet('jest-wc-54');
    await waitForWallet(m);

    // The pay tab opens scanning (the mount IS the scan intent); the camera placeholder branch
    // carries the hint line under the privacy line.
    await armPayScan(m);
    await m.driver.findByTestID('pay-scan', {timeoutMs: 5000});
    expect(m.driver.readText('wc-scan-hint')).toBe('WalletConnect codes connect your dapps here.');
    expect(m.driver.isPresent('btn-pay-wc')).toBe(false);

    // The classifier route: a `wc:` pairing URI off the camera lands in the Wallet's pairing
    // entry (pairWc), which on this disabled env answers the honest refusal card - the proof it
    // was ROUTED (a non-payment payload would have said "isn't a dpay payment code" instead).
    await m.driver.settleFrames(1);
    scanSeam()('wc:8a5f2c@2?relay-protocol=irn&symKey=4d7a9b1c');
    await m.driver.findByTestID('pay-link-error', {timeoutMs: 5000});
    expect(m.driver.readText('pay-link-error-body')).toBe(
      'WalletConnect is unavailable. Use the dpay mobile app to connect.',
    );
    expect(m.driver.bodyText()).not.toContain("isn't a dpay payment code");

    await m.unmount();
  }, 150_000);

  it('the Solana scan card stays bare: no hint line, no entry row (education is IC-pay-only)', async () => {
    const {onboardWallet, waitForWallet, openBalances, selectCurrency, armPayScan} = await evmEnv();
    const m = await onboardWallet('jest-wc-54b');
    await waitForWallet(m);
    await openBalances(m, {timeoutMs: 5000});
    await selectCurrency(m, 'sol', {timeoutMs: 5000});
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 5000});
    expect(m.driver.isPresent('wc-scan-hint')).toBe(false);
    expect(m.driver.isPresent('btn-sol-pay-wc')).toBe(false);
    // The scanner still arms on the SOL card - the wc: classifier rides it there too.
    await armPayScan(m);
    await m.unmount();
  }, 150_000);
});
