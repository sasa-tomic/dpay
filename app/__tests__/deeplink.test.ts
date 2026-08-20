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
  receiptShareBlob,
  shareHandoff,
  readRequestDeeplink,
  readPaymentDeeplink,
  parseRailProof,
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

// A realistic rail proof (the post-cutover dpay:pay/ payload — {ledger, block_index, request_id},
// derived by the payer's phone after read_state confirms its envelope settled).
const SAMPLE_PROOF = {
  ledger: 'w7x7r-c3z3l-…', // principal text (abridged in tests — the format gate doesn't check it)
  block_index: '123456',
  request_id: 'ab'.repeat(32), // 64-hex = the 32-byte request_id of the payer's envelope
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

// --- shareHandoff: web shares an OPENABLE /wallet?… URL, native keeps the dpay: scheme ---------

describe('shareHandoff', () => {
  const withWebLocation = (origin: string, fn: () => void) => {
    Platform.OS = 'web';
    const w = globalThis as unknown as {location?: {origin?: string; search?: string}};
    w.location = {origin, search: ''};
    try { fn(); } finally { delete w.location; }
  };
  it('on web, builds an openable /wallet?req= URL (origin from location)', () => {
    withWebLocation('https://dpay.kalaj.org', () => {
      const s = shareHandoff('req', 'aB3-_xY9');
      expect(s).toBe('https://dpay.kalaj.org/wallet?req=aB3-_xY9');
      expect(new URL(s).searchParams.get('req')).toBe('aB3-_xY9');
    });
  });
  it('on web, builds /wallet?pay=<blob> and the blob matches receiptShareBlob', () => {
    withWebLocation('https://dpay.kalaj.org', () => {
      const blob = receiptShareBlob(SAMPLE_RECEIPT);
      const s = shareHandoff('pay', blob);
      const u = new URL(s);
      expect(u.pathname).toBe('/wallet');
      expect(u.searchParams.get('pay')).toBe(blob);
      expect(decodeReceiptDeeplink(u.searchParams.get('pay')!)).toEqual(SAMPLE_RECEIPT);
    });
  });
  it('on web with no location, still emits a relative /wallet?… URL (openable same-origin)', () => {
    Platform.OS = 'web';
    expect(shareHandoff('req', 'abc')).toBe('/wallet?req=abc');
  });
  it('on native, keeps the canonical dpay: URI (the app owns the scheme)', () => {
    Platform.OS = 'android';
    expect(shareHandoff('req', 'abc')).toBe('dpay:req/abc');
    expect(shareHandoff('pay', 'xyz')).toBe('dpay:pay/xyz');
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

// --- rail-proof FORMAT gate (parseRailProof — F2/F6, 2026-08-20) ------------------------------
// The dpay:pay/ blob is UNTRUSTED: parseRailProof is the pure format gate the merchant's screen
// applies BEFORE binding the proof to its open request. A non-null result means "well-formed,
// still unverified" — the settlement poll confirms on-chain. This is the forgery surface: a
// random-but-well-formed request_id must pass the FORMAT gate (that is correct — the point is
// that format alone can no longer flip the UI to Received; only read_state can).

describe('parseRailProof (format gate of the dpay:pay hand-back)', () => {
  it('accepts a well-formed proof and echoes request_id/block_index', () => {
    expect(parseRailProof(SAMPLE_PROOF)).toEqual({
      request_id: 'ab'.repeat(32),
      block_index: '123456',
      ledger: 'w7x7r-c3z3l-…',
    });
  });
  it('accepts a FORGED-but-well-formed proof (random rid) — format-valid ≠ verified', () => {
    const forged = {request_id: '00ff'.repeat(16), block_index: '0', ledger: 'x'};
    // The format gate passes it; the COMPONENT test (ReceiveMode) proves it can't flip the UI.
    expect(parseRailProof(forged)).not.toBeNull();
  });
  it('round-trips through the full codec: encodeReceiptDeeplink → decodeReceiptDeeplink → parseRailProof', () => {
    const blob = encodeReceiptDeeplink(SAMPLE_PROOF).slice('dpay:pay/'.length);
    expect(parseRailProof(decodeReceiptDeeplink(blob))).toEqual({
      request_id: SAMPLE_PROOF.request_id,
      block_index: SAMPLE_PROOF.block_index,
      ledger: SAMPLE_PROOF.ledger,
    });
  });
  it('null on null / non-object input', () => {
    expect(parseRailProof(null)).toBeNull();
  });
  it('null when request_id is not 64-hex (too short)', () => {
    expect(parseRailProof({...SAMPLE_PROOF, request_id: 'ab'.repeat(31)})).toBeNull();
  });
  it('null when request_id is not hex', () => {
    expect(parseRailProof({...SAMPLE_PROOF, request_id: 'zz'.repeat(32)})).toBeNull();
  });
  it('null when request_id is not a string (a number is malformed)', () => {
    expect(parseRailProof({...SAMPLE_PROOF, request_id: 123} as unknown as Record<string, unknown>)).toBeNull();
  });
  it('null when block_index is missing', () => {
    expect(parseRailProof({request_id: 'ab'.repeat(32)})).toBeNull();
  });
  it('null when block_index is not digits (hex/negative/float rejected)', () => {
    expect(parseRailProof({...SAMPLE_PROOF, block_index: '12ab'})).toBeNull();
    expect(parseRailProof({...SAMPLE_PROOF, block_index: '-1'})).toBeNull();
    expect(parseRailProof({...SAMPLE_PROOF, block_index: '1.5'})).toBeNull();
  });
  it('null when block_index is a number, not a decimal string', () => {
    expect(parseRailProof({...SAMPLE_PROOF, block_index: 42} as unknown as Record<string, unknown>)).toBeNull();
  });
  it('accepts block_index 0 (the ledger genesis edge — digits-only is the contract)', () => {
    expect(parseRailProof({...SAMPLE_PROOF, block_index: '0'})?.block_index).toBe('0');
  });
  it('ledger is optional (absent ledger still parses — the open request owns routing)', () => {
    const {ledger, ...noLedger} = SAMPLE_PROOF;
    void ledger;
    const out = parseRailProof(noLedger);
    expect(out?.request_id).toBe(SAMPLE_PROOF.request_id);
    expect(out?.ledger).toBeUndefined();
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
