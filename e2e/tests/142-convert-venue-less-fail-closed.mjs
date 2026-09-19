// Flow 142 — delegated conversion is uniform-IA: the venue-less subject fails closed with honest
// copy, and a venue subject opens the form from the SAME button.
//
// The Convert entry point is the SAME button for every asset (uniform-IA hard rule); the venue
// check happens INSIDE the surface, never by hiding the button (spec §0 + §6 e2e (c)). The
// 2026-09-19 VEUR retirement (currency 9, `4851c88`) removed the flow's former co-subject, and
// it also removed the excuse: DEMO is now the ONLY venue-less mainnet row in the catalog — every
// other bundled row has a registered route (the ICPSwap ic_amm family, Jupiter's SOL↔USDC and
// SOL↔EURC, SideShift's cross-rail pairs). So the flow pins the rule from BOTH sides with what
// honestly exists today:
//   * the retirement itself: the accounts route renders NO VEUR row at all — a retired asset
//     must not survive as a selectable surface;
//   * DEMO (venue-less): the fail-closed panel with the honest what-exists-today copy naming all
//     six IC pairs dpay converts today ("VCHF ↔ ICP, ICP ↔ USDC, ICP ↔ ETH, BTC ↔ ICP, BTC ↔ ETH
//     and VCHF ↔ USDC through ICPSwap — and nothing else" — the copy is DERIVED from the bundled
//     mainnet ic_amm registry, so it names exactly what exists), never a teaser, never a
//     waitlist;
//   * ICP (has a venue): the SAME button opens the real convert form — the fail-closed panel is
//     the asset's data, not a different IA;
//   * the panel gives the way back to the accounts list (a real action, not a dead end);
//   * no quote is fetched and no amount field is offered on the fail-closed surface.
//   * Screenshots: the fail-closed panel.
import {setup, assert, assertIncludes, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency} from '../harness/lib.mjs';

const ICP_SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON); a zero balance gates the form

export const meta = {
  id: '142',
  name: 'convert-venue-less-fail-closed',
  journey: 'convert',
  covers: ['convert', 'uniform-ia', 'venue-less', 'fail-closed', 'honest-copy', 'demo', 'icp'],
  verifies: 'Every asset gets the same Convert button and the outcome is data-driven INSIDE the surface: the accounts route renders no VEUR row at all (retired 2026-09-19); DEMO — the only venue-less mainnet row left — fails closed with the honest what-exists-today copy naming all six IC converted pairs (derived from the bundled registry) and offers no amount field or quote, while ICP (has a venue) opens the real form from the same button.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[142-convert-venue-less] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[142-convert-venue-less] onboarding…');
    await onboardWallet(driver, 'e2e-convert-venueless');

    // --- the retirement: no VEUR row anywhere ---------------------------------------------------
    await openBalances(driver);
    assert(!(await driver.findByTestID('asset-veur', { timeoutMs: 3_000 }).catch(() => null)),
      'VEUR (currency 9) is retired — the accounts route must render NO row for it');

    // --- DEMO: fail closed with the exhaustive what-exists-today copy ----------------------------
    console.log('[142-convert-venue-less] DEMO → fail-closed panel…');
    // selectCurrency makes DEMO the active asset and leaves on Pay; re-open the accounts route so
    // Convert (which renders on the SELECTED row only) is on screen.
    await selectCurrency(driver, 'demo');
    await openBalances(driver);
    await driver.waitForText('Convert', { timeoutMs: 6_000 });
    await driver.click('btn-accounts-convert', { timeoutMs: 5_000 });
    assert(await driver.findByTestID('convert-unavailable', { timeoutMs: 8_000 }) != null, 'DEMO lands on the fail-closed panel (not the form)');

    assertIncludes(await driver.readText('convert-unavailable-title'), 'DEMO', 'fail-closed title names the selected asset (DEMO)');
    const dmBody = await driver.readText('convert-unavailable-body');
    assertIncludes(dmBody, 'VCHF ↔ ICP', 'fail-closed body names what exists today (VCHF ↔ ICP)');
    assertIncludes(dmBody, 'ICP ↔ USDC', 'fail-closed body names what exists today (ICP ↔ USDC)');
    assertIncludes(dmBody, 'ICP ↔ ETH', 'fail-closed body names what exists today (ICP ↔ ETH)');
    assertIncludes(dmBody, 'BTC ↔ ICP', 'fail-closed body names what exists today (BTC ↔ ICP)');
    assertIncludes(dmBody, 'BTC ↔ ETH', 'fail-closed body names what exists today (BTC ↔ ETH)');
    assertIncludes(dmBody, 'VCHF ↔ USDC', 'fail-closed body names what exists today (VCHF ↔ USDC)');
    assertIncludes(dmBody, 'ICPSwap', 'fail-closed body names the venue');
    assertIncludes(dmBody, 'nothing else', 'fail-closed copy is exhaustive, never a teaser');

    const dmAll = await driver.bodyText();
    assert(!dmAll.includes('Minimum you\'ll receive'), 'no quote surface (no minimum-receive line) on a venue-less asset');
    assert(await driver.findByTestID('convert-amount', { timeoutMs: 1_000 }).catch(() => null) == null, 'no amount field on the fail-closed surface');
    await driver.screenshot('142-convert-venueless-demo');

    // Back to the accounts list is a real action, then the contrast leg.
    await driver.click('btn-convert-back', { timeoutMs: 5_000 });
    assert(await driver.findByTestID('accounts-list', { timeoutMs: 6_000 }) != null, 'back returns to the accounts list (no dead end)');

    // --- ICP: the SAME button, an asset that HAS a venue → the real form --------------------------
    console.log('[142-convert-venue-less] ICP → the convert form (uniform entry)…');
    // Fund the ICP rail first (same seam as flow 143): the form is the FUNDED surface — a zero
    // balance gates it, and this leg's point is the entry outcome, not the funding gate.
    const account = await accountOf(driver);
    const fund = await faucetAccount(env.relayBaseURL, account.publicHex, ICP_SEED, { currency: 8 });
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);
    // selectCurrency leaves on Pay, so re-open the route for the Convert button on the newly
    // selected row.
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', { timeoutMs: 5_000 });
    assert(await driver.findByTestID('convert-screen', { timeoutMs: 8_000 }) != null, 'an asset with a venue opens the real convert form');
    assert(await driver.findByTestID('convert-amount', { timeoutMs: 4_000 }) != null, 'the form offers the amount field DEMO was denied');
    assert(await driver.findByTestID('convert-unavailable', { timeoutMs: 1_000 }).catch(() => null) == null,
      'the fail-closed panel must NOT render for an asset that has a venue — same button, data-driven outcome');

    console.log(`[142-convert-venue-less] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('142-convert-venue-less RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
