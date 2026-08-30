// Minimal Solana JSON-RPC 2.0 client over `fetch` with bounded timeouts. NETWORK module —
// dynamic-imported from the seam `app/solana.ts` so `@solana/*` (here: none) and real RPC never run
// under jest/e2e (the seam no-ops when `SOLANA_RPC_URL` is empty, which jest.setup.js + the e2e
// driver set). Exposes the online SOL MVP + offline-pay rail calls:
//   getBalance, getLatestBlockhash, sendTransaction, confirmTransaction (poll getSignatureStatuses).
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

import {composeTimeout as composeTimeoutShared} from '../lib/timeout';
import {bytesToBase64} from '../lib/base64';
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
 *  the fee (the message references accounts not yet loadable, or is otherwise invalid). Used by
 *  the v2 path. */
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

// ============================================================================
// Transaction history — the two reads `solana/history.ts` composes into the SOL rail's ledger.
// These stay THIN on purpose: they validate only what makes the response usable AT ALL (the
// signature list must be an ordered array of {signature, slot}), and hand the transaction detail
// back verbatim. The money-critical validation (balance arrays, token amounts, decimals) lives in
// history.ts, because there a single malformed transaction must become one logged, counted drop —
// not an exception that blanks the whole list.
// ============================================================================

/** One entry of `getSignaturesForAddress`. `slot` is the ordering key: always present and
 *  monotonic, unlike the `blockTime` the same response carries — which a node may not have, and
 *  which is read off the transaction DETAIL (one source) rather than duplicated from here. */
export interface SolanaSignatureInfo {
  readonly signature: string;
  readonly slot: number;
}

/** One pre/post SPL token balance snapshot from `meta`. `owner` is the token account's OWNER
 *  wallet (not the token account itself) — the field that says whose money this is. It is optional
 *  on the wire; history.ts refuses to guess when it is missing for a mint it is accounting. */
export interface SolanaTokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: {readonly amount: string; readonly decimals: number};
}

/** `meta` of a confirmed transaction. `preBalances`/`postBalances` are lamports indexed over the
 *  FULL account list (static message keys ++ loadedAddresses.writable ++ loadedAddresses.readonly).
 *  `err` is non-null exactly when the transaction failed on-chain (the fee is still charged). */
export interface SolanaTransactionMeta {
  readonly err: unknown;
  readonly fee: number;
  readonly preBalances: readonly number[];
  readonly postBalances: readonly number[];
  readonly preTokenBalances?: readonly SolanaTokenBalance[];
  readonly postTokenBalances?: readonly SolanaTokenBalance[];
  /** Present for versioned (v0) transactions that resolve accounts through address lookup tables. */
  readonly loadedAddresses?: {writable: readonly string[]; readonly: readonly string[]};
}

/** A confirmed transaction as returned by `getTransaction` with `encoding:'json'` (accountKeys are
 *  base58 STRINGS — `jsonParsed` would make them objects and is not requested). */
export interface SolanaTransactionDetail {
  readonly slot: number;
  readonly blockTime: number | null;
  readonly meta: SolanaTransactionMeta | null;
  readonly transaction: {readonly message: {readonly accountKeys: readonly string[]}};
}

/** The most recent `limit` transaction signatures that touched `address`, newest-first. Bounded by
 *  `limit` — no `before` cursor is exposed (the wallet shows a recent list, never an unbounded
 *  walk). Throws on a malformed entry: a list we cannot order is unusable, not a partial result. */
export async function getSignaturesForAddress(
  url: string,
  address: string,
  limit: number,
  opts?: SolanaRpcOpts,
): Promise<SolanaSignatureInfo[]> {
  const result = (await rpcFetch(
    url,
    'getSignaturesForAddress',
    [address, {limit, commitment: SOL_PAYMENT_COMMITMENT}],
    opts,
  )) as unknown;
  if (!Array.isArray(result)) {
    throw new Error(`solana rpc: getSignaturesForAddress returned a non-array for ${address}`);
  }
  return result.map((e: {signature?: unknown; slot?: unknown}) => {
    if (typeof e?.signature !== 'string' || !Number.isSafeInteger(e?.slot)) {
      throw new Error(`solana rpc: getSignaturesForAddress returned a malformed entry for ${address}`);
    }
    return {signature: e.signature, slot: e.slot as number};
  });
}

/** A confirmed transaction's detail, or `null` when the node does not have it (unknown signature,
 *  or pruned). `maxSupportedTransactionVersion:0` is REQUIRED — without it the RPC errors outright
 *  on every versioned (v0) transaction, which is most of mainnet. */
export async function getTransaction(
  url: string,
  signature: string,
  opts?: SolanaRpcOpts,
): Promise<SolanaTransactionDetail | null> {
  const result = (await rpcFetch(
    url,
    'getTransaction',
    [signature, {encoding: 'json', commitment: SOL_PAYMENT_COMMITMENT, maxSupportedTransactionVersion: 0}],
    opts,
  )) as unknown;
  if (result === null) return null;
  if (typeof result !== 'object') {
    throw new Error(`solana rpc: getTransaction returned a non-object for ${signature}`);
  }
  return result as SolanaTransactionDetail;
}
