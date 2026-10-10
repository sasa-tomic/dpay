#!/usr/bin/env node
// One-off: stage presentable landing screenshots (shot-*.png) from the REAL app — no mocks beyond
// the documented e2e seams (__DPAY_TEST_SCAN / __DPAY_TEST_NFC_SESSION). Drives the real app in
// the shared e2e harness (relay + web + headless chrome), onboards "Alex", and captures the seven
// landing states for the ONE-PRESS payment flow (founder directive 2026-08-24):
//   request (the shop's request QR), paying (the auto-sign status right after the scan — "Paying /
//   Pay ∂5.00 / to Café Demo / Signing…"), scanned (offline hand-off QR), paid (online settle →
//   Paid ✓), nfc-listen, nfc-exchange, nfc-paid.
// There is NO review card anymore on the camera/NFC rails: the "Pay Now" gate (btn-start-scan)
// was the single deliberate press, so a scanned/tapped payable request signs immediately (the
// deeplink entry keeps its review + Approve — not a landing beat).
// Payment narrative: Alex pays Café Demo ∂5.00 (currency 0 DEMO).
//
// The paying beat is transient by design — a fast local settle flashes past the sign status in a
// few hundred ms (flow 31 notes the same race). To land the shot, the driver briefly HOLDS the
// ledger's /api/v2/canister/<ledger>/call POST via request interception: the app is genuinely
// mid-sign-submit (busy=true → "Signing…") while the screenshot lands, then the held request
// continues and the settle completes through the real gateway. Nothing is faked.
//
// Output: e2e/shots/staging/*.png (copied into crates/dpay-relay/assets/ by hand after visual
// review — NOT automatic, so a bad capture never ships).
import {setup, onboardWallet, goOffline, armPayScan, armNfcCard, stopSession} from './harness/lib.mjs';
import {generateKeypair, randNonceHex, buildRequestQR} from './harness/wire.mjs';
import {mkdirSync} from 'node:fs';

const OUT = 'staging'; // driver.screenshot prefixes e2e/shots/
const PAY_CENTS = 500; // ∂5.00

