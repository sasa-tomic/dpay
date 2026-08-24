// Flow 11 — NFC tap phases (driven through the __DPAY_TEST_NFC_SESSION seam).
//
// The NFC radio hop is a physical-device gate (two phones); this flow drives the JS event plumbing
// the real Kotlin module emits, through the app's REAL NfcTap state machine, and asserts each phase
// renders the correct status view. The seam flips the device NFC status to 'ready'
// (window.__DPAY_TEST_NFC_STATUS) so the Pay screen arms the HCE card; then
// __DPAY_TEST_NFC_SESSION dispatches the same DpayNfcEvent 'phase' payloads the native module emits
// (role='card' = payer), and the app's listener drives NfcTap's phase state + UI verbatim.
//
// Phases asserted (the payer/card side):
//   - waiting   : "Tap or scan to pay" (NfcTap renders nothing while merely listening — by design
//                 the QR scanner stays live so the payer taps OR scans with no mode switch).
//   - linking   : "Connecting…"  (the tap started; NfcTap takes over the screen)
//   - request   : AUTO-SIGN (one-press rule, founder directive 2026-08-24): a `request` event
//                 validates + signs IMMEDIATELY — the "Pay Now" gate that armed the card was the
//                 single deliberate press. The tap goes straight to exchanging; the amount rides
//                 the status line read-only ("Paying ∂50.00"); no review card, no Approve button.
//   - exchanging: "Communicating…" + "Hold the phones together to send"
//   - settling  : "Confirming…" (the signed envelope left the NFC transport)
// The request case signs for real (the web shim stashes __DPAY_TEST_NFC_APPROVED_WIRE); the
// phase walk itself stays a pure UI proof — the radio hop is a physical-device gate, as designed.
//
// Selector contract: `nfc-status` (the NfcTap view once active), `__DPAY_TEST_NFC_APPROVED_WIRE`
// (the web shim's signed-wire stash).
import { setup, assert, onboardWallet , armNfcCard} from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '11',
  name: 'nfc',
  journey: 'nfc',
  covers: ['nfc-phases', 'event-bus', 'auto-sign'],
  verifies: 'NFC transport phases render via the RNW event bus; a request AUTO-SIGNS on arrival (one-press rule) — the wire exists with no Approve click.',
  timeoutMs: 15000,
};

