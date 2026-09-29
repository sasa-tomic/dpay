/**
 * Flow 11 nfc — the jest twin of `e2e/tests/11-nfc.mjs` (M1 port: proves the payer NFC session
 * seam `__DPAY_TEST_NFC_SESSION` driving the app's REAL NfcTap state machine over the shared
 * RCTDeviceEventEmitter bus).
 *
 * With the radio forced ready, the Pay screen arms the HCE card; the seam dispatches the same
 * DpayNfcEvent payloads the native module emits (role='card' = payer). Asserts: the waiting
 * surface, linking → "Connecting…", a `request` AUTO-SIGNS (one-press rule — the wire exists with
 * no Approve click; the signed envelope is stashed by the shim on __DPAY_TEST_NFC_APPROVED_WIRE),
 * and an error event surfaces the honest "Tap failed" terminal.
 *
 * Not ported (browser-only): the screenshots; the Done-dismiss + re-arm phase walk IS ported here
 * (batch D's full-parity leg — clickByAria + the pure-phase walk over the re-armed session).
 */
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {it, expect} from '@jest/globals';
import {armNfcCard, assert, onboardWallet} from '../harness/lib';
import type {Mount} from '../harness/lib';
import {clickByAria, nfcPhaseWalk} from './h';

const g = globalThis as unknown as Record<string, unknown>;

type NfcEvent = Record<string, unknown>;
const dispatch = async (m: Mount, event: NfcEvent): Promise<void> => {
  await armNfcCard(m, 'ic');
  (g.__DPAY_TEST_NFC_SESSION as (e: NfcEvent) => void)(event);
};
/** The walker-facing closure: the mount is closed over, the walker passes only the event. */
const dispatchFrom = (m: Mount) => async (event: NfcEvent): Promise<void> => dispatch(m, event);

hermeticFlow();

hermeticDescribe('flow 11 — NFC tap phases through the real event bus', () => {
  it('linking → request AUTO-SIGNS → exchanging; an error surfaces the honest terminal', async () => {
    // The device NFC status flips to 'ready' BEFORE the wallet mounts so Pay arms the card.
    g.__DPAY_TEST_NFC_STATUS = 'ready';
    const m = await onboardWallet('jest-nfc');

    // Waiting-for-tap: the pay scan surface is live (NfcTap renders nothing while listening —
    // the QR scanner stays mounted alongside it, by design).
    await m.driver.findByTestID('pay-scan', {timeoutMs: 5000});

    // linking → "Connecting…" (NfcTap takes over the screen; nfc-status mounts).
    await dispatch(m, {type: 'phase', phase: 'linking', role: 'card'});
    expect(await m.driver.waitForText('Connecting', {timeoutMs: 6000})).toBe(true);

    // request → AUTO-SIGN (one-press): DEMO currency 0 is payable, so the sign fires immediately
    // and the tap goes straight to exchanging — the amount rides the status line read-only.
    const nowSecs = Math.floor(Date.now() / 1000);
    await dispatch(m, {
      type: 'request', role: 'card',
      toHex: '11'.repeat(32), amount: '5000', nonceHex: 'cd'.repeat(16),
      expiry: nowSecs + 240, currency: 0,
    });
    expect(await m.driver.waitForText('Communicating', {timeoutMs: 6000})).toBe(true);
    const body = m.driver.bodyText();
    expect(body).toContain('Hold the phones together to send');
    expect(body).toContain('Paying ∂50.00');
    // One-press honesty: NO review affordances exist on this path — the sign already happened.
    expect(m.driver.isPresent('nfc-pay-amount')).toBe(false);
    expect(m.driver.isPresent('btn-nfc-approve')).toBe(false);
    expect(m.driver.isPresent('btn-nfc-decline')).toBe(false);
    expect(m.driver.isPresent('nfc-countdown')).toBe(false);
    const wire = g.__DPAY_TEST_NFC_APPROVED_WIRE as {envelopeHex?: string} | undefined;
    assert(wire != null && typeof wire.envelopeHex === 'string' && wire.envelopeHex.length > 128,
      'the signed wire should exist right after the request (auto-sign) — no Approve click happened');

    // Error terminal: the honest failure state, no fake success.
    await dispatch(m, {type: 'error', role: 'card', reason: 'jest: end the auto-sign session'});
    expect(await m.driver.waitForText('Tap failed', {timeoutMs: 5000})).toBe(true);

    // Done re-arms for the pure-phase walk (batch D's full-parity leg: the terminal escape).
    expect(await clickByAria(m, 'Done')).toBe('Done');
    await m.driver.waitGone('nfc-status', {timeoutMs: 5000});

    // PURE-PHASE WALK (post-terminal re-arm, no request involved): linking → exchanging →
    // settling — the envelope has left the NFC transport; ledger polling now owns the outcome.
    await nfcPhaseWalk(m, dispatchFrom(m), ['linking', 'exchanging', 'settling'], {statusId: 'nfc-status'});

    await m.unmount();
  }, 90_000);
});
