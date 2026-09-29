/**
 * Flow 41 a11y-census — the jest twin of `e2e/tests/41-a11y-census.mjs`: EVERY interactive control
 * on every wallet surface carries BOTH an accessibility role and an accessibility label. The
 * census walks the same surface/testID matrix as the twin; under react-test-renderer the role and
 * label are read as component props (accessibilityRole / accessibilityLabel) instead of DOM
 * attributes — the same facts the RNW DOM projects.
 *
 * VCHF is funded up front: the send surface censused last sits behind the fund-first gate, and a
 * zero balance would substitute the fund panel for the very controls under census.
 */
import {it, expect} from '@jest/globals';
// FIRST: the SOL RPC override + stub helper (the app captures the URL at module load).
import {installSolAccountsHelper} from './solStub';
import {
  accountOf, faucetAccount, onboardWallet, openBalances, openPaySend, railPrincipalText,
  selectCurrency,
} from '../harness/lib';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

const SURFACES: Record<string, string[]> = {
  chrome: ['btn-settings', 'btn-theme', 'link-home', 'tab-home', 'tab-pay', 'tab-receive', 'tab-transactions'],
  home: [],
  homeTab: ['btn-home-add-funds', 'btn-home-convert', 'btn-home-withdraw', 'btn-home-more',
    'btn-home-accounts', 'btn-home-activity-all'],
  accounts: ['btn-accounts-back', 'btn-accounts-convert-CHF', 'btn-accounts-convert-USD',
    'btn-accounts-convert-EUR', 'btn-accounts-convert-BTC', 'btn-accounts-convert-ETH',
    'btn-accounts-convert-ICP', 'btn-accounts-convert-SOL', 'btn-topup',
    'btn-toggle-testnet', 'asset-demo-select', 'btn-accounts-currency-CHF',
    'btn-accounts-currency-USD', 'btn-accounts-currency-EUR', 'btn-accounts-currency-BTC',
    'btn-accounts-currency-ETH', 'btn-accounts-currency-ICP', 'btn-accounts-currency-SOL',
    'btn-accounts-add-currency'],
  receive: ['req-prefix', 'amount-input', 'memo-input', 'btn-request',
    'req-pick-demo', 'req-pick-ckbtc', 'req-pick-ckusdc', 'req-pick-cketh',
    'req-pick-vchf', 'req-pick-icp', 'req-pick-sol'],
  settings: ['btn-settings-close', 'btn-theme-auto', 'btn-theme-light', 'btn-theme-dark', 'settings-relay', 'btn-relay-apply', 'btn-backup', 'btn-reset', 'btn-settings-restore', 'btn-settings-address-book', 'privacy-policy', 'btn-trip-readiness'],
  addresses: ['btn-addresses-back', 'btn-addresses-add'],
  settingsResetConfirm: ['btn-reset-confirm', 'btn-reset-cancel'],
  settingsRestoreConfirm: ['settings-restore-seed-input', 'btn-settings-restore-confirm', 'btn-settings-restore-cancel'],
  transactions: [],
  paySend: ['btn-pay-scan', 'btn-pay-send', 'send-address-input', 'send-scan',
    'send-amount-input', 'btn-send-max', 'btn-send-confirm'],
  paySendResolved: ['send-save-name'],
};

