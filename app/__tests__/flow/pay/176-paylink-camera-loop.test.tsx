/**
 * Flow 176 — the jest twin of `e2e/tests/176-paylink-camera-loop.mjs` (the two-phone loop: a
 * merchant's request QR is camera-scanned by a payer on its OWN identity, on both rails).
 *
 * jest has one identity store, so the "second incognito context" is a SECOND full-app mount: the
 * merchant app (m1) is mounted and parked on its request screen while the payer's identity is
 * seeded and a second app (m2) mounts over it — two wallets, one relay, exactly the counter
 * situation. The camera seam on the payer phone receives the QR's OWN string — no fixture, no
 * rebuild. IC: review pre-filled, NOT paid, Approve settles, the payer's practice row drops, and
 * the merchant's OPEN request auto-confirms from the memo. SOL: the link carries the NETTED wire
 * and NO ref; the payer's SOL send form pre-fills and broadcasts; the SOL request screen does NOT
 * auto-confirm (radio/scan-back are its confirm paths).
 *
 * LOAD-ORDER CONTRACT: the RPC override is set before the harness require (see ./solrpc).
 */
import {describe, it, expect} from '@jest/globals';
import {baseSolStub, enableSolRpcStub, installSolAccountsHelper} from './solrpc';

const G = globalThis as unknown as Record<string, unknown>;
enableSolRpcStub();
installSolAccountsHelper();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../harness/lib') as typeof import('../harness/lib');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {mountApp} = require('../harness/mount') as typeof import('../harness/mount');
const {
  accountOf, armPayScan, assert: assert_, assertEq, assertIncludes, faucetAccount,
  generateKeypair, onboardWallet, openBalances, railPrincipalText,
} = lib;
const assert: typeof lib.assert = lib.assert;
const {parsePayLink, scanSeam} = require('./local') as typeof import('./local');

const IC_AMOUNT = '3.50';
const SOL_AMOUNT = '0.02'; // the typed PRICE
const SOL_NETTED = '0.019995'; // 0.02 price − 5000-lamport fee — the netted wire

