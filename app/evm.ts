// EVM native device-key rail — the isolation-boundary seam (mirrors `app/solana.ts` line for
// line; the SOL seam's header IS the contract). Statically imports ONLY the PURE modules
// (`evm/identity`, `evm/endpoints`, `evm/errors` + type-only re-exports from the network
// modules — `export type` is erased, so nothing network-shaped enters the bundle). The network
// module `evm/service` is reached via a lazy `await import('./evm/service')` INSIDE the async
// network functions, gated by a non-empty `evmRpcUrl(chainId)` (evm/endpoints.ts — operator
// override > `__DPAY_TEST_EVM_RPC_URL` > the relay-derived per-chain route). With the URL empty
// (jest.setup.js + the e2e driver set it to ''), these functions no-op / throw — so the offline
// inner loop never imports the network module and never touches a chain.
//
// What this seam owns that SOL's does not: the WRONG-CHAIN GUARD (spec 2026-09-26 D10/D12).
// One JSON-RPC upstream serves ONE chain, and the relay multiplexes by chain id
// (`/api/v1/evm/rpc/{chainId}`; the bare route IS chain 1). Before the first spend-shaped
// request of a session the endpoint must PROVE its chain identity (`eth_chainId`) or the send
// refuses LOUDLY (EvmWrongChainError, `evm/errors.ts`) — a wrong-chain balance read is refused
// the same way. The rail itself is the ledger of record; the relay is transport only; dpay
// never holds an EVM key, never pays, and never quotes gas (the wallet is its own gas source —
// the send path's gas honesty gate refuses + instructs, D15).
//
// ============================================================================
// SEND-PATH DEADLINE TABLE (the sendSol table's EVM restatement — every await on the send
// path answers to exactly one deadline and one owner; `evm/service.ts` carries the per-await
// table). The whole-sheet bound is the CALLER's `abortable()` below: a send that outlives its
// deadline REJECTS so the sheet flips to the honest unknown instead of spinning.
//
//   await (send path)                    bound                                owner
//   ──────────────────────────────────  ──────────────────────────────────  ─────────────────────────
//   module load `import('./evm/service')`  EVM_RPC_IMPORT_DEADLINE_MS (10s)  `loadEvmRpcForSend`
//     (the lazy chunk; no signal)          + sheet-mount preload             — races the import,
//                                                                            fails retryable
//   eth_chainId / estimateGas /           per-attempt rpcFetch deadline     `evm/rpc.ts` rpcFetch —
//   gasPrice / balance / nonce            (8s, halving per candidate,         halving under the
//                                           1s floor)                         candidate walk
//   sign (keccak + secp256k1 + RLP)       SYNC — no await                    `signEip1559Tx`
//   eth_sendRawTransaction                per-attempt rpcFetch deadline      `evm/rpc.ts` rpcFetch —
//                                                                            same bytes walk, never
//                                                                            a re-sign (EVM dedups
//                                                                            by tx hash)
//   receipt poll                          EVM_RECEIPT_TIMEOUT_MS (60s),      `evm/service.ts`
//                                           poll 1.5s, signal-checked          pollEvmReceiptIn
//                                           sleep; timeout = honest unknown
//   the WHOLE sheet submit                the sheet's signal + `abortable`   the caller (below)
// ============================================================================

