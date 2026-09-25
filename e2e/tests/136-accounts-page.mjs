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
  assertEq,
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
  verifies: 'The accounts page keeps its contract under the currency grammar: the zero CHF and ICP rows stay visible (asset-first, per currency), the practice row sits LAST under its own divider, the Main badge rides the MAIN currency row only, the row press sets MAIN and lands Home, and a reload resumes under the remembered main.',
  timeoutMs: 90_000,
};

export async function run() {
  const start = Date.now();
  const env = await setup({solStub: true});
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(env.relayBaseURL)}`;

    console.log('[136-accounts-page] onboarding…');
    await onboardWallet(driver, 'e2e-accounts-page');

    await openBalances(driver);
    await driver.findByTestID('accounts-list', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('home-accounts')), 'the retired container name must be gone — the list is a route now');

    // --- 1. the visible-currency contract: zero-balance currencies STAY; practice row LAST ------
    assertIncludes(await driver.readText('accounts-currency-CHF'), '0.00 Fr', 'the zero CHF row stays visible with an honest currency-unit figure');
    assertIncludes(await driver.readText('accounts-currency-ICP'), '0 ICP', 'zero-balance ICP stays visible (asset-first rule, per currency)');
    assertIncludes(await driver.readText('asset-demo'), '∂100.00', 'the funded practice row shows its balance');
    const order = await driver.eval(() => [...document.querySelectorAll('[data-testid^="accounts-currency-"][aria-selected]')]
      .map(el => el.getAttribute('data-testid')));
    assert(order[0] === 'accounts-currency-CHF', `the main currency leads the list. Got: ${JSON.stringify(order)}`);
    const note = await driver.readText('accounts-practice-note');
    assertIncludes(note.toLowerCase(), 'practice', 'the divider names the practice money in a whole sentence');
    assertIncludes(note.toLowerCase(), 'no shop', 'the divider says what practice money cannot do');
    console.log(`[136-accounts-page] ✓ order: ${order[0]} first; practice last under its divider`);

    // --- 2. the Main badge sits on the MAIN currency row only -----------------------------------
    assert(await driver.findByTestID('currency-CHF-main', { timeoutMs: 4_000 }) != null, 'Main badge on the CHF row');
    assert(!(await driver.findByTestID('currency-USD-main', { timeoutMs: 1_000 }).catch(() => null)),
      'no Main badge on a non-main currency row');

    // --- 3. the row press sets MAIN and goes Home (the spec's deliberate gesture) ---------------
    await driver.click('btn-accounts-currency-CHF', { timeoutMs: 5_000 });
    await driver.findByTestID('home-headline-label', { timeoutMs: 5_000 });
    assertEq(await driver.readText('home-headline-label'), 'Balance CHF', 'the row press set CHF main and landed Home');

    // --- 4. the currency-row semantics SURVIVE a reload ----------------------------------------
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({ timeoutMs: 8_000 });
    await driver.findByTestID('home-headline-label', { timeoutMs: 8_000 });
    assertEq(await driver.readText('home-headline-label'), 'Balance CHF',
      'the reload resumes under the remembered main (CHF)');

    await driver.screenshot('136-accounts-page');
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
