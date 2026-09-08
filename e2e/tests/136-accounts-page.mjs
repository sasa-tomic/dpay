// Flow 136 — the Home tab's inline ACCOUNTS list carries the retired Balances sheet's contract
// (O4 S3): every rail stays its own row, the home-currency group is MARKED and never summed, and
// the whole-row select + testnet chrome all live on the balance-first surface now.
//
// The sheet-era invariants this flow re-pins on the Home tab:
//   * zero-balance rows REMAIN VISIBLE with honest "0.00 VCHF" / "0 ICP" amounts (nothing is
//     pruned behind a balance);
//   * the MAIN badge sits on the PREFERRED rail only (home=CHF → VCHF), and under a two-rail
//     currency (home=USD) the sibling wears a badge NAMING its rail — never a second MAIN;
//   * NO group total exists anywhere (the founder's honesty rule: same-currency rails on
//     different chains must never read as one balance);
//   * the whole-row select switches the headline to the selected asset's OWN unit and PERSISTS
//     across surface switches (the stored selection + reconcileSelectedAsset contract);
//   * the testnet toggle is reachable from Home (flow 54 owns its full reveal/hide walk).
//
// Selector contract: `tab-home` (bottom tab → the accounts list), `home-headline-label` /
// `home-headline-amount` (the headline), `asset-vchf-select` (row whole-row select),
// `asset-vchf-main` / `asset-ckusdc-main` (MAIN badge), `asset-sol-usdc-rail` (sibling badge),
// `btn-settings` + `btn-currency-USD` (home-currency switch), `btn-toggle-testnet`.
import {
  setup, assert, assertIncludes, onboardWallet, openBalances, waitForEnabled,
} from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '136',
  name: 'home-accounts',
  journey: 'system',
  covers: ['home-tab', 'balances', 'group-model', 'rail-health'],
  verifies: 'The Home tab accounts list keeps the Balances-sheet contract inline: zero-balance rows visible, MAIN on the preferred rail only with the sibling rail named (never a second MAIN, never a group total), whole-row select switches the headline to the asset own unit and persists, and the testnet toggle is reachable.',
  timeoutMs: 30_000,
};

export async function run() {
  const start = Date.now();
  console.log('[136-home-accounts] setup (relay + web + browser, solStub for the USDC·Solana rail)…');
  const env = await setup({solStub: true});
  try {
    const { driver } = env;

    // 1. Onboard (home=CHF — the chooser default) and land the Home tab.
    console.log('[136-home-accounts] onboarding…');
    await onboardWallet(driver, 'e2e-home-accounts');
    await openBalances(driver);
    await driver.findByTestID('home-accounts', { timeoutMs: 5_000 });

    // 2. Zero-balance rows remain visible with honest own-unit amounts (cold-start wallet state).
    const vchfRow = await driver.readText('asset-vchf');
    assertIncludes(vchfRow, '0.00 VCHF', 'zero-balance VCHF row stays visible with an honest amount');
    assertIncludes(await driver.readText('asset-icp'), '0 ICP', 'zero-balance ICP row stays visible');
    assertIncludes(await driver.readText('asset-demo'), '∂100.00', 'the funded DEMO row shows its balance');
    console.log('[136-home-accounts] ✓ zero-balance rows visible (VCHF/ICP honest, DEMO funded)');

    // 3. home=CHF: MAIN on the PREFERRED rail only; no rail badges anywhere; no group total.
    assert(await driver.isPresent('asset-vchf-main'), 'MAIN badge on the preferred CHF rail (VCHF)');
    assert(!(await driver.isPresent('asset-sol-usdc-main')), 'no MAIN on a non-home-currency rail');
    for (const key of ['asset-ckusdc', 'asset-sol-usdc', 'asset-icp', 'asset-demo']) {
      assert(!(await driver.isPresent(`${key}-rail`)), `no rail badge on ${key} under single-rail home=CHF`);
    }
    assert(!(await driver.isPresent('balances-group-total')), 'no group total anywhere on the surface');
    console.log('[136-home-accounts] ✓ home=CHF: MAIN on VCHF only, no rail badges, nothing summed');

    // 4. Whole-row select switches the headline to the asset's OWN unit (currency named, token
    //    never converted — the O1 eyebrow contract) via the aria-selected row state.
    await driver.click('asset-vchf-select', { timeoutMs: 5_000 });
    await driver.waitForText('0.00 VCHF', { timeoutMs: 5_000 });
    const label = await driver.readText('home-headline-label');
    assertIncludes(label, 'Swiss francs', 'headline names the home currency after the rail select');
    assertIncludes(label, 'Main', 'the preferred rail reads "Main" in the eyebrow');
    assertIncludes(await driver.readText('home-headline-amount'), '0.00 VCHF', 'headline amount stays in the token unit');
    console.log('[136-home-accounts] ✓ row select switched the headline (Swiss francs · Main / 0.00 VCHF)');

    // 5. The selection persists across surface switches (stored selection + reconcile).
    await driver.click('tab-pay', { timeoutMs: 5_000 });
    await driver.click('tab-home', { timeoutMs: 5_000 });
    assertIncludes(await driver.readText('home-headline-label'), 'Swiss francs', 'selection persists across tab switches');
    console.log('[136-home-accounts] ✓ selection persists across surface switches');

    // 6. home=USD: the two-rail group renders as two named rows — MAIN on ckUSDC only, the
    //    Solana sibling BADGED with its rail line, and still no group total.
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.click('btn-currency-USD', { timeoutMs: 5_000 });
    await driver.click('btn-settings-close', { timeoutMs: 5_000 });
    await openBalances(driver);
    assert(await driver.isPresent('asset-ckusdc-main'), 'MAIN moves to the preferred USD rail (ckUSDC)');
    assert(!(await driver.isPresent('asset-sol-usdc-main')), 'the sibling never wears a second MAIN');
    const railBadge = await driver.readText('asset-sol-usdc-rail');
    assertIncludes(railBadge, 'USDC · Solana', 'the sibling badge NAMES its rail (ledger token · settlement chain)');
    assert(!(await driver.isPresent('balances-group-total')), 'no USD group total — two named rows, never one number');
    console.log('[136-home-accounts] ✓ home=USD: MAIN on ckUSDC, sibling named, nothing summed');

    // 7. The testnet toggle is reachable from the Home accounts list (flow 54 owns the full walk).
    await waitForEnabled(driver, 'btn-toggle-testnet', { timeoutMs: 5_000 });
    await driver.click('btn-toggle-testnet', { timeoutMs: 5_000 });
    await driver.findByTestID('asset-ckbtc-testnet', { timeoutMs: 5_000 });
    await driver.click('btn-toggle-testnet', { timeoutMs: 5_000 });
    await driver.waitGone('asset-ckbtc-testnet', { timeoutMs: 5_000 });
    console.log('[136-home-accounts] ✓ testnet toggle reachable (reveals + hides the testnet rows)');

    await driver.screenshot('136-home-accounts');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[136-home-accounts] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/136-home-accounts.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[136-home-accounts] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
