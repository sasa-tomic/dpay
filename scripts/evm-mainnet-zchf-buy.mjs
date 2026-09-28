#!/usr/bin/env node
// evm-mainnet-zchf-buy.mjs — the D31 RECEIVE leg: the EVM rail address buys REAL ZCHF on
// Ethereum MAINNET with native ETH through Uniswap V3 (SwapRouter02), broadcast THROUGH the
// dpay relay's production EVM pipe (POST /api/v1/evm/rpc — chain 1, upstream DPAY_EVM_RPC_URL).
// The harness twin of what a user's device signs; the same keccak/SLIP-10/EIP-1559 stack the
// app ships (e2e/harness/evm/evm-core.mjs — NO ethers/web3).
//
//   node scripts/evm-mainnet-zchf-buy.mjs [zchfAmount] [relayBase]
//     zchfAmount  default 1.5 — the exact-output buy size (float rule: smallest sensible)
//     relayBase   default http://127.0.0.1:8899 — the LOCAL main-HEAD relay (pipe must carry
//                 DPAY_EVM_RPC_URL; verified eth_chainId=0x1 before anything signs)
//
// Sequence: pipe chainId gate → rail key from the IC float seed (SLIP-10 m/44'/60'/0'/0/0,
// decrypted IN-PROCESS, never printed) → QuoterV2 exact-output quote (free eth_call) →
// multicall(exactOutputSingle, refundETH) signed + broadcast via the pipe → receipt, gas,
// latency → balanceOf deltas + decoded Transfer log → honest FAIL on any gate (the caller
// ledgers whatever landed; a reverted buy burns gas and must be recorded, never retried
// blind — float rule).
import {execFileSync} from 'node:child_process';
import {
  rpc, ethCall, decodeUint256, signEip1559, sendRawRpc,
  encodeErc20BalanceOf, encodeTransferFrom, decodeTransferLog, TRANSFER_TOPIC,
  deriveEvmKeypair, eip55, selector, addressWord, word32BE,
} from '../e2e/harness/evm/evm-core.mjs';

const ZCHF_ETH = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB'; // real ZCHF on Ethereum (catalog pin)
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';   // Uniswap SwapRouter02 (Ethereum)
const QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';   // Uniswap QuoterV2 (Ethereum)
const POOL_FEE = 3000;                                          // ZCHF/WETH 0.3% (0x79dc…f083)
const CHAIN_ID = 1n;
const TIP_GWEI = 500_000_000n; // 0.5 gwei priority — lands in the next few blocks at calm gas
const GAS_LIMIT = 400_000n;
const SLIPPAGE_NUM = 105n; // amountInMaximum = quote × 1.05 (5% headroom; pegged pair)
const MIN_GAS_DUST = 500_000_000_000_000n; // keep ≥ 0.0005 ETH for the later legs

const assert = (ok, msg) => { if (!ok) throw new Error(`evm-buy: ${msg}`); };
const gwei = (w) => `${Number(w) / 1e9} gwei`;

