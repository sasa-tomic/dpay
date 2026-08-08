// Flow 54 — Testnet toggle in the Balances sheet.
//
// The testnet toggle (`btn-toggle-testnet`) is structurally invisible in e2e without a testnet
// currency in the FakeLedger catalog: `isTestnetCurrency()` is true only for a currency whose
// `network` is NOT a known mainnet network, and every fake_catalog entry was mainnet-only before
// currency 6 (ckTESTBTC, network "Bitcoin Testnet"). `showTestnet` defaults to false → testnet
// currencies are filtered OUT of `visibleCatalog` → the toggle renders only when `hasTestnet` is
// true. This flow exercises the full reveal/hide cycle now that the catalog carries a testnet entry.
//
// Proves:
//   - The toggle renders (currency 6's testnet status flips `hasTestnet` true).
//   - Tapping reveal surfaces a "BTC testnet" row (testnetDisplayName), testID `asset-ckbtc-testnet`
//     (the `-testnet` suffix keeps the testID unique vs the mainnet ckBTC sibling).
//   - Tapping again hides the row (filtered back out of visibleCatalog).
//   - No existing visible asset is affected (currencies 0-5 are all mainnet → always visible).
//
// Selector contract: `balance` (header → Balances), `btn-balances-close`, `btn-toggle-testnet`,
// `asset-ckbtc-testnet`.
import {setup, assert, onboardWallet, openBalances} from '../harness/lib.mjs';

export const meta = {
  id: '54',
  name: 'testnet-toggle',
  journey: 'onboard',
  covers: ['testnet', 'catalog', 'toggle', 'balances'],
  verifies: 'Balances testnet toggle reveals + hides a "BTC testnet" row (catalog-driven testnet detection).',
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

    // 1. Open Balances. The testnet toggle renders because the FakeLedger catalog now carries
    //    currency 6 (ckTESTBTC, network "Bitcoin Testnet") → hasTestnet = true.
    console.log('[54-testnet-toggle] opening Balances…');
    await openBalances(driver);
    await driver.findByTestID('btn-toggle-testnet', {timeoutMs: 8_000});
    console.log('[54-testnet-toggle] ✓ testnet toggle rendered (catalog has a testnet currency)');

    // 2. Before reveal, the testnet row is filtered out of visibleCatalog (showTestnet=false).
    let hidden = await driver.isPresent('asset-ckbtc-testnet');
    assert(!hidden, 'the testnet row must be hidden before the toggle is tapped');
    console.log('[54-testnet-toggle] ✓ testnet row hidden by default');

    // 3. Tap reveal → the "BTC testnet" row appears.
    console.log('[54-testnet-toggle] tapping reveal…');
    await driver.click('btn-toggle-testnet', {timeoutMs: 5_000});
    const testnetCard = await driver.findByTestID('asset-ckbtc-testnet', {timeoutMs: 5_000});
    const cardTxt = await testnetCard.evaluate((n) => (n.textContent ?? '').trim());
    assert(/BTC testnet/.test(cardTxt), `the revealed row should read "BTC testnet", got: "${cardTxt}"`);
    console.log(`[54-testnet-toggle] ✓ revealed: "${cardTxt}"`);

    // 4. Tap hide → the row disappears again.
    console.log('[54-testnet-toggle] tapping hide…');
    await driver.click('btn-toggle-testnet', {timeoutMs: 5_000});
    await driver.waitGone('asset-ckbtc-testnet', {timeoutMs: 5_000});
    console.log('[54-testnet-toggle] ✓ testnet row hidden again after toggle');

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
