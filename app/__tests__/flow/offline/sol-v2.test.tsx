/**
 * The SOL v2 offline/merchant family — the jest twins of `e2e/tests/46-sol-offline-handoff.mjs`,
 * `51-sol-merchant-broadcast.mjs`, `53-sol-merchant-error.mjs`, `67-sol-no-setup.mjs`,
 * `74-sol-usdc-payment.mjs`, `138-sol-settle-mismatch.mjs` (batch D port).
 *
 * 46: scan solreq:v2 → AUTO-SIGN (no setup, no nonce — v2) → solpay:v2 QR (short-payee line) →
 *     honest pending ("Sent · awaiting"), never "Paid ✓".
 * 51: the FULL merchant cycle — solreq (online stub) quotes the NETTED wire (0.025 typed →
 *     amt 24995000), the payer's NFC auto-sign produces a REAL signed solpay, the merchant scans
 *     it → strict verify + broadcast + settle-gate → "Received" + signature.
 * 53: the same cycle against a REJECTING stub — friendly rejection copy, never raw RPC, no false
 *     "Received".
 * 67: v2 no-setup (SolPayMode mounts straight in scan) + the expired-request decline at the
 *     freshness gate (friendly "expired", no solpay QR).
 * 74: the USDC twin of 51 — the ONLY path exercising signSplPayment (TransferChecked) end-to-end.
 * 138: the settle-gate's three verdicts — mismatching confirmed body → honest doubt + reconcile
 *     card; unreadable body → stays "Broadcasting…" until verified; on-chain error → rejected.
 *
 * The file enables the SOL module env via solEnv() (the RPC override is captured at constants
 * module load, so lib must be required lazily AFTER it is set). The RPC stub is per-test state.
 */
import {describe, it, expect, afterEach, beforeEach} from '@jest/globals';
import {
  buildSolReq, clickByAria, extractSig, MERCHANT_ADDR, makeSolStub, nfcPhaseWalk, setSolStub,
  solEnv, solTxDetailFromSolpay, type NfcEvent,
} from '../nfc/h';
import type {Mount} from '../../harness/lib';

const g = globalThis as unknown as Record<string, unknown>;

let libRef: ReturnType<typeof solEnv> | null = null;
const lib = (): ReturnType<typeof solEnv> => {
  libRef ??= solEnv();
  return libRef!;
};

/** Mutable handles the file-level stub echoes back (sig, settle-gate fixture, read counter). */
const handles = {sig: null as string | null, txDetail: null as Record<string, unknown> | null, getTxReads: 0};

beforeEach(() => {
  handles.sig = null;
  handles.txDetail = null;
  handles.getTxReads = 0;
  setSolStub(makeSolStub(handles));
});
afterEach(() => {
  setSolStub(null);
  delete g.__DPAY_SOL_NFC_LAST;
  delete g.__DPAY_SOL_REQ_LAST;
  g.__DPAY_TEST_NFC_APPROVED_WIRE = undefined;
  g.__DPAY_TEST_NFC_READER_REQUEST = undefined;
});

/** NFC-ready onboarding + SOL selected, ending on the SOL pay scanner. */
async function onboardSolPayer(name: string): Promise<Mount> {
  g.__DPAY_TEST_NFC_STATUS = 'ready';
  const {onboardWallet, openBalances, selectCurrency, waitForWallet} = lib();
  const m = await onboardWallet(name);
  await waitForWallet(m, {timeoutMs: 8000});
  await openBalances(m, {timeoutMs: 5000});
  await selectCurrency(m, 'sol', {timeoutMs: 5000});
  // The accounts list is inline on Home — the flow owns the return to Pay.
  await m.driver.click('tab-pay', {timeoutMs: 5000});
  await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 5000});
  return m;
}

/** The dispatch-closure shape the phase walker passes only the event through. */
const makeDispatch = (m: Mount) => async (event: NfcEvent): Promise<void> => {
  await lib().armNfcCard(m, 'sol');
  (g.__DPAY_TEST_SOL_NFC_SESSION as (e: NfcEvent) => void)(event);
};

