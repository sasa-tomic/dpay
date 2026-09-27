// evm/claims — the offline permit claim engine (D21/D22/D24/D25 of the EVM-rail spec). The money
// mechanics of "merchant collects a pull-claim while offline" in one PURE-over-injection module:
//
//   1. OFFLINE SIGN (payer): `signEvmClaim` turns a decoded evmreq:v1 into an EIP-2612 permit
//      signature over the token's registry domain (minimal for ZCHF, addendum 1) and attaches the
//      raw 65-byte sig to an evmpay:v1 claim bound by rid. No network — the permit nonce comes
//      from the caller's cache (`takeEvmNonce`, D22.2).
//   2. NONCE CACHE (payer): AsyncStorage-backed `${chainId}:${token}` → next nonce. The balance
//      poll seeds it (D22.1); each offline sign consumes + optimistically bumps it; the
//      `needs-resign` outcome resets it to the chain's answer (D22.3).
//   3. CLAIM QUEUE (merchant): an AsyncStorage list, schema-versioned envelope, per-identity key,
//      capped at 50 with oldest-settled eviction, corrupt-tolerant load (a malformed value degrades
//      to empty rows, never a throw) — the list-shaped twin of `services/solMerchantPersist.ts`.
//   4. SETTLE (merchant, D24): permit() then transferFrom(), gas from the merchant's ETH, over an
//      INJECTED `EvmRpcLike` — no network import here. Every spend is preceded by typed pre-checks
//      (binding, expiry, duplicate, on-chain re-entry log scan, gas gate, revert-classifying
//      eth_call preflight). Settle-first-wins: the first successful transferFrom IS the payment;
//      a replayed claim resolves to the first settle's hash or the on-chain Transfer log and never
//      spends twice (D24.4). A stale permit nonce classifies as the `needs-resign` STATE (not an
//      error) with the on-chain nonce attached, so the payer re-signs the same rid fresh (D22.3).
//   5. RECEIPT DECISION (payer, D25): `decideEvmPayerReceipt` mirrors decideSolPayerReceiptV2 with
//      EXPLICIT lowercase hex normalization on both compared sides.
//
// SEAM CONTRACT (integration with `app/evm.ts`, D10 — owned by another stream, not yet landed):
// the seam adapts its JSON-RPC client to `EvmRpcLike` below (method names are the client's, the
// `ethCall`/`send` reject paths carry the revert payload) and exposes
// `settleEvmClaim(secretHex, req, claim, rpc)` as a thin wrapper resolving `key` from the device
// identity, `tokenAddress` via `resolveEvmTokenAddress`, and the receipt-poll deadlines from the
// D10 table. Until the seam lands, tests and callers inject `EvmRpcLike` directly.

import AsyncStorage from '@react-native-async-storage/async-storage';
import {secp256k1} from '@noble/curves/secp256k1';
import {bytesToUtf8} from '../lib/base64url';
import {bytesToHex, hexToBytes} from '../lib/format';
import {
  addressWord,
  decodeTransferLog,
  decodeUint256,
  encodePermit,
  encodeTransferFrom,
  functionSelector,
  TRANSFER_EVENT_TOPIC,
} from './abi';
import {EVM_CHAINS, evmZchfDeployment, type EvmChainId} from './chains';
import {evmKeypairFromPrivate} from './identity';
import {keccak256} from './keccak';
import {signPermit, permitDigest, type PermitDomain, type PermitMessage} from './permit';
import {signEip1559Tx, toHex0x} from './tx';
import {
  encodeEvmPay,
  isEvmReqExpired,
  isValidEvmPayShape,
  isValidEvmReqShape,
  type EvmPayV1,
  type EvmReceiptV1,
  type EvmReqV1,
} from './qr';

export type {EvmPayV1, EvmReceiptV1, EvmReqV1} from './qr';

// ---------------------------------------------------------------------------
// Token resolution — the registry (evm/chains.ts) is the single source of truth.
// ---------------------------------------------------------------------------

/** The contract address for a registry token on a chain, or null when the chain has no deployment
 *  (a request naming an unresolvable token can never be signed or settled — refuse at the door). */
export function resolveEvmTokenAddress(chainId: number, token: string): string | null {
  if (token !== 'ZCHF') return null; // the only registry symbol that ships; a new row extends this
  return evmZchfDeployment(chainId as EvmChainId)?.address ?? null;
}

/** The permit domain for the token deployment the registry names on `chainId`. Only the MINIMAL
 *  domain ships (real ZCHF on both chains + the committed MockZCHF are ERC20PermitLight, addendum
 *  1); a 'full'-kind deployment would need name/version in the registry before signing is legal —
 *  refuse rather than sign over a guessed domain (a wrong-domain permit is a valid-looking
 *  signature the token always rejects). */
export function permitDomainFor(chainId: number): PermitDomain {
  const dep = evmZchfDeployment(chainId as EvmChainId);
  if (!dep) throw new Error(`evm claims: no ZCHF deployment on chain ${chainId}`);
  if (dep.domainKind !== 'minimal') {
    throw new Error('evm claims: full-domain tokens need registry name/version — not shipped');
  }
  return {kind: 'minimal', chainId, verifyingContract: dep.address};
}

// ---------------------------------------------------------------------------
// 1. Offline sign + signature recovery helpers
// ---------------------------------------------------------------------------

export interface EvmSignedClaim {
  /** The rid-bound claim with the 65-byte permit signature attached (the evmpay:v1 payload). */
  readonly claim: EvmPayV1;
  /** `encodeEvmPay(claim)` — the QR (later NFC, same bytes) payload the payer hands back. */
  readonly claimUri: string;
  /** The permit nonce consumed (the payer records it; the optimistic cache is already bumped). */
  readonly nonceUsed: number;
  /** The token contract the permit targets (resolved from the registry). */
  readonly tokenAddress: string;
}

