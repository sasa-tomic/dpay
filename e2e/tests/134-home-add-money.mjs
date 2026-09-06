// Flow 134 — Home add-money (O4 slice 1): the action row's capability dispatch.
//
// The Home action row is ONE chrome for every asset — the add-money button dispatches by
// capability, never by asset special case:
//   - DEMO selected → the button IS the faucet (the Balances row's topUp machinery + fail-closed
//     copy): a tap fires /api/v1/faucet and the headline's OWN-token ∂ amount rises;
//   - a real IC asset selected → the button lands the EXISTING deposit surface for THAT asset
//     (Receive → My address), the same surface the fund gates use.
// Also pins the home-rail eyebrow branch here: with CHF as home currency, selecting VCHF (the
// CHF home rail) names the CURRENCY over the VCHF-token amount — "Swiss francs · Main", never
// a CHF-converted figure.
import { setup, assert, assertIncludes, onboardWallet, openBalances, selectCurrency } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '134',
  name: 'home-add-money',
  journey: 'deposit',
  covers: ['home-tab', 'add-money'],
  verifies: 'DEMO add-money fires the faucet and the ∂ balance rises; a real IC asset\'s add-money lands the deposit surface for that asset',
  timeoutMs: 25000,
};

export async function run() {
  const start = Date.now();
  console.log('[134-home-add-money] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // --- DEMO: the add-money button is the faucet ---------------------------------------------
    console.log('[134-home-add-money] onboarding (DEMO ∂100)…');
    await onboardWallet(driver, 'e2e-add');
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    assertIncludes(await driver.readText('home-headline-amount'), '∂100.00', 'the DEMO headline starts at the faucet-seeded ∂100.00');

    console.log('[134-home-add-money] tapping add-money (faucet path)…');
    await driver.click('btn-home-add-money', { timeoutMs: 4_000 });
    const rose = await driver.waitForText('∂200.00', { timeoutMs: 8_000 });
    assert(rose, 'the faucet top-up must land: the headline should read ∂200.00 (faucet adds ∂100 per tap)');
    assertIncludes(await driver.readText('home-headline-amount'), '∂200.00', 'the Home headline reflects the risen balance in its own token unit');
    console.log('[134-home-add-money] ✓ DEMO add-money fired the faucet (∂100.00 → ∂200.00)');

    // --- A real IC asset: add-money lands the deposit surface for THAT asset --------------------
    console.log('[134-home-add-money] selecting VCHF (the CHF home rail)…');
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });

    assertIncludes(await driver.readText('home-headline-label'), 'Swiss francs', 'the home rail names the CURRENCY');
    assertIncludes(await driver.readText('home-headline-label'), 'Main', 'the home rail carries the Main badge');
    assertIncludes(await driver.readText('home-headline-amount'), 'VCHF', 'the amount stays in the VCHF token unit — the currency is only the NAME');

    console.log('[134-home-add-money] tapping add-money (deposit path)…');
    await driver.click('btn-home-add-money', { timeoutMs: 4_000 });
    await driver.findByTestID('deposit-address', { timeoutMs: 5_000 });
    const addr = await driver.readText('deposit-address');
    assert(addr.length > 0, 'the VCHF deposit address must render');
    console.log(`[134-home-add-money] ✓ add-money landed the VCHF deposit surface (address ${addr.slice(0, 12)}…)`);

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
