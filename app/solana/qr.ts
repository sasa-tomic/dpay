// `solreq:` / `solpay:` URI codec for the SOL offline-pay rail — PROTOCOL v2 (recent-blockhash).
//
// PURE module — no network, no React, no Buffer/btoa/TextEncoder (the base64url + UTF-8 codecs are
// hand-rolled in `../lib/base64url.ts` and identical on RN/Hermes, jest/Node, and the e2e browser
// bundle). All decode paths throw typed errors — never a silent failure.
//
// v2 supersedes v1 (durable-nonce) per 2026-08-12-solana-recent-blockhash-rewrite-plan.md. The v1
// codec is GONE — decoders reject v1 explicitly (no compatibility branch). Phase 3 deletes the
// remaining v1 lifecycle in `solana.ts`; until then, those callers carry an inline v1 placeholder.
//
// SCHEMAS (frozen, golden-tested):
//
//   solreq:v2?<base64url(json)>   merchant → payer (the payment request)
//   solpay:v2?<base64url(json)>   payer → merchant (the offline-signed authorization)
//
// The HARD CANONICAL INVARIANT: `encodeSolReq(decodeSolReq(raw)) === raw` for every valid URI.
// Decoding must NOT trim, normalize, re-order JSON keys, pad base64url, or accept trailing bytes.
// The producer re-serializes canonically and compares byte-for-byte against the input payload —
// any drift (reordered keys, padded b64url, trailing whitespace, extra fields) is a hard reject.
//
// SIZE CAPS (chosen here; documented for downstream reasoning):
//   name/memo  ≤ 32 UTF-16 code units — mirrors the IC `NAME_LEN` discipline (canonical merchant
//                display-name bound on the facade; same cap on the SOL rail keeps parity).
//   tx         ≤ 1232 bytes          — the Solana transaction packet limit (MTU on the wire).
//   URI        ≤ 2000 chars          — safe QR + URL limit; no legitimate request approaches it.

import { isValidSolanaAddress } from './identity';
import {bytesToBase64Url, base64UrlToBytes, utf8ToBytes, bytesToUtf8} from '../lib/base64url';

export const SOL_QR_VERSION = 2;

const SOL_REQ_PREFIX = `solreq:v${SOL_QR_VERSION}?`;
const SOL_PAY_PREFIX = `solpay:v${SOL_QR_VERSION}?`;

const MAX_NAME_LEN = 32;
const MAX_MEMO_LEN = 32;
const MAX_TX_LEN = 1232;
const MAX_URI_LEN = 2000;

/** The request's token literal: 'SOL' for native lamports, or a registered SPL token symbol
 *  ('USDC', 'EURC', …). The CODEC is deliberately token-agnostic — it validates the SHAPE of
 *  `cur` (an uppercase `[A-Z0-9]{2,10}` symbol) and the mint/toAta STRUCTURE (SOL ⇔ both null,
 *  non-SOL ⇔ both present and valid base58), never the MEMBERSHIP. Whether a given mint is one
 *  this wallet will pay is a catalog/registry decision enforced at the engine + component layer
 *  (same split as `parseSolanaPayUri`'s structural parse). The `(string & {})` arm keeps the
 *  known literals as completions while accepting any future registry symbol. */
export type SolCurrency = 'SOL' | 'USDC' | 'EURC' | (string & {});

/** The frozen cluster id. v2 is locked to mainnet-beta; other clusters are out of scope. */
export type SolNet = 'mainnet-beta';

/** Merchant → payer request. `amt` is a decimal-digit string of smallest units (lamports for SOL;
 *  the token's smallest unit at its own decimals for an SPL token — micro-USDC, micro-EURC, …) —
 *  BigInt-safe, never a JS number (lossy > 2^53). */
