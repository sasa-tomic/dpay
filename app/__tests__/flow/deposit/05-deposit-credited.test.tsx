/**
 * Flow 05 deposit-credited — the jest twin of `e2e/tests/05-deposit-credited.mjs`.
 *
 * The money-in proof: a ckBTC (currency 1) faucet credit at THIS wallet's principal (the
 * documented deposit-simulation seam for the Bitcoin leg) is detected by the sheet's OWN honest
 * balance-delta mechanism — a captured railBalanceOf baseline + a strictly-higher recheck →
 * "Deposited ✓" + the minted delta. Then the credited BTC stays VISIBLE in the wallet: the BTC
 * asset row re-renders the minted amount after the sheet closes.
 */
import {describe, it, expect} from '@jest/globals';
import {
  accountOf, assert, assertIncludes, faucetAccount, getBalance, onboardWallet,
  openBalances, openReceiveAddress, selectCurrency,
} from '../harness/lib';

const DEPOSIT_CURRENCY = 1; // ckBTC — the Balances row selected for the deposit flow
const SEED_SATS = 50_000;   // 0.0005 BTC

describe('flow 05 — deposit credited: balance-delta detection + the credit stays visible', () => {
  it('faucet-at-principal → "Deposited ✓" + minted delta + a visible BTC row', async () => {
    const m = await onboardWallet('jest-deposit');
    const identity = await accountOf(m);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64,
      `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);

    // The BTC row is ALWAYS visible in Balances (renders at every balance, including zero).
    await openBalances(m);
    const zeroTxt = m.driver.readText('accounts-currency-BTC');
    assertIncludes(zeroTxt, '0 BTC', 'the BTC card should show the zero balance before any top-up');
    assertIncludes(zeroTxt, 'BTC', 'the BTC card should be clearly labeled "BTC"');

    // Pre-credit: the ckBTC (currency 1) rail balance for this account is zero (only DEMO_USD
    // funded). getBalance THROWS when the currency has no entry — a missing zero is a bug.
    const before = await getBalance(accountHex!, DEPOSIT_CURRENCY);
    expect(before).toBe('0');

    // Select ckBTC → Receive → "My address". Count the sheet's OWN ledger reads first (installed
    // before it mounts): every railBalanceOf is a signed icrc1_balance_of posted to
    // /api/v2/canister/<ledger>/query, so the count is a direct, deterministic witness of "the
    // sheet has polled the ledger N times" — what the baseline-capture step needs and what a
    // wall-clock sleep could only guess at. (Chained ON TOP of the harness fetch rewrite.)
    const realFetch = globalThis.fetch;
    const queryUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const res = await realFetch.call(globalThis, input, init);
      if (/\/api\/v2\/canister\/[^/]+\/query$/.test(url)) queryUrls.push(url);
      return res;
    }) as typeof fetch;

    await selectCurrency(m, 'ckbtc');
    await openReceiveAddress(m);
    await m.driver.findByTestID('deposit-address', {timeoutMs: 10_000});

    // The deposit address is derived by the minter query at THIS user's principal — the gateway's
    // documented derivation `bc1qdpay` + hex(principal[:8]), tying the address to the principal
    // the faucet credits.
    const address = m.driver.readText('deposit-address');
    expect(address).toMatch(/^bc1qdpay[0-9a-f]{16}$/);

    // Let the sheet's balance recheck capture its WATCHING BASELINE before any funds move: two
    // completed /query round trips mean the first one's reply has had a full poll cycle to be
    // decoded and stored (POLL.deposit is 25ms here). Waited for, never slept through.
    await m.driver.waitForFunction(() => queryUrls.length >= 2,
      {timeoutMs: 10_000, label: 'the deposit sheet completed two pre-fund ledger balance reads'});
    assertIncludes(m.driver.bodyText(), 'Watching for your deposit',
      'the sheet should be in the honest watching state before funding (baseline captured)');

    // Fund the deposit: credit fake-IC ckBTC at THIS wallet's principal via the faucet.
    const funded = await faucetAccount(accountHex!, SEED_SATS, {currency: DEPOSIT_CURRENCY});
    assert(funded.ok, `faucet credit should succeed, got status ${funded.status}: ${JSON.stringify(funded.body)}`);

    // Click the manual "Check now" — the app's own refreshNow recheck (the same function the
    // auto-poll runs). The auto-poll can legitimately win the race; if the button already
    // unmounted because the sheet flipped to "Deposited ✓", that IS the credited state.
    try {
      await m.driver.click('btn-deposit-check', {timeoutMs: 3_000});
    } catch (e) {
      const already = await m.driver.waitForText('Deposited', {timeoutMs: 2_000});
      if (!already) throw e;
    }

    // The sheet flips to "Deposited ✓" + the minted delta ("0.0005 BTC minted").
    const credited = await m.driver.waitForText('Deposited', {timeoutMs: 8_000});
    const body = m.driver.bodyText();
    assert(credited, `deposit sheet should show "Deposited ✓" after the recheck. body excerpt:\n${body.slice(0, 600)}`);
    assertIncludes(body, '0.0005 BTC', 'sheet should show the minted BTC delta');

    // The credited path proven directly on the rail: the currency-1 balance grew by the funded
    // amount. (The ∂ wallet header is currency 0 — a separate asset, by design.)
    const after = await getBalance(accountHex!, DEPOSIT_CURRENCY);
    expect(after).toBe(String(SEED_SATS));

    // SEAMLESSNESS: flip the toggle back to "Request payment" and prove the credited ckBTC stays
    // VISIBLE — a top-up whose balance vanishes when the deposit closes is the bug this guards.
    await m.driver.click('btn-receive-request', {timeoutMs: 5_000});
    await m.driver.waitGone('deposit-address', {timeoutMs: 4_000});
    await openBalances(m);
    await m.driver.findByTestID('accounts-currency-BTC', {timeoutMs: 8_000});
    const assetTxt = m.driver.readText('accounts-currency-BTC');
    assertIncludes(assetTxt, '0.0005 BTC', 'the wallet\'s visible BTC card should show the minted BTC after the sheet closes');
    assertIncludes(assetTxt, 'BTC', 'the BTC card should be clearly labeled "BTC" (the deposited asset name, H1)');

    await m.unmount();
  }, 90_000);
});
