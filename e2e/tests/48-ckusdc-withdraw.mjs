// Flow 48 — Withdraw ckUSDC to a native Ethereum address over the IC user-principal rail (W2).
//
// Proves the ckERC-20 DUAL-LEDGER cash-out path end-to-end through the REAL app + fake-IC
// gateway: the wallet's ckUSDC asset (currency 2, CkEthErc20 family with token_contract Some)
// reaches the SAME "Send to address" sheet, family-dispatched to the ckERC20 branch — the app
// queries the minter's eip_1559_transaction_price gas quote, surfaces the honest "You need
// ckETH for gas" note (Fork-C — dpay never converts ckUSDC→ckETH, no-swap), and signs THREE
// envelopes ON-DEVICE (the DpayCore wasm shim — byte-exact vs the Rust core): an
// icrc2_approve for the GAS on the ckETH gas ledger, an icrc2_approve for the AMOUNT on the
// ckUSDC ledger (each carrying its ledger's live icrc1_fee), then withdraw_erc20 on the minter
// — each POSTed straight to /api/v2/canister/<canister>/call with a read_state poll
// reconciling the outcome (the minter's Ok(record{block_index}) reply decoded by rail.ts's
// frozen-shape parser). The gateway then burns the approved ckUSDC amount AND the ckETH gas
// from the minter's home ledger — the browser-driven proof of the REAL dual-ledger flow.
//
// Funding: per-ledger buckets mean the wallet needs BOTH assets — ckUSDC (currency 2) for the
// amount + its 10000-microunit approve fee, AND ckETH (currency 6) for the 78e12-Wei gas burn
// + its 2e12-Wei approve fee. Honest post-withdraw expectations: ckUSDC 1e9 − 1e6 − 10000 =
// 998990000 (the row reads '998.99 USDC'); ckETH seed − 2e12 − 78e12.
//
// Flow 15 (BTC) + flow 44 (native ETH) + flow 48 (ckERC20) cover ALL three family branches of
// the withdraw surface.
//
// Selector contract: `asset-ckusdc-select` (the ckUSDC row whole-row select), `btn-pay-send`
// (Pay → "Send to address"), `send-address-input` (the ONE shared destination field —
// SendSheet/AddressField own it), `send-status` (the route disclosure under the field),
// `withdraw-amount-input`, `withdraw-gas-note` (the ckETH-gas-dependency note — renders ONLY for a
// ckERC20 token), `btn-withdraw-confirm`, `withdraw-status`, `btn-pay-scan` (flip back to scan).
// Asset segregation note: ckUSDC is currency 2 + ckETH currency 6, SEPARATE assets from the `$`
// DEMO_USD header (currency 0).
import { setup, assert, assertEq, faucetAccount, getBalance, onboardWallet, accountOf, openBalances, selectCurrency, openPaySend } from '../harness/lib.mjs';

