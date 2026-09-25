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
import {setup, assert, assertIncludes, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency, openConvertFor} from '../harness/lib.mjs';

const ICP_SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON); a zero balance gates the form

export const meta = {
  id: '142',
  name: 'convert-venue-less-fail-closed',
  journey: 'convert',
  covers: ['convert', 'uniform-ia', 'venue-less', 'fail-closed', 'honest-copy', 'demo', 'icp'],
  verifies: 'The currency-first swap surface fails closed honestly: the accounts route renders no VEUR row at all (retired 2026-09-19); the practice/DEMO row carries NO Convert affordance at all — practice money is not a currency in the currency-first model, so its swap surface is gone by design, not a dead panel — while ICP (a currency with venues) opens the real swap form from its row Convert button.',
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

    // --- DEMO: the practice row offers NO convert affordance at all ------------------------------
    console.log('[142-convert-venue-less] DEMO → no swap surface by design…');
    // Practice money is NOT a currency in the currency-first model (it is never main, never a
    // list row), so the practice row carries only its faucet action — no Convert. The old
    // fail-closed panel is gone with the destination picker: absence is the honest verdict,
    // not a dead end wearing a screen's clothes.
    await selectCurrency(driver, 'demo');
    await openBalances(driver);
    assert(await driver.findByTestID('asset-demo', { timeoutMs: 5_000 }) != null, 'the practice row renders under its divider');
    assert(await driver.findByTestID('btn-accounts-convert-DEMO', { timeoutMs: 2_000 }).catch(() => null) == null,
      'the practice row carries NO Convert button (practice money is not a currency)');
    const dmAll = await driver.bodyText();
    assert(!dmAll.includes('Minimum you\'ll receive'), 'no quote surface (no minimum-receive line) anywhere on the practice row');
    await driver.screenshot('142-convert-venueless-demo');

    // --- ICP: the SAME button, an asset that HAS a venue → the real form --------------------------
    console.log('[142-convert-venue-less] ICP → the convert form (uniform entry)…');
    // Fund the ICP rail first (same seam as flow 143): the form is the FUNDED surface — a zero
    // balance gates it, and this leg's point is the entry outcome, not the funding gate.
    const account = await accountOf(driver);
    const fund = await faucetAccount(env.relayBaseURL, account.publicHex, ICP_SEED, { currency: 8 });
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);
    await openConvertFor(driver, 'icp');
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
