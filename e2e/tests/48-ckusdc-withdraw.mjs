// Flow 48 — Withdraw ckUSDC to a native Ethereum address (the ckERC-20 dual-ledger send path).
//
// Proves the ckERC-20 CASH-OUT path end-to-end through the REAL app + relay + FakeLedger: the
// wallet's ckUSDC asset card (currency 2, CkEthErc20 family with token_contract Some) exposes a
// "Cash out" affordance (the flipped cashable gate — `offramp !== Unavailable` AND a known
// CkEthErc20 family, NO `token_contract == null` restriction); opening it signs a WithdrawAuth
// ON-DEVICE at 6-dec micro-unit precision, surfaces an honest "You need ckETH for gas" note
// (Fork-C — dpay never converts ckUSDC→ckETH, no-swap), and submits to POST /api/v1/withdraw; the
// FakeLedger's family-aware `withdraw` verifies the signature and debits ckUSDC from the subaccount
// (the BTC-family retrieve_btc_min_amount floor does NOT apply — ckERC20 has no local floor). The
// credited balance is verified DIRECTLY against the real relay's currency-2 balance before + after,
// AND the UI Balances row drops.
//
// This is the browser-driven proof of the canister's dual-ledger `withdraw_erc20` family dispatch
// that the PocketIC canister tests (81/81) prove at the settlement layer. The FakeLedger does NOT
// model the dual-ledger gas burn (it debits only the requested amount) — that's by design: the
// canister PocketIC tests prove the real dual-ledger flow (approve ckETH gas ledger + ckERC20 amount
// ledger → minter withdraw_erc20, incl. partial-failure SETTLE), and this e2e proves the
// UI↔relay↔FakeLedger wiring + the cashable-gate flip + the gas-dependency UX note. Flow 15 (BTC) +
// flow 44 (native ETH) + flow 48 (ckERC20) now cover ALL three family branches of the withdraw
// surface.
//
// Parallel-safe + isolated: a FRESH incognito context (distinct random pubkey) seeded with its own
// ckUSDC; the withdraw nonce is app-generated (random 16 bytes, collision-free). Follows flow 44's
// pattern (seed → refresh → assert balance) but at 6-dec USDC precision.
//
// Selector contract: `asset-ckusdc-select` (the ckUSDC row whole-row select), `btn-pay-send`
// (Pay → "Send to address"), `withdraw-address-input`, `withdraw-amount-input`,
// `withdraw-gas-note` (the ckETH-gas-dependency note — renders ONLY for a ckERC20 token),
// `btn-withdraw-confirm`, `withdraw-status`, `btn-pay-scan` (flip back to scan). Asset segregation
// note: ckUSDC is currency 2, a SEPARATE asset from the `$` DEMO_USD header (currency 0).
import { setup, assert, assertEq, seedDeposit, refreshDeposit, getBalance, onboardWallet, accountOf, openBalances, selectCurrency, openPaySend } from '../harness/lib.mjs';

const CKUSDC_CURRENCY = 2; // ckUSDC — CkEthErc20 + token_contract Some (matches App + relay catalog)
// 6-dec micro-units. The raw values here stay well under 2^53, so plain JS numbers are safe; the
// decimal-STRING contract is kept anyway (the relay's U64String accepts both, and it future-proofs
// against a larger seed).
const SEED_RAW = 1_000_000_000; // 1000 USDC @ 6 dec = 1e9 raw
const WITHDRAW_USDC = '1'; // user enters "1" (USDC) — the app converts to 1e6 raw via toUnits(_, 6)
const WITHDRAW_RAW = 1_000_000; // 1 USDC @ 6 dec = 1e6 raw
// A valid Ethereum destination: 0x + 40 hex (the app's isValidDestinationAddress regex for CkEthErc20).
const WITHDRAW_ADDR = '0x000000000000000000000000000000000000dead';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '48',
  name: 'ckusdc-withdraw',
  journey: 'withdraw',
  covers: ['ckerc20-offramp', 'cashable-gate', 'ckusdc', 'withdraw', 'sign', 'settle', 'balance-delta', 'ui-balance-delta', 'gas-note'],
  verifies: 'ckUSDC Cash-out: the flipped cashable gate renders Cash-out for a ckERC20 token; enter 0x addr + USDC amount → gas-dependency note renders → sign on-device at 6-dec → settle; balance debits at both the ledger AND the UI.',
  timeoutMs: 15000,
};

