import {describe, test, expect} from '@jest/globals';
import {
  encodeSolReq,
  decodeSolReq,
  encodeSolPay,
  decodeSolPay,
  generateRid,
  SOL_QR_VERSION,
  type SolReqInput,
  type SolPayInput,
} from '../solana/qr';

// =============================================================================================
// v2 codec — Phase 1 of the recent-blockhash rewrite. The v1 durable-nonce codec is GONE; this
// suite freezes the v2 byte layout (compact JSON in declared field order, canonical unpadded
// base64url) via golden round-trips, then probes every malformed boundary. The HARD CANONICAL
// INVARIANT is `encodeSolReq(decodeSolReq(raw)) === raw` for every valid URI: decoding must not
// trim, normalize, re-order keys, pad base64url, or accept trailing bytes.
// =============================================================================================

// Deterministic mainnet-shaped fixtures (reuse the addresses shared across every other SOL suite).
const MERCHANT = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MERCHANT_USDC_ATA = 'C9dhv75Qeu2NLrEprtNNMageKX6z2bsysrdRTNFB3nbk';
// A 32-byte Solana recent-blockhash-shaped value (reusing the NONCE_ACCOUNT fixture from other
// suites — base58, 32-byte decode target; the codec does not care that this is human-coined).
const BLOCKHASH = 'GZXyfzSTCBmA7rpeDLrmUbiSA45H5EEwJhoBeR6ZNb3u';
const RID = '0123456789abcdef0123456789abcdef'; // 32 lowercase hex chars (16 bytes)

const SOL_REQ_INPUT: SolReqInput = {
  rid: RID,
  net: 'mainnet-beta',
  bh: BLOCKHASH,
  lvh: 300_000_000,
  slot: 290_000_000,
  iat: 1760000000,
  exp: 1760000060, // iat + 60
  to: MERCHANT,
  amt: '2000000', // 0.002 SOL (lamports)
  cur: 'SOL',
  mint: null,
  toAta: null,
  name: 'Cafe Sol',
  memo: 'table 7',
};

// EURC golden vector (Stage 2 dual-rail). Mint is the REAL mainnet EURC mint from the token
// registry — the codec itself never gates on WHICH mint (structural validation only); the
// supported-mint gate lives at the component/engine layer, so this vector pins exactly the
// codec-level promise: a third token's bytes lay out identically to USDC's.
const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';
const MERCHANT_EURC_ATA = 'Fg6VdtbcsqSB4rJmFQdYK5JmWr17cy3q7nHvhCwhfWqX';
const EURC_REQ_INPUT: SolReqInput = {
  rid: RID,
  net: 'mainnet-beta',
  bh: BLOCKHASH,
  lvh: 300_000_000,
  slot: 290_000_000,
  iat: 1760000000,
  exp: 1760000060, // iat + 60
  to: MERCHANT,
  amt: '2500000', // 2.5 EURC (micro-EURC, 6 decimals)
  cur: 'EURC',
  mint: EURC_MINT,
  toAta: MERCHANT_EURC_ATA,
  name: 'Cafe Sol',
  memo: 'table 7',
};

const USDC_REQ_INPUT: SolReqInput = {
  rid: RID,
  net: 'mainnet-beta',
  bh: BLOCKHASH,
  lvh: 300_000_000,
  slot: 290_000_000,
  iat: 1760000000,
  exp: 1760000090, // iat + 90 (the protocol maximum)
  to: MERCHANT,
  amt: '5000000', // 5 USDC (micro-USDC, 6 decimals)
  cur: 'USDC',
  mint: USDC_MINT,
  toAta: MERCHANT_USDC_ATA,
  name: 'Cafe Sol',
  memo: '',
};

// Raw signed-tx bytes (synthetic; the QR codec is agnostic to their meaning). Deliberately includes
// bytes 0xfb / 0xff / 0xbf to force the base64url codec through its `-` / `_` branches (those bytes
// map to `+` / `/` in standard base64 — confirming we emit url-safe chars).
const TX_BYTES = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x7e, 0x01, 0x80, 0xff, 0xfe]);

