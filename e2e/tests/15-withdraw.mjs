// Flow 15 — Withdraw ckBTC to a native BTC address (W2) end-to-end through the REAL app + relay.
//
// Proves the WITHDRAWAL path (the one-way valve's other direction): the wallet's ckBTC asset card
// exposes a "Withdraw" affordance; opening it signs a WithdrawAuth ON-DEVICE (the DpayCore shim —
// byte-exact vs the Rust core, proven in 00-cross-val) and submits to POST /api/v1/withdraw; the
// FakeLedger verifies the signature and debits ckBTC from the subaccount. The credited balance is
// verified DIRECTLY against the real relay's currency-1 balance before + after.
//
// Parallel-safe + isolated: a FRESH incognito context (distinct random pubkey) seeded with its own
// ckBTC; the withdraw nonce is app-generated (random 16 bytes, collision-free). Follows flow 05's
// pattern (seed → refresh → assert balance).
//
// Selector contract: `balance` (header → Balances), `asset-ckbtc` (the BTC row in Balances),
// `btn-withdraw` (the BTC row Cash-out, shown once funded), `withdraw-address-input`,
// `withdraw-amount-input`, `btn-withdraw-confirm`, `withdraw-status`, `btn-copy-destination` (L3),
// `btn-withdraw-close`. Asset segregation note (same as flow 05): ckBTC is currency 1, a SEPARATE
// asset from the `$` DEMO_USD header — the withdraw debits currency 1.
import { setup, assert, assertEq, seedDeposit, refreshDeposit, getBalance, onboardWallet, accountOf, openBalances } from '../harness/lib.mjs';

