// Flow 130 — the EUR group in the accounts route: ONE row, and the health note renders NOWHERE
// (the 2026-09-19 VEUR retirement collapsed the former dual-rail group).
//
// Flow 129 pinned the chooser's single-rail collapse; this flow pins the route where the money
// lives:
//   * home=EUR renders exactly ONE row — EURC, carrying MAIN. The founder's rule ("two rails are
//     two rows, never one summed balance") retires with the second rail: one rail is one row, and
//     no trace of VEUR may survive as a row, a badge, or a sum.
//   * The rail-health note renders on NO bundled row anymore. VEUR was the only THIN rail in the
//     catalog; with it gone the warn-tone footer (`RailLiquidityNote`) has nothing to say
//     anywhere: not on EURC (deep — a caution icon on "circulates widely" would contradict
//     itself, and warn tone gates to thin anyway), not on untiered rows (VCHF, SOL, USDC say
//     nothing they cannot back).
//   * No badge colours change and no group total appears — the note is text, not chrome.
import {setup, assert, assertIncludes, onboardWallet, openBalances, waitForWallet} from '../harness/lib.mjs';

export const meta = {
  id: '130',
  name: 'eur-single-rail-balances',
  journey: 'onboard',
  covers: ['home-currency', 'balances', 'eur', 'eurc', 'vchf', 'group-model', 'rail-health'],
  verifies: 'home=EUR in the accounts route renders ONE row — EURC with MAIN, no VEUR row or badge anywhere (retired 2026-09-19) — and the thin note ("Thin liquidity") renders on NO bundled row: absent on EURC/VCHF/SOL alike, with no group sum.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[130-eur-single-rail-balances] setup…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    // --- 1. onboard seeded, pin home=EUR, land on its one rail ----------------------------------
    console.log('[130-eur-single-rail-balances] onboarding, pinning home=EUR…');
    await onboardWallet(driver, 'e2e-eur-balances');
    await driver.click('btn-settings', {timeoutMs: 5_000});
    await driver.click('btn-currency-EUR', {timeoutMs: 5_000});
    await driver.click('btn-settings-close', {timeoutMs: 5_000});
    await waitForWallet(driver, {timeoutMs: 8_000});

    // --- 2. the EUR currency row: ONE row (fork #2), Main badge, rail label names EURC --------
    await openBalances(driver);
    assert(await driver.isPresent('accounts-currency-EUR'),
      'the EUR currency row exists (the currency list\'s one-row-per-currency grammar)');
    assert(await driver.findByTestID('currency-EUR-main', {timeoutMs: 4_000}) != null,
      'EUR carries the Main badge — it is the wallet\'s one currency');
    assert(!(await driver.isPresent('asset-sol-eurc')),
      'the per-rail EURC row is GONE — the currency row replaces it');
    assert(!(await driver.isPresent('asset-veur')) && !(await driver.isPresent('asset-veur-main')),
      'the retired VEUR rail renders NO row or badge (gone since 2026-09-19)');
    const eurLabel = await driver.readText('accounts-currency-EUR');
    assertIncludes(eurLabel, 'EURC · Solana', 'the row\'s rail label names the EURC@Solana rail');
    console.log('[130-eur-single-rail-balances] ✓ EUR: one currency row (Main + EURC rail label), no VEUR trace');

    // --- 3. the health note: on NO row -----------------------------------------------------------
    const eurcRow = await driver.readText('accounts-currency-EUR');
    assert(!eurcRow.includes('Thin liquidity') && !eurcRow.includes('Circulates widely'),
      `the deep rail carries NO health line (warn tone gates to thin, and VEUR — the only thin row — is gone). Got: ${JSON.stringify(eurcRow)}`);
    const vchfRow = await driver.readText('accounts-currency-CHF');
    assert(!vchfRow.includes('Thin liquidity') && !vchfRow.includes('Circulates widely'),
      `an untiered row (CHF) states nothing — no tier, no copy. Got: ${JSON.stringify(vchfRow)}`);
    const solRow = await driver.readText('accounts-currency-SOL');
    assert(!solRow.includes('Thin liquidity') && !solRow.includes('Circulates widely'),
      `native SOL states nothing either. Got: ${JSON.stringify(solRow)}`);
    assert(!(await driver.isPresent('rail-liquidity-note')),
      'the rail-health footer renders on NO row — VEUR was the only thin rail in the catalog');
    await driver.screenshot('130-eur-balance-rails');

    // --- 4. the row's figure is the summed currency unit; no separate total -----------------------
    const sheet = await driver.bodyText();
    assert(!/\bgroup total\b/i.test(sheet),
      `no group-total element may exist beyond the row\'s own summed figure. Got: ${JSON.stringify(sheet.slice(0, 400))}`);
    console.log('[130-eur-single-rail-balances] ✓ health note renders nowhere; the row figure IS the sum');

    console.log(`[130-eur-single-rail-balances] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[130-eur-single-rail-balances] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
