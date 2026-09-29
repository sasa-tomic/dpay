/**
 * Flow 16 ckusdc-onramp — the jest twin of `e2e/tests/16-ckusdc-onramp.mjs`.
 *
 * The WIRING of the non-custodial ckERC20 deposit through the REAL app + relay with a mock
 * EIP-1193 provider (dpay never sees the key — it BUILDS the calldata, byte-exact vs the live
 * helper-contract ABI and pinned by cketh.test.ts, and asks the wallet to sign):
 *   1. WRONG-NETWORK GUARD: chainId '0x89' (Polygon) → "Wrong network … chain 1", stays in
 *      'connect' (no amount/approve), 0 sendTransaction calls.
 *   2. REVERTED RECEIPT: chainId '0x1' + receipt status '0x0' → connect + enter + approve, then
 *      waitForReceipt throws ReceiptReverted → an honest "reverted" error, stays in 'enter'
 *      (NO watching transition), exactly 1 sendTransaction.
 *   3. HAPPY PATH: receipt '0x1' → both txs mined → watching; exactly 2 sendTransaction calls
 *      with the right contracts + selectors, and the deposit targets the USER principal with the
 *      default (all-zero) subaccount.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  accountOf, assert, assertIncludes, DpayCore, onboardWallet, openBalances,
  openReceiveAddress, selectCurrency,
} from '../harness/lib';
import {principalToBytes32} from '../../../cketh';

const USDC_ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const HELPER_ADDR = '0x18901044688D3756C35Ed2b36D93e6a5B8e00E68';
const SEL_APPROVE = '0x095ea7b3';
const SEL_DEPOSIT = '0xdb9751af';

type EthCall = {to?: string; data?: string};

/** Install a recording EIP-1193 mock on the window seam (window === globalThis in the flow tier).
 *  `receiptStatus` is the status every eth_getTransactionReceipt returns ('0x1' success /
 *  '0x0' reverted); the mock answers immediately (no mining delay in the harness). */
function installMockProvider(chainIdHex: string, receiptStatus: string): {calls: EthCall[]} {
  const calls: EthCall[] = [];
  (globalThis as unknown as Record<string, unknown>).ethereum = {
    request: async ({method, params}: {method: string; params?: unknown[]}) => {
      if (method === 'eth_requestAccounts') return ['0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'];
      if (method === 'eth_chainId') return chainIdHex;
      if (method === 'eth_sendTransaction') { calls.push((params as EthCall[])[0]); return '0x' + 'ab'.repeat(32); }
      if (method === 'eth_getTransactionReceipt') return {status: receiptStatus};
      return null;
    },
  };
  return {calls};
}

hermeticDescribe('flow 16 — ckUSDC onramp: wrong-network guard, honest revert, byte-exact calldata', () => {
  it('connect → enter → approve → deposit against a mock Ethereum wallet', async () => {
    // === Scenario 1: WRONG-NETWORK GUARD (Polygon 0x89) ========================================
    let mock = installMockProvider('0x89', '0x1');
    const m = await onboardWallet('jest-ckusdc');
    await openBalances(m);
    await selectCurrency(m, 'ckusdc');
    await openReceiveAddress(m);
    await m.driver.findByTestID('ckerc20-deposit', {timeoutMs: 8_000});

    await m.driver.click('btn-connect-wallet', {timeoutMs: 5_000});
    // The connect path fetches onramp params + the chain id before the guard verdict renders.
    expect(await m.driver.waitForText('Wrong network', {timeoutMs: 8_000})).toBe(true);
    {
      const body = m.driver.bodyText();
      assertIncludes(body, 'chain 1', 'the error must name the expected chain (Ethereum mainnet = 1)');
    }
    expect(m.driver.isPresent('ckerc20-amount')).toBe(false);
    expect(m.driver.isPresent('btn-approve')).toBe(false);
    expect(mock.calls.length).toBe(0);

    // === Scenario 2: REVERTED RECEIPT (mainnet 0x1, receipt 0x0) ===============================
    // Connect succeeds, the user enters an amount and approves; waitForReceipt throws
    // ReceiptReverted → the sheet surfaces "reverted" and stays in 'enter' (NOT watching).
    mock = installMockProvider('0x1', '0x0');
    await m.driver.click('btn-connect-wallet', {timeoutMs: 5_000});
    await m.driver.findByTestID('ckerc20-amount', {timeoutMs: 5_000});
    await m.driver.type('ckerc20-amount', '100', {timeoutMs: 5_000});
    await m.driver.click('btn-approve', {timeoutMs: 5_000});

    expect(await m.driver.waitForText('reverted', {timeoutMs: 8_000})).toBe(true);
    {
      const body = m.driver.bodyText();
      expect(/Waiting for confirmation/.test(body)).toBe(false);
      expect(m.driver.isPresent('btn-approve')).toBe(true);
      expect(mock.calls.length).toBe(1);
    }

    // === Scenario 3: HAPPY PATH (mainnet 0x1, receipt 0x1) =====================================
    // Reinstall the mock with SUCCESS receipts; the sheet is still in 'enter' (after the revert),
    // so click btn-approve again → approve + deposit both mined → watching.
    mock = installMockProvider('0x1', '0x1');
    await m.driver.click('btn-approve', {timeoutMs: 5_000});
    expect(await m.driver.waitForText('Waiting for confirmation', {timeoutMs: 8_000})).toBe(true);
    {
      const body = m.driver.bodyText();
      expect(/scrapes/.test(body)).toBe(false);
      assertIncludes(body, 'USDC', 'CkErc20DepositSheet body should name the asset (USDC) (H1)');
      assertIncludes(body, 'ETH for network gas fees', 'the sheet must warn about Ethereum gas fees (M8)');
    }

    // Assert the WIRING: exactly 2 sendTransaction calls with the right contract + selector.
    const calls = mock.calls;
    assert(Array.isArray(calls) && calls.length === 2, `expected 2 eth_sendTransaction calls, got ${calls?.length}`);
    const [approve, deposit] = calls;
    const norm = (a: string | undefined): string => (a ?? '').toLowerCase();
    expect(norm(approve.to)).toBe(USDC_ADDR.toLowerCase());
    expect(norm(deposit.to)).toBe(HELPER_ADDR.toLowerCase());
    assertIncludes(approve.data ?? '', SEL_APPROVE, 'approve calldata must start with the approve selector');
    assertIncludes(deposit.data ?? '', SEL_DEPOSIT, 'deposit calldata must start with the depositErc20 selector');
    // depositErc20 calldata = 4-byte selector + 4×32-byte words = 132 bytes = 264 hex chars (0x + 264).
    expect((deposit.data ?? '').length).toBe(2 + 264);

    // === Deposit TARGET: the user's OWN IC principal, default subaccount ======================
    // (Facade-era regression guard: the deposit once minted at the FACADE principal — funds
    // invisible to every user-principal balance read.) decode calldata words: selector [0:10],
    // w1=erc20 [10:74], w2=amount [74:138], w3=principal [138:202], w4=subaccount [202:266].
    const acct = await accountOf(m);
    assert(!!acct?.publicHex, 'accountOf must return the onboarded identity publicHex');
    const expectedPrincipal = await DpayCore.icpPrincipalFromPubkey(acct!.publicHex);
    const word3 = (deposit.data ?? '').slice(138, 202);
    const word4 = (deposit.data ?? '').slice(202, 266);
    expect(word3).toBe(principalToBytes32(expectedPrincipal));
    expect(word4).toBe('0'.repeat(64));

    await m.unmount();
  }, 120_000);
});
