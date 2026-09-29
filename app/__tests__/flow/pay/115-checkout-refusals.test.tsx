/**
 * Flow 115 — the jest twin of `e2e/tests/115-checkout-refusals.mjs` (the cashier-code control fails
 * closed by name where a charge cannot be opened, and one tap fixes it).
 *
 * With ckBTC selected the checkbox names the asset and its chain, says a checkout code is paid in
 * VCHF (the backing symbol, never the wrapper), and offers one tap that switches — after which the
 * counter is open with the checkbox still checked (the code form is wallet-owned across the rail
 * re-mount). With SOL selected the same control renders on the Solana Receive form and refuses
 * naming SOL on Solana — and the message box there is the ONE box both code forms share. A price
 * finer than a rappen is refused on the device with the correction spelled out, nothing signed.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {assertEq, assertIncludes, onboardWallet, openBalances, selectCurrency} from '../harness/lib';

hermeticDescribe('flow 115 — checkout refusals: named, actionable, fail-closed, on both rails', () => {
  it('ckBTC/SOL refuse by name with the switch offered; the shared box survives; sub-rappen refused', async () => {
    const m = await onboardWallet('jest-checkout-refusals');

    // --- 1. a chain-key asset: refused by name, with the switch offered ---------------------------
    await openBalances(m);
    await selectCurrency(m, 'ckbtc');
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    expect(m.driver.isPresent('receive-code-form')).toBe(true); // the same-surfaces rule
    await m.driver.click('btn-code-checkout', {timeoutMs: 4000});
    await m.driver.findByTestID('checkout-refused', {timeoutMs: 5000});
    const refusedBtc = m.driver.readText('checkout-refused');
    assertIncludes(refusedBtc, 'BTC', 'the refusal names the selected asset');
    assertIncludes(refusedBtc, 'Bitcoin', 'and the chain it is on');
    assertIncludes(refusedBtc, 'VCHF', 'and what a checkout code IS paid in');
    expect(refusedBtc).not.toContain('ckBTC'); // the backing symbol, never the wrapper
    expect(m.driver.isPresent('btn-checkout-open')).toBe(false); // nothing to press

    // --- 2. the one tap that fixes it --------------------------------------------------------------
    await m.driver.click('checkout-refused-go', {timeoutMs: 4000});
    await m.driver.findByTestID('btn-checkout-open', {timeoutMs: 6000});
    expect(m.driver.isPresent('checkout-refused')).toBe(false);

    // --- 3. the SAME control on the Solana rail ------------------------------------------------------
    await openBalances(m);
    await selectCurrency(m, 'sol', {timeoutMs: 5000});
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    expect(m.driver.isPresent('receive-code-form')).toBe(true); // renders on the Solana form too
    await m.driver.findByTestID('checkout-refused', {timeoutMs: 5000});
    const refusedSol = m.driver.readText('checkout-refused');
    assertIncludes(refusedSol, 'SOL', 'the Solana refusal names the selected asset');
    assertIncludes(refusedSol, 'Solana', 'and the rail it settles on');
    assertIncludes(refusedSol, 'Internet Computer', 'and where a checkout code settles instead');

    // The ONE message box on the SOL rail too: its text survives the checkbox toggle both ways.
    const SOL_NOTE = 'SOL-side note';
    await m.driver.type('sol-req-memo-input', SOL_NOTE, {timeoutMs: 4000});
    await m.driver.click('btn-code-checkout', {timeoutMs: 4000}); // uncheck → the dpay SOL request form
    assertEq(m.driver.readInputValue('sol-req-memo-input'), SOL_NOTE, 'the SOL text survives unchecking');
    expect(m.driver.isPresent('btn-sol-req-make')).toBe(true);
    await m.driver.click('btn-code-checkout', {timeoutMs: 4000}); // check again → the refusal returns
    expect(m.driver.isPresent('sol-req-memo-input')).toBe(true);
    assertEq(m.driver.readInputValue('sol-req-memo-input'), SOL_NOTE, 'the SOL text survives checking again');
    await m.driver.findByTestID('checkout-refused', {timeoutMs: 5000});
    await m.driver.click('checkout-refused-go', {timeoutMs: 4000});
    await m.driver.findByTestID('btn-checkout-open', {timeoutMs: 6000});

    // --- 4. a price a checkout cannot charge, refused on the device ----------------------------------
    await m.driver.type('amount-input', '10.505', {timeoutMs: 4000});
    await m.driver.click('btn-checkout-open', {timeoutMs: 4000});
    await m.driver.findByTestID('checkout-err', {timeoutMs: 4000});
    const err = m.driver.readText('checkout-err');
    assertIncludes(err, 'rappen', 'the refusal names the rule that was broken');
    assertIncludes(err, '10.50', 'and shows what to type instead');
    expect(m.driver.isPresent('checkout-qr')).toBe(false); // nothing was opened

    await m.unmount();
  }, 150_000);
});
