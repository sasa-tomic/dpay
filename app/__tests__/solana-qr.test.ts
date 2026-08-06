import { describe, test, expect } from '@jest/globals';
import {
  encodeSolReq,
  decodeSolReq,
  encodeSolPay,
  decodeSolPay,
  SOL_QR_VERSION,
  type SolReqInput,
  type SolPayInput,
} from '../solana/qr';

// Deterministic addresses (reuse the SLIP-10 leaf + PoC nonces from 08/09-golden so every SOL test
// suite shares one fixture set).
const MERCHANT = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const NONCE_ACCOUNT = 'GZXyfzSTCBmA7rpeDLrmUbiSA45H5EEwJhoBeR6ZNb3u';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MERCHANT_USDC_ATA = 'C9dhv75Qeu2NLrEprtNNMageKX6z2bsysrdRTNFB3nbk';

const SOL_REQ_INPUT: SolReqInput = {
  to: MERCHANT,
  amt: '2000000', // 0.002 SOL (lamports)
  cur: 'SOL',
  mint: null,
  toAta: null,
  exp: 1760000000,
  name: 'Cafe Sol',
  memo: 'table 7',
};

const USDC_REQ_INPUT: SolReqInput = {
  to: MERCHANT,
  amt: '5000000', // 5 USDC (micro-USDC, 6 decimals)
  cur: 'USDC',
  mint: USDC_MINT,
  toAta: MERCHANT_USDC_ATA,
  exp: 1760000000,
  name: 'Cafe Sol',
  memo: '',
};

// Raw signed-tx bytes (synthetic; the QR codec is agnostic to their meaning). Deliberately includes
// bytes 0xfb / 0xff / 0xbf to force the base64url codec through its `-` / `_` branches (those bytes
// map to `+` / `/` in standard base64 — confirming we emit url-safe chars).
const TX_BYTES = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x7e, 0x01, 0x80, 0xff, 0xfe]);

const SOL_PAY_INPUT: SolPayInput = {
  to: MERCHANT,
  amt: '2000000',
  cur: 'SOL',
  npub: NONCE_ACCOUNT,
  tx: TX_BYTES,
};

const USDC_PAY_INPUT: SolPayInput = {
  to: MERCHANT,
  amt: '5000000',
  cur: 'USDC',
  npub: NONCE_ACCOUNT,
  tx: TX_BYTES,
};

describe('solana/qr — version + URI format', () => {
  test('SOL_QR_VERSION is 1', () => {
    expect(SOL_QR_VERSION).toBe(1);
  });
  test('encodeSolReq emits the solreq:v1? prefix', () => {
    const uri = encodeSolReq(SOL_REQ_INPUT);
    expect(uri.startsWith('solreq:v1?')).toBe(true);
  });
  test('encodeSolPay emits the solpay:v1? prefix', () => {
    const uri = encodeSolPay(SOL_PAY_INPUT);
    expect(uri.startsWith('solpay:v1?')).toBe(true);
  });
  test('payload is unpadded base64url charset only', () => {
    const uri = encodeSolReq(USDC_REQ_INPUT);
    const payload = uri.slice('solreq:v1?'.length);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(payload).not.toContain('=');
    expect(payload).not.toContain('+');
    expect(payload).not.toContain('/');
  });
});

