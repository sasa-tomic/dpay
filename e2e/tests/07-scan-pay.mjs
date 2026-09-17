// Flow 07 — Scan → auto-sign → pay (two wallets, REAL signing + REAL settlement).
//
// Two wallets in one test: wallet A is the onboarded payer (in the browser); wallet B is a fresh
// keypair generated IN-TEST (Node side, @noble/ed25519 — no second browser needed). B builds a
// request QR (the flow-06 logic); A's app scans it via the camera seam `window.__DPAY_TEST_SCAN`,
// and the decode AUTO-SIGNS (one-press rule, founder directive 2026-08-24: the "Pay Now" gate
// press that armed the scanner IS the single deliberate press — no review/Approve exists on the
// camera path) → the app signs with A's on-device key (the @noble shim, byte-exact vs Rust per
// test 00) + POSTs /api/v1/pay → the FakeLedger VERIFIES the ed25519 sig + settles (debits A,
// credits B). Asserts:
//   - A reaches "Paid ✓ ∂25.00" straight from the scan (no intermediate button).
//   - A's `$` balance decreased by the amount (currency 0 = DEMO_USD, the wallet asset).
//   - B's balance (direct relay query, currency 0) increased by the amount — recipient credited.
//   - A's Recent history lists the outgoing payment to B.
// Every money step runs through the REAL relay + REAL FakeLedger settlement (sig verified, nonce
// spent, atomic debit/credit). B needs no browser: its balance is read straight off the ledger.
//
// Selector contract: `tab-pay` (default), `btn-new`, `balance`.
import { setup, assert, assertIncludes, getBalance, onboardWallet, railPrincipalText , armPayScan} from '../harness/lib.mjs';
import { openHistory } from '../harness/flow-steps.mjs';
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
  verifies: 'Payer scans (auto-sign, one press): two-wallet real ed25519 sign + relay settle → \'Paid ✓\', balances correct.',
  timeoutMs: 90000,
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
    //     seam fires the app's onCodeScanned → onRequestString → AUTO-SIGN (the review/Approve
    //     hop is gone — the "Pay Now" gate was the press). -------------------------------------
    console.log('[07-scan-pay] injecting B’s request QR via the camera seam (auto-sign)…');
    await armPayScan(driver); // pay-intent gate: arm the scan surface (no-op when already armed)
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, requestQR);

    // --- Auto-sign → the app signs offline + submits to the REAL relay → FakeLedger settles. --
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'payer should reach the Paid screen straight from the scan (auto-sign, no Approve)');
    // L6: the Paid ✓ confirmation must show the ACTUAL recipient name (to_name from the request
    // bytes), not a generic "merchant" label.
    const paidBody = await driver.bodyText();
    assertIncludes(paidBody, 'Bob', 'Paid ✓ confirmation should name the recipient (L6)');
    assert(!/\bmerchant\b/i.test(paidBody), 'Paid ✓ confirmation must not use the generic "merchant" label (L6)');
    console.log('[07-scan-pay] ✓ A reached "Paid ✓" to Bob straight from the scan (L6: real recipient name)');

    // --- A's `$` balance decreased by the amount (the 2.5s poll reconciles). ------------------
    const aliceDown = await driver.waitForText('∂75.00', { timeoutMs: 10_000 });
    assert(aliceDown, `payer A balance should be ∂75.00 (∂100 − ∂25) after the settle`);
    console.log('[07-scan-pay] ✓ A balance ∂100.00 → ∂75.00');

    // --- B was credited (read straight off the ledger — no second browser). -------------------
    const bobAfter = await getBalance(relayBaseURL, bob.publicHex, 0);
    assertEqMoney(bobAfter, PAY_CENTS, 'payee B balance after the settle');
    console.log(`[07-scan-pay] ✓ B credited: 0 → $${(Number(bobAfter) / 100).toFixed(2)}`);

    // --- A's Recent history lists the outgoing payment to B (refreshHistory fired on settle). --
    // IC rail: the row names the payee from the annotation saved on this device at approve time
    // (the request QR's to_name + nonce joined to the ledger row via the echoed memo nonce —
    // flow 172 pins the grammar). The row still must not dump the full principal or raw hex.
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    assert(await openHistory(driver), 'the Recent card should render once the payment lands in history');
    const histBody = await driver.bodyText();
    assertIncludes(histBody, 'to Bob', 'history row should show the payee name (device-saved annotation)');
    assert(!histBody.includes(bobPrincipal), 'history must NOT dump the full principal');
    assert(!histBody.includes(bob.publicHex), 'history must NOT dump the raw 64-char recipient pubkey');
    console.log('[07-scan-pay] ✓ A history shows the outgoing payment to Bob (annotation-named)');

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
