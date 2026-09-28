// Flow 104 — Send VCHF to an EXTERNAL Internet Computer account from the Pay tab.
//
// The capability this whole change exists for: moving a no-minter direct-ICRC asset out of the
// wallet to an address the user typed. Before this, VCHF and ICP had NO send path at all — the Pay
// tab's "Send to address" toggle was gated on a chain-key minter family, so the two assets that
// have no minter were the two you could receive but never send. (The Receive tab had already been
// fixed to `depositFamily || directIcrc`; the Pay tab had not. Same-surfaces rule, CLAUDE.md.)
//
// Proven end-to-end through the REAL app + fake-IC gateway: the destination is classified by the
// REAL core parser (the DpayCore wasm shim — base32+CRC, not a regex), the route is disclosed
// before the user commits, ONE icrc1_transfer envelope is signed on-device and POSTed to
// /api/v2/canister/<ledger>/call, and BOTH sides of the ledger move — the sender debited by
// amount + fee, the recipient credited by exactly the amount.
//
// The recipient is a REAL second wallet's principal (derived from its pubkey the same way the
// gateway keys balances), so the credit is asserted at a queryable account rather than assumed.
//
// VCHF carries a registered fee of 10_000 raw (0.0001 VCHF at 8 decimals), so the sender's debit is
// amount + 10_000 — this flow pins that arithmetic, which is also what the Max button depends on.
//
// Selector contract: `balance` (header → Balances), `asset-vchf-select`, `btn-pay-send`
// (Pay → "Send to address"), `send-address-input`, `send-status` (route disclosure),
// `send-amount-input`, `send-review-amount`, `send-review-fee`, `send-review-total`,
// `btn-send-confirm`, `send-destination`, `btn-send-done`, `btn-pay-scan`, and `send-outcome` —
// the DONE headline, deliberately a DIFFERENT id from the form-phase `send-status` line above it.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency, openPaySend, railPrincipalText,
} from '../harness/lib.mjs';

const CURRENCY = 7;            // VCHF — a complete no-minter direct-ICRC row
const ASSET_KEY = 'vchf';
const FEE_RAW = 10_000;        // the VCHF catalog row's registered ledger fee
const SEED = 500_000_000;      // 5.00000000 VCHF
const SEND_TEXT = '1.25000000';
const SEND_RAW = 125_000_000;

// A second wallet's pubkey — any 32-byte hex. Its self-authenticating principal is a REAL external
// destination as far as the app is concerned (the app has no idea it is a test fixture), and the
// relay's balance route can read it back, so the credit side is proven and not merely assumed.
const RECIPIENT_PUBKEY = 'b'.repeat(64);

