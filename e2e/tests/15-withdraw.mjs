// Flow 15 — Withdraw ckBTC to a native BTC address over the IC user-principal rail (W2).
//
// Proves the WITHDRAWAL path (the one-way valve's other direction) end-to-end through the REAL
// app + fake-IC gateway: the "Send to address" sheet signs BOTH envelopes ON-DEVICE (the DpayCore
// wasm shim — byte-exact vs the Rust core, proven in 00-cross-val): icrc2_approve(spender=minter)
// for the EXACT amount on the ckBTC ledger (carrying the live icrc1_fee), then
// retrieve_btc_with_approval on the minter — each POSTed straight to
// /api/v2/canister/<canister>/call with a read_state poll reconciling the outcome (the minter's
// Ok(record{block_index}) reply decoded by rail.ts's frozen-shape parser). The gateway burns the
// approved amount at the user's PRINCIPAL; the debit is verified DIRECTLY against the relay's
// balance route before + after, AND the UI Balances row drops.
//
// Balances are PER-LEDGER on the fake gateway (real ICRC semantics): funding a currency credits
// ITS ledger at the wallet principal only — the onboarding ∂100 DEMO credit (currency 0) does not
// touch it. The ckBTC catalog row carries fee None (the gateway's icrc1_fee answers 0), so the
// debit is EXACTLY the withdrawn amount.
//
// MAINNET ckBTC (currency 1) — the prod-shaped path, no testnet toggle. (History: the old fake
// catalog gave ckTESTBTC the SAME CKBTC minter text as ckBTC, and the gateway's minter→home-ledger
// map is keyed by MINTER TEXT (last row wins), which made a currency-1 approve land on the wrong
// ledger — "insufficient allowance" on the FAKE only. Since the 2026-08-28 transplant to the REAL
// prod rows, ckTESTBTC has its own minter principal (ml52i-…), so currency 1 is consistently
// wired and this flow drives it directly.)
//
// Selector contract: `balance` (header → Balances), `asset-ckbtc-select` (the row whole-row
// select), `btn-pay-send` (Pay → "Send to address"), `send-address-input` (the ONE shared
// destination field — SendSheet/AddressField own it), `send-status` (the route disclosure under
// the field), `withdraw-amount-input`, `btn-withdraw-confirm`, `withdraw-status`,
// `btn-copy-destination` (L3), `btn-withdraw-done` (success-screen Done),
// `btn-pay-scan` (flip back to scan).
import { setup, assert, assertEq, assertIncludes, faucetAccount, getBalance, onboardWallet, accountOf, openBalances, selectCurrency, openPaySend } from '../harness/lib.mjs';

