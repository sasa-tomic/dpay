// `solreq:` / `solpay:` URI codec for the SOL offline-pay rail.
//
// PURE module — no network, no React. Two versioned payloads (single source of truth for the SOL
// QR schemas documented in 2026-08-06-sol-mvp-followups-and-offline-rail.md §4):
//
//   solreq:v1?<base64url(json)>   merchant → payer (the payment request)
//   solpay:v1?<base64url(json)>   payer → merchant (the offline-signed authorization)
//
// `v1` is FROZEN once shipped (mirror the IC wire-format freeze discipline); new fields bump to v2.
// base64url + UTF-8 are hand-rolled (no Buffer/btoa/TextEncoder dependency) so the codec is identical
// on RN/Hermes, jest/Node, and the e2e browser bundle. All decode paths throw typed errors — never
// a silent failure (a malformed/unknown-version/expired request is rejected explicitly).

import { isValidSolanaAddress } from './identity';

export const SOL_QR_VERSION = 1;

const SOL_REQ_PREFIX = `solreq:v${SOL_QR_VERSION}?`;
const SOL_PAY_PREFIX = `solpay:v${SOL_QR_VERSION}?`;

export type SolCurrency = 'SOL' | 'USDC';

/** Merchant → payer request. `amt` is a decimal-digit string of smallest units (lamports for SOL,
 *  micro-USDC for USDC) — BigInt-safe, never a JS number (lossy > 2^53). */
export interface SolReq {
  readonly v: 1;
  readonly to: string;          // base58 merchant SOL address (the payee)
  readonly amt: string;         // decimal-digit string, smallest units
  readonly cur: SolCurrency;
  readonly mint: string | null; // null for SOL; the SPL mint for USDC
  readonly toAta: string | null;// null for SOL; the merchant's pre-existing token account for USDC
  readonly exp: number;         // unix seconds (request expiry)
  readonly name: string;        // merchant display name ("" ok)
  readonly memo: string;        // optional note ("" ok)
}

/** Payer → merchant offline-signed authorization. `tx` is the raw signed legacy Solana transaction
 *  bytes ({AdvanceNonce(ix0), Transfer | Token.transfer}, recentBlockhash = the payer's stored
 *  durable-nonce value). */
export interface SolPay {
  readonly v: 1;
  readonly to: string;     // echoed merchant address
  readonly amt: string;    // echoed
  readonly cur: SolCurrency;
  readonly npub: string;   // payer's nonce-account address (binding key for the receipt round-trip)
  readonly tx: Uint8Array; // raw signed Solana tx bytes
}

export type SolReqInput = Omit<SolReq, 'v'>;
export type SolPayInput = Omit<SolPay, 'v'>;

// --- base64url (RFC 4648 §5) ------------------------------------------------------------------

const B64U_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64U_REV = (() => {
  const m = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64U_CHARS.length; i++) m[B64U_CHARS.charCodeAt(i)] = i;
  return m;
})();

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

function base64UrlToBytes(s: string): Uint8Array | null {
  // Accept the canonical unpadded form; tolerate padded (strip `=`) for robustness.
  const len = s.endsWith('=') ? s.replace(/=+$/, '').length : s.length;
  if (len === 0) return new Uint8Array(0);
  // Whole groups of 4 → 3 bytes; a trailing group of 2 → 1 byte, of 3 → 2 bytes.
  const full = Math.floor(len / 4);
  const rem = len % 4;
  if (rem === 1) return null; // impossible in valid base64
  const outLen = full * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0);
  const out = new Uint8Array(outLen);
  let oi = 0;
  const decodeBlock = (c0: number, c1: number, c2: number, c3: number, bytesIn: number) => {
    const v0 = B64U_REV[c0];
    const v1 = B64U_REV[c1];
    const v2 = c2 >= 0 ? B64U_REV[c2] : -1;
    const v3 = c3 >= 0 ? B64U_REV[c3] : -1;
    if (v0 < 0 || v1 < 0 || (bytesIn >= 3 && v2 < 0) || (bytesIn >= 4 && v3 < 0)) return false;
    out[oi++] = (v0 << 2) | (v1 >> 4);
    if (bytesIn >= 3) out[oi++] = ((v1 & 0x0f) << 4) | (v2 >> 2);
    if (bytesIn >= 4) out[oi++] = ((v2 & 0x03) << 6) | v3;
    return true;
  };
  let i = 0;
  for (; i + 4 <= len; i += 4) {
    if (!decodeBlock(s.charCodeAt(i), s.charCodeAt(i + 1), s.charCodeAt(i + 2), s.charCodeAt(i + 3), 4)) return null;
  }
  if (rem === 2) {
    if (!decodeBlock(s.charCodeAt(i), s.charCodeAt(i + 1), -1, -1, 2)) return null;
  } else if (rem === 3) {
    if (!decodeBlock(s.charCodeAt(i), s.charCodeAt(i + 1), s.charCodeAt(i + 2), -1, 3)) return null;
  }
  return out;
}

