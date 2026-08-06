// Minimal Solana JSON-RPC 2.0 client over `fetch` with bounded timeouts. NETWORK module —
// dynamic-imported from the seam `app/solana.ts` so `@solana/*` (here: none) and real RPC never run
// under jest/e2e (the seam no-ops when `SOLANA_RPC_URL` is empty, which jest.setup.js + the e2e
// driver set). Exposes the online SOL MVP + offline-pay rail calls:
//   getBalance, getLatestBlockhash, sendTransaction, confirmTransaction (poll getSignatureStatuses),
//   getNonceAccount (parses the 80-byte durable-nonce NonceState), getMinimumBalanceForRentExemption.
//
// Timeouts use the shared `lib/timeout.ts` compose (NOT AbortSignal.any/AbortSignal.timeout —
// those ES2024/ES2022 statics are absent from this project's TS `lib` and not guaranteed on
// Hermes/RN). A caller signal (first-abort-wins) is forwarded in.
//
// E2E STUB SEAM: when `globalThis.__DPAY_TEST_SOLANA_RPC_STUB` is set (by jest.setup.js or the e2e
// driver), every `rpcFetch` routes to that object keyed by raw RPC method name instead of `fetch`.
// This lets the offline e2e loop (flow 46) exercise sign/broadcast against a deterministic in-memory
// Solana simulator with zero real network — mirroring the `__DPAY_TEST_NFC_SESSION` precedent. The
// stub is checked per-call (runtime), so setting/clearing it between tests takes effect immediately.

import bs58 from 'bs58';
import {composeTimeout as composeTimeoutShared} from '../lib/timeout';

export interface SolanaBlockhash {
  /** base58-encoded recent blockhash (raw RPC shape — decode to 32 bytes at the call site). */
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}

export interface SolanaRpcOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** confirmTransaction poll spacing (default 1.5s). */
  pollMs?: number;
}

export interface SolanaSignatureStatus {
  readonly confirmationStatus?: 'processed' | 'confirmed' | 'finalized';
  readonly err?: unknown;
}

/** Parsed durable-nonce account state (the `NonceAccountLayout`: u32 version | u32 state | 32B
 *  authority | 32B nonce value | u64 fee). The offline payer signs against `value`; the authority
 *  must match the payer's device key (binding). */
export interface SolanaNonceAccount {
  /** base58 authority pubkey (the key authorized to advance the nonce). */
  readonly authority: string;
  /** base58 durable nonce value (the stored nonce — sign offline against this). */
  readonly value: string;
}

/** A raw JSON-RPC method handler used by the e2e stub simulator (`__DPAY_TEST_SOLANA_RPC_STUB`).
 *  Returns the `result` field of the JSON-RPC response. */
export type SolanaRpcStubHandler = (params: unknown[]) => unknown | Promise<unknown>;

/** The e2e stub simulator: keyed by RPC method name (e.g. `'getBalance'`, `'getAccountInfo'`). Any
 *  method absent from the stub throws a typed error (never silently falls through to `fetch`). */
export type SolanaRpcStub = Partial<Record<string, SolanaRpcStubHandler>>;

const DEFAULT_TIMEOUT_MS = 8000;
const CONFIRM_TIMEOUT_MS = 30000;
const CONFIRM_POLL_MS = 1500;

let nextId = 1;

function activeStub(): SolanaRpcStub | undefined {
  return (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB;
}

function composeTimeout(callerSignal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): {signal: AbortSignal; cancel: () => void} {
  return composeTimeoutShared(callerSignal, timeoutMs);
}

async function rpcFetch(url: string, method: string, params: unknown[], opts?: SolanaRpcOpts): Promise<unknown> {
  const stub = activeStub();
  if (stub) {
    const handler = stub[method];
    if (typeof handler !== 'function') {
      throw new Error(`solana rpc stub: method ${method} not implemented`);
    }
    return await handler(params);
  }
  const {signal, cancel} = composeTimeout(opts?.signal, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: nextId++, method, params}),
      signal,
    });
    if (!r.ok) throw new Error(`solana rpc http ${r.status}`);
    const j: {error?: {message?: string}; result?: unknown} = await r.json();
    if (j.error) throw new Error(`solana rpc: ${j.error.message ?? 'error'}`);
    return j.result;
  } finally {
    cancel();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, {once: true});
  });
}

/** Read an account's lamport balance as a decimal-digit string (lamports < 2^53 for all real
 *  supplies, but String() keeps the app-wide "amounts are strings" invariant). */
export async function getBalance(url: string, address: string, opts?: SolanaRpcOpts): Promise<string> {
  const result = (await rpcFetch(url, 'getBalance', [address], opts)) as {value: number};
  return String(result.value);
}

/** Fetch a fresh recent blockhash + its last-valid block height (needed to build + track a tx). */
export async function getLatestBlockhash(url: string, opts?: SolanaRpcOpts): Promise<SolanaBlockhash> {
  const result = (await rpcFetch(url, 'getLatestBlockhash', [], opts)) as {
    value: {blockhash: string; lastValidBlockHeight: number};
  };
  return {blockhash: result.value.blockhash, lastValidBlockHeight: result.value.lastValidBlockHeight};
}

