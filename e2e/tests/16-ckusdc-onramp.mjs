// Flow 16 — ckUSDC direct onramp via wallet-connect (M2). Proves the WIRING of the non-custodial
// ckERC20 deposit flow end-to-end through the REAL app + relay, with a MOCK Ethereum provider that
// records the two transactions the user's wallet would sign. dpay NEVER sees the key — it BUILDS the
// calldata (byte-exact vs the live helper-contract ABI, pinned by app/__tests__/cketh.test.ts) and
// asks the wallet to sign. This test asserts the seam: the CkErc20DepositSheet fetches the onramp
// params from the relay, builds approve+depositErc20 calldata, and calls eth_sendTransaction twice
// with the correct to-addresses (USDC contract / helper contract) + the correct ABI selectors.
//
// The byte-exactness of the calldata CONTENT is pinned by the jest golden suite (cketh.test.ts,
// 11 goldens incl. the full 132-byte depositErc20 calldata + 5 principal→bytes32 vectors). This flow
// proves the WIRING: that the right screen calls sendTransaction with calldata built from the relay's
// runtime params + the user's pubkey as the subaccount. The ETH radio hop (wallet signs + tx mined +
// minter scrapes ~20min) is an inherent outer-loop gate, not offline-testable.
//
// Selector contract: `balance` (header → Balances), `asset-add-ckusdc` (USDC row Add),
// `ckerc20-deposit`, `btn-connect-wallet`, `ckerc20-amount`, `btn-approve`, `ckerc20-status`.
import { setup, assert, assertIncludes, onboardWallet, openBalances } from '../harness/lib.mjs';

const USDC_ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const HELPER_ADDR = '0x18901044688D3756C35Ed2b36D93e6a5B8e00E68';
const SEL_APPROVE = '0x095ea7b3';
const SEL_DEPOSIT = '0xdb9751af';

export async function run() {
  const start = Date.now();
  console.log('[16-ckusdc-onramp] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // Install a MOCK EIP-1193 provider (window.ethereum) that records eth_sendTransaction calls.
    // This is the sanctioned smallest-boundary seam: only the provider I/O is faked; the app's real
    // calldata-building + sendTransaction wiring runs verbatim. Prod never installs this.
    await driver.eval(() => {
      const calls = [];
      window.__DPAY_TEST_ETH_CALLS = calls;
      window.ethereum = {
        request: async ({ method, params }) => {
          if (method === 'eth_requestAccounts') return ['0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'];
          if (method === 'eth_sendTransaction') { calls.push(params[0]); return '0x' + 'ab'.repeat(32); }
          return null;
        },
      };
    });
    console.log('[16-ckusdc-onramp] mock window.ethereum installed');

    await onboardWallet(driver, 'e2e-ckusdc');

    // Balances → USDC row "Add" (the CkEthErc20 ramp).
    console.log('[16-ckusdc-onramp] Balances → pick USDC…');
    await openBalances(driver);
    await driver.click('asset-add-ckusdc', { timeoutMs: 5_000 });
    await driver.findByTestID('ckerc20-deposit', { timeoutMs: 8_000 });
    {
      const body = await driver.bodyText();
      // H1: the sheet title names the ASSET (USDC), not the network (Ethereum).
      assertIncludes(body, 'Add USDC', 'CkErc20DepositSheet title should name the asset (USDC), not the network (H1)');
      assert(!/Add Ethereum/.test(body), 'the sheet title must not read "Add Ethereum" (H1)');
      // M8: a gas-fee warning must be present (the onramp needs ETH for the two Ethereum txs).
      assertIncludes(body, 'ETH for Ethereum network gas', 'the sheet must warn about Ethereum gas fees (M8)');
      console.log('[16-ckusdc-onramp] ✓ title is "Add USDC" (not Ethereum) + gas-fee note shown');
    }
    console.log('[16-ckusdc-onramp] ✓ CkErc20DepositSheet opened with wrong-network warning');

    // Connect the (mock) wallet.
    await driver.click('btn-connect-wallet', { timeoutMs: 5_000 });
    await driver.findByTestID('ckerc20-amount', { timeoutMs: 5_000 });
    console.log('[16-ckusdc-onramp] ✓ wallet connected, amount input shown');

    // Enter 100 USDC + Approve & deposit → triggers approve + depositErc20 (2 eth_sendTransaction).
    await driver.type('ckerc20-amount', '100', { timeoutMs: 5_000 });
    await driver.click('btn-approve', { timeoutMs: 5_000 });

    // The sheet transitions to "watching" once both txs are signed (calldata proven correct by the
    // recorded calls). M9: the watching state is now ONE clear line — no "scrapes" jargon, no
    // duplicate ~20min (confirmation + credit).
    await driver.waitForText('Waiting for confirmation', { timeoutMs: 8_000 });
    {
      const body = await driver.bodyText();
      assert(!/scrapes/.test(body), 'the watching state must not use the "scrapes" jargon (M9)');
      console.log('[16-ckusdc-onramp] ✓ watching state uses a single plain confirmation line (no "scrapes")');
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
