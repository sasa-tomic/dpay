// Flow 45 — Native SOL rail: balance card + receive address (inline in the Receive tab).
//
// Proves the device-derived Solana key path renders in the Balances hub (a SEPARATE card from the
// relay-mediated catalog) and that the locally-derived Solana address + QR + copy surface is reached
// via the SAME tab IA every IC currency uses (no per-currency exception): Balances → select SOL →
// Receive tab → "My address" sub-mode (the receive-mode-toggle right segment). The address is derived
// IN-BROWSER from the real onboarding seed via the same SLIP-10 m/44'/501'/0'/0' path the device uses
// (e2e/web/dpay-core.ts provides a real noble generateKeypair), so this is a true end-to-end check of
// the derivation + rendering, not a stub.
//
// RPC is DISABLED in e2e (`__DPAY_TEST_SOLANA_RPC_URL=''`) so the balance shows "—" and no devnet
// call is ever made — the inner loop stays fully offline. The deposit address renders inline (no
// overlay sheet); the SOL per-row Balances buttons are gone (uniform with IC).
import {setup, assert, assertIncludes, onboardWallet, openBalances} from '../harness/lib.mjs';

export const meta = {
  id: '45',
  name: 'sol-receive',
  journey: 'deposit',
  covers: ['sol-card', 'sol-derive', 'sol-receive', 'qr', 'address', 'sol-tab-ia'],
  verifies: 'Native SOL rail: device-derived SOL card in Balances + receive address QR via the Receive tab "My address" sub-mode (offline, no devnet).',
  timeoutMs: 20000,
};

// base58 (Bitcoin alphabet) — the Solana address charset. 32–44 chars is the valid pubkey range.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function run() {
  const start = Date.now();
  console.log('[45-sol-receive] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver} = env;

    console.log('[45-sol-receive] onboarding to seed a device identity…');
    await onboardWallet(driver, 'e2e-sol');

    console.log('[45-sol-receive] opening the Balances hub…');
    await openBalances(driver);

    // 1. The SOL card renders as a SEPARATE concern from the catalog loop. It must show the asset
    //    label and the offline balance placeholder "—" (RPC disabled → no devnet call).
    console.log('[45-sol-receive] waiting for the SOL asset card…');
    const solCard = await driver.findByTestID('asset-sol', {timeoutMs: 8_000});
    const cardTxt = await solCard.evaluate((n) => (n.textContent ?? '').trim());
    assertIncludes(cardTxt, 'SOL', 'SOL card should show the SOL asset label');
    assertIncludes(cardTxt, '—', 'SOL card should show "—" balance when RPC is disabled (offline)');
    console.log('[45-sol-receive] ✓ SOL card renders with offline "—" balance');

    // 2. Select SOL as the active asset (the whole-row select; SOL === IC — no per-row Receive/Send
    //    buttons anymore). The Balances sheet auto-closes; SOL becomes the active rail.
    console.log('[45-sol-receive] selecting SOL as the active asset…');
    await driver.click('asset-sol-select', {timeoutMs: 5_000});
    await driver.waitGone('btn-balances-close', {timeoutMs: 5_000});

    // 3. Switch to the Receive tab. SolReceiveMode mounts; the "My address" sub-mode toggle (the
    //    right segment of the receive-mode-toggle) is always rendered for SOL.
    console.log('[45-sol-receive] switching to the Receive tab…');
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('receive-mode-toggle', {timeoutMs: 5_000});

    // 4. Tap "My address" → the SolanaReceiveSheet body renders INLINE in the tab (no overlay).
    //    The address comes from the SAME seed as the IC identity, derived via SLIP-10 m/44'/501'/0'/0'
    //    — fully in-browser, no network.
    console.log('[45-sol-receive] opening the SOL receive address sub-mode…');
    await driver.click('btn-receive-address', {timeoutMs: 5_000});
    const address = await driver.readText('sol-receive-address');
    assert(BASE58.test(address),
      `SOL receive address should be a valid base58 Solana address (32–44 chars), got "${address}"`);
    console.log(`[45-sol-receive] ✓ receive address: ${address}`);

    // Back-toggle regression (Rules of Hooks): SolReceiveMode's early return for the 'address'
    // sub-mode MUST sit below its useState/useEffect calls. Otherwise toggling back to 'request'
    // renders more hooks than the previous (address) render and React silently resets the component
    // state. We detect the reset by mutating a piece of state (the amount input), toggling away to
    // 'address' and back to 'request', then asserting the amount SURVIVED. A hook-order violation
    // re-initializes useState on the toggle-back, so the amount snaps back to its default '0.025'.
    await driver.click('btn-receive-request', {timeoutMs: 5_000});
    await driver.waitGone('sol-receive-address', {timeoutMs: 5_000});
    await driver.findByTestID('receive-mode-toggle', {timeoutMs: 5_000});
    const amountInput = await driver.findByTestID('sol-req-amount-input', {timeoutMs: 8_000});
    await driver.type('sol-req-amount-input', '1.0', {timeoutMs: 5_000});
    const beforeToggle = await driver.readInputValue('sol-req-amount-input');
    assert(beforeToggle === '1.0', `amount should be 1.0 after typing, got "${beforeToggle}"`);
    await driver.click('btn-receive-address', {timeoutMs: 5_000});
    await driver.findByTestID('sol-receive-address', {timeoutMs: 5_000});
    await driver.click('btn-receive-request', {timeoutMs: 5_000});
    await driver.waitGone('sol-receive-address', {timeoutMs: 5_000});
    const afterToggle = await driver.readInputValue('sol-req-amount-input', {timeoutMs: 8_000});
    assert(afterToggle === '1.0', `amount should be preserved across the address detour (Rules of Hooks), got "${afterToggle}"`);
    console.log('[45-sol-receive] ✓ request-form state preserved across address detour');

    // Return to the "My address" sub-mode for the original copy-control + screenshot checks below.
    await driver.click('btn-receive-address', {timeoutMs: 5_000});
    await driver.findByTestID('sol-receive-address', {timeoutMs: 5_000});

    // 5. The copy control is present inline (mirrors the ckBTC deposit sheet's copy affordance).
    await driver.findByTestID('btn-sol-receive-copy', {timeoutMs: 5_000});
    console.log('[45-sol-receive] ✓ copy control present (inline)');

    await driver.screenshot('45-sol-receive');

    // 6. Pay tab parity: switching to the Pay tab surfaces the SOL "Send to address" toggle (uniform
    //    with IC — SOL no longer carries per-row Balances Send). Assert the toggle exists; it's gated
    //    on no balance offline, so only the toggle (not the funded-only send surface) is asserted.
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.findByTestID('btn-pay-send', {timeoutMs: 5_000});
    console.log('[45-sol-receive] ✓ Pay tab "Send to address" toggle present (SOL === IC)');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[45-sol-receive] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/45-sol-receive.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[45-sol-receive] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
