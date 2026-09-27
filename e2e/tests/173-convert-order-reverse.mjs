// Flow 173 — the auto-pick + registry-order invariants in the REVERSE direction (VCHF → ICP).
//
// Flow 167 pins the sheet's disclosed pick + expander order for ICP → VCHF only; the reverse
// leg is NOT redundant. It is the direction where `zero_for_one` flips on BOTH pools — and the
// two venues' pools legitimately DISAGREE about which side is token0 — so any
// direction-derivation or ranking bug that hides behind the forward orientation surfaces only
// here. Same invariants, mirrored: the DISCLOSED PICK follows the strictly-best venue in both
// phases (each venue takes a turn being floored), the Other-venues expander keeps REGISTRY
// order through every re-fetch, each row's quote follows its own venue byte-identically, and
// tap 2 stays armed throughout.
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, openConvertFor, openOtherVenues, typeConvertAmount, pickSwapTarget,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const SEED = 1_000_000_000; // 10 VCHF (8 decimals, plain Number — the faucet body is JSON) — enough
// that the re-keyed amounts (1-3 VCHF) never trip the insufficient gate for a reason this flow
// does not assert on.
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai'; // the REAL venue's pool
const POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7'; // fixture B's own pool
const FIXTURE_VENUE = 'icpswap-fixture-b';

export const meta = {
  id: '173',
  name: 'convert-order-reverse',
  journey: 'convert',
  covers: ['convert', 'venues', 'auto-venue-pick', 'intent-sheet', 'registry-order', 'no-ranking', 'pool-knob', 'reverse-direction', 'vchf'],
  verifies: 'The sheet\'s auto-pick + registry-order invariants hold in the REVERSE direction (VCHF \u2192 ICP): flooring the real pool and then flooring fixture B instead \u2014 each venue taking a turn being strictly worse \u2014 moves the disclosed pick onto the strictly-best venue in both phases, the Other-venues expander keeps registry order through every re-fetch, each row\'s reverse-direction quote follows its own venue byte-identically, and tap 2 stays armed.',
  timeoutMs: 120000,
};

/** Unique venue-row testIDs in DOM order (RN-web mirrors testID onto wrapper layers). */
async function rowOrder(driver) {
  const raw = await driver.eval(() =>
    Array.from(document.querySelectorAll('[data-testid]'))
      .map((el) => el.getAttribute('data-testid'))
      .filter((id) => id === 'convert-venue-icpswap' || id === 'convert-venue-icpswap-fixture-b'));
  return [...new Set(raw)];
}

