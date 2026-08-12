// Flow 63 — Receive currency picker lists SOL + picking it switches the rail to SolReceiveMode.
//
// Direct coverage for founder issue #2b/2c/2d: the ReceiveMode CurrencyPicker was IC-only (SOL was
// reachable only via the Balances sheet). The unified picker now lists SOL alongside the IC catalog
// currencies (req-pick-sol). Phase 3 (2026-08-12 unified asset selection rewrite) keeps the
// ReceiveMode picker on its legacy buildCurrencyList adapter + local reqCurrency state for now, but
// Wallet threads an interim bridge: the picker's SOL branch calls Wallet's onSelectSol prop, which
// is `() => handleSelect('solana:SOL')`. That sets selectedAssetId='solana:SOL' → selectedAsset.
// protocol==='solana' → SolReceiveMode mounts (ReceiveMode unmounts cleanly; the up-call fires
// before re-render, no race). Proves the two selectors (Balances + the Receive picker) share one
// entry path to every asset. Phase 4 will converge the ReceiveMode picker onto the same
// SelectableAsset contract and drop the interim bridge.
//
// Selector contract: `tab-receive`, `req-prefix` (amount glyph → opens picker), `req-pick-sol`
// (the unified SOL row), `active-rail-chip` (the header chip — reads 'SOL' once the rail flips),
// `sol-req-amount-input` (SolReceiveMode's amount input — proves the SOL receive form mounted).
import {setup, assertEq, onboardWallet} from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '63',
  name: 'picker-sol-rail',
  journey: 'system',
  covers: ['receive-picker', 'sol-rail', 'currency-switch'],
  verifies: 'SOL is selectable in the Receive currency picker → switches the active rail to SolReceiveMode.',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[63-picker-sol-rail] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver} = env;

    console.log('[63-picker-sol-rail] onboarding…');
    await onboardWallet(driver, 'e2e-picker-sol');

    // 1. Baseline: the active rail is DEMO (selectedAssetId reconciles to ic:0).
    let chip = await driver.readText('active-rail-chip');
    assertEq(chip, 'DEMO', 'baseline active-rail-chip (DEMO)');

    // 2. Open the Receive tab + the compact currency picker (via the amount prefix glyph).
    console.log('[63-picker-sol-rail] opening the Receive currency picker…');
    await driver.click('tab-receive', {timeoutMs: 4_000});
    await driver.findByTestID('req-prefix', {timeoutMs: 4_000});
    await driver.click('req-prefix', {timeoutMs: 4_000});

    // 3. The SOL row is present in the picker (Issue #2: SOL is now listed alongside the IC rows).
    console.log('[63-picker-sol-rail] waiting for the SOL row in the picker…');
    await driver.findByTestID('req-pick-sol', {timeoutMs: 4_000});

    // 4. Tap the SOL row → the interim onSelectSol bridge fires → handleSelect('solana:SOL') →
    //    selectedAssetId='solana:SOL' → SolReceiveMode mounts. ReceiveMode unmounts mid-update; the
    //    picker's SOL branch calls the up-call and returns immediately (no local setState), so
    //    there's no "update on unmounting component" warning.
    console.log('[63-picker-sol-rail] tapping SOL → switching rail…');
    await driver.click('req-pick-sol', {timeoutMs: 5_000});

    // 5. The header chip flips to 'SOL' (selectedAsset.symbol — the rail switched).
    chip = await driver.readText('active-rail-chip');
    assertEq(chip, 'SOL', 'active-rail-chip after picking SOL in the Receive picker');

    // 6. SolReceiveMode mounted — its amount input is present (proves the SOL receive form is the
    //    active surface, not the IC ReceiveMode).
    await driver.findByTestID('sol-req-amount-input', {timeoutMs: 8_000});
    console.log('[63-picker-sol-rail] ✓ SolReceiveMode mounted (rail switched from the picker)');

    await driver.screenshot('63-picker-sol-rail');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[63-picker-sol-rail] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/63-picker-sol-rail.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[63-picker-sol-rail] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
