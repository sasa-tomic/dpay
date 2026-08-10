// Flow 36 — Bad / malformed QR: scanning garbage surfaces an HONEST error, no crash, no fake review.
//
// The camera seam (`window.__DPAY_TEST_SCAN`) is the sanctioned smallest-boundary shim; every other
// flow injects a WELL-FORMED request through it. This flow injects GARBAGE and asserts the app's
// input-validation path: `onRequestString` → `parseRequestQR` (a trim-only pass-through) →
// `DpayCore.decodeRequest` throws on the malformed bytes → PayMode catches and surfaces a friendly
// "This isn't a dpay payment code" error on the scan screen. The honest contract:
//   - the error text names the problem in plain language, never a silent swallow or a fake success;
//   - the review screen NEVER mounts (no `pay-amount`, no Approve of a nonsensical request);
//   - the scan surface stays alive — a second garbage payload lands a second error (re-arms), proving
//     the failure is transient and non-fatal (the user can scan again).
//
// Two payloads exercise the two real failure shapes: a plain non-base64 string, and a valid-base64
// but wrong-length decode (the 132-byte request can't reconstruct from 3 bytes). Both must hit the
// same honest error path.
//
// Selector contract: the scan-screen error renders via `<Text style={S.err}>{err}</Text>` (no testID
// — matched by body text). The review screen's `pay-amount` is the "did we wrongly advance?" canary.
import { setup, assert, onboardWallet } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '36',
  name: 'bad-qr',
  journey: 'pay',
  covers: ['bad-qr', 'malformed', 'error-handling', 'input-validation'],
  verifies: 'Scanning/pasting garbage (non-base64 + wrong-length) surfaces a friendly \'This isn\'t\'t a dpay payment code\' error; review never mounts; scan surface re-arms.',
  timeoutMs: 15000,
};

const GARBAGE_PAYLOADS = [
  'this is definitely not a valid request QR!!!', // non-base64 → decodeRequest rejects
  'AAAA',                                          // valid base64 → decodes to 3 bytes, not the 132-byte request
];

export async function run() {
  const start = Date.now();
  console.log('[36-bad-qr] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // Onboard to reach the Pay scan surface (the default tab post-onboarding).
    console.log('[36-bad-qr] onboarding…');
    await onboardWallet(driver, 'e2e-badqr');

    for (let i = 0; i < GARBAGE_PAYLOADS.length; i++) {
      const payload = GARBAGE_PAYLOADS[i];
      console.log(`[36-bad-qr] injecting garbage #${i + 1} (${JSON.stringify(payload.slice(0, 24))}${payload.length > 24 ? '…' : ''}) via the camera seam…`);
      await driver.eval(
        (qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); },
        payload,
      );

      // The honest error: the scan screen shows a friendly "This isn't a dpay payment code" message
      // (PayMode catches the decode throw and surfaces it — never a silent swallow, never a fake review).
      const got = await driver.waitForText("isn't a dpay payment code", { timeoutMs: 5_000 });
      const body = await driver.bodyText();
      assert(
        got,
        `garbage payload ${JSON.stringify(payload)} should surface a friendly "This isn't a dpay payment code" error.\n  body excerpt:\n${body.slice(0, 500)}`,
      );

      // The review screen MUST NOT have mounted — a nonsensical request can never reach Approve.
      const reviewMounted = await driver.isPresent('pay-amount');
      assert(!reviewMounted, 'the review screen must NOT mount for a malformed request (no pay-amount)');
      console.log(`[36-bad-qr] ✓ garbage #${i + 1} → friendly error, no review mount`);
    }

    // The scan surface is still alive after the errors (transient, non-fatal): the camera seam still
    // has a listener registered, proving the QrScanner did not tear down or deadlock on bad input.
    const listeners = await driver.eval(() => (typeof window.__DPAY_TEST_SCAN_COUNT === 'function' ? window.__DPAY_TEST_SCAN_COUNT() : -1));
    assert(listeners > 0, `the scan surface should still be armed after malformed input (listeners=${listeners})`);
    console.log(`[36-bad-qr] ✓ scan surface still armed (${listeners} listener(s)) — failure is transient`);

    await driver.screenshot('36-bad-qr');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[36-bad-qr] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[36-bad-qr] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
