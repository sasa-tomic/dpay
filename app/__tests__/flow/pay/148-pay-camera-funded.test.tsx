/**
 * Flow 148 — the jest twin of `e2e/tests/148-pay-camera-and-funded-account.mjs` (the founder's
 * reported state: an unfunded asset selected on the Pay tab).
 *
 * X1: the fund instruction states the lack, keeps the deposit route, and NAMES the practice balance
 * the wallet actually holds (∂100.00, "Practise with it", "cannot pay a real merchant"). X3: the
 * camera stays reachable and one press opens it; a DEMO request scanned with VCHF selected still
 * settles — the request names the asset, not the selection. X1 again: the one-tap switch moves the
 * WORKING selection, the chip keeps the main currency (X4).
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  armPayScan, assert, assertEq, assertIncludes, generateKeypair, onboardWallet,
  openBalances, selectCurrency,
} from '../harness/lib';
import {DpayCore} from '../harness/lib';
import {scanSeam} from './local';

const PAY_CENTS = '100'; // ∂1.00

hermeticDescribe('flow 148 — an unfunded selection: the pointer, the camera, the request’s own asset', () => {
  it('the fund panel names the practice balance; the camera opens; a DEMO request settles anyway', async () => {
    // A fresh wallet: ∂100.00 practice money from the faucet, and nothing else anywhere.
    const m = await onboardWallet('jest-x1x3');

    // Select VCHF — a real asset this wallet holds none of. This IS the founder's reported state.
    await openBalances(m);
    await selectCurrency(m, 'vchf');
    await m.driver.click('tab-pay', {timeoutMs: 5000});

    // X1: the instruction survives AND the practice balance is finally named.
    await m.driver.findByTestID('pay-fund', {timeoutMs: 5000});
    const panel = m.driver.readText('pay-fund');
    assertIncludes(panel, 'No VCHF available', 'the fund instruction still states the lack');
    assertIncludes(panel, 'Show my VCHF address', 'and still carries the deposit route');
    const pointer = m.driver.readText('fund-sibling-holds');
    assertIncludes(pointer, '∂100.00', 'the pointer names the practice balance the wallet actually holds');
    assertIncludes(pointer, 'Practise with it', 'and says what it is FOR');
    assertIncludes(pointer, 'cannot pay a real merchant', 'and what it is NOT — never an implied real balance');

    // X3: the camera is LIVE on open (founder 2026-10-09 auto-arm) and the fund instruction
    // keeps its entry BELOW the lens.
    await m.driver.findByTestID('scan-cam-box', {timeoutMs: 8000});
    expect(m.driver.isPresent('pay-fund')).toBe(true);

    // X3, the consequence: a request for an asset the wallet DOES hold settles.
    const bob = await generateKeypair();
    const requestQR = await DpayCore.encodeRequest(
      bob.publicHex, PAY_CENTS, 'aa'.repeat(16), Math.floor(Date.now() / 1000) + 600, 0, 'Cafe', '',
    );
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(requestQR);
    await m.driver.findByTestID('pay-amount', {timeoutMs: 8000});
    assert(await m.driver.waitForText('Paid', {timeoutMs: 15_000}),
      'a DEMO request scanned with VCHF selected must settle');

    // X1: the one-tap switch is real.
    await m.driver.click('btn-new', {timeoutMs: 5000});
    await m.driver.click('tab-home', {timeoutMs: 5000});
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.click('btn-fund-sibling-switch', {timeoutMs: 8000});
    assertEq(m.driver.readText('active-asset-label'), 'Balance CHF',
      'the practice tap moves the WORKING selection — the chip keeps the main currency (X4)');

    await m.unmount();
  }, 150_000);
});