/** Sign the EIP-2612 permit for a decoded evmreq:v1 OFFLINE and attach the signature to an
 *  evmpay:v1 claim. `nonce` is the permit nonce the caller cached (D22.2); `exp` is the deadline
 *  (D21: deadline == req.exp); the spender IS the merchant's `to` address and the value IS `amt`.
 *  Pure: no network, no clock, no storage. */
export function signEvmClaim(privateKey: Uint8Array, req: EvmReqV1, nonce: number): EvmSignedClaim {
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new Error(`evm claims: permit nonce must be a safe non-negative integer, got ${nonce}`);
  }
  const domain = permitDomainFor(req.chainId);
  const owner = evmKeypairFromPrivate(privateKey).address;
  const msg: PermitMessage = {
    owner,
    spender: req.to,
    value: BigInt(req.amt),
    deadline: BigInt(req.exp),
    nonce: BigInt(nonce),
  };
  const signed = signPermit(privateKey, domain, msg);
  const claim: EvmPayV1 = {
    v: 1,
    rid: req.rid,
    owner,
    deadline: req.exp,
    sig: '0x' + bytesToHex(signed.serialized),
  };
  // Self-check before handing the claim out: the attached signature must recover to the owner
  // over the exact fields the merchant will submit. A mismatch is a code bug, never a runtime
  // condition — better to refuse than ship a claim that can only fail on-chain.
  const recovered = recoverEvmClaimSigner(domain, msg, claim.sig);
  if (recovered !== owner) {
    throw new Error('evm claims: attached permit signature does not recover to the owner');
  }
  return {claim, claimUri: encodeEvmPay(claim), nonceUsed: nonce, tokenAddress: domain.verifyingContract};
}

/** Recover the signer address from a 0x + 130-hex permit signature over explicit permit fields.
 *  Returns null for a malformed or unrecoverable signature (never throws). The on-chain role of
 *  this function is the token's own ecrecover; here it serves the payer self-check and the
 *  merchant/test mock's preflight verification (the same math the contract runs). */
