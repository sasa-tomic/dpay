/**
 * Flow 202 — the jest twin of `e2e/tests/202-send-terminal-sol.mjs` (the SOL send terminal), driven
 * through the RELAY's own Solana stub upstream (the derived production path: the app talks to the
 * relay proxy, whose upstream flip is armed over the test-helpers route).
 *
 * Leg A: a 3s confirm deadline over an ACCEPTED broadcast lands on the honest unknown — signature
 * kept, NO send control, no fee-only claim, no nothing-sent claim — and Check status re-reads the
 * chain read-only and flips the panel to settled (the SAME signature survives the flip). Leg B: an
 * on-chain InstructionError over an accepted broadcast returns to the form with the fee-only note,
 * without the nothing-sent line — a NEW send is the user's own consent.
 *
 * LOAD-ORDER CONTRACT: the RPC override (the relay proxy URL) is set before the harness require.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';

const G = globalThis as unknown as Record<string, unknown>;
// The derived production path: the RELAY's Solana proxy (the stub upstream lives behind it).
// The hermetic fetch rewrite carries this module-captured URL to the FILE's private relay
// (per-fetch rewrite — the string names the run's shared origin, the fetch lands hermetic).
G.__DPAY_TEST_SOLANA_RPC_URL = `${process.env.DPAY_JEST_RELAY_URL}/api/v1/solana/rpc`;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../harness/lib') as typeof import('../harness/lib');
const {assertEq, onboardWallet, openBalances, selectCurrency, openPaySend} = lib;
const {relayPost} = require('../harness/relayClient') as typeof import('../harness/relayClient');

const DEST_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r'; // valid base58 Solana address

/** Arm the stub upstream's getSignatureStatuses flip (relay test-helpers route). */
async function armMode(body: Record<string, unknown>): Promise<void> {
  const r = await relayPost('/api/v1/test/solana-upstream/mode', body);
  expect(r.ok).toBe(true); // stub mode armed
}

const absent = async (m: Parameters<typeof openBalances>[0], testID: string): Promise<boolean> => {
  await new Promise((r) => setTimeout(r, 200));
  return !m.driver.isPresent(testID);
};

hermeticDescribe('flow 202 — the SOL send terminal: honest unknown → Check status → settled; the fee-only failure', () => {
  it('deadline over an accepted broadcast stays honest; Check settles it; a chain failure names the fee', async () => {
    const m = await onboardWallet('jest-send-term-sol');
    // The per-call deadline seam: every confirm press reads it fresh (prod shape, only shorter).
    G.__DPAY_TEST_SOL_SEND_TIMEOUT_MS = 3000;

    // ── Leg A: submitting → unknown → Check status → settled ──────────────────────────────────
    await armMode({confirmAfterHits: 1});
    await openBalances(m);
    expect(await m.driver.waitForText('2 SOL', {timeoutMs: 15_000})).toBe(true); // the stub upstream funds the wallet 2 SOL
    await selectCurrency(m, 'sol', {timeoutMs: 5000});
    await openPaySend(m);
    await m.driver.findByTestID('sol-send-address-input', {timeoutMs: 5000});
    await m.driver.type('sol-send-address-input', DEST_ADDR, {timeoutMs: 4000});
    await m.driver.type('sol-send-amount-input', '0.5', {timeoutMs: 4000});
    await m.driver.findByTestID('sol-send-review', {timeoutMs: 4000});

    await lib.waitForEnabled(m, 'btn-sol-send-confirm');
    await m.driver.click('btn-sol-send-confirm', {timeoutMs: 5000});
    expect(await m.driver.waitForText('not confirmed yet', {timeoutMs: 25_000})).toBe(true);
    // the deadline over the ACCEPTED broadcast lands on the honest unknown
    expect(await absent(m, 'btn-sol-send-confirm')).toBe(true); // THE INVARIANT: no resend control
    expect(await absent(m, 'sol-send-fee-note')).toBe(true); // a pending send never claims fee-only
    expect(await absent(m, 'sol-send-nothing-sent')).toBe(true); // …and never claims nothing was sent
    const sig = m.driver.readText('sol-send-signature').trim();
    expect(sig.length).toBeGreaterThan(0); // the signature is kept and shown as the reference

    // Check status → the stub flips → settled.
    await m.driver.click('btn-sol-send-check', {timeoutMs: 4000});
    expect(await m.driver.waitForText('Sent', {timeoutMs: 15_000})).toBe(true); // the confirmed read flips to the settled terminal
    expect(await absent(m, 'sol-send-unknown-title')).toBe(true);
    expect(await absent(m, 'btn-sol-send-check')).toBe(true);
    assertEq(m.driver.readText('sol-send-signature').trim(), sig, 'the SAME signature survives the flip');

    // ── Leg B: the fee-only failure over an ACCEPTED broadcast ─────────────────────────────────
    await m.driver.click('btn-sol-send-done', {timeoutMs: 4000});
    await armMode({failAfterHits: 0}); // replaces the mode; counter resets

    await m.driver.click('btn-pay-send', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-send-address-input', {timeoutMs: 5000});
    await m.driver.type('sol-send-address-input', DEST_ADDR, {timeoutMs: 4000});
    await m.driver.type('sol-send-amount-input', '0.4', {timeoutMs: 4000});
    await m.driver.findByTestID('sol-send-review', {timeoutMs: 4000});
    await lib.waitForEnabled(m, 'btn-sol-send-confirm');
    await m.driver.click('btn-sol-send-confirm', {timeoutMs: 5000});

    // The first confirm poll answers the on-chain InstructionError: sendSol throws over the
    // ACCEPTED broadcast, and the terminal names the fee-only truth.
    expect(await m.driver.waitForText('only the network fee', {timeoutMs: 20_000})).toBe(true);
    // the fee-only note renders over an accepted-then-failed broadcast
    expect(await absent(m, 'sol-send-nothing-sent')).toBe(true); // the network ACCEPTED this transfer
    expect(await absent(m, 'sol-send-unknown-title')).toBe(true); // a definitive failure is not a pending
    expect(m.driver.isPresent('btn-sol-send-confirm')).toBe(true); // the form returned — a NEW send is the user's consent
    // Disarm for teardown: leave the shared stub neutral.
    await armMode({});

    await m.unmount();
  }, 240_000);
});