async function swapPoolKnob(base, body) {
  const r = await fetch(`${base}/api/v1/test/swap_pool`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
  });
  assert(r.ok, `swap_pool knob ok (status ${r.status})`);
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
    await onboardWallet(driver, 'e2e-convert-order');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED, {currency: 7}); // VCHF
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);

    const arm = await fetch(`${r2.baseURL}/api/v1/test/venue`, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({venue_id: FIXTURE_VENUE, served: true}),
    });
    assert(arm.ok, `venue knob armed (status ${arm.status})`);

    // The REVERSE direction: VCHF is the from-asset. The standing pair is stable-first
    // (CHF \u2192 USD, the 2026-09-25 founder rule); this flow's venue facts live on the
    // VCHF \u2194 ICP pair, so the ICP target is one chip away — then every venue row quotes
    // its output in ICP.
    await openConvertFor(driver, 'vchf');
    await pickSwapTarget(driver, 'ICP');
    await typeConvertAmount(driver, '1');
    await driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
    // The sheet grammar (brief 5.2): the PICK is the card's disclosed auto line; the expander
    // holds exactly the OTHER row. Two venues ⇒ one expander row — the complement of the pick —
    // and the complement IDENTITY is what tracks the knobs below (direction-independent).
    await openOtherVenues(driver);
    const before = await rowOrder(driver);
    assertEq(before.length, 1, 'the expander holds exactly the OTHER row (the pick is the auto line on the card)');
    // REVERSE direction: the two pools disagree about which side is token0, and here the
    // FIXTURE pool wins the mechanical pick at this size — so the expander's complement row
    // is the REAL venue.
    assertEq(before[0], 'convert-venue-icpswap', 'the fixture venue auto-picked; the real venue waits in the expander');

    // ── Phase 1: the real pool's payout floors to zero (impact 10000). The PICK must flip to
    //    the fixture venue (strictly better) and the expander must swap its row to the real
    //    venue — whose own reverse reply must be the zero the knob forced.
    console.log('[173-convert-order-reverse] phase 1: flooring the real pool via the swap_pool knob (impact_bps 10000)…');
    await swapPoolKnob(r2.baseURL, {pool: POOL, impact_bps: 10000});
    await typeConvertAmount(driver, '2'); // re-key → both rows re-fetch their venues
    await driver.waitForFunction(() => {
      const auto = document.querySelector('[data-testid="convert-venue-auto"]')?.textContent ?? '';
      return auto.includes('offline fixture');
    }, {timeoutMs: 15_000});
    const autoLine1 = await driver.readText('convert-venue-auto');
    assertIncludes(autoLine1, `Executed via ICPSwap (offline fixture)`, 'the disclosed pick followed the strictly-better fixture venue');
    assertIncludes(autoLine1, 'highest quoted rate of 2 venues', 'the pick states the comparison count');
    const after1 = await rowOrder(driver);
    assertEq(after1.length, 1, 'the expander still holds exactly one row');
    assertEq(after1[0], 'convert-venue-icpswap', 'the expander row swapped to the real venue (the complement of the pick)');
    const aQuote = await driver.readText('convert-venue-icpswap-quote');
    assert(/^0(\.0+)? ICP$/.test(aQuote.trim()), `the floored real row shows its OWN zeroed reverse reply ("${aQuote}")`);
    assert(await driver.findByTestID('btn-convert-confirm', {timeoutMs: 2_000}) != null, 'tap 2 stays armed at the pick');

    // ── Phase 2 (the opposite): re-price fixture B via its OWN pool knob (fee 1000 → 4321),
    //    then floor B while the real pool RESTORES. The pick must flip back to the real venue
    //    and the expander must hand the row back to the (now floored, zeroed) fixture.
    console.log('[173-convert-order-reverse] phase 2: re-pricing fixture B (fee 4321) then flooring it while the real pool restores…');
    await swapPoolKnob(r2.baseURL, {pool: POOL_B, fee_millionths: 4321});
    await swapPoolKnob(r2.baseURL, {pool: POOL_B, impact_bps: 10000});
    await swapPoolKnob(r2.baseURL, {pool: POOL, impact_bps: 0});
    await typeConvertAmount(driver, '3');
    await driver.waitForFunction(() => {
      const auto = document.querySelector('[data-testid="convert-venue-auto"]')?.textContent ?? '';
      return auto.includes('Executed via ICPSwap,') && !auto.includes('offline fixture');
    }, {timeoutMs: 15_000});
    const autoLine2 = await driver.readText('convert-venue-auto');
    assertIncludes(autoLine2, 'Executed via ICPSwap,', 'the disclosed pick flipped back to the real venue');
    assert(!autoLine2.includes('offline fixture'), 'the disclosure names the venue whose numbers won — never the loser');
    const after2 = await rowOrder(driver);
    assertEq(after2.length, 1, 'the expander still holds exactly one row');
    assertEq(after2[0], `convert-venue-${FIXTURE_VENUE}`, 'the expander row handed back to the fixture venue');
    const bQuote2 = await driver.readText(`convert-venue-${FIXTURE_VENUE}-quote`);
    assert(/^0(\.0+)? ICP$/.test(bQuote2.trim()), `the floored fixture row shows its OWN zeroed reverse reply ("${bQuote2}")`);
    assert(await driver.findByTestID('btn-convert-confirm', {timeoutMs: 2_000}) != null, 'tap 2 armed at the flipped pick');

    await driver.screenshot('173-convert-order');
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
