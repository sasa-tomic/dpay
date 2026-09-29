/**
 * Flow 91 coach-tips — the jest twin of `e2e/tests/91-coach-tips.mjs`. (CoachTip.test.tsx pins the
 * component; this ports the live first-run coaching walk over the real wallet.)
 *
 * First-use coaching is anchored, dismissible, and remembered: receiveRequest shows at the Receive
 * entry and stays dismissed; the payment review carries NO tip (the retired payReview must stay
 * gone); offlineQr + pendingOutcome coach the offline hand-off exactly once; and the money path
 * settles + reconciles right through the coaching. All three seen-markers persist on the identity
 * with the stamps intact.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  accountOf, assertIncludes, DpayCore, faucetAccount, generateKeypair, getBalance,
  goOffline, icpCatalog, onboardWallet, openBalances, railPrincipalText, waitForScanner,
} from '../harness/lib';
import {relayBaseURL} from '../harness/relayClient';

const g = globalThis as unknown as Record<string, unknown> & {__DPAY_TEST_SCAN?: (qr: string) => void};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = require('@react-native-async-storage/async-storage') as {getItem: (k: string) => Promise<string | null>};

const PAY_CENTS = 2500; // ∂25.00

function randNonceHex(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

import type {Driver} from '../harness/driver';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

/** The card's rise+fade entrance — under react-test-renderer there are no frames, so "at rest" is
 *  two identical text snapshots (the driver's waitAtRest contract). */
const settle = (d: Driver, key: string): Promise<void> => d.waitAtRest(`coach-${key}`, {timeoutMs: 8000});

