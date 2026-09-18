// DpayCore shim — the ONLY money-critical shim — backed by the SHARED WASM CORE
// (`crates/dpay-relay/assets/dpay-core.wasm`, compiled from `crates/dpay-wasm`, ABI v1).
//
// This is not a JS re-implementation: every byte the app signs, decodes, or verifies goes through
// the SAME Rust `dpay-core` that the Android app's UniFFI binding and the relay/canister use.
// The previous @noble/ed25519 JS shim (`dpay-core.ts`) was deleted with the facade wire
// (2026-08-19 IC-rail cutover): the retired JS-side `verifyWire` was its last consumer. The wasm
// core keeps the frozen ABI v1 `w_sign_request`/`w_sign_withdraw`/`w_verify_receipt_sig` exports
// (exercised by the wasm-core parity oracle), but the app surface no longer calls them.
//
// Loading: the wasm is a vite `?url` asset — hashed, same-origin, served straight from the dist
// (both the e2e sirv server and the relay's embedded web build). A Node/CI consumer can inject
// staged bytes instead via `globalThis.__DPAY_WASM_BYTES` (Uint8Array/ArrayBuffer) — the same
// injection-seam pattern as `initWalletWire` had.
//
// Memory discipline (frozen ABI v1): `w_alloc` is a bump allocator and wasm memory growth DETACHES
// JS views. Every helper below re-derives its `Uint8Array` view immediately after ANY `w_alloc`,
// and pointers are only ever written/read through fresh views.
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
// @ts-expect-error — vite asset URL import (no TS types; esbuild/vite handles it natively)
import wasmUrl from '../../crates/dpay-relay/assets/dpay-core.wasm?url';

// --- base64url codec (RFC 4648 §5, no pad) — byte-identical to Rust URL_SAFE_NO_PAD ------------
const B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_URL_REV: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B64_URL.length; i++) m[B64_URL[i]] = i;
  return m;
})();
const base64url = {
  encode(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += B64_URL[b0 >> 2];
      out += B64_URL[((b0 & 0x03) << 4) | (b1 >> 4)];
      if (i + 1 < bytes.length) out += B64_URL[((b1 & 0x0f) << 2) | (b2 >> 6)];
      if (i + 2 < bytes.length) out += B64_URL[b2 & 0x3f];
    }
    return out;
  },
  decode(s: string): Uint8Array {
    const cleaned = s.replace(/=+$/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < cleaned.length; i += 4) {
      const c0 = B64_URL_REV[cleaned[i]];
      const c1 = B64_URL_REV[cleaned[i + 1]];
      const c2 = i + 2 < cleaned.length ? B64_URL_REV[cleaned[i + 2]] : undefined;
      const c3 = i + 3 < cleaned.length ? B64_URL_REV[cleaned[i + 3]] : undefined;
      if (c0 === undefined || c1 === undefined) throw new Error('base64url: bad char');
      bytes.push((c0 << 2) | (c1 >> 4));
      if (c2 !== undefined) bytes.push(((c1 & 0x0f) << 4) | (c2 >> 2));
      if (c3 !== undefined) bytes.push(((c2 & 0x03) << 6) | c3);
    }
    return new Uint8Array(bytes);
  },
};

// --- hex codec ----------------------------------------------------------------------------------
function hex(h: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0) {
    throw new Error('Length'); // mirrors CodecError::Length semantics for hex-shaped fields
  }
  return hexToBytes(h);
}

