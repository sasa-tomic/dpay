// Flow 14 — Keyboard surface: Escape closes the open sheet (documented in-UI + asserted).
//
// The keyboard-shortcuts surface's seed (plan flow 14) is Escape-to-close on a sheet, built in
// Wave U (useEscapeToClose). This flow asserts it as a standalone: the deposit sheet's "Press Esc to
// close" hint is visible (the surface is documented in-UI), and pressing Escape actually closes the
// sheet. The broader keyboard surface (single-key primary actions) is documented in
// CODEBASE_ANALYSIS.md alongside this test.
//
// Selector contract: `btn-deposit`, `deposit-address`, `btn-deposit-close`.
import { setup, assert, assertIncludes, onboardWallet } from '../harness/lib.mjs';

export async function run() {
  const start = Date.now();
  console.log('[14-keyboard] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[14-keyboard] onboarding…');
    await onboardWallet(driver, 'e2e-keyboard');

    // Open the deposit sheet via the Add money affordance (now via the asset picker — pick Bitcoin).
    console.log('[14-keyboard] opening the deposit sheet (via asset picker)…');
    await driver.click('btn-deposit', { timeoutMs: 5_000 });
    await driver.click('asset-picker-row-ckbtc', { timeoutMs: 5_000 });
    await driver.findByTestID('deposit-address', { timeoutMs: 10_000 });

    // The keyboard surface is documented in-UI: the "Press Esc to close" hint renders on web.
    const body = await driver.bodyText();
    assertIncludes(body, 'Press Esc to close', 'the deposit sheet should document the Esc shortcut in-UI');
    console.log('[14-keyboard] ✓ "Press Esc to close" hint is visible');

    // Escape closes the open sheet (the seed keyboard affordance).
    console.log('[14-keyboard] pressing Escape…');
    await driver.pressKey('Escape');
    await driver.waitGone('deposit-address', { timeoutMs: 3_000 });
    console.log('[14-keyboard] ✓ Escape closed the deposit sheet');

    await driver.screenshot('14-keyboard');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[14-keyboard] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[14-keyboard] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