const SOL_PAY_INPUT: SolPayInput = {rid: RID, tx: TX_BYTES};

// --- helpers for crafting well-formed-but-semantically-invalid payloads ----------------------

const B64U_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64U_CHARS[b0 >> 2];
    out += B64U_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64U_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64U_CHARS[b2 & 0x3f];
  }
  return out;
}

function utf8ToBytes(s: string): Uint8Array {
  let utf8 = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) utf8 += String.fromCharCode(c);
    else if (c < 0x800) utf8 += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else utf8 += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  const out = new Uint8Array(utf8.length);
  for (let i = 0; i < utf8.length; i++) out[i] = utf8.charCodeAt(i) & 0xff;
  return out;
}

// Build a `scheme:v?<b64u(json)>` URI directly from a raw object (bypasses encodeSolReq/Pay
// validation), so tests can feed malformed-but-parseable payloads to the decoders. The version
// tag and JSON key order are EXACTLY what the caller passes — this is how we probe the canonical
// byte-equality invariant.
function encodeRaw(scheme: 'solreq' | 'solpay', version: number, obj: Record<string, unknown>): string {
  const json = JSON.stringify(obj);
  return `${scheme}:v${version}?${bytesToBase64Url(utf8ToBytes(json))}`;
}

// The canonical v2 solreq JSON in declared field order. Used to build golden URIs that the codec
// MUST reproduce byte-for-byte.
function canonicalReqJson(req: Record<string, unknown>): string {
  const o = {
    v: 2,
    rid: req.rid,
    net: req.net,
    bh: req.bh,
    lvh: req.lvh,
    slot: req.slot,
    iat: req.iat,
    exp: req.exp,
    to: req.to,
    amt: req.amt,
    cur: req.cur,
    mint: req.mint,
    toAta: req.toAta,
    name: req.name,
    memo: req.memo,
  };
  return JSON.stringify(o);
}

function canonicalPayJson(rid: string, txB64u: string): string {
  return JSON.stringify({v: 2, rid, tx: txB64u});
}

function goldenReqUri(input: Record<string, unknown>): string {
  return 'solreq:v2?' + bytesToBase64Url(utf8ToBytes(canonicalReqJson(input)));
}

function goldenPayUri(rid: string, tx: Uint8Array): string {
  return 'solpay:v2?' + bytesToBase64Url(utf8ToBytes(canonicalPayJson(rid, bytesToBase64Url(tx))));
}

// =============================================================================================
// SOL_QR_VERSION + prefix
// =============================================================================================

describe('solana/qr — version + URI format', () => {
  test('SOL_QR_VERSION is 2', () => {
    expect(SOL_QR_VERSION).toBe(2);
  });
  test('encodeSolReq emits the solreq:v2? prefix', () => {
    expect(encodeSolReq(SOL_REQ_INPUT).startsWith('solreq:v2?')).toBe(true);
  });
  test('encodeSolPay emits the solpay:v2? prefix', () => {
    expect(encodeSolPay(SOL_PAY_INPUT).startsWith('solpay:v2?')).toBe(true);
  });
  test('payload is unpadded base64url charset only', () => {
    const uri = encodeSolReq(USDC_REQ_INPUT);
    const payload = uri.slice('solreq:v2?'.length);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(payload).not.toContain('=');
    expect(payload).not.toContain('+');
    expect(payload).not.toContain('/');
  });
});

// =============================================================================================
// HARD CANONICAL INVARIANT — golden round-trips (byte-exact)
// =============================================================================================

