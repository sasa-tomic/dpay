/**
 * Flow 45 sol-receive — the jest twin of `e2e/tests/45-sol-receive.mjs`.
 *
 * The native SOL rail's receive surface: the device-derived Solana address (SLIP-10 m/44'/501'/0'/0'
 * from the onboarding seed — the real wasm core, no stub), the QR carrying a Solana Pay URI
 * `solana:<address>?reference=<base58>` (no spl-token), the Rules-of-Hooks toggle regression
 * (request-form state survives an address detour), the copy control writing the EXACT address to
 * the clipboard seam, and the read-back: scanning the receive QR in the Pay tab opens the Solana
 * Pay review for the SAME address. RPC stays disabled (`''`) — fully offline, no devnet.
 */
import {describe, it, expect} from '@jest/globals';
import {
  assert, assertEq, assertIncludes, armPayScan, onboardWallet, openBalances, selectCurrency,
} from '../harness/lib';

const g = globalThis as unknown as Record<string, unknown>;

// base58 (Bitcoin alphabet) — the Solana address charset. 32–44 chars is the valid pubkey range.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

describe('flow 45 — SOL receive: derived address, Solana Pay QR, hooks-safe toggle, read-back', () => {
  it('derives the SOL address offline, copies it, and scans its own QR back into review', async () => {
    const m = await onboardWallet('jest-sol');

    // 1. The SOL card renders as a SEPARATE concern from the catalog loop: asset label + the
    //    offline balance placeholder "—" (RPC disabled → no devnet call).
    await openBalances(m);
    await m.driver.findByTestID('accounts-currency-SOL', {timeoutMs: 8_000});
    const cardTxt = m.driver.readText('accounts-currency-SOL');
    assertIncludes(cardTxt, 'SOL', 'SOL row should show the SOL asset label');
    assertIncludes(cardTxt, '—', 'SOL row should show "—" balance when RPC is disabled (offline)');

    // 2. Select SOL as the active asset (the whole-row select; SOL === IC — no per-row buttons).
    await selectCurrency(m, 'sol', {timeoutMs: 5_000});

    // 3-4. Receive tab → "My address" → the address derived IN-PROCESS from the same seed.
    await m.driver.click('tab-receive', {timeoutMs: 5_000});
    await m.driver.findByTestID('receive-mode-toggle', {timeoutMs: 5_000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5_000});
    const address = m.driver.readText('sol-receive-address');
    expect(address).toMatch(BASE58);

    // The QR carries a Solana Pay URI `solana:<address>?reference=<base58>`, never an spl-token.
    const qrVal = g.__DPAY_QR_LAST as string;
    assert(typeof qrVal === 'string' && qrVal.startsWith(`solana:${address}?reference=`),
      `the receive QR must carry a Solana Pay URI solana:<address>?reference=, got "${qrVal}"`);
    const solanaPayRef = qrVal.slice(`solana:${address}?reference=`.length);
    expect(solanaPayRef).toMatch(BASE58);
    expect(qrVal.includes('spl-token')).toBe(false);

    // Back-toggle regression (Rules of Hooks): the 'address' sub-mode early return must sit below
    // the component's hooks. Detected by mutating state (the amount input), toggling away and
    // back, then asserting the amount SURVIVED — a hook-order violation re-initializes useState.
    await m.driver.click('btn-receive-request', {timeoutMs: 5_000});
    await m.driver.waitGone('sol-receive-address', {timeoutMs: 5_000});
    await m.driver.findByTestID('receive-mode-toggle', {timeoutMs: 5_000});
    await m.driver.findByTestID('sol-req-amount-input', {timeoutMs: 8_000});
    await m.driver.type('sol-req-amount-input', '1.0', {timeoutMs: 5_000});
    const beforeToggle = m.driver.readInputValue('sol-req-amount-input');
    expect(beforeToggle).toBe('1.0');
    await m.driver.click('btn-receive-address', {timeoutMs: 5_000});
    await m.driver.findByTestID('sol-receive-address', {timeoutMs: 5_000});
    await m.driver.click('btn-receive-request', {timeoutMs: 5_000});
    await m.driver.waitGone('sol-receive-address', {timeoutMs: 5_000});
    const afterToggle = m.driver.readInputValue('sol-req-amount-input');
    expect(afterToggle).toBe('1.0');

    // Return to the "My address" sub-mode for the copy-control checks.
    await m.driver.click('btn-receive-address', {timeoutMs: 5_000});
    await m.driver.findByTestID('sol-receive-address', {timeoutMs: 5_000});

    // 5. The copy control is present inline and writes the EXACT address to the REAL clipboard
    //    (the harness Share recorder — the seam the browser build's navigator.clipboard fills).
    await m.driver.findByTestID('btn-sol-receive-copy', {timeoutMs: 5_000});
    assertEq(g.__DPAY_TEST_CLIPBOARD, '', 'clipboard seam should be empty before SOL copy');
    await m.driver.click('btn-sol-receive-copy', {timeoutMs: 5_000});
    await m.driver.waitForText('Copied', {timeoutMs: 4_000});
    assertEq(g.__DPAY_TEST_CLIPBOARD, address, 'clipboard seam after SOL copy should equal the derived address');

    // 6. Pay tab parity: the SOL "Send to address" toggle exists (uniform with IC).
    await m.driver.click('tab-pay', {timeoutMs: 5_000});
    await m.driver.findByTestID('btn-pay-send', {timeoutMs: 5_000});

    // 7. READ-BACK: scan the URI this flow captured at step 4. The camera answers its own Solana
    //    Pay QR with the Solana Pay review for the SAME address (amount-less by design — the payer
    //    names the amount; reaching review sends nothing with RPC disabled).
    await armPayScan(m);
    (g.__DPAY_TEST_SCAN as (v: string) => void)(qrVal);
    await m.driver.findByTestID('sol-spay-amount-input', {timeoutMs: 8_000});
    assertEq(m.driver.readText('sol-pay-payee'), address,
      'reading the receive QR back must open review for the SAME address');
    await m.driver.findByTestID('btn-approve', {timeoutMs: 5_000});
    await m.driver.findByTestID('btn-sol-pay-cancel', {timeoutMs: 5_000});

    await m.unmount();
  }, 120_000);
});
