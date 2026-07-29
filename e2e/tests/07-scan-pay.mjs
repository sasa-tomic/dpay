// Flow 07 — Scan → review → pay (two wallets, REAL signing + REAL settlement).
//
// Two wallets in one test: wallet A is the onboarded payer (in the browser); wallet B is a fresh
// keypair generated IN-TEST (Node side, @noble/ed25519 — no second browser needed). B builds a
// request QR (the flow-06 logic); A's app scans it via the camera seam `window.__DPAY_TEST_SCAN`,
// reviews "Pay $X to merchant", Approves → the app signs with A's on-device key (the @noble shim,
// byte-exact vs Rust per test 00) + POSTs /api/v1/pay → the FakeLedger VERIFIES the ed25519 sig +
// settles (debits A, credits B). Asserts:
//   - A's review shows the exact amount + merchant name.
//   - A reaches "Paid ✓ $25.00".
//   - A's `$` balance decreased by the amount (currency 0 = DEMO_USD, the wallet asset).
//   - B's balance (direct relay query, currency 0) increased by the amount — recipient credited.
//   - A's Recent history lists the outgoing payment to B.
// Every money step runs through the REAL relay + REAL FakeLedger settlement (sig verified, nonce
// spent, atomic debit/credit). B needs no browser: its balance is read straight off the ledger.
//
// Selector contract: `tab-pay` (default), `pay-amount`, `btn-approve`, `btn-new`, `balance`.
import { setup, assert, assertIncludes, getBalance } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const ONBOARD_PLACEHOLDER = 'e.g. Alice';
const PAY_CENTS = 2500; // $25.00 (DEMO_USD = currency 0, the wallet asset)
const MERCHANT_NAME = 'merchant';

export async function run() {
  const start = Date.now();
  console.log('[07-scan-pay] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // --- wallet B: a fresh keypair generated in-test (the payee). -----------------------------
    const bob = await generateKeypair();
    console.log(`[07-scan-pay] wallet B (payee): ${bob.publicHex.slice(0, 16)}…`);
    // Pre-condition: B holds nothing yet.
    const bobBefore = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(bobBefore === 0, `payee B must start at 0, got ${bobBefore}`);

    // --- wallet A: onboarded in the browser (the payer, funded $100 by the faucet). -----------
    console.log('[07-scan-pay] onboarding wallet A (payer)…');
    await driver.typeByPlaceholder(ONBOARD_PLACEHOLDER, 'e2e-alice', { timeoutMs: 8_000 });
    await driver.click('btn-create', { timeoutMs: 4_000 });
    await driver.findByTestID('balance', { timeoutMs: 10_000 });
    await driver.waitForText('$100.00', { timeoutMs: 12_000 });

    // --- B's request QR: to=B, amount=$25, fresh nonce, +10min expiry, currency 0 (DEMO_USD). -
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(bob.publicHex, PAY_CENTS, nonce, expiry, 0, MERCHANT_NAME);

    // --- A scans B's request via the camera seam. PayMode is on the scan screen by default; the
    //     seam fires the app's onCodeScanned → onRequestString → review screen. ----------------
    console.log('[07-scan-pay] injecting B’s request QR via the camera seam…');
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, requestQR);

    // --- Review screen: exact amount + merchant name. -----------------------------------------
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    const payAmt = await driver.readText('pay-amount');
    assert(payAmt.includes('$25.00'), `review should show "Pay $25.00", got "${payAmt}"`);
    const reviewBody = await driver.bodyText();
    assertIncludes(reviewBody, MERCHANT_NAME, 'review should name the merchant');
    console.log(`[07-scan-pay] ✓ review: ${payAmt} to ${MERCHANT_NAME}`);

    // --- Approve → the app signs offline + submits to the REAL relay → FakeLedger settles. ----
    console.log('[07-scan-pay] clicking btn-approve (sign + pay)…');
    await driver.click('btn-approve', { timeoutMs: 5_000 });
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'payer should reach the Paid screen after the relay settles');
    console.log('[07-scan-pay] ✓ A reached "Paid ✓" — FakeLedger verified the sig + settled');

    // --- A's `$` balance decreased by the amount (the 2.5s poll reconciles). ------------------
    const aliceDown = await driver.waitForText('$75.00', { timeoutMs: 10_000 });
    assert(aliceDown, `payer A balance should be $75.00 ($100 − $25) after the settle`);
    console.log('[07-scan-pay] ✓ A balance $100.00 → $75.00');

    // --- B was credited (read straight off the ledger — no second browser). -------------------
    const bobAfter = await getBalance(relayBaseURL, bob.publicHex, 0);
    assertEqMoney(bobAfter, PAY_CENTS, 'payee B balance after the settle');
    console.log(`[07-scan-pay] ✓ B credited: 0 → $${(bobAfter / 100).toFixed(2)}`);

    // --- A's Recent history lists the outgoing payment to B (refreshHistory fired on settle). --
    // NB: the history card title is CSS-uppercased, so innerText renders "Recent" as "RECENT"; assert
    // the recipient's short pubkey in the row instead (no text-transform — the meaningful proof that
    // the settled payment landed in the ledger-sourced history).
    const hasHistory = await driver.waitForText('RECENT', { timeoutMs: 8_000 });
    assert(hasHistory, 'the Recent card should render once the payment lands in history');
    const histBody = await driver.bodyText();
    assertIncludes(histBody, bob.publicHex.slice(0, 8), 'history row should name the recipient (short pubkey)');
    console.log('[07-scan-pay] ✓ A history shows the outgoing payment to B');

    await driver.screenshot('07-scan-pay');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[07-scan-pay] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

function assertEqMoney(actualMinor, expectedMinor, label) {
  if (actualMinor !== expectedMinor) {
    throw new Error(`[assert] ${label}: expected $${(expectedMinor / 100).toFixed(2)} (${expectedMinor}), got $${(actualMinor / 100).toFixed(2)} (${actualMinor})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[07-scan-pay] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