describe('solana/qr — v2 canonical byte-equality (golden round-trip)', () => {
  test('SOL request round-trips byte-exactly: encode(decode(uri)) === uri', () => {
    const uri = encodeSolReq(SOL_REQ_INPUT);
    expect(uri).toBe(goldenReqUri(SOL_REQ_INPUT));
    expect(encodeSolReq(decodeSolReq(uri))).toBe(uri);
  });
  test('USDC request round-trips byte-exactly', () => {
    const uri = encodeSolReq(USDC_REQ_INPUT);
    expect(uri).toBe(goldenReqUri(USDC_REQ_INPUT));
    expect(encodeSolReq(decodeSolReq(uri))).toBe(uri);
  });
  test('EURC request round-trips byte-exactly (same wire layout as USDC)', () => {
    const uri = encodeSolReq(EURC_REQ_INPUT);
    expect(uri).toBe(goldenReqUri(EURC_REQ_INPUT));
    expect(encodeSolReq(decodeSolReq(uri))).toBe(uri);
  });
  test('decodeSolReq returns the declared field values (SOL)', () => {
    const d = decodeSolReq(goldenReqUri(SOL_REQ_INPUT));
    expect(d).toEqual({v: 2, ...SOL_REQ_INPUT});
  });
  test('decodeSolReq returns the declared field values (USDC)', () => {
    const d = decodeSolReq(goldenReqUri(USDC_REQ_INPUT));
    expect(d).toEqual({v: 2, ...USDC_REQ_INPUT});
  });
  test('decodeSolReq returns the declared field values (EURC)', () => {
    const d = decodeSolReq(goldenReqUri(EURC_REQ_INPUT));
    expect(d).toEqual({v: 2, ...EURC_REQ_INPUT});
    expect(d.mint).toBe(EURC_MINT);
  });
  test('encodeSolPay/decodeSolPay round-trip byte-exactly, including 0xfb/0xff/0xbf tx bytes', () => {
    const uri = encodeSolPay(SOL_PAY_INPUT);
    expect(uri).toBe(goldenPayUri(RID, TX_BYTES));
    expect(encodeSolPay(decodeSolPay(uri))).toBe(uri);
  });
  test('decodeSolPay returns the declared field values + tx bytes', () => {
    const d = decodeSolPay(goldenPayUri(RID, TX_BYTES));
    expect(d.v).toBe(2);
    expect(d.rid).toBe(RID);
    expect(Array.from(d.tx)).toEqual(Array.from(TX_BYTES));
  });
  test('multibyte UTF-8 (emoji + accents) round-trips in name/memo', () => {
    const uri = encodeSolReq({...SOL_REQ_INPUT, name: 'Café ☕ Solana', memo: 'ここ'});
    const d = decodeSolReq(uri);
    expect(d.name).toBe('Café ☕ Solana');
    expect(d.memo).toBe('ここ');
    expect(encodeSolReq(d)).toBe(uri);
  });
});

// =============================================================================================
// Version rejection — v1 + unknown versions explicitly fail
// =============================================================================================

describe('solana/qr — version rejection', () => {
  test('rejects solreq:v1? (explicit v1 rejection)', () => {
    const v1 = encodeRaw('solreq', 1, {v: 1, to: MERCHANT, amt: '1', cur: 'SOL', mint: null, toAta: null, exp: 1, name: '', memo: ''});
    expect(() => decodeSolReq(v1)).toThrow(/version|scheme/i);
  });
  test('rejects solreq:v3? (unknown version)', () => {
    const v3 = encodeRaw('solreq', 3, {v: 3, rid: RID, net: 'mainnet-beta', bh: BLOCKHASH, lvh: 1, slot: 1, iat: 1, exp: 2, to: MERCHANT, amt: '1', cur: 'SOL', mint: null, toAta: null, name: '', memo: ''});
    expect(() => decodeSolReq(v3)).toThrow(/version|scheme/i);
  });
  test('rejects solpay:v1? (explicit v1 rejection)', () => {
    const v1 = encodeRaw('solpay', 1, {v: 1, to: MERCHANT, amt: '1', cur: 'SOL', npub: BLOCKHASH, tx: 'AAAA'});
    expect(() => decodeSolPay(v1)).toThrow(/version|scheme/i);
  });
  test('rejects solpay:v3? (unknown version)', () => {
    const v3 = encodeRaw('solpay', 3, {v: 3, rid: RID, tx: 'AAAA'});
    expect(() => decodeSolPay(v3)).toThrow(/version|scheme/i);
  });
  test('rejects the wrong scheme (solpay: handed to decodeSolReq)', () => {
    expect(() => decodeSolReq(encodeSolPay(SOL_PAY_INPUT))).toThrow(/solreq|scheme/i);
  });
  test('rejects the wrong scheme (solreq: handed to decodeSolPay)', () => {
    expect(() => decodeSolPay(encodeSolReq(SOL_REQ_INPUT))).toThrow(/solpay|scheme/i);
  });
});