const BTC_CURRENCY = 1; // ckBTC (mainnet) — the CkBtcUtxo withdraw path (see the header note)
const BTC_ASSET_KEY = 'ckbtc';
const SEED_SATS = 100_000;   // = 0.00100000 BTC
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
  covers: ['withdraw', 'icrc2-approve', 'retrieve_btc_with_approval', 'sign', 'settle', 'clipboard', 'balance-delta', 'destination-copy', 'ui-balance-delta'],
  verifies: 'Withdraw ckBTC: faucet-fund at the principal → enter addr + amount → sign approve + retrieve on-device → gateway burns → "Withdrawn ✓" + Copy destination; balance debits at both the gateway AND the UI (row drops to 0.0005 BTC).',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[15-withdraw] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Onboard → wallet + capture this wallet's account (pubkey hex → self-authenticating
    //    principal — the key the fake-IC gateway balances are recorded under).
    console.log('[15-withdraw] onboarding…');
    await onboardWallet(driver, 'e2e-withdraw');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);
    console.log(`[15-withdraw] wallet account: ${accountHex.slice(0, 16)}…`);

    // 2. Fund the ckBTC rail at the wallet's PRINCIPAL via the faucet (test-helpers). The ckBTC
    //    ledger row carries fee None (icrc1_fee answers 0), so the bucket reads back EXACTLY the
    //    seeded sats.
    console.log(`[15-withdraw] faucet-funding ${SEED_SATS} sats (currency ${BTC_CURRENCY})…`);
    const fund = await faucetAccount(relayBaseURL, accountHex, SEED_SATS, { currency: BTC_CURRENCY });
    assert(fund.ok, `faucet funding must succeed, got HTTP ${fund.status}: ${JSON.stringify(fund.body)}`);
    const before = await getBalance(relayBaseURL, accountHex, BTC_CURRENCY);
    assertEq(before, String(SEED_SATS), 'pre-withdraw ckBTC balance at the principal (per-ledger bucket)');

    // 3. Open the Balances sheet, wait for the ckBTC row to appear FUNDED (the balance poll picks
    //    up the faucet credit), then SELECT it (makes it the active asset).
    console.log('[15-withdraw] opening Balances; waiting for the funded BTC row…');
    await openBalances(driver);
    await driver.waitForText('0.001 BTC', { timeoutMs: 8_000 });

    // 4. Select the BTC asset → Pay → "Send to address" (the inline WithdrawSheet body).
    console.log('[15-withdraw] selecting BTC → Pay → Send to address…');
    await selectCurrency(driver, BTC_ASSET_KEY);
    await openPaySend(driver);
    await driver.findByTestID('send-address-input', { timeoutMs: 5_000 });

    // 5. Paste the BTC destination into the ONE shared field. A native-chain address routes to the
    //    chain-key offramp, so the route line quotes BITCOIN's economics (~10 min, 0.0005 BTC
    //    minimum — not the IC's seconds-and-a-flat-fee) and the WithdrawSheet body, which owns the
    //    amount rules, renders below it. Then enter the amount (>= the 0.0005 min) and confirm.
    await driver.type('send-address-input', WITHDRAW_ADDR, { timeoutMs: 4_000 });
    const routeTxt = await driver.readText('send-status', { timeoutMs: 4_000 });
    assertEq(routeTxt, 'Bitcoin · about 10 min · minimum 0.0005 BTC', 'the route line discloses the Bitcoin burn before the user commits');
    await driver.findByTestID('withdraw-amount-input', { timeoutMs: 5_000 });
    const sheetBody = await driver.bodyText();
    assertIncludes(sheetBody, 'native BTC address', 'the withdraw sheet presents the BTC destination surface');
    await driver.type('withdraw-amount-input', WITHDRAW_BTC, { timeoutMs: 4_000 });
    // The review card appears once a valid amount is entered — proves the app parsed the BTC amount.
    await driver.findByTestID('withdraw-review-amount', { timeoutMs: 4_000 });
    const reviewTxt = await driver.readText('withdraw-review-amount');
    assert(reviewTxt.includes('0.0005 BTC'), `review should show the BTC amount, got: "${reviewTxt}"`);

    console.log('[15-withdraw] confirming (signs approve + retrieve on-device, POSTs to /api/v2)…');
    await driver.click('btn-withdraw-confirm', { timeoutMs: 5_000 });

    // 6. Assert "Withdrawn ✓" — the app signed both envelopes, the gateway executed the approve +
    //    burn. The submit path fetches the certified IC clock (read_state), fetches the ledger's
    //    icrc1_fee, submits each envelope, and polls read_state to terminal state.
    const ok = await driver.waitForText('Withdrawn', { timeoutMs: 15_000 });
    const body = await driver.bodyText();
    assert(ok, `withdraw sheet should show "Withdrawn ✓". body excerpt:\n${body.slice(0, 600)}`);

    // 7. The debited path proven directly on the fake-IC gateway: the ckBTC balance dropped by
    //    the withdrawn amount plus the LEDGER's own fee — 10 sats, measured off the real ckBTC
    //    ledger (icrc1_fee) and pinned in the catalog 2026-09-18.
    const after = await getBalance(relayBaseURL, accountHex, BTC_CURRENCY);
    assertEq(after, String(SEED_SATS - WITHDRAW_SATS - 10), 'post-withdraw ckBTC balance (burned at the principal, plus the ledger fee)');
    console.log(`[15-withdraw] ✓ ckBTC balance ${before} → ${after} sats (approve + retrieve_btc_with_approval through the REAL app+gateway)`);

    await driver.screenshot('15-withdraw');

    // 8. L3 — the success screen exposes a Copy affordance for the destination address. Prove the
    //    button exists, reads the shown address, and that clicking it writes the EXACT destination
    //    to the clipboard seam (real navigator.clipboard, not the Share noop).
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

    // 9. UI balance delta (closes the withdraw coverage gap): the gateway-level delta is already
    //    proven in step 7. This step proves the wallet SURFACE reflects the debit too — flip the
    //    toggle back to "Scan to pay" (hides the inline withdraw body), open the Balances hub,
    //    and assert the ckBTC row now shows the REDUCED remaining balance (0.0005 BTC compact =
    //    50000 sats), not the pre-withdraw 0.00100000 BTC. This locks the UI↔gateway agreement
    //    (a stale balance cache would fail here).
    await driver.click('btn-pay-scan', { timeoutMs: 5_000 });
    await openBalances(driver);
    // 49_990 sats remain (the burn plus the pinned 10-sat ledger fee) — the row states it exactly.
    const reduced = await driver.waitForText('0.0004999 BTC', { timeoutMs: 10_000 });
    const balBody = await driver.bodyText();
    assert(reduced, `Balances ckBTC row should show the reduced 0.0004999 BTC (49990 sats remaining) after the withdraw. body excerpt:\n${balBody.slice(0, 500)}`);
    assert(!balBody.includes('0.001 BTC'), 'Balances must NOT still show the pre-withdraw 0.001 BTC (stale balance cache?)');
    console.log('[15-withdraw] ✓ UI ckBTC balance dropped to 0.0005 BTC (matches the gateway delta)');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[15-withdraw] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[15-withdraw] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
