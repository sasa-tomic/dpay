// Flow 173 — the V5 order/no-preselection red lines in the REVERSE direction (VCHF → ICP).
//
// Flow 167 pins order-stability for ICP → VCHF only; the reverse leg is NOT redundant. It is the
// direction where `zero_for_one` flips on BOTH pools — and the two venues' pools legitimately
// DISAGREE about which side is token0 (the fixture-B pool declares the pair the other way round,
// ic_gateway.rs) — so any direction-derivation or ranking bug that hides behind the forward
// orientation surfaces only here. Same spec (docs/specs/2026-09-08-multi-venue-readiness.md V5):
// rows render in a stable, quote-independent REGISTRY order — never sorted by output — and
// nothing auto-selects when rates move. Mirrors 167's two dominance phases with the same pool
// knobs, so each venue takes a turn being strictly worse:
//   phase 1: the REAL pool floors to zero (impact_bps 10000) → the NON-FIRST venue (fixture B)
//            is strictly best — a UI that ranked by output or parked the best rate on top fails;
//   phase 2: the real pool RESTORES while fixture B floors → the FIRST venue is strictly better —
//            the mirror-image temptation fails the same invariant.
// The from-asset is VCHF (selected in the accounts route), so the legs resolve in=VCHF/out=ICP
// (resolveConvertDirection walks the SAME unordered pair the other way) and every row quotes ICP.
//
// Private relay (startRelay, the flow-164/166/167 pattern): the venue knob + pool mutations
// cannot reach any sibling flow.
import {setup, assert, assertEq, assertIncludes, assertDisabled, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const SEED = 1_000_000_000; // 10 VCHF (8 decimals, plain Number — the faucet body is JSON) — enough
// that the re-keyed amounts (1–3 VCHF + 2× input fee) never trip the insufficient-funds gate,
// which would disable confirm for a reason this flow does not assert on.
const VCHF_CURRENCY = 7; // the catalog row id the faucet funds (VCHF; ICP is 8)
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai'; // the REAL venue's pool (the row floored in phase 1)
const POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7'; // fixture B's own pool (floored in phase 2)
const FIXTURE_VENUE = 'icpswap-fixture-b';

export const meta = {
  id: '173',
  name: 'convert-order-reverse',
  journey: 'convert',
  covers: ['convert', 'venues', 'venue-chooser', 'registry-order', 'no-ranking', 'no-preselection', 'pool-knob', 'reverse-direction', 'vchf'],
  verifies: 'The chooser\'s order/no-preselection red lines hold in the REVERSE direction (VCHF → ICP): with both venues armed on a private relay, flooring the real pool and then flooring fixture B instead — each venue taking a turn being strictly worse — never moves the rows off registry order, never auto-selects a row (radio-dot probe), and confirm stays disabled until the user picks.',
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
  console.log('[173-convert-order-reverse] setup (own relay + shared web + browser)…');
  const env = await setup();
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});

    console.log('[173-convert-order-reverse] onboarding + funding 10 VCHF on the private relay…');
    await onboardWallet(driver, 'e2e-convert-reverse');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED, {currency: VCHF_CURRENCY});
    assert(fund.ok, `faucet VCHF credit ok (status ${fund.status})`);

    // Arm the second venue BEFORE the convert surface mounts (it loads /api/v1/venues on mount).
    const arm = await fetch(`${r2.baseURL}/api/v1/test/venue`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({venue_id: FIXTURE_VENUE, served: true}),
    });
    assert(arm.ok, `venue knob armed (status ${arm.status})`);

    // The REVERSE direction: VCHF is the from-asset. selectCurrency leaves the app on Pay;
    // re-open the accounts route so Convert renders on the SELECTED (VCHF) row — resolveLegs then
    // resolves in=VCHF / out=ICP and every venue row quotes its output in ICP.
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', {timeoutMs: 6_000});
    await driver.type('convert-amount', '1');
    await driver.findByTestID(`convert-venue-${FIXTURE_VENUE}-quote`, {timeoutMs: 10_000});
    await driver.findByTestID('convert-venue-icpswap-quote', {timeoutMs: 10_000});

    const before = await rowOrder(driver);
    assertEq(before.length, 2, 'exactly two venue rows render in the reverse direction');
    assertEq(before.join('|'), 'convert-venue-icpswap|convert-venue-icpswap-fixture-b',
      'rows keep REGISTRY order (real venue first) — order is direction-independent');
    const aBefore = await driver.readText('convert-venue-icpswap-quote');
    assertIncludes(aBefore, 'ICP', 'the real venue quotes the reverse output asset before the mutation');

    // --- PHASE 1 — the NON-FIRST venue strictly best: floor the real pool via the swap_pool knob.
    // The impact haircut multiplies the OUTPUT regardless of direction, so impact 10000 zeroes
    // the row in the reverse orientation too. If anything sorted rows by output, the now-worthless
    // real venue would fall to row 2.
    console.log('[173-convert-order-reverse] phase 1: flooring the real pool via the swap_pool knob (impact_bps 10000)…');
    const knob = await fetch(`${r2.baseURL}/api/v1/test/swap_pool`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({pool: POOL, impact_bps: 10000}),
    });
    assert(knob.ok, `swap_pool knob ok (status ${knob.status})`);

    // Re-key the amount (driver.type REPLACES the field) → both rows re-fetch their venues.
    // (The compact formatter renders a zero payout as "0 ICP" — trailing-zero group collapses
    // to "0" — and the "Quote: " prefix is GONE (verbosity pass 2026-09-16), so the zero-row
    // probe anchors the WHOLE row text: a bare "0 ICP", never a suffix of a bigger number.
    // NOTE: the regex must be INLINED inside waitForFunction callbacks — they run in the PAGE
    // context, where flow-side consts do not exist.)
    const ZERO_Q = /^0(\.0+)? ICP$/;
    await driver.type('convert-amount', '2');
    await driver.waitForFunction(() => {
      const el = document.querySelector('[data-testid="convert-venue-icpswap-quote"]');
      return el != null && /^0(\.0+)? ICP$/.test(el.textContent.trim());
    }, {timeoutMs: 15_000});
    const aAfter = await driver.readText('convert-venue-icpswap-quote');
    assertIncludes(aAfter, 'ICP', 'the mutated row really re-fetched (its reverse quote is now zero)');

    // The fixture venue's OWN quote is untouched by the real pool's knob (nonzero output).
    const bAfter = await driver.readText(`convert-venue-${FIXTURE_VENUE}-quote`);
    assert(!ZERO_Q.test(bAfter.trim()), `the other row keeps its own healthy quote ("${bAfter}")`);
    assertIncludes(bAfter, 'ICP', 'and still quotes the reverse output asset');

    // THE RED LINE: order unchanged by the mutation + re-fetch…
    const after = await rowOrder(driver);
    assertEq(after.join('|'), before.join('|'), 'row order is quote-independent in the reverse direction (registry order survives a zero-floor mutation)');

    // …and still NOTHING selected: no auto-pick of the now-obviously-better fixture venue.
    const selected = await rowsWithDot(driver);
    assert(selected.every(v => v === false), `no row self-selects when one venue collapses (radio-dot probe: [${selected.join(', ')}])`);
    await assertDisabled(driver, 'btn-convert-confirm', 'confirm stays withheld — the user, not the rates, picks the venue');

    // --- PHASE 2 — the OPPOSITE direction: the FIRST venue strictly better than the second. ------
    // Restore the real pool (only impact was mutated — fee was never touched) and floor FIXTURE B
    // instead. Now the registry's FIRST row is the obviously-better one — the mirror-image
    // temptation: a UI that "helpfully" parks the best rate on top, or that re-orders by output
    // in either direction, fails HERE. The rows must stay in registry order with the now-worthless
    // fixture still in slot 2, still nothing preselected, still no confirm.
    console.log('[173-convert-order-reverse] phase 2: restore the real pool, floor fixture B…');
    const knobA2 = await fetch(`${r2.baseURL}/api/v1/test/swap_pool`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({pool: POOL, impact_bps: 0}),
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
    await driver.type('convert-amount', '3');
    await driver.waitForFunction(() => {
      const a = document.querySelector('[data-testid="convert-venue-icpswap-quote"]');
      const b = document.querySelector('[data-testid="convert-venue-icpswap-fixture-b-quote"]');
      return a != null && b != null
        && !/^0(\.0+)? ICP$/.test(a.textContent.trim())
        && /^0(\.0+)? ICP$/.test(b.textContent.trim());
    }, {timeoutMs: 15_000});
    const aRestored = await driver.readText('convert-venue-icpswap-quote');
    assertIncludes(aRestored, 'ICP', 'the real venue restored to a healthy reverse quote');
    assert(!ZERO_Q.test(aRestored.trim()), `the real venue is the strictly-better row now ("${aRestored}")`);

    const afterOpposite = await rowOrder(driver);
    assertEq(afterOpposite.join('|'), before.join('|'),
      'row order survives the OPPOSITE phase too (first venue strictly best — registry order, never rate order)');
    const selectedOpposite = await rowsWithDot(driver);
    assert(selectedOpposite.every(v => v === false), `no row self-selects when the FIRST venue is strictly best (radio-dot probe: [${selectedOpposite.join(', ')}])`);
    await assertDisabled(driver, 'btn-convert-confirm', 'confirm still withheld in the opposite phase — the user picks, not the rates');

    await driver.screenshot('173-convert-order-reverse');
    console.log(`[173-convert-order-reverse] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => {
    console.log('[173-convert-order-reverse] standalone run complete');
    process.exit(0);
  }).catch((e) => {
    console.error('[173-convert-order-reverse] FAILED:', e);
    process.exit(1);
  });
}
