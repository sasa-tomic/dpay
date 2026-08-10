// Flow 18 — Withdraw error paths (folded: below-min, over-balance, relay-level rejects).
//
// The withdrawal path has TWO layers of error handling, both exercised here against the REAL relay:
//   1. APP-LEVEL UI GUARDS (the first line of defense): the WithdrawSheet gates `canReview` on
//      `!belowMin && !overBalance`, so an invalid amount shows an inline warning + a DISABLED
//      confirm button — the error never reaches the relay. Proven via the visible warning text.
//   2. RELAY-LEVEL ENFORCEMENT (the API-level gate): POST /api/v1/withdraw verifies the Ed25519 sig
//      under `from`, then rejects below-min / insufficient / wrong-sig / nonce-reused with HTTP 422.
//      Driven DIRECTLY via postWithdraw (signed by the byte-exact wire.mjs helper), proving the
//      relay is the authoritative gate the UI guards mirror. (Covered exhaustively in relay unit
//      tests relay.rs; this proves the same gate live over HTTP.)
//
// Folds ALL three withdraw error scenarios into ONE test (speed: onboard once, reuse the sheet):
//   - Below-min: 10_000 sats < the 50_000 retrieve_btc_min_amount → UI warning + relay 422.
//   - Over-balance: 1_000_000 sats > the 100_000 balance → UI warning + relay InsufficientFunds.
//   - Wrong-sig: a sig under a DIFFERENT key → relay 422 "bad signature" (no UI guard; only the
//     relay catches this since the app always signs correctly).
//
// Selector contract: `balance` (header → Balances), `asset-ckbtc-select` (BTC row whole-row
// select), `btn-pay-send` (Pay → "Send to address"), `withdraw-address-input`,
// `withdraw-amount-input`, `btn-withdraw-confirm` (asserted disabled via the dim style / no review
// card).
//
// Also covers INVALID-ADDRESS validation (the documented gap, now closed): the app validates the
// destination format family-aware — a wrong-chain address (ETH 0x… in the BTC cash-out) shows a
// warning + disables the confirm button.
import { setup, assert, assertEq, seedDeposit, refreshDeposit, getBalance, postWithdraw, onboardWallet, accountOf, openBalances, selectCurrency, openPaySend, assertDisabled } from '../harness/lib.mjs';
import { signWithdrawalHex, randNonceHex, generateKeypair } from '../harness/wire.mjs';

