// Flow 130 — the EUR group in the Home accounts list: two named rows, health note on the THIN rail only
// (Stage 5 of the EUR dual-rail addition).
//
// Flow 129 pinned the chooser's detail; this flow pins the sheet where the money lives:
//   * home=EUR keeps EURC (MAIN) and VEUR (named rail badge) as two DISTINCT rows — never one
//     summed balance (the founder's honesty rule, same as USD in flow 121).
//   * The rail-health note is ONE shared row-footer, rendered in warn tone — so it appears on
//     VEUR (thin) and on NOBODY else: not on EURC (deep — a caution icon on "circulates widely"
//     would contradict itself), not on untiered rows (VCHF, SOL, USDC say nothing they cannot
//     back), not on non-EUR rows.
//   * No badge colours change and no group total appears — the note is text, not chrome.
import {
  setup, assert, assertIncludes, waitForEnabled, skipWalkthroughIfPresent, skipRehearsalIfPresent,
  openBalances,
} from '../harness/lib.mjs';

export const meta = {
  id: '130',
  name: 'eur-balances-rails',
  journey: 'onboard',
  covers: ['home-currency', 'balances', 'eur', 'eurc', 'veur', 'vchf', 'group-model', 'rail-health'],
  verifies: 'home=EUR in the Home accounts list: EURC carries MAIN and VEUR a named rail badge as distinct rows with no group sum; the thin-liability note renders on VEUR ONLY (warn tone) — EURC/VCHF/other rows carry none.',
  timeoutMs: 30000,
};

export async function run() {
  const start = Date.now();
  console.log('[130-eur-balances-rails] setup…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    // --- 1. onboard by hand, choose EUR, land on its preferred rail ------------------------------
    console.log('[130-eur-balances-rails] onboarding with home=EUR…');
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-eur-balances', {timeoutMs: 8_000});
    await driver.click('btn-create', {timeoutMs: 4_000});
    await driver.findByTestID('mnemonic-backup', {timeoutMs: 8_000});
    await driver.click('mnemonic-backup-checkbox', {timeoutMs: 4_000});
    await waitForEnabled(driver, 'btn-mnemonic-continue', {timeoutMs: 4_000});
    await driver.click('btn-mnemonic-continue', {timeoutMs: 4_000});
    await skipRehearsalIfPresent(driver);
    await driver.findByTestID('home-currency-title', {timeoutMs: 10_000});
    await driver.click('home-currency-EUR', {timeoutMs: 4_000});
    await driver.click('btn-home-currency-continue', {timeoutMs: 4_000});
    await driver.findByTestID('balance', {timeoutMs: 10_000});

    // --- 2. both EUR rails are distinct rows: MAIN on EURC, VEUR named ---------------------------
    await openBalances(driver);
    assert(await driver.isPresent('asset-sol-eurc'),
      'the preferred EUR rail (EURC@Solana) must have its own row');
    assert(await driver.isPresent('asset-veur'),
      'the sibling EUR rail (VEUR@IC) must ALSO have its own row — two rails are two rows, never one');
    assert(await driver.isPresent('asset-sol-eurc-main'),
      'the preferred rail (EURC) carries the MAIN badge');
    assert(!(await driver.isPresent('asset-sol-eurc-rail')),
      'the preferred rail carries MAIN only, not both badges');
    assert(!(await driver.isPresent('asset-veur-main')),
      'the sibling rail must NOT wear a second MAIN badge');
    assert(await driver.isPresent('asset-veur-rail'),
      'the sibling rail carries a rail badge');
    assertIncludes(await driver.readText('asset-veur-rail'), 'VEUR · Internet Computer',
      'the sibling badge NAMES its rail (ledger token · settlement chain)');
    console.log('[130-eur-balances-rails] ✓ EUR group: two rows, MAIN on EURC, VEUR named');

    // --- 3. the health note: on the THIN rail only ------------------------------------------------
    const veurRow = await driver.readText('asset-veur');
    assertIncludes(veurRow, 'Very little VEUR exists on-chain today',
      'the thin rail carries the warn note, naming the LEDGER token');
    assertIncludes(veurRow, 'receiving can be hard',
      'the warn note states what thin liquidity MEANS for the user, not a bare tier label');
    const eurcRow = await driver.readText('asset-sol-eurc');
    assert(!eurcRow.includes('Very little') && !eurcRow.includes('Circulates widely'),
      `the deep rail carries NO health line in the accounts list (warn tone renders nothing on deep). Got: ${JSON.stringify(eurcRow)}`);
    const vchfRow = await driver.readText('asset-vchf');
    assert(!vchfRow.includes('Very little') && !vchfRow.includes('Circulates widely'),
      `an untiered row (VCHF) states nothing — no tier, no copy. Got: ${JSON.stringify(vchfRow)}`);
    const solRow = await driver.readText('asset-sol');
    assert(!solRow.includes('Very little') && !solRow.includes('Circulates widely'),
      `native SOL states nothing either. Got: ${JSON.stringify(solRow)}`);
    await driver.screenshot('130-eur-balance-rails');

    // --- 4. nothing summed, no chrome change -------------------------------------------------------
    const sheet = await driver.bodyText();
    assert(!/\btotal\b/i.test(sheet),
      `a two-rail currency must never be summed. Got: ${JSON.stringify(sheet.slice(0, 400))}`);
    assert(!(await driver.isPresent('balances-group-total')),
      'no group-total element may exist for the EUR group');
    console.log('[130-eur-balances-rails] ✓ health note scoped to VEUR; nothing summed');

    console.log(`[130-eur-balances-rails] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[130-eur-balances-rails] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