describe('solana/qr — solreq round-trip', () => {
  test('SOL request round-trips field-for-field', () => {
    const uri = encodeSolReq(SOL_REQ_INPUT);
    const decoded = decodeSolReq(uri);
    expect(decoded.v).toBe(1);
    expect(decoded.to).toBe(MERCHANT);
    expect(decoded.amt).toBe('2000000');
    expect(decoded.cur).toBe('SOL');
    expect(decoded.mint).toBeNull();
    expect(decoded.toAta).toBeNull();
    expect(decoded.exp).toBe(1760000000);
    expect(decoded.name).toBe('Cafe Sol');
    expect(decoded.memo).toBe('table 7');
  });
  test('USDC request round-trips field-for-field (mint + toAta)', () => {
    const uri = encodeSolReq(USDC_REQ_INPUT);
    const decoded = decodeSolReq(uri);
    expect(decoded.cur).toBe('USDC');
    expect(decoded.mint).toBe(USDC_MINT);
    expect(decoded.toAta).toBe(MERCHANT_USDC_ATA);
    expect(decoded.memo).toBe('');
  });
  test('multibyte UTF-8 (emoji + accents) round-trips in name/memo', () => {
    const uri = encodeSolReq({...SOL_REQ_INPUT, name: 'Café ☕ Solana', memo: 'ここ'});
    const decoded = decodeSolReq(uri);
    expect(decoded.name).toBe('Café ☕ Solana');
    expect(decoded.memo).toBe('ここ');
  });
});

describe('solana/qr — solpay round-trip', () => {
  test('SOL payment round-trips field-for-field (incl. tx bytes)', () => {
    const uri = encodeSolPay(SOL_PAY_INPUT);
    const decoded = decodeSolPay(uri);
    expect(decoded.v).toBe(1);
    expect(decoded.to).toBe(MERCHANT);
    expect(decoded.amt).toBe('2000000');
    expect(decoded.cur).toBe('SOL');
    expect(decoded.npub).toBe(NONCE_ACCOUNT);
    expect(Array.from(decoded.tx)).toEqual(Array.from(TX_BYTES));
  });
  test('tx bytes containing 0xfb/0xff/0xbf survive the base64url round-trip (url-safe chars)', () => {
    const uri = encodeSolPay(SOL_PAY_INPUT);
    // The url-safe alphabet must not contain + or / — the 0xfb/0xff/0xbf bytes would have produced
    // them under standard base64.
    const payload = uri.slice('solpay:v1?'.length);
    expect(payload).not.toContain('+');
    expect(payload).not.toContain('/');
    const decoded = decodeSolPay(uri);
    expect(Array.from(decoded.tx)).toEqual(Array.from(TX_BYTES));
  });
  test('USDC payment round-trips', () => {
    const decoded = decodeSolPay(encodeSolPay(USDC_PAY_INPUT));
    expect(decoded.cur).toBe('USDC');
    expect(Array.from(decoded.tx)).toEqual(Array.from(TX_BYTES));
  });
});

describe('solana/qr — decodeSolReq validation (no silent failures)', () => {
  test('rejects the wrong scheme (solpay: handed to decodeSolReq)', () => {
    const solpayUri = encodeSolPay(SOL_PAY_INPUT); // solpay:v1?...
    expect(() => decodeSolReq(solpayUri)).toThrow(/solreq/i);
  });
  test('rejects an unversioned / unknown-version payload', () => {
    const uri = encodeSolReq(SOL_REQ_INPUT);
    // strip the explicit version tag — payload still decodes to JSON but v will be wrong
    const tampered = uri.replace('solreq:v1?', 'solreq:v2?');
    expect(() => decodeSolReq(tampered)).toThrow(/version|scheme/i);
    expect(() => decodeSolReq('solreq:v1?')).toThrow(/payload/i);
  });
  test('rejects malformed base64url', () => {
    expect(() => decodeSolReq('solreq:v1?not*valid*b64u!')).toThrow(/payload/i);
  });
  test('rejects a missing required field (to)', () => {
    const bad = encodeRaw('solreq', {v: 1, amt: '1', cur: 'SOL', mint: null, toAta: null, exp: 1, name: '', memo: ''});
    expect(() => decodeSolReq(bad)).toThrow(/to/i);
  });
  test('rejects an invalid merchant address', () => {
    expect(() => decodeSolReq(encodeSolReq({...SOL_REQ_INPUT, to: '0invalid!!!'}))).toThrow(/to/i);
  });
  test('rejects a non-decimal amt', () => {
    expect(() => decodeSolReq(encodeSolReq({...SOL_REQ_INPUT, amt: '1.5e3'}))).toThrow(/amt/i);
    expect(() => decodeSolReq(encodeSolReq({...SOL_REQ_INPUT, amt: '12a'}))).toThrow(/amt/i);
  });
  test('rejects an unknown currency', () => {
    expect(() => decodeSolReq(encodeSolReq({...SOL_REQ_INPUT, cur: 'BTC' as any}))).toThrow(/cur/i);
  });
  test('rejects USDC without a mint', () => {
    expect(() => decodeSolReq(encodeRaw('solreq', {...USDC_REQ_INPUT, v: 1, mint: null}))).toThrow(/mint/i);
  });
  test('rejects USDC without a toAta', () => {
    expect(() => decodeSolReq(encodeRaw('solreq', {...USDC_REQ_INPUT, v: 1, toAta: null}))).toThrow(/toAta|ata/i);
  });
  test('rejects SOL carrying a non-null mint (ambiguous)', () => {
    expect(() => decodeSolReq(encodeRaw('solreq', {...SOL_REQ_INPUT, v: 1, mint: USDC_MINT}))).toThrow(/mint/i);
  });
  test('rejects a non-safe-integer exp', () => {
    expect(() => decodeSolReq(encodeSolReq({...SOL_REQ_INPUT, exp: 1.5}))).toThrow(/exp/i);
  });
});

