#!/usr/bin/env node
// e2e/harness/evm/pipe-smoke.mjs — prove a FULL ERC-20 transfer round trip THROUGH the relay pipe
// (flow-165 discipline for the EVM rail, D26): every app-like call goes to the harness relay's
//   POST /api/v1/evm/rpc  →  (pure pipe)  →  DPAY_EVM_RPC_URL  →  scratch anvil
// and NEVER directly to anvil. No ethers — the tx is built + signed with evm-core.mjs on the same
// @noble packages the app ships. No internet — every socket here is 127.0.0.1.
//
// The round trip: eth_chainId → balanceOf before → build+sign an EIP-1559 ZCHF transfer →
// eth_sendRawTransaction (uncached pass-through — the send path) → eth_getTransactionReceipt →
// balanceOf after → eth_getLogs → decode the Transfer log and match (from, to, value).
//
// Run: node e2e/harness/evm/pipe-smoke.mjs   (exits 0 on PASS, 1 on any failure)
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {startRelay, pickFreePort} from '../relay.mjs';
import {
  stageAnvil,
  ANVIL_ACCOUNT_0_PRIV,
} from './anvil.mjs';
import {
  eip55, evmAddressOf, rpc, signEip1559, encodeErc20Transfer, encodeErc20BalanceOf,
  decodeUint256, TRANSFER_TOPIC, decodeTransferLog,
} from './evm-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// anvil account #1 — the well-known counterparty (public and valueless).
const ACCOUNT_1_PRIV = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ACCOUNT_1 = eip55(evmAddressOf(ACCOUNT_1_PRIV));
const AMOUNT_RAW = 1_234_500_000_000_000_000n; // 1.2345 ZCHF
const assert = (ok, msg) => { if (!ok) throw new Error(`pipe-smoke: ${msg}`); };

const anvilPort = await pickFreePort();
const staged = await stageAnvil({port: anvilPort});
const {tokenAddress} = staged;
console.log(`[pipe-smoke] anvil :${anvilPort} — token ${tokenAddress}, deployer ${staged.deployer}`);

