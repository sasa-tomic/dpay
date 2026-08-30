// Flow 99 — NFC disclosure for the native assets (wave: VCHF+ICP support, 2026-08-28).
//
// The VCHF+ICP twin of flow 32's nfc-disclosure, asserting obligation (8) for BOTH assets in one
// session: before any tap-to-pay signs, the NFC status surface identifies the asset and the exact
// amount —
//   * "Paying 1.00000001 VCHF on Internet Computer" / "Paying 1.00000001 ICP on Internet Computer"
//     (exact 8-decimal units + the shared IC network label, NOT the DEMO ∂ formatter leak), and
//     the disclosure is READ-ONLY: no nfc-pay-amount input, no btn-nfc-approve button — the card
//     role cannot edit or approve what the terminal requested.
//   * The app DOES sign the wire after the one-press auto-approve: __DPAY_TEST_NFC_APPROVED_WIRE
//     carries a real envelope (the same signer core whose canister target flows 95/96 pin).
// Cleanup after each leg dispatches the declined phase so the session returns to the scan surface.
import { setup, assert, assertIncludes, onboardWallet, armNfcCard } from '../harness/lib.mjs';

const LEGS = [
  { currency: 7, tag: 'VCHF' },
  { currency: 8, tag: 'ICP' },
];
const AMOUNT = '100000001'; // 1.00000001 — 8-decimal exactness

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '99',
  name: 'nfc-native-assets',
  journey: 'nfc',
  covers: ['nfc', 'vchf', 'icp', 'icp-mainnet', 'disclosure', 'read-only', 'one-press', '8-decimals'],
  verifies: 'NFC tap-to-pay discloses "Paying 1.00000001 VCHF/ICP on Internet Computer" (exact units + network, no ∂ formatter leak) with NO amount input and NO approve button on the card surface, for both native assets, before the auto-signed wire is stashed.',
  timeoutMs: 30000, // two NFC legs + an inter-leg reload (disclosure + wire stash + declined cleanup)
};

export async function run() {
  const start = Date.now();
  console.log('[99-nfc-native-assets] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // Arm the HCE card seam BEFORE onboarding so the Pay screen mounts the card role (flow 32).
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });
    await onboardWallet(driver, 'e2e-nfc-native');
    await driver.findByTestID('pay-scan', { timeoutMs: 5_000 });

    const dispatch = async (event) => {
      await armNfcCard(driver, 'ic');
      return driver.eval((e) => window.__DPAY_TEST_NFC_SESSION(e), event);
    };

    // Escape a terminal NfcTapView: the button flips its label to "Done" on a terminal phase.
    // Dispatching a phase only QUEUES a React update, so reading the DOM in the same tick can still
    // see the OLD label ('Cancel') — a race that only loses on a loaded machine (this flow went RED
    // in a full parallel run while passing in isolation). Poll for the expected label, then click;
    // if it never arrives, return whichever label is present so the assert names what it saw.
    const clickNfcButton = async (expected) => {
      for (let i = 0; i < 40; i++) {
        const hit = await driver.eval((label) => {
          const btn = document.querySelector(`button[aria-label="${label}"]`);
          if (btn) { btn.click(); return label; }
          return null;
        }, expected);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 100));
      }
      return driver.eval(() => {
        for (const label of ['Done', 'Cancel']) {
          if (document.querySelector(`button[aria-label="${label}"]`)) return label;
        }
        return null;
      });
    };

    for (const leg of LEGS) {
      console.log(`[99-nfc-native-assets] ${leg.tag} disclosure leg…`);
      const nowSecs = Math.floor(Date.now() / 1000);
      await dispatch({
        type: 'request',
        role: 'card',
        toHex: '11'.repeat(32),
        amount: AMOUNT,
        nonceHex: 'ab'.repeat(16),
        expiry: nowSecs + 300,
        currency: leg.currency,
        toName: 'merchant',
        memo: 'exact change',
      });

      await driver.findByTestID('nfc-status', { timeoutMs: 5_000 });
      assert(await driver.waitForText('Communicating', { timeoutMs: 6_000 }), `${leg.tag}: NFC session reaches the status surface`);
      const body = await driver.bodyText();
      assertIncludes(body, `Paying 1.00000001 ${leg.tag} on Internet Computer`, `${leg.tag} disclosure names asset + exact amount + network`);
      assert(body.includes('Hold the phones together to send'), `${leg.tag}: status surface shows the tap hint`);
      assert(!/∂1\.00000001/.test(body), `${leg.tag}: no DEMO ∂ formatter leak into the disclosure`);
      assert(!(await driver.isPresent('nfc-pay-amount')), `${leg.tag}: no amount input on the read-only disclosure`);
      assert(!(await driver.isPresent('btn-nfc-approve')), `${leg.tag}: no approve button on the card surface`);

      // The one-press auto-approve signs a real wire (envelope) for this exact request.
      let wire = null;
      for (let i = 0; i < 20 && wire == null; i++) {
        wire = await driver.eval(() => window.__DPAY_TEST_NFC_APPROVED_WIRE ?? null);
        if (wire == null) await new Promise((r) => setTimeout(r, 250));
      }
      assert(wire != null && typeof wire.envelopeHex === 'string' && wire.envelopeHex.length > 128,
        `${leg.tag}: approved wire stashed (signed envelope)`);

      // Cleanup: terminate the leg (declined phase → terminal view), then escape via the Done
      // button so the card re-arms for the next leg (flow 60's terminal-escape pattern — the
      // button flips its aria-label to "Done" on a terminal phase).
      await dispatch({ type: 'phase', role: 'card', phase: 'declined' });
      const escaped = await clickNfcButton('Done');
      assert(escaped === 'Done', `NFC terminal view should offer a Done escape between legs (saw: ${escaped})`);
      await driver.waitGone('nfc-status', { timeoutMs: 5_000 });
    }

    await driver.screenshot('99-nfc-native-assets');
    console.log(`[99-nfc-native-assets] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('99-nfc-native-assets RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
