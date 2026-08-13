// Flow 44 — Withdraw native ckETH to a native ETH address (the family-dispatch UI path).
//
// Proves the NATIVE-ETH send path end-to-end through the REAL app + relay + FakeLedger: the
// wallet's native-ETH asset card (currency 5, CkEthErc20 family with token_contract == null) exposes
// a "Send" affordance (the no-swap offramp gate — `offramp !== Unavailable` AND the family's
// native-ETH discriminator); opening it signs a WithdrawAuth ON-DEVICE at 18-dec Wei precision and
// submits to POST /api/v1/withdraw; the FakeLedger's family-aware `withdraw` verifies the signature
// and debits ckETH from the subaccount (the BTC-family retrieve_btc_min_amount floor does NOT apply —
// the ckETH minter enforces its own governed minimum). The credited balance is verified DIRECTLY
// against the real relay's currency-5 balance before + after, AND the UI Balances row drops.
//
// This is the browser-driven proof of the canister's family dispatch (CkBtcUtxo vs native-ETH
// CkEthErc20) that the PocketIC canister tests (73) prove at the settlement layer and the jest
// golden UI tests prove at the render layer — but NO prior browser flow exercised, because the
// FakeLedger catalog had no native-ETH currency. Flow 15 (BTC) + flow 44 (native ETH) now cover both
// family branches of the withdraw surface.
//
// Parallel-safe + isolated: a FRESH incognito context (distinct random pubkey) seeded with its own
// ckETH; the withdraw nonce is app-generated (random 16 bytes, collision-free). Follows flow 15's
// pattern (seed → refresh → assert balance) but at 18-dec Wei precision (BigInt — the raw values
// exceed 2^53, so plain JS number arithmetic would lose precision).
//
// Selector contract: `asset-cketh-select` (the native-ETH row whole-row select — only ONE on-chain
// asset is funded in this flow so the select is unambiguous), `btn-pay-send` (Pay → "Send to
// address"), `withdraw-address-input`, `withdraw-amount-input`, `btn-withdraw-confirm`,
// `withdraw-status`, `btn-copy-destination`, `btn-pay-scan` (flip back to scan). Asset segregation
// note: native ETH is currency 5, a SEPARATE asset from the `$` DEMO_USD header (currency 0) — the
// withdraw debits currency 5.
import { setup, assert, assertEq, seedDeposit, refreshDeposit, getBalance, onboardWallet, accountOf, openBalances, selectCurrency, openPaySend } from '../harness/lib.mjs';

