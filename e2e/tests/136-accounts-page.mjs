// Flow 136 — the ACCOUNTS page carries the retired Balances sheet's contract, wherever it lives.
//
// The list has moved twice: sheet → inline on the Home tab (O4 S3) → its own route (2026-09-08,
// because it was ~80% of the Home surface). Every row testID survived both moves untouched; only
// the container's name changed, and this flow is the contract that outlives the moves:
//   * zero-balance rows REMAIN VISIBLE with honest "0.00 VCHF" / "0 ICP" amounts (nothing is
//     pruned behind a balance — CLAUDE.md's asset-first rule);
//   * the MAIN badge sits on the PREFERRED rail only (home=CHF → VCHF), and under a two-rail
//     currency (home=USD) the sibling wears a badge NAMING its rail — never a second MAIN;
//   * NO group total exists anywhere (the founder's honesty rule: same-currency rails on
//     different chains must never read as one balance);
//   * ORDER (X22): the home currency's rail leads, and the PRACTICE rail is last, under a divider
//     that says in a whole sentence what it is — it used to sit first carrying ∂100.00, the
//     largest number on screen, above BTC and USDC;
//   * the whole-row select switches the HEADER chip to the selected asset's OWN unit and PERSISTS
//     across surface switches — while the Home headline stays on the home currency (X4);
//   * the testnet toggle is reachable here (flow 54 owns its full reveal/hide walk).
//
// Selector contract: `balance` (header chip → the accounts route, via `openBalances`),
// `accounts-list` (the container), `accounts-practice-note` (the practice divider),
// `asset-vchf-select` (row whole-row select), `asset-vchf-main` / `asset-ckusdc-main` (MAIN badge),
// `asset-sol-usdc-rail` (sibling badge), `btn-settings` + `btn-currency-USD` (home-currency
// switch), `btn-toggle-testnet`.
import {
  setup, assert, assertIncludes, onboardWallet, openBalances, waitForEnabled,
} from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '136',
  name: 'accounts-page',
  journey: 'system',
  covers: ['accounts-route', 'balances', 'group-model', 'rail-health', 'account-order'],
  verifies: 'The accounts page keeps the Balances-sheet contract: zero-balance rows visible, MAIN on the preferred rail only with the sibling rail named (never a second MAIN, never a group total), the practice rail LAST under its own divider, whole-row select switching the header chip and persisting while the Home headline stays on the home currency, and the testnet toggle reachable.',
  timeoutMs: 90_000,
};

