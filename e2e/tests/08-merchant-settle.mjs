// Flow 08 — Merchant receive → settle (the RECIPIENT side, explicitly).
//
// The mirror of flow 07 from the recipient's perspective. Wallet B (the merchant) is onboarded in
// the browser; wallet A (the payer) is generated + faucet-funded in-test, then signs an
// authorization for B's request and submits it directly via /api/v1/pay (A is the online payer). B's
// app polls /api/v1/receipt/<nonce> and flips to "Received $X". Asserts the recipient-side state
// EXPLICITLY:
//   - B's app reaches "Received $30.00".
//   - B's `$` balance grew by the amount (currency 0).
//   - B's Recent history shows the INCOMING payment from A (the recipient row, not the payer row).
// This is the "merchant online-confirm" half of the two-phone flow: the recipient learns the
// payment settled through the ledger-sourced receipt poll, not a payer-presented claim.
//
// Selector contract: `tab-receive`, `amount-input`, `btn-request`, `request-qr`, `balance`.
import { setup, assert, assertIncludes, getBalance, postPay } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, decodeRequest, signAuthorizationCode } from '../harness/wire.mjs';

const ONBOARD_PLACEHOLDER = 'e.g. Alice';
const PAY_CENTS = 3000; // $30.00

export async function run() {
  const start = Date.now();
  console.log('[08-merchant-settle] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // --- wallet A (payer): generated + faucet-funded in-test (the online payer). ----------------
    const alice = await generateKeypair();
    // Fund A via the faucet so it can pay (mirrors onboarding's faucet POST).
    const fundA = await fetch(`${relayBaseURL}/api/v1/faucet`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: alice.publicHex, amount: 10_000 }),
    });
    assert(fundA.ok, `payer A faucet funding must succeed, got ${fundA.status}`);
    console.log(`[08-merchant-settle] wallet A (payer, funded $100): ${alice.publicHex.slice(0, 16)}…`);

    // --- wallet B (merchant): onboarded in the browser. ---------------------------------------
    console.log('[08-merchant-settle] onboarding wallet B (merchant)…');
    await driver.typeByPlaceholder(ONBOARD_PLACEHOLDER, 'e2e-merchant', { timeoutMs: 8_000 });
    await driver.click('btn-create', { timeoutMs: 4_000 });
    await driver.findByTestID('balance', { timeoutMs: 10_000 });
    await driver.waitForText('$100.00', { timeoutMs: 12_000 });
    const bob = await driver.eval(() => JSON.parse(localStorage.getItem('dpay.identity.v1') ?? 'null'));
    const bobHex = bob.publicHex;

    // --- B creates a $30 receive request; read the request QR the app rendered + decode it. ----
    console.log('[08-merchant-settle] B requesting $30.00…');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '30.00', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });
    const requestQR = await driver.eval(() => window.__DPAY_QR_LAST);
    const req = decodeRequest(requestQR);
    assertEqHex(req.toHex, bobHex, 'B request.to == B account');
    assertEq(req.amount, PAY_CENTS, 'B request.amount == $30.00');
    console.log(`[08-merchant-settle] B request nonce=${req.nonceHex.slice(0, 12)}…`);

    // --- A (online payer) signs an authorization for B's request and submits it directly. -----
    // The signed wire is byte-exact vs the app (cross-validated in test 00), so the FakeLedger
    // verifies A's sig + settles: debit A, credit B.
    console.log('[08-merchant-settle] A signing + submitting the authorization…');
    const code = await signAuthorizationCode(alice.secretHex, bobHex, PAY_CENTS, req.nonceHex, req.expiry, 0);
    const pay = await postPay(relayBaseURL, code);
    assert(pay.ok && pay.body?.receipt, `A's /pay must settle, got status=${pay.status} body=${JSON.stringify(pay.body)}`);
    assert(pay.body.replayed === false, 'first pay must not be a replay');
    console.log('[08-merchant-settle] ✓ A settled (FakeLedger verified + debited A, credited B)');

    // --- B's app confirms receipt via its /receipt poll → "Received $30.00". -------------------
    const received = await driver.waitForText('Received', { timeoutMs: 10_000 });
    assert(received, 'merchant B should reach the "Received" screen via the receipt poll');
    console.log('[08-merchant-settle] ✓ B app shows "Received" (ledger-sourced confirmation)');

    // --- B's `$` balance grew by the amount. --------------------------------------------------
    const bobUp = await driver.waitForText('$130.00', { timeoutMs: 10_000 });
    assert(bobUp, `merchant B balance should be $130.00 ($100 + $30) after the settle`);
    const bobLedger = await getBalance(relayBaseURL, bobHex, 0);
    assert(bobLedger === 13_000, `B ledger balance must be 13000 cents, got ${bobLedger}`);
    console.log('[08-merchant-settle] ✓ B balance $100.00 → $130.00');

    // --- B's Recent history shows the INCOMING payment from A (recipient row). ----------------
    const hasHistory = await driver.waitForText('RECENT', { timeoutMs: 8_000 });
    assert(hasHistory, 'B history should render the incoming payment');
    const histBody = await driver.bodyText();
    assertIncludes(histBody, alice.publicHex.slice(0, 8), 'B history row should name the payer (short pubkey)');
    console.log('[08-merchant-settle] ✓ B history shows the incoming payment from A');

    await driver.screenshot('08-merchant-settle');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[08-merchant-settle] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

function assertEq(actual, expected, label) {
  if (actual !== expected) throw new Error(`[assert] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertEqHex(a, b, label) {
  if (String(a).toLowerCase() !== String(b).toLowerCase()) throw new Error(`[assert] ${label}: expected ${b}, got ${a}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[08-merchant-settle] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
