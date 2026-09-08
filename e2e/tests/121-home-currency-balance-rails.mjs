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
import {
  setup, assert, assertIncludes, waitForEnabled, skipWalkthroughIfPresent, skipRehearsalIfPresent,
  openBalances,
} from '../harness/lib.mjs';

export const meta = {
  id: '121',
  name: 'home-currency-balance-rails',
  journey: 'onboard',
  covers: ['home-currency', 'balances', 'ckusdc', 'solana-usdc', 'vchf', 'group-model'],
  verifies: 'The accounts route marks every rail of the home-currency group without summing it: home=USD keeps ckUSDC (MAIN) and USDC · Solana (named rail badge) as distinct rows with no group total; home=CHF renders exactly as before (MAIN on VCHF, no rail badges).',
  timeoutMs: 30000,
};

export async function run() {
  const start = Date.now();
  console.log('[121-home-currency-balance-rails] setup…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    // --- 1. onboard by hand, choose USD, land on its preferred rail --------------------------------
    console.log('[121-home-currency-balance-rails] onboarding to the currency question…');
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-balance-rails', {timeoutMs: 8_000});
    await driver.click('btn-create', {timeoutMs: 4_000});
    await driver.findByTestID('mnemonic-backup', {timeoutMs: 8_000});
    await driver.click('mnemonic-backup-checkbox', {timeoutMs: 4_000});
    await waitForEnabled(driver, 'btn-mnemonic-continue', {timeoutMs: 4_000});
    await driver.click('btn-mnemonic-continue', {timeoutMs: 4_000});
    await skipRehearsalIfPresent(driver);
    await driver.findByTestID('home-currency-title', {timeoutMs: 10_000});
    await driver.click('home-currency-USD', {timeoutMs: 4_000});
    await driver.click('btn-home-currency-continue', {timeoutMs: 4_000});
    await driver.findByTestID('balance', {timeoutMs: 10_000});

    // --- 2. home=USD: BOTH rails visible, MAIN on ckUSDC only, sibling named, nothing summed ------
    await openBalances(driver);
    assert(await driver.isPresent('asset-ckusdc'),
      'the IC rail of the USD group must have its own row in the accounts list');
    assert(await driver.isPresent('asset-sol-usdc'),
      'the Solana rail of the USD group must ALSO have its own row — a two-rail currency is two rows, never one');
    assert(await driver.isPresent('asset-ckusdc-main'),
      'the preferred rail (ckUSDC) carries the MAIN badge');
    assert(!(await driver.isPresent('asset-sol-usdc-main')),
      'the sibling rail must NOT wear a second MAIN badge — two Mains would read as one merged account');
    assert(!(await driver.isPresent('asset-ckusdc-rail')),
      'the preferred rail carries MAIN only, not both badges');
    assert(await driver.isPresent('asset-sol-usdc-rail'),
      'the sibling rail carries a rail badge');
    const siblingBadge = await driver.readText('asset-sol-usdc-rail');
    assertIncludes(siblingBadge, 'USDC · Solana',
      'the sibling badge NAMES its rail with the rail-line vocabulary (ledger token · settlement chain), never "MAIN"');
    console.log('[121-home-currency-balance-rails] ✓ USD group: two rows, MAIN on ckUSDC, sibling named');

    // No summed/combined-total line: the route's text carries no total vocabulary, and no badge or
    // row merges the two rails' balances into one number.
    const sheet = await driver.bodyText();
    assert(!/\btotal\b/i.test(sheet),
      `a two-rail currency must never be summed — no group-total line may exist. Got: ${JSON.stringify(sheet.slice(0, 400))}`);
    assert(!(await driver.isPresent('balances-group-total')),
      'no group-total element may exist for the home currency');
    await driver.screenshot('121-balance-rails-usd');

    // --- 3. home=CHF: single rail, nothing changed vs before ---------------------------------------
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.click('btn-settings', {timeoutMs: 5_000});
    await driver.click('btn-currency-CHF', {timeoutMs: 5_000});
    await driver.click('btn-settings-close', {timeoutMs: 5_000});
    await driver.findByTestID('balance', {timeoutMs: 8_000});
    await openBalances(driver);
    assert(await driver.isPresent('asset-vchf-main'),
      'the single-rail home currency keeps its MAIN badge on VCHF');
    assert(!(await driver.isPresent('asset-vchf-rail')),
      'a one-rail group carries no rail badge — the badge exists to NAME a sibling, and VCHF has none');
    assert(!(await driver.isPresent('asset-ckusdc-rail')),
      'with home=CHF the USD rows are not home-rails either — no rail badges anywhere');
    assert(!(await driver.isPresent('asset-sol-usdc-rail')),
      'with home=CHF the Solana USDC row carries no rail badge');
    await driver.screenshot('121-balance-rails-chf');
    console.log('[121-home-currency-balance-rails] ✓ CHF: single rail, exactly as before');

    console.log(`[121-home-currency-balance-rails] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}