// --- UTF-8 (hand-rolled; no TextEncoder/Buffer dependency) ------------------------------------

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

function bytesToUtf8(bytes: Uint8Array): string {
  // Full RFC 3629 decode (handles 1–4 byte sequences; rejects overlong/surrogates).
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    let cp: number;
    let extra: number;
    if (b < 0x80) {
      cp = b;
      extra = 0;
    } else if ((b & 0xe0) === 0xc0) {
      cp = b & 0x1f;
      extra = 1;
    } else if ((b & 0xf0) === 0xe0) {
      cp = b & 0x0f;
      extra = 2;
    } else if ((b & 0xf8) === 0xf0) {
      cp = b & 0x07;
      extra = 3;
    } else {
      throw new Error('invalid UTF-8 lead byte');
    }
    if (i + extra > bytes.length) throw new Error('truncated UTF-8 sequence');
    for (let k = 0; k < extra; k++) {
      const cb = bytes[i++];
      if ((cb & 0xc0) !== 0x80) throw new Error('invalid UTF-8 continuation byte');
      cp = (cp << 6) | (cb & 0x3f);
    }
    // Reject overlong encodings.
    const min = extra === 1 ? 0x80 : extra === 2 ? 0x800 : extra === 3 ? 0x10000 : 0;
    if (cp < min) throw new Error('overlong UTF-8 sequence');
    // Reject UTF-16 surrogate halves (invalid in UTF-8).
    if (cp >= 0xd800 && cp <= 0xdfff) throw new Error('surrogate in UTF-8');
    out += cp > 0xffff
      ? String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff))
      : String.fromCharCode(cp);
  }
  return out;
}

// --- validation (shared by encode + decode; single source of truth) --------------------------

const DECIMAL_RE = /^[0-9]+$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function nonNegDecimalAmt(v: unknown, field: string): string {
  if (!isStr(v) || !DECIMAL_RE.test(v)) {
    throw new Error(`solana qr: '${field}' must be a non-negative decimal-digit string`);
  }
  return v;
}

function optAddr(v: unknown, field: string): string | null {
  if (v === null) return null;
  if (!isStr(v) || !isValidSolanaAddress(v)) {
    throw new Error(`solana qr: '${field}' must be a valid base58 address or null`);
  }
  return v;
}

function reqAddr(v: unknown, field: string): string {
  if (!isStr(v) || !isValidSolanaAddress(v)) {
    throw new Error(`solana qr: '${field}' must be a valid base58 address`);
  }
  return v;
}

/** Validate a parsed request object. Enforces the cross-field rule: SOL ⇒ mint+toAta are null;
 *  USDC ⇒ mint+toAta are present (the codec refuses to carry an ambiguous/underspecified request). */
function validateReq(obj: unknown): SolReq {
  if (!isObj(obj)) throw new Error('solana qr: request payload is not an object');
  const v = obj.v;
  if (v !== SOL_QR_VERSION) throw new Error(`solana qr: unsupported request version ${String(v)}`);
  const cur = obj.cur;
  if (cur !== 'SOL' && cur !== 'USDC') throw new Error("solana qr: 'cur' must be SOL or USDC");
  const to = reqAddr(obj.to, 'to');
  const amt = nonNegDecimalAmt(obj.amt, 'amt');
  const mint = optAddr(obj.mint, 'mint');
  const toAta = optAddr(obj.toAta, 'toAta');
  if (cur === 'SOL') {
    if (mint !== null) throw new Error("solana qr: 'mint' must be null for SOL");
    if (toAta !== null) throw new Error("solana qr: 'toAta' must be null for SOL");
  } else {
    // USDC: both required.
    if (mint === null) throw new Error("solana qr: 'mint' is required for USDC");
    if (toAta === null) throw new Error("solana qr: 'toAta' is required for USDC");
  }
  const exp = obj.exp;
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp)) {
    throw new Error("solana qr: 'exp' must be a safe integer (unix seconds)");
  }
  const name = obj.name;
  if (!isStr(name)) throw new Error("solana qr: 'name' must be a string");
  const memo = obj.memo;
  if (!isStr(memo)) throw new Error("solana qr: 'memo' must be a string");
  return {v: SOL_QR_VERSION, to, amt, cur, mint, toAta, exp, name, memo};
}

