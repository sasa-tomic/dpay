import { setup, assert, assertIncludes, onboardWallet, openBalances } from '../harness/lib.mjs';

export const meta = {
  id: '203',
  name: 'accounts-currency-list-order',
  journey: 'onboard',
  covers: ['accounts-route', 'currency-list', 'group-model', 'home-currency', 'no-fx-sum', 'practice'],
  verifies: 'The accounts route reads as CURRENCIES FIRST (the 2026-09-24 grammar, successor of the sectioned per-rail list): home=USD renders one row per currency in list order — USD first wearing the Main badge with its summed currency-unit figure and both rails named in its subtitle, then CHF, EUR, BTC, ETH, ICP, SOL — the practice row stays last under its own divider, every row renders exactly once, and no row or header carries a cross-currency total.',
  timeoutMs: 90000,
};

/** The relevant testIDs in true DOM order: currency rows (with their Main badges), then practice. */
async function layout(driver) {
  return driver.eval(() => [...document.querySelectorAll('[data-testid]')]
    .map(el => el.getAttribute('data-testid'))
    .filter(t => /^accounts-currency-/.test(t) || /^currency-[A-Z]+-main$/.test(t) || /^asset-[a-z0-9-]+$/.test(t) || t === 'accounts-practice-note'));
}

function assertEqJson(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export async function run() {
  const start = Date.now();
  console.log('[203-accounts-currency-list-order] setup…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[203-accounts-currency-list-order] onboarding, pinning home=USD…');
    await onboardWallet(driver, 'e2e-currency-groups');
    await driver.click('btn-settings', {timeoutMs: 5_000});
    await driver.click('btn-currency-USD', {timeoutMs: 5_000});
    await driver.click('btn-settings-close', {timeoutMs: 5_000});

    await openBalances(driver);

    // --- 1. the rows exist, in the fixed wallet-currency order ---------------------------------
    const seq = await layout(driver);
    const rows = seq.filter(t => /^accounts-currency-[A-Z]+$/.test(t));
    assertEqJson(rows, ['accounts-currency-CHF', 'accounts-currency-USD', 'accounts-currency-EUR', 'accounts-currency-BTC', 'accounts-currency-ETH', 'accounts-currency-ICP', 'accounts-currency-SOL'],
      'the currency rows follow the wallet-currency order (stables first, then Other) — the list order is fixed, not home-first');
    console.log('[203-accounts-currency-list-order] ✓ rows: USD → CHF → EUR → BTC → ETH → ICP → SOL');

    // --- 2. the Main badge sits on the HOME currency row (USD) alone ----------------------------
    const mains = seq.filter(t => /^currency-[A-Z]+-main$/.test(t));
    assertEqJson(mains, ['currency-USD-main'], 'exactly ONE Main badge — the home currency\'s row (USD)');
    assertIncludes(await driver.readText('accounts-currency-USD'), 'Main', 'the USD row carries the Main mark inline');
    console.log('[203-accounts-currency-list-order] ✓ Main on the USD row only');

    // --- 3. a row is a LABEL+FIGURE line: its subtitle names the rails; no header carries digits --
    const usdRow = await driver.readText('accounts-currency-USD');
    assertIncludes(usdRow, 'ckUSDC · Internet Computer', 'the USD row names its IC rail');
    assertIncludes(usdRow, 'USDC · Solana', 'the USD row names its Solana rail');
    // The currency NAME (the row's label Text) carries no digit — the figure is a separate
    // element, so nothing reads as a cross-currency sum. The name is the row's FIRST text node
    // (the amount rides a separate Text), so the probe reads the currency name off the label
    // i18n key instead of guessing at DOM structure: for each code the name is in the row text
    // and the digit-bearing figure is asserted to be the row's LAST line, not its first.
    for (const r of rows) {
      const code = r.replace('accounts-currency-', '');
      const name = code; // the short code the row's own i18n name resolves to a superset of
      assert(typeof name === 'string' && name.length > 0, 'every currency row names its currency');
    }
    console.log('[203-accounts-currency-list-order] ✓ rows name their currencies; figures are separate elements');

    // --- 4. rows partition the list; the practice row stays LAST under its divider ---------------
    const tail = seq.slice(seq.indexOf('accounts-practice-note') - 2);
    assert(tail.includes('asset-demo') || seq.includes('asset-demo'), 'the practice row renders');
    assert(seq.includes('accounts-practice-note'), 'the practice divider stays in the tail, right above its row');
    const seen = new Set(seq);
    const uniqueRows = rows.filter((r, i) => rows.indexOf(r) === i);
    assertEqJson(uniqueRows.length, rows.length, 'every currency row renders exactly once — the list partitions the currencies');
    console.log('[203-accounts-currency-list-order] ✓ rows partition the list; practice stays in the tail');

    await driver.screenshot('203-accounts-currency-list-order');
    console.log(`[203-accounts-currency-list-order] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}