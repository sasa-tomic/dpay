/**
 * Flows 118 + 120 + 121 + 129 + 130 + 149 — the home-currency chooser and the currency-row
 * balance grammar — the jest twins of `e2e/tests/118-home-currency.mjs`, `120-home-currency-rails.mjs`,
 * `121-home-currency-balance-rails.mjs`, `129-eur-rail-detail.mjs`, `130-eur-balances-rails.mjs`,
 * `149-currency-chooser-dead-tap.mjs`.
 *
 * The chooser gates the wallet and offers exactly the realisable currencies, each naming its
 * catalogued rails as "ledger token · settlement chain" (preferred first; the retired VEUR never
 * appears; a single-rail currency never expands to detail copy). Choosing lands the wallet on the
 * chosen currency's headline grammar; the accounts route reads ONE row per currency with the rail
 * group in its label and the Main badge on the main row; the early Continue press is answered and
 * commits nothing; Settings can change the main and a reload resumes under it.
 *
 * The EUR row's rail (EURC@Solana) is enumerable offline through the SOL RPC stub (solStub.ts —
 * the harness's stand-in for the coherence check's Solana read).
 */
import {it, expect} from '@jest/globals';
// FIRST: the SOL RPC override + stub helper (the app captures the URL at module load).
import {installSolAccountsHelper} from '../settings/solStub';
import {mountApp, type Mount} from '../harness/mount';
import {
  assertEq, assertIncludes, chooseHomeCurrencyIfPresent, onboardWallet, openBalances,
  skipPracticeIfPresent, skipWalkthroughIfPresent, waitForEnabled, waitForWallet,
  WALLET_READY,
} from '../harness/lib';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

/** Walk a fresh context from the walkthrough to the currency question (the twins' shared preamble). */
async function onboardToChooser(m: Mount): Promise<void> {
  await skipWalkthroughIfPresent(m);
  await m.driver.typeByPlaceholder('e.g. Alice', 'e2e-currency', {timeoutMs: 8000});
  await m.driver.click('btn-create', {timeoutMs: 4000});
  await m.driver.findByTestID('mnemonic-backup', {timeoutMs: 8000});
  await m.driver.click('mnemonic-backup-checkbox', {timeoutMs: 4000});
  await waitForEnabled(m, 'btn-mnemonic-continue', {timeoutMs: 4000});
  await m.driver.click('btn-mnemonic-continue', {timeoutMs: 4000});
  await skipPracticeIfPresent(m);
  await m.driver.findByTestID('home-currency-title', {timeoutMs: 10_000});
}

hermeticDescribe('flow 118 — home-currency', () => {
  it('the chooser gates the wallet; only realisable currencies with their catalogued rails; choosing lands it; Settings can change it', async () => {
    installSolAccountsHelper();
    const m = await mountApp();
    await onboardToChooser(m);

    // The wallet must not be reachable until a currency has been chosen.
    expect(m.driver.isPresent(WALLET_READY)).toBe(false);

    // Only realisable currencies are offered; the EUR row names EXACTLY its one catalogued rail.
    expect(m.driver.isPresent('home-currency-CHF')).toBe(true);
    expect(m.driver.isPresent('home-currency-USD')).toBe(true);
    expect(m.driver.isPresent('home-currency-EUR')).toBe(true);
    const eurRow = m.driver.readText('home-currency-EUR');
    assertIncludes(eurRow, 'EURC · Solana', 'the EUR row names its one rail, the Solana one');
    expect(eurRow.includes('VEUR')).toBe(false);
    expect(/(^|[^A-Za-z])EUR ·/.test(eurRow)).toBe(false);

    // Each row names the LEDGER TOKEN on the SETTLEMENT chain.
    const chooser = m.driver.bodyText();
    assertIncludes(chooser, 'VCHF', 'the CHF row must name the token actually held');
    assertIncludes(chooser, 'ckUSDC', 'the USD row must name ckUSDC, not the bare glyph');
    assertIncludes(chooser, 'Internet Computer', 'the rows must name the settlement chain');
    expect(/on Ethereum/.test(chooser)).toBe(false);

    // 3. Choosing CHF lands the wallet on VCHF, and Home states the currency (eyebrow grammar).
    await m.driver.click('home-currency-CHF', {timeoutMs: 4000});
    await m.driver.click('btn-home-currency-continue', {timeoutMs: 4000});
    await waitForWallet(m, {timeoutMs: 10_000});
    // The headline node may carry the offline eyebrow ('~ … approx.') in the same subtree.
    assertIncludes(m.driver.readText('home-headline-label'), 'Balance CHF', 'the landing names the CURRENCY');
    const headline = m.driver.readText('home-headline-amount');
    expect(/^[~]?\d/.test(headline) && headline.includes('Fr')).toBe(true);

    // 4. Settings changes the main; a reload resumes under it (the chooser must NOT re-appear).
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-currency-USD', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});
    await waitForWallet(m, {timeoutMs: 8000});
    await m.remount({url: '/'});
    await chooseHomeCurrencyIfPresent(m); // must NOT appear — a currency is stored
    await waitForWallet(m, {timeoutMs: 10_000});
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    const afterReload = m.driver.readText('active-asset-label').replace(/^~\s*/, '');
    assertEq(afterReload, 'Balance USD', 'the chip headlines the NEW main currency after the reload');

    // 5. The NEW main currency is what the accounts route marks Main.
    await openBalances(m);
    assertIncludes(m.driver.readText('accounts-currency-USD'), 'Main', 'the USD row is marked Main');

    await m.unmount();
  }, 150_000);
});

