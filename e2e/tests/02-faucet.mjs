// Flow 02 — Faucet top-up (explicit, repeatable demo $ via the REAL relay).
//
// Onboarding already funds ∂100 on create (a best-effort faucet POST in Onboarding.create). This
// flow tests the EXPLICIT, repeatable faucet affordance: the `btn-topup` button inside the Balances
// sheet (the wallet's single money hub — top-up consolidated here so demo funds have ONE home) that
// POSTs /api/v1/faucet {account, amount: 10000} on demand and uses the response `{balance}` for an
// immediate refresh. Proves the faucet→balance path end-to-end through the REAL relay + REAL
// FakeLedger (mint), and that the button is repeatable (balance grows again).
//
// Selector contract: `balance` (header balance → opens Balances), `btn-topup` (inside Balances).
import { setup, assert, onboardWallet, openBalances } from '../harness/lib.mjs';

export async function run() {
  const start = Date.now();
  console.log('[02-faucet] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Onboard → wallet. The faucet funds ∂100.00 on create (verified in flow 01).
    console.log('[02-faucet] onboarding…');
    await onboardWallet(driver, 'e2e-faucet');

    // 2. Open the Balances sheet where the demo faucet now lives.
    console.log('[02-faucet] opening Balances…');
    await openBalances(driver);
    await driver.findByTestID('btn-topup', { timeoutMs: 4_000 });

    // 3. Tap the explicit faucet button. The app POSTs /api/v1/faucet and applies the response
    //    balance immediately (no waiting on the 2.5s poll). The balance text is in the DOM behind
    //    the overlay, so waitForText sees it. Allow time for the mint + React re-render.
    console.log('[02-faucet] clicking btn-topup (+∂100)…');
    await driver.click('btn-topup', { timeoutMs: 4_000 });
    const grew = await driver.waitForText('∂200.00', { timeoutMs: 8_000 });
    const body = await driver.bodyText();
    assert(grew, `balance should read ∂200.00 after the faucet top-up (∂100 + ∂100). body excerpt:\n${body.slice(0, 500)}`);
    console.log('[02-faucet] ✓ balance grew ∂100.00 → ∂200.00 through the REAL faucet');

    // 4. Repeatable: a second tap adds another ∂100 (∂200 → ∂300). Proves it is not a one-shot.
    console.log('[02-faucet] clicking btn-topup again (repeatable)…');
    await driver.click('btn-topup', { timeoutMs: 4_000 });
    const grewAgain = await driver.waitForText('∂300.00', { timeoutMs: 8_000 });
    assert(grewAgain, `faucet must be repeatable: balance should read ∂300.00 after a second +∂100`);

    await driver.screenshot('02-faucet');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[02-faucet] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[02-faucet] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
