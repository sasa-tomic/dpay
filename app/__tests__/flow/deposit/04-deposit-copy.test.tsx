/**
 * Flow 04 deposit-copy — the jest twin of `e2e/tests/04-deposit-copy.mjs` (M1 port: proves the
 * clipboard seam `__DPAY_TEST_CLIPBOARD` end to end through the REAL copy affordance).
 *
 * Balances → select ckBTC → Receive → "My address" → "Copy address" writes the EXACT deposit
 * address to the captured clipboard (the recorder sits where the browser's navigator.clipboard
 * write sits in the e2e build).
 */
import {describe, it, expect} from '@jest/globals';
import {openBalances, onboardWallet, openReceiveAddress, selectCurrency} from '../harness/lib';

const g = globalThis as unknown as Record<string, unknown>;

describe('flow 04 — deposit copy: the real address reaches the clipboard', () => {
  it('copy writes the deposit address; the request toggle hides the body', async () => {
    const m = await onboardWallet('jest-copy');

    // Balances → select ckBTC (active asset) → Receive → "My address".
    await openBalances(m);
    await selectCurrency(m, 'ckbtc');
    await openReceiveAddress(m);

    await m.driver.findByTestID('deposit-address', {timeoutMs: 10_000});
    const address = m.driver.readText('deposit-address');
    expect(address.length).toBeGreaterThan(0);

    // The seam starts empty; the copy button fills it with the EXACT address.
    g.__DPAY_TEST_CLIPBOARD = '';
    await m.driver.click('btn-deposit-copy', {timeoutMs: 5000});
    await m.driver.waitForFunction(
      () => ((g.__DPAY_TEST_CLIPBOARD as string | undefined)?.length ?? 0) > 0,
      {timeoutMs: 4000, label: 'the clipboard seam receives the write'},
    );
    expect(g.__DPAY_TEST_CLIPBOARD).toBe(address);

    // Flipping back to "Request payment" unmounts the deposit body.
    await m.driver.click('btn-receive-request', {timeoutMs: 5000});
    await m.driver.waitGone('deposit-address', {timeoutMs: 3000});

    await m.unmount();
  }, 60_000);
});