export interface SolReqV2 {
  readonly v: 2;
  readonly rid: string;       // 32 lowercase hex chars (16 random bytes) — binds request ↔ receipt
  readonly net: SolNet;       // frozen cluster
  readonly bh: string;        // base58 recent blockhash (32-byte Solana value)
  readonly lvh: number;       // lastValidBlockHeight (from the getLatestBlockhash context)
  readonly slot: number;      // context slot (paired with lvh for reorg-aware confirmation)
  readonly iat: number;       // unix seconds (request creation time, signed clock)
  readonly exp: number;       // unix seconds (request expiry); iat < exp ≤ iat + 90
  readonly to: string;        // base58 merchant SOL address (the payee)
  readonly amt: string;       // decimal-digit string, smallest units, > 0, ≤ 2^64-1
  readonly cur: SolCurrency;
  readonly mint: string | null; // null for SOL; the SPL mint for a token request
  readonly toAta: string | null;// null for SOL; the merchant's pre-existing token account for the mint
  readonly name: string;      // merchant display name ("" ok)
  readonly memo: string;      // optional note ("" ok)
}

/** Payer → merchant offline-signed authorization. The merchant's broadcast returns a {status, rid,
 *  sig} receipt; the payer binds the receipt to the request via rid (no echoed untrusted claims). */
export interface SolPayV2 {
  readonly v: 2;
  readonly rid: string;
  readonly tx: Uint8Array;
}

/** The merchant's broadcast returns this; the payer decides what to believe. `status` codes:
 *  0=settled, 1=rejected/expired, 2=unknown. Unknown values (not 0/1/2) are honest-unknown pending. */
export interface SolReceiptV2 {
  readonly status: number;
  readonly rid: string;
  readonly sig: string;
}

export type SolReqInput = Omit<SolReqV2, 'v'>;
export type SolPayInput = Omit<SolPayV2, 'v'>;

// --- canonical JSON serialization (declared field order; compact) ----------------------------
//
// JSON.stringify on a literal `{a, b, c}` emits keys in declaration order. We build every payload
// through these canonicalizers so producer + consumer emit byte-identical bytes.

function canonicalReqJson(r: SolReqV2): string {
  return JSON.stringify({
    v: 2,
    rid: r.rid,
    net: r.net,
    bh: r.bh,
    lvh: r.lvh,
    slot: r.slot,
    iat: r.iat,
    exp: r.exp,
    to: r.to,
    amt: r.amt,
    cur: r.cur,
    mint: r.mint,
    toAta: r.toAta,
    name: r.name,
    memo: r.memo,
  });
}

function canonicalPayJson(r: SolPayV2): string {
  return JSON.stringify({v: 2, rid: r.rid, tx: bytesToBase64Url(r.tx)});
}

// --- validation (shared by encode + decode; single source of truth) --------------------------

const DECIMAL_RE = /^[0-9]+$/;
const RID_RE = /^[0-9a-f]{32}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
// A token symbol literal — the same shape rule parseAssetId uses for `solana:<TOKEN>` (registry
// symbols: SOL, USDC, EURC, …). Uppercase + digits, 2–10 chars.
const TOKEN_RE = /^[A-Z0-9]{2,10}$/;
// 2^64 - 1 inclusive — u64 max. amt must fit in a u64 (Solana's largest unit count).
const AMT_MAX_BIGINT = 18446744073709551615n;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function expectRid(v: unknown): string {
  if (!isStr(v) || !RID_RE.test(v)) {
    throw new Error("solana qr: 'rid' must be exactly 32 lowercase hex chars");
  }
  return v;
}

function expectNet(v: unknown): SolNet {
  if (v !== 'mainnet-beta') {
    throw new Error("solana qr: 'net' must be exactly 'mainnet-beta'");
  }
  return v;
}

function expectBase58(v: unknown, field: string): string {
  if (!isStr(v) || !isValidSolanaAddress(v)) {
    throw new Error(`solana qr: '${field}' must be a valid base58 address`);
  }
  return v;
}

