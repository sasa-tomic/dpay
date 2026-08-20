// Flow 18 — Withdraw error paths (folded: below-min, over-balance, bad-address UI guards + a
// REAL rail rejection surfaced through the app).
//
// The withdrawal path has layers of error handling, and this flow drives ALL of them through the
// REAL WithdrawSheet:
//   1. APP-LEVEL UI GUARDS (the first line of defense): the sheet gates `canReview` on
//      `!belowMin && !overBalance && !badAddr`, so an invalid amount/address shows an inline
//      warning + a DISABLED confirm button — the error never reaches the rail.
//   2. RAIL REJECTION (the honest-failure surface): a fully-valid confirm that the LEDGER/MINTER
//      refuses must surface as a message in `withdraw-err` — never silent, never a lie. The
//      constructible case on this fake rail: withdraw the ENTIRE balance ("empty the wallet,
//      forget the costs"). The app's over-balance guard compares amount vs balance only, so the
//      full amount passes review — but the withdrawal also owes the icrc2_approve ledger fee
//      (1e16 Wei on the fake ckETH ledger) before the minter's withdraw_eth burn, and the burn
//      finds insufficient funds → the minter rejects (code 5, "insufficient funds: …") → the app
//      surfaces the reject message verbatim. ICRC-2 semantics make this MONEY-HONEST, not
//      money-neutral: the approve is a real ledger call and its fee is genuinely spent
//      (balance 5e18 → 4.99e18); the WITHDRAWN amount itself never moves. The flow asserts
//      BOTH the surfaced message and the exact fee-only debit.
//
// Driven on FUNDED native ckETH (currency 5: CkEthErc20 + token_contract None — the withdraw_eth
// path, no separate gas ledger on this fake). Balances are per-ledger on the fake gateway, so the
// ckETH bucket reads back EXACTLY the faucet seed.
//
// The gateway's own wire semantics (unknown canister, malformed args, envelope verification) are
// covered relay-direct in crates/dpay-relay/tests/ — they need no browser.
//
// Selector contract: `balance` (header → Balances), `asset-cketh-select` (the native-ETH row
// whole-row select), `btn-pay-send` (Pay → "Send to address"), `withdraw-address-input`,
// `withdraw-amount-input`, `btn-withdraw-confirm` (asserted disabled via aria-disabled),
// `withdraw-err` (the surfaced rail rejection).
import { setup, assert, assertEq, assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf, openBalances, selectCurrency, openPaySend, assertDisabled } from '../harness/lib.mjs';

const ETH_CURRENCY = 5; // native ckETH — CkEthErc20 + token_contract None (the withdraw_eth path)
// 18-dec Wei. Plain JS numbers lose precision above 2^53 (~9e15), so the amount crosses the HTTP
// boundary as a DECIMAL STRING (the relay's U64String parses it without precision loss).
const SEED_WEI = 5_000_000_000_000_000_000n; // 5 ETH
const APPROVE_FEE_WEI = 10_000_000_000_000_000n; // the fake ckETH ledger's icrc1_fee (1e16)
const DEST = '0x000000000000000000000000000000000000dead'; // valid 0x + 40 hex (the app's CkEthErc20 regex)
const BTC_STYLE_ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'; // wrong-chain (BTC format in the ETH cash-out)

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '18',
  name: 'withdraw-errors',
  journey: 'withdraw',
  covers: ['withdraw-errors', 'below-min', 'over-balance', 'bad-addr', 'rail-rejection', 'money-safe'],
  verifies: 'Withdraw error paths: below-min / over-balance / bad-addr warnings disable the confirm button; a minter-refused full-balance withdraw surfaces the "insufficient funds" reject in withdraw-err with a fee-only debit.',
  timeoutMs: 35000,
};