/** Poll a seam value until non-null (the e2e bounded-sampling loops). */
async function untilSeam<T>(read: () => T | null, what: string, tries = 100): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = read();
    if (v != null) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${what} never happened within ${tries * 50}ms`);
}

/** Flow 51's merchant cycle up to the signed solpay: create a request, auto-sign it via the NFC
 *  card seam, stash sig + settle-gate fixture (unless seedDetail=false), dismiss the overlay,
 *  open the merchant scanner, scan the signed solpay. */
async function merchantCycle(m: Mount, amount: string, splice: ((d: Record<string, any>) => void) | null = null, seedDetail = true): Promise<{solpayUri: string; sig: string}> {
  // Clear BOTH cycle stashes up front: the reader re-arms on btn-sol-req-make and the card
  // re-signs on request arrival — a stash from the previous leg would pass the shape check while
  // failing the merchant's strict verify cross-leg (same-latency trap as the e2e page reload).
  delete g.__DPAY_SOL_REQ_LAST;
  delete g.__DPAY_SOL_NFC_LAST;
  await m.driver.click('tab-receive', {timeoutMs: 5000});
  await m.driver.findByTestID('sol-req-amount-input', {timeoutMs: 5000});
  await m.driver.type('sol-req-amount-input', amount, {timeoutMs: 5000});
  await m.driver.click('btn-sol-req-make', {timeoutMs: 5000});
  await m.driver.findByTestID('sol-req-qr', {timeoutMs: 8000});

  // The QR is the payment LINK (founder 2026-09-12); the machine code is read off the armed
  // reader seam — what the card will actually receive.
  const solreqUri = await untilSeam(() => (g.__DPAY_SOL_REQ_LAST as string | undefined) ?? null, 'the reader arming with the solreq:v2 machine code');
  expect(solreqUri.startsWith('solreq:v2?')).toBe(true);

  await m.driver.click('tab-pay', {timeoutMs: 5000});
  await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 5000});
  const dispatch = makeDispatch(m);
  await nfcPhaseWalk(m, dispatch, ['linking'], {statusId: 'sol-nfc-status', text: null});
  await dispatch({type: 'request', role: 'card', solreqUri});
  expect(await m.driver.waitForText('Communicating', {timeoutMs: 6000})).toBe(true);

  const solpayUri = await untilSeam(() => (g.__DPAY_SOL_NFC_LAST as string | undefined) ?? null, 'the arrival auto-sign producing a solpay:v2 URI');
  expect(solpayUri.startsWith('solpay:v2?')).toBe(true);
  const sig = extractSig(solpayUri);
  handles.sig = sig;
  if (seedDetail) {
    const detail = solTxDetailFromSolpay(solpayUri);
    if (splice) splice(detail);
    handles.txDetail = detail;
  }

  // Dismiss the NFC overlay (Done on a terminal phase, Cancel mid-flow).
  const hit = await clickByAria(m, 'Done');
  if (hit !== 'Done') await clickByAria(m, 'Cancel');
  await m.driver.waitGone('sol-nfc-status', {timeoutMs: 5000});

  // Back to Receive → open the scanner → scan the signed solpay.
  await m.driver.click('tab-receive', {timeoutMs: 5000});
  await m.driver.findByTestID('sol-req-qr', {timeoutMs: 5000});
  await clickByAria(m, "Scan the payer's signed code", []);
  expect(await m.driver.waitForText("Scan the payer's signed code", {timeoutMs: 5000})).toBe(true);
  // The camera seam arms ASYNC after the scanner mounts — wait for the listener, then inject.
  await lib().armPayScan(m);
  (g.__DPAY_TEST_SCAN as (v: string) => void)(solpayUri);
  return {solpayUri, sig};
}

/** The flow-51 exit: back to a clean request form (the "New request" reset). */
async function newRequest(m: Mount): Promise<void> {
  await clickByAria(m, 'New request', []);
  await m.driver.findByTestID('sol-req-amount-input', {timeoutMs: 5000});
}

describe('flow 46 — SOL v2 offline hand-off: scan → offline sign → honest pending', () => {
  it('auto-signs against the request blockhash, shows the solpay QR with the short payee, never Paid ✓', async () => {
    const m = await onboardSolPayer('jest-sol-pay');

    // Scan the merchant's solreq:v2 (fresh blockhash embedded; the merchant fetched it online).
    const solreqUri = buildSolReq({rid: 'a'.repeat(32)});
    await lib().armPayScan(m);
    (g.__DPAY_TEST_SCAN as (v: string) => void)(solreqUri);

    // AUTO-SIGN: the scan itself signs offline (pure, no RPC) → the solpay QR surface.
    await m.driver.findByTestID('sol-pay-qr', {timeoutMs: 8000});
    const qrBody = m.driver.bodyText();
    expect(qrBody).toMatch(/0\.001005 SOL/);
    // U-F5: the dim payee line carries the short base58 destination under the name.
    expect(m.driver.readText('sol-pay-payee')).toBe(`${MERCHANT_ADDR.slice(0, 8)}…`);

    // The signed solpay:v2 QR is captured (the QR shim stashes the exact value).
    const solpayUri = g.__DPAY_QR_LAST as string;
    expect(typeof solpayUri).toBe('string');
    expect(solpayUri.startsWith('solpay:v2?')).toBe(true);

    // "Handed to merchant" → the HONEST pending state (NOT "Paid ✓").
    await m.driver.click('btn-sol-pay-handed', {timeoutMs: 5000});
    expect(m.driver.readText('sol-pay-status')).toMatch(/Sent/);
    expect(m.driver.bodyText()).toMatch(/awaiting/);

    await m.unmount();
  }, 90_000);
});

describe('flow 51 — SOL v2 merchant broadcast (the full cycle through SolReceiveMode)', () => {
  it('netted solreq → real signed solpay → strict verify + broadcast + settle gate → Received + sig', async () => {
    const m = await onboardSolPayer('jest-sol-merchant');

    // 1. Receive tab → create the solreq QR (ONLINE via stub).
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-req-amount-input', {timeoutMs: 5000});
    await m.driver.type('sol-req-amount-input', '0.025', {timeoutMs: 5000});
    await m.driver.click('btn-sol-req-make', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-req-qr', {timeoutMs: 8000});

    // 2. The solreq carries the NETTED wire: typed 0.025 − the 5000-lamport payee fee = 24995000.
    const solreqUri = await untilSeam(() => (g.__DPAY_SOL_REQ_LAST as string | undefined) ?? null, 'the reader arming with the solreq:v2 machine code');
    const solreq = JSON.parse(Buffer.from(solreqUri.split('solreq:v2?')[1], 'base64url').toString());
    expect(solreq.amt).toBe('24995000');
    const reqBody = m.driver.bodyText();
    expect(reqBody).toContain('0.025 SOL');
    expect(reqBody).toContain('you receive 0.024995 SOL');

    // 3+4. Pay tab → NFC request auto-signs a REAL solpay:v2; stash sig + settle-gate fixture.
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 5000});
    const dispatch = makeDispatch(m);
    await nfcPhaseWalk(m, dispatch, ['linking'], {statusId: 'sol-nfc-status', text: null});
    await dispatch({type: 'request', role: 'card', solreqUri});
    expect(await m.driver.waitForText('Communicating', {timeoutMs: 6000})).toBe(true);
    const solpayUri = await untilSeam(() => (g.__DPAY_SOL_NFC_LAST as string | undefined) ?? null, 'the auto-sign producing a solpay:v2 URI');
    handles.sig = extractSig(solpayUri);
    handles.txDetail = solTxDetailFromSolpay(solpayUri);

    // Dismiss the overlay; back to Receive → scan the signed solpay → broadcast → "Received".
    const hit = await clickByAria(m, 'Done');
    if (hit !== 'Done') await clickByAria(m, 'Cancel');
    await m.driver.waitGone('sol-nfc-status', {timeoutMs: 5000});
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-req-qr', {timeoutMs: 5000});
    await clickByAria(m, "Scan the payer's signed code", []);
    expect(await m.driver.waitForText("Scan the payer's signed code", {timeoutMs: 5000})).toBe(true);
    await lib().armPayScan(m); // the camera seam arms async after the scanner mounts
    (g.__DPAY_TEST_SCAN as (v: string) => void)(solpayUri);

    await m.driver.findByTestID('sol-req-status', {timeoutMs: 15000});
    expect(m.driver.readText('sol-req-status')).toMatch(/Received/);
    expect(m.driver.readText('sol-req-sig').length).toBeGreaterThan(0);

    await m.unmount();
  }, 120_000);
});

describe('flow 53 — a rejecting broadcast surfaces FRIENDLY copy, never raw RPC, never Received', () => {
  it('sendTransaction throws the unfunded-account error → the rejected message on sol-req-err', async () => {
    setSolStub(makeSolStub(handles, {
      sendTransaction: () => { throw new Error('Transaction simulation failed: Attempt to debit an account but found no record of a prior credit'); },
    }));
    const m = await onboardSolPayer('jest-sol-err');
    await merchantCycle(m, '0.025', null, false); // no settle-gate fixture needed: send throws first

    await m.driver.findByTestID('sol-req-err', {timeoutMs: 15000});
    const errTxt = m.driver.readText('sol-req-err');
    expect(errTxt).toMatch(/rejected/i);
    expect(errTxt).not.toMatch(/Transaction simulation failed/);
    expect(errTxt).not.toMatch(/Attempt to debit/);
    expect(m.driver.bodyText()).not.toMatch(/Received/);

    await m.unmount();
  }, 120_000);
});

describe('flow 67 — SOL v2 no-setup + the expired-request decline', () => {
  it('SolPayMode mounts straight in scan; a fresh req signs; an expired req is refused with "expired"', async () => {
    const m = await onboardSolPayer('jest-sol-no-setup'); // mounting in scan IS the no-setup proof

    // Part A: a valid (fresh) solreq auto-signs → solpay:v2 QR.
    await lib().armPayScan(m);
    (g.__DPAY_TEST_SCAN as (v: string) => void)(buildSolReq({rid: 'b'.repeat(32)}));
    await m.driver.findByTestID('sol-pay-qr', {timeoutMs: 8000});
    const solpayUri = g.__DPAY_QR_LAST as string;
    expect(solpayUri.startsWith('solpay:v2?')).toBe(true);

    // Reset to scan (discard the signed payment), then Part B: the expired req.
    await m.driver.click('btn-sol-pay-discard', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 5000});

    await lib().armPayScan(m);
    (g.__DPAY_TEST_SCAN as (v: string) => void)(buildSolReq({expired: true, rid: 'b'.repeat(32)}));
    await m.driver.findByTestID('sol-pay-err', {timeoutMs: 5000});
    const errTxt = m.driver.readText('sol-pay-err');
    expect(errTxt).toMatch(/expir/i);
    // The scan surface is still available (the payer can try again).
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 5000});

    await m.unmount();
  }, 90_000);
});

describe('flow 74 — SOL v2 USDC full cycle (signSplPayment / TransferChecked end-to-end)', () => {
  it('USDC solreq (mint + toAta) → NFC auto-sign (TransferChecked) → broadcast → Received + sig', async () => {
    const {onboardWallet, openBalances, selectSolRail, waitForWallet} = lib();
    g.__DPAY_TEST_NFC_STATUS = 'ready';
    const m = await onboardWallet('jest-sol-usdc');
    await waitForWallet(m, {timeoutMs: 8000});
    await openBalances(m, {timeoutMs: 5000});
    await selectSolRail(m, 'sol-usdc', {timeoutMs: 5000});
    await m.driver.click('btn-receive-request', {timeoutMs: 5000}); // the REQUEST form on the SOL-USDC rail
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-req-amount-input', {timeoutMs: 5000});

    await m.driver.type('sol-req-amount-input', '2.5', {timeoutMs: 5000});
    await m.driver.click('btn-sol-req-make', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-req-qr', {timeoutMs: 8000});

    const solreqUri = await untilSeam(() => (g.__DPAY_SOL_REQ_LAST as string | undefined) ?? null, 'the reader arming with the USDC solreq');
    const reqPayload = JSON.parse(Buffer.from(solreqUri.split('solreq:v2?')[1], 'base64url').toString());
    expect(reqPayload.cur).toBe('USDC');
    expect(reqPayload.mint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(typeof reqPayload.toAta).toBe('string');
    expect(reqPayload.toAta.length).toBeGreaterThan(0);

    // Pay tab → NFC auto-sign (TransferChecked) → real signed solpay.
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 5000});
    const dispatch = makeDispatch(m);
    await nfcPhaseWalk(m, dispatch, ['linking'], {statusId: 'sol-nfc-status', text: null});
    await dispatch({type: 'request', role: 'card', solreqUri});
    expect(await m.driver.waitForText('Communicating', {timeoutMs: 6000})).toBe(true);
    const solpayUri = await untilSeam(() => (g.__DPAY_SOL_NFC_LAST as string | undefined) ?? null, 'the auto-sign producing a USDC solpay:v2 URI');
    handles.sig = extractSig(solpayUri);
    handles.txDetail = solTxDetailFromSolpay(solpayUri);

    const hit = await clickByAria(m, 'Done');
    if (hit !== 'Done') await clickByAria(m, 'Cancel');
    await m.driver.waitGone('sol-nfc-status', {timeoutMs: 5000});
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-req-qr', {timeoutMs: 5000});
    await clickByAria(m, "Scan the payer's signed code", []);
    expect(await m.driver.waitForText("Scan the payer's signed code", {timeoutMs: 5000})).toBe(true);
    await lib().armPayScan(m); // the camera seam arms async after the scanner mounts
    (g.__DPAY_TEST_SCAN as (v: string) => void)(solpayUri);

    await m.driver.findByTestID('sol-req-status', {timeoutMs: 15000});
    expect(m.driver.readText('sol-req-status')).toMatch(/Received/);
    expect(m.driver.readText('sol-req-sig').length).toBeGreaterThan(0);

    await m.unmount();
  }, 120_000);
});

describe('flow 138 — the settle gate\u2019s three verdicts, each reaching the merchant honestly', () => {
  it('(a) mismatching body → doubt + reconcile; (b) unreadable → Broadcasting until verified; (c) on-chain error → rejected', async () => {
    const m = await onboardSolPayer('jest-sol-settle');

    // ---- Leg (a): confirmed body ≠ canonical → MISMATCH (3) ---------------------------------
    await merchantCycle(m, '0.025', (detail) => {
      // Well-formed, confirmed, NOT this request: the System transfer's data carries one
      // different byte (a one-lamport-different transfer).
      const ix = (detail.transaction.message.instructions as Array<{data: string}>)[1];
      const buf = Buffer.from(ix.data, 'base64');
      buf[buf.length - 1] ^= 1;
      ix.data = buf.toString('base64');
    });
    await m.driver.findByTestID('sol-req-err', {timeoutMs: 15000});
    const errTxtA = m.driver.readText('sol-req-err');
    expect(errTxtA).toMatch(/doesn.t match this request/i);
    expect(errTxtA).not.toMatch(/received/i);
    expect(m.driver.bodyText()).not.toMatch(/Received/);
    // The durable unknown-state stays armed (the tx may still move money — reconcile/rebroadcast).
    await m.driver.findByTestID('sol-req-reconcile', {timeoutMs: 5000});
    await newRequest(m);

    // ---- Leg (b): the re-read THROWS transiently, then null → only a VERIFIED body settles ---
    handles.getTxReads = 0;
    handles.txDetail = null;
    setSolStub(makeSolStub(handles, {
      getTransaction: () => {
        handles.getTxReads += 1;
        if (handles.getTxReads <= 5) throw new Error('solana rpc http 503');
        return handles.txDetail;
      },
    }));
    const legB = await merchantCycle(m, '0.03', null, false);
    for (let i = 0; i < 40; i++) {
      if (m.driver.bodyText().includes('Broadcasting')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log('LEG-B body:', m.driver.bodyText().replace(/\s+/g, ' ').slice(0, 420), '| reads:', handles.getTxReads, '| sig set:', handles.sig != null);
    expect(await m.driver.waitForText('Broadcasting', {timeoutMs: 15000})).toBe(true);
    // Let several polls land while unreadable — counted by the stub, not slept through.
    for (let i = 0; i < 100 && handles.getTxReads < 8; i++) await new Promise((r) => setTimeout(r, 50));
    let bodyB = m.driver.bodyText();
    expect(bodyB).toMatch(/Broadcasting/);
    expect(bodyB).not.toMatch(/Received/);
    expect(bodyB).not.toMatch(/doesn.t match this request/i);
    expect(bodyB).not.toMatch(/rejected/i);
    // The read recovered: the seeded body derives from THIS leg's signed tx → verified → settles.
    handles.txDetail = solTxDetailFromSolpay(legB.solpayUri);
    expect(await m.driver.waitForText('Received', {timeoutMs: 10000})).toBe(true);
    await newRequest(m);

    // ---- Leg (c): confirmed body carries meta.err → REJECTED --------------------------------
    await merchantCycle(m, '0.04', (detail) => {
      detail.meta = {err: {InstructionError: [1, 'InsufficientFundsForFees']}, fee: 5000, preBalances: [], postBalances: []};
    });
    await m.driver.findByTestID('sol-req-err', {timeoutMs: 15000});
    const errTxtC = m.driver.readText('sol-req-err');
    expect(errTxtC).toMatch(/rejected/i);
    expect(m.driver.bodyText()).not.toMatch(/Received/);

    await m.unmount();
  }, 180_000);
});
