/**
 * Flow 14 keyboard — the jest twin of `e2e/tests/14-keyboard.mjs` (minus the DOM-only legs).
 *
 * The single-key surface (P/R/L/T/A + Escape) is driven through the harness's keydown registry —
 * the same `window.addEventListener('keydown')` seam useHotkeys attaches to. T is global: pressed
 * from the Pay tab (which has no faucet button) it must reach the faucet and answer IN PLACE with
 * the relay's own cooldown reason. Escape closes the inline deposit body, whose "Press Esc to
 * close" hint is the in-UI documentation of the surface.
 *
 * GAP vs the browser twin (filed for the integrator): the input-guard leg IS ported — but by
 * seeding the `document.activeElement` global the app's guard reads (jest has no document),
 * which is exactly the state the browser's focused input produces. The :focus-visible ring leg is
 * a computed-style read and stays visual.
 */
import {describe, it, expect} from '@jest/globals';
import {
  assertIncludes, onboardWallet, openBalances, openReceiveAddress, selectCurrency,
} from '../harness/lib';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

const g = globalThis as unknown as Record<string, unknown>;

hermeticDescribe('flow 14 — keyboard', () => {
  it('P/R/L switch tabs; T answers in place from Pay; A lands accounts; the input guard holds; Escape closes the deposit', async () => {
    const m = await onboardWallet('e2e-keyboard');
    // The app itself lands on Home; onboardWallet leaves it on the Pay tab. Demo balance ∂100.00.

    // --- R / P: single-key tab switching -------------------------------------------------------
    await m.driver.pressKey('r');
    await m.driver.findByTestID('btn-request', {timeoutMs: 3000});
    expect(m.driver.isPresent('pay-scan')).toBe(false);
    await m.driver.pressKey('p');
    await m.driver.findByTestID('pay-scan', {timeoutMs: 3000});
    expect(m.driver.isPresent('btn-request')).toBe(false);

    // --- L: single-key Ledger (transactions) ----------------------------------------------------
    await m.driver.pressKey('l');
    await m.driver.findByTestID('ledger-view', {timeoutMs: 3000});
    await m.driver.pressKey('p'); // back to Pay for the rest of the flow
    await m.driver.findByTestID('pay-scan', {timeoutMs: 3000});

    // --- T: single-key top-up, fired from the Pay tab (no faucet button there) ------------------
    // The proof T FIRED is the relay's own cooldown refusal, and it must land ON THIS SCREEN.
    await m.driver.pressKey('t');
    await m.driver.findByTestID('topup-err', {timeoutMs: 6000});
    const said = m.driver.readText('topup-err');
    expect(said).toMatch(/faucet cooldown: try again in ~\d+ (h|min|s)/);
    expect(m.driver.isPresent('pay-scan')).toBe(true);
    expect(m.driver.isPresent('btn-topup')).toBe(false);

    // --- A: single-key Accounts -----------------------------------------------------------------
    await m.driver.pressKey('a');
    await m.driver.findByTestID('accounts-list', {timeoutMs: 3000});
    expect(m.driver.bodyText()).toContain('∂100.00'); // a refused top-up credited nothing

    // Back to Pay via P.
    await m.driver.pressKey('p');
    await m.driver.findByTestID('pay-scan', {timeoutMs: 3000});

    // --- Input guard: shortcuts must NOT fire while an input is focused -------------------------
    await m.driver.pressKey('r'); // → Receive (amount-input is the field a user would type into)
    await m.driver.findByTestID('amount-input', {timeoutMs: 3000});
    // Seed exactly the state a focused input produces — the global the guard reads.
    g.document = {activeElement: {tagName: 'INPUT'}};
    await m.driver.pressKey('p'); // must NOT switch tabs while an input is focused
    expect(m.driver.isPresent('pay-scan')).toBe(false);
    // Once the field loses focus (activeElement empty again), the shortcut works.
    g.document = undefined;
    await m.driver.pressKey('p');
    await m.driver.findByTestID('pay-scan', {timeoutMs: 3000});

    // --- Escape closes the inline deposit body + the in-UI hint renders --------------------------
    await openBalances(m);
    await selectCurrency(m, 'ckbtc');
    await openReceiveAddress(m);
    await m.driver.findByTestID('deposit-address', {timeoutMs: 10_000});
    assertIncludes(m.driver.bodyText(), 'Press Esc to close', 'the deposit body documents the Esc shortcut in-UI');
    await m.driver.pressKey('Escape');
    await m.driver.waitGone('deposit-address', {timeoutMs: 3000});

    await m.unmount();
  }, 90_000);
});
