// Flow 129 — the EUR dual-rail detail: the chooser's inline expansion (Stage 4+5 of the
// founder-approved EUR dual-rail addition, docs/specs 2026-09-04-currency-first-wallet-plan.md).
//
// EUR is the first currency whose two rails differ in more than chain: EURC@Solana is catalogued
// DEEP, VEUR@IC is THIN and sellable only through DFX. This flow pins that the chooser states
// those differences as FACTS, inside the card, on demand:
//
//   * Tapping the EUR row EXPANDS a detail panel inside the card — both rails in preference
//     order, the preferred one carrying its reason. A single-rail currency (CHF) NEVER expands:
//     there is nothing to compare, and its confirm path stays exactly as it was.
//   * Every line in the panel renders a catalog field: the fee in the rail's OWN unit (SOL+rent
//     for EURC, e8s VEUR for VEUR), the liquidity tier (thin warns, deep states plainly), the
//     ramp capability (DFX sell-only on VEUR, wallet-to-wallet on EURC). No adjectives a field
//     cannot back.
//   * Back collapses the panel WITHOUT unpicking the row; Continue still commits, and EUR lands
//     the wallet on EURC@Solana — the stated preference, not the catalog's enumeration order.
import {
  setup, assert, assertEq, assertIncludes, waitForEnabled, skipWalkthroughIfPresent, skipRehearsalIfPresent,
  openBalances,
} from '../harness/lib.mjs';

export const meta = {
  id: '129',
  name: 'eur-rail-detail',
  journey: 'onboard',
  covers: ['home-currency', 'onboard', 'eur', 'eurc', 'veur', 'group-model', 'rail-detail', 'fees'],
  verifies: 'Tapping the EUR row expands an in-card detail panel: both rails preferred-first (EURC reason on the pick only), fee facts in each rail\'s own units, thin-warn on VEUR vs deep on EURC, DFX sell-only ramp on VEUR; Back collapses without unpicking; CHF never expands; Continue lands the wallet on EURC@Solana.',
  timeoutMs: 30000,
};

