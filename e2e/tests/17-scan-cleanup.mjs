// Flow 17 — QR scanner listener cleanup (NIT 1a-ii) + pay-intent gate.
//
// The web `useCodeScanner` shim registers a listener on every <QrScanner> mount. The cleanup
// contract: when the scanner unmounts (the user switches Pay → Receive), its listener MUST be
// removed — otherwise every mount leaks one listener (and the closure it holds) for the whole
// session. With the pay-intent gate (2026-08-23) the Pay tab starts IDLE (scanner deliberately
// unmounted until "Pay Now"), so this flow also pins the gate itself: idle → 0 listeners,
// armed → exactly 1, Receive → 0, back to Pay → idle again (gate) → armed → 1.
//
// Selector contract: `btn-settings` (waits for wallet), `tab-pay`, `tab-receive`, `btn-start-scan`.
import { setup, assert, assertEq, onboardWallet, armPayScan } from '../harness/lib.mjs';

async function scanCount(driver) {
  const n = await driver.eval(() => (window.__DPAY_TEST_SCAN_COUNT?.() ?? -1));
  return n;
}

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '17',
  name: 'scan-cleanup',
  journey: 'system',
  covers: ['qr-scanner', 'teardown', 'unmount', 'listener-leak', 'pay-intent-gate'],
  verifies: 'Pay tab starts gated (0 listeners until "Pay Now"); armed → 1; Pay→Receive→Pay tears down cleanly (no leak; re-mount re-gates then re-arms).',
  timeoutMs: 15000,
};

export async function run() {
  const start = Date.now();
  console.log('[17-scan-cleanup] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[17-scan-cleanup] onboarding…');
    await onboardWallet(driver, 'e2e-scan-cleanup');

    // The Pay tab mounts IDLE under the pay-intent gate: no scanner (0 listeners) until the
    // payer's explicit "Pay Now" tap. Pin the idle state first, then arm.
    await driver.findByTestID('tab-pay', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-start-scan', { timeoutMs: 4_000 });
    assertEq(await scanCount(driver), 0, 'Pay tab starts gated — no scan listener until "Pay Now"');
    console.log('[17-scan-cleanup] ✓ Pay tab idle → 0 listeners (pay-intent gate holds)');
    await armPayScan(driver);
    assertEq(await scanCount(driver), 1, 'arming the gate mounts exactly one scan listener');
    console.log('[17-scan-cleanup] ✓ armed → 1 scan listener registered');

    // Switch to Receive: PayMode unmounts (its <QrScanner> must tear down). ReceiveMode's initial
    // state is the amount form (no scanner) — it only mounts a scanner when the merchant taps
    // "scan signed QR", which this flow does NOT do. So the count must return to its baseline (0).
    console.log('[17-scan-cleanup] switching Pay → Receive (unmounts the scanner)…');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-request', { timeoutMs: 4_000 }); // Receive amount form rendered
    let after = await scanCount(driver);
    for (let i = 0; i < 20 && after > 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      after = await scanCount(driver);
    }
    assertEq(after, 0, 'unmounting the scanner must remove its listener (no leak)');
    console.log(`[17-scan-cleanup] ✓ Receive tab → ${after} listeners (cleanup ran, no leak)`);

    // Switch back to Pay: a FRESH mount re-gates (idle, 0 listeners) — then re-arms to exactly one.
    console.log('[17-scan-cleanup] switching Receive → Pay (re-mount re-gates)…');
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-start-scan', { timeoutMs: 4_000 });
    assertEq(await scanCount(driver), 0, 're-mounting re-gates the scanner (fresh intent required)');
    await armPayScan(driver);
    assertEq(await scanCount(driver), 1, 're-arming the gate registers its listener again');
    console.log('[17-scan-cleanup] ✓ Pay tab again → gated 0, then armed → 1 (re-mount works)');

    await driver.screenshot('17-scan-cleanup');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[17-scan-cleanup] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[17-scan-cleanup] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
