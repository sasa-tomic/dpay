// Flow 71 — Selection lock preserves an in-flight pay review (Phase 5, concern B).
//
// While a pay review/QR/paid (or receive request-QR/result) is in flight, switching the idle asset
// would unmount the active engine and destroy the captured request snapshot the user is mid-flow on.
// It would also arm the wrong protocol's NFC reader (invariant #11). So Wallet locks USER-initiated
// selection changes for the duration of the in-flight op: the header Balances button goes disabled
// (testID `balance` carries accessibilityState.disabled + Pressable.disabled), and handleSelect bails.
//
// This flow enters a PayMode review via the camera scan seam (`__DPAY_TEST_SCAN`), then asserts the
// lock from both angles:
//   1. assertDisabled('balance') — the button reports a disabled state.
//   2. tapping it anyway is a no-op — the Balances sheet (btn-balances-close) does NOT open and the
//      review (pay-amount) is still showing.
// Canceling the review (btn-review-cancel) returns to scan, releases the lock, and the Balances
// button is re-enabled + opens normally. The decoded request is immutable either way (this is a
// UX/state-preservation + NFC-arming lock, not a money-correctness fix — the plan is explicit).
//
// Selector contract: `pay-scan` (scan surface present before the seam fires), `pay-amount` (review),
// `balance` (header → Balances, disabled while locked), `btn-balances-close` (sheet-open gate),
// `btn-review-cancel` (review → scan, releases the lock).
import { setup, assert, assertIncludes, assertDisabled, waitForEnabled, openBalances, onboardWallet } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout) and
  * by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for id/name;
  * journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '71',
  name: 'selection-lock',
  journey: 'system',
  covers: ['selection-lock', 'in-flight-preserve', 'balances-disable', 'nfc-arming-invariant'],
  verifies: 'An in-flight pay review locks the idle asset selection: the Balances button is disabled + a no-op, and canceling the review re-enables it.',
  timeoutMs: 20000,
};

const PAY_CENTS = 2500; // Đ25.00 DEMO (currency 0).

export async function run() {
  const start = Date.now();
  console.log('[71-selection-lock] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Onboard → wallet (DEMO seeded). Enter the Pay tab's scan surface.
    console.log('[71-selection-lock] onboarding…');
    await onboardWallet(driver, 'e2e-lock');
    await driver.click('tab-pay', { timeoutMs: 5_000 });
    await driver.findByTestID('pay-scan', { timeoutMs: 5_000 });

    // 2. Build a merchant request for Đ25.00 DEMO (currency 0) and deliver it via the camera scan
    //    seam — the same path flow 27 uses. onRequestString decodes → setReq + setPhase('review').
    const bob = await generateKeypair();
    const reqQr = buildRequestQR(bob.publicHex, PAY_CENTS, randNonceHex(), Math.floor(Date.now() / 1000) + 600, 0, 'Bob');
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, reqQr);

    // 3. Review is showing — pay-amount renders the locked amount; the selection is now LOCKED.
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    assertIncludes(await driver.readText('pay-amount'), 'Đ25.00', 'review shows the scanned amount (immutable snapshot)');
    console.log('[71-selection-lock] ✓ entered PayMode review (Đ25.00)');

    // 4. LOCKED (assertion 1): the header Balances button reports a disabled state.
    await assertDisabled(driver, 'balance', 'Balances button disabled while PayMode review is in flight');

    // 5. LOCKED (assertion 2): tapping it anyway is a no-op. The sheet does NOT open and the review
    //    is still showing — the active engine was not unmounted.
    await driver.click('balance', { timeoutMs: 5_000 });
    const sheetOpen = await driver.eval((id) => !!document.querySelector(`[data-testid="${id}"]`), 'btn-balances-close');
    assert(!sheetOpen, 'Balances sheet must NOT open while the selection is locked');
    const stillReview = await driver.eval((id) => !!document.querySelector(`[data-testid="${id}"]`), 'pay-amount');
    assert(stillReview, 'PayMode review must still be showing after a locked Balances tap (engine not unmounted)');
    console.log('[71-selection-lock] ✓ Balances disabled + no-op during review');

    // 6. Cancel the review → back to scan → the engine reports onLockChange(false) → lock released.
    await driver.click('btn-review-cancel', { timeoutMs: 5_000 });
    await driver.waitGone('pay-amount', { timeoutMs: 5_000 });

    // 7. UNLOCKED: the Balances button is re-enabled and opens normally.
    await waitForEnabled(driver, 'balance', { timeoutMs: 5_000 });
    await openBalances(driver);
    await driver.findByTestID('btn-balances-close', { timeoutMs: 5_000 });
    console.log('[71-selection-lock] ✓ cancel released the lock; Balances re-opened');

    await driver.screenshot('71-selection-lock');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[71-selection-lock] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/71-selection-lock.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[71-selection-lock] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
