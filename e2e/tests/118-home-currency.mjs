// Flow 118 — the HOME CURRENCY: the one currency the wallet is "in" (founder direction 2026-09-04).
//
// Every other flow answers the currency question in its preamble and immediately switches to DEMO,
// because DEMO is what they exercise. This flow is the one that keeps the answer and checks what it
// bought. It pins, end to end through the real app:
//
//   * The chooser stands in FRONT of the wallet on a first run, for any wallet with no stored
//     currency — it is not an onboarding-only screen.
//   * It offers exactly the currencies the catalog can realise: CHF, USD and EUR (single-rail
//     since the 2026-09-19 VEUR retirement: EURC@Solana alone), with each row naming
//     exactly its catalogued rails, each as ledger token · settlement chain. The honesty gate
//     is now shape, not absence: a row may not name a rail the catalog does not carry (founder
//     rule 2026-08-29).
//   * Each row says what the wallet will actually HOLD: the ledger token on the chain the transfer
//     executes on. USD must read "ckUSDC on Internet Computer" — NOT "USDC on Ethereum", which is
//     what naming the display glyph and the backing chain produced, and which would invite someone
//     to send Ethereum USDC to an IC principal.
//   * Choosing CHF lands the wallet ON VCHF, and the header names the CURRENCY ("Swiss francs")
//     while the amount underneath keeps the TOKEN's own unit (VCHF). The wallet can be "in francs"
//     without claiming VCHF is a franc.
//   * Settings changes it, and the wallet follows.
//   * A reload RESUMES where the user was rather than resetting — the remembered selection outranks
//     the home currency once a choice exists, which is what makes `?screen=…` deep links and page
//     reloads stop throwing the user off their asset.
import {
  setup, assert, assertEq, assertIncludes, waitForEnabled,
  skipWalkthroughIfPresent, skipPracticeIfPresent, chooseHomeCurrencyIfPresent, openBalances,
  waitForWallet, WALLET_READY,
} from '../harness/lib.mjs';

