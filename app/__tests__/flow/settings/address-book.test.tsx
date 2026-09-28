/**
 * Flow 178 address-book — the jest twin of `e2e/tests/178-address-book.mjs`. (addressBook.test.ts
 * pins the store; this ports the route walk.)
 *
 * The Settings door closes the sheet and opens the route; the EMPTY book says so and names its way
 * out (send destinations are kept for you); the add form refuses a garbage destination with the
 * Save gate held shut; a valid principal on the VCHF rail saves under its rail, named, renames in
 * place; the send form's manage link opens the same route and Back returns to the form; Remove
 * empties the book and says so again.
 */
import {describe, it, expect} from '@jest/globals';
import {
  accountOf, assertIncludes, faucetAccount, onboardWallet, openBalances,
  openPaySend, railPrincipalText, selectCurrency,
} from '../harness/lib';
import {freshContext} from '../onboard/helpers';

const PRINCIPAL_SEED = 'b'.repeat(64);

describe('flow 178 — address-book', () => {
  it('the door, the empty book, refuse-first add, save/rename, the send-form manage link, remove', async () => {
    await freshContext();
    const m = await onboardWallet('e2e-book');
    // Cold-start landing assertions ride the reload pattern flow 133 uses.
    await m.remount({url: '/'});
    await m.driver.findByTestID('home-headline-amount', {timeoutMs: 10_000});

    const principal = await railPrincipalText(PRINCIPAL_SEED);
    const addr8 = principal.slice(0, 8);

    // (a) Settings → Address book: the door CLOSES the sheet and OPENS the route.
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-settings-address-book', {timeoutMs: 5000});
    await m.driver.click('btn-settings-address-book', {timeoutMs: 5000});
    await m.driver.findByTestID('addresses-list', {timeoutMs: 5000});
    expect(m.driver.isPresent('settings-relay')).toBe(false);

    // (a′) The EMPTY book says so, and says what to do next.
    await m.driver.findByTestID('addresses-empty', {timeoutMs: 5000});
    const emptyLine = m.driver.readText('addresses-empty');
    assertIncludes(emptyLine, 'No saved addresses yet', 'the empty book states its condition');
    assertIncludes(emptyLine, 'automatically', 'the empty book names its way out');

    // (b) Refuse-first: garbage destination → a status line, the Save gate held shut.
    await m.driver.click('btn-addresses-add', {timeoutMs: 5000});
    await m.driver.findByTestID('addresses-add-form', {timeoutMs: 5000});
    await m.driver.type('addr-add-address-input', 'not-an-address', {timeoutMs: 5000});
    await m.driver.findByTestID('addr-add-status', {timeoutMs: 5000});
    await expect(m.driver.propOf('btn-addresses-save', 'aria-disabled') === true
      || m.driver.propOf('btn-addresses-save', 'disabled') === true).toBe(true);
    await m.driver.click('btn-addresses-cancel', {timeoutMs: 5000});
    await m.driver.waitGone('addresses-add-form', {timeoutMs: 5000});

    // (b′) Valid destination on the VCHF rail, named, saved.
    await m.driver.click('btn-addresses-add', {timeoutMs: 5000});
    await m.driver.findByTestID('addresses-add-form', {timeoutMs: 5000});
    await m.driver.click('addr-add-asset-vchf', {timeoutMs: 5000});
    await m.driver.type('addr-add-address-input', principal, {timeoutMs: 5000});
    // Wait for the resolver to clear the gate (the IC check is debounced).
    await m.driver.waitForFunction(
      () => m.driver.propOf('btn-addresses-save', 'disabled') !== true,
      {timeoutMs: 6000, label: 'the valid destination clears the Save gate'},
    );
    await m.driver.type('addr-add-name-input', 'Landlord', {timeoutMs: 5000});
    await m.driver.click('btn-addresses-save', {timeoutMs: 5000});
    await m.driver.waitGone('addresses-add-form', {timeoutMs: 5000});
    const rowID = `addr-row-vchf-${addr8}`;
    await m.driver.findByTestID(rowID, {timeoutMs: 5000});
    const rowText = m.driver.readText(rowID);
    assertIncludes(rowText, 'Landlord', 'the saved entry shows its label');
    assertIncludes(rowText, principal.slice(0, 5), 'the saved entry shows its address');

    // (c) Rename in place.
    await m.driver.click(`addr-rename-vchf-${addr8}`, {timeoutMs: 5000});
    await m.driver.type('addr-rename-input-vchf', 'Canteen', {timeoutMs: 5000});
    await m.driver.click('addr-rename-save-vchf', {timeoutMs: 5000});
    await m.driver.waitGone('addr-rename-input-vchf', {timeoutMs: 5000});
    assertIncludes(m.driver.readText(rowID), 'Canteen', 'the renamed label replaced the old one');

    // (d) The send form's contextual entry: leave the route, fund + select the VCHF rail, then
    //     the send form's manage link opens the same route and Back returns to the form.
    await m.driver.click('btn-addresses-back', {timeoutMs: 5000});
    await m.driver.findByTestID('home-headline-amount', {timeoutMs: 5000});
    const identity = await accountOf(m);
    const fund = await faucetAccount(identity!.publicHex, 500_000_000, {currency: 7});
    expect(fund.ok).toBe(true);
    await openBalances(m);
    await selectCurrency(m, 'vchf');
    // The funded figure lands on the accounts row — dump what actually renders if it never does.
    await m.driver.waitForFunction(() => /5\.00 Fr/.test(m.driver.bodyText()), {timeoutMs: 8000, label: 'the funded VCHF figure renders'});
    await openPaySend(m);
    await m.driver.findByTestID('send-saved', {timeoutMs: 5000});
    await m.driver.click('send-manage', {timeoutMs: 5000});
    await m.driver.findByTestID('addresses-list', {timeoutMs: 5000});
    await m.driver.click('btn-addresses-back', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-pay-send', {timeoutMs: 5000});

    // (c′) Remove: one explicit tap, and the book says so again.
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-settings-address-book', {timeoutMs: 5000});
    await m.driver.click('btn-settings-address-book', {timeoutMs: 5000});
    await m.driver.findByTestID(rowID, {timeoutMs: 5000});
    await m.driver.click(`addr-forget-vchf-${addr8}`, {timeoutMs: 5000});
    await m.driver.waitGone(rowID, {timeoutMs: 5000});
    assertIncludes(m.driver.readText('addresses-empty'), 'No saved addresses yet', 'the book is empty again and says so');

    await m.driver.click('btn-addresses-back', {timeoutMs: 5000});
    await m.unmount();
  }, 240_000);
});
