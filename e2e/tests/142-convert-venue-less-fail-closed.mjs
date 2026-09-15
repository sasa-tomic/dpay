// Flow 142 — delegated conversion is uniform-IA: venue-less assets fail closed with honest copy.
//
// The Convert entry point is the SAME button for every asset (uniform-IA hard rule); the venue
// check happens INSIDE the surface, never by hiding the button (spec §0 + §6 e2e (c)):
//   * ckBTC (a mainnet asset with no registered venue): the surface renders the fail-closed
//     panel with the honest what-exists-today copy naming every pair dpay converts today
//     ("ICP ↔ VCHF, ICP ↔ ckUSDC and ICP ↔ ckETH through ICPSwap — and nothing else" — the
//     copy grew with the pair-scoped ICPSwap pools, 2026-09-15), never a teaser, never a
//     waitlist;
//   * DEMO (a plain venue-less asset): the same fail-closed panel and the same copy;
//   * the panel gives the way back to the accounts list (a real action, not a dead end);
//   * no quote is fetched and no amount field is offered on the fail-closed surface.
//   * Screenshots: both fail-closed panels.
import {setup, assert, assertIncludes, onboardWallet, openBalances, selectCurrency} from '../harness/lib.mjs';

export const meta = {
  id: '142',
  name: 'convert-venue-less-fail-closed',
  journey: 'convert',
  covers: ['convert', 'uniform-ia', 'venue-less', 'fail-closed', 'ckbtc', 'honest-copy', 'demo'],
  verifies: 'Every asset gets the same Convert button; assets without a venue fail closed INSIDE the surface: ckBTC and DEMO show the honest what-exists-today copy naming all three converted pairs, and neither offers an amount field or a quote.',
  timeoutMs: 45000,
};

export async function run() {
  const start = Date.now();
  console.log('[142-convert-venue-less] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[142-convert-venue-less] onboarding…');
    await onboardWallet(driver, 'e2e-convert-venueless');

    // --- ckBTC: fail closed with the exhaustive what-exists-today copy -------------------------
    console.log('[142-convert-venue-less] ckBTC → fail-closed panel…');
    // selectCurrency makes ckBTC the active asset and leaves on Pay; re-open the accounts route so
    // Convert (which renders on the SELECTED row only) is on screen.
    await openBalances(driver);
    await selectCurrency(driver, 'ckbtc');
    await openBalances(driver);
    await driver.waitForText('Convert', { timeoutMs: 6_000 });
    await driver.click('btn-accounts-convert', { timeoutMs: 5_000 });
    assert(await driver.findByTestID('convert-unavailable', { timeoutMs: 8_000 }) != null, 'ckBTC lands on the fail-closed panel (not the form)');

    assertIncludes(await driver.readText('convert-unavailable-title'), 'BTC', 'fail-closed title names the selected asset (BTC)');
    const btBody = await driver.readText('convert-unavailable-body');
    assertIncludes(btBody, 'ICP ↔ VCHF', 'fail-closed body names what exists today (ICP ↔ VCHF)');
    assertIncludes(btBody, 'ICP ↔ ckUSDC', 'fail-closed body names what exists today (ICP ↔ ckUSDC)');
    assertIncludes(btBody, 'ICP ↔ ckETH', 'fail-closed body names what exists today (ICP ↔ ckETH)');
    assertIncludes(btBody, 'ICPSwap', 'fail-closed body names the venue');
    assertIncludes(btBody, 'nothing else', 'fail-closed copy is exhaustive, never a teaser');

    const btAll = await driver.bodyText();
    assert(!btAll.includes('Minimum you\'ll receive'), 'no quote surface (no minimum-receive line) on a venue-less asset');
    assert(await driver.findByTestID('convert-amount', { timeoutMs: 1_000 }).catch(() => null) == null, 'no amount field on the fail-closed surface');
    await driver.screenshot('142-convert-venueless-ckbtc');

    // Back to the accounts list is a real action, then DEMO: the same panel, the same copy.
    await driver.click('btn-convert-back', { timeoutMs: 5_000 });
    assert(await driver.findByTestID('accounts-list', { timeoutMs: 6_000 }) != null, 'back returns to the accounts list (no dead end)');

    // Back landed the accounts route, so the DEMO row is right there; selectCurrency leaves on Pay,
    // so re-open the route for the Convert button on the newly selected row.
    await selectCurrency(driver, 'demo');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', { timeoutMs: 5_000 });
    assert(await driver.findByTestID('convert-unavailable', { timeoutMs: 8_000 }) != null, 'DEMO lands on the same fail-closed panel');
    assertIncludes(await driver.readText('convert-unavailable-title'), 'DEMO', 'fail-closed title names DEMO');
    const dmBody = await driver.readText('convert-unavailable-body');
    assertIncludes(dmBody, 'ICP ↔ ckUSDC', 'same honest what-exists-today copy for DEMO');
    assertIncludes(dmBody, 'nothing else', 'the copy stays exhaustive, never a teaser');
    await driver.screenshot('142-convert-venueless-demo');

    console.log(`[142-convert-venue-less] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('142-convert-venue-less RED:', e.stack || e.message || e);
  });
}
