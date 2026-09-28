// `evmreq:v1` / `evmpay:v1` URI codec for the EVM offline-permit rail (D21 of the EVM-rail spec).
//
// PURE module — no network, no React, no Buffer/btoa/TextEncoder (the base64url + UTF-8 codecs are
// hand-rolled in `../lib/base64url.ts` and identical on RN/Hermes, jest/Node, and the e2e browser
// bundle). All decode paths throw errors carrying a TYPED `kind` ('bad-scheme' | 'bad-base64' |
// 'bad-json' | 'bad-field' | 'bad-window' | 'non-canonical' | 'too-long') — never a silent failure.
//
// This is the app-side TWIN of `e2e/harness/evm/qr.mjs` (committed, flow-215-pinned). The two must
// never diverge: the exact canonical JSON key order, the `0x`-prefixed 130-hex sig spelling and the
// 600s window are shared wire facts, so each side asserts the other's bytes in its own test suite.
//
// SCHEMAS (frozen):
//
//   evmreq:v1?<base64url(json)>   merchant → payer (works OFFLINE on both sides)
//   evmpay:v1?<base64url(json)>   payer → merchant (the offline permit claim)
//
// The HARD CANONICAL INVARIANT: `encodeEvmReq(decodeEvmReq(raw)) === raw` for every valid URI.
// Decoding must NOT trim, normalize, re-order JSON keys, pad base64url, or accept trailing bytes;
// any drift is a hard reject ('non-canonical').
//
// SIZE CAPS + WINDOW: name/memo ≤ 32 UTF-16 units (IC `NAME_LEN` parity, same cap as the SOL rail);
// URI ≤ 2000 chars (safe QR + URL limit); request window `iat < exp ≤ iat + 600` — 600s, not SOL's
// 90s: replay protection is the ON-CHAIN permit nonce, not a short client window (D21), so
// generosity costs nothing under the settle-first-wins model (D24).

import {bytesToBase64Url, base64UrlToBytes, utf8ToBytes, bytesToUtf8} from '../lib/base64url';

export const EVM_QR_VERSION = 1;

const EVM_REQ_PREFIX = `evmreq:v${EVM_QR_VERSION}?`;
const EVM_PAY_PREFIX = `evmpay:v${EVM_QR_VERSION}?`;

const MAX_NAME_LEN = 32;
const MAX_MEMO_LEN = 32;
const MAX_URI_LEN = 2000;
/** The request window: `iat < exp ≤ iat + 600` (unix seconds; exp doubles as the EIP-2612 deadline). */
export const EVM_REQ_WINDOW_SECONDS = 600;

/** Merchant → payer request. `amt` is a decimal-digit string of RAW smallest units (18-dec ZCHF:
 *  wei-scale), BigInt-safe — never a JS number (lossy past 2^53). `exp` is ALSO the permit
 *  deadline the payer signs (D21: `deadline == req.exp`). */
export interface EvmReqV1 {
  readonly v: 1;
  readonly rid: string;    // 32 lowercase hex (16 random bytes) — binds request ↔ claim ↔ receipt
  readonly chainId: number; // the settlement chain (42161 | 1 | 421614 | 31337)
  readonly token: string;  // 'ZCHF' (registry symbol; the contract resolves via evm/chains.ts)
  readonly to: string;     // merchant 0x address (the permit's spender / transferFrom recipient)
  readonly amt: string;    // decimal-digit string of raw units, > 0, ≤ uint256
  readonly iat: number;    // unix seconds
  readonly exp: number;    // unix seconds; iat < exp ≤ iat + 600; == the EIP-2612 deadline
  readonly name: string;   // merchant display name ("" ok)
  readonly memo: string;   // optional note ("" ok)
}

/** Payer → merchant offline claim. `sig` is the raw 65-byte EIP-2612 signature (r||s||v) spelled
 *  `0x` + 130 lowercase hex. The merchant submits it verbatim as permit()'s (v, r, s). */