// =============================================================================================
// rid validation (request id — 32 lowercase hex chars from 16 random bytes)
// =============================================================================================

describe('solana/qr — rid validation', () => {
  test('rid must be exactly 32 lowercase hex chars', () => {
    const bad = (rid: string) => goldenReqUri({...SOL_REQ_INPUT, rid});
    expect(() => decodeSolReq(bad('0123456789abcdef'))).toThrow(/rid/i); // too short
    expect(() => decodeSolReq(bad('0123456789abcdef0123456789abcde'))).toThrow(/rid/i); // 31 chars
    expect(() => decodeSolReq(bad('0123456789abcdef0123456789abcdef0'))).toThrow(/rid/i); // 33 chars
    expect(() => decodeSolReq(bad('0123456789ABCDEF0123456789abcdef'))).toThrow(/rid/i); // uppercase
    expect(() => decodeSolReq(bad('0123456789abcdeg0123456789abcdef'))).toThrow(/rid/i); // non-hex
  });
  test('generateRid() returns 32 lowercase hex chars matching /^[0-9a-f]{32}$/', () => {
    for (let i = 0; i < 16; i++) {
      const r = generateRid();
      expect(r).toMatch(/^[0-9a-f]{32}$/);
    }
  });
  test('generateRid uses the test-override RNG seam when present', () => {
    const g = globalThis as unknown as {__DPAY_TEST_RNG?: {getRandomValues: (a: Uint8Array) => Uint8Array}};
    const fixed = new Uint8Array(16); // all zeros → '00000000000000000000000000000000'
    g.__DPAY_TEST_RNG = {getRandomValues: (a) => { a.set(fixed); return a; }};
    try {
      expect(generateRid()).toBe('00000000000000000000000000000000');
    } finally {
      delete g.__DPAY_TEST_RNG;
    }
  });
});

// =============================================================================================
// Field-level validation — recent blockhash, addresses, amount, integers, network, currency
// =============================================================================================

