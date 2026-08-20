// Flow 56 — Withdraw saved-address persistence (tap-to-reuse, no re-paste).
//
// Characterizes the IC-rail persistence behavior: after a SUCCESSFUL rail withdraw, the app
// persists the destination address to AsyncStorage (`saveWithdrawAddr` in services/withdraw.ts —
// one per currency), and the NEXT time the user opens the WithdrawSheet for that currency the
// `btn-withdraw-saved` chip renders ("Use last: …") which, on tap, pre-fills the address input
// (`loadSavedWithdrawAddr`). The other withdraw flows (15/18/44/48) always type a FRESH address —
// none exercise the persist → remount → reuse path.
//
// The persistence is gated on a SUCCESSFUL settle: `saveWithdrawAddr` fires inside WithdrawSheet's
// `confirm()` ONLY after every offramp envelope (icrc2_approve + minter call) settles via the
// read_state poll and `setPhase('done')` runs. So this flow mirrors flow 15's funding setup
// exactly — faucet-fund ckTESTBTC (currency 6; see flow 15's header for why the fake catalog's
// shared CKBTC minter text makes currency 1 unusable on the fake) — then withdraw the minimum
// (0.00050000 BTC = 50_000 sats) to a fixed bc1 address. The settle succeeds → the address is
// saved. The sheet is then closed, REOPENED for the same currency, and the saved chip +
// tap-to-fill is asserted.
//
// Selector contract: `balance` (header → Balances), `btn-toggle-testnet` (reveal the testnet
// row), `asset-ckbtc-testnet-select` (the row whole-row select), `btn-pay-send` (Pay →
// "Send to address"), `withdraw-address-input`, `withdraw-amount-input`,
// `btn-withdraw-confirm`, `btn-withdraw-done` (success-screen Done), `btn-pay-scan` (flip back
// to scan), `btn-withdraw-saved` (the reload chip). Address + amount reused verbatim from flow
// 15 so amount validation passes.
import { setup, assert, assertEq, assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf, openBalances, selectCurrency, openPaySend } from '../harness/lib.mjs';

const BTC_CURRENCY = 6; // ckTESTBTC — the CkBtcUtxo withdraw path (flow 15's header explains why)
const BTC_ASSET_KEY = 'ckbtc-testnet';
const SEED_SATS = 100_000;   // 0.00100000 BTC
const WITHDRAW_BTC = '0.00050000'; // 50_000 sats == retrieve_btc_min_amount (passes amount validation)
const WITHDRAW_SATS = 50_000;
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
  verifies: 'A successful rail withdraw (approve + retrieve settled on /api/v2) persists the destination (AsyncStorage); reopening the sheet shows a "Use last" chip that pre-fills the address input.',
  timeoutMs: 25000,
};

export async function run() {
  const start = Date.now();
  console.log('[56-withdraw-saved-addr] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Onboard + faucet-fund the ckBTC rail so the WithdrawSheet has a balance to draw from
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

    // 2. Open the Balances hub; reveal + wait for the funded testnet BTC row, then SELECT it →
    //    Pay → "Send to address" (the inline WithdrawSheet body).
    await openBalances(driver);
    await driver.click('btn-toggle-testnet', { timeoutMs: 4_000 });
    await driver.waitForText('0.00100000 BTC', { timeoutMs: 8_000 });

    // 3. Open the inline withdraw. On a FIRST cash-out there is NO saved address yet → the
    //    btn-withdraw-saved chip must be ABSENT (proves the chip is persistence-gated, not always-on).
    console.log('[56-withdraw-saved-addr] first withdraw (no saved chip yet)…');
    await selectCurrency(driver, BTC_ASSET_KEY);
    await openPaySend(driver);
    await driver.findByTestID('withdraw-address-input', { timeoutMs: 5_000 });
    const chipBeforeFirst = await driver.isPresent('btn-withdraw-saved');
    assert(!chipBeforeFirst, 'btn-withdraw-saved must be ABSENT on the first cash-out (nothing persisted yet)');

    // 4. Enter the destination + the minimum amount, then confirm. A successful settle fires
    //    saveWithdrawAddr(currency, address) — the persistence this flow characterizes.
    await driver.type('withdraw-address-input', WITHDRAW_ADDR, { timeoutMs: 4_000 });
    await driver.type('withdraw-amount-input', WITHDRAW_BTC, { timeoutMs: 4_000 });
    await driver.findByTestID('withdraw-review-amount', { timeoutMs: 4_000 }); // parsed the BTC amount
    console.log('[56-withdraw-saved-addr] confirming (signs approve + retrieve on-device → saveWithdrawAddr)…');
    await driver.click('btn-withdraw-confirm', { timeoutMs: 5_000 });

    // 5. Assert "Withdrawn ✓" — the gateway accepted + burned, and the address is now saved.
    const ok = await driver.waitForText('Withdrawn', { timeoutMs: 10_000 });
    const body = await driver.bodyText();
    assert(ok, `withdraw sheet should show "Withdrawn ✓". body excerpt:\n${body.slice(0, 600)}`);
    const after = await getBalance(relayBaseURL, accountHex, BTC_CURRENCY);
    assertEq(after, String(SEED_SATS - WITHDRAW_SATS), 'post-withdraw balance (burned at the principal)');
    console.log(`[56-withdraw-saved-addr] ✓ withdrew ${WITHDRAW_BTC} BTC to ${WITHDRAW_ADDR} (address persisted)`);

    // 6. Flip the toggle back to "Scan to pay" (unmounts the inline WithdrawSheet → the next open is
    //    a FRESH mount that reloads the saved address via loadSavedWithdrawAddr in its mount-time
    //    useEffect). The success-screen "Done" button would also work, but the toggle is the
    //    canonical exit from the inline withdraw body.
    await driver.click('btn-pay-scan', { timeoutMs: 5_000 });
    await driver.waitGone('btn-withdraw-done', { timeoutMs: 5_000 });

    // 7. REOPEN the inline withdraw for the SAME currency. The reload fires; since a saved
    //    address now exists AND the address input is empty, the btn-withdraw-saved chip renders.
    console.log('[56-withdraw-saved-addr] reopening — expecting the saved-address chip…');
    await driver.click('btn-pay-send', { timeoutMs: 5_000 });
    await driver.findByTestID('withdraw-address-input', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-withdraw-saved', { timeoutMs: 5_000 });

    // 8. The chip labels the saved address ("Use last: <truncated>"). Assert it is the right one.
    const chipText = await driver.readText('btn-withdraw-saved');
    assertIncludes(chipText, 'Use last:', 'saved-address chip copy');
    assertIncludes(chipText, WITHDRAW_ADDR.slice(0, 8), 'saved-address chip shows the persisted address prefix');
    console.log(`[56-withdraw-saved-addr] ✓ saved chip rendered: "${chipText}"`);

    // 9. The address input is still empty (the chip is the opt-in to reuse). Tap the chip → it sets
    //    the input to the saved address verbatim. This is the tap-to-reuse behavior.
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