export interface EvmPayV1 {
  readonly v: 1;
  readonly rid: string;    // echoes the request
  readonly owner: string;  // payer 0x address (the permit's `owner`, transferFrom's `from`)
  readonly deadline: number; // == req.exp (the permit's deadline field)
  readonly sig: string;    // 0x + 130 lowercase hex — 65 bytes r||s||v
}

/** The merchant's settle returns this to the payer; the payer decides what to believe (D25).
 *  `status`: 0=settled, 1=rejected/expired, 2=unknown (the settle timed out; the tx MAY land).
 *  Unknown codes are honest-unknown, never a false decline. `sig` is the merchant's own settle
 *  tx hash (a claim receipt is never a tx the merchant did not broadcast itself). */
export interface EvmReceiptV1 {
  readonly status: number;
  readonly rid: string;
  readonly sig: string; // 0x-prefixed tx hash (case-insensitive; compared lowercased, D25)
}

export type EvmReqInput = Omit<EvmReqV1, 'v'>;
export type EvmPayInput = Omit<EvmPayV1, 'v'>;

// --- canonical JSON (declared field order, compact — the harness twin's exact key order) ------

const REQ_KEYS = ['v', 'rid', 'chainId', 'token', 'to', 'amt', 'iat', 'exp', 'name', 'memo'] as const;
const PAY_KEYS = ['v', 'rid', 'owner', 'deadline', 'sig'] as const;

function canonicalJson(obj: object, keys: readonly string[]): string {
  const src = obj as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const k of keys) picked[k] = src[k];
  return JSON.stringify(picked);
}

// --- typed errors -------------------------------------------------------------------------------

export type EvmQrErrorKind =
  | 'bad-scheme'
  | 'bad-base64'
  | 'bad-json'
  | 'bad-field'
  | 'bad-window'
  | 'non-canonical'
  | 'too-long';

function qrError(kind: EvmQrErrorKind, detail: string): Error {
  const e = new Error(`evm qr: ${kind}: ${detail}`) as Error & {kind: EvmQrErrorKind};
  e.kind = kind;
  return e;
}

// --- validation (shared by encode + decode; single source of truth) ------------------------------

const HEX32_RE = /^[0-9a-f]{32}$/;
const HEX40_RE = /^0x[0-9a-fA-F]{40}$/;
const SIG_RE = /^0x[0-9a-f]{130}$/; // 0x + r(64) + s(64) + v(2), lowercase hex
const DIGITS_RE = /^[0-9]+$/;
const TOKEN_RE = /^[A-Z0-9]{2,10}$/; // registry symbol shape — 'ZCHF' now, future rows later
// 78 decimal digits ≤ uint256 max (2^256-1 has 78 digits); the codec is rail-generic, ERC-20
// amounts are uint256 and routinely exceed the IC rail's u64 bound.
const AMT_MAX_DIGITS = 78;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(kind: EvmQrErrorKind, msg: string): never {
  throw qrError(kind, msg);
}

/** Structural validation of a parsed request object. Shape only — token MEMBERSHIP (is this a
 *  token this wallet lists?) is the registry/catalog layer's call, never the codec's. */