export async function run() {
  const start = Date.now();
  console.log('[129-eur-rail-detail] setup…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    // --- 1. onboard by hand, and STOP at the currency question ---------------------------------
    console.log('[129-eur-rail-detail] onboarding to the currency question…');
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-eur-detail', {timeoutMs: 8_000});
    await driver.click('btn-create', {timeoutMs: 4_000});
    await driver.findByTestID('mnemonic-backup', {timeoutMs: 8_000});
    await driver.click('mnemonic-backup-checkbox', {timeoutMs: 4_000});
    await waitForEnabled(driver, 'btn-mnemonic-continue', {timeoutMs: 4_000});
    await driver.click('btn-mnemonic-continue', {timeoutMs: 4_000});
    await skipRehearsalIfPresent(driver);
    await driver.findByTestID('home-currency-title', {timeoutMs: 10_000});

    assert(await driver.isPresent('home-currency-EUR'),
      'EUR must be offered — both its rails are catalog rows now');
    // Collapsed, the row names its rails and NOTHING else: no fee, no health, no ramp copy.
    const collapsed = await driver.readText('home-currency-EUR');
    assertIncludes(collapsed, 'EURC · Solana', 'the collapsed EUR row names the Solana rail');
    assertIncludes(collapsed, 'VEUR · Internet Computer', 'the collapsed EUR row names the IC rail');
    for (const absent of ['Fee', 'Very little', 'Circulates', 'DFX', 'fiat ramp', 'sellable']) {
      assert(!collapsed.includes(absent),
        `the collapsed row carries no detail copy ("${absent}") — detail is one tap away, not noise. Got: ${JSON.stringify(collapsed)}`);
    }
    console.log('[129-eur-rail-detail] ✓ EUR offered; collapsed row names both rails and nothing more');

    // --- 2. tap → the detail panel, both rails, preferred first ---------------------------------
    await driver.click('home-currency-EUR', {timeoutMs: 4_000});
    await driver.findByTestID('home-currency-detail', {timeoutMs: 5_000});
    assert(await driver.isPresent('rail-detail-sol-eurc'), 'the EURC rail block is present');
    assert(await driver.isPresent('rail-detail-veur'), 'the VEUR rail block is present');
    const panel = await driver.readText('home-currency-detail');
    assert(panel.indexOf('EURC') < panel.indexOf('VEUR'),
      `the preferred rail (EURC) must be first in the panel. Got: ${JSON.stringify(panel)}`);
    assertIncludes(await driver.readText('rail-detail-sol-eurc'), "EURC · Solana — dpay's default rail",
      'the pick carries its reason (chooseRail: preference on a fresh wallet)');
    const veurBlock = await driver.readText('rail-detail-veur');
    assert(!veurBlock.includes('— dpay'),
      `only the PICK carries a reason; the sibling states facts. Got: ${JSON.stringify(veurBlock)}`);
    assertIncludes(veurBlock, 'VEUR · Internet Computer', 'the sibling names its rail');
    // Chain tags: the settlement chain as a pill, proper noun, uppercase.
    assertIncludes(veurBlock, 'IC', 'the VEUR block tags the Internet Computer');
    assertIncludes(await driver.readText('rail-detail-sol-eurc'), 'SOLANA', 'the EURC block tags Solana');
    console.log('[129-eur-rail-detail] ✓ detail panel: both rails, preferred-first with its reason');

    // --- 3. every panel line is a catalog field, in the rail's OWN units ------------------------
    assertEq((await driver.readText('rail-detail-fee-sol-eurc')).trim(),
      'Solana · Fee 0.000005000 SOL + one-time account rent 0.002039280 SOL',
      'the EURC fee fact: signature fee + the ATA rent (EURC states its one-time rent too), in SOL');
    assertEq((await driver.readText('rail-detail-fee-veur')).trim(),
      'Internet Computer · Fee 0.00010000 VEUR',
      'the VEUR fee fact: the catalog row\'s 10000-e8s transfer fee, in VEUR\'s own 8 decimals');
    assertEq((await driver.readText('rail-detail-liquidity-sol-eurc')).trim(),
      'Circulates widely on-chain today.',
      'EURC\'s deep tier states plainly (no caution icon on a good fact)');
    assertIncludes(await driver.readText('rail-detail-liquidity-veur'), 'Very little VEUR exists on-chain today',
      'VEUR\'s thin tier warns, naming the LEDGER token (VEUR, never a bare "EUR")');
    assertIncludes(await driver.readText('rail-detail-ramp-veur'), 'DFX lists this token as sellable; buying is not available today.',
      'VEUR\'s ramp fact: Partner offramp naming DFX, onramp Unavailable — sell-only, stated as such');
    assertEq((await driver.readText('rail-detail-ramp-sol-eurc')).trim(),
      'No fiat ramp today — it moves wallet to wallet.',
      'EURC\'s ramp fact: no ramp claimed where none exists');
    await driver.screenshot('129-eur-detail-panel');
    console.log('[129-eur-rail-detail] ✓ per-rail facts: fees in own units, liquidity tiers, ramp capabilities');

    // --- 4. Back collapses without unpicking; CHF NEVER expands ---------------------------------
    await driver.click('btn-home-currency-back', {timeoutMs: 4_000});
    await driver.waitGone('home-currency-detail', {timeoutMs: 5_000});
    assertIncludes(await driver.readText('home-currency-EUR'), 'EURC · Solana',
      'the row stays picked after Back — collapsing is not unpicking');
    await driver.click('home-currency-CHF', {timeoutMs: 4_000});
    await driver.waitGone('home-currency-detail', {timeoutMs: 3_000});
    assert(!(await driver.isPresent('btn-home-currency-back')),
      'a single-rail currency (CHF) must never expand — there is nothing to compare');
    console.log('[129-eur-rail-detail] ✓ Back collapses, row stays picked; CHF never expands');

    // --- 5. Continue commits: EUR lands the wallet on EURC@Solana -------------------------------
    await driver.click('home-currency-EUR', {timeoutMs: 4_000});
    await driver.click('btn-home-currency-continue', {timeoutMs: 4_000});
    await driver.findByTestID('balance', {timeoutMs: 10_000});
    const label = await driver.readText('active-asset-label');
    assertIncludes(label, 'uros', 'the header names the CURRENCY (euros), not the token');
    assert(!(await driver.isPresent('home-currency-detail')),
      'the detail panel is a chooser surface — it must not leak into the wallet');
    // The home screen names the currency, not the token; the landed RAIL is proven in Balances,
    // where the main badge sits on the EURC row (chooseRail's preference — the deep rail).
    await openBalances(driver);
    assert(await driver.isPresent('asset-sol-eurc-main'),
      'Continue commits EUR onto its preferred rail — EURC carries the MAIN badge');
    assert(!(await driver.isPresent('asset-veur-main')),
      'VEUR — the thin rail — is the named sibling, never the landing');
    console.log(`[129-eur-rail-detail] ✓ continue commits → wallet on EURC@Solana (${JSON.stringify(label)})`);

    console.log(`[129-eur-rail-detail] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[129-eur-rail-detail] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
