// Flow 142 — delegated conversion is uniform-IA: venue-less assets fail closed with honest copy.
//
// The Convert entry point is the SAME button for every asset (uniform-IA hard rule); the venue
// check happens INSIDE the surface, never by hiding the button (spec §0 + §6 e2e (c)):
//   * ckUSDC (the strongest venue-less case — spec §1 measured its direct VCHF pool as saturated,
//     depth ≈ CHF 315, and REFUSES it in the PoC): the surface renders the fail-closed panel with
//     the honest what-exists-today copy AND the ckUSDC-specific saturated-pool refusal line;
//   * DEMO (a plain venue-less asset): the same fail-closed panel WITHOUT the ckUSDC line — the
//     generic copy names exactly what exists today ("ICP ↔ Swiss francs (VCHF) through ICPSwap —
//     and nothing else"), never a teaser, never a waitlist;
//   * the panel gives the way back to the accounts list (a real action, not a dead end);
//   * no quote is fetched and no amount field is offered on the fail-closed surface.
//   * Screenshots: both fail-closed panels.
import {setup, assert, assertIncludes, onboardWallet, openBalances, selectCurrency} from '../harness/lib.mjs';

export const meta = {
  id: '142',
  name: 'convert-venue-less-fail-closed',
  journey: 'convert',
  covers: ['convert', 'uniform-ia', 'venue-less', 'fail-closed', 'ckusdc', 'saturated-pool', 'honest-copy', 'demo'],
  verifies: 'Every asset gets the same Convert button; assets without a venue fail closed INSIDE the surface: ckUSDC shows the honest what-exists-today copy plus the saturated-direct-pool refusal line (spec §1), DEMO shows the generic copy without it, and neither offers an amount field or a quote.',
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

    // --- ckUSDC: fail closed + the saturated direct-pool refusal (spec §1) ----------------------
    console.log('[142-convert-venue-less] ckUSDC → fail-closed panel with the saturated-pool line…');
    // selectCurrency makes ckUSDC the active asset and leaves on Pay; re-open the accounts route so
    // Convert (which renders on the SELECTED row only) is on screen.
    await openBalances(driver);
    await selectCurrency(driver, 'ckusdc');
    await openBalances(driver);
    await driver.waitForText('Convert', { timeoutMs: 6_000 });
    await driver.click('btn-accounts-convert', { timeoutMs: 5_000 });
    assert(await driver.findByTestID('convert-unavailable', { timeoutMs: 8_000 }) != null, 'ckUSDC lands on the fail-closed panel (not the form)');

    const ckTitle = await driver.readText('convert-unavailable-title');
    assertIncludes(ckTitle, 'USDC', 'fail-closed title names the selected asset (USDC)');
    const ckBody = await driver.readText('convert-unavailable-body');
    assertIncludes(ckBody, 'ICP ↔ Swiss francs (VCHF)', 'fail-closed body names exactly what exists today (ICP ↔ Swiss francs (VCHF))');
    assertIncludes(ckBody, 'ICPSwap', 'fail-closed body names the venue');
    assertIncludes(ckBody, 'nothing else', 'fail-closed copy is exhaustive, never a teaser');
    const ckLine = await driver.readText('convert-unavailable-ckusdc');
    assert(ckLine.length > 0, 'the ckUSDC-specific line renders (the saturated direct pool refusal)');

    const ckAll = await driver.bodyText();
    assert(!ckAll.includes('Minimum you\'ll receive'), 'no quote surface (no minimum-receive line) on a venue-less asset');
    assert(await driver.findByTestID('convert-amount', { timeoutMs: 1_000 }).catch(() => null) == null, 'no amount field on the fail-closed surface');
    await driver.screenshot('142-convert-venueless-ckusdc');

    // Back to the accounts list is a real action, then DEMO: same panel, NO ckUSDC line.
    await driver.click('btn-convert-back', { timeoutMs: 5_000 });
    assert(await driver.findByTestID('accounts-list', { timeoutMs: 6_000 }) != null, 'back returns to the accounts list (no dead end)');

    // Back landed the accounts route, so the DEMO row is right there; selectCurrency leaves on Pay,
    // so re-open the route for the Convert button on the newly selected row.
    await selectCurrency(driver, 'demo');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', { timeoutMs: 5_000 });
    assert(await driver.findByTestID('convert-unavailable', { timeoutMs: 8_000 }) != null, 'DEMO lands on the same fail-closed panel');
    assertIncludes(await driver.readText('convert-unavailable-title'), 'DEMO', 'fail-closed title names DEMO');
    assertIncludes(await driver.readText('convert-unavailable-body'), 'ICP ↔ Swiss francs (VCHF)', 'same honest what-exists-today copy for DEMO');
    assert(await driver.findByTestID('convert-unavailable-ckusdc', { timeoutMs: 1_000 }).catch(() => null) == null, 'the ckUSDC-specific line does NOT render for DEMO');
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
