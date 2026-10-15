/**
 * Flow 53: the Mt Pelerin buy entry is VISIBLE where the user is (the 2026-10-15 fix).
 *
 * THE DEFECT THIS FLOWS AGAINST: the buy sheet, its FundingRoutes row and the DepositSheet
 * entry had all landed, yet the buy choice rendered nowhere a user actually passes, because
 * the Add-funds gate read the home HEADLINE rail (`mtpBuyTokenOf(homeAsset)` in Wallet) and
 * CURRENCY_RAILS prefers an IC row for every home currency (CHF -> VCHF, USD -> ckUSDC): so
 * no headline ever qualified and AddFundsMenu never mounted.
 *
 * THE FIXED CONTRACT pinned here: the Add-funds gate is CATALOG-level (`mtpBuyOfferOf`,
 * funding.ts: the catalog holds a Partner EVM row with a delivery chain whenever the relay
 * serves the EVM mainnet sections, which it always does), so
 *
 *   • Add funds on Home opens the deposit-vs-buy choice for ANY headline (the first arm runs
 *     on the default DEMO headline; the deposit-trip arm runs on a SOL headline, the exact
 *     shape a headline-level gate got wrong);
 *   • the menu's Buy row opens the ONE root-mounted MtpBuySheet, which reviews the validation
 *     signature and hands the golden prefilled widget URL to the open seam (ZCHF, the offer
 *     default: bsc=CHF, bdc=ZCHF, net=dnet=mainnet);
 *   • the menu's Deposit row keeps the direct deposit trip, byte-unchanged.
 *
 * Acceptance arm for the Wallet-side gate change (`onBuy` / `addFundsOpen` keyed on
 * `mtpBuyOfferOf(assets)` instead of `mtpBuyTokenOf(homeAsset)`); written alongside the
 * funding.ts helper + AddFundsMenu unit pins in the same wave. The sign/open mechanics are
 * flow 51's (the FundingRoutes arm) and are not re-derived here beyond one golden pass.
 */
import {it, expect, jest} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {evmEnv} from '../evm/env';
import {deriveEvmKeypair} from '../../../evm/identity';
import {deriveValidationCode, validationMessage} from '../../../ramp/mtpelerin';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

hermeticDescribe('flow 53: the buy choice is visible on Home (catalog-level gate; deposit trip intact)', () => {
  it('Add funds opens the choice for any headline; Buy signs + hands the golden ZCHF URL; Deposit keeps the old trip (SOL headline)', async () => {
    const {accountOf, onboardWallet, waitForWallet, openBalances} = await evmEnv();
    const m = await onboardWallet('jest-mtp-53');
    const id = await accountOf(m);
    expect(id?.secretHex ?? '').toHaveLength(64);
    const device = deriveEvmKeypair(id!.secretHex);
    const code = deriveValidationCode(device.address);

    await waitForWallet(m);

    // ── Add funds opens the CHOICE menu (the defect: it never appeared at all). ──
    await m.driver.click('btn-home-add-funds', {timeoutMs: 5000});
    await m.driver.findByTestID('home-add-funds-menu', {timeoutMs: 5000});
    expect(m.driver.isPresent('btn-add-funds-deposit')).toBe(true);
    expect(m.driver.isPresent('btn-add-funds-buy')).toBe(true);

    // ── Buy opens the ONE root-mounted sheet and signs the per-address validation message. ──
    await m.driver.click('btn-add-funds-buy', {timeoutMs: 5000});
    await m.driver.findByTestID('mtp-buy-sheet', {timeoutMs: 5000});
    await m.driver.waitForText(validationMessage(code), {timeoutMs: 5000});
    const openSeam = jest.fn<(uri: string) => Promise<void>>();
    g.__DPAY_TEST_MTP_OPEN = openSeam;
    await m.driver.click('btn-mtp-sign', {timeoutMs: 5000});
    await m.driver.waitForText('Mt Pelerin opened in your browser', {timeoutMs: 5000});
    expect(openSeam).toHaveBeenCalledTimes(1);
    const url = openSeam.mock.calls[0][0] as string;
    // The offer default is ZCHF: 1:1 CHF on their published pricing, delivered on Ethereum.
    expect(url.startsWith('https://widget.mtpelerin.com/?')).toBe(true);
    expect(url).toContain('net=mainnet&dnet=mainnet&bsc=CHF&bdc=ZCHF&');
    expect(url).toContain(`code=${code}`);
    await m.driver.click('btn-mtp-close', {timeoutMs: 5000});
    expect(m.driver.isPresent('mtp-buy-sheet')).toBe(false);
    delete g.__DPAY_TEST_MTP_OPEN;

    // ── The gate is the CATALOG, not the headline: a SOL headline gets the same choice. ──
    await openBalances(m, {timeoutMs: 5000});
    await m.driver.click('btn-accounts-currency-SOL', {timeoutMs: 5000});
    await m.driver.findByTestID('home-headline-label', {timeoutMs: 5000});

    // ── Deposit keeps the direct deposit trip: the menu's first row, byte-unchanged. ──
    await m.driver.click('tab-home', {timeoutMs: 5000});
    await m.driver.click('btn-home-add-funds', {timeoutMs: 5000});
    await m.driver.findByTestID('home-add-funds-menu', {timeoutMs: 5000});
    await m.driver.click('btn-add-funds-deposit', {timeoutMs: 5000});
    await m.driver.findByTestID('receive-mode-toggle', {timeoutMs: 5000});
    expect(m.driver.isPresent('mtp-buy-sheet')).toBe(false);

    await m.unmount();
  }, 150_000);
});