// --- wasm core types ----------------------------------------------------------------------------
type FieldSpec = { offset: number; len: number; endian: 'le' | null };
type WireFieldSpec = { offset: number; len: number };
type Layout = {
  signing_len: number; wire_len: number; request_len: number; sig_len: number;
  pubkey_len: number; nonce_len: number;
  fields: { from: FieldSpec; to: FieldSpec };
  wire_fields: { signing: WireFieldSpec; sig: WireFieldSpec; from_pub: WireFieldSpec };
};
type WasmExports = WebAssembly.Exports & {
  w_alloc(size: number): number;
  w_abi_version(): number;
  w_layout_json(out: number, cap: number): number;
  w_pubkey(seedPtr: number, out32: number): number;
  w_sign_request(seedPtr: number, reqPtr: number, fromNamePtr: number, fromNameLen: number, outWirePtr: number): number;
  w_decode_request(reqPtr: number, outJsonPtr: number, cap: number): number;
  w_sign_withdraw(seedPtr: number, destPtr: number, destLen: number, amountLo: number, amountHi: number, noncePtr: number, expiryLo: number, expiryHi: number, currency: number, outSigPtr: number): number;
  w_verify_receipt_sig(pubPtr: number, claimPtr: number, claimLen: number, sigPtr: number): number;
  w_build_request(toPtr: number, amountLo: number, amountHi: number, noncePtr: number, expiryLo: number, expiryHi: number, currency: number, toNamePtr: number, toNameLen: number, memoPtr: number, memoLen: number, outReqPtr: number): number;
  w_receipt_claim(noncePtr: number, fromPtr: number, toPtr: number, amountLo: number, amountHi: number, currency: number, blockLo: number, blockHi: number, tsLo: number, tsHi: number, outClaimPtr: number): number;
  w_till_open_sig(seedPtr: number, centsLo: number, centsHi: number, noncePtr: number, iatLo: number, iatHi: number, namePtr: number, nameLen: number, outSigPtr: number): number;
  // IC user-principal rail (additive, ABI v1): all strings are ptr+len pairs; decimal-string
  // numerics; structured results are compact JSON returned by length (0 = cap/bad input).
  w_icp_self_principal(seedPtr: number, outPtr: number, cap: number): number;
  w_icp_principal_from_pubkey(ptr: number, len: number, outPtr: number, cap: number): number;
  w_icp_validate_principal(ptr: number, len: number, outPtr: number, cap: number): number;
  w_icp_validate_icrc_account(ptr: number, len: number, outPtr: number, cap: number): number;
  w_icp_validate_account_id(ptr: number, len: number, outPtr: number, cap: number): number;
  w_icp_account_id_from_principal(ownerPtr: number, ownerLen: number, subPtr: number, subLen: number, outPtr: number, cap: number): number;
  w_icp_legacy_transfer_arg(toPtr: number, toLen: number, fromSubPtr: number, fromSubLen: number, amountPtr: number, amountLen: number, feePtr: number, feeLen: number, memoPtr: number, memoLen: number, outPtr: number, cap: number): number;
  w_icp_decode_legacy_transfer_result(argPtr: number, argLen: number, outPtr: number, cap: number): number;
  w_icp_ingress_expiry(nowPtr: number, nowLen: number, aheadS: number, outPtr: number, cap: number): number;
  w_icp_transfer_arg(toOwnerPtr: number, toOwnerLen: number, toSubPtr: number, toSubLen: number, fromSubPtr: number, fromSubLen: number, amountPtr: number, amountLen: number, feePtr: number, feeLen: number, memoPtr: number, memoLen: number, outPtr: number, cap: number): number;
  w_icp_approve_arg(spenderOwnerPtr: number, spenderOwnerLen: number, spenderSubPtr: number, spenderSubLen: number, fromSubPtr: number, fromSubLen: number, amountPtr: number, amountLen: number, expectedPtr: number, expectedLen: number, expiresPtr: number, expiresLen: number, memoPtr: number, memoLen: number, feePtr: number, feeLen: number, outPtr: number, cap: number): number;
  w_icp_balance_of_arg(ownerPtr: number, ownerLen: number, subPtr: number, subLen: number, outPtr: number, cap: number): number;
  w_icp_minter_account_arg(ownerPtr: number, ownerLen: number, subPtr: number, subLen: number, outPtr: number, cap: number): number;
  w_icp_retrieve_btc_arg(addrPtr: number, addrLen: number, amountPtr: number, amountLen: number, subPtr: number, subLen: number, outPtr: number, cap: number): number;
  w_icp_withdraw_eth_arg(recipPtr: number, recipLen: number, amountPtr: number, amountLen: number, subPtr: number, subLen: number, outPtr: number, cap: number): number;
  w_icp_withdraw_erc20_arg(amountPtr: number, amountLen: number, ledgerPtr: number, ledgerLen: number, recipPtr: number, recipLen: number, sub1Ptr: number, sub1Len: number, sub2Ptr: number, sub2Len: number, outPtr: number, cap: number): number;
  w_icp_eip1559_price_arg(ledgerPtr: number, ledgerLen: number, outPtr: number, cap: number): number;
  w_icp_decode_text(argPtr: number, argLen: number, outPtr: number, cap: number): number;
  w_icp_decode_eip1559_price(argPtr: number, argLen: number, outPtr: number, cap: number): number;
  w_icp_sign_update(seedPtr: number, canisterPtr: number, canisterLen: number, methodPtr: number, methodLen: number, argPtr: number, argLen: number, expiryPtr: number, expiryLen: number, outPtr: number, cap: number): number;
  w_icp_sign_query(seedPtr: number, canisterPtr: number, canisterLen: number, methodPtr: number, methodLen: number, argPtr: number, argLen: number, expiryPtr: number, expiryLen: number, outPtr: number, cap: number): number;
  w_icp_sign_read_state(seedPtr: number, ridsPtr: number, nRids: number, wantTime: number, expiryPtr: number, expiryLen: number, outPtr: number, cap: number): number;
  w_icp_envelope_request_id(envPtr: number, envLen: number, outPtr: number): number;
  w_icp_decode_query(bodyPtr: number, bodyLen: number, outPtr: number, cap: number): number;
  w_icp_decode_read_state(bodyPtr: number, bodyLen: number, ridsPtr: number, nRids: number, outPtr: number, cap: number): number;
  w_icp_decode_transfer_result(argPtr: number, argLen: number, outPtr: number, cap: number): number;
  w_icp_decode_minter_ok(argPtr: number, argLen: number, outPtr: number, cap: number): number;
  w_icp_decode_int(argPtr: number, argLen: number, outPtr: number, cap: number): number;
  w_icp_deposit_and_swap_arg(amountInPtr: number, amountInLen: number, minOutPtr: number, minOutLen: number, feeInPtr: number, feeInLen: number, feeOutPtr: number, feeOutLen: number, zeroForOne: number, outPtr: number, cap: number): number;
  w_icp_swap_min_out(quotedPtr: number, quotedLen: number, slippageBps: number, outPtr: number, cap: number): number;
  w_icp_decode_swap_result(argPtr: number, argLen: number, outPtr: number, cap: number): number;
  memory: WebAssembly.Memory;
};

const ABI_VERSION = 1;
const WIRE_LEN = 292;
const SIGNING_LEN = 196;
const REQUEST_LEN = 132;
const SIG_LEN = 64;
const PUBKEY_LEN = 32;
const NONCE_LEN = 16;
const WASM_FETCH_TIMEOUT_MS = 10_000;

let layout: Layout | null = null;
let exports_: WasmExports | null = null;
let initP: Promise<WasmExports> | null = null;

/** Idempotent lazy init of the wasm instance (first method call warms it). */
function core(): Promise<WasmExports> {
  if (!initP) initP = init().catch((e) => { initP = null; throw e; });
  return initP;
}

/** u64 as a (lo, hi) u32 pair via BigInt — the full u64 range stays exact. */
function splitU64(v: string | number | bigint): [number, number] {
  const n = BigInt(v);
  return [Number(n & 0xffffffffn), Number((n >> 32n) & 0xffffffffn)];
}

/** Map a wasm status code to the error the app expects (mirrors CodecError names). */
function bail(status: number, what: string): never {
  const cause = status === 1 ? 'Length' : status === 2 ? 'Utf8' : status === 3 ? 'Verify' : `Wasm${status}`;
  throw new Error(`DpayCore wasm: ${what} failed (${cause})`);
}

/** Allocate + copy bytes into wasm memory. Returns the pointer. Re-derives the view AFTER the
 *  alloc (memory growth detaches JS views — ABI v1 bump allocator). */
function put(ex: WasmExports, bytes: Uint8Array): number {
  const p = ex.w_alloc(bytes.length);
  if (p === 0) throw new Error('DpayCore wasm: w_alloc OOM');
  new Uint8Array(ex.memory.buffer).set(bytes, p);
  return p;
}

/** Read `len` bytes at `ptr` into a FRESH copy (never a live view). */
function readBytes(ex: WasmExports, ptr: number, len: number): Uint8Array {
  return new Uint8Array(ex.memory.buffer).slice(ptr, ptr + len);
}

/** Read `len` bytes at `ptr` as UTF-8 text. */
function readStr(ex: WasmExports, ptr: number, len: number): string {
  return new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr, len));
}

