// Flow 134 — Home add-money, and where the practice faucet went.
//
// Home's action row acts on the account the SCREEN IS SHOWING — the home currency's rail — so no
// button on Home can move money into an account the headline is not naming. That is the other half
// of the X4 fix: the headline stopped following the transient selection, so the actions beside it
// had to stop following it too.
//   (a) Add money on Home lands the EXISTING deposit surface for the home rail (Receive → My
//       address), the same surface the fund gates use — even when another account is selected;
//   (b) the DEMO faucet is not a Home action any more: it is the practice row's own button in the
//       accounts route, and a tap there raises the practice balance;
//   (c) the `T` hotkey still fires the faucet from anywhere, and its outcome is visible where the
//       user is — a hotkey that fails silently is a bug (founder rule 2026-08-29).
import { setup, assert, assertIncludes, onboardWallet, openBalances, selectCurrency } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '134',
  name: 'home-add-money',
  journey: 'deposit',
  covers: ['home-tab', 'add-money', 'faucet'],
  verifies: 'Home add-money lands the deposit surface for the HOME rail even while another account is selected; the DEMO faucet lives on the practice row in the accounts route and raises the ∂ balance there',
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

    // (b) The faucet is the practice row's own button, in the accounts route.
    console.log('[134-home-add-money] tapping the practice row faucet…');
    await openBalances(driver);
    assertIncludes(await driver.readText('asset-demo'), '∂100.00', 'the practice row starts at the faucet-seeded ∂100.00');
    await driver.click('btn-topup', { timeoutMs: 4_000 });
    const rose = await driver.waitForText('∂200.00', { timeoutMs: 8_000 });
    assert(rose, 'the faucet top-up must land: the practice row should read ∂200.00 (faucet adds ∂100 per tap)');
    assertIncludes(await driver.readText('asset-demo'), '∂200.00', 'the practice row reflects the risen balance in its own token unit');
    console.log('[134-home-add-money] ✓ practice faucet fired from its own row (∂100.00 → ∂200.00)');

    // (c) The T hotkey still works from anywhere, and Home renders its outcome. This relay HAS a
    //     faucet, so the honest outcome is a third ∂100 — the error line is flow 37's branch.
    await selectCurrency(driver, 'demo');
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    await driver.pressKey('t');
    await openBalances(driver);
    const third = await driver.waitForText('∂300.00', { timeoutMs: 8_000 });
    assert(third, 'the T hotkey must fire the faucet from a surface that has no faucet button');
    console.log('[134-home-add-money] ✓ T hotkey fired the faucet from Home (∂200.00 → ∂300.00)');

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
