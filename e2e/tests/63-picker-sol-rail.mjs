// Flow 63 — Receive asset picker lists SOL + picking it switches the rail to SolReceiveMode.
//
// Direct coverage for founder issue #2b/2c/2d: the ReceiveMode picker was IC-only (SOL was reachable
// only via the Balances sheet). The unified AssetPicker now lists SOL alongside the IC catalog
// currencies (req-pick-sol). Phase 4 (2026-08-12 unified asset selection rewrite) converged the
// ReceiveMode picker onto the SAME SelectableAsset contract as Balances: picking any row (IC or
// SOL) fires Wallet's single `onSelectAsset(id)` (= `handleSelect`). Tapping `req-pick-sol` calls
// `onSelectAsset('solana:SOL')` → selectedAssetId='solana:SOL' → selectedAsset.protocol==='solana'
// → SolReceiveMode mounts (ReceiveMode unmounts cleanly; handleSelect resets the sub-modes too).
// Proves the two selectors (Balances + the Receive picker) share ONE entry path to every asset.
//
// Selector contract: `tab-receive`, `req-prefix` (amount glyph → opens AssetPicker), `req-pick-sol`
// (the unified SOL row), `active-asset-label` (the header asset label — reads 'SOL balance' once
// the rail flips; the former active-rail chip was dropped 2026-08-18), `sol-req-amount-input`
// (SolReceiveMode's amount input — proves the SOL receive form mounted).
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
  timeoutMs: 90000,
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
    let label = await driver.readText('active-asset-label');
    assertEq(label, 'DEMO balance', 'baseline active-asset-label (DEMO)');

    // 2. Open the Receive tab + the compact currency picker (via the amount prefix glyph).
    console.log('[63-picker-sol-rail] opening the Receive currency picker…');
    await driver.click('tab-receive', {timeoutMs: 4_000});
    await driver.findByTestID('req-prefix', {timeoutMs: 4_000});
    await driver.click('req-prefix', {timeoutMs: 4_000});

    // 3. The SOL row is present in the picker (Issue #2: SOL is now listed alongside the IC rows).
    console.log('[63-picker-sol-rail] waiting for the SOL row in the picker…');
    await driver.findByTestID('req-pick-sol', {timeoutMs: 4_000});

    // 4. Tap the SOL row → the unified onSelectAsset fires → handleSelect('solana:SOL') →
    //    selectedAssetId='solana:SOL' → SolReceiveMode mounts. ReceiveMode unmounts mid-update; the
    //    picker's row handler calls `onSelect(id); onClose()` and returns, so there's no "update on
    //    unmounting component" warning (no local setState after the up-call).
    console.log('[63-picker-sol-rail] tapping SOL → switching rail…');
    await driver.click('req-pick-sol', {timeoutMs: 5_000});

    // 5. The header asset label flips to 'SOL balance' (selectedAsset.symbol — the rail switched).
    label = await driver.readText('active-asset-label');
    assertEq(label, 'SOL balance', 'active-asset-label after picking SOL in the Receive picker');

    // 6. SolReceiveMode mounted — its amount input is present (proves the SOL receive form is the
    //    active surface, not the IC ReceiveMode). Phase 4: this mount now happens via Wallet's
    //    handleSelect reconcile, not the Phase 3 interim onSelectSol bridge.
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
