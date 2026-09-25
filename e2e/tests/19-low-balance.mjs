// Flow 19 — Low-balance scenarios (folded: offline auto-sign warning + online no-sign gate).
//
// Two distinct insufficient-balance behaviors, both driven through the REAL app + REAL relay
// (one-press rule, founder directive 2026-08-24: the camera path AUTO-SIGNS on decode — the
// "Pay Now" gate press that armed the scanner IS the single deliberate press):
//   1. OFFLINE insufficient: the payer is OFFLINE (online=false), the amount exceeds the local
//      balance — the app STILL SIGNS (the truthful offline UX: the app can't check the ledger, and
//      the merchant's online verify is the real gate). The read-only sign/qr surfaces carry the
//      honest "Your local balance may not cover this — the merchant will verify." note
//      (testID `review-lowbal`).
//   2. ONLINE insufficient (C2): when ONLINE and the known balance can't cover the amount, the
//      auto-sign is BLOCKED BEFORE any envelope exists — the sign status shows the balance note
//      "Not enough balance to cover this payment." + a Cancel back to the gated scan, and NO sign
//      button exists at all (there never is one on the camera path — the gate is structural, not a
//      disabled button). No doomed /pay submission ever fires.
//
// Folds both into ONE test (speed: one onboarding, an offline pass, then an online pass). The
// offline pass uses the harness's guaranteed-dead relay port (ECONNREFUSED, the real failure mode)
// to force online=false — plain goOffline kills the IC gateway too, so the offline pass exercises
// the FULLY-offline sign (device-clock stamp via prepareTransfer's offlineHandoff fallback,
// 2026-09-16); the online pass restores the good relay.
//
// Selector contract: `btn-paid`, `btn-notpaid`, `review-err` (offline leg), `pay-amount`,
// `review-lowbal`, `btn-review-cancel`, `btn-settings`, `settings-relay`, `btn-settings-close`.
import {
  setup,
  assert,
  onboardWallet,
  goOffline,
  setRelay,
  waitForScanner,
  armPayScan,
  openBalances,
} from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const OVER_CENTS = 20_000; // ∂200.00 — exceeds the ∂100.00 faucet-funded balance

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '19',
  name: 'low-balance',
  journey: 'pay',
  covers: ['low-balance', 'insufficient', 'no-sign-gate'],
  verifies: 'Insufficient funds: fully offline (gateway dead) still signs on the device-clock stamp and hands off the QR (merchant verifies); online blocks the sign entirely.',
  timeoutMs: 60000,
                    // assertions GREEN, backstop false-fired 0.09s past budget — flow-41 precedent
                    // class: host-load spikes uncompensated by the one-shot load factor)
};

