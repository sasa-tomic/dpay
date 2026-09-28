/**
 * Flow 144 — the jest twin of `e2e/tests/144-checkout-capability-off.mjs` (the private-relay
 * leg the batch B port deferred): cashier availability is DISCOVERED, not constant. A relay with
 * its checkout routes disabled (DPAY_ENABLE_CHECKOUT=false — the operator opt-out) must show the
 * ordinary dpay request form on Receive, never the cashier selector that would lead to a
 * guaranteed 404; the SAME app re-pointed at a checkout-ENABLED relay offers the selector.
 * Absent-then-present on the same wallet pins the surface to `GET /api/v1/capabilities`.
 *
 * The private relay is a startFlowRelay spawn (flow/harness/flowRelay.ts) — checkout is a relay
 * PROCESS env, so the shared per-run relay cannot host the negative half. The positive control
 * re-points at the baked default (fetch-rewritten to the shared, checkout-enabled relay), which
 * also clears the Receive tab's request state the way the twin's `?relay=` reload does.
 *
 * Deliberately NOT asserted: "the app sends no checkout POST" — with the selector absent
 * CheckoutCharge is unreachable, so that assertion would be true of an enabled relay too.
 */
import {describe, it, expect} from '@jest/globals';
import {onboardWallet, pointRelayListAt} from '../harness/lib';
import {startFlowRelay} from '../harness/flowRelay';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

describe('flow 144 — checkout-capability-off (private relay, the operator opt-out)', () => {
  it('a checkout-disabled relay offers no cashier selector while the ordinary VCHF request still works; the enabled relay offers the selector', async () => {
    const checkoutOff = await startFlowRelay({checkout: false});
    // The whole app world rides the persisted relay list (the jest retarget surface) + the
    // per-call IC gateway seam.
    g.__DPAY_TEST_IC_GATEWAY = checkoutOff.baseURL;
    await pointRelayListAt(checkoutOff.baseURL);
    const m = await onboardWallet('jest-checkout-off', {relayBase: checkoutOff.baseURL});

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

    // (3) POSITIVE CONTROL — the same wallet (identity persists), re-pointed at the checkout-
    //     ENABLED shared relay. Dropping the persisted list restores the baked default origin,
    //     which the harness fetch rewrite delivers to the shared relay; the remount also clears
    //     the Receive tab's request state, so the selector is judged on a freshly mounted form.
    g.__DPAY_TEST_IC_GATEWAY = process.env.DPAY_JEST_RELAY_URL;
    await pointRelayListAt(null);
    await m.remount();
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.findByTestID('amount-input', {timeoutMs: 8000});
    expect(m.driver.isPresent('btn-code-checkout')).toBe(true);

    await m.unmount();
  }, 150_000);
});
