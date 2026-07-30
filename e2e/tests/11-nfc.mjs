// Flow 11 — NFC tap phases (driven through the __DPAY_TEST_NFC_SESSION seam).
//
// The NFC radio hop is a physical-device gate (two phones); this flow drives the JS event plumbing
// the real Kotlin module emits, through the app's REAL NfcTap state machine, and asserts each phase
// renders the correct status view. The seam flips the device NFC status to 'ready'
// (window.__DPAY_TEST_NFC_STATUS) so the NfcPill shows + the Pay screen arms the HCE card; then
// __DPAY_TEST_NFC_SESSION dispatches the same DpayNfcEvent 'phase' payloads the native module emits
// (role='card' = payer), and the app's listener drives NfcTap's phase state + UI verbatim.
//
// Phases asserted (the payer/card side):
//   - waiting   : "Tap or scan to pay" (NfcTap renders nothing while merely listening — by design
//                 the QR scanner stays live so the payer taps OR scans with no mode switch).
//   - linking   : "Connecting…"  (the tap started; NfcTap takes over the screen)
//   - exchanging: "Communicating…"
//   - success   : "Paid ✓"  (the terminal phase)
// No real signing fires (no 'request' event dispatched), so this is a pure UI-phase proof — the
// radio hop itself stays a physical-device gate, exactly as designed.
//
// Selector contract: `nfc-ready` (the NFC-on pill), `nfc-status` (the NfcTap view once active).
import { setup, assert, onboardWallet } from '../harness/lib.mjs';

export async function run() {
  const start = Date.now();
  console.log('[11-nfc] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // Flip the device NFC status to 'ready' BEFORE the Wallet mounts (on onboarding) so the app's
    // nfcStatus() probe returns 'ready' → the NfcPill shows and Pay mode arms the HCE card.
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    console.log('[11-nfc] onboarding (NFC forced ready)…');
    await onboardWallet(driver, 'e2e-nfc');

    // Waiting-for-tap: NFC ready → the Pay screen says "Tap or scan to pay" + the NFC-on pill shows.
    // (NfcTap renders nothing while merely listening — the QR scanner stays live alongside it.)
    await driver.findByTestID('nfc-ready', { timeoutMs: 5_000 });
    const waiting = await driver.waitForText('Tap or scan to pay', { timeoutMs: 5_000 });
    assert(waiting, 'Pay screen should invite a tap or scan while NFC is ready');
    console.log('[11-nfc] ✓ waiting-for-tap: "Tap or scan to pay" + NFC-on pill');

    // Helper: dispatch one NFC event through the seam (role='card' = the payer being tapped).
    const dispatch = (event) => driver.eval((e) => window.__DPAY_TEST_NFC_SESSION(e), event);

    // linking → "Connecting…" (NfcTap takes over the screen; nfc-status mounts).
    await dispatch({ type: 'phase', role: 'card', phase: 'linking' });
    await driver.findByTestID('nfc-status', { timeoutMs: 4_000 });
    assert(await driver.waitForText('Connecting', { timeoutMs: 4_000 }), 'linking should show "Connecting…"');
    console.log('[11-nfc] ✓ linking → "Connecting…"');

    // exchanging → "Communicating…".
    await dispatch({ type: 'phase', role: 'card', phase: 'exchanging' });
    assert(await driver.waitForText('Communicating', { timeoutMs: 4_000 }), 'exchanging should show "Communicating…"');
    console.log('[11-nfc] ✓ exchanging → "Communicating…"');

    // success → "Paid ✓" (terminal).
    await dispatch({ type: 'phase', role: 'card', phase: 'success' });
    assert(await driver.waitForText('Paid', { timeoutMs: 4_000 }), 'success should show "Paid ✓"');
    console.log('[11-nfc] ✓ success → "Paid ✓"');

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
