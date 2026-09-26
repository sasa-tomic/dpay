// The EVM rail's money-path services: balance reads, the fee quote, the ERC-20 send flow, and
// the receipt poll. NETWORK module — reached ONLY through the seam `app/evm.ts` (dynamic
// import, gated on a non-empty `evmRpcUrl(chainId)`), which is what keeps the offline inner
// loop from ever loading it (or `./rpc`, which this module imports statically). The send-path
// deadline table from the seam's header applies to every await here:
//
//   await (send path)                    bound                                   owner
//   ──────────────────────────────────  ──────────────────────────────────────  ─────────────────────────────
//   eth_chainId (wrong-chain gate)       per-call rpcFetch deadline (8s)         ./rpc rpcFetch
//   eth_estimateGas / eth_gasPrice       per-call rpcFetch deadline              ./rpc rpcFetch
//   eth_getBalance (gas gate)            per-call rpcFetch deadline              ./rpc rpcFetch
//   eth_getTransactionCount              per-call rpcFetch deadline              ./rpc rpcFetch
//   sign (secp256k1, keccak, RLP)        SYNC — no await                         signEip1559Tx
//   eth_sendRawTransaction               per-call rpcFetch deadline              ./rpc rpcFetch
//   receipt poll                         EVM_RECEIPT_TIMEOUT_MS (60s),           pollEvmReceipt (below)
//                                          poll 1.5s, signal-checked sleep
//   the WHOLE send                       the caller's abortable() signal         the seam (app/evm.ts)
//
// # The wrong-chain guard (D10/D12) — THE money-safety gate of this rail
//
// ONE JSON-RPC upstream serves ONE chain; a 31337 envelope answered by a chain-1 node is a
// wrong-ledger answer, not a degraded mode. So before the FIRST spend-shaped request against an
// endpoint the wallet asks it `eth_chainId` and refuses a mismatch LOUDLY (EvmWrongChainError,
// naming both chains). The verdict is memoized per ENDPOINT LIST for the session (a chain's
// identity does not move; the relay caches the read for an hour) and never cached on failure —
// a failed check re-asks. SENDS gate on it, and so do BALANCE reads: a wrong-chain balanceOf
// would render the wrong ledger's number as this asset's balance, which is the same money
// danger one screen earlier. The gate runs before EVERY send regardless of the memo (one
// memoized read serving many sends is the point; skipping the check is not an option).

import {deriveEvmKeypair} from './identity';
import {encodeBalanceOf, encodeTransfer, decodeUint256} from './abi';
import {toBaseUnits, EVM_CHAINS} from './chains';
import {signEip1559Tx, toHex0x} from './tx';
import {
  EvmGasGateError,
  EvmWrongChainError,
  isEvmEndpointRefusal,
  isEvmRelayPathDown,
  type EvmReadFailure,
} from './errors';
import {
  ethCall,
  ethChainId,
  ethEstimateGas,
  ethGasPrice,
  ethGetBalance,
  ethGetTransactionCount,
  ethGetTransactionReceipt,
  ethMaxPriorityFeePerGas,
  ethSendRawTransaction,
  rpcSleep,
  type EvmReceipt,
} from './rpc';
import {evmRpcUrl, evmRpcUrls} from './endpoints';
import {icGatewayUrl} from '../config/constants';

// ── The wrong-chain memo ───────────────────────────────────────────────────────────────────────
// Keyed by the FULL candidate list (an override change or a relay re-point is a different
// endpoint asking a different question). Value = the chain the endpoint PROVED it serves.
const chainVerified = new Map<string, number>();

/** Parse a 0x-hex quantity ("0x7a69") — throws on anything else (the endpoint's bytes are the
 *  problem, and a misread chain id must fail loud, never coerce). */
function hexToNumber(hex: string, what: string): number {
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error(`evm: ${what} answered "${hex.slice(0, 40)}" where 0x-hex was expected`);
  const n = Number(BigInt(hex));
  if (!Number.isSafeInteger(n)) throw new Error(`evm: ${what} answered ${hex.slice(0, 40)} — out of range`);
  return n;
}

