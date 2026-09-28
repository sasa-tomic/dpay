/**
 * Flow 147 rail-unreadable — the jest twin of `e2e/tests/147-rail-unreadable.mjs`, driven through
 * the app's OWN `__DPAY_TEST_SOLANA_RPC_STUB` seam (solana/rpc.ts reads it per call, so the stub
 * swaps modes live) over the three cause classes the row distinguishes:
 *
 *   answer   → a balance, and NO outage banner;
 *   refused  → the endpoint ANSWERED and said no (HTTP 429, the branded error shape) — the row
 *              names the network, promises the automatic retry, and renders exactly ONE banner
 *              for the one network even though three Solana accounts are unreadable at once;
 *   transport→ while provably ONLINE the copy blames dpay's relay (never the phone), states the
 *              money fact, names what still works, and gives the Settings escape; OFFLINE it
 *              names no cause and offers no escape.
 *
 * The connectivity override (`__DPAY_TEST_SOLANA_CONNECTIVITY`) is the app's own oracle seam —
 * the same one solana-seam.test.ts drives hermetically.
 */
import {describe, it, expect} from '@jest/globals';
// FIRST: sets the SOL RPC override the app captures at module load, then the App graph imports.
import {installSolAccountsHelper} from './solStub';
import {onboardWallet, openBalances} from '../harness/lib';
import {freshContext} from '../onboard/helpers';

type G = {
  __DPAY_TEST_SOLANA_RPC_STUB?: Record<string, (p: unknown[]) => unknown>;
  __DPAY_TEST_SOLANA_RPC_URL?: string;
  __DPAY_TEST_SOLANA_CONNECTIVITY?: 'offline' | 'online';
  __DPAY_SOL_ACCOUNTS?: (p: unknown[], o: unknown) => unknown;
};
const g = globalThis as unknown as G;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('flow 147 — rail-unreadable', () => {
  it('answer → no banner; 429 → one explaining banner; transport+online → the relay is blamed with an escape; offline → no cause, no escape', async () => {
    await freshContext();
    installSolAccountsHelper();
    // The connectivity override set to 'online' mirrors the BROWSER default (navigator.onLine),
    // which the twin's stages rely on without setting it.
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'online';
    const m = await onboardWallet('e2e-rail-unreadable');

    // One mutable state walks the endpoint through answering and the two failure SHAPES. The
    // 'refused' throw is BRANDED exactly as SolanaEndpointRefused brands itself — the brand field
    // is the only thing the classifier looks at. 'transport' throws a plain fetch-shaped error.
    const st = {mode: 'answer'};
    const fail = (): never => {
      if (st.mode === 'refused') {
        // Branded EXACTLY as SolanaEndpointRefused brands itself (solana/errors.ts) — the brand
        // field is the only thing the classifier looks at, never instanceof.
        const e = new Error('solana rpc rate limit (HTTP 429): max usage reached') as Error & {dpayEndpointRefused?: boolean; status?: number};
        e.dpayEndpointRefused = true;
        e.status = 429;
        throw e;
      }
      // 'transport': a plain fetch-shaped error, no opinion about who is down.
      throw new Error('fetch failed');
    };
    g.__DPAY_TEST_SOLANA_RPC_STUB = {
      getGenesisHash: () => '5eykt4UsFv8PJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      // One request for every rail account — one failure flips every rail at once (an exhausted key).
      getMultipleAccounts: (p) => (st.mode === 'answer' && g.__DPAY_SOL_ACCOUNTS ? g.__DPAY_SOL_ACCOUNTS(p, {lamports: 2000000000, token: {amount: '0', decimals: 6}}) : fail()),
      getBalance: () => (st.mode === 'answer' ? {value: 2000000000} : fail()),
      getTokenAccountBalance: () => (st.mode === 'answer' ? {value: {amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0'}} : fail()),
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
    };

    // --- the rail answers: a balance, and NO warning -------------------------------------------
    await openBalances(m);
    await m.driver.waitForFunction(() => m.driver.isReadTextSafe('accounts-currency-SOL', '2 SOL'), {timeoutMs: 12_000, label: 'the SOL balance renders'});
    expect(m.driver.isPresent('rail-unreadable-solana')).toBe(false);

    // --- the endpoint answers 429: the row explains itself (REFUSED) ----------------------------
    st.mode = 'refused';
    await m.driver.waitForFunction(() => m.driver.isPresent('rail-unreadable-solana'), {timeoutMs: 12_000, label: 'the outage banner renders'});
    const line = m.driver.readText('rail-unreadable-solana');
    expect(line).toContain('Solana');
    expect(line).toContain('Nothing moved');
    expect(line).toContain('refused the request');
    expect(line).toContain('keeps retrying');
    // One network outage renders exactly ONE banner (the USD row hosts Solana USDC).
    expect(m.driver.isPresent('accounts-currency-USD')).toBe(true);
    expect(m.driver.isPresent('rail-unreadable-usd')).toBe(false);

    // Scoped to the failed rail — the IC row claims nothing about it.
    expect(m.driver.readText('accounts-currency-CHF').includes('unreadable')).toBe(false);

    // --- nothing answers while the phone IS online (UNREACHABLE) ---------------------------------
    st.mode = 'transport';
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'online';
    // The banner node stays mounted across the copy swap — wait on its TEXT, not its presence.
    await m.driver.waitForFunction(
      () => m.driver.isReadTextSafe('rail-unreadable-solana', 'unreachable while you are online'),
      {timeoutMs: 12_000, label: 'the unreachable copy swaps in'},
    );
    const unreachableLine = m.driver.readText('rail-unreadable-solana');
    expect(unreachableLine).toContain('unreachable while you are online');
    expect(unreachableLine).toContain('dpay’s relay can’t reach');
    expect(unreachableLine).toContain('Your money is untouched');
    expect(unreachableLine).toContain('Internet Computer payments still work');
    expect(unreachableLine).toContain('still sign payments offline');
    expect(unreachableLine.includes('Internet Computer balances')).toBe(false);
    expect(unreachableLine.includes('offline QR payments are unaffected')).toBe(false);
    expect(unreachableLine).toContain('Settings ▸ Advanced');
    expect(m.driver.isPresent('rail-unreadable-usd')).toBe(false);

    // The escape is ACTIONABLE: tapping the note opens Settings with the Advanced section expanded.
    await m.driver.click('rail-unreadable-solana', {timeoutMs: 4000});
    await m.driver.findByTestID('btn-settings-close', {timeoutMs: 8000});
    await m.driver.findByTestID('settings-sol-rpc', {timeoutMs: 8000});
    await m.driver.click('btn-settings-close', {timeoutMs: 4000});

    // --- nothing answers anywhere, the IC boundary probe included (OFFLINE) ----------------------
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'offline';
    await m.driver.waitForFunction(
      () => m.driver.isReadTextSafe('rail-unreadable-solana', 'You seem offline'),
      {timeoutMs: 12_000, label: 'the offline copy swaps in'},
    );
    const offlineLine = m.driver.readText('rail-unreadable-solana');
    expect(offlineLine).toContain('You seem offline');
    expect(offlineLine).toContain('Nothing moved');
    expect(offlineLine).toContain('update when you reconnect');
    expect(offlineLine).toContain('QR payments still work offline');
    expect(offlineLine.includes('Settings')).toBe(false);

    await m.unmount();
    g.__DPAY_TEST_SOLANA_RPC_STUB = undefined;
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = undefined;
    void sleep;
  }, 150_000);
});