export function recoverEvmClaimSigner(
  domain: PermitDomain,
  msg: PermitMessage,
  sigHex: string,
): string | null {
  try {
    const raw = hexToBytes(sigHex);
    if (raw.length !== 65) return null;
    const v = raw[64];
    if (v !== 27 && v !== 28) return null;
    const sig = secp256k1.Signature.fromCompact(raw.subarray(0, 64)).addRecoveryBit(v - 27);
    const digest = permitDigest(domain, msg);
    const pub = sig.recoverPublicKey(digest); // throws on an invalid recovery bit for this digest
    const uncompressed = pub.toRawBytes(false).subarray(1); // drop the 0x04 prefix
    const addrBytes = keccak256(new Uint8Array(uncompressed)).subarray(12);
    return '0x' + bytesToHex(new Uint8Array(addrBytes));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2. Permit nonce cache (payer side, D22)
// ---------------------------------------------------------------------------

export type EvmNonceCache = Record<string, number>; // key `${chainId}:${token}` → next nonce

export function evmNonceCacheKey(identityAddress: string): string {
  return `dpay.evm.nonces.v1.${identityAddress.toLowerCase()}`;
}

export function evmNonceKey(chainId: number, token: string): string {
  return `${chainId}:${token}`;
}

async function loadNonceStore(identityAddress: string): Promise<EvmNonceCache> {
  try {
    const raw = await AsyncStorage.getItem(evmNonceCacheKey(identityAddress));
    if (raw == null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: EvmNonceCache = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) out[k] = v;
    }
    return out;
  } catch {
    return {}; // corrupt or unreadable — the next online poll re-seeds; never throw
  }
}

/** Consume the cached permit nonce and optimistically bump the cache (D22.2: both the consumed
 *  value and the bump are durable before the caller shows the QR). The cache is seeded by the
 *  balance poll's `nonces(owner)` read (D22.1); an unseeded key starts at 0 (a fresh account's
 *  nonce). Single-flight by usage: one claim signs at a time per device. */
export async function takeEvmNonce(identityAddress: string, chainId: number, token: string): Promise<number> {
  const cache = await loadNonceStore(identityAddress);
  const key = evmNonceKey(chainId, token);
  const consumed = cache[key] ?? 0;
  cache[key] = consumed + 1;
  await saveNonceStore(identityAddress, cache);
  return consumed;
}

/** Seed/overwrite one cached nonce (the poll's online `nonces(owner)` read, D22.1). */
export async function seedEvmNonce(
  identityAddress: string,
  chainId: number,
  token: string,
  nonce: number,
): Promise<void> {
  const cache = await loadNonceStore(identityAddress);
  cache[evmNonceKey(chainId, token)] = nonce;
  await saveNonceStore(identityAddress, cache);
}

/** The `needs-resign` report: the true on-chain nonce replaces the stale guess (D22.3). */
export async function resetEvmNonce(
  identityAddress: string,
  chainId: number,
  token: string,
  observedNonce: number,
): Promise<void> {
  return seedEvmNonce(identityAddress, chainId, token, observedNonce);
}

async function saveNonceStore(identityAddress: string, cache: EvmNonceCache): Promise<void> {
  try {
    await AsyncStorage.setItem(evmNonceCacheKey(identityAddress), JSON.stringify(cache));
  } catch (e) {
    console.warn(
      'evm claims: nonce cache persist failed — a restart may re-guess a consumed nonce:',
      e instanceof Error ? e.message : String(e),
    );
  }
}

// ---------------------------------------------------------------------------
// 3. The merchant claim queue (AsyncStorage, D23)
// ---------------------------------------------------------------------------

export type EvmClaimStatus = 'queued' | 'settling' | 'settled' | 'failed' | 'unknown' | 'needsResign';
export type EvmClaimFailReason = 'nonce' | 'expired' | 'rejected' | 'gas' | null;

/** One queued offline claim. Deviations from the D23 sketch, all load-bearing: the FULL `req` is
 *  carried (the claim deliberately carries only rid/owner/deadline/sig — settling needs chainId,
 *  token, to and amt); `createdAtMs` drives eviction; `failDetail` carries the instructive failure
 *  text; status gains 'needsResign' (D22.3's state, not an error). `permitNonce` holds the
 *  on-chain nonces(owner) observed at the failed classify — the nonce a re-sign must use. */
export interface EvmClaimRow {
  readonly req: EvmReqV1;
  readonly claim: EvmPayV1;
  readonly status: EvmClaimStatus;
  readonly txHash: string | null; // set on settled/unknown — the reconciliation handle
  readonly permitNonce: number; // -1 until an on-chain read produces a value
  readonly failReason: EvmClaimFailReason;
  readonly failDetail: string | null;
  readonly attempts: number; // settle re-entry guard (MAX_CLAIM_ATTEMPTS, then failed honestly)
  readonly settledAtMs: number | null;
  readonly createdAtMs: number;
}

export const MAX_EVM_CLAIMS = 50;
export const MAX_CLAIM_ATTEMPTS = 3;

const CLAIMS_SCHEMA = 1;

export function evmClaimsKey(identityAddress: string): string {
  return `dpay.evm.claims.v1.${identityAddress.toLowerCase()}`;
}

function emptyRow(req: EvmReqV1, claim: EvmPayV1, nowMs: number): EvmClaimRow {
  return {
    req,
    claim,
    status: 'queued',
    txHash: null,
    permitNonce: -1,
    failReason: null,
    failDetail: null,
    attempts: 0,
    settledAtMs: null,
    createdAtMs: nowMs,
  };
}

const STATUS_VALUES: readonly EvmClaimStatus[] = ['queued', 'settling', 'settled', 'failed', 'unknown', 'needsResign'];
const FAIL_REASONS: readonly string[] = ['nonce', 'expired', 'rejected', 'gas'];

/** The pure hydrater: an unknown stored blob → valid rows only. A wrong envelope or non-array rows
 *  degrades to [] (never thrown); an individually-corrupt ROW is dropped, not its 49 valid
 *  siblings. Every row is shape-checked (codec rules) AND rid/deadline binding-checked, so a
 *  hand-edited blob can never surface as a settlable claim. */
export function hydrateEvmClaimRows(raw: unknown): EvmClaimRow[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const env = raw as Record<string, unknown>;
  if (env.schema !== CLAIMS_SCHEMA || !Array.isArray(env.rows)) return [];
  const rows: EvmClaimRow[] = [];
  for (const item of env.rows) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (!isValidEvmReqShape(r.req) || !isValidEvmPayShape(r.claim)) continue;
    const req = r.req as EvmReqV1;
    const claim = r.claim as EvmPayV1;
    if (claim.rid !== req.rid || claim.deadline !== req.exp) continue; // binding must hold in storage
    if (typeof r.status !== 'string' || !STATUS_VALUES.includes(r.status as EvmClaimStatus)) continue;
    if (r.txHash !== null && typeof r.txHash !== 'string') continue;
    if (typeof r.permitNonce !== 'number' || !Number.isSafeInteger(r.permitNonce)) continue;
    if (r.failReason !== null && (typeof r.failReason !== 'string' || !FAIL_REASONS.includes(r.failReason))) continue;
    if (r.failDetail !== null && typeof r.failDetail !== 'string') continue;
    if (typeof r.attempts !== 'number' || !Number.isSafeInteger(r.attempts) || r.attempts < 0) continue;
    if (r.settledAtMs !== null && typeof r.settledAtMs !== 'number') continue;
    if (typeof r.createdAtMs !== 'number' || !Number.isSafeInteger(r.createdAtMs)) continue;
    rows.push({
      req,
      claim,
      status: r.status as EvmClaimStatus,
      txHash: r.txHash as string | null,
      permitNonce: r.permitNonce,
      failReason: r.failReason as EvmClaimFailReason,
      failDetail: r.failDetail as string | null,
      attempts: r.attempts,
      settledAtMs: r.settledAtMs as number | null,
      createdAtMs: r.createdAtMs,
    });
  }
  return rows;
}

/** Load the queue. Best-effort: a missing, corrupt or unreadable value degrades to [] — a storage
 *  glitch can never crash the settle/resume path (the solMerchantPersist discipline). */
export async function loadEvmClaims(key: string): Promise<EvmClaimRow[]> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch (e) {
    console.warn('evm claims: reading the queue failed:', e instanceof Error ? e.message : String(e));
    return [];
  }
  if (raw == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // not JSON — swallow, start fresh
  }
  return hydrateEvmClaimRows(parsed);
}

/** Persist the queue. Best-effort: an AsyncStorage failure warns (a missed persist means a restart
 *  re-derives state from the chain, not a crash). */
export async function saveEvmClaims(key: string, rows: EvmClaimRow[]): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify({schema: CLAIMS_SCHEMA, rows}));
  } catch (e) {
    console.warn(
      'evm claims: persisting the queue failed — a restart will not see these claims:',
      e instanceof Error ? e.message : String(e),
    );
  }
}

export interface EvmEnqueueInput {
  readonly req: EvmReqV1;
  readonly claim: EvmPayV1;
  readonly nowMs?: number;
}

/** Queue a scanned claim. The rid is single-use locally (D24.4):
 *  - a SETTLED row with the rid is never overwritten (re-scan after settle is a no-op);
 *  - identical claim bytes already queued are a no-op (idempotent re-scan);
 *  - DIFFERENT bytes over a 'needsResign' row adopt as a fresh 'queued' row (the D22.3 re-sign);
 *  - anything else with the rid is refused (the existing row wins).
 *  Appends otherwise, then enforces the 50-row cap: oldest-settled terminal rows evict first;
 *  a queue of only-unsettled rows drops the oldest row last of all (bounded storage). */
