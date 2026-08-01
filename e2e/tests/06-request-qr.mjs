// Flow 06 — Request QR (receive): renders a QR AND decodes to a 132-byte request with verified fields.
//
// Drives the REAL app's ReceiveMode: enter an amount → click btn-request → the app builds a
// PaymentRequest via DpayCore.encodeRequest (base64url of the 132-byte request) and renders it as a
// QR carrying the base64url (the merchant's username rides as `to_name` INSIDE the bytes; the old
// `|name` suffix is gone). This flow asserts (1) the QR renders, then (2) DECODES the request
// bytes field-for-field against the wire layout (dfx/wire_layout.json) and verifies:
//   - to        == this wallet's account (its pubkey hex) — the deposit destination
//   - amount    == the entered amount in minor units (cents)
//   - expiry    == a sane near-future unix-seconds value (now < expiry < now + EXPIRY_WINDOW)
//   - currency  == 0 (DEMO_USD — the wallet's single `$` asset)
//   - to_name   == the merchant's username (now in the bytes)
//   - length    == 132 bytes (REQUEST_LEN)
// The QR value is read via the __DPAY_QR_LAST shim seam (the QR pixels already encode it; the seam
// exposes it readably so the test decodes the EXACT bytes a payer would scan — not an OCR guess).
//
// Selector contract: `tab-receive`, `amount-input`, `btn-request`, `request-qr`.
import { setup, assert, assertEq, onboardWallet, accountOf } from '../harness/lib.mjs';
import { decodeRequest, REQUEST_LEN } from '../harness/wire.mjs';

const EXPIRY_WINDOW_SLACK = 700; // EXPIRY_WINDOW=600 in App.tsx + a few seconds of test latency

export async function run() {
  const start = Date.now();
  console.log('[06-request-qr] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Onboard → wallet; capture this wallet's account (pubkey hex) to verify the request's `to`.
    console.log('[06-request-qr] onboarding…');
    await onboardWallet(driver, 'e2e-bob');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be 32-byte hex, got "${accountHex}"`);

    // 2. Switch to Receive + enter an amount. amount-input defaults to "25.00"; set 42.50 → 4250 cents.
    console.log('[06-request-qr] receive mode → request…');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '42.50', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });

    // 3. The request QR renders (the `request-qr` container is the gate).
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });

    // L4: the offline-payer affordance uses clear merchant-facing wording (not the ambiguous
    // "Payer offline? Scan their QR").
    const reqBody = await driver.bodyText();
    assert(/payer paid offline/i.test(reqBody) && /scan to settle/i.test(reqBody),
      `request screen should show the clear offline-payer affordance (L4). body excerpt:\n${reqBody.slice(0, 400)}`);
    console.log('[06-request-qr] ✓ offline-payer affordance wording is clear (L4)');

    // 4. Read the EXACT value the QR encodes via the shim seam, then decode the 132-byte request.
    //    The QR is now PLAIN base64url (the merchant's `to_name` lives inside the bytes — wire-format
    //    v2; the old `<b64>|<name>` suffix is GONE).
    const qrValue = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof qrValue === 'string' && qrValue.length > 0, `__DPAY_QR_LAST should hold the request QR value, got "${qrValue}"`);
    assert(!qrValue.includes('|'), `request QR must be plain base64url (no |name suffix), got "${qrValue}"`);
    const req = decodeRequest(qrValue);
    const now = Math.floor(Date.now() / 1000);

    // 5. Verify every field byte-exact against the wallet's account + the entered amount.
    assertEq(req.toHex, accountHex, 'request.to == this wallet account (the deposit destination)');
    assertEq(req.amount, '4250', 'request.amount == entered 42.50 in minor units (cents)');
    assert(req.expiry > now, `request.expiry must be in the future (got ${req.expiry}, now ${now})`);
    assert(req.expiry < now + EXPIRY_WINDOW_SLACK, `request.expiry must be within the ~10min window (got ${req.expiry}, now ${now})`);
    assertEq(req.currency, 0, 'request.currency == DEMO_USD (the wallet `$` asset)');
    // The merchant's own username rides as `to_name` INSIDE the request bytes now.
    assertEq(req.toName, 'e2e-bob', 'request.to_name == the merchant username (now in the bytes, not a suffix)');
    assertEq(req.memo, '', 'request.memo == empty (no memo entered)');
    // decodeRequest already enforces length == REQUEST_LEN; assert explicitly for the contract.
    assertEq(REQUEST_LEN, 132, 'REQUEST_LEN (the frozen request wire size — 132 bytes with to_name + memo)');
    console.log(`[06-request-qr] ✓ decoded 132-byte request: to=${req.toHex.slice(0, 12)}… amount=${req.amount} to_name=${req.toName} expiry=+${req.expiry - now}s currency=${req.currency}`);

    await driver.screenshot('06-request-qr');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[06-request-qr] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[06-request-qr] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
