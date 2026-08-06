// Flow 45 — Native SOL rail: balance card + receive address sheet.
//
// Proves the device-derived Solana key path renders in the Balances hub (a SEPARATE card from the
// relay-mediated catalog) and that tapping Receive opens a sheet with the locally-derived Solana
// address + QR + copy. The address is derived IN-BROWSER from the real onboarding seed via the same
// SLIP-10 m/44'/501'/0'/0' path the device uses (e2e/web/dpay-core.ts provides a real noble
// generateKeypair), so this is a true end-to-end check of the derivation + rendering, not a stub.
//
// RPC is DISABLED in e2e (`__DPAY_TEST_SOLANA_RPC_URL=''`) so the balance shows "—" and no devnet
// call is ever made — the inner loop stays fully offline. The Send button is gated on a positive
// balance, so it is correctly ABSENT here; the send sheet's local signing is covered byte-exact by
// jest (solana-tx.test.ts vs @solana/web3.js) and its UI mirrors the e2e-covered WithdrawSheet.
import {setup, assert, assertIncludes, onboardWallet, openBalances} from '../harness/lib.mjs';

export const meta = {
  id: '45',
  name: 'sol-receive',
  journey: 'deposit',
  covers: ['sol-card', 'sol-derive', 'sol-receive', 'qr', 'address'],
  verifies: 'Native SOL rail: device-derived SOL card in Balances + receive address QR (offline, no devnet).',
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

    // 2. Receive opens the locally-derived address sheet. The address comes from the SAME seed as the
    //    IC identity, derived via SLIP-10 m/44'/501'/0'/0' — fully in-browser, no network.
    console.log('[45-sol-receive] opening the SOL receive sheet…');
    await driver.click('btn-sol-receive', {timeoutMs: 5_000});
    await driver.findByTestID('sol-receive-address', {timeoutMs: 8_000});
    const address = await driver.readText('sol-receive-address');
    assert(BASE58.test(address),
      `SOL receive address should be a valid base58 Solana address (32–44 chars), got "${address}"`);
    console.log(`[45-sol-receive] ✓ receive address: ${address}`);

    // 3. The copy control is present (mirrors the ckBTC deposit sheet's copy affordance).
    await driver.findByTestID('btn-sol-receive-copy', {timeoutMs: 5_000});
    console.log('[45-sol-receive] ✓ copy control present');

    await driver.screenshot('45-sol-receive');

    // 4. Closing returns to the Balances hub (the sheet unmounts).
    await driver.click('btn-sol-receive-close', {timeoutMs: 5_000});
    await driver.waitGone('sol-receive-address', {timeoutMs: 5_000});
    console.log('[45-sol-receive] ✓ receive sheet closed');

    // 5. The Send button is gated on a positive balance — with RPC disabled it must NOT render.
    //    This guards against a gating regression that would offer a send with no funded balance.
    let sendPresent = true;
    try { await driver.findByTestID('btn-sol-send', {timeoutMs: 1_500}); } catch { sendPresent = false; }
    assert(!sendPresent, 'Send SOL button must be absent when balance is unfunded (offline)');
    console.log('[45-sol-receive] ✓ Send button correctly absent (balance unfunded)');

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
