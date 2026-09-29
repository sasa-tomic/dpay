/**
 * Flows 60 nfc-error, 86 nfc-unknown-reconcile, 87 nfc-payer-settle — the jest twins of
 * `e2e/tests/60-nfc-error.mjs`, `86-nfc-unknown-reconcile.mjs`, `87-nfc-payer-settle.mjs`
 * (batch D port; the IC seam `__DPAY_TEST_NFC_SESSION` drives the REAL NfcTap state machine).
 *
 * 60: the three failure shapes the happy path doesn't cover — a mid-tap transport error surfaces
 *     honest "Tap failed" (no fake Paid, no debit); an unsupported-asset request AUTO-DECLINES at
 *     validation ("Unsupported asset (currency 99)", no wire, no debit); a late error after
 *     settling is IGNORED (a radio glitch can't overwrite a decided outcome).
 * 86: the RECEIVER contract — the offline payer bundle (update + signed read_state) is submitted
 *     by the merchant alone; the exact ledger match resolves "Received ✓ ∂10.00" and queues the
 *     merchant-signed result (`__DPAY_TEST_NFC_RESULT`); settled exactly once.
 * 87: the PAYER contract — the request auto-signs offline (update + read_state, never submits);
 *     only a nonce/rid-bound merchant `result` resolves "Paid ✓ ∂10.00"; balances move exactly once.
 */
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {it, expect} from '@jest/globals';
import {scaled as budgetScaled} from '../harness/budget';
import {
  accountOf, armNfcCard, armPayScan, assert, DpayCore, faucetAccount, generateKeypair,
  getBalance, icpCatalog, onboardWallet, openBalances, railPrincipalText, type Mount,
} from '../harness/lib';
import {clickByAria, nfcPhase, nfcPhaseWalk, type NfcEvent} from './h';

const g = globalThis as unknown as Record<string, unknown>;

/** The wire bundle the web shim stashes on approve (`__DPAY_TEST_NFC_APPROVED_WIRE`). */
type ApprovedWire = {envelopeHex: string; readStateEnvelopeHex: string; requestIdHex: string};
/** The merchant-queued result the shim stashes on confirm (`__DPAY_TEST_NFC_RESULT`). */
type NfcResult = {status: number; nonceHex: string; requestIdHex: string};

const dispatchFor = async (m: Mount, event: NfcEvent): Promise<void> => {
  await armNfcCard(m, 'ic');
  (g.__DPAY_TEST_NFC_SESSION as (e: NfcEvent) => void)(event);
};

hermeticFlow();

hermeticDescribe('flow 60 — NFC failure modes: honest terminals, no debit, no false success', () => {
  it('transport error → Tap failed; unsupported asset auto-declines; late error after settling ignored', async () => {
    g.__DPAY_TEST_NFC_STATUS = 'ready';
    const m = await onboardWallet('jest-nfc-err');
    const dispatch = (event: NfcEvent): Promise<void> => dispatchFor(m, event);
    await m.driver.findByTestID('pay-scan', {timeoutMs: 5000});

    // --- 1. TRANSPORT ERROR mid-tap. ------------------------------------------------------------
    await nfcPhaseWalk(m, dispatch, ['linking'], {statusId: 'nfc-status', text: null});
    await dispatchFor(m, {type: 'error', role: 'card', reason: 'Lost the radio link'});
    expect(await m.driver.waitForText('Tap failed', {timeoutMs: 5000})).toBe(true);
    expect(m.driver.bodyText()).not.toMatch(/\bPaid\b/);
    expect(m.driver.bodyText()).toContain('Lost the radio link');
    expect(await clickByAria(m, 'Done')).toBe('Done');
    await m.driver.waitGone('nfc-status', {timeoutMs: 5000});
    // No money moved: the practice figure reads on the accounts route.
    await openBalances(m);
    expect(m.driver.readText('asset-demo')).toContain('∂100.00');
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await armPayScan(m);

    // --- 2. FAIL-CLOSED AUTO-DECLINE (unsupported asset — no review card to decline from). ------
    await nfcPhaseWalk(m, dispatch, ['linking'], {statusId: 'nfc-status', text: null});
    await dispatchFor(m, {
      type: 'request', role: 'card',
      toHex: '11'.repeat(32), amount: '5000', nonceHex: 'cd'.repeat(16),
      expiry: Math.floor(Date.now() / 1000) + 240, currency: 99,
    });
    expect(await m.driver.waitForText('Declined', {timeoutMs: 5000})).toBe(true);
    expect(m.driver.bodyText()).toContain('Unsupported asset (currency 99)');
    expect(m.driver.bodyText()).not.toMatch(/\bPaid\b/);
    expect(g.__DPAY_TEST_NFC_APPROVED_WIRE ?? null).toBeNull(); // nothing signed
    expect(await clickByAria(m, 'Done')).toBe('Done');
    await m.driver.waitGone('nfc-status', {timeoutMs: 5000});
    await openBalances(m);
    expect(m.driver.readText('asset-demo')).toContain('∂100.00');
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await armPayScan(m);

    // --- 3. LATE ERROR AFTER SETTLING IS IGNORED (no false failure over a decided outcome). -----
    await nfcPhase(m, dispatch, 'linking', {statusId: 'nfc-status', text: null});
    await nfcPhase(m, dispatch, 'exchanging', {text: null});
    expect(await nfcPhase(m, dispatch, 'settling')).toBe(true); // committed=true
    await dispatchFor(m, {type: 'error', role: 'card', reason: 'should be ignored'});
    await m.driver.settleFrames(10); // give React its frames; the bug would un-show "Confirming"
    const bodyAfterLate = m.driver.bodyText();
    expect(bodyAfterLate).toContain('Confirming');
    expect(bodyAfterLate).not.toContain('should be ignored');
    expect(bodyAfterLate).not.toMatch(/Tap failed/);
    expect(await clickByAria(m, 'Cancel')).toBe('Cancel');

    await m.unmount();
  }, 120_000);
});

