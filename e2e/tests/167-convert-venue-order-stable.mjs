// Flow 167 — the AUTO PICK follows the quotes; the expander's REGISTRY ORDER follows nothing.
//
// The 2026-09-26 intent sheet supersedes the V5 no-preselection chooser: dpay now picks the
// venue mechanically (highest net quoted output among live quotes) and discloses the pick.
// The invariants this flow pins after that supersession:
//   * the DISCLOSED PICK tracks the strictly-best venue in BOTH dynamic directions (floored
//     real pool → the fixture venue is the pick; restored real pool + floored fixture → the
//     real venue is the pick). A pick that lagged the numbers, or a disclosure naming the
//     wrong venue, is RED;
//   * the Other-venues expander always holds exactly the COMPLEMENT of the pick (the pick is
//     the card's disclosed auto line; two venues ⇒ one expander row), and the expander's
//     single row swaps identity with the pick through every re-fetch — never moved by output
//     ranking inside the expander itself (the multi-row registry order is pinned by the jest
//     suite and flow 190's three-mechanism pair);
//   * each expander row's displayed number follows ITS OWN venue's re-priced reply,
//     byte-identically through relay echo → app → rendered string;
//   * tap 2 stays armed at every instant — the pick is dpay's job now, not a withheld choice.
// Same pool knobs, same two-venue world on a private relay (startRelay, the flow-164 pattern).
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, openConvertFor, openOtherVenues, typeConvertAmount,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON)
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai'; // the REAL venue's pool
const POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7'; // fixture B's own pool
const FIXTURE_VENUE = 'icpswap-fixture-b';

export const meta = {
  id: '167',
  name: 'convert-venue-order-stable',
  journey: 'convert',
  covers: ['convert', 'venues', 'auto-venue-pick', 'intent-sheet', 'registry-order', 'no-ranking', 'pool-knob'],
  verifies: 'Mutating each venue\'s output mid-test (the relay\'s pool knobs floor the real pool, then re-price fixture B, then floor fixture B while the real pool restores) moves the sheet\'s DISCLOSED PICK onto the strictly-best venue in BOTH directions — the mechanical pick follows the numbers — while the Other-venues expander always holds exactly the complement row (whose quote follows its own venue byte-identically, zeroed when floored), and tap 2 stays armed throughout.',
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
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({venue_id: FIXTURE_VENUE, served: true}),
    });
    assert(arm.ok, `venue knob armed (status ${arm.status})`);

    await openConvertFor(driver, 'icp');
    await typeConvertAmount(driver, '1');
    await driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
    // The sheet grammar (brief 5.2): the PICK is the card's disclosed auto line; the expander
    // holds every OTHER row. Two venues ⇒ the expander holds exactly ONE row — the complement
    // of the pick — and the complement IDENTITY is what tracks the knobs below.
    await openOtherVenues(driver);
    const before = await rowOrder(driver);
    assertEq(before.length, 1, 'the expander holds exactly the OTHER row (the pick is the auto line on the card)');
    assertEq(before[0], `convert-venue-${FIXTURE_VENUE}`, 'the real venue auto-picked (bundled registry row 0), the fixture waits in the expander');

    // ── Phase 1: the real pool's payout floors to zero (impact 10000). The PICK must flip to
    //    the fixture venue (strictly better) and the expander must swap its row to the real
    //    venue — whose own quote must be the zero the knob forced.
    console.log('[167-convert-order] flooring the real pool via the swap_pool knob (impact_bps 10000)…');
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
    assert(/^0(\.0+)? VCHF$/.test(aQuote.trim()), `the floored real row shows its OWN zeroed reply ("${aQuote}")`);
    assert(await driver.findByTestID('btn-convert-confirm', {timeoutMs: 2_000}) != null, 'tap 2 stays armed at the pick');

    // ── Phase 2 (the opposite): re-price fixture B via its OWN pool knob (fee 1000 → 4321),
    //    then floor B while the real pool RESTORES. The pick must flip back to the real venue
    //    and the expander must hand the row back to the (now floored, zeroed) fixture.
    console.log('[167-convert-order] re-pricing fixture B (fee 4321) then flooring it while the real pool restores…');
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
    assert(/^0(\.0+)? VCHF$/.test(bQuote2.trim()), `the floored fixture row shows its OWN zeroed reply ("${bQuote2}")`);
    assert(await driver.findByTestID('btn-convert-confirm', {timeoutMs: 2_000}) != null, 'tap 2 armed at the flipped pick');

    await driver.screenshot('167-convert-order');
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