export async function run() {
  const start = Date.now();
  console.log('[48-ckusdc-withdraw] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Onboard → wallet + capture this wallet's account.
    console.log('[48-ckusdc-withdraw] onboarding…');
    await onboardWallet(driver, 'e2e-ckusdc');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);
    console.log(`[48-ckusdc-withdraw] wallet account: ${accountHex.slice(0, 16)}…`);

    // 2. Seed + credit ckUSDC (currency 2) WITHOUT opening the deposit sheet: seed via the
    //    test-helpers route, then drain+credit via /deposit/refresh. The wallet's own balance poll
    //    then picks up the credited currency-2 balance and renders the ckUSDC asset card as funded,
    //    which passes the flipped cashable gate (offramp=Direct + CkEthErc20 family).
    console.log(`[48-ckusdc-withdraw] seeding + crediting ${SEED_RAW} raw (${SEED_RAW / 1_000_000} USDC)…`);
    await seedDeposit(relayBaseURL, accountHex, CKUSDC_CURRENCY, String(SEED_RAW));
    await refreshDeposit(relayBaseURL, accountHex, CKUSDC_CURRENCY);
    const before = await getBalance(relayBaseURL, accountHex, CKUSDC_CURRENCY);
    assertEq(before, String(SEED_RAW), 'pre-withdraw ckUSDC balance');

    // 3. Open the Balances sheet; wait for the ckUSDC row to appear funded (the balance poll credits
    //    currency 2), then SELECT ckUSDC → Pay → "Send to address" (the inline withdraw body,
    //    family-dispatched to the dual-ledger withdraw_erc20 path). The send is no longer a per-row
    //    Balances button.
    console.log('[48-ckusdc-withdraw] opening Balances; waiting for the funded ckUSDC row…');
    await openBalances(driver);
    await driver.waitForText('1000.000000 USDC', { timeoutMs: 8_000 });

    // 4. Select ckUSDC → Pay → "Send to address". The sheet title reads "Send Ethereum" (the ckUSDC
    //    family display's networkLabel — the settlement NETWORK, not the asset).
    console.log('[48-ckusdc-withdraw] selecting ckUSDC → Pay → Send to address…');
    await selectCurrency(driver, 'ckusdc');
    await openPaySend(driver);
    await driver.findByTestID('withdraw-address-input', { timeoutMs: 5_000 });

    // 5. Assert the ckETH gas-dependency note renders (Fork-C — no-swap honesty). It appears ONLY for
    //    a ckERC20 token (token_contract Some); a native-ETH or BTC withdraw sheet does NOT show it.
    //    This is the honest "you need ckETH for gas" UX — dpay never converts ckUSDC→ckETH.
    await driver.findByTestID('withdraw-gas-note', { timeoutMs: 5_000 });
    const gasNoteBody = await driver.bodyText();
    assert(gasNoteBody.includes('ckETH for gas'), `the gas-dependency note should mention ckETH. body excerpt:\n${gasNoteBody.slice(0, 500)}`);
    console.log('[48-ckusdc-withdraw] ✓ gas-dependency note renders ("You need ckETH for gas")');

    // 6. Enter the ETH destination + amount (in USDC, >= the 0 floor), then confirm.
    await driver.type('withdraw-address-input', WITHDRAW_ADDR, { timeoutMs: 4_000 });
    await driver.type('withdraw-amount-input', WITHDRAW_USDC, { timeoutMs: 4_000 });
    // The review card appears once a valid amount is entered — proves the app parsed the USDC amount
    // at 6-dec precision. fmtAsset(1e6, 6, 'USDC') = "1.000000 USDC".
    await driver.findByTestID('withdraw-review-amount', { timeoutMs: 4_000 });
    const reviewTxt = await driver.readText('withdraw-review-amount');
    assert(reviewTxt.includes('1.000000 USDC'), `review should show the USDC amount at 6-dec precision, got: "${reviewTxt}"`);

    console.log('[48-ckusdc-withdraw] confirming (signs on-device + submits to /api/v1/withdraw)…');
    await driver.click('btn-withdraw-confirm', { timeoutMs: 5_000 });

    // 7. Assert "Withdrawn" — the app signed, submitted, the FakeLedger verified + debited ckUSDC.
    const ok = await driver.waitForText('Withdrawn', { timeoutMs: 10_000 });
    const body = await driver.bodyText();
    assert(ok, `withdraw sheet should show "Withdrawn ✓". body excerpt:\n${body.slice(0, 600)}`);

    // 8. The credited path proven directly on the real ledger: the currency-2 balance dropped by the
    //    withdrawn raw. (The DEMO `$` header is currency 0, a separate asset; deliberately unmoved.)
    const after = await getBalance(relayBaseURL, accountHex, CKUSDC_CURRENCY);
    assertEq(after, String(SEED_RAW - WITHDRAW_RAW), 'post-withdraw ckUSDC balance (debited)');
    console.log(`[48-ckusdc-withdraw] ✓ ckUSDC balance ${SEED_RAW} → ${after} raw (debited through the REAL app+relay+FakeLedger)`);

    await driver.screenshot('48-ckusdc-withdraw');

    // 9. UI balance delta (locks the UI↔ledger agreement): flip the toggle back to "Scan to pay"
    //    (hides the inline withdraw body), re-open the Balances hub, and assert the ckUSDC row now
    //    shows the REDUCED remaining balance (999.000000 USDC = 999_000_000 raw), not the pre-withdraw
    //    1000 USDC.
    await driver.click('btn-pay-scan', { timeoutMs: 5_000 });
    await openBalances(driver);
    const reduced = await driver.waitForText('999.000000 USDC', { timeoutMs: 10_000 });
    const balBody = await driver.bodyText();
    assert(reduced, `Balances ckUSDC row should show the reduced 999.000000 USDC (999e6 raw remaining) after the withdraw. body excerpt:\n${balBody.slice(0, 500)}`);
    assert(!balBody.includes('1000.000000 USDC'), 'Balances must NOT still show the pre-withdraw 1000.000000 USDC (stale facade cache?)');
    console.log('[48-ckusdc-withdraw] ✓ UI ckUSDC balance dropped to 999.000000 USDC (matches the ledger delta)');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[48-ckusdc-withdraw] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[48-ckusdc-withdraw] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
