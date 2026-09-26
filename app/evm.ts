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

// Type-only re-exports: the hooks consume these shapes but must reach the network module only
// through this seam. `export type` is erased, so nothing is pulled into the bundle.
export type {EvmHistory, EvmHistoryRow};
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
 *  fails with the engine-load class instead of hanging the send on a stalled chunk. The
 *  underlying import keeps loading; the RETRY then succeeds without re-fetching. */
export async function loadEvmRpcForSend(
  deadlineMs: number = EVM_RPC_IMPORT_DEADLINE_MS,
  load: () => Promise<typeof import('./evm/service')> = () => import('./evm/service'),
): Promise<typeof import('./evm/service')> {
  preloadEvmRpc();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      rpcPreloadStarted = false; // a timed-out load must be retryable
      reject(new Error(`evm rpc module failed to load within ${deadlineMs}ms (the payment engine chunk never arrived — check the connection to the relay and retry)`));
    }, deadlineMs);
  });
  try {
    return await Promise.race([load(), deadline]);
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
