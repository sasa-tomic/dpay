// Flow 17 — QR scanner listener cleanup (NIT 1a-ii).
//
// The web `useCodeScanner` shim registers a listener on every <QrScanner> mount. The cleanup
// contract: when the scanner unmounts (the user switches Pay → Receive), its listener MUST be
// removed — otherwise every mount leaks one listener (and the closure it holds) for the whole
// session. This flow mounts the scanner (Pay tab), confirms exactly one listener is registered,
// then switches to Receive (which renders NO scanner until the merchant starts a signed-QR scan)
// and asserts the listener count returns to its pre-mount baseline.
//
// Selector contract: `btn-settings` (waits for wallet), `tab-pay`, `tab-receive`.
import { setup, assert, assertEq, onboardWallet } from '../harness/lib.mjs';

async function scanCount(driver) {
  const n = await driver.eval(() => (window.__DPAY_TEST_SCAN_COUNT?.() ?? -1));
  return n;
}

export async function run() {
  const start = Date.now();
  console.log('[17-scan-cleanup] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[17-scan-cleanup] onboarding…');
    await onboardWallet(driver, 'e2e-scan-cleanup');

    // Baseline the listener count with the Pay tab mounted (PayMode always renders a <QrScanner>).
    // Give the mount effect a tick to register.
    await driver.findByTestID('tab-pay', { timeoutMs: 4_000 });
    let count = await scanCount(driver);
    for (let i = 0; i < 20 && count < 1; i++) {
      await new Promise((r) => setTimeout(r, 50));
      count = await scanCount(driver);
    }
    assertEq(count, 1, 'Pay tab mounts exactly one scan listener');
    console.log(`[17-scan-cleanup] ✓ Pay tab → ${count} scan listener registered`);

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

    // Switch back to Pay: a fresh mount registers exactly one listener again (re-mount works).
    console.log('[17-scan-cleanup] switching Receive → Pay (re-mount)…');
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    let remount = await scanCount(driver);
    for (let i = 0; i < 20 && remount < 1; i++) {
      await new Promise((r) => setTimeout(r, 50));
      remount = await scanCount(driver);
    }
    assertEq(remount, 1, 're-mounting the scanner registers its listener again');
    console.log(`[17-scan-cleanup] ✓ Pay tab again → ${remount} listener (re-mount works)`);

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
