// Flow 20 — offline hand-off (IC rail): the payer's phone has NO network, yet pays. A approves
// bob's request while offline; the app signs a REAL icrc1_transfer envelope (memo = request nonce)
// and shows it as a QR hand-off (base64url envelope bytes). We read the QR payload, walk it over
// to "bob's phone" (the test POSTs it to the fake-IC /api/v2 gateway exactly as the merchant app
// would after scanning), then bring A back online — A's reconcile poll (read_state, keyed by the
// request_id it signed) flips the screen to Paid with the ledger proof. Bob's balance grows.
//
// Rail semantics: the offline branch never POSTs (nothing to dedup on A's side); the envelope QR
// IS the payment; reconciliation is by request_id via read_state — the same terminal state the
// online path reaches, just submitted by the counterparty.
import {setup, assert, assertIncludes, getBalance, faucetAccount, icpCatalog, onboardWallet, accountOf, goOffline, setRelay, armPayScan} from '../harness/lib.mjs';
import {generateKeypair, decodeRequest, buildRequestQR, randNonceHex} from '../harness/wire.mjs';

export const meta = {
  id: '20',
  name: 'offline-handoff',
  journey: 'offline',
  covers: ['offline-pay', 'hand-off', 'reconcile'],
  verifies: 'offline payer signs an icrc1_transfer envelope QR (base64url, memo = request nonce); counterparty submits it to the IC gateway; payer reconnects and reconciles to Paid by request_id (read_state); payee balance grows',
  timeoutMs: 30_000,
};

const PAY_CENTS = 2500;

export async function run() {
  const start = Date.now();
  console.log(`[${meta.name}] pay-journey cutover: offline envelope hand-off + reconcile`);
  const env = await setup();
  try {
    // --- Payee bob (keypair only — the "merchant phone" is the test acting on his behalf). ------
    const bob = await generateKeypair();
    await faucetAccount(env.relayBaseURL, bob.publicHex, 10_000);

    // --- Payer A: onboarded wallet, then OFFLINE before the payment. ---------------------------
    // keepGateway: this flow's DESIGN requires a live IC gateway — the rail submits envelopes to
    // IC (/api/v2), not to the relay, and the counterparty below POSTs the captured envelope at
    // the live gateway. Offline here means relay-dead-only (balance/history polls fail → online
    // flips false → the approx. banner + the offline sign branch); the value path stays up.
    await onboardWallet(env.driver, 'e2e-alice');
    const alice = await accountOf(env.driver);
    await goOffline(env.driver, {keepGateway: true});
    const offlineShown = await env.driver.waitForText('approx.', {timeoutMs: 8_000});
    assert(offlineShown, 'A should show the offline approx. balance banner');
    console.log(`[${meta.name}] ✓ A is offline (~ approx. balance shown)`);

    // --- bob's request QR (built wire-side — his "phone" is this test). ------------------------
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(bob.publicHex, PAY_CENTS, nonce, expiry, 0, 'bob');
    await armPayScan(env.driver); // pay-intent gate: arm the scan surface (no-op when already armed)
    await env.driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);
    // One-press rule (2026-08-24): the scan AUTO-SIGNS while offline. The gateway is ALIVE here
    // (keepGateway), so the sign lands straight in the envelope hand-off QR — the transient sign
    // status may flash by unread on a fast host, so the QR surface is the assert (no Approve press
    // exists; the ∂25.00 amount rides the QR surface's amountBig line).
    await env.driver.waitForText('signed on this device ✓', {timeoutMs: 8_000});

    // --- Offline auto-sign → the hand-off QR (the envelope, base64url). ------------------------
    const qrShown = await env.driver.waitForText('signed on this device ✓', {timeoutMs: 8_000});
    assert(qrShown, 'A offline approval should show the envelope hand-off QR');
    const payload = await env.driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof payload === 'string' && payload.length >= 64, `hand-off QR payload must be the base64url envelope (≥64 chars), got ${payload && payload.length}`);
    console.log(`[${meta.name}] ✓ offline approval produced the envelope QR (${payload.length} chars)`);

    // --- "bob's phone" submits the envelope to the IC gateway. --------------------------------
    // The payload is base64url(envelope bytes) — the exact bytes the merchant app would POST.
    const envelopeBytes = b64urlToBytes(payload);
    const catalog = await icpCatalog(env.relayBaseURL);
    const ledger = catalog.find((c) => c.currency === 0).ledger;
    const submitted = await fetch(`${env.relayBaseURL}/api/v2/canister/${ledger}/call`, {
      method: 'POST',
      headers: {'Content-Type': 'application/cbor'},
      body: envelopeBytes,
    });
    assert(submitted.status === 202, `bob's phone submit must be 202, got ${submitted.status}`);
    console.log(`[${meta.name}] ✓ counterparty submitted the envelope (202)`);

    // --- bob's ledger balance grew by the payment. ---------------------------------------------
    const bobBal = await getBalance(env.relayBaseURL, bob.publicHex, 0);
    assert(bobBal === '12500', `bob must be credited (12500), got ${bobBal}`);
    console.log(`[${meta.name}] ✓ bob credited: 12500`);

    // --- A comes back online → reconcile-by-request_id flips the screen to Paid. ---------------
    await setRelay(env.driver, env.relayBaseURL);
    const paidShown = await env.driver.waitForText('Paid', {timeoutMs: 12_000});
    assert(paidShown, 'A back online should reconcile the hand-off to Paid');
    const body = await env.driver.bodyText();
    assertIncludes(body, '∂25.00', 'A Paid screen should carry the amount');
    console.log(`[${meta.name}] ✓ A reconnected → Paid (reconciled by request_id)`);

    // --- A's balance reflects the debit (100 − 25). --------------------------------------------
    const aliceBal = await getBalance(env.relayBaseURL, alice.publicHex, 0);
    assert(aliceBal === '7500', `A ledger balance must be 7500 after the offline pay, got ${aliceBal}`);
    const shown = await env.driver.waitForText('∂75.00', {timeoutMs: 10_000});
    assert(shown, 'A on-screen balance should show ∂75.00');

    await env.driver.screenshot('20-offline-handoff');
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[${meta.name}] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[${meta.name}] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