export async function run() {
  const start = Date.now();
  console.log('[11-nfc] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // Flip the device NFC status to 'ready' BEFORE the Wallet mounts (on onboarding) so the app's
    // nfcStatus() probe returns 'ready' → Pay mode arms the HCE card.
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    console.log('[11-nfc] onboarding (NFC forced ready)…');
    await onboardWallet(driver, 'e2e-nfc');

    // Waiting-for-tap: NFC ready → the Pay scan surface is visible. On native the text is "Tap or
    // scan to pay" (NFC armed); on web NFC is suppressed → "Scan to pay". Either way `pay-scan` mounts.
    // (NfcTap renders nothing while merely listening — the QR scanner stays live alongside it.)
    await driver.findByTestID('pay-scan', { timeoutMs: 5_000 });
    console.log('[11-nfc] ✓ waiting-for-tap: pay-scan surface visible');

    // Helper: dispatch one NFC event through the seam (role='card' = the payer being tapped).
    const dispatch = async (event) => { await armNfcCard(driver, 'ic'); return driver.eval((e) => window.__DPAY_TEST_NFC_SESSION(e), event); };

    // linking → "Connecting…" (NfcTap takes over the screen; nfc-status mounts).
    await dispatch({ type: 'phase', role: 'card', phase: 'linking' });
    await driver.findByTestID('nfc-status', { timeoutMs: 4_000 });
    assert(await driver.waitForText('Connecting', { timeoutMs: 4_000 }), 'linking should show "Connecting…"');
    console.log('[11-nfc] ✓ linking → "Connecting…"');

    // --- AUTO-SIGN (one-press rule): a request event validates + signs IMMEDIATELY. -------------
    // The "Pay Now" gate that armed the card was the single deliberate press — the tap is the
    // CHANNEL, not the consent. DEMO currency 0 is payable, so the sign fires: prepareNfcTransfer
    // builds the envelope + the web shim's approveCard stashes __DPAY_TEST_NFC_APPROVED_WIRE.
    const nowSecs = Math.floor(Date.now() / 1000);
    await dispatch({
      type: 'request', role: 'card',
      toHex: '11'.repeat(32), amount: '5000', nonceHex: 'cd'.repeat(16),
      expiry: nowSecs + 240, currency: 0,
    });
    assert(await driver.waitForText('Communicating', { timeoutMs: 6_000 }), 'a payable request should go STRAIGHT to exchanging (auto-sign, no review park)');
    {
      const body = await driver.bodyText();
      assert(body.includes('Hold the phones together to send'), 'the exchanging card-role hint should render');
      assert(body.includes('Paying ∂50.00'), 'the read-only amount should ride the status line ("Paying ∂50.00")');
      // One-press honesty: NO review affordances exist on this path — the sign already happened.
      assert(!(await driver.isPresent('nfc-pay-amount')), 'no review-card amount node (nfc-pay-amount) may exist');
      assert(!(await driver.isPresent('btn-nfc-approve')), 'no Approve button exists (one press already spent at "Pay Now")');
      assert(!(await driver.isPresent('btn-nfc-decline')), 'no Decline button exists (fail-closed legs auto-decline on their own)');
      assert(!(await driver.isPresent('nfc-countdown')), 'no countdown chip exists (the expiry gate is at sign time, authoritative)');
      const wire = await driver.eval(() => window.__DPAY_TEST_NFC_APPROVED_WIRE);
      assert(wire != null && typeof wire.envelopeHex === 'string' && wire.envelopeHex.length > 128,
        'the signed wire should exist right after the request (auto-sign) — no Approve click happened');
    }
    console.log('[11-nfc] ✓ request → auto-sign → exchanging ("Paying ∂50.00", wire stashed, no review card)');
    await driver.screenshot('11-nfc-sign');

    // Error terminal → Done re-arms for the pure-phase walk (the session needs a clean end).
    await dispatch({ type: 'error', role: 'card', reason: 'e2e: end the auto-sign session' });
    assert(await driver.waitForText('Tap failed', { timeoutMs: 5_000 }), 'the error event should surface the honest "Tap failed" terminal');
    await driver.eval(() => {
      const btn = document.querySelector('button[aria-label="Done"]');
      if (btn) btn.click();
    });
    await driver.waitGone('nfc-status', { timeoutMs: 5_000 });

    // --- PURE-PHASE WALK (post-Approve progression, no request involved). ----------------------

    // linking → "Connecting…" (fresh session after the re-arm).
    await dispatch({ type: 'phase', role: 'card', phase: 'linking' });
    await driver.findByTestID('nfc-status', { timeoutMs: 4_000 });
    assert(await driver.waitForText('Connecting', { timeoutMs: 4_000 }), 'linking should show "Connecting…"');

    // exchanging → "Communicating…".
    await dispatch({ type: 'phase', role: 'card', phase: 'exchanging' });
    assert(await driver.waitForText('Communicating', { timeoutMs: 4_000 }), 'exchanging should show "Communicating…"');
    console.log('[11-nfc] ✓ exchanging → "Communicating…"');

    // settling → the envelope has left the NFC transport; ledger polling now owns the outcome.
    await dispatch({ type: 'phase', role: 'card', phase: 'settling' });
    assert(await driver.waitForText('Confirming', { timeoutMs: 4_000 }), 'settling should show "Confirming…"');
    console.log('[11-nfc] ✓ settling → "Confirming…"');

    await driver.screenshot('11-nfc');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[11-nfc] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[11-nfc] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
