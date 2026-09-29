/**
 * Flows 15 + 44 + 48 + 18 — the jest twins of the withdraw family
 * (`e2e/tests/15-withdraw.mjs`, `44-cketh-withdraw.mjs`, `48-ckusdc-withdraw.mjs`,
 * `18-withdraw-errors.mjs`) — all three family branches of the "Send to address" sheet plus its
 * error paths.
 *
 * 15 (ckBTC → BTC address): icrc2_approve + retrieve_btc_with_approval signed ON-DEVICE, the
 * gateway burns at the principal, "Withdrawn ✓" + Copy destination (L3), and the UI row drops in
 * agreement. 44 (native ckETH → 0x address): the withdraw_eth branch — no gas note, approve fee +
 * burn debited. 48 (ckUSDC → 0x address): the dual-ledger ckERC20 branch — the "ckETH for gas"
 * note renders, THREE envelopes, both ledgers burn. 18 (error paths): below-min/over-balance
 * disable the confirm; a wrong-chain paste is refused by name with NO offramp body; a minter
 * refusal surfaces verbatim in withdraw-err with a fee-only debit.
 */
import {describe, it, expect} from '@jest/globals';
import {
  accountOf, assert, assertDisabled, assertEq, assertIncludes, clipboardAfterCopy, faucetAccount, getBalance,
  onboardWallet, openBalances, selectCurrency, openPaySend,
} from '../harness/lib';

const BTC_CURRENCY = 1;
const BTC_ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const ETH_CURRENCY = 6;
const ETH_ADDR = '0x000000000000000000000000000000000000dead';
const SEED_WEI = 5_000_000_000_000_000_000n; // 5 ETH
const APPROVE_FEE_WEI = 2_000_000_000_000n; // the ckETH ledger's icrc1_fee
const GAS_FEE_WEI = 78_000_000_000_000n; // the minter's fixed eip_1559 quote on this fake

describe('flow 15 — withdraw ckBTC to a native BTC address', () => {
  it('approve + retrieve burn at the principal; Withdrawn ✓; clipboard + UI row agree', async () => {
    const m = await onboardWallet('jest-withdraw');
    const accountHex = (await accountOf(m))!.publicHex;
    const fund = await faucetAccount(accountHex, 100_000, {currency: BTC_CURRENCY});
    assert(fund.ok, `faucet funding must succeed, got ${fund.status}`);
    assertEq(await getBalance(accountHex, BTC_CURRENCY), '100000', 'pre-withdraw ckBTC balance');

    await openBalances(m);
    assert(await m.driver.waitForText('0.001 BTC', {timeoutMs: 8000}), 'the funded BTC row');
    await selectCurrency(m, 'ckbtc');
    await openPaySend(m);
    await m.driver.findByTestID('send-address-input', {timeoutMs: 5000});
    await m.driver.type('send-address-input', BTC_ADDR, {timeoutMs: 4000});
    await m.driver.waitForFunction(() => m.driver.readTextSafe('send-status')?.startsWith('Bitcoin') === true,
      {timeoutMs: 6000, label: 'the route line discloses the Bitcoin burn'});
    assertEq(m.driver.readText('send-status'), 'Bitcoin · about 10 min · minimum 0.0005 BTC', 'the route line discloses the burn');
    await m.driver.findByTestID('withdraw-amount-input', {timeoutMs: 5000});
    assertIncludes(m.driver.bodyText(), 'native BTC address', 'the withdraw sheet presents the BTC destination surface');
    await m.driver.type('withdraw-amount-input', '0.00050000', {timeoutMs: 4000});
    await m.driver.findByTestID('withdraw-review-amount', {timeoutMs: 4000});
    assertIncludes(m.driver.readText('withdraw-review-amount'), '0.0005 BTC', 'review shows the BTC amount');
    await m.driver.click('btn-withdraw-confirm', {timeoutMs: 5000});
    assert(await m.driver.waitForText('Withdrawn', {timeoutMs: 15_000}), 'Withdrawn ✓');
    assertEq(await getBalance(accountHex, BTC_CURRENCY), String(100_000 - 50_000 - 10),
      'post-withdraw balance (burn + the pinned 10-sat ledger fee)');

    // L3: the success screen's Copy affordance writes the EXACT destination. Jest's navigator is
    // jest-environment-node's LIVE FORWARD of the worker's real Node global — a read-mutate here
    // would pollute the WORKER for every later file (the harness beforeEach drops a grafted
    // clipboard anyway; this assignment keeps the graft file-local by construction).
    const g = globalThis as unknown as Record<string, unknown>;
    g.navigator = {clipboard: {writeText: async (t: string) => { g.__DPAY_TEST_CLIPBOARD = t; }}};

    await m.driver.findByTestID('btn-copy-destination', {timeoutMs: 4000});
    assertEq(m.driver.readText('withdraw-destination'), BTC_ADDR, 'destination rendered on the success screen');
    expect(g.__DPAY_TEST_CLIPBOARD as string).toBe('');
    await m.driver.click('btn-copy-destination', {timeoutMs: 4000});
    assert(await m.driver.waitForText('Copied', {timeoutMs: 4000}), 'Copied ✓');
    expect(await clipboardAfterCopy()).toBe(BTC_ADDR);

    // UI balance delta: flip back to scan, re-open the accounts hub — 0.0004999 BTC remains.
    await m.driver.click('btn-pay-scan', {timeoutMs: 5000});
    await openBalances(m);
    assert(await m.driver.waitForText('0.0004999 BTC', {timeoutMs: 10_000}), 'the UI row dropped in agreement');
    expect(m.driver.bodyText()).not.toContain('0.001 BTC');

    await m.unmount();
  }, 180_000);
});

