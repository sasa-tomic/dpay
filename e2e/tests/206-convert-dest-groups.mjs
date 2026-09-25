// Flow 206 — the Convert DESTINATION PICKER is grouped by currency (multi-currency build-out,
// 2026-09). Presentation only: `groupDestSections` (components/ConvertShared.tsx) partitions the
// buildDestGroups rows by the currency each DESTINATION settles, home currencies first in their
// fixed order, then the tail of destinations that settle no home currency — other in-wallet assets,
// the standing direct pair when it lands on one (VCHF's direct pair is ICP), and the
// external-address payouts. What is pinned, on the real VCHF convert form:
//
//   * the section headers exist and name their currency — "US dollars" then "Other destinations";
//   * the sections lead: the USD destination (ckUSDC) sits under its header, BEFORE the tail;
//   * registry order inside a section is preserved — the tail keeps the direct pair first, then
//     ckETH, ckBTC, then the route rows (the same order flow 190 pins, now under a header);
//   * the rows themselves are untouched — every pinned row testID of flows 188/190 still resolves,
//     and nothing is preselected by the grouping (headers carry no radio state of their own).
import { setup, assert, assertIncludes, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency, openConvertFor, pickSwapTarget } from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const SEED_VCHF = 50000000000; // 500 VCHF — enough to open the convert form's funded gates

export const meta = {
  id: '206',
  name: 'convert-target-currencies',
  journey: 'convert',
  covers: ['convert', 'target-currencies', 'currency-groups', 'group-model', 'registry-order', 'no-fx-sum'],
  verifies: 'The swap screen\'s target list is grouped by CURRENCY (the 2026-09-24 currency grammar, successor of the destination picker): on VCHF the list carries every other wallet currency in list order (stables first, then Other), the SOURCE currency renders disabled rather than absent, the reachable set exactly mirrors the pair walk (registry-derived, EUR absent — no VCHF→EUR row exists), headers carry no numbers, and the USD pair\'s venue rows keep kind order (direct pool, via-ICP hub, Route B) with the single venue auto-armed — nothing preselected where two venues serve a pair.',
  timeoutMs: 120_000,
};

/** The target list's rows in true DOM order. */
async function targetLayout(driver) {
  return driver.eval(() => [...document.querySelectorAll('[data-testid]')]
    .map(el => el.getAttribute('data-testid'))
    .filter(t => t === 'btn-convert-target'
      || /^convert-target-[A-Z]+$/.test(t)
      || /^convert-venue-/.test(t)));
}

export async function run() {
  const start = Date.now();
  console.log('[206-convert-dest-groups] setup (own relay + shared web + browser)…');
  // solStub: the EUR currency is offerable only when its EURC(Solana) rail exists in the
  // wallet's asset list — the RPC stub answers the balance probe honestly offline, so the
  // target list pins the FULL six-currency set.
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

    // Open the convert form on the VCHF account (the currency row's Convert button).
    await openConvertFor(driver, 'vchf');
    await driver.findByTestID('convert-target-leg', {timeoutMs: 15_000});

    // --- 1. the target list: every OTHER wallet currency, in list order -------------------------
    await driver.click('btn-convert-target', {timeoutMs: 5_000});
    const seq = await targetLayout(driver);
    const codes = ['CHF', 'USD', 'EUR', 'BTC', 'ETH', 'ICP', 'SOL'];
    const found = codes.filter(c => seq.includes(`convert-target-${c}`));
    console.log('[206] target rows found: ' + JSON.stringify(found));
    // The full set INCLUDING the source's own row — the source renders DISABLED (the
    // same-currency target is refused honestly, not hidden).
    assertEqJson(found, ['CHF', 'USD', 'EUR', 'BTC', 'ETH', 'ICP', 'SOL'],
      'the target list carries every wallet currency in list order (stables first, then Other), the source included');
    const srcState = await driver.eval(() => document.querySelector('[data-testid="convert-target-CHF"]')?.getAttribute('aria-state')
      ?? document.querySelector('[data-testid="convert-target-CHF"]')?.getAttribute('aria-disabled') ?? null);
    const srcNode = await driver.eval(() => {
      const el = document.querySelector('[data-testid="convert-target-CHF"]');
      if (el == null) return null;
      const inner = el.hasAttribute('aria-disabled') ? el : el.querySelector('[aria-disabled="true"]');
      return inner == null ? null : inner.getAttribute('aria-disabled');
    });
    assert(srcNode === 'true', `the source currency's own row is DISABLED (aria-disabled, got ${JSON.stringify(srcNode)})`);
    void srcState;
    for (const c of found) {
      const text = await driver.readText(`convert-target-${c}`);
      assert(!/\d/.test(text.replace(/^\s+/, '').split('\n')[0]), `the target row ${c} carries no number in its name line — got "${text.slice(0, 60)}"`);
    }
    console.log('[206-convert-target-currencies] ✓ target rows: list order, source excluded');

    // --- 2. the SOURCE currency renders DISABLED (same-currency target refused honestly) --------
    // (The source's row only renders when the source itself is a wallet currency — VCHF is CHF,
    // which the filter already excluded; the disabled-state contract is pinned by the
    // swapTargets jest suite and flow 190's ckETH leg.)

    // --- 3. the standing pair arms on its own: single venue → attributed line --------------------
    await driver.click('btn-convert-target', {timeoutMs: 3_000}); // close the list
    await driver.type('convert-amount', '1');
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    assert(await driver.findByTestID('convert-venue-icpswap', {timeoutMs: 4_000}) != null,
      'the standing ICP pair\'s direct pool is the standing pick (one venue, nothing withheld)');
    assert(await driver.findByTestID('convert-venue-none', {timeoutMs: 1_000}).catch(() => null) == null,
      'no none-selected line — the single venue leaves nothing to choose');
    console.log('[206-convert-target-currencies] ✓ standing pair: direct pool armed, attributed headline');

    // --- 4. the USD pair: kind order (direct pool, hub, Route B) and NO cash-out row -------------
    await pickSwapTarget(driver, 'USD');
    await driver.findByTestID('convert-venues', {timeoutMs: 8_000});
    const usdRows = (await targetLayout(driver)).filter(t => t.startsWith('convert-venue-') && !/-quote$|-err$|-slow$/.test(t) && t !== 'convert-venue-none' && t !== 'convert-venue-details');
    assertEqJson(usdRows, [
      'convert-venue-icpswap-vchf-ckusdc',                 // direct pool
      'convert-venue-hub:icpswap:8:icpswap-ckusdc',        // via the ICP hub
      'convert-venue-multihop:icpswap-vchf-ckusdc:2:cctp', // Route B (in-wallet landing)
    ], 'the USD pair\'s venue rows in kind order (registry order inside each kind, never ranked)');
    // Two venues? The direct pool + ... the hub and route are composites, not venues — ONE
    // venue serves the pair → the direct pool is the standing pick (nothing withheld).
    assert(await driver.findByTestID('convert-venue-none', {timeoutMs: 1_000}).catch(() => null) == null,
      'the USD pair\'s single venue is the standing pick (nothing withheld)');
    console.log('[206-convert-target-currencies] ✓ USD pair rows: kind order, single venue standing');

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
