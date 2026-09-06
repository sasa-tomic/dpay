// Flow 55 — Balances asset selection binds the header (DEMO → ckBTC → SOL).
//
// Characterizes an EXISTING, zero-covered behavior: tapping a currency row in the Balances hub
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
// Selector contract: `balance` (header → Balances), `asset-ckbtc-select` (the BTC row whole-row
// select Pressable), `asset-sol-select` (the SOL row's select Pressable), `active-asset-label`
// (the header asset label), `tab-home` (bottom tab → the accounts list).
import { setup, assertEq, assertIncludes, onboardWallet, openBalances, selectCurrency } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '55',
  name: 'balances-select-asset',
  journey: 'system',
  covers: ['asset-select', 'header-balance-binding', 'active-asset-label'],
  verifies: 'Selecting an asset in Balances binds the header: label DEMO→ckBTC→SOL and the balance text follows the active-rail branch.',
  timeoutMs: 20000,
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

    // 2. Baseline: the header asset label reads 'DEMO balance' (selectedAssetId reconciles to ic:0).
    let label = await driver.readText('active-asset-label');
    assertEq(label, 'DEMO balance', 'baseline active-asset-label (DEMO)');

    // 3. Select ckBTC (testKey 'ckbtc') — tap its whole-row select in the Balances hub.
    //    handleSelect('ic:1') sets selectedAssetId + closes the sheet; the header then reads the
    //    unfunded balances['ic:1'].
    console.log('[55-balances-select-asset] selecting ckBTC…');
    await openBalances(driver);
    await selectCurrency(driver, 'ckbtc');

    // 4. Primary: the label switches to the backing_symbol 'BTC balance' (selectedAsset.symbol).
    label = await driver.readText('active-asset-label');
    assertEq(label, 'BTC balance', 'active-asset-label after selecting ckBTC (uses backing_symbol, not wrapper_name)');

    // 5. Secondary: the header balance text follows — ckBTC is unfunded, so balances['ic:1']
    //    renders fmtCurrencyAmount(...'0') = "0 BTC" (fmtAsset's zero special-case).
    const btcHeader = await driver.readText('balance');
    assertIncludes(btcHeader, '0 BTC', 'header balance after selecting ckBTC (unfunded → "0 BTC")');
    console.log('[55-balances-select-asset] ✓ header bound to ckBTC (label "BTC balance", balance "0 BTC")');

    // 6. Select SOL — the SOL row's select Pressable carries `asset-sol-select`. handleSelect
    //    ('solana:SOL') sets selectedAssetId + closes the sheet; the header then reads SOL.
    console.log('[55-balances-select-asset] selecting SOL…');
    await openBalances(driver);
    await driver.click('asset-sol-select', { timeoutMs: 5_000 });

    // 7. Primary: the label switches to 'SOL balance' (selectedAsset.symbol).
    label = await driver.readText('active-asset-label');
    assertEq(label, 'SOL balance', 'active-asset-label after selecting SOL');

    // 8. Secondary: the header balance is SOL — RPC disabled in e2e so solState is unavailable → "—".
    const solHeader = await driver.readText('balance');
    assertIncludes(solHeader, '—', 'header balance after selecting SOL (RPC disabled → "—")');
    console.log('[55-balances-select-asset] ✓ header bound to SOL (label "SOL balance", balance "—")');

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
