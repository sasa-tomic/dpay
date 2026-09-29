/**
 * Flows 32 nfc-disclosure + 99 nfc-native-assets — the jest twins of `e2e/tests/32-nfc-disclosure.mjs`
 * and `e2e/tests/99-nfc-native-assets.mjs` (batch D port; the flow-11 session-seam pattern from M1).
 *
 * The one-press auto-sign rule (founder 2026-08-24) means a `request` event SIGNS on arrival, so the
 * exchanging status must disclose the honest asset + fee-inclusive gross WHILE the money moves:
 *   32: ckBTC — "Paying 0.0005001 BTC on Bitcoin" (50_000 sats + the pinned 10-sat ledger fee),
 *       never the DEMO ∂ formatter, no review affordances, wire stashed on arrival.
 *   99: VCHF + ICP — "Paying 1.00010001 VCHF/ICP on Internet Computer" (8-decimal exactness, total
 *       debit = wire + live fee), read-only card surface, real envelope per leg, Done escape between
 *       legs (the aria-label flip the terminal view offers).
 * The radio hop stays a physical-device gate; only the JS event plumbing is faked (the seam).
 */
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {it, expect} from '@jest/globals';
import {armNfcCard, assert, onboardWallet, type Mount} from '../harness/lib';
import {clickByAria, type NfcEvent} from './h';

const g = globalThis as unknown as Record<string, unknown>;

const dispatchFor = async (m: Mount, event: NfcEvent): Promise<void> => {
  await armNfcCard(m, 'ic');
  (g.__DPAY_TEST_NFC_SESSION as (e: NfcEvent) => void)(event);
};

hermeticFlow();

hermeticDescribe('flow 32 — NFC auto-sign exchanging status discloses the honest ckBTC gross', () => {
  it('a ckBTC request signs on arrival and shows "Paying 0.0005001 BTC on Bitcoin"', async () => {
    g.__DPAY_TEST_NFC_STATUS = 'ready';
    const m = await onboardWallet('jest-nfc-disc');
    await m.driver.findByTestID('pay-scan', {timeoutMs: 5000});

    const nowSecs = Math.floor(Date.now() / 1000);
    await dispatchFor(m, {
      type: 'request', role: 'card',
      toHex: '11'.repeat(32), amount: '50000', nonceHex: 'ab'.repeat(16),
      expiry: nowSecs + 300, currency: 1, toName: 'merchant', memo: 'two coffees',
    });

    await m.driver.findByTestID('nfc-status', {timeoutMs: 5000});
    expect(await m.driver.waitForText('Communicating', {timeoutMs: 6000})).toBe(true);
    // WAITED FOR: the fee-inclusive gross resolves through the live fee chain (the wire shows
    // alone until it lands).
    expect(await m.driver.waitForText('Paying 0.0005001 BTC on Bitcoin', {timeoutMs: 8000})).toBe(true);
    const body = m.driver.bodyText();
    expect(body).toContain('BTC');
    expect(body).toContain('0.0005');
    expect(body).not.toMatch(/∂0\.00050000/); // the blind-tap bug: the DEMO formatter on ckBTC
    expect(body).toContain('Hold the phones together to send');
    // One-press honesty: no review affordances exist — the sign already happened.
    expect(m.driver.isPresent('nfc-pay-amount')).toBe(false);
    expect(m.driver.isPresent('btn-nfc-approve')).toBe(false);
    const wire = g.__DPAY_TEST_NFC_APPROVED_WIRE as {envelopeHex?: string} | undefined;
    assert(wire != null && typeof wire.envelopeHex === 'string' && wire.envelopeHex.length > 128,
      'the signed wire should exist right after arrival (auto-sign) — no Approve click ever happened');

    // Terminal cleanup so the session does not hang mid-tap.
    await dispatchFor(m, {type: 'phase', role: 'card', phase: 'declined'});
    expect(await m.driver.waitForText('Declined', {timeoutMs: 5000})).toBe(true);

    await m.unmount();
  }, 90_000);
});

hermeticDescribe('flow 99 — NFC disclosure for the native assets (VCHF + ICP legs in one session)', () => {
  it('each leg discloses the fee-inclusive total debit and stashes a real envelope; Done escapes', async () => {
    g.__DPAY_TEST_NFC_STATUS = 'ready';
    const m = await onboardWallet('jest-nfc-native');
    await m.driver.findByTestID('pay-scan', {timeoutMs: 5000});

    for (const leg of [{currency: 7, tag: 'VCHF'}, {currency: 8, tag: 'ICP'}]) {
      const nowSecs = Math.floor(Date.now() / 1000);
      await dispatchFor(m, {
        type: 'request', role: 'card',
        toHex: '11'.repeat(32), amount: '100000001', nonceHex: 'ab'.repeat(16),
        expiry: nowSecs + 300, currency: leg.currency, toName: 'merchant', memo: 'exact change',
      });

      await m.driver.findByTestID('nfc-status', {timeoutMs: 5000});
      expect(await m.driver.waitForText('Communicating', {timeoutMs: 6000})).toBe(true);
      // WAITED FOR, not sampled: the total-debit disclosure waits on the live icrc1_fee query.
      expect(await m.driver.waitForText(`Paying 1.00010001 ${leg.tag} on Internet Computer`, {timeoutMs: 8000})).toBe(true);
      const body = m.driver.bodyText();
      expect(body).toContain('Hold the phones together to send');
      expect(body).not.toMatch(new RegExp(`∂1\\.00010001`)); // no DEMO formatter leak
      expect(m.driver.isPresent('nfc-pay-amount')).toBe(false); // read-only disclosure
      expect(m.driver.isPresent('btn-nfc-approve')).toBe(false);

      const wire = g.__DPAY_TEST_NFC_APPROVED_WIRE as {envelopeHex?: string} | undefined;
      assert(wire != null && typeof wire.envelopeHex === 'string' && wire.envelopeHex.length > 128,
        `${leg.tag}: approved wire stashed (signed envelope)`);

      // Terminate the leg, then escape via the terminal view's Done so the card re-arms
      // (armCard resets the wire stash — the next leg must produce its OWN envelope).
      await dispatchFor(m, {type: 'phase', role: 'card', phase: 'declined'});
      expect(await clickByAria(m, 'Done')).toBe('Done');
      await m.driver.waitGone('nfc-status', {timeoutMs: 5000});
    }

    await m.unmount();
  }, 120_000);
});
