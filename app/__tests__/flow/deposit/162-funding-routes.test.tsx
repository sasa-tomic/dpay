/**
 * Flow 162 funding-routes — the jest twin of `e2e/tests/162-funding-routes.mjs`.
 *
 * The step BEFORE the address: a user who holds NOTHING is told where to get some. VCHF names the
 * route that actually works (no provider sells it → buy ICP and convert); providers are listed
 * with their OWN published figures with the "up to" qualifier intact; the attribution says whose
 * numbers they are and when they were read; the screen states dpay recommends and is paid by
 * none of them; and native ICP — the one card-reachable IC asset — is a DIRECT buy, reached by
 * the ONE-TAP asset switch that keeps the address sub-mode.
 */
import {describe, it, expect} from '@jest/globals';
import {
  assertIncludes, onboardWallet, openBalances, openReceiveAddress, selectCurrency,
} from '../harness/lib';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

hermeticDescribe('flow 162 — funding routes: honest "where do I get some" with attributed figures', () => {
  it('VCHF routes through convert, providers keep their qualifiers, ICP is a direct buy', async () => {
    const m = await onboardWallet('jest-funding-routes');

    // ---- (a)+(b) VCHF: the exact surface the founder called a dead end ------------------------
    await openBalances(m);
    await selectCurrency(m, 'vchf');
    await openReceiveAddress(m);
    await m.driver.findByTestID('deposit-address', {timeoutMs: 10_000});
    await m.driver.findByTestID('funding-routes', {timeoutMs: 8_000});
    const vchfBody = m.driver.bodyText();

    // The route that actually works: `Convert` is named because the swap is the only path from a
    // card to francs. Getting this wrong ("buy VCHF at MoonPay") would send a user to look for
    // something nobody sells.
    assertIncludes(vchfBody, 'No provider sells', 'VCHF must say plainly that nobody sells it directly');
    assertIncludes(vchfBody, 'Convert', 'VCHF must name the convert leg — it is the only card route to francs');

    // ---- (c) providers, with their own figures and the qualifier intact ----------------------
    for (const key of ['coinbase', 'moonpay', 'ramp', 'transak']) {
      expect(m.driver.isPresent(`funding-provider-${key}`)).toBe(true);
    }
    // "up to 4.5%" — the ceiling qualifier. Printing "4.5%" alone would state a maximum as if it
    // were the price, which is the precise false claim the spec forbids.
    assertIncludes(vchfBody, 'up to 4.5%', "MoonPay's card rate must keep its 'up to' qualifier — it is a cap, not a price");
    assertIncludes(vchfBody, 'card 2.5%', "Coinbase's card rate is published as a flat figure and reads as one");
    // Ramp's card ceiling is 3.9% only for USD/EUR/GBP — other currencies, CHF among them, pay up
    // to 5.45%. Both rows must be visible, each with its own qualifier.
    assertIncludes(vchfBody, 'up to 3.9%', "Ramp's USD/EUR/GBP card ceiling must stay visible with its qualifier");
    assertIncludes(vchfBody, 'up to 5.45%', "Ramp's other-currencies card ceiling must be its own visible row");
    assertIncludes(vchfBody, 'incl. CHF', 'the other-currencies row must name CHF so a CHF user can find their number');
    assertIncludes(vchfBody, 'non-USD purchases', "MoonPay's non-USD minimum-fee uplift must be stated — CHF buyers pay it");
    // Transak publishes per-method tables as text; the figures render and the old "varies by
    // country" placeholder is gone.
    assertIncludes(vchfBody, '3.5% + €1', "Transak's published card rate (EUR) must render with its fixed €1 on top");
    assertIncludes(vchfBody, 'SEPA 0.99%', "Transak's published SEPA rate must render");
    assertIncludes(vchfBody, 'margin', 'the spread most providers take must be named, not omitted');
    expect(vchfBody.includes('varies by country')).toBe(false);

    // ---- (d) attribution + the explicit non-endorsement ---------------------------------------
    const attribution = m.driver.readText('funding-attribution');
    assertIncludes(attribution, '2026', 'the figures must carry the date they were read');
    assertIncludes(attribution, 'not prices', 'the attribution must say these are limits rather than prices');
    const endorsement = m.driver.readText('funding-no-endorsement');
    assertIncludes(endorsement, 'recommends none', 'the screen must state that dpay recommends none of them');
    assertIncludes(endorsement, 'paid by none', 'the screen must state that dpay is paid by none of them');

    // ---- (e) native ICP is a DIRECT buy, reached by the one-tap switch ------------------------
    // The switch must KEEP the address sub-mode: Wallet's ordinary select resets it, which would
    // bounce the user back to the request form.
    await m.driver.click('btn-receive-asset-switch', {timeoutMs: 5_000});
    await m.driver.click('req-pick-icp', {timeoutMs: 5_000});
    await m.driver.findByTestID('deposit-address', {timeoutMs: 8_000});
    expect(m.driver.isPresent('btn-request')).toBe(false);
    await m.driver.findByTestID('funding-routes', {timeoutMs: 8_000});
    const icpBody = m.driver.bodyText();
    assertIncludes(icpBody, 'Buy', 'ICP is purchasable directly and must say so');
    expect(icpBody.includes('No provider sells')).toBe(false);

    await m.unmount();
  }, 120_000);
});
