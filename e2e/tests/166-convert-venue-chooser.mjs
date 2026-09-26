// Flow 166 — the disclosed AUTO PICK + the one-tap override (two venues on one pair).
//
// Supersedes the 2026-09-11 V5 no-preselection chooser (founder directive 2026-09-26, recorded
// with its compensating controls in docs/specs + the design brief §5.3): dpay now picks the
// venue MECHANICALLY — highest net quoted output among live quotes — and discloses the pick as
// a fact ("Executed via X, highest quoted rate of 2 venues"). The red lines that survive:
//   * the pick is DERIVABLE from the venues' own verbatim replies (never a blend, never a
//     score; the word "best" never appears);
//   * the pick DISCLOSES itself (venue + count) and the quote keeps its attribution +
//     timestamp;
//   * every other row stays reachable in ONE tap behind the Other-venues expander, in
//     REGISTRY order — order-stability asserts live there now;
//   * an override switches attribution + floor to the picked row's own numbers, immediately,
//     and the CTA re-arms with no re-confirm loop.
// The tail of the flow re-runs the V9 INV-6 fee census (zero tolerance): it forces the real
// venue's fee tier through the pool knob (fee_millionths 4321), lets the mechanical pick
// follow the numbers, and asserts EVERY fee-bearing money line byte-matches the venue-quoted
// tier / catalog-quoted ledger fees, with dpay-paid-nothing + net end state asserted GONE.
//
// The two-venue world exists only on this flow's OWN relay (startRelay — the flow-164
// pattern): the fixture venue `icpswap-fixture-b` is served by the test-helpers gateway ONLY
// while POST /api/v1/test/venue arms it.
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, openConvertFor, openOtherVenues, typeConvertAmount, fmtHero,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON)
const FIXTURE_VENUE = 'icpswap-fixture-b';
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai'; // the REAL venue's pool (the census knob's target)
const ICP_FEE = 10000n; // raw e8s, the catalog fee field (same numbers flow 140's census pins)
const VCHF_FEE = 10000n;

/** fmtAssetCompact twin (8 decimals, trailing zeros trimmed — the app renders fees and amounts
 *  compact since 2026-09-13; '.' separator, no grouping under 1000 — the web driver locale). */
function fmt8(raw) {
  const n = BigInt(raw);
  const whole = n / 100000000n;
  const frac = (n % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export const meta = {
  id: '166',
  name: 'convert-venue-chooser',
  journey: 'convert',
  covers: ['convert', 'venues', 'auto-venue-pick', 'intent-sheet', 'one-tap-override', 'quote-attribution', 'registry-order', 'fees-itemised', 'inv-6-fee-census', 'venue-disclosure', 'no-impact-line'],
  verifies: 'With two venues served on one pair (test-helpers knob on a private relay), the intent sheet auto-picks the HIGHEST net quoted output and discloses it mechanically ("Executed via X, highest quoted rate of 2 venues", no "best" wording); the Other-venues expander lists the other row verbatim in registry order with its OWN attributed quote; overriding is ONE tap and moves attribution + floor + headline to the picked row\'s own numbers. The INV-6 fee census then forces the real pool tier (4321 millionths), lets the pick follow the fresh numbers, and asserts every fee line byte-matches the venue-quoted tier / catalog fees, with dpay-paid-nothing + net end state asserted GONE and the floor derived from the same forced quote (and no price-impact line, V8).',
  timeoutMs: 120000,
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

    await openConvertFor(driver, 'icp');
    await typeConvertAmount(driver, '1');
    await driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
    // The served venue registry lands async: the pick line may render from the bundled
    // registry alone. Wait for BOTH rows' quotes before any expander read.
    await driver.findByTestID(`convert-venue-${FIXTURE_VENUE}-quote`, {timeoutMs: 10_000}).catch(() => null);
    await driver.findByTestID('convert-venue-icpswap-quote', {timeoutMs: 10_000}).catch(() => null);

    // The mechanical pick: the sheet compares BOTH venues' live quotes and takes the higher
    // net output. The sheet's own numbers are cross-checked against the two oracle replies
    // fetched flow-side for the SAME amount (single source of truth).
    const ORACLE_A_BODY = await (await fetchQuote(r2.baseURL, ICP_LEDGER, VCHF_LEDGER, POOL)).json();
    const netA = BigInt(ORACLE_A_BODY.amount_out) - VCHF_FEE;
    const FIXTURE_POOL = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7';
    const oracleB = await fetch(`${r2.baseURL}/api/v1/swap_quote?pool=${FIXTURE_POOL}&token_in=${ICP_LEDGER}&token_out=${VCHF_LEDGER}&amount_in=100000000`);
    assert(oracleB.ok, `fixture oracle quote ok (status ${oracleB.status})`);
    const ORACLE_B_BODY = await oracleB.json();
    const netB = BigInt(ORACLE_B_BODY.amount_out) - VCHF_FEE;
    const best = netB > netA
      ? {id: FIXTURE_VENUE, name: 'ICPSwap (offline fixture)', net: netB}
      : {id: 'icpswap', name: 'ICPSwap', net: netA};

    const autoLine = await driver.readText('convert-venue-auto');
    assertIncludes(autoLine, 'Executed via', 'the pick line names its executor');
    assertIncludes(autoLine, 'highest quoted rate of 2 venues', 'the pick states the comparison count as a fact');
    assert(!autoLine.toLowerCase().includes('best'), 'the word "best" never appears (no endorsement language)');
    assertIncludes(autoLine, best.name, `the pick followed the higher net quote (${best.name})`);
    const headlineNet = await driver.readText('convert-receive');
    // The hero reads at standard display precision (VCHF: 2 decimals); the picked venue's
    // VERBATIM reply is pinned in Details below (the never-computed red line, untouched).
    assertIncludes(headlineNet, `≈ ${fmtHero(best.net, 8, 'VCHF', { stable: true })}`, 'the receive hero is the PICKED venue\'s own reply at standard display precision');

    // The expander: the OTHER row (the pick is the card's auto line), carrying its OWN quote.
    // The sheet grammar (brief 5.2) makes the expander the complement of the pick: with two
    // venues that is ONE row. Its number is cross-checked against the oracle for the amount
    // the sheet actually holds in its input — single source of truth, byte-exact.
    await openOtherVenues(driver);
    const otherId = best.id === 'icpswap' ? FIXTURE_VENUE : 'icpswap';
    const otherNet = best.id === 'icpswap' ? netB : netA;
    const typed = await inputValue(driver, 'convert-amount');
    assertIncludes(typed, '1', `the sheet's input holds the typed amount (got: ${typed})`);
    const expectedOther = `${fmt8(otherNet + VCHF_FEE)} VCHF`;
    await driver.waitForFunction(
      (sel, want) => {
        const row = document.querySelector(`[data-testid="${sel}-quote"]`);
        return row != null && row.textContent.trim() === want;
      },
      {timeoutMs: 15_000, label: 'other row shows its OWN quote at the typed amount', args: [`convert-venue-${otherId}`, expectedOther]},
    ).catch(async () => {
      const otherRow = await driver.readText(`convert-venue-${otherId}`);
      assertIncludes(otherRow, expectedOther, 'the other row shows its OWN quote at the typed amount (compact amount, no prefix)');
    });
    const order = await venueRowOrder(driver);
    assertEq(order.length, 1, 'the expander holds exactly the other row (the pick is the auto line)');
    assertEq(order[0], `convert-venue-${otherId}`, 'the expander row IS the complement of the pick');

    // ONE-TAP override: the attribution + floor + headline move to the picked row's numbers.
    await driver.click(`convert-venue-${otherId}`, {timeoutMs: 5_000});
    await driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});
    const overriddenSource = await driver.readText('convert-quote-source');
    assertIncludes(overriddenSource, 'fetched', 'the overridden card still carries attribution + a timestamp');
    assertIncludes(overriddenSource, otherId === 'icpswap' ? 'Quote from ICPSwap,' : 'ICPSwap (offline fixture)',
      'the attribution names the OVERRIDDEN venue');
    assert(await driver.findByTestID('convert-venue-auto', {timeoutMs: 1_000}).catch(() => null) == null,
      'the mechanical-pick line stands down under an override (it describes the auto pick, not a user choice)');
    const overriddenReceive = await driver.readText('convert-receive');
    assertIncludes(overriddenReceive, `≈ ${fmtHero(otherNet, 8, 'VCHF', { stable: true })}`, 'the receive hero follows the overridden row\'s own reply');
    await driver.screenshot('166-convert-override');

    // --- V9 INV-6 FEE CENSUS (zero tolerance) on the card under the override. -------------------
    // Force the real venue's fee tier through the pool knob (the same seam flow 167 mutates
    // with), fetch the oracle quote flow-side for the SAME amount, let the sheet re-fetch, and
    // assert every folded fee-bearing money line renders EXACTLY the forced venue tier and the
    // catalog ledger fees. Zero tolerance: not "a fee appears" but byte-exact strings, incl.
    // the 4-decimal tier (0.4321%, never rounded to 0.43%).
    console.log('[166-convert-chooser] INV-6 fee census: forcing the real pool tier to 4321 millionths…');
    const knob = await fetch(`${r2.baseURL}/api/v1/test/swap_pool`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({pool: POOL, fee_millionths: 4321}),
    });
    assert(knob.ok, `swap_pool knob ok (status ${knob.status})`);

    const AMOUNT_IN = 200000000n; // 2 ICP — the re-key below re-fetches at this amount
    const oracle = await (await fetchQuote(r2.baseURL, ICP_LEDGER, VCHF_LEDGER, POOL, AMOUNT_IN)).json();
    assertEq(String(oracle.fee_millionths), '4321', 'the oracle quote carries the FORCED fee tier');
    assertEq(oracle.venue_id, 'icpswap', "the oracle quote is the real venue's own reply");
    const gross = BigInt(oracle.amount_out);
    const minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n; // the core's floor math @ 1%
    const net = gross - VCHF_FEE;

    // Re-key the amount (the sheet re-fetches both rows at the forced tier), then OVERRIDE to
    // the real venue so the census reads ITS numbers. The pool-fee line settling at the FORCED
    // tier is the deterministic signal that the fresh quote landed and derivation finished.
    await typeConvertAmount(driver, '2');
    // The expander stayed open through the override and the re-key; re-open only if needed.
    if (await driver.findByTestID('convert-venue-icpswap', {timeoutMs: 1_500}).catch(() => null) == null) {
      await openOtherVenues(driver);
    }
    await driver.click('convert-venue-icpswap', {timeoutMs: 5_000});
    await driver.click('convert-details', {timeoutMs: 5_000});
    await driver.waitForFunction(
      () => (document.querySelector('[data-testid="convert-pool-fee"]')?.textContent ?? '').includes('0.4321%'),
      {timeoutMs: 15_000},
    );

    // THE CENSUS — every fee-bearing money line on the card, byte-exact:
    const poolFeeLine = await driver.readText('convert-pool-fee');
    assertIncludes(poolFeeLine, '0.4321%', 'pool fee = the venue-quoted FORCED tier (4321 millionths → 0.4321%, all 4 decimals, never rounded)');
    assertIncludes(poolFeeLine, 'ICPSwap fee tier', 'and the tier is attributed to the venue whose quote it rode');
    assertIncludes(await driver.readText('convert-in-fee'), `Input fee: ${fmt8(ICP_FEE)} ICP`,
      `input fee = the catalog ledger fee, exact (${fmt8(ICP_FEE)} ICP)`);
    assertIncludes(await driver.readText('convert-out-fee'), `${fmt8(VCHF_FEE)} VCHF`,
      `output fee = the catalog ledger fee, exact (${fmt8(VCHF_FEE)} VCHF)`);
    assert(await driver.findByTestID('convert-dpay-fee', {timeoutMs: 1_000}).catch(() => null) == null,
      'the dpay line is GONE — INV-6 now pins its absence');
    // The derived money lines follow the SAME forced quote — the census is self-consistent:
    // the hero at standard display precision, the venue's verbatim figure right here.
    assertIncludes(await driver.readText('convert-receive'), `≈ ${fmtHero(net, 8, 'VCHF', { stable: true })}`,
      `receive hero = gross − output fee from the forced quote, at display precision (${fmt8(net)} VCHF verbatim)`);
    assertIncludes(await driver.readText('convert-quote-verbatim'), `${fmt8(gross)} VCHF`,
      'Details carries the forced quote\'s verbatim gross figure');
    const minOutLine = await driver.readText('convert-min-out');
    assertIncludes(minOutLine, `${fmt8(minOut)} VCHF`,
      `the floor = the core's floor math on the forced quote (${fmt8(minOut)} VCHF)`);
    assertIncludes(minOutLine, '1% slippage', 'at the default 1% slippage');
    assert(await driver.findByTestID('convert-net', {timeoutMs: 1_000}).catch(() => null) == null,
      'the net end-state line is GONE: the receive figure IS the end state');
    // The per-venue disclosure renders on the card; and NO price-impact line exists anywhere
    // (V8 — the venue publishes none, the UI restates none).
    const disclosureLine = await driver.readText('convert-venue-disclosure');
    assert(disclosureLine.trim().length > 0, 'the per-venue disclosure sentence renders under the pick');
    assert(await driver.findByTestID('convert-impact', {timeoutMs: 1_000}).catch(() => null) == null,
      'no price-impact line renders (V8)');

    await driver.screenshot('166-convert-chooser');
    console.log(`[166-convert-chooser] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

/** Oracle quote through the REAL venue's pool (the relay's own route, flow-140's seam). */
/** The live value of an input testID (the app's own amount text, not the DOM attribute). */
async function inputValue(driver, testID) {
  return driver.eval((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`);
    return el == null ? '' : (el.value ?? el.textContent ?? '');
  }, testID);
}

async function fetchQuote(base, tokenIn, tokenOut, pool, amountIn = 100000000n) {
  const r = await fetch(`${base}/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`);
  assert(r.ok, `oracle swap_quote ok (status ${r.status})`);
  return r;
}

/** Unique venue-row testIDs in DOM order (RN-web mirrors testID onto wrapper layers). */
async function venueRowOrder(driver) {
  const raw = await driver.eval(() =>
    Array.from(document.querySelectorAll('[data-testid]'))
      .map((el) => el.getAttribute('data-testid'))
      .filter((id) => id === 'convert-venue-icpswap' || id === 'convert-venue-icpswap-fixture-b'));
  return [...new Set(raw)];
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