hermeticDescribe('flow 120 — home-currency-rails', () => {
  it('USD names both rails preferred first; EUR and CHF name exactly their one rail; Settings shows the group', async () => {
    installSolAccountsHelper();
    const m = await mountApp();
    await onboardToChooser(m);

    // The USD row names BOTH rails, preferred first, without the internal preference label.
    const usdRow = m.driver.readText('home-currency-USD');
    assertIncludes(usdRow, 'ckUSDC · Internet Computer', 'the USD row names the IC rail');
    assertIncludes(usdRow, 'USDC · Solana', 'the USD row ALSO names the Solana rail');
    expect(usdRow.includes("dpay's default rail")).toBe(false);
    expect(usdRow.indexOf('ckUSDC') < usdRow.indexOf('USDC · Solana')).toBe(true);

    // The EUR row names its ONE rail — no retired-rail phantom, no IC line.
    const eurRow = m.driver.readText('home-currency-EUR');
    assertIncludes(eurRow, 'EURC · Solana', 'the EUR row names the Solana rail');
    expect(eurRow.includes('VEUR')).toBe(false);
    expect(eurRow.includes('Internet Computer')).toBe(false);
    expect(eurRow.includes("dpay's default rail")).toBe(false);

    // The CHF row names its ONE rail and no phantom second one.
    const chfRow = m.driver.readText('home-currency-CHF');
    assertIncludes(chfRow, 'VCHF · Internet Computer', 'the CHF row names the VCHF rail');
    expect(/Solana/.test(chfRow)).toBe(false);

    // Continue still works: choosing USD lands the wallet, the headline names the CURRENCY.
    await m.driver.click('home-currency-USD', {timeoutMs: 4000});
    await m.driver.click('btn-home-currency-continue', {timeoutMs: 4000});
    await waitForWallet(m, {timeoutMs: 10_000});
    assertIncludes(m.driver.readText('home-headline-label'), 'Balance USD', 'choosing USD lands on its preferred rail');

    // Settings shows the same group shape for the main currency.
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    assertIncludes(m.driver.bodyText(), 'ckUSDC · Internet Computer, USDC · Solana',
      'the Settings main-currency row shows the whole USD group on one line, preferred rail first');
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});

    await m.unmount();
  }, 150_000);
});

hermeticDescribe('flow 121 — home-currency-balance-rails', () => {
  it('home=USD reads ONE currency row with both rails in its label and the Main badge; home=CHF the same grammar', async () => {
    installSolAccountsHelper();
    const m = await onboardWallet('e2e-balance-rails');
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-currency-USD', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});
    await waitForWallet(m, {timeoutMs: 8000});

    // home=USD: ONE currency row, summed figure, both rails named in the label.
    await openBalances(m);
    expect(m.driver.isPresent('accounts-currency-USD')).toBe(true);
    expect(m.driver.isPresent('asset-ckusdc')).toBe(false); // per-rail rows are gone
    expect(m.driver.isPresent('asset-sol-usdc')).toBe(false);
    await m.driver.findByTestID('currency-USD-main', {timeoutMs: 4000});
    const usdLabel = m.driver.readText('accounts-currency-USD');
    assertIncludes(usdLabel, 'ckUSDC · Internet Computer', "the row's rail label names the IC rail");
    assertIncludes(usdLabel, 'USDC · Solana', "the row's rail label names the Solana rail");
    expect(/\bgroup total\b/i.test(m.driver.bodyText())).toBe(false);

    // home=CHF: single rail, the same one-row grammar.
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-currency-CHF', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});
    await waitForWallet(m, {timeoutMs: 8000});
    await openBalances(m);
    await m.driver.findByTestID('currency-CHF-main', {timeoutMs: 4000});
    expect(m.driver.isPresent('accounts-currency-CHF')).toBe(true);

    await m.unmount();
  }, 150_000);
});