import {
  EVM_RPC_IMPORT_DEADLINE_MS,
  evmRpcUrl,
  evmRpcUrls,
  EVM_RPC_PROXY_PATH,
  EVM_RPC_STORAGE_KEY,
  setEvmRpcUrl as setEvmRpcUrlOverride,
} from './evm/endpoints';
import {deriveEvmKeypair} from './evm/identity';
import {EVM_CHAINS, setEvmCatalogDeployment, type EvmChainId} from './evm/chains';
import {engineLoadCopy} from './transportFailure';
import {
  isEvmEndpointRefusal,
  isEvmGasGateError,
  isEvmRelayPathDown,
  isEvmWrongChainError,
  type EvmReadFailure,
} from './evm/errors';
import type {EvmHistory, EvmHistoryRow} from './evm/history';
import type {
  EvmBalancesRead,
  EvmFeeQuote,
  EvmGasBalanceResult,
  EvmKey,
  EvmReceiptStatus,
  EvmSendInput,
  EvmTokenBalanceResult,
} from './evm/service';
import {
  decodeEvmPay,
  decodeEvmReq,
  encodeEvmPay,
  encodeEvmReq,
  EVM_REQ_WINDOW_SECONDS,
  generateRid,
  isEvmReqExpired,
  type EvmPayV1,
  type EvmReceiptV1,
  type EvmReqV1,
} from './evm/qr';
import {
  decideEvmPayerReceipt,
  enqueueEvmClaim,
  evmClaimsKey,
  loadEvmClaims,
  patchEvmClaim,
  resetEvmNonce,
  resolveEvmTokenAddress,
  saveEvmClaims,
  signEvmClaim,
  takeEvmNonce,
  MAX_CLAIM_ATTEMPTS,
  MAX_EVM_CLAIMS,
  type EvmClaimRow,
  type EvmSettleResult,
  type EvmSignedClaim,
} from './evm/claims';

// Type-only re-exports: the hooks consume these shapes but must reach the network module only
// through this seam. `export type` is erased, so nothing is pulled into the bundle.
export type {EvmHistory, EvmHistoryRow};
import type {UniswapQuote, UniswapSwapPlan} from './evm/uniswapPlan';
export type {UniswapQuote, UniswapSwapPlan};
export type {CowQuote} from './evm/cow';
export type {CowOrderParams, CowOrderStatusBody, SignedCowOrder} from './evm/cowPlan';
export type {
  EvmBalancesRead,
  EvmFeeQuote,
  EvmGasBalanceResult,
  EvmKey,
  EvmReceiptStatus,
  EvmSendInput,
  EvmTokenBalanceResult,
};
export {EVM_LOG_PAGE_SIZE, EVM_HISTORY_MAX_ROWS} from './evm/constants';
export {
  isEvmEndpointRefusal,
  isEvmGasGateError,
  isEvmRelayPathDown,
  isEvmWrongChainError,
};
export type {EvmReadFailure};

/** The device's EVM address: m/44'/60'/0'/0/0 over the SAME `Identity.secretHex` every other
 *  rail derives from — one seed, one backup, every rail. The address is a function of the key,
 *  NOT of the chain: the SAME address on Ethereum, Arbitrum One, and every other EVM chain. */
export function deriveEvmAddress(secretHex: string): string {
  return deriveEvmKeypair(secretHex).address;
}

/** Well-formedness only (0x + 40 hex) — never existence, never checksum (a checksummed paste
 *  is verified separately by `eip55ChecksumBad`, lib/eip55.ts; an all-lower/upper address is
 *  legal EVM with no checksum to check). The `isValidSolanaAddress` decode-the-answer
 *  discipline. */
export function isValidEvmAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

export {evmRpcUrl, evmRpcUrls, EVM_RPC_PROXY_PATH, EVM_RPC_STORAGE_KEY};
/** Re-point the operator EVM endpoint override (per DEVICE, all chains). `''` clears. Throws on
 *  a non-URL or a plain-http PUBLIC host (local http — anvil — is accepted). See
 *  `evm/endpoints.ts`. */
export function setEvmRpcUrl(url: string): void {
  setEvmRpcUrlOverride(url);
}

/** Whether the EVM rail is configured for `chainId` (endpoint URL non-empty). A pure sync read
 *  — independent of relay `online` (plan invariant #9). The wrong-chain sense (the endpoint
 *  serves a different chain) is the separate eth_chainId gate, checked live before any spend. */
export function isEvmRpcAvailable(chainId: number): boolean {
  return evmRpcUrl(chainId) !== '';
}

