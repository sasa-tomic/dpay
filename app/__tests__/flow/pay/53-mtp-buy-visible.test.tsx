/**
 * Flow 53: Add funds is ONE tap into the deposit surface; the buy is discovered INSIDE it.
 *
 * THE RESTORED CONTRACT (2026-10-15, the founder directive: no new chooser UI, no extra steps):
 * the deposit-vs-buy choice (AddFundsMenu) is DELETED and the Add-funds press keeps the
 * pre-wave single path — the deposit surface of the account the headline names, directly. The
 * buy lives where the TrustWallet deep link always lived: a peer row INSIDE that surface, the
 * DepositSheet onBuy slot / the FundingRoutes provider row, per-asset gated by the same
 * funding.ts rule. So:
 *
 *   • Add funds on Home lands the deposit surface DIRECTLY — one tap, and the chooser's
 *     testIDs are gone from the app entirely;
 *   • an eligible asset's deposit surface (ZCHF on Ethereum) shows the Mt Pelerin buy row
 *     beside the address;
 *   • an ineligible asset's surface (SOL) shows no such row.
 *
 * The DepositSheet row's own contract (btn-deposit-mtp-buy, present iff the caller bound
 * onBuy) is pinned at unit tier in DepositSheet.test.tsx; the sheet's sign/open mechanics are
 * flow 51's and are not re-derived here.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {evmEnv} from '../evm/env';

hermeticDescribe('flow 53: Add funds opens the deposit surface directly; the buy row lives inside it (per asset)', () => {
  it('one tap from Home to the deposit surface (no menu); ZCHF-on-Ethereum shows the buy row; SOL shows none', async () => {
    const {onboardWallet, waitForWallet, selectEvmAsset, openBalances} = await evmEnv();
    const m = await onboardWallet('jest-mtp-53');

    await waitForWallet(m);

    // ── Add funds is ONE tap: the deposit surface of the home rail, no choice in between. ──
    await m.driver.click('tab-home', {timeoutMs: 5000});
    await m.driver.click('btn-home-add-funds', {timeoutMs: 5000});
    await m.driver.findByTestID('receive-mode-toggle', {timeoutMs: 5000});
    expect(m.driver.isPresent('home-add-funds-menu')).toBe(false);
    expect(m.driver.isPresent('btn-add-funds-buy')).toBe(false);
    expect(m.driver.isPresent('mtp-buy-sheet')).toBe(false);

    // ── The buy is INSIDE the surface: an eligible asset's deposit view carries the row. ──
    await selectEvmAsset(m, 'evm-zchf-ethereum');
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('funding-provider-mtp', {timeoutMs: 5000});

    // ── An ineligible asset's surface carries none: the per-asset gate fails closed. ──
    // (The native SOL rail, NOT an SPL token: evmEnv configures no Solana RPC, so SPL rows are
    // fail-closed out of the picker — the SOL currency card is the reachable surface here.)
    await openBalances(m, {timeoutMs: 5000});
    await m.driver.click('btn-accounts-currency-SOL', {timeoutMs: 5000});
    await m.driver.findByTestID('home-headline-label', {timeoutMs: 5000});
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('funding-provider-coinbase', {timeoutMs: 5000});
    expect(m.driver.isPresent('funding-provider-mtp')).toBe(false);

    await m.unmount();
  }, 150_000);
});
