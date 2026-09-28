// node-anvil/anvilEnv — the tier's shared wiring + the DIRECT-anvil assertion oracle.
//
// The tier proves the REAL chain pipe at service level: one scratch anvil (31337) + the REAL
// test-helpers relay staged ONCE per jest run by the globalSetup child (stage-child.mjs, which
// reuses e2e/harness/evm/{anvil,pipe}.mjs verbatim). The app's own seam (`../evm`) drives the
// chain THROUGH the relay pipe; this module covers only the two things the app must not provide:
//
//   • the staging env handoff (globalSetup → workers via process.env; test code must never import
//     e2e/harness/*.mjs, babel's CJS transform breaks its import.meta.url);
//   • the SECOND SOURCE for assertions: plain JSON-RPC reads DIRECT to anvil, bypassing the relay
//     entirely. An assert that only reads back through the pipe would prove the pipe agrees with
//     itself; the direct read proves REAL chain state.
//
// Wherever app code exists it is used (abi/tx/identity codecs, the seam) — nothing here
// re-implements app logic. Funding is harness-side scaffolding, exactly the e2e flows'
// fundEth/transferToken ladder, re-expressed with the app's own signing code.

import {sha256} from '@noble/hashes/sha2';
import {
  encodeBalanceOf,
  decodeUint256,
  encodeTransfer,
  encodeAllowance,
  TRANSFER_EVENT_TOPIC,
  decodeTransferLog,
} from '../../evm/abi';
import {encodeEvmNonces} from '../../evm/claims';
import {evmKeypairFromPrivate} from '../../evm/identity';import {signEip1559Tx, toHex0x} from '../../evm/tx';
import {hexToBytes} from '../../lib/format';
import {utf8ToBytes} from '../../lib/base64url';

export const ANVIL_CHAIN_ID = 31337;

/** Anvil's well-known account #0 (mnemonic "test test … junk") — the MockZCHF deployer, public
 *  and valueless on a scratch chain. The funding source, identical to e2e/harness/evm/anvil.mjs. */
export const ANVIL_DEPLOYER_PRIV = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const ANVIL_DEPLOYER = evmKeypairFromPrivate(hexToBytes(ANVIL_DEPLOYER_PRIV)).address;

/** Anvil's well-known account #1 — the standing recipient/counterparty. */
export const ANVIL_ACCOUNT_1 = evmKeypairFromPrivate(
  hexToBytes('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'),
).address;

/** A deterministic, VALUELESS per-role device seed (the pipe.mjs devSeed pattern). The derived
 *  address is stable across runs and machines, which is what makes staged balances assertable. */
export function devSeed(role: string): string {
  return Buffer.from(sha256(utf8ToBytes(`dpay node-anvil ${role} seed — valueless, offline only`))).toString('hex');
}

export interface NodeAnvilEnv {
  /** anvil's JSON-RPC, DIRECT (assertions + funding only; the app never dials this). */
  readonly rpc: string;
  /** The relay's per-chain pipe route the app seam is pointed at (`<relay>/api/v1/evm/rpc/31337`). */
  readonly pipe: string;
  /** The deployed MockZCHF address. */
  readonly token: string;
  /** The relay base (catalog reads). */
  readonly relay: string;
}

/** Read + validate the globalSetup handoff. Throws with the fix when the tier was started wrong
 *  (a bare jest run must never reach the chain — the project is env-gated, this is the backstop). */
export function nodeAnvilEnv(): NodeAnvilEnv {
  const rpc = process.env.DPAY_NODE_ANVIL_RPC ?? '';
  const pipe = process.env.DPAY_NODE_ANVIL_PIPE ?? '';
  const token = process.env.DPAY_NODE_ANVIL_TOKEN ?? '';
  const relay = process.env.DPAY_NODE_ANVIL_RELAY ?? '';
  const ok =
    /^http:\/\/127\.0\.0\.1:\d+$/.test(rpc) &&
    /^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/evm\/rpc\/31337$/.test(pipe) &&
    /^0x[0-9a-fA-F]{40}$/.test(token) &&
    /^http:\/\/127\.0\.0\.1:\d+$/.test(relay);
  if (!ok) {
    throw new Error(
      '[node-anvil] chain env missing — run the tier through `just node-anvil` ' +
        '(it sets DPAY_NODE_ANVIL=1 so the project globalSetup stages anvil + relay).',
    );
  }
  return {rpc, pipe, token, relay};
}