describe('solana/qr — decodeSolPay validation', () => {
  test('rejects the wrong scheme (solreq: handed to decodeSolPay)', () => {
    const solreqUri = encodeSolReq(SOL_REQ_INPUT); // solreq:v1?...
    expect(() => decodeSolPay(solreqUri)).toThrow(/solpay/i);
  });
  test('rejects a missing npub', () => {
    const bad = encodeRaw('solpay', {v: 1, to: MERCHANT, amt: '1', cur: 'SOL', tx: 'AAAA'});
    expect(() => decodeSolPay(bad)).toThrow(/npub/i);
  });
  test('rejects an invalid npub address', () => {
    expect(() => decodeSolPay(encodeSolPay({...SOL_PAY_INPUT, npub: '##bad##'}))).toThrow(/npub/i);
  });
  test('rejects a non-base64url tx', () => {
    const bad = encodeRaw('solpay', {v: 1, to: MERCHANT, amt: '1', cur: 'SOL', npub: NONCE_ACCOUNT, tx: 'not*valid!!'});
    expect(() => decodeSolPay(bad)).toThrow(/tx/i);
  });
  test('rejects an empty tx', () => {
    const bad = encodeRaw('solpay', {v: 1, to: MERCHANT, amt: '1', cur: 'SOL', npub: NONCE_ACCOUNT, tx: ''});
    expect(() => decodeSolPay(bad)).toThrow(/tx/i);
  });
});

describe('solana/qr — encode validation (defense in depth at the producer)', () => {
  test('encodeSolReq rejects USDC without mint', () => {
    expect(() => encodeSolReq({...USDC_REQ_INPUT, mint: null})).toThrow(/mint/i);
  });
  test('encodeSolReq rejects SOL with a non-null mint', () => {
    expect(() => encodeSolReq({...SOL_REQ_INPUT, mint: USDC_MINT})).toThrow(/mint/i);
  });
  test('encodeSolReq rejects an invalid merchant address', () => {
    expect(() => encodeSolReq({...SOL_REQ_INPUT, to: 'bad'})).toThrow(/to/i);
  });
  test('encodeSolPay rejects empty tx bytes', () => {
    expect(() => encodeSolPay({...SOL_PAY_INPUT, tx: new Uint8Array(0)})).toThrow(/tx/i);
  });
});

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

// Build a `scheme:v1?<b64u(json)>` URI directly from a raw object (bypasses encodeSolReq/Pay
// validation), so tests can feed malformed-but-parseable payloads to the decoders.
function encodeRaw(scheme: 'solreq' | 'solpay', obj: Record<string, unknown>): string {
  const json = JSON.stringify(obj);
  return `${scheme}:v1?${bytesToBase64Url(utf8ToBytes(json))}`;
}
