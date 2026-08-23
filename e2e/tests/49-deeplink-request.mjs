// Flow 49 — Deeplink request pre-fill (`dpay:req` via the web `?req=` mirror).
//
// A merchant's Request QR is a raw base64url blob; the deeplink wraps it as `dpay:req/<blob>` so it
// can be shared over a messaging app and opened on the payer's phone to PRE-FILL the pay review
// screen (the payer still taps Approve — a deeplink NEVER auto-signs). On web the same blob rides as
// `?req=<blob>` (the OS scheme handler doesn't exist in a browser), so this flow exercises the REAL
// web path: navigate the browser to `?relay=<relay>&req=<blob>` (identity persists in AsyncStorage →
// the wallet auto-loads → Wallet's mount effect reads ?req= → PayMode's prefill effect decodes →
// review screen). This is the EXACT code path a real web user hitting `dpay.kalaj.org/?req=...` runs.
//
// The blob is byte-identical to a camera-scanned request (flow 07), so the full Approve→settle path
// is reused end-to-end (settles on the REAL FakeLedger). The security assertion: the deeplink lands
// on REVIEW (btn-approve present + NOT yet Paid) — proving it prefilled WITHOUT auto-paying.
//
// Approach chosen (reload, not a JS seam): the reload tests the real `?req=` reader with ZERO
// test-only prod code (no `__DPAY_TEST_DEEPLINK` global). Flow 12 proves reload+remount is reliable;
// `?relay=` is preserved in the URL so the test relay is still used on the reloaded page.
//
// Selector contract: `tab-pay`, `pay-amount`, `btn-approve`, `btn-new`, `balance`.
import { setup, assert, assertIncludes, getBalance, onboardWallet } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const PAY_CENTS = 2500; // Đ25.00 (DEMO_USD = currency 0, the wallet asset)
const MERCHANT_NAME = 'Bob';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '49',
  name: 'deeplink-request',
  journey: 'pay',
  covers: ['deeplink', 'request-link', 'prefill', 'pay-review'],
  verifies: 'dpay:req deeplink opens the pay review screen pre-filled with the merchant request (no auto-approve).',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[49-deeplink-request] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL, webBaseURL } = env;

    // --- wallet B: a fresh keypair generated in-test (the payee). -----------------------------
    const bob = await generateKeypair();
    console.log(`[49-deeplink-request] wallet B (payee): ${bob.publicHex.slice(0, 16)}…`);
    const bobBefore = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(bobBefore === '0', `payee B must start at 0, got ${bobBefore}`);

    // --- wallet A: onboarded in the browser (the payer, funded Đ100 by the faucet). -----------
    console.log('[49-deeplink-request] onboarding wallet A (payer)…');
    await onboardWallet(driver, 'e2e-deeplink');

    // --- B's request blob: to=B, amount=Đ25, fresh nonce, +10min expiry, currency 0, name 'Bob'.
    //     This is the EXACT base64url blob the merchant's QR carries (buildRequestQR) — the deeplink
    //     wraps it in `dpay:req/<blob>`; on web it rides as `?req=<blob>`. ----------------------
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const blob = buildRequestQR(bob.publicHex, PAY_CENTS, nonce, expiry, 0, MERCHANT_NAME);
    console.log('[49-deeplink-request] reloading with ?relay=&req=<blob> to simulate the deeplink…');

    // --- Simulate the deeplink arriving: reload the browser to the SAME origin with `?req=<blob>`
    //     (and `?relay=` preserved so the reloaded page still talks to the test relay — relay-config
    //     reads ?relay= at module load). AsyncStorage identity persists, so the wallet auto-loads →
    //     Wallet mounts → its deeplink effect reads ?req= → sets prefillRequest + mode='pay' →
    //     PayMode's prefill effect decodes the blob via the SAME onRequestString path a camera scan
    //     uses → review screen. -----------------------------------------------------------------
    const reloadPath = `/?relay=${encodeURIComponent(relayBaseURL)}&req=${encodeURIComponent(blob)}`;
    await driver.navigate(webBaseURL, reloadPath, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });

    // --- Review screen pre-filled with the merchant request. The deeplink did NOT auto-pay: the
    //     payer must be ON the review screen (btn-approve visible) and NOT on the Paid screen. -----
    await driver.findByTestID('pay-amount', { timeoutMs: 6_000 });
    const payAmt = await driver.readText('pay-amount');
    assert(payAmt.includes('Đ25.00'), `review should show "Pay Đ25.00", got "${payAmt}"`);
    const reviewBody = await driver.bodyText();
    assertIncludes(reviewBody, MERCHANT_NAME, 'review should name the merchant from the deeplink');
    // SECURITY INVARIANT: the deeplink prefilled review only — it must NOT have reached Paid.
    assert(!/\bPaid\b/.test(reviewBody), 'deeplink must NOT auto-pay — review screen only (no "Paid")');
    await driver.findByTestID('btn-approve', { timeoutMs: 4_000 });
    console.log(`[49-deeplink-request] ✓ review pre-filled: ${payAmt} to ${MERCHANT_NAME} (no auto-approve)`);

    // --- Approve → the app signs offline + submits to the REAL relay → FakeLedger settles. This
    //     proves the deeplink blob is byte-identical to a camera-scanned blob (settles for real) +
    //     that the prefill fully wired into the settle path. Mirrors flow 07. --------------------
    console.log('[49-deeplink-request] clicking btn-approve (sign + pay)…');
    await driver.click('btn-approve', { timeoutMs: 5_000 });
    const paid = await driver.waitForText('Paid', { timeoutMs: 10_000 });
    assert(paid, 'payer should reach the Paid screen after the relay settles the prefilled request');
    const aliceDown = await driver.waitForText('Đ75.00', { timeoutMs: 10_000 });
    assert(aliceDown, 'payer A balance should be Đ75.00 (Đ100 − Đ25) after the settle');
    const bobAfter = await getBalance(relayBaseURL, bob.publicHex, 0);
    assert(String(bobAfter) === String(PAY_CENTS), `payee B balance after settle: expected ${PAY_CENTS}, got ${bobAfter}`);
    console.log(`[49-deeplink-request] ✓ settled: A Đ100→Đ75, B 0→Đ25 (real FakeLedger settle of the deeplink blob)`);

    await driver.screenshot('49-deeplink-request');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[49-deeplink-request] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[49-deeplink-request] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
