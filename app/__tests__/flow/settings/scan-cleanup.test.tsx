/**
 * Flow 17 scan-cleanup — the jest twin of `e2e/tests/17-scan-cleanup.mjs`.
 *
 * The Pay tab mounts IDLE under the pay-intent gate (0 listeners until "Pay Now"); arming mounts
 * exactly one; switching tabs unmounts the scanner and its listener goes with it (no leak); a
 * re-mount re-gates (fresh intent required) and re-arms to exactly one. Listener counts come off
 * the harness's own scan-seam registry.
 */
import {describe, it, expect} from '@jest/globals';
import {armPayScan, onboardWallet} from '../harness/lib';
import {scaled as budgetScaled} from '../harness/budget';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

const g = globalThis as unknown as Record<string, unknown>;
const scanCount = (): number => (g.__DPAY_TEST_SCAN_COUNT as () => number)();

hermeticDescribe('flow 17 — scan-cleanup', () => {
  it('idle 0 → armed 1 → tab switch cleans up → re-mount re-gates → re-arms to 1', async () => {
    const m = await onboardWallet('e2e-scan-cleanup');

    // Pay tab idle: no scan listener until "Pay Now".
    await m.driver.findByTestID('tab-pay', {timeoutMs: 4000});
    await m.driver.findByTestID('btn-start-scan', {timeoutMs: 4000});
    expect(scanCount()).toBe(0);

    // Arming the gate mounts exactly one scan listener.
    await armPayScan(m);
    expect(scanCount()).toBe(1);

    // Pay → Receive: PayMode unmounts, its scanner tears down, the count returns to 0.
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.findByTestID('btn-request', {timeoutMs: 4000});
    let after = scanCount();
    for (let i = 0; i < 20 && after > 0; i++) {
      await new Promise((r) => setTimeout(r, budgetScaled(50)));
      after = scanCount();
    }
    expect(after).toBe(0);

    // Receive → Pay: a FRESH mount re-gates (0), then re-arms to exactly one.
    await m.driver.click('tab-pay', {timeoutMs: 4000});
    await m.driver.findByTestID('btn-start-scan', {timeoutMs: 4000});
    expect(scanCount()).toBe(0);
    await armPayScan(m);
    expect(scanCount()).toBe(1);

    await m.unmount();
  }, 120_000);
});
