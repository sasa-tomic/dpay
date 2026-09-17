// Flow 33 — ckERC20 deposit state PERSISTS across app restart (MC8 U5). Proves the watching phase is
// RESUMABLE WITHOUT a wallet reconnect: an app restart mid-watch rehydrates the watching state from
// AsyncStorage, the relay balance poll picks back up, and the sheet re-opens showing the in-flight
// amount + a "deposit pending" notice — with NO "Connect wallet" prompt (the EIP-1193 session does
// NOT survive restart, but the watching poll hits the RELAY balance, not Ethereum, so it needs no
// wallet session).
//
// KEY LEVERAGE: only the watching phase is persisted. The wallet-bound phases (connect/enter/sending)
// are ephemeral and discarded on restart — an honest notice is shown if somehow a non-watching phase
// is recovered (defensive; the service layer filters them).
//
// Flow: drive the onramp to `watching` (mirror flow 16's happy-path mock: eth_chainId 0x1,
// eth_requestAccounts, eth_sendTransaction ×2, eth_getTransactionReceipt status 0x1 ×2 → watching),
// capture the amount + account, RELOAD the page (the EIP-1193 mock is gone — window.ethereum is
// undefined), then assert the sheet RE-OPENS in watching showing the original amount + the resumed
// "deposit pending" notice + a "Start a new deposit" escape, with NO "Connect wallet" prompt. The
// escape is then clicked to prove it returns to 'connect' (clearing the persisted key).
//
// Mock provider contract is identical to flow 16 (only provider I/O faked; cketh.ts calldata runs
// verbatim). Selector contract: `asset-ckusdc-select` (USDC row whole-row select),
// `btn-receive-address` (Receive → "My address"), `ckerc20-deposit`, `btn-connect-wallet`,
// `btn-approve`, `ckerc20-amount`, `ckerc20-status`, `btn-ckerc20-new`, `btn-ckerc20-check`.
import { setup, assert, assertIncludes, onboardWallet, openBalances, selectCurrency, openReceiveAddress, waitForWallet} from '../harness/lib.mjs';

// Install a recording EIP-1193 mock identical to flow 16's (chainId 0x1 = Ethereum mainnet, receipt
// status 0x1 = success). After reload this is GONE (window.ethereum is undefined) — proving the
// watching resume works WITHOUT the wallet session.
/** The happy-path EIP-1193 mock as an init script: the seeded boot's navigation discards plain
  * evals made on the pre-boot page, so the FIRST install must ride evaluateOnNewDocument to be
  * live when the deposit surface mounts. Removed right after boot — the flow later proves the
  * mock does NOT survive a reload. */
