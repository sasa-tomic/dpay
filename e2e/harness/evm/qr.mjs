// e2e/harness/evm/qr.mjs — the evmreq:v1 / evmpay:v1 wire codec (D21), the harness-side twin of
// app/evm/qr.ts (stream S2). What crosses the QR (later NFC, same bytes):
//   merchant → payer:  evmreq:v1?<base64url(canonical json)>   — works OFFLINE on both sides
//   payer   → merchant: evmpay:v1?<base64url(canonical json)>  — the offline permit claim
// Canonical JSON = the interface's exact key order, no whitespace. HARD INVARIANT: every decode
// re-encodes and must reproduce the input byte-for-byte (decode never trims, reorders, pads, or
// accepts trailing bytes); every failure is a TYPED error on `err.kind`.
// Size caps + window: name/memo ≤ 32 UTF-16 units; URI ≤ 2000 chars; iat < exp ≤ iat + 600.

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function b64urlEncode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 6) { out += B64URL[(value >>> (bits -= 6)) & 63]; }
  }
  if (bits > 0) out += B64URL[(value << (6 - bits)) & 63];
  return out;
}

export function b64urlDecode(str) {
  const out = [];
  let bits = 0, value = 0;
  for (const c of str) {
    const i = B64URL.indexOf(c);
    if (i < 0) throw err('bad-base64', `character ${JSON.stringify(c)} is not base64url`);
    value = (value << 6) | i;
    bits += 6;
    if (bits >= 8) out.push((value >>> (bits -= 8)) & 0xff);
  }
  if (bits >= 6 || (value & ((1 << bits) - 1)) !== 0) throw err('bad-base64', 'trailing bits are not zero — not canonical base64url');
  return Buffer.from(out);
}

function err(kind, detail) { const e = new Error(`${kind}: ${detail}`); e.kind = kind; return e; }

// Canonical JSON: fixed key order (the D21 interface order), no whitespace. encodeURIComponent
// would escape whole strings differently — JSON.stringify is the canonical serializer here.
const reqKeys = ['v', 'rid', 'chainId', 'token', 'to', 'amt', 'iat', 'exp', 'name', 'memo'];
const payKeys = ['v', 'rid', 'owner', 'deadline', 'sig'];

function canonical(obj, keys) {
  const picked = {};
  for (const k of keys) picked[k] = obj[k];
  return JSON.stringify(picked);
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const HEX130 = /^0x[0-9a-f]{130}$/;
const DIGITS = /^[0-9]+$/;
export const REQ_WINDOW_SECONDS = 600;

function validateReq(r) {
  if (r.v !== 1) throw err('bad-field', `v must be 1, got ${JSON.stringify(r.v)}`);
  if (!HEX32.test(r.rid)) throw err('bad-field', 'rid must be 32 lowercase hex chars');
  if (!Number.isInteger(r.chainId) || r.chainId <= 0) throw err('bad-field', 'chainId must be a positive integer');
  if (typeof r.token !== 'string' || !/^[A-Z0-9]{2,10}$/.test(r.token)) throw err('bad-field', 'token must be the registry symbol (2-10 A-Z0-9)');
  if (typeof r.to !== 'string' || !HEX40.test(r.to)) throw err('bad-field', 'to must be a 0x + 40-hex address');
  if (typeof r.amt !== 'string' || !DIGITS.test(r.amt) || r.amt.length > 78) throw err('bad-field', 'amt must be a decimal RAW-unit string (BigInt-safe)');
  if (!Number.isInteger(r.iat) || !Number.isInteger(r.exp)) throw err('bad-field', 'iat/exp must be unix seconds');
  if (!(r.iat < r.exp && r.exp <= r.iat + REQ_WINDOW_SECONDS)) throw err('bad-window', `iat < exp <= iat + ${REQ_WINDOW_SECONDS} must hold`);
  for (const k of ['name', 'memo']) {
    if (typeof r[k] !== 'string' || r[k].length > 32) throw err('bad-field', `${k} must be a string of ≤ 32 UTF-16 units`);
  }
}

function validatePay(p) {
  if (p.v !== 1) throw err('bad-field', `v must be 1, got ${JSON.stringify(p.v)}`);
  if (!HEX32.test(p.rid)) throw err('bad-field', 'rid must be 32 lowercase hex chars');
  if (typeof p.owner !== 'string' || !HEX40.test(p.owner)) throw err('bad-field', 'owner must be a 0x + 40-hex address');
  if (!Number.isInteger(p.deadline)) throw err('bad-field', 'deadline must be unix seconds');
  if (typeof p.sig !== 'string' || !HEX130.test(p.sig)) throw err('bad-field', 'sig must be 130 lowercase hex chars (r||s||v, 65 bytes)');
}

function encodeUri(prefix, payload, keys, maxLength) {
  const uri = prefix + b64urlEncode(Buffer.from(canonical(payload, keys), 'utf8'));
  if (uri.length > maxLength) throw err('too-long', `URI is ${uri.length} chars, cap is ${maxLength}`);
  return uri;
}

function decodeUri(uri, prefix, keys, validate) {
  if (typeof uri !== 'string' || !uri.startsWith(prefix)) throw err('bad-scheme', `expected ${prefix}…`);
  let json;
  try {
    json = Buffer.from(b64urlDecode(uri.slice(prefix.length))).toString('utf8');
  } catch (e) {
    throw e.kind === 'bad-base64' ? e : err('bad-base64', String(e));
  }
  let obj;
  try { obj = JSON.parse(json); } catch { throw err('bad-json', 'payload is not JSON'); }
  // No extra keys, no missing keys, exact canonical form: re-encode must reproduce the input.
  validate(obj);
  if (canonical(obj, keys) !== json) throw err('non-canonical', 're-encoding the payload does not reproduce the input bytes');
  return obj;
}

const MAX_URI = 2000;

/** Build the merchant request URI. Throws typed errors on any malformed field. */
export function encodeEvmReq(req) { validateReq(req); return encodeUri('evmreq:v1?', req, reqKeys, MAX_URI); }
/** Decode + fully validate a request URI (strict canonical form). */
export function decodeEvmReq(uri) { return decodeUri(uri, 'evmreq:v1?', reqKeys, validateReq); }
/** Build the payer's claim URI (the offline permit signature rides as 130-hex). */
export function encodeEvmPay(pay) { validatePay(pay); return encodeUri('evmpay:v1?', pay, payKeys, MAX_URI); }
/** Decode + fully validate a claim URI (strict canonical form). */
export function decodeEvmPay(uri) { return decodeUri(uri, 'evmpay:v1?', payKeys, validatePay); }

/** Valid through the expiry second (inclusive), mirroring isSolReqV2Expired semantics. */
export function isEvmReqExpired(req, nowSeconds = Math.floor(Date.now() / 1000)) {
  return nowSeconds > req.exp;
}
