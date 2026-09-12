// Flow 162 — the step BEFORE the address: a user who holds NOTHING is told where to get some.
//
// The gap this closes, in the founder's own words: the app's only honest funding instruction was
// "send VCHF from an Internet Computer wallet". Every deposit surface answers "where do I send it"
// correctly and none of them answered "I don't have any" — and the target user is a traveller who
// does not have an Internet Computer wallet, has never heard of one, and was given no route to
// getting one. It is a complete sentence and a dead end, arriving at the exact moment a new user
// decides whether the product is real.
//
// Design, the measured provider evidence, and the regulatory constraints this screen is built
// under: docs/specs/2026-09-09-funding-routes-plan.md. Not restated here.
//
// What this pins:
//   (a) the section renders on the VCHF deposit surface — the exact dead end the founder hit;
//   (b) VCHF names the route that actually works: no provider sells it, so buy ICP and convert.
//       Getting this wrong in the obvious direction ("buy VCHF at MoonPay") would send a user to
//       look for something nobody sells;
//   (c) providers are listed with their OWN published figures, and the qualifier survives —
//       "up to 4.5%" is a ceiling, not a price, and copy that dropped the words would be a false
//       claim under the external-claims rule. Conditional rates are their own rows with their
//       qualifiers: Ramp's 5.45% other-currencies ceiling (CHF is one) must be visible, and
//       Transak's now-published per-method figures must render (F2, re-read 2026-09-12);
//   (d) the attribution says whose numbers they are and when they were read, and the screen says
//       out loud that dpay recommends none of them and is paid by none of them;
//   (e) native ICP — the one card-reachable Internet Computer asset — is a DIRECT buy, not a
//       conversion, so the two IC rows do not get the same answer.
//
// Selector contract: `funding-routes`, `funding-provider-coinbase|moonpay|ramp|transak`,
// `funding-attribution`, `funding-no-endorsement`, `btn-receive-address`, `deposit-address`.
import { setup, assert, assertIncludes, onboardWallet, openBalances, selectCurrency, openReceiveAddress } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '162',
  name: 'funding-routes',
  journey: 'deposit',
  covers: ['funding-routes', 'honest-instructions', 'no-endorsement', 'attributed-figures', 'asset-switch', 'one-gesture'],
  verifies: 'The deposit surfaces answer "I do not have any yet": VCHF names the buy-ICP-then-convert route because no provider sells it, native ICP is a direct buy, providers carry their own published figures with the "up to" qualifier intact, and the screen states that dpay recommends none of them and is paid by none of them. Also: another asset\'s receiving address is ONE tap from this surface and the switch keeps the address sub-mode instead of bouncing to the request form.',
  timeoutMs: 40_000,
};

