// Flow 55 — Balances asset selection binds the header (DEMO → ckBTC → SOL).
//
// Characterizes an EXISTING, zero-covered behavior: tapping a currency row in the accounts route
// SELECTS it as the wallet's one `selectedAssetId` (Phase 3 — 2026-08-12 unified asset selection
// rewrite), and the wallet header follows — both the balance amount (read from the per-asset
// `balances` map) AND the header asset label (`activeAssetName` = selectedAsset.symbol; the
// former active-rail chip was dropped 2026-08-18, this label is the active-asset signal). The
// whole-row select Pressable carries `asset-<key>-select`, so the flow drives it directly.
//
// Onboarding seeds DEMO (selectedAssetId reconciles to ic:0 → header ∂100.00, label 'DEMO
// balance'). The flow selects ckBTC (testKey 'ckbtc' → asset-ckbtc-select) — handleSelect('ic:1')
// sets selectedAssetId, the header reads balances['ic:1'] = "0 BTC" (unfunded), and the label
// switches to the catalog backing_symbol 'BTC balance'. Then it selects SOL (testKey 'sol' →
// asset-sol-select) — handleSelect('solana:SOL'); the SOL RPC is disabled in e2e so
// solState.status='unavailable' and the header renders "—"; the label reads 'SOL balance'.
//
// Selector contract: `balance` (the header chip → the accounts route), `asset-ckbtc-select` (the
// BTC row whole-row select Pressable), `asset-sol-select` (the SOL row's select Pressable),
// `active-asset-label` (the header asset label).
import { setup, assertEq, assertIncludes, onboardWallet, openBalances, selectCurrency } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '55',
  name: 'balances-select-asset',
  journey: 'system',
  covers: ['asset-select', 'header-balance-binding', 'active-asset-label'],
  verifies: 'The currency-first header chip binds to the MAIN currency: it headlines Balance CHF on a fresh wallet (never the practice rail), a ckBTC currency-row tap re-points it to Balance BTC, a SOL tap to Balance SOL with the RPC-unavailable figure, and the accounts route\'s currency rows carry their own summed figures (0 BTC unfunded).',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[55-balances-select-asset] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Onboard → wallet (DEMO seeded: header ∂100.00, label 'DEMO balance').
    console.log('[55-balances-select-asset] onboarding…');
    await onboardWallet(driver, 'e2e-select');

    // 2. Baseline (currency-first chip): the header chip headlines the MAIN currency — the
    //    wallet is "in" CHF — regardless of the practice ∂100 seeded onboarding. The per-asset
    //    'DEMO balance' / 'BTC balance' header labels are gone with the per-rail header; the
    //    per-asset name+balance binding now lives on the accounts route's currency rows and
    //    inside the Pay/Receive engines.
    let label = await driver.readText('active-asset-label');
    assertEq(label, 'Balance CHF', 'baseline chip: the MAIN currency (CHF), never the practice rail');

    // 3. Tap the ckBTC CURRENCY row — the spec's set-main gesture. The chip follows main.
    console.log('[55-balances-select-asset] selecting ckBTC (currency row)…');
    await openBalances(driver);
    await selectCurrency(driver, 'ckbtc');

    // 4. The chip now headlines BTC — the currency the wallet is "in" (fork #4: currency unit).
    label = await driver.readText('active-asset-label');
    assertEq(label, 'Balance BTC', 'chip after the ckBTC row tap (main follows the gesture)');

    // 5. The BTC currency row on the accounts route carries the summed balance in currency
    //    unit — ckBTC is unfunded, so the row reads "0 BTC" (its only rail's token unit).
    await openBalances(driver);
    const btcRow = await driver.readText('accounts-currency-BTC');
    assertIncludes(btcRow, '0 BTC', 'the BTC currency row shows the unfunded 0 (its rail\'s token unit)');
    console.log('[55-balances-select-asset] ✓ chip bound to main; BTC row shows its unfunded 0 BTC');

    // 6. Select SOL via its currency row — the working rail follows the main.
    console.log('[55-balances-select-asset] selecting SOL…');
    await selectCurrency(driver, 'sol');

    // 7. The chip headlines SOL.
    label = await driver.readText('active-asset-label');
    assertEq(label, 'Balance SOL', 'chip after the SOL row tap (main follows the gesture)');

    // 8. Secondary: the header figure is SOL — RPC disabled in e2e so solState is unavailable → "—".
    const solHeader = await driver.readText('balance');
    assertIncludes(solHeader, '—', 'header figure after selecting SOL (RPC disabled → "—")');
    console.log('[55-balances-select-asset] ✓ chip bound to SOL (figure "—")');

    await driver.screenshot('55-balances-select-asset');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[55-balances-select-asset] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/55-balances-select-asset.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[55-balances-select-asset] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
