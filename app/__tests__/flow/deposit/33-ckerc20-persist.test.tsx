/**
 * Flow 33 ckerc20-persist — the jest twin of `e2e/tests/33-ckerc20-persist.mjs`.
 *
 * The watching phase is RESUMABLE WITHOUT a wallet reconnect: drive the onramp to `watching`
 * (the happy-path EIP-1193 mock), capture the persisted AsyncStorage key, then RELOAD the app
 * (remount without clearing storage) with the wallet session GONE (window.ethereum deleted —
 * EIP-1193 sessions do not survive a restart). The sheet must auto-reopen in watching: the
 * in-flight amount + the honest "Deposit pending" notice, NO "Connect wallet" prompt, the
 * "Start a new deposit" escape, and an honest manual recheck. The escape clears the key, and a
 * second reload does NOT re-open the sheet.
 */
import {it, expect} from '@jest/globals';
import {
  assert, assertIncludes, onboardWallet, openBalances, openReceiveAddress, selectCurrency,
  waitForWallet, type Mount,
} from '../harness/lib';
import {deadline as budgetDeadline} from '../harness/budget';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

const g = globalThis as unknown as Record<string, unknown>;
const mark = (l: string): void => { if (process.env.DPAY_FLOW_DEBUG === '1') console.log(`[m33] ${l}`); };

type EthCall = {to?: string; data?: string};

/** Install the happy-path EIP-1193 mock (chainId 0x1 = Ethereum mainnet, receipt 0x1 = success).
 *  Deleted before the reload — proving the watching resume works WITHOUT the wallet session. */
function installHappyProvider(): void {
  g.ethereum = {
    request: async ({method, params}: {method: string; params?: unknown[]}) => {
      if (method === 'eth_requestAccounts') return ['0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'];
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_sendTransaction') { (g.__DPAY_TEST_ETH_CALLS as EthCall[]).push((params as EthCall[])[0]); return '0x' + 'ab'.repeat(32); }
      if (method === 'eth_getTransactionReceipt') return {status: '0x1'};
      return null;
    },
  };
}

type Persisted = {key: string; value: {phase?: string; amount?: string; txHashes?: string[]}};

/** The persisted ckERC20 deposit record, scanned straight off AsyncStorage (the app's own store;
 *  on the web build this is the localStorage key the phase-transition effect writes). */
async function readPersistedDeposit(): Promise<Persisted | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AsyncStorage = require('@react-native-async-storage/async-storage') as {
    getAllKeys: () => Promise<readonly string[]>;
    getItem: (k: string) => Promise<string | null>;
  };
  for (const k of await AsyncStorage.getAllKeys()) {
    if (typeof k === 'string' && k.startsWith('dpay.ckerc20.deposit.')) {
      const raw = await AsyncStorage.getItem(k);
      return raw ? {key: k, value: JSON.parse(raw)} : null;
    }
  }
  return null;
}

