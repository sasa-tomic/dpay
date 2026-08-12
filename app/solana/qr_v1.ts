// PHASE-3-DELETE — v1 durable-nonce codec, preserved verbatim from HEAD for the still-v1 UI
// components (SolPayMode / SolReceiveMode / SolNfcTap), the still-v1 seam (solana.ts), and the
// still-v1 seam test (solana-seam.test.ts). Phase 2 migrates these consumers to the v2
// recent-blockhash codec in qr.ts; Phase 3 deletes this entire file. The v2 codec in qr.ts is the
// canonical replacement (pure, frozen by solana-qr.test.ts golden round-trips).
//
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
import {bytesToBase64Url, base64UrlToBytes, utf8ToBytes, bytesToUtf8} from '../lib/base64url';

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

// base64url (RFC 4648 §5) + UTF-8 codecs live in `../lib/base64url.ts` (the single source of truth,
// shared with `lib/deepLink.ts`'s receipt-handback codec). Extracted 2026-08-08 so the IC deeplink
// path doesn't re-implement them and doesn't couple to this SOL QR module.

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
