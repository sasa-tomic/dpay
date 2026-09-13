// Flow 44 — Withdraw native ckETH to a native ETH address over the IC user-principal rail (W2).
//
// Proves the NATIVE-ETH send path end-to-end through the REAL app + fake-IC gateway: the wallet's
// native-ETH asset (currency 6, CkEthErc20 family with token_contract == null) reaches the SAME
// "Send to address" sheet, family-dispatched to the ETH branch — the app queries the minter's
// eip_1559_transaction_price for the live gas quote, signs BOTH envelopes ON-DEVICE (the DpayCore
// wasm shim — byte-exact vs the Rust core, proven in 00-cross-val): icrc2_approve(spender=minter)
// for amount+gas on the ckETH ledger (carrying the live icrc1_fee), then withdraw_eth on the
// minter — each POSTed straight to /api/v2/canister/<canister>/call with a read_state poll
// reconciling the outcome (the minter's Ok(record{block_index}) reply decoded by rail.ts's
// frozen-shape parser). Because token_contract is null the sheet shows NO "ckETH for gas" note
// (that hint is the ckERC20 discriminator — asserted here to lock the family dispatch).
//
// Balances are PER-LEDGER on the fake gateway (real ICRC semantics): funding currency 6 credits
// the ckETH ledger at the wallet principal only. The REAL ckETH ledger row (since the 2026-08-28
// catalog transplant) carries a 2e12 Wei (0.000002 ETH) icrc1_fee: the APPROVE step debits that
// fee, and the minter burn debits the withdrawn Wei, so the honest post-withdraw expectation is
// SEED − fee − amount (3.999998e18 Wei — the '998' sits at the 10^15 place, which display-truncation to 6 places keeps visible: '3.999998 ETH').
//
// BigInt discipline: 18-dec Wei exceeds 2^53, so raw values are BigInt and every amount that
// crosses an HTTP boundary is a decimal STRING (the relay's U64String parses it losslessly).
//
// Selector contract: `asset-cketh-select` (the native-ETH row whole-row select), `btn-pay-send`
// (Pay → "Send to address"), `send-address-input` (the ONE shared destination field —
// SendSheet/AddressField own it), `send-status` (the route disclosure under the field),
// `withdraw-amount-input`, `btn-withdraw-confirm`, `withdraw-status`, `btn-copy-destination`,
// `btn-pay-scan` (flip back to scan). Asset segregation note: native ETH is currency 6, a SEPARATE
// asset from the `$` DEMO_USD header (currency 0) — the withdraw debits currency 6 only.
import { setup, assert, assertEq, faucetAccount, getBalance, onboardWallet, accountOf, openBalances, selectCurrency, openPaySend } from '../harness/lib.mjs';

const NATIVE_ETH_CURRENCY = 6; // native ckETH — CkEthErc20 + token_contract == null (family dispatch)
// 18-dec Wei. Plain JS numbers lose precision above 2^53 (~9e15), so every raw value is a BigInt and
// every amount that crosses an HTTP boundary is a decimal STRING.
const SEED_WEI = 5_000_000_000_000_000_000n; // 5 ETH
const APPROVE_FEE_WEI = 2_000_000_000_000n; // the REAL ckETH ledger's icrc1_fee (2e12 Wei = 0.000002 ETH, from the prod catalog row)
const WITHDRAW_ETH = '1'; // user enters "1" (ETH) — the app converts to 1e18 Wei via toUnits(_, 18)
const WITHDRAW_WEI = 1_000_000_000_000_000_000n; // 1 ETH = 1e18 Wei (the minter burn amount)
// A valid native-ETH destination: 0x + 40 hex (the app's isValidDestinationAddress regex for CkEthErc20).
const WITHDRAW_ADDR = '0x000000000000000000000000000000000000dead';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '44',
  name: 'cketh-withdraw',
  journey: 'withdraw',
  covers: ['native-eth-withdraw', 'cketh', 'family-dispatch', 'withdraw', 'icrc2-approve', 'withdraw_eth', 'gas-quote', 'sign', 'settle', 'balance-delta', 'ui-balance-delta'],
  verifies: 'Withdraw native ckETH: faucet-fund at the principal → enter 0x addr + ETH amount → query the minter gas price + sign approve + withdraw_eth on-device → gateway burns → "Withdrawn ✓"; balance debits fee+amount at both the gateway AND the UI (row drops to 3.999998 ETH).',
  timeoutMs: 25000,
};

