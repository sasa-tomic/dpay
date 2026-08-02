// Flow 16 — ckUSDC direct onramp via wallet-connect (M2) + chain-ID enforcement (MC8 U3) + ETH
// receipt/revert handling (MC8 U4). Proves the WIRING of the non-custodial ckERC20 deposit flow
// end-to-end through the REAL app + relay, with a MOCK Ethereum provider. dpay NEVER sees the key —
// it BUILDS the calldata (byte-exact vs the live helper-contract ABI, pinned by cketh.test.ts) and
// asks the wallet to sign.
//
// Three scenarios against the SAME sheet, each reinstalling the mock provider:
//   1. WRONG-NETWORK GUARD (MC8 U3): chainId '0x89' (Polygon) → connect surfaces a "Wrong network"
//      error, stays in 'connect' (NO amount/approve), 0 sendTransaction calls.
//   2. REVERTED RECEIPT (MC8 U4): chainId '0x1' + receipt status '0x0' → connect + enter + approve,
//      then waitForReceipt throws ReceiptReverted → "reverted" error surfaced, stays in 'enter'
//      (NO watching transition). 1 sendTransaction call (the reverted approve).
//   3. HAPPY PATH: chainId '0x1' + receipt status '0x1' → re-approve → both txs mined → watching.
//      Exactly 2 sendTransaction calls with the right contract + selector.
//
// MC8 U4 close: sendTransaction previously returned the hash on accept (NOT mined) and the sheet
// unconditionally setPhase('watching') → a reverted approve/deposit lied as "will appear in ~20min".
// Now each sendTransaction is followed by waitForReceipt; a 0x0 status surfaces an honest "reverted"
// error and a timeout transitions to watching SOFTLY (Fork-2).
//
// The byte-exactness of the calldata CONTENT is pinned by the jest golden suite (cketh.test.ts,
// 11 goldens). The ETH radio hop (wallet signs + tx mined + minter scrapes ~20min) is an outer-loop
// gate. Mock provider contract: `{request({method, params}) -> Promise<unknown>}` — only provider
// I/O is faked; the app's real calldata-building + sendTransaction + waitForReceipt runs verbatim.
// Responds to: eth_requestAccounts, eth_chainId, eth_sendTransaction, eth_getTransactionReceipt.
//
// Selector contract: `balance` (header → Balances), `asset-add-ckusdc` (USDC row Add),
// `ckerc20-deposit`, `btn-connect-wallet`, `ckerc20-amount`, `btn-approve`, `ckerc20-status`.
import { setup, assert, assertIncludes, onboardWallet, openBalances } from '../harness/lib.mjs';

const USDC_ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const HELPER_ADDR = '0x18901044688D3756C35Ed2b36D93e6a5B8e00E68';
const SEL_APPROVE = '0x095ea7b3';
const SEL_DEPOSIT = '0xdb9751af';

// Install a recording EIP-1193 mock with a configurable chain id + receipt status. The calls array
// is exposed on window.__DPAY_TEST_ETH_CALLS so the flow can assert the sendTransaction count.
// `receiptStatus` is the status field every eth_getTransactionReceipt returns ('0x1' success /
// '0x0' reverted); the mock always returns a receipt immediately (no mining delay in the harness).
async function installMockProvider(driver, chainIdHex, receiptStatus) {
  await driver.eval((hex, status) => {
    const calls = [];
    window.__DPAY_TEST_ETH_CALLS = calls;
    window.ethereum = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') return ['0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'];
        if (method === 'eth_chainId') return hex; // MC8 U3: the wallet's current chain
        if (method === 'eth_sendTransaction') { calls.push(params[0]); return '0x' + 'ab'.repeat(32); }
        if (method === 'eth_getTransactionReceipt') return { status }; // MC8 U4: mined immediately
        return null;
      },
    };
  }, chainIdHex, receiptStatus);
}

