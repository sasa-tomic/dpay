// DpayCore shim — the ONLY money-critical shim — backed by the SHARED WASM CORE
// (`crates/dpay-relay/assets/dpay-core.wasm`, compiled from `crates/dpay-wasm`, ABI v1).
//
// This is not a JS re-implementation: every byte the app signs, decodes, or verifies goes through
// the SAME Rust `dpay-core` that the Android app's UniFFI binding and the relay/canister use.
// The previous @noble/ed25519 JS shim (`dpay-core.ts`) was deleted; its only remaining JS-side
// crypto is `verifyWire` (the wasm core deliberately exports no wire-verify — it has no way to
// report WHY it failed), which parses the wire with the layout served by `w_layout_json` and
// verifies via @noble/ed25519 (binary-compatible with dalek; cross-validated in 00-cross-val).
//
// Loading: the wasm is a vite `?url` asset — hashed, same-origin, served straight from the dist
// (both the e2e sirv server and the relay's embedded web build). A Node/CI consumer can inject
// staged bytes instead via `globalThis.__DPAY_WASM_BYTES` (Uint8Array/ArrayBuffer) — the same
// injection-seam pattern as `initWalletWire` had.
//
// Memory discipline (frozen ABI v1): `w_alloc` is a bump allocator and wasm memory growth DETACHES
// JS views. Every helper below re-derives its `Uint8Array` view immediately after ANY `w_alloc`,
// and pointers are only ever written/read through fresh views.
import * as ed from '@noble/ed25519';
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
  memory: WebAssembly.Memory;
};

const ABI_VERSION = 1;
const WIRE_LEN = 292;
const SIGNING_LEN = 196;
const REQUEST_LEN = 132;
const SIG_LEN = 64;
const PUBKEY_LEN = 32;
const NONCE_LEN = 16;

