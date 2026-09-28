/**
 * Flow 201 — the jest twin of `e2e/tests/201-send-terminal-ic.mjs`, BOTH legs.
 *
 * Leg 1 (shared relay): a settled IC send ends on the shared SendTerminal — the ledger block
 * index is the copyable reference, and View receipt opens the Wallet-root TxnReceipt with that
 * block index as the proof; no "not confirmed yet" status on a settled receipt, and no
 * Check-status control (the IC rail cannot re-read a pending transfer).
 *
 * Leg 2 (below, own relay): the deadline-forced UNKNOWN terminal via the per-gateway `ic_delay`
 * knob — harness capability `startFlowRelay` (flow/harness/flowRelay.ts).
 */
import {describe, it, expect} from '@jest/globals';
import {
  accountOf, assert, assertEq, assertIncludes, faucetAccount, onboardWallet, openBalances,
  railPrincipalText, selectCurrency, openPaySend, pointRelayListAt,
} from '../harness/lib';
import {startFlowRelay} from '../harness/flowRelay';
import {relayPostAt} from '../harness/relayClient';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

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

// ── Leg 2: the DEADLINE-FORCED UNKNOWN — private relay + the ic_delay knob ─────────────────────
// The knob is global per relay gateway, so this leg owns a startFlowRelay spawn (the harness gap
// the header above filed): POST /api/v1/test/ic_delay holds every icrc1_transfer reply out of the
// read_state certs for 12s while the sheet's poll budget is 12 × 500ms = 6s. The send becomes the
// honest pending: clock glyph, the may-still-land body, the FRESH MEMO HEX as the reference, the
// pending receipt (a "not confirmed yet" status, NO proof) — and THE INVARIANT: no resend invite
// and no Check status, because IC cannot re-read a pending transfer. The form never returns.
describe('flow 201 leg 2 — the deadline-forced unknown terminal (private relay, ic_delay 12s vs the 6s poll budget)', () => {
  it('renders the honest pending — memo-hex reference, pending receipt, no resend control — never a failure, never a spinner', async () => {
    const r2 = await startFlowRelay();
    g.__DPAY_TEST_IC_GATEWAY = r2.baseURL;
    await pointRelayListAt(r2.baseURL);
    const m = await onboardWallet('jest-send-term-2', {relayBase: r2.baseURL});
    const accountHex = (await accountOf(m))!.publicHex;
    const recipientPrincipal = await railPrincipalText(RECIPIENT_PUBKEY);

    // The twin funds VCHF on the private relay (its gateway starts EMPTY — per-process state).
    const fund = await faucetAccount(accountHex, SEED, {currency: VCHF, baseURL: r2.baseURL});
    assert(fund.ok, `private-relay funding must succeed, got HTTP ${fund.status}`);

    // Arm the knob (flow 192's pattern): hold icrc1_transfer replies for 12s.
    const arm = await relayPostAt(r2.baseURL, '/api/v1/test/ic_delay', {method: 'icrc1_transfer', ms: 12_000});
    assert(arm.ok, `ic_delay knob armed (status ${arm.status}): ${await arm.text()}`);

    try {
      await openBalances(m);
      await m.driver.waitForText('5.00 VCHF', {timeoutMs: 8000});
      await selectCurrency(m, 'vchf');
      await openPaySend(m);
      await m.driver.type('send-address-input', recipientPrincipal, {timeoutMs: 4000});
      await m.driver.findByTestID('send-status', {timeoutMs: 5000});
      await m.driver.type('send-amount-input', '1.00000000', {timeoutMs: 4000});
      await m.driver.click('btn-send-confirm', {timeoutMs: 5000});

      // The poll budget (12 × 500ms) exhausts long before the 12s reply becomes visible — the
      // HONEST pending, never a failure and never a spinner.
      assert(await m.driver.waitForText('may still', {timeoutMs: 20_000}), 'the unknown terminal renders (the transfer may still execute)');
      await m.driver.findByTestID('send-unknown-note', {timeoutMs: 4000});
      const memoRef = m.driver.readText('send-ref').trim();
      expect(memoRef).toMatch(/^[0-9a-f]{32}$/); // the unknown reference is the FRESH MEMO HEX
      expect(m.driver.isPresent('btn-send-confirm')).toBe(false); // THE INVARIANT: no resend control
      expect(m.driver.isPresent('send-nothing-sent')).toBe(false); // the envelope IS out

      // The pending receipt: a "not confirmed yet" STATUS line, and NO proof (a pending row has none).
      await m.driver.click('btn-send-receipt', {timeoutMs: 4000});
      await m.driver.findByTestID('txn-receipt', {timeoutMs: 5000});
      assert(/not confirmed|pending/i.test(m.driver.readText('txn-receipt-status')), 'the pending receipt says so');
      expect(m.driver.isPresent('txn-receipt-proof')).toBe(false);
      await m.driver.click('btn-txn-receipt-close', {timeoutMs: 4000});
    } finally {
      // Teardown ORDER (the e2e twin's): quiesce the page's polls (unmount) BEFORE the relay work.
      await m.unmount().catch(() => undefined);
      // Disarm best-effort so the relay dies clean (the harness afterEach stops it).
      await relayPostAt(r2.baseURL, '/api/v1/test/ic_delay', {method: 'icrc1_transfer', ms: 0}).catch(() => undefined);
    }
  }, 150_000);
});