export function assertEvmReqShape(obj: unknown): void {
  if (!isObj(obj)) field('bad-field', 'request payload is not an object');
  if (obj.v !== EVM_QR_VERSION) field('bad-field', `v must be 1, got ${JSON.stringify(obj.v)}`);
  if (typeof obj.rid !== 'string' || !HEX32_RE.test(obj.rid)) {
    field('bad-field', 'rid must be 32 lowercase hex chars');
  }
  if (typeof obj.chainId !== 'number' || !Number.isInteger(obj.chainId) || obj.chainId <= 0) {
    field('bad-field', 'chainId must be a positive integer');
  }
  if (typeof obj.token !== 'string' || !TOKEN_RE.test(obj.token)) {
    field('bad-field', 'token must be the registry symbol (2-10 A-Z0-9)');
  }
  if (typeof obj.to !== 'string' || !HEX40_RE.test(obj.to)) {
    field('bad-field', 'to must be a 0x + 40-hex address');
  }
  if (typeof obj.amt !== 'string' || !DIGITS_RE.test(obj.amt) || obj.amt.length > AMT_MAX_DIGITS) {
    field('bad-field', 'amt must be a decimal RAW-unit string (BigInt-safe, ≤ uint256)');
  }
  if (BigInt(obj.amt) <= 0n) field('bad-field', 'amt must be greater than zero');
  if (typeof obj.iat !== 'number' || !Number.isInteger(obj.iat)) {
    field('bad-field', 'iat must be unix seconds');
  }
  if (typeof obj.exp !== 'number' || !Number.isInteger(obj.exp)) {
    field('bad-field', 'exp must be unix seconds');
  }
  if (!(obj.iat < obj.exp && obj.exp <= obj.iat + EVM_REQ_WINDOW_SECONDS)) {
    field('bad-window', `iat < exp <= iat + ${EVM_REQ_WINDOW_SECONDS} must hold`);
  }
  if (typeof obj.name !== 'string' || obj.name.length > MAX_NAME_LEN) {
    field('bad-field', `name must be a string of ≤ ${MAX_NAME_LEN} UTF-16 units`);
  }
  if (typeof obj.memo !== 'string' || obj.memo.length > MAX_MEMO_LEN) {
    field('bad-field', `memo must be a string of ≤ ${MAX_MEMO_LEN} UTF-16 units`);
  }
}

/** Structural validation of a parsed claim object. `deadline` is checked against the request at
 *  the claim-binding layer (claims.ts), not here: the codec sees one object at a time. */
export function assertEvmPayShape(obj: unknown): void {
  if (!isObj(obj)) field('bad-field', 'claim payload is not an object');
  if (obj.v !== EVM_QR_VERSION) field('bad-field', `v must be 1, got ${JSON.stringify(obj.v)}`);
  if (typeof obj.rid !== 'string' || !HEX32_RE.test(obj.rid)) {
    field('bad-field', 'rid must be 32 lowercase hex chars');
  }
  if (typeof obj.owner !== 'string' || !HEX40_RE.test(obj.owner)) {
    field('bad-field', 'owner must be a 0x + 40-hex address');
  }
  if (!Number.isInteger(obj.deadline)) field('bad-field', 'deadline must be unix seconds');
  if (typeof obj.sig !== 'string' || !SIG_RE.test(obj.sig)) {
    field('bad-field', 'sig must be 0x + 130 lowercase hex chars (r||s||v, 65 bytes)');
  }
}

/** Non-throwing shape probes — the claim-queue hydrater's filter (a corrupt stored row is dropped,
 *  never displayed). Same rules as the assert variants. */
export function isValidEvmReqShape(obj: unknown): boolean {
  try {
    assertEvmReqShape(obj);
    return true;
  } catch {
    return false;
  }
}

export function isValidEvmPayShape(obj: unknown): boolean {
  try {
    assertEvmPayShape(obj);
    return true;
  } catch {
    return false;
  }
}

// --- codec --------------------------------------------------------------------------------------

function encodeUri(prefix: string, obj: object, keys: readonly string[]): string {
  const json = canonicalJson(obj, keys);
  const uri = prefix + bytesToBase64Url(utf8ToBytes(json));
  if (uri.length > MAX_URI_LEN) {
    throw qrError('too-long', `URI is ${uri.length} chars, cap is ${MAX_URI_LEN}`);
  }
  return uri;
}

function decodeUri(uri: string, prefix: string, keys: readonly string[], assertShape: (o: unknown) => void): Record<string, unknown> {
  if (typeof uri !== 'string' || !uri.startsWith(prefix)) {
    throw qrError('bad-scheme', `expected ${prefix}…`);
  }
  const b64u = uri.slice(prefix.length);
  // Strict canonical base64url: the lib decoder tolerates padding/whitespace, so re-encode and
  // compare — a padded, whitespace-bearing or trailing-bits-mangled payload cannot reproduce its
  // own spelling and is rejected exactly like the harness twin's strict decoder.
  const bytes = base64UrlToBytes(b64u);
  if (bytes === null || bytes.length === 0 || bytesToBase64Url(bytes) !== b64u) {
    throw qrError('bad-base64', 'payload is not canonical base64url');
  }
  let obj: unknown;
  try {
    obj = JSON.parse(bytesToUtf8(bytes));
  } catch {
    throw qrError('bad-json', 'payload is not JSON');
  }
  assertShape(obj);
  const canonical = canonicalJson(obj as Record<string, unknown>, keys);
  if (canonical !== bytesToUtf8(bytes)) {
    throw qrError('non-canonical', 're-encoding the payload does not reproduce the input bytes');
  }
  return obj as Record<string, unknown>;
}

