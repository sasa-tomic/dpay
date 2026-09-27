/**
 * Flow 157 transaction-receipt — the jest twin of `e2e/tests/157-transaction-receipt.mjs`.
 *
 * A settled rail payment reaches the Transactions tab; its receipt states what the ledger recorded
 * (exact amount, the payer's FULL principal, the memo as the reference, a numeric block index);
 * the copy affordance puts the whole proof on the clipboard; the faucet MINT row's receipt says
 * what the ledger recorded nothing for in sentences, never blank labelled rows; and the Home feed
 * opens the identical receipt.
 *
 * Port note: the clipboard is observed at the harness's Share recorder (`__DPAY_TEST_CLIPBOARD`,
 * the seam the browser twin's writeText wrapper feeds) — Platform.OS='web' routes the app's
 * copyToClipboard through the same fallback path.
 */
import {describe, it, expect} from '@jest/globals';
import {
  accountOf, assertIncludes, faucetAccount, generateKeypair, onboardWallet,
  railPrincipalText, railTransfer,
} from '../harness/lib';
import {freshContext} from '../onboard/helpers';

const MEMO_HEX = '9f2c00112233445566778899aabbccdd';
const g = globalThis as unknown as Record<string, unknown>;

describe('flow 157 — transaction-receipt', () => {
  it('the receipt states the ledger record; copy carries the whole proof; mints speak in sentences; Home opens the same receipt', async () => {
    await freshContext();
    const m = await onboardWallet('e2e-receipt');
    const me = await accountOf(m);
    const payer = await generateKeypair();
    const payerPrincipal = await railPrincipalText(payer.publicHex);
    const fund = await faucetAccount(payer.publicHex, 20000);
    expect(fund.ok).toBe(true);
    const paid = await railTransfer(payer.secretHex, me!.publicHex, 4200n, {memoHex: MEMO_HEX});
    expect({ok: paid.ok, status: paid.status}).toEqual({ok: true, status: 202});

    // ---- (a) the row is pressable and the receipt states what the ledger recorded --------------
    await m.driver.click('tab-transactions', {timeoutMs: 5000});
    await m.driver.findByTestID('ledger-view', {timeoutMs: 5000});
    expect(await m.driver.waitForText('+∂42.00', {timeoutMs: 12_000})).toBe(true);
    await m.driver.click('hist-row-0', {timeoutMs: 5000});
    await m.driver.findByTestID('txn-receipt', {timeoutMs: 5000});

    expect(m.driver.readText('txn-receipt-amount')).toBe('+∂42.00');
    // The full principal (the node's subtree carries the 'Received from' label verbosely).
    assertIncludes(m.driver.readText('txn-receipt-account'), payerPrincipal,
      'the receipt must carry the payer\'s FULL principal, untruncated');
    assertIncludes(m.driver.readText('txn-receipt-ref'), MEMO_HEX,
      'the reference carries the memo the payment carried');
    expect(m.driver.readText('txn-receipt-proof')).toMatch(/block\s*\d+$/); // label joins the value under RTR

    // ---- (b) the proof really lands on the clipboard --------------------------------------------
    g.__DPAY_TEST_CLIPBOARD = '';
    await m.driver.click('btn-txn-receipt-copy', {timeoutMs: 5000});
    let clip = '';
    for (let i = 0; i < 100; i++) {
      clip = String(g.__DPAY_TEST_CLIPBOARD ?? '');
      if (clip.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assertIncludes(clip, '+∂42.00', 'the copied receipt carries the amount');
    assertIncludes(clip, payerPrincipal, 'the copied receipt carries the full payer account');
    assertIncludes(clip, MEMO_HEX, 'the copied receipt carries the reference');

    // ---- (c) the row the ledger recorded nothing for SAYS so ------------------------------------
    await m.driver.click('btn-txn-receipt-close', {timeoutMs: 4000});
    await m.driver.waitGone('txn-receipt', {timeoutMs: 4000});
    await m.driver.click('hist-row-1', {timeoutMs: 5000});
    await m.driver.findByTestID('txn-receipt', {timeoutMs: 5000});
    expect(m.driver.readText('txn-receipt-amount')).toBe('+∂100.00');
    const mintAccount = m.driver.readText('txn-receipt-account');
    expect(mintAccount.length > 0 && !mintAccount.includes('-')).toBe(true);
    assertIncludes(mintAccount, 'no account', 'the empty-counterparty slot names what is missing');
    assertIncludes(m.driver.readText('txn-receipt-ref'), 'carried no memo', 'the empty-memo slot names what is missing');
    expect(m.driver.readText('txn-receipt-proof')).toMatch(/block\s*\d+$/);

    // ---- (d) the Home feed opens the SAME receipt ------------------------------------------------
    await m.driver.click('btn-txn-receipt-close', {timeoutMs: 4000});
    await m.driver.waitGone('txn-receipt', {timeoutMs: 4000});
    await m.driver.click('tab-home', {timeoutMs: 4000});
    await m.driver.findByTestID('home-activity', {timeoutMs: 5000});
    await m.driver.click('home-hist-row-0', {timeoutMs: 5000});
    await m.driver.findByTestID('txn-receipt', {timeoutMs: 5000});
    assertIncludes(m.driver.readText('txn-receipt-account'), payerPrincipal,
      'the Home feed opens the same receipt for the same row');

    await m.unmount();
  }, 120_000);
});