hermeticDescribe('flow 91 — coach-tips', () => {
  it('receiveRequest shown once; the pay review carries no tip; the offline hand-off coached once; money settles through it all', async () => {
    const m = await onboardWallet('coach');
    const alice = await accountOf(m);
    const bob = await generateKeypair();
    await faucetAccount(bob.publicHex, 10_000);
    expect(alice).not.toBeNull();

    // --- receiveRequest: mounts at the Receive ENTRY form; dismiss persists across re-entry -----
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.findByTestID('coach-receiveRequest', {timeoutMs: 6000});
    await m.driver.type('amount-input', '42.50', {timeoutMs: 4000});
    await m.driver.click('btn-request', {timeoutMs: 4000});
    await m.driver.findByTestID('request-qr', {timeoutMs: 8000});
    // The phase flip re-mounts the tip's instance (its journey gate renders nothing while
    // 'checking') — re-find it, then let its entrance come to rest.
    await m.driver.findByTestID('coach-receiveRequest', {timeoutMs: 6000});
    await settle(m.driver, 'receiveRequest');
    await m.driver.click('btn-coach-receiveRequest-dismiss', {timeoutMs: 4000});
    await m.driver.waitGone('coach-receiveRequest', {timeoutMs: 6000});
    // Re-enter the same phase (fresh request) → the tip stays dismissed. The Pay leg is WAITED
    // FOR, not assumed: a second tab press before the first took effect leaves Receive mounted.
    await m.driver.click('tab-pay', {timeoutMs: 4000});
    await m.driver.findByTestID('pay-scan', {timeoutMs: 8000});
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.type('amount-input', '10.00', {timeoutMs: 4000});
    await m.driver.click('btn-request', {timeoutMs: 4000});
    await m.driver.findByTestID('request-qr', {timeoutMs: 8000});
    expect(m.driver.isPresent('coach-receiveRequest')).toBe(false);
    await m.driver.click('tab-pay', {timeoutMs: 4000});

    // --- THE PAYMENT REVIEW CARRIES NO TIP AT ALL (the retired payReview, asserted on the
    //     surface it used to occupy, so re-adding it fails here) -------------------------------
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    const payLink = (ref: string): string => `/wallet/pay/${bobPrincipal}?asset=DEMO&network=internet-computer&amount=25&label=bob&ref=${ref}`
      + `&relay=${encodeURIComponent(relayBaseURL())}`;
    await m.remount({url: payLink(randNonceHex())});
    expect(await m.driver.waitForText('Pay ∂25.00', {timeoutMs: 6000})).toBe(true);
    expect(m.driver.isPresent('btn-approve')).toBe(true);
    expect(m.driver.isPresent('coach-payReview')).toBe(false);
    await m.driver.click('btn-review-cancel', {timeoutMs: 4000});

    // --- offlineQr + pendingOutcome: the offline hand-off, coached exactly once ----------------
    //     (The camera scan AUTO-SIGNS while offline — no review, no btn-approve.)
    await goOffline(m, {keepGateway: true});
    expect(await m.driver.waitForText('approx.', {timeoutMs: 8000})).toBe(true);
    const req3 = await DpayCore.encodeRequest(bob.publicHex, String(PAY_CENTS), randNonceHex(), Math.floor(Date.now() / 1000) + 600, 0, 'bob', '');
    await waitForScanner(m);
    g.__DPAY_TEST_SCAN!(req3);
    expect(await m.driver.waitForText('signed on this device ✓', {timeoutMs: 10_000})).toBe(true);
    await m.driver.findByTestID('coach-offlineQr', {timeoutMs: 6000});
    await settle(m.driver, 'offlineQr');
    const payload = g.__DPAY_QR_LAST as string;
    expect(typeof payload === 'string' && payload.length >= 64).toBe(true);
    await m.driver.click('btn-coach-offlineQr-dismiss', {timeoutMs: 4000});
    await m.driver.waitGone('coach-offlineQr', {timeoutMs: 6000});

    // Hand to the merchant → the honest-pending view carries pendingOutcome.
    await m.driver.click('btn-paid', {timeoutMs: 4000});
    expect(await m.driver.waitForText('Sent ∂25.00', {timeoutMs: 8000})).toBe(true);
    await m.driver.findByTestID('coach-pendingOutcome', {timeoutMs: 6000});
    await settle(m.driver, 'pendingOutcome');
    await m.driver.click('btn-coach-pendingOutcome-dismiss', {timeoutMs: 4000});
    await m.driver.waitGone('coach-pendingOutcome', {timeoutMs: 6000});

    // --- the money path never cared: counterparty submits, payer reconciles to Paid ------------
    const envelopeBytes = b64urlToBytes(payload);
    const catalog = await icpCatalog();
    const ledger = catalog.find((c) => c.currency === 0)?.ledger;
    expect(ledger).toBeTruthy();
    const submitted = await fetch(`${relayBaseURL()}/api/v2/canister/${ledger}/call`, {
      method: 'POST',
      headers: {'Content-Type': 'application/cbor'},
      body: envelopeBytes as unknown as Parameters<typeof fetch>[1] extends {body?: infer B} ? B : never,
    });
    expect(submitted.status).toBe(202);
    expect(await getBalance(bob.publicHex, 0)).toBe('12500');
    // The payer's own ledger truth: debited 100 − 25 (the flow's hard oracle — the relay, not a
    // screen). (GAP vs the browser twin, filed for the integrator: the twin additionally reads a
    // 'Paid' headline flip on the payer's card and the pending-record retirement — but PayMode's
    // settle-watch lives ONLY on the hand-off QR screen (phase==='qr', PayMode.tsx ~543); after
    // btn-paid the card is honestly 'Sent · awaiting', and the Wallet's history join polls the
    // SELECTED currency, not DEMO. Flow 20's twin (no btn-paid press) is what proves the
    // QR-screen flip.)
    expect(await getBalance(alice!.publicHex, 0)).toBe('7500');
    // The confirmed state stays coach-free: the dismissed pending tip never re-mounts.
    expect(m.driver.isPresent('coach-pendingOutcome')).toBe(false);
    expect(m.driver.isPresent('coach-offlineQr')).toBe(false);
    // New payment releases the surface; the payer's balance reflects the debit on the accounts route.
    await m.driver.click('btn-new', {timeoutMs: 8000});
    await m.driver.findByTestID('pay-scan', {timeoutMs: 8000});
    await openBalances(m);
    expect(await m.driver.waitForText('∂75.00', {timeoutMs: 10_000})).toBe(true);

    // --- all three seen-markers persisted on this identity --------------------------------------
    const journey = (await AsyncStorage.getItem('dpay.journey.v1')) ?? '';
    for (const key of ['receiveRequest', 'offlineQr', 'pendingOutcome']) {
      assertIncludes(journey, `"${key}"`, `seen-marker "${key}" persisted`);
    }
    expect(journey.includes('"payReview"')).toBe(false);
    assertIncludes(journey, '"recoverySaved"', 'recoverySaved stamp rode along untouched');

    await m.unmount();
  }, 120_000);
});
