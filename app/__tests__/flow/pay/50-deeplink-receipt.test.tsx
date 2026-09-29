/**
 * Flow 50 — the jest twin of `e2e/tests/50-deeplink-receipt.mjs` (the `dpay:pay` receipt hand-back,
 * the W3 NFC-less rail proof).
 *
 * The payer (online) settles their own payment — an icrc1_transfer whose memo is the REQUEST NONCE —
 * and shares the rail proof {ledger, block_index, request_id} back as a `dpay:pay/<blob>` link
 * (base64url JSON — the receiptShareBlob codec). The merchant's app binds the proof to the OPEN
 * request and the "Received" flip comes from an exact recipient/currency/amount/memo match in
 * durable ledger history, never from the blob itself.
 *
 * FORGERY LEG (F2): a well-formed proof with a RANDOM request_id is injected FIRST — it must NOT
 * flip Received: the app spends its bounded history budget and says so ("Couldn't confirm this
 * payment yet"). Only the REAL pre-settled proof completes to Received, and a dpay:pay never
 * routes to the Pay review.
 */
import {randomBytes} from 'node:crypto';
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  accountOf, assert, assertIncludes, faucetAccount, generateKeypair, getBalance,
  icpCatalog, onboardWallet, railPrincipalText, railTransfer,
} from '../harness/lib';
import {relayGet} from '../harness/relayClient';
import {parsePayLink} from './local';

const PAY_UNITS = '2500'; // ∂25.00 (DEMO = currency 0)

hermeticDescribe('flow 50 — dpay:pay receipt hand-back (forgery refused, ledger-bound Received)', () => {
  it('a forged proof exhausts the history budget; the real nonce-bound proof flips Received', async () => {
    // --- wallet A: onboarded (the MERCHANT). ------------------------------------------------------
    const m = await onboardWallet('jest-receipt');
    const alice = await accountOf(m);
    const alicePub = alice!.publicHex;

    // --- A builds a REAL request through the app: the link's `ref` is the nonce to memo. ---------
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.type('amount-input', '25.00', {timeoutMs: 4000});
    await m.driver.click('btn-request', {timeoutMs: 4000});
    await m.driver.findByTestID('request-qr', {timeoutMs: 5000});
    const qrValue = (globalThis as unknown as Record<string, string>).__DPAY_QR_LAST as string;
    assert(typeof qrValue === 'string' && qrValue.length > 0, '__DPAY_QR_LAST should hold the request QR value');
    const link = parsePayLink(qrValue);
    assert(link !== null, `the request QR must BE the payment link, got "${qrValue}"`);
    expect(link.recipient).toBe(await railPrincipalText(alicePub));
    expect(link.amount).toBe('25.00');
    expect(link.asset).toBe('DEMO');
    expect(link.network).toBe('internet-computer');
    expect(link.ref ?? '').toMatch(/^[0-9a-f]{32}$/);
    const nonce = link.ref!;

    // --- wallet B: a fresh keypair (the PAYER), fauceted ∂100. ------------------------------------
    const bob = await generateKeypair();
    const fund = await faucetAccount(bob.publicHex, 10000);
    assert(fund.ok, `payer B faucet should succeed, got ${fund.status}`);
    expect(await getBalance(bob.publicHex, 0)).toBe('10000');

    const catalog = await icpCatalog();
    const ledger = catalog.find((c) => c.currency === 0)?.ledger;
    assert(typeof ledger === 'string' && ledger.length > 0, 'catalog must carry the DEMO ledger id');

    // --- FORGERY first: a well-formed random-rid proof must NOT flip Received. --------------------
    const forgedRid = randomBytes(32).toString('hex');
    const forgedBlob = Buffer.from(JSON.stringify({ledger, block_index: '0', request_id: forgedRid}), 'utf8').toString('base64url');
    const deeplink = (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_DEEPLINK as (u: string) => void;
    assert(typeof deeplink === 'function', '__DPAY_TEST_DEEPLINK seam not mounted (Wallet link effect missing)');
    deeplink(`dpay:pay/${forgedBlob}`);
    // Wait for the app to SPEND its history budget and SAY so — the proof-of-absence that cannot
    // pass by arriving early.
    assert(await m.driver.waitForText('Couldn’t confirm this payment yet', {timeoutMs: 20_000}),
      'the forged proof must exhaust the history budget and be refused, not silently ignored');
    expect(m.driver.bodyText()).not.toContain('Received');
    expect(m.driver.isPresent('request-qr')).toBe(true);

    // --- B settles ON THE RAIL (memo = the request nonce) — the app-independent payer. ------------
    const pay = await railTransfer(bob.secretHex, alicePub, PAY_UNITS, {currency: 0, memoHex: nonce});
    assert(pay.ok, `B's rail transfer should be accepted, got ${pay.status}: ${pay.bodyText.slice(0, 300)}`);

    // --- Ledger-state confirmation (the honest W3 leg): memo-keyed row + balance grew. ------------
    const alicePrincipal = await railPrincipalText(alicePub);
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    const j = await relayGet(`/api/v1/transactions/${alicePub}?currency=0&limit=20`) as {transactions?: Array<{memo: string; from: string; to: string; amount: string}>};
    const row = (j.transactions ?? []).find((t) => t.memo === nonce);
    assert(row !== undefined, `the rail txn row keyed by the request memo must exist for the merchant`);
    expect(row.from).toBe(bobPrincipal);
    expect(row.to).toBe(alicePrincipal);
    expect(row.amount).toBe(PAY_UNITS);
    expect(await getBalance(alicePub, 0)).toBe('12500');

    // --- The REAL rail proof, handed back through the dpay:pay deeplink seam. ---------------------
    const proof = {ledger, block_index: '0', request_id: pay.requestIdHex};
    const blob = Buffer.from(JSON.stringify(proof), 'utf8').toString('base64url');
    deeplink(`dpay:pay/${blob}`);

    // --- Received: the proof bound to the OPEN request, ledger-confirmed; never the Pay review. ---
    assert(await m.driver.waitForText('Received', {timeoutMs: 8000}),
      'merchant should see "Received" after the dpay:pay proof bound to the open request');
    const body = m.driver.bodyText();
    assertIncludes(body, '∂25.00', 'the Received screen should show the open request amount ∂25.00');
    assertIncludes(body, 'from ', 'the Received screen should name the payer');
    expect(body).not.toMatch(/\bPay ∂25\.00\b/); // SECURITY: routes to Receive, not the Pay review

    await m.unmount();
  }, 150_000);
});