/** Whether ANY known chain has an endpoint — the preload gate (the SOL rail has one URL, so
 *  its gate reads that one; the EVM rail is per-chain). */
function evmRailConfigured(): boolean {
  return [1, 42161, 421614, 31337].some((chainId) => evmRpcUrl(chainId) !== '');
}

/** One warn line in the money-log's own dialect (console.warn is the transport the on-device
 *  log mirror captures — never a services import from this seam). */
function traceSend(msg: string): void {
  console.warn(`money: evm send ${msg}`);
}

let rpcPreloadStarted = false;

/** Warm the network module OFF the money path (the `preloadSolanaRpc` mirror): fired when the
 *  send sheet mounts, so the click-time import in `loadEvmRpcForSend` resolves instantly. A
 *  no-op when the rail is off (the jest/e2e isolation contract) and when a preload already
 *  started. A failed warm stays retryable. */
export function preloadEvmRpc(): void {
  if (rpcPreloadStarted || !evmRailConfigured()) return;
  rpcPreloadStarted = true;
  void import('./evm/service').catch(() => {
    rpcPreloadStarted = false;
  });
}

/** The bounded module load for every MONEY path that awaits the network module (the
 *  `loadRpcForSend` mirror, 10s bound): races the import against EVM_RPC_IMPORT_DEADLINE_MS and
 *  fails with the CLASSIFIED engine copy (`engineLoadCopy` in `app/transportFailure.ts` →
 *  `M.errors.engine.*`) instead of hanging the send on a stalled chunk — never a flat "check
 *  your connection" to a phone whose connection is fine (work order 2026-09-30). A fast import
 *  failure (a broken/stale chunk on the origin) is the same user fact and classifies the same
 *  way. The underlying import keeps loading; the RETRY then succeeds without re-fetching. */
export async function loadEvmRpcForSend(
  deadlineMs: number = EVM_RPC_IMPORT_DEADLINE_MS,
  load: () => Promise<typeof import('./evm/service')> = () => import('./evm/service'),
): Promise<typeof import('./evm/service')> {
  preloadEvmRpc();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      rpcPreloadStarted = false; // a timed-out load must be retryable
      reject(new Error(`evm rpc module failed to load within ${deadlineMs}ms (the engine chunk never arrived)`));
    }, deadlineMs);
  });
  try {
    return await Promise.race([load(), deadline]);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const copy = await engineLoadCopy(raw);
    if (copy != null) {
      console.warn(`money: evm send loadEvmRpcForSend — the engine chunk never arrived: ${raw}`);
      throw new Error(copy);
    }
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The send seam's deadline GUARANTEE (the `abortable` helper verbatim): the returned promise
 *  settles the moment `signal` aborts, even if the underlying work never does — a send that
 *  outlives its deadline REJECTS into the honest-unknown state instead of spinning forever. */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined, what: string): Promise<T> {
  if (signal === undefined) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(`${what} aborted (deadline)`));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, {once: true});
    p.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** The per-token balance result states. NO 'absent' arm (the D10 note): an EVM balanceOf
 *  answers 0 for any address — measured behavior, unlike SOL's null token account. */

/**
 * One poll for every visible EVM row (D16's read half): one `eth_getBalance` per chain (gas
 * honesty even at zero tokens) + one `eth_call balanceOf` per token row. Answers 'offline' for
 * every key WITHOUT importing the network module when the rail is off for all of the keys'
 * chains — the same offline contract as `readSolanaBalances`. Chains run in parallel; per-key
 * failures carry the classified `EvmReadFailure`.
 */
export async function readEvmBalances(secretHex: string, keys: readonly EvmKey[], signal?: AbortSignal): Promise<EvmBalancesRead> {
  if (keys.every((k) => evmRpcUrl(k.chainId) === '')) {
    const offlineToken = {kind: 'offline'} as const;
    const gas: Record<number, EvmGasBalanceResult> = {};
    const tokens: Record<string, EvmTokenBalanceResult> = {};
    for (const k of keys) {
      gas[k.chainId] = {kind: 'offline'};
      tokens[`${k.chainId}:${k.token}`] = offlineToken;
    }
    return {gas, tokens};
  }
  const {readEvmBalances: read} = await import('./evm/service');
  return read(secretHex, keys, signal);
}

