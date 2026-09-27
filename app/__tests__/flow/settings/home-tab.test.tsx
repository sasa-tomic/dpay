/**
 * Flow 134 home-add-money — the jest twin of `e2e/tests/134-home-add-money.mjs`.
 *
 * Add funds opens the home rail's deposit surface (and SELECTS it); the T hotkey reaches the relay
 * from Home and answers in place; the practice row's own faucet button refuses inside the cooldown
 * with the relay's verbatim retry time and credits nothing.
 */
import {describe, it, expect} from '@jest/globals';
import {
  assertEq, assertIncludes, onboardWallet, openBalances, selectCurrency,
} from '../harness/lib';
import {freshContext} from '../onboard/helpers';

describe('flow 134 — home-add-money', () => {
  it('add-funds lands the home rail deposit; T answers on Home; the practice faucet refuses and credits nothing', async () => {
    await freshContext();
    const m = await onboardWallet('e2e-add'); // DEMO ∂100
    await m.driver.click('tab-home', {timeoutMs: 4000});
    await m.driver.findByTestID('home-headline-amount', {timeoutMs: 5000});

    // (a) The headline states the home CURRENCY; Add funds opens the home rail's deposit surface.
    assertEq(m.driver.readText('home-headline-label'), 'Balance CHF', 'the headline names the home CURRENCY');
    expect(m.driver.readText('home-headline-amount').includes('∂')).toBe(false);

    await m.driver.click('btn-home-add-funds', {timeoutMs: 4000});
    await m.driver.findByTestID('deposit-address', {timeoutMs: 5000});
    const addr = m.driver.readText('deposit-address');
    expect(addr.length > 0).toBe(true);
    assertIncludes(m.driver.readText('active-asset-label'), 'Balance CHF',
      'funding the home rail SELECTS it — the account you asked to fund is the account you land on');

    // (c) FIRST, because its proof is the FIRST refusal line to appear: the T hotkey from a
    //     surface with no faucet button at all.
    await openBalances(m);
    await selectCurrency(m, 'demo');
    await m.driver.click('tab-home', {timeoutMs: 4000});
    await m.driver.findByTestID('home-headline-amount', {timeoutMs: 5000});
    expect(m.driver.isPresent('btn-topup')).toBe(false);
    await m.driver.pressKey('t');
    await m.driver.findByTestID('topup-err', {timeoutMs: 8000});
    assertIncludes(m.driver.readText('topup-err'), 'faucet cooldown',
      "the T hotkey reached the relay from Home and its own reason came back");
    await m.driver.findByTestID('home-headline-amount', {timeoutMs: 4000});

    // (b) The faucet button lives on the practice row, and a refused tap moves no money.
    await openBalances(m);
    assertIncludes(m.driver.readText('asset-demo'), '∂100.00', 'the practice row starts at the faucet-seeded ∂100.00');
    await m.driver.click('btn-topup', {timeoutMs: 4000});
    await m.driver.findByTestID('topup-err', {timeoutMs: 8000});
    assertIncludes(m.driver.readText('topup-err'), 'try again in',
      "the refusal names WHEN to retry — the relay's own text, verbatim (N5)");
    assertIncludes(m.driver.readText('asset-demo'), '∂100.00', 'a refused top-up credits nothing');

    await m.unmount();
  }, 120_000);
});