describe('flow 44 — withdraw native ckETH to a 0x address (withdraw_eth branch)', () => {
  it('gas-quote + approve + burn; no ckERC20 gas note; both gateway and UI agree', async () => {
    const m = await onboardWallet('jest-cketh');
    const accountHex = (await accountOf(m))!.publicHex;
    const fund = await faucetAccount(accountHex, Number(SEED_WEI), {currency: ETH_CURRENCY}); // 5e18 is exactly representable
    assert(fund.ok, `faucet funding must succeed, got ${fund.status}`);
    assertEq(await getBalance(accountHex, ETH_CURRENCY), String(SEED_WEI), 'pre-withdraw native-ETH balance');

    await openBalances(m);
    assert(await m.driver.waitForText('5 ETH', {timeoutMs: 8000}), 'the funded ckETH row');
    await selectCurrency(m, 'cketh');
    await openPaySend(m);
    await m.driver.findByTestID('send-address-input', {timeoutMs: 5000});
    await m.driver.type('send-address-input', ETH_ADDR, {timeoutMs: 4000});
    await m.driver.waitForFunction(() => m.driver.readTextSafe('send-status')?.startsWith('Ethereum') === true,
      {timeoutMs: 6000, label: 'the route line discloses the burn'});
    assertEq(m.driver.readText('send-status'), 'Ethereum · about 1 min · minimum 0.01 ETH', 'the route line discloses the burn');
    await m.driver.findByTestID('withdraw-amount-input', {timeoutMs: 5000});
    // Family dispatch: token_contract == null → NO "ckETH for gas" note on the native branch.
    expect(m.driver.isPresent('withdraw-gas-note')).toBe(false);
    await m.driver.type('withdraw-amount-input', '1', {timeoutMs: 4000});
    await m.driver.findByTestID('withdraw-review-amount', {timeoutMs: 4000});
    assertIncludes(m.driver.readText('withdraw-review-amount'), '1 ETH', 'review shows the ETH amount compact');
    await m.driver.click('btn-withdraw-confirm', {timeoutMs: 5000});
    assert(await m.driver.waitForText('Withdrawn', {timeoutMs: 15_000}), 'Withdrawn ✓');
    assertEq(await getBalance(accountHex, ETH_CURRENCY), String(SEED_WEI - APPROVE_FEE_WEI - 1_000_000_000_000_000_000n),
      'post-withdraw balance (approve fee + minter burn)');

    // L3: the same Copy affordance with a navigator.clipboard stand-in (see flow 15 — file-local
    // assignment; never read-mutate the worker's real navigator).
    const g = globalThis as unknown as Record<string, unknown>;
    g.navigator = {clipboard: {writeText: async (t: string) => { g.__DPAY_TEST_CLIPBOARD = t; }}};
    await m.driver.findByTestID('btn-copy-destination', {timeoutMs: 4000});
    assertEq(m.driver.readText('withdraw-destination'), ETH_ADDR, 'destination rendered');
    await m.driver.click('btn-copy-destination', {timeoutMs: 4000});
    assert(await m.driver.waitForText('Copied', {timeoutMs: 4000}), 'Copied ✓');
    expect(await clipboardAfterCopy()).toBe(ETH_ADDR);

    await m.driver.click('btn-pay-scan', {timeoutMs: 5000});
    await openBalances(m);
    assert(await m.driver.waitForText('3.999998 ETH', {timeoutMs: 10_000}), 'the UI row dropped (display-truncated to 6)');
    expect(m.driver.bodyText()).not.toContain('5.000000 ETH');

    await m.unmount();
  }, 180_000);
});

