// Flow 167 — V5 red line: venue row ORDER is quote-independent, and no selection ever appears
// on its own — in BOTH dynamic directions.
//
// Spec docs/specs/2026-09-08-multi-venue-readiness.md V5: rows render in a stable,
// quote-independent order — never sorted by output amount — and nothing auto-selects when rates
// move (no "obviously better" shortcut, no last-used memory). This flow mutates each venue's
// output mid-test via the EXISTING pool knobs (POST /api/v1/test/swap_pool) and asserts the ROW
// ORDER and the no-selection state survive every re-fetch, in both phases:
//   phase 1: the real pool floors to zero (impact_bps 10000) → the NON-FIRST venue is strictly
//            best; then fixture B re-prices (fee 1000 → 4321) under the same rule.
//   phase 2 (the opposite): the real pool RESTORES while fixture B floors → the FIRST venue is
//            strictly better than the second. Registry order is the stable IDENTITY; best-rate
//            is only a per-row affordance — if anything ever ranked rows by output (or parked
//            the best rate on top), one of the two phases catches it.
//
// Private relay (startRelay, the flow-164 pattern): the venue knob + pool mutations cannot reach
// any sibling flow.
import {setup, assert, assertEq, assertIncludes, assertDisabled, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency, openConvertFor,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON)
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai'; // the REAL venue's pool (the row that will be floored)
const POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7'; // fixture B's own pool
const FIXTURE_VENUE = 'icpswap-fixture-b';

export const meta = {
  id: '167',
  name: 'convert-venue-order-stable',
  journey: 'convert',
  covers: ['convert', 'venues', 'venue-chooser', 'registry-order', 'no-ranking', 'no-preselection', 'pool-knob'],
  verifies: 'Mutating each venue\'s output mid-test (the relay\'s pool knobs floor the real pool to zero, re-price fixture B, then floor fixture B while the real pool restores) does NOT move the chooser rows in EITHER direction — non-first-best or first-best: registry order survives every re-fetch, nothing is ever preselected, and each row\'s displayed number follows its own venue\'s re-priced reply.',
  timeoutMs: 120000,
};

/** Unique row testIDs in DOM order (RN-web Pressable mirrors testID onto wrapper layers). */
async function rowOrder(driver) {
  const raw = await driver.eval(() =>
    Array.from(document.querySelectorAll('[data-testid]'))
      .map(el => el.getAttribute('data-testid'))
      .filter(id => id === 'convert-venue-icpswap' || id === 'convert-venue-icpswap-fixture-b'));
  return [...new Set(raw)];
}

/** Per-venue SELECTED state, read structurally: this RNW version does not project
  * accessibilityState → aria-checked (the documented flow-85 gap), but the row Pressable renders
  * the radio DOT (a 10×10px rounded brand View) ONLY when `on` is true — so the dot IS the
  * rendered selection. Returns [realSelected, fixtureSelected] booleans. */
