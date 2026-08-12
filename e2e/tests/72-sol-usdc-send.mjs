// Flow 72 — Solana USDC direct send (Phase 6 asset-aware "Send to address").
//
// Phase 6 (2026-08-12 unified asset selection rewrite) makes SolanaWithdrawSheet asset-aware: when
// Solana USDC is the selected asset, the Pay tab's "Send to address" sub-mode must run the SPL
// Token transfer path (sendSpl), NOT the native SOL path. The fail-closed sender-ATA gate mirrors
// Phase 4's receive-side gate: if the device's USDC ATA is known absent, the send form is REPLACED
// by an instruction card (you can't send USDC you don't have an account for).
//
// This flow proves end-to-end through the REAL app:
//   1. Solana USDC is selectable in Balances (uniform with the SOL row + IC rows).
//   2. The Pay tab "Send to address" toggle surfaces SolanaWithdrawSheet with the USDC unit.
//   3. When the device's USDC ATA is ABSENT (stub getAccountInfo → null), the fail-closed
//      instruction card renders (`sol-send-instructions`) — the form is suppressed so the user
//      can never submit a doomed USDC send.
//   4. The instruction text honestly explains the one-time ATA setup requirement.
//
// The happy-path SPL send (both ATAs present → sign + broadcast) is proven in jest
// (solana-seam.test.ts → "builds + broadcasts the SPL transfer when both ATAs exist"). This flow
// covers the UI-visible fail-closed gate that jest structurally cannot see.
//
// Uses `setup({solStub: true})` so the Solana rail + Solana USDC row are coherent. The stub's
// getAccountInfo returns `{value: null}` → the device's USDC ATA is absent → the gate blocks.
//
// Selector contract: `asset-sol-usdc-select`, `tab-pay`, `btn-pay-send`, `sol-send-instructions`.
import {setup, assert, assertIncludes, onboardWallet, openBalances} from '../harness/lib.mjs';

export const meta = {
  id: '72',
  name: 'sol-usdc-send',
  journey: 'system',
  covers: ['sol-usdc-send', 'spl-transfer', 'fail-closed-ata', 'asset-aware-send'],
  verifies: 'Solana USDC "Send to address" fails closed when the device ATA is absent (no doomed SPL send).',
  timeoutMs: 30000,
};

export async function run() {
  const start = Date.now();
  console.log('[72-sol-usdc-send] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[72-sol-usdc-send] onboarding…');
    await onboardWallet(driver, 'e2e-sol-usdc-send');

    // Stub: funded SOL (getBalance) + ABSENT USDC ATA (getAccountInfo → null). The absent ATA drives
    // the fail-closed assertion below. No broadcast happens in this flow.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getLatestBlockhash: () => ({value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: () => 'sig_unused',
        getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
        getAccountInfo: () => ({value: null}),
        getBalance: () => ({value: 5000000000}),
      };
    });

    // 1. Select Solana USDC via Balances. selectedAssetId flips to 'solana:USDC' → SolPayMode mounts
    //    with selectedToken='USDC'. The Pay tab will now drive the SPL send path, not native SOL.
    console.log('[72-sol-usdc-send] selecting Solana USDC via Balances…');
    await openBalances(driver);
    await driver.findByTestID('asset-sol-usdc-select', {timeoutMs: 8_000});
    await driver.click('asset-sol-usdc-select', {timeoutMs: 5_000});
    await driver.waitGone('btn-balances-close', {timeoutMs: 5_000});

    // 2. Switch to the Pay tab. SolPayMode mounts; it reads the seeded nonce (if any) → phase='setup'
    //    (first-use gate) since we did NOT seed a nonce. That's fine — we're driving the "Send to
    //    address" sub-mode which bypasses the scan/setup phase entirely (the early-return for
    //    subMode==='send' sits before the phase rendering).
    console.log('[72-sol-usdc-send] switching to the Pay tab…');
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.findByTestID('pay-mode-toggle', {timeoutMs: 5_000});

    // 3. Switch to "Send to address" sub-mode. SolanaWithdrawSheet mounts with token='USDC'. Since the
    //    device's USDC ATA is absent (stub getAccountInfo → null), the fail-closed instruction card
    //    renders INSTEAD of the form — the user can never submit a doomed USDC send.
    console.log('[72-sol-usdc-send] switching to "Send to address" (asserting fail-closed ATA gate)…');
    await driver.click('btn-pay-send', {timeoutMs: 5_000});

    // 4. FAIL-CLOSED: the instruction card renders with `sol-send-instructions` testID. The form
    //    inputs (sol-send-address-input / sol-send-amount-input) must NOT be present — the gate
    //    replaces the entire form body. This is the honest pre-check: you can't send USDC you don't
    //    have an account for.
    const instrEl = await driver.findByTestID('sol-send-instructions', {timeoutMs: 8_000});
    const instrTxt = await instrEl.evaluate((n) => (n.textContent ?? '').trim());
    assertIncludes(instrTxt, 'USDC account', 'the fail-closed instruction should mention "USDC account"');
    console.log('[72-sol-usdc-send] ✓ fail-closed instruction card rendered');

    // The form inputs must be absent — the gate replaces the form.
    const formPresent = await driver.eval(() => !!document.querySelector('[data-testid="sol-send-address-input"]'));
    assert(formPresent === false, 'the send form must NOT render when the device ATA is absent (gate replaces it)');
    console.log('[72-sol-usdc-send] ✓ send form suppressed (no doomed submit possible)');

    await driver.screenshot('72-sol-usdc-send');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[72-sol-usdc-send] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[72-sol-usdc-send] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