describe('flow 176 — the two-phone paylink loop: merchant QR → payer camera → both rails settle', () => {
  it('IC: scan → review → Approve → Received from the memo; SOL: netted link → pre-filled send → Sent', async () => {
    // ── The MERCHANT phone: onboarded, parked on its request screen. ────────────────────────────
    const m1 = await onboardWallet('jest-link-merchant');
    const merchant = (await accountOf(m1))!;
    const selfPrincipal = await railPrincipalText(merchant.publicHex);

    await m1.driver.click('tab-receive', {timeoutMs: 4000});
    await m1.driver.type('amount-input', IC_AMOUNT, {timeoutMs: 4000});
    await m1.driver.click('btn-request', {timeoutMs: 4000});
    await m1.driver.findByTestID('request-qr', {timeoutMs: 5000});

    // The QR value is the LINK: this wallet, this asset, this amount, the nonce as `ref`.
    const linkStr = (globalThis as unknown as Record<string, string>).__DPAY_QR_LAST as string;
    const link = parsePayLink(linkStr);
    assert(link !== null, `the request QR must BE the payment link, got "${linkStr}"`);
    assertEq(link.recipient, selfPrincipal, 'the link pays the requesting wallet’s principal');
    assertEq(link.asset, 'DEMO', 'the link names the requested asset');
    assertEq(link.network, 'internet-computer', 'the link names the settlement network');
    assertEq(link.amount, IC_AMOUNT, 'the link carries the requested amount');
    assertIncludes(linkStr, `label=${encodeURIComponent('jest-link-merchant')}`, 'the link carries the merchant label');
    expect(link.ref ?? '').toMatch(/^[0-9a-f]{32}$/);

    // ── The PAYER phone: its own faucet-funded identity, mounted OVER the parked merchant. ───────
    const payer = await generateKeypair();
    const funded = await faucetAccount(payer.publicHex, 10_000);
    assert(funded.ok, `the payer faucet should succeed, got ${funded.status}`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AS = require('@react-native-async-storage/async-storage') as {setItem: (k: string, v: string) => Promise<void>; getItem: (k: string) => Promise<string | null>};
    await AS.setItem('dpay.identity.v1', JSON.stringify({
      secretHex: payer.secretHex, publicHex: payer.publicHex, username: 'jest-link-payer',
    }));
    await AS.setItem('dpay.journey.v1', JSON.stringify({
      stamps: ['walkthroughDone', 'recoverySaved', 'flowUnderstood'],
      at: {walkthroughDone: Date.now(), recoverySaved: Date.now(), flowUnderstood: Date.now()},
      seen: ['firstRunPractice'],
    }));
    const m2 = await mountApp();
    await lib.chooseHomeCurrencyIfPresent(m2);
    await lib.waitForWallet(m2, {timeoutMs: 10_000});
    const payerIdentity = await accountOf(m2);
    assert(payerIdentity !== null && payerIdentity.publicHex === payer.publicHex,
      'the payer phone runs the PAYER identity (a second wallet over the same relay)');

    // ── IC leg: the payer camera-scans THAT EXACT STRING. ────────────────────────────────────────
    await m2.driver.click('tab-pay', {timeoutMs: 4000});
    await armPayScan(m2);
    await m2.driver.settleFrames(1);
    scanSeam()(linkStr);

    // The review — reached, pre-filled, NOT paid (a link is a zero-press entry).
    await m2.driver.findByTestID('pay-amount', {timeoutMs: 6000});
    assertIncludes(m2.driver.readText('pay-amount'), '∂3.50', 'the review shows "Pay ∂3.50"');
    assertEq(m2.driver.readText('review-payee'), selfPrincipal, 'the review shows the link’s destination (full principal)');
    expect(m2.driver.bodyText()).not.toMatch(/\bPaid\b/);

    // Approve → sign + settle; the link's `ref` rides as the on-chain memo.
    await m2.driver.click('btn-approve', {timeoutMs: 5000});
    assert(await m2.driver.waitForText('Paid', {timeoutMs: 10_000}), 'the payer reaches the Paid screen');
    await m2.driver.findByTestID('btn-new', {timeoutMs: 8000});
    await m2.driver.click('btn-new', {timeoutMs: 5000});
    await openBalances(m2);
    assert(await m2.driver.waitForText('∂96.50', {timeoutMs: 10_000}), 'payer balance ∂100 − ∂3.50 = ∂96.50');

    // The merchant's OPEN request auto-confirms from the memo — one key: ref = nonce = memo.
    assert(await m1.driver.waitForText('Received ∂3.50', {timeoutMs: 20_000}),
      'the open request must flip to "Received ∂3.50" from the link payment’s memo');

    // ── SOL leg: the merchant opens a SOL request; the payer pays it from its own camera. ────────
    G.__DPAY_TEST_SOLANA_RPC_STUB = baseSolStub({
      getMultipleAccounts: (p: unknown) => (G.__DPAY_SOL_ACCOUNTS as (p: unknown, s: unknown) => unknown)(p, {lamports: 5_000_000_000, token: {amount: '0', decimals: 6}}),
      getBalance: () => ({value: 5_000_000_000}),
    });

    // Currency-first: SOL is selected via its CURRENCY row (the working rail follows the main).
    await openBalances(m1);
    await m1.driver.click('btn-accounts-currency-SOL', {timeoutMs: 8000});
    await m1.driver.click('tab-receive', {timeoutMs: 5000});
    await m1.driver.findByTestID('sol-req-amount-input', {timeoutMs: 5000});
    await m1.driver.type('sol-req-amount-input', SOL_AMOUNT, {timeoutMs: 5000});
    await m1.driver.click('btn-sol-req-make', {timeoutMs: 5000});
    await m1.driver.findByTestID('sol-req-qr', {timeoutMs: 8000});

    // The SOL QR is the LINK — and `ref` is deliberately null.
    const solLinkStr = (globalThis as unknown as Record<string, string>).__DPAY_QR_LAST as string;
    const solLink = parsePayLink(solLinkStr);
    assert(solLink !== null, `the SOL request QR must BE the payment link, got "${solLinkStr}"`);
    assertEq(solLink.asset, 'SOL', 'the SOL link names the asset');
    assertEq(solLink.network, 'solana', 'the SOL link names the network');
    assertEq(solLink.amount, SOL_NETTED, 'the SOL link carries the NETTED wire (price − 5000-lamport fee)');
    expect(solLink.recipient).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(solLink.ref).toBeNull(); // the rail attaches no reconciliation memo

    // Camera-scan the exact string on the payer phone → the SOL send surface, pre-filled.
    await m2.driver.click('tab-pay', {timeoutMs: 5000});
    await armPayScan(m2);
    await m2.driver.settleFrames(1);
    scanSeam()(solLinkStr);
    await m2.driver.findByTestID('sol-send-address-input', {timeoutMs: 10_000});
    await m2.driver.waitForFunction(
      () => m2.driver.readInputValue('sol-send-address-input') === solLink.recipient
        && m2.driver.readInputValue('sol-send-amount-input') === SOL_NETTED,
      {timeoutMs: 10_000, label: 'the send form pre-fills with the link’s destination + netted amount'},
    );

    // Confirm → the REAL send path (local sign + broadcast through the stub).
    await lib.waitForEnabled(m2, 'btn-sol-send-confirm');
    await m2.driver.click('btn-sol-send-confirm', {timeoutMs: 5000});
    await m2.driver.findByTestID('sol-send-outcome', {timeoutMs: 12_000});
    expect(m2.driver.readText('sol-send-outcome')).toMatch(/Sent/);

    // The SOL request screen does NOT auto-confirm — documented semantics. It stays open, waiting.
    await m1.driver.click('tab-receive', {timeoutMs: 5000});
    await m1.driver.findByTestID('sol-req-qr', {timeoutMs: 5000});
    const reqBody = m1.driver.bodyText();
    expect(reqBody).not.toMatch(/Received/);
    assertIncludes(reqBody, 'Waiting', 'the SOL request stays open, waiting for its radio/scan-back confirm');

    await m1.unmount();
    await m2.unmount();
  }, 240_000);
});
