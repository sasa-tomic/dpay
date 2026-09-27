/**
 * Flow 06 request-qr — the jest twin of `e2e/tests/06-request-qr.mjs` (M1 port: proves the QR
 * capture seam `__DPAY_QR_LAST`, the Share recorder, and the NFC reader wire in one flow).
 *
 * Merchant enters an amount → the request QR renders the payment LINK (own principal, exact
 * asset/chain/amount/label, ref = the request nonce); Share carries the SAME string; and with the
 * NFC radio forced ready, the reader arms with the REAL 132-byte request — decoded here
 * field-for-field by the app's own wasm core (DpayCore.decodeRequest).
 */
import {describe, it, expect} from '@jest/globals';
import {
  accountOf, assertEq, assertIncludes, DpayCore, onboardSlowPath, selectDemoAsset, waitForWallet,
} from '../harness/lib';
import {mountApp} from '../harness/mount';

const EXPIRY_WINDOW_SLACK = 1000; // EXPIRY_WINDOW=900 + a few seconds of test latency

type Link = {
  recipient: string; asset: string; network: string; amount: string;
  label: string; memo: string; ref: string | null;
};

/** e2e/harness/paylink.mjs parsePayLink twin — app/lib/deepLink.ts encodePayLink is the grammar's
 *  source of truth; this mirrors just enough for the flow to assert what a payer camera opens. */
function parsePayLink(url: string): Link | null {
  let u: URL;
  try {
    u = new URL(url, 'https://dpay.invalid');
  } catch {
    return null;
  }
  const match = u.pathname.match(/^\/wallet\/pay\/([^/?#]+)$/);
  if (!match) return null;
  return {
    recipient: decodeURIComponent(match[1]),
    asset: u.searchParams.get('asset') ?? '',
    network: u.searchParams.get('network') ?? '',
    amount: u.searchParams.get('amount') ?? '',
    label: u.searchParams.get('label') ?? '',
    memo: u.searchParams.get('memo') ?? '',
    ref: u.searchParams.get('ref'),
  };
}

const g = globalThis as unknown as Record<string, unknown>;

/** The reader seam carries HEX (the Android radio form); the core's decoder eats base64url. */
function hexToB64url(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('flow 06 — request QR: the link IS the code, Share agrees, the radio carries the wire', () => {
  it('renders the payment link QR, Share-matches it, and arms the reader with the real request', async () => {
    // Force the radio ready BEFORE the wallet mounts so the request also builds the NFC machine
    // code and arms reader mode (the wire's only exit from the screen now).
    g.__DPAY_TEST_NFC_STATUS = 'ready';
    const m = await mountApp();
    await onboardSlowPath(m, 'jest-bob');
    await waitForWallet(m, {timeoutMs: 10_000});
    // The e2e onboarding contract ends on DEMO (the flow-06 subject is the DEMO request) — the
    // create path lands on the home currency's rail, so select DEMO explicitly.
    await selectDemoAsset(m);
    const identity = await accountOf(m);
    const accountHex = identity?.publicHex ?? '';
    expect(accountHex).toHaveLength(64);

    // Receive → amount → request.
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.type('amount-input', '42.50', {timeoutMs: 4000});
    await m.driver.click('btn-request', {timeoutMs: 4000});
    await m.driver.findByTestID('request-qr', {timeoutMs: 5000});

    // The concise offline-payer affordance + help-text (L4 + D5).
    const reqBody = m.driver.bodyText();
    expect(reqBody).toMatch(/Scan the payer's signed code/i);
    expect(reqBody).toMatch(/paid without scanning/i);
    expect(reqBody).toMatch(/confirm with their phone/i);

    // The QR value — read through the SAME seam the e2e shim writes — parses as the pay link.
    const qrValue = g.__DPAY_QR_LAST as string;
    expect(typeof qrValue).toBe('string');
    expect(qrValue.length).toBeGreaterThan(0);
    const link = parsePayLink(qrValue);
    expect(link).not.toBeNull();
    const selfPrincipal = await DpayCore.icpSelfPrincipal(identity!.secretHex);
    assertEq(link!.recipient, selfPrincipal, 'the link must pay THIS wallet (principal derived by the real core)');
    assertEq(link!.asset, 'DEMO', 'the link names the exact asset');
    assertEq(link!.network, 'internet-computer', 'the link names the settlement chain');
    assertEq(link!.amount, '42.50', 'the link carries the entered amount, unrounded');
    assertEq(link!.label, 'jest-bob', 'the link carries the merchant username as the label');
    assertEq(link!.memo, '', 'no memo entered → the link omits it');
    expect(link!.ref ?? '').toMatch(/^[0-9a-f]{32}$/);

    // The 15-minute countdown (U-F3).
    expect(reqBody).toMatch(/Valid for ~1[0-9] min/);

    // Share carries the SAME string the QR renders (one payment, one code) — captured through the
    // harness's Share recorder (__DPAY_TEST_CLIPBOARD, the seam spec 1.2 names).
    g.__DPAY_TEST_CLIPBOARD = '';
    await m.driver.click('btn-share-request', {timeoutMs: 5000});
    const shared = g.__DPAY_TEST_CLIPBOARD as string;
    expect(shared.length).toBeGreaterThan(0);
    assertEq(shared, qrValue, 'Share must carry the SAME string the QR renders');

    // The machine code survives on the radio: the reader armed with the REAL 132-byte request
    // (stashed by the shim on __DPAY_TEST_NFC_READER_REQUEST), decoded by the app's own core.
    let readerHex: string | null = null;
    for (let i = 0; i < 100 && !readerHex; i++) {
      readerHex = (g.__DPAY_TEST_NFC_READER_REQUEST as string | undefined) ?? null;
      if (!readerHex) await new Promise((r) => setTimeout(r, 50));
    }
    expect(typeof readerHex).toBe('string');
    expect(readerHex!.length).toBeGreaterThan(0);
    const req = await DpayCore.decodeRequest(hexToB64url(readerHex!));
    const now = Math.floor(Date.now() / 1000);
    const expiry = Number(req.expiry); // u64 crosses the wasm boundary as a decimal string
    assertEq(req.toHex, accountHex, 'wire.to == this wallet account');
    assertEq(req.amount, '4250', 'wire.amount == entered 42.50 in minor units');
    expect(expiry).toBeGreaterThan(now);
    expect(expiry).toBeLessThan(now + EXPIRY_WINDOW_SLACK);
    assertEq(req.currency, 0, 'wire.currency == DEMO (the wallet `$` asset)');
    assertEq(req.toName, 'jest-bob', 'wire.to_name == the merchant username');
    assertEq(req.memo, '', 'wire.memo == empty');
    assertEq(req.nonceHex, link!.ref, 'the wire nonce and the link ref are the SAME 16 bytes');

    await m.unmount();
  }, 90_000);
});