const CKUSDC_CURRENCY = 2; // ckUSDC — CkEthErc20 + token_contract Some (dual-ledger withdraw_erc20)
const CKETH_CURRENCY = 6; // native ckETH — the gas ledger (desc.gas_ledger)
// 6-dec micro-units (ckUSDC side — well under 2^53, plain Numbers fine; STRING contract kept).
const SEED_RAW = 1_000_000_000; // 1000 USDC @ 6 dec = 1e9 raw
const APPROVE_FEE_RAW = 10_000; // the ckUSDC ledger's icrc1_fee (10000 microunits = 0.01 USDC)
const WITHDRAW_USDC = '1'; // user enters "1" (USDC) — the app converts to 1e6 raw via toUnits(_, 6)
const WITHDRAW_RAW = 1_000_000; // 1 USDC @ 6 dec = 1e6 raw
// ckETH side (18-dec Wei — BigInt; amounts cross HTTP as decimal STRINGS).
const SEED_ETH_WEI = 100_000_000_000_000_000n; // 0.1 ETH — covers gas + its approve fee
const CKETH_APPROVE_FEE_WEI = 2_000_000_000_000n; // the REAL ckETH ledger's icrc1_fee (2e12 Wei = 0.000002 ETH, from the prod catalog row)
const GAS_FEE_WEI = 78_000_000_000_000n; // the minter's eip_1559 quote (fixed on this fake)
// A valid Ethereum destination: 0x + 40 hex (the app's isValidDestinationAddress regex for CkEthErc20).
const WITHDRAW_ADDR = '0x000000000000000000000000000000000000dead';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '48',
  name: 'ckusdc-withdraw',
  journey: 'withdraw',
  covers: ['ckerc20-offramp', 'ckusdc', 'withdraw', 'icrc2-approve', 'withdraw_erc20', 'dual-ledger-gas', 'gas-note', 'sign', 'settle', 'balance-delta', 'ui-balance-delta'],
  verifies: 'ckUSDC Send-to-address: gas-dependency note renders (no-swap honesty) → enter 0x addr + USDC amount → query gas + sign gas-approve + amount-approve + withdraw_erc20 on-device → gateway burns BOTH ledgers → "Withdrawn ✓"; ckUSDC debits fee+amount, ckETH debits gas-fee + gas at the gateway AND the UI row drops to 998.99 USDC.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[48-ckusdc-withdraw] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Onboard → wallet + capture this wallet's account (pubkey hex → self-authenticating
    //    principal — the key the fake-IC gateway balances are recorded under).
    console.log('[48-ckusdc-withdraw] onboarding…');
    await onboardWallet(driver, 'e2e-ckusdc');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);
    console.log(`[48-ckusdc-withdraw] wallet account: ${accountHex.slice(0, 16)}…`);

    // 2. Fund BOTH legs of the dual-ledger path at the wallet's PRINCIPAL via the faucet:
    //    ckUSDC for the amount (+ its approve fee) and ckETH for the minter's gas burn (+ its
    //    approve fee). Per-ledger buckets read each back EXACTLY.
    console.log(`[48-ckusdc-withdraw] faucet-funding ${SEED_RAW} raw ckUSDC + ${SEED_ETH_WEI} Wei ckETH (gas leg)…`);
    const fundUsdc = await faucetAccount(relayBaseURL, accountHex, String(SEED_RAW), { currency: CKUSDC_CURRENCY });
    assert(fundUsdc.ok, `ckUSDC faucet funding must succeed, got HTTP ${fundUsdc.status}: ${JSON.stringify(fundUsdc.body)}`);
    const fundEth = await faucetAccount(relayBaseURL, accountHex, String(SEED_ETH_WEI), { currency: CKETH_CURRENCY });
    assert(fundEth.ok, `ckETH faucet funding must succeed, got HTTP ${fundEth.status}: ${JSON.stringify(fundEth.body)}`);
    const beforeUsdc = await getBalance(relayBaseURL, accountHex, CKUSDC_CURRENCY);
    assertEq(beforeUsdc, String(SEED_RAW), 'pre-withdraw ckUSDC balance at the principal (per-ledger bucket)');
    const beforeEth = await getBalance(relayBaseURL, accountHex, CKETH_CURRENCY);
    assertEq(beforeEth, String(SEED_ETH_WEI), 'pre-withdraw ckETH gas-leg balance at the principal');

    // 3. Open the accounts route; wait for the ckUSDC row to appear funded (the balance poll picks
    //    up the faucet credit), then SELECT ckUSDC (makes it the active asset).
    console.log('[48-ckusdc-withdraw] opening the accounts route; waiting for the funded ckUSDC row…');
    await openBalances(driver);
    await driver.waitForText('1,000.00 USDC', { timeoutMs: 8_000 });

    // 4. Select ckUSDC → Pay → "Send to address" (the inline WithdrawSheet body, family-dispatched
    //    to the dual-ledger withdraw_erc20 path).
    console.log('[48-ckusdc-withdraw] selecting ckUSDC → Pay → Send to address…');
    await selectCurrency(driver, 'ckusdc');
    await openPaySend(driver);
    await driver.findByTestID('send-address-input', { timeoutMs: 5_000 });

    // 5. Paste the Ethereum destination into the ONE shared field. A native-chain address routes to
    //    the chain-key offramp, so the route line quotes ETHEREUM's economics and the WithdrawSheet
    //    body renders below it, family-dispatched to the dual-ledger withdraw_erc20 path.
    await driver.type('send-address-input', WITHDRAW_ADDR, { timeoutMs: 4_000 });
    const routeTxt = await driver.readText('send-status', { timeoutMs: 4_000 });
    // (ckERC20 carries no minter floor — withdrawMinRaw 0 — so the minimum reads a bare "0 USDC".)
    assertEq(routeTxt, 'Ethereum · about 1 min', 'the route line discloses the Ethereum burn, with NO minimum clause (ckERC20 has no floor — "minimum 0" would read as a malfunction)');
    await driver.findByTestID('withdraw-amount-input', { timeoutMs: 5_000 });

    // 5b. Assert the ckETH gas-dependency note renders (Fork-C — no-swap honesty). It appears ONLY
    //    for a ckERC20 token (token_contract Some); the native-ETH sheet does NOT show it (flow 44
    //    asserts its absence). This is the honest "you need ckETH for gas" UX — dpay never
    //    converts ckUSDC→ckETH.
    await driver.findByTestID('withdraw-gas-note', { timeoutMs: 5_000 });
    const gasNoteBody = await driver.bodyText();
    assert(gasNoteBody.includes('ckETH for gas'), `the gas-dependency note should mention ckETH. body excerpt:\n${gasNoteBody.slice(0, 500)}`);
    console.log('[48-ckusdc-withdraw] ✓ gas-dependency note renders ("You need ckETH for gas")');

    // 6. Enter the amount (in USDC, >= the 0 floor), then confirm.
    await driver.type('withdraw-amount-input', WITHDRAW_USDC, { timeoutMs: 4_000 });
    // The review card appears once a valid amount is entered — proves the app parsed the USDC amount
    // compact (trailing zeros trimmed; the withdraw sheet's display carries no min-fraction floor).
    await driver.findByTestID('withdraw-review-amount', { timeoutMs: 4_000 });
    const reviewTxt = await driver.readText('withdraw-review-amount');
    assert(reviewTxt.includes('1 USDC'), `review should show the USDC amount compact, got: "${reviewTxt}"`);

    console.log('[48-ckusdc-withdraw] confirming (gas query + signs gas-approve + amount-approve + withdraw_erc20 on-device, POSTs to /api/v2)…');
    await driver.click('btn-withdraw-confirm', { timeoutMs: 5_000 });

    // 7. Assert "Withdrawn" — the app fetched the certified IC clock, the minter's gas quote, both
    //    ledgers' icrc1_fees, signed all three envelopes, and the gateway executed both burns.
    const ok = await driver.waitForText('Withdrawn', { timeoutMs: 15_000 });
    const body = await driver.bodyText();
    assert(ok, `withdraw sheet should show "Withdrawn ✓". body excerpt:\n${body.slice(0, 600)}`);

    // 8. The dual-ledger debit proven directly on the fake-IC gateway. ckUSDC leg: the approve fee
    //    (10000 microunits, charged on the amount-approve) + the burned amount. ckETH leg: the
    //    approve fee (2e12 Wei, charged on the gas-approve) + the 78e12-Wei gas burn the minter
    //    takes from its home ledger. (The DEMO `$` header is currency 0, a separate bucket.)
    const afterUsdc = await getBalance(relayBaseURL, accountHex, CKUSDC_CURRENCY);
    assertEq(afterUsdc, String(SEED_RAW - APPROVE_FEE_RAW - WITHDRAW_RAW), 'post-withdraw ckUSDC balance (approve fee + minter burn)');
    const afterEth = await getBalance(relayBaseURL, accountHex, CKETH_CURRENCY);
    assertEq(afterEth, String(SEED_ETH_WEI - CKETH_APPROVE_FEE_WEI - GAS_FEE_WEI), 'post-withdraw ckETH gas-leg balance (approve fee + gas burn)');
    console.log(`[48-ckusdc-withdraw] ✓ ckUSDC ${beforeUsdc} → ${afterUsdc} raw + ckETH ${beforeEth} → ${afterEth} Wei (dual-ledger burn through the REAL app+gateway)`);

    await driver.screenshot('48-ckusdc-withdraw');

    // 9. UI balance delta (locks the UI↔gateway agreement): flip the toggle back to "Scan to pay"
    //    (hides the inline withdraw body), re-open the accounts route, and assert the ckUSDC row now
    //    shows the REDUCED remaining balance (998.99 USDC = 998_990_000 raw), not the
    //    pre-withdraw 1000 USDC.
    await driver.click('btn-pay-scan', { timeoutMs: 5_000 });
    await openBalances(driver);
    const reduced = await driver.waitForText('$998.99', { timeoutMs: 10_000 }) // the USD currency row: summed balance in the currency unit (fork #4);
    // Scoped to the ACCOUNTS LIST: the Home activity feed legitimately keeps the +1,000.00 USDC
    // faucet-seed row — history, not a stale balance. The rows live on the accounts route, reached
    // by the header balance chip.
    const balBody = await driver.readText('accounts-list');
    assert(reduced, `Balances ckUSDC row should show the reduced 998.99 USDC (998990000 raw remaining) after the withdraw. accounts excerpt:\n${balBody.slice(0, 500)}`);
    assert(!balBody.includes('1,000.00 USDC'), 'Balances must NOT still show the pre-withdraw 1,000.00 USDC (stale balance cache?)');
    console.log('[48-ckusdc-withdraw] ✓ UI ckUSDC balance dropped to 998.99 USDC (matches the gateway delta)');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[48-ckusdc-withdraw] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[48-ckusdc-withdraw] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
