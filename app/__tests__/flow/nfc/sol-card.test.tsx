/**
 * Flows 47 sol-nfc, 66 sol-nfc-error, 139 sol-nfc-mismatch-receipt — the jest twins of
 * `e2e/tests/47-sol-nfc.mjs`, `66-sol-nfc-error.mjs`, `139-sol-nfc-mismatch-receipt.mjs`
 * (batch D port; the SOL seam is `__DPAY_TEST_SOL_NFC_SESSION`, the auto-sign + receipt-binding
 * proofs ride the REAL SolNfcTap state machine).
 *
 * 47: NETTED request (wire 0.000995 for a 0.001 price — the customer pays exactly the price, the
 *     payee nets the fee) → request AUTO-SIGNS on arrival → "Paying 0.001 SOL" → receipt
 *     (status 0, rid+sig exact match) → the honest pending "Sent · awaiting".
 * 66: expired solreq auto-declines AT SIGN ("This payment request expired", no solpay URI);
 *     transport error → "Tap failed"; late error after settling is IGNORED (no false failure);
 *     the merchant reader sees the same decline.
 * 139: receipt code 3 (settle-verify MISMATCH) → the payer lands on honest pending, NEVER a
 *     decline, and never bounced back to the scan surface.
 *
 * The file arms the SOL module env by IMPORT SIDE EFFECT (`../settings/solStub` sets
 * `__DPAY_TEST_SOLANA_RPC_URL = 'stub'` in its module body): constants captures the override at
 * module load, and the hermetic wire (hermeticDescribe's beforeAll) loads constants BEFORE any
 * test body runs — so the lazy `solEnv()`-first-idiom alone captures the offline `''` default and
 * every SOL surface renders fail-closed ("Solana is offline"). The RPC stub is per-test state,
 * cleared in afterEach.
 */
import '../settings/solStub';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {it, expect, afterEach, beforeEach} from '@jest/globals';
import {buildSolReq, clickByAria, extractSig, makeSolStub, nfcPhase, nfcPhaseWalk, setSolStub, solEnv, type NfcEvent} from './h';
import type {Mount} from '../harness/lib';

const REQ_RID = 'c'.repeat(32);
const g = globalThis as unknown as Record<string, unknown>;

/** The lazy lib handle — solEnv() set the RPC override first; requiring lib now loads the app. */
let libRef: ReturnType<typeof solEnv> | null = null;
const lib = (): ReturnType<typeof solEnv> => {
  libRef ??= solEnv();
  return libRef!;
};

/** The flow-steps.mjs dispatch-closure shape: the mount is closed over per test, the walker passes
 *  only the event. */
const makeDispatch = (m: Mount) => async (event: NfcEvent): Promise<void> => {
  await lib().armNfcCard(m, 'sol');
  (g.__DPAY_TEST_SOL_NFC_SESSION as (e: NfcEvent) => void)(event);
};

// The SOL RPC stub is per-test state (this file's own fixture); the NFC stashes are the
// harness's now (the lifecycle + the hermetic hook reset them per test).
afterEach(() => {
  setSolStub(null);
});

// The stub answers the balance polls too — with the override 'stub' but no stub object, fetch
// would try to parse the literal 'stub' URL. The offline cases simply never touch the rest.
const stubHandles = {sig: null, txDetail: null, getTxReads: 0};
beforeEach(() => { setSolStub(makeSolStub(stubHandles)); });

hermeticFlow();