/** The rail key from the float seed — decrypted inside this process only. */
function railKey() {
  const seed = execFileSync('node', ['scripts/agent-key.mjs', 'seed'],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  assert(/^[0-9a-f]{64}$/i.test(seed), 'agent-key seed did not return 64 hex chars — refusing');
  const kp = deriveEvmKeypair(seed);
  seed.replace(/./g, '0');
  return kp; // {privateKeyHex, address}
}

/** encodeExactOutputSingle(params tuple) calldata (SwapRouter02). */
function encodeExactOutputSingle(p) {
  // exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
  const head = selector('exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))');
  return head
    + addressWord(p.tokenIn).toString('hex') + addressWord(p.tokenOut).toString('hex')
    + word32BE(p.fee).toString('hex') + addressWord(p.recipient).toString('hex')
    + word32BE(p.deadline).toString('hex') + word32BE(p.amountOut).toString('hex')
    + word32BE(p.amountInMaximum).toString('hex') + word32BE(p.sqrtPriceLimitX96).toString('hex');
}

/** multicall(bytes[]) over the given subcalls (SwapRouter02). */
function encodeMulticall(subcallsHex) {
  const head = selector('multicall(bytes[])');
  const data = subcallsHex.map((s) => s.replace(/^0x/, '')).join('');
  // offset 0x20 (64 hex chars), bytes length (64), payload padded to 32
  const offset = BigInt(32).toString(16).padStart(64, '0');
  const lenBytes = BigInt(data.length / 2).toString(16).padStart(64, '0');
  const padLen = Math.ceil(data.length / 64) * 64;
  const payload = (data + '0'.repeat(padLen - data.length));
  return '0x' + head + offset + lenBytes + payload;
}

const encodeRefundEth = () => '0x' + selector('refundETH()');
const encodeQuoteExactOutputSingle = encodeExactOutputSingle; // QuoterV2 takes the SAME tuple shape

let pipe = null;
try {
  const zchfOut = process.argv[2] ?? '1.5';
  assert(/^\d+(\.\d+)?$/.test(zchfOut), `bad amount ${zchfOut}`);
  const relayBase = (process.argv[3] ?? 'http://127.0.0.1:8899').replace(/\/+$/, '');
  pipe = `${relayBase}/api/v1/evm/rpc`;

  // 1. the pipe must PROVE it is chain 1 (the app's own wrong-chain gate, harness-side twin)
  assert(BigInt(await rpc(pipe, 'eth_chainId', [], {timeoutMs: 20_000})) === CHAIN_ID,
    'pipe eth_chainId != 0x1 — the relay has no Ethereum mainnet upstream (set DPAY_EVM_RPC_URL)');

  // 2. the rail key + funding state
  const rail = railKey();
  const nonce = BigInt(await rpc(pipe, 'eth_getTransactionCount', [rail.address, 'pending'], {timeoutMs: 20_000}));
  const head = await rpc(pipe, 'eth_getBlockByNumber', ['latest', false], {timeoutMs: 20_000});
  const baseFee = BigInt(head.baseFeePerGas);
  const ethWei = BigInt(await rpc(pipe, 'eth_getBalance', [rail.address, 'latest'], {timeoutMs: 20_000}));
  console.log(`[buy] rail ${rail.address} · ETH ${Number(ethWei) / 1e18} · nonce ${nonce} · base ${gwei(baseFee)}`);
  assert(ethWei > 0n, 'rail holds no ETH — fund it first (leg 1), refusing to sign');

  // 3. the QuoterV2 quote (free) — exact-output: how much ETH does 1.5 ZCHF cost?
  const amountOut = BigInt(Math.round(Number(zchfOut) * 1e6)) * 10n ** 12n; // decimal → 18 raw
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const quoteData = encodeQuoteExactOutputSingle({
    tokenIn: WETH, tokenOut: ZCHF_ETH, fee: POOL_FEE, recipient: rail.address,
    deadline, amountOut, amountInMaximum: 0n, sqrtPriceLimitX96: 0n,
  });
  const qRaw = await ethCall(pipe, QUOTER, quoteData, {timeoutMs: 30_000});
  // QuoterV2 returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)
  const amountIn = decodeUint256('0x' + qRaw.replace(/^0x/, '').slice(0, 64));
  const gasEstimate = decodeUint256('0x' + qRaw.replace(/^0x/, '').slice(192, 256));
  const amountInMaximum = amountIn * SLIPPAGE_NUM / 100n;
  console.log(`[buy] quote: ${zchfOut} ZCHF ← ${Number(amountIn) / 1e18} ETH (max ${Number(amountInMaximum) / 1e18}, router gas ≈ ${gasEstimate})`);
  assert(amountIn > 0n, 'quoter returned zero — no liquidity in the ZCHF/WETH pool?');
  assert(ethWei - amountInMaximum > MIN_GAS_DUST + GAS_LIMIT * (baseFee * 2n + TIP_GWEI),
    `buy would leave < gas dust: ETH ${ethWei}, max-in ${amountInMaximum} — shrink the size`);

  // 4. sign + broadcast multicall(exactOutputSingle, refundETH) THROUGH the pipe
  const callData = encodeMulticall([
    encodeExactOutputSingle({
      tokenIn: WETH, tokenOut: ZCHF_ETH, fee: POOL_FEE, recipient: rail.address,
      deadline, amountOut, amountInMaximum, sqrtPriceLimitX96: 0n,
    }),
    encodeRefundEth(),
  ]);
  const maxFeePerGas = baseFee * 4n + TIP_GWEI;
  const {rawTx, txHash} = signEip1559({
    privHex: rail.privateKeyHex, chainId: CHAIN_ID, nonce,
    maxFeePerGas, maxPriorityFeePerGas: TIP_GWEI, gasLimit: GAS_LIMIT,
    to: ROUTER, value: amountInMaximum, data: callData,
  });
  console.log(`[buy] broadcasting ${txHash} (msg.value ${Number(amountInMaximum) / 1e18} ETH, gasLimit ${GAS_LIMIT}, maxFee ${gwei(maxFeePerGas)})…`);
  const t0 = Date.now();
  await sendRawRpc(pipe, rawTx, {timeoutMs: 30_000});
  let receipt = null;
  for (;;) {
    receipt = await rpc(pipe, 'eth_getTransactionReceipt', [txHash], {timeoutMs: 20_000}).catch(() => null);
    if (receipt != null) break;
    if (Date.now() - t0 > 180_000) throw new Error(`receipt for ${txHash} never landed in 180s — record as unknown, DO NOT re-broadcast`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
  const latencyMs = Date.now() - t0;
  const gasUsed = BigInt(receipt.gasUsed);
  const effectiveGasPrice = BigInt(receipt.effectiveGasPrice ?? maxFeePerGas);
  const status = BigInt(receipt.status);
  console.log(`[buy] receipt: block ${BigInt(receipt.blockNumber)} · status ${status} · gas ${gasUsed} @ ${gwei(effectiveGasPrice)} · ${latencyMs}ms`);
  if (status !== 1n) {
    console.error(JSON.stringify({tx: txHash, status: 'REVERTED', gasBurnedWei: (gasUsed * effectiveGasPrice).toString()}, null, 2));
    process.exit(2); // the CALLER ledgers the burned gas — never a silent retry
  }

  // 5. verify: ZCHF balance delta + the decoded Transfer log + the ETH dust left
  const zchfWei = BigInt(await ethCall(pipe, ZCHF_ETH, encodeErc20BalanceOf(rail.address), {timeoutMs: 30_000}));
  const ethAfter = BigInt(await rpc(pipe, 'eth_getBalance', [rail.address, 'latest'], {timeoutMs: 20_000}));
  const logs = await rpc(pipe, 'eth_getLogs', [{
    fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
    address: ZCHF_ETH, topics: [TRANSFER_TOPIC],
  }], {timeoutMs: 30_000});
  const toRail = logs.map(decodeTransferLog).filter((d) => d != null && d.to.toLowerCase() === rail.address.toLowerCase());
  console.log('\n[buy] PASS — record block:');
  console.log(JSON.stringify({
    chain: 'ethereum', chainId: 1, rail: rail.address, router: ROUTER,
    boughtZchfRaw: amountOut.toString(),
    zchfBalanceNow: zchfWei.toString(),
    transferToRail: toRail.map((d) => ({from: d.from, value: d.value.toString()})),
    tx: txHash, block: receipt.blockNumber.toString(),
    ethInMaxWei: amountInMaximum.toString(),
    gasUsed: gasUsed.toString(), gasPriceGwei: gwei(effectiveGasPrice),
    gasCostWei: (gasUsed * effectiveGasPrice).toString(),
    latencyMs, ethDustLeftWei: ethAfter.toString(),
  }, null, 2));
  assert(zchfWei > 0n, 'ZCHF balance still zero after a successful swap — investigate before proceeding');
  assert(ethAfter >= MIN_GAS_DUST, `ETH dust below ${MIN_GAS_DUST} after the buy: ${ethAfter} — the later legs need gas`);
  process.exitCode = 0;
} catch (e) {
  console.error(`[buy] FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
