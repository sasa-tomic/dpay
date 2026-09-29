/**
 * Flow 13 offline — the jest twin of `e2e/tests/13-offline.mjs`.
 *
 * With the relay GENUINELY dead (a bound-then-closed port — the real unreachable-relay failure
 * mode), the wallet fails closed and gracefully: the DEMO top-up HIDES instead of advertising a
 * guaranteed failure, the balance poll fails for the RIGHT reason (a connection refusal, not a
 * port-policy artifact), the header shows the offline indicator, and the wallet still renders.
 */
import {it, expect} from '@jest/globals';
import {scaled as budgetScaled} from '../harness/budget';

import {
  goOffline, onboardWallet, openBalances, waitForWallet,
} from '../harness/lib';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

hermeticDescribe('flow 13 — offline', () => {
  it('a dead relay hides the top-up (fail-closed), fails for the right reason, shows the indicator, and never crashes', async () => {
    // Onboard against the GOOD relay (∂100 — the wallet works when online).
    const m = await onboardWallet('e2e-offline');

    // Retarget at a GENUINELY-DEAD relay and record the underlying request failures. Only THIS
    // origin's failures count: the snapshot's earlier entries belong to the onboarding churn.
    const {deadRelay} = await goOffline(m);

    // Capability fail-closed: no DEMO faucet advertised while the relay is unreachable.
    await openBalances(m);
    expect(m.driver.isPresent('btn-topup')).toBe(false);

    // The RIGHT-REASON gate: the balance poll must have failed with a CONNECTION-class error.
    // (Re-collect per iteration: the driver's snapshot only advances when collected.)
    let failed: Array<{url: string; origin: string; error?: string}> = [];
    for (let i = 0; i < 40 && failed.length === 0; i++) {
      m.driver.collectFetchFailures();
      failed = m.driver.fetchFailures.filter((f) => f.url.includes('/api/v1/balances') && f.origin === deadRelay);
      if (failed.length === 0) await new Promise((r) => setTimeout(r, budgetScaled(100)));
    }
    expect(failed.length > 0).toBe(true);
    const errText = failed[0].error ?? '';
    expect(/CONNECTION|NETWORK|REFUSED|FAILED/i.test(errText)).toBe(true);
    expect(/UNSAFE_PORT/i.test(errText)).toBe(false);

    // The header shows the offline indicator ("~ DEMO approx." — 'approx.' is the substring).
    expect(await m.driver.waitForText('approx.', {timeoutMs: 8000})).toBe(true);

    // The wallet is still rendered (no blank/crash).
    await waitForWallet(m, {timeoutMs: 4000});

    await m.unmount();
  }, 90_000);
});
