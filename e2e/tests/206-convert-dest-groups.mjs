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
import { setup, assert, assertIncludes, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency } from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const SEED_VCHF = 50000000000; // 500 VCHF — enough to open the convert form's funded gates

export const meta = {
  id: '206',
  name: 'convert-dest-groups',
  journey: 'convert',
  covers: ['convert', 'destination-picker', 'currency-groups', 'group-model', 'registry-order', 'no-fx-sum'],
  verifies: 'The convert destination picker is grouped by the currency each destination settles: on VCHF, "US dollars" leads with the ckUSDC row, then "Other destinations" keeps registry order (the ICP direct pair, ckETH, ckBTC, the route rows) — headers name currencies and carry no numbers, every pinned row testID still resolves, and nothing is preselected by the grouping.',
  timeoutMs: 120_000,
};

/** The picker's headers and rows in true DOM order. */
async function pickerLayout(driver) {
  return driver.eval(() => [...document.querySelectorAll('[data-testid]')]
    .map(el => el.getAttribute('data-testid'))
    .filter(t => /^convert-dest-group-/.test(t)
      || t === 'convert-dest-direct'
      || /^convert-dest-inwallet-\d+$/.test(t)
      || /^convert-dest-route-/.test(t)
      || /^convert-dest-cefi-/.test(t)));
}

export async function run() {
  const start = Date.now();
  console.log('[206-convert-dest-groups] setup (own relay + shared web + browser)…');
  const env = await setup();
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

    // Open the convert form on the VCHF account (Convert renders on the SELECTED row only).
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', {timeoutMs: 6_000});
    await driver.findByTestID('convert-dest', {timeoutMs: 15_000});

    // --- 1. the headers exist, name their currency, and LEAD ------------------------------------
    assert(await driver.isPresent('convert-dest-group-usd'), 'the USD section leads the picker');
    assert(await driver.isPresent('convert-dest-group-other'), 'the tail names itself: destinations that settle no home currency');
    assert(!(await driver.isPresent('convert-dest-group-chf')), 'VCHF itself is the INPUT, not a destination — no CHF section');
    assert(!(await driver.isPresent('convert-dest-group-eur')), 'no EUR section — the picker carries no EURC destination on the IC');
    for (const g of ['convert-dest-group-usd', 'convert-dest-group-other']) {
      const text = await driver.readText(g);
      assert(!/\d/.test(text), `the header ${g} carries no number (a label, never a total) — got "${text}"`);
    }
    assertIncludes(await driver.readText('convert-dest-group-usd'), 'US dollars', 'the USD section names its currency');
    console.log('[206-convert-dest-groups] ✓ headers: US dollars → Other destinations, no numbers in any of them');

    // --- 2. DOM order: the USD destination first, then the tail in registry order ----------------
    const seq = await pickerLayout(driver);
    const usdIdx = seq.indexOf('convert-dest-group-usd');
    const otherIdx = seq.indexOf('convert-dest-group-other');
    assert(usdIdx !== -1 && otherIdx !== -1 && usdIdx < otherIdx, `the currency sections lead the tail, got: ${seq.join(' | ')}`);
    const usdRows = seq.slice(usdIdx + 1, otherIdx);
    assertEqJson(usdRows, ['convert-dest-inwallet-2'], 'the USD section carries exactly the ckUSDC destination row');
    const tail = seq.slice(otherIdx + 1);
    // Registry order inside the tail: the standing direct pair (ICP — it settles no home currency,
    // so it lives HERE), then the hub-reachable ckETH and ckBTC rows, then the external routes.
    assert(tail[0] === 'convert-dest-direct', `the direct pair leads the tail, got: ${tail.join(' | ')}`);
    assert(tail.includes('convert-dest-inwallet-6') && tail.indexOf('convert-dest-inwallet-6') < tail.indexOf('convert-dest-inwallet-1'),
      'the tail keeps registry order: ckETH before ckBTC');
    assert(tail.some(t => t.startsWith('convert-dest-route-')), 'the external route rows stay in the tail, under the honest header');
    console.log('[206-convert-dest-groups] ✓ order: USD row under its header; tail = direct → ckETH → ckBTC → routes');

    // --- 3. the rows are untouched: flows 188/190's pinned testIDs still resolve ------------------
    for (const row of ['convert-dest-direct', 'convert-dest-inwallet-2', 'convert-dest-inwallet-6', 'convert-dest-inwallet-1',
      'convert-dest-route-multihop:icpswap-vchf-ckusdc:2']) {
      assert(await driver.isPresent(row), `the pinned destination row ${row} still resolves under the grouping`);
    }
    assert(await driver.isPresent('convert-dest-group-other'), 'the grouping adds headers; it preselects nothing');
    await driver.screenshot('206-convert-dest-groups');
    console.log('[206-convert-dest-groups] ✓ every pinned row testID survives; the grouping is presentation only');

    console.log(`[206-convert-dest-groups] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
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
