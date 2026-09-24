// Flow 204 — the currency-level RAIL SWITCH (multi-currency build-out, 2026-09).
//
// A multi-rail currency section carries ONE switch affordance that resolves `chooseRail` to the
// funded — else preferred — rail of THAT currency. Routing between rails of one currency is not an
// exchange: same unit, different settlement chain. What is pinned here, end to end with home=USD:
//
//   * the switch lives on the SECTION, not the rows: single-rail currencies (CHF, EUR) render no
//     switch at all — selecting the row IS the switch there;
//   * it resolves the preferred rail by name ("Switch to ckUSDC · Internet Computer") and tapping
//     it selects the ASSET row — the MAIN badge comes back with it, the home currency is untouched;
//   * the switch hides while the resolved rail is ALREADY the selected row — a control that would
//     re-select the same account is not a control;
//   * the gesture is the lock-gated payRailSelect contract (flow 71): `onSwitchRail` is undefined
//     while a payment holds the selection, so the affordance vanishes instead of appearing dead.
import { setup, assert, assertIncludes, onboardWallet, openBalances, selectCurrency } from '../harness/lib.mjs';

export const meta = {
  id: '204',
  name: 'currency-rail-switch',
  journey: 'onboard',
  covers: ['currency-groups', 'rail-switch', 'choose-rail', 'group-model', 'routing-not-exchange'],
  verifies: 'On a multi-rail currency section one switch affordance resolves to the preferred — else funded — rail of that currency: it offers the preferred rail by name from outside the group, selects the asset row on tap (MAIN returns, home currency untouched), disappears once the resolved rail is already selected, and never renders on single-rail sections.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[204-currency-rail-switch] setup…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[204-currency-rail-switch] onboarding, pinning home=USD…');
    await onboardWallet(driver, 'e2e-rail-switch');
    await driver.click('btn-settings', {timeoutMs: 5_000});
    await driver.click('btn-currency-USD', {timeoutMs: 5_000});
    await driver.click('btn-settings-close', {timeoutMs: 5_000});

    // --- 1. from a selection outside the group, the switch offers the preferred rail -------------
    // (onboarding leaves the practice rail selected; the USD section resolves chooseRail to its
    // preferred rail — nothing funded, so preference order decides — and offers it by name.)
    await openBalances(driver);
    await driver.findByTestID('accounts-group-usd', {timeoutMs: 6_000});
    await driver.findByTestID('btn-accounts-rail-usd', {timeoutMs: 6_000});
    assertIncludes(await driver.readText('btn-accounts-rail-usd'), 'Switch to ckUSDC · Internet Computer',
      'the switch offers the preferred rail by its rail-line name (ledger token · settlement chain)');
    console.log('[204-currency-rail-switch] ✓ the switch offers the preferred rail by name');

    // Single-rail sections never carry one: the row IS the switch there.
    assert(!(await driver.isPresent('btn-accounts-rail-chf')), 'a single-rail currency (CHF) renders no switch');
    assert(!(await driver.isPresent('btn-accounts-rail-eur')), 'a single-rail currency (EUR) renders no switch');
    assert(!(await driver.isPresent('btn-accounts-rail-other')), 'the non-currency tail renders no switch');
    console.log('[204-currency-rail-switch] ✓ single-rail sections and the tail carry no switch');

    // --- 2. tap it: the ASSET row is selected, MAIN returns, the home currency is untouched ------
    await driver.click('btn-accounts-rail-usd');
    const deadline = Date.now() + 6_000;
    for (;;) {
      const v = await driver.eval(() => document.querySelector('[data-testid="asset-ckusdc"]')?.getAttribute('aria-selected') ?? null);
      if (v === 'true') break;
      if (Date.now() > deadline) throw new Error(`asset-ckusdc never became selected after the rail switch (aria-selected=${v})`);
      await new Promise(r => setTimeout(r, 100));
    }
    assert(await driver.isPresent('asset-ckusdc-main'), 'the preferred rail wears MAIN after the switch selects it');
    assert(await driver.isPresent('asset-sol-usdc-rail'), 'the sibling rail is still its own named row — routing, never a merge');
    assert(!(await driver.isPresent('btn-accounts-rail-usd')), 'the switch disappears once the resolved rail IS the selection');
    assertIncludes(await driver.readText('accounts-group-usd'), 'Main · US dollars',
      'the home currency is untouched — the switch selects an asset row, it never changes the wallet\'s currency');
    await driver.screenshot('204-rail-switch-selected');
    console.log('[204-currency-rail-switch] ✓ the switch selected the asset row; home currency unchanged');

    // --- 3. from the sibling rail, the same gesture routes back -----------------------------------
    await selectCurrency(driver, 'sol-usdc');
    await openBalances(driver);
    await driver.findByTestID('btn-accounts-rail-usd', {timeoutMs: 6_000});
    await driver.screenshot('204-rail-switch-offered');
    await driver.click('btn-accounts-rail-usd');
    const deadline2 = Date.now() + 6_000;
    for (;;) {
      const v = await driver.eval(() => document.querySelector('[data-testid="asset-ckusdc"]')?.getAttribute('aria-selected') ?? null);
      if (v === 'true') break;
      if (Date.now() > deadline2) throw new Error(`asset-ckusdc never became selected on the route back (aria-selected=${v})`);
      await new Promise(r => setTimeout(r, 100));
    }
    assert(!(await driver.isPresent('btn-accounts-rail-usd')), 'and the switch stands down again — its job is done');
    console.log('[204-currency-rail-switch] ✓ routing back from the sibling rail works the same');

    console.log(`[204-currency-rail-switch] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('204-currency-rail-switch RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
