// Flow 71 — Selection lock preserves an in-flight pay review (Phase 5, concern B).
//
// While a pay review/QR/paid (or receive request-QR/result) is in flight, switching the idle asset
// would unmount the active engine and destroy the captured request snapshot the user is mid-flow on.
// It would also arm the wrong protocol's NFC reader (invariant #11). So Wallet locks USER-initiated
// selection changes for the duration of the in-flight op: the header account chip goes disabled
// (testID `balance` carries accessibilityState.disabled + Pressable.disabled), and handleSelect bails.
//
// This flow enters the PayMode sign-blocked surface (an ONLINE insufficient request — the
// auto-sign refuses to fire, so the read-only review stands) via the camera scan
// seam (`__DPAY_TEST_SCAN`), then asserts the
// lock from both angles:
//   1. assertDisabled('balance') — the button reports a disabled state.
//   2. tapping it anyway is a no-op — the mode STAYS Pay (no accounts list) and the
//      review (pay-amount) is still showing.
// Canceling the review (btn-review-cancel) returns to scan, releases the lock, and the chip is
// re-enabled + opens the accounts route normally.
// The accounts list is its own ROUTE (2026-09-08; a sheet before O4 S3, inline on Home between the
// two). While the review holds the lock the rows are unreachable BY CONSTRUCTION — the chip that
// reaches them is the disabled one, and every other way in means leaving the review, whose
// engine unmount releases the lock (useReportLock resets on unmount). This flow pins that seam:
// navigating away mid-review abandons the review (engine unmounted, lock released) and rows then
// select again — the sheet-era "overlay never unmounts the engine" guarantee is gone with the
// sheet, exactly like the pre-existing tab-receive/ledger navigation.
// (One-press rule 2026-08-24: a PAYABLE scan would auto-sign straight through review→qr/paid, so
// this flow pins the lock on the blocked-insufficient leg — a stable review surface.)
//
// Selector contract: `pay-scan` (scan surface present before the seam fires), `pay-amount` (review),
// `balance` (header → the accounts route, disabled while locked), `accounts-list` (route landed),
// `btn-home-accounts` (the Home affordance into the same route), `asset-vchf-select` (row whole-row
// select), `btn-review-cancel` (review → scan, releases the lock).
import {
  setup,
  assert,
  assertIncludes,
  assertDisabled,
  waitForEnabled,
  openBalances, assertEq,
  onboardWallet,
  armPayScan,
  selectCurrency,
} from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout) and
  * by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for id/name;
  * journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '71',
  name: 'selection-lock',
  journey: 'system',
  covers: ['selection-lock', 'in-flight-preserve', 'balances-disable', 'nfc-arming-invariant'],
  verifies: 'An in-flight pay review locks the idle asset selection: the header account chip is disabled + a no-op, and leaving the review releases the lock so the accounts route selects rows again.',
  timeoutMs: 90000,
};

const PAY_CENTS = 20000; // ∂200.00 DEMO — OVER the ∂100 balance: online+insufficient blocks the
// auto-sign (C2), parking the read-only review this flow needs (a payable ∂25 would settle
// straight to `paid` before the lock asserts could run).

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

    // 2. Build a merchant request for ∂200.00 DEMO (currency 0) and deliver it via the camera scan
    //    seam — the same path flow 27 uses. onRequestString decodes → setReq + setPhase('review')
    //    and the auto-sign is BLOCKED (insufficient online balance → no sign, review stands).
    const bob = await generateKeypair();
    const reqQr = buildRequestQR(bob.publicHex, PAY_CENTS, randNonceHex(), Math.floor(Date.now() / 1000) + 600, 0, 'Bob');
    await armPayScan(driver); // pay-intent gate: arm the scan surface (no-op when already armed)
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, reqQr);

    // 3. Review is showing — pay-amount renders the locked amount; the selection is now LOCKED.
    await driver.findByTestID('pay-amount', { timeoutMs: 5_000 });
    assertIncludes(await driver.readText('pay-amount'), '∂200.00', 'review shows the scanned amount (immutable snapshot)');
    console.log('[71-selection-lock] ✓ entered the blocked-insufficient PayMode review (∂200.00)');

    // 4. LOCKED (assertion 1): the header account chip reports a disabled state.
    await assertDisabled(driver, 'balance', 'the header account chip is disabled while the PayMode review is in flight');

    // 5. LOCKED (assertion 2): tapping it anyway is a no-op. The mode STAYS Pay (the disabled
    //    Pressable never navigates — no accounts list renders) and the review is still showing —
    //    the active engine was not unmounted.
    await driver.click('balance', { timeoutMs: 5_000 });
    const routeLanded = await driver.eval((id) => !!document.querySelector(`[data-testid="${id}"]`), 'accounts-list');
    assert(!routeLanded, 'the accounts route must NOT open while the selection is locked (the chip is a no-op)');
    const stillReview = await driver.eval((id) => !!document.querySelector(`[data-testid="${id}"]`), 'pay-amount');
    assert(stillReview, 'PayMode review must still be showing after a locked Balances tap (engine not unmounted)');
    console.log('[71-selection-lock] ✓ the account chip is disabled + a no-op during review');

    // 5b. LOCKED → row-select suppression is BY CONSTRUCTION: the accounts route is only reachable
    //     by LEAVING the review, and the engine's unmount releases the lock (useReportLock resets
    //     on unmount). Pin that seam: navigate away mid-review — the review unmounts (pay-amount
    //     gone) — and the rows then select freely again. If a future change keeps the engine
    //     mounted across mode switches, this is the assert that catches it. Home is the way in
    //     here precisely BECAUSE the chip is refusing: `btn-home-accounts` is not lock-gated, and
    //     it does not need to be — reaching it has already abandoned the review.
    await driver.click('tab-home', { timeoutMs: 5_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    const reviewGone = await driver.eval((id) => !document.querySelector(`[data-testid="${id}"]`), 'pay-amount');
    assert(reviewGone, 'navigating away mid-review abandons the review (engine unmounted — pre-existing tab semantics)');
    await driver.click('btn-home-accounts', { timeoutMs: 5_000 });
    await driver.findByTestID('accounts-list', { timeoutMs: 5_000 });
    // Currency grammar: the row tap SETS MAIN and lands Home — the tap taking effect (Home
    // headlines the picked currency) IS the proof the rows select again.
    await selectCurrency(driver, 'vchf', { timeoutMs: 5_000 });
    await driver.findByTestID('home-headline-label', { timeoutMs: 5_000 });
    assertEq(await driver.readText('home-headline-label'), 'Balance CHF',
      'rows select again once the engine unmount released the lock — the row tap set CHF main and landed Home');
    console.log('[71-selection-lock] ✓ lock releases on engine unmount; rows selectable in the accounts route');

    // 6. Back to Pay (scan) — the released lock left the chip re-enabled, and it opens the route.
    await driver.click('tab-pay', { timeoutMs: 5_000 });
    await waitForEnabled(driver, 'balance', { timeoutMs: 5_000 });
    await openBalances(driver);
    console.log('[71-selection-lock] ✓ lock released; the chip opens the accounts route again');

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
