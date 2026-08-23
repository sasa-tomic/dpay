// Flow 07 — Scan → review → pay (two wallets, REAL signing + REAL settlement).
//
// Two wallets in one test: wallet A is the onboarded payer (in the browser); wallet B is a fresh
// keypair generated IN-TEST (Node side, @noble/ed25519 — no second browser needed). B builds a
// request QR (the flow-06 logic); A's app scans it via the camera seam `window.__DPAY_TEST_SCAN`,
// reviews "Pay $X to merchant", Approves → the app signs with A's on-device key (the @noble shim,
// byte-exact vs Rust per test 00) + POSTs /api/v1/pay → the FakeLedger VERIFIES the ed25519 sig +
// settles (debits A, credits B). Asserts:
//   - A's review shows the exact amount + merchant name.
//   - A reaches "Paid ✓ ∂25.00".
//   - A's `$` balance decreased by the amount (currency 0 = DEMO_USD, the wallet asset).
//   - B's balance (direct relay query, currency 0) increased by the amount — recipient credited.
//   - A's Recent history lists the outgoing payment to B.
// Every money step runs through the REAL relay + REAL FakeLedger settlement (sig verified, nonce
// spent, atomic debit/credit). B needs no browser: its balance is read straight off the ledger.
//
// Selector contract: `tab-pay` (default), `pay-amount`, `btn-approve`, `btn-new`, `balance`.
import { setup, assert, assertIncludes, getBalance, onboardWallet, railPrincipalText } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const PAY_CENTS = 2500; // ∂25.00 (DEMO_USD = currency 0, the wallet asset)
const MERCHANT_NAME = 'Bob';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '07',
  name: 'scan-pay',
  journey: 'pay',
  covers: ['scan', 'sign', 'settle', 'receipt', 'history', 'recipient-name'],
  verifies: 'Payer scans → reviews → approves: two-wallet real ed25519 sign + relay settle → \'Paid ✓\', balances correct.',
  timeoutMs: 20000,
};

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
    assert(bobBefore === '0', `payee B must start at 0, got ${bobBefore}`);

    // --- wallet A: onboarded in the browser (the payer, funded ∂100 by the faucet). -----------
    console.log('[07-scan-pay] onboarding wallet A (payer)…');
    await onboardWallet(driver, 'e2e-alice');

    // --- B's request QR: to=B, amount=∂25, fresh nonce, +10min expiry, currency 0 (DEMO_USD). -
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
    assert(payAmt.includes('∂25.00'), `review should show "Pay ∂25.00", got "${payAmt}"`);
    const reviewBody = await driver.bodyText();
    assertIncludes(reviewBody, MERCHANT_NAME, 'review should name the merchant');
    console.log(`[07-scan-pay] ✓ review: ${payAmt} to ${MERCHANT_NAME}`);

    // --- Approve → the app signs offline + submits to the REAL relay → FakeLedger settles. ----
    console.log('[07-scan-pay] clicking btn-approve (sign + pay)…');
    await driver.click('btn-approve', { timeoutMs: 5_000 });
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'payer should reach the Paid screen after the relay settles');
    // L6: the Paid ✓ confirmation must show the ACTUAL recipient name (to_name from the request
    // bytes), not a generic "merchant" label.
    const paidBody = await driver.bodyText();
    assertIncludes(paidBody, 'Bob', 'Paid ✓ confirmation should name the recipient (L6)');
    assert(!/\bmerchant\b/i.test(paidBody), 'Paid ✓ confirmation must not use the generic "merchant" label (L6)');
    console.log('[07-scan-pay] ✓ A reached "Paid ✓" to Bob (L6: real recipient name, not "merchant")');

    // --- A's `$` balance decreased by the amount (the 2.5s poll reconciles). ------------------
    const aliceDown = await driver.waitForText('∂75.00', { timeoutMs: 10_000 });
    assert(aliceDown, `payer A balance should be ∂75.00 (∂100 − ∂25) after the settle`);
    console.log('[07-scan-pay] ✓ A balance ∂100.00 → ∂75.00');

    // --- B was credited (read straight off the ledger — no second browser). -------------------
    const bobAfter = await getBalance(relayBaseURL, bob.publicHex, 0);
    assertEqMoney(bobAfter, PAY_CENTS, 'payee B balance after the settle');
    console.log(`[07-scan-pay] ✓ B credited: 0 → $${(Number(bobAfter) / 100).toFixed(2)}`);

    // --- A's Recent history lists the outgoing payment to B (refreshHistory fired on settle). --
    // IC rail: history rows are name-less (names died with facade settlement — only the payer's
    // REVIEW knew the name, from the request QR bytes); the row shows the payee's short PRINCIPAL
    // text (61-merchant-received-name pins the same convention). Assert the short principal is
    // rendered and neither the full principal nor the raw hex pubkey leaks.
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    await driver.click('tab-transactions', { timeoutMs: 4_000 });
    const hasHistory = await driver.waitForText('RECENT', { timeoutMs: 8_000 });
    assert(hasHistory, 'the Recent card should render once the payment lands in history');
    const histBody = await driver.bodyText();
    assertIncludes(histBody, bobPrincipal.slice(0, 8), 'history row should show the payee short principal text');
    assert(!histBody.includes(bobPrincipal), 'history must NOT dump the full principal');
    assert(!histBody.includes(bob.publicHex), 'history must NOT dump the raw 64-char recipient pubkey');
    console.log('[07-scan-pay] ✓ A history shows the outgoing payment (short principal; names died with the facade)');

    await driver.screenshot('07-scan-pay');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[07-scan-pay] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

function assertEqMoney(actualMinor, expectedMinor, label) {
  // MC1 units 2-4: compare raw-u64 amounts as decimal strings (BigInt-safe; `actualMinor` is the
  // relay's string form, `expectedMinor` may be a number literal in the test).
  if (String(actualMinor) !== String(expectedMinor)) {
    throw new Error(`[assert] ${label}: expected $${(expectedMinor / 100).toFixed(2)} (${expectedMinor}), got $${(Number(actualMinor) / 100).toFixed(2)} (${actualMinor})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[07-scan-pay] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