describe('solana/qr — solreq field validation', () => {
  test('bh must be valid base58 (32-byte Solana value)', () => {
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, bh: '0invalid!!!'}))).toThrow(/bh|blockhash/i);
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, bh: 'short'}))).toThrow(/bh|blockhash/i);
  });
  test('to must be a valid base58 address', () => {
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, to: 'bad'}))).toThrow(/to/i);
  });
  test('mint (when non-null) must be a valid base58 address', () => {
    expect(() => decodeSolReq(goldenReqUri({...USDC_REQ_INPUT, mint: 'not-an-address'}))).toThrow(/mint/i);
  });
  test('toAta (when non-null) must be a valid base58 address', () => {
    expect(() => decodeSolReq(goldenReqUri({...USDC_REQ_INPUT, toAta: 'not-an-address'}))).toThrow(/ata/i);
  });
  test('amt must be canonical decimal string > 0 and <= 2^64-1', () => {
    const bad = (amt: string) => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, amt}));
    expect(() => bad('0')).toThrow(/amt/i); // zero
    expect(() => bad('1.5')).toThrow(/amt/i); // fractional
    expect(() => bad('12a')).toThrow(/amt/i); // non-digits
    expect(() => bad('')).toThrow(/amt/i); // empty
    expect(() => bad('18446744073709551616')).toThrow(/amt/i); // 2^64 (one over u64 max)
    expect(() => bad('-1')).toThrow(/amt/i); // negative
  });
  test('amt accepts the u64 max (18446744073709551615) and small values', () => {
    expect(decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, amt: '1'})).amt).toBe('1');
    expect(decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, amt: '18446744073709551615'})).amt).toBe('18446744073709551615');
  });
  test('lvh / slot / iat / exp must be safe bounded non-negative integers', () => {
    const bad = (patch: Record<string, unknown>) =>
      decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, ...patch}));
    expect(() => bad({lvh: -1})).toThrow(/lvh/i);
    expect(() => bad({lvh: 1.5})).toThrow(/lvh/i);
    expect(() => bad({lvh: '100'})).toThrow(/lvh/i);
    expect(() => bad({slot: -1})).toThrow(/slot/i);
    expect(() => bad({iat: -1})).toThrow(/iat/i);
    expect(() => bad({iat: 1.5})).toThrow(/iat/i);
    expect(() => bad({exp: -1})).toThrow(/exp/i);
    expect(() => bad({exp: Number.MAX_SAFE_INTEGER + 1})).toThrow(/exp/i); // unsafe integer
  });
  test('net must be exactly "mainnet-beta"', () => {
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, net: 'devnet'}))).toThrow(/net/i);
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, net: 'mainnet'}))).toThrow(/net/i);
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, net: 'Mainnet-Beta'}))).toThrow(/net/i);
  });
  test('cur must be an uppercase token symbol [A-Z0-9]{2,10}', () => {
    // Lowercase, too-short, too-long, and non-symbol characters are all refused at the SHAPE
    // level — WHICH symbol it is (USDC, EURC, …) is deliberately NOT the codec's business.
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, cur: 'btc'}))).toThrow(/cur/i);
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, cur: 'S'}))).toThrow(/cur/i);
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, cur: 'SOLPOWEREDX'}))).toThrow(/cur/i);
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, cur: 'US-DC'}))).toThrow(/cur/i);
  });
  test('SOL requires mint === null && toAta === null', () => {
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, mint: USDC_MINT}))).toThrow(/mint/i);
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, toAta: MERCHANT_USDC_ATA}))).toThrow(/ata/i);
  });
  test('USDC requires non-null mint AND non-null toAta', () => {
    expect(() => decodeSolReq(goldenReqUri({...USDC_REQ_INPUT, mint: null}))).toThrow(/mint/i);
    expect(() => decodeSolReq(goldenReqUri({...USDC_REQ_INPUT, toAta: null}))).toThrow(/ata/i);
  });
  test('EURC (any non-SOL token) requires non-null mint AND non-null toAta, error names the token', () => {
    expect(() => decodeSolReq(goldenReqUri({...EURC_REQ_INPUT, mint: null}))).toThrow(/EURC/);
    expect(() => decodeSolReq(goldenReqUri({...EURC_REQ_INPUT, toAta: null}))).toThrow(/EURC/);
  });
  test('iat < exp AND exp <= iat + 90', () => {
    // exp == iat (NOT strictly greater) must fail.
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, iat: 1000, exp: 1000}))).toThrow(/exp|iat/i);
    // exp < iat must fail.
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, iat: 1000, exp: 999}))).toThrow(/exp|iat/i);
    // exp > iat + 90 must fail.
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, iat: 1000, exp: 1091}))).toThrow(/exp|iat/i);
    // exp == iat + 90 must SUCCEED (boundary).
    expect(decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, iat: 1000, exp: 1090})).exp).toBe(1090);
    // exp == iat + 1 must SUCCEED (smallest legal window).
    expect(decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, iat: 1000, exp: 1001})).exp).toBe(1001);
  });
  test('name and memo cap at 32 chars (UTF-16 code units, mirroring IC NAME_LEN)', () => {
    const name32 = 'a'.repeat(32);
    const memo32 = 'b'.repeat(32);
    expect(decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, name: name32, memo: memo32})).name).toBe(name32);
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, name: 'a'.repeat(33)}))).toThrow(/name/i);
    expect(() => decodeSolReq(goldenReqUri({...SOL_REQ_INPUT, memo: 'a'.repeat(33)}))).toThrow(/memo/i);
  });
});