export async function run() {
  const start = Date.now();
  console.log('[18-withdraw-errors] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // Onboard + faucet-fund native ckETH so the WithdrawSheet has a real balance to draw from
    // (the over-balance guard needs a funded sheet to be meaningful).
    await onboardWallet(driver, 'e2e-werr');
    const accountHex = (await accountOf(driver)).publicHex;
    const fund = await faucetAccount(relayBaseURL, accountHex, String(SEED_WEI), { currency: ETH_CURRENCY });
    assert(fund.ok, `faucet funding must succeed, got HTTP ${fund.status}: ${JSON.stringify(fund.body)}`);
    const before = await getBalance(relayBaseURL, accountHex, ETH_CURRENCY);
    assertEq(before, String(SEED_WEI), 'pre-rejection ckETH balance must be the seeded bucket');

    // Open Balances; wait for the funded native-ETH row, then SELECT it → Pay → "Send to address".
    await openBalances(driver);
    await driver.waitForText('5.000000 ETH', { timeoutMs: 8_000 });
    await selectCurrency(driver, 'cketh');
    await openPaySend(driver);
    await driver.findByTestID('withdraw-address-input', { timeoutMs: 5_000 });

    // --- 1. BELOW-MINIMUM (UI guard): type an amount under the 0.01 ETH family floor. ----------
    console.log('[18-withdraw-errors] below-min UI guard…');
    await driver.type('withdraw-address-input', DEST, { timeoutMs: 4_000 });
    await driver.type('withdraw-amount-input', '0.001', { timeoutMs: 4_000 }); // 1e15 Wei < 1e16 min
    const bodyBelow = await driver.bodyText();
    assertIncludes(bodyBelow, 'Below the 0.010000 ETH minimum withdrawal.', 'below-min warning');
    // The confirm button is the gate: `canReview` is false when belowMin, so the Pressable is
    // disabled (the review card itself still renders the amount — that's fine; the SUBMIT is blocked).
    await assertDisabled(driver, 'btn-withdraw-confirm', 'the confirm button must be DISABLED for a below-min amount (canReview=false)');
    console.log('[18-withdraw-errors] ✓ below-min warning shows + confirm disabled');

    // --- 2. OVER-BALANCE (UI guard): type an amount exceeding the available balance. -----------
    console.log('[18-withdraw-errors] over-balance UI guard…');
    await driver.type('withdraw-amount-input', '6', { timeoutMs: 4_000 }); // 6 ETH > 5.000000 ETH available
    const bodyOver = await driver.bodyText();
    assertIncludes(bodyOver, 'More than your available 5.000000 ETH.', 'over-balance warning');
    await assertDisabled(driver, 'btn-withdraw-confirm', 'the confirm button must be DISABLED for an over-balance amount (canReview=false)');
    console.log('[18-withdraw-errors] ✓ over-balance warning shows + confirm disabled');

    // --- 2b. INVALID ADDRESS (UI guard): paste a wrong-chain address (BTC format in the ETH
    //         cash-out) — the documented invalid-address guard. ---------------------------------
    console.log('[18-withdraw-errors] invalid-address UI guard…');
    await driver.type('withdraw-address-input', BTC_STYLE_ADDR, { timeoutMs: 4_000 });
    await driver.type('withdraw-amount-input', '1', { timeoutMs: 4_000 }); // valid amount (1e18 Wei)
    const bodyBad = await driver.bodyText();
    assertIncludes(bodyBad, "That doesn't look like a valid ETH address.", 'bad-addr warning');
    await driver.findByTestID('withdraw-bad-addr', { timeoutMs: 4_000 });
    await assertDisabled(driver, 'btn-withdraw-confirm', 'confirm must be DISABLED for a wrong-chain address');
    console.log('[18-withdraw-errors] ✓ invalid-address warning + confirm disabled');

    await driver.screenshot('18-withdraw-errors-guards');

    // --- 3. RAIL REJECTION (honest failure): fix the address, withdraw the ENTIRE balance. The
    //         over-balance guard passes (amount == balance, not >), but the withdrawal also owes
    //         the approve ledger fee — the minter's withdraw_eth burn finds insufficient funds
    //         and rejects (code 5, "insufficient funds: …"). The app MUST surface the reject
    //         message verbatim — never silently swallow it. Money-honest per ICRC-2: the approve
    //         is a real ledger call, so its fee (1e16 Wei) is genuinely spent; the withdrawn
    //         amount itself NEVER moves (5e18 − 1e16 remains — exactly fee-only). -----------------
    console.log('[18-withdraw-errors] rail rejection (minter-refused full-balance withdraw)…');
    await driver.type('withdraw-address-input', DEST, { timeoutMs: 4_000 });
    await driver.type('withdraw-amount-input', '5', { timeoutMs: 4_000 }); // == the full balance
    await driver.findByTestID('withdraw-review-amount', { timeoutMs: 4_000 }); // parsed 5 ETH at 18-dec
    await driver.click('btn-withdraw-confirm', { timeoutMs: 5_000 });
    // Submitting → approve settles (fee charged) → withdraw_eth burn refused → reject message
    // surfaced. Clock fetch + approve + withdraw + read_state polls take a few seconds.
    await driver.waitForText('insufficient funds', { timeoutMs: 15_000 });
    const errTxt = await driver.readText('withdraw-err');
    assertIncludes(errTxt, 'insufficient funds', 'the rail rejection is surfaced (the minter refuse message, verbatim)');
    console.log(`[18-withdraw-errors] ✓ rail rejection surfaced honestly: "${errTxt}"`);
    // Money-honest: EXACTLY the approve fee moved — the withdrawn principal did not.
    const after = await getBalance(relayBaseURL, accountHex, ETH_CURRENCY);
    assertEq(after, String(SEED_WEI - APPROVE_FEE_WEI), 'post-rejection ckETH balance (approve fee spent; the withdrawn amount unmoved)');
    console.log(`[18-withdraw-errors] ✓ fee-only debit through the rejection (${before} → ${after})`);

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
