/**
 * Flow 26 — the jest twin of `e2e/tests/26-names-memo.mjs` (display names + memo over wire v2).
 *
 * Wallet B "Bob" builds a request with to_name="Bob" + memo="coffee"; Alice scans it and the app
 * AUTO-SIGNS (one-press rule) with from_name="Alice" + the copied to_name/memo. Asserts: Paid ✓
 * names Bob; Alice's history row reads "to Bob" + "coffee" from the DEVICE-SAVED note (txNotes —
 * rail rows stay name-less; the hex nonce no longer sits on the row); and B's LEDGER history
 * (direct relay query) shows the name-less rail truth with memo == the request nonce — the
 * reconciliation key B reconciles its open request by.
 */
import {describe, it, expect} from '@jest/globals';
import {
  armPayScan, assert, assertEq, assertIncludes, generateKeypair, getBalance, onboardWallet,
  openBalances, railPrincipalText,
} from '../harness/lib';
import {relayGet} from '../harness/relayClient';
import {DpayCore} from '../harness/lib';
import {scanSeam} from './local';

const PAY_CENTS = '2500';
const PAYEE_NAME = 'Bob';
const PAYER_NAME = 'Alice';
const MEMO = 'coffee';
const NONCE = '11'.repeat(16);

describe('flow 26 — names + memo ride the signed bytes', () => {
  it('Alice pays Bob with memo coffee → both histories are self-describing (the rail honestly is not)', async () => {
    // --- wallet B "Bob" (payee/merchant): generated in-test, starts at 0. ------------------------
    const bob = await generateKeypair();
    expect(await getBalance(bob.publicHex, 0)).toBe('0');

    // --- wallet A "Alice" (payer): onboarded in the app (∂100 by the faucet). --------------------
    const m = await onboardWallet(PAYER_NAME);

    // --- B's request: to_name + memo ride INSIDE the 132-byte request bytes. ----------------------
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = await DpayCore.encodeRequest(bob.publicHex, PAY_CENTS, NONCE, expiry, 0, PAYEE_NAME, MEMO);

    // --- A scans → AUTO-SIGN → settle (one-press rule): no review stop, no Approve click. --------
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(requestQR);

    expect(await m.driver.waitForText('Paid', {timeoutMs: 10_000})).toBe(true);
    const paidBody = m.driver.bodyText();
    assertIncludes(paidBody, '∂25.00', 'the paid headline should carry the exact ∂25.00 amount');
    assertIncludes(paidBody, PAYEE_NAME, 'Paid ✓ confirmation should name the recipient (by display name)');

    // --- A's balance decreased; the read goes through the explicit "New payment" release. --------
    await m.driver.click('btn-new', {timeoutMs: 8000});
    await openBalances(m);
    assert(await m.driver.waitForText('∂75.00', {timeoutMs: 10_000}), 'payer A balance should be ∂75.00');

    // --- A's Recent history: the DEVICE-SAVED NOTE names the row (txNotes). ----------------------
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    await m.driver.click('tab-transactions', {timeoutMs: 5000});
    assert(await m.driver.waitForText('Recent', {timeoutMs: 8000}), 'the Recent card should render');
    // The row's arrival is a positive transition (mount → history fetch → rows render): wait for
    // the NAME itself instead of reading the first snapshot — a single read races the fetch and
    // loses whenever the tick lands between the mount and the response (observed in-run).
    assert(await m.driver.waitForText(`to ${PAYEE_NAME}`, {timeoutMs: 8000}),
      'A history row should show the payee NAME');
    const histBody = m.driver.bodyText();
    assertIncludes(histBody, MEMO, 'A history row should show the human memo');
    expect(histBody).not.toContain(NONCE.slice(0, 8)); // the note's message replaced the hex nonce
    expect(histBody).not.toContain(bobPrincipal);
    expect(histBody).not.toContain(bob.publicHex);

    // --- B was credited; B's LEDGER history carries the name-less rail truth (memo = nonce). -----
    assertEq(await getBalance(bob.publicHex, 0), PAY_CENTS, 'payee B balance after the settle');
    const j = await relayGet(`/api/v1/transactions/${bob.publicHex}?currency=0&limit=5`) as {
      transactions: Array<{to?: string; from_name?: string; to_name?: string; memo: string}>;
    };
    expect(j.transactions.length).toBeGreaterThan(0);
    const inRow = j.transactions.find((row) => row.to && row.to.toLowerCase() === bobPrincipal.toLowerCase());
    assert(inRow !== undefined, 'B’s history should contain the incoming row (to == B’s principal)');
    assertEq(inRow.from_name ?? '', '', 'B history from_name is EMPTY on the rail (names died with the facade)');
    assertEq(inRow.to_name ?? '', '', 'B history to_name is EMPTY on the rail');
    assertEq(inRow.memo, NONCE, 'B history row.memo == the request nonce (the reconciliation key)');

    await m.unmount();
  }, 120_000);
});