hermeticDescribe('flow 86 — receiver settles an offline-payer NFC bundle, exactly once', () => {
  it('update + signed read_state from A; B alone submits/polls; exact match → Received ✓ ∂10.00', async () => {
    g.__DPAY_TEST_NFC_STATUS = 'ready';
    // The payer: generated + faucet-funded OUTSIDE the app (their "phone" is this test).
    const alice = await generateKeypair();
    const fundA = await faucetAccount(alice.publicHex, 10_000);
    assert(fundA.ok, `payer A faucet funding must succeed, got ${fundA.status}`);

    // The merchant: onboarded in the app.
    const m = await onboardWallet('jest-merchant');
    const bob = await accountOf(m);
    const bobHex = bob!.publicHex;

    // B requests ∂10.00 — the real reader arms with the 132-byte wire request.
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.type('amount-input', '10.00', {timeoutMs: 4000});
    await m.driver.click('btn-request', {timeoutMs: 4000});
    await m.driver.findByTestID('request-qr', {timeoutMs: 5000});
    let readerHex: string | null = null;
    for (let i = 0; i < 100 && !readerHex; i++) {
      readerHex = (g.__DPAY_TEST_NFC_READER_REQUEST as string | undefined) ?? null;
      if (!readerHex) await new Promise((r) => setTimeout(r, budgetScaled(50)));
    }
    assert(typeof readerHex === 'string' && readerHex.length > 0, 'the NFC reader must arm with the 132-byte wire request');
    const req = await DpayCore.decodeRequest(hexToB64url(readerHex));
    expect(req.toHex).toBe(bobHex);
    expect(req.amount).toBe('1000');

    // A signs a REAL icrc1_transfer envelope (memo = the request nonce) + the reusable read_state.
    const catalog = await icpCatalog();
    const ledger = catalog.find((c) => c.currency === 0)?.ledger ?? '';
    const argHex = await DpayCore.icpTransferArg(await railPrincipalText(bobHex), '', '', '1000', '', req.nonceHex);
    const expiryNs = (BigInt(Date.now()) * 1_000_000n + 240_000n * 1_000_000n).toString();
    const signed = await DpayCore.icpSignUpdate(alice.secretHex, ledger, 'icrc1_transfer', argHex, expiryNs);
    const readStateHex = await DpayCore.icpSignReadState(alice.secretHex, [signed.requestIdHex], false, (BigInt(expiryNs) + 60_000_000_000n).toString());

    // Native ordering: transport reaches Settling, then delivers the immutable wire bundle.
    (g.__DPAY_TEST_NFC_SESSION as (e: NfcEvent) => void)({type: 'phase', role: 'reader', phase: 'settling'});
    (g.__DPAY_TEST_NFC_SESSION as (e: NfcEvent) => void)({
      type: 'done', role: 'reader',
      envelopeHex: signed.envelopeHex,
      readStateEnvelopeHex: readStateHex,
      requestIdHex: signed.requestIdHex,
    });
    await m.driver.findByTestID('nfc-status', {timeoutMs: 5000});

    // Settlement queues the signed result, but the merchant UI stays nonterminal until the payer
    // accepts it (Done must not tear reader mode down before a result-only re-tap).
    let queued: NfcResult | null = null;
    for (let i = 0; i < 200 && !queued; i++) {
      queued = (g.__DPAY_TEST_NFC_RESULT as NfcResult | null) ?? null;
      if (!queued) await new Promise((r) => setTimeout(r, budgetScaled(50)));
    }
    expect(queued?.status).toBe(0);
    expect(queued?.requestIdHex).toBe(signed.requestIdHex);
    expect(m.driver.readText('nfc-status')).not.toContain('Received');
    (g.__DPAY_TEST_NFC_SESSION as (e: NfcEvent) => void)({type: 'confirmed', role: 'reader'});

    expect(await m.driver.waitForText('Received ✓ ∂10.00', {timeoutMs: 20000})).toBe(true);
    expect(await getBalance(bobHex, 0)).toBe('11000');
    expect(await getBalance(alice.publicHex, 0)).toBe('9000');

    await m.unmount();
  }, 120_000);
});

