// Flow 36 — Bad / malformed QR: scanning garbage surfaces an HONEST error, no crash, no fake review,
// and the camera is genuinely ready for the NEXT code.
//
// The camera seam (`window.__DPAY_TEST_SCAN`) is the sanctioned smallest-boundary shim; every other
// flow injects a WELL-FORMED request through it. This flow injects codes the app cannot pay and
// asserts the input-validation path: `onRequestString` → `parseRequestQR` (a trim-only pass-through)
// → `DpayCore.decodeRequest` throws on the malformed bytes → `onNotARequest` asks `classifyScan` for
// a second opinion → PayMode surfaces a friendly error on the scan screen. The honest contract:
//   - the error text names the problem in plain language, never a silent swallow or a fake success;
//   - the sign screen NEVER mounts (no `pay-amount` — nothing auto-signs a nonsensical request);
//   - and — the part this flow exists for — the failure is TRANSIENT: a second, different code can
//     be scanned straight afterwards and gets its OWN answer.
//
// WHY THE LAST POINT NEEDS REAL MACHINERY. `QrScanner` fires once per mount (`fired.current`), so a
// payload pushed into an already-fired listener is silently swallowed. This flow used to inject a
// second payload and then re-read the SAME on-screen error — passing whether or not the app had
// re-armed, and passing whether or not the second code was ever read. Two things fix that, and both
// are load-bearing here:
//   1. Each payload expects a DIFFERENT message from the one already on screen, so "the text is
//      there" can only be true if this code was actually read. The payloads therefore ALTERNATE
//      between the two refusals rather than repeating one.
//   2. `__DPAY_TEST_SCAN_GEN` (harness/e2e/web/camera.ts) counts <QrScanner> MOUNTS. After each
//      refusal the flow waits for it to advance — proof that PayMode's `refuseScan` remounted the
//      scanner — before injecting the next code. Without that wait the next injection could race
//      the remount and land on the spent listener.
//
// Three payloads exercise three real failure shapes, in an order where every expected message
// differs from the previous one:
//   1. a plain non-base64 string        → "This isn't a dpay payment code"
//   2. a DAMAGED OpenCryptoPay till code — a real merchant QR whose bech32 checksum no longer
//      verifies → "This code is damaged…", the distinct instruction to ask for the code again. (A
//      damaged code must never resolve to whatever host the damage happens to spell, which is what
//      the checksum is for. Flow 111 owns the WORKING till code and its payment.)
//   3. a valid-base64, wrong-length decode (3 bytes can't reconstruct the 132-byte request)
//                                        → back to "This isn't a dpay payment code"
//
// Selector contract: the scan-screen error renders via `<Text style={S.err}>{err}</Text>` (no testID
// — matched by body text). The sign status's `pay-amount` is the "did we wrongly advance?" canary.
import { setup, assert, onboardWallet, armPayScan } from '../harness/lib.mjs';
import { encodeLnurl, damageLnurl } from '../harness/lnurl.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '36',
  name: 'bad-qr',
  journey: 'pay',
  covers: ['bad-qr', 'malformed', 'error-handling', 'input-validation', 'rescan'],
  verifies: 'Three unpayable codes in a row (non-base64, a bech32-damaged OpenCryptoPay till code, a wrong-length base64) each surface their OWN honest error; the review never mounts; and after every refusal the scanner REMOUNTS (mount counter advances) so the next, different code is genuinely read rather than swallowed.',
  timeoutMs: 20000,
};

const NOT_A_PAYMENT_CODE = "isn't a dpay payment code";
const DAMAGED_CODE = 'This code is damaged';

// A real OpenCryptoPay till code with ONE data symbol corrupted: still an `lnurl1…` string (so the
// app knows what KIND of code it is), but the checksum no longer verifies.
const DAMAGED_TILL = damageLnurl(encodeLnurl('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e'));