function optBase58(v: unknown, field: string): string | null {
  if (v === null) return null;
  if (!isStr(v) || !isValidSolanaAddress(v)) {
    throw new Error(`solana qr: '${field}' must be a valid base58 address or null`);
  }
  return v;
}

function expectAmt(v: unknown): string {
  if (!isStr(v) || !DECIMAL_RE.test(v) || v.length === 0) {
    throw new Error("solana qr: 'amt' must be a decimal-digit string");
  }
  // Leading zeros are accepted by DECIMAL_RE; canonicalize on compare via BigInt (no leading-zero
  // ambiguity since `String(Bigint('007'))` would differ — but the canonical re-serializer uses the
  // ORIGINAL string, so producer+consumer match byte-exact regardless). Enforce value bounds:
  let n: bigint;
  try { n = BigInt(v); } catch { throw new Error("solana qr: 'amt' is not a valid integer"); }
  if (n <= 0n) throw new Error("solana qr: 'amt' must be greater than zero");
  if (n > AMT_MAX_BIGINT) throw new Error("solana qr: 'amt' exceeds 2^64-1");
  return v;
}

function expectNonNegSafeInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new Error(`solana qr: '${field}' must be a safe non-negative integer`);
  }
  return v;
}

function expectBoundedStr(v: unknown, field: string, max: number): string {
  if (!isStr(v)) throw new Error(`solana qr: '${field}' must be a string`);
  if (v.length > max) throw new Error(`solana qr: '${field}' exceeds ${max} chars`);
  return v;
}

/** Validate a parsed request object. Enforces cross-field rules: SOL ⇒ mint+toAta null; a
 *  non-SOL token ⇒ both present and valid base58; the iat<exp≤iat+90 lifetime window; and the
 *  per-field bounds above. SHAPE only — token MEMBERSHIP (is this mint one we pay?) is the
 *  engine/component layer's call, never the codec's. */
function validateReq(obj: unknown): SolReqV2 {
  if (!isObj(obj)) throw new Error('solana qr: request payload is not an object');
  if (obj.v !== SOL_QR_VERSION) {
    throw new Error(`solana qr: unsupported request version ${String(obj.v)}`);
  }
  const rid = expectRid(obj.rid);
  const net = expectNet(obj.net);
  const bh = expectBase58(obj.bh, 'bh');
  const lvh = expectNonNegSafeInt(obj.lvh, 'lvh');
  const slot = expectNonNegSafeInt(obj.slot, 'slot');
  const iat = expectNonNegSafeInt(obj.iat, 'iat');
  const exp = expectNonNegSafeInt(obj.exp, 'exp');
  if (!(iat < exp)) throw new Error("solana qr: 'exp' must be strictly greater than 'iat'");
  if (exp > iat + 90) throw new Error("solana qr: 'exp' must be at most 'iat' + 90");
  const cur = obj.cur;
  if (!isStr(cur) || !TOKEN_RE.test(cur)) {
    throw new Error("solana qr: 'cur' must be an uppercase token symbol ([A-Z0-9]{2,10})");
  }
  const to = expectBase58(obj.to, 'to');
  const amt = expectAmt(obj.amt);
  const mint = optBase58(obj.mint, 'mint');
  const toAta = optBase58(obj.toAta, 'toAta');
  if (cur === 'SOL') {
    if (mint !== null) throw new Error("solana qr: 'mint' must be null for SOL");
    if (toAta !== null) throw new Error("solana qr: 'toAta' must be null for SOL");
  } else {
    if (mint === null) throw new Error(`solana qr: 'mint' is required for ${cur}`);
    if (toAta === null) throw new Error(`solana qr: 'toAta' is required for ${cur}`);
  }
  const name = expectBoundedStr(obj.name, 'name', MAX_NAME_LEN);
  const memo = expectBoundedStr(obj.memo, 'memo', MAX_MEMO_LEN);
  return {v: 2, rid, net, bh, lvh, slot, iat, exp, to, amt, cur, mint, toAta, name, memo};
}