async function loadBytes(): Promise<Uint8Array> {
  const seam = (globalThis as Record<string, unknown>).__DPAY_WASM_BYTES;
  if (seam instanceof Uint8Array) return seam;
  if (seam instanceof ArrayBuffer) return new Uint8Array(seam);
  if (typeof fetch !== 'function') {
    throw new Error('DpayCore wasm: no __DPAY_WASM_BYTES seam and no fetch (Node?) — inject staged bytes');
  }
  // Bounded fetch (A-F3): a hung CDN/connection must never hang wallet boot. Manual AbortController
  // + setTimeout compose — NOT AbortSignal.timeout/AbortSignal.any (absent from Hermes) — mirroring
  // app/lib/timeout.ts / app/solana/rpc.ts.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WASM_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(wasmUrl as string, {signal: ctrl.signal});
    if (!r.ok) throw new Error(`DpayCore wasm: fetch ${wasmUrl} → HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    if (ctrl.signal.aborted) {
      throw new Error(`DpayCore wasm: fetch ${wasmUrl} timed out after ${WASM_FETCH_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function init(): Promise<WasmExports> {
  const bytes = await loadBytes();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports as unknown as WasmExports;
  if (typeof ex.w_abi_version !== 'function' || ex.w_abi_version() !== ABI_VERSION) {
    throw new Error(`DpayCore wasm: ABI mismatch (expected v${ABI_VERSION})`);
  }
  // Layout: single-sourced from the wasm itself (w_layout_json) — never hand-transcribed, never a
  // second JSON copy. Fail LOUD if the frozen wire sizes ever drift.
  const cap = 8192;
  const out = ex.w_alloc(cap);
  if (out === 0) throw new Error('DpayCore wasm: w_alloc OOM (layout)');
  const len = ex.w_layout_json(out, cap);
  if (len === 0 || len > cap) throw new Error('DpayCore wasm: w_layout_json buffer too small');
  const parsed = JSON.parse(readStr(ex, out, len)) as Layout;
  const eq = (a: unknown, b: unknown, msg: string) => {
    if (a !== b) throw new Error(`DpayCore wasm: layout ${msg} drift (got ${a}, expected ${b}) — REFUSING to run`);
  };
  eq(parsed.signing_len, SIGNING_LEN, 'signing_len');
  eq(parsed.wire_len, WIRE_LEN, 'wire_len');
  eq(parsed.request_len, REQUEST_LEN, 'request_len');
  eq(parsed.sig_len, SIG_LEN, 'sig_len');
  eq(parsed.pubkey_len, PUBKEY_LEN, 'pubkey_len');
  eq(parsed.nonce_len, NONCE_LEN, 'nonce_len');
  layout = parsed;
  exports_ = ex;
  return ex;
}

/** encodeRequest: the 132-byte request via w_build_request (the wasm
 *  truncates + NUL-pads the display fields itself). */
async function buildRequestBytes(
  ex: WasmExports, toHex: string, amount: string | number, nonceHex: string, expiry: number,
  currency: number, toName: string, memo: string,
): Promise<Uint8Array> {
  const to = hex(toHex);
  const nonce = hex(nonceHex);
  if (to.length !== PUBKEY_LEN) throw new Error(`to length: ${to.length}`);
  if (nonce.length !== NONCE_LEN) throw new Error(`nonce length: ${nonce.length}`);
  const toNameB = new TextEncoder().encode(toName);
  const memoB = new TextEncoder().encode(memo);
  const toP = put(ex, to);
  const nonceP = put(ex, nonce);
  const tnP = put(ex, toNameB);
  const mP = put(ex, memoB);
  const out = ex.w_alloc(REQUEST_LEN);
  if (out === 0) throw new Error('DpayCore wasm: w_alloc OOM (request)');
  const [amtLo, amtHi] = splitU64(amount);
  const [expLo, expHi] = splitU64(expiry);
  const st = ex.w_build_request(toP, amtLo, amtHi, nonceP, expLo, expHi, currency, tnP, toNameB.length, mP, memoB.length, out);
  if (st !== 0) bail(st, 'w_build_request');
  return readBytes(ex, out, REQUEST_LEN);
}

async function encodeRequest(
  toHex: string, amount: string | number, nonceHex: string, expiry: number, currency: number,
  toName = '', memo = '',
): Promise<string> {
  const ex = await core();
  return base64url.encode(await buildRequestBytes(ex, toHex, amount, nonceHex, expiry, currency, toName, memo));
}

/** Hex of the raw 132-byte request — the `DpayNfc.buildRequest` contract (mirrors Android's
 *  `nfcRequestBytes` → hex, same Rust builder through the shared wasm core). Exported so the web
 *  NFC shim can arm reader mode in e2e exactly like the device does. */
async function buildRequestHex(
  toHex: string, amount: string | number, nonceHex: string, expiry: number, currency: number,
  toName = '', memo = '',
): Promise<string> {
  const ex = await core();
  const bytes = await buildRequestBytes(ex, toHex, amount, nonceHex, expiry, currency, toName, memo);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

async function decodeRequest(
  qr: string,
): Promise<{ toHex: string; amount: string; nonceHex: string; expiry: number; currency: number; toName: string; memo: string }> {
  const ex = await core();
  // The QR is plain base64url; tolerate a stray `|name` suffix defensively (it carries no name).
  const b64 = qr.includes('|') ? qr.slice(0, qr.indexOf('|')) : qr;
  let bytes: Uint8Array;
  try {
    bytes = base64url.decode(b64);
  } catch {
    throw new Error('Base64');
  }
  if (bytes.length !== REQUEST_LEN) throw new Error('Length');
  const reqP = put(ex, bytes);
  const cap = 2048;
  const out = ex.w_alloc(cap);
  if (out === 0) throw new Error('DpayCore wasm: w_alloc OOM (decode)');
  const len = ex.w_decode_request(reqP, out, cap);
  if (len === 0 || len > cap) throw new Error('Length');
  const j = JSON.parse(readStr(ex, out, len)) as {
    toHex: string; amount: string; nonceHex: string; expiry: string; currency: number; toName: string; memo: string;
  };
  // u64s come back as decimal STRINGS (lossless above 2^53) — same shape the app already handles.
  return { toHex: j.toHex, amount: j.amount, nonceHex: j.nonceHex, expiry: j.expiry, currency: j.currency, toName: j.toName, memo: j.memo };
}

// (encodeQr / verifyWire retired with the 292-byte facade wire; signWithdrawal / verifyReceiptSig
// retired with the offramp/user-principal cutover — the offramp signs user-principal envelopes and
// receipts are canister-signed no longer. Frozen ABI v1 exports stay compiled for the parity oracle.)

export function randNonceHex(): string {
  const buf = new Uint8Array(NONCE_LEN);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return bytesToHex(buf);
}

// `window.__DPAY_TEST_NFC_STATUS` override seam (unchanged from the noble shim): defaults to
// 'unknown' so the Pay screen shows the NFC-unavailable row and NfcTap never mounts — the right
// web default; a test flips it to 'ready' to drive the NFC tap phases via the session seam.
async function nfcStatus(): Promise<string> {
  if (typeof window !== 'undefined') {
    const v = (window as unknown as Record<string, unknown>).__DPAY_TEST_NFC_STATUS;
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return 'unknown';
}

// --- IC user-principal rail (mirrors app/lib/types.ts DpayCoreApi icp* methods) -------------------
//
// Same money-critical rule as the rest of this shim: every envelope/arg byte is produced by the
// shared Rust core (dpay-icp compiled into dpay-wasm); JS only marshals. Numbers that can exceed
// 2^53 (ns timestamps, u128 amounts) cross as decimal STRINGS; bytes as lowercase hex; structured
// results arrive as compact JSON from the wasm (0 = cap too small / bad input).

export type IcpSignedUpdateOut = { envelopeHex: string; requestIdHex: string };
export type IcpQueryReplyOut = {
  replied: boolean; argHex?: string; rejectCode?: string; rejectMessage?: string; errorCode?: string | null;
};
export type IcpRequestStatusOut = {
  requestIdHex: string;
  state: 'unknown' | 'received' | 'processing' | 'replied' | 'rejected' | 'done';
  replyArgHex?: string; rejectCode?: string; rejectMessage?: string; errorCode?: string | null;
};
export type IcpStateReadOut = { timeNs: string | null; statuses: IcpRequestStatusOut[] };
export type IcpTransferOutcomeOut = { ok: boolean; blockIndex?: string; errVariant?: string; errDetail?: string };
export type IcpSwapReplyOut = { ok: boolean; amountOutGross?: string; errVariant?: string; errDetail?: string };
export type IcpEip1559PriceOut = {
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  maxTransactionFee: string;
  timestampNs?: string;
};

const ICP_JSON_CAP = 4096;
const ICP_ENV_CAP = 2048; // envelopes are 388-398B; generous headroom

/** Write a UTF-8 string into wasm memory, returning (ptr, len). */
function putStr(ex: WasmExports, s: string): [number, number] {
  const b = new TextEncoder().encode(s);
  return [put(ex, b), b.length];
}

/** Allocate a `cap`-byte out buffer. Returns the pointer (0 = OOM, throws). */
function outBuf(ex: WasmExports, cap: number, what: string): number {
  const p = ex.w_alloc(cap);
  if (p === 0) throw new Error(`DpayCore wasm: w_alloc OOM (${what})`);
  return p;
}

/** Run a length-returning JSON export and parse the result. 0 → throw (mirrors bail()).
 * Small returns (1–3) are the wasm error codes BAD_LEN/BAD_UTF8/VERIFY_FAILED (see the
 * contract table in dpay-wasm lib.rs), never real JSON — reject them explicitly so an
 * error is never read as a byte length (which yields garbage into JSON.parse). */
function jsonOut(ex: WasmExports, len: number, out: number, what: string): unknown {
  if (len === 0 || len > ICP_JSON_CAP) throw new Error(`DpayCore wasm: ${what} failed (bad input or cap)`);
  if (len <= 3) throw new Error(`DpayCore wasm: ${what} failed (wasm error code ${len})`);
  return JSON.parse(readStr(ex, out, len));
}

/** Run a length-returning BINARY export (arg/envelope bytes) and hex the result. */
function binOutHex(ex: WasmExports, len: number, out: number, what: string): string {
  if (len === 0) throw new Error(`DpayCore wasm: ${what} failed (bad input or cap)`);
  return bytesToHex(readBytes(ex, out, len));
}

async function icpSelfPrincipal(secretHex: string): Promise<string> {
  const ex = await core();
  const seedP = put(ex, hex(secretHex));
  const out = outBuf(ex, 128, 'icp_self_principal');
  const len = ex.w_icp_self_principal(seedP, out, 128);
  if (len === 0) throw new Error('DpayCore wasm: icp_self_principal failed');
  return readStr(ex, out, len);
}

async function icpPrincipalFromPubkey(pubkeyHex: string): Promise<string> {
  const ex = await core();
  const bytes = hex(pubkeyHex);
  if (bytes.length !== 32) throw new Error('DpayCore wasm: pubkey must be 32 bytes');
  const p = put(ex, bytes);
  const out = outBuf(ex, 128, 'icp_principal_from_pubkey');
  const len = ex.w_icp_principal_from_pubkey(p, 32, out, 128);
  if (len === 0) throw new Error('DpayCore wasm: icp_principal_from_pubkey failed');
  return readStr(ex, out, len);
}

/** Validate a payment link's destination principal through the REAL core parser (base32-CRC).
 *  A wasm status code (≤3) means the text is not a principal — thrown, never returned as a
 *  bogus 1–3 character "principal". */
async function icpValidatePrincipal(text: string): Promise<string> {
  const ex = await core();
  const [p, len0] = putStr(ex, text);
  const out = outBuf(ex, 128, 'icp_validate_principal');
  const len = ex.w_icp_validate_principal(p, len0, out, 128);
  if (len <= 3) throw new Error('DpayCore wasm: icp_validate_principal failed');
  return readStr(ex, out, len);
}

/** Parse a send-to-address destination as an ICRC-1 textual ACCOUNT — the bare principal every IC
 *  wallet's receive QR carries, or `principal-checksum.subaccount`. `subaccountHex` is EMPTY for
 *  the default subaccount, so it feeds straight into icpTransferArg. Throws on anything the core
 *  refuses (bad CRC, bad checksum, non-canonical) — never a partial "address". */
async function icpValidateIcrcAccount(text: string): Promise<{owner: string; subaccountHex: string}> {
  const ex = await core();
  const [p, len0] = putStr(ex, text);
  const out = outBuf(ex, ICP_JSON_CAP, 'icp_validate_icrc_account');
  const len = ex.w_icp_validate_icrc_account(p, len0, out, ICP_JSON_CAP);
  return jsonOut(ex, len, out, 'icp_validate_icrc_account') as {owner: string; subaccountHex: string};
}

/** Validate a 64-hex ICP account identifier (CRC-checked), returning canonical lowercase. */
async function icpValidateAccountId(text: string): Promise<string> {
  const ex = await core();
  const [p, len0] = putStr(ex, text);
  const out = outBuf(ex, 128, 'icp_validate_account_id');
  const len = ex.w_icp_validate_account_id(p, len0, out, 128);
  if (len <= 3) throw new Error('DpayCore wasm: icp_validate_account_id failed');
  return readStr(ex, out, len);
}

/** Derive the account identifier owned by `ownerText` on `subaccountHex` (the self-send guard). */
async function icpAccountIdFromPrincipal(ownerText: string, subaccountHex: string): Promise<string> {
  const ex = await core();
  const owner = putStr(ex, ownerText);
  const sub = putStr(ex, subaccountHex);
  const out = outBuf(ex, 128, 'icp_account_id_from_principal');
  const len = ex.w_icp_account_id_from_principal(owner[0], owner[1], sub[0], sub[1], out, 128);
  if (len <= 3) throw new Error('DpayCore wasm: icp_account_id_from_principal failed');
  return readStr(ex, out, len);
}

/** DIDL args for the ICP ledger's LEGACY `transfer` (the only method that reaches a 64-hex
 *  account identifier). Amounts/fee/memo are decimal strings; `Tokens` is nat64, so out-of-range
 *  is refused by the core rather than truncated. */
async function icpLegacyTransferArg(
  toAccountIdHex: string, fromSubaccountHex: string, amountE8s: string, feeE8s: string, memo: string,
): Promise<string> {
  const ex = await core();
  const to = putStr(ex, toAccountIdHex);
  const fromSub = putStr(ex, fromSubaccountHex);
  const amount = putStr(ex, amountE8s);
  const fee = putStr(ex, feeE8s);
  const memoP = putStr(ex, memo);
  const out = outBuf(ex, ICP_ENV_CAP, 'icp_legacy_transfer_arg');
  const len = ex.w_icp_legacy_transfer_arg(to[0], to[1], fromSub[0], fromSub[1], amount[0], amount[1], fee[0], fee[1], memoP[0], memoP[1], out, ICP_ENV_CAP);
  return binOutHex(ex, len, out, 'icp_legacy_transfer_arg');
}

/** The legacy `transfer` reply — same outcome shape as icpDecodeTransferResult, but carrying the
 *  LEGACY variant tags (TxDuplicate / TxTooOld / TxCreatedInFuture). */
async function icpDecodeLegacyTransferResult(argHex: string): Promise<IcpTransferOutcomeOut> {
  const ex = await core();
  const arg = hex(argHex);
  const argP = put(ex, arg);
  const out = outBuf(ex, ICP_JSON_CAP, 'icp_decode_legacy_transfer_result');
  const len = ex.w_icp_decode_legacy_transfer_result(argP, arg.length, out, ICP_JSON_CAP);
  return jsonOut(ex, len, out, 'icp_decode_legacy_transfer_result') as IcpTransferOutcomeOut;
}

async function icpIngressExpiry(nowNs: string, aheadS: number): Promise<string> {
  const ex = await core();
  const [nowP, nowLen] = putStr(ex, nowNs);
  const out = outBuf(ex, 32, 'icp_ingress_expiry');
  const len = ex.w_icp_ingress_expiry(nowP, nowLen, aheadS, out, 32);
  if (len === 0) throw new Error('DpayCore wasm: icp_ingress_expiry failed');
  return readStr(ex, out, len);
}

async function icpTransferArg(
  toOwnerText: string, toSubaccountHex: string, fromSubaccountHex: string,
  amount: string, fee: string, memoHex: string,
): Promise<string> {
  const ex = await core();
  const to = putStr(ex, toOwnerText);
  const toSub = putStr(ex, toSubaccountHex);
  const fromSub = putStr(ex, fromSubaccountHex);
  const amt = putStr(ex, amount);
  const feeP = putStr(ex, fee ?? '');
  const memo = putStr(ex, memoHex ?? '');
  const out = outBuf(ex, 512, 'icp_transfer_arg');
  const len = ex.w_icp_transfer_arg(to[0], to[1], toSub[0], toSub[1], fromSub[0], fromSub[1], amt[0], amt[1], feeP[0], feeP[1], memo[0], memo[1], out, 512);
  return binOutHex(ex, len, out, 'icp_transfer_arg');
}

/** The PULL: spend an allowance the payer granted this wallet, moving THEIR money to `to`. Mirrors
 *  `icp_transfer_from_arg` in dpay-ffi, which owns the reasoning. */
async function icpTransferFromArg(
  fromOwnerText: string, fromSubaccountHex: string,
  toOwnerText: string, toSubaccountHex: string,
  amount: string, memoHex: string, fee: string,
): Promise<string> {
  const ex = await core();
  const from = putStr(ex, fromOwnerText);
  const fromSub = putStr(ex, fromSubaccountHex ?? '');
  const to = putStr(ex, toOwnerText);
  const toSub = putStr(ex, toSubaccountHex ?? '');
  const amt = putStr(ex, amount);
  const memo = putStr(ex, memoHex ?? '');
  const feeP = putStr(ex, fee ?? '');
  const out = outBuf(ex, 512, 'icp_transfer_from_arg');
  const len = ex.w_icp_transfer_from_arg(
    from[0], from[1], fromSub[0], fromSub[1], to[0], to[1], toSub[0], toSub[1],
    amt[0], amt[1], memo[0], memo[1], feeP[0], feeP[1], out, 512,
  );
  return binOutHex(ex, len, out, 'icp_transfer_from_arg');
}

async function icpApproveArg(
  spenderOwnerText: string, spenderSubaccountHex: string, fromSubaccountHex: string,
  amount: string, expectedAllowance: string, expiresAtNs: string, memoHex: string, fee: string,
): Promise<string> {
  const ex = await core();
  const spender = putStr(ex, spenderOwnerText);
  const spenderSub = putStr(ex, spenderSubaccountHex);
  const fromSub = putStr(ex, fromSubaccountHex);
  const amt = putStr(ex, amount ?? '');
  const expected = putStr(ex, expectedAllowance ?? '');
  const expires = putStr(ex, expiresAtNs ?? '');
  const memo = putStr(ex, memoHex ?? '');
  const feeP = putStr(ex, fee ?? '');
  const out = outBuf(ex, 512, 'icp_approve_arg');
  const len = ex.w_icp_approve_arg(spender[0], spender[1], spenderSub[0], spenderSub[1], fromSub[0], fromSub[1], amt[0], amt[1], expected[0], expected[1], expires[0], expires[1], memo[0], memo[1], feeP[0], feeP[1], out, 512);
  return binOutHex(ex, len, out, 'icp_approve_arg');
}

async function icpBalanceOfArg(ownerText: string, subaccountHex: string): Promise<string> {
  const ex = await core();
  const owner = putStr(ex, ownerText);
  const sub = putStr(ex, subaccountHex ?? '');
  const out = outBuf(ex, 256, 'icp_balance_of_arg');
  const len = ex.w_icp_balance_of_arg(owner[0], owner[1], sub[0], sub[1], out, 256);
  return binOutHex(ex, len, out, 'icp_balance_of_arg');
}

// --- delegated conversion (ICPSwap pool) — the compiled core, same as every other builder here ---

/** The pool's `depositFromAndSwap` arg: the leg the user's key signs after `icrc2_approve` named
 *  the pool the spender. Amounts + both token fees are decimal e8s strings; `zeroForOne` is the
 *  pool's own token0→token1 direction, taken from the venue quote. */
async function icpDepositAndSwapArg(
  amountIn: string, amountOutMinimum: string, tokenInFee: string, tokenOutFee: string, zeroForOne: boolean,
): Promise<string> {
  const ex = await core();
  const amt = putStr(ex, amountIn);
  const min = putStr(ex, amountOutMinimum);
  const feeIn = putStr(ex, tokenInFee);
  const feeOut = putStr(ex, tokenOutFee);
  const out = outBuf(ex, 512, 'icp_deposit_and_swap_arg');
  const len = ex.w_icp_deposit_and_swap_arg(
    amt[0], amt[1], min[0], min[1], feeIn[0], feeIn[1], feeOut[0], feeOut[1],
    zeroForOne ? 1 : 0, out, 512,
  );
  if (len <= 3) throw new Error(`DpayCore wasm: icp_deposit_and_swap_arg failed (wasm error code ${len})`);
  return binOutHex(ex, len, out, 'icp_deposit_and_swap_arg');
}

/** Exact-floor min-out for a venue quote at `slippageBps`.
 *
 *  The bps guard lives HERE, not in the ABI: `slippageBps` crosses as a raw wasm i32, and JS
 *  ToInt32-coerces a fractional number on the way in — 0.5 would arrive as 0, silently turning the
 *  user's slippage tolerance off and signing a min-out equal to the full quote. Refuse it in JS,
 *  naming the value, so the web build and the Kotlin bridge fail the same way. (The core still
 *  refuses an out-of-u16 bps on its own side; this guard is what makes a FRACTION visible.) */
async function icpSwapMinOut(quotedOut: string, slippageBps: number): Promise<string> {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 65535) {
    throw new Error(
      `DpayCore wasm: slippageBps must be a whole number of basis points in 0..65535, got ${slippageBps}`,
    );
  }
  const ex = await core();
  const quoted = putStr(ex, quotedOut);
  const out = outBuf(ex, 64, 'icp_swap_min_out');
  const len = ex.w_icp_swap_min_out(quoted[0], quoted[1], slippageBps, out, 64);
  return (jsonOut(ex, len, out, 'icp_swap_min_out') as {minOut: string}).minOut;
}

/** The pool's own reply: `{ok, amountOutGross?}` or `{ok:false, errVariant, errDetail}`. */
async function icpDecodeSwapResult(argHex: string): Promise<IcpSwapReplyOut> {
  const ex = await core();
  const arg = hex(argHex);
  const argP = put(ex, arg);
  const out = outBuf(ex, ICP_JSON_CAP, 'icp_decode_swap_result');
  const len = ex.w_icp_decode_swap_result(argP, arg.length, out, ICP_JSON_CAP);
  return jsonOut(ex, len, out, 'icp_decode_swap_result') as IcpSwapReplyOut;
}

// --- minter calls (user-principal offramp + deposits) — golden-pinned builders ---

async function icpMinterAccountArg(ownerText: string, subaccountHex: string): Promise<string> {
  const ex = await core();
  const owner = putStr(ex, ownerText);
  const sub = putStr(ex, subaccountHex ?? '');
  const out = outBuf(ex, 256, 'icp_minter_account_arg');
  const len = ex.w_icp_minter_account_arg(owner[0], owner[1], sub[0], sub[1], out, 256);
  return binOutHex(ex, len, out, 'icp_minter_account_arg');
}

async function icpRetrieveBtcArg(address: string, amountSats: string, fromSubaccountHex: string): Promise<string> {
  const ex = await core();
  const addr = putStr(ex, address);
  const amt = putStr(ex, amountSats);
  const sub = putStr(ex, fromSubaccountHex ?? '');
  const out = outBuf(ex, 256, 'icp_retrieve_btc_arg');
  const len = ex.w_icp_retrieve_btc_arg(addr[0], addr[1], amt[0], amt[1], sub[0], sub[1], out, 256);
  return binOutHex(ex, len, out, 'icp_retrieve_btc_arg');
}

async function icpWithdrawEthArg(recipient: string, amountWei: string, fromSubaccountHex: string): Promise<string> {
  const ex = await core();
  const recip = putStr(ex, recipient);
  const amt = putStr(ex, amountWei);
  const sub = putStr(ex, fromSubaccountHex ?? '');
  const out = outBuf(ex, 256, 'icp_withdraw_eth_arg');
  const len = ex.w_icp_withdraw_eth_arg(recip[0], recip[1], amt[0], amt[1], sub[0], sub[1], out, 256);
  return binOutHex(ex, len, out, 'icp_withdraw_eth_arg');
}

async function icpWithdrawErc20Arg(
  amount: string, ckerc20LedgerText: string, recipient: string,
  fromCkethSubaccountHex: string, fromCkerc20SubaccountHex: string,
): Promise<string> {
  const ex = await core();
  const amt = putStr(ex, amount);
  const ledger = putStr(ex, ckerc20LedgerText);
  const recip = putStr(ex, recipient);
  const sub1 = putStr(ex, fromCkethSubaccountHex ?? '');
  const sub2 = putStr(ex, fromCkerc20SubaccountHex ?? '');
  const out = outBuf(ex, 256, 'icp_withdraw_erc20_arg');
  const len = ex.w_icp_withdraw_erc20_arg(
    amt[0], amt[1], ledger[0], ledger[1], recip[0], recip[1], sub1[0], sub1[1], sub2[0], sub2[1], out, 256,
  );
  return binOutHex(ex, len, out, 'icp_withdraw_erc20_arg');
}

async function icpEip1559PriceArg(ckerc20LedgerText: string): Promise<string> {
  const ex = await core();
  const ledger = putStr(ex, ckerc20LedgerText);
  const out = outBuf(ex, 256, 'icp_eip1559_price_arg');
  const len = ex.w_icp_eip1559_price_arg(ledger[0], ledger[1], out, 256);
  return binOutHex(ex, len, out, 'icp_eip1559_price_arg');
}

async function icpDecodeText(argHex: string): Promise<string> {
  const ex = await core();
  const arg = put(ex, hexToBytes(argHex));
  const out = outBuf(ex, ICP_JSON_CAP, 'icp_decode_text');
  const len = ex.w_icp_decode_text(arg, argHex.length / 2, out, ICP_JSON_CAP);
  const j = jsonOut(ex, len, out, 'icp_decode_text') as {text: string};
  return j.text;
}

async function icpDecodeEip1559Price(argHex: string): Promise<IcpEip1559PriceOut> {
  const ex = await core();
  const arg = put(ex, hexToBytes(argHex));
  const out = outBuf(ex, ICP_JSON_CAP, 'icp_decode_eip1559_price');
  const len = ex.w_icp_decode_eip1559_price(arg, argHex.length / 2, out, ICP_JSON_CAP);
  return jsonOut(ex, len, out, 'icp_decode_eip1559_price') as IcpEip1559PriceOut;
}

async function icpSignUpdate(
  secretHex: string, canisterText: string, methodName: string, argHex: string, ingressExpiryNs: string,
): Promise<IcpSignedUpdateOut> {
  const ex = await core();
  const seedP = put(ex, hex(secretHex));
  const canister = putStr(ex, canisterText);
  const method = putStr(ex, methodName);
  const arg = put(ex, hex(argHex));
  const expiry = putStr(ex, ingressExpiryNs);
  const out = outBuf(ex, ICP_ENV_CAP, 'icp_sign_update');
  const len = ex.w_icp_sign_update(seedP, canister[0], canister[1], method[0], method[1], arg, argHex.length / 2, expiry[0], expiry[1], out, ICP_ENV_CAP);
  const envelopeHex = binOutHex(ex, len, out, 'icp_sign_update');
  const requestIdHex = await icpEnvelopeRequestId(envelopeHex);
  return { envelopeHex, requestIdHex };
}

async function icpSignQuery(
  secretHex: string, canisterText: string, methodName: string, argHex: string, ingressExpiryNs: string,
): Promise<string> {
  const ex = await core();
  const seedP = put(ex, hex(secretHex));
  const canister = putStr(ex, canisterText);
  const method = putStr(ex, methodName);
  const arg = put(ex, hex(argHex));
  const expiry = putStr(ex, ingressExpiryNs);
  const out = outBuf(ex, ICP_ENV_CAP, 'icp_sign_query');
  const len = ex.w_icp_sign_query(seedP, canister[0], canister[1], method[0], method[1], arg, argHex.length / 2, expiry[0], expiry[1], out, ICP_ENV_CAP);
  return binOutHex(ex, len, out, 'icp_sign_query');
}

async function icpSignReadState(
  secretHex: string, requestIdsHex: string[], wantTime: boolean, ingressExpiryNs: string,
): Promise<string> {
  const ex = await core();
  if (requestIdsHex.length > 8) throw new Error('Length');
  const seedP = put(ex, hex(secretHex));
  const rids = new Uint8Array(requestIdsHex.length * 32);
  requestIdsHex.forEach((ridHex, i) => {
    const rid = hex(ridHex);
    if (rid.length !== 32) throw new Error(`request id length: ${rid.length}`);
    rids.set(rid, i * 32);
  });
  const ridsP = put(ex, rids);
  const expiry = putStr(ex, ingressExpiryNs);
  const out = outBuf(ex, ICP_ENV_CAP, 'icp_sign_read_state');
  const len = ex.w_icp_sign_read_state(seedP, ridsP, requestIdsHex.length, wantTime ? 1 : 0, expiry[0], expiry[1], out, ICP_ENV_CAP);
  return binOutHex(ex, len, out, 'icp_sign_read_state');
}

async function icpEnvelopeRequestId(envelopeHex: string): Promise<string> {
  const ex = await core();
  const env = hex(envelopeHex);
  const envP = put(ex, env);
  const out = outBuf(ex, 32, 'icp_envelope_request_id');
  const st = ex.w_icp_envelope_request_id(envP, env.length, out);
  if (st !== 0) bail(st, 'w_icp_envelope_request_id');
  return bytesToHex(readBytes(ex, out, 32));
}

async function icpDecodeQuery(bodyHex: string): Promise<IcpQueryReplyOut> {
  const ex = await core();
  const body = hex(bodyHex);
  const bodyP = put(ex, body);
  const out = outBuf(ex, ICP_JSON_CAP, 'icp_decode_query');
  const len = ex.w_icp_decode_query(bodyP, body.length, out, ICP_JSON_CAP);
  return jsonOut(ex, len, out, 'icp_decode_query') as IcpQueryReplyOut;
}

async function icpDecodeReadState(bodyHex: string, requestIdsHex: string[]): Promise<IcpStateReadOut> {
  const ex = await core();
  if (requestIdsHex.length > 8) throw new Error('Length');
  const body = hex(bodyHex);
  const bodyP = put(ex, body);
  const rids = new Uint8Array(requestIdsHex.length * 32);
  requestIdsHex.forEach((ridHex, i) => {
    const rid = hex(ridHex);
    if (rid.length !== 32) throw new Error(`request id length: ${rid.length}`);
    rids.set(rid, i * 32);
  });
  const ridsP = put(ex, rids);
  const out = outBuf(ex, ICP_JSON_CAP, 'icp_decode_read_state');
  const len = ex.w_icp_decode_read_state(bodyP, body.length, ridsP, requestIdsHex.length, out, ICP_JSON_CAP);
  return jsonOut(ex, len, out, 'icp_decode_read_state') as IcpStateReadOut;
}

async function icpDecodeTransferResult(argHex: string): Promise<IcpTransferOutcomeOut> {
  const ex = await core();
  const arg = hex(argHex);
  const argP = put(ex, arg);
  const out = outBuf(ex, ICP_JSON_CAP, 'icp_decode_transfer_result');
  const len = ex.w_icp_decode_transfer_result(argP, arg.length, out, ICP_JSON_CAP);
  return jsonOut(ex, len, out, 'icp_decode_transfer_result') as IcpTransferOutcomeOut;
}

/** The icrc2_approve reply — same outcome shape; ApproveError carries approve-only variants
 *  (AllowanceChanged, Expired) the transfer decoder cannot read. */
async function icpDecodeApproveResult(argHex: string): Promise<IcpTransferOutcomeOut> {
  const ex = await core();
  const arg = hex(argHex);
  const argP = put(ex, arg);
  const out = outBuf(ex, ICP_JSON_CAP, 'icp_decode_approve_result');
  const len = ex.w_icp_decode_approve_result(argP, arg.length, out, ICP_JSON_CAP);
  return jsonOut(ex, len, out, 'icp_decode_approve_result') as IcpTransferOutcomeOut;
}

/** The pull's reply — same outcome shape, plus `InsufficientAllowance`, the one failure only a
 *  pull can have (its detail is the allowance the ledger actually holds). */
async function icpDecodeTransferFromResult(argHex: string): Promise<IcpTransferOutcomeOut> {
  const ex = await core();
  const arg = hex(argHex);
  const argP = put(ex, arg);
  const out = outBuf(ex, ICP_JSON_CAP, 'icp_decode_transfer_from_result');
  const len = ex.w_icp_decode_transfer_from_result(argP, arg.length, out, ICP_JSON_CAP);
  return jsonOut(ex, len, out, 'icp_decode_transfer_from_result') as IcpTransferOutcomeOut;
}

/** Minter retrieve/withdraw Ok({block_index}) reply — mirrors icpDecodeTransferResult. */
async function icpDecodeMinterOk(argHex: string): Promise<IcpTransferOutcomeOut> {
  const ex = await core();
  const arg = hex(argHex);
  const argP = put(ex, arg);
  const out = outBuf(ex, ICP_JSON_CAP, 'icp_decode_minter_ok');
  const len = ex.w_icp_decode_minter_ok(argP, arg.length, out, ICP_JSON_CAP);
  return jsonOut(ex, len, out, 'icp_decode_minter_ok') as IcpTransferOutcomeOut;
}

async function icpDecodeInt(argHex: string): Promise<string> {
  const ex = await core();
  const arg = hex(argHex);
  const argP = put(ex, arg);
  const out = outBuf(ex, 64, 'icp_decode_int');
  const len = ex.w_icp_decode_int(argP, arg.length, out, 64);
  if (len === 0) throw new Error('DpayCore wasm: icp_decode_int failed');
  return readStr(ex, out, len);
}

/** Merchant side: sign a ring-up on dpay's own OpenCryptoPay till. The merchant pubkey is derived
 *  from the seed INSIDE the core, so the signature always covers the key that will be paid. The
 *  canonical bytes and the anti-replay rule live in `dpay_core::TillOpen`; the golden is
 *  `dfx/till_open_signing.json`. A NON-EMPTY note signs the v2 encoding via `w_till_open_sig_note`
 *  (feature-detected by symbol presence per the wasm ABI policy); an empty note signs the note-less
 *  v1 bytes through the frozen `w_till_open_sig`. Returns the 64-byte signature as hex. */
async function tillOpenSignature(
  secretHex: string, cents: string, nonceHex: string, issuedAt: number, merchantName: string, note: string,
): Promise<string> {
  const ex = await core();
  const seed = hex(secretHex);
  if (seed.length !== 32) throw new Error('Length');
  const nonce = hex(nonceHex);
  if (nonce.length !== NONCE_LEN) throw new Error(`nonce length: ${nonce.length}`);
  const seedP = put(ex, seed);
  const nonceP = put(ex, nonce);
  const [nameP, nameLen] = putStr(ex, merchantName);
  const out = outBuf(ex, SIG_LEN, 'tillOpenSignature');
  const [centsLo, centsHi] = splitU64(cents);
  const [iatLo, iatHi] = splitU64(issuedAt);
  let status: number;
  if (note !== '' && typeof ex.w_till_open_sig_note === 'function') {
    const [noteP, noteLen] = putStr(ex, note);
    status = ex.w_till_open_sig_note(seedP, centsLo, centsHi, nonceP, iatLo, iatHi, nameP, nameLen, noteP, noteLen, out);
    if (status !== 0) bail(status, 'w_till_open_sig_note');
  } else {
    status = ex.w_till_open_sig(seedP, centsLo, centsHi, nonceP, iatLo, iatHi, nameP, nameLen, out);
    if (status !== 0) bail(status, 'w_till_open_sig');
  }
  return bytesToHex(readBytes(ex, out, SIG_LEN));
}

async function generateKeypair(): Promise<{secretHex: string; publicHex: string}> {
  const ex = await core();
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  const seedP = put(ex, seed);
  const out = outBuf(ex, PUBKEY_LEN, 'generateKeypair');
  const status = ex.w_pubkey(seedP, out);
  if (status !== 0) bail(status, 'generateKeypair');
  return {secretHex: bytesToHex(seed), publicHex: bytesToHex(readBytes(ex, out, PUBKEY_LEN))};
}

async function keypairFromSecret(secretHex: string): Promise<{secretHex: string; publicHex: string}> {
  const ex = await core();
  const seed = hex(secretHex);
  if (seed.length !== 32) throw new Error('Length');
  const seedP = put(ex, seed);
  const out = outBuf(ex, PUBKEY_LEN, 'keypairFromSecret');
  const status = ex.w_pubkey(seedP, out);
  if (status !== 0) bail(status, 'keypairFromSecret');
  return {secretHex: bytesToHex(seed), publicHex: bytesToHex(readBytes(ex, out, PUBKEY_LEN))};
}

export const DpayCore = {
  generateKeypair,
  keypairFromSecret,
  encodeRequest,
  buildRequestHex,
  decodeRequest,
  nfcStatus,
  tillOpenSignature,
  icpSelfPrincipal,
  icpPrincipalFromPubkey,
  icpValidatePrincipal,
  icpIngressExpiry,
  icpTransferArg,
  icpTransferFromArg,
  icpApproveArg,
  icpDepositAndSwapArg,
  icpSwapMinOut,
  icpDecodeSwapResult,
  icpBalanceOfArg,
  icpMinterAccountArg,
  icpRetrieveBtcArg,
  icpWithdrawEthArg,
  icpWithdrawErc20Arg,
  icpEip1559PriceArg,
  icpDecodeText,
  icpDecodeEip1559Price,
  icpSignUpdate,
  icpSignQuery,
  icpSignReadState,
  icpEnvelopeRequestId,
  icpDecodeQuery,
  icpDecodeReadState,
  icpDecodeTransferResult,
  icpDecodeApproveResult,
  icpDecodeTransferFromResult,
  icpDecodeMinterOk,
  icpDecodeInt,
  icpValidateIcrcAccount,
  icpValidateAccountId,
  icpAccountIdFromPrincipal,
  icpLegacyTransferArg,
  icpDecodeLegacyTransferResult,
};
export type DpayCoreShim = typeof DpayCore;