export async function run() {
  const start = Date.now();
  console.log('[44-cketh-withdraw] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Onboard → wallet + capture this wallet's account (pubkey hex → self-authenticating
    //    principal — the key the fake-IC gateway balances are recorded under).
    console.log('[44-cketh-withdraw] onboarding…');
    await onboardWallet(driver, 'e2e-cketh');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);
    console.log(`[44-cketh-withdraw] wallet account: ${accountHex.slice(0, 16)}…`);

    // 2. Fund the ckETH rail at the wallet's PRINCIPAL via the faucet (test-helpers). The amount
    //    is an 18-dec Wei decimal STRING (exceeds 2^53 — a raw JSON number would lose precision in
    //    JS before the request body was even built). Per-ledger buckets make it read back EXACTLY.
    console.log(`[44-cketh-withdraw] faucet-funding ${SEED_WEI} Wei (currency ${NATIVE_ETH_CURRENCY})…`);
    const fund = await faucetAccount(relayBaseURL, accountHex, String(SEED_WEI), { currency: NATIVE_ETH_CURRENCY });
    assert(fund.ok, `faucet funding must succeed, got HTTP ${fund.status}: ${JSON.stringify(fund.body)}`);
    const before = await getBalance(relayBaseURL, accountHex, NATIVE_ETH_CURRENCY);
    assertEq(before, String(SEED_WEI), 'pre-withdraw native-ETH balance at the principal (per-ledger bucket)');

    // 3. Open the Balances sheet; wait for the native-ETH row to appear funded (the balance poll
    //    picks up the faucet credit), then SELECT ckETH (makes it the active asset).
    console.log('[44-cketh-withdraw] opening Balances; waiting for the funded ckETH row…');
    await openBalances(driver);
    await driver.waitForText('5 ETH', { timeoutMs: 8_000 });

    // 4. Select ckETH → Pay → "Send to address" (the inline WithdrawSheet body, family-dispatched
    //    to the native-ETH withdraw_eth branch).
    console.log('[44-cketh-withdraw] selecting ckETH → Pay → Send to address…');
    await selectCurrency(driver, 'cketh');
    await openPaySend(driver);
    await driver.findByTestID('send-address-input', { timeoutMs: 5_000 });

    // 5. Paste the ETH destination into the ONE shared field. A native-chain address routes to the
    //    chain-key offramp, so the route line quotes ETHEREUM's economics and the WithdrawSheet
    //    body renders below it, family-dispatched to the withdraw_eth branch.
    await driver.type('send-address-input', WITHDRAW_ADDR, { timeoutMs: 4_000 });
    const routeTxt = await driver.readText('send-status', { timeoutMs: 4_000 });
    assertEq(routeTxt, 'Ethereum · about 1 min · minimum 0.01 ETH', 'the route line discloses the Ethereum burn before the user commits');
    await driver.findByTestID('withdraw-amount-input', { timeoutMs: 5_000 });

    // 5b. Family-dispatch discriminator, asserted on the RENDERED native body: token_contract ==
    //     null → NO "ckETH for gas" hint (that note only renders for ckERC20 sends — flow 48
    //     asserts its presence there). Checked only once the body exists, so the absence is a real
    //     dispatch fact rather than the body simply not being on screen yet.
    const gasNotePresent = await driver.isPresent('withdraw-gas-note');
    assert(!gasNotePresent, 'native-ETH sheet must NOT show the ckERC20 "ckETH for gas" note (family dispatch)');

    // Enter the amount (in ETH, >= the 0.01 ETH local floor), then confirm.
    await driver.type('withdraw-amount-input', WITHDRAW_ETH, { timeoutMs: 4_000 });
    // The review card appears once a valid amount is entered — proves the app parsed the ETH amount
    // at 18-dec Wei precision (compact display: trailing zeros trimmed, ckETH has no min fraction).
    await driver.findByTestID('withdraw-review-amount', { timeoutMs: 4_000 });
    const reviewTxt = await driver.readText('withdraw-review-amount');
    assert(reviewTxt.includes('1 ETH'), `review should show the ETH amount compact, got: "${reviewTxt}"`);

    console.log('[44-cketh-withdraw] confirming (gas query + signs approve + withdraw_eth on-device, POSTs to /api/v2)…');
    await driver.click('btn-withdraw-confirm', { timeoutMs: 5_000 });

    // 6. Assert "Withdrawn ✓" — the app fetched the certified IC clock, the minter's gas quote,
    //    the ledger's icrc1_fee, signed both envelopes, and the gateway executed the approve + burn.
    const ok = await driver.waitForText('Withdrawn', { timeoutMs: 15_000 });
    const body = await driver.bodyText();
    assert(ok, `withdraw sheet should show "Withdrawn ✓". body excerpt:\n${body.slice(0, 600)}`);

    // 7. The debited path proven directly on the fake-IC gateway: the currency-6 balance dropped by
    //    the APPROVE FEE (the ckETH ledger's icrc1_fee, charged on the approve call) + the
    //    withdrawn Wei (the minter burn). BigInt arithmetic — the raw values exceed 2^53 (the
    //    DEMO `$` header is currency 0, a separate per-ledger bucket; deliberately unmoved).
    const after = await getBalance(relayBaseURL, accountHex, NATIVE_ETH_CURRENCY);
    assertEq(after, String(SEED_WEI - APPROVE_FEE_WEI - WITHDRAW_WEI), 'post-withdraw native-ETH balance (approve fee + minter burn)');
    console.log(`[44-cketh-withdraw] ✓ native-ETH balance ${before} → ${after} Wei (approve + withdraw_eth through the REAL app+gateway)`);

    await driver.screenshot('44-cketh-withdraw');

    // 8. L3 — the success screen exposes a Copy affordance for the destination address (same surface
    //    as the BTC send, flow 15). Prove the button exists + writes the EXACT destination to the
    //    clipboard seam.
    await driver.findByTestID('btn-copy-destination', { timeoutMs: 4_000 });
    const dest = await driver.readText('withdraw-destination');
    assertEq(dest, WITHDRAW_ADDR, 'destination address rendered on the success screen');
    const clipBefore = await driver.eval(() => window.__DPAY_TEST_CLIPBOARD);
    assertEq(clipBefore, '', 'clipboard seam empty before copy');
    await driver.click('btn-copy-destination', { timeoutMs: 4_000 });
    await driver.waitForText('Copied', { timeoutMs: 4_000 });
    const clipAfter = await driver.eval(() => window.__DPAY_TEST_CLIPBOARD);
    assertEq(clipAfter, WITHDRAW_ADDR, 'clipboard seam holds the destination after copy');
    console.log(`[44-cketh-withdraw] ✓ Copy destination wrote "${WITHDRAW_ADDR}" to the clipboard`);

    // 9. UI balance delta (locks the UI↔gateway agreement): flip the toggle back to "Scan to pay"
    //    (hides the inline withdraw body), re-open the Balances hub, and assert the ETH row now
    //    shows the REDUCED remaining balance (3.999998 ETH — display-TRUNCATED to 6 places from
    //    3.999998e18 Wei), not the pre-withdraw 5 ETH. A stale balance cache would fail here.
    await driver.click('btn-pay-scan', { timeoutMs: 5_000 });
    await openBalances(driver);
    const reduced = await driver.waitForText('3.999998 ETH', { timeoutMs: 10_000 });
    const balBody = await driver.bodyText();
    assert(reduced, `Balances ETH row should show the reduced 3.999998 ETH (${SEED_WEI - APPROVE_FEE_WEI - WITHDRAW_WEI} Wei remaining, display-truncated to 6) after the withdraw. body excerpt:\n${balBody.slice(0, 500)}`);
    assert(!balBody.includes('5.000000 ETH'), 'Balances must NOT still show the pre-withdraw 5 ETH (stale balance cache?)');
    console.log('[44-cketh-withdraw] ✓ UI native-ETH balance dropped to 3.999998 ETH (matches the gateway delta)');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[44-cketh-withdraw] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[44-cketh-withdraw] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