/** Validate a parsed payment object. `tx` is a base64url STRING in the JSON; decoded to bytes here.
 *  The only fields allowed are v, rid, tx — anything else is rejected (no untrusted echoed claims). */
function validatePay(obj: unknown): SolPayV2 {
  if (!isObj(obj)) throw new Error('solana qr: payment payload is not an object');
  if (obj.v !== SOL_QR_VERSION) {
    throw new Error(`solana qr: unsupported payment version ${String(obj.v)}`);
  }
  const rid = expectRid(obj.rid);
  const txField = obj.tx;
  if (!isStr(txField) || txField.length === 0) {
    throw new Error("solana qr: 'tx' must be a non-empty base64url string");
  }
  const txBytes = base64UrlToBytes(txField);
  if (txBytes === null || txBytes.length === 0) {
    throw new Error("solana qr: 'tx' is not valid base64url");
  }
  if (txBytes.length > MAX_TX_LEN) {
    throw new Error(`solana qr: 'tx' exceeds ${MAX_TX_LEN} bytes (Solana packet limit)`);
  }
  return {v: 2, rid, tx: txBytes};
}

// --- codec ------------------------------------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Strip the `scheme:v2?` prefix. Strict — no trimming of leading/trailing whitespace, no padding.
 *  Distinguishes "wrong scheme" from "wrong version" for a debuggable error. */
function splitPayload(raw: string, scheme: string, version: number): string {
  // No leading whitespace — strict.
  const colon = raw.indexOf(':');
  if (colon <= 0) {
    throw new Error(`solana qr: not a ${scheme} payload`);
  }
  const foundScheme = raw.slice(0, colon);
  if (foundScheme !== scheme) {
    throw new Error(`solana qr: not a ${scheme} payload (got scheme '${foundScheme}')`);
  }
  // Check the version tag explicitly: scheme matches but version differs.
  const expectedVerTag = `:v${version}?`;
  const afterScheme = raw.slice(colon);
  if (!afterScheme.startsWith(expectedVerTag)) {
    // Find the version tag they actually used to surface it in the error.
    const q = afterScheme.indexOf('?');
    const theirTag = q > 0 ? afterScheme.slice(1, q) : afterScheme.slice(1);
    throw new Error(`solana qr: unsupported ${scheme} version '${theirTag}' (expected v${version})`);
  }
  return raw.slice(colon + expectedVerTag.length);
}

function decodePayload(raw: string, scheme: string): {bytes: Uint8Array; b64u: string} {
  const b64u = splitPayload(raw, scheme, SOL_QR_VERSION);
  if (b64u.length === 0) {
    throw new Error(`solana qr: empty ${scheme} payload`);
  }
  // Strict base64url: only the url-safe alphabet, NO padding, NO whitespace. The tolerant decoder in
  // lib/base64.ts strips `=` and `\s`; we forbid them here so the canonical round-trip is preserved.
  if (!BASE64URL_RE.test(b64u)) {
    throw new Error(`solana qr: ${scheme} payload is not canonical base64url (padding/whitespace/charset)`);
  }
  const bytes = base64UrlToBytes(b64u);
  if (bytes === null) {
    throw new Error(`solana qr: malformed ${scheme} payload (bad base64url)`);
  }
  if (raw.length > MAX_URI_LEN) {
    throw new Error(`solana qr: ${scheme} URI exceeds ${MAX_URI_LEN} chars`);
  }
  return {bytes, b64u};
}

export function encodeSolReq(input: SolReqInput): string {
  // The codec owns the version; encode stamps it. Validation runs on the assembled object so a
  // caller bug (e.g. USDC with no mint) is caught at the producer, not just at the consumer.
  const req: SolReqV2 = {v: 2, ...input};
  validateReq(req);
  const json = canonicalReqJson(req);
  const uri = SOL_REQ_PREFIX + bytesToBase64Url(utf8ToBytes(json));
  if (uri.length > MAX_URI_LEN) {
    throw new Error(`solana qr: solreq URI exceeds ${MAX_URI_LEN} chars`);
  }
  return uri;
}

