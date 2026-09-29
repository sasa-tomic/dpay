/**
 * Flows 08 + 21 — the jest twins of `e2e/tests/08-merchant-settle.mjs` and `e2e/tests/21-receive-scan.mjs`
 * (the RECIPIENT side of the IC pay, explicitly).
 *
 * Wallet B (merchant, onboarded) opens a request; wallet A (payer, a harness keypair funded on the
 * relay) signs a REAL icrc1_transfer envelope with memo = the request nonce (the reconciliation
 * key); B's app receives it through the offline-payer scan affordance, submits it to the fake-IC
 * gateway, and its read_state poll reconciles the request → "Received". Flow 08 drives it from a
 * fresh ∂30 request; flow 21 is the envelope-twin from a ∂25 request typed by placeholder.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  accountOf, assert, assertEq, assertIncludes, faucetAccount, generateKeypair,
  getBalance, onboardWallet, openBalances, railPrincipalText,
} from '../harness/lib';
import {b64urlEncode, hexBytes, openPayerScan, parsePayLink, scanSeam, signIcrc1Envelope} from './local';

const DEMO_LEDGER = 'td2nx-oaaaa-aaaab-qhdnq-cai'; // catalog currency 0's ledger (the fake-IC gateway registers it)

hermeticDescribe('flow 08 — merchant receive → settle (fresh request, ∂30)', () => {
  it('A signs the envelope for B’s request → B scans it → Received ∂30.00, both ledgers agree', async () => {
    // --- wallet A (payer): generated + faucet-funded in-test (the offline-style payer). ---------
    const alice = await generateKeypair();
    const fund = await faucetAccount(alice.publicHex, 10_000);
    assert(fund.ok, `payer A faucet funding must succeed, got ${fund.status}`);

    // --- wallet B (merchant): onboarded in the app. ---------------------------------------------
    const m = await onboardWallet('jest-merchant');
    const bob = await accountOf(m);
    assert(bob !== null && bob.publicHex.length === 64, 'the onboarded merchant must carry a 32-byte pubkey');

    // --- B creates a ∂30 request; the QR is the payment LINK (the reconciliation ref is `ref`). --
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.type('amount-input', '30.00', {timeoutMs: 4000});
    await m.driver.click('btn-request', {timeoutMs: 4000});
    await m.driver.findByTestID('request-qr', {timeoutMs: 5000});
    const requestQR = (globalThis as unknown as Record<string, string>).__DPAY_QR_LAST as string;
    const link = parsePayLink(requestQR);
    assert(link !== null, `the request QR must BE the payment link, got "${requestQR}"`);
    assertEq(link.recipient, await railPrincipalText(bob.publicHex), 'B link.recipient == B principal');
    assertEq(link.amount, '30.00', 'B link.amount == ∂30.00');
    expect(link.ref ?? '').toMatch(/^[0-9a-f]{32}$/);
    const nonceHex = link.ref!;

    // --- A signs a REAL icrc1_transfer envelope (memo = the request nonce). ----------------------
    const {envelopeHex, ledger} = await signIcrc1Envelope(alice.secretHex, bob.publicHex, 3000, {memoHex: nonceHex});
    assertEq(ledger, DEMO_LEDGER, 'catalog currency 0 ledger');
    const envelopeB64 = b64urlEncode(hexBytes(envelopeHex));

    // --- Hand the envelope to B's app through the offline-payer scan affordance. -----------------
    await openPayerScan(m);
    scanSeam()(envelopeB64);

    // --- B's app submits + reconciles via its read_state poll → "Received ∂30.00". ---------------
    assert(await m.driver.waitForText('Received ∂30.00', {timeoutMs: 12_000}),
      'merchant B should reach the "Received ∂30.00" screen after submitting the payer’s envelope');

    // --- B's `$` balance grew by the amount; A was debited once. ---------------------------------
    await openBalances(m);
    assert(await m.driver.waitForText('∂130.00', {timeoutMs: 10_000}), 'B balance should be ∂130.00 (∂100 + ∂30)');
    assertEq(await getBalance(bob.publicHex, 0), '13000', 'B ledger balance');
    assertEq(await getBalance(alice.publicHex, 0), '7000', 'A ledger balance (10000 − 3000, debited once)');

    const alicePrincipal = await railPrincipalText(alice.publicHex);
    // --- B's Recent history shows the INCOMING payment as A's SHORT principal (never the full). --
    await m.driver.click('tab-transactions', {timeoutMs: 5000});
    assert(await m.driver.waitForText('Recent', {timeoutMs: 8000}), 'B history should render the incoming payment');
    const shortPayer = alicePrincipal.slice(0, 8);
    assert(await m.driver.waitForText(shortPayer, {timeoutMs: 10_000}),
      `B history row should name the payer (short principal ${shortPayer})`);
    const histBody = m.driver.bodyText();
    expect(histBody).not.toContain(alicePrincipal);

    await m.unmount();
  }, 120_000);
});

hermeticDescribe('flow 21 — receive-scan (the envelope-twin, ∂25 by placeholder)', () => {
  it('B scans A’s base64url envelope (memo = nonce) → Received ∂25.00 + ledger truth', async () => {
    // --- Payer: a funded offline wallet (keys only — the payer's phone never talks to the relay). -
    const alice = await generateKeypair();
    await faucetAccount(alice.publicHex, 10_000);

    // --- Merchant B: onboarded, with an OPEN ∂25 request. ----------------------------------------
    const m = await onboardWallet('jest-merchant21');
    const bob = await accountOf(m);
    assert(bob !== null, 'merchant identity missing');
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.typeByPlaceholder('0.00', '25.00', {timeoutMs: 4000});
    await m.driver.click('btn-request', {timeoutMs: 4000});
    await m.driver.findByTestID('request-qr', {timeoutMs: 5000});
    const requestQR = (globalThis as unknown as Record<string, string>).__DPAY_QR_LAST as string;
    const link = parsePayLink(requestQR);
    assert(link !== null, `the request QR must BE the payment link, got "${requestQR}"`);
    assertEq(link.recipient, await railPrincipalText(bob.publicHex), 'request link payee must be merchant B');
    assertEq(link.amount, '25.00', 'request link amount must be ∂25.00');
    expect(link.ref ?? '').toMatch(/^[0-9a-f]{32}$/);
    const nonceHex = link.ref!;

    // --- Payer signs an icrc1_transfer envelope bound to the request (memo = nonce). -------------
    const {envelopeHex} = await signIcrc1Envelope(alice.secretHex, bob.publicHex, 2500, {memoHex: nonceHex});
    const envelopeB64 = b64urlEncode(hexBytes(envelopeHex));

    // --- B opens the scan affordance and receives the payer's hand-off QR. -----------------------
    await openPayerScan(m);
    scanSeam()(envelopeB64);

    // --- The Received flip — B's app submitted + reconciled the transfer via read_state. ---------
    assert(await m.driver.waitForText('Received ∂25.00', {timeoutMs: 12_000}),
      'B should reach the "Received ∂25.00" screen after scanning the payer’s envelope');

    // --- Ledger truth: B credited, alice debited once; B's on-screen balance picked it up. -------
    assertEq(await getBalance(bob.publicHex, 0), '12500', 'B ledger balance');
    assertEq(await getBalance(alice.publicHex, 0), '7500', 'alice ledger balance');
    await openBalances(m);
    assert(await m.driver.waitForText('∂125.00', {timeoutMs: 10_000}), 'B on-screen balance should read ∂125.00');
    assertIncludes(m.driver.bodyText(), '∂125.00', 'the accounts route carries the settled balance');

    await m.unmount();
  }, 120_000);
});