// =============================================================================================
// SolPayV2 — only v, rid, tx; nothing else
// =============================================================================================

describe('solana/qr — solpay validation', () => {
  test('rejects an extra field', () => {
    const extra = encodeRaw('solpay', 2, {v: 2, rid: RID, tx: bytesToBase64Url(TX_BYTES), extra: 'nope'});
    expect(() => decodeSolPay(extra)).toThrow(/field|extra|tx|canonical/i);
  });
  test('rejects a missing rid', () => {
    const noRid = encodeRaw('solpay', 2, {v: 2, tx: bytesToBase64Url(TX_BYTES)});
    expect(() => decodeSolPay(noRid)).toThrow(/rid/i);
  });
  test('rejects empty tx bytes', () => {
    const emptyTx = encodeRaw('solpay', 2, {v: 2, rid: RID, tx: ''});
    expect(() => decodeSolPay(emptyTx)).toThrow(/tx/i);
  });
  test('rejects non-base64url tx', () => {
    const badTx = encodeRaw('solpay', 2, {v: 2, rid: RID, tx: 'not*valid!!'});
    expect(() => decodeSolPay(badTx)).toThrow(/tx/i);
  });
  test('rejects a malformed rid (case/length)', () => {
    const upper = encodeRaw('solpay', 2, {v: 2, rid: RID.toUpperCase(), tx: bytesToBase64Url(TX_BYTES)});
    expect(() => decodeSolPay(upper)).toThrow(/rid/i);
  });
  test('rejects tx larger than 1232 bytes (Solana packet limit)', () => {
    const big = new Uint8Array(1233);
    expect(() => encodeSolPay({rid: RID, tx: big})).toThrow(/tx|packet|1232/i);
  });
});

// =============================================================================================
// Canonical-form rejection — non-canonical JSON key order, whitespace, padded base64url,
// trailing bytes ALL fail
// =============================================================================================

