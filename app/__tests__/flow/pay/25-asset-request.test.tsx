/**
 * Flows 25 + 28 — the jest twins of `e2e/tests/25-asset-request.mjs` and `e2e/tests/28-ckusdc-request.mjs`
 * (multi-currency merchant-create: the merchant picks the EXACT settlement asset; dpay never swaps).
 *
 * Founder 2026-09-12: the request QR is the payment LINK, so the asserts run on the LINK (asset,
 * network, own principal, NETTED amount = typed price − ledger fee) AND — with the radio forced
 * ready — the 132-byte wire the NFC reader arms with, where the currency-id + byte-exact encode
 * contract lives: ckBTC → currency 1 + 39990 sats (0.0004 − the pinned 10-sat fee); ckUSDC →
 * currency 2 + '40000' raw 6-dec (0.05 − 0.01). The readout names the asset's own units, never a
 * dollar amount.
 */
import {describe, it, expect} from '@jest/globals';
import {
  accountOf, assert, assertEq, DpayCore, onboardWallet, railPrincipalText,
} from '../harness/lib';
import {hexToB64url, parsePayLink, pollReaderRequestHex} from './local';

function nfcReady(): void {
  (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_NFC_STATUS = 'ready';
  // The reader stash is a per-page global in the browser; in jest one file = one globalThis, so a
  // previous test's armed wire would still be stashed here. Clear it before the flow's request.
  delete (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_NFC_READER_REQUEST;
}

function qrLast(): string {
  const v = (globalThis as unknown as Record<string, string>).__DPAY_QR_LAST;
  assert(typeof v === 'string' && v.length > 0, '__DPAY_QR_LAST should hold the request QR value');
  return v;
}

describe('flow 25 — asset-request (ckBTC, currency 1, netted wire)', () => {
  it('ckBTC chip + 0.0004 → link names ckBTC/IC + netted sats; the wire carries currency 1', async () => {
    nfcReady();
    const m = await onboardWallet('jest-merchant25');
    const accountHex = (await accountOf(m))?.publicHex ?? '';

    // Receive → the amount prefix glyph opens the picker → pick ckBTC → type the BTC price.
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.click('req-prefix', {timeoutMs: 4000});
    await m.driver.click('req-pick-ckbtc', {timeoutMs: 4000});
    await m.driver.type('amount-input', '0.0004', {timeoutMs: 4000});
    await m.driver.click('btn-request', {timeoutMs: 4000});
    await m.driver.findByTestID('request-qr', {timeoutMs: 5000});

    // The LINK asserts (exact-price rule: the LEDGER fee is netted OUT of the wire/link).
    const link = parsePayLink(qrLast());
    assert(link !== null, `the request QR must BE the payment link, got "${qrLast()}"`);
    assertEq(link.recipient, await railPrincipalText(accountHex), 'the link must pay THIS wallet’s principal');
    assertEq(link.asset, 'ckBTC', 'the link must name ckBTC');
    assertEq(link.network, 'internet-computer', 'the link must name the settlement chain');
    assertEq(link.amount, '0.0003999', 'the link carries the NETTED wire (40000 price − 10-sat ledger fee)');

    // The WIRE the NFC reader armed with carries the runtime currency id (1 = ckBTC), not 0.
    const req = await DpayCore.decodeRequest(hexToB64url(await pollReaderRequestHex()));
    assertEq(req.currency, 1, 'request should encode currency 1 (ckBTC)');
    assertEq(req.amount, '39990', 'wire request should be the netted 39990 sats');

    // The readout renders the asset's OWN units — never a dollar framing (no-swap rule).
    const body = m.driver.bodyText();
    expect(body).toContain('0.0004 BTC');
    expect(body).not.toContain('$0.40');

    await m.unmount();
  }, 120_000);
});

describe('flow 28 — ckusdc-request (currency 2, 6-decimal, netted wire)', () => {
  it('ckUSDC chip + 0.05 → link names ckUSDC/IC + netted 0.04; the wire is a byte-exact integer', async () => {
    nfcReady();
    const m = await onboardWallet('jest-merchant28');
    const accountHex = (await accountOf(m))?.publicHex ?? '';

    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.click('req-prefix', {timeoutMs: 4000});
    await m.driver.click('req-pick-ckusdc', {timeoutMs: 4000});
    await m.driver.type('amount-input', '0.05', {timeoutMs: 4000});
    await m.driver.click('btn-request', {timeoutMs: 4000});
    await m.driver.findByTestID('request-qr', {timeoutMs: 5000});

    const link = parsePayLink(qrLast());
    assert(link !== null, `the request QR must BE the payment link, got "${qrLast()}"`);
    assertEq(link.recipient, await railPrincipalText(accountHex), 'the link must pay THIS wallet’s principal');
    assertEq(link.asset, 'ckUSDC', 'the link must name ckUSDC');
    assertEq(link.network, 'internet-computer', 'the link must name the settlement chain');
    assertEq(link.amount, '0.04', 'the link carries the netted wire (price 0.05 − fee 0.01)');

    const req = await DpayCore.decodeRequest(hexToB64url(await pollReaderRequestHex()));
    assertEq(req.currency, 2, 'request should encode currency 2 (ckUSDC)');
    assertEq(req.amount, '40000', 'request amount should be 40000 raw (the netted 0.040000 USDC wire)');
    expect(req.amount).not.toContain('.'); // byte-exact discipline: no float artifact

    // The readout headlines the typed price (6-decimal zero-padded, backing_symbol suffix) + the
    // fee line — no "$0.05" (fmtCurrencyAmount uses the unit suffix, never the $ glyph).
    const body = m.driver.bodyText();
    expect(body).toContain('0.05 USDC');
    expect(body).not.toContain('$0.05');
    expect(body).toContain('you receive 0.04 USDC');

    await m.unmount();
  }, 120_000);
});