/** Build the merchant request URI (the QR payload). Throws typed errors on any malformed field. */
export function encodeEvmReq(input: EvmReqInput): string {
  const req: EvmReqV1 = {v: EVM_QR_VERSION, ...input};
  assertEvmReqShape(req);
  return encodeUri(EVM_REQ_PREFIX, req, REQ_KEYS);
}

/** Decode + fully validate a request URI (strict canonical form — the HARD CANONICAL INVARIANT). */
export function decodeEvmReq(uri: string): EvmReqV1 {
  const obj = decodeUri(uri, EVM_REQ_PREFIX, REQ_KEYS, assertEvmReqShape);
  return {
    v: 1,
    rid: obj.rid as string,
    chainId: obj.chainId as number,
    token: obj.token as string,
    to: obj.to as string,
    amt: obj.amt as string,
    iat: obj.iat as number,
    exp: obj.exp as number,
    name: obj.name as string,
    memo: obj.memo as string,
  };
}

/** Build the payer's claim URI (the offline permit signature rides as 0x + 130 lowercase hex). */
export function encodeEvmPay(input: EvmPayInput): string {
  const pay: EvmPayV1 = {v: EVM_QR_VERSION, ...input};
  assertEvmPayShape(pay);
  return encodeUri(EVM_PAY_PREFIX, pay, PAY_KEYS);
}

/** Decode + fully validate a claim URI (strict canonical form). */
export function decodeEvmPay(uri: string): EvmPayV1 {
  const obj = decodeUri(uri, EVM_PAY_PREFIX, PAY_KEYS, assertEvmPayShape);
  return {
    v: 1,
    rid: obj.rid as string,
    owner: obj.owner as string,
    deadline: obj.deadline as number,
    sig: obj.sig as string,
  };
}

// --- expiry (D22.4 — mirrors isSolReqV2Expired semantics) ----------------------------------------

/** Whether an `evmreq:v1` has expired: valid THROUGH its expiry second (`nowSecs === exp` ⇒ NOT
 *  expired), one second later it is. `nowSecs` defaults to the wall clock and is a parameter so
 *  the boundary is unit-testable. The 600s advisory window cap is enforced at decode time
 *  ('bad-window'), matching the harness twin; this check is only the clock comparison. */
export function isEvmReqExpired(req: {exp: number}, nowSecs: number = Math.floor(Date.now() / 1000)): boolean {
  return nowSecs > req.exp;
}

// --- rid generator (secure random; the codec stays pure) ------------------------------------------
//
// 16 random bytes → 32 lowercase hex chars. globalThis.crypto.getRandomValues works on RN via the
// `react-native-get-random-values` polyfill (app/index.js), natively on web/Node, and through the
// `__DPAY_TEST_RNG` seam for deterministic jest vectors. NEVER Math.random.

const HEX_DIGITS = '0123456789abcdef';

export function generateRid(): string {
  // Looked up at CALL time so a test seam installed after import still takes effect.
  const r =
    (globalThis as unknown as {__DPAY_TEST_RNG?: {getRandomValues: (a: Uint8Array) => Uint8Array}})
      .__DPAY_TEST_RNG ?? globalThis.crypto;
  const buf = new Uint8Array(16);
  r.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += HEX_DIGITS[buf[i] >> 4];
    out += HEX_DIGITS[buf[i] & 0x0f];
  }
  if (!HEX32_RE.test(out)) {
    throw new Error('evm qr: generateRid produced a non-conforming rid');
  }
  return out;
}