hermeticDescribe('flow 87 — offline payer signs, never submits, and resolves Paid only on the returned result', () => {
  it('auto-sign provides update+read_state; card done moves nothing; the merchant submits; result → Paid ✓ ∂10.00', async () => {
    g.__DPAY_TEST_NFC_STATUS = 'ready';
    const m = await onboardWallet('jest-nfc-payer');
    const payer = await accountOf(m);
    const merchant = await generateKeypair();
    const payerBefore = BigInt(await getBalance(payer!.publicHex, 0));
    const merchantBefore = BigInt(await getBalance(merchant.publicHex, 0));

    const nonceHex = 'e7'.repeat(16);
    await dispatchFor(m, {
      type: 'request', role: 'card', toHex: merchant.publicHex, amount: '1000',
      nonceHex, expiry: Math.floor(Date.now() / 1000) + 240, currency: 0,
    });
    await m.driver.findByTestID('nfc-status', {timeoutMs: 5000});

    // One-press: the wire poll proves the sign happened on arrival.
    let approved: ApprovedWire | null = null;
    for (let i = 0; i < 50 && !approved; i++) {
      approved = (g.__DPAY_TEST_NFC_APPROVED_WIRE as ApprovedWire | null) ?? null;
      if (!approved) await new Promise((r) => setTimeout(r, budgetScaled(100)));
    }
    assert(approved?.envelopeHex != null && approved.envelopeHex.length > 128, 'offline payer must approve a real signed IC update');
    assert(approved.readStateEnvelopeHex != null && approved.readStateEnvelopeHex.length > 128, 'offline payer must also provide a signed read_state envelope');

    await dispatchFor(m, {type: 'phase', role: 'card', phase: 'settling'});
    await dispatchFor(m, {type: 'done', role: 'card'});

    // The merchant owns submission. Nothing moves when the card-side done fires.
    expect(BigInt(await getBalance(payer!.publicHex, 0))).toBe(payerBefore);
    const catalog = await icpCatalog();
    const ledger = catalog.find((c) => c.currency === 0)?.ledger ?? '';
    const bytes = new Uint8Array(approved.envelopeHex.match(/../g)!.map((h: string) => parseInt(h, 16)));
    const submit = await fetch(`${process.env.DPAY_JEST_RELAY_URL}/api/v2/canister/${ledger}/call`, {
      method: 'POST', headers: {'Content-Type': 'application/cbor'}, body: bytes,
    });
    expect(submit.ok).toBe(true);

    // Only the nonce/rid-bound merchant result resolves Paid.
    await dispatchFor(m, {type: 'result', role: 'card', status: 0, nonceHex, requestIdHex: approved.requestIdHex});
    expect(await m.driver.waitForText('Paid ✓ ∂10.00', {timeoutMs: 15000})).toBe(true);

    expect(BigInt(await getBalance(payer!.publicHex, 0))).toBe(payerBefore - 1000n);
    expect(BigInt(await getBalance(merchant.publicHex, 0))).toBe(merchantBefore + 1000n);

    await m.unmount();
  }, 120_000);
});

/** The reader seam carries HEX; the core's decoder eats base64url (the flow-06 twin). */
function hexToB64url(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
