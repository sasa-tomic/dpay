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
import {bytesToBase64, base64ToBytes} from '../lib/base64';
import {SOL_PAYMENT_COMMITMENT} from '../config/constants';

/** A fetched recent blockhash + its validity window + the context slot it was observed at. The v2
 *  payment rail threads `contextSlot` as the `minContextSlot` for every downstream freshness call
 *  (isBlockhashValid, getBlockHeight, sendTransaction) so reorg-aware RPC behavior is consistent. */
export interface SolanaBlockhash {
  /** base58-encoded recent blockhash (raw RPC shape — decode to 32 bytes at the call site). */
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  /** context.slot from the getLatestBlockhash response — passed as minContextSlot downstream. */
  readonly slot: number;
  /** alias for `slot` (the context slot); kept explicit so the freshness state machine reads clearly. */
  readonly contextSlot: number;
}

export interface SolanaRpcOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** confirmTransaction poll spacing (default 1.5s). */
  pollMs?: number;
  /** minContextSlot for RPC methods that support it (getBlockHeight, isBlockhashValid,
   *  getFeeForMessage, sendTransaction). Threads the request's context slot for reorg-awareness. */
  minContextSlot?: number;
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

/** Fetch a fresh recent blockhash + its last-valid block height (needed to build + track a tx).
 *  v2: also captures `context.slot` (the slot the blockhash was observed at, threaded as
 *  `minContextSlot` for every downstream freshness call). Backward-compatible — callers reading
 *  `.blockhash`/`.lastValidBlockHeight` keep working; the new `slot`/`contextSlot` are additive. */
export async function getLatestBlockhash(url: string, opts?: SolanaRpcOpts): Promise<SolanaBlockhash> {
  const result = (await rpcFetch(url, 'getLatestBlockhash', [{commitment: SOL_PAYMENT_COMMITMENT}], opts)) as {
    context: {slot: number};
    value: {blockhash: string; lastValidBlockHeight: number};
  };
  const contextSlot = result.context.slot;
  return {
    blockhash: result.value.blockhash,
    lastValidBlockHeight: result.value.lastValidBlockHeight,
    slot: contextSlot,
    contextSlot,
  };
}

/** Broadcast a raw signed transaction (bytes). Base64-encodes internally for the wire. Returns the
 *  transaction signature (base58).
 *
 *  v2: when `opts.config` is provided, its `{commitment, minContextSlot, skipPreflight}` are passed
 *  through as the second RPC param (the v2 freshness state machine sets these for preflight + context
 *  slot binding). Without `opts.config` the original `{encoding:'base64'}`-only shape is sent, so the
 *  v1 callers (sendSol, sendSpl, broadcastSolPayment-v1) stay byte-identical. */
