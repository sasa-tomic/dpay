// Flow 55 — Balances asset selection binds the header (DEMO → ckBTC → SOL).
//
// Characterizes an EXISTING, zero-covered behavior: tapping a currency row in the Balances hub
// SELECTS it as the wallet's one `selectedAssetId` (Phase 3 — 2026-08-12 unified asset selection
// rewrite), and the wallet header follows — both the balance amount (read from the per-asset
// `balances` map) AND the active-rail chip (`activeAssetName` = selectedAsset.symbol). The
// whole-row select Pressable carries `asset-<key>-select`, so the flow drives it directly.
//
// Onboarding seeds DEMO (selectedAssetId reconciles to ic:0 → header ∂100.00, chip 'DEMO'). The
// flow selects ckBTC (testKey 'ckbtc' → asset-ckbtc-select) — handleSelect('ic:1') sets
// selectedAssetId, the header reads balances['ic:1'] = "0 BTC" (unfunded), and the chip switches to
// the catalog backing_symbol 'BTC'. Then it selects SOL (testKey 'sol' → asset-sol-select) —
// handleSelect('solana:SOL'); the SOL RPC is disabled in e2e so solState.status='unavailable' and
// the header renders "—"; the chip reads 'SOL'. The chip text (DEMO → BTC → SOL) is the primary
// coverage target; the header balance text is the secondary.
//
// Selector contract: `balance` (header → Balances), `asset-ckbtc-select` (the BTC row whole-row
// select Pressable), `asset-sol-select` (the SOL row's select Pressable), `active-rail-chip` (the
// header chip), `btn-balances-close` (sheet-open gate).
import { setup, assertEq, assertIncludes, onboardWallet, openBalances, selectCurrency } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '55',
  name: 'balances-select-asset',
  journey: 'system',
  covers: ['asset-select', 'header-balance-binding', 'active-rail-chip'],
  verifies: 'Selecting an asset in Balances binds the header: chip DEMO→ckBTC→SOL and the balance text follows the active-rail branch.',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[55-balances-select-asset] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Onboard → wallet (DEMO seeded: header ∂100.00, chip 'DEMO').
    console.log('[55-balances-select-asset] onboarding…');
    await onboardWallet(driver, 'e2e-select');

    // 2. Baseline: the active-rail chip reads 'DEMO' (selectedAssetId reconciles to ic:0).
    let chip = await driver.readText('active-rail-chip');
    assertEq(chip, 'DEMO', 'baseline active-rail-chip (DEMO)');

    // 3. Select ckBTC (testKey 'ckbtc') — tap its whole-row select in the Balances hub.
    //    handleSelect('ic:1') sets selectedAssetId + closes the sheet; the header then reads the
    //    unfunded balances['ic:1'].
    console.log('[55-balances-select-asset] selecting ckBTC…');
    await openBalances(driver);
    await selectCurrency(driver, 'ckbtc');

    // 4. Primary: the chip switches to the backing_symbol 'BTC' (selectedAsset.symbol).
    chip = await driver.readText('active-rail-chip');
    assertEq(chip, 'BTC', 'active-rail-chip after selecting ckBTC (uses backing_symbol, not wrapper_name)');

    // 5. Secondary: the header balance text follows — ckBTC is unfunded, so balances['ic:1']
    //    renders fmtCurrencyAmount(...'0') = "0 BTC" (fmtAsset's zero special-case).
    const btcHeader = await driver.readText('balance');
    assertIncludes(btcHeader, '0 BTC', 'header balance after selecting ckBTC (unfunded → "0 BTC")');
    console.log('[55-balances-select-asset] ✓ header bound to ckBTC (chip "BTC", balance "0 BTC")');

    // 6. Select SOL — the SOL row's select Pressable carries `asset-sol-select`. handleSelect
    //    ('solana:SOL') sets selectedAssetId + closes the sheet; the header then reads SOL.
    console.log('[55-balances-select-asset] selecting SOL…');
    await openBalances(driver);
    await driver.click('asset-sol-select', { timeoutMs: 5_000 });
    await driver.waitGone('btn-balances-close', { timeoutMs: 5_000 });

    // 7. Primary: the chip switches to 'SOL' (selectedAsset.symbol).
    chip = await driver.readText('active-rail-chip');
    assertEq(chip, 'SOL', 'active-rail-chip after selecting SOL');

    // 8. Secondary: the header balance is SOL — RPC disabled in e2e so solState is unavailable → "—".
    const solHeader = await driver.readText('balance');
    assertIncludes(solHeader, '—', 'header balance after selecting SOL (RPC disabled → "—")');
    console.log('[55-balances-select-asset] ✓ header bound to SOL (chip "SOL", balance "—")');

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
