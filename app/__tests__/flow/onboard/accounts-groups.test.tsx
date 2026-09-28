/**
 * Flows 203 + 204 — the accounts currency groups and the currency→rail switch — the jest twins of
 * `e2e/tests/203-accounts-currency-groups.mjs` and `204-currency-rail-switch.mjs`.
 *
 * 203: with home=USD the accounts list carries every wallet currency, the Main badge sits on the
 *      USD row alone, each row names its rails in the subtitle, and the practice row stays LAST
 *      under its divider.
 * 204: funding ONLY the IC rail (250 ckUSDC) and tapping the USD row lands main AND the working
 *      rail on the funded ckUSDC rail; the receive surface mounts in full; and no per-rail
 *      "Switch to…" affordance exists anywhere — rails are dpay's routing decision.
 *
 * GAP vs the browser twin (filed for the integrator): 203's row-ORDER assertion enumerates DOM
 * order (querySelectorAll), which has no react-test-renderer equivalent; membership, Main
 * exclusivity, and the practice divider are pinned instead.
 */
import {describe, it, expect} from '@jest/globals';
// FIRST: the SOL RPC override + stub helper (the app captures the URL at module load).
import {installSolAccountsHelper} from '../settings/solStub';
import {
  accountOf, assertEq, assertIncludes, faucetAccount, onboardWallet, openBalances,
  waitForWallet,
} from '../harness/lib';
import {freshContext} from './helpers';

describe('flow 203 — accounts-currency-groups', () => {
  it('every wallet currency listed once; Main on USD alone; rail subtitles; the practice row last', async () => {
    await freshContext();
    installSolAccountsHelper();
    const m = await onboardWallet('e2e-currency-groups');
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-currency-USD', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});

    await openBalances(m);

    // 1. The rows exist (the fixed wallet-currency ORDER is a DOM fact — browser-only).
    for (const code of ['CHF', 'USD', 'EUR', 'BTC', 'ETH', 'ICP', 'SOL']) {
      expect(m.driver.isPresent(`accounts-currency-${code}`)).toBe(true);
    }

    // 2. The Main badge sits on the HOME currency row (USD) alone.
    expect(m.driver.isPresent('currency-USD-main')).toBe(true);
    for (const code of ['CHF', 'EUR', 'BTC', 'ETH', 'ICP', 'SOL']) {
      expect(m.driver.isPresent(`currency-${code}-main`)).toBe(false);
    }
    assertIncludes(m.driver.readText('accounts-currency-USD'), 'Main', 'the USD row carries the Main mark inline');

    // 3. A row is a LABEL+FIGURE line: its subtitle names the rails.
    const usdRow = m.driver.readText('accounts-currency-USD');
    assertIncludes(usdRow, 'ckUSDC · Internet Computer', 'the USD row names its IC rail');
    assertIncludes(usdRow, 'USDC · Solana', 'the USD row names its Solana rail');

    // 4. The practice row renders LAST, under its divider.
    expect(m.driver.isPresent('accounts-practice-note')).toBe(true);
    expect(m.driver.isPresent('asset-demo')).toBe(true);

    await m.unmount();
  }, 150_000);
});

describe('flow 204 — currency-rail-switch', () => {
  it('funding only the IC rail, the USD row tap lands main + rail on the funded ckUSDC; receive mounts in full; no manual rail switch', async () => {
    await freshContext();
    installSolAccountsHelper();
    const m = await onboardWallet('e2e-rail-switch');
    const account = await accountOf(m);
    const fund = await faucetAccount(account!.publicHex, 25000000, {currency: 2}); // 250 ckUSDC (IC only)
    expect(fund.ok).toBe(true);
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-currency-USD', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});
    await waitForWallet(m, {timeoutMs: 8000});

    // 1. The USD row tap: main AND the working rail land on the FUNDED ckUSDC rail.
    await openBalances(m);
    await m.driver.click('btn-accounts-currency-USD', {timeoutMs: 6000});
    await m.driver.findByTestID('home-headline-label', {timeoutMs: 6000});
    assertEq(m.driver.readText('home-headline-label'), 'Balance USD', 'the row tap set USD main and landed Home');

    // The direct-mount path: the receive form mounts in full on the funded rail.
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.findByTestID('req-prefix', {timeoutMs: 8000});
    assertEq(m.driver.readText('active-asset-label'), 'Balance USD', 'receive on the funded rail keeps the main-currency chip');
    assertIncludes(m.driver.bodyText(), 'Request payment', 'the receive form renders (request + address modes present)');
    await m.driver.click('tab-home', {timeoutMs: 5000});

    // 2. No manual switch affordance may exist anywhere.
    await openBalances(m);
    expect(m.driver.isPresent('btn-accounts-rail-usd')).toBe(false);

    await m.unmount();
  }, 150_000);
});
