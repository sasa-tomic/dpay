/**
 * Flow 201 — the jest twin of `e2e/tests/201-send-terminal-ic.mjs`, leg 1 (the SETTLED terminal).
 *
 * A settled IC send ends on the shared SendTerminal: the ledger block index is the copyable
 * reference, and View receipt opens the Wallet-root TxnReceipt with that block index as the proof —
 * no "not confirmed yet" status on a settled receipt, and no Check-status control (the IC rail
 * cannot re-read a pending transfer).
 *
 * HARNESS GAP (filed for the integrator): the twin's leg 2 (the deadline-forced UNKNOWN terminal)
 * needs a PRIVATE relay with the `ic_delay` knob armed (12s > the 6s poll budget). jest has exactly
 * one relay per run and the knob is global per relay process — arming it here would stall every
 * concurrent worker's IC settlements. Port leg 2 when the harness grows per-run relay isolation.
 */
import {describe, it, expect} from '@jest/globals';
import {
  accountOf, assert, assertEq, assertIncludes, faucetAccount, onboardWallet, openBalances,
  railPrincipalText, selectCurrency, openPaySend,
} from '../harness/lib';

const VCHF = 7;
const SEED = 500_000_000; // 5.00000000 VCHF
const RECIPIENT_PUBKEY = 'c'.repeat(64); // a second wallet's pubkey — a REAL external destination

describe('flow 201 — the settled IC send terminal: block-index reference + TxnReceipt proof', () => {
  it('Sent → the block index as a copyable reference → the receipt carries it as the proof', async () => {
    const m = await onboardWallet('jest-send-term');
    const accountHex = (await accountOf(m))!.publicHex;
    const recipientPrincipal = await railPrincipalText(RECIPIENT_PUBKEY);

    const fund = await faucetAccount(accountHex, SEED, {currency: VCHF});
    assert(fund.ok, `faucet funding must succeed, got ${fund.status}`);
    await openBalances(m);
    await m.driver.waitForText('5.00 VCHF', {timeoutMs: 8000});
    await selectCurrency(m, 'vchf');
    await openPaySend(m);
    await m.driver.type('send-address-input', recipientPrincipal, {timeoutMs: 4000});
    await m.driver.findByTestID('send-status', {timeoutMs: 5000});
    await m.driver.type('send-amount-input', '1.25000000', {timeoutMs: 4000});

    await m.driver.click('btn-send-confirm', {timeoutMs: 5000});
    assert(await m.driver.waitForText('Sent', {timeoutMs: 15_000}), 'the settled terminal shows the Sent headline');
    assertEq(m.driver.readText('send-destination'), recipientPrincipal, 'the terminal shows the FULL destination');
    const blockRef = m.driver.readText('send-ref').trim();
    expect(blockRef).toMatch(/^\d+$/); // the settled reference is the LEDGER BLOCK INDEX
    await m.driver.findByTestID('btn-send-copy', {timeoutMs: 4000}); // the reference is copyable
    expect(m.driver.isPresent('btn-send-check')).toBe(false); // IC offers NO Check status

    // View receipt → the SAME TxnReceipt the History rows open, with the block index as PROOF.
    await m.driver.click('btn-send-receipt', {timeoutMs: 4000});
    await m.driver.findByTestID('txn-receipt', {timeoutMs: 5000});
    assertIncludes(m.driver.readText('txn-receipt-proof'), blockRef, `the receipt's proof IS the terminal's block index (${blockRef})`);
    expect(m.driver.isPresent('txn-receipt-status')).toBe(false); // a settled receipt carries no pending status
    await m.driver.click('btn-txn-receipt-close', {timeoutMs: 4000});
    await m.driver.waitGone('txn-receipt', {timeoutMs: 4000});

    await m.unmount();
  }, 150_000);
});
