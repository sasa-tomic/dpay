// Flow 92 — the one-shot offline peak (Trip Ready J5).
//
// The FIRST truly-offline CONFIRMED payment earns the campaign moment ("Roaming off. Payment
// on."), which auto-settles into a quiet remnant; every later payment — online OR offline —
// shows nothing (the journey stamp firstOfflinePayment is the one-shot, persisted). This flow
// drives the REAL offline hand-off (flow 20's gateway-live/relay-dead pattern), reconciles to
// Paid, and asserts the peak + its settled remnant; then a SECOND offline payment (quiet), and
// finally the plain ONLINE paid path (flow 03-style) shows no peak ever + the calm paid stamp.
// (The 118px 'dpay' circle stamp inside the peak was dropped by founder directive 2026-08-24 —
// the campaign copy carries the moment alone; the pinned testIDs are unchanged.)
//
// testID contract: `offline-peak` (mounted-but-settled for the card's lifetime — deterministic
// to catch after the ~2s moment), `first-offline-stamp` (the settled remnant mark), and
// `paid-stamp` (the compact calm stamp on every confirmed paid card). The honesty core: the
// pending "Sent" hand-off view (btn-paid) must carry NEITHER the peak NOR the stamp.
import {setup, assert, assertIncludes, getBalance, faucetAccount, onboardWallet, accountOf, goOffline, setRelay, armPayScan} from '../harness/lib.mjs';
import {generateKeypair, buildRequestQR, randNonceHex} from '../harness/wire.mjs';

export const meta = {
  id: '92',
  name: 'offline-peak',
  journey: 'offline',
  covers: ['offline-pay', 'hand-off', 'reconcile', 'delight-peak', 'journey-stamps'],
  verifies: 'first OFFLINE confirmed payment plays the one-shot campaign peak (offline-peak + campaign line → settles to first-offline-stamp remnant); second offline payment and online paid show NO peak; pending hand-off never shows peak or stamp',
  timeoutMs: 45_000,
};

const PAY_CENTS = 2500;

/** Absence assert: the testID must NOT be in the DOM (waitForSelector has no expectMissing;
 *  a direct query is also deterministic — no race with a 5s default timeout). */
const absent = async (driver, testID) => {
  const found = await driver.eval((id) => document.querySelector(`[data-testid="${id}"]`) !== null, testID);
  assert(!found, `testID=${testID} must NOT be present`);
};

/** Visibility gate: the node must exist AND its fade-in must have COMMITTED (computed
 *  opacity ≥ 0.95). The calm stamp animates 0→1 over 560ms (180ms delay + 380ms); a bare
 *  findByTestID passes at opacity 0, so screenshots could catch it mid-fade — this makes
 *  "the stamp shows" a VISUAL truth, not just a DOM truth. */
