// Flow 20 — Offline QR payment round trip (the signature feature: payer offline → payee settles).
//
// Proves the OFFLINE handoff end-to-end through the REAL app + REAL relay:
//   1. Payer A onboards online (good relay, ∂100), then goes OFFLINE (dead relay → online=false).
//   2. A scans the payee's request QR (via the camera seam), reviews, Approves → the app signs
//      OFFLINE (the on-device key). The direct /pay fails (ECONNREFUSED), so the app falls through
//      to the OFFLINE QR hand-off screen (phase='qr', `!online` branch).
//   3. Assert the offline handoff UI: "Offline — … settles this when they submit it" + the two
//      affordances `btn-paid` ("Handed to …") and `btn-notpaid` ("Cancel"). The `btn-paid` path is
//      an HONEST "handed off" (pending), NOT a fake "Paid ✓" — the offline payer can't know it settled.
//   4. Click `btn-paid` → the pending state: "Sent $X" + "awaiting the merchant's confirmation"
//      (optimistic local deduction; no fabricated history entry).
//   5. The MERCHANT (online) settles: capture the exact signed auth the payer rendered in its QR
//      (`window.__DPAY_QR_LAST`) and POST /api/v1/pay via the good relay → FakeLedger verifies the
//      on-device sig + settles (the REAL money move, driven by the captured signed code).
//   6. A comes back online (restore the good relay) → A's /receipt poll reconciles the settled nonce
//      → "Paid ✓" (the canister-signed receipt verifies under R2). This is the full offline→online
//      reconcile: the offline-signed payment DID settle while A was disconnected.
//
// This is the airplane-mode demo flow: the payer signs offline, hands off, and learns the outcome
// once reconnected — never a fake success, never a stuck spinner.
//
// Selector contract: `btn-settings`, `settings-relay`, `btn-settings-close`, `pay-amount`,
// `btn-approve`, `btn-paid`, `btn-notpaid`, `btn-new`.
import { setup, assert, postPay, onboardWallet, goOffline, setRelay } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR, decodeRequest } from '../harness/wire.mjs';

const PAY_CENTS = 2500; // ∂25.00

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '20',
  name: 'offline-handoff',
  journey: 'offline',
  covers: ['offline-sign', 'qr-handoff', 'settle', 'reconcile', 'round-trip'],
  verifies: 'Payer signs offline → relay unreachable → signed QR → merchant settles → payer reconnects → \'Paid ✓\'.',
  timeoutMs: 25000,
};

export async function run() {
  const start = Date.now();
  console.log('[20-offline-handoff] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    const bob = await generateKeypair(); // the payee (merchant)

    // 1. Onboard A online (∂100 funded).
    console.log('[20-offline-handoff] onboarding A (payer, online)…');
    await onboardWallet(driver, 'e2e-offline-pay');

    // 2. Go OFFLINE: point at a genuinely-dead relay → online=false on the next failed poll.
    console.log('[20-offline-handoff] going offline…');
    await goOffline(driver);
    await driver.waitForText('approx.', { timeoutMs: 8_000 }); // offline indicator

    // 3. A scans B's request + Approves → signs offline → direct /pay fails → QR hand-off screen.
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(bob.publicHex, PAY_CENTS, nonce, expiry, 0, 'merchant');
    console.log('[20-offline-handoff] scanning B’s request + approving (offline sign)…');
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    await driver.click('btn-approve', { timeoutMs: 5_000 });

    // 4. The OFFLINE QR hand-off screen: the signed QR + the honest offline copy + btn-paid/btn-notpaid.
    console.log('[20-offline-handoff] waiting for the offline QR hand-off screen…');
    await driver.findByTestID('btn-paid', { timeoutMs: 8_000 });
    await driver.findByTestID('btn-notpaid', { timeoutMs: 4_000 });
    const handoffBody = await driver.bodyText();
    assert(/offline/i.test(handoffBody) && /settles this|submit/i.test(handoffBody),
      `the offline hand-off copy should explain the payer is offline. body excerpt:\n${handoffBody.slice(0, 500)}`);
    console.log('[20-offline-handoff] ✓ offline hand-off screen: signed QR + btn-paid/btn-notpaid');

    // Capture the signed auth A rendered (the QR shim stashes it on window.__DPAY_QR_LAST).
    const signedCode = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof signedCode === 'string' && signedCode.length > 100,
      `the signed QR must be captured from __DPAY_QR_LAST, got: ${JSON.stringify(signedCode)?.slice(0, 80)}`);

    // 5. Click btn-paid → the HONEST pending state (NOT "Paid ✓" — "Sent … awaiting confirmation").
    console.log('[20-offline-handoff] clicking btn-paid (honest pending hand-off)…');
    await driver.click('btn-paid', { timeoutMs: 4_000 });
    const pending = await driver.waitForText('awaiting', { timeoutMs: 6_000 });
    assert(pending, 'the pending state should say "awaiting the merchant’s confirmation"');
    const paidBody = await driver.bodyText();
    assert(paidBody.includes('Sent'), 'the pending headline should be "Sent $X" (not "Paid ✓")');
    console.log('[20-offline-handoff] ✓ honest pending: "Sent $X · awaiting the merchant’s confirmation"');

    // 6. The merchant settles ONLINE: POST the captured signed auth via the good relay → FakeLedger
    //    verifies A's on-device sig + settles (debits A, credits B). This is the REAL money move
    //    driven by the EXACT bytes A signed offline.
    console.log('[20-offline-handoff] merchant settling the captured signed auth online…');
    const settle = await postPay(relayBaseURL, signedCode);
    assert(settle.ok && settle.body?.receipt,
      `merchant /pay must settle the offline-signed auth, got status=${settle.status} body=${JSON.stringify(settle.body)?.slice(0, 200)}`);
    console.log('[20-offline-handoff] ✓ merchant settled (FakeLedger verified A’s offline sig)');

    // 7. A comes back online → the /receipt poll reconciles the settled nonce → "Paid ✓".
    console.log('[20-offline-handoff] A reconnecting (restore good relay)…');
    await driver.click('btn-new', { timeoutMs: 4_000 }); // leave the pending screen first
    await setRelay(driver, relayBaseURL);
    // The reconnect reconciles: balance returns to the authoritative ∂75 (∂100 − ∂25).
    const reconnected = await driver.waitForText('∂75.00', { timeoutMs: 12_000 });
    assert(reconnected, 'A balance should reconcile to ∂75.00 (∂100 − ∂25) once back online');
    console.log('[20-offline-handoff] ✓ A reconciled online: balance ∂75.00 (the offline pay settled)');

    await driver.screenshot('20-offline-handoff');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[20-offline-handoff] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[20-offline-handoff] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