/** The EVM history read's honest states — the same discriminated-union contract as the SOL
 *  rail: 'offline' is the rail being OFF (not an error), 'history' is a read fact, 'error'
 *  carries WHY (classified HERE at the seam, never guessed at the component). An ABORTED
 *  signal rethrows untouched (a caller's cancellation is not a rail fact). */
export type EvmHistoryResult =
  | {kind: 'offline'}
  | {kind: 'history'; rows: readonly EvmHistoryRow[]; dropped: number}
  | {kind: 'error'; failure: EvmReadFailure};

/** Recent Transfer movements of `tokenAddress` for `address` on `chainId`, newest-first
 *  (`eth_getLogs` Transfer-topic paging — `evm/history.ts`). Offline → `{kind:'offline'}` with
 *  no fetch and no dynamic import. */
export async function getEvmHistory(
  chainId: number,
  address: string,
  tokenAddress: string,
  signal?: AbortSignal,
): Promise<EvmHistoryResult> {
  if (evmRpcUrl(chainId) === '') return {kind: 'offline'};
  const {fetchEvmHistory} = await import('./evm/history');
  try {
    const history: EvmHistory = await fetchEvmHistory(evmRpcUrls(chainId), chainId, address, tokenAddress, {signal});
    return {kind: 'history', rows: history.rows, dropped: history.dropped};
  } catch (e) {
    if (signal?.aborted) throw e;
    const failure: EvmReadFailure = isEvmRelayPathDown(e)
      ? 'unreachable'
      : isEvmEndpointRefusal(e)
        ? 'refused'
        : await classifyEvmTransport();
    console.warn(`getEvmHistory: ${failure} for ${address} on chain ${chainId}:`, e instanceof Error ? e.message : String(e));
    return {kind: 'error', failure};
  }
}

// The offline/unreachable oracle lives in the network module (it is the same IC-boundary probe
// the SOL seam owns) — reached through the dynamically-imported service so the offline loop
// never loads it before it is needed.
async function classifyEvmTransport(): Promise<'unreachable' | 'offline'> {
  const {classifyEvmTransportFailure} = await import('./evm/service');
  return classifyEvmTransportFailure();
}

/** The chain's own fee arithmetic over the caller's typed inputs (D15.2 — dpay never quotes;
 *  this IS the chain's estimateGas + gasPrice). Runs the wrong-chain gate. Throws when the
 *  rail is off. */
export async function quoteEvmFee(
  chainId: number,
  from: string,
  to: string,
  data: string,
  signal?: AbortSignal,
): Promise<EvmFeeQuote> {
  if (evmRpcUrl(chainId) === '') throw new Error(`EVM is not configured on this device (chain ${chainId})`);
  const {quoteEvmFee: quote} = await import('./evm/service');
  return quote(chainId, from, to, data, signal);
}

/**
 * Build, sign, broadcast, and confirm an ERC-20 transfer (D15). Gate order — wrong-chain guard
 * → fee probe → GAS HONESTY GATE (refuses with `EvmGasGateError` carrying the fee, the
 * payer's balance, the chain and the payer's own 0x address to receive gas at) → sign →
 * broadcast → receipt poll. `onBroadcast` fires the moment the network ACCEPTS the tx, before
 * confirmation. Throws when the rail is off, on any gate, or into the honest unknown on a
 * confirm timeout. The whole call answers to the caller's `signal` (the abortable contract).
 */
