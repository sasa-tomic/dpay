/**
 * Flow 45 sol-receive — the jest twin of `e2e/tests/45-sol-receive.mjs`.
 *
 * The native SOL rail: the device-derived SOL card in Balances (offline "—" balance — the RPC
 * override is the suite default, so no devnet call is ever made) and the receive address reached
 * via the SAME tab IA every IC currency uses (Balances → select SOL → Receive ▸ "My address").
 * The address is derived from the real onboarding seed via SLIP-10 m/44'/501'/0'/0' in the wasm
 * core; the QR carries a Solana Pay URI (solana:<address>?reference=<base58>, amount-less); the
 * request-form state survives the address detour (Rules of Hooks); the copy control writes the
 * EXACT address to the clipboard seam; and scanning the receive URI back in the Pay tab opens the
 * Solana Pay review for the SAME address.
 */
import {describe, it, expect} from '@jest/globals';
import {
  armPayScan, assertEq, assertIncludes, assert, onboardWallet, openBalances, selectCurrency,
} from './h';

const g = globalThis as unknown as Record<string, unknown>;

// base58 (Bitcoin alphabet) — the Solana address charset. 32–44 chars is the valid pubkey range.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

describe('flow 45 — SOL receive: derived card + address, Solana Pay QR, copy, read-back', () => {
  it('the offline SOL surface renders, copies, and its QR scans back into the pay review', async () => {
    const m = await onboardWallet('jest-sol-rcv');
    await openBalances(m);

    // 1. The SOL card renders as a SEPARATE concern from the catalog loop: the asset label and
    //    the offline balance placeholder (RPC disabled → no devnet call).
    const cardTxt = m.driver.readText('accounts-currency-SOL');
    assertIncludes(cardTxt, 'SOL', 'SOL row should show the SOL asset label');
    assertIncludes(cardTxt, '—', 'SOL row should show "—" balance when RPC is disabled (offline)');

    // 2. Select SOL as the active asset (whole-row select, uniform with IC).
    await selectCurrency(m, 'sol', {timeoutMs: 5000});

    // 3. Receive tab → the "My address" sub-mode (always rendered for SOL).
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.findByTestID('receive-mode-toggle', {timeoutMs: 5000});

    // 4. "My address" → the Solana receive sheet body inline; base58 address from the seed.
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    const address = m.driver.readText('sol-receive-address');
    assert(BASE58.test(address), `SOL receive address should be a valid base58 Solana address (32–44 chars), got "${address}"`);

    // The QR carries a Solana Pay URI: solana:<address>?reference=<base58 pubkey>, no spl-token.
    const qrVal = g.__DPAY_QR_LAST;
    assert(typeof qrVal === 'string' && qrVal.startsWith(`solana:${address}?reference=`),
      `the receive QR must carry a Solana Pay URI solana:<address>?reference=, got "${String(qrVal)}"`);
    const solanaPayRef = (qrVal as string).slice(`solana:${address}?reference=`.length);
    assert(BASE58.test(solanaPayRef), `the reference param must be a base58 pubkey, got "${solanaPayRef}"`);
    expect((qrVal as string).includes('spl-token')).toBe(false);

    // 5. Rules-of-hooks regression: the request form's state must survive an address detour.
    await m.driver.click('btn-receive-request', {timeoutMs: 5000});
    await m.driver.waitGone('sol-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('receive-mode-toggle', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-req-amount-input', {timeoutMs: 8000});
    await m.driver.type('sol-req-amount-input', '1.0', {timeoutMs: 5000});
    assertEq(m.driver.readInputValue('sol-req-amount-input'), '1.0', 'amount should be 1.0 after typing');
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-receive-address', {timeoutMs: 5000});
    await m.driver.click('btn-receive-request', {timeoutMs: 5000});
    await m.driver.waitGone('sol-receive-address', {timeoutMs: 5000});
    assertEq(m.driver.readInputValue('sol-req-amount-input'), '1.0',
      'amount should be preserved across the address detour (Rules of Hooks)');

    // 6. The copy control writes the EXACT derived address to the clipboard seam.
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-sol-receive-copy', {timeoutMs: 5000});
    assertEq(g.__DPAY_TEST_CLIPBOARD, '', 'clipboard seam should be empty before SOL copy');
    await m.driver.click('btn-sol-receive-copy', {timeoutMs: 5000});
    // The jest flow tier has no navigator.clipboard, so the write takes the app's Share fallback
    // (the recorder seam still captures the text) — the button confirms 'Shared ✓' where the
    // e2e browser's real clipboard path confirms 'Copied ✓'. Either label is the success state.
    expect(await m.driver.waitForFunction(
      () => /Copied ✓|Shared ✓/.test(m.driver.readTextSafe('btn-sol-receive-copy') ?? ''),
      {timeoutMs: 4000, label: 'copy feedback label'},
    )).toBeUndefined();
    assertEq(g.__DPAY_TEST_CLIPBOARD, address, 'clipboard seam after SOL copy should equal the derived address');

    // 7. Pay tab parity: the SOL "Send to address" toggle exists (uniform with IC).
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-pay-send', {timeoutMs: 5000});

    // 8. READ-BACK: scan the captured receive URI — the app must open the Solana Pay review for
    //    the SAME address, with amount entry (the QR is amount-less by design). RPC stays off.
    await armPayScan(m);
    (g.__DPAY_TEST_SCAN as (v: string) => void)(qrVal as string);
    await m.driver.findByTestID('sol-spay-amount-input', {timeoutMs: 8000});
    assertEq(m.driver.readText('sol-pay-payee'), address,
      'reading the receive QR back must open review for the SAME address');
    await m.driver.findByTestID('btn-approve', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-sol-pay-cancel', {timeoutMs: 5000});

    await m.unmount();
  }, 120_000);
});
