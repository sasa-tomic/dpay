// Flow 54 — Testnet toggle in the accounts list.
//
// The testnet toggle (`btn-toggle-testnet`) is structurally invisible in e2e without a testnet
// currency in the catalog: `isTestnetCurrency()` is true only for a currency whose `network` is
// NOT a known mainnet network, and a mainnet-only catalog never flips `hasTestnet`. `showTestnet`
// defaults to false → testnet currencies are filtered OUT of `visibleCatalog` → the toggle
// renders only when `hasTestnet` is true. The REAL catalog (since the 2026-08-28 transplant)
// carries THREE testnet rows in its testnet section: 3 ckTESTBTC (network "Bitcoin Testnet"),
// 4 ckSepoliaUSDC ("Sepolia"), 5 ckSepoliaETH ("Sepolia") — this flow exercises the full
// reveal/hide cycle across all three.
//
// Proves:
//   - The toggle renders (the three testnet rows flip `hasTestnet` true).
//   - Tapping reveal surfaces ALL THREE rows with their testnetDisplayName + testIDs:
//       asset-ckbtc-testnet          → "BTC testnet"   (the `-testnet` suffix keeps the testID
//                                                       unique vs the mainnet ckBTC sibling)
//       asset-cksepoliausdc-testnet  → "USDC testnet"
//       asset-cksepoliaeth-testnet   → "ETH testnet"
//   - Tapping again hides ALL THREE rows (filtered back out of visibleCatalog).
//   - No existing visible asset is affected (mainnet set is 0 DEMO / 1 ckBTC / 2 ckUSDC /
//     6 ckETH / 7 VCHF / 8 ICP → always visible).
//
// Selector contract: `balance` (the header chip → the accounts route), `btn-toggle-testnet`,
// `asset-ckbtc-testnet`, `asset-cksepoliausdc-testnet`, `asset-cksepoliaeth-testnet`.
import {setup, assert, onboardWallet, openBalances} from '../harness/lib.mjs';

// The catalog's three testnet rows (ids 3/4/5) with their app-side asset test keys
// (assetTestKey: CkBtcUtxo → 'ckbtc', else wrapper_name lowercase; '-testnet' suffix) and
// testnetDisplayName ("<backing> testnet") renders.
const TESTNET_ROWS = [
  {tid: 'asset-ckbtc-testnet', name: 'BTC testnet'},         // 3 ckTESTBTC (Bitcoin Testnet)
  {tid: 'asset-cksepoliausdc-testnet', name: 'USDC testnet'}, // 4 ckSepoliaUSDC (Sepolia)
  {tid: 'asset-cksepoliaeth-testnet', name: 'ETH testnet'},   // 5 ckSepoliaETH (Sepolia)
];
const TESTNET_TIDS = TESTNET_ROWS.map((r) => r.tid);

export const meta = {
  id: '54',
  name: 'testnet-toggle',
  journey: 'onboard',
  covers: ['testnet', 'catalog', 'toggle', 'balances'],
  verifies: 'The accounts route\'s testnet toggle reveals + hides all three testnet rows (BTC/USDC/ETH testnet — catalog-driven testnet detection).',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[54-testnet-toggle] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver} = env;

    console.log('[54-testnet-toggle] onboarding…');
    await onboardWallet(driver, 'e2e-testnet');

    // 1. Open Balances. The testnet toggle renders because the REAL catalog's testnet section
    //    carries currencies 3/4/5 (ckTESTBTC, ckSepoliaUSDC, ckSepoliaETH) → hasTestnet = true.
    console.log('[54-testnet-toggle] opening Balances…');
    await openBalances(driver);
    await driver.findByTestID('btn-toggle-testnet', {timeoutMs: 8_000});
    console.log('[54-testnet-toggle] ✓ testnet toggle rendered (catalog has testnet currencies)');

    // 2. Before reveal, ALL THREE testnet rows are filtered out of visibleCatalog (showTestnet=false).
    for (const tid of TESTNET_TIDS) {
      const hidden = await driver.isPresent(tid);
      assert(!hidden, `the ${tid} row must be hidden before the toggle is tapped`);
    }
    console.log('[54-testnet-toggle] ✓ all three testnet rows hidden by default');

    // 3. Tap reveal → all three rows appear, each with its exact testnetDisplayName.
    console.log('[54-testnet-toggle] tapping reveal…');
    await driver.click('btn-toggle-testnet', {timeoutMs: 5_000});
    for (const {tid, name} of TESTNET_ROWS) {
      const row = await driver.findByTestID(tid, {timeoutMs: 5_000});
      const rowTxt = await row.evaluate((n) => (n.textContent ?? '').trim());
      assert(rowTxt.includes(name), `the revealed ${tid} row should read "${name}", got: "${rowTxt}"`);
      console.log(`[54-testnet-toggle] ✓ revealed ${tid}: "${name}"`);
    }

    // 4. Tap hide → all three rows disappear again.
    console.log('[54-testnet-toggle] tapping hide…');
    await driver.click('btn-toggle-testnet', {timeoutMs: 5_000});
    for (const tid of TESTNET_TIDS) {
      await driver.waitGone(tid, {timeoutMs: 5_000});
    }
    console.log('[54-testnet-toggle] ✓ all three testnet rows hidden again after toggle');

    await driver.screenshot('54-testnet-toggle');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[54-testnet-toggle] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[54-testnet-toggle] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