/**
 * Prove the endpoint serves `chainId` before anything is spent or shown from it. Throws
 * `EvmWrongChainError` on a mismatch (LOUD, names both chains — D10/D12). Memoized per
 * endpoint list for the session; a failed verification is never memoized.
 */
export async function ensureChain(chainId: number, urls: readonly string[], signal?: AbortSignal): Promise<void> {
  const key = urls.join('\n');
  if (chainVerified.get(key) === chainId) return;
  const answered = hexToNumber(await ethChainId(urls, {signal}), 'eth_chainId');
  chainVerified.set(key, answered);
  if (answered !== chainId) {
    throw new EvmWrongChainError(chainId, answered);
  }
}

// ── The offline/unreachable oracle ─────────────────────────────────────────────────────────────
// The SOL rail's R3 distinction, EVM twin: a transport failure on the EVM path proves only that
// NOTHING answered there. To tell "no connectivity" from "the rail is down while the phone is
// online", the seam asks a host deliberately OFF that path — the IC boundary (icGatewayUrl(),
// the wallet's other value rail, which never touches the EVM path). ANY HTTP answer proves the
// phone is online → 'unreachable'; no answer anywhere → 'offline'. The relay itself CANNOT be
// the reference host: the EVM path IS the relay, so a relay outage would fail both the read and
// the probe and collapse 'unreachable' into 'offline'. Checked per call, in order: the test
// override (hermetic jest), navigator.onLine === false (free web signal, absent on RN), then
// the probe, deduped per probe URL for 10s (a failing 2.5s poll must not fire a probe per tick).

const CONNECTIVITY_PROBE_MS = 2500;
const CONNECTIVITY_PROBE_TTL_MS = 10000;
let connectivityMemo: {probeUrl: string; at: number; result: 'unreachable' | 'offline'} | null = null;

export async function classifyEvmTransportFailure(): Promise<'unreachable' | 'offline'> {
  const override =
    (globalThis as unknown as {__DPAY_TEST_EVM_CONNECTIVITY?: 'offline' | 'online'}).__DPAY_TEST_EVM_CONNECTIVITY;
  if (override === 'offline') return 'offline';
  if (override === 'online') return 'unreachable';
  const nav = (globalThis as unknown as {navigator?: {onLine?: boolean}}).navigator;
  if (nav?.onLine === false) return 'offline';
  const probeUrl = icGatewayUrl();
  if (connectivityMemo != null && connectivityMemo.probeUrl === probeUrl
      && Date.now() - connectivityMemo.at < CONNECTIVITY_PROBE_TTL_MS) {
    return connectivityMemo.result;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONNECTIVITY_PROBE_MS);
  let result: 'unreachable' | 'offline';
  try {
    await fetch(probeUrl, {method: 'HEAD', signal: ctrl.signal});
    result = 'unreachable';
  } catch {
    result = 'offline';
  } finally {
    clearTimeout(timer);
  }
  connectivityMemo = {probeUrl, at: Date.now(), result};
  return result;
}

/** The read-failure classification, applied once per error (the seam's taxonomy): the relay's
 *  own marker maps straight to 'unreachable' (it answered HTTP — the phone is online; no
 *  probe), then the endpoint-refusal brand, then the offline/unreachable oracle. */
export async function classifyEvmReadFailure(e: unknown, signal?: AbortSignal): Promise<EvmReadFailure> {
  if (isEvmRelayPathDown(e)) return 'unreachable';
  if (isEvmEndpointRefusal(e)) return 'refused';
  if (signal?.aborted) return 'refused'; // unreachable: callers rethrow aborted signals first
  return classifyEvmTransportFailure();
}

// ── Balances (D10/D16 app half) ────────────────────────────────────────────────────────────────

/** One visible EVM token row to poll — the `visibleEvmKeys()` tuple (lib/evmCatalog.ts), so the
 *  rendered rows and the polled set can never drift (the SOL helper's invariant). */
