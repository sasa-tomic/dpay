// Flow 205 — the TILL prices in the merchant's chosen currency: the cashier picks the settlement
// asset at ring-up (multi-currency build-out, 2026-09; extends flows 114/115).
//
// `tillSettlementRow` (app/services/till.ts) admits exactly the IC rows that settle a HOME currency
// at mainnet with a stated catalog fee — a charge priced in francs settles 1:1 into VCHF, dollars
// into ckUSDC; anything else would need an exchange rate, and dpay has none to quote. What is
// pinned here, through the REAL relay's till routes:
//
//   * the counter offers a settlement PICKER with exactly the qualifying rows — VCHF and ckUSDC —
//     and never a non-currency asset (no ICP/ckBTC pill: no honest price unit exists for one);
//   * a dollar pick served by today's VCHF-only till is REFUSED WHOLE: the answer names the asset
//     it opened, the counter shows no code for a charge the counter did not ring up, and the
//     refusal names both assets with the one-tap fix;
//   * re-picking the served asset and ringing up again opens the charge — the franc price reads
//     exactly as flow 114's, so the picker costs the VCHF path nothing.
import { setup, assert, assertIncludes, onboardWallet, openBalances, selectCurrency } from '../harness/lib.mjs';

export const meta = {
  id: '205',
  name: 'till-settlement-predicate',
  journey: 'pay',
  covers: ['till', 'merchant-till', 'settlement-predicate', 'currency-groups', 'honest-refusal', 'vchf', 'ckusdc', 'no-fx-sum'],
  verifies: 'The till counter offers exactly the assets an honest multi-currency till can settle (VCHF · CHF, ckUSDC · USD — never ICP/ckBTC, which have no currency to price in); a ckUSDC pick answered by the VCHF-only till is refused whole with no code shown and a one-tap fix naming both assets; re-picking VCHF rings the charge up exactly as flow 114 does.',
  timeoutMs: 120_000,
};

export async function run() {
  const start = Date.now();
  console.log('[205-till-settlement-predicate] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver} = env;

    console.log('[205-till-settlement-predicate] onboarding the shop…');
    await onboardWallet(driver, 'Bahnhof Kiosk');

    // --- the counter, on the till's own row -------------------------------------------------------
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await driver.click('tab-receive', {timeoutMs: 4_000});
    await driver.click('btn-code-till', {timeoutMs: 4_000});

    // --- 1. the picker offers exactly the honest settlement assets --------------------------------
    await driver.findByTestID('till-settle', {timeoutMs: 6_000});
    assert(await driver.isPresent('till-asset-vchf'), 'the picker offers VCHF · CHF');
    assert(await driver.isPresent('till-asset-ckusdc'), 'the picker offers ckUSDC · USD');
    assert(!(await driver.isPresent('till-asset-icp')), 'ICP settles no home currency — no honest price unit exists, so no pill');
    assert(!(await driver.isPresent('till-asset-ckbtc')), 'ckBTC settles no home currency — no pill');
    const pills = await driver.readText('till-settle');
    assertIncludes(pills, 'VCHF · CHF', 'each pill names the asset AND the currency the price is read in');
    assertIncludes(pills, 'ckUSDC · USD', 'the dollar pill prices in dollars, not francs');
    await driver.screenshot('205-till-settlement-picker');
    console.log('[205-till-settlement-predicate] ✓ picker: VCHF · CHF and ckUSDC · USD, nothing without a price unit');

    // --- 2. a dollar pick against the VCHF-only till is refused whole -----------------------------
    await driver.click('till-asset-ckusdc', {timeoutMs: 4_000});
    assertIncludes(await driver.readText('req-prefix'), '$',
      'the amount-field unit badge follows the pick — a dollar pick never sits under a franc badge');
    await driver.type('amount-input', '10.50', {timeoutMs: 4_000});
    await driver.click('btn-till-ring-up', {timeoutMs: 4_000});
    await driver.findByTestID('till-failed', {timeoutMs: 15_000});
    assert(!(await driver.isPresent('till-qr')), 'NO code is shown for a charge the counter did not ring up');
    const said = await driver.readText('till-failed');
    assertIncludes(said, 'VCHF', 'the refusal names the asset the till DID open');
    assertIncludes(said, 'USD', 'the refusal names the currency the cashier picked');
    await driver.screenshot('205-till-served-other-refusal');
    console.log('[205-till-settlement-predicate] ✓ a dollar pick served as a franc charge is refused, naming both');

    // --- 3. the one-tap fix: re-pick the served asset, ring up again — flow 114's result ----------
    await driver.click('till-failed-go', {timeoutMs: 4_000});
    await driver.findByTestID('btn-till-ring-up', {timeoutMs: 6_000});
    assertIncludes(await driver.readInputValue('amount-input'), '10.50', 'the typed price survives the round trip, ready for the re-ring');
    // The pick is proven by BEHAVIOUR, not by an attribute: the re-ring opens the charge.
    await driver.click('btn-till-ring-up', {timeoutMs: 4_000});
    await driver.findByTestID('till-qr', {timeoutMs: 15_000});
    assertIncludes(await driver.bodyText(), '10.50 CHF', 'the VCHF ring-up reads the franc price exactly as flow 114\'s');
    await driver.screenshot('205-till-ring-up-after-repick');
    console.log('[205-till-settlement-predicate] ✓ re-picked VCHF rings up exactly as the single-asset till did');

    console.log(`[205-till-settlement-predicate] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('205-till-settlement-predicate RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
