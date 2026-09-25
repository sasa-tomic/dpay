// Flow 133 — The Home surface: the LANDING screen and what it is worth landing on.
//
// The founder reversed the standing decision on 2026-09-08 (docs/specs/2026-09-08-first-run-
// redesign.md §1 F2): the app opens on Home, and Pay is one tap away. Greeting a new user with a
// payment-request surface is what read as a scam. This flow is where that contract lives, and it
// pins the mitigation that makes the change cost nothing as well:
//   (a) a freshly onboarded wallet LANDS on Home — the headline is on screen with zero taps, and
//       the Pay scanner is NOT;
//   (b) the headline is the HOME CURRENCY's, in the home rail's OWN token unit under the "· Main"
//       eyebrow — never a converted figure, and never the transient selection (X4);
//   (c) Pay (2026-09-14: honestly named — the screen behind it scans, taps and beams; the oversized
//       "Scan to pay" button is gone and the action row is three EQUAL cards) is one tap to a live
//       camera, and it lands the SCAN sub-mode even when the Pay tab was last left on
//       "Send to address" — the returning traveller's checkout gesture stays one tap;
//   (d) Home carries the accounts AFFORDANCE and not the accounts LIST (that is flow 136's route);
//       since 2026-09-14 the affordance IS the headline — tapping the balance opens accounts;
//   (e) Receive still opens the request form.
// (The add-money dispatch is flow 134's contract; the activity feed is flow 135's.)
import { setup, assert, assertEq, assertIncludes, onboardWallet, openBalances, openPaySend, selectCurrency } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '133',
  name: 'home-surface',
  journey: 'system',
  covers: ['home-tab', 'action-row', 'landing', 'scan-affordance'],
  verifies: 'The app LANDS on Home: the headline shows the home currency in the home rail\'s own token unit, Home carries the accounts affordance but not the list, Scan reaches a live camera in one tap even after the Pay tab was left on Send-to-address, and Receive opens the request form',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[133-home-surface] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // The harness preamble ends on the Pay tab by construction (selectDemoAsset restores it for
    // the ~115 flows that assume it), so this flow onboards by reload instead: a reload is the
    // cheapest reproduction of a cold start, and the landing mode is exactly what is under test.
    console.log('[133-home-surface] onboarding…');
    await onboardWallet(driver, 'e2e-home');
    await driver.navigate(env.webBaseURL, `/?relay=${encodeURIComponent(env.relayBaseURL)}`,
      { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });

    // (a) The landing surface IS Home — zero taps. The scanner is one tap away, not in front.
    await driver.findByTestID('home-headline-amount', { timeoutMs: 10_000 });
    assert(!(await driver.isPresent('pay-scan')), 'the Pay scanner must NOT be the landing surface (the founder reversed that on 2026-09-08)');
    await driver.findByTestID('tab-pay', { timeoutMs: 4_000 });
    console.log('[133-home-surface] ✓ cold start lands on Home, scanner not mounted');

    // (b) The headline is the HOME CURRENCY (the harness picks CHF) in the CURRENCY unit —
    //     fork #4's "Balance CHF / 4.54 Fr" grammar (the 2026-09-24 redesign supersedes the
    //     token-unit headline). The wallet holds ∂100.00 of practice money and it does NOT
    //     reach the headline — the home currency owns that number (X4).
    assertEq(await driver.readText('home-headline-label'), 'Balance CHF', 'the headline names the home CURRENCY (the sketch\'s eyebrow grammar)');
    const headline = await driver.readText('home-headline-amount');
    assert(!headline.includes('VCHF'), 'the headline amount is the CURRENCY figure, not the rail token');
    assert(!headline.includes('∂'), `the practice balance must never reach the headline. Got: ${JSON.stringify(headline)}`);
    console.log(`[133-home-surface] ✓ headline: Balance CHF / ${headline}`);

    // (d) The accounts AFFORDANCE is here — since 2026-09-14 it IS the headline (the balance is
    //     the button; the "Accounts · N" pill is gone); the LIST is not.
    await driver.findByTestID('btn-home-accounts', { timeoutMs: 4_000 });
    assert(!(await driver.isPresent('accounts-list')), 'the accounts list must NOT render on Home — it is its own route');
    assert(!(await driver.isPresent('asset-demo-select')), 'no account row renders on Home');
    console.log('[133-home-surface] ✓ Home carries the accounts affordance (the tappable balance), not the list');

    // (d′) Tapping the balance opens the accounts route — the founder's 2026-09-14 directive.
    await driver.click('btn-home-accounts', { timeoutMs: 4_000 });
    await driver.findByTestID('accounts-list', { timeoutMs: 5_000 });
    await driver.click('btn-accounts-back', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    console.log('[133-home-surface] ✓ tapping the balance opens accounts and Back returns');

    // (b′) X4's regression pin: the working rail moving must not rewrite the home currency. The
    //      practice row selects DEMO — the chip follows the practice selection, the headline
    //      does not (the currency-first chip headlines the MAIN currency's summed figure).
    // (b″) The currency-first gesture (the 2026-09-24 spec supersedes the old X4 row rule):
    // tapping a CURRENCY row sets it as the wallet's main — the headline follows, deliberately.
    await openBalances(driver);
    await selectCurrency(driver, 'ckbtc');
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    assertEq(await driver.readText('home-headline-label'), 'Balance BTC',
      'the currency-row tap sets main — the headline follows it (the spec\'s deliberate gesture)');
    console.log('[133-home-surface] ✓ currency-row tap re-pointed the headline to BTC (set-main)');
    // ...and the X4 core survives where it actually matters: a practice-row tap (DEMO — never
    // main) re-points the working selection without touching the headline.
    await openBalances(driver);
    await selectCurrency(driver, 'demo', { timeoutMs: 5_000 });
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    assertEq(await driver.readText('home-headline-label'), 'Balance BTC',
      'a practice tap must NOT rewrite the home currency the headline states (X4)');
    console.log('[133-home-surface] ✓ the practice tap left the headline in BTC');
    // Restore ckBTC as main + the working rail (the Pay tab's send toggle below needs a real
    // send-capable asset; DEMO cannot send).
    await openBalances(driver);
    await selectCurrency(driver, 'ckbtc');
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    assertEq(await driver.readText('home-headline-label'), 'Balance BTC', 'ckBTC is main again for the send leg');

    // (c) Leave the Pay tab on "Send to address", come back to Home, and tap Pay: the camera must
    //     be live. Without the sub-mode pin this is two taps, which is the regression the primary
    //     Pay card exists to prevent (the card is honestly named "Pay" since 2026-09-14 — the
    //     screen behind it scans, taps and beams).
    await openPaySend(driver);
    await driver.findByTestID('btn-pay-send', { timeoutMs: 4_000 });
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    // (d′) Pay/Receive stay EXACTLY where the spec pinned them: bottom tabs (fork #1 — the
    // Home action row is Add funds / Convert / Withdraw funds / [...], no Pay card). The
    // within-tab sub-mode survives (the pin from (c)); one toggle tap returns to the scanner.
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    await driver.click('btn-pay-scan', { timeoutMs: 4_000 });
    await driver.findByTestID('pay-scan', { timeoutMs: 5_000 });
    console.log('[133-home-surface] ✓ Pay back on the live scanner (sub-mode pin + one toggle tap)');

    // (e) Receive still opens the request form.
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.findByTestID('req-prefix', { timeoutMs: 5_000 });

    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
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
