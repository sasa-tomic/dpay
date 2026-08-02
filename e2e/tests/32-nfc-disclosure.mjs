// Flow 32 — NFC asset disclosure (MC8 U1). Drives the REAL NfcTap state machine through the
// __DPAY_TEST_NFC_SESSION seam with a `request` event carrying currency 1 (ckBTC) + amount 50000
// sats, and asserts the NFC status view discloses the honest asset name + network + asset-correct
// amount ("BTC" + "Bitcoin" + "0.00050000 BTC") DURING the exchanging window — BEFORE any success
// dispatch.
//
// The blind-tap bug this pins: NfcTap.autoSign previously set the amount disclosure AFTER
// `await signAuthorization`, so during signing the payer saw a generic "Communicating…" with NO
// asset name / amount / network, and the post-sign line rendered the DEMO `usd()` formatter even
// for ckBTC → a misleading "∂0.00050000". The fix resolves the disclosure SYNCHRONOUSLY before the
// first await. This flow dispatches a real `request` event (which triggers autoSign → real
// signAuthorization in the e2e shim), then reads back the live status text to prove the honest
// asset/network/amount are visible while the tap is mid-flight.
//
// The radio hop itself stays a physical-device gate; only the JS event plumbing is faked (same seam
// as flow 11). No real signing of a settled payment fires (no `done`/`success` result dispatch is
// required to prove the disclosure; a terminal `declined` is dispatched at the end to clean up).
//
// Selector contract: `nfc-status` (the NfcTap view once active).
import { setup, assert, onboardWallet } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '32',
  name: 'nfc-disclosure',
  journey: 'nfc',
  covers: ['nfc-disclosure', 'consent', 'asset-name', 'network'],
  verifies: 'NFC asset disclosure: mid-tap the status shows honest asset name + network + \'0.00050000 BTC\' BEFORE success.',
  timeoutMs: 15000,
};

export async function run() {
  const start = Date.now();
  console.log('[32-nfc-disclosure] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // Flip the device NFC status to 'ready' BEFORE the Wallet mounts so the Pay screen arms the HCE card.
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    console.log('[32-nfc-disclosure] onboarding (NFC forced ready)…');
    await onboardWallet(driver, 'e2e-nfc-disc');

    // Waiting-for-tap: NFC ready → the Pay screen arms the card; NfcTap renders nothing yet.
    const waiting = await driver.waitForText('Tap or scan to pay', { timeoutMs: 5_000 });
    assert(waiting, 'Pay screen should invite a tap or scan while NFC is ready');

    // Helper: dispatch one NFC event through the seam (role='card' = the payer being tapped).
    const dispatch = (event) => driver.eval((e) => window.__DPAY_TEST_NFC_SESSION(e), event);

    // Dispatch a `request` event carrying currency 1 (ckBTC) + 50000 sats. The app's listener calls
    // autoSign, which resolves the disclosure SYNCHRONOUSLY (before `await signAuthorization`) and
    // sets the NFC status to exchanging. The 32-byte toHex + 16-byte nonceHex are well-formed so the
    // e2e shim's real signAuthorization produces a valid wire (no error finalize).
    const nowSecs = Math.floor(Date.now() / 1000);
    await dispatch({
      type: 'request', role: 'card',
      toHex: '11'.repeat(32),     // merchant pubkey (32 bytes)
      amount: '50000',            // 50000 sats = 0.00050000 BTC
      nonceHex: 'ab'.repeat(16),  // 16-byte single-use nonce
      expiry: nowSecs + 300,      // 5 min from now
      currency: 1,                // ckBTC
    });

    // The NfcTap view mounts (nfc-status) and the exchanging phase renders the honest disclosure.
    await driver.findByTestID('nfc-status', { timeoutMs: 5_000 });
    assert(await driver.waitForText('Communicating', { timeoutMs: 5_000 }), 'exchanging should show "Communicating…"');

    // CORE ASSERTION — the honest asset disclosure is visible DURING the exchanging window, BEFORE
    // any success/result dispatch. The sub-line must read "Paying 0.00050000 BTC on Bitcoin".
    {
      const body = await driver.bodyText();
      assert(body.includes('BTC'), 'NFC status should disclose the asset name "BTC"');
      assert(body.includes('Bitcoin'), 'NFC status should disclose the network "Bitcoin"');
      assert(body.includes('0.00050000'), 'NFC status should disclose the asset-correct amount "0.00050000"');
      // The blind-tap bug rendered the DEMO ∂ formatter for ckBTC — assert it is NOT present.
      assert(!/∂0\.00050000/.test(body), 'NFC status must NOT render the DEMO ∂ formatter for a ckBTC amount');
      console.log('[32-nfc-disclosure] ✓ disclosure visible: BTC + Bitcoin + "0.00050000 BTC" (no ∂ formatter)');
    }

    await driver.screenshot('32-nfc-disclosure');

    // Clean up: dispatch a terminal phase so NfcTap finalizes (no hanging mid-tap state).
    await dispatch({ type: 'phase', role: 'card', phase: 'declined' });

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[32-nfc-disclosure] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[32-nfc-disclosure] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
