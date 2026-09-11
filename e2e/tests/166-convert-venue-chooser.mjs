// Flow 166 — V5 venue chooser: two venues on one pair render with NOTHING preselected.
//
// Spec docs/specs/2026-09-08-multi-venue-readiness.md V5: when a pair has two venues, the screen
// must show N rows in a STABLE, quote-independent order (registry order), each row carrying its
// OWN quote with attribution + timestamp, and NO row preselected — the red lines: never rank by
// output, never auto-pick the "obviously better" venue, never default to last-used. The
// checklist + confirm stay gated on an explicit pick.
//
// The two-venue world exists only on this flow's OWN relay (startRelay — the same pattern flow
// 164 uses): the second fixture venue `icpswap-fixture-b` is served by the test-helpers gateway
// ONLY while POST /api/v1/test/venue arms it, so the shared suite relay (flows 140–145) never
// sees a second venue and the default experience stays ONE venue per pair.
import {setup, assert, assertEq, assertIncludes, assertDisabled, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON)
const FIXTURE_VENUE = 'icpswap-fixture-b';

export const meta = {
  id: '166',
  name: 'convert-venue-chooser',
  journey: 'convert',
  covers: ['convert', 'venues', 'venue-chooser', 'no-preselection', 'quote-attribution', 'registry-order'],
  verifies: 'With two venues served on one pair (test-helpers knob on a private relay), the chooser renders both rows in registry order, each with its OWN quote attributed + timestamped; no row is preselected, and the headline/checklist/confirm stay withheld until the user picks one.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[166-convert-chooser] setup (own relay + shared web + browser)…');
  const env = await setup();
  const r2 = await startRelay(); // own fake-IC gateway: the venue knob cannot touch any sibling flow
  try {
    const {driver, webBaseURL} = env;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});

    console.log('[166-convert-chooser] onboarding + funding 3 ICP on the private relay…');
    await onboardWallet(driver, 'e2e-convert-chooser');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED, {currency: 8});
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);

    // Arm the second venue BEFORE the convert surface mounts (it loads /api/v1/venues on mount).
    const arm = await fetch(`${r2.baseURL}/api/v1/test/venue`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({venue_id: FIXTURE_VENUE, served: true}),
    });
    assert(arm.ok, `venue knob armed (status ${arm.status}: ${await arm.text()})`);

    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', {timeoutMs: 6_000});
    await driver.type('convert-amount', '1');
    await driver.findByTestID('convert-venues', {timeoutMs: 10_000});
    // Both rows must have their OWN quote before absence claims mean anything.
    await driver.findByTestID(`convert-venue-${FIXTURE_VENUE}-quote`, {timeoutMs: 10_000});
    await driver.findByTestID('convert-venue-icpswap-quote', {timeoutMs: 10_000});

    // Row order is REGISTRY order (dedup: RN-web Pressable mirrors testID onto wrapper layers).
    const orderRaw = await driver.eval(() =>
      Array.from(document.querySelectorAll('[data-testid]'))
        .map(el => el.getAttribute('data-testid'))
        .filter(id => id === 'convert-venue-icpswap' || id === 'convert-venue-icpswap-fixture-b'));
    const order = [...new Set(orderRaw)];
    assertEq(order.length, 2, 'exactly two venue rows render');
    assert(order[0] === 'convert-venue-icpswap' && order[1] === `convert-venue-${FIXTURE_VENUE}`,
      `rows keep registry order (real venue first), got [${order.join(', ')}]`);

    // Each row carries its OWN quote, attributed + timestamped (the venue's display name + the
    // relay's fetched_at — never the device receipt time).
    const rowA = await driver.readText('convert-venue-icpswap-quote');
    const rowB = await driver.readText(`convert-venue-${FIXTURE_VENUE}-quote`);
    assertIncludes(rowA, 'Quote:', 'the real venue row shows its own quote');
    assertIncludes(rowA, 'VCHF', 'the real venue row quotes the output asset');
    assertIncludes(rowB, 'Quote:', 'the fixture venue row shows its own quote');
    assertIncludes(rowB, 'VCHF', 'the fixture venue row quotes the output asset');
    assertIncludes(await driver.readText(`convert-venue-${FIXTURE_VENUE}-source`), 'Quote from ICPSwap (offline fixture), fetched',
      'the fixture row is attributed + timestamped');
    assertIncludes(await driver.readText('convert-venue-icpswap-source'), 'Quote from ICPSwap, fetched',
      'the real row is attributed + timestamped');

    // NONE preselected: no row is checked, the none-selected line shows, and every surface that
    // follows a pick (headline, checklist, confirm) is absent or disabled.
    const selected = await driver.eval(() =>
      document.querySelectorAll('[data-testid="convert-venue-icpswap"][aria-checked="true"],[data-testid="convert-venue-icpswap-fixture-b"][aria-checked="true"]').length);
    assert(selected === 0, `no venue row is preselected (found ${selected} checked)`);
    const noneLine = await driver.findByTestID('convert-venue-none', {timeoutMs: 2_000});
    assert(noneLine != null, 'the none-selected guidance line renders');
    assertIncludes(await driver.readText('convert-venue-none'), 'Select a venue', 'the guidance line tells the user to pick');
    assert(await driver.findByTestID('convert-headline', {timeoutMs: 1_000}).catch(() => null) == null,
      'no headline before a pick (the user has chosen nothing)');
    assert(await driver.findByTestID('convert-counterparty', {timeoutMs: 1_000}).catch(() => null) == null,
      'no checklist disclosure before a pick');
    await assertDisabled(driver, 'btn-convert-confirm', 'confirm is withheld until a venue is picked');

    await driver.screenshot('166-convert-chooser');
    console.log(`[166-convert-chooser] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => {
    console.log('[166-convert-chooser] standalone run complete');
    process.exit(0);
  }).catch((e) => {
    console.error('[166-convert-chooser] FAILED:', e);
    process.exit(1);
  });
}
