// Flow 16 — ckUSDC direct onramp via wallet-connect (M2) + chain-ID enforcement (MC8 U3). Proves the
// WIRING of the non-custodial ckERC20 deposit flow end-to-end through the REAL app + relay, with a
// MOCK Ethereum provider that records the two transactions the user's wallet would sign. dpay NEVER
// sees the key — it BUILDS the calldata (byte-exact vs the live helper-contract ABI, pinned by
// app/__tests__/cketh.test.ts) and asks the wallet to sign.
//
// MC8 U3 — chain-ID enforcement: the mock provider now answers `eth_chainId`. The flow runs TWO
// scenarios against the SAME sheet:
//   1. WRONG-NETWORK GUARD: mock returns chainId '0x89' (Polygon) → connect must surface a
//      "Wrong network" error, stay in the 'connect' phase (NO amount input / NO btn-approve), and
//      record ZERO eth_sendTransaction calls. This is the close: a wrong-network MetaMask can no
//      longer silently broadcast calldata to the wrong chain.
//   2. HAPPY PATH: the mock is reinstalled to return chainId '0x1' (Ethereum mainnet) → connect
//      proceeds, the user enters 100 USDC, Approve & deposit fires exactly 2 sendTransaction calls
//      with the right contract + selector (the original wiring proof).
//
// The byte-exactness of the calldata CONTENT is pinned by the jest golden suite (cketh.test.ts,
// 11 goldens incl. the full 132-byte depositErc20 calldata + 5 principal→bytes32 vectors). The ETH
// radio hop (wallet signs + tx mined + minter scrapes ~20min) is an inherent outer-loop gate.
//
// Mock provider contract: `{request({method, params}) -> Promise<unknown>}` — the sanctioned smallest
// boundary; only provider I/O is faked, the app's real calldata-building + sendTransaction wiring
// runs verbatim. Responds to: eth_requestAccounts, eth_chainId, eth_sendTransaction.
//
// Selector contract: `balance` (header → Balances), `asset-add-ckusdc` (USDC row Add),
// `ckerc20-deposit`, `btn-connect-wallet`, `ckerc20-amount`, `btn-approve`, `ckerc20-status`.
import { setup, assert, assertIncludes, onboardWallet, openBalances } from '../harness/lib.mjs';

const USDC_ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const HELPER_ADDR = '0x18901044688D3756C35Ed2b36D93e6a5B8e00E68';
const SEL_APPROVE = '0x095ea7b3';
const SEL_DEPOSIT = '0xdb9751af';

// Install a recording EIP-1193 mock on window.ethereum with a configurable chain id. The calls array
// is exposed on window.__DPAY_TEST_ETH_CALLS so the flow can assert the sendTransaction count.
async function installMockProvider(driver, chainIdHex) {
  await driver.eval((hex) => {
    const calls = [];
    window.__DPAY_TEST_ETH_CALLS = calls;
    window.ethereum = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') return ['0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'];
        if (method === 'eth_chainId') return hex; // MC8 U3: the wallet's current chain
        if (method === 'eth_sendTransaction') { calls.push(params[0]); return '0x' + 'ab'.repeat(32); }
        return null;
      },
    };
  }, chainIdHex);
}

export async function run() {
  const start = Date.now();
  console.log('[16-ckusdc-onramp] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // --- MC8 U3 scenario 1: WRONG-NETWORK GUARD (Polygon 0x89) ---------------------------------
    // Install the mock on the WRONG chain first so the connect guard is exercised before the happy
    // path. The sheet must surface a wrong-network error and NEVER reach the amount/approve phase.
    await installMockProvider(driver, '0x89'); // Polygon
    console.log('[16-ckusdc-onramp] mock window.ethereum installed (chainId=0x89 Polygon)');

    await onboardWallet(driver, 'e2e-ckusdc');

    console.log('[16-ckusdc-onramp] Balances → pick USDC…');
    await openBalances(driver);
    await driver.click('asset-add-ckusdc', { timeoutMs: 5_000 });
    await driver.findByTestID('ckerc20-deposit', { timeoutMs: 8_000 });

    // Connect on the wrong chain → the sheet must abort with a wrong-network error.
    await driver.click('btn-connect-wallet', { timeoutMs: 5_000 });
    {
      const body = await driver.bodyText();
      assertIncludes(body, 'Wrong network', 'connect on the wrong chain must surface a wrong-network error');
      assertIncludes(body, 'chain 1', 'the error must name the expected chain (Ethereum mainnet = 1)');
      console.log('[16-ckusdc-onramp] ✓ wrong-network guard: "Wrong network … chain 1" surfaced');
    }
    // The sheet must STAY in the connect phase: NO amount input + NO approve button.
    const amountPresent = await driver.isPresent('ckerc20-amount');
    const approvePresent = await driver.isPresent('btn-approve');
    assert(!amountPresent, 'wrong-network connect must NOT show the amount input (stays in connect phase)');
    assert(!approvePresent, 'wrong-network connect must NOT show btn-approve (stays in connect phase)');
    // ZERO sendTransaction calls — no calldata was broadcast to the wrong chain.
    const wrongChainCalls = await driver.eval(() => window.__DPAY_TEST_ETH_CALLS?.length ?? 0);
    assert(wrongChainCalls === 0, `wrong-network connect must fire 0 sendTransaction calls, got ${wrongChainCalls}`);
    console.log('[16-ckusdc-onramp] ✓ wrong-network: 0 eth_sendTransaction calls (no wrong-chain broadcast)');

    // --- MC8 U3 scenario 2: HAPPY PATH (Ethereum mainnet 0x1) ----------------------------------
    // Reinstall the mock on the CORRECT chain and reconnect. The connect button is still visible
    // (the wrong-network guard stayed in the connect phase), so click it again.
    await installMockProvider(driver, '0x1'); // Ethereum mainnet
    console.log('[16-ckusdc-onramp] mock reinstalled (chainId=0x1 Ethereum mainnet)');

    await driver.click('btn-connect-wallet', { timeoutMs: 5_000 });
    await driver.findByTestID('ckerc20-amount', { timeoutMs: 5_000 });
    console.log('[16-ckusdc-onramp] ✓ wallet connected on mainnet, amount input shown');

    {
      const body = await driver.bodyText();
      // H1: the sheet title names the ASSET (USDC), not the network (Ethereum).
      assertIncludes(body, 'Add USDC', 'CkErc20DepositSheet title should name the asset (USDC), not the network (H1)');
      assert(!/Add Ethereum/.test(body), 'the sheet title must not read "Add Ethereum" (H1)');
      // M8: a gas-fee warning must be present (the onramp needs ETH for the two Ethereum txs).
      assertIncludes(body, 'ETH for Ethereum network gas', 'the sheet must warn about Ethereum gas fees (M8)');
      console.log('[16-ckusdc-onramp] ✓ title is "Add USDC" (not Ethereum) + gas-fee note shown');
    }

    // Enter 100 USDC + Approve & deposit → triggers approve + depositErc20 (2 eth_sendTransaction).
    await driver.type('ckerc20-amount', '100', { timeoutMs: 5_000 });
    await driver.click('btn-approve', { timeoutMs: 5_000 });

    // The sheet transitions to "watching" once both txs are signed (calldata proven correct by the
    // recorded calls). M9: the watching state is now ONE clear line — no "scrapes" jargon.
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
