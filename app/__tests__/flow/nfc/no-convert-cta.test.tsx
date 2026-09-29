/**
 * Flow 171 nfc-no-convert-cta — the jest twin of `e2e/tests/171-nfc-no-convert-cta.mjs`
 * (batch D port; V9 INVARIANT 8, the NFC half). The NFC/HCE payment surfaces never grow convert
 * affordances: a convert CTA mid-tap would be exactly the "conversion offer inside a payment flow"
 * the spec forbids. Every NFC sub-surface the harness can drive is walked — IC payer card (idle
 * armed, linking, exchanging, settling, success, the auto-sign disclosure with money moving, the
 * declined and error terminals) and the SOL payer card (idle armed, linking, auto-sign exchanging,
 * the receipt-bound paid phase) — each gets the zero-tolerance census. The honesty control proves
 * the census CAN fail: Accounts with a convert-capable currency selected carries per-currency
 * Convert entries.
 *
 * Not reachable (noted by the e2e twin, still true): the READER-side surface (the merchant
 * checkout terminal, not a wallet surface) and the NFC 'pending' terminal (renders through the
 * same NfcTapView shell walked above).
 */
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {it, expect} from '@jest/globals';
import {armNfcCard, assertEq, onboardWallet, openBalances, selectCurrency} from '../harness/lib';
import {buildSolReq, clickByAria, convertCtaCount, extractSig, nfcPhase, type NfcEvent} from './h';

const g = globalThis as unknown as Record<string, unknown>;
const REQ_RID = 'c'.repeat(32);

hermeticFlow();

hermeticDescribe('flow 171 — no NFC surface ever offers a conversion (INVARIANT 8)', () => {
  it('every walked IC + SOL sub-surface counts ZERO convert affordances; the probe control can fail', async () => {
    g.__DPAY_TEST_NFC_STATUS = 'ready';
    const m = await onboardWallet('jest-nfc-no-convert');
    await m.driver.findByTestID('pay-scan', {timeoutMs: 5000});

    const zeroConvert = (surface: string): void => {
      assertEq(convertCtaCount(m), 0, `NFC surface "${surface}" shows ZERO convert affordances`);
    };
    const dispatch = async (event: NfcEvent): Promise<void> => {
      await armNfcCard(m, 'ic');
      (g.__DPAY_TEST_NFC_SESSION as (e: NfcEvent) => void)(event);
    };

    // --- IC card: idle armed pay surface. -------------------------------------------------------
    await armNfcCard(m, 'ic');
    zeroConvert('IC idle armed pay surface');

    // --- IC card: the pure phase walk. ----------------------------------------------------------
    expect(await nfcPhase(m, dispatch, 'linking', {statusId: 'nfc-status'})).toBe(true);
    zeroConvert('IC linking (Connecting…)');
    expect(await nfcPhase(m, dispatch, 'exchanging')).toBe(true);
    zeroConvert('IC exchanging (Communicating…)');
    expect(await nfcPhase(m, dispatch, 'settling')).toBe(true);
    zeroConvert('IC settling (Confirming…)');
    expect(await nfcPhase(m, dispatch, 'success', {text: 'Paid', timeoutMs: 5000})).toBe(true);
    zeroConvert('IC success terminal (Paid ✓)');
    expect(await clickByAria(m, 'Done')).toBe('Done');
    await m.driver.waitGone('nfc-status', {timeoutMs: 5000});

    // --- IC card: AUTO-SIGN exchanging with the honest asset disclosure (flow-32 shape). --------
    const nowSecs = Math.floor(Date.now() / 1000);
    await dispatch({
      type: 'request', role: 'card',
      toHex: '11'.repeat(32), amount: '50000', nonceHex: 'ab'.repeat(16),
      expiry: nowSecs + 300, currency: 1, toName: 'merchant', memo: 'two coffees',
    });
    expect(await m.driver.waitForText('Communicating', {timeoutMs: 6000})).toBe(true);
    // GROSS (founder rule 2026-09-14): the fee chain resolves async — WAIT for the settled line.
    expect(await m.driver.waitForText('Paying 0.0005001 BTC on Bitcoin', {timeoutMs: 8000})).toBe(true);
    zeroConvert('IC auto-sign exchanging (Paying 0.0005001 BTC on Bitcoin)');
    await dispatch({type: 'phase', role: 'card', phase: 'declined'});
    expect(await m.driver.waitForText('Declined', {timeoutMs: 5000})).toBe(true);
    zeroConvert('IC declined terminal');
    expect(await clickByAria(m, 'Done')).toBe('Done');
    await m.driver.waitGone('nfc-status', {timeoutMs: 5000});

    // --- IC card: the transport-error terminal. -------------------------------------------------
    await nfcPhase(m, dispatch, 'linking', {statusId: 'nfc-status', text: null});
    await dispatch({type: 'error', role: 'card', reason: 'Lost the radio link'});
    expect(await m.driver.waitForText('Tap failed', {timeoutMs: 5000})).toBe(true);
    zeroConvert('IC error terminal (Tap failed)');
    expect(await clickByAria(m, 'Done')).toBe('Done');
    await m.driver.waitGone('nfc-status', {timeoutMs: 5000});

    // --- PROBE CONTROL: the census CAN fail — Accounts carries per-currency Convert entries. ----
    await openBalances(m);
    await selectCurrency(m, 'icp');
    await openBalances(m);
    const control = m.tree.root.findAll((n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('btn-accounts-convert-')).length;
    expect(control).toBeGreaterThanOrEqual(1);

    // --- SOL card: idle armed SolPayMode, then the tap phases + the receipt-bound paid phase. ---
    await openBalances(m);
    await selectCurrency(m, 'sol');
    await m.driver.findByTestID('btn-sol-start-scan', {timeoutMs: 5000});
    const dispatchSol = async (event: NfcEvent): Promise<void> => {
      await armNfcCard(m, 'sol');
      (g.__DPAY_TEST_SOL_NFC_SESSION as (e: NfcEvent) => void)(event);
    };

    zeroConvert('SOL idle armed pay surface');
    expect(await nfcPhase(m, dispatchSol, 'linking', {statusId: 'sol-nfc-status'})).toBe(true);
    zeroConvert('SOL linking (Connecting…)');
    await dispatchSol({type: 'request', role: 'card', solreqUri: buildSolReq({rid: REQ_RID})});
    expect(await m.driver.waitForText('Communicating', {timeoutMs: 6000})).toBe(true);
    expect(m.driver.bodyText()).toContain('Paying 0.001005 SOL');
    zeroConvert('SOL auto-sign exchanging (Paying 0.001005 SOL)');

    const solpayUri = g.__DPAY_SOL_NFC_LAST as string | undefined;
    expect(typeof solpayUri).toBe('string');
    expect(solpayUri!.startsWith('solpay:v2?')).toBe(true);
    await dispatchSol({type: 'receipt', role: 'card', status: 0, rid: REQ_RID, sig: extractSig(solpayUri!)});
    expect(await m.driver.waitForText('awaiting', {timeoutMs: 5000})).toBe(true);
    zeroConvert("SOL paid phase (Sent · awaiting the merchant's confirmation)");

    await m.unmount();
  }, 150_000);
});
