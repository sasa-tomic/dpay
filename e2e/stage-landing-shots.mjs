#!/usr/bin/env node
// One-off: stage presentable landing screenshots (shot-*.png) from the REAL app — no mocks beyond
// the documented e2e seams (__DPAY_TEST_SCAN / __DPAY_TEST_NFC_SESSION / __DPAY_QR_LAST). Drives
// the real app in the shared e2e harness (relay + web + headless chrome), onboards "Alex", and
// captures the seven landing states at 780×1688:
//   request (Receive request-QR), approve (review), scanned (offline hand-off QR), paid (success),
//   nfc-listen, nfc-exchange, nfc-paid.
// Payment narrative: Alex pays Café Demo Đ5.00 (currency 0 DEMO).
// Output: e2e/shots/staging/*.png (copied into crates/dpay-relay/assets/shot-*.png by hand after
// visual review — NOT automatic, so a bad capture never ships).
import {setup, onboardWallet, goOffline} from './harness/lib.mjs';
import {generateKeypair, randNonceHex, buildRequestQR} from './harness/wire.mjs';
import {mkdirSync} from 'node:fs';

const OUT = 'staging'; // driver.screenshot prefixes e2e/shots/
const PAY_CENTS = 500; // Đ5.00

const env = await setup();
mkdirSync('e2e/shots/staging', {recursive: true});
try {
  const {driver, relayBaseURL} = env;
  const cafe = await generateKeypair(); // the merchant (payee)

  // Arm the NFC seam BEFORE the wallet mounts (same ordering as flow 11).
  await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

  // 1. Onboard Alex (online, Đ100 funded).
  await onboardWallet(driver, 'Alex');

  // --- request: merchant-side Receive request-QR (Alex's own request for the narrative shots) ----
  await driver.click('tab-receive', {timeoutMs: 4000});
  await driver.type('amount-input', '5.00', {timeoutMs: 4000});
  await driver.click('btn-request', {timeoutMs: 4000});
  await driver.findByTestID('request-qr', {timeoutMs: 5000});
  await driver.screenshot(`${OUT}/shot-request`);
  console.log('✓ shot-request (Alex request Đ5.00)');

  // Back to Pay mode for the payment narrative.
  await driver.click('tab-pay', {timeoutMs: 4000});
  await driver.findByTestID('pay-scan', {timeoutMs: 5000});

  // --- NFC trio: listen → exchange → paid (seam-driven phases, payer role) -----------------------
  const dispatch = (event) => driver.eval((e) => window.__DPAY_TEST_NFC_SESSION(e), event);

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

  // exchange: dispatch request → autoSign → exchanging ("Communicating…" + disclosure).
  const startedSecs = Math.floor(Date.now() / 1000);
  await dispatch({
    type: 'request', role: 'card',
    toHex: cafe.publicHex, amount: String(PAY_CENTS), nonceHex: randNonceHex(),
    expiry: startedSecs + 300, currency: 0,
  });
  await driver.findByTestID('nfc-status', {timeoutMs: 5000});
  await driver.waitForText('Communicating', {timeoutMs: 5000});
  await driver.screenshot(`${OUT}/shot-nfc-exchange`);
  console.log('✓ shot-nfc-exchange (Communicating… Paying Đ5.00)');

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

  // --- online scan-to-pay: approve (review) → paid (settled success) -----------------------------
  // shot-paid must come from the ONLINE approve path: approve() settles through the relay and the
  // paid phase renders "Paid ✓" with a verified receipt. The offline hand-off CANNOT get there on
  // its own — its "Handed to…" button enters a terminal pending clock state (the receipt poll only
  // runs while the hand-off QR is on screen), so staging paid offline would require faking state.
  const nowSecs = Math.floor(Date.now() / 1000);
  const onlineReq = buildRequestQR(cafe.publicHex, PAY_CENTS, randNonceHex(), nowSecs + 600, 0, 'Café Demo');
  await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), onlineReq);
  await driver.findByTestID('pay-amount', {timeoutMs: 5000});
  await driver.screenshot(`${OUT}/shot-approve`);
  console.log('✓ shot-approve (Review payment Đ5.00 to Café Demo)');
  await driver.click('btn-approve', {timeoutMs: 5000});
  await driver.waitForText('Paid ✓', {timeoutMs: 10_000});
  await driver.screenshot(`${OUT}/shot-paid`);
  console.log('✓ shot-paid (online settle → Paid ✓ with verified receipt)');
  await driver.click('btn-new', {timeoutMs: 4000});

  // --- offline hand-off: scanned (the signed QR the payer shows the merchant) --------------------
  // keepGateway: same premise as flow 20 — the "offline" narrative is relay-dead-only; signing the
  // hand-off envelope is the rail's IC path (the QR IS the payment, no reconcile asserted here).
  await goOffline(driver, {keepGateway: true});
  const offlineReq = buildRequestQR(cafe.publicHex, PAY_CENTS, randNonceHex(), nowSecs + 900, 0, 'Café Demo');
  await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), offlineReq);
  await driver.findByTestID('pay-amount', {timeoutMs: 5000});
  await driver.click('btn-approve', {timeoutMs: 5000});
  await driver.findByTestID('btn-paid', {timeoutMs: 8000});
  await driver.screenshot(`${OUT}/shot-scanned`);
  console.log('✓ shot-scanned (offline hand-off, signed QR)');
} finally {
  await env.stop();
}
console.log(`done → ${OUT}/shot-*.png`);
