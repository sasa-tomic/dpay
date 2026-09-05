// Flow 109 — the Pay camera reads a payment LINK and a bare ADDRESS, not only a request code.
//
// The defect this closes: `onRequestString` asked the wire codec one question, and answered every
// refusal with "This isn't a dpay payment code". Two perfectly good codes therefore dead-ended in
// the shipped app:
//
//   • a printed PAYMENT LINK. `app/lib/deepLink.ts` documents the format as one meant to be shared
//     "over chat/email/a printed QR", but the only code path that parsed it was the OS App Link /
//     web-location reader. Scanned with dpay's own camera it failed — the same string with two
//     different outcomes depending on how it reached the app.
//   • a bare WALLET ADDRESS — including the ICRC-1 principal dpay's own Receive ▸ My address screen
//     renders as a QR. The wallet could show an address it could not then read back.
//
// Both violate the founder rule (2026-08-29) that every step, especially the error path, gives the
// user something to do. This flow proves the fix on the REAL app, through the REAL camera seam:
//
//   1. a scanned payment link lands on the pre-filled review — the SAME surface an App Link
//      produces (flow 49), reached through the camera, and STILL requiring an Approve press;
//   2. a scanned IC account switches to "Send to address" with the destination filled in and its
//      route disclosed, so the refusal/disclosure logic that already exists is what speaks;
//   3. a `bitcoin:` payment request (BIP-21) is refused BY NAME with a practical instruction —
//      another wallet's payment format used to die as "not a payment code" (founder rule
//      2026-08-29: every error path gives the user something to do);
//   4. a payload nothing recognises keeps the honest "not a payment code" refusal — the second
//      opinion widens the answer, it does not soften it (flow 36 owns the malformed-wire case).
//
// Selector contract: `asset-vchf-select`, `btn-start-scan` (via armPayScan), `pay-amount`,
// `btn-approve`, `btn-review-cancel`, `send-address-input`, `send-status`, `btn-pay-scan`.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount,
  openBalances, selectCurrency, armPayScan, railPrincipalText,
} from '../harness/lib.mjs';

const CURRENCY = 7;      // VCHF — a direct-ICRC row: sendable to any IC account, no minter involved
const SEED = 500_000_000; // 5.00000000 VCHF, so neither the fund-first gate nor a zero balance fires
const LINK_AMOUNT = '1.25';
// A second wallet's pubkey. Its self-authenticating principal is a real destination as far as the
// app is concerned — it is what the link names AND what the bare-address scan carries.
const RECIPIENT_PUBKEY = 'c'.repeat(64);
const BTC_ADDRESS = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

export const meta = {
  id: '109',
  name: 'scan-link-and-address',
  journey: 'pay',
  covers: ['scan-fallback', 'pay-link', 'send-to-address', 'error-handling', 'input-validation'],
  verifies: 'The Pay camera classifies what it read: a payment-link QR opens the pre-filled review (no auto-sign), a bare IC account opens Send to address with the destination filled + route disclosed, a bitcoin: request is refused by name with an instruction to use a Bitcoin wallet, and unrecognised input keeps the honest "not a payment code" refusal.',
  timeoutMs: 40000,
};

/** Inject a payload through the camera seam, arming the scan surface first (the pay-intent gate). */
async function scan(driver, payload) {
  await armPayScan(driver);
  await driver.eval(
    (qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); },
    payload,
  );
}