const DEPOSIT_CURRENCY = 1; // ckBTC — matches App.tsx DEPOSIT_CURRENCY
const SEED_SATS = 100_000;   // 0.00100000 BTC
const WITHDRAW_BTC = '0.00050000'; // 50_000 sats == retrieve_btc_min_amount
const WITHDRAW_SATS = 50_000;
const WITHDRAW_ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '15',
  name: 'withdraw',
  journey: 'withdraw',
  covers: ['withdraw', 'sign', 'settle', 'clipboard', 'balance-delta', 'destination-copy', 'ui-balance-delta'],
  verifies: 'Withdraw ckBTC: enter addr + amount → sign on-device → settle; success screen + Copy destination; balance debits at both the ledger AND the UI (Balances row drops to 0.00050000 BTC).',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[15-withdraw] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Onboard → wallet + capture this wallet's account.
    console.log('[15-withdraw] onboarding…');
    await onboardWallet(driver, 'e2e-withdraw');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);
    console.log(`[15-withdraw] wallet account: ${accountHex.slice(0, 16)}…`);

    // 2. Seed + credit ckBTC (currency 1) WITHOUT opening the deposit sheet: seed via the
    //    test-helpers route, then drain+credit via /deposit/refresh. The wallet's own 2.5s balance
    //    poll then picks up the credited currency-1 balance and renders the asset card.
    console.log(`[15-withdraw] seeding + crediting ${SEED_SATS} sats ckBTC…`);
    await seedDeposit(relayBaseURL, accountHex, DEPOSIT_CURRENCY, SEED_SATS);
    await refreshDeposit(relayBaseURL, accountHex, DEPOSIT_CURRENCY);
    const before = await getBalance(relayBaseURL, accountHex, DEPOSIT_CURRENCY);
    assertEq(before, String(SEED_SATS), 'pre-withdraw ckBTC balance');

    // 3. Open the Balances sheet; wait for the BTC row's Cash-out to appear (it renders once the
    //    balance poll credits currency 1 → funded). The asset row + withdraw affordance live here now.
    console.log('[15-withdraw] opening Balances; waiting for the ckBTC Cash-out…');
    await openBalances(driver);
    await driver.findByTestID('btn-withdraw', { timeoutMs: 8_000 });

    // 4. Open the Withdraw sheet via the asset card's "Withdraw" affordance.
    console.log('[15-withdraw] opening the withdraw sheet…');
    await driver.click('btn-withdraw', { timeoutMs: 5_000 });
    await driver.findByTestID('withdraw-address-input', { timeoutMs: 5_000 });

    // 5. Enter the BTC destination + amount (in BTC, >= the 0.0005 min), then confirm.
    await driver.type('withdraw-address-input', WITHDRAW_ADDR, { timeoutMs: 4_000 });
    await driver.type('withdraw-amount-input', WITHDRAW_BTC, { timeoutMs: 4_000 });
    // The review card appears once a valid amount is entered — proves the app parsed the BTC amount.
    await driver.findByTestID('withdraw-review-amount', { timeoutMs: 4_000 });
    const reviewTxt = await driver.readText('withdraw-review-amount');
    assert(reviewTxt.includes('0.00050000 BTC'), `review should show the BTC amount, got: "${reviewTxt}"`);

    console.log('[15-withdraw] confirming (signs on-device + submits to /api/v1/withdraw)…');
    await driver.click('btn-withdraw-confirm', { timeoutMs: 5_000 });

    // 6. Assert "Withdrawn ✓" — the app signed, submitted, the FakeLedger verified + debited.
    const ok = await driver.waitForText('Withdrawn', { timeoutMs: 10_000 });
    const body = await driver.bodyText();
    assert(ok, `withdraw sheet should show "Withdrawn ✓". body excerpt:\n${body.slice(0, 600)}`);

    // 7. The credited path proven directly on the real ledger: the currency-1 balance dropped by the
    //    withdrawn amount. (The `$` header is currency 0 — a separate asset; deliberately unmoved.)
    const after = await getBalance(relayBaseURL, accountHex, DEPOSIT_CURRENCY);
    assertEq(after, String(SEED_SATS - WITHDRAW_SATS), 'post-withdraw ckBTC balance (debited)');
    console.log(`[15-withdraw] ✓ ckBTC balance ${SEED_SATS} → ${after} sats (debited through the REAL app+relay+FakeLedger)`);

    await driver.screenshot('15-withdraw');

    // 8. L3 — the success screen exposes a Copy affordance for the destination address (previously a
    //    raw, long, un-copyable string). Prove the button exists, reads the shown address, and that
    //    clicking it writes the EXACT destination to the clipboard seam (real navigator.clipboard,
    //    not the Share noop — same regression surface as flow 04-deposit-copy).
    await driver.findByTestID('btn-copy-destination', { timeoutMs: 4_000 });
    const dest = await driver.readText('withdraw-destination');
    assertEq(dest, WITHDRAW_ADDR, 'destination address rendered on the success screen');
    const clipBefore = await driver.eval(() => window.__DPAY_TEST_CLIPBOARD);
    assertEq(clipBefore, '', 'clipboard seam empty before copy');
    await driver.click('btn-copy-destination', { timeoutMs: 4_000 });
    await driver.waitForText('Copied', { timeoutMs: 4_000 });
    const clipAfter = await driver.eval(() => window.__DPAY_TEST_CLIPBOARD);
    assertEq(clipAfter, WITHDRAW_ADDR, 'clipboard seam holds the destination after copy');
    console.log(`[15-withdraw] ✓ Copy destination wrote "${WITHDRAW_ADDR}" to the clipboard`);

    // 9. UI balance delta (closes the withdraw coverage gap): the relay-level delta is already proven
    //    in step 7 (after === SEED_SATS − WITHDRAW_SATS). This step proves the wallet SURFACE reflects
    //    the debit too — close the withdraw sheet, open the Balances hub, and assert the BTC row now
    //    shows the REDUCED remaining balance (0.00050000 BTC = 50000 sats), not the pre-withdraw
    //    0.00100000 BTC. This locks the UI↔ledger agreement (a stale facade `BAL_CACHE` would fail
    //    here, showing the old amount).
    await driver.click('btn-withdraw-close', { timeoutMs: 5_000 });
    await openBalances(driver);
    const reduced = await driver.waitForText('0.00050000 BTC', { timeoutMs: 10_000 });
    const balBody = await driver.bodyText();
    assert(reduced, `Balances BTC row should show the reduced 0.00050000 BTC (50000 sats remaining) after the withdraw. body excerpt:\n${balBody.slice(0, 500)}`);
    assert(!balBody.includes('0.00100000 BTC'), 'Balances must NOT still show the pre-withdraw 0.00100000 BTC (stale facade cache?)');
    console.log('[15-withdraw] ✓ UI ckBTC balance dropped to 0.00050000 BTC (matches the ledger delta)');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[15-withdraw] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[15-withdraw] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
