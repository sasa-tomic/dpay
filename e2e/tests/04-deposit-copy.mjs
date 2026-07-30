// Flow 04 — Deposit copy: REAL clipboard, not the Share noop (U4).
//
// Opens the sheet via the "Add money" button (U5 — proves the promoted affordance opens the sheet),
// clicks "Copy address", and asserts the test seam `window.__DPAY_TEST_CLIPBOARD` now holds the
// EXACT deposit address. This proves the copy button uses `navigator.clipboard.writeText` (the real
// clipboard on web) rather than the `Share.share` noop shimmed in shims.ts (which captures nothing).
// On native the same code path falls back to the real Share sheet; the harness proves the clipboard
// path, which is the regression surface.
//
// Selector contract: `btn-deposit` (Add money), `deposit-address`, `btn-deposit-copy`.
import { setup, assertEq, onboardWallet } from '../harness/lib.mjs';

export async function run() {
  const start = Date.now();
  console.log('[04-deposit-copy] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Onboard → wallet.
    console.log('[04-deposit-copy] onboarding…');
    await onboardWallet(driver, 'e2e-copy');

    // 2. Open the sheet via the promoted "Add money" affordance (U5).
    console.log('[04-deposit-copy] clicking btn-deposit (Add money)…');
    await driver.click('btn-deposit', { timeoutMs: 5_000 });

    // 3. Read the address before copying.
    await driver.findByTestID('deposit-address', { timeoutMs: 10_000 });
    const address = await driver.readText('deposit-address');

    // 4. The clipboard seam starts empty (the Share noop would leave it empty).
    const before = await driver.eval(() => window.__DPAY_TEST_CLIPBOARD);
    assertEq(before, '', 'clipboard seam should be empty before copy');

    // 5. Click copy. The app calls navigator.clipboard.writeText (wrapped by the shim to capture).
    console.log('[04-deposit-copy] clicking btn-deposit-copy…');
    await driver.click('btn-deposit-copy', { timeoutMs: 5_000 });

    // 6. "Copied ✓" confirms the clipboard path was taken (not the Share "Shared ✓" label).
    await driver.waitForText('Copied', { timeoutMs: 4_000 });

    // 7. The seam now holds the EXACT address — proves a real clipboard write happened.
    const after = await driver.eval(() => window.__DPAY_TEST_CLIPBOARD);
    assertEq(after, address, `clipboard seam after copy should equal the deposit address "${address}"`);
    console.log(`[04-deposit-copy] ✓ clipboard captured the deposit address (${address})`);

    // 8. U7 — Escape closes the open sheet (seed of the keyboard-shortcuts surface, plan flow 14).
    await driver.pressKey('Escape');
    await driver.waitGone('deposit-address', { timeoutMs: 3_000 });
    console.log('[04-deposit-copy] ✓ Escape closed the deposit sheet');

    await driver.screenshot('04-deposit-copy');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[04-deposit-copy] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/04-deposit-copy.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[04-deposit-copy] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
