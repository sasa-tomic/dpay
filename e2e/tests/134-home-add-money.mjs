// Flow 134 — Home add-money, and where the practice faucet went.
//
// Home's action row acts on the account the SCREEN IS SHOWING — the home currency's rail — so no
// button on Home can move money into an account the headline is not naming. That is the other half
// of the X4 fix: the headline stopped following the transient selection, so the actions beside it
// had to stop following it too.
//   (a) Add money on Home lands the EXISTING deposit surface for the home rail (Receive → My
//       address), the same surface the fund gates use — even when another account is selected;
//   (b) the DEMO faucet is not a Home action any more: it is the practice row's own button in the
//       accounts route;
//   (c) the `T` hotkey still fires the faucet from anywhere, and its answer is visible on the
//       accounts route — a hotkey that fails silently is a bug (founder rule 2026-08-29).
//
// WHAT A TAP CAN PROVE, AND WHY IT IS NOT "+∂100" (corrected 2026-09-08). The faucet gives one
// top-up per (account, currency) per hour, and ONBOARDING HAS ALREADY SPENT IT — so inside a flow
// there is no second credit to observe, on any wallet, in production or here. This flow used to
// assert ∂100 → ∂200 → ∂300 because the offline fixture faucet had no cooldown at all; it now has
// the same one production has, so what a tap proves is that the button and the hotkey reach the
// relay and that its own refusal reaches the user. The successful credit is flow 01's ∂100.
import { setup, assert, assertIncludes, onboardWallet, openBalances, selectCurrency } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '134',
  name: 'home-add-money',
  journey: 'deposit',
  covers: ['home-tab', 'add-money', 'faucet'],
  verifies: 'Home add-money lands the deposit surface for the HOME rail even while another account is selected; the DEMO faucet is not a Home action but the practice row\'s own button, and both it and the T hotkey carry the relay\'s own cooldown refusal back to the user without moving money',
  timeoutMs: 25000,
};

export async function run() {
  const start = Date.now();
  console.log('[134-home-add-money] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[134-home-add-money] onboarding (DEMO ∂100)…');
    await onboardWallet(driver, 'e2e-add');
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });

    // (a) DEMO is the SELECTED asset after the harness preamble, and the home currency is CHF. The
    //     headline names francs, and Add money must fund francs — not the selection.
    assertIncludes(await driver.readText('home-headline-label'), 'Swiss francs', 'the home rail names the CURRENCY');
    assertIncludes(await driver.readText('home-headline-label'), 'Main', 'the home rail carries the Main badge');
    assertIncludes(await driver.readText('home-headline-amount'), 'VCHF', 'the amount stays in the VCHF token unit — the currency is only the NAME');
    assertIncludes(await driver.readText('active-asset-label'), 'DEMO', 'the SELECTED account is still the practice rail');

    console.log('[134-home-add-money] tapping add-money (deposit path)…');
    await driver.click('btn-home-add-money', { timeoutMs: 4_000 });
    await driver.findByTestID('deposit-address', { timeoutMs: 5_000 });
    const addr = await driver.readText('deposit-address');
    assert(addr.length > 0, 'the VCHF deposit address must render');
    assertIncludes(await driver.readText('active-asset-label'), 'Swiss francs',
      'funding the home rail SELECTS it — the account you asked to fund is the account you land on');
    console.log(`[134-home-add-money] ✓ add-money landed the home rail's deposit surface (address ${addr.slice(0, 12)}…)`);

    // (c) FIRST, because it is the half whose proof is the FIRST refusal line to appear: the T
    //     hotkey reaches the relay from a surface that carries no faucet button at all.
    await openBalances(driver);
    await selectCurrency(driver, 'demo');
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('btn-topup')), 'the faucet is NOT a Home action — that is what (b) is about');
    await driver.pressKey('t');
    // ON HOME, with no navigation: the refusal is rendered once by the wallet shell above the mode
    // switch, so it reaches whichever surface the hotkey was pressed on. It used to live inside the
    // accounts route, so this flow had to go there before it could see anything — i.e. the answer
    // existed but the user pressing T on Home never saw it.
    await driver.findByTestID('topup-err', { timeoutMs: 8_000 });
    assertIncludes(await driver.readText('topup-err'), 'faucet cooldown',
      'the T hotkey reached the relay from Home and its own reason came back — a hotkey that answers nothing is a bug');
    await driver.findByTestID('home-headline-amount', { timeoutMs: 4_000 });
    console.log('[134-home-add-money] ✓ T hotkey fired the faucet from Home, and the relay\'s reason is on Home');

    // (b) The faucet button lives on the practice row, and a refused tap moves no money.
    console.log('[134-home-add-money] tapping the practice row faucet…');
    await openBalances(driver);
    assertIncludes(await driver.readText('asset-demo'), '∂100.00', 'the practice row starts at the faucet-seeded ∂100.00');
    await driver.click('btn-topup', { timeoutMs: 4_000 });
    await driver.findByTestID('topup-err', { timeoutMs: 8_000 });
    assertIncludes(await driver.readText('topup-err'), 'try again in',
      'the refusal names WHEN to retry — the relay\'s own text, verbatim (N5)');
    assertIncludes(await driver.readText('asset-demo'), '∂100.00', 'a refused top-up credits nothing');
    console.log('[134-home-add-money] ✓ practice faucet fired from its own row; refused, and nothing moved');

    await driver.screenshot('134-home-add-money');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[134-home-add-money] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[134-home-add-money] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