export async function run() {
  const start = Date.now();
  console.log('[16-ckusdc-onramp] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // === MC8 U3 scenario 1: WRONG-NETWORK GUARD (Polygon 0x89) =================================
    await installMockProvider(driver, '0x89', '0x1');
    console.log('[16-ckusdc-onramp] mock installed (chainId=0x89 Polygon)');

    await onboardWallet(driver, 'e2e-ckusdc');
    console.log('[16-ckusdc-onramp] Balances → pick USDC…');
    await openBalances(driver);
    await driver.click('asset-add-ckusdc', { timeoutMs: 5_000 });
    await driver.findByTestID('ckerc20-deposit', { timeoutMs: 8_000 });

    await driver.click('btn-connect-wallet', { timeoutMs: 5_000 });
    {
      const body = await driver.bodyText();
      assertIncludes(body, 'Wrong network', 'connect on the wrong chain must surface a wrong-network error');
      assertIncludes(body, 'chain 1', 'the error must name the expected chain (Ethereum mainnet = 1)');
      console.log('[16-ckusdc-onramp] ✓ wrong-network guard: "Wrong network … chain 1" surfaced');
    }
    assert(!(await driver.isPresent('ckerc20-amount')), 'wrong-network must NOT show the amount input');
    assert(!(await driver.isPresent('btn-approve')), 'wrong-network must NOT show btn-approve');
    const wrongChainCalls = await driver.eval(() => window.__DPAY_TEST_ETH_CALLS?.length ?? 0);
    assert(wrongChainCalls === 0, `wrong-network must fire 0 sendTransaction calls, got ${wrongChainCalls}`);
    console.log('[16-ckusdc-onramp] ✓ wrong-network: 0 eth_sendTransaction calls');

    // === MC8 U4 scenario 2: REVERTED RECEIPT (mainnet 0x1, receipt 0x0) =========================
    // Reinstall the mock on mainnet but with a REVERTED receipt. Connect succeeds, the user enters an
    // amount and approves; waitForReceipt throws ReceiptReverted → the sheet surfaces "reverted" and
    // stays in 'enter' (NO watching transition). This is the close: a reverted tx no longer lies.
    await installMockProvider(driver, '0x1', '0x0');
    console.log('[16-ckusdc-onramp] mock reinstalled (chainId=0x1, receipt=0x0 reverted)');

    await driver.click('btn-connect-wallet', { timeoutMs: 5_000 });
    await driver.findByTestID('ckerc20-amount', { timeoutMs: 5_000 });
    await driver.type('ckerc20-amount', '100', { timeoutMs: 5_000 });
    await driver.click('btn-approve', { timeoutMs: 5_000 });

    // The reverted receipt must surface an honest error and keep the sheet in 'enter' (NOT watching).
    assert(await driver.waitForText('reverted', { timeoutMs: 8_000 }), 'a reverted receipt must surface a "reverted" error');
    {
      const body = await driver.bodyText();
      assert(!/Waiting for confirmation/.test(body), 'a reverted tx must NOT reach the watching state');
      console.log('[16-ckusdc-onramp] ✓ reverted receipt → "reverted" error, NO watching transition');
    }
    // btn-approve is still visible (stayed in 'enter'); only the approve fired (1 sendTransaction).
    assert(await driver.isPresent('btn-approve'), 'a reverted tx must keep btn-approve visible (stay in enter)');
    const revertedCalls = await driver.eval(() => window.__DPAY_TEST_ETH_CALLS?.length ?? 0);
    assert(revertedCalls === 1, `reverted scenario should fire 1 sendTransaction (the approve), got ${revertedCalls}`);

    // === HAPPY PATH (mainnet 0x1, receipt 0x1) =================================================
    // Reinstall the mock with SUCCESS receipts. The sheet is still in 'enter' (after the revert), so
    // click btn-approve again → approve + deposit both mined → watching.
    await installMockProvider(driver, '0x1', '0x1');
    console.log('[16-ckusdc-onramp] mock reinstalled (chainId=0x1, receipt=0x1 success)');

    await driver.click('btn-approve', { timeoutMs: 5_000 });
    await driver.waitForText('Waiting for confirmation', { timeoutMs: 8_000 });
    {
      const body = await driver.bodyText();
      assert(!/scrapes/.test(body), 'the watching state must not use the "scrapes" jargon (M9)');
      // H1: the sheet title names the ASSET (USDC), not the network (Ethereum).
      assertIncludes(body, 'Add USDC', 'CkErc20DepositSheet title should name the asset (USDC), not the network (H1)');
      assert(!/Add Ethereum/.test(body), 'the sheet title must not read "Add Ethereum" (H1)');
      assertIncludes(body, 'ETH for Ethereum network gas', 'the sheet must warn about Ethereum gas fees (M8)');
      console.log('[16-ckusdc-onramp] ✓ happy path: title "Add USDC" + gas note + watching (no "scrapes")');
    }

    // Assert the WIRING: exactly 2 sendTransaction calls with the right contract + selector.
    const calls = await driver.eval(() => window.__DPAY_TEST_ETH_CALLS);
    assert(Array.isArray(calls) && calls.length === 2, `expected 2 eth_sendTransaction calls, got ${calls?.length}`);
    const [approve, deposit] = calls;
    const norm = (a) => (a || '').toLowerCase();
    assert(norm(approve.to) === USDC_ADDR.toLowerCase(), `approve.to should be USDC, got ${approve.to}`);
    assert(norm(deposit.to) === HELPER_ADDR.toLowerCase(), `deposit.to should be helper, got ${deposit.to}`);
    assertIncludes(approve.data, SEL_APPROVE, 'approve calldata must start with the approve selector');
    assertIncludes(deposit.data, SEL_DEPOSIT, 'deposit calldata must start with the depositErc20 selector');
    // depositErc20 calldata = 4-byte selector + 4×32-byte words = 132 bytes = 264 hex chars (0x + 264).
    assert(deposit.data.length === 2 + 264, `deposit calldata should be 132 bytes, got ${(deposit.data.length - 2) / 2}`);
    console.log('[16-ckusdc-onramp] ✓ approve→USDC(sel 095ea7b3) + depositErc20→helper(sel db9751af, 132 bytes)');

    console.log(`[16-ckusdc-onramp] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}