hermeticDescribe('flow 129 — eur-single-rail', () => {
  it('EUR offered with exactly its one rail; a tap picks without expanding; Continue lands EURC@Solana', async () => {
    installSolAccountsHelper();
    const m = await mountApp();
    await onboardToChooser(m);

    expect(m.driver.isPresent('home-currency-EUR')).toBe(true);
    // Collapsed, the row names its ONE rail and NOTHING else — no fee/health/ramp copy, no retired rail.
    const collapsed = m.driver.readText('home-currency-EUR');
    assertIncludes(collapsed, 'EURC · Solana', 'the collapsed EUR row names the Solana rail');
    expect(collapsed.includes('VEUR')).toBe(false);
    expect(collapsed.includes('Internet Computer')).toBe(false);
    for (const absent of ['Fee', 'Thin liquidity', 'Circulates', 'DFX', 'fiat ramp', 'sellable']) {
      expect({absent, present: collapsed.includes(absent)}).toEqual({absent, present: false});
    }

    // Tap → a pick, NEVER an expansion (uniform with CHF).
    await m.driver.click('home-currency-EUR', {timeoutMs: 4000});
    expect(m.driver.isPresent('home-currency-detail')).toBe(false);
    expect(m.driver.isPresent('btn-home-currency-back')).toBe(false);
    await m.driver.click('home-currency-CHF', {timeoutMs: 4000});
    expect(m.driver.isPresent('home-currency-detail')).toBe(false);

    // Continue commits: EUR lands the wallet on EURC@Solana.
    await m.driver.click('home-currency-EUR', {timeoutMs: 4000});
    await m.driver.click('btn-home-currency-continue', {timeoutMs: 4000});
    await waitForWallet(m, {timeoutMs: 10_000});
    assertIncludes(m.driver.readText('home-headline-label'), 'Balance EUR', 'the headline names the CURRENCY');
    expect(m.driver.isPresent('home-currency-detail')).toBe(false);
    await openBalances(m);
    expect(m.driver.isPresent('currency-EUR-main')).toBe(true);
    expect(m.driver.isPresent('asset-veur')).toBe(false);

    await m.unmount();
  }, 150_000);
});

hermeticDescribe('flow 130 — eur-single-rail-balances', () => {
  it('one EUR row (Main + EURC rail label), no VEUR trace, no health note on any row, the row figure IS the sum', async () => {
    installSolAccountsHelper();
    const m = await onboardWallet('e2e-eur-balances');
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-currency-EUR', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});
    await waitForWallet(m, {timeoutMs: 8000});

    await openBalances(m);
    expect(m.driver.isPresent('accounts-currency-EUR')).toBe(true);
    await m.driver.findByTestID('currency-EUR-main', {timeoutMs: 4000});
    expect(m.driver.isPresent('asset-sol-eurc')).toBe(false);
    expect(m.driver.isPresent('asset-veur')).toBe(false);
    expect(m.driver.isPresent('asset-veur-main')).toBe(false);
    assertIncludes(m.driver.readText('accounts-currency-EUR'), 'EURC · Solana', "the row's rail label names the EURC@Solana rail");

    // The health note renders on NO row.
    expect(m.driver.readText('accounts-currency-EUR').includes('Thin liquidity')).toBe(false);
    expect(m.driver.readText('accounts-currency-EUR').includes('Circulates widely')).toBe(false);
    expect(m.driver.readText('accounts-currency-CHF').includes('Thin liquidity')).toBe(false);
    expect(m.driver.readText('accounts-currency-CHF').includes('Circulates widely')).toBe(false);
    expect(m.driver.readText('accounts-currency-SOL').includes('Thin liquidity')).toBe(false);
    expect(m.driver.isPresent('rail-liquidity-note')).toBe(false);

    // No group-total vocabulary beyond the row's own summed figure.
    expect(/\bgroup total\b/i.test(m.driver.bodyText())).toBe(false);

    await m.unmount();
  }, 150_000);
});

hermeticDescribe('flow 149 — currency-chooser-dead-tap', () => {
  it('nothing preselected; an early Continue is answered and commits nothing; picking clears the prompt and Continue commits', async () => {
    const m = await mountApp();
    await onboardToChooser(m);

    // Nothing is preselected (no aria-checked row), and nothing is nagging yet.
    // No row is checked (the prop may be absent entirely — absence is what "not preselected" is).
    const checked = m.driver.propOf('home-currency-CHF', 'aria-checked');
    expect(checked === true).toBe(false);
    expect(m.driver.isPresent('home-currency-pick-first')).toBe(false);

    // The early press: it must ANSWER, and it must not commit anything.
    await m.driver.click('btn-home-currency-continue', {timeoutMs: 5000});
    expect(m.driver.readText('home-currency-pick-first')).toBe('Pick a currency first.');
    expect(m.driver.isPresent('home-currency-title')).toBe(true);
    expect(m.driver.isPresent(WALLET_READY)).toBe(false);

    // Picking clears the prompt; Continue then does exactly what it says.
    await m.driver.click('home-currency-CHF', {timeoutMs: 5000});
    expect(m.driver.isPresent('home-currency-pick-first')).toBe(false);
    await m.driver.click('btn-home-currency-continue', {timeoutMs: 5000});
    await waitForWallet(m, {timeoutMs: 10_000});

    await m.unmount();
  }, 120_000);
});
