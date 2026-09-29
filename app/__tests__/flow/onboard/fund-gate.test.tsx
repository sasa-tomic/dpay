/**
 * Flow 124 fund-gate-sibling-rail — the jest twin of `e2e/tests/124-fund-gate-sibling-rail.mjs`.
 * (FundedSiblingRail.test.tsx pins the component; this ports the live pay-gate walk.)
 *
 * home=USD starts on the preferred ckUSDC rail, which is UNFUNDED — the pay-fund gate rises. The
 * sibling rail (USDC · Solana) is funded to exactly 2.5 USDC through the SOL RPC stub, and the
 * gate's pointer names THAT account in its own unit — never a merged or converted figure. One tap
 * on the switch lands the funded rail's own scan screen; the chip keeps headline duty for the MAIN
 * currency.
 */
import {describe, it} from '@jest/globals';
// FIRST: the SOL RPC override + stub helper (the app captures the URL at module load).
import {installSolAccountsHelper} from '../settings/solStub';
import {
  assertEq, assertIncludes, onboardWallet, openBalances, selectCurrency, waitForWallet,
} from '../harness/lib';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

const g = globalThis as unknown as Record<string, unknown>;

hermeticDescribe('flow 124 — fund-gate-sibling-rail', () => {
  it('the unfunded preferred rail raises the gate; the pointer names the funded sibling in its own unit; one tap switches', async () => {
    installSolAccountsHelper();
    const m = await onboardWallet('e2e-sibling');
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-currency-USD', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});
    await waitForWallet(m, {timeoutMs: 8000});
    await openBalances(m);
    await selectCurrency(m, 'ckusdc');

    assertIncludes(m.driver.readText('active-asset-label'), 'Balance USD',
      'home=USD must start on the preferred ckUSDC rail');

    // Fund the SIBLING rail only: 2.5 USDC on Solana (live install — no navigation follows). The
    // IC side stays untouched: a fresh wallet's ckUSDC balance is zero, which raises the gate.
    g.__DPAY_TEST_SOLANA_RPC_STUB = {
      getMultipleAccounts: (p: unknown[]) => (g.__DPAY_SOL_ACCOUNTS as (p2: unknown, o: unknown) => unknown)(p, {lamports: 5000000000, token: {amount: '2500000', decimals: 6}}),
      getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      getMinimumBalanceForRentExemption: () => 1447680,
      sendTransaction: () => 'sig_' + Math.random().toString(36).slice(2, 12),
      getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680}}),
      getBalance: () => ({value: 5000000000}),
      getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
    };

    // 1. The fund gate for the unfunded preferred rail.
    await m.driver.findByTestID('pay-fund', {timeoutMs: 15_000});

    // 2. The pointer names the sibling rail and its amount, unit included.
    await m.driver.findByTestID('fund-sibling-rail', {timeoutMs: 5000});
    await m.driver.waitForFunction(
      () => m.driver.isReadTextSafe('fund-sibling-holds', 'USDC · Solana'),
      {timeoutMs: 15_000, label: 'the pointer names the funded sibling rail'},
    );
    assertEq(m.driver.readText('fund-sibling-holds'), 'You hold 2.50 USDC on USDC · Solana',
      'the pointer must name the funded sibling rail and its own-unit amount');

    // 3. ONE tap: the switch lands the funded rail's own scan screen — no Balances detour.
    await m.driver.click('btn-fund-sibling-switch', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-sol-start-scan', {timeoutMs: 10_000});
    assertEq(m.driver.readText('active-asset-label'), 'Balance USD',
      'the chip keeps headline duty for the MAIN currency (USD)');

    await m.unmount();
    g.__DPAY_TEST_SOLANA_RPC_STUB = undefined;
  }, 150_000);
});
