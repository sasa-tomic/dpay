// Flow 69 — unified asset selection: IC USDC ↔ Solana USDC via the picker (Phase 4 RED test).
//
// Phase 4 (2026-08-12 unified asset selection rewrite) collapses every Receive-form selector onto
// ONE Wallet-owned `selectedAssetId` + ONE `AssetPicker` + ONE `onSelectAsset(id)` contract. This
// flow pins the invariants the plan calls out (plan lines ~262-265):
//   - Balances selection is reflected by the Receive prefix AND the open picker (one source of truth).
//   - Every Receive prefix (IC ReceiveMode's `req-prefix` AND SolReceiveMode's `sol-req-prefix`)
//     opens the SAME complete asset list (no selector hides a row).
//   - Switching IC USDC ↔ Solana USDC changes the protocol/rail (ReceiveMode ↔ SolReceiveMode) and
//     clears the old amount/memo (same-protocol switch clears inline; cross-protocol switch clears
//     by unmount/remount — same observable: empty amount input after the switch).
//
// Uses `setup({solStub: true})` so the Solana rail + Solana USDC row are coherent (the stub URL is
// neither empty nor devnet → solanaUsdcCoherent → true). No broadcast happens here.
//
// Selector contract: asset-ckusdc-select, tab-receive, req-prefix, req-pick-ckusdc, req-pick-sol,
// req-pick-sol-usdc, amount-input, memo-input, sol-req-prefix, sol-req-amount-input,
// btn-sol-req-make.
import {setup, assertEq, assertIncludes, onboardWallet} from '../harness/lib.mjs';

export const meta = {
  id: '69',
  name: 'sol-usdc-selection',
  journey: 'system',
  covers: ['asset-picker', 'ic-usdc', 'sol-usdc', 'rail-switch', 'amount-clear'],
  verifies: 'IC USDC ↔ Solana USDC: unified picker switches rail + clears amount (symmetric in both directions).',
  timeoutMs: 30000,
};

