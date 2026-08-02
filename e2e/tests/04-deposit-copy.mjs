// Flow 04 — Deposit copy: REAL clipboard, not the Share noop (U4).
//
// Opens the BTC deposit sheet via the Balances sheet (the wallet's money hub) — tap the header
// balance → Balances → the BTC row's "＋ Add" button → the deposit sheet, then click "Copy address"
// and assert the test seam `window.__DPAY_TEST_CLIPBOARD` now holds the EXACT deposit address. This
// proves the copy button uses `navigator.clipboard.writeText` (the real clipboard on web) rather than
// the `Share.share` noop shimmed in shims.ts (which captures nothing). On native the same code path
// falls back to the real Share sheet; the harness proves the clipboard path, which is the regression
// surface.
//
// Selector contract: `balance` (header → Balances), `asset-add-ckbtc` (BTC row Add), `deposit-address`,
// `btn-deposit-copy`.
import { setup, assertEq, onboardWallet, openBalances } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '04',
  name: 'deposit-copy',
  journey: 'deposit',
  covers: ['deposit-address', 'clipboard'],
  verifies: '\'Copy address\' writes the REAL address to the clipboard (not the Share noop).',
  timeoutMs: 15000,
};

export async function run() {
  const start = Date.now();
  console.log('[04-deposit-copy] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Onboard → wallet.
    console.log('[04-deposit-copy] onboarding…');
    await onboardWallet(driver, 'e2e-copy');

    // 2. Open Balances → pick Bitcoin (the CkBtcUtxo ramp) via its "Add" action to reach the deposit sheet.
    console.log('[04-deposit-copy] opening Balances → BTC deposit…');
    await openBalances(driver);
    await driver.click('asset-add-ckbtc', { timeoutMs: 5_000 });

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
