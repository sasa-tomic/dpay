// Flow 56 — Saved send destinations (address book): remembered on success, reusable after a remount.
//
// Characterizes the PERSISTENCE behavior of the shared send surface: after a SUCCESSFUL send the
// destination is written to the per-asset address book (`rememberAddress` in
// services/addressBook.ts, AsyncStorage, MRU, capped), and the NEXT time the user opens the send
// sub-mode for that asset the book is re-read and the destination renders as a saved chip that
// pre-fills the field on tap. The other send/withdraw flows (15/18/44/48/104/105/106) always type a
// FRESH address — none exercise the persist → remount → reuse path.
//
// The persistence is gated on a SUCCESSFUL settle. This flow drives the CHAIN-KEY branch, where the
// gate is two components deep: WithdrawSheet calls `onSaveAddress(dest)` only after every offramp
// envelope (icrc2_approve + minter call) settles via the read_state poll and `setPhase('done')`
// runs, and SendSheet — which owns the field and the book — turns that into a `rememberAddress`
// write. So a saved chip appearing at all proves the whole sequence settled.
//
// The load-bearing assertion is the REMOUNT: flipping to "Scan to pay" unmounts SendSheet (taking
// its in-memory `saved` state with it), so the chip that appears on reopening was rebuilt from
// storage by the mount-time `loadAddressBook` effect — not carried over in React state. A chip that
// only survived because the component never unmounted would prove nothing about persistence.
//
// Setup mirrors flow 15 — faucet-fund ckBTC (currency 1, mainnet; the prod-shaped CkBtcUtxo path,
// see flow 15's header) — then withdraw the minimum (0.00050000 BTC = 50_000 sats) to a fixed bc1
// address, reusing flow 15's address + amount verbatim so amount validation passes.
//
// Selector contract: `balance` (header → Balances), `asset-ckbtc-select` (the row whole-row
// select), `btn-pay-send` (Pay → "Send to address"), `send-address-input` (the ONE shared
// destination field), `withdraw-amount-input`, `btn-withdraw-confirm`, `btn-withdraw-done`
// (success-screen Done), `btn-pay-scan` (flip back to scan), `send-saved` (the saved list) and
// `send-saved-<first 8 chars of the address>` (the tap-to-reuse chip).
import { setup, assert, assertEq, assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf, openBalances, selectCurrency, openPaySend } from '../harness/lib.mjs';

const BTC_CURRENCY = 1; // ckBTC (mainnet) — the CkBtcUtxo withdraw path (flow 15's header explains)
const BTC_ASSET_KEY = 'ckbtc';
const SEED_SATS = 100_000;   // 0.00100000 BTC
const WITHDRAW_BTC = '0.00050000'; // 50_000 sats == retrieve_btc_min_amount (passes amount validation)
const WITHDRAW_SATS = 50_000;
// Reused verbatim from flow 15 — a valid bc1 bech32 address so the destination routes to the
// Bitcoin offramp. The chip's testID suffix is the address's first 8 characters.
const WITHDRAW_ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const SAVED_CHIP = 'send-saved-bc1qxy2k';
// AddressField middle-elides a long address (first 12 … last 8) so both ends stay checkable.
const SHORT_ADDR = 'bc1qxy2kgdyg…fjhx0wlh';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '56',
  name: 'withdraw-saved-addr',
  journey: 'withdraw',
  covers: ['saved-address', 'address-book', 'send-saved', 'withdraw-persist'],
  verifies: 'A successful chain-key send (approve + retrieve settled on /api/v2) writes the destination to the per-asset address book; after the send surface is closed and REMOUNTED the book is re-read from storage and the destination renders as a saved chip that pre-fills the shared field on tap.',
  timeoutMs: 25000,
};