export function decodeSolReq(raw: string): SolReqV2 {
  const {bytes} = decodePayload(raw, "solreq");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytesToUtf8(bytes));
  } catch {
    throw new Error('solana qr: malformed solreq payload (not JSON)');
  }
  const validated = validateReq(parsed);
  // Canonical byte check: re-serialize canonically and compare to the input bytes. Any non-canonical
  // input (reordered keys, whitespace, extra fields, trailing bytes) diverges here.
  const canonical = utf8ToBytes(canonicalReqJson(validated));
  if (!bytesEqual(canonical, bytes)) {
    throw new Error('solana qr: solreq payload is not canonical (key order/whitespace/extra/trailing)');
  }
  return validated;
}

export function encodeSolPay(input: SolPayInput): string {
  if (input.tx.length === 0) throw new Error("solana qr: 'tx' must be non-empty");
  if (input.tx.length > MAX_TX_LEN) {
    throw new Error(`solana qr: 'tx' exceeds ${MAX_TX_LEN} bytes (Solana packet limit)`);
  }
  const pay: SolPayV2 = {v: 2, rid: expectRid(input.rid), tx: input.tx};
  const json = canonicalPayJson(pay);
  const uri = SOL_PAY_PREFIX + bytesToBase64Url(utf8ToBytes(json));
  if (uri.length > MAX_URI_LEN) {
    throw new Error(`solana qr: solpay URI exceeds ${MAX_URI_LEN} chars`);
  }
  return uri;
}

export function decodeSolPay(raw: string): SolPayV2 {
  const {bytes} = decodePayload(raw, "solpay");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytesToUtf8(bytes));
  } catch {
    throw new Error('solana qr: malformed solpay payload (not JSON)');
  }
  // Reject extra fields BEFORE validatePay (which only checks the known fields). The canonical byte
  // check below catches extras, but a clearer error here helps debugging.
  if (isObj(parsed)) {
    const keys = Object.keys(parsed);
    if (keys.length !== 3 || !keys.includes('v') || !keys.includes('rid') || !keys.includes('tx')) {
      throw new Error("solana qr: solpay payload must contain only 'v', 'rid', 'tx'");
    }
  }
  const validated = validatePay(parsed);
  // Canonical byte check.
  const canonical = utf8ToBytes(canonicalPayJson(validated));
  if (!bytesEqual(canonical, bytes)) {
    throw new Error('solana qr: solpay payload is not canonical (key order/whitespace/extra/trailing)');
  }
  return validated;
}

// --- rid generator (secure random; codec stays pure) -----------------------------------------
//
// 16 random bytes → 32 lowercase hex chars. Uses globalThis.crypto.getRandomValues (works on RN via
// the `react-native-get-random-values` polyfill wired in app/index.js, natively on web, and via a
// test-override seam `globalThis.__DPAY_TEST_RNG` for deterministic jest vectors). NEVER Math.random.

const HEX_DIGITS = '0123456789abcdef';

export function generateRid(): string {
  // Look up the RNG at CALL time (not module-load time) so the test-override seam can be installed
  // after the module has been imported.
  const r =
    (globalThis as unknown as {__DPAY_TEST_RNG?: {getRandomValues: (a: Uint8Array) => Uint8Array}}).__DPAY_TEST_RNG ??
    globalThis.crypto;
  const buf = new Uint8Array(16);
  r.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += HEX_DIGITS[buf[i] >> 4];
    out += HEX_DIGITS[buf[i] & 0x0f];
  }
  if (!RID_RE.test(out)) {
    // Defensive: getRandomValues is required to produce uniform bytes; a non-conforming RNG would
    // surface here rather than as a downstream decode failure.
    throw new Error('solana qr: generateRid produced a non-conforming rid');
  }
  return out;
}
