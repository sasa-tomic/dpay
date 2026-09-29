/**
 * Flow 163 funding-mechanism — the jest twin of `e2e/tests/163-funding-mechanism.mjs`.
 *
 * The funding instruction must match the deposit that actually runs. ONE switch picks the deposit
 * sheet AND writes the instruction under it, so a surface and its funding copy cannot describe
 * different deposits. On a USD wallet: (a) ckUSDC reaches the wallet-signed ckERC20 sheet (the
 * home-rail branch once shadowed it) and its funding card says there is NO address, names ETH as
 * a separate fee holding, and NEVER says "send it to the address"; (b) ckBTC says buy BTC on
 * BITCOIN (the backing chain) and DOES send it to the address shown; (c) the Solana rail gets the
 * same send-to-address shape with no catalog descriptor behind it.
 */
import {describe, it, expect} from '@jest/globals';
import {
  assertIncludes, onboardWallet, openBalances, openReceiveAddress, selectCurrency,
  waitForWallet,
} from '../harness/lib';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

hermeticDescribe('flow 163 — funding mechanism: the instruction matches the deposit that runs', () => {
  it('ckUSDC has no address (wallet-signed); ckBTC and SOL send to the address shown', async () => {
    const m = await onboardWallet('jest-funding-mechanism');

    // The wallet must be IN dollars: CURRENCY_RAILS.USD is ['ckUSDC', 'USDC'], which makes ckUSDC
    // a two-rail home group — the branch that once shadowed its own deposit sheet. On the suite's
    // default francs the defect is unreachable, and a gate that cannot see its defect is worse
    // than no gate.
    await m.driver.click('btn-settings', {timeoutMs: 5_000});
    await m.driver.click('btn-currency-USD', {timeoutMs: 5_000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5_000});
    await waitForWallet(m, {timeoutMs: 8_000});

    // ---- (a) ckUSDC: a wallet-signed deposit, and copy that says so --------------------------
    await openBalances(m);
    await selectCurrency(m, 'ckusdc');
    await openReceiveAddress(m);
    await m.driver.findByTestID('ckerc20-deposit', {timeoutMs: 10_000});
    expect(m.driver.isPresent('btn-connect-wallet')).toBe(true);
    expect(m.driver.isPresent('ic-also-section')).toBe(true);

    await m.driver.findByTestID('funding-routes', {timeoutMs: 8_000});
    const usdc = m.driver.readText('funding-bridge');
    // The exact sentence the money-loss reading came from, asserted as an ABSENCE — the shape of
    // the defect was a complete, confident, WRONG instruction.
    expect(/send it to the address/i.test(usdc)).toBe(false);
    assertIncludes(usdc, 'No address exists for this one', 'the card must say plainly that this deposit has no address');
    assertIncludes(usdc, 'ETH', 'and it must name ETH — without it in the same wallet, the deposit cannot be signed at all');
    assertIncludes(usdc, 'in it for fees', 'the reason ETH is needed must be given, not left as a bare token name');
    assertIncludes(usdc, 'Ethereum', 'ckUSDC is bought on Ethereum, which is where the signed deposit runs');

    // ---- (b) ckBTC: a real address, and the BACKING chain named ------------------------------
    await openBalances(m);
    await selectCurrency(m, 'ckbtc');
    await openReceiveAddress(m);
    await m.driver.findByTestID('deposit-address', {timeoutMs: 10_000});
    await m.driver.findByTestID('funding-routes', {timeoutMs: 8_000});
    const btc = m.driver.bodyText();
    assertIncludes(btc, 'Bitcoin',
      'ckBTC is bought on BITCOIN — the row settles on the Internet Computer, and naming that as the place to buy sends the user looking for something nobody sells there');
    assertIncludes(btc, 'send it to the address above',
      'and this mechanism DOES have an address, so the instruction must end there');
    expect(/no address exists for this one/i.test(btc)).toBe(false);

    // ---- (c) Solana: the same shape, with no descriptor behind it ----------------------------
    await openBalances(m);
    await selectCurrency(m, 'sol', {timeoutMs: 5_000});
    await m.driver.click('tab-receive', {timeoutMs: 5_000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5_000});
    await m.driver.findByTestID('sol-receive-qr', {timeoutMs: 10_000});
    await m.driver.findByTestID('funding-routes', {timeoutMs: 8_000});
    const sol = m.driver.bodyText();
    assertIncludes(sol, 'Solana', 'the Solana rail names its own chain as the place to buy');
    assertIncludes(sol, 'send it to the address above', 'and it is an address deposit like any other');

    await m.unmount();
  }, 150_000);
});