async function installHappyProvider(driver) {
  return driver.addInitScript(() => {
    const calls = [];
    window.__DPAY_TEST_ETH_CALLS = calls;
    window.ethereum = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') return ['0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'];
        if (method === 'eth_chainId') return '0x1'; // Ethereum mainnet
        if (method === 'eth_sendTransaction') { calls.push(params[0]); return '0x' + 'ab'.repeat(32); }
        if (method === 'eth_getTransactionReceipt') return { status: '0x1' }; // mined successfully
        return null;
      },
    };
  });
}

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '33',
  name: 'ckerc20-persist',
  journey: 'deposit',
  covers: ['ckerc20', 'persist', 'restart', 'watching-resume'],
  verifies: 'ckERC20 deposit watching PERSISTS across restart: reload rehydrates watching (no reconnect), resumed notice shown.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[33-ckerc20-persist] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL, webBaseURL } = env;

    // === PHASE 1: drive the onramp to `watching` (happy path) ===================================
    const providerSeed = await installHappyProvider(driver);
    console.log('[33-ckerc20-persist] happy-path ETH mock installed (chainId=0x1, receipt=0x1)');

    await onboardWallet(driver, 'e2e-persist');
    await driver.removeInitScript(providerSeed);
    await openBalances(driver);
    await selectCurrency(driver, 'ckusdc');
    await openReceiveAddress(driver);
    await driver.findByTestID('ckerc20-deposit', { timeoutMs: 8_000 });

    // Founder 2026-08-29: the connect view must ALSO surface the plain ICRC-1 receive route —
    // ckUSDC already on the IC transfers straight to the wallet's principal (no Ethereum txs).
    // (textContent, not bodyText: innerText drops line-clamped text.)
    const icSec = await driver.findByTestID('ic-also-section', { timeoutMs: 5_000 });
    const icTxt = (await icSec.evaluate(n => (n.textContent ?? '').trim()));
    assertIncludes(icTxt, 'Already on the Internet Computer', 'erc20 sheet shows the IC-receive section');
    assertIncludes(icTxt, 'ckUSDC', 'IC-receive section names the LEDGER token (ckUSDC, not USDC-on-Ethereum)');

    // Connect + enter amount + approve → both txs mined (mock receipt 0x1) → watching.
    await driver.click('btn-connect-wallet', { timeoutMs: 5_000 });
    await driver.findByTestID('ckerc20-amount', { timeoutMs: 5_000 });
    await driver.type('ckerc20-amount', '100', { timeoutMs: 5_000 });
    await driver.click('btn-approve', { timeoutMs: 5_000 });
    await driver.waitForText('Waiting for confirmation', { timeoutMs: 8_000 });
    console.log('[33-ckerc20-persist] ✓ reached watching (fresh session, wallet connected)');

    // Sanity: the watching state IS persisted (AsyncStorage key written by the phase-transition
    // effect). Read it back directly to prove the key exists + carries the resumable slice.
    const persisted = await driver.eval(() => {
      // AsyncStorage on web (react-native-web) is backed by localStorage; scan for the key prefix.
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('dpay.ckerc20.deposit.')) {
          return { key: k, value: JSON.parse(localStorage.getItem(k)) };
        }
      }
      return null;
    });
    assert(persisted !== null, 'a watching deposit MUST be persisted to AsyncStorage on phase entry');
    assert(persisted.value.phase === 'watching', `persisted phase must be "watching", got ${persisted.value.phase}`);
    assert(persisted.value.amount === '100', `persisted amount must be "100", got ${persisted.value.amount}`);
    assert(Array.isArray(persisted.value.txHashes) && persisted.value.txHashes.length === 2,
      `persisted txHashes must have 2 entries, got ${JSON.stringify(persisted.value.txHashes)}`);
    console.log(`[33-ckerc20-persist] ✓ AsyncStorage key ${persisted.key} (phase=watching, amount=100, 2 txHashes)`);

    // === PHASE 2: RELOAD — the EIP-1193 session is gone; the watching state must resume =========
    // Reload with the same ?relay= path (relay persistence is flow 12's concern; here we isolate the
    // deposit resume). The mock provider does NOT survive the navigation.
    console.log('[33-ckerc20-persist] reloading page (the ETH mock will be gone)…');
    const navPath = `/?relay=${encodeURIComponent(relayBaseURL)}`;
    await driver.navigate(webBaseURL, navPath, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 8_000 });

    // Prove the wallet session is truly gone (the resume must work WITHOUT it).
    const hasProvider = await driver.eval(() => typeof window.ethereum !== 'undefined');
    assert(hasProvider === false, 'window.ethereum must be undefined after reload (EIP-1193 sessions do not persist)');
    console.log('[33-ckerc20-persist] ✓ window.ethereum is gone after reload (no wallet session)');

    // The Wallet auto-open effect scans for a persisted watching deposit + opens the sheet. Wait for
    // the sheet to re-appear, then assert it is in the WATCHING phase (not connect/enter).
    await driver.findByTestID('ckerc20-deposit', { timeoutMs: 8_000 });
    console.log('[33-ckerc20-persist] ✓ sheet re-opened after reload (auto-open on persisted watching)');

    // NO "Connect wallet" prompt — the resume skipped the connect/enter/sending phases entirely.
    assert(!(await driver.isPresent('btn-connect-wallet')),
      'resumed watching must NOT show btn-connect-wallet (the wallet session is not needed)');
    assert(!(await driver.isPresent('ckerc20-amount')),
      'resumed watching must NOT show the amount input (phase is watching, not enter)');
    console.log('[33-ckerc20-persist] ✓ no Connect-wallet / amount input (resume without wallet reconnect)');

    // The watching UI surfaces the in-flight amount + the honest "deposit pending" notice.
    {
      const body = await driver.bodyText();
      // Original amount shown so the user knows WHAT is pending across the restart.
      assertIncludes(body, '100', 'resumed watching must show the in-flight amount');
      assertIncludes(body, 'USDC', 'resumed watching must name the asset (USDC)');
      // The honest resumed notice — NOT the fresh-session "Waiting for confirmation" line.
      assertIncludes(body, 'Deposit pending', 'resumed watching must surface the "Deposit pending" notice');
      assert(!/Connect wallet/.test(body), 'resumed watching must NOT show a Connect wallet prompt');
      console.log('[33-ckerc20-persist] ✓ resumed watching shows amount(100) + "Deposit pending" + no Connect prompt');
    }

    // The "Start a new deposit" escape exists (a stuck watching key must not wedge the sheet).
    assert(await driver.isPresent('btn-ckerc20-new'),
      'resumed watching must show btn-ckerc20-new (the escape from a stuck watch)');
    console.log('[33-ckerc20-persist] ✓ "Start a new deposit" escape present (btn-ckerc20-new)');

    // The manual recheck. Every other deposit sheet (ckBTC, direct-ICRC, Solana) has always had
    // one; this sheet left the user with nothing to do but wait out the poll interval, which on a
    // watching screen reads as "nothing is happening". It shares the cadence poll's comparison, so
    // tapping it cannot reach a different verdict than waiting would.
    assert(await driver.isPresent('btn-ckerc20-check'),
      'the watching state must offer a manual "Check now" like the other deposit sheets');
    await driver.click('btn-ckerc20-check', { timeoutMs: 5_000 });
    // Still watching: nothing was deposited, so an honest recheck changes nothing.
    await driver.findByTestID('ckerc20-status', { timeoutMs: 5_000 });
    assert(await driver.isPresent('btn-ckerc20-check'),
      'an unfunded recheck leaves the watch running — it must not fake a completed deposit');
    console.log('[33-ckerc20-persist] ✓ manual recheck present and honest (still watching)');

    // === PHASE 3 (optional): the escape clears the key + returns to 'connect' ===================
    // Clicking the escape clears the persisted watching key and returns to 'connect' so the user can
    // begin fresh. The wallet session is gone, so 'connect' is the honest reset target.
    await driver.click('btn-ckerc20-new', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-connect-wallet', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('btn-ckerc20-new')),
      'after escape, the resumed-watching escape must be gone (phase is now connect)');
    console.log('[33-ckerc20-persist] ✓ escape → connect (btn-connect-wallet back, resumed UI gone)');

    // The persisted key is GONE after the escape (clearDeposit ran). A second reload must NOT re-open
    // the sheet (it lands on the wallet main screen, not the deposit sheet).
    await driver.navigate(webBaseURL, navPath, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 8_000 });
    await waitForWallet(driver, { timeoutMs: 8_000 }); // wallet main screen rendered
    assert(!(await driver.isPresent('ckerc20-deposit')),
      'after escape + reload, the deposit sheet must NOT re-open (the key was cleared)');
    console.log('[33-ckerc20-persist] ✓ post-escape reload lands on the wallet (key cleared, no auto-open)');

    console.log(`[33-ckerc20-persist] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[33-ckerc20-persist] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