// ── the DIRECT-anvil oracle (assertions on REAL chain state, bypassing the relay) ──────────────

async function anvilRpc<T>(rpc: string, method: string, params: unknown[]): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
      signal: ctrl.signal,
    });
    const json = (await res.json()) as {result?: T; error?: {message?: string}};
    if (json.error) throw new Error(`anvil ${method} answered an error: ${JSON.stringify(json.error).slice(0, 200)}`);
    if (json.result === undefined) throw new Error(`anvil ${method} answered no result`);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function tokenBalanceRaw(rpc: string, token: string, owner: string): Promise<bigint> {
  const out = await anvilRpc<string>(rpc, 'eth_call', [{to: token, data: toHex0x(encodeBalanceOf(owner))}, 'latest']);
  return decodeUint256(out);
}

export async function ethBalanceRaw(rpc: string, owner: string): Promise<bigint> {
  return BigInt(await anvilRpc<string>(rpc, 'eth_getBalance', [owner, 'latest']));
}

export async function permitNonceRaw(rpc: string, token: string, owner: string): Promise<bigint> {
  const out = await anvilRpc<string>(rpc, 'eth_call', [{to: token, data: toHex0x(encodeEvmNonces(owner))}, 'latest']);
  return decodeUint256(out);
}

export async function allowanceRaw(rpc: string, token: string, owner: string, spender: string): Promise<bigint> {
  const out = await anvilRpc<string>(rpc, 'eth_call', [{to: token, data: toHex0x(encodeAllowance(owner, spender))}, 'latest']);
  return decodeUint256(out);
}

export async function txCountRaw(rpc: string, owner: string): Promise<bigint> {
  return BigInt(await anvilRpc<string>(rpc, 'eth_getTransactionCount', [owner, 'latest']));
}

export interface RawTransferLog {
  readonly txHash: string;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
}

/** Every decoded Transfer log the token emitted since `fromBlockHex` (DIRECT read). */
export async function transferLogsRaw(rpc: string, token: string, fromBlockHex: string): Promise<RawTransferLog[]> {
  const logs = await anvilRpc<Array<{transactionHash?: string; topics?: string[]; data?: string}>>(
    rpc,
    'eth_getLogs',
    // TRANSFER_EVENT_TOPIC is already the 0x-hex topic string (evm/abi.ts)
    [{address: token, topics: [TRANSFER_EVENT_TOPIC], fromBlock: fromBlockHex, toBlock: 'latest'}],
  );
  const out: RawTransferLog[] = [];
  for (const log of logs) {
    if (!log.topics || log.data === undefined) continue;
    const parsed = decodeTransferLog(log.data, log.topics);
    if (parsed) out.push({txHash: log.transactionHash ?? '', from: parsed.from, to: parsed.to, amount: parsed.amount});
  }
  return out;
}

export async function latestBlockHex(rpc: string): Promise<string> {
  return anvilRpc<string>(rpc, 'eth_blockNumber', []);
}

/** Poll a probe until it satisfies `ok` (the pipe's 2s read cache and anvil's 1s blocks make
 *  every "did it land yet" read a poll, never an assumption). */