export const meta = {
  id: '104',
  name: 'send-to-address',
  journey: 'withdraw',
  covers: ['send-to-address', 'direct-icrc', 'vchf', 'icrc1_transfer', 'route-disclosure', 'fee', 'balance-delta', 'ui-balance-delta'],
  verifies: 'Send VCHF to an external IC account: the Pay tab exposes "Send to address" for a no-minter asset, the pasted principal is CRC-validated and its route disclosed with the fee, one icrc1_transfer settles, and both the sender (−amount−fee) and the recipient (+amount) move at the gateway; the UI balance follows.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[104-send-to-address] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    console.log('[104-send-to-address] onboarding…');
    await onboardWallet(driver, 'e2e-send');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);

    const recipientPrincipal = await railPrincipalText(RECIPIENT_PUBKEY);
    console.log(`[104-send-to-address] recipient principal: ${recipientPrincipal}`);

    // Fund the VCHF rail at the wallet's principal.
    const fund = await faucetAccount(relayBaseURL, accountHex, SEED, { currency: CURRENCY });
    assert(fund.ok, `faucet funding must succeed, got HTTP ${fund.status}: ${JSON.stringify(fund.body)}`);
    const senderBefore = await getBalance(relayBaseURL, accountHex, CURRENCY);
    assertEq(senderBefore, String(SEED), 'pre-send VCHF balance at the sender principal');
    const recipientBefore = await getBalance(relayBaseURL, RECIPIENT_PUBKEY, CURRENCY);
    assertEq(recipientBefore, '0', 'recipient starts with no VCHF');

    // Select VCHF, then open Pay → "Send to address". That this toggle EXISTS for VCHF is the
    // headline regression guard: it did not before this change.
    console.log('[104-send-to-address] selecting VCHF → Pay → Send to address…');
    await openBalances(driver);
    await selectCurrency(driver, ASSET_KEY);
    await openPaySend(driver);
    await driver.findByTestID('send-address-input', { timeoutMs: 5_000 });

    // Paste the destination. The route line resolves through the REAL core parser and must both
    // name the settlement network and disclose the fee BEFORE any amount is entered.
    console.log('[104-send-to-address] entering the destination principal…');
    await driver.type('send-address-input', recipientPrincipal, { timeoutMs: 4_000 });
    await driver.findByTestID('send-status', { timeoutMs: 5_000 });
    const routeLine = await driver.readText('send-status');
    assertIncludes(routeLine, 'Internet Computer', 'the route line names the settlement network');
    assertIncludes(routeLine, '0.0001 VCHF', 'the route line discloses the ledger fee before committing');
    console.log(`[104-send-to-address] route disclosed: "${routeLine}"`);

    // Amount → the review card shows amount, fee and the TOTAL that will leave the account.
    await driver.type('send-amount-input', SEND_TEXT, { timeoutMs: 4_000 });
    await driver.findByTestID('send-review-amount', { timeoutMs: 4_000 });
    const reviewAmount = await driver.readText('send-review-amount');
    assertIncludes(reviewAmount, '1.25 VCHF', 'review shows the amount being sent, compact');
    const reviewFee = await driver.readText('send-review-fee');
    assertIncludes(reviewFee, '0.0001', 'review shows the ledger fee');
    const reviewTotal = await driver.readText('send-review-total');
    assertIncludes(reviewTotal, '1.2501', 'review shows amount + fee as the total leaving the account');

    console.log('[104-send-to-address] confirming (signs one icrc1_transfer on-device)…');
    await driver.click('btn-send-confirm', { timeoutMs: 5_000 });

    const sent = await driver.waitForText('Sent', { timeoutMs: 15_000 });
    const body = await driver.bodyText();
    assert(sent, `send sheet should confirm "Sent". body excerpt:\n${body.slice(0, 600)}`);

    // The destination is shown in FULL on the success screen — the user can verify where it went.
    const shownDest = await driver.readText('send-destination');
    assertEq(shownDest, recipientPrincipal, 'the success screen shows the full destination account');

    // Both sides of the ledger, at the gateway. The sender pays amount + fee; the recipient
    // receives exactly the amount (the fee is burned, not forwarded).
    const senderAfter = await getBalance(relayBaseURL, accountHex, CURRENCY);
    assertEq(senderAfter, String(SEED - SEND_RAW - FEE_RAW), 'sender debited by amount + fee');
    const recipientAfter = await getBalance(relayBaseURL, RECIPIENT_PUBKEY, CURRENCY);
    assertEq(recipientAfter, String(SEND_RAW), 'recipient credited by exactly the amount');
    console.log(`[104-send-to-address] ✓ sender ${senderBefore} → ${senderAfter}, recipient ${recipientBefore} → ${recipientAfter} (raw)`);

    await driver.screenshot('104-send-to-address');

    // The wallet SURFACE agrees with the gateway (a stale balance cache would fail here). The
    // negative assert is scoped to the ACCOUNTS LIST: the Home activity feed legitimately keeps
    // the +5.00 VCHF faucet-seed row (its own token unit, O4 S2) — that is history, not a stale
    // balance. The rows live on the accounts route, reached by the header balance chip.
    await driver.click('btn-send-done', { timeoutMs: 5_000 });
    await openBalances(driver);
    // Fork #4: the CHF currency row shows the SUMMED balance in the currency unit ("3.74 Fr" —
    // 2-decimal Fr, token unit retired for balance display). The exact raw ledger truth is
    // asserted flow-side below via getBalance.
    const reduced = await driver.waitForText('3.74 Fr', { timeoutMs: 10_000 });
    const balBody = await driver.readText('accounts-list');
    assert(reduced, `Balances CHF row should show the reduced balance in the currency unit. accounts excerpt:\n${balBody.slice(0, 500)}`);
    assert(!balBody.includes('5.00 Fr'), 'Balances must NOT still show the pre-send 5.00 Fr (stale cache?)');
    console.log('[104-send-to-address] ✓ UI CHF balance dropped to 3.74 Fr (currency unit)');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[104-send-to-address] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[104-send-to-address] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
