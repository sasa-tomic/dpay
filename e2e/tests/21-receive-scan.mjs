// Flow 21 — Receive-side "Payer paid offline? Scan to settle" path.
//
// The Receive screen's offline-payer affordance: after the merchant generates a request QR, if the
// PAYER is the offline party (the signature feature inverted — merchant online, payer offline), the
// merchant can SCAN the payer's signed QR instead of waiting for the payer to submit online. The
// merchant's app POSTs the scanned signed auth to /api/v1/pay → the FakeLedger verifies the payer's
// on-device sig + settles → the merchant's /receipt poll confirms → "Received $X".
//
// Proves the full path through the REAL app + REAL relay:
//   1. Merchant B onboards, requests ∂25 → the request QR screen renders with the
//      "Payer paid offline? Scan to settle" affordance.
//   2. Click it → the QrScanner mounts (scanning=true); the affordance label swaps to
//      "Scan the payer's signed QR".
//   3. The payer (generated in-test, faucet-funded) signs an authorization for B's EXACT request
//      (byte-exact wire via wire.mjs) and the test injects the signed code via the camera seam.
//   4. B's onSignedQr POSTs /api/v1/pay → FakeLedger verifies the sig + settles (credits B).
//   5. B's /receipt poll reconciles → "Received ∂25.00" + B's balance grows to ∂125.
//
// This mirrors flow 08 (merchant-settle) but drives the SETTLE through the app's OWN scan→submit
// path (onSignedQr), not a direct postPay — proving the "Payer paid offline? Scan to settle"
// affordance is wired end-to-end. The signing is REAL (byte-exact vs Rust, cross-validated in 00).
//
// Selector contract: `tab-receive`, `amount-input`, `btn-request`, `request-qr`, `balance`.
import { setup, assert, getBalance, onboardWallet, accountOf } from '../harness/lib.mjs';
import { generateKeypair, decodeRequest, signAuthorizationCode } from '../harness/wire.mjs';

const PAY_CENTS = 2500; // ∂25.00

export async function run() {
  const start = Date.now();
  console.log('[21-receive-scan] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // The payer (offline party): generated + faucet-funded in-test. Signs B's request offline.
    const alice = await generateKeypair();
    const fundA = await fetch(`${relayBaseURL}/api/v1/faucet`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: alice.publicHex, amount: 10_000 }),
    });
    assert(fundA.ok, `payer faucet funding must succeed, got ${fundA.status}`);
    console.log(`[21-receive-scan] payer A (funded ∂100): ${alice.publicHex.slice(0, 16)}…`);

    // Merchant B onboards in the browser.
    console.log('[21-receive-scan] onboarding merchant B…');
    await onboardWallet(driver, 'e2e-merchant-scan');
    const bob = await accountOf(driver);
    const bobHex = bob.publicHex;

    // B requests ∂25 → the request QR screen renders.
    console.log('[21-receive-scan] B requesting ∂25.00…');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '25.00', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });

    // Decode B's request to get the exact nonce/expiry A must sign over.
    const requestQR = await driver.eval(() => window.__DPAY_QR_LAST);
    const req = decodeRequest(requestQR);
    assert(req.toHex.toLowerCase() === bobHex.toLowerCase(), 'B request.to == B account');

    // L4: the offline-payer affordance uses clear merchant-facing language (not the ambiguous
    // "Payer offline? Scan their QR").
    const beforeScan = await driver.bodyText();
    assert(/payer paid offline/i.test(beforeScan) && /scan to settle/i.test(beforeScan),
      `the request screen should show "Payer paid offline? Scan to settle.". body excerpt:\n${beforeScan.slice(0, 500)}`);
    console.log('[21-receive-scan] ✓ "Payer paid offline? Scan to settle." affordance visible (L4)');

    // Click it → the scanner mounts. The affordance is a Pressable with no testID — click by text.
    // RNW renders Pressables as plain elements (not <button>), so search the full DOM for the label.
    await driver.eval(() => {
      const nodes = Array.from(document.querySelectorAll('text, span, div, a, button, [role]'));
      const target = nodes.find(e => /scan to settle/i.test((e.textContent || '').trim()) && e.children.length === 0);
      if (!target) throw new Error('affordance text node not found');
      // Walk up to the nearest clickable (the Pressable wrapper).
      let el = target;
      for (let i = 0; i < 5 && el; i++) {
        el.click?.();
        el = el.parentElement;
      }
    });
    const scanning = await driver.waitForText("Scan the payer's signed QR", { timeoutMs: 5_000 });
    assert(scanning, 'clicking the affordance should mount the scanner (label swaps)');
    console.log('[21-receive-scan] ✓ scanner mounted (scanning for the payer’s signed QR)');

    // A signs B's request offline (byte-exact wire) → inject via the camera seam → B submits it.
    console.log('[21-receive-scan] A signing offline + injecting the signed QR…');
    const code = await signAuthorizationCode(alice.secretHex, bobHex, PAY_CENTS, req.nonceHex, req.expiry, 0);
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), code);

    // B's onSignedQr POSTs /pay → FakeLedger settles → /receipt poll confirms → "Received ∂25".
    const received = await driver.waitForText('Received', { timeoutMs: 12_000 });
    assert(received, 'merchant B should reach "Received ∂25.00" after scanning the payer’s signed QR');
    console.log('[21-receive-scan] ✓ B received (app scanned + submitted the payer’s signed QR)');

    // B's balance grew by ∂25 (ledger-sourced — the FakeLedger credited B's subaccount).
    const bobUp = await driver.waitForText('∂125.00', { timeoutMs: 10_000 });
    assert(bobUp, 'merchant B balance should be ∂125.00 (∂100 + ∂25)');
    const bobLedger = await getBalance(relayBaseURL, bobHex, 0);
    assert(bobLedger === '12500', `B ledger balance must be 12500 cents, got ${bobLedger}`);
    console.log('[21-receive-scan] ✓ B balance ∂100.00 → ∂125.00 (credited through the scan→submit path)');

    await driver.screenshot('21-receive-scan');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[21-receive-scan] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[21-receive-scan] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
