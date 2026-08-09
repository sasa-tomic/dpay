// Flow 56 — Withdraw saved-address persistence (Fork-B: tap-to-reuse, no re-paste).
//
// Characterizes an EXISTING, zero-covered behavior: after a SUCCESSFUL withdraw, the app persists the
// destination address to AsyncStorage (`saveWithdrawAddr` in services/withdraw.ts — one per
// currency), and the NEXT time the user opens the WithdrawSheet for that currency the
// `btn-withdraw-saved` chip renders ("Use last: …") which, on tap, pre-fills the address input
// (`loadSavedWithdrawAddr`). The existing withdraw flows (15/18/44/48/52) always type a FRESH
// address — none ever exercise the persist → reload → reuse path, so it has zero dedicated coverage.
//
// The persistence is gated on a SUCCESSFUL settle: `saveWithdrawAddr` fires inside WithdrawSheet's
// `confirm()` ONLY after the relay accepts the signed WithdrawAuth and `setPhase('done')` runs. So
// this flow mirrors flow 15's funding setup exactly — seed + credit ckBTC (currency 1) via the
// test-helpers deposit route, then withdraw the minimum (0.00050000 BTC = 50_000 sats) to a fixed
// bc1 address. The settle succeeds → the address is saved. The sheet is then closed, REOPENED for
// the same currency, and the saved chip + tap-to-fill is asserted.
//
// Selector contract: `balance` (header → Balances), `btn-withdraw` (the ckBTC row Cash-out, shown
// once funded), `withdraw-address-input`, `withdraw-amount-input`, `btn-withdraw-confirm`,
// `withdraw-status` ('Withdrawn ✓'), `btn-withdraw-done` (success-screen close), `btn-withdraw-saved`
// (the reload chip). Address + amount reused verbatim from flow 15 so amount validation passes.
import { setup, assert, assertEq, assertIncludes, seedDeposit, refreshDeposit, onboardWallet, accountOf, openBalances } from '../harness/lib.mjs';

const DEPOSIT_CURRENCY = 1; // ckBTC — matches App.tsx DEPOSIT_CURRENCY / flow 15
const SEED_SATS = 100_000;   // 0.00100000 BTC
const WITHDRAW_BTC = '0.00050000'; // 50_000 sats == retrieve_btc_min_amount (passes amount validation)
// Reused verbatim from flow 15 — a valid bc1 bech32 address so family-aware validation passes.
const WITHDRAW_ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '56',
  name: 'withdraw-saved-addr',
  journey: 'withdraw',
  covers: ['saved-address', 'btn-withdraw-saved', 'withdraw-persist'],
  verifies: 'A successful withdraw persists the destination (AsyncStorage); reopening the sheet shows a "Use last" chip that pre-fills the address input.',
  timeoutMs: 25000,
};

export async function run() {
  const start = Date.now();
  console.log('[56-withdraw-saved-addr] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Onboard + fund ckBTC so the WithdrawSheet has a balance to draw from + a Cash-out to open.
    //    Mirrors flow 15's setup verbatim (seed → refresh → the balance poll credits currency 1).
    console.log('[56-withdraw-saved-addr] onboarding + seeding ckBTC…');
    await onboardWallet(driver, 'e2e-saved');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);
    await seedDeposit(relayBaseURL, accountHex, DEPOSIT_CURRENCY, SEED_SATS);
    await refreshDeposit(relayBaseURL, accountHex, DEPOSIT_CURRENCY);

    // 2. Open the Balances hub; wait for the ckBTC row's Cash-out (renders once funded).
    await openBalances(driver);
    await driver.findByTestID('btn-withdraw', { timeoutMs: 8_000 });

    // 3. Open the Withdraw sheet. On a FIRST cash-out there is NO saved address yet → the
    //    btn-withdraw-saved chip must be ABSENT (proves the chip is persistence-gated, not always-on).
    console.log('[56-withdraw-saved-addr] first withdraw (no saved chip yet)…');
    await driver.click('btn-withdraw', { timeoutMs: 5_000 });
    await driver.findByTestID('withdraw-address-input', { timeoutMs: 5_000 });
    const chipBeforeFirst = await driver.isPresent('btn-withdraw-saved');
    assert(!chipBeforeFirst, 'btn-withdraw-saved must be ABSENT on the first cash-out (nothing persisted yet)');

    // 4. Enter the destination + the minimum amount, then confirm. A successful settle fires
    //    saveWithdrawAddr(currency, address) — the persistence this flow characterizes.
    await driver.type('withdraw-address-input', WITHDRAW_ADDR, { timeoutMs: 4_000 });
    await driver.type('withdraw-amount-input', WITHDRAW_BTC, { timeoutMs: 4_000 });
    await driver.findByTestID('withdraw-review-amount', { timeoutMs: 4_000 }); // parsed the BTC amount
    console.log('[56-withdraw-saved-addr] confirming (signs on-device + submits → saveWithdrawAddr)…');
    await driver.click('btn-withdraw-confirm', { timeoutMs: 5_000 });

    // 5. Assert "Withdrawn ✓" — the relay accepted the sig + debited, and the address is now saved.
    const ok = await driver.waitForText('Withdrawn', { timeoutMs: 10_000 });
    const body = await driver.bodyText();
    assert(ok, `withdraw sheet should show "Withdrawn ✓". body excerpt:\n${body.slice(0, 600)}`);
    console.log(`[56-withdraw-saved-addr] ✓ withdrew ${WITHDRAW_BTC} BTC to ${WITHDRAW_ADDR} (address persisted)`);

    // 6. Close the sheet (unmounts WithdrawSheet → the next open is a FRESH mount that reloads
    //    the saved address via loadSavedWithdrawAddr in its mount-time useEffect).
    await driver.click('btn-withdraw-done', { timeoutMs: 5_000 });
    await driver.waitGone('btn-withdraw-done', { timeoutMs: 5_000 });

    // 7. REOPEN the Withdraw sheet for the SAME currency (ckBTC). The reload fires; since a saved
    //    address now exists AND the address input is empty, the btn-withdraw-saved chip renders.
    console.log('[56-withdraw-saved-addr] reopening — expecting the saved-address chip…');
    await openBalances(driver);
    await driver.click('btn-withdraw', { timeoutMs: 5_000 });
    await driver.findByTestID('withdraw-address-input', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-withdraw-saved', { timeoutMs: 5_000 });

    // 8. The chip labels the saved address ("Use last: <truncated>"). Assert it is the right one.
    const chipText = await driver.readText('btn-withdraw-saved');
    assertIncludes(chipText, 'Use last:', 'saved-address chip copy');
    assertIncludes(chipText, WITHDRAW_ADDR.slice(0, 8), 'saved-address chip shows the persisted address prefix');
    console.log(`[56-withdraw-saved-addr] ✓ saved chip rendered: "${chipText}"`);

    // 9. The address input is still empty (the chip is the opt-in to reuse). Tap the chip → it sets
    //    the input to the saved address verbatim. This is the tap-to-reuse behavior (Fork-B).
    let addrValue = await driver.readInputValue('withdraw-address-input');
    assertEq(addrValue, '', 'address input should be empty until the saved chip is tapped');
    await driver.click('btn-withdraw-saved', { timeoutMs: 5_000 });
    addrValue = await driver.readInputValue('withdraw-address-input');
    assertEq(addrValue, WITHDRAW_ADDR, 'address input pre-filled with the saved address after tapping the chip');
    console.log(`[56-withdraw-saved-addr] ✓ tap-to-reuse pre-filled the input with "${WITHDRAW_ADDR}"`);

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
