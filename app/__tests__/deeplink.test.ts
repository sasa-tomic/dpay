/**
 * Unit tests for the pure `dpay:` deeplink codec (item 6). A merchant's request QR carries a raw
 * base64url blob; the deeplink wraps it as `dpay:req/<blob>` so it can be shared over a messaging
 * app + opened on the payer's phone. The codec is pure (no React/native deps beyond the file's
 * existing `Platform` import, which the jest preset mocks) so it runs on the fast inner loop.
 *
 * The blob is the EXACT base64url the QR already carries — no new wire format. Version lives inside
 * the blob. Slash-not-query so URL libs don't mangle `+`/`%`.
 *
 * Also covers the `dpay:pay/` receipt-handback codec (`encodeReceiptDeeplink`/`decodeReceiptDeeplink`)
 * where `<blob>` = base64url(JSON.stringify(receipt)) — DIFFERENT from `req`'s raw base64url, but the
 * `pay` handler base64url-decodes THEN JSON.parses. And the web `?pay=` reader (`readPaymentDeeplink`).
 */
import {describe, it, expect, beforeEach, afterEach} from '@jest/globals';
import {Platform} from 'react-native';
import {
  encodeDeeplink,
  decodeDeeplink,
  encodeReceiptDeeplink,
  decodeReceiptDeeplink,
  readRequestDeeplink,
  readPaymentDeeplink,
} from '../lib/deepLink';

// A realistic canister-signed receipt object (the shape the relay's POST /api/v1/pay returns under
// `body.receipt`). Every protocol-u64 field is a decimal STRING (MC1 units 2-4 — lossy above 2^53).
const SAMPLE_RECEIPT = {
  nonce: 'aabbccdd11223344',
  from: '1b8a5ee7'.repeat(8),
  to: 'deadbeef'.repeat(8),
  amount: '2500',
  currency: 0,
  block_index: '123456',
  settle_ts: '1700000000',
  receipt_sig: 'ff'.repeat(64),
  pubkey: 'ee'.repeat(32),
};

describe('encodeDeeplink', () => {
  it('wraps a req blob in dpay:req/', () => {
    expect(encodeDeeplink('req', 'abc')).toBe('dpay:req/abc');
  });
  it('wraps a pay blob in dpay:pay/', () => {
    expect(encodeDeeplink('pay', 'xyz')).toBe('dpay:pay/xyz');
  });
});

describe('decodeDeeplink', () => {
  it('parses dpay:req/<blob>', () => {
    expect(decodeDeeplink('dpay:req/abc')).toEqual({kind: 'req', blob: 'abc'});
  });
  it('parses dpay:pay/<blob>', () => {
    expect(decodeDeeplink('dpay:pay/xyz')).toEqual({kind: 'pay', blob: 'xyz'});
  });

  it('round-trips a req blob', () => {
    const blob = 'aB3-_xY9'; // base64url chars incl - and _
    expect(decodeDeeplink(encodeDeeplink('req', blob))).toEqual({kind: 'req', blob});
  });
  it('round-trips a pay blob (codec symmetric)', () => {
    const blob = 'Zm9vYmFy'; // "foobar" base64url
    expect(decodeDeeplink(encodeDeeplink('pay', blob))).toEqual({kind: 'pay', blob});
  });

  it('preserves base64url - and _ characters in the blob (no mangling)', () => {
    const blob = 'Aa-_Bb-_Cc-_Dd-_';
    expect(decodeDeeplink(`dpay:req/${blob}`)?.blob).toBe(blob);
  });

  it('null for a non-dpay string', () => {
    expect(decodeDeeplink('not a dpay link')).toBeNull();
  });
  it('null for an http URL (the web ?req= path is handled separately, not by the codec)', () => {
    expect(decodeDeeplink('https://dpay.kalaj.org/?req=abc')).toBeNull();
  });
  it('null for an empty blob', () => {
    expect(decodeDeeplink('dpay:req/')).toBeNull();
  });
  it('null for an unknown kind', () => {
    expect(decodeDeeplink('dpay:foo/abc')).toBeNull();
  });
  it('null for a missing slash', () => {
    expect(decodeDeeplink('dpay:req')).toBeNull();
  });
  it('null for an empty kind (leading slash)', () => {
    expect(decodeDeeplink('dpay:/abc')).toBeNull();
  });
  it('null for an empty string', () => {
    expect(decodeDeeplink('')).toBeNull();
  });
  it('null for just the scheme', () => {
    expect(decodeDeeplink('dpay:')).toBeNull();
  });
  it('is case-sensitive on the scheme (DPAY: rejected)', () => {
    expect(decodeDeeplink('DPAY:req/abc')).toBeNull();
  });
});

// --- receipt-handback codec (dpay:pay/<base64url(JSON)>) --------------------------------------