hermeticDescribe('flow 33 — ckERC20 watching persists across an app restart', () => {
  it('reload rehydrates watching with no wallet reconnect; escape clears the key', async () => {
    // === PHASE 1: drive the onramp to `watching` (happy path) ==================================
    g.__DPAY_TEST_ETH_CALLS = [];
    installHappyProvider();
    mark('onboard');
    let m: Mount = await onboardWallet('jest-persist');
    mark('balances');
    await openBalances(m);
    mark('select ckusdc');
    await selectCurrency(m, 'ckusdc');
    mark('receive');
    await openReceiveAddress(m);
    await m.driver.findByTestID('ckerc20-deposit', {timeoutMs: 8_000});

    // Founder 2026-08-29: the connect view must ALSO surface the plain ICRC-1 receive route —
    // ckUSDC already on the IC transfers straight to the wallet's principal (no Ethereum txs).
    const icTxt = m.driver.readText('ic-also-section');
    assertIncludes(icTxt, 'Have an Internet Computer wallet', 'erc20 sheet shows the IC-receive section'); // copy-economy sweep: copy shortened/hyphened, the fact stays
    assertIncludes(icTxt, 'ckUSDC', 'IC-receive section names the LEDGER token (ckUSDC, not USDC-on-Ethereum)');

    // Connect + enter amount + approve → both txs mined (mock receipt 0x1) → watching.
    mark('connect');
    await m.driver.click('btn-connect-wallet', {timeoutMs: 5_000});
    await m.driver.findByTestID('ckerc20-amount', {timeoutMs: 5_000});
    await m.driver.type('ckerc20-amount', '100', {timeoutMs: 5_000});
    mark('approve');
    await m.driver.click('btn-approve', {timeoutMs: 5_000});
    expect(await m.driver.waitForText('Waiting for confirmation', {timeoutMs: 8_000})).toBe(true);

    // Sanity: the watching state IS persisted (AsyncStorage key written by the phase-transition
    // effect — one tick after the phase render, so it is WAITED for, not read racefully).
    mark('read persisted');
    let persisted: Persisted | null = null;
    const persistDeadline = budgetDeadline(5_000); // positive transition (the persist tick) — budget-scaled
    while (Date.now() < persistDeadline) {
      persisted = await readPersistedDeposit();
      if (persisted?.value.phase === 'watching') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert(persisted !== null, 'a watching deposit MUST be persisted to AsyncStorage on phase entry');
    expect(persisted!.value.phase).toBe('watching');
    expect(persisted!.value.amount).toBe('100');
    expect(Array.isArray(persisted!.value.txHashes) && persisted!.value.txHashes!.length === 2).toBe(true);

    // === PHASE 2: RELOAD — the EIP-1193 session is gone; the watching state must resume =========
    // Remount WITHOUT clearing storage (the reload/kill semantics). The mock provider is deleted
    // first: it does not survive a navigation, and the resume must work without it.
    delete g.ethereum;
    mark('remount');
    // The e2e twin navigates to a clean `/?relay=…` — a fresh URL with no screen params (the
    // location stub would otherwise cold-load the wallet back onto the pushed receive URL).
    await m.remount({url: '/'});

    // The Wallet auto-open effect scans for a persisted watching deposit + opens the sheet.
    mark('wait sheet reopen');
    await m.driver.findByTestID('ckerc20-deposit', {timeoutMs: 8_000});
    // The sheet's first frame is the ephemeral 'connect' phase; the persisted phase hydrates in a
    // mount effect — the resumed notice is the honest signal the WATCHING state is live.
    const resumed = await m.driver.waitForText('Deposit pending', {timeoutMs: 8_000});
    assert(resumed, 'the auto-opened sheet must hydrate the persisted WATCHING phase (no resume = the restart broke the watch)');

    // NO "Connect wallet" prompt — the resume skipped the connect/enter/sending phases entirely.
    expect(m.driver.isPresent('btn-connect-wallet')).toBe(false);
    expect(m.driver.isPresent('ckerc20-amount')).toBe(false);

    // The watching UI surfaces the in-flight amount + the honest "Deposit pending" notice.
    {
      const body = m.driver.bodyText();
      assertIncludes(body, '100', 'resumed watching must show the in-flight amount');
      assertIncludes(body, 'USDC', 'resumed watching must name the asset (USDC)');
      assertIncludes(body, 'Deposit pending', 'resumed watching must surface the "Deposit pending" notice');
      expect(/Connect wallet/.test(body)).toBe(false);
    }

    // The "Start a new deposit" escape exists (a stuck watching key must not wedge the sheet).
    expect(m.driver.isPresent('btn-ckerc20-new')).toBe(true);

    // The manual recheck. Every other deposit sheet has always had one; tapping it cannot reach a
    // different verdict than waiting would (it shares the cadence poll's comparison).
    expect(m.driver.isPresent('btn-ckerc20-check')).toBe(true);
    mark('recheck');
    await m.driver.click('btn-ckerc20-check', {timeoutMs: 5_000});
    await m.driver.findByTestID('ckerc20-status', {timeoutMs: 5_000});
    expect(m.driver.isPresent('btn-ckerc20-check')).toBe(true);

    // === PHASE 3: the escape clears the key + returns to 'connect' ==============================
    // The wallet session is gone, so 'connect' is the honest reset target.
    mark('escape');
    await m.driver.click('btn-ckerc20-new', {timeoutMs: 5_000});
    await m.driver.findByTestID('btn-connect-wallet', {timeoutMs: 5_000});
    expect(m.driver.isPresent('btn-ckerc20-new')).toBe(false);

    // The persisted key is GONE after the escape (clearDeposit ran). A second reload must NOT
    // re-open the sheet (it lands on the wallet main screen, not the deposit sheet).
    mark('remount 2');
    expect(await readPersistedDeposit()).toBeNull();
    await m.remount({url: '/'});
    await waitForWallet(m, {timeoutMs: 8_000});
    expect(m.driver.isPresent('ckerc20-deposit')).toBe(false);

    mark('done');
    await m.unmount();
  }, 150_000);
});
