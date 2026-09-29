/**
 * Flow 59 — the jest twin of `e2e/tests/59-share-receipt.mjs` (the `btn-share-receipt` hand-back).
 *
 * When the payer settles ONLINE, the Paid screen holds the canister receipt and renders
 * `btn-share-receipt` → `Share.share({message: shareReceipt(paid.receipt!)})`. On web the payload
 * is an OPENABLE `<origin>/wallet?pay=<base64url>` URL. The harness Share recorder captures the
 * message into `__DPAY_TEST_CLIPBOARD` (the jest seam name — the browser twin is
 * `__DPAY_TEST_SHARE`; same recorder semantics). Asserts the button only renders on a fresh online
 * settle, the share payload is a `/wallet?pay=` URL with a base64url blob, the label flips to
 * "Link copied ✓", and the blob decodes to the rail proof {ledger, block_index, request_id}.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  armPayScan, assert, DpayCore, generateKeypair, icpCatalog, onboardWallet,
} from '../harness/lib';
import {scanSeam} from './local';

const PAY_CENTS = '2500'; // ∂25.00 (DEMO = currency 0)
const MERCHANT_NAME = 'Bob';

hermeticDescribe('flow 59 — share receipt: the online settle’s proof is handed to Share', () => {
  it('btn-share-receipt shares a /wallet?pay= URL whose blob is the rail proof', async () => {
    const bob = await generateKeypair();
    const m = await onboardWallet('jest-alice');

    // B's request QR: to=B, ∂25, fresh nonce, +10min expiry, currency 0.
    const nonce = 'cd'.repeat(16);
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = await DpayCore.encodeRequest(bob.publicHex, PAY_CENTS, nonce, expiry, 0, MERCHANT_NAME, '');

    // A scans → AUTO-SIGN → online settle → "Paid" + a fresh receipt.
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(requestQR);
    assert(await m.driver.waitForText('Paid', {timeoutMs: 10_000}),
      'payer should reach the Paid screen straight from the scan');

    // btn-share-receipt renders ONLY because the online settle captured a receipt.
    await m.driver.findByTestID('btn-share-receipt', {timeoutMs: 5000});

    // Tap → the recorder captures Share.share's message; the label flips to "Link copied ✓" (U-F1).
    await m.driver.click('btn-share-receipt', {timeoutMs: 5000});
    assert(await m.driver.waitForText('Link copied ✓', {timeoutMs: 4000}),
      'btn-share-receipt should flip its label to "Link copied ✓"');

    const shared = (globalThis as unknown as Record<string, string>).__DPAY_TEST_CLIPBOARD as string;
    assert(typeof shared === 'string' && shared.length > 0, 'the Share recorder should have captured a message');
    const url = new URL(shared);
    expect(url.pathname).toBe('/wallet');
    const blob = url.searchParams.get('pay') ?? '';
    expect(blob.length).toBeGreaterThan(0);
    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/);

    // The blob JSON-decodes to the post-W8 rail proof {ledger, block_index, request_id}.
    const decoded = JSON.parse(Buffer.from(blob, 'base64url').toString('utf8')) as {request_id: string; ledger: string; block_index: string};
    expect(decoded.request_id).toMatch(/^[0-9a-f]{64}$/);
    const catalog = await icpCatalog();
    const ledger0 = catalog.find((c) => c.currency === 0)?.ledger;
    expect(decoded.ledger).toBe(ledger0);
    expect(decoded.block_index).toMatch(/^\d+$/);

    await m.unmount();
  }, 120_000);
});
