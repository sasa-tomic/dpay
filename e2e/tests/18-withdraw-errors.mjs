// Flow 18 — Withdraw error paths (folded: below-min, over-balance, bad-address UI guards).
//
// The withdrawal path has TWO layers of error handling:
//   1. APP-LEVEL UI GUARDS (the first line of defense) — covered HERE, browser-driven through the
//      REAL WithdrawSheet: the sheet gates `canReview` on `!belowMin && !overBalance && !badAddr`,
//      so an invalid amount/address shows an inline warning + a DISABLED confirm button — the
//      error never reaches the relay. Proven via the visible warning text.
//   2. RELAY-LEVEL ENFORCEMENT (the API gate): POST /api/v1/withdraw's 4xx rejects (bad signature /
//      insufficient funds / below-min / nonce reuse) need NO browser — they are covered
//      exhaustively + money-safely by the relay-direct unit tests in crates/dpay-relay/tests/
//      relay.rs (withdraw_wrong_sig_rejected_no_funds_move, withdraw_below_min_rejected,
//      withdraw_insufficient_funds_releases_nonce_for_retry, …), which assert status + error code
//      + no-debit against the same route the app calls. They were moved out of this flow on
//      2026-08-15 (this flow previously POSTed them over HTTP — duplicating the relay tests while
//      holding the browser open for cases that never touch it).
//
// Folds the three UI-guard scenarios into ONE test (speed: onboard once, reuse the sheet):
//   - Below-min: 10_000 sats < the 50_000 retrieve_btc_min_amount → UI warning + confirm disabled.
//   - Over-balance: 1_000_000 sats > the 100_000 balance → UI warning + confirm disabled.
//   - Wrong-chain address (ETH 0x… in the BTC cash-out) → warning + confirm disabled (the
//     documented invalid-address gap, closed).
//
// Selector contract: `balance` (header → Balances), `asset-ckbtc-select` (BTC row whole-row
// select), `btn-pay-send` (Pay → "Send to address"), `withdraw-address-input`,
// `withdraw-amount-input`, `btn-withdraw-confirm` (asserted disabled via the dim style / no review
// card).
import { setup, assert, seedDeposit, refreshDeposit, onboardWallet, openBalances, selectCurrency, openPaySend, assertDisabled, accountOf } from '../harness/lib.mjs';

const DEPOSIT_CURRENCY = 1; // ckBTC — matches the CkBtcUtxo catalog entry
const SEED_SATS = 100_000;   // 0.00100000 BTC — enough to withdraw but small enough to over-draw
const DEST = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '18',
  name: 'withdraw-errors',
  journey: 'withdraw',
  covers: ['withdraw-errors', 'below-min', 'over-balance', 'bad-addr'],
  verifies: 'Withdraw UI guards: below-min / over-balance / bad-addr warnings disable the confirm button (relay 4xx gates covered relay-direct in relay.rs).',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[18-withdraw-errors] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // Onboard + seed ckBTC so the WithdrawSheet has a balance to draw from + an asset card to open.
    await onboardWallet(driver, 'e2e-werr');
    const accountHex = (await accountOf(driver)).publicHex;
    await seedDeposit(relayBaseURL, accountHex, DEPOSIT_CURRENCY, SEED_SATS);
    await refreshDeposit(relayBaseURL, accountHex, DEPOSIT_CURRENCY);
    // Open Balances; wait for the funded ckBTC row, then SELECT ckBTC → Pay → "Send to address".
    await openBalances(driver);
    await driver.waitForText('0.00100000 BTC', { timeoutMs: 8_000 });

    // --- 1. BELOW-MINIMUM (UI guard): type an amount under the 50_000 floor. -----------------
    console.log('[18-withdraw-errors] below-min UI guard…');
    await selectCurrency(driver, 'ckbtc');
    await openPaySend(driver);
    await driver.findByTestID('withdraw-address-input', { timeoutMs: 5_000 });
    await driver.type('withdraw-address-input', DEST, { timeoutMs: 4_000 });
    await driver.type('withdraw-amount-input', '0.00010000', { timeoutMs: 4_000 }); // 10_000 sats
    const bodyBelow = await driver.bodyText();
    assert(bodyBelow.includes('Below the 0.00050000 BTC minimum withdrawal.'),
      `below-min warning should show. body excerpt:\n${bodyBelow.slice(0, 500)}`);
    // The confirm button is the gate: `canReview` is false when belowMin, so the Pressable is disabled
    // (the review card itself still renders the amount — that's fine; the SUBMIT is blocked).
    await assertDisabled(driver, 'btn-withdraw-confirm', 'the confirm button must be DISABLED for a below-min amount (canReview=false)');
    console.log('[18-withdraw-errors] ✓ below-min warning shows + confirm disabled');

    // --- 2. OVER-BALANCE (UI guard): type an amount exceeding the available balance. ----------
    console.log('[18-withdraw-errors] over-balance UI guard…');
    await driver.type('withdraw-amount-input', '0.01000000', { timeoutMs: 4_000 }); // 1_000_000 sats > 100_000
    const bodyOver = await driver.bodyText();
    assert(bodyOver.includes('More than your available 0.00100000 BTC.'),
      `over-balance warning should show. body excerpt:\n${bodyOver.slice(0, 500)}`);
    await assertDisabled(driver, 'btn-withdraw-confirm', 'the confirm button must be DISABLED for an over-balance amount (canReview=false)');
    console.log('[18-withdraw-errors] ✓ over-balance warning shows + confirm disabled');

    // --- 2b. INVALID ADDRESS (UI guard): paste a wrong-chain address (ETH format in BTC cash-out). -
    console.log('[18-withdraw-errors] invalid-address UI guard…');
    await driver.type('withdraw-address-input', '0x1234567890abcdef1234567890abcdef12345678', { timeoutMs: 4_000 });
    await driver.type('withdraw-amount-input', '0.00050000', { timeoutMs: 4_000 }); // valid amount
    const bodyBad = await driver.bodyText();
    assert(bodyBad.includes("That doesn't look like a valid BTC address."),
      `bad-addr warning should show. body excerpt:\n${bodyBad.slice(0, 500)}`);
    await assertDisabled(driver, 'btn-withdraw-confirm', 'confirm must be DISABLED for a wrong-chain address');
    console.log('[18-withdraw-errors] ✓ invalid-address warning + confirm disabled');

    await driver.screenshot('18-withdraw-errors');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[18-withdraw-errors] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[18-withdraw-errors] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
