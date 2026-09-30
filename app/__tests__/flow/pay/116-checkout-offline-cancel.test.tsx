/**
 * Flow 116 — the jest twin of `e2e/tests/116-checkout-offline-cancel.mjs` (the counter under a live
 * charge: out of contact, back, and a mis-keyed total taken back).
 *
 * A live charge with the relay killed says "Can't check this charge right now" — silence is not
 * rendered as waiting, certainly not as a sale, and the code stays up (our ignorance does not stop
 * a customer paying). The relay back → the screen returns to waiting. Cancel → the end state names
 * what happened ("Charge cancelled", "Nothing is owed") with no payable code, and the counter
 * reopens from the panel itself.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {assert, assertIncludes, goOffline, onboardWallet, openBalances, selectCurrency, setRelay} from '../harness/lib';
import {relayBaseURL} from '../harness/relayClient';

hermeticDescribe('flow 116 — checkout offline + cancel: out of contact is not unpaid, and a charge can be taken back', () => {
  it('unreachable says so honestly, recovers on reconnection, and cancels cleanly', async () => {
    const m = await onboardWallet('jest-checkout-offline');

    await openBalances(m);
    await selectCurrency(m, 'vchf');
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.click('btn-code-checkout', {timeoutMs: 4000});
    await m.driver.type('amount-input', '4.50', {timeoutMs: 4000});
    await m.driver.click('btn-checkout-open', {timeoutMs: 4000});
    await m.driver.findByTestID('checkout-qr', {timeoutMs: 15_000});
    assertIncludes(m.driver.readText('checkout-status'), 'Waiting for the payment', 'a reachable checkout waits');

    // --- 1. out of contact -------------------------------------------------------------------------
    await goOffline(m);
    assert(await m.driver.waitForText('Can’t check this charge', {timeoutMs: 20_000}),
      'an unreachable checkout must say so');
    const offline = m.driver.bodyText();
    // The two sentences that would be lies — and the denial that makes the first one honest.
    expect(/unpaid/i.test(offline) ? /does NOT mean it is unpaid/.test(offline) : true).toBe(true);
    expect(offline).not.toContain('Waiting for the payment'); // silence is not waiting
    expect(offline).not.toContain('Paid'); // and certainly not a sale
    expect(m.driver.isPresent('checkout-qr')).toBe(true); // the code stays up

    // --- 2. and back ----------------------------------------------------------------------------------
    await setRelay(m, relayBaseURL());
    assert(await m.driver.waitForText('Waiting for the payment', {timeoutMs: 20_000}),
      'the screen returns to waiting once the checkout answers again');

    // --- 3. the mis-keyed total, taken back ------------------------------------------------------------
    await m.driver.click('btn-checkout-cancel', {timeoutMs: 4000});
    await m.driver.findByTestID('checkout-ended', {timeoutMs: 20_000});
    const ended = m.driver.readText('checkout-ended');
    assertIncludes(ended, 'Charge cancelled', 'the end state names what happened');
    assertIncludes(ended, 'Nothing is owed', 'and what it means for the customer standing there');
    expect(m.driver.isPresent('checkout-qr')).toBe(false); // no payable code

    // The counter reopens from the panel itself.
    await m.driver.click('checkout-ended-go', {timeoutMs: 4000});
    await m.driver.findByTestID('btn-checkout-open', {timeoutMs: 6000});

    await m.unmount();
  }, 180_000);
});