let layout: Layout | null = null;
let exports_: WasmExports | null = null;
let initP: Promise<WasmExports> | null = null;

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
  const r = await fetch(wasmUrl as string);
  if (!r.ok) throw new Error(`DpayCore wasm: fetch ${wasmUrl} → HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
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

/** Idempotent lazy init — starts on the FIRST method call, not at import (so a Node consumer that
 *  never calls DpayCore never fetches). Every public method awaits this. */
function core(): Promise<WasmExports> {
  if (!initP) initP = init().catch((e) => { initP = null; throw e; });
  return initP;
}

// --- the public DpayCore surface (mirrors app/lib/types.ts DpayCoreApi; all hex strings) --------

async function generateKeypair(): Promise<{ secretHex: string; publicHex: string }> {
  const ex = await core();
  const seed = new Uint8Array(32);
  globalThis.crypto.getRandomValues(seed);
  return { secretHex: bytesToHex(seed), publicHex: derivePubHex(ex, seed) };
}

async function keypairFromSecret(secretHex: string): Promise<{ secretHex: string; publicHex: string }> {
  const ex = await core();
  const secret = hex(secretHex);
  return { secretHex: bytesToHex(secret), publicHex: derivePubHex(ex, secret) };
}

function derivePubHex(ex: WasmExports, seed: Uint8Array): string {
  const seedP = put(ex, seed);
  const out = ex.w_alloc(PUBKEY_LEN);
  if (out === 0) throw new Error('DpayCore wasm: w_alloc OOM (pubkey)');
  const st = ex.w_pubkey(seedP, out);
  if (st !== 0) bail(st, 'w_pubkey');
  return bytesToHex(readBytes(ex, out, PUBKEY_LEN));
}

// Wire-format byte lengths from the wasm layout (asserted against the frozen sizes at init).
async function wireLen(): Promise<number> { await core(); return WIRE_LEN; }
async function signingLen(): Promise<number> { await core(); return SIGNING_LEN; }
async function requestLen(): Promise<number> { await core(); return REQUEST_LEN; }

async function signAuthorization(
  secretHex: string, toHex: string, amount: string | number, nonceHex: string, expiry: number,
  currency: number, fromName = '', toName = '', memo = '',
): Promise<string> {
  const ex = await core();
  const seed = hex(secretHex);
  if (seed.length !== PUBKEY_LEN) throw new Error('Length');
  const req = await buildRequestBytes(ex, toHex, amount, nonceHex, expiry, currency, toName, memo);
  const reqP = put(ex, req);
  const fromNameB = new TextEncoder().encode(fromName);
  const fnP = put(ex, fromNameB);
  const out = ex.w_alloc(WIRE_LEN);
  if (out === 0) throw new Error('DpayCore wasm: w_alloc OOM (wire)');
  const st = ex.w_sign_request(seedP(ex, seed), reqP, fnP, fromNameB.length, out);
  if (st !== 0) bail(st, 'w_sign_request');
  return bytesToHex(readBytes(ex, out, WIRE_LEN));
}

/** Shared by signAuthorization + encodeRequest: the 132-byte request via w_build_request (the wasm
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

async function encodeQr(wireHex: string): Promise<string> {
  await core();
  return base64url.encode(hex(wireHex));
}

// verifyWire is the ONE method the wasm core does not export (no failure-reason reporting), so it
// parses the wire with the wasm-served layout and verifies via @noble/ed25519 — binary-compatible
// with dalek (proven by 00-cross-val against the golden bytes).
async function verifyWire(wireHex: string): Promise<boolean> {
  try {
    const ex = await core();
    const L = layout!;
    const wire = hex(wireHex);
    if (wire.length !== WIRE_LEN) return false;
    const signing = wire.slice(L.wire_fields.signing.offset, L.wire_fields.signing.offset + L.wire_fields.signing.len);
    const sig = wire.slice(L.wire_fields.sig.offset, L.wire_fields.sig.offset + L.wire_fields.sig.len);
    const fromPub = wire.slice(L.wire_fields.from_pub.offset, L.wire_fields.from_pub.offset + L.wire_fields.from_pub.len);
    const fromHex = bytesToHex(signing.slice(L.fields.from.offset, L.fields.from.offset + L.fields.from.len));
    // from_pub MUST equal the `from` field embedded in the signing buffer (dpay_core::PubkeyMismatch).
    if (fromHex !== bytesToHex(fromPub)) return false;
    void ex;
    return await ed.verifyAsync(sig, signing, fromPub);
  } catch {
    return false;
  }
}

async function signWithdrawal(
  secretHex: string, btcAddress: string, amount: string | number, nonceHex: string, expiry: number, currency: number,
): Promise<string> {
  const ex = await core();
  const seed = hex(secretHex);
  if (seed.length !== PUBKEY_LEN) throw new Error('Length');
  const nonce = hex(nonceHex);
  if (nonce.length !== NONCE_LEN) throw new Error(`nonce length: ${nonce.length}`);
  const dest = new TextEncoder().encode(btcAddress);
  const seedP = put(ex, seed);
  const destP = put(ex, dest);
  const nonceP = put(ex, nonce);
  const out = ex.w_alloc(SIG_LEN);
  if (out === 0) throw new Error('DpayCore wasm: w_alloc OOM (withdraw sig)');
  const [amtLo, amtHi] = splitU64(amount);
  const [expLo, expHi] = splitU64(expiry);
  const st = ex.w_sign_withdraw(seedP, destP, dest.length, amtLo, amtHi, nonceP, expLo, expHi, currency, out);
  if (st !== 0) bail(st, 'w_sign_withdraw');
  return bytesToHex(readBytes(ex, out, SIG_LEN));
}

async function verifyReceiptSig(
  nonceHex: string, fromHex: string, toHex: string, amount: string | number, currency: number,
  blockIndex: string | number, settleTs: string | number, receiptSigHex: string, pubkeyHex: string,
): Promise<boolean> {
  // Never throws (the app gates "Paid ✓" on a clean true).
  try {
    const ex = await core();
    const nonce = hex(nonceHex);
    const from = hex(fromHex);
    const to = hex(toHex);
    const sig = hex(receiptSigHex);
    const pub = hex(pubkeyHex);
    if (nonce.length !== NONCE_LEN) return false;
    if (from.length !== PUBKEY_LEN) return false;
    if (to.length !== PUBKEY_LEN) return false;
    if (sig.length !== SIG_LEN) return false;
    if (pub.length !== PUBKEY_LEN) return false;
    const nonceP = put(ex, nonce);
    const fromP = put(ex, from);
    const toP = put(ex, to);
    const out = ex.w_alloc(108);
    if (out === 0) return false;
    const [amtLo, amtHi] = splitU64(amount);
    const [blkLo, blkHi] = splitU64(blockIndex);
    const [tsLo, tsHi] = splitU64(settleTs);
    const st = ex.w_receipt_claim(nonceP, fromP, toP, amtLo, amtHi, currency, blkLo, blkHi, tsLo, tsHi, out);
    if (st !== 0) return false;
    const pubP = put(ex, pub);
    const sigP = put(ex, sig);
    return ex.w_verify_receipt_sig(pubP, out, 108, sigP) === 1;
  } catch {
    return false;
  }
}

/** Synchronous RNG-backed nonce (browser CSPRNG) — parity with the old shim's export. */
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

// put() re-export used by signAuthorization's seed pointer (kept tiny to avoid double-deriving).
function seedP(ex: WasmExports, seed: Uint8Array): number {
  return put(ex, seed);
}

export const DpayCore = {
  generateKeypair,
  keypairFromSecret,
  wireLen,
  signingLen,
  requestLen,
  signAuthorization,
  signWithdrawal,
  encodeRequest,
  decodeRequest,
  encodeQr,
  verifyWire,
  verifyReceiptSig,
  nfcStatus,
};
export type DpayCoreShim = typeof DpayCore;
