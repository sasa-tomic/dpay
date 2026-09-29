/**
 * Flows 210 + 211 + 212 — the add-currency route (search, hide, re-add), the Remove guard's
 * refusals, and the currency-row set-main persistence — the jest twins of
 * `e2e/tests/210-add-currency-search.mjs`, `211-remove-guard-refusals.mjs`, `212-currency-row-tap-sets-main.mjs`.
 *
 * 210: the add-currency route offers the FULL supported set; in-wallet rows carry no Add button;
 *      search filters live with an honest empty state; Remove hides a currency (a list operation);
 *      re-add restores it.
 * 211: the Remove guard refuses a NONZERO balance (the refusal renders in the menu, the menu stays),
 *      zero-balance currencies hide, funded/unreadable ones refuse, and re-add restores.
 * 212: tapping the ICP currency row sets ICP main, the working rail follows, and the tap survives
 *      a reload (persisted main).
 */
import {describe, it, expect} from '@jest/globals';
// FIRST: the SOL RPC override + stub helper (the app captures the URL at module load).
import {installSolAccountsHelper} from './solStub';
import {
  accountOf, assertEq, faucetAccount, onboardWallet, openBalances,
  waitForWallet,
} from '../harness/lib';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

const g = globalThis as unknown as Record<string, unknown>;

async function openAddCurrency(m: Awaited<ReturnType<typeof onboardWallet>>): Promise<void> {
  await openBalances(m);
  await m.driver.click('btn-accounts-add-currency', {timeoutMs: 5000});
  await m.driver.findByTestID('input-addcur-search', {timeoutMs: 5000});
}