export async function run() {
  const start = Date.now();
  console.log('[136-accounts-page] setup (relay + web + browser, solStub for the USDC·Solana rail)…');
  const env = await setup({solStub: true});
  try {
    const { driver } = env;

    // 1. Onboard (home=CHF — the chooser default) and open the accounts route.
    console.log('[136-accounts-page] onboarding…');
    await onboardWallet(driver, 'e2e-accounts-page');
    await openBalances(driver);
    await driver.findByTestID('accounts-list', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('home-accounts')), 'the retired container name must be gone — the list is a route now');

    // 2. Zero-balance rows remain visible with honest own-unit amounts (cold-start wallet state).
    const vchfRow = await driver.readText('asset-vchf');
    assertIncludes(vchfRow, '0.00 VCHF', 'zero-balance VCHF row stays visible with an honest amount');
    assertIncludes(await driver.readText('asset-icp'), '0 ICP', 'zero-balance ICP row stays visible');
    assertIncludes(await driver.readText('asset-demo'), '∂100.00', 'the funded practice row shows its balance');
    console.log('[136-accounts-page] ✓ zero-balance rows visible (VCHF/ICP honest, practice funded)');

    // 3. X22 — the order. The home currency leads; the practice rail is last, under its divider.
    // The row CONTAINER is the only asset-* element carrying aria-selected (CurrencyRow's card
    // variant) — the badges/selects/notes share the prefix, so a prefix match alone is not a row.
    const order = await driver.eval(() => [...document.querySelectorAll('[data-testid^="asset-"][aria-selected]')]
      .map(el => el.getAttribute('data-testid')));
    assert(order[0] === 'asset-vchf', `the home currency's rail leads the list. Got: ${JSON.stringify(order)}`);
    assert(order[order.length - 1] === 'asset-demo', `the practice rail is LAST, never first with the biggest number. Got: ${JSON.stringify(order)}`);
    const note = await driver.readText('accounts-practice-note');
    assertIncludes(note.toLowerCase(), 'practice', 'the divider names the practice money in a whole sentence');
    assertIncludes(note.toLowerCase(), 'no shop', 'the divider says what practice money cannot do');
    console.log(`[136-accounts-page] ✓ order: ${order[0]} first, ${order[order.length - 1]} last under its divider`);

    // 4. home=CHF: MAIN on the PREFERRED rail only; no rail badges anywhere; no group total.
    assert(await driver.isPresent('asset-vchf-main'), 'MAIN badge on the preferred CHF rail (VCHF)');
    assert(!(await driver.isPresent('asset-sol-usdc-main')), 'no MAIN on a non-home-currency rail');
    for (const key of ['asset-ckusdc', 'asset-sol-usdc', 'asset-icp', 'asset-demo']) {
      assert(!(await driver.isPresent(`${key}-rail`)), `no rail badge on ${key} under single-rail home=CHF`);
    }
    assert(!(await driver.isPresent('balances-group-total')), 'no group total anywhere on the surface');
    console.log('[136-accounts-page] ✓ home=CHF: MAIN on VCHF only, no rail badges, nothing summed');

    // 5. Whole-row select switches the HEADER chip to the asset's OWN unit (the O1 eyebrow
    //    contract) via the aria-selected row state — and leaves the Home headline alone (X4).
    await driver.click('asset-vchf-select', { timeoutMs: 5_000 });
    await driver.waitForText('0.00 VCHF', { timeoutMs: 5_000 });
    const label = await driver.readText('active-asset-label');
    assertIncludes(label, 'Swiss francs', 'the header chip names the home currency after the rail select');
    assertIncludes(label, 'Main', 'the preferred rail reads "Main" in the eyebrow');
    console.log('[136-accounts-page] ✓ row select switched the header chip (Swiss francs · Main)');

    // 6. The selection persists across surface switches (stored selection + reconcile).
    await driver.click('tab-pay', { timeoutMs: 5_000 });
    await openBalances(driver);
    const persisted = await driver.eval(() => document.querySelector('[data-testid="asset-vchf"]')?.getAttribute('aria-selected'));
    assert(persisted === 'true', `the selection persists across surface switches (aria-selected=${persisted})`);
    console.log('[136-accounts-page] ✓ selection persists across surface switches');

    // 7. home=USD: the two-rail group renders as two named rows — MAIN on ckUSDC only, the
    //    Solana sibling BADGED with its rail line, and still no group total.
    await driver.click('tab-pay', { timeoutMs: 5_000 });
    await driver.click('btn-settings', { timeoutMs: 5_000 });
    await driver.click('btn-currency-USD', { timeoutMs: 5_000 });
    await driver.click('btn-settings-close', { timeoutMs: 5_000 });
    await openBalances(driver);
    assert(await driver.isPresent('asset-ckusdc-main'), 'MAIN moves to the preferred USD rail (ckUSDC)');
    assert(!(await driver.isPresent('asset-sol-usdc-main')), 'the sibling never wears a second MAIN');
    const railBadge = await driver.readText('asset-sol-usdc-rail');
    assertIncludes(railBadge, 'USDC · Solana', 'the sibling badge NAMES its rail (ledger token · settlement chain)');
    assert(!(await driver.isPresent('balances-group-total')), 'no USD group total — two named rows, never one number');
    const usdOrder = await driver.eval(() => [...document.querySelectorAll('[data-testid^="asset-"][aria-selected]')]
      .map(el => el.getAttribute('data-testid')));
    assert(usdOrder[0] === 'asset-ckusdc' && usdOrder[1] === 'asset-sol-usdc',
      `the home currency's rails lead, preferred first. Got: ${JSON.stringify(usdOrder)}`);
    console.log('[136-accounts-page] ✓ home=USD: MAIN on ckUSDC, sibling named + second, nothing summed');

    // 8. The testnet toggle is reachable from the accounts page (flow 54 owns the full walk).
    await waitForEnabled(driver, 'btn-toggle-testnet', { timeoutMs: 5_000 });
    await driver.click('btn-toggle-testnet', { timeoutMs: 5_000 });
    await driver.findByTestID('asset-ckbtc-testnet', { timeoutMs: 5_000 });
    await driver.click('btn-toggle-testnet', { timeoutMs: 5_000 });
    await driver.waitGone('asset-ckbtc-testnet', { timeoutMs: 5_000 });
    console.log('[136-accounts-page] ✓ testnet toggle reachable (reveals + hides the testnet rows)');

    await driver.screenshot('136-accounts-page');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[136-accounts-page] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/136-accounts-page.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[136-accounts-page] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