export async function run() {
  const start = Date.now();
  console.log('[109-scan-link-and-address] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver, relayBaseURL} = env;

    console.log('[109-scan-link-and-address] onboarding…');
    await onboardWallet(driver, 'e2e-scan2');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);

    const recipient = await railPrincipalText(RECIPIENT_PUBKEY);
    console.log(`[109-scan-link-and-address] recipient principal: ${recipient}`);

    const fund = await faucetAccount(relayBaseURL, accountHex, SEED, {currency: CURRENCY});
    assert(fund.ok, `faucet funding must succeed, got HTTP ${fund.status}: ${JSON.stringify(fund.body)}`);

    // VCHF is the active asset: it can both be paid (direct icrc1_transfer) and sent to an address,
    // so ONE asset exercises both halves of the classifier.
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');

    // --- 1. a printed payment link, read by the camera ------------------------------------------
    // The host is deliberately not the web origin: parsePayLink ignores it by design (on native the
    // OS only delivers verified hosts), so a QR printed against the production domain must work in
    // any build — which is exactly the case a scan covers and an App Link cannot.
    const link = `https://dpay.kalaj.org/wallet/pay/${recipient}?asset=VCHF&network=internet-computer&amount=${LINK_AMOUNT}&label=Cafe`;
    console.log('[109-scan-link-and-address] scanning a payment-link QR…');
    await driver.click('tab-pay');
    await scan(driver, link);

    await driver.findByTestID('pay-amount', {timeoutMs: 10_000});
    const amountText = await driver.readText('pay-amount');
    assertIncludes(amountText, LINK_AMOUNT, 'the scanned link\'s amount reaches the review');
    // A link is a ZERO-PRESS entry wherever it came from: the camera's "Pay Now" press armed the
    // scanner, it did not consent to this payee. Approve must still be there, unpressed.
    assert(await driver.isPresent('btn-approve'), 'a scanned payment link must still require an Approve press — it may never auto-sign');
    const body = await driver.bodyText();
    assert(!body.includes("isn't a dpay payment code"), 'a payment link must not be refused as an unknown code');
    console.log('[109-scan-link-and-address] ✓ link → pre-filled review, no auto-sign');
    await driver.screenshot('109-scan-link');

    // --- 2. a bare wallet address, read by the camera --------------------------------------------
    await driver.click('btn-review-cancel');
    console.log('[109-scan-link-and-address] scanning a bare IC account…');
    await scan(driver, recipient);

    await driver.findByTestID('send-address-input', {timeoutMs: 10_000});
    // The scan fills the field through a state update, so the value is NOT there on the CDP round
    // trip immediately after the field mounts — a snapshot taken then reads "" and the flow fails
    // for a render it did not wait for (observed RED under contention, 2026-09-01). Wait for the
    // value, then pin it.
    await driver.waitForFunction(
      (sel, want) => document.querySelector(sel)?.value === want,
      {
        timeoutMs: 10_000,
        args: ['[data-testid="send-address-input"]', recipient],
        label: `the scanned account reaches the destination field (${recipient})`,
      },
    );
    assertEq(await driver.readInputValue('send-address-input'), recipient, 'the scanned account fills the destination field verbatim');
    // The disclosure is the point: the user learns the rail + its fee BEFORE typing an amount, and
    // it is produced by the same resolver a paste goes through (no scan-specific shortcut).
    const status = await driver.readText('send-status');
    assertIncludes(status, 'Internet Computer', 'the scanned destination\'s route is disclosed');
    console.log(`[109-scan-link-and-address] ✓ address → Send to address, route: ${status}`);
    await driver.screenshot('109-scan-address');

    // --- 3. another wallet's payment format, refused BY NAME --------------------------------------
    await driver.click('btn-pay-scan');
    console.log('[109-scan-link-and-address] scanning a bitcoin: payment request…');
    await scan(driver, `BITCOIN:${BTC_ADDRESS}?amount=0.001&label=Coffee`);
    assert(
      await driver.waitForText('payment request for Bitcoin', {timeoutMs: 5_000}),
      'a bitcoin: request must be refused by name — the coin, the scheme, and where to pay it instead',
    );
    const coinBody = await driver.bodyText();
    assert(!coinBody.includes("isn't a dpay payment code"), 'a bitcoin: request must not get the generic refusal');
    assert(!(await driver.isPresent('pay-amount')), 'a coin request must never reach a review');
    console.log('[109-scan-link-and-address] ✓ bitcoin: request → named refusal, no review');
    await driver.screenshot('109-scan-bitcoin');

    // --- 4. still honest about what it genuinely cannot read -------------------------------------
    console.log('[109-scan-link-and-address] scanning an unrecognised payload…');
    await scan(driver, 'not a link, not an address, not a request');
    assert(
      await driver.waitForText("isn't a dpay payment code", {timeoutMs: 5_000}),
      'input that belongs to no namespace must keep the honest refusal — widening the answer must not soften it',
    );
    assert(!(await driver.isPresent('pay-amount')), 'unrecognised input must never reach a review');
    console.log('[109-scan-link-and-address] ✓ unrecognised input → honest refusal, no review');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[109-scan-link-and-address] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[109-scan-link-and-address] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
