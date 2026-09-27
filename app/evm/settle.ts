// evm/settle — the seam-side adapter between the JSON-RPC client (`./rpc`, NETWORK) and the
// pure claim engine (`./claims`, PURE-over-injection). This is the "thin app/evm/settle.ts the
// seam re-exports" of the claims stream's SEAM CONTRACT (evm/claims.ts header):
//
//   • hex ↔ Uint8Array, hex ↔ bigint — the client speaks 0x-hex strings, the engine speaks
//     bytes and BigInt;
//   • `ethCall` passes `from` — the transferFrom preflight MUST call as the merchant
//     (`allowance[owner][msg.sender]`; permit is ecrecover-based and msg.sender-blind);
//   • revert payloads ride rejections on `err.data` (the thrown EvmEndpointRefused carries the
//     node's JSON-RPC `error.data` — rpc.ts), and transport-shaped failures are marked
//     `err.transport = true` so the engine can tell "the chain answered: no" from "we could
//     not ask";
//   • the WRONG-CHAIN GATE runs HERE before the engine sees the rpc — the engine's injected
//     rpc cannot prove chain identity, and a settle against a foreign chain is a wrong-ledger
//     spend (D10/D12).
//
// NETWORK module — reached only through the seam `app/evm.ts` (lazy dynamic import), never
// statically. The money-path deadline table (seam header) applies: per-call rpcFetch bounds,
// receipt poll 1.5s / 60s confirm deadline (D24.2 defaults, passed to the engine).

import {bytesToHex, hexToBytes} from '../lib/format';
import {decodeTransferLog, TRANSFER_EVENT_TOPIC} from './abi';
import {
  evmClaimsKey,
  readEvmPermitNonce,
  resolveEvmTokenAddress,
  seedEvmNonce,
  settleEvmClaim,
  type EvmPayV1,
  type EvmReqV1,
  type EvmRpcLike,
  type EvmSettleResult,
} from './claims';
import {type EvmChainId, EVM_CHAINS} from './chains';
import {deriveEvmKeypair} from './identity';
import {isEvmEndpointRefusal, isEvmRelayPathDown, isEvmWrongChainError} from './errors';
import {
  ethCall,
  ethEstimateGas,
  ethGasPrice,
  ethGetBalance,
  ethGetLogs,
  ethGetTransactionCount,
  ethGetTransactionReceipt,
  ethMaxPriorityFeePerGas,
  ethSendRawTransaction,
  type EvmLog,
} from './rpc';
import {evmRpcUrl, evmRpcUrls} from './endpoints';
import {ensureChain, type EvmKey} from './service';
import {toHex0x} from './tx';

export type {EvmPayV1, EvmReqV1, EvmSettleResult};

/** The transport/revert split the engine classifies on: `transport = true` means the chain was
 *  never ASKED (relay leg dead, HTTP-level refusal, rate limit, wrong-chain guard, fetch died)
 *  — the engine then treats the claim as retryable-unknown, never as an on-chain verdict. A
 *  JSON-RPC-level refusal (status null) IS the chain's own answer — its `data` may be a revert
 *  payload the engine decodes. */
function markTransport(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  const transport =
    isEvmRelayPathDown(e) ||
    isEvmWrongChainError(e) ||
    !isEvmEndpointRefusal(e) ||
    (e as {status?: unknown}).status !== null;
  return transport ? Object.assign(err, {transport: true}) : err;
}

/** The JSON-RPC client, reshaped into the engine's `EvmRpcLike`. All hex/byte/bigint mapping
 *  lives here so the engine stays pure. */
export function adaptEvmRpc(chainId: number, signal?: AbortSignal): EvmRpcLike {
  const urls = evmRpcUrls(chainId);
  const quantity = (n: number): string => '0x' + BigInt(n).toString(16);
  const guard = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      throw markTransport(e);
    }
  };
  return {
    ethCall: (to, data, from) => guard(ethCall(urls, to, toHex0x(data), {signal}, from)),
    ethGetBalance: (address) => guard(ethGetBalance(urls, address, {signal}).then((h) => BigInt(h))),
    ethGetTransactionCount: (address) => guard(ethGetTransactionCount(urls, address, {signal}).then((h) => Number(BigInt(h)))),
    ethEstimateGas: (tx) => guard(ethEstimateGas(urls, {from: tx.from, to: tx.to, data: toHex0x(tx.data)}, {signal}).then((h) => BigInt(h))),
    ethGasPrice: () => guard(ethGasPrice(urls, {signal}).then((h) => BigInt(h))),
    ethMaxPriorityFeePerGas: () => guard(ethMaxPriorityFeePerGas(urls, {signal}).then((h) => (h === null ? 0n : BigInt(h)))),
    ethSendRawTransaction: (raw) => guard(ethSendRawTransaction(urls, toHex0x(raw), {signal})),
    ethGetTransactionReceipt: async (txHash) => {
      // NOT guard-wrapped: a throw during the receipt poll is the engine's own "receipt channel
      // died" path (it degrades to unseen — the tx MAY land). The raw rejection keeps the
      // engine's poll try/catch in charge.
      const r = await ethGetTransactionReceipt(urls, txHash.toLowerCase(), {signal});
      return r === null ? null : {status: r.status ?? ''};
    },
    ethGetLogs: async (filter) => {
      const logs: EvmLog[] = await ethGetLogs(urls, {
        address: filter.address,
        topics: filter.topics,
        fromBlock: quantity(filter.fromBlock),
        toBlock: 'latest',
      }, {signal});
      return logs as Array<{transactionHash?: string; topics?: string[]; data?: string}>;
    },
  };
}

