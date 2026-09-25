// Flow 121 — the BALANCES half of the currency group: every rail of the home currency is MARKED,
// never summed (Objective 2, docs/specs/2026-09-04-currency-first-wallet-plan.md).
//
// Flow 120 pinned that the CHOOSER names every rail of a currency; this flow pins that the
// ACCOUNTS route — where the money actually lives — keeps the two USD rails as two DISTINCT
// rows, each wearing its own badge, with no group total anywhere:
//
//   * home=USD: BOTH rails stay visible as their own rows (ckUSDC AND USDC·Solana) — the founder's
//     honesty rule is that same-currency rails on different chains must never read as one balance,
//     so the answer to a two-rail currency is two named rows, not one summed line.
//   * The MAIN badge stays on the PREFERRED rail only (ckUSDC); the sibling does NOT wear a second
//     MAIN — two "Main" badges would read as one merged account. Instead the sibling wears a badge
//     NAMING its rail ("USDC · Solana", the S1 rail-line vocabulary).
//   * NO summed/combined-total line exists for the group — the only USD numbers on the surface are
//     the two rows' own balances.
//   * home=CHF: a single-rail currency renders EXACTLY as before — MAIN on VCHF, and no rail badge
//     anywhere (a badge on a one-rail group would be noise naming the obvious).
//
// (2026-09-08: the accounts list is its own ROUTE, reached by the header balance chip — it was
// inlined on the Home tab before that, and a Balances sheet before that. `openBalances` owns the
// navigation, so this flow reads the same either way.)
import {setup, assert, assertIncludes, onboardWallet, openBalances, waitForWallet} from '../harness/lib.mjs';

export const meta = {
  id: '121',
  name: 'home-currency-balance-rails',
  journey: 'onboard',
  covers: ['home-currency', 'balances', 'ckusdc', 'solana-usdc', 'vchf', 'group-model'],
  verifies: 'The accounts route is ONE row per CURRENCY (fork #2, the 2026-09-24 redesign superseding the per-rail rows): home=USD renders a single summed currency-unit row whose rail label names BOTH rails (ckUSDC · Internet Computer, USDC · Solana), the Main badge sits on the USD row, no per-rail rows remain, and home=CHF renders its single rail the same way.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[121-home-currency-balance-rails] setup…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    // --- 1. onboard seeded, pin home=USD -----------------------------------------------
    console.log('[121-home-currency-balance-rails] onboarding, pinning home=USD…');
    await onboardWallet(driver, 'e2e-balance-rails');
    await driver.click('btn-settings', {timeoutMs: 5_000});
    await driver.click('btn-currency-USD', {timeoutMs: 5_000});
    await driver.click('btn-settings-close', {timeoutMs: 5_000});
    await waitForWallet(driver, {timeoutMs: 8_000});

    // --- 2. home=USD: ONE currency row, summed figure, both rails named in the label ----
    await openBalances(driver);
    assert(await driver.isPresent('accounts-currency-USD'),
      'the USD currency row exists (fork #2: one row per currency, not per rail)');
    assert(!(await driver.isPresent('asset-ckusdc')),
      'the per-rail ckUSDC row is GONE — the currency row replaces it');
    assert(!(await driver.isPresent('asset-sol-usdc')),
      'the per-rail USDC·Solana row is GONE too — the wallet reads one USD account');
    assert(await driver.findByTestID('currency-USD-main', {timeoutMs: 4_000}) != null,
      'the USD row carries the Main badge (it is the wallet\'s one currency)');
    const usdLabel = await driver.readText('accounts-currency-USD');
    assertIncludes(usdLabel, 'ckUSDC · Internet Computer', 'the row\'s rail label names the IC rail');
    assertIncludes(usdLabel, 'USDC · Solana', 'the row\'s rail label names the Solana rail');
    // The summed figure is the row's own amount (currency unit) — no separate group-total line.
    const sheet = await driver.bodyText();
    assert(!/\bgroup total\b/i.test(sheet),
      `no group-total vocabulary may exist beyond the row\'s own summed figure. Got: ${JSON.stringify(sheet.slice(0, 400))}`);
    await driver.screenshot('121-balance-rails-usd');

    // --- 3. home=CHF: single rail, the same one-row grammar -----------------------------
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.click('btn-settings', {timeoutMs: 5_000});
    await driver.click('btn-currency-CHF', {timeoutMs: 5_000});
    await driver.click('btn-settings-close', {timeoutMs: 5_000});
    await waitForWallet(driver, {timeoutMs: 8_000});
    await openBalances(driver);
    assert(await driver.findByTestID('currency-CHF-main', {timeoutMs: 4_000}) != null,
      'home=CHF carries the Main badge on its currency row');
    assert(await driver.isPresent('accounts-currency-CHF'),
      'the CHF currency row exists (single rail — exactly the row the currency list always had)');
    await driver.screenshot('121-balance-rails-chf');
    console.log('[121-home-currency-balance-rails] ✓ CHF: single rail, same one-row grammar');

    console.log(`[121-home-currency-balance-rails] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}