const PAYLOADS = [
  { label: 'non-base64 garbage', payload: 'this is definitely not a valid request QR!!!', expect: NOT_A_PAYMENT_CODE },
  { label: 'damaged till code', payload: DAMAGED_TILL, expect: DAMAGED_CODE },
  { label: 'valid base64, wrong length', payload: 'AAAA', expect: NOT_A_PAYMENT_CODE },
];

/** Live count of registered scan listeners (mounted <QrScanner> instances). */
const scanCount = (driver) =>
  driver.eval(() => (typeof window.__DPAY_TEST_SCAN_COUNT === 'function' ? window.__DPAY_TEST_SCAN_COUNT() : -1));

/** Monotonic <QrScanner> MOUNT counter — see the header. `-1` when the seam is missing. */
const scanGen = (driver) =>
  driver.eval(() => (typeof window.__DPAY_TEST_SCAN_GEN === 'function' ? window.__DPAY_TEST_SCAN_GEN() : -1));

/** Wait until a NEW <QrScanner> has mounted since `was` — i.e. the refusal re-armed the camera. */
async function waitForRemount(driver, was, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await scanGen(driver);
    if (now > was) return now;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert(false, `after refusing the ${label} the scanner never remounted (mount counter stuck at ${was}); a code scanned next would be silently swallowed`);
}

export async function run() {
  const start = Date.now();
  console.log('[36-bad-qr] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // Onboard to reach the Pay scan surface (the default tab post-onboarding).
    console.log('[36-bad-qr] onboarding…');
    await onboardWallet(driver, 'e2e-badqr');

    let previous = null; // the message currently on screen, which the NEXT leg must displace
    for (const { label, payload, expect } of PAYLOADS) {
      await armPayScan(driver); // pay-intent gate: arm the scan surface (no-op when already armed)
      const gen = await scanGen(driver);
      assert(gen > 0, `the camera seam must expose a mount counter (got ${gen}) — see e2e/web/camera.ts`);
      console.log(`[36-bad-qr] injecting ${label} (${JSON.stringify(payload.slice(0, 24))}${payload.length > 24 ? '…' : ''}) into scanner mount #${gen}…`);
      await driver.eval(
        (qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); },
        payload,
      );

      // The honest error: PayMode catches the decode throw, asks classifyScan what the string IS,
      // and surfaces the message for THAT answer — never a silent swallow, never a fake review.
      const got = await driver.waitForText(expect, { timeoutMs: 5_000 });
      const body = await driver.bodyText();
      assert(
        got,
        `${label} (${JSON.stringify(payload.slice(0, 40))}) should surface "${expect}".\n  body excerpt:\n${body.slice(0, 500)}`,
      );
      // The message CHANGED. This is what makes the leg non-vacuous: a swallowed payload would leave
      // the previous refusal on screen, and the previous refusal is a different sentence.
      if (previous !== null && previous !== expect) {
        assert(
          !body.includes(previous),
          `${label} must produce its OWN error — the previous message ("${previous}") is still on screen, so this code was never read`,
        );
      }

      // The review screen MUST NOT have mounted — a nonsensical request can never reach Approve.
      const reviewMounted = await driver.isPresent('pay-amount');
      assert(!reviewMounted, `the sign screen must NOT mount for ${label} (no pay-amount)`);

      // The refusal re-arms the camera: a NEW <QrScanner> is mounted, so the next code is read
      // rather than dropped into the spent listener of the one that just fired.
      const next = await waitForRemount(driver, gen, label);
      console.log(`[36-bad-qr] ✓ ${label} → its own error, no review mount, scanner remounted (#${gen} → #${next})`);
      previous = expect;
    }

    // The scan surface is still alive after the errors (transient, non-fatal): the camera shim still
    // has exactly one listener registered, proving the QrScanner did not tear down, leak a listener
    // per remount, or deadlock on bad input.
    const listeners = await scanCount(driver);
    assert(listeners === 1, `exactly one scan listener should remain after three refusals (got ${listeners}) — a leak or a teardown`);
    console.log(`[36-bad-qr] ✓ scan surface still armed with ${listeners} listener — failure is transient`);

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
