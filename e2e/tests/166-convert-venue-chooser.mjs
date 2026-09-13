// Flow 166 — V5 venue chooser: two venues on one pair render with NOTHING preselected.
//
// Spec docs/specs/2026-09-08-multi-venue-readiness.md V5: when a pair has two venues, the screen
// must show N rows in a STABLE, quote-independent order (registry order), each row carrying its
// OWN quote with attribution + timestamp, and NO row preselected — the red lines: never rank by
// output, never auto-pick the "obviously better" venue, never default to last-used. The
// checklist + confirm stay gated on an explicit pick.
//
// After the no-pick assertions, the flow ALSO runs the V9 INV-6 fee census (zero tolerance):
// it forces the real venue's fee tier through the same pool knob 167 uses (fee_millionths 4321),
// picks that venue, and asserts EVERY fee-bearing money line on the pre-sign checklist renders
// exactly the venue-quoted tier / catalog-quoted ledger fees / the dpay-paid-nothing line — plus
// the derived money lines (headline, min-out, net) against the relay's own quote reply fetched
// flow-side for the same amount. Deterministic end to end: private relay, forced tier, no
// sibling can touch the pool.
//
// The two-venue world exists only on this flow's OWN relay (startRelay — the same pattern flow
// 164 uses): the second fixture venue `icpswap-fixture-b` is served by the test-helpers gateway
// ONLY while POST /api/v1/test/venue arms it, so the shared suite relay (flows 140–145) never
// sees a second venue and the default experience stays ONE venue per pair.
import {setup, assert, assertEq, assertIncludes, assertDisabled, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency} from '../harness/lib.mjs';
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
  covers: ['convert', 'venues', 'venue-chooser', 'no-preselection', 'quote-attribution', 'registry-order', 'fees-itemised', 'inv-6-fee-census', 'venue-disclosure', 'no-impact-line'],
  verifies: 'With two venues served on one pair (test-helpers knob on a private relay), the chooser renders both rows in registry order, each with its OWN quote attributed + timestamped; no row is preselected, and the headline/checklist/confirm stay withheld until the user picks one. Under the pick: the INV-6 fee census forces the venue tier (4321 millionths) and asserts every fee line on the pre-sign checklist byte-matches the venue-quoted tier / catalog fees / dpay-paid-nothing, with min-out+net derived from the same forced quote (and no price-impact line, V8).',
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

    // NONE preselected: no row is selected, the none-selected line shows, and every surface that
    // follows a pick (headline, checklist, confirm) is absent or disabled.
    //
    // SELECTION PROBE — this RNW version does not project accessibilityState → aria-checked (the
    // documented flow-85 gap), so "checked" is read STRUCTURALLY: the row Pressable renders the
    // radio DOT (a 10×10px rounded brand View) ONLY when `on` is true. rowsWithDot() reports, per
    // venue row, whether that dot exists — the real rendered selection state.
    const rowsWithDot = () => driver.eval(() =>
      ['icpswap', 'icpswap-fixture-b'].map((vid) => {
        const row = document.querySelector(`[data-testid="convert-venue-${vid}"]`);
        if (!row) return false;
        return Array.from(row.querySelectorAll('div')).some((d) => {
          const s = getComputedStyle(d);
          return parseFloat(s.width) === 10 && parseFloat(s.height) === 10 && parseFloat(s.borderRadius) === 5;
        });
      }));
    const noPick = await rowsWithDot();
    assert(noPick.every(v => v === false), `no venue row is preselected (radio-dot probe: [${noPick.join(', ')}])`);
    const noneLine = await driver.findByTestID('convert-venue-none', {timeoutMs: 2_000});
    assert(noneLine != null, 'the none-selected guidance line renders');
    assertIncludes(await driver.readText('convert-venue-none'), 'Select a venue', 'the guidance line tells the user to pick');
    assert(await driver.findByTestID('convert-headline', {timeoutMs: 1_000}).catch(() => null) == null,
      'no headline before a pick (the user has chosen nothing)');
    assert(await driver.findByTestID('convert-counterparty', {timeoutMs: 1_000}).catch(() => null) == null,
      'no checklist disclosure before a pick');
    await assertDisabled(driver, 'btn-convert-confirm', 'confirm is withheld until a venue is picked');

    // --- V9 INV-6 FEE CENSUS (zero tolerance) on the checklist that appears under a pick. --------
    // Force the real venue's fee tier through the pool knob (the same seam flow 167 mutates with),
    // fetch the oracle quote flow-side for the SAME amount the UI will re-key to, then pick the
    // venue and assert every fee-bearing money line renders EXACTLY the forced venue tier, the
    // catalog ledger fees, and the dpay-paid-nothing line — plus the derived lines (headline,
    // min-out, net) derived from the same forced quote. Zero tolerance: not "a fee appears" but
    // byte-exact strings, incl. the 4-decimal tier (0.4321%, never rounded to 0.43%).
    console.log('[166-convert-chooser] INV-6 fee census: forcing the real pool tier to 4321 millionths…');
    const knob = await fetch(`${r2.baseURL}/api/v1/test/swap_pool`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({pool: POOL, fee_millionths: 4321}),
    });
    assert(knob.ok, `swap_pool knob ok (status ${knob.status})`);

    const AMOUNT_IN = 200000000n; // 2 ICP — the re-key below re-fetches both rows at this amount
    const oracleRes = await fetch(
      `${r2.baseURL}/api/v1/swap_quote?pool=${POOL}&token_in=${ICP_LEDGER}&token_out=${VCHF_LEDGER}&amount_in=${AMOUNT_IN}`,
    );
    assert(oracleRes.ok, `oracle swap_quote ok (status ${oracleRes.status})`);
    const oracle = await oracleRes.json();
    assertEq(String(oracle.fee_millionths), '4321', 'the oracle quote carries the FORCED fee tier');
    assertEq(oracle.venue_id, 'icpswap', "the oracle quote is the real venue's own reply");
    const gross = BigInt(oracle.amount_out);
    const minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n; // the core's floor math @ 1%
    const net = gross - VCHF_FEE;

    // Re-key so the rows re-fetch at the forced tier, then PICK the real venue. The checklist
    // gates on math != null; the pool-fee line settling at the FORCED tier is the deterministic
    // signal that the re-fetch landed and derivation finished (the pre-knob 0.30% line would
    // still read 0.30% until the fresh quote replaces it — this wait closes that race).
    await driver.type('convert-amount', '2');
    await driver.click('convert-venue-icpswap', {timeoutMs: 5_000});
    await driver.waitForFunction(
      () => (document.querySelector('[data-testid="convert-pool-fee"]')?.textContent ?? '').includes('0.4321%'),
      {timeoutMs: 15_000},
    );

    // Exactly one row selected — the user's pick, and only that row (same radio-dot probe as the
    // pre-pick check above; the pick renders the dot on the chosen row only).
    const picked = await rowsWithDot();
    assert(picked[0] === true && picked[1] === false,
      `the picked row (and only it) is selected (radio-dot probe: [${picked.join(', ')}])`);

    // THE CENSUS — every fee-bearing money line on the pre-sign checklist, byte-exact:
    const poolFeeLine = await driver.readText('convert-pool-fee');
    assertIncludes(poolFeeLine, '0.4321%', 'pool fee = the venue-quoted FORCED tier (4321 millionths → 0.4321%, all 4 decimals, never rounded)');
    assertIncludes(poolFeeLine, 'ICPSwap fee tier', 'and the tier is attributed to the venue whose quote it rode');
    assertIncludes(await driver.readText('convert-in-fee'), `Input fee: ${fmt8(ICP_FEE)} ICP`,
      `input fee = the catalog ledger fee, exact (${fmt8(ICP_FEE)} ICP)`);
    assertIncludes(await driver.readText('convert-out-fee'), `${fmt8(VCHF_FEE)} VCHF`,
      `output fee = the catalog ledger fee, exact (${fmt8(VCHF_FEE)} VCHF)`);
    assertIncludes(await driver.readText('convert-dpay-fee'), 'dpay charges nothing and is paid nothing',
      'the dpay line: no fee recipient, paid nothing (INV-6)');
    // The derived money lines follow the SAME forced quote — the census is self-consistent:
    assertIncludes(await driver.readText('convert-headline'), `${fmt8(net)} VCHF`,
      `headline receive-amount = gross − output fee from the forced quote (${fmt8(net)} VCHF)`);
    const minOutLine = await driver.readText('convert-min-out');
    assertIncludes(minOutLine, `${fmt8(minOut)} VCHF`,
      `min-out = the core's floor math on the forced quote (${fmt8(minOut)} VCHF)`);
    assertIncludes(minOutLine, '1% slippage', 'at the default 1% slippage');
    assertIncludes(await driver.readText('convert-net'), `${fmt8(net)} VCHF`,
      `net end state = gross − output fee from the forced quote (${fmt8(net)} VCHF)`);
    assertIncludes(await driver.readText('convert-quote-source'), 'Quote from ICPSwap, fetched',
      'the checklist quote stays attributed to the picked venue');
    // WP1 surfaces render under the pick: the per-venue disclosure sentence; and NO price-impact
    // line exists anywhere (V8 — the venue publishes none, the UI restates none).
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

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => {
    console.log('[166-convert-chooser] standalone run complete');
    process.exit(0);
  }).catch((e) => {
    console.error('[166-convert-chooser] FAILED:', e);
    process.exit(1);
  });
}
