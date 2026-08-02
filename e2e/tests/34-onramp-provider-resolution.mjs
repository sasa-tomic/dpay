// Flow 34 — Onramp provider-SOURCE resolution (MC8 U6.3 + U6.7).
//
// Flow 16 proves the full ckERC20 calldata wiring (approve + depositErc20 byte-exact, chain-id gate,
// receipt/revert handling) against a MOCK EIP-1193 provider. This flow proves the SOURCE PICKER seam
// itself — `resolveOnrampProvider()` in wallet.ts — without any real WalletConnect pairing (the WC
// branch is unreachable in this web harness BY DESIGN: react-native-web sets Platform.OS='web', so
// the resolver's WC gate `Platform.OS !== 'web'` is always false, even though the harness injects a
// non-empty `__DPAY_TEST_WALLETCONNECT_PROJECT_ID` via driver.mjs injectTestGlobals so WC is
// "configured" app-wide). Two assertions:
//
//   (a) WEB-MOCK WINS — with `window.ethereum` set, the resolver returns it FIRST (before any WC
//       code), connect succeeds, and the amount input appears. This is the load-bearing web-first
//       ordering: the browser path + the e2e mock provider never reach WalletConnect.
//   (b) NO WALLET (WC unreachable on web) — delete `window.ethereum`; even though WC is "configured"
//       (project id set), the web Platform gate blocks the WC branch → resolver returns null → the
//       sheet surfaces the honest "No Ethereum wallet found" error + 0 eth_sendTransaction calls.
//       Proves the resolver correctly falls through to null and the sheet shows an honest no-wallet
//       state rather than crashing, hanging, or reaching WalletConnect.
//
// The native copy ("No wallet connected. Pair a wallet via WalletConnect.") is the Platform.OS!=='web'
// branch of the same ternary (CkErc20DepositSheet.connect); it cannot fire in this web harness and is
// proven by code inspection + `just typecheck`. The live WalletConnect PAIRING (QR modal → wallet
// handshake → encrypted session) needs a real wallet + network and is an outer-loop device gate —
// explicitly scoped OUT (same class as the NFC radio hop + the ETH tx-mining hop).
//
// Selector contract: `balance` (header → Balances), `asset-add-ckusdc` (USDC row Add → deposit sheet),
// `ckerc20-deposit`, `btn-connect-wallet`, `ckerc20-amount`, `ckerc20-status`, `btn-ckerc20-close`.
import { setup, assert, assertIncludes, onboardWallet, openBalances } from '../harness/lib.mjs';

// A minimal recording EIP-1193 mock — only the methods `connect` calls (eth_requestAccounts +
// eth_chainId). eth_sendTransaction is recorded (pushed to window.__DPAY_TEST_ETH_CALLS) so the flow
// can assert 0 sends in the no-wallet leg, but this flow never submits (no approve/deposit).
async function installMockProvider(driver, chainIdHex) {
  await driver.eval((hex) => {
    const calls = [];
    window.__DPAY_TEST_ETH_CALLS = calls;
    window.ethereum = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') return ['0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'];
        if (method === 'eth_chainId') return hex; // Ethereum mainnet
        if (method === 'eth_sendTransaction') { calls.push(params[0]); return '0x' + 'ab'.repeat(32); }
        return null;
      },
    };
  }, chainIdHex);
}

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '34',
  name: 'onramp-provider-resolution',
  journey: 'deposit',
  covers: ['onramp-resolver', 'eip-1193', 'walletconnect-gate'],
  verifies: 'Onramp resolver: window.ethereum wins when present; WC branch unreachable on web even when \'configured\' → honest null.',
  timeoutMs: 15000,
};

export async function run() {
  const start = Date.now();
  console.log('[34-onramp-provider-resolution] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // === (a) WEB-MOCK WINS ============================================================
    // With window.ethereum set, resolveOnrampProvider() returns it FIRST — before any WalletConnect
    // code. Connect succeeds → the amount input appears (the sheet transitioned connect → enter).
    await installMockProvider(driver, '0x1');
    console.log('[34-onramp-provider-resolution] mock installed (window.ethereum, chainId=0x1)');

    await onboardWallet(driver, 'e2e-resolve');
    await openBalances(driver);
    await driver.click('asset-add-ckusdc', { timeoutMs: 5_000 });
    await driver.findByTestID('ckerc20-deposit', { timeoutMs: 8_000 });

    await driver.click('btn-connect-wallet', { timeoutMs: 5_000 });
    // Connect succeeded → the amount input renders (the resolver returned the mock, not null).
    await driver.findByTestID('ckerc20-amount', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('ckerc20-status')),
      'connect with a web provider must NOT surface an error (ckerc20-status absent)');
    console.log('[34-onramp-provider-resolution] ✓ web-mock wins: connect succeeded, amount input shown');

    // === (b) NO WALLET — WC unreachable on web (Platform gate) ========================
    // Close the connected sheet, delete window.ethereum, reopen the deposit sheet, and click connect.
    // WALLETCONNECT_PROJECT_ID is "configured" (driver.mjs injects __DPAY_TEST_WALLETCONNECT_PROJECT_ID
    // before the bundle loads), BUT the resolver's WC branch is gated by `Platform.OS !== 'web'` —
    // react-native-web sets Platform.OS='web' in this harness, so the WC branch is unreachable. The
    // resolver falls through to null → the sheet surfaces the honest "No Ethereum wallet found" error.
    await driver.click('btn-ckerc20-close', { timeoutMs: 5_000 });
    await driver.eval(() => { delete window.ethereum; });
    console.log('[34-onramp-provider-resolution] window.ethereum deleted (WC configured but Platform-gated out)');

    await openBalances(driver);
    await driver.click('asset-add-ckusdc', { timeoutMs: 5_000 });
    await driver.findByTestID('ckerc20-deposit', { timeoutMs: 8_000 });
    await driver.click('btn-connect-wallet', { timeoutMs: 5_000 });

    // The honest no-wallet error must surface (the resolver returned null → connect stayed in phase
    // 'connect' and set the platform-aware error copy).
    const noWallet = await driver.waitForText('No Ethereum wallet found', { timeoutMs: 5_000 });
    const body = await driver.bodyText();
    assert(noWallet,
      `no-wallet (WC unreachable on web) must surface the honest "No Ethereum wallet found" error.\n  body excerpt:\n${body.slice(0, 600)}`);
    // The amount input + approve button must NOT appear (stayed in 'connect' phase — no provider).
    assert(!(await driver.isPresent('ckerc20-amount')),
      'no-wallet must NOT show the amount input (stayed in connect phase)');
    assert(!(await driver.isPresent('btn-approve')),
      'no-wallet must NOT show btn-approve (stayed in connect phase)');
    // 0 eth_sendTransaction calls across the whole flow (neither leg submitted; the no-wallet leg had
    // no provider at all). __DPAY_TEST_ETH_CALLS was reset by installMockProvider in leg (a) and only
    // eth_sendTransaction pushes to it — connect's eth_requestAccounts/eth_chainId do not.
    const calls = await driver.eval(() => window.__DPAY_TEST_ETH_CALLS?.length ?? 0);
    assert(calls === 0, `no-wallet must fire 0 eth_sendTransaction calls, got ${calls}`);
    console.log('[34-onramp-provider-resolution] ✓ no-wallet: honest error + 0 sendTransaction (WC unreachable on web)');

    await driver.screenshot('34-onramp-provider-resolution');

    console.log(`[34-onramp-provider-resolution] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[34-onramp-provider-resolution] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