describe('flow 48 — withdraw ckUSDC (dual-ledger ckERC20 branch)', () => {
  it('the gas note renders; three envelopes; BOTH ledgers burn; the UI row agrees', async () => {
    const m = await onboardWallet('jest-ckusdc-w');
    const accountHex = (await accountOf(m))!.publicHex;
    const SEED_RAW = 1_000_000_000; // 1000 USDC
    const SEED_ETH_WEI = 100_000_000_000_000_000n; // 0.1 ETH for the gas leg
    const CKETH_APPROVE_FEE_WEI = 2_000_000_000_000n;
    const fundUsdc = await faucetAccount(accountHex, SEED_RAW, {currency: 2});
    assert(fundUsdc.ok, `ckUSDC faucet must succeed, got ${fundUsdc.status}`);
    const fundEth = await faucetAccount(accountHex, Number(SEED_ETH_WEI), {currency: ETH_CURRENCY});
    assert(fundEth.ok, `ckETH faucet must succeed, got ${fundEth.status}`);
    assertEq(await getBalance(accountHex, 2), String(SEED_RAW), 'pre-withdraw ckUSDC balance');
    assertEq(await getBalance(accountHex, ETH_CURRENCY), String(SEED_ETH_WEI), 'pre-withdraw ckETH gas leg');

    await openBalances(m);
    assert(await m.driver.waitForText('$1,000.00', {timeoutMs: 8000}), 'the funded ckUSDC row');
    await selectCurrency(m, 'ckusdc');
    await openPaySend(m);
    await m.driver.findByTestID('send-address-input', {timeoutMs: 5000});
    await m.driver.type('send-address-input', ETH_ADDR, {timeoutMs: 4000});
    // ckERC20 carries no minter floor — the route line quotes the burn with NO minimum clause.
    await m.driver.waitForFunction(() => m.driver.readTextSafe('send-status')?.startsWith('Ethereum') === true,
      {timeoutMs: 6000, label: 'route line with no minimum clause'});
    assertEq(m.driver.readText('send-status'), 'Ethereum · about 1 min', 'route line with no minimum clause');
    await m.driver.findByTestID('withdraw-amount-input', {timeoutMs: 5000});
    // Fork-C honesty: the gas dependency is disclosed, never silently converted (no-swap).
    await m.driver.findByTestID('withdraw-gas-note', {timeoutMs: 5000});
    assertIncludes(m.driver.bodyText(), 'ckETH for gas', 'the gas-dependency note mentions ckETH');
    await m.driver.type('withdraw-amount-input', '1', {timeoutMs: 4000});
    await m.driver.findByTestID('withdraw-review-amount', {timeoutMs: 4000});
    assertIncludes(m.driver.readText('withdraw-review-amount'), '1 USDC', 'review shows the USDC amount compact');
    await m.driver.click('btn-withdraw-confirm', {timeoutMs: 5000});
    assert(await m.driver.waitForText('Withdrawn', {timeoutMs: 15_000}), 'Withdrawn ✓');
    assertEq(await getBalance(accountHex, 2), String(SEED_RAW - 10_000 - 1_000_000),
      'ckUSDC leg (approve fee + burn)');
    assertEq(await getBalance(accountHex, ETH_CURRENCY), String(SEED_ETH_WEI - CKETH_APPROVE_FEE_WEI - GAS_FEE_WEI),
      'ckETH gas leg (approve fee + gas burn)');

    await m.driver.click('btn-pay-scan', {timeoutMs: 5000});
    await openBalances(m);
    assert(await m.driver.waitForText('$998.99', {timeoutMs: 10_000}), 'the UI ckUSDC row dropped to 998.99');
    expect(m.driver.readText('accounts-list')).not.toContain('1,000.00 USDC');

    await m.unmount();
  }, 180_000);
});

