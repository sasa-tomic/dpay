// Flow 02 — The demo faucet gives ∂100 once, and SAYS SO when it will not give more.
//
// WHAT THIS FLOW USED TO ASSERT, AND WHY IT WAS WRONG (2026-09-08). It pressed `btn-topup` twice
// and asserted ∂100 → ∂200 → ∂300, "proving" the button was repeatable. The SHIPPED faucet has
// never been repeatable: the production relay enforces one top-up per (account, currency) per hour
// (`crates/dpay-relay/src/faucet.rs`), and onboarding has already spent that hour's top-up on
// create. Only the offline fixture faucet had no cooldown, so the suite was pinning a behaviour
// that exists nowhere but the fixture — the exact drift OPEN_ISSUES filed as "FakeLedger has no
// rate-limit — accepted simplification". Both builds now run the one predicate, so this flow can
// assert what a user actually gets.
//
// The three things asserted here, none of which had any coverage before:
//   1. onboarding's own top-up lands (∂100.00);
//   2. pressing the button again is REFUSED, and the refusal carries the relay's own verbatim wait
//      ("faucet cooldown: try again in ~59 min") — the N5 contract, so the user is told WHEN, not
//      just "unavailable";
//   3. the balance does not move on a refusal — no phantom credit, no optimistic write.
//
// Selector contract: `balance` (header balance → opens the accounts route), `btn-topup`,
// `topup-err` (the one-line refusal; rendered by the wallet shell, so it shows on whichever
// surface the top-up was asked for — flows 14 and 134 are the ones that pin that).
import { setup, assert, onboardWallet, openBalances } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '02',
  name: 'faucet',
  journey: 'onboard',
  covers: ['faucet', 'topup', 'cooldown', 'balance-delta'],
  verifies: 'Demo faucet funds ∂100 once; a second top-up inside the hour is refused with the relay\'s own retry time and the balance does not move.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[02-faucet] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Onboard → wallet. The faucet funds ∂100.00 on create (verified in flow 01) and, in doing
    //    so, spends this account's top-up for the window.
    console.log('[02-faucet] onboarding…');
    await onboardWallet(driver, 'e2e-faucet');

    // 2. Open the accounts route where the demo faucet lives.
    console.log('[02-faucet] opening the accounts route…');
    await openBalances(driver);
    await driver.findByTestID('btn-topup', { timeoutMs: 4_000 });
    const funded = await driver.waitForText('∂100.00', { timeoutMs: 8_000 });
    assert(funded, 'onboarding must have funded ∂100.00 through the real faucet');

    // 3. Press the button. The relay refuses — the same refusal the deployed relay gives — and the
    //    app renders its reason VERBATIM (N5): the wait, not a generic failure.
    console.log('[02-faucet] clicking btn-topup inside the cooldown window…');
    await driver.click('btn-topup', { timeoutMs: 4_000 });
    await driver.findByTestID('topup-err', { timeoutMs: 8_000 });
    const said = await driver.readText('topup-err', { timeoutMs: 4_000 });
    assert(
      /faucet cooldown: try again in ~\d+ (h|min|s)/.test(said),
      `the refusal must carry the relay's own retry time, got: ${JSON.stringify(said)}`,
    );
    console.log(`[02-faucet] ✓ refused verbatim: ${said}`);

    // 4. Nothing was credited. A refusal that moved the number would be worse than the refusal.
    const body = await driver.bodyText();
    assert(body.includes('∂100.00'), `balance must still read ∂100.00 after a refused top-up. body excerpt:\n${body.slice(0, 500)}`);
    assert(!body.includes('∂200.00'), 'a refused top-up must not credit anything');

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