hermeticDescribe('flow 47 — SOL v2 NFC tap: netted request auto-signs, receipt binds, honest pending', () => {
  it('arm → request auto-sign → "Paying 0.001 SOL" → receipt (rid+sig) → "Sent · awaiting"', async () => {
    g.__DPAY_TEST_NFC_STATUS = 'ready';
    const {onboardWallet, openBalances, selectCurrency, waitForWallet} = lib();
    const m = await onboardWallet('jest-sol-nfc');
    const dispatch = makeDispatch(m);

    await waitForWallet(m, {timeoutMs: 8000});
    await openBalances(m, {timeoutMs: 5000});
    await selectCurrency(m, 'sol', {timeoutMs: 5000});
    // The accounts list is inline on Home — the flow owns the return to Pay.
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 5000});

    // linking → "Connecting…".
    await nfcPhaseWalk(m, dispatch, ['linking'], {statusId: 'sol-nfc-status', text: null});

    // request → AUTO-SIGN on arrival (the "Pay Now" gate that armed the card was the press).
    // The request carries the NETTED wire (995000 = the 0.001 price − the 5000-lamport payee fee).
    await dispatch({type: 'request', role: 'card', solreqUri: buildSolReq({rid: REQ_RID, amt: '995000'})});
    expect(await m.driver.waitForText('Communicating', {timeoutMs: 6000})).toBe(true);
    const body = m.driver.bodyText();
    expect(body).toContain('Hold the phones together to send');
    // The read-only total rides the status line: netted wire 0.000995 + 5000 fee = the price.
    expect(body).toContain('Paying 0.001 SOL');
    expect(m.driver.isPresent('btn-nfc-approve')).toBe(false);

    // The arrival sign produced a REAL solpay:v2 URI.
    const solpayUri = g.__DPAY_SOL_NFC_LAST as string | undefined;
    expect(typeof solpayUri).toBe('string');
    expect(solpayUri!.startsWith('solpay:v2?')).toBe(true);

    // receipt (status 0 SETTLED, rid+sig exact match) → honest pending (NfcTapView's "Paid ✓"
    // never renders — SolPayMode switches to the paid phase in the same commit).
    await dispatch({type: 'receipt', role: 'card', status: 0, rid: REQ_RID, sig: extractSig(solpayUri!)});
    expect(await m.driver.waitForText('awaiting', {timeoutMs: 5000})).toBe(true);
    expect(m.driver.bodyText()).toMatch(/Sent/);

    await m.unmount();
  }, 90_000);
});

hermeticDescribe('flow 66 — SOL v2 NFC failure modes', () => {
  it('expired auto-declines at sign; transport error → Tap failed; late error after settling ignored; reader sees the decline', async () => {
    g.__DPAY_TEST_NFC_STATUS = 'ready';
    const {onboardWallet, openBalances, selectCurrency, waitForWallet} = lib();
    const m = await onboardWallet('jest-sol-nfc-err');
    const dispatch = makeDispatch(m);

    await waitForWallet(m, {timeoutMs: 8000});
    await openBalances(m, {timeoutMs: 5000});
    await selectCurrency(m, 'sol', {timeoutMs: 5000});
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 5000});

    // --- 1. EXPIRED REQUEST → AUTO-DECLINE AT SIGN (the expiry gate is authoritative there). ---
    await nfcPhaseWalk(m, dispatch, ['linking'], {statusId: 'sol-nfc-status', text: null});
    await dispatch({type: 'request', role: 'card', solreqUri: buildSolReq({expired: true, rid: 'd'.repeat(32)})});
    expect(await m.driver.waitForText('Declined', {timeoutMs: 5000})).toBe(true);
    const expiredBody = m.driver.bodyText();
    expect(expiredBody).not.toMatch(/\bPaid\b/);
    expect(expiredBody).toContain('This payment request expired');
    expect(g.__DPAY_SOL_NFC_LAST).toBeUndefined(); // nothing signed
    expect(await clickByAria(m, 'Done')).toBe('Done');
    await m.driver.waitGone('sol-nfc-status', {timeoutMs: 5000});

    // --- 2. TRANSPORT ERROR mid-tap: honest "Tap failed", no fake Paid. ------------------------
    await nfcPhaseWalk(m, dispatch, ['linking'], {statusId: 'sol-nfc-status', text: null});
    await dispatch({type: 'error', role: 'card', reason: 'Lost the radio link'});
    expect(await m.driver.waitForText('Tap failed', {timeoutMs: 5000})).toBe(true);
    expect(m.driver.bodyText()).not.toMatch(/\bPaid\b/);
    expect(m.driver.bodyText()).toContain('Lost the radio link');
    expect(await clickByAria(m, 'Done')).toBe('Done');
    await m.driver.waitGone('sol-nfc-status', {timeoutMs: 5000});

    // --- 3. LATE ERROR AFTER SETTLING IGNORED (no false failure over a decided outcome). -------
    await nfcPhaseWalk(m, dispatch, ['linking', 'exchanging'], {statusId: 'sol-nfc-status', text: null});
    expect(await nfcPhase(m, dispatch, 'settling')).toBe(true); // committed=true; "Confirming…"
    await dispatch({type: 'error', role: 'card', reason: 'should be ignored'});
    // Give React its frames: if the bug existed (error overwrites the decided phase), "Confirming"
    // would be gone after the flush.
    await m.driver.settleFrames(10);
    const lateErrBody = m.driver.bodyText();
    expect(lateErrBody).toContain('Confirming');
    expect(lateErrBody).not.toContain('should be ignored');
    expect(lateErrBody).not.toMatch(/Tap failed/);
    // Cancel closes the mid-flow session (the same press the e2e's label-assert makes).
    expect(await clickByAria(m, 'Cancel')).toBe('Cancel');

    // --- 4. MERCHANT (READER) DECLINE: the merchant sees the same decline. ---------------------
    // Case 4's makeRequest is ONLINE: a minimal stub answers the request build.
    setSolStub(makeOnlineStub());
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-req-amount-input', {timeoutMs: 5000});
    await m.driver.type('sol-req-amount-input', '0.025', {timeoutMs: 5000});
    await m.driver.click('btn-sol-req-make', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-req-qr', {timeoutMs: 8000}); // reader is now mounted
    await nfcPhaseWalk(m, dispatch, ['linking'], {role: 'reader', statusId: 'sol-nfc-status', text: null});
    expect(await nfcPhaseWalk(m, dispatch, ['declined'], {role: 'reader', text: 'Declined', timeoutMs: 5000})).toBeTruthy();
    const readerBody = m.driver.bodyText();
    expect(readerBody).not.toMatch(/\bPaid\b/);
    expect(readerBody).not.toMatch(/Received/);

    await m.unmount();
  }, 120_000);
});