describe('flow 18 — withdraw error paths (guards + an honest rail rejection)', () => {
  it('below-min/over-balance disable confirm; wrong chain refused by name; minter refusal surfaced', async () => {
    const m = await onboardWallet('jest-werr');
    const accountHex = (await accountOf(m))!.publicHex;
    const fund = await faucetAccount(accountHex, Number(SEED_WEI), {currency: ETH_CURRENCY}); // 5e18 is exactly representable
    assert(fund.ok, `faucet funding must succeed, got ${fund.status}`);
    assertEq(await getBalance(accountHex, ETH_CURRENCY), String(SEED_WEI), 'pre-rejection ckETH balance');

    await openBalances(m);
    assert(await m.driver.waitForText('5 ETH', {timeoutMs: 8000}), 'the funded ckETH row');
    await selectCurrency(m, 'cketh');
    await openPaySend(m);
    await m.driver.findByTestID('send-address-input', {timeoutMs: 5000});

    // 1. BELOW-MIN: a valid 0x destination + an amount under the 0.01 ETH floor.
    await m.driver.type('send-address-input', ETH_ADDR, {timeoutMs: 4000});
    await m.driver.findByTestID('withdraw-amount-input', {timeoutMs: 5000});
    await m.driver.type('withdraw-amount-input', '0.001', {timeoutMs: 4000});
    assertIncludes(m.driver.bodyText(), 'Below the 0.01 ETH minimum withdrawal.', 'below-min warning');
    await assertDisabled(m, 'btn-withdraw-confirm', 'confirm must be DISABLED below the minimum (canReview=false)');

    // 2. OVER-BALANCE: 6 ETH > 5 ETH available.
    await m.driver.type('withdraw-amount-input', '6', {timeoutMs: 4000});
    assertIncludes(m.driver.bodyText(), 'More than your available 5 ETH.', 'over-balance warning');
    await assertDisabled(m, 'btn-withdraw-confirm', 'confirm must be DISABLED over balance (canReview=false)');

    // 2b. WRONG-CHAIN: a Bitcoin paste into the ETH cash-out — refused BY NAME (the classifier is
    //     async — wait for the refusal to displace the route line), and the offramp body is gone.
    await m.driver.type('send-address-input', BTC_ADDR, {timeoutMs: 4000});
    await m.driver.waitForFunction(() => m.driver.readTextSafe('send-status')?.includes('Bitcoin') === true,
      {timeoutMs: 6000, label: 'the wrong-chain refusal displaced the route line'});
    assertEq(m.driver.readText('send-status'),
      "Bitcoin addresses can't receive ETH — it settles on Ethereum. Paste an address for that network instead.",
      'the wrong-chain refusal names the pasted chain, the asset and the network to use');
    await m.driver.waitGone('withdraw-amount-input', {timeoutMs: 4000});
    expect(m.driver.isPresent('btn-withdraw-confirm')).toBe(false);

    // 3. RAIL REJECTION: fix the address, withdraw the ENTIRE balance. The approve is a real
    //    ledger call (its fee is genuinely spent); the minter's burn finds insufficient funds and
    //    the reject message is surfaced verbatim. Money-honest: exactly the fee moved.
    await m.driver.type('send-address-input', ETH_ADDR, {timeoutMs: 4000});
    await m.driver.findByTestID('withdraw-amount-input', {timeoutMs: 5000});
    await m.driver.type('withdraw-amount-input', '5', {timeoutMs: 4000});
    await m.driver.findByTestID('withdraw-review-amount', {timeoutMs: 4000});
    await m.driver.click('btn-withdraw-confirm', {timeoutMs: 5000});
    assert(await m.driver.waitForText('insufficient funds', {timeoutMs: 15_000}), 'the rail rejection surfaced');
    assertIncludes(m.driver.readText('withdraw-err'), 'insufficient funds', 'the minter refuse message, verbatim');
    assertEq(await getBalance(accountHex, ETH_CURRENCY), String(SEED_WEI - APPROVE_FEE_WEI),
      'fee-only debit through the rejection (the withdrawn amount unmoved)');

    await m.unmount();
  }, 180_000);
});