export async function sendTransaction(url: string, rawBytes: Uint8Array, opts?: SolanaRpcOpts & {
  config?: {commitment?: 'confirmed' | 'processed' | 'finalized'; minContextSlot?: number; skipPreflight?: boolean};
}): Promise<string> {
  const params: unknown[] = opts?.config
    ? [bytesToBase64(rawBytes), {encoding: 'base64', ...opts.config}]
    : [bytesToBase64(rawBytes), {encoding: 'base64'}];
  const result = (await rpcFetch(url, 'sendTransaction', params, opts)) as string;
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

/** Whether an on-chain account exists at `address` — a non-null `getAccountInfo` result. True for
 *  any funded/owned account; false for a never-created account (the F4 ATA gate: a missing USDC
 *  Associated Token Account makes an offline USDC payment unfulfillable). Throws on a network/RPC
 *  error so the caller can surface "couldn't verify" honestly (a failed check is never silent). */
export async function accountExists(url: string, address: string, opts?: SolanaRpcOpts): Promise<boolean> {
  const result = (await rpcFetch(url, 'getAccountInfo', [address, {encoding: 'base64'}], opts)) as {
    value: unknown;
  };
  return result.value !== null && result.value !== undefined;
}

/** Raw on-chain account info at the SOL_PAYMENT_COMMITMENT slot. Phase 6 reclaim uses this to read a
 *  legacy durable-nonce account's 80-byte data + lamports in ONE round trip (the balance + data come
 *  from the same RPC response, so they're mutually consistent — no getBalance/accountInfo race).
 *  Returns null when the account does not exist (never-created or already closed). The `data` field
 *  is null for accounts with no on-chain data; otherwise the decoded base64 bytes. */
export interface SolanaAccountInfo {
  readonly lamports: bigint;
  readonly owner: string;
  readonly data: Uint8Array | null;
  readonly executable: boolean;
  readonly rentEpoch: number;
}
export async function getAccountInfo(url: string, address: string, opts?: SolanaRpcOpts): Promise<SolanaAccountInfo | null> {
  const result = (await rpcFetch(url, 'getAccountInfo', [address, {encoding: 'base64', commitment: SOL_PAYMENT_COMMITMENT}], opts)) as {
    value: {data: [string, string] | null; owner: string; lamports: number; executable: boolean; rentEpoch: number} | null;
  };
  if (!result.value) return null;
  const v = result.value;
  const data = v.data && v.data[1] === 'base64' ? base64ToBytes(v.data[0]) : null;
  return {lamports: BigInt(v.lamports), owner: v.owner, data, executable: v.executable, rentEpoch: v.rentEpoch};
}

/** Read a SPL token account's raw balance as an EXACT decimal-digit string + its `decimals`. Uses
 *  `getTokenAccountBalance` and returns the raw `amount` field UNCHANGED — never coerced through JS
 *  `number` (money-critical: values above 2^53 lose precision; the app-wide "amounts are strings"
 *  invariant). The caller (the USDC balance hook) trusts this to render a distinct Solana-USDC row.
 *
 *  Throws on any RPC error (account not found, invalid param, network failure) — the hook translates
 *  a throw into the `'error'` status so a transient RPC failure is honest, not a silent zero. */
export async function getTokenAccountBalance(
  url: string,
  ataAddress: string,
  opts?: SolanaRpcOpts,
): Promise<{amount: string; decimals: number}> {
  const result = (await rpcFetch(url, 'getTokenAccountBalance', [ataAddress], opts)) as {
    value: {amount: unknown; decimals: unknown};
  };
  // Defensive validation: never trust the wire shape for money. A malformed response is an error,
  // not a zero balance — the caller surfaces "couldn't read" honestly.
  const amount = result?.value?.amount;
  const decimals = result?.value?.decimals;
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
    throw new Error(`solana rpc: getTokenAccountBalance returned malformed amount for ${ataAddress}`);
  }
  if (typeof decimals !== 'number' || !Number.isFinite(decimals)) {
    throw new Error(`solana rpc: getTokenAccountBalance returned malformed decimals for ${ataAddress}`);
  }
  return {amount, decimals};
}

// RFC 4648 base64 of a byte array — imported from `lib/base64.ts` (the SINGLE implementation shared
// with the URL-safe codec in `lib/base64url.ts`). Standard alphabet, padded, throws-on-malformed.

// ============================================================================
// Phase 3 — v2 recent-blockhash freshness RPC methods. The merchant's broadcast state machine
// (solana.ts broadcastSolPayment) requires these to authoritatively prove a request is still
// broadcastable BEFORE sendTransaction, and to authoritatively classify a confirm timeout as
// expired vs honest-unknown. All run at SOL_PAYMENT_COMMITMENT='confirmed' and accept
// `minContextSlot` (the request's context slot) for reorg-aware behavior. See invariants #4/#12/#13
// in 2026-08-12-solana-recent-blockhash-rewrite-plan.md "Freshness rules".
// ============================================================================

// Module-level genesis-hash cache: one successful mainnet check per RPC URL per app session. A
// mismatch throws (fail-closed); a cache MISS on a subsequent call re-fetches. Never cached on
// failure (a transient RPC error must not pin a wrong cluster identity for the session).
const genesisHashCache = new Map<string, string>();