const env = await setup();
mkdirSync('e2e/shots/staging', {recursive: true});
try {
  const {driver, relayBaseURL} = env;
  const cafe = await generateKeypair(); // the merchant (payee)

  // Arm the NFC seam BEFORE the wallet mounts (same ordering as flow 11).
  await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

  // 1. Onboard Alex (online, ∂100 funded).
  await onboardWallet(driver, 'Alex');

  // --- request: merchant-side Receive request-QR (Alex's own request for the narrative shots) ----
  await driver.click('tab-receive', {timeoutMs: 4000});
  await driver.type('amount-input', '5.00', {timeoutMs: 4000});
  await driver.click('btn-request', {timeoutMs: 4000});
  await driver.findByTestID('request-qr', {timeoutMs: 5000});
  await driver.screenshot(`${OUT}/shot-request`);
  console.log('✓ shot-request (Alex request ∂5.00)');

  // Back to Pay mode for the payment narrative.
  await driver.click('tab-pay', {timeoutMs: 4000});
  await driver.findByTestID('pay-scan', {timeoutMs: 5000});

  // --- NFC trio: listen → exchange → paid (seam-driven phases, payer role) -----------------------
  const dispatch = async (event) => { await armNfcCard(driver, 'ic'); return driver.eval((e) => window.__DPAY_TEST_NFC_SESSION(e), event); };

  // listen: dispatch linking phase → NfcTapView mounts with the big NFC mark + "Hold near…" copy,
  // then dispatch listening again? No — listening is not a dispatchable phase (linking is terminal-
  // guarded). The honest staged listen state IS the linking "Connecting…" view. For the classic
  // "Hold near the other phone / dpay is listening for a tap" state we dispatch linking FIRST to
  // mount nfc-status, and screenshot — the marketing 'listen' beat.
  await dispatch({type: 'phase', role: 'card', phase: 'linking'});
  await driver.findByTestID('nfc-status', {timeoutMs: 5000});
  await driver.waitForText('Connecting', {timeoutMs: 5000});
  await driver.screenshot(`${OUT}/shot-nfc-listen`);
  console.log('✓ shot-nfc-listen (NFC armed, Connecting…)');

  // exchange: dispatch request → autoSign → exchanging ("Communicating…" + "Paying ∂5.00").
  const startedSecs = Math.floor(Date.now() / 1000);
  await dispatch({
    type: 'request', role: 'card',
    toHex: cafe.publicHex, amount: String(PAY_CENTS), nonceHex: randNonceHex(),
    expiry: startedSecs + 300, currency: 0,
  });
  await driver.findByTestID('nfc-status', {timeoutMs: 5000});
  await driver.waitForText('Communicating', {timeoutMs: 5000});
  await driver.screenshot(`${OUT}/shot-nfc-exchange`);
  console.log('✓ shot-nfc-exchange (Communicating… Paying ∂5.00)');

  // paid: success phase → "Paid ✓".
  await dispatch({type: 'phase', role: 'card', phase: 'success'});
  await driver.waitForText('Paid', {timeoutMs: 5000});
  await driver.screenshot(`${OUT}/shot-nfc-paid`);
  console.log('✓ shot-nfc-paid (Paid ✓)');
  // Done button has no testID — RN-web maps accessibilityLabel to aria-label.
  {
    const done = await driver.page.waitForSelector('[aria-label="Done"]', {timeout: 4000});
    if (done) await done.click().catch(() => {});
  }

  // --- online scan-to-pay: paying (auto-sign status) → paid (settled success) --------------------
  // One-press: the scan AUTO-SIGNS (no review card). shot-paid must come from the ONLINE path:
  // the auto-sign submits through the gateway, the settle lands, and the paid phase renders
  // "Paid ✓" with a verified receipt. The offline hand-off CANNOT get there on its own — its
  // "Handed to…" button enters a terminal pending clock state (the receipt poll only runs while
  // the hand-off QR is on screen), so staging paid offline would require faking state.
  const nowSecs = Math.floor(Date.now() / 1000);
  const onlineReq = buildRequestQR(cafe.publicHex, PAY_CENTS, randNonceHex(), nowSecs + 600, 0, 'Café Demo');
  await armPayScan(driver); // ensure the scan surface is live (no-op when already armed)
  // Hold the FIRST ledger /call POST so the sign status stays on screen for the shot; every other
  // request (balance/history polls, clock read_state) passes through untouched.
  let heldCall = null;
  await driver.page.setRequestInterception(true);
  driver.page.on('request', (req) => {
    if (!heldCall && req.method() === 'POST' && /\/api\/v2\/canister\/[^/]+\/call$/.test(req.url())) {
      heldCall = req; // held — continued right after the screenshot
    } else {
      req.continue().catch(() => {});
    }
  });
  await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), onlineReq);
  await driver.findByTestID('pay-amount', {timeoutMs: 5000});
  await driver.waitForText('Signing', {timeoutMs: 5000});
  await driver.screenshot(`${OUT}/shot-paying`);
  console.log('✓ shot-paying (one-press auto-sign: Paying, Pay ∂5.00 to Café Demo, Signing…)');
  // Release the held submit (continue BEFORE disabling interception, or the paused request hangs),
  // then let the settle complete through the real gateway.
  if (heldCall) await heldCall.continue().catch(() => {});
  await driver.page.setRequestInterception(false);
  await driver.waitForText('Paid ✓', {timeoutMs: 10_000});
  await driver.screenshot(`${OUT}/shot-paid`);
  console.log('✓ shot-paid (online settle → Paid ✓ with verified receipt)');
  await driver.click('btn-new', {timeoutMs: 4000});

  // --- offline hand-off: scanned (the signed QR the payer shows the merchant) --------------------
  // keepGateway: same premise as flow 20 — the "offline" narrative is relay-dead-only; signing the
  // hand-off envelope is the rail's IC path (the QR IS the payment, no reconcile asserted here).
  // One-press: the scan auto-signs; offline (online=false) skips the submit and the hand-off QR
  // shows directly — no Approve press anywhere.
  await goOffline(driver, {keepGateway: true});
  const offlineReq = buildRequestQR(cafe.publicHex, PAY_CENTS, randNonceHex(), nowSecs + 900, 0, 'Café Demo');
  await armPayScan(driver); // wait out the post-reset scanner remount before injecting
  await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), offlineReq);
  await driver.findByTestID('btn-paid', {timeoutMs: 8000});
  await driver.screenshot(`${OUT}/shot-scanned`);
  console.log('✓ shot-scanned (offline hand-off, signed QR)');
} finally {
  await env.stop();
  await stopSession(); // standalone one-off: tear the shared relay/web/browser down so node exits
}
console.log(`done → ${OUT}/shot-*.png`);