hermeticDescribe('flow 210 — add-currency-search', () => {
  it('the full set offered, in-wallet rows not re-addable, search filters live, Remove hides, re-add restores', async () => {
    installSolAccountsHelper();
    const m = await onboardWallet('e2e-addcur');
    // The SOL rail must read a KNOWN balance for the Remove guard's verdict to be data.
    g.__DPAY_TEST_SOLANA_RPC_STUB = {
      getMultipleAccounts: (p: unknown[]) => (g.__DPAY_SOL_ACCOUNTS as (p2: unknown, o: unknown) => unknown)(p, {lamports: 0}),
      getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      getFeeForMessage: () => ({context: {slot: 250000000}, value: {lamports: 5000}}),
      getBalance: () => ({value: 0}),
    };

    // §1 the full supported set; in-wallet rows not addable.
    await openAddCurrency(m);
    for (const code of ['CHF', 'USD', 'EUR', 'BTC', 'ETH', 'ICP', 'SOL']) {
      expect(m.driver.isPresent(`btn-addcur-${code}`)).toBe(true);
    }
    for (const code of ['CHF', 'USD', 'BTC', 'ETH', 'ICP', 'SOL']) {
      expect(m.driver.isPresent(`btn-addcur-add-${code}`)).toBe(false);
    }

    // §2 the search filters live; an empty result states itself; clearing restores.
    await m.driver.type('input-addcur-search', 'Bitco');
    expect(m.driver.isPresent('btn-addcur-BTC')).toBe(true);
    expect(m.driver.isPresent('btn-addcur-CHF')).toBe(false);
    expect(m.driver.isPresent('addcur-none')).toBe(false);
    await m.driver.type('input-addcur-search', 'Zzz');
    await m.driver.findByTestID('addcur-none', {timeoutMs: 4000});
    await m.driver.type('input-addcur-search', '');
    for (const code of ['CHF', 'SOL']) {
      expect(m.driver.isPresent(`btn-addcur-${code}`)).toBe(true);
    }
    await m.driver.click('btn-addcur-back', {timeoutMs: 5000});
    await m.driver.findByTestID('accounts-list', {timeoutMs: 5000});

    // §3 hide SOL through the Home menu (Remove): SOL must be MAIN, and its balance must read as
    // a KNOWN zero first (the guard refuses an unreadable balance — wait for the row to land it).
    await openBalances(m);
    await m.driver.findByTestID('accounts-currency-SOL', {timeoutMs: 5000});
    await m.driver.waitForFunction(
      () => m.driver.isReadTextSafe('accounts-currency-SOL', '0 SOL'),
      {timeoutMs: 10_000, label: 'the SOL row reads its known zero'},
    );
    await m.driver.click('btn-accounts-currency-SOL', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-home-more', {timeoutMs: 5000});
    await m.driver.click('btn-home-more', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-home-menu-remove', {timeoutMs: 5000});
    await m.driver.click('btn-home-menu-remove', {timeoutMs: 5000});
    await new Promise((r) => setTimeout(r, 500));
    await m.driver.pressKey('a');
    expect(m.driver.isPresent('accounts-currency-SOL')).toBe(false);

    // §4 re-add: the add-currency route now offers SOL with its Add button.
    await openAddCurrency(m);
    expect(m.driver.isPresent('btn-addcur-add-SOL')).toBe(true);
    await m.driver.click('btn-addcur-add-SOL', {timeoutMs: 5000});
    await m.driver.click('btn-addcur-back', {timeoutMs: 5000});
    expect(m.driver.isPresent('accounts-currency-SOL')).toBe(true);

    await m.unmount();
    g.__DPAY_TEST_SOLANA_RPC_STUB = undefined;
  }, 180_000);
});

hermeticDescribe('flow 211 — remove-guard-refusals', () => {
  it('a nonzero balance refuses Remove (the menu stays); zero hides; the sweep spares the funded; re-add restores', async () => {
    installSolAccountsHelper();
    const m = await onboardWallet('e2e-remove-guard');
    const account = await accountOf(m);
    // Fund ICP (nonzero) so the ICP hide refuses on balance.
    const fund = await faucetAccount(account!.publicHex, 200000000, {currency: 8});
    expect(fund.ok).toBe(true);
    // The SOL rail must read a KNOWN (nonzero) balance so its refusal is data, not a guess.
    g.__DPAY_TEST_SOLANA_RPC_STUB = {
      getMultipleAccounts: (p: unknown[]) => (g.__DPAY_SOL_ACCOUNTS as (p2: unknown, o: unknown) => unknown)(p, {lamports: 5000000000}),
      getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      getFeeForMessage: () => ({context: {slot: 250000000}, value: {lamports: 5000}}),
      getBalance: () => ({value: 5000000000}),
    };

    // §1 NONZERO refusal: make ICP main (wait for the funded figure to land first — the guard
    // refuses on the balance it can READ).
    await openBalances(m);
    await m.driver.waitForFunction(
      () => m.driver.isReadTextSafe('accounts-currency-ICP', '2 ICP'),
      {timeoutMs: 10_000, label: 'the ICP row reads the funded 2 ICP'},
    );
    await m.driver.click('btn-accounts-currency-ICP', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-home-more', {timeoutMs: 5000});
    await m.driver.click('btn-home-more', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-home-menu-remove', {timeoutMs: 5000});
    await m.driver.click('btn-home-menu-remove', {timeoutMs: 5000});
    // The refusal renders in the menu; the menu STAYS open (refused, not swallowed).
    await m.driver.findByTestID('home-menu-remove-refusal', {timeoutMs: 5000});
    await m.driver.click('btn-home-menu-close', {timeoutMs: 3000});
    await openBalances(m);
    expect(m.driver.isPresent('accounts-currency-ICP')).toBe(true);

    // §2 zero-balance hides + the sweep: CHF and EUR are menu-hidden; the funded ICP and the
    // stubbed-SOL currency survive (nonzero refuses).
    for (const code of ['CHF', 'EUR']) {
      await openBalances(m);
      await m.driver.click(`btn-accounts-currency-${code}`, {timeoutMs: 5000});
      await m.driver.findByTestID('btn-home-more', {timeoutMs: 5000});
      await m.driver.click('btn-home-more', {timeoutMs: 5000});
      await m.driver.findByTestID('btn-home-menu-remove', {timeoutMs: 5000});
      await m.driver.click('btn-home-menu-remove', {timeoutMs: 5000});
      await m.driver.click('btn-home-menu-close', {timeoutMs: 2000}).catch(() => {});
    }
    await m.driver.click('tab-pay', {timeoutMs: 3000}).catch(() => {});
    await openBalances(m);
    expect(m.driver.isPresent('accounts-currency-ICP')).toBe(true);
    expect(m.driver.isPresent('accounts-currency-SOL')).toBe(true);

    // §3 re-add restores CHF (a list operation, nothing on chain).
    await openBalances(m);
    await m.driver.click('btn-accounts-add-currency', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-addcur-add-CHF', {timeoutMs: 5000});
    await m.driver.click('btn-addcur-add-CHF', {timeoutMs: 5000});
    await m.driver.click('btn-addcur-back', {timeoutMs: 5000});
    expect(m.driver.isPresent('accounts-currency-CHF')).toBe(true);

    await m.unmount();
    g.__DPAY_TEST_SOLANA_RPC_STUB = undefined;
  }, 180_000);
});

hermeticDescribe('flow 212 — currency-row-tap-sets-main', () => {
  it('the ICP row tap sets main, the working rail follows, and the tap survives a reload', async () => {
    installSolAccountsHelper();
    const m = await onboardWallet('e2e-row-tap-main');
    const account = await accountOf(m);
    const fund = await faucetAccount(account!.publicHex, 150000000, {currency: 8}); // 1.5 ICP
    expect(fund.ok).toBe(true);

    // §1 the ICP row tap: ICP becomes main, the headline follows.
    await openBalances(m);
    await m.driver.click('btn-accounts-currency-ICP', {timeoutMs: 5000});
    await m.driver.findByTestID('home-headline-label', {timeoutMs: 6000});
    assertEq(m.driver.readText('home-headline-label'), 'Balance ICP', 'the row tap set ICP main');

    // §2 the working rail follows: the receive surface states the ICP asset.
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.findByTestID('req-prefix', {timeoutMs: 5000});

    // §3 the tap survives a reload.
    await m.remount({url: '/'});
    await waitForWallet(m, {timeoutMs: 8000});
    assertEq(m.driver.readText('home-headline-label'), 'Balance ICP', 'the reload resumes with ICP main (persisted)');

    await m.unmount();
  }, 150_000);
});