const DEPOSIT_CURRENCY = 1; // ckBTC — matches the CkBtcUtxo catalog entry
const SEED_SATS = 100_000;   // 0.00100000 BTC — enough to withdraw but small enough to over-draw
const MIN_SATS = 50_000;     // retrieve_btc_min_amount (mirrors the live minter + the relay constant)
const DEST = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '18',
  name: 'withdraw-errors',
  journey: 'withdraw',
  covers: ['withdraw-errors', 'below-min', 'over-balance', 'bad-sig', 'bad-addr'],
  verifies: 'Withdraw errors: below-min / over-balance / bad-addr UI guards (confirm disabled) + relay 422 (bad-sig/insufficient).',
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
    const identity = await accountOf(driver);
    const accountHex = identity.publicHex;
    await seedDeposit(relayBaseURL, accountHex, DEPOSIT_CURRENCY, SEED_SATS);
    await refreshDeposit(relayBaseURL, accountHex, DEPOSIT_CURRENCY);
    assertEq(await getBalance(relayBaseURL, accountHex, DEPOSIT_CURRENCY), String(SEED_SATS), 'seeded ckBTC balance');
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

    // Close the inline withdraw body so the relay-level checks below are a clean separate phase.
    // Flipping the toggle back to "Scan to pay" unmounts the WithdrawSheet.
    await driver.click('btn-pay-scan', { timeoutMs: 4_000 });
    await driver.waitGone('withdraw-address-input', { timeoutMs: 4_000 });

    // --- 3. RELAY-LEVEL enforcement (the API gate the UI mirrors): drive POST /api/v1/withdraw
    //     directly with a REAL on-device-style signed request, one per rejection case. -------------
    const exp = Math.floor(Date.now() / 1000) + 600;
    const destWallet = { secretHex: identity.secretHex, publicHex: accountHex };

    // 3a. Below-min: a properly-signed withdraw for 10_000 sats (< 50_000) → relay 422.
    console.log('[18-withdraw-errors] relay: below-min rejection…');
    {
      const nonce = randNonceHex();
      const sig = await signWithdrawalHex(destWallet.secretHex, accountHex, DEST, 10_000, nonce, exp, DEPOSIT_CURRENCY);
      const r = await postWithdraw(relayBaseURL, { from: accountHex, destination: DEST, amount: 10_000, nonce, expiry: exp, currency: DEPOSIT_CURRENCY, sig });
      assert(!r.ok && r.status === 422, `below-min withdraw must be 422, got status=${r.status} body=${JSON.stringify(r.body)}`);
      assert(typeof r.body?.error === 'string' && /below.*retrieve_btc_min_amount/i.test(r.body.error),
        `below-min error text should mention retrieve_btc_min_amount, got "${r.body?.error}"`);
      console.log(`[18-withdraw-errors] ✓ relay rejected below-min (422): "${r.body.error}"`);
    }

    // 3b. Insufficient funds: a properly-signed withdraw for 1_000_000 sats (> 100_000 balance) → 422.
    console.log('[18-withdraw-errors] relay: insufficient-funds rejection…');
    {
      const nonce = randNonceHex();
      const sig = await signWithdrawalHex(destWallet.secretHex, accountHex, DEST, 1_000_000, nonce, exp, DEPOSIT_CURRENCY);
      const r = await postWithdraw(relayBaseURL, { from: accountHex, destination: DEST, amount: 1_000_000, nonce, expiry: exp, currency: DEPOSIT_CURRENCY, sig });
      assert(!r.ok && r.status === 422, `over-balance withdraw must be 422, got status=${r.status}`);
      assert(typeof r.body?.error === 'string' && /InsufficientFunds/i.test(r.body.error),
        `over-balance error text should mention InsufficientFunds, got "${r.body?.error}"`);
      console.log(`[18-withdraw-errors] ✓ relay rejected insufficient (422): "${r.body.error}"`);
    }

    // 3c. Wrong signature: a sig under a DIFFERENT key (the app always signs correctly, so this is
    //     only reachable via a malicious/buggy client — the relay is the sole gate) → 422.
    console.log('[18-withdraw-errors] relay: bad-signature rejection…');
    {
      const attacker = await generateKeypair();
      const nonce = randNonceHex();
      // Sign under the ATTACKER's key but claim `from` = the real wallet → sig verify fails.
      const sig = await signWithdrawalHex(attacker.secretHex, accountHex, DEST, MIN_SATS, nonce, exp, DEPOSIT_CURRENCY);
      const r = await postWithdraw(relayBaseURL, { from: accountHex, destination: DEST, amount: MIN_SATS, nonce, expiry: exp, currency: DEPOSIT_CURRENCY, sig });
      assert(!r.ok && r.status === 422, `wrong-sig withdraw must be 422, got status=${r.status}`);
      assert(typeof r.body?.error === 'string' && /bad signature/i.test(r.body.error),
        `wrong-sig error text should say "bad signature", got "${r.body?.error}"`);
      console.log(`[18-withdraw-errors] ✓ relay rejected bad sig (422): "${r.body.error}"`);
    }

    // Money-safety: none of the rejected withdraws moved any funds (balance unchanged).
    assertEq(await getBalance(relayBaseURL, accountHex, DEPOSIT_CURRENCY), String(SEED_SATS),
      'ckBTC balance unchanged after all rejected withdraws (no funds moved)');

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
