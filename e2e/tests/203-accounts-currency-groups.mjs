// Flow 203 — the ACCOUNTS ROUTE reads as currencies first (multi-currency build-out, 2026-09).
//
// `groupAccountsByCurrency` (app/config/currency.ts) partitions the ordered account list into
// LABELLED sections: the home currency first, then every other offered currency in HOME_CURRENCIES
// order, then the tail of assets that settle no home currency (BTC/ETH/ICP/SOL/practice). What is
// pinned here, end to end through the real app with home=USD:
//
//   * the section HEADERS exist, in the fixed order, and each NAMES its currency — "Main · US
//     dollars", "Swiss francs", "Euros", "Other assets";
//   * a header is a LABEL, never a total: no header may carry a digit, because a number beside a
//     currency name would read as a cross-asset sum and dpay quotes no FX (invariant E5);
//   * every row still renders exactly once, under the right header — the practice rail stays in
//     the tail with its divider, and the two USD rails stay in the one USD section (flow 121 pins
//     their badges; this flow pins the sectioning).
import { setup, assert, assertIncludes, onboardWallet, openBalances } from '../harness/lib.mjs';

export const meta = {
  id: '203',
  name: 'accounts-currency-groups',
  journey: 'onboard',
  covers: ['accounts-route', 'currency-groups', 'group-model', 'home-currency', 'no-fx-sum', 'practice'],
  verifies: 'The accounts route is sectioned by the currency each account settles: home=USD reads "Main · US dollars" (both dollar rails), then "Swiss francs", then "Euros", then "Other assets" — headers name currencies and carry no digits (a label, never a total), and every row renders exactly once under its own header with the practice rail in the tail.',
  timeoutMs: 90000,
};

/** The relevant testIDs in true DOM order: section headers, then the rows under each. */
async function layout(driver) {
  return driver.eval(() => [...document.querySelectorAll('[data-testid]')]
    .map(el => el.getAttribute('data-testid'))
    .filter(t => /^accounts-group-/.test(t) || /^asset-[a-z0-9-]+$/.test(t) || t === 'accounts-practice-note'));
}

function assertEqJson(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export async function run() {
  const start = Date.now();
  console.log('[203-accounts-currency-groups] setup…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[203-accounts-currency-groups] onboarding, pinning home=USD…');
    await onboardWallet(driver, 'e2e-currency-groups');
    await driver.click('btn-settings', {timeoutMs: 5_000});
    await driver.click('btn-currency-USD', {timeoutMs: 5_000});
    await driver.click('btn-settings-close', {timeoutMs: 5_000});

    await openBalances(driver);

    // --- 1. the headers exist, in the fixed order, naming their currency ------------------------
    const groups = await driver.eval(() =>
      [...document.querySelectorAll('[data-testid^="accounts-group-"]')].map(el => el.getAttribute('data-testid')));
    assertEqJson(groups, ['accounts-group-usd', 'accounts-group-chf', 'accounts-group-eur', 'accounts-group-other'],
      'the sections follow HOME_CURRENCIES order with the tail last');
    assertIncludes(await driver.readText('accounts-group-usd'), 'Main · US dollars', 'the home section NAMES the currency (and that it is the main one)');
    assertIncludes(await driver.readText('accounts-group-chf'), 'Swiss francs', 'the CHF section names its currency');
    assertIncludes(await driver.readText('accounts-group-eur'), 'Euros', 'the EUR section names its currency');
    assertIncludes(await driver.readText('accounts-group-other'), 'Other assets', 'the tail names itself honestly');
    console.log('[203-accounts-currency-groups] ✓ headers: usd → chf → eur → other, each naming its currency');

    // --- 2. a header is a LABEL: no digit may render in one -------------------------------------
    for (const g of groups) {
      const text = await driver.readText(g);
      assert(!/\d/.test(text), `the section header ${g} must carry no number (a label, never a total) — got "${text}"`);
    }
    console.log('[203-accounts-currency-groups] ✓ no header carries a digit — nothing is summed');

    // --- 3. rows sit under the right headers, each exactly once ---------------------------------
    const seq = await layout(driver);
    const under = (header, stopAt) => {
      const i = seq.indexOf(header);
      const j = stopAt === null ? seq.length : seq.indexOf(stopAt);
      return seq.slice(i + 1, j);
    };
    const usdRows = under('accounts-group-usd', 'accounts-group-chf');
    assert(usdRows.includes('asset-ckusdc') && usdRows.includes('asset-sol-usdc'),
      `both dollar rails sit in the ONE usd section, got: ${usdRows.join(', ')}`);
    assert(usdRows.includes('asset-ckusdc-main'), 'the preferred rail keeps its MAIN badge inside its section');
    const chfRows = under('accounts-group-chf', 'accounts-group-eur');
    assert(chfRows.includes('asset-vchf'), 'vchf sits in the chf section');
    const seqAll = await layout(driver);
    assert(!seqAll.includes('asset-vchf-main'), 'with home=USD only the USD group carries MAIN — a foreign currency wears no main badge');
    const eurRows = under('accounts-group-eur', 'accounts-group-other');
    assert(eurRows.includes('asset-sol-eurc'), 'the EURC rail sits in the eur section');
    assert(!seqAll.includes('asset-sol-eurc-main'), 'the EURC rail wears no MAIN either — MAIN belongs to the home currency alone');
    const tail = under('accounts-group-other', null);
    for (const key of ['ckbtc', 'cketh', 'icp', 'demo']) {
      assert(tail.includes(`asset-${key}`), `asset-${key} settles no home currency — it belongs in the tail (got: ${tail.join(', ')})`);
    }
    assert(tail.includes('accounts-practice-note'), 'the practice divider stays in the tail, right above its row');
    const rows = seq.filter(t => /^asset-[a-z0-9-]+$/.test(t));
    assertEqJson(new Set(rows).size, rows.length, 'every row renders exactly once — the sections partition the list');
    console.log('[203-accounts-currency-groups] ✓ rows partition under their headers; practice stays in the tail');

    await driver.screenshot('203-accounts-currency-groups');
    console.log(`[203-accounts-currency-groups] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('203-accounts-currency-groups RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