/**
 * The seam's settle wrapper (the claims stream's SEAM CONTRACT, D24): resolve the merchant key
 * from the device seed, the token contract from the registry, the queue key from the device
 * address, prove the chain, then run the pure engine over the adapted rpc. Deadlines: poll
 * 1.5s, confirm 60s (the D10 table's receipt-poll row).
 */
export async function settleEvmClaimForDevice(
  secretHex: string,
  req: EvmReqV1,
  claim: EvmPayV1,
  signal?: AbortSignal,
): Promise<EvmSettleResult> {
  const urls = evmRpcUrls(req.chainId);
  if (urls[0] === '') throw new Error(`EVM is not configured on this device (chain ${req.chainId})`);
  // The wrong-chain gate BEFORE anything the engine does (one upstream serves one chain —
  // D10/D12; the engine's injected rpc cannot check this itself).
  await ensureChain(req.chainId, urls, signal);
  const tokenAddress = resolveEvmTokenAddress(req.chainId, req.token);
  if (tokenAddress === null) throw new Error(`evm settle: no ${req.token} deployment on chain ${req.chainId}`);
  const keypair = deriveEvmKeypair(secretHex);
  return settleEvmClaim({
    key: evmClaimsKey(keypair.address),
    merchantPrivateKey: keypair.privateKey,
    req,
    claim,
    tokenAddress,
    rpc: adaptEvmRpc(req.chainId, signal),
  });
}

/**
 * Seed the permit-nonce cache from the chain (D22.1 — the balance poll's every-5th-tick read):
 * one `nonces(owner)` eth_call per configured (chain, token) key, best-effort per key (one
 * failing chain never blocks the others). Keys are the visible EVM rows (the `EvmKey` tuple);
 * a key whose chain has no endpoint or whose token has no registry deployment is skipped.
 */
export async function seedEvmNoncesFromChain(secretHex: string, keys: readonly EvmKey[]): Promise<void> {
  const owner = deriveEvmKeypair(secretHex).address;
  await Promise.all(keys.map(async (key) => {
    try {
      if (evmRpcUrl(key.chainId) === '') return;
      const token = resolveEvmTokenAddress(key.chainId, key.token);
      if (token === null) return;
      const nonce = await readEvmPermitNonce(adaptEvmRpc(key.chainId), token, owner);
      await seedEvmNonce(owner, key.chainId, key.token, nonce);
    } catch (e) {
      // Best-effort by contract: an unseeded nonce only means the next offline sign guesses the
      // cached value and a stale guess surfaces as the honest needs-resign flow (D22.3).
      console.warn(`evm settle: nonce seed failed for chain ${key.chainId} ${key.token}:`, e instanceof Error ? e.message : String(e));
    }
  }));
}

// 32-byte left-padded address word for an event topic — the same encoding the engine's
// `addressWord` builds for calldata, inlined as hex so the payer-side read stays a thin client
// call over the shared decoder.
function addressTopic(address: string): string {
  const raw = hexToBytes(address);
  const word = new Uint8Array(32);
  word.set(raw, 32 - raw.length);
  return '0x' + bytesToHex(word);
}

/**
 * Did the payment ALREADY land? The payer-side claim check: the first on-chain
 * `Transfer(owner → to, amount)` log since `fromBlock`, as its tx hash — null when nothing
 * matches (read-only; nothing here spends). Mirrors the engine's own re-entry scan (D24.1's
 * duplicate check) so both sides of a hand-off ask the chain the same question.
 */
export async function findEvmSettledTransfer(
  chainId: number,
  tokenAddress: string,
  owner: string,
  to: string,
  rawAmount: string,
  fromBlock: number = 0,
  signal?: AbortSignal,
): Promise<string | null> {
  const urls = evmRpcUrls(chainId);
  if (urls[0] === '') throw new Error(`EVM is not configured on this device (chain ${chainId})`);
  await ensureChain(chainId, urls, signal);
  const amount = BigInt(rawAmount);
  const ownerL = owner.toLowerCase();
  const toL = to.toLowerCase();
  const logs = await ethGetLogs(urls, {
    address: tokenAddress,
    topics: [TRANSFER_EVENT_TOPIC, addressTopic(ownerL), addressTopic(toL)],
    fromBlock: '0x' + BigInt(fromBlock).toString(16),
    toBlock: 'latest',
  }, {signal});
  for (const log of logs) {
    if (!log.topics || log.data === undefined) continue;
    const parsed = decodeTransferLog(log.data, [...log.topics]);
    if (parsed && parsed.from.toLowerCase() === ownerL && parsed.to.toLowerCase() === toL && parsed.amount === amount) {
      return log.transactionHash ?? null;
    }
  }
  return null;
}
| null {
  const c = EVM_CHAINS[chainId as EvmChainId];
  return c ? {name: c.name, nativeSymbol: c.nativeSymbol} : null;
}
