/**
 * Flow 205 checkout-settlement-predicate — the jest twin of
 * `e2e/tests/205-checkout-settlement-predicate.mjs`. (Batch E owns the flow; the porting map's
 * flow/pay/checkout.test.tsx is batch B's file, so this lives in settings/ per the lane rules.)
 *
 * The checkout's settlement picker offers exactly the honest settlement assets (VCHF · CHF and
 * ckUSDC · USD — nothing without a home-currency price unit). A dollar pick against a franc-only
 * checkout is refused WHOLE (no code shown; the refusal names both the served asset and the picked
 * currency), and the one-tap fix re-picks the served asset so the retry opens the charge — with
 * the typed price surviving the round trip.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {assertIncludes, onboardWallet, openBalances, selectCurrency} from '../harness/lib';
import {freshContext} from '../onboard/helpers';

hermeticDescribe('flow 205 — checkout-settlement-predicate', () => {
  it('the picker offers only honest price units; a mismatched pick is refused whole; the one-tap fix re-picks and opens', async () => {
    await freshContext();
    const m = await onboardWallet('Bahnhof Kiosk');

    // The counter, on the checkout's own row.
    await openBalances(m);
    await selectCurrency(m, 'vchf');
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.click('btn-code-checkout', {timeoutMs: 4000});

    // 1. The picker offers exactly the honest settlement assets.
    await m.driver.findByTestID('checkout-settle', {timeoutMs: 6000});
    expect(m.driver.isPresent('checkout-asset-vchf')).toBe(true);
    expect(m.driver.isPresent('checkout-asset-ckusdc')).toBe(true);
    expect(m.driver.isPresent('checkout-asset-icp')).toBe(false);
    expect(m.driver.isPresent('checkout-asset-ckbtc')).toBe(false);
    const pills = m.driver.readText('checkout-settle');
    assertIncludes(pills, 'VCHF · CHF', 'each pill names the asset AND the price currency');
    assertIncludes(pills, 'ckUSDC · USD', 'the dollar pill prices in dollars, not francs');

    // 2. A dollar pick against the VCHF checkout is refused WHOLE.
    await m.driver.click('checkout-asset-ckusdc', {timeoutMs: 4000});
    assertIncludes(m.driver.readText('req-prefix'), '$',
      'the amount-field unit badge follows the pick');
    await m.driver.type('amount-input', '10.50', {timeoutMs: 4000});
    await m.driver.click('btn-checkout-open', {timeoutMs: 4000});
    await m.driver.findByTestID('checkout-failed', {timeoutMs: 15_000});
    expect(m.driver.isPresent('checkout-qr')).toBe(false);
    const said = m.driver.readText('checkout-failed');
    assertIncludes(said, 'VCHF', 'the refusal names the asset the checkout DID open');
    assertIncludes(said, 'USD', 'the refusal names the currency the cashier picked');

    // 3. The one-tap fix: re-pick the served asset, open a fresh charge (flow 114's result).
    await m.driver.click('checkout-failed-go', {timeoutMs: 4000});
    await m.driver.findByTestID('btn-checkout-open', {timeoutMs: 6000});
    // The fix re-picks the wallet's asset too — the badge names francs again.
    const prefixAfterFix = m.driver.readText('req-prefix');
    assertIncludes(prefixAfterFix, 'VCHF', 'the one-tap fix moves the wallet asset back too');
    expect(prefixAfterFix.includes('$')).toBe(false);
    assertIncludes(m.driver.readInputValue('amount-input'), '10.50', 'the typed price survives the round trip');
    await m.driver.click('btn-checkout-open', {timeoutMs: 4000});
    await m.driver.findByTestID('checkout-qr', {timeoutMs: 15_000});
    assertIncludes(m.driver.bodyText(), '10.50 CHF', "the VCHF checkout-open reads the franc price exactly");

    await m.unmount();
  }, 150_000);
});