export async function sendErc20(
  secretHex: string,
  input: EvmSendInput,
  signal?: AbortSignal,
  onBroadcast?: (txHash: string) => void,
): Promise<{txHash: string}> {
  if (evmRpcUrl(input.chainId) === '') throw new Error(`EVM is not configured on this device (chain ${input.chainId})`);
  return abortable((async () => {
    let step = 'module-load';
    // Step-ENTRY tracing: a STALL never reaches the catch below, so the last traced line is
    // the only witness to which await hung (the sendSol audit's lesson, restated).
    const at = (s: string) => { step = s; traceSend(`step ${s}`); };
    traceSend(`erc20(${input.tokenAddress}) start to=${input.to} amount=${input.rawAmount} chain=${input.chainId}`);
    try {
      const service = await loadEvmRpcForSend();
      at('wrong-chain-gate');
      const {txHash} = await service.sendErc20(secretHex, input, signal, (h) => {
        traceSend(`BROADCAST accepted hash=${h}`);
        onBroadcast?.(h);
      });
      traceSend(`confirmed hash=${txHash}`);
      return {txHash};
    } catch (e: unknown) {
      traceSend(`FAILED at step=${step}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  })(), signal, 'evm send');
}

/** The chain's verdict on an already-broadcast tx hash — null means the node has never heard
 *  of it ('pending' at the seam's `getEvmReceiptStatus`). Reading is safe to repeat: nothing
 *  here signs or moves anything. Throws when the rail is off (a hash can only exist because a
 *  broadcast succeeded — an RPC that has since gone missing is a state to retry, never a
 *  silent "not found"). */
export async function getEvmReceiptStatus(chainId: number, txHash: string, signal?: AbortSignal): Promise<EvmReceiptStatus> {
  if (evmRpcUrl(chainId) === '') throw new Error(`EVM is not configured on this device (chain ${chainId})`);
  const {getEvmReceiptStatus: get} = await import('./evm/service');
  return get(chainId, txHash, signal);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The offline permit-claim rail (D21-D25) — the PURE engine (`evm/qr` + `evm/claims`) is
// statically imported (it touches no network; its only side channel is AsyncStorage), the
// settle/nonce-seed/read paths reach the chain through the dynamically-imported `evm/settle`
// adapter (EvmRpcLike over ./rpc — see that module's header for the mapping contract).
// ═════════════════════════════════════════════════════════════════════════════════════════════

export {
  decodeEvmPay,
  decodeEvmReq,
  encodeEvmPay,
  encodeEvmReq,
  EVM_REQ_WINDOW_SECONDS,
  generateRid,
  isEvmReqExpired,
  decideEvmPayerReceipt,
  enqueueEvmClaim,
  evmClaimsKey,
  loadEvmClaims,
  patchEvmClaim,
  resetEvmNonce,
  resolveEvmTokenAddress,
  saveEvmClaims,
  MAX_CLAIM_ATTEMPTS,
  MAX_EVM_CLAIMS,
};
export type {EvmPayV1, EvmReceiptV1, EvmReqV1, EvmClaimRow, EvmSignedClaim, EvmSettleResult};

export interface EvmPaymentRequestInput {
  readonly chainId: number;
  /** Registry token symbol ('ZCHF' — the only deployment that ships). */
  readonly token: string;
  /** The merchant's 0x address (this device's own address). */
  readonly to: string;
  /** Raw smallest units (decimal-digit string) — the UI converts the typed display amount. */
  readonly amt: string;
  /** Merchant display name ("" ok) — bounded by the codec. */
  readonly name?: string;
  /** Optional note ("" ok) — bounded by the codec. */
  readonly memo?: string;
  /** Test seams: now (unix secs) and the request window (≤ the codec's 600s cap). */
  readonly nowSecs?: number;
  readonly ttlSecs?: number;
}

/** Mint an `evmreq:v1` payment request — PURE and fully OFFLINE (D21: no chain read — there is
 *  no blockhash analog to fetch). Fresh rid, `iat` = now, `exp` = now + the window (clamped to
 *  the codec's 600s cap). Refuses at the door when the registry has no deployment of `token`
 *  on `chainId` (such a request could never be signed or settled). */
export function createEvmPaymentRequest(input: EvmPaymentRequestInput): {req: EvmReqV1; uri: string} {
  if (resolveEvmTokenAddress(input.chainId, input.token) === null) {
    throw new Error(`evm request: no ${input.token} deployment on chain ${input.chainId}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.to)) throw new Error('evm request: the merchant address is not a 0x address');
  if (!/^\d+$/.test(input.amt) || BigInt(input.amt) === 0n) throw new Error('evm request: the amount must be a positive raw-unit integer');
  const iat = input.nowSecs ?? Math.floor(Date.now() / 1000);
  const ttl = Math.max(1, Math.min(input.ttlSecs ?? EVM_REQ_WINDOW_SECONDS, EVM_REQ_WINDOW_SECONDS));
  const req: EvmReqV1 = {
    v: 1,
    rid: generateRid(),
    chainId: input.chainId,
    token: input.token,
    to: input.to,
    amt: input.amt,
    iat,
    exp: iat + ttl,
    name: input.name ?? '',
    memo: input.memo ?? '',
  };
  return {req, uri: encodeEvmReq(req)};
}

/**
 * Sign an EIP-2612 permit claim for a decoded request — the payer's OFFLINE act (D22). The
 * permit nonce comes from the device's cache (`takeEvmNonce`: consume + optimistic bump, both
 * durable before the QR shows) and the request must still be inside its expiry window. The
 * only await is AsyncStorage — no network module is loaded, no fetch fires. A stale cached
 * nonce is NOT caught here (the payer is offline by definition): the merchant's settle
 * classifies it as `needs-resign` and `resetEvmNonce` re-seeds the true value for the re-sign.
 */
export async function signEvmPermitClaim(secretHex: string, req: EvmReqV1): Promise<EvmSignedClaim> {
  if (isEvmReqExpired(req)) throw new Error('This payment request has expired — ask for a fresh QR code.');
  if (resolveEvmTokenAddress(req.chainId, req.token) === null) {
    throw new Error(`evm claim: no ${req.token} deployment on chain ${req.chainId}`);
  }
  const keypair = deriveEvmKeypair(secretHex);
  const nonce = await takeEvmNonce(keypair.address, req.chainId, req.token);
  return signEvmClaim(keypair.privateKey, req, nonce);
}

/**
 * Merchant settle (D24) — permit() then transferFrom(), gas from the merchant's own ETH, the
 * queue keyed by the device's EVM address, the token resolved from the registry, the
 * wrong-chain gate first. Honest outcomes only: `settled` (the winning tx hash), `needs-resign`
 * (stale permit nonce — a STATE; re-sign the same rid fresh), `failed` (typed reason), and
 * `unknown` (a broadcast whose receipt never confirmed — the tx MAY land; the row keeps the
 * hash for reconciliation).
 */
export async function settleEvmClaim(
  secretHex: string,
  req: EvmReqV1,
  claim: EvmPayV1,
  signal?: AbortSignal,
): Promise<EvmSettleResult> {
  if (evmRpcUrl(req.chainId) === '') throw new Error(`EVM is not configured on this device (chain ${req.chainId})`);
  const {settleEvmClaimForDevice} = await import('./evm/settle');
  return settleEvmClaimForDevice(secretHex, req, claim, signal);
}

/** Seed the permit-nonce cache from the chain for the visible EVM rows (D22.1 — the balance
 *  poll's every-5th-tick piggyback). Best-effort per key; offline/no-op when the rail is off. */
export async function seedEvmPermitNonces(secretHex: string, keys: readonly EvmKey[]): Promise<void> {
  if (keys.every((k) => evmRpcUrl(k.chainId) === '')) return;
  const {seedEvmNoncesFromChain} = await import('./evm/settle');
  return seedEvmNoncesFromChain(secretHex, keys);
}

/** Read-only payer-side check: did a handed-off claim's Transfer already land? Returns the tx
 *  hash, or null (nothing yet). Throws when the rail is off. */
export async function findEvmSettledTransfer(
  chainId: number,
  tokenAddress: string,
  owner: string,
  to: string,
  rawAmount: string,
  fromBlock?: number,
  signal?: AbortSignal,
): Promise<string | null> {
  if (evmRpcUrl(chainId) === '') throw new Error(`EVM is not configured on this device (chain ${chainId})`);
  const {findEvmSettledTransfer: find} = await import('./evm/settle');
  return find(chainId, tokenAddress, owner, to, rawAmount, fromBlock, signal);
}

/** Sync the registry with the CATALOG's evm rows (D3/D6): a served ZCHF row on a chain the
 *  pinned registry does not know (the env-gated Anvil dev row) IS the deployment — install it so
 *  requests, permit domains and settles resolve the token the user actually selected. The mainnet
 *  pins always win for their own chains. Called from the Wallet on every catalog change. */
export function syncEvmCatalogDeployments(rows: ReadonlyArray<{chainId: number; token: string; address: string}>): void {
  for (const row of rows) {
    if (row.token !== 'ZCHF') continue;
    if (resolveEvmTokenAddress(row.chainId, row.token) !== null) continue; // pinned (or already synced)
    if (EVM_CHAINS[row.chainId as EvmChainId] === undefined) continue; // unknown chain — never invent
    setEvmCatalogDeployment(row.chainId as EvmChainId, row.address);
  }
}

/** Whether ANY known EVM chain has an endpoint configured — the rail-visibility gate the
 *  Wallet passes as `buildSelectableAssets`' `evmEnabled` (the solanaEnabled precedent: the
 *  rail does not render under jest/e2e until a seam URL is configured — D11). */
export function isEvmRailConfigured(): boolean {
  return evmRailConfigured();
}

// ── The Uniswap V3 convert surface (the any-pair mandate, 2026-09-28) ──────────────────────────
// Same seam discipline as every function above: gated on the rail being configured, the
// network module loaded lazily, the caller's signal honored end to end. The quote is the
// venue's own number (QuoterV2 through the relay pipe, the best fee tier's answer); the
// executor carries the gas-honesty gate (the whole sequence's worst case checked before any
// signature) and sequential nonces with per-leg receipts (the D31 discipline).

/** The venue's own quote for one EVM pair across the Uniswap V3 fee tiers. */
export async function quoteUniswapSwap(
  args: Parameters<typeof import('./evm/uniswap')['quoteUniswap']>[0],
  signal?: AbortSignal,
): Promise<UniswapQuote> {
  if (evmRpcUrl(args.chainId) === '') throw new Error(`EVM is not configured on this device (chain ${args.chainId})`);
  const {quoteUniswap} = await import('./evm/uniswap');
  return quoteUniswap(args, signal);
}

/** The sequence's aggregate worst-case fee, before anything is signed (the review's
 *  "network fee (estimate)" line and prepare's own dry gate). */
export async function estimateUniswapSequenceFee(
  secretHex: string,
  args: {chainId: number; plan: UniswapSwapPlan},
  signal?: AbortSignal,
): Promise<{maxFeeWei: string}> {
  if (evmRpcUrl(args.chainId) === '') throw new Error(`EVM is not configured on this device (chain ${args.chainId})`);
  const {estimateSequenceFee} = await import('./evm/uniswap');
  return estimateSequenceFee(secretHex, args, signal);
}

/** Execute the frozen plan: gate → per-leg sign/broadcast/receipt. `onBroadcast` fires per
 *  accepted leg (the record's durable hash list). */
export async function executeUniswapSequence(
  secretHex: string,
  args: {chainId: number; plan: UniswapSwapPlan},
  signal?: AbortSignal,
  onBroadcast?: (step: {label: string; txHash: string}) => void,
): Promise<{steps: Array<{label: string; txHash: string}>}> {
  if (evmRpcUrl(args.chainId) === '') throw new Error(`EVM is not configured on this device (chain ${args.chainId})`);
  const {executeUniswapSequence: run} = await import('./evm/uniswap');
  return run(secretHex, args, signal, onBroadcast as Parameters<typeof run>[3]);
}

/** One raw EVM balance read for the convert surface's realized-credit line (token or native). */
export async function readEvmRailBalance(
  chainId: number,
  secretHex: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<string | null> {
  if (evmRpcUrl(chainId) === '') return null;
  const {readEvmTokenRaw, readEvmNativeRaw} = await import('./evm/uniswap');
  const owner = deriveEvmAddress(secretHex);
  return token != null ? readEvmTokenRaw(chainId, token, owner, signal) : readEvmNativeRaw(chainId, owner, signal);
}

// ── The CoW Swap family (the SECOND EVM venue, 2026-10-03) — same seam discipline: gated
// on the rail being configured, the network module loaded lazily, the caller's signal
// honored end to end. The order API rides dpay's relay pipes (`/api/v1/cow/mainnet/*`),
// never the device; the chain legs walk the EVM RPC pipe like every other read.

/** The venue's own quote for one EVM pair (the venue's figures verbatim; the WETH rule for
 *  a native destination matches the V3 adapter's). The CowQuote rides with `amountOut`
 *  carrying its `buyAmount` - the sheet's display math reads one field name across both
 *  venue families, the venue's own figure either way. */
export async function quoteCowSwap(
  args: Omit<Parameters<typeof import('./evm/cow')['quoteCow']>[0], 'secretHex'> & {secretHex: string},
  signal?: AbortSignal,
): Promise<import('./evm/cow').CowQuote & {amountOut: string}> {
  if (evmRpcUrl(args.chainId) === '') throw new Error(`EVM is not configured on this device (chain ${args.chainId})`);
  const {quoteCow} = await import('./evm/cow');
  const q = await quoteCow(args, signal);
  return {...q, amountOut: q.buyAmount};
}

/** The chain legs' (approve + native-out unwrap) aggregate worst-case fee, before anything
 *  is signed — the review's fee line and prepare's dry gate. */
export async function estimateCowSequenceFee(
  secretHex: string,
  args: Parameters<typeof import('./evm/cow')['estimateCowSequenceFee']>[1],
  signal?: AbortSignal,
): Promise<{maxFeeWei: string}> {
  if (evmRpcUrl(args.chainId) === '') throw new Error(`EVM is not configured on this device (chain ${args.chainId})`);
  const {estimateCowSequenceFee: run} = await import('./evm/cow');
  return run(secretHex, args, signal);
}

/** The full CoW sequence: approve → sign+submit → per-drive poll, milestones handed back
 *  for the record to freeze (approveTxHash, uid). Terminal outcomes return; a still-open
 *  order returns null (the engine re-arms). */
export async function driveCowSequence(
  secretHex: string,
  args: Parameters<typeof import('./evm/cow')['driveCowSequence']>[1],
  signal?: AbortSignal,
  onProgress?: Parameters<typeof import('./evm/cow')['driveCowSequence']>[3],
): Promise<ReturnType<typeof import('./evm/cow')['driveCowSequence']>> {
  if (evmRpcUrl(args.chainId) === '') throw new Error(`EVM is not configured on this device (chain ${args.chainId})`);
  const {driveCowSequence: run} = await import('./evm/cow');
  return run(secretHex, args, signal, onProgress as Parameters<typeof run>[3]);
}

/** The post-fulfillment unwrap: the settlement's WETH credit withdrawn to native. */
export async function unwrapCowWeth(
  secretHex: string,
  args: {chainId: number; amount: bigint},
  signal?: AbortSignal,
): Promise<string> {
  if (evmRpcUrl(args.chainId) === '') throw new Error(`EVM is not configured on this device (chain ${args.chainId})`);
  const {unwrapCowWeth: run} = await import('./evm/cow');
  return run(secretHex, args, signal);
}