export async function enqueueEvmClaim(key: string, input: EvmEnqueueInput): Promise<EvmClaimRow[]> {
  const nowMs = input.nowMs ?? Date.now();
  const rows = await loadEvmClaims(key);
  const existingIdx = rows.findIndex((r) => r.claim.rid === input.claim.rid);
  if (existingIdx >= 0) {
    const existing = rows[existingIdx];
    const sameBytes =
      existing.claim.sig === input.claim.sig &&
      existing.claim.owner === input.claim.owner &&
      existing.claim.deadline === input.claim.deadline &&
      reqEq(existing.req, input.req);
    if (existing.status === 'settled' || sameBytes || existing.status !== 'needsResign') {
      return rows;
    }
    // A re-signed claim (fresh nonce, same rid) replaces the stale one and resets the retry guard.
    rows[existingIdx] = {...emptyRow(input.req, input.claim, nowMs), createdAtMs: existing.createdAtMs};
  } else {
    rows.push(emptyRow(input.req, input.claim, nowMs));
  }
  const capped = capRows(rows);
  await saveEvmClaims(key, capped);
  return capped;
}

function reqEq(a: EvmReqV1, b: EvmReqV1): boolean {
  return (
    a.rid === b.rid &&
    a.chainId === b.chainId &&
    a.token === b.token &&
    a.to === b.to &&
    a.amt === b.amt &&
    a.iat === b.iat &&
    a.exp === b.exp &&
    a.name === b.name &&
    a.memo === b.memo
  );
}

function capRows(rows: EvmClaimRow[]): EvmClaimRow[] {
  if (rows.length <= MAX_EVM_CLAIMS) return rows;
  const terminal = (r: EvmClaimRow) => r.status === 'settled' || r.status === 'failed';
  const bySettledOldest = [...rows]
    .filter(terminal)
    .sort((a, b) => (a.settledAtMs ?? a.createdAtMs) - (b.settledAtMs ?? b.createdAtMs));
  const drop = new Set(bySettledOldest.slice(0, rows.length - MAX_EVM_CLAIMS));
  let kept = rows.filter((r) => !drop.has(r));
  if (kept.length > MAX_EVM_CLAIMS) {
    kept = [...kept].sort((a, b) => a.createdAtMs - b.createdAtMs).slice(kept.length - MAX_EVM_CLAIMS);
  }
  return kept;
}

/** Apply a patch to one row by rid; returns the updated list (persisted). Unknown rid → unchanged. */
export async function patchEvmClaim(
  key: string,
  rid: string,
  patch: Partial<Omit<EvmClaimRow, 'req' | 'claim'>>,
): Promise<EvmClaimRow[]> {
  const rows = await loadEvmClaims(key);
  const idx = rows.findIndex((r) => r.claim.rid === rid);
  if (idx < 0) return rows;
  rows[idx] = {...rows[idx], ...patch};
  await saveEvmClaims(key, rows);
  return rows;
}

// ---------------------------------------------------------------------------
// 4. Revert classification (typed outcomes, never string-prefix assumptions)
// ---------------------------------------------------------------------------

export type EvmRevert =
  | {kind: 'expired'} // PERMIT_DEADLINE_EXPIRED
  | {kind: 'invalid-signer'} // INVALID_SIGNER — stale nonce OR garbage signature
  | {kind: 'nonce'} // INVALID_NONCE (the OZ spelling of a consumed nonce)
  | {kind: 'insufficient-funds'} // insufficient allowance/balance on the token side
  | {kind: 'string'; message: string}
  | {kind: 'opaque'};

// Verified revert strings: the committed MockZCHF (e2e/harness/evm/MockZCHF.sol) and real ZCHF's
// ERC20PermitLight (spec addendum 1) both use PERMIT_DEADLINE_EXPIRED / INVALID_SIGNER. The token
// transfer guards are matched on the STANDARD phrases ('insufficient allowance'/'insufficient
// balance'), never on a 'ZCHF: …' prefix — tokens word their require strings differently.
const REVERT_MARKERS: ReadonlyArray<readonly [string, EvmRevert['kind']]> = [
  ['PERMIT_DEADLINE_EXPIRED', 'expired'],
  ['INVALID_SIGNER', 'invalid-signer'],
  ['INVALID_NONCE', 'nonce'],
  ['insufficient allowance', 'insufficient-funds'],
  ['insufficient balance', 'insufficient-funds'],
];

/** Decode a Solidity `Error(string)` revert payload (selector 0x08c379a0) — the message, or null
 *  for any other selector/shape. */
export function decodeSolidityRevertString(dataHex: string): string | null {
  try {
    const bytes = hexToBytes(dataHex);
    if (bytes.length < 4 + 32 + 32) return null;
    if (bytesToHex(bytes.subarray(0, 4)) !== '08c379a0') return null;
    const len = BigInt('0x' + bytesToHex(bytes.subarray(36, 68)));
    if (len > 1024n) return null; // sanity bound — a message is short
    const body = bytes.subarray(68, 68 + Number(len));
    return bytesToUtf8(new Uint8Array(body));
  } catch {
    return null;
  }
}

/** Classify any thrown rpc error into a typed outcome. Reads `err.data` (0x-hex revert payload,
 *  the ethers/viem convention) first, then the message text for the verified markers. RPC
 *  implementations SHOULD mark transport (non-revert) failures with `err.transport = true`; those
 *  classify as {kind: 'opaque'} + the marker so the settle path can tell "the chain answered: no"
 *  from "we could not ask" (the queue treats the latter as retryable-unknown). */
