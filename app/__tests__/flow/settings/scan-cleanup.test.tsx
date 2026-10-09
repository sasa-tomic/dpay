/**
 * Flow 17 scan-cleanup — the jest twin of `e2e/tests/17-scan-cleanup.mjs`.
 *
 * The Pay tab mounts its scanner LIVE (auto-arm, founder 2026-10-09: exactly one listener on
 * open, no press first); switching tabs unmounts the scanner and its listener goes with it (no
 * leak); a re-mount re-arms to exactly one. Listener counts come off the harness's own scan-seam
 * registry.
 */
import {it, expect} from '@jest/globals';
import {onboardWallet} from '../harness/lib';
import {scaled as budgetScaled} from '../harness/budget';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

const g = globalThis as unknown as Record<string, unknown>;
const scanCount = (): number => (g.__DPAY_TEST_SCAN_COUNT as () => number)();

hermeticDescribe('flow 17 — scan-cleanup', () => {
  it('open 1 → tab switch cleans up → re-mount re-arms to 1', async () => {
    const m = await onboardWallet('e2e-scan-cleanup');

    // Pay tab open: the scanner mounts WITH the tab — one live listener, no gate press.
    await m.driver.findByTestID('tab-pay', {timeoutMs: 4000});
    await m.driver.findByTestID('scan-cam-box', {timeoutMs: 4000});
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

    // Receive → Pay: a FRESH mount re-arms to exactly one.
    await m.driver.click('tab-pay', {timeoutMs: 4000});
    await m.driver.findByTestID('scan-cam-box', {timeoutMs: 4000});
    expect(scanCount()).toBe(1);

    await m.unmount();
  }, 120_000);
});
