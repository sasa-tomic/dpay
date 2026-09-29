/**
 * Flow 56 — the jest twin of `e2e/tests/56-withdraw-saved-addr.mjs` (the address book's
 * persistence behavior on the shared send surface).
 *
 * A SUCCESSFUL chain-key send (approve + retrieve settled via read_state) writes the destination
 * to the per-asset address book. The load-bearing assertion is the REMOUNT: flipping to "Scan to
 * pay" unmounts SendSheet (taking its in-memory `saved` state with it), so the chip on reopen was
 * rebuilt from storage by the mount-time loadAddressBook effect — not carried in React state.
 * Reuses flow 15's address + amount verbatim so amount validation passes.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  accountOf, assert, assertEq, assertIncludes, faucetAccount, getBalance, onboardWallet,
  openBalances, selectCurrency, openPaySend,
} from '../harness/lib';

const BTC_CURRENCY = 1;
const SEED_SATS = 100_000; // 0.00100000 BTC
const WITHDRAW_ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'; // flow 15's address, verbatim
const SAVED_CHIP = 'send-saved-bc1qxy2k'; // the chip testID = first 8 chars of the address
const SHORT_ADDR = 'bc1qxy2kgdyg…fjhx0wlh'; // AddressField middle-elides a long address

hermeticDescribe('flow 56 — saved send destinations: persisted on success, rebuilt from storage on remount', () => {
  it('a settled send saves the destination; after the surface unmounts, the chip pre-fills on tap', async () => {
    const m = await onboardWallet('jest-saved');
    const accountHex = (await accountOf(m))!.publicHex;
    const fund = await faucetAccount(accountHex, SEED_SATS, {currency: BTC_CURRENCY});
    assert(fund.ok, `faucet funding must succeed, got ${fund.status}`);
    assertEq(await getBalance(accountHex, BTC_CURRENCY), String(SEED_SATS), 'pre-withdraw balance');

    await openBalances(m);
    assert(await m.driver.waitForText('0.001 BTC', {timeoutMs: 8000}), 'the funded BTC row');

    // 1. FIRST send: nothing in the book → the saved list must be ABSENT (persistence-gated, not
    //    always-on chrome).
    await selectCurrency(m, 'ckbtc');
    await openPaySend(m);
    await m.driver.findByTestID('send-address-input', {timeoutMs: 5000});
    expect(m.driver.isPresent('send-saved')).toBe(false);

    // 2. Destination + the minimum amount → confirm → the settle fires the address-book write.
    await m.driver.type('send-address-input', WITHDRAW_ADDR, {timeoutMs: 4000});
    await m.driver.findByTestID('withdraw-amount-input', {timeoutMs: 5000});
    await m.driver.type('withdraw-amount-input', '0.00050000', {timeoutMs: 4000});
    await m.driver.findByTestID('withdraw-review-amount', {timeoutMs: 4000});
    await m.driver.click('btn-withdraw-confirm', {timeoutMs: 5000});
    assert(await m.driver.waitForText('Withdrawn', {timeoutMs: 10_000}), 'Withdrawn ✓');
    assertEq(await getBalance(accountHex, BTC_CURRENCY), String(SEED_SATS - 50_000 - 10),
      'post-withdraw balance (burn + the 10-sat ledger fee)');

    // 3. Flip back to scan — this UNMOUNTS SendSheet (field, saved state, offramp body all gone).
    await m.driver.click('btn-pay-scan', {timeoutMs: 5000});
    await m.driver.waitGone('btn-withdraw-done', {timeoutMs: 5000});
    await m.driver.waitGone('send-address-input', {timeoutMs: 5000});

    // 4. REOPEN: a fresh mount whose loadAddressBook effect reads the book back from storage.
    await m.driver.click('btn-pay-send', {timeoutMs: 5000});
    await m.driver.findByTestID('send-address-input', {timeoutMs: 5000});
    await m.driver.findByTestID('send-saved', {timeoutMs: 5000});
    await m.driver.findByTestID(SAVED_CHIP, {timeoutMs: 5000});
    // The chain-key offramp saves with no user-given name → "Unnamed" over the elided address.
    const chipText = m.driver.readText(SAVED_CHIP);
    assertIncludes(chipText, 'Unnamed', 'an unnamed saved destination is labelled as such');
    assertIncludes(chipText, SHORT_ADDR, 'the chip shows the persisted address, middle-elided');

    // 5. Nothing pre-fills behind the user's back; the chip tap is the opt-in to reuse.
    assertEq(m.driver.readInputValue('send-address-input'), '', 'the field stays empty until the chip is tapped');
    await m.driver.click(SAVED_CHIP, {timeoutMs: 5000});
    assertEq(m.driver.readInputValue('send-address-input'), WITHDRAW_ADDR, 'the chip pre-filled the saved address');

    await m.unmount();
  }, 180_000);
});
