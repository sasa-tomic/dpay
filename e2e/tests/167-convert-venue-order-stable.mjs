// Flow 167 — V5 red line: venue row ORDER is quote-independent, and no selection ever appears
// on its own.
//
// Spec docs/specs/2026-09-08-multi-venue-readiness.md V5: rows render in a stable,
// quote-independent order — never sorted by output amount — and nothing auto-selects when rates
// move (no "obviously better" shortcut, no last-used memory). This flow mutates ONE venue's
// output mid-test via the EXISTING pool knob (POST /api/v1/test/swap_pool, impact_bps 10000
// floors the real pool's payout to zero — the most extreme re-rank temptation there is) and
// asserts the ROW ORDER and the no-selection state are unchanged after the re-fetch.
//
// Private relay (startRelay, the flow-164 pattern): the venue knob + pool mutation cannot reach
// any sibling flow.
import {setup, assert, assertEq, assertIncludes, assertDisabled, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON)
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai'; // the REAL venue's pool (the row that will be floored)
const FIXTURE_VENUE = 'icpswap-fixture-b';

export const meta = {
  id: '167',
  name: 'convert-venue-order-stable',
  journey: 'convert',
  covers: ['convert', 'venues', 'venue-chooser', 'registry-order', 'no-ranking', 'no-preselection', 'pool-knob'],
  verifies: 'Mutating each venue\'s output mid-test (the relay\'s pool knobs floor the real pool to zero, then re-price fixture B) does NOT move the chooser rows: registry order survives every re-fetch, nothing is ever preselected, and each row\'s displayed number follows its own venue\'s re-priced reply.',
  timeoutMs: 90000,
};

/** Unique row testIDs in DOM order (RN-web Pressable mirrors testID onto wrapper layers). */
async function rowOrder(driver) {
  const raw = await driver.eval(() =>
    Array.from(document.querySelectorAll('[data-testid]'))
      .map(el => el.getAttribute('data-testid'))
      .filter(id => id === 'convert-venue-icpswap' || id === 'convert-venue-icpswap-fixture-b'));
  return [...new Set(raw)];
}

export async function run() {
  const start = Date.now();
  console.log('[167-convert-order] setup (own relay + shared web + browser)…');
  const env = await setup();
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});

    console.log('[167-convert-order] onboarding + funding 3 ICP on the private relay…');
    await onboardWallet(driver, 'e2e-convert-order');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED, {currency: 8});
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);

    const arm = await fetch(`${r2.baseURL}/api/v1/test/venue`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({venue_id: FIXTURE_VENUE, served: true}),
    });
    assert(arm.ok, `venue knob armed (status ${arm.status})`);

    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', {timeoutMs: 6_000});
    await driver.type('convert-amount', '1');
    await driver.findByTestID(`convert-venue-${FIXTURE_VENUE}-quote`, {timeoutMs: 10_000});

    const before = await rowOrder(driver);
    assertEq(before.length, 2, 'exactly two venue rows render');
    const aBefore = await driver.readText('convert-venue-icpswap-quote');
    assertIncludes(aBefore, 'VCHF', 'the real venue quotes a healthy amount before the mutation');

    // Mutate ONE venue's output: the real pool's payout floors to zero (impact 10000). If
    // anything sorted rows by output, the now-worthless real venue would fall to row 2.
    console.log('[167-convert-order] flooring the real pool via the swap_pool knob (impact_bps 10000)…');
    const knob = await fetch(`${r2.baseURL}/api/v1/test/swap_pool`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({pool: POOL, impact_bps: 10000}),
    });
    assert(knob.ok, `swap_pool knob ok (status ${knob.status})`);

    // Re-key the amount (driver.type REPLACES the field) → both rows re-fetch their venues.
    // (fmtAsset renders a zero payout as "0 VCHF" — trailing-zero group collapses to "0".)
    await driver.type('convert-amount', '2');
    await driver.waitForFunction(() => {
      const el = document.querySelector('[data-testid="convert-venue-icpswap-quote"]');
      return el != null && /Quote: 0(\.0+)? VCHF/.test(el.textContent);
    }, {timeoutMs: 15_000});
    const aAfter = await driver.readText('convert-venue-icpswap-quote');
    assertIncludes(aAfter, 'VCHF', 'the mutated row really re-fetched (its quote is now zero)');

    // The fixture venue's OWN quote is untouched by the real pool's knob (nonzero output).
    const bAfter = await driver.readText(`convert-venue-${FIXTURE_VENUE}-quote`);
    assert(!/Quote: 0(\.0+)? VCHF/.test(bAfter), `the other row keeps its own healthy quote ("${bAfter}")`);
    assertIncludes(bAfter, 'VCHF', 'and still quotes the output asset');

    // THE RED LINE: order unchanged by the mutation + re-fetch…
    const after = await rowOrder(driver);
    assertEq(after.join('|'), before.join('|'), 'row order is quote-independent (registry order survives a zero-floor mutation)');

    // …and still NOTHING selected: no auto-pick of the now-obviously-better fixture venue.
    const selected = await driver.eval(() =>
      document.querySelectorAll('[data-testid="convert-venue-icpswap"][aria-checked="true"],[data-testid="convert-venue-icpswap-fixture-b"][aria-checked="true"]').length);
    assert(selected === 0, `no row self-selects when one venue collapses (found ${selected} checked)`);
    await assertDisabled(driver, 'btn-convert-confirm', 'confirm stays withheld — the user, not the rates, picks the venue');

    // V9 INVARIANT 4 (per-venue half): mutate the OTHER pool's own output the same way — the
    // fixture venue's row must follow ITS OWN venue's re-priced reply through relay echo →
    // app → rendered string, byte-identically (and the order still must not move).
    console.log('[167-convert-order] re-pricing fixture B via its own pool knob (fee 1000 → 4321)…');
    const knobB = await fetch(`${r2.baseURL}/api/v1/test/swap_pool`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({pool: '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7', fee_millionths: 4321}),
    });
    assert(knobB.ok, `fixture-B swap_pool knob ok (status ${knobB.status})`);
    await driver.type('convert-amount', '3');
    let bMoved = null;
    for (let i = 0; i < 40 && bMoved === null; i++) {
      const t = await driver.readText('convert-venue-icpswap-fixture-b-quote');
      if (t !== bAfter && t.includes('VCHF')) bMoved = t;
      else await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert(bMoved !== null, `fixture B's row followed its own venue's re-priced reply ("${bAfter}" → "${bMoved}")`);
    const afterB = await rowOrder(driver);
    assertEq(afterB.join('|'), before.join('|'), 'row order survives BOTH venues being re-priced');
    await assertDisabled(driver, 'btn-convert-confirm', 'confirm still withheld after both re-pricings');

    await driver.screenshot('167-convert-order-stable');
    console.log(`[167-convert-order] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => {
    console.log('[167-convert-order] standalone run complete');
    process.exit(0);
  }).catch((e) => {
    console.error('[167-convert-order] FAILED:', e);
    process.exit(1);
  });
}