export function classifyEvmRevert(err: unknown): EvmRevert & {transport: boolean} {
  const transport = !!(err as {transport?: unknown} | null)?.transport;
  const data = (err as {data?: unknown} | null)?.data;
  let text: string | null = null;
  let sawText = false;
  if (typeof data === 'string' && data.length > 10) {
    const decoded = decodeSolidityRevertString(data);
    if (decoded !== null) {
      text = decoded;
      sawText = true;
    }
  }
  if (text === null && err instanceof Error && err.message) {
    text = err.message;
    sawText = true;
  }
  if (text !== null) {
    for (const [marker, kind] of REVERT_MARKERS) {
      if (text.includes(marker)) return {kind, transport} as EvmRevert & {transport: boolean};
    }
  }
  if (sawText && text !== null) return {kind: 'string', message: text, transport};
  return {kind: 'opaque', transport};
}

// ---------------------------------------------------------------------------
// 5. Settle (merchant, D24) — PURE over the injected rpc
// ---------------------------------------------------------------------------

/** The JSON-RPC surface settle needs. `app/evm.ts`'s rpc client (D9's module list) maps 1:1 onto
 *  these names; `ethGetTransactionCount` is the merchant tx-nonce source. `ethCall`'s optional
 *  `from` sets eth_call's msg.sender — REQUIRED for the transferFrom preflight (the token checks
 *  allowance[owner][msg.sender], so without `from` the call would see the zero address and revert
 *  spuriously); the permit preflight omits it (permit is ecrecover-based, msg.sender-blind).
 *  Reverts reject from `ethCall` with the revert payload on `err.data` (or the message); transport
 *  failures reject with `err.transport = true` so the queue can stay honest about the difference
 *  between "the chain answered: no" and "we could not ask". */
export interface EvmRpcLike {
  ethCall(to: string, data: Uint8Array, from?: string): Promise<string>;
  ethGetBalance(address: string): Promise<bigint>;
  ethGetTransactionCount(address: string): Promise<number>;
  ethEstimateGas(tx: {from: string; to: string; data: Uint8Array}): Promise<bigint>;
  ethGasPrice(): Promise<bigint>;
  ethMaxPriorityFeePerGas(): Promise<bigint>;
  ethSendRawTransaction(raw: Uint8Array): Promise<string>;
  ethGetTransactionReceipt(txHash: string): Promise<{status: string} | null>;
  ethGetLogs(filter: {
    address: string;
    topics: string[];
    fromBlock: number;
    toBlock: 'latest';
  }): Promise<Array<{transactionHash?: string; topics?: string[]; data?: string}>>;
}

export type EvmSettleOutcome = 'settled' | 'needs-resign' | 'failed' | 'unknown';

export interface EvmSettleResult {
  readonly outcome: EvmSettleOutcome;
  /** The queue row after the settle attempt (already persisted). */
  readonly row: EvmClaimRow;
  /** The settle tx hash (permit or transferFrom stage); null when nothing was broadcast. */
  readonly txHash: string | null;
  readonly reason: EvmClaimFailReason;
  readonly detail: string | null;
  /** needs-resign only: the on-chain nonces(owner) a fresh signature must use. */
  readonly observedNonce: number | null;
}

export interface EvmSettleInput {
  /** The queue store key — `evmClaimsKey(identityAddress)`. */
  readonly key: string;
  readonly merchantPrivateKey: Uint8Array;
  readonly req: EvmReqV1;
  readonly claim: EvmPayV1;
  /** The token contract — resolve via `resolveEvmTokenAddress(req.chainId, req.token)`. */
  readonly tokenAddress: string;
  readonly rpc: EvmRpcLike;
  readonly nowMs?: number;
  /** Receipt-poll cadence + per-tx confirm deadline (defaults 1.5s / 60s, D24.2). */
  readonly pollMs?: number;
  readonly settleDeadlineMs?: number;
  /** Lower bound for the re-entry Transfer-log scan (the claim's arrival block; 0 scans all). */
  readonly fromBlock?: number;
}

const SELECTOR_NONCES = functionSelector('nonces(address)');

/** calldata for `nonces(address owner)` — the merchant's stale-nonce diagnostic + the payer
 *  poll's cache seed (D16/D22.1). */
export function encodeEvmNonces(owner: string): Uint8Array {
  return new Uint8Array([...SELECTOR_NONCES, ...addressWord(owner)]);
}

/** Read `nonces(owner)` through the injected rpc (the permit replay-protection counter). */
export async function readEvmPermitNonce(rpc: EvmRpcLike, token: string, owner: string): Promise<number> {
  const out = await rpc.ethCall(token, encodeEvmNonces(owner));
  return Number(decodeUint256(out));
}

function topicFor(address: string): string {
  return '0x' + bytesToHex(addressWord(address));
}

function receiptStatus(rec: {status: string} | null): 1 | 0 | null {
  if (!rec) return null;
  const n = parseInt(rec.status, 16);
  if (n === 1) return 1;
  if (n === 0) return 0;
  return null;
}

