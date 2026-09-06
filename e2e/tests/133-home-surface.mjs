// Flow 133 — The Home surface (O4 slice 1): the balance-first home tab and its action row.
//
// The scanner stays the landing screen (founder decision 4: tap-to-pay abroad — the tourist's
// first gesture is scanning, so the balance home is one tap away rather than in front of it).
// This flow pins that contract PLUS the new surface:
//   (a) a freshly onboarded wallet lands on the Pay scanner — tab-home is present but the Home
//       headline is NOT rendered;
//   (b) tab-home lands Home: the headline shows the SELECTED asset's balance in its OWN token
//       unit under the correct eyebrow (DEMO selection → the plain asset label, never a
//       main-currency name over a token amount);
//   (c) the action row navigates: Pay returns to the scanner, Receive opens the request form.
// (The add-money capability dispatch is flow 134's contract; the activity feed is flow 135's.)
import { setup, assert, assertEq, assertIncludes, onboardWallet } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '133',
  name: 'home-surface',
  journey: 'system',
  covers: ['home-tab', 'action-row', 'landing'],
  verifies: 'Landing stays the Pay scanner; tab-home lands Home: headline shows the selected asset balance in its own token unit with the correct eyebrow; the action row navigates to Pay and Receive',
  timeoutMs: 25000,
};

export async function run() {
  const start = Date.now();
  console.log('[133-home-surface] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[133-home-surface] onboarding…');
    await onboardWallet(driver, 'e2e-home');

    // (a) The landing surface is STILL the Pay scanner — Home is one tap away, never in front.
    await driver.findByTestID('pay-scan', { timeoutMs: 5_000 });
    await driver.findByTestID('tab-home', { timeoutMs: 4_000 });
    assert(!(await driver.isPresent('home-headline-amount')), 'the Home headline must not render while Pay is the active mode (the scanner is the landing screen)');

    // (b) tab-home lands Home: DEMO selected → the plain asset eyebrow over the own-unit amount.
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    assertEq(await driver.readText('home-headline-label'), 'DEMO balance', 'a non-home selection names the ASSET (never the currency)');
    assertIncludes(await driver.readText('home-headline-amount'), '∂100.00', 'the headline amount is the selected asset\'s OWN token-unit balance');

    // (c) The action row navigates: Pay returns to the scanner; Receive opens the request form.
    await driver.click('btn-home-pay', { timeoutMs: 4_000 });
    await driver.findByTestID('pay-scan', { timeoutMs: 5_000 });
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    await driver.click('btn-home-receive', { timeoutMs: 4_000 });
    await driver.findByTestID('req-prefix', { timeoutMs: 5_000 });

    await driver.screenshot('133-home-surface');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[133-home-surface] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[133-home-surface] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