const waitFadedIn = async (driver, testID, timeoutMs = 3_000) => {
  const t0 = Date.now();
  for (;;) {
    const op = await driver.eval((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return el ? Number(getComputedStyle(el).opacity) : null;
    }, testID);
    if (op !== null && op >= 0.95) return true;
    if (Date.now() - t0 > timeoutMs) {
      assert(false, `testID=${testID} must exist with committed opacity ≥0.95 (last seen ${op})`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
};

export async function run() {
  const start = Date.now();
  console.log(`[${meta.name}] one-shot offline peak: first offline confirmed payment`);
  const env = await setup();
  try {
    const { driver } = env;

    // --- First payment: OFFLINE hand-off (flow 20's pattern — relay dead, IC gateway live). ----
    const bob = await generateKeypair();
    await faucetAccount(env.relayBaseURL, bob.publicHex, 10_000);
    await onboardWallet(driver, 'e2e-alice');
    const alice = await accountOf(driver);
    await goOffline(driver, {keepGateway: true});
    assert(await driver.waitForText('approx.', {timeoutMs: 8_000}), 'A should show the offline approx. banner');

    let nonce = randNonceHex();
    let expiry = Math.floor(Date.now() / 1000) + 600;
    let requestQR = buildRequestQR(bob.publicHex, PAY_CENTS, nonce, expiry, 0, 'bob');
    await armPayScan(driver); // pay-intent gate (btn-new/reset disarmed)
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);
    // One-press rule (2026-08-24): the scan AUTO-SIGNS while offline — the envelope hand-off QR
    // mounts with no Approve press (the read-only "Pay ∂25.00" status flashes by between decode
    // and prepare, so the envelope QR is the stable landing surface).
    assert(await driver.waitForText('signed on this device ✓', {timeoutMs: 10_000}), 'offline auto-sign should show the envelope QR');
    const payload = await driver.eval(() => window.__DPAY_QR_LAST);

    // HONESTY: the hand-off moment (before confirmation) must carry NO peak, NO stamp — the
    // payment is signed, not settled. The "Handed to bob" pending view stays quiet too.
    const qrBody = await driver.bodyText();
    assert(!qrBody.includes('Roaming off'), 'the un-confirmed hand-off QR view must NOT show the campaign line');
    await absent(driver, 'offline-peak');
    await absent(driver, 'paid-stamp');
    console.log(`[${meta.name}] ✓ hand-off moment honest: no peak, no stamp`);

    // Counterparty submits the envelope; A reconciles to Paid.
    const envelopeBytes = b64urlToBytes(payload);
    const catalog = (await (await fetch(`${env.relayBaseURL}/api/v1/currencies`)).json()).currencies;
    const ledger = catalog.find((c) => c.currency === 0).ledger;
    const submitted = await fetch(`${env.relayBaseURL}/api/v2/canister/${ledger}/call`, {
      method: 'POST', headers: {'Content-Type': 'application/cbor'}, body: envelopeBytes,
    });
    assert(submitted.status === 202, `counterparty submit must be 202, got ${submitted.status}`);

    await setRelay(driver, env.relayBaseURL);
    assert(await driver.waitForText('Paid ✓', {timeoutMs: 12_000}), 'A back online should reconcile to Paid ✓');

    // --- THE PEAK: campaign moment on the first offline confirmed payment. ---------------------
    // (Race-hardened 2026-08-23: the peak auto-settles in ~2s and the old find-then-read pair
    // burned 3 CDP roundtrips after Paid ✓ — under full-pool load that gap exceeded the window
    // and the line had settled away. The campaign text mounts in the SAME render as Paid, so a
    // single waitForText started now catches it within one poll of mount, well inside 2s.)
    assert(await driver.waitForText('Roaming off. Payment on.', {timeoutMs: 6_000}), 'the peak must carry the single-sourced campaign line');
    await driver.findByTestID('offline-peak', {timeoutMs: 3_000});
    await driver.screenshot('92-offline-peak-moment');
    console.log(`[${meta.name}] ✓ PEAK visible: campaign line + stamp moment`);

    // Auto-settle (~2s): the wrapper testID persists (mounted-but-settled), the remnant appears,
    // the campaign moment is gone, and Done stays usable (never blocked).
    await driver.waitForText('paid with no signal', {timeoutMs: 6_000});
    await driver.findByTestID('first-offline-stamp', {timeoutMs: 3_000});
    assert(!(await driver.bodyText()).includes('No signal the whole time'), 'the moment microcopy must settle away');
    await driver.screenshot('92-offline-peak-settled');
    console.log(`[${meta.name}] ✓ peak settled into the quiet remnant (first-offline-stamp)`);

    // --- Second offline payment: NOTHING (one-shot, persisted via the journey stamp). -----------
    // New nonce + fresh request from bob; A stays on the paid card → New payment → offline again.
    await driver.click('btn-new', {timeoutMs: 4_000});
    await goOffline(driver, {keepGateway: true});
    assert(await driver.waitForText('approx.', {timeoutMs: 8_000}), 'A offline again for the second payment');
    nonce = randNonceHex();
    expiry = Math.floor(Date.now() / 1000) + 600;
    requestQR = buildRequestQR(bob.publicHex, PAY_CENTS, nonce, expiry, 0, 'bob');
    await armPayScan(driver); // pay-intent gate (btn-new/reset disarmed)
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);
    assert(await driver.waitForText('signed on this device ✓', {timeoutMs: 10_000}), 'second offline auto-sign shows the envelope QR');
    const payload2 = await driver.eval(() => window.__DPAY_QR_LAST);
    const submitted2 = await fetch(`${env.relayBaseURL}/api/v2/canister/${ledger}/call`, {
      method: 'POST', headers: {'Content-Type': 'application/cbor'}, body: b64urlToBytes(payload2),
    });
    assert(submitted2.status === 202, `second submit must be 202, got ${submitted2.status}`);
    await setRelay(driver, env.relayBaseURL);
    assert(await driver.waitForText('Paid ✓', {timeoutMs: 12_000}), 'second offline payment reconciles to Paid ✓');

    // No peak anywhere (neither the moment nor the remnant), no campaign line; the CALM paid
    // stamp still shows (it is not the one-shot — only the peak is) — faded-in, not just mounted.
    await absent(driver, 'offline-peak');
    await absent(driver, 'first-offline-stamp');
    assert(!(await driver.bodyText()).includes('Roaming off'), 'second offline paid must NOT re-run the peak');
    await waitFadedIn(driver, 'paid-stamp');
    console.log(`[${meta.name}] ✓ second offline payment: quiet (no peak), calm stamp only`);

    // --- The ONLINE paid path never peaks — but the calm stamp rides the confirmed card. -------
    await driver.click('btn-new', {timeoutMs: 4_000});
    assert(await driver.waitForText('∂50.00', {timeoutMs: 10_000}), 'A is back online (live balance ∂50.00)');
    nonce = randNonceHex();
    expiry = Math.floor(Date.now() / 1000) + 600;
    requestQR = buildRequestQR(bob.publicHex, PAY_CENTS, nonce, expiry, 0, 'bob');
    await armPayScan(driver); // pay-intent gate (btn-new/reset disarmed)
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR);
    // Online auto-sign: decode → sign → submitTransfer → settled → Paid ✓ (no Approve press).
    assert(await driver.waitForText('Paid ✓', {timeoutMs: 12_000}), 'online auto-sign settles to Paid ✓ (flow 03-style)');
    await absent(driver, 'offline-peak');
    assert(!(await driver.bodyText()).includes('Roaming off'), 'the ONLINE paid path must NEVER peak');
    await waitFadedIn(driver, 'paid-stamp');
    console.log(`[${meta.name}] ✓ online paid: no peak ever, calm stamp only`);

    // Ledger truth after all three payments (100 − 25 − 25 − 25).
    const aliceBal = await getBalance(env.relayBaseURL, alice.publicHex, 0);
    assert(aliceBal === '2500', `A ledger balance must be 2500 after three pays, got ${aliceBal}`);
    const bobBal = await getBalance(env.relayBaseURL, bob.publicHex, 0);
    assert(bobBal === '17500', `bob must hold 17500, got ${bobBal}`);

    await driver.screenshot('92-offline-peak-online-quiet');
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