export async function run() {
  const start = Date.now();
  console.log('[56-withdraw-saved-addr] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Onboard + faucet-fund the ckBTC rail so the send surface has a balance to draw from
    //    (and passes the fund-first gate). Mirrors flow 15's setup.
    console.log('[56-withdraw-saved-addr] onboarding + faucet-funding ckBTC…');
    await onboardWallet(driver, 'e2e-saved');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);
    const fund = await faucetAccount(relayBaseURL, accountHex, SEED_SATS, { currency: BTC_CURRENCY });
    assert(fund.ok, `faucet funding must succeed, got HTTP ${fund.status}: ${JSON.stringify(fund.body)}`);
    const before = await getBalance(relayBaseURL, accountHex, BTC_CURRENCY);
    assertEq(before, String(SEED_SATS), 'pre-withdraw balance at the principal (per-ledger bucket)');

    // 2. Open the Balances hub; wait for the funded BTC row, then SELECT it → Pay →
    //    "Send to address" (the shared destination field).
    await openBalances(driver);
    await driver.waitForText('0.001 BTC', { timeoutMs: 8_000 });

    // 3. On a FIRST send there is nothing in the book → the saved list must be ABSENT (proves the
    //    list is persistence-gated, not always-on chrome).
    console.log('[56-withdraw-saved-addr] first send (empty address book)…');
    await selectCurrency(driver, BTC_ASSET_KEY);
    await openPaySend(driver);
    await driver.findByTestID('send-address-input', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('send-saved')), 'the saved-address list must be ABSENT on the first send (nothing persisted yet)');

    // 4. Paste the destination (routes to the Bitcoin offramp body) + the minimum amount, then
    //    confirm. A successful settle is what fires the address-book write.
    await driver.type('send-address-input', WITHDRAW_ADDR, { timeoutMs: 4_000 });
    await driver.findByTestID('withdraw-amount-input', { timeoutMs: 5_000 });
    await driver.type('withdraw-amount-input', WITHDRAW_BTC, { timeoutMs: 4_000 });
    await driver.findByTestID('withdraw-review-amount', { timeoutMs: 4_000 }); // parsed the BTC amount
    console.log('[56-withdraw-saved-addr] confirming (signs approve + retrieve on-device → rememberAddress)…');
    await driver.click('btn-withdraw-confirm', { timeoutMs: 5_000 });

    // 5. Assert "Withdrawn ✓" — the gateway accepted + burned, and the destination is now saved.
    const ok = await driver.waitForText('Withdrawn', { timeoutMs: 10_000 });
    const body = await driver.bodyText();
    assert(ok, `send surface should show "Withdrawn ✓". body excerpt:\n${body.slice(0, 600)}`);
    const after = await getBalance(relayBaseURL, accountHex, BTC_CURRENCY);
    assertEq(after, String(SEED_SATS - WITHDRAW_SATS), 'post-withdraw balance (burned at the principal)');
    console.log(`[56-withdraw-saved-addr] ✓ withdrew ${WITHDRAW_BTC} BTC to ${WITHDRAW_ADDR} (address remembered)`);

    // 6. Flip the toggle back to "Scan to pay". This UNMOUNTS SendSheet — the address field, its
    //    `saved` state and the offramp body all go away — so the next open is a FRESH mount whose
    //    `loadAddressBook` effect must read the book back from storage. This is the step that makes
    //    the assertion below about PERSISTENCE rather than about React state.
    await driver.click('btn-pay-scan', { timeoutMs: 5_000 });
    await driver.waitGone('btn-withdraw-done', { timeoutMs: 5_000 });
    await driver.waitGone('send-address-input', { timeoutMs: 5_000 });

    // 7. REOPEN the send sub-mode for the SAME asset. The field comes up empty (fresh mount) and,
    //    because the book now has an entry, the saved list + its chip render.
    console.log('[56-withdraw-saved-addr] reopening — expecting the saved-address chip…');
    await driver.click('btn-pay-send', { timeoutMs: 5_000 });
    await driver.findByTestID('send-address-input', { timeoutMs: 5_000 });
    await driver.findByTestID('send-saved', { timeoutMs: 5_000 });
    await driver.findByTestID(SAVED_CHIP, { timeoutMs: 5_000 });

    // 8. The chip identifies the saved destination: the chain-key offramp saves with no user-given
    //    name (the naming field belongs to the direct-send body), so it reads "Unnamed" over the
    //    middle-elided address — both ends visible, which is what a user compares against their
    //    source wallet.
    const chipText = await driver.readText(SAVED_CHIP);
    assertIncludes(chipText, 'Unnamed', 'an unnamed saved destination is labelled as such, never left blank');
    assertIncludes(chipText, SHORT_ADDR, 'the chip shows the persisted address, middle-elided');
    console.log(`[56-withdraw-saved-addr] ✓ saved chip rebuilt from storage: "${chipText}"`);

    // 9. The field is still empty (the chip is the opt-in to reuse — nothing is pre-filled behind
    //    the user's back). Tap the chip → the field holds the saved address verbatim.
    let addrValue = await driver.readInputValue('send-address-input');
    assertEq(addrValue, '', 'the destination field should be empty until the saved chip is tapped');
    await driver.click(SAVED_CHIP, { timeoutMs: 5_000 });
    addrValue = await driver.readInputValue('send-address-input');
    assertEq(addrValue, WITHDRAW_ADDR, 'the destination field is pre-filled with the saved address after tapping the chip');
    console.log(`[56-withdraw-saved-addr] ✓ tap-to-reuse pre-filled the field with "${WITHDRAW_ADDR}"`);

    await driver.screenshot('56-withdraw-saved-addr');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[56-withdraw-saved-addr] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/56-withdraw-saved-addr.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[56-withdraw-saved-addr] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