let relay = null;
try {
  // The harness relay (the REAL dpay-relay, FakeLedger, test-helpers) with its EVM upstream
  // pointed at our scratch anvil — the flow-165 shape, named explicitly so no shell-exported
  // DPAY_EVM_RPC_URL can leak in or out.
  relay = await startRelay({env: {DPAY_EVM_RPC_URL: staged.rpcUrl}});
  const pipe = `${relay.baseURL}/api/v1/evm/rpc`;
  console.log(`[pipe-smoke] relay :${relay.port} — pipe ${pipe} → ${staged.rpcUrl}`);
  const viaPipe = (method, params) => rpc(pipe, method, params, {timeoutMs: 8_000});

  // 1. chain id through the pipe (a cached allowlisted read; first call MUST hit the upstream).
  const chainId = await viaPipe('eth_chainId', []);
  assert(BigInt(chainId) === 31337n, `eth_chainId through the pipe must be 31337, got ${chainId}`);

  // 2. balanceOf(#1) before — 0 (a fresh chain).
  const before1 = decodeUint256(await viaPipe('eth_call', [{to: tokenAddress, data: encodeErc20BalanceOf(ACCOUNT_1)}, 'latest']));
  assert(before1 === 0n, `recipient balance must start at 0, got ${before1}`);
  const before0 = decodeUint256(await viaPipe('eth_call', [{to: tokenAddress, data: encodeErc20BalanceOf(staged.deployer)}, 'latest']));
  assert(before0 > AMOUNT_RAW, `deployer balance ${before0} must exceed the transfer amount`);

  // 3. build + sign the raw EIP-1559 transfer with the DEPLOYER key (anvil #0, funded with all ZCHF).
  const from = eip55(evmAddressOf(ANVIL_ACCOUNT_0_PRIV));
  const nonce = BigInt(await viaPipe('eth_getTransactionCount', [from, 'pending']));
  const head = await viaPipe('eth_getBlockByNumber', ['latest', false]);
  const baseFee = BigInt(head.baseFeePerGas);
  const tip = 2_000_000_000n;
  const {rawTx, txHash} = signEip1559({
    privHex: ANVIL_ACCOUNT_0_PRIV, chainId: 31337n, nonce,
    maxFeePerGas: baseFee * 4n + tip, maxPriorityFeePerGas: tip,
    gasLimit: 80_000n, to: tokenAddress, value: 0n,
    data: encodeErc20Transfer(ACCOUNT_1, AMOUNT_RAW),
  });

  // 4. broadcast THROUGH the pipe (uncached pass-through — the exact app send path).
  const sentHash = await viaPipe('eth_sendRawTransaction', [rawTx]);
  assert(sentHash.toLowerCase() === txHash.toLowerCase(), `node hash ${sentHash} != locally computed ${txHash}`);

  // 5. receipt through the pipe (1s blocks — poll briefly).
  let receipt = null;
  for (let i = 0; i < 40 && receipt == null; i++) {
    receipt = await viaPipe('eth_getTransactionReceipt', [sentHash]);
    if (receipt == null) await new Promise((r) => setTimeout(r, 250));
  }
  assert(receipt != null, 'receipt never landed within 10s');
  assert(BigInt(receipt.status) === 1n, `transfer receipt status ${receipt.status} (reverted)`);
  console.log(`[pipe-smoke] transfer ${sentHash} included in block ${BigInt(receipt.blockNumber)} (gas ${BigInt(receipt.gasUsed)})`);

  // 6. balances after, through the pipe. The pipe's read cache gives eth_call 2s of bounded
  // staleness (D12's TTL table) — poll past it instead of assuming instant visibility (the same
  // discipline the app's balance poll follows).
  const deadline = Date.now() + 8_000;
  let after1 = 0n, after0 = 0n;
  for (;;) {
    after1 = decodeUint256(await viaPipe('eth_call', [{to: tokenAddress, data: encodeErc20BalanceOf(ACCOUNT_1)}, 'latest']));
    after0 = decodeUint256(await viaPipe('eth_call', [{to: tokenAddress, data: encodeErc20BalanceOf(staged.deployer)}, 'latest']));
    if (after1 === AMOUNT_RAW && before0 - after0 === AMOUNT_RAW) break;
    if (Date.now() > deadline) {
      assert(after1 === AMOUNT_RAW, `recipient balance ${after1} != transferred ${AMOUNT_RAW} (past the 2s read-cache TTL)`);
      assert(before0 - after0 === AMOUNT_RAW, `sender delta ${before0 - after0} != ${AMOUNT_RAW}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // 7. the log — history's raw material — fetched through the pipe and DECODED.
  const logs = await viaPipe('eth_getLogs', [{
    fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    address: tokenAddress, topics: [TRANSFER_TOPIC],
  }]);
  const decoded = logs.map(decodeTransferLog).find((d) => d != null && d.to.toLowerCase() === ACCOUNT_1.toLowerCase());
  assert(decoded != null, 'no decoded Transfer log for the recipient in the tx block');
  assert(decoded.from.toLowerCase() === from.toLowerCase(), `Transfer.from ${decoded.from} != sender ${from}`);
  assert(decoded.value === AMOUNT_RAW, `Transfer.value ${decoded.value} != ${AMOUNT_RAW}`);

  console.log('[pipe-smoke] PASS — full transfer round trip through the relay pipe:');
  console.log(`  chain 31337 · token ${tokenAddress}`);
  console.log(`  ${from} → ${ACCOUNT_1} · ${AMOUNT_RAW} raw (1.2345 ZCHF) · tx ${sentHash}`);
  console.log(`  balances before/after verified · Transfer log decoded (from/to/value all match)`);
  process.exitCode = 0;
} catch (e) {
  console.error(`[pipe-smoke] FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  try { await relay?.stop(); } catch {}
  try { await staged.stop(); } catch {}
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { relay?.stop(); staged.stop(); } catch {} process.exit(130); });