describe('encodeReceiptDeeplink', () => {
  it('wraps a receipt as dpay:pay/<blob>', () => {
    const uri = encodeReceiptDeeplink(SAMPLE_RECEIPT);
    expect(uri.startsWith('dpay:pay/')).toBe(true);
    // The blob is base64url (charset + no padding), NOT the raw JSON.
    const blob = uri.slice('dpay:pay/'.length);
    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(blob).not.toContain('=');
    expect(blob).not.toContain('{'); // JSON must be base64url-encoded, not plaintext
  });
  it('the blob is NOT the raw receipt JSON (it is base64url-encoded)', () => {
    const uri = encodeReceiptDeeplink(SAMPLE_RECEIPT);
    expect(uri).not.toContain(SAMPLE_RECEIPT.from);
    expect(uri).not.toContain('"amount"');
  });
});

describe('decodeReceiptDeeplink', () => {
  it('round-trips a full receipt object (every field preserved)', () => {
    const uri = encodeReceiptDeeplink(SAMPLE_RECEIPT);
    const back = decodeReceiptDeeplink(uri.slice('dpay:pay/'.length));
    expect(back).toEqual(SAMPLE_RECEIPT);
  });
  it('preserves large decimal-string amounts (BigInt-safe, no Number coercion)', () => {
    const big = {...SAMPLE_RECEIPT, amount: '18446744073709551615'}; // u64 max
    const back = decodeReceiptDeeplink(encodeReceiptDeeplink(big).slice('dpay:pay/'.length));
    expect(back).toEqual(big);
    expect((back as typeof big).amount).toBe('18446744073709551615');
  });
  it('preserves unicode in string fields', () => {
    const r = {...SAMPLE_RECEIPT, memo: 'café ☕ ₿'};
    const back = decodeReceiptDeeplink(encodeReceiptDeeplink(r).slice('dpay:pay/'.length));
    expect(back).toEqual(r);
  });
  it('round-trips via the full encodeDeeplink/decodeDeeplink too (kind=pay blob)', () => {
    // The blob is opaque to decodeDeeplink; decodeReceiptDeeplink takes that blob + JSON-parses.
    const uri = encodeReceiptDeeplink(SAMPLE_RECEIPT);
    const dl = decodeDeeplink(uri);
    expect(dl?.kind).toBe('pay');
    expect(decodeReceiptDeeplink(dl!.blob)).toEqual(SAMPLE_RECEIPT);
  });
  it('returns null on an empty string', () => {
    expect(decodeReceiptDeeplink('')).toBeNull();
  });
  it('returns null on garbage (not base64url)', () => {
    expect(decodeReceiptDeeplink('@@@not-base64@@@')).toBeNull();
  });
  it('returns null on base64url that is not valid JSON', () => {
    // "abc" is valid base64url but decodes to non-JSON bytes.
    expect(decodeReceiptDeeplink('abc')).toBeNull();
  });
});

// --- web query-param readers (?req= / ?pay=) -------------------------------------------------
// The readers are Platform.OS-gated: null on native, read location.search on web. The RN jest preset
// defaults Platform.OS to 'ios'; these tests flip it to 'web' + stub location.search, then restore.

const origOS = Platform.OS;
afterEach(() => { Platform.OS = origOS; });

describe('readPaymentDeeplink (web ?pay= reader)', () => {
  beforeEach(() => {
    Platform.OS = 'web';
  });
  it('reads a ?pay=<blob> param on web', () => {
    const w = globalThis as unknown as {location?: {search?: string}};
    w.location = {search: '?pay=eyJmb28iOiJiYXIifQ'}; // base64url({"foo":"bar"})
    try {
      expect(readPaymentDeeplink()).toBe('eyJmb28iOiJiYXIifQ');
    } finally { delete w.location; }
  });
  it('returns null when no ?pay= is present', () => {
    const w = globalThis as unknown as {location?: {search?: string}};
    w.location = {search: '?req=abc'};
    try {
      expect(readPaymentDeeplink()).toBeNull();
    } finally { delete w.location; }
  });
  it('returns null for an empty ?pay=', () => {
    const w = globalThis as unknown as {location?: {search?: string}};
    w.location = {search: '?pay='};
    try {
      expect(readPaymentDeeplink()).toBeNull();
    } finally { delete w.location; }
  });
  it('returns null on native (Platform.OS !== web)', () => {
    Platform.OS = 'ios';
    const w = globalThis as unknown as {location?: {search?: string}};
    w.location = {search: '?pay=abc'};
    try {
      expect(readPaymentDeeplink()).toBeNull();
    } finally { delete w.location; }
  });
});

describe('readRequestDeeplink (web ?req= reader — mirror, regression guard)', () => {
  beforeEach(() => {
    Platform.OS = 'web';
  });
  it('reads a ?req=<blob> param on web', () => {
    const w = globalThis as unknown as {location?: {search?: string}};
    w.location = {search: '?req=abc-_XY9'};
    try {
      expect(readRequestDeeplink()).toBe('abc-_XY9');
    } finally { delete w.location; }
  });
  it('returns null on native', () => {
    Platform.OS = 'android';
    const w = globalThis as unknown as {location?: {search?: string}};
    w.location = {search: '?req=abc'};
    try {
      expect(readRequestDeeplink()).toBeNull();
    } finally { delete w.location; }
  });
});