/** Broadcast a raw signed transaction (bytes). Base64-encodes internally for the wire. Returns the
 *  transaction signature (base58). */
export async function sendTransaction(url: string, rawBytes: Uint8Array, opts?: SolanaRpcOpts): Promise<string> {
  const result = (await rpcFetch(url, 'sendTransaction', [bytesToBase64(rawBytes), {encoding: 'base64'}], opts)) as string;
  return result;
}

/** Poll `getSignatureStatuses` until the transaction is confirmed/finalized. Throws on a reported
 *  transaction error or a timeout (the tx may still land after a timeout — the caller surfaces that
 *  truthfully, never as a false success). */
export async function confirmTransaction(url: string, signature: string, opts?: SolanaRpcOpts): Promise<void> {
  const deadline = Date.now() + (opts?.timeoutMs ?? CONFIRM_TIMEOUT_MS);
  while (true) {
    if (opts?.signal?.aborted) throw new Error('aborted');
    const result = (await rpcFetch(url, 'getSignatureStatuses', [[signature]], {
      signal: opts?.signal,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })) as {value: (SolanaSignatureStatus | null)[]};
    const status = result.value?.[0];
    if (status) {
      if (status.err != null) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return;
    }
    if (Date.now() >= deadline) throw new Error('solana confirmation timeout');
    await sleep(opts?.pollMs ?? CONFIRM_POLL_MS, opts?.signal);
  }
}

/** Read a durable-nonce account and parse its NonceState (u32 version | u32 state | 32B authority |
 *  32B nonce value | u64 fee). Throws a typed error on an uninitialized/closed/absent/malformed
 *  account — never returns a stale or null value silently (the offline rail trusts this value to
 *  sign against, so a parse failure must be loud). */
export async function getNonceAccount(url: string, nonceAddress: string, opts?: SolanaRpcOpts): Promise<SolanaNonceAccount> {
  const result = (await rpcFetch(url, 'getAccountInfo', [nonceAddress, {encoding: 'base64'}], opts)) as {
    value: {data: [string, string]; owner: string; lamports: number} | null;
  };
  if (!result.value) throw new Error(`solana nonce account not found: ${nonceAddress}`);
  const data = result.value.data;
  if (!data || data[1] !== 'base64') throw new Error(`solana nonce account: unexpected encoding ${data?.[1] ?? 'none'}`);
  const bytes = base64ToBytes(data[0]);
  if (bytes.length < 80) throw new Error(`solana nonce account: malformed data (${bytes.length} bytes, need 80)`);
  // NonceState layout: u32(0) version | u32(1) state | 32B authority | 32B nonce | u64 fee.
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const state = dv.getUint32(4, true);
  if (state !== 1) throw new Error(`solana nonce account: state ${state} is not Initialized`);
  const authorityBytes = bytes.subarray(8, 40);
  const nonceBytes = bytes.subarray(40, 72);
  return {authority: bs58.encode(authorityBytes), value: bs58.encode(nonceBytes)};
}

/** Query the rent-exempt minimum for an account of `dataLength` bytes. Returns a bigint (the
 *  downstream consumers — `buildCreateNonceAccountMessage`, ATA creation — take bigint). */
export async function getMinimumBalanceForRentExemption(url: string, dataLength: number, opts?: SolanaRpcOpts): Promise<bigint> {
  const result = (await rpcFetch(url, 'getMinimumBalanceForRentExemption', [dataLength], opts)) as number;
  return BigInt(result);
}

// RFC 4648 base64 of a byte array. Hand-rolled (no Buffer/btoa dependency) so it is identical on
// RN/Hermes, jest/Node, and the e2e browser bundle.
function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? chars[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? chars[b2 & 0x3f] : '=';
  }
  return out;
}

// RFC 4648 base64 decode (standard alphabet, '=' padding tolerated). Hand-rolled to match
// `bytesToBase64` — no Buffer/atob dependency so it is identical across RN/Hermes/jest/browser.
function base64ToBytes(b64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Int8Array(128).fill(-1);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
  // Strip padding; tolerate whitespace.
  const clean = b64.replace(/=+$/, '').replace(/\s/g, '');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const v0 = lookup[clean.charCodeAt(i) & 0x7f];
    const v1 = i + 1 < clean.length ? lookup[clean.charCodeAt(i + 1) & 0x7f] : -1;
    const v2 = i + 2 < clean.length ? lookup[clean.charCodeAt(i + 2) & 0x7f] : -1;
    const v3 = i + 3 < clean.length ? lookup[clean.charCodeAt(i + 3) & 0x7f] : -1;
    if (v0 < 0 || v1 < 0) throw new Error('solana rpc: malformed base64');
    out[o++] = (v0 << 2) | (v1 >> 4);
    if (v2 >= 0) out[o++] = ((v1 & 0x0f) << 4) | (v2 >> 2);
    if (v3 >= 0) out[o++] = ((v2 & 0x03) << 6) | v3;
  }
  return out.subarray(0, o);
}
