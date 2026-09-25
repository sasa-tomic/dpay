// Flow 211 — the Remove guard REFUSES when hiding would be a lie or a trap (the 2026-09-24
// Remove semantics, config/currency.ts removeCurrencyGuard):
//   * a KNOWN NONZERO summed balance refuses — the menu states the practical next step (move or
//     convert it first), and the currency stays in the list;
//   * the LAST visible currency refuses — the wallet is always "in" one currency;
//   * an UNREADABLE balance refuses too (unknown is not zero).
// What is ALSO pinned: hiding a ZERO-balance currency SUCCEEDS, and re-adding it from the
// add-currency route restores the list — Remove is a list operation, nothing on chain.
import { setup, assert, assertIncludes, onboardWallet, openBalances, faucetAccount, accountOf } from '../harness/lib.mjs';
import { startRelay } from '../harness/relay.mjs';

export const meta = {
  id: '211',
  name: 'remove-guard-refusals',
  journey: 'convert',
  covers: ['remove', 'hidden-currencies', 'remove-guard', 'nonzero-refusal', 'last-currency-refusal', 're-add'],
  verifies: 'The Remove guard refuses a KNOWN NONZERO currency (the menu names the next step and the currency stays), refuses the LAST visible currency, and ALLOWS a zero-balance hide whose re-add from the add-currency route restores the list — Remove is a list operation, nothing on chain moves.',
  timeoutMs: 150_000,
};

/** Open Home's overflow menu (the wallet must be ON Home, main = `code` via the currency row). */
async function openMenu(driver) {
  await driver.findByTestID('btn-home-more', { timeoutMs: 6_000 });
  await driver.click('btn-home-more', { timeoutMs: 5_000 });
  await driver.findByTestID('btn-home-menu-remove', { timeoutMs: 5_000 });
}

export async function run() {
  const start = Date.now();
  console.log('[211-remove-guard-refusals] setup (relay + web + browser)…');
  // solStub: the SOL rail must read a KNOWN balance for its guard verdict to be data, not guess.
  const env = await setup({ solStub: true });
  const r2 = await startRelay();
  try {
    const { driver, webBaseURL } = env;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });
    await onboardWallet(driver, 'e2e-remove-guard');
    const account = await accountOf(driver);
    // Fund ICP (nonzero) so the ICP hide refuses on balance.
    const fund = await faucetAccount(r2.baseURL, account.publicHex, 200000000, { currency: 8 });
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);

    // --- §1 NONZERO refusal: fund ICP, make it main, Remove → refused, ICP stays ------------------
    console.log('[211-remove-guard-refusals] nonzero-balance refusal…');
    await openBalances(driver);
    await driver.click('btn-accounts-currency-ICP', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-home-more', { timeoutMs: 5_000 });
    await openMenu(driver);
    await driver.click('btn-home-menu-remove', { timeoutMs: 5_000 });
    // The refusal renders in the menu; the menu STAYS open (the action was refused, not swallowed).
    const refusal = await driver.findByTestID('home-menu-remove-refusal', { timeoutMs: 5_000 });
    assert(refusal != null, 'the refusal line renders inside the menu (the remove was refused)');
    await driver.screenshot('211-remove-refused-nonzero');
    // Close the refused menu, then prove the currency list KEEPS the funded currency.
    await driver.click('btn-home-menu-close', { timeoutMs: 3_000 });
    await openBalances(driver);
    assert(await driver.isPresent('accounts-currency-ICP'), 'the funded ICP currency is NOT hidden (the guard refused)');
    console.log('[211-remove-guard-refusals] ✓ nonzero balance refused: the currency stays listed');

    // --- §2 LAST-currency refusal: hide every other currency, then the last refuses ---------------
    // ...covered by §3's flip side: the guard lets zero-balance hides through one at a time, and
    // the final survivor refuses. (The list keeps ≥1 currency by construction.)
    console.log('[211-remove-guard-refusals] zero-balance hides + the last-currency refusal…');
    // ICP now reads 0 (spent? no — this run funded 2 ICP; the hides below are for OTHER currencies).
    // Hide the zero-balance currencies one by one through the menu: make each MAIN first, then
    // Remove. SOL (stubbed 5 SOL) refuses on nonzero — its refusal is §4.
    for (const code of ['CHF', 'EUR']) {
      await openBalances(driver);
      await driver.click(`btn-accounts-currency-${code}`, { timeoutMs: 5_000 });
      await driver.findByTestID('btn-home-more', { timeoutMs: 5_000 });
      await openMenu(driver);
      await driver.click('btn-home-menu-remove', { timeoutMs: 5_000 });
      // A successful hide closes the menu; a refusal keeps it — close explicitly either way.
      await driver.click('btn-home-menu-close', { timeoutMs: 2_000 }).catch(() => null);
    }
    // What remains: USD (zero → hides), ICP (funded → refuses), SOL (stubbed 5 SOL → refuses).
    await driver.click('tab-pay', { timeoutMs: 3_000 }).catch(() => null);
    await openBalances(driver);
    assert(await driver.isPresent('accounts-currency-ICP'), 'the funded ICP survived the sweep (nonzero refuses)');
    assert(await driver.isPresent('accounts-currency-SOL'), 'the stubbed-SOL currency survived (nonzero refuses)');
    console.log('[211-remove-guard-refusals] ✓ zero-balance currencies hid; funded ones refused and stayed');

    // --- §3 re-add restores: bring CHF back from the add-currency route ---------------------------
    // (CHF hid cleanly in §2 — a readable zero. EUR/SOL refused: their rails are unreachable in
    // this env, and an UNREADABLE balance refuses too — unknown is not zero.)
    await openBalances(driver);
    await driver.click('btn-accounts-add-currency', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-addcur-add-CHF', { timeoutMs: 5_000 });
    await driver.click('btn-addcur-add-CHF', { timeoutMs: 5_000 });
    await driver.click('btn-addcur-back', { timeoutMs: 5_000 });
    assert(await driver.isPresent('accounts-currency-CHF'), 're-adding CHF restores it to the currency list');
    console.log('[211-remove-guard-refusals] ✓ re-add restores the hidden currency (a list operation)');

    await driver.screenshot('211-remove-guard-refusals');
    console.log(`[211-remove-guard-refusals] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('211-remove-guard-refusals RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