async function pollReceipt(
  rpc: EvmRpcLike,
  txHash: string,
  deadlineMs: number,
  pollMs: number,
): Promise<{status: string} | null> {
  const start = Date.now();
  for (;;) {
    const rec = await rpc.ethGetTransactionReceipt(txHash);
    if (rec) return rec;
    if (Date.now() - start >= deadlineMs) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function sameClaimBytes(a: EvmPayV1, b: EvmPayV1): boolean {
  return a.sig === b.sig && a.owner === b.owner && a.deadline === b.deadline && a.rid === b.rid;
}

/**
 * Settle one offline claim: permit(owner, spender=merchant, value, deadline, v, r, s) then
 * transferFrom(owner → merchant), both signed by the MERCHANT key (the merchant's ETH pays gas,
 * D24). Order of operations is the safety story:
 *
 *   binding → expiry → duplicate(rid, local) → re-entry(Transfer log, on-chain) → attempts guard
 *   → permit preflight (typed revert classification, zero gas) → gas gate (balance ≥ 2×fee)
 *   → permit sign+broadcast+receipt → transferFrom preflight → sign+broadcast+receipt → settled.
 *
 * Outcomes are honest by construction: 'settled' carries the winning tx hash; 'needs-resign' is
 * the stale-nonce STATE (never thrown, never terminal) with the on-chain nonce attached;
 * 'failed' is terminal with the instructive reason; 'unknown' means a broadcast whose receipt
 * never confirmed (tx MAY land — the row is preserved with the hash for reconciliation), with
 * txHash null a chain answer the preflight could not get (row stays queued, retryable), or a
 * raced on-chain permit revert whose permit the token would still accept now (row re-queued,
 * retryable — the attempts guard bounds it; a terminal fail there would abandon a live claim).
 */
export async function settleEvmClaim(input: EvmSettleInput): Promise<EvmSettleResult> {
  const {key, req, claim, tokenAddress, rpc} = input;
  const nowMs = input.nowMs ?? Date.now();
  const pollMs = input.pollMs ?? 1500;
  const deadlineMs = input.settleDeadlineMs ?? 60_000;
  const fromBlock = input.fromBlock ?? 0;
  const merchant = evmKeypairFromPrivate(input.merchantPrivateKey);
  const merchantAddr = merchant.address.toLowerCase();
  const ownerAddr = claim.owner.toLowerCase();
  const amt = BigInt(req.amt);

  const fail = async (
    row: EvmClaimRow,
    reason: EvmClaimFailReason,
    detail: string,
  ): Promise<EvmSettleResult> => {
    const patched: EvmClaimRow = {...row, status: 'failed', failReason: reason, failDetail: detail};
    await saveEvmClaims(key, await replaceRow(key, patched));
    return {outcome: 'failed', row: patched, txHash: null, reason, detail, observedNonce: null};
  };

  // --- stage 0: binding + expiry (free, before anything else) -----------------------------
  if (claim.rid !== req.rid || claim.deadline !== req.exp) {
    const rows = await loadEvmClaims(key);
    const row = rows.find((r) => r.claim.rid === claim.rid) ?? emptyRow(req, claim, nowMs);
    return fail(row, 'rejected', 'claim does not bind to the request (rid/deadline mismatch)');
  }
  if (isEvmReqExpired(req, Math.floor(nowMs / 1000))) {
    const rows = await loadEvmClaims(key);
    const row = rows.find((r) => r.claim.rid === claim.rid) ?? emptyRow(req, claim, nowMs);
    return fail(row, 'expired', `request expired at unix ${req.exp} — ask for a fresh QR`);
  }

  // --- stage 1: load the row; settled/failed are idempotent, needsResign adopts a re-sign ---
  const rows = await loadEvmClaims(key);
  const idx = rows.findIndex((r) => r.claim.rid === claim.rid);
  let row: EvmClaimRow;
  if (idx >= 0) {
    const existing = rows[idx];
    if (existing.status === 'settled') {
      return {
        outcome: 'settled',
        row: existing,
        txHash: existing.txHash,
        reason: null,
        detail: 'already settled — no second spend',
        observedNonce: null,
      };
    }
    if (existing.status === 'failed') {
      return {
        outcome: 'failed',
        row: existing,
        txHash: null,
        reason: existing.failReason,
        detail: existing.failDetail,
        observedNonce: null,
      };
    }
    if (!sameClaimBytes(existing.claim, claim)) {
      if (existing.status !== 'needsResign') {
        return fail(existing, 'rejected', 'a different claim already holds this rid');
      }
      row = {...emptyRow(req, claim, nowMs), createdAtMs: existing.createdAtMs}; // the D22.3 re-sign
    } else {
      row = existing;
    }
  } else {
    row = emptyRow(req, claim, nowMs);
  }

  // --- stage 2: attempts guard, then the atomic settling reservation ----------------------
  if (row.attempts >= MAX_CLAIM_ATTEMPTS) {
    return fail(row, 'rejected', `settle gave up after ${row.attempts} attempts without success`);
  }
  row = {...row, attempts: row.attempts + 1, status: 'settling', failReason: null, failDetail: null};
  await saveEvmClaims(key, await replaceRow(key, row)); // reserved BEFORE the first network call

  // --- stage 3: on-chain re-entry (the 'unknown' reconcile): did the money already move? ---
  const log = await firstMatchingTransfer(rpc, tokenAddress, ownerAddr, merchantAddr, amt, fromBlock);
  if (log !== null) {
    row = {...row, status: 'settled', txHash: log, settledAtMs: nowMs, failDetail: 'found via Transfer log'};
    await saveEvmClaims(key, await replaceRow(key, row));
    return {outcome: 'settled', row, txHash: log, reason: null, detail: 'already settled — found via Transfer log', observedNonce: null};
  }

  // --- stage 4: split the signature; permit preflight classifies reverts for free ----------
  const sig = hexToBytes(claim.sig); // 65 bytes r||s||v (codec-validated)
  const v = sig[64];
  const permitData = encodePermit(claim.owner, req.to, amt, BigInt(claim.deadline), v, sig.slice(0, 32), sig.slice(32, 64));

  const classifyPermitFailure = async (
    err: unknown,
  ): Promise<EvmSettleResult> => {
    const cls = classifyEvmRevert(err);
    if (cls.transport) {
      // Could not ask the chain — nothing spent, the claim stays queued for the next online window.
      row = {...row, status: 'queued', failDetail: 'chain unreachable — claim stays queued'};
      await saveEvmClaims(key, await replaceRow(key, row));
      return {outcome: 'unknown', row, txHash: null, reason: null, detail: 'chain unreachable — claim stays queued', observedNonce: null};
    }
    if (cls.kind === 'invalid-signer' || cls.kind === 'nonce') {
      // The signature does not apply to the chain's current nonce: the D22.3 stale-nonce shape.
      // Read the TRUE nonce and surface the state (never a terminal error).
      let observed: number | null = null;
      try {
        observed = await readEvmPermitNonce(rpc, tokenAddress, claim.owner);
      } catch {
        observed = null;
      }
      row = {
        ...row,
        status: 'needsResign',
        failReason: 'nonce',
        permitNonce: observed ?? -1,
        failDetail: 'permit nonce stale — the payer must re-sign with the on-chain nonce',
      };
      await saveEvmClaims(key, await replaceRow(key, row));
      return {outcome: 'needs-resign', row, txHash: null, reason: 'nonce', detail: row.failDetail, observedNonce: observed};
    }
    if (cls.kind === 'expired') {
      return fail(row, 'expired', 'permit deadline expired on-chain — ask for a fresh QR');
    }
    const detail = cls.kind === 'string' ? cls.message : 'permit rejected by the token';
    return fail(row, 'rejected', detail);
  };

  try {
    await rpc.ethCall(tokenAddress, permitData);
  } catch (e) {
    return classifyPermitFailure(e);
  }

  // --- stage 5: the gas gate (D24.1) — merchant balance ≥ 2× the estimated fee, or refuse ----
  // The quote group runs against live state: if the permit's validity moved against us between the
  // preflight and now, the estimate itself reverts — classify from the chain's answer, never leak
  // a raw node error.
  let priority: bigint;
  let price: bigint;
  let balance: bigint;
  let gasUnits: bigint;
  try {
    [priority, price, gasUnits, balance] = await Promise.all([
      rpc.ethMaxPriorityFeePerGas(),
      rpc.ethGasPrice(),
      rpc.ethEstimateGas({from: merchantAddr, to: tokenAddress, data: permitData}),
      rpc.ethGetBalance(merchantAddr),
    ]);
  } catch (e) {
    return classifyPermitFailure(e);
  }
  // The SIGNED worst case per tx is maxFeePerGas = 2×base + priority (the send path's
  // arithmetic — a maxFeePerGas pinned AT the current base fee would tip 0 and strand the
  // settle in the mempool the moment the base fee rises). The gate demands TWO txs of that
  // worst case (permit + transferFrom, D24.1).
  const maxFeePerGas = price * 2n + priority;
  const need = 2n * gasUnits * maxFeePerGas;
  if (balance < need) {
    const native = EVM_CHAINS[req.chainId as EvmChainId]?.nativeSymbol ?? 'ETH';
    return fail(
      row,
      'gas',
      `settling needs ≈ ${need} wei of ${native} on chain ${req.chainId}; you hold ${balance} — receive ${native} at ${merchant.address}`,
    );
  }

  // --- stage 6: permit, signed + broadcast by the merchant ----------------------------------
  // A receipt channel that dies mid-poll degrades to "unseen" (the tx MAY land; the row keeps
  // the hash for reconciliation) instead of leaking a raw transport error.
  const poll = async (txHash: string): Promise<{status: string} | null> => {
    try {
      return await pollReceipt(rpc, txHash, deadlineMs, pollMs);
    } catch {
      return null;
    }
  };

  const sendTx = async (data: Uint8Array, gasLimit: bigint): Promise<string> => {
    const nonce = await rpc.ethGetTransactionCount(merchantAddr);
    const signed = signEip1559Tx(
      {
        chainId: req.chainId,
        nonce,
        maxPriorityFeePerGas: priority,
        maxFeePerGas,
        gasLimit,
        to: tokenAddress,
        value: 0n,
        data,
      },
      merchant.privateKey,
    );
    const txHash = toHex0x(signed.txHash);
    await rpc.ethSendRawTransaction(signed.raw); // a throw here is a lost answer → unknown
    return txHash;
  };

  let permitHash: string;
  try {
    permitHash = await sendTx(permitData, gasUnits);
  } catch {
    row = {...row, status: 'unknown', txHash: null, failDetail: 'permit broadcast answer lost'};
    await saveEvmClaims(key, await replaceRow(key, row));
    return {outcome: 'unknown', row, txHash: null, reason: null, detail: 'permit broadcast answer lost — nothing known to have landed', observedNonce: null};
  }

  const permitReceipt = await poll(permitHash);
  const permitStatus = receiptStatus(permitReceipt);
  if (permitStatus === null) {
    row = {...row, status: 'unknown', txHash: permitHash, failDetail: 'permit receipt not seen in time — the tx MAY land'};
    await saveEvmClaims(key, await replaceRow(key, row));
    return {outcome: 'unknown', row, txHash: permitHash, reason: null, detail: row.failDetail, observedNonce: null};
  }
  if (permitStatus === 0) {
    // Lost the inclusion race (or a state change between preflight and block): re-classify from
    // the chain's current answer — the honest path, D24.2's failed-permit mapping.
    try {
      await rpc.ethCall(tokenAddress, permitData);
      // The raced edge: the tx reverted AT INCLUSION while the CURRENT state would accept the
      // same permit (transient state has moved back). The permit may still be spendable, so a
      // terminal 'failed' would abandon a live claim — re-queue for the next settle window
      // instead. The attempts guard (stage 2) bounds the retries; the reverted tx's hash stays
      // on the row as the reconcile handle (a revert burns gas, but sets NO token state).
      row = {...row, status: 'queued', txHash: permitHash, failDetail: 'permit tx reverted on-chain, but the token would accept it now — re-queued'};
      await saveEvmClaims(key, await replaceRow(key, row));
      return {outcome: 'unknown', row, txHash: permitHash, reason: null, detail: row.failDetail, observedNonce: null};
    } catch (e) {
      return classifyPermitFailure(e);
    }
  }

  // --- stage 7: transferFrom (only after the permit confirms, D24.3) -------------------------
  const transferData = encodeTransferFrom(claim.owner, req.to, amt);
  try {
    await rpc.ethCall(tokenAddress, transferData, merchantAddr);
  } catch (e) {
    const cls = classifyEvmRevert(e);
    if (cls.transport) {
      // The permit is already consumed on-chain; leave the row pending on the permit hash so the
      // reconcile log scan can still close it out.
      row = {...row, status: 'unknown', txHash: permitHash, failDetail: 'transferFrom preflight unreachable after a consumed permit'};
      await saveEvmClaims(key, await replaceRow(key, row));
      return {outcome: 'unknown', row, txHash: permitHash, reason: null, detail: row.failDetail, observedNonce: null};
    }
    const detail = cls.kind === 'string' ? cls.message : 'transferFrom rejected by the token';
    return fail(row, 'rejected', detail);
  }
  let tfGas: bigint;
  try {
    tfGas = await rpc.ethEstimateGas({from: merchantAddr, to: tokenAddress, data: transferData});
  } catch (e) {
    // the transferFrom no longer quotes (balance/allowance moved) — the permit burn is real
    const cls = classifyEvmRevert(e);
    if (cls.transport) {
      row = {...row, status: 'unknown', txHash: permitHash, failDetail: 'transferFrom estimate unreachable after a consumed permit'};
      await saveEvmClaims(key, await replaceRow(key, row));
      return {outcome: 'unknown', row, txHash: permitHash, reason: null, detail: row.failDetail, observedNonce: null};
    }
    const detail = cls.kind === 'string' ? cls.message : 'transferFrom rejected by the token';
    return fail(row, 'rejected', detail);
  }

  let tfHash: string;
  try {
    tfHash = await sendTx(transferData, tfGas);
  } catch {
    row = {...row, status: 'unknown', txHash: permitHash, failDetail: 'transferFrom broadcast answer lost (permit consumed)'};
    await saveEvmClaims(key, await replaceRow(key, row));
    return {outcome: 'unknown', row, txHash: permitHash, reason: null, detail: row.failDetail, observedNonce: null};
  }

  const tfReceipt = await poll(tfHash);
  const tfStatus = receiptStatus(tfReceipt);
  if (tfStatus === null) {
    row = {...row, status: 'unknown', txHash: tfHash, failDetail: 'transferFrom receipt not seen in time — the tx MAY land'};
    await saveEvmClaims(key, await replaceRow(key, row));
    return {outcome: 'unknown', row, txHash: tfHash, reason: null, detail: row.failDetail, observedNonce: null};
  }
  if (tfStatus === 0) {
    return fail(row, 'rejected', 'transferFrom reverted on-chain after a successful permit');
  }

  row = {...row, status: 'settled', txHash: tfHash, settledAtMs: nowMs, failDetail: null};
  await saveEvmClaims(key, await replaceRow(key, row));
  return {outcome: 'settled', row, txHash: tfHash, reason: null, detail: null, observedNonce: null};
}

async function replaceRow(key: string, row: EvmClaimRow): Promise<EvmClaimRow[]> {
  const rows = await loadEvmClaims(key);
  const idx = rows.findIndex((r) => r.claim.rid === row.claim.rid);
  if (idx >= 0) rows[idx] = row;
  else rows.push(row);
  return rows;
}

/** The first on-chain Transfer(owner → to, amount) log at/after `fromBlock`, as its tx hash —
 *  the D24.1 idempotent re-entry check ("the money already moved; spend nothing"). */
async function firstMatchingTransfer(
  rpc: EvmRpcLike,
  token: string,
  owner: string,
  to: string,
  amount: bigint,
  fromBlock: number,
): Promise<string | null> {
  const logs = await rpc.ethGetLogs({
    address: token,
    topics: [TRANSFER_EVENT_TOPIC, topicFor(owner), topicFor(to)],
    fromBlock,
    toBlock: 'latest',
  });
  for (const log of logs) {
    if (!log.topics || log.data === undefined) continue;
    const parsed = decodeTransferLog(log.data, log.topics);
    if (parsed && parsed.from === owner && parsed.to === to && parsed.amount === amount) {
      return log.transactionHash ?? null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 6. Payer receipt decision (D25)
// ---------------------------------------------------------------------------

export type EvmPayerOutcome = {outcome: 'success'} | {outcome: 'declined'} | {outcome: 'pending'} | {outcome: 'ignore'};

/** Decide the payer's outcome from a merchant settle receipt. Both bindings must match — `rid`
 *  always, and `expectedTxHash` when the payer has one recorded (the payer never learns the
 *  merchant's hash at hand-off time, so it is optional). Hex is compared lowercase-normalized on
 *  BOTH sides, explicitly and named (unlike SOL's case-sensitive base58, hex case is display
 *  noise). A settled receipt for a different rid/tx is 'ignore'; an unknown status code is honest
 *  pending — never a false decline. */
export function decideEvmPayerReceipt(
  receipt: EvmReceiptV1,
  expectedRid: string,
  expectedTxHash?: string | null,
): EvmPayerOutcome {
  const norm = (s: string) => s.trim().toLowerCase();
  if (!expectedRid || norm(receipt.rid) !== norm(expectedRid)) return {outcome: 'ignore'};
  if (expectedTxHash && norm(receipt.sig) !== norm(expectedTxHash)) return {outcome: 'ignore'};
  if (receipt.status === 0) return {outcome: 'success'};
  if (receipt.status === 1) return {outcome: 'declined'};
  return {outcome: 'pending'};
}