function rowsWithDot(driver) {
  return driver.eval(() =>
    ['icpswap', 'icpswap-fixture-b'].map((vid) => {
      const row = document.querySelector(`[data-testid="convert-venue-${vid}"]`);
      if (!row) return false;
      return Array.from(row.querySelectorAll('div')).some((d) => {
        const s = getComputedStyle(d);
        return parseFloat(s.width) === 10 && parseFloat(s.height) === 10 && parseFloat(s.borderRadius) === 5;
      });
    }));
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

    await openConvertFor(driver, 'icp');
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
    // (The compact formatter renders a zero payout as "0 VCHF" — trailing-zero group collapses
    // to "0" — and the "Quote: " prefix is GONE (verbosity pass 2026-09-16), so the zero-row
    // probe anchors the WHOLE row text: a bare "0 VCHF", never a suffix of a bigger number.
    // NOTE: the regex must be INLINED inside waitForFunction callbacks — they run in the PAGE
    // context, where flow-side consts do not exist.)
    const ZERO_Q = /^0(\.0+)? VCHF$/;
    await driver.type('convert-amount', '2');
    await driver.waitForFunction(() => {
      const el = document.querySelector('[data-testid="convert-venue-icpswap-quote"]');
      return el != null && /^0(\.0+)? VCHF$/.test(el.textContent.trim());
    }, {timeoutMs: 15_000});
    const aAfter = await driver.readText('convert-venue-icpswap-quote');
    assertIncludes(aAfter, 'VCHF', 'the mutated row really re-fetched (its quote is now zero)');

    // The fixture venue's OWN quote is untouched by the real pool's knob (nonzero output).
    const bAfter = await driver.readText(`convert-venue-${FIXTURE_VENUE}-quote`);
    assert(!ZERO_Q.test(bAfter.trim()), `the other row keeps its own healthy quote ("${bAfter}")`);
    assertIncludes(bAfter, 'VCHF', 'and still quotes the output asset');

    // THE RED LINE: order unchanged by the mutation + re-fetch…
    const after = await rowOrder(driver);
    assertEq(after.join('|'), before.join('|'), 'row order is quote-independent (registry order survives a zero-floor mutation)');

    // …and still NOTHING selected: no auto-pick of the now-obviously-better fixture venue
    // (radio-dot probe — see rowsWithDot for why not aria-checked).
    const selected = await rowsWithDot(driver);
    assert(selected.every(v => v === false), `no row self-selects when one venue collapses (radio-dot probe: [${selected.join(', ')}])`);
    await assertDisabled(driver, 'btn-convert-confirm', 'confirm stays withheld — the user, not the rates, picks the venue');

    // V9 INVARIANT 4 (per-venue half): mutate the OTHER pool's own output the same way — the
    // fixture venue's row must follow ITS OWN venue's re-priced reply through relay echo →
    // app → rendered string, byte-identically (and the order still must not move).
    console.log('[167-convert-order] re-pricing fixture B via its own pool knob (fee 1000 → 4321)…');
    const knobB = await fetch(`${r2.baseURL}/api/v1/test/swap_pool`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({pool: POOL_B, fee_millionths: 4321}),
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

    // --- PHASE 2 — the OPPOSITE direction: the FIRST venue strictly better than the second. ------
    // Restore the real pool (impact back to 0, fee back to its 3000 seed) and floor FIXTURE B
    // instead. Now the registry's FIRST row is the obviously-better one — the mirror-image
    // temptation: a UI that "helpfully" parks the best rate on top, or that re-orders by output
    // in either direction, fails HERE. The rows must stay in registry order with the now-worthless
    // fixture still in slot 2, still nothing preselected, still no confirm: registry order is the
    // stable IDENTITY, best-rate is only a per-row affordance.
    console.log('[167-convert-order] opposite phase: restore the real pool, floor fixture B…');
    const knobA2 = await fetch(`${r2.baseURL}/api/v1/test/swap_pool`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({pool: POOL, impact_bps: 0, fee_millionths: 3000}),
    });
    assert(knobA2.ok, `real-pool restore knob ok (status ${knobA2.status})`);
    const knobB2 = await fetch(`${r2.baseURL}/api/v1/test/swap_pool`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({pool: POOL_B, impact_bps: 10000}),
    });
    assert(knobB2.ok, `fixture-B floor knob ok (status ${knobB2.status})`);

    // Re-key → both rows re-fetch: the real venue must come back HEALTHY (nonzero) while fixture
    // B collapses to zero — only then is "first strictly better" true and the phase meaningful.
    await driver.type('convert-amount', '4');
    await driver.waitForFunction(() => {
      const a = document.querySelector('[data-testid="convert-venue-icpswap-quote"]');
      const b = document.querySelector('[data-testid="convert-venue-icpswap-fixture-b-quote"]');
      return a != null && b != null
        && !/^0(\.0+)? VCHF$/.test(a.textContent.trim())
        && /^0(\.0+)? VCHF$/.test(b.textContent.trim());
    }, {timeoutMs: 15_000});
    const aRestored = await driver.readText('convert-venue-icpswap-quote');
    assertIncludes(aRestored, 'VCHF', 'the real venue restored to a healthy quote');
    assert(!ZERO_Q.test(aRestored.trim()), `the real venue is the strictly-better row now ("${aRestored}")`);

    const afterOpposite = await rowOrder(driver);
    assertEq(afterOpposite.join('|'), before.join('|'),
      'row order survives the OPPOSITE phase too (first venue strictly best — registry order, never rate order)');
    const selectedOpposite = await rowsWithDot(driver);
    assert(selectedOpposite.every(v => v === false), `no row self-selects when the FIRST venue is strictly best (radio-dot probe: [${selectedOpposite.join(', ')}])`);
    await assertDisabled(driver, 'btn-convert-confirm', 'confirm still withheld in the opposite phase — the user picks, not the rates');

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