hermeticDescribe('flow 41 — a11y-census', () => {
  it('every interactive control on every surface carries a role and an aria-label', async () => {
    installSolAccountsHelper();
    const m = await onboardWallet('e2e-a11y');
    const identity = await accountOf(m);
    const fund = await faucetAccount(identity!.publicHex, 500_000_000, {currency: 7}); // 5 VCHF
    expect(fund.ok).toBe(true);

    const allMissing: Array<{surface: string; testid: string; missing: string[]}> = [];
    let checked = 0;

    /** Census the CURRENTLY mounted surface: every expected testID present, with a role + label. */
    const census = (surface: string, extra: string[] = [], skip: string[] = []): void => {
      const expected = [...SURFACES.chrome, ...(surface === 'homeTab' ? [] : ['balance']), ...(SURFACES[surface] ?? []), ...extra]
        .filter((id) => !skip.includes(id));
      for (const id of expected) {
        if (!m.driver.isPresent(id)) {
          allMissing.push({surface, testid: id, missing: ['present']});
          continue;
        }
        const role = m.driver.propOf(id, 'accessibilityRole');
        const label = m.driver.propOf(id, 'accessibilityLabel');
        const missing: string[] = [];
        // Text inputs carry no accessibilityRole prop — their tag (INPUT/TEXTAREA) is the implicit
        // role the twin's IMPLICIT_ROLE_TAGS set allows.
        const isInput = m.driver.propOf(id, 'onChangeText') !== null || id === 'settings-relay';
        if (!isInput && (typeof role !== 'string' || role.length === 0)) missing.push('role');
        if (typeof label !== 'string' || label.length === 0) missing.push('aria-label');
        if (missing.length > 0) allMissing.push({surface, testid: id, missing});
        checked += 1;
      }
    };

    // 1. The Pay scanner surface.
    census('home');

    // 1b. Home tab — the landing surface.
    await m.driver.click('tab-home', {timeoutMs: 4000});
    await m.driver.findByTestID('home-headline-amount', {timeoutMs: 5000});
    census('homeTab');

    // 1c. The accounts route.
    await m.driver.click('btn-home-accounts', {timeoutMs: 4000});
    await m.driver.findByTestID('accounts-list', {timeoutMs: 5000});
    census('accounts');
    await m.driver.click('btn-accounts-back', {timeoutMs: 4000});

    // 2. Receive + the currency picker.
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.findByTestID('req-prefix', {timeoutMs: 4000});
    await m.driver.click('req-prefix', {timeoutMs: 4000});
    await m.driver.findByTestID('req-pick-demo', {timeoutMs: 4000});
    census('receive');
    await m.driver.pressKey('Escape');

    // 3. Settings sheet, Advanced expanded (the relay row lives there).
    await m.driver.click('btn-settings', {timeoutMs: 4000});
    await m.driver.click('btn-advanced-toggle', {timeoutMs: 4000});
    await m.driver.findByTestID('settings-relay', {timeoutMs: 4000});
    census('settings');

    // 3b. Reset confirmation dialog.
    await m.driver.click('btn-reset', {timeoutMs: 4000});
    await m.driver.findByTestID('btn-reset-confirm', {timeoutMs: 4000});
    census('settingsResetConfirm');
    await m.driver.click('btn-reset-cancel', {timeoutMs: 4000});
    await m.driver.waitGone('btn-reset-confirm', {timeoutMs: 6000});

    // 3c. Restore confirmation form.
    await m.driver.findByTestID('btn-settings-restore', {timeoutMs: 4000});
    await m.driver.click('btn-settings-restore', {timeoutMs: 4000});
    await m.driver.findByTestID('settings-restore-seed-input', {timeoutMs: 4000});
    census('settingsRestoreConfirm');
    await m.driver.click('btn-settings-restore-cancel', {timeoutMs: 4000});

    // 3d. Settings → Address book (empty book: two chrome controls).
    await m.driver.click('btn-settings-address-book', {timeoutMs: 4000});
    await m.driver.findByTestID('addresses-list', {timeoutMs: 5000});
    census('addresses');
    await m.driver.click('btn-addresses-back', {timeoutMs: 4000});

    // 4. Transactions tab (empty for a fresh wallet).
    await m.driver.click('tab-transactions', {timeoutMs: 4000});
    await m.driver.waitForText('No payments yet', {timeoutMs: 3000}).catch(() => {});
    census('transactions');

    // 5. Pay → Send to address for the funded VCHF row (run LAST — it swaps the active asset).
    await openBalances(m);
    await selectCurrency(m, 'vchf');
    await openPaySend(m);
    await m.driver.findByTestID('send-address-input', {timeoutMs: 5000});
    census('paySend');

    // 5b. With a resolved destination — the optional name field appears.
    const recipientPrincipal = await railPrincipalText('a'.repeat(64));
    await m.driver.type('send-address-input', recipientPrincipal, {timeoutMs: 4000});
    await m.driver.findByTestID('send-save-name', {timeoutMs: 6000});
    census('paySendResolved');

    // Final verdict: one throw naming every miss.
    expect(allMissing).toEqual([]);
    expect(checked > 0).toBe(true);

    await m.unmount();
  }, 240_000);
});