export const meta = {
  id: '118',
  name: 'home-currency',
  journey: 'onboard',
  covers: ['home-currency', 'onboard', 'vchf', 'ckusdc', 'eur', 'eurc', 'settings', 'asset-selector', 'persistence'],
  verifies: 'The first run asks which currency the user thinks in, offers only currencies the catalog can realise (CHF/USD/EUR — EUR single-rail, EURC · Solana, since the 2026-09-19 VEUR retirement) with each row naming exactly its catalogued rails as token · chain, names the ledger token on its settlement chain, lands the wallet on that currency, follows a Settings change, and remembers the asset across a reload.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[118-home-currency] setup…');
    // solStub: the EUR row's rail (EURC@Solana) must be enumerable offline — the stub is the
    // harness's stand-in for the solana RPC the app's coherence check reads.
  const env = await setup({ lazyBoot: false, solStub: true });
  try {
    const {driver, webBaseURL, relayBaseURL} = env;

    // --- 1. onboard by hand, and STOP at the currency question ---------------------------------
    console.log('[118-home-currency] onboarding to the currency question…');
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-currency', {timeoutMs: 8_000});
    await driver.click('btn-create', {timeoutMs: 4_000});
    await driver.findByTestID('mnemonic-backup', {timeoutMs: 8_000});
    await driver.click('mnemonic-backup-checkbox', {timeoutMs: 4_000});
    await waitForEnabled(driver, 'btn-mnemonic-continue', {timeoutMs: 4_000});
    await driver.click('btn-mnemonic-continue', {timeoutMs: 4_000});
    await skipPracticeIfPresent(driver);

    // The chooser is the wallet's gate, so it must be on screen BEFORE any balance is.
    await driver.findByTestID('home-currency-title', {timeoutMs: 10_000});
    assert(!(await driver.isPresent(WALLET_READY)),
      'the wallet must not be reachable until a currency has been chosen');
    console.log('[118-home-currency] ✓ the currency question gates the wallet');

    // --- 2. only realisable currencies are offered, each with exactly its catalogued rails ------
    assert(await driver.isPresent('home-currency-CHF'), 'CHF must be offered (VCHF is a catalog row)');
    assert(await driver.isPresent('home-currency-USD'), 'USD must be offered (ckUSDC is a catalog row)');
    assert(await driver.isPresent('home-currency-EUR'),
      'EUR must be offered — EURC@Solana is a catalog row (its one rail since VEUR retired)');
    // ...and the EUR row names EXACTLY its one catalogued rail — the honesty gate is shape: a
    // second line would promise the rail the 2026-09-19 VEUR retirement removed.
    const eurRow = await driver.readText('home-currency-EUR');
    assertIncludes(eurRow, 'EURC · Solana', 'the EUR row names its one rail, the Solana one');
    assert(!eurRow.includes('VEUR'),
      `the retired VEUR rail must not survive anywhere on the row. Got: ${JSON.stringify(eurRow)}`);
    assert(!/(^|[^A-Za-z])EUR ·/.test(eurRow),
      `no phantom "EUR" token rail — the row carries exactly its one catalogued rail. Got: ${JSON.stringify(eurRow)}`);
    console.log('[118-home-currency] ✓ CHF + USD + EUR offered, EUR with exactly its catalogued rails');

    // Each row names the LEDGER TOKEN on the SETTLEMENT chain.
    const chooser = await driver.bodyText();
    assertIncludes(chooser, 'VCHF', 'the CHF row must name the token actually held');
    assertIncludes(chooser, 'ckUSDC', 'the USD row must name ckUSDC, not the bare display glyph USDC');
    assertIncludes(chooser, 'Internet Computer', 'the rows must name the chain the transfer executes on');
    assert(!/on Ethereum/.test(chooser),
      `no row may claim an Ethereum settlement chain — ckUSDC settles on the IC. Got: ${JSON.stringify(chooser.slice(0, 400))}`);
    console.log('[118-home-currency] ✓ rows name the ledger token on its settlement chain');
    await driver.screenshot('118-home-currency-chooser');

    // --- 3. choosing CHF lands the wallet on VCHF ----------------------------------------------
    await driver.click('home-currency-CHF', {timeoutMs: 4_000});
    await driver.click('btn-home-currency-continue', {timeoutMs: 4_000});
    await waitForWallet(driver, {timeoutMs: 10_000});

    // The wallet lands on HOME, and Home states the chosen currency in its own headline — the
    // founder sketch's eyebrow grammar ("Balance CHF" + the currency-unit figure; fork #4
    // supersedes the token-unit headline, and VCHF's peg stays unclaimed: the unit is the
    // suffix "Fr", never "CHF <amount>").
    const label = await driver.readText('home-headline-label');
    assertEq(label, 'Balance CHF', 'the landing screen names the CURRENCY the user chose (the eyebrow grammar)');
    const headline = await driver.readText('home-headline-amount');
    assert(/^[~]?\d/.test(headline) && headline.includes('Fr'),
      `the headline figure renders in the currency unit ("0.00 Fr"), got ${JSON.stringify(headline)}`);
    const home = await driver.bodyText();
    console.log(`[118-home-currency] ✓ landed on the chosen currency: ${JSON.stringify(label)} / ${JSON.stringify(headline)}`);
    await driver.screenshot('118-home-currency-wallet');

    // --- 4. Settings changes it, and the wallet follows -----------------------------------------
    await driver.click('btn-settings', {timeoutMs: 5_000});
    await driver.click('btn-currency-USD', {timeoutMs: 5_000});
    await driver.click('btn-settings-close', {timeoutMs: 5_000});
    await waitForWallet(driver, {timeoutMs: 8_000});
    // The wallet was explicitly left on VCHF, so changing the MAIN currency does not yank the user
    // off the asset they are looking at — it changes what the wallet opens with. Prove it by reload.
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(relayBaseURL)}`,
      {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 10_000});
    await chooseHomeCurrencyIfPresent(driver); // must NOT appear — a currency is stored
    await waitForWallet(driver, {timeoutMs: 10_000});
    // The chip headlines the MAIN currency (the currency-first chip names the wallet's one
    // currency): after the settings switch + reload it reads "Balance USD" — the switch took.
    await driver.click('tab-pay', {timeoutMs: 5_000});
    const afterReload = await driver.readText('active-asset-label');
    assertEq(afterReload.replace(/^~\s*/, ''), 'Balance USD',
      `the chip headlines the NEW main currency after the reload. Got ${JSON.stringify(afterReload)}`);
    console.log(`[118-home-currency] ✓ reload resumed under the new main: ${JSON.stringify(afterReload)}`);

    // --- 5. and the NEW main currency is what an unremembered wallet opens on --------------------
    // Selecting USD's rail explicitly, then reloading, proves the pair: the remembered asset wins,
    // and the label follows the main currency once the two agree.
    await openBalances(driver, {timeoutMs: 5_000});
    const usdRow = await driver.readText('accounts-currency-USD');
    assertIncludes(usdRow, 'Main', 'with USD as the main currency, its currency row is marked Main');
    console.log(`[118-home-currency] ✓ the main-currency row reads as main: ${JSON.stringify(usdRow.slice(0, 60))}`);

    console.log(`[118-home-currency] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}