const NATIVE_ETH_CURRENCY = 5; // native ckETH — CkEthErc20 + token_contract == null (matches App catalog)
// 18-dec Wei. Plain JS numbers lose precision above 2^53 (~9e15), so every raw value is a BigInt and
// every amount that crosses an HTTP boundary is a decimal STRING (the relay's U64String accepts both).
const SEED_WEI = 5_000_000_000_000_000_000n; // 5 ETH
const WITHDRAW_ETH = '1'; // user enters "1" (ETH) — the app converts to 1e18 Wei via toUnits(_, 18)
const WITHDRAW_WEI = 1_000_000_000_000_000_000n; // 1 ETH = 1e18 Wei
// A valid native-ETH destination: 0x + 40 hex (the app's isValidDestinationAddress regex for CkEthErc20).
const WITHDRAW_ADDR = '0x000000000000000000000000000000000000dead';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '44',
  name: 'cketh-withdraw',
  journey: 'withdraw',
  covers: ['native-eth-withdraw', 'cketh', 'family-dispatch', 'withdraw', 'sign', 'settle', 'balance-delta', 'ui-balance-delta'],
  verifies: 'Withdraw native ckETH: Cash-out button renders for a CkEthErc20 + token_contract=null asset; enter 0x addr + ETH amount → sign on-device at 18-dec Wei → settle; balance debits at both the ledger AND the UI (family-dispatch UI path).',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[44-cketh-withdraw] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Onboard → wallet + capture this wallet's account.
    console.log('[44-cketh-withdraw] onboarding…');
    await onboardWallet(driver, 'e2e-cketh');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);
    console.log(`[44-cketh-withdraw] wallet account: ${accountHex.slice(0, 16)}…`);

    // 2. Seed + credit native ETH (currency 5) WITHOUT opening the deposit sheet: seed via the
    //    test-helpers route, then drain+credit via /deposit/refresh. The amount is an 18-dec Wei
    //    decimal STRING (exceeds 2^53 — the U64String deserializer parses it; a raw JSON number would
    //    lose precision in JS before the request body was even built). The wallet's own balance poll
    //    then picks up the credited currency-5 balance and renders the native-ETH asset card.
    console.log(`[44-cketh-withdraw] seeding + crediting ${SEED_WEI} Wei (${Number(SEED_WEI / WITHDRAW_WEI)} ETH)…`);
    await seedDeposit(relayBaseURL, accountHex, NATIVE_ETH_CURRENCY, String(SEED_WEI));
    await refreshDeposit(relayBaseURL, accountHex, NATIVE_ETH_CURRENCY);
    const before = await getBalance(relayBaseURL, accountHex, NATIVE_ETH_CURRENCY);
    assertEq(before, String(SEED_WEI), 'pre-withdraw native-ETH balance');

    // 3. Open the Balances sheet; wait for the native-ETH row to appear funded (the balance poll
    //    credits currency 5), then SELECT ckETH → Pay → "Send to address" (the inline withdraw body,
    //    family-dispatched to native-ETH withdraw_eth). The send is no longer a per-row Balances
    //    button — it lives in the Pay tab.
    console.log('[44-cketh-withdraw] opening Balances; waiting for the funded ckETH row…');
    await openBalances(driver);
    await driver.waitForText('5.000000 ETH', { timeoutMs: 8_000 });

    // 4. Select ckETH → Pay → "Send to address". The sheet title reads "Send Ethereum" (native-ETH).
    console.log('[44-cketh-withdraw] selecting ckETH → Pay → Send to address…');
    await selectCurrency(driver, 'cketh');
    await openPaySend(driver);
    await driver.findByTestID('withdraw-address-input', { timeoutMs: 5_000 });

    // 5. Enter the ETH destination + amount (in ETH, >= the 0.001 ETH local floor), then confirm.
    await driver.type('withdraw-address-input', WITHDRAW_ADDR, { timeoutMs: 4_000 });
    await driver.type('withdraw-amount-input', WITHDRAW_ETH, { timeoutMs: 4_000 });
    // The review card appears once a valid amount is entered — proves the app parsed the ETH amount
    // at 18-dec Wei precision (display shows 6 fractional places via display_decimals).
    await driver.findByTestID('withdraw-review-amount', { timeoutMs: 4_000 });
    const reviewTxt = await driver.readText('withdraw-review-amount');
    assert(reviewTxt.includes('1.000000 ETH'), `review should show the ETH amount at 6-dec display precision, got: "${reviewTxt}"`);

    console.log('[44-cketh-withdraw] confirming (signs on-device + submits to /api/v1/withdraw)…');
    await driver.click('btn-withdraw-confirm', { timeoutMs: 5_000 });

    // 6. Assert "Withdrawn ✓" — the app signed, submitted, the FakeLedger verified + debited.
    const ok = await driver.waitForText('Withdrawn', { timeoutMs: 10_000 });
    const body = await driver.bodyText();
    assert(ok, `withdraw sheet should show "Withdrawn ✓". body excerpt:\n${body.slice(0, 600)}`);

    // 7. The credited path proven directly on the real ledger: the currency-5 balance dropped by the
    //    withdrawn Wei. BigInt arithmetic — the raw values exceed 2^53 (the DEMO `$` header is
    //    currency 0, a separate asset; deliberately unmoved).
    const after = await getBalance(relayBaseURL, accountHex, NATIVE_ETH_CURRENCY);
    assertEq(after, String(SEED_WEI - WITHDRAW_WEI), 'post-withdraw native-ETH balance (debited)');
    console.log(`[44-cketh-withdraw] ✓ native-ETH balance ${SEED_WEI} → ${after} Wei (debited through the REAL app+relay+FakeLedger)`);

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

    // 9. UI balance delta (locks the UI↔ledger agreement): flip the toggle back to "Scan to pay"
    //    (hides the inline withdraw body), re-open the Balances hub, and assert the ETH row now shows
    //    the REDUCED remaining balance (4.000000 ETH = 4e18 Wei), not the pre-withdraw 5 ETH.
    await driver.click('btn-pay-scan', { timeoutMs: 5_000 });
    await openBalances(driver);
    const reduced = await driver.waitForText('4.000000 ETH', { timeoutMs: 10_000 });
    const balBody = await driver.bodyText();
    assert(reduced, `Balances ETH row should show the reduced 4.000000 ETH (4e18 Wei remaining) after the withdraw. body excerpt:\n${balBody.slice(0, 500)}`);
    assert(!balBody.includes('5.000000 ETH'), 'Balances must NOT still show the pre-withdraw 5 ETH (stale facade cache?)');
    console.log('[44-cketh-withdraw] ✓ UI native-ETH balance dropped to 4.000000 ETH (matches the ledger delta)');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[44-cketh-withdraw] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[44-cketh-withdraw] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
