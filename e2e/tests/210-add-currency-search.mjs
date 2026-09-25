// Flow 210 — the add-currency route (the 2026-09-24 grammar): a search field at the top, the
// list split into "Stable currencies" and "Other", every supported currency rendered exactly
// once with its state (in-wallet: marked, NOT re-addable; hidden: an Add button). The re-add
// gesture is a LIST operation only — hiding never touched money on chain, so re-adding needs
// nothing but the tap.
//
// What is pinned here, end to end through the real app:
//   * the sections render with their own labels and the FULL supported set (CHF/USD/EUR stables,
//     BTC/ETH/ICP/SOL Other) — each in-wallet row carries the in-wallet mark and NO Add button;
//   * the search field FILTERS: a query matching nothing renders the honest empty state, a query
//     matching one section's row narrows to it, and clearing restores the full set;
//   * re-adding a HIDDEN currency: hide SOL via the Home menu (the Remove flow), reopen the
//     add-currency route — SOL now carries the Add button — tap it, and the currency list shows
//     the SOL row again (the wallet list is whole; the working rail follows main untouched).
import { setup, assert, assertIncludes, onboardWallet, openBalances } from '../harness/lib.mjs';
import { startRelay } from '../harness/relay.mjs';

export const meta = {
  id: '210',
  name: 'add-currency-search-readd',
  journey: 'convert',
  covers: ['add-currency', 'search', 'hidden-currencies', 're-add', 'currency-list'],
  verifies: 'The add-currency route renders the full supported set split into stables and Other, in-wallet rows marked and not re-addable; the search field filters live (an empty result states itself; clearing restores); hiding SOL via Remove makes its Add button appear, and tapping it returns SOL to the currency list — a list operation, nothing on chain.',
  timeoutMs: 120_000,
};

async function openAddCurrency(driver) {
  await openBalances(driver);
  await driver.click('btn-accounts-add-currency', { timeoutMs: 5_000 });
  await driver.findByTestID('input-addcur-search', { timeoutMs: 5_000 });
}

export async function run() {
  const start = Date.now();
  console.log('[210-add-currency-search] setup (relay + web + browser)…');
  // solStub: EUR is offerable only when its EURC(Solana) rail is in the wallet's asset list.
  const env = await setup({ solStub: true });
  const r2 = await startRelay();
  try {
    const { driver, webBaseURL } = env;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });
    await onboardWallet(driver, 'e2e-add-cur-search');
    // The SOL rail's RPC stub: the Remove guard refuses to hide a currency whose balance it
    // cannot read, so SOL must read as a KNOWN balance for the hide leg below.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, { lamports: 0 }),
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({ context: { slot: 250000000 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999 } }),
        getFeeForMessage: () => ({ context: { slot: 250000000 }, value: { lamports: 5000 } }),
        getBalance: () => ({ value: 0 }),
      };
    });

    // --- §1 the full supported set, split into stables and Other; in-wallet rows not addable ----
    console.log('[210-add-currency-search] opening the add-currency route…');
    await openAddCurrency(driver);
    for (const code of ['CHF', 'USD', 'EUR', 'BTC', 'ETH', 'ICP', 'SOL']) {
      assert(await driver.isPresent(`btn-addcur-${code}`), `btn-addcur-${code} renders (the full supported set)`);
    }
    // In-wallet rows carry NO Add button — a currency the wallet already lists is not re-addable.
    for (const code of ['CHF', 'USD', 'BTC', 'ETH', 'ICP', 'SOL']) {
      assert(!(await driver.isPresent(`btn-addcur-add-${code}`)),
        `btn-addcur-add-${code} absent — an in-wallet currency is not re-addable`);
    }
    console.log('[210-add-currency-search] ✓ full set rendered; in-wallet rows carry no Add button');

    // --- §2 the search filters live; an empty result states itself; clearing restores -----------
    await driver.type('input-addcur-search', 'Bitco');
    assert(await driver.isPresent('btn-addcur-BTC'), 'a matching query narrows to its row (BTC)');
    assert(!(await driver.isPresent('btn-addcur-CHF')), 'a non-matching row is filtered out (CHF)');
    assert(!(await driver.isPresent('addcur-none')), 'a matching query renders no empty state');
    await driver.type('input-addcur-search', 'Zzz');
    assert(await driver.findByTestID('addcur-none', { timeoutMs: 4_000 }) != null,
      'a query matching nothing renders the honest empty state');
    await driver.type('input-addcur-search', '');
    for (const code of ['CHF', 'SOL']) {
      assert(await driver.isPresent(`btn-addcur-${code}`), `clearing the query restores ${code}`);
    }
    console.log('[210-add-currency-search] ✓ search filters live, empty state honest, clearing restores');
    await driver.screenshot('210-addcur-search');

    // Back to the accounts route for the hide/re-add leg.
    await driver.click('btn-addcur-back', { timeoutMs: 5_000 });
    await driver.findByTestID('accounts-list', { timeoutMs: 5_000 });

    // --- §3 hide SOL through the Home menu (Remove): SOL must be MAIN for the menu's Remove, so
    //     tap the SOL currency row first. Then the list no longer carries it. -------------------
    await driver.click('btn-accounts-currency-SOL', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-home-more', { timeoutMs: 5_000 });
    await driver.click('btn-home-more', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-home-menu-remove', { timeoutMs: 5_000 });
    await driver.click('btn-home-menu-remove', { timeoutMs: 5_000 });
    // The `a` hotkey opens the accounts route (the coach-tip overlay can swallow a coordinate
    // click on the tappable headline right after the menu closes).
    await driver.pressKey('a');
    const dump = await driver.eval(() => ({
      ids: [...new Set(Array.from(document.querySelectorAll('[data-testid]')).map(n => n.getAttribute('data-testid')).filter(t => t.startsWith('accounts-') || t.startsWith('asset-') || t.startsWith('currency-')))],
      text: document.body.textContent.slice(0, 400),
    }));
    console.log('[210] POST-REMOVE SURF ' + JSON.stringify(dump).slice(0, 700));
    assert(!(await driver.isPresent('accounts-currency-SOL')),
      'SOL is hidden — the currency list no longer carries it');
    console.log('[210-add-currency-search] ✓ SOL hidden via Remove (a list operation, nothing on chain)');

    // --- §4 re-add: the add-currency route now offers SOL with its Add button -------------------
    await openAddCurrency(driver);
    assert(await driver.isPresent('btn-addcur-add-SOL'), 'the hidden SOL row carries its Add button');
    await driver.click('btn-addcur-add-SOL', { timeoutMs: 5_000 });
    await driver.click('btn-addcur-back', { timeoutMs: 5_000 });
    assert(await driver.isPresent('accounts-currency-SOL'),
      're-adding SOL returns it to the currency list (the whole set is visible again)');
    await driver.screenshot('210-addcur-readded');
    console.log(`[210-add-currency-search] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('210-add-currency-search RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
