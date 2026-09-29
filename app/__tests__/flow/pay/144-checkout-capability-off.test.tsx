/**
 * Flow 144 — the jest twin of `e2e/tests/144-checkout-capability-off.mjs` (the private-relay
 * leg the batch B port deferred): cashier availability is DISCOVERED, not constant. A relay with
 * its checkout routes disabled (DPAY_ENABLE_CHECKOUT=false — the operator opt-out) must show the
 * ordinary dpay request form on Receive, never the cashier selector that would lead to a
 * guaranteed 404; the SAME app re-pointed at a checkout-ENABLED relay offers the selector.
 * Absent-then-present on the same wallet pins the surface to `GET /api/v1/capabilities`.
 *
 * Checkout is a relay PROCESS env, so it is a per-spawn knob: the hermetic file relay carries the
 * NEGATIVE half (hermeticFlow({relay:{checkout:false}}) — every app/harness path lands there), and
 * the positive control spawns an ad-hoc checkout-ENABLED relay per test (startFlowRelay — the
 * lifecycle drains it after the test).
 *
 * Deliberately NOT asserted: "the app sends no checkout POST" — with the selector absent
 * CheckoutCharge is unreachable, so that assertion would be true of an enabled relay too.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {onboardWallet, pointRelayListAt} from '../harness/lib';
import {startFlowRelay} from '../harness/flowRelay';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

hermeticFlow({relay: {checkout: false}});

hermeticDescribe('flow 144 — checkout-capability-off (private relay, the operator opt-out)', () => {
  it('a checkout-disabled relay offers no cashier selector while the ordinary VCHF request still works; the enabled relay offers the selector', async () => {
    // The hermetic world already rides the checkout-DISABLED relay (gateway seam + fetch rewrite):
    // no re-point needed for the negative half.
    const m = await onboardWallet('jest-checkout-off');

    // (1) NEGATIVE HALF — checkout off. `receive-code-form` is the selector's container; its
    //     absence is the constraint (asserting btn-code-checkout here would restate it).
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.findByTestID('amount-input', {timeoutMs: 8000});
    expect(m.driver.isPresent('receive-code-form')).toBe(false);

    // (2) The ordinary VCHF request is untouched by the missing capability — the honest fallback
    //     is the full dpay request, not a degraded screen.
    await m.driver.type('amount-input', '1.00', {timeoutMs: 4000});
    await m.driver.click('btn-request', {timeoutMs: 4000});
    await m.driver.findByTestID('request-qr', {timeoutMs: 8000});

    // (3) POSITIVE CONTROL — the same wallet (identity persists), re-pointed at an ad-hoc
    //     checkout-ENABLED relay: the persisted list + gateway seam carry the app there, and the
    //     remount clears the Receive tab's request state so the selector is judged on a freshly
    //     mounted form.
    const checkoutOn = await startFlowRelay({checkout: true});
    g.__DPAY_TEST_IC_GATEWAY = checkoutOn.baseURL;
    await pointRelayListAt(checkoutOn.baseURL);
    await m.remount();
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.findByTestID('amount-input', {timeoutMs: 8000});
    expect(m.driver.isPresent('btn-code-checkout')).toBe(true);

    await m.unmount();
  }, 150_000);
});