export async function pollUntil<T>(what: string, probe: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await probe();
    if (ok(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`[node-anvil] ${what} never settled within ${timeoutMs}ms (last: ${String(last)})`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ── the funding ladder (harness-side scaffolding, signed with the app's OWN tx code) ───────────

/** Sign a type-2 tx with the app's own signer, broadcast DIRECT to anvil, and wait for an
 *  included (non-reverted) receipt. The staging/funding lane only; the app path rides the pipe. */
export async function sendDirectTx(rpc: string, privHex: string, to: string, data: Uint8Array, gasLimit: bigint): Promise<string> {
  const signer = evmKeypairFromPrivate(hexToBytes(privHex));
  const nonce = Number(BigInt(await anvilRpc<string>(rpc, 'eth_getTransactionCount', [signer.address, 'pending'])));
  const head = await anvilRpc<{baseFeePerGas: string}>(rpc, 'eth_getBlockByNumber', ['latest', false]);
  const baseFee = BigInt(head.baseFeePerGas);
  const tip = 2_000_000_000n; // 2 gwei — generous on a scratch chain, irrelevant to correctness
  const signed = signEip1559Tx(
    {
      chainId: ANVIL_CHAIN_ID,
      nonce,
      maxPriorityFeePerGas: tip,
      maxFeePerGas: baseFee * 4n + tip,
      gasLimit,
      to,
      value: 0n,
      data,
    },
    signer.privateKey,
  );
  const hash = await anvilRpc<string>(rpc, 'eth_sendRawTransaction', [toHex0x(signed.raw)]);
  const receipt = await pollUntil<{status: string} | null>(
    `direct tx ${hash.slice(0, 10)}…`,
    () => anvilRpc<{status: string} | null>(rpc, 'eth_getTransactionReceipt', [hash]),
    (r) => r !== null,
  );
  if (receipt === null || BigInt(receipt.status) !== 1n) throw new Error(`[node-anvil] direct tx ${hash} reverted`);
  return hash;
}

/** anvil_setBalance — the gas leg (the e2e ladder's fundEth). */
export async function fundEthDirect(rpc: string, address: string, wei: bigint): Promise<void> {
  await anvilRpc<unknown>(rpc, 'anvil_setBalance', [address, '0x' + wei.toString(16)]);
}

/** A signed MockZCHF transfer from the well-known deployer (the e2e ladder's transferToken). */
export async function fundZchfDirect(rpc: string, token: string, to: string, amountRaw: bigint): Promise<string> {
  return sendDirectTx(rpc, ANVIL_DEPLOYER_PRIV, token, encodeTransfer(to, amountRaw), 80_000n);
}

// ── the seam wiring every test file runs in beforeAll ──────────────────────────────────────────

/**
 * Point the app seam at the relay pipe (the OPERATOR override — plain http accepted for loopback,
 * the local-anvil case the endpoint validator names) and install the served catalog's Anvil ZCHF
 * row into the token registry, the same `syncEvmCatalogDeployments` call the Wallet makes on
 * every catalog change. The per-file module registry starts unconfigured, so this runs per file.
 */
export async function wireSeamToPipe(env: NodeAnvilEnv): Promise<void> {
  const {setEvmRpcUrl, syncEvmCatalogDeployments, resolveEvmTokenAddress} = await import('../../evm');
  setEvmRpcUrl(env.pipe);
  const row = await anvilCatalogRow(env.relay);
  if (row.address.toLowerCase() !== env.token.toLowerCase()) {
    throw new Error(`[node-anvil] catalog row ${row.address} != staged token ${env.token}`);
  }
  syncEvmCatalogDeployments([row]);
  if (resolveEvmTokenAddress(ANVIL_CHAIN_ID, 'ZCHF') === null) {
    throw new Error('[node-anvil] the Anvil ZCHF row did not resolve in the token registry');
  }
}

/** GET /api/v1/currencies → the `{evm, "Anvil", testnet}` section's ZCHF row (chain 31337). */
async function anvilCatalogRow(relay: string): Promise<{chainId: number; token: string; address: string}> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let body: {networks?: Array<{protocol?: string; name?: string; assets?: Array<{token?: string; chain_id?: number; address?: string}>}>};
  try {
    const res = await fetch(`${relay}/api/v1/currencies`, {signal: ctrl.signal});
    if (!res.ok) throw new Error(`GET /api/v1/currencies → HTTP ${res.status}`);
    body = (await res.json()) as typeof body;
  } finally {
    clearTimeout(timer);
  }
  for (const network of body.networks ?? []) {
    if (network.protocol !== 'evm' || network.name !== 'Anvil') continue;
    for (const asset of network.assets ?? []) {
      if (asset.token === 'ZCHF' && Number(asset.chain_id) === ANVIL_CHAIN_ID && /^0x[0-9a-fA-F]{40}$/.test(asset.address ?? '')) {
        return {chainId: ANVIL_CHAIN_ID, token: 'ZCHF', address: asset.address as string};
      }
    }
  }
  throw new Error('[node-anvil] the relay catalog carries no Anvil ZCHF row — the staging child must set DPAY_EVM_ANVIL_TOKEN');
}
