// Flow 129 — EUR is a SINGLE-rail currency: the chooser card behaves exactly like CHF's.
//
// EUR used to be the dual-rail showcase (EURC@Solana deep + VEUR@IC thin, with the Stage 4+5
// in-card detail panel). VNX wound VEUR down (2026-09-19 census: zero ICPSwap pools; the deepest
// pool on any chain held $608 on Base and never traded), and the founder retired currency 9
// outright (`4851c88`). The catalog now carries ONE EUR rail — EURC · Solana — so the card loses
// the expansion with it. This flow pins the collapse:
//
//   * The collapsed EUR row names EXACTLY its one catalogued rail, as ledger token · settlement
//     chain, and nothing else: no fee, no health note, no ramp copy — and no VEUR line and no IC
//     chain anywhere on the row (a rail the catalog retired must not survive as copy).
//   * Tapping EUR picks it and opens NOTHING: no detail panel, no Back link — a single-rail
//     currency has nothing to compare, the same rule CHF has always followed. The detail panel
//     itself stays alive for the remaining multi-rail currency (USD) and is pinned in jest
//     (HomeCurrencyChooser.test.tsx); e2e followed the currency the panel used to serve.
//   * Continue still commits, and EUR lands the wallet on EURC@Solana — the only rail there is.
import {
  setup, assert, assertIncludes, waitForEnabled, skipWalkthroughIfPresent, skipPracticeIfPresent,
  openBalances,
 waitForWallet} from '../harness/lib.mjs';

export const meta = {
  id: '129',
  name: 'eur-single-rail',
  journey: 'onboard',
  covers: ['home-currency', 'onboard', 'eur', 'eurc', 'group-model', 'single-rail', 'fees'],
  verifies: 'EUR — single-rail since the 2026-09-19 VEUR retirement — is offered with exactly its one catalogued rail (EURC · Solana, ledger token · chain; no VEUR line, no IC chain, no detail copy), taps to a pick with NO in-card expansion (uniform with CHF: no detail panel, no Back), and Continue lands the wallet on EURC@Solana.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[129-eur-single-rail] setup…');
  const env = await setup({ lazyBoot: false, solStub: true });
  try {
    const {driver} = env;

    // --- 1. onboard by hand, and STOP at the currency question ---------------------------------
    console.log('[129-eur-single-rail] onboarding to the currency question…');
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-eur-detail', {timeoutMs: 8_000});
    await driver.click('btn-create', {timeoutMs: 4_000});
    await driver.findByTestID('mnemonic-backup', {timeoutMs: 8_000});
    await driver.click('mnemonic-backup-checkbox', {timeoutMs: 4_000});
    await waitForEnabled(driver, 'btn-mnemonic-continue', {timeoutMs: 4_000});
    await driver.click('btn-mnemonic-continue', {timeoutMs: 4_000});
    await skipPracticeIfPresent(driver);
    await driver.findByTestID('home-currency-title', {timeoutMs: 10_000});

    assert(await driver.isPresent('home-currency-EUR'),
      'EUR must be offered — EURC@Solana is a catalog row (its one rail since VEUR retired)');
    // Collapsed, the row names its ONE rail and NOTHING else: no fee, no health, no ramp copy —
    // and no trace of the retired IC rail, not even as a chain name.
    const collapsed = await driver.readText('home-currency-EUR');
    assertIncludes(collapsed, 'EURC · Solana', 'the collapsed EUR row names the Solana rail');
    assert(!collapsed.includes('VEUR'),
      `the retired VEUR rail must not survive anywhere on the row. Got: ${JSON.stringify(collapsed)}`);
    assert(!collapsed.includes('Internet Computer'),
      `an IC chain line would promise the rail the catalog retired. Got: ${JSON.stringify(collapsed)}`);
    for (const absent of ['Fee', 'Thin liquidity', 'Circulates', 'DFX', 'fiat ramp', 'sellable']) {
      assert(!collapsed.includes(absent),
        `the collapsed row carries no detail copy ("${absent}") — and a single-rail row never expands to any. Got: ${JSON.stringify(collapsed)}`);
    }
    console.log('[129-eur-single-rail] ✓ EUR offered; collapsed row names exactly its one rail and nothing more');

    // --- 2. tap → a pick, NEVER an expansion (uniform with CHF) ---------------------------------
    await driver.click('home-currency-EUR', {timeoutMs: 4_000});
    assert(!(await driver.isPresent('home-currency-detail')),
      'a single-rail currency (EUR, like CHF) must never open the in-card detail panel — there is nothing to compare');
    assert(!(await driver.isPresent('btn-home-currency-back')),
      'no detail panel means no Back link either');
    // The same rule still holds for the currency it always held for:
    await driver.click('home-currency-CHF', {timeoutMs: 4_000});
    assert(!(await driver.isPresent('home-currency-detail')),
      'CHF must never expand either — single-rail IA is uniform');
    console.log('[129-eur-single-rail] ✓ tap picks without expanding (EUR and CHF alike)');

    // --- 3. Continue commits: EUR lands the wallet on EURC@Solana -------------------------------
    await driver.click('home-currency-EUR', {timeoutMs: 4_000});
    await driver.click('btn-home-currency-continue', {timeoutMs: 4_000});
    await waitForWallet(driver, {timeoutMs: 10_000});
    // The wallet lands on HOME, and Home states the chosen currency in its own headline — the
    // header chip is not rendered there (it names the SELECTION, which is a different fact; see
    // flow 158). `home-headline-label` is the currency statement on this surface.
    const label = await driver.readText('home-headline-label');
    assertIncludes(label, 'Balance EUR', 'the headline names the CURRENCY (the eyebrow grammar)');
    assert(!(await driver.isPresent('home-currency-detail')),
      'the detail panel is a chooser surface — it must not leak into the wallet');
    // The home screen names the currency, not the token; the landed rail is proven in the Home
    // accounts list, where the MAIN badge sits on the EURC row — the only EUR rail there is.
    await openBalances(driver);
    assert(await driver.isPresent('currency-EUR-main'),
      'Continue commits EUR onto its one rail — EURC carries the MAIN badge');
    assert(!(await driver.isPresent('asset-veur')),
      'the retired VEUR rail renders NO row at all — not a sibling, not a landing');
    console.log(`[129-eur-single-rail] ✓ continue commits → wallet on EURC@Solana (${JSON.stringify(label)})`);

    console.log(`[129-eur-single-rail] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[129-eur-single-rail] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