/** The cluster's immutable genesis hash (mainnet-beta's frozen value is in `SOL_GENESIS_HASH`).
 *  Cached per-URL on success so the createSolPaymentRequest fast path doesn't pay a round trip per
 *  request. A mismatch with the configured `SOL_GENESIS_HASH` is a hard fail (wrong cluster). */
export async function getGenesisHash(url: string, opts?: SolanaRpcOpts): Promise<string> {
  const cached = genesisHashCache.get(url);
  if (cached !== undefined) return cached;
  const result = (await rpcFetch(url, 'getGenesisHash', [], opts)) as string;
  genesisHashCache.set(url, result);
  return result;
}

/** The current block height (the chain tip's slot number). Used to check whether a request's
 *  `lastValidBlockHeight` has been exceeded — the authoritative on-chain expiry signal. */
export async function getBlockHeight(url: string, opts?: SolanaRpcOpts): Promise<number> {
  const config: Record<string, unknown> = {commitment: SOL_PAYMENT_COMMITMENT};
  if (opts?.minContextSlot !== undefined) config.minContextSlot = opts.minContextSlot;
  const result = (await rpcFetch(url, 'getBlockHeight', [config], opts)) as number;
  return result;
}

/** Whether a given recent blockhash is still valid for transaction inclusion. Returns both the
 *  validity and the context slot of the observation (the freshness state machine requires
 *  `contextSlot >= request.slot` to treat an `invalid` result as authoritative). */
export async function isBlockhashValid(
  url: string,
  blockhash: string,
  opts?: SolanaRpcOpts,
): Promise<{valid: boolean; contextSlot: number}> {
  const config: Record<string, unknown> = {commitment: SOL_PAYMENT_COMMITMENT};
  if (opts?.minContextSlot !== undefined) config.minContextSlot = opts.minContextSlot;
  const result = (await rpcFetch(url, 'isBlockhashValid', [blockhash, config], opts)) as {
    context: {slot: number};
    value: boolean;
  };
  return {valid: result.value === true, contextSlot: result.context.slot};
}

/** History-aware signature status lookup for a single signature. Calls `getSignatureStatuses` with
 *  `{searchTransactionHistory:true}` so a TX that already landed (even if it dropped out of the
 *  node's recent-status cache) is still observable. Returns the parsed status (or null when the
 *  signature is unknown to the node) + the context slot of the observation.
 *
 *  Distinct from the existing `confirmTransaction` poll (which uses a non-history-aware
 *  `getSignatureStatuses` for the v1 rail). The v2 freshness state machine uses THIS helper so a
 *  confirm timeout can be authoritatively classified: a null status, combined with an expired
 *  blockhash, is definitive expiry; a present status is the on-chain verdict. */
export async function getSignatureStatusesForSig(
  url: string,
  signature: string,
  opts?: SolanaRpcOpts,
): Promise<{status: SolanaSignatureStatus | null; contextSlot: number}> {
  const result = (await rpcFetch(
    url,
    'getSignatureStatuses',
    [[signature], {searchTransactionHistory: true}],
    opts,
  )) as {
    context: {slot: number};
    value: (SolanaSignatureStatus | null)[];
  };
  const status = Array.isArray(result.value) ? result.value[0] ?? null : null;
  return {status, contextSlot: result.context.slot};
}

/** Quote the lamport fee for a (base64-encoded) message. Returns null when the RPC cannot compute
 *  the fee (the message references accounts not yet loadable, or is otherwise invalid). Used by the
 *  v2 path + the Phase 6 reclaim fee quote. */
export async function getFeeForMessage(
  url: string,
  messageBase64: string,
  opts?: SolanaRpcOpts,
): Promise<bigint | null> {
  const config: Record<string, unknown> = {commitment: SOL_PAYMENT_COMMITMENT};
  if (opts?.minContextSlot !== undefined) config.minContextSlot = opts.minContextSlot;
  const result = (await rpcFetch(url, 'getFeeForMessage', [messageBase64, config], opts)) as number | null;
  return result === null ? null : BigInt(result);
}