export async function run() {
  const start = Date.now();
  console.log('[19-low-balance] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // A second wallet (the payee named on the request). Generated in-test; no browser needed.
    const bob = await generateKeypair();
    const buildReq = () => {
      const nonce = randNonceHex();
      const expiry = Math.floor(Date.now() / 1000) + 600;
      return buildRequestQR(bob.publicHex, OVER_CENTS, nonce, expiry, 0, 'merchant');
    };

    // --- 1. OFFLINE insufficient: payer offline, amount > local balance → SIGNS with a warning. --
    // Onboard against the GOOD relay (∂100 funded → balance known, online=true initially).
    console.log('[19-low-balance] onboarding…');
    await onboardWallet(driver, 'e2e-lowbal');

    // Point the app at a genuinely-dead relay so the next balance poll fails → online=false. The
    // review-lowbal guard is `!online && shownBalance != null && req.amount > shownBalance`.
    console.log('[19-low-balance] going offline (dead relay)…');
    await goOffline(driver);
    // Wait for the header's offline indicator ("~ DEMO approx." after D3) — proves online flipped to false.
    const approx = await driver.waitForText('approx.', { timeoutMs: 8_000 });
    assert(approx, 'the header should show the offline indicator ("~ DEMO approx.") once offline');

    // Scan a ∂200 request (> the ~∂100 local balance) with BOTH the relay and the IC gateway dead
    // (plain goOffline kills both). The auto-sign fires (offline pays, merchant verifies) and —
    // since the 2026-09-16 offline hand-off — SUCCEEDS: with no certified clock to read anywhere,
    // prepareTransfer's offlineHandoff fallback stamps the envelope from the DEVICE clock (capped
    // at the request's expiry), the NFC tap's trust extended to the camera path, and the payer
    // lands on the offline hand-off QR for the merchant to scan. This flow pins that harder
    // fully-dead-gateway sign; the transient "local balance may not cover" warn note that rides
    // beside it is unit-pinned (PayMode.test.tsx, hung-sign fixture).
    console.log('[19-low-balance] scanning a ∂200 request while fully offline (device-clock sign)…');
    const offlineReq = buildReq();
    await armPayScan(driver); // pay-intent gate: arm the scan surface (no-op when already armed)
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), offlineReq);
    // The sign completes without any network (dead gateway fails fast) → the QR hand-off phase.
    await driver.findByTestID('btn-paid', { timeoutMs: 8_000 });
    await driver.findByTestID('btn-notpaid', { timeoutMs: 4_000 });
    const offlineErr = await driver.isPresent('review-err');
    assert(!offlineErr, 'the fully-offline sign must not surface an error (device-clock stamp)');
    console.log('[19-low-balance] ✓ offline insufficient: signed on the device clock, hand-off QR up');

    // --- 2. ONLINE insufficient: the sign is blocked outright — honest note + Cancel, no sign. --
    // Cancel out of the offline pass (drops the pending record) to return to the gated scan, then
    // restore the relay URL.
    console.log('[19-low-balance] cancelling the offline pass, going back online…');
    await driver.click('btn-notpaid', { timeoutMs: 5_000 }); // the hand-off QR's Cancel
    await setRelay(driver, relayBaseURL);
    // Wait for the header to drop the offline indicator (online=true) before scanning.
    await driver.waitForText('balance', { timeoutMs: 8_000 });

    // Scan a ∂200 request while ONLINE + ∂100 balance. The known balance can't cover it, so the
    // app blocks the sign BEFORE any envelope exists: the balance note + Cancel, and no sign
    // button at all (structural — there is never a sign button on the camera path). No doomed
    // /pay submission fires. (The relay's InsufficientFunds→"Not enough balance" surfacing stays
    // unit-tested in payments.ts.)
    const onlineReq = buildReq();
    await waitForScanner(driver);
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), onlineReq);
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    // The online insufficient-balance note (re-uses review-lowbal as the balance note surface).
    await driver.findByTestID('review-lowbal', { timeoutMs: 5_000 });
    const lowbalOnlineTxt = await driver.readText('review-lowbal');
    assert(lowbalOnlineTxt.includes('Not enough balance to cover this payment.'),
      `review-lowbal should state the online block, got: "${lowbalOnlineTxt}"`);
    // C2: no sign control exists at all — the blocked payment cannot be submitted.
    const hasApprove = await driver.isPresent('btn-approve');
    assert(!hasApprove, 'no sign button may exist when online + balance insufficient (C2)');
    // And nothing was signed: no offline handoff QR surfaced, Cancel is the way out.
    const hasQr = await driver.isPresent('btn-paid');
    assert(!hasQr, 'no offline handoff QR may render for the online-blocked payment');
    await driver.findByTestID('btn-review-cancel', { timeoutMs: 4_000 });
    console.log(`[19-low-balance] ✓ online insufficient: "${lowbalOnlineTxt}" + Cancel only (C2, no doomed submit)`);

    await driver.screenshot('19-low-balance');

    const elapsed = ((Date.now() - start) / 1_000).toFixed(2);
    console.log(`[19-low-balance] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[19-low-balance] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
