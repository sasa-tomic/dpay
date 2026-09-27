/**
 * Flow 93 tap-motion — the jest twin of `e2e/tests/93-tap-motion.mjs` (batch D port): the
 * FUNCTIONAL tap-state motion on both rails, walked through the real event seams. Every phase
 * keeps its pinned textContent while the motion beats mount exactly when they should — itinerary
 * segments per phase, ellipsis on pending, shake-settle on declined/error — and the HONESTY rule:
 * pending shows NO settled mark and NO campaign line anywhere. The dpay stamp ring is gone
 * everywhere (founder 2026-08-24); card awaitingApproval maps STRAIGHT to exchanging (auto-sign:
 * the review key beat is READER-only).
 *
 * Not ported (browser-only): the screenshot beats — pixel capture stays in the e2e visual tier.
 */
import {describe, it, expect} from '@jest/globals';
import {armNfcCard, onboardWallet, openBalances, selectCurrency, waitForWallet, type Mount} from '../harness/lib';
import {clickByAria, has, nfcPhase, nfcPhaseWalk, type NfcEvent} from './h';

const g = globalThis as unknown as Record<string, unknown>;

describe('flow 93 — every NFC phase renders its pinned text + its own motion beat (IC + SOL)', () => {
  it('IC: linking/exchanging/awaitingApproval/settling/success/pending/declined; SOL: parity + no peak', async () => {
    // ============================== IC rail (nfc-status) ======================================
    g.__DPAY_TEST_NFC_STATUS = 'ready';
    const m = await onboardWallet('jest-tap-motion');
    await m.driver.findByTestID('pay-scan', {timeoutMs: 5000});
    const icDispatch = async (event: NfcEvent): Promise<void> => {
      await armNfcCard(m, 'ic');
      (g.__DPAY_TEST_NFC_SESSION as (e: NfcEvent) => void)(event);
    };

    // listening → the breathing ring mounts with the pinned copy (NfcTap takes over ONLY on linking).
    expect(await nfcPhase(m, icDispatch, 'linking', {statusId: 'nfc-status'})).toBe(true);
    expect(has(m, 'tap-progress')).toBe(true);
    expect(has(m, 'tap-progress-seg-1')).toBe(true);
    expect(has(m, 'tap-progress-seg-2')).toBe(false);
    expect(has(m, 'tap-success-stamp')).toBe(false); // HONESTY: no stamp ring exists anywhere

    expect(await nfcPhase(m, icDispatch, 'exchanging')).toBe(true);
    expect(has(m, 'tap-progress-seg-2')).toBe(true);
    expect(has(m, 'tap-progress-seg-3')).toBe(false);

    // awaitingApproval (card) maps STRAIGHT to exchanging — no review park exists on the card side.
    expect(await nfcPhase(m, icDispatch, 'awaitingApproval')).toBe(true);
    expect(has(m, 'tap-progress-seg-2')).toBe(true);
    expect(m.driver.bodyText()).not.toContain('Review payment');

    expect(await nfcPhase(m, icDispatch, 'settling')).toBe(true);
    expect(has(m, 'tap-progress-seg-3')).toBe(true);

    // success → the badge + title carry it; no stamp ring; no peak on an online session.
    expect(await nfcPhase(m, icDispatch, 'success', {text: 'Paid', timeoutMs: 5000})).toBe(true);
    expect(has(m, 'tap-success-stamp')).toBe(false);
    expect(has(m, 'offline-peak')).toBe(false);
    expect(has(m, 'tap-progress')).toBe(false);
    // Close the terminal view to re-arm for the pending walk (the Done escape).
    await clickDone(m);

    // pending → deliberate STILLNESS: ellipsis pulse, NO stamp, NO campaign line.
    await nfcPhase(m, icDispatch, 'linking', {statusId: 'nfc-status', text: null});
    expect(await nfcPhase(m, icDispatch, 'pending')).toBe(true);
    expect(has(m, 'tap-ellipsis')).toBe(true);
    expect(has(m, 'tap-success-stamp')).toBe(false);
    expect(has(m, 'offline-peak')).toBe(false);
    expect(m.driver.bodyText()).not.toContain("Don't need it");

    // declined → restrained shake-settle; still no stamp/campaign.
    await clickDone(m);
    await nfcPhase(m, icDispatch, 'linking', {statusId: 'nfc-status', text: null});
    expect(await nfcPhase(m, icDispatch, 'declined')).toBe(true);
    expect(has(m, 'tap-shake')).toBe(true);
    expect(has(m, 'tap-success-stamp')).toBe(false);
    expect(m.driver.bodyText()).not.toContain("Don't need it");

    // ============================== SOL rail (sol-nfc-status) ==================================
    // Same wallet → Balances → SOL → SOL scan arms SolNfcTap. Dismiss the declined terminal first.
    await clickDone(m);
    await waitForWallet(m, {timeoutMs: 8000});
    await openBalances(m, {timeoutMs: 5000});
    await selectCurrency(m, 'sol', {timeoutMs: 5000});
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 5000});
    const solDispatch = async (event: NfcEvent): Promise<void> => {
      await armNfcCard(m, 'sol');
      (g.__DPAY_TEST_SOL_NFC_SESSION as (e: NfcEvent) => void)(event);
    };

    expect(await nfcPhase(m, solDispatch, 'linking', {statusId: 'sol-nfc-status'})).toBe(true);
    expect(has(m, 'tap-progress-seg-1')).toBe(true);
    expect(await nfcPhase(m, solDispatch, 'awaitingApproval')).toBe(true);
    expect(has(m, 'tap-progress-seg-2')).toBe(true);
    expect(await nfcPhase(m, solDispatch, 'success', {text: 'Paid', timeoutMs: 5000})).toBe(true);
    expect(has(m, 'tap-success-stamp')).toBe(false);
    expect(has(m, 'offline-peak')).toBe(false);

    await m.unmount();
  }, 120_000);
});

/** The terminal view's escape — the button has no testID by design (the e2e ghost-Done idiom). */
async function clickDone(m: Mount): Promise<void> {
  await clickByAria(m, 'Done');
  await m.driver.waitGone('nfc-status', {timeoutMs: 5000}).catch(() => {});
}
