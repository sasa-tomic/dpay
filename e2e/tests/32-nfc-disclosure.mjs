// Flow 32 — NFC asset disclosure IN THE EXCHANGING STATUS (MC8 U1 + auto-sign one-press rule,
// founder directive 2026-08-24). Drives the REAL NfcTap state machine through the
// __DPAY_TEST_NFC_SESSION seam with a `request` event carrying currency 1 (ckBTC) + amount 50000
// sats, and asserts the sign-status/exchanging surface discloses the honest asset name +
// asset-correct amount ("Paying 0.0005 BTC on Bitcoin") + hold-to-send copy. The "Pay Now"
// gate that armed the card was the single deliberate press — the request AUTO-SIGNS on arrival,
// so the wire exists immediately (no Approve click, no review card).
//
// The blind-tap bug this pinned historically: the amount disclosure used to land AFTER signing
// began (generic "Communicating…", no asset/amount) and the post-sign line rendered the DEMO `usd()`
// formatter for ckBTC ("∂0.0005"). The disclosure contract survives the one-press rework:
// honest asset/amount sit in front of the payer WHILE the money moves, never a generic spinner
// hiding what's being spent.
//
// The radio hop itself stays a physical-device gate; only the JS event plumbing is faked (same seam
// as flow 11). No settled payment fires (no `done`/`success` result dispatch; a terminal `declined`
// cleans up after the auto-sign exchanging window).
//
// Selector contract: `nfc-status`, `__DPAY_TEST_NFC_APPROVED_WIRE` (the web shim's signed-wire stash).
import { setup, assert, onboardWallet , armNfcCard} from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '32',
  name: 'nfc-disclosure',
  journey: 'nfc',
  covers: ['nfc-disclosure', 'consent', 'asset-name', 'auto-sign'],
  verifies: 'NFC auto-sign exchanging status discloses honest asset + amount ("Paying 0.0005 BTC on Bitcoin") + hold-to-send; the wire exists on arrival (one-press rule).',
  timeoutMs: 90000,
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

    // Waiting-for-tap: NFC ready → the Pay scan surface is visible. On web NFC text is suppressed
    // (PR35); the `pay-scan` testID is platform-agnostic.
    await driver.findByTestID('pay-scan', { timeoutMs: 5_000 });

    // Helper: dispatch one NFC event through the seam (role='card' = the payer being tapped).
    const dispatch = async (event) => { await armNfcCard(driver, 'ic'); return driver.eval((e) => window.__DPAY_TEST_NFC_SESSION(e), event); };

    // Dispatch a `request` event carrying currency 1 (ckBTC) + 50000 sats. One-press rule: the
    // "Pay Now" gate already armed the card, so the request AUTO-SIGNS — validation → sign →
    // exchanging with NO intermediate review. The 32-byte toHex + 16-byte nonceHex are well-formed
    // so the sign-time real signAuthorization (in the e2e shim) produces a valid wire.
    // `toName`/`memo` ride the same event the Kotlin module forwards (uniffi PaymentRequestData
    // toName/memo).
    const nowSecs = Math.floor(Date.now() / 1000);
    await dispatch({
      type: 'request', role: 'card',
      toHex: '11'.repeat(32),     // merchant pubkey (32 bytes)
      amount: '50000',            // 50000 sats = 0.0005 BTC
      nonceHex: 'ab'.repeat(16),  // 16-byte single-use nonce
      expiry: nowSecs + 300,      // 5 min from now
      currency: 1,                // ckBTC
      toName: 'merchant',         // merchant display name (plumbed through NfcEvent.toName)
      memo: 'two coffees',        // merchant memo (plumbed through NfcEvent.memo)
    });

    // The NfcTap view mounts (nfc-status); the request goes STRAIGHT to exchanging (auto-sign).
    await driver.findByTestID('nfc-status', {timeoutMs: 5_000});
    assert(await driver.waitForText('Communicating', {timeoutMs: 6_000}), 'a payable request should auto-sign → exchanging, no review park');

    // CORE ASSERTION — the honest asset disclosure rides the exchanging status WHILE the money
    // moves (the read-only amount + network from the resolved disclosure), and the wire already
    // exists (the sign happened on arrival — the tap is the channel, not the consent).
    {
      const body = await driver.bodyText();
      assert(body.includes('BTC'), 'the exchanging status should disclose the asset name "BTC"');
      assert(body.includes('0.0005'), 'the exchanging status should disclose the asset-correct amount "0.0005"');
      // The blind-tap bug rendered the DEMO ∂ formatter for ckBTC — assert it is NOT present.
      assert(!/∂0\.00050000/.test(body), 'the exchanging status must NOT render the DEMO ∂ formatter for a ckBTC amount');
      assert(body.includes('Paying 0.0005 BTC on Bitcoin'), 'the read-only amount line should read "Paying 0.0005 BTC on Bitcoin"');
      assert(body.includes('Hold the phones together to send'), 'the exchanging card-role hint should render');
      // One-press honesty: the review affordances are gone — no card, no buttons, no countdown.
      assert(!(await driver.isPresent('nfc-pay-amount')), 'no review-card amount node (nfc-pay-amount) may exist');
      assert(!(await driver.isPresent('btn-nfc-approve')), 'no Approve button exists (one press already spent at "Pay Now")');
      const wire = await driver.eval(() => window.__DPAY_TEST_NFC_APPROVED_WIRE);
      assert(wire != null && typeof wire.envelopeHex === 'string' && wire.envelopeHex.length > 128,
        'the signed wire should exist right after arrival (auto-sign) — no Approve click ever happened');
      console.log('[32-nfc-disclosure] ✓ auto-sign: Paying 0.0005 BTC on Bitcoin + hold-to-send, wire stashed, no ∂ formatter');
    }

    await driver.screenshot('32-nfc-disclosure-sign');

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
