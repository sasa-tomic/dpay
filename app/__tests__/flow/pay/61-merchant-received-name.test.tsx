/**
 * Flow 61 — the jest twin of `e2e/tests/61-merchant-received-name.mjs` (counterparty rendering on
 * the IC rail; friendly names are GONE with the facade settlement).
 *
 * Gates the regression that still matters: counterparties render as SHORT PRINCIPAL TEXT (8-char
 * prefix), never a full principal, never the raw hex pubkey; the reconciliation nonce is NOT on
 * the history row (2026-10-02 audit: machine references stay off the list) — it lives on the
 * row's receipt Reference line; and the online direct payment updates balance + history but does
 * NOT flip the merchant's "Received" (that flip is merchant-app-submission only — flows 08/21).
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  accountOf, assert, assertIncludes, faucetAccount, generateKeypair, getBalance, onboardWallet,
  railPrincipalText, railTransfer,
} from '../harness/lib';
import {parsePayLink} from './local';

const PAY_CENTS = '2500'; // ∂25.00

hermeticDescribe('flow 61 — the rail renders short principals + the memo (names are gone)', () => {
  it('history shows the payer’s short principal + the nonce memo, never names/full principals', async () => {
    // --- wallet A (merchant): onboarded. ----------------------------------------------------------
    const m = await onboardWallet('Alice');
    const alicePub = (await accountOf(m))!.publicHex;

    // --- wallet B (payer): generated in-test, fauceted ∂100. --------------------------------------
    const bob = await generateKeypair();
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    const fund = await faucetAccount(bob.publicHex, 10000);
    assert(fund.ok, `payer B faucet should succeed, got ${fund.status}`);

    // --- A creates a ∂25 receive request; the link's `ref` IS the request nonce (the memo). -------
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.type('amount-input', '25.00', {timeoutMs: 4000});
    await m.driver.click('btn-request', {timeoutMs: 4000});
    await m.driver.findByTestID('request-qr', {timeoutMs: 5000});
    const requestQR = (globalThis as unknown as Record<string, string>).__DPAY_QR_LAST as string;
    const link = parsePayLink(requestQR);
    assert(link !== null, `the request QR must BE the payment link, got "${requestQR}"`);
    expect(link.ref ?? '').toMatch(/^[0-9a-f]{32}$/);
    const nonceHex = link.ref!;

    // --- B settles ON THE RAIL (online direct payment — no merchant-app submission). --------------
    const pay = await railTransfer(bob.secretHex, alicePub, PAY_CENTS, {memoHex: nonceHex});
    expect(pay.ok).toBe(true);
    expect(pay.status).toBe(202);

    // --- Ledger truth: A credited. ----------------------------------------------------------------
    expect(await getBalance(alicePub, 0)).toBe('12500');

    // --- A's history: SHORT PRINCIPAL only; the reconciliation nonce is a RECEIPT fact now. -------
    // (2026-10-02 audit: the raw nonce third-line crowded the row; the reconciliation key
    // lives where a dispute looks - the receipt's Reference line and its copied text.)
    await m.driver.click('tab-transactions', {timeoutMs: 5000});
    assert(await m.driver.waitForText('Recent', {timeoutMs: 8000}), 'history should render');
    assert(await m.driver.waitForText(bobPrincipal.slice(0, 8), {timeoutMs: 8000}),
      'history should show the payer as the short PRINCIPAL prefix');
    const body = m.driver.bodyText();
    assertIncludes(body, bobPrincipal.slice(0, 8), 'history shows the short principal counterparty');
    expect(body).not.toContain(bobPrincipal);
    expect(body).not.toContain(bob.publicHex);
    expect(body).not.toContain(nonceHex.slice(0, 8)); // machine references stay off the list row
    expect(body).not.toMatch(/Received ∂/); // the flip is merchant-app-submission only (flows 08/21)

    // The row opens the receipt; the FULL nonce is the reconciliation key, right where a
    // merchant copies their proof.
    let opened = false;
    for (let i = 0; i < 12 && !opened; i++) {
      const id = `hist-row-${i}`;
      if (!m.driver.isPresent(id)) break;
      if (m.driver.readText(id).includes(bobPrincipal.slice(0, 8))) {
        await m.driver.click(id, {timeoutMs: 5000});
        opened = true;
      }
    }
    assert(opened, 'the payer row should open its receipt');
    await m.driver.findByTestID('txn-receipt', {timeoutMs: 5000});
    assertIncludes(m.driver.readText('txn-receipt-ref'), nonceHex, 'the receipt carries the reconciliation nonce');
    await m.driver.click('btn-txn-receipt-close', {timeoutMs: 4000});

    await m.unmount();
  }, 120_000);
});