/** Minimal online stub for the reader-decline leg's ONLINE makeRequest (genesis + blockhash). */
function makeOnlineStub() {
  return {
    getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN', lastValidBlockHeight: 300000000}}),
    getBalance: () => ({value: 0}),
  };
}

hermeticDescribe('flow 139 — SOL NFC receipt code 3 (settle-verify mismatch) is NEVER a decline', () => {
  it('receipt(status=3, rid+sig match) → the honest pending, no rejection, no scan bounce', async () => {
    g.__DPAY_TEST_NFC_STATUS = 'ready';
    const {onboardWallet, openBalances, selectCurrency, waitForWallet} = lib();
    const m = await onboardWallet('jest-sol-mismatch');
    const dispatch = makeDispatch(m);

    await waitForWallet(m, {timeoutMs: 8000});
    await openBalances(m, {timeoutMs: 5000});
    await selectCurrency(m, 'sol', {timeoutMs: 5000});
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 5000});

    await nfcPhaseWalk(m, dispatch, ['linking'], {statusId: 'sol-nfc-status'});
    await dispatch({type: 'request', role: 'card', solreqUri: buildSolReq({rid: REQ_RID})});
    expect(await m.driver.waitForText('Communicating', {timeoutMs: 6000})).toBe(true);

    const solpayUri = g.__DPAY_SOL_NFC_LAST as string | undefined;
    expect(typeof solpayUri).toBe('string');
    expect(solpayUri!.startsWith('solpay:v2?')).toBe(true);

    // receipt code 3 (MISMATCH) with an EXACT rid+sig match → decideSolPayerReceiptV2 → pending.
    await dispatch({type: 'receipt', role: 'card', status: 3, rid: REQ_RID, sig: extractSig(solpayUri!)});
    expect(await m.driver.waitForText('awaiting', {timeoutMs: 5000})).toBe(true);
    const body = m.driver.bodyText();
    expect(body).toMatch(/Sent/);
    expect(body).not.toMatch(/rejected/i);
    expect(m.driver.isPresent('sol-pay-scan')).toBe(false); // never bounced back to scan

    await m.unmount();
  }, 90_000);
});