export async function run() {
  const start = Date.now();
  console.log('[69-sol-usdc-selection] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[69-sol-usdc-selection] onboarding…');
    await onboardWallet(driver, 'e2e-usdc-x');

    // Stub: funded SOL (getBalance). No broadcast happens here.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: null}),
        getLatestBlockhash: () => ({value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: () => 'sig_unused',
        getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
        getAccountInfo: () => ({value: null}),
        getBalance: () => ({value: 5000000000}),
      };
    });

    // 1. Select IC USDC via Balances. The unified selection state (selectedAssetId='ic:2') is the
    //    ONE source of truth — the Receive prefix + the open picker must BOTH reflect it.
    console.log('[69-sol-usdc-selection] selecting IC USDC (ckUSDC) via Balances…');
    await driver.findByTestID('balance', {timeoutMs: 8_000});
    await driver.click('balance', {timeoutMs: 5_000});
    await driver.findByTestID('asset-ckusdc-select', {timeoutMs: 5_000});
    await driver.click('asset-ckusdc-select', {timeoutMs: 5_000});
    await driver.click('tab-receive', {timeoutMs: 5_000});

    // 2. ReceiveMode (IC rail) mounted. The amount prefix reflects the IC USDC glyph ($). Type an
    //    amount + memo so we can later prove they're cleared on a rail switch.
    console.log('[69-sol-usdc-selection] ReceiveMode mounted — typing amount + memo…');
    await driver.findByTestID('req-prefix', {timeoutMs: 5_000});
    const prefixTxt = await driver.readText('req-prefix');
    assertIncludes(prefixTxt, '$', 'IC USDC prefix should show the $ glyph');
    await driver.type('amount-input', '5', {timeoutMs: 5_000});
    await driver.type('memo-input', 'secret-memo', {timeoutMs: 5_000});

    // 3. The IC Receive picker lists BOTH the IC rows AND the Solana rows (incl. Solana USDC) —
    //    every selector renders the SAME complete visible asset list (invariant #2). The shared row
    //    testIDs prove it: req-pick-ckusdc (IC), req-pick-sol-usdc (Solana).
    console.log('[69-sol-usdc-selection] opening IC Receive picker — asserting complete list…');
    await driver.click('req-prefix', {timeoutMs: 5_000});
    await driver.findByTestID('req-pick-ckusdc', {timeoutMs: 5_000});
    await driver.findByTestID('req-pick-sol', {timeoutMs: 5_000});
    await driver.findByTestID('req-pick-sol-usdc', {timeoutMs: 5_000});
    console.log('[69-sol-usdc-selection] ✓ IC picker lists IC + Solana rows (unified list)');

    // 4. Switch to Solana USDC. selectedAssetId flips to 'solana:USDC' → SolReceiveMode mounts with
    //    selectedToken='USDC'. The old amount/memo are cleared (ReceiveMode unmounts; the picker's
    //    onSelect ran setAmount('') before the up-call). SolReceiveMode mounts fresh → empty input.
    console.log('[69-sol-usdc-selection] switching IC USDC → Solana USDC via the picker…');
    await driver.click('req-pick-sol-usdc', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-amount-input', {timeoutMs: 8_000});

    // 5. The Solana USDC rail prefix shows the $ glyph (USDC) AND the amount input is EMPTY (cleared
    //    on the cross-protocol switch — the typed "5" did NOT survive the rail flip).
    const solPrefixTxt = await driver.readText('sol-req-prefix');
    assertIncludes(solPrefixTxt, '$', 'Solana USDC prefix should show the $ glyph');
    const solAmt = await driver.readInputValue('sol-req-amount-input');
    assertEq(solAmt, '', 'Solana USDC amount input must be empty after the rail switch (amount cleared)');
    console.log('[69-sol-usdc-selection] ✓ Solana USDC rail mounted + amount cleared');

    // 6. The Solana Receive picker (sol-req-prefix) opens the SAME complete list — proving both
    //    Receive forms share one picker contract (no selector hides a row). Tapping req-pick-ckusdc
    //    both closes the picker AND flips the rail back to IC USDC (onSelect → onClose).
    console.log('[69-sol-usdc-selection] opening Solana Receive picker — asserting same complete list…');
    await driver.click('sol-req-prefix', {timeoutMs: 5_000});
    await driver.findByTestID('req-pick-ckusdc', {timeoutMs: 5_000});
    await driver.findByTestID('req-pick-sol', {timeoutMs: 5_000});
    await driver.findByTestID('req-pick-sol-usdc', {timeoutMs: 5_000});
    console.log('[69-sol-usdc-selection] ✓ Solana picker lists the same IC + Solana rows');

    // 7. Switch back to IC USDC. The rail flips back to ReceiveMode; the amount is cleared again
    //    (SolReceiveMode's picker onSelect ran setAmount('') before the up-call; ReceiveMode mounts
    //    fresh). Proves the rail-switch + amount-clear is symmetric in both directions.
    console.log('[69-sol-usdc-selection] switching Solana USDC → IC USDC via the picker…');
    await driver.click('req-pick-ckusdc', {timeoutMs: 5_000});
    await driver.findByTestID('amount-input', {timeoutMs: 8_000});
    const icAmt = await driver.readInputValue('amount-input');
    assertEq(icAmt, '', 'IC USDC amount input must be empty after switching back (amount cleared)');
    const prefixTxt2 = await driver.readText('req-prefix');
    assertIncludes(prefixTxt2, '$', 'IC USDC prefix should still show the $ glyph after the round-trip');
    console.log('[69-sol-usdc-selection] ✓ IC USDC rail restored + amount cleared (symmetric)');

    await driver.screenshot('69-sol-usdc-selection');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[69-sol-usdc-selection] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[69-sol-usdc-selection] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