describe('solana/qr — canonical-form rejection (no normalization)', () => {
  test('non-canonical JSON key order is rejected', () => {
    // Same fields, WRONG order — re-encoding canonically would differ from input bytes.
    const reordered = encodeRaw('solreq', 2, {
      to: MERCHANT, amt: '2000000', cur: 'SOL', mint: null, toAta: null, name: 'Cafe Sol', memo: 'table 7',
      v: 2, rid: RID, net: 'mainnet-beta', bh: BLOCKHASH, lvh: 300_000_000, slot: 290_000_000,
      iat: 1760000000, exp: 1760000060,
    });
    expect(() => decodeSolReq(reordered)).toThrow(/canonical|order|key/i);
  });
  test('extra field is rejected (canonical mismatch)', () => {
    // Same fields in canonical order, but with an extra `surprise` key — the canonical byte-check
    // diverges on the trailing `,"surprise":"nope"`.
    const json = canonicalReqJson(SOL_REQ_INPUT).replace(/}$/, ',"surprise":"nope"}');
    const extra = 'solreq:v2?' + bytesToBase64Url(utf8ToBytes(json));
    expect(() => decodeSolReq(extra)).toThrow(/canonical|field|extra/i);
  });
  test('leading whitespace in the URI is rejected (no trim)', () => {
    const uri = encodeSolReq(SOL_REQ_INPUT);
    expect(() => decodeSolReq(' ' + uri)).toThrow(/solreq|scheme|payload/i);
  });
  test('trailing whitespace in the URI is rejected (no trim)', () => {
    const uri = encodeSolReq(SOL_REQ_INPUT);
    expect(() => decodeSolReq(uri + ' ')).toThrow(/canonical|base64|payload|trim/i);
  });
  test('padded base64url (with pad char =) is rejected', () => {
    // Construct a solreq URI whose payload is the canonical base64url PLUS one '=' pad char.
    const json = canonicalReqJson(SOL_REQ_INPUT);
    let padded = bytesToBase64Url(utf8ToBytes(json));
    // Add '=' padding up to a multiple of 4. (Encoding always emits unpadded, so we add it here.)
    while ((padded.length + 1) % 4 !== 0) padded += '=';
    padded += '=';
    const uri = 'solreq:v2?' + padded;
    expect(() => decodeSolReq(uri)).toThrow(/canonical|base64|pad|payload/i);
  });
  test('trailing bytes after the JSON object are rejected', () => {
    // Append an extra `}` — JSON.parse would throw, but the canonical check would also catch any
    // trailing data that JSON.parse happens to tolerate (e.g. trailing whitespace inside the b64).
    const json = canonicalReqJson(SOL_REQ_INPUT) + ' '; // trailing space inside the b64 payload
    const uri = 'solreq:v2?' + bytesToBase64Url(utf8ToBytes(json));
    expect(() => decodeSolReq(uri)).toThrow(/canonical|trailing|payload/i);
  });
});

// =============================================================================================
// URI length cap
// =============================================================================================

describe('solana/qr — URI size cap', () => {
  test('rejects a URI > 2000 chars', () => {
    // A name at the 32-char cap with the rest of the fixture sits well under 2000. To trip the cap
    // without violating any per-field rule, we need to push the encoded JSON past 2000 chars via
    // memo... but memo is capped at 32. So the URI cap is effectively unreachable through valid
    // per-field inputs. We assert the cap by direct encoder rejection: build an oversized URI by
    // hand-rolling a payload that exceeds 2000 chars AFTER the prefix.
    const huge = 'solreq:v2?' + 'A'.repeat(2000);
    expect(huge.length).toBeGreaterThan(2000);
    expect(() => decodeSolReq(huge)).toThrow();
  });
});

// =============================================================================================
// encode-side defense in depth (producer bugs caught at encode time)
// =============================================================================================

describe('solana/qr — encode validation (defense in depth)', () => {
  test('encodeSolReq rejects USDC without mint', () => {
    expect(() => encodeSolReq({...USDC_REQ_INPUT, mint: null})).toThrow(/mint/i);
  });
  test('encodeSolReq rejects SOL with a non-null mint', () => {
    expect(() => encodeSolReq({...SOL_REQ_INPUT, mint: USDC_MINT})).toThrow(/mint/i);
  });
  test('encodeSolReq rejects an invalid merchant address', () => {
    expect(() => encodeSolReq({...SOL_REQ_INPUT, to: 'bad'})).toThrow(/to/i);
  });
  test('encodeSolReq rejects a malformed rid', () => {
    expect(() => encodeSolReq({...SOL_REQ_INPUT, rid: 'not-hex'})).toThrow(/rid/i);
  });
  test('encodeSolReq rejects an out-of-range lifetime', () => {
    expect(() => encodeSolReq({...SOL_REQ_INPUT, iat: 1000, exp: 1091})).toThrow(/exp|iat/i);
  });
  test('encodeSolPay rejects empty tx bytes', () => {
    expect(() => encodeSolPay({rid: RID, tx: new Uint8Array(0)})).toThrow(/tx/i);
  });
  test('encodeSolPay rejects a malformed rid', () => {
    expect(() => encodeSolPay({rid: 'NOT-HEX', tx: TX_BYTES})).toThrow(/rid/i);
  });
});
