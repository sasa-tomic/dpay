// Flow 206 — the intent sheet's TARGET grammar: the standing line + the sibling chips.
//
// The 2026-09-26 intent sheet replaces the grouped destination-picker list: the conversion's
// target is ONE pre-computed default on its own line, and every OTHER reachable currency rides
// as a small sibling chip — changing it is optional, never required. What is pinned, on the
// real VCHF sheet:
//
//   * the standing target for a stable source is its value twin (CHF → USD, the 2026-09-25
//     founder rule) — the line names it, and USD carries NO chip (it IS the line);
//   * the chips carry exactly the reachable set in list order — the pair walk is
//     registry-derived (EUR reachable since the CeFi EURC generalization; the source CHF absent by
//     construction), and no chip ever shows a number (chips are currencies, not quotes);
//   * one chip tap re-resolves the pair: the target line flips, the sheet re-quotes;
//   * the USD pair's OTHER rows sit behind the Other-venues expander in kind order (direct
//     pool standing, via-ICP hub, Route B) with the direct pool auto-picked and disclosed.
import { setup, assert, assertIncludes, onboardWallet, accountOf, faucetAccount, openConvertFor, pickSwapTarget, openOtherVenues } from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const SEED_VCHF = 50000000000; // 500 VCHF — enough to open the sheet's funded gates

export const meta = {
  id: '206',
  name: 'convert-target-currencies',
  journey: 'convert',
  covers: ['convert', 'target-currencies', 'intent-sheet', 'target-line', 'target-chips', 'group-model', 'registry-order', 'auto-venue-pick'],
  verifies: 'The intent sheet\'s target grammar: on VCHF the standing target is the value twin USD (the line names it; USD carries no chip), the sibling chips carry exactly the reachable set in list order (EUR, BTC, ETH, ICP, SOL in list order — EUR reachable since the CeFi EURC generalization; CHF absent as the source), no chip shows a number, one chip tap re-resolves the pair and flips the line, and the USD pair\'s other rows (via-ICP hub, Route B) wait in the Other-venues expander in kind order beneath the auto-picked, mechanically disclosed direct pool.',
  timeoutMs: 120_000,
};

/** The sheet's target testIDs in true DOM order (line + chips). */
async function targetLayout(driver) {
  return driver.eval(() => [...document.querySelectorAll('[data-testid]')]
    .map(el => el.getAttribute('data-testid'))
    .filter(t => t === 'convert-target-line'
      || /^convert-target-chip-[A-Z]+$/.test(t)
      || /^convert-venue-/.test(t)));
}

export async function run() {
  const start = Date.now();
  console.log('[206-convert-dest-groups] setup (own relay + shared web + browser)…');
  // solStub: the SOL currency is offerable only when its native rail exists in the wallet's
  // asset list — the RPC stub answers the balance probe honestly offline, so the chips pin
  // the FULL reachable set.
  const env = await setup({solStub: true});
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;

    console.log('[206-convert-dest-groups] onboarding + funding VCHF on the private relay…');
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'e2e-dest-groups');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED_VCHF, {currency: 7});
    assert(fund.ok, `faucet VCHF credit ok (status ${fund.status})`);

    // Tap 1 — the convert sheet on the VCHF account (the currency row's Convert button).
    await openConvertFor(driver, 'vchf');
    await driver.findByTestID('convert-target-leg', {timeoutMs: 15_000});

    // --- 1. the standing target is the value twin; the chips carry exactly the reachable set ---
    const layout = await targetLayout(driver);
    const chips = layout.filter(t => t.startsWith('convert-target-chip-'));
    assertEqJson(chips, [
      'convert-target-chip-USD',
      'convert-target-chip-BTC',
      'convert-target-chip-ETH',
      'convert-target-chip-ICP',
      'convert-target-chip-SOL',
    ], 'the chips carry exactly the reachable currencies in list order (EUR standing as the twin, so it vacates the chips; CHF absent: it is the source)');
    assert(layout.includes('convert-target-line'), 'the standing target renders as the ONE line');
    const lineText = await driver.readText('convert-target-line');
    assertIncludes(lineText, 'Euros', 'a stable source stands on its value twin (CHF → EUR, the brief 5.3 rule)');
    // The pair walk arms the sheet: the standing pair is already quoted on open.
    await driver.findByTestID('convert-quote-source', {timeoutMs: 15_000});
    console.log('[206-convert-dest-groups] ✓ standing line (stable twin USD) + reachable chips');

    // --- 2. one chip tap re-resolves the pair (the optional decision, one tap) ------------------
    await pickSwapTarget(driver, 'ICP');
    const afterPick = await driver.readText('convert-target-line');
    assertIncludes(afterPick, 'Internet Computer', 'the line flipped to the picked currency');
    assert(await driver.findByTestID('convert-target-chip-USD', {timeoutMs: 4_000}) != null,
      'the previous standing target returns to the chips');
    assert(await driver.findByTestID('convert-target-chip-ICP', {timeoutMs: 1_000}).catch(() => null) == null,
      'the picked currency vacates the chips (it IS the line)');
    console.log('[206-convert-dest-groups] ✓ one-tap target switch');

    // --- 3. the USD pair (a chip pick): its OTHER rows in the expander, kind order ----
    await pickSwapTarget(driver, 'USD');
    await driver.findByTestID('convert-venue-auto', {timeoutMs: 8_000});
    const autoLine = await driver.readText('convert-venue-auto');
    assertIncludes(autoLine, 'Executed via', 'the direct pool is auto-picked and mechanically disclosed');
    await openOtherVenues(driver);
    const venueRows = (await targetLayout(driver))
      .filter(t => t.startsWith('convert-venue-') && t !== 'convert-venue-auto' && !/-quote$|-err$|-slow$/.test(t));
    assertEqJson(venueRows, [
      'convert-venue-hub:icpswap:8:icpswap-ckusdc',        // via the ICP hub
      // The composed IC+CeFi chains (2026-09-26): direct-then-hub IC legs into the
      // sideshift-usdc order, keyed on the settle mint, in registry order.
      'convert-venue-composed:icpswap:sideshift-usdc',
      'convert-venue-composed:hub:icpswap-vchf-ckusdc:2:icpswap-ckusdc:sideshift-usdc',
      'convert-venue-multihop:icpswap-vchf-ckusdc:2:cctp', // Route B (in-wallet landing)
    ], 'the USD pair\'s other rows in kind order (registry order inside each kind, never ranked) — the direct pool is the standing pick, not a row');

    await driver.screenshot('206-convert-target-currencies');

  } finally {
    await env.stop();
    await r2.stop();
  }
}

function assertEqJson(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('206-convert-dest-groups RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
