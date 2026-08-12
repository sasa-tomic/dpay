// Flow 62 — SOL/USDC ATA gating (F4, fail-closed).
//
// USDC offline-pay needs the device's USDC Associated Token Account to pre-exist on-chain (the
// merchant's `toAta` is encoded in the request; the payer's source ATA is debited). Without one the
// request is unfulfillable and the broadcast fails opaquely at the Token program. F4 gates the USDC
// selection: when the merchant selects USDC and the device has no USDC ATA, the form shows a clear
// inline warning and disables Request (the request would be unfulfillable). This flow proves the
// gate fires + is currency-specific (switching back to SOL clears it).
//
// Phase 4 (2026-08-12 unified asset selection rewrite): the OLD binary `sol-req-prefix` toggle
// (SOL↔USDC) is GONE. `sol-req-prefix` now OPENS the unified AssetPicker; selecting `req-pick-sol-usdc`
// sets selectedAssetId='solana:USDC' via Wallet's handleSelect → SolReceiveMode receives
// selectedToken='USDC' → the F4 effect runs `checkUsdcAta` → `accountExists` (stub getAccountInfo
// returns `{value: null}`) → usdcAta='absent' → `sol-usdc-ata-warn` renders + `btn-sol-req-make`
// disabled. Switching back via `req-pick-sol` sets selectedToken='SOL' → usdcAta resets → gate clears.
//
// Selector contract: asset-sol-select, tab-receive, sol-req-prefix, req-pick-sol-usdc, req-pick-sol,
// sol-usdc-ata-warn, btn-sol-req-make.
import {setup, assert, assertDisabled, onboardWallet} from '../harness/lib.mjs';

export const meta = {
  id: '62',
  name: 'sol-usdc-ata-warning',
  journey: 'offline',
  covers: ['sol-merchant', 'sol-usdc', 'ata-gate', 'asset-picker', 'disabled-request'],
  verifies: 'USDC selection: no USDC ATA → inline warning + Request disabled; SOL clears it.',
  timeoutMs: 25000,
};

export async function run() {
  const start = Date.now();
  console.log('[62-sol-usdc-ata-warning] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[62-sol-usdc-ata-warning] onboarding…');
    await onboardWallet(driver, 'e2e-sol-usdc-ata');

    // Install the stub. The F4 ATA check calls getAccountInfo for the device's derived USDC ATA; a
    // `{value: null}` response means the account does not exist → usdcAta='absent'. getBalance feeds
    // useSolanaBalance so the SOL card renders funded (the form is reachable). No broadcast happens
    // in this flow, so no nonce data is needed.
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

    // 1. Select SOL via the Balances sheet, then switch to the Receive tab.
    console.log('[62-sol-usdc-ata-warning] selecting SOL + opening the Receive form…');
    await driver.findByTestID('balance', {timeoutMs: 8_000});
    await driver.click('balance', {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-amount-input', {timeoutMs: 5_000});

    // 2. Open the unified AssetPicker (Phase 4: `sol-req-prefix` no longer toggles inline — it opens
    //    the picker) and select USDC. selectedAssetId flips to 'solana:USDC' → SolReceiveMode re-
    //    renders with selectedToken='USDC' → the F4 effect fires checkUsdcAta → stub getAccountInfo
    //    → null → usdcAta='absent'.
    console.log('[62-sol-usdc-ata-warning] opening AssetPicker + selecting USDC (no ATA on-chain)…');
    await driver.click('sol-req-prefix', {timeoutMs: 5_000});
    await driver.findByTestID('req-pick-sol-usdc', {timeoutMs: 5_000});
    await driver.click('req-pick-sol-usdc', {timeoutMs: 5_000});

    // 3. The inline warning renders + Request is disabled (the request would be unfulfillable).
    const warnEl = await driver.findByTestID('sol-usdc-ata-warn', {timeoutMs: 8_000});
    const warnTxt = await warnEl.evaluate((n) => (n.textContent ?? '').trim());
    assert(/USDC account/i.test(warnTxt), `the warning should mention "USDC account", got: "${warnTxt}"`);
    console.log(`[62-sol-usdc-ata-warning] ✓ warning: "${warnTxt}"`);
    await assertDisabled(driver, 'btn-sol-req-make', 'Request must be disabled when USDC is selected but no ATA exists (F4)');
    console.log('[62-sol-usdc-ata-warning] ✓ Request disabled while USDC ATA is absent');

    // 4. Switch back to SOL via the picker — the gate clears (SOL needs no ATA; the warning
    //    disappears, Request re-enables). Proves the gate is currency-specific and not stuck.
    console.log('[62-sol-usdc-ata-warning] switching back to SOL via picker (gate must clear)…');
    await driver.click('sol-req-prefix', {timeoutMs: 5_000});
    await driver.findByTestID('req-pick-sol', {timeoutMs: 5_000});
    await driver.click('req-pick-sol', {timeoutMs: 5_000});
    // The warning element must be gone (findByTestID would throw past its timeout if it lingered).
    let warnStillThere = true;
    try {
      await driver.findByTestID('sol-usdc-ata-warn', {timeoutMs: 3_000});
    } catch {
      warnStillThere = false;
    }
    assert(!warnStillThere, 'the USDC ATA warning must disappear after switching back to SOL');
    // Request re-enabled: online + SOL (no ATA gate). Confirm it is NOT disabled.
    const disabled = await driver.eval((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) return false;
      return el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled') || el.disabled === true;
    }, 'btn-sol-req-make');
    assert(disabled === false, 'Request must be re-enabled after switching back to SOL (online + no ATA gate)');
    console.log('[62-sol-usdc-ata-warning] ✓ gate cleared on SOL — Request re-enabled');

    await driver.screenshot('62-sol-usdc-ata-warning');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[62-sol-usdc-ata-warning] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[62-sol-usdc-ata-warning] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
