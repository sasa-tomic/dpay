// Flow 120 — the CURRENCY GROUP: a currency is a set of rails, and the chooser names them all
// (Objective 2, docs/specs/2026-09-04-currency-first-wallet-plan.md).
//
// Flow 118 pinned that a row names the ledger token on its settlement chain; this flow pins that a
// row names EVERY rail of the currency, with the rail dpay would pick listed first. What each
// assertion protects:
//
//   * USD is a TWO-rail currency here (ckUSDC on the Internet Computer, USDC on Solana) — a row
//     that named only ckUSDC would present "US dollars" as one token, which is exactly the merged-
//     balance reading the founder's honesty rule forbids (same-currency rails on different chains
//     must never read as one balance; naming both is how they stay distinct).
//   * CHF is a ONE-rail currency (VCHF on the Internet Computer) — its row must not carry a
//     Solana line that would promise a rail the catalog does not have.
//   * EUR is a TWO-rail currency too (EURC on Solana, VEUR on the Internet Computer — the
//     dual-rail addition), and its preferred rail is the DEEP-liquidity one: EURC first, then
//     VEUR. Preference is a catalog-backed statement, not an
//     accident of enumeration.
//   * The preferred rail is FIRST, without exposing the internal “dpay default rail” policy label.
//   * Settings shows the same group shape for the main currency, so "Main currency: USD" there
//     never reads as one token either.
//   * The byte-stable chooser testIDs still drive the flow (home-currency-<CCY>,
//     btn-home-currency-continue) — the ~106 flows that ride chooseHomeCurrencyIfPresent.
import {
  setup, assert, assertIncludes, waitForEnabled, skipWalkthroughIfPresent, skipPracticeIfPresent,
 waitForWallet} from '../harness/lib.mjs';

export const meta = {
  id: '120',
  name: 'home-currency-rails',
  journey: 'onboard',
  covers: ['home-currency', 'onboard', 'ckusdc', 'solana-usdc', 'eur', 'eurc', 'veur', 'settings', 'group-model'],
  verifies: 'The chooser row lists EVERY rail of a currency (USD: ckUSDC · Internet Computer AND USDC · Solana; EUR: EURC · Solana first — the deep-liquidity preference — then VEUR · Internet Computer; CHF: VCHF only), keeps the preferred rail first without a “dpay default rail” suffix, Settings shows the same group for the main currency, and Continue still works.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[120-home-currency-rails] setup…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    // --- 1. onboard by hand, and STOP at the currency question ---------------------------------
    console.log('[120-home-currency-rails] onboarding to the currency question…');
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-currency-rails', {timeoutMs: 8_000});
    await driver.click('btn-create', {timeoutMs: 4_000});
    await driver.findByTestID('mnemonic-backup', {timeoutMs: 8_000});
    await driver.click('mnemonic-backup-checkbox', {timeoutMs: 4_000});
    await waitForEnabled(driver, 'btn-mnemonic-continue', {timeoutMs: 4_000});
    await driver.click('btn-mnemonic-continue', {timeoutMs: 4_000});
    await skipPracticeIfPresent(driver);
    await driver.findByTestID('home-currency-title', {timeoutMs: 10_000});

    // --- 2. the USD row names BOTH rails, preferred first ---------------------------------------
    const usdRow = await driver.readText('home-currency-USD');
    assertIncludes(usdRow, 'ckUSDC · Internet Computer',
      'the USD row must name the IC rail as ledger token · settlement chain');
    assertIncludes(usdRow, 'USDC · Solana',
      'the USD row must ALSO name the Solana rail — USD is a two-rail currency, and hiding one would read as one merged balance');
    assert(!usdRow.includes("dpay's default rail"),
      `the chooser must not expose its internal preference label. Got: ${JSON.stringify(usdRow)}`);
    assert(usdRow.indexOf('ckUSDC') < usdRow.indexOf('USDC · Solana'),
      `the preferred rail must be listed first. Got: ${JSON.stringify(usdRow)}`);
    console.log('[120-home-currency-rails] ✓ USD row names both rails, preferred first without policy jargon');

    // --- 2b. the EUR row names BOTH rails, deep-liquidity EURC preferred first -------------------
    const eurRow = await driver.readText('home-currency-EUR');
    assertIncludes(eurRow, 'EURC · Solana',
      'the EUR row names the Solana rail as ledger token · settlement chain');
    assertIncludes(eurRow, 'VEUR · Internet Computer',
      'the EUR row ALSO names the IC rail — EUR is a two-rail currency');
    assert(!eurRow.includes("dpay's default rail"),
      `the EUR row must not expose the internal preference label. Got: ${JSON.stringify(eurRow)}`);
    assert(eurRow.indexOf('EURC') < eurRow.indexOf('VEUR'),
      `the preferred EUR rail must be listed first. Got: ${JSON.stringify(eurRow)}`);
    console.log('[120-home-currency-rails] ✓ EUR row names both rails, EURC preferred first');

    // --- 3. the CHF row names its ONE rail and no phantom second one ----------------------------
    const chfRow = await driver.readText('home-currency-CHF');
    assertIncludes(chfRow, 'VCHF · Internet Computer',
      'the CHF row must name the VCHF rail as ledger token · settlement chain');
    assert(!/Solana/.test(chfRow),
      `CHF has one rail in the catalog — a Solana line would promise a rail it cannot deliver. Got: ${JSON.stringify(chfRow)}`);
    console.log('[120-home-currency-rails] ✓ CHF row names exactly its one rail');
    await driver.screenshot('120-home-currency-rails-chooser');

    // --- 4. Continue still works, byte-stable testIDs and all ------------------------------------
    await driver.click('home-currency-USD', {timeoutMs: 4_000});
    await driver.click('btn-home-currency-continue', {timeoutMs: 4_000});
    await waitForWallet(driver, {timeoutMs: 10_000});
    // The wallet lands on HOME, and Home states the chosen currency in its own headline — the
    // header chip is not rendered there (it names the SELECTION, which is a different fact; see
    // flow 158). `home-headline-label` is the currency statement on this surface.
    const label = await driver.readText('home-headline-label');
    assertIncludes(label, 'US dollars', 'choosing USD must land the wallet on its preferred rail, in the currency\'s name');
    console.log(`[120-home-currency-rails] ✓ continue works: ${JSON.stringify(label)}`);

    // --- 5. Settings shows the same group shape for the main currency ----------------------------
    await driver.click('btn-settings', {timeoutMs: 5_000});
    const settings = await driver.bodyText();
    assertIncludes(settings, 'ckUSDC · Internet Computer, USDC · Solana',
      'the Settings main-currency row must show the whole USD group on one line, preferred rail first');
    await driver.click('btn-settings-close', {timeoutMs: 5_000});
    console.log('[120-home-currency-rails] ✓ Settings names the whole group');

    console.log(`[120-home-currency-rails] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}