/** Validate a parsed payment object. `tx` is a base64url string in the JSON; decoded to bytes here. */
function validatePay(obj: unknown): SolPay {
  if (!isObj(obj)) throw new Error('solana qr: payment payload is not an object');
  const v = obj.v;
  if (v !== SOL_QR_VERSION) throw new Error(`solana qr: unsupported payment version ${String(v)}`);
  const cur = obj.cur;
  if (cur !== 'SOL' && cur !== 'USDC') throw new Error("solana qr: 'cur' must be SOL or USDC");
  const to = reqAddr(obj.to, 'to');
  const amt = nonNegDecimalAmt(obj.amt, 'amt');
  const npub = reqAddr(obj.npub, 'npub');
  const txField = obj.tx;
  if (!isStr(txField) || txField.length === 0) throw new Error("solana qr: 'tx' must be a non-empty base64url string");
  const txBytes = base64UrlToBytes(txField);
  if (txBytes === null || txBytes.length === 0) throw new Error("solana qr: 'tx' is not valid base64url");
  return {v: SOL_QR_VERSION, to, amt, cur, npub, tx: txBytes};
}

// --- codec ------------------------------------------------------------------------------------

function splitPayload(raw: string, expectedPrefix: string, label: string): string {
  const t = raw.trim();
  if (!t.startsWith(expectedPrefix)) {
    // Distinguish "wrong scheme" from "wrong version" for a debuggable error.
    const colon = t.indexOf(':');
    const scheme = colon > 0 ? t.slice(0, colon) : '';
    if (scheme === label) throw new Error(`solana qr: unsupported ${label} scheme/version`);
    throw new Error(`solana qr: not a ${label} payload`);
  }
  return t.slice(expectedPrefix.length);
}

export function encodeSolReq(input: SolReqInput): string {
  // The codec owns the version; encode stamps it. Validation runs on the assembled object so a
  // caller bug (e.g. USDC with no mint) is caught at the producer, not just at the consumer.
  const obj = {v: SOL_QR_VERSION, ...input};
  validateReq(obj);
  const json = JSON.stringify(obj);
  return SOL_REQ_PREFIX + bytesToBase64Url(utf8ToBytes(json));
}

export function decodeSolReq(raw: string): SolReq {
  const payload = splitPayload(raw, SOL_REQ_PREFIX, 'solreq');
  const bytes = base64UrlToBytes(payload);
  if (bytes === null) throw new Error('solana qr: malformed solreq payload (bad base64url)');
  let json: unknown;
  try {
    json = JSON.parse(bytesToUtf8(bytes));
  } catch {
    throw new Error('solana qr: malformed solreq payload (not JSON)');
  }
  return validateReq(json);
}

export function encodeSolPay(input: SolPayInput): string {
  const obj = {v: SOL_QR_VERSION, to: input.to, amt: input.amt, cur: input.cur, npub: input.npub, tx: bytesToBase64Url(input.tx)};
  validatePay(obj);
  const json = JSON.stringify(obj);
  return SOL_PAY_PREFIX + bytesToBase64Url(utf8ToBytes(json));
}

export function decodeSolPay(raw: string): SolPay {
  const payload = splitPayload(raw, SOL_PAY_PREFIX, 'solpay');
  const bytes = base64UrlToBytes(payload);
  if (bytes === null) throw new Error('solana qr: malformed solpay payload (bad base64url)');
  let json: unknown;
  try {
    json = JSON.parse(bytesToUtf8(bytes));
  } catch {
    throw new Error('solana qr: malformed solpay payload (not JSON)');
  }
  return validatePay(json);
}
