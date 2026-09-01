// Flow 92 — the one-shot offline peak (Trip Ready J5).
//
// The FIRST truly-offline CONFIRMED payment earns the campaign moment ("Signal? Don't need
// it."), which auto-settles into a quiet remnant; every later payment — online OR offline —
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
import {setup, assert, assertIncludes, getBalance, faucetAccount, icpCatalog, onboardWallet, accountOf, goOffline, setRelay, armPayScan} from '../harness/lib.mjs';
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
    assert(!qrBody.includes("Don't need it"), 'the un-confirmed hand-off QR view must NOT show the campaign line');
    await absent(driver, 'offline-peak');
    await absent(driver, 'paid-stamp');
    console.log(`[${meta.name}] ✓ hand-off moment honest: no peak, no stamp`);

    // Counterparty submits the envelope; A reconciles to Paid.
    const envelopeBytes = b64urlToBytes(payload);
    const catalog = await icpCatalog(env.relayBaseURL);
    const ledger = catalog.find((c) => c.currency === 0).ledger;
    const submitted = await fetch(`${env.relayBaseURL}/api/v2/canister/${ledger}/call`, {
      method: 'POST', headers: {'Content-Type': 'application/cbor'}, body: envelopeBytes,
    });
    assert(submitted.status === 202, `counterparty submit must be 202, got ${submitted.status}`);

    // --- THE PEAK: campaign moment on the first offline confirmed payment. ---------------------
    // (Race-hardened 2026-08-24, round 2: the reconcile poll rides the IC GATEWAY — which
    // goOffline({keepGateway:true}) deliberately keeps ALIVE — not the relay. Paid ✓ and the
    // peak therefore mount WHILE THE RELAY IS STILL DEAD, and the peak auto-settles in ~2s.
    // Round 1 (2026-08-23) only removed CDP roundtrips AFTER Paid ✓; the setRelay "come back
    // online" dance (a 5-click UI roundtrip through Settings) sat BETWEEN the counterparty
    // submit and the first wait — under pool load it alone burned the whole 2s window. The fix:
    // wait for Paid + the moment + the settled remnant with the relay still dead (none of them
    // need the relay), and only THEN setRelay — the dance can no longer race the moment.)
    assert(await driver.waitForText('Paid ✓', {timeoutMs: 12_000}), 'the gateway reconcile should flip the hand-off to Paid ✓ (relay still dead)');
    assert(await driver.waitForText("Signal? Don't need it.", {timeoutMs: 6_000}), 'the peak must carry the single-sourced campaign line');
    await driver.findByTestID('offline-peak', {timeoutMs: 3_000});
    await driver.screenshot('92-offline-peak-moment');
    console.log(`[${meta.name}] ✓ PEAK visible: campaign line + stamp moment`);

    // Auto-settle (~2s): the wrapper testID persists (mounted-but-settled), the remnant appears,
    // the campaign moment is gone, and Done stays usable (never blocked).
    //
    // The remnant is read through its OWN node rather than through the page text, and that is the
    // whole point: `S.peakSettledText` is `textTransform: 'uppercase'` while `waitForText` matches
    // `innerText`, which APPLIES the transform — so a page-wide wait for the lowercase source
    // string could never match. It never did. The flow used to discard that wait's `false`, burn
    // its six seconds, and lean on the next selector, which left the settle unverified and the
    // remaining budget too thin under load (this is what the 2026-09-01 REDs were). `readText`
    // reads `textContent`, which is the source string, so the assertion is the copy the component
    // actually renders.
    await driver.findByTestID('first-offline-stamp', {timeoutMs: 8_000});
    assertIncludes(await driver.readText('first-offline-stamp'), 'paid with no signal',
      'the peak must auto-settle into the quiet remnant carrying its settled line');
    assert(!(await driver.bodyText()).includes('No signal the whole time'), 'the moment microcopy must settle away');
    await driver.screenshot('92-offline-peak-settled');
    console.log(`[${meta.name}] ✓ peak settled into the quiet remnant (first-offline-stamp)`);

    // NOW come back online (deferred past the whole peak moment — see the race note above). The
    // remaining legs of this flow (second payment's balance display, the online ∂50.00 check)
    // need the live relay; the peak moment never did.
    await setRelay(driver, env.relayBaseURL);

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
    assert(!(await driver.bodyText()).includes("Don't need it"), 'second offline paid must NOT re-run the peak');
    await driver.waitAtRest('paid-stamp', {timeoutMs: 6_000});
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
    assert(!(await driver.bodyText()).includes("Don't need it"), 'the ONLINE paid path must NEVER peak');
    await driver.waitAtRest('paid-stamp', {timeoutMs: 6_000});
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