export interface EvmKey {
  readonly chainId: number;
  readonly token: string;
  readonly tokenAddress: string;
  readonly decimals: number;
}

export type EvmGasBalanceResult =
  | {kind: 'offline'}
  | {kind: 'balance'; wei: string}
  | {kind: 'error'; failure: EvmReadFailure};

export type EvmTokenBalanceResult =
  | {kind: 'offline'}
  | {kind: 'balance'; amount: string}
  | {kind: 'error'; failure: EvmReadFailure};

export type EvmBalancesRead = {
  /** Per-chain NATIVE (gas) balance, keyed by chainId — gas honesty needs it even at zero
   *  tokens (D19). */
  gas: Record<number, EvmGasBalanceResult>;
  /** Per-token balance, keyed `${chainId}:${token}` — the asset id's own two stable halves. */
  tokens: Record<string, EvmTokenBalanceResult>;
};

/**
 * One poll for every visible EVM row: one `eth_getBalance` per CHAIN (gas leg) + one
 * `eth_call balanceOf` per token row, chains in PARALLEL (independent ledgers — one chain
 * failing must not blank another). No 'absent' arm anywhere (the D10 note): an EVM balanceOf
 * answers 0 for any address — measured behavior, unlike SOL's null account. Amounts are exact
 * raw decimal STRINGS, never through JS number.
 *
 * The wrong-chain gate runs per configured chain BEFORE its reads; a mismatch fails that
 * chain's whole leg as 'refused' — the endpoint is answering and the answer would be from the
 * wrong ledger, which is exactly the 'refused' shape ("this device is online and the rail is
 * what is broken").
 */