export async function run() {
  const start = Date.now();
  console.log('[162-funding-routes] setup (relay + web + browser)…');
  const env = await setup({ solStub: true });
  try {
    const { driver } = env;

    console.log('[162-funding-routes] onboarding…');
    await onboardWallet(driver, 'e2e-funding-routes');

    // ---- (a)+(b) VCHF: the exact surface the founder called a dead end ------------------------
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await openReceiveAddress(driver);
    await driver.findByTestID('deposit-address', { timeoutMs: 10_000 });
    await driver.findByTestID('funding-routes', { timeoutMs: 8_000 });
    const vchfBody = await driver.bodyText();

    // The route that actually works. `Convert` is named because the swap is the only path from a
    // card to francs, and the user signs it themselves.
    assertIncludes(vchfBody, 'No provider sells', 'VCHF must say plainly that nobody sells it directly');
    assertIncludes(vchfBody, 'Convert', 'VCHF must name the convert leg — it is the only card route to francs');
    // Who signs the swap is the load-bearing fact: dpay is never a party to it, and the screen has
    // to say so where the user is standing rather than only in a spec.
    assertIncludes(vchfBody, 'You sign that swap yourself', 'the swap must be attributed to the user, on screen');
    assertIncludes(vchfBody, 'dpay takes no part of it', 'and dpay must state that it takes no part of it');
    console.log('[162-funding-routes] ✓ VCHF names buy-ICP-then-convert, not a seller that does not exist');

    // ---- (c) providers, with their own figures and the qualifier intact ----------------------
    for (const key of ['coinbase', 'moonpay', 'ramp', 'transak']) {
      assert(await driver.isPresent(`funding-provider-${key}`), `funding-provider-${key} must render`);
    }
    // "up to 4.5%" — the ceiling qualifier. Printing "4.5%" alone would state a maximum as if it
    // were the price, which is the precise false claim the spec forbids.
    assertIncludes(vchfBody, 'up to 4.5%', "MoonPay's card rate must keep its 'up to' qualifier — it is a cap, not a price");
    assertIncludes(vchfBody, 'card 2.5%', "Coinbase's card rate is published as a flat figure and reads as one");
    // F2 (re-read 2026-09-12): Ramp's card ceiling is 3.9% only for USD/EUR/GBP — other
    // currencies, CHF among them (this wallet's home market), pay up to 5.45%. Both rows must
    // be visible, each with its own qualifier; folding them would show a CHF user a number
    // that does not apply to them as if it did.
    assertIncludes(vchfBody, 'up to 3.9%', "Ramp's USD/EUR/GBP card ceiling must stay visible with its qualifier");
    assertIncludes(vchfBody, 'up to 5.45%', "Ramp's other-currencies card ceiling must be its own visible row");
    assertIncludes(vchfBody, 'incl. CHF', 'the other-currencies row must name CHF so a CHF user can find their number');
    assertIncludes(vchfBody, 'non-USD purchases', "MoonPay's non-USD minimum-fee uplift must be stated — CHF buyers pay it");
    // Transak now publishes per-method tables as text (the 09-10 read found only images), so
    // the figures render and the old "varies by country" placeholder is gone — a placeholder
    // where figures exist would be the stale claim this screen exists to avoid. The spread it
    // also publishes stays named.
    assertIncludes(vchfBody, '3.5% + €1', "Transak's published card rate (EUR) must render with its fixed €1 on top");
    assertIncludes(vchfBody, 'SEPA 0.99%', "Transak's published SEPA rate must render");
    assertIncludes(vchfBody, 'margin', 'the spread most providers take must be named, not omitted');
    assert(!(vchfBody.includes('varies by country')), 'the stale "varies" placeholder must be gone — Transak publishes figures now');
    console.log('[162-funding-routes] ✓ provider figures carry their published qualifiers');

    // ---- (d) attribution + the explicit non-endorsement ---------------------------------------
    const attribution = await driver.readText('funding-attribution');
    assertIncludes(attribution, '2026', 'the figures must carry the date they were read');
    assertIncludes(attribution, 'not prices', 'the attribution must say these are limits rather than prices');
    const endorsement = await driver.readText('funding-no-endorsement');
    assertIncludes(endorsement, 'does not recommend', 'the screen must state that dpay recommends none of them');
    assertIncludes(endorsement, 'not paid by', 'the screen must state that dpay is paid by none of them');
    console.log('[162-funding-routes] ✓ figures are attributed and dated, and nothing reads as a recommendation');

    // ---- (e) native ICP is a DIRECT buy, so the two IC rows differ ----------------------------
    //
    // Reached by the NEW one-tap switch rather than by the accounts route, which proves both things
    // at once. Before this control existed, an address for an asset you had not already selected
    // cost four taps and a tab switch (header chip → accounts → row → Receive → My address); the
    // Receive tab's request half has had a one-tap picker since 2026-08-12 and its address half
    // never did, so the two halves of one tab disagreed about whether choosing an asset was a
    // gesture or a journey. Crucially the switch must KEEP the address sub-mode: Wallet's ordinary
    // select resets it, which would bounce the user back to the request form.
    await driver.click('btn-receive-asset-switch', { timeoutMs: 5_000 });
    await driver.click('req-pick-icp', { timeoutMs: 5_000 });
    await driver.findByTestID('deposit-address', { timeoutMs: 8_000 });
    assert(!(await driver.isPresent('btn-request')),
      'switching asset from the address surface must STAY on the address surface, not bounce to the request form');
    await driver.findByTestID('funding-routes', { timeoutMs: 8_000 });
    const icpBody = await driver.bodyText();
    assertIncludes(icpBody, 'Buy', 'ICP is purchasable directly and must say so');
    assert(!icpBody.includes('No provider sells'),
      'ICP is the one card-reachable Internet Computer asset — it must NOT be routed through a conversion');
    console.log('[162-funding-routes] ✓ native ICP is a direct buy, not a conversion');

    await driver.screenshot('162-funding-routes');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[162-funding-routes] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[162-funding-routes] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