export async function readEvmBalances(secretHex: string, keys: readonly EvmKey[], signal?: AbortSignal): Promise<EvmBalancesRead> {
  const gas: Record<number, EvmGasBalanceResult> = {};
  const tokens: Record<string, EvmTokenBalanceResult> = {};
  const address = deriveEvmKeypair(secretHex).address;

  // Off-rail chains (empty URL for that chain — jest/e2e default) answer 'offline' with no
  // fetch and no dynamic work.
  const byChain = new Map<number, EvmKey[]>();
  const offlineChains = new Set<number>();
  for (const key of keys) {
    if (evmRpcUrl(key.chainId) === '') {
      offlineChains.add(key.chainId);
      tokens[`${key.chainId}:${key.token}`] = {kind: 'offline'};
      continue;
    }
    const list = byChain.get(key.chainId) ?? [];
    list.push(key);
    byChain.set(key.chainId, list);
  }
  for (const chainId of offlineChains) gas[chainId] = {kind: 'offline'};
  if (byChain.size === 0) return {gas, tokens};

  await Promise.all([...byChain.entries()].map(async ([chainId, list]) => {
    const urls = evmRpcUrls(chainId);
    const fail = (e: unknown): Promise<EvmReadFailure> => classifyEvmReadFailure(e, signal);
    try {
      await ensureChain(chainId, urls, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      // A wrong-chain answer is a refusal by the endpoint (the branded error carries both
      // brands); everything else classifies like any read failure.
      const failure = await fail(e);
      gas[chainId] = {kind: 'error', failure};
      for (const key of list) tokens[`${chainId}:${key.token}`] = {kind: 'error', failure};
      return;
    }
    const [gasRes, ...tokenRes] = await Promise.all([
      ethGetBalance(urls, address, {signal}).then(
        // Wei as an exact DECIMAL string (amounts are strings app-wide; never through JS number).
        (wei) => ({kind: 'balance', wei: BigInt(wei).toString(10)} as EvmGasBalanceResult),
        async (e: unknown) => {
          if (signal?.aborted) throw e; // a CALLER-aborted read is not a failure to classify
          return {kind: 'error', failure: await fail(e)} as const;
        },
      ),
      ...list.map(async (key) => {
        let hex: string;
        try {
          hex = await ethCall(urls, key.tokenAddress, toHex0x(encodeBalanceOf(address)), {signal});
        } catch (e) {
          if (signal?.aborted) throw e;
          return {kind: 'error', failure: await fail(e)} as const;
        }
        // The endpoint ANSWERED; its bytes are the problem. Never a zero — the hook keeps the
        // last known fact and says nothing new (the SOL 'unreadable' discipline).
        let raw: bigint;
        try {
          raw = decodeUint256(hex);
        } catch {
          return {kind: 'error', failure: 'unreadable'} as const;
        }
        const result: EvmTokenBalanceResult = {kind: 'balance', amount: raw.toString(10)};
        return result;
      }),
    ]);
    gas[chainId] = gasRes;
    list.forEach((key, i) => {
      tokens[`${chainId}:${key.token}`] = tokenRes[i];
    });
  }));
  return {gas, tokens};
}

// ── The fee quote (D15.2) ──────────────────────────────────────────────────────────────────────

export interface EvmFeeQuote {
  /** Worst-case fee in wei: maxFeePerGas × gasUnits. */
  readonly maxFeeWei: string;
  /** The chain's own base gas price (eth_gasPrice), wei. */
  readonly baseFeeWei: string;
  /** The node's priority-fee suggestion, wei ('0' when the node does not answer the method). */
  readonly priorityFeeWei: string;
  /** eth_estimateGas's answer, units of gas. */
  readonly gasUnits: string;
  /** maxFeePerGas the send will sign (2×baseFee + priority), wei. */
  readonly maxFeePerGasWei: string;
}

/**
 * The chain's own fee arithmetic over the caller's typed inputs (D15.2 — dpay never quotes;
 * this is the chain's estimateGas + gasPrice, displayed with the "estimate" attribution).
 * Runs the wrong-chain gate first: a fee quoted from the wrong ledger is a wrong answer.
 *
 * maxFeePerGas = 2 × baseFee + priority — the standard wallet headroom over base-fee movement
 * while the tx waits to be included. estimateGas is pending-state dependent and relay-uncached
 * by contract.
 */
export async function quoteEvmFee(
  chainId: number,
  from: string,
  to: string,
  data: string,
  signal?: AbortSignal,
): Promise<EvmFeeQuote> {
  const urls = evmRpcUrls(chainId);
  if (urls[0] === '') throw new Error(`EVM is not configured on this device (chain ${chainId})`);
  await ensureChain(chainId, urls, signal);
  const [gasUnitsHex, baseFeeHex, priorityHex] = await Promise.all([
    ethEstimateGas(urls, {from, to, data}, {signal}),
    ethGasPrice(urls, {signal}),
    ethMaxPriorityFeePerGas(urls, {signal}).catch((e: unknown) => {
      if (signal?.aborted) throw e;
      return null; // the node does not answer the method — the quote stays the chain's own
    }),
  ]);
  const gasUnits = hexToNumber(gasUnitsHex, 'eth_estimateGas');
  const baseFee = BigInt(baseFeeHex);
  const priority = priorityHex === null ? 0n : BigInt(priorityHex);
  const maxFeePerGas = baseFee * 2n + priority;
  return {
    maxFeeWei: (maxFeePerGas * BigInt(gasUnits)).toString(10),
    baseFeeWei: baseFee.toString(10),
    priorityFeeWei: priority.toString(10),
    gasUnits: String(gasUnits),
    maxFeePerGasWei: maxFeePerGas.toString(10),
  };
}

// ── The send flow (D15 app half) ───────────────────────────────────────────────────────────────

export const EVM_RECEIPT_TIMEOUT_MS = 60000;
export const EVM_RECEIPT_POLL_MS = 1500;

export interface EvmSendInput {
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly to: string;
  /** Exact raw smallest units (decimal-digit string; uint256-safe). */
  readonly rawAmount: string;
  /** The token's smallest-unit decimal count (the catalog row's decimals — the caller reads it
   *  off the asset row, never a guess; ZCHF is 18). */
  readonly decimals: number;
}

/** The chain's verdict on a broadcast tx: receipt status 0x1 / 0x0, 'pending' while unknown to
 *  the node, 'unknown' when the receipt shape cannot be trusted. */
export type EvmReceiptStatus = 'included' | 'pending' | 'failed' | 'unknown';

function receiptStatus(r: EvmReceipt | null): EvmReceiptStatus {
  if (r === null) return 'pending';
  if (r.status === '0x1') return 'included';
  if (r.status === '0x0') return 'failed';
  return 'unknown';
}

/** One receipt read. A transport/refusal error during the poll is the CALLER's business — this
 *  thin read answers the chain's words or throws; the loop below decides what a throw means. */
export async function getEvmReceiptStatus(chainId: number, txHash: string, signal?: AbortSignal): Promise<EvmReceiptStatus> {
  const urls = evmRpcUrls(chainId);
  if (urls[0] === '') throw new Error(`EVM is not configured on this device (chain ${chainId})`);
  return receiptStatus(await ethGetTransactionReceipt(urls, txHash.toLowerCase(), {signal}));
}

/**
 * Build, sign, broadcast, and confirm an ERC-20 `transfer(to, rawAmount)` of the token at
 * `tokenAddress` on `chainId`. Signs LOCALLY with the device-derived secp256k1 key
 * (m/44'/60'/0'/0/0 over the SAME seed as every other rail) — non-custodial; dpay never holds
 * keys, pays gas, or quotes fees.
 *
 * The gate ORDER is the money-safety order (D15):
 *   1. wrong-chain gate — the endpoint must PROVE it serves `chainId` (eth_chainId) before
 *      any spend-shaped request;
 *   2. fee probe — the chain's own arithmetic (estimateGas + gasPrice + priority);
 *   3. GAS HONESTY GATE — the wallet is its own gas source and dpay pays nothing, so the
 *      payer's measured native balance must cover the max fee, or the send REFUSES with
 *      `EvmGasGateError` carrying every number the instructive copy needs (fee, have, chain,
 *      the payer's own 0x to receive gas at). No broadcast can happen past this gate.
 *   4. sign type-2 (EIP-1559, deterministic), broadcast raw bytes, receipt poll to
 *      EVM_RECEIPT_TIMEOUT_MS.
 *
 * `onBroadcast` fires the moment the network ACCEPTS the raw tx (before confirmation) — the
 * first instant a throw can no longer mean "nothing happened" (the sendSol contract). A
 * confirmation timeout REJECTS into the honest-unknown state: the tx MAY still land; the
 * caller keeps the txHash (returned via the error's `txHash`-carrying catch or `onBroadcast`)
 * and never re-signs blindly. Returns the confirmed tx hash.
 */
export async function sendErc20(
  secretHex: string,
  input: EvmSendInput,
  signal?: AbortSignal,
  onBroadcast?: (txHash: string) => void,
): Promise<{txHash: string}> {
  const urls = evmRpcUrls(input.chainId);
  if (urls[0] === '') throw new Error(`EVM is not configured on this device (chain ${input.chainId})`);
  const chain = EVM_CHAINS[input.chainId as keyof typeof EVM_CHAINS];
  const chainName = chain?.name ?? `chain ${input.chainId}`;
  const nativeSymbol = chain?.nativeSymbol ?? 'ETH';

  // 1. Wrong-chain gate (module header). Memoized; the first send of a session pays one read.
  await ensureChain(input.chainId, urls, signal);

  const keypair = deriveEvmKeypair(secretHex);
  const from = keypair.address;
  const rawAmount = toBaseUnits(input.rawAmount, input.decimals);
  const data = toHex0x(encodeTransfer(input.to, rawAmount));

  // 2. Fee probe — the chain's own arithmetic over the user's typed inputs.
  const gasUnitsHex = await ethEstimateGas(urls, {from, to: input.tokenAddress, data}, {signal});
  const gasUnits = BigInt(hexToNumber(gasUnitsHex, 'eth_estimateGas'));
  // 20% headroom over the estimate: a pending-state shift between estimate and inclusion must
  // not kill an otherwise-valid send at the node's own bound-check. Display quote + bound only;
  // the chain enforces reality.
  const gasLimit = gasUnits + (gasUnits * 20n) / 100n + 1n;
  const baseFee = BigInt(await ethGasPrice(urls, {signal}));
  const priorityHex = await ethMaxPriorityFeePerGas(urls, {signal}).catch((e: unknown) => {
    if (signal?.aborted) throw e;
    return null;
  });
  const priority = priorityHex === null ? 0n : BigInt(priorityHex);
  const maxFeePerGas = baseFee * 2n + priority;
  const maxFeeWei = maxFeePerGas * gasLimit;

  // 3. THE GAS GATE (D15.3): refuse + carry every number the instructive copy needs.
  const gasWei = BigInt(await ethGetBalance(urls, from, {signal}));
  if (gasWei < maxFeeWei) {
    throw new EvmGasGateError({
      requiredWei: maxFeeWei.toString(10),
      gasBalanceWei: gasWei.toString(10),
      chainId: input.chainId,
      chainName,
      nativeSymbol,
      address: from,
    });
  }

  // 4. Sign + broadcast + receipt.
  const nonce = hexToNumber(await ethGetTransactionCount(urls, from, {signal}), 'eth_getTransactionCount');
  const signed = signEip1559Tx({
    chainId: input.chainId,
    nonce,
    maxPriorityFeePerGas: priority,
    maxFeePerGas,
    gasLimit,
    to: input.tokenAddress,
    value: 0n,
    data: encodeTransfer(input.to, rawAmount),
  }, keypair.privateKey);
  const localHash = toHex0x(signed.txHash);
  let accepted: string;
  try {
    accepted = await ethSendRawTransaction(urls, toHex0x(signed.raw), {signal});
  } catch (e) {
    console.warn(`evm send: broadcast of ${localHash} failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
  // The node's hash for OUR bytes must BE our hash — a mismatch means the answering node
  // echoed something unexpected. It is NOT a verdict: the signed bytes are valid and may be
  // in-flight or accepted elsewhere, so the receipt (the referee) decides by OUR hash. Never
  // a re-sign, never a false success.
  if (accepted.toLowerCase() !== localHash.toLowerCase()) {
    console.warn(`evm send: node answered hash ${accepted} for locally-signed ${localHash} — the receipt decides by our hash`);
  }
  onBroadcast?.(localHash);
  await pollEvmReceiptIn(urls, localHash, signal);
  return {txHash: localHash};
}

/** Poll `eth_getTransactionReceipt` until included/failed or the confirm deadline. A
 *  'failed' receipt is DEFINITIVE (the tx landed and reverted — nothing will move); a timeout
 *  is the honest unknown (the tx MAY still land). Per-poll transport errors keep polling. */
async function pollEvmReceiptIn(urls: readonly string[], txHash: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + EVM_RECEIPT_TIMEOUT_MS;
  while (true) {
    if (signal?.aborted) throw new Error('aborted');
    let status: EvmReceiptStatus;
    try {
      status = receiptStatus(await ethGetTransactionReceipt(urls, txHash, {signal}));
    } catch (e) {
      if (signal?.aborted) throw e;
      status = 'unknown'; // a transient read failure is not a verdict; keep polling
    }
    if (status === 'included') return;
    if (status === 'failed') throw new Error(`evm send: transaction ${txHash} was included but FAILED on-chain (reverted) — no transfer happened`);
    if (Date.now() >= deadline) {
      throw new Error(
        `evm send: no receipt for ${txHash} within ${Math.round(EVM_RECEIPT_TIMEOUT_MS / 1000)}s — ` +
          `the transaction may still be included; do not re-send blindly`,
      );
    }
    await rpcSleep(EVM_RECEIPT_POLL_MS, signal);
  }
}
