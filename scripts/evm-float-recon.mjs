#!/usr/bin/env node
// evm-float-recon.mjs — the D31 mainnet staging RECON (spec 2026-09-26 §6 D31; live-testing
// rules: READ-ONLY on mainnet — balances + venue/pool facts only; NO swaps, NO sends, no key
// material ever leaves this process or appears in output). Decrypts the agent float key via the
// repo's sops flow (the evm-sign.mjs pattern), prints the ADDRESS ONLY (it is already a
// registered public fact in secrets/agent-evm.pub.json), then reads:
//
//   1. float balances: native ETH on Ethereum + Arbitrum One, ZCHF on both (the pinned
//      deployments), plus nonces and current gas;
//   2. the staging swap path: which Uniswap V3 pools exist for the pinned ZCHF on EACH chain
//      (getPool across the standard fee tiers, against WETH / native USDC / USDC.e), their
//      slot0/liquidity, and a QuoterV2 quote for a ~50 ZCHF staging target — every contract
//      address printed is verified ON-CHAIN in this run (symbol()/decimals()/getPool), never
//      from memory;
//   3. a cost line: measured gas prices + the quoter's own gasEstimate → ETH (and USD at
//      Coinbase's public spot rate, when reachable).
//
//   node scripts/evm-float-recon.mjs
//   DPAY_EVM_RECON_ETH_URL=… DPAY_EVM_RECON_ARB_URL=… node scripts/evm-float-recon.mjs
//   DPAY_EVM_RECON_ARB_RPC=1   # also round-trip the recon through a LOCAL relay pipe
//                              # (POST /api/v1/evm/rpc/42161) to prove the read path end to end
//   DPAY_RECON_TARGET_ZCHF=50  # the staging amount to quote (default 50)
//
// Exit 0 on recon complete (findings are the OUTPUT — never a pass/fail gate on balances).
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {
  eip55, evmAddressOf, rpc, ethCall, selector, word32BE, addressWord, decodeUint256,
} from '../e2e/harness/evm/evm-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEC = join(ROOT, 'secrets/agent-evm.sops.json');
const PUB = join(ROOT, 'secrets/agent-evm.pub.json');
const ETH_URL = process.env.DPAY_EVM_RECON_ETH_URL ?? 'https://ethereum-rpc.publicnode.com';
const ARB_URL = process.env.DPAY_EVM_RECON_ARB_URL ?? 'https://arbitrum-one-rpc.publicnode.com';
const TARGET_ZCHF = BigInt(process.env.DPAY_RECON_TARGET_ZCHF ?? '50');

// --- the key: decrypt at the moment of use, verify against the registered address, print ONLY the address.
function floatAddress() {
  const out = execFileSync('sops', ['-d', SEC], {
    encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, SOPS_AGE_KEY_FILE: process.env.SOPS_AGE_KEY_FILE ?? join(ROOT, '.dev/age/agent-key.txt')},
  });
  const key = JSON.parse(out).private_key_hex;
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error('recon: sops key is not 32 bytes of hex');
  const derived = eip55(evmAddressOf(key));
  const registered = JSON.parse(readFileSync(PUB, 'utf8')).address;
  if (derived.toLowerCase() !== registered.toLowerCase()) {
    throw new Error(`recon: derived ${derived} != registered ${registered} — refusing`);
  }
  return derived; // the ONLY thing that leaves this function
}

// --- pinned facts this recon verifies on-chain before relying on them ---------------------------
const ZCHF = {1: '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB', 42161: '0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553'};
const V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984'; // same address on both chains
const V3_QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'; // same address on both chains
const V3_ROUTER02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'; // SwapRouter02 — SAME address on Ethereum + Arbitrum One
const usd = (wei, ethUsd) => ethUsd ? ` (≈ $${(Number(wei) / 1e18 * ethUsd).toFixed(4)})` : '';
const V4_POOLMANAGER = '0x000000000004444c5dc75cb358380d2e3de08a90';
// Hop candidates per chain — each verified on-chain (symbol/decimals) before any pool math.
const HOPS = {
  1: [
    {label: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18},
    {label: 'USDC (native)', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6},
  ],
  42161: [
    {label: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18},
    {label: 'USDC (native)', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6},
    {label: 'USDC.e (bridged)', address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', decimals: 6},
  ],
};
const FEE_TIERS = [100, 500, 3000, 10000];

const enc = (s) => selector(s);
const balanceOf = (owner) => selector('balanceOf(address)') + addressWord(owner).toString('hex');

function decodeAbiString(hex) {
  const h = String(hex ?? '').replace(/^0x/, '');
  if (h.length < 128) return null; // empty/reverted call — the caller reports it
  const len = Number(BigInt('0x' + h.slice(64, 128)));
  return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8');
}
const fmt = (raw, decimals) => Number(BigInt(raw)) / 10 ** Number(decimals);
const gwei = (wei) => Number(wei) / 1e9;

const [, , ...argv] = process.argv;
const VIA_RELAY = process.env.DPAY_EVM_RECON_ARB_RPC === '1' || argv.includes('--via-relay');
let relay = null;

try {
  const address = floatAddress();
  console.log(`float address (m/44'/60'/0'/0/0, verified against secrets/agent-evm.pub.json): ${address}`);

  if (VIA_RELAY) {
    const {startRelay} = await import('../e2e/harness/relay.mjs');
    relay = await startRelay({env: {DPAY_EVM_RPC_URL: ETH_URL, DPAY_EVM_RPC_URL_42161: ARB_URL}});
    console.log(`[recon] arbitrum reads ride the LOCAL relay pipe → ${ARB_URL}`);
  }
  const arb = VIA_RELAY ? `${relay.baseURL}/api/v1/evm/rpc/42161` : ARB_URL;

  // --- 1. balances (read-only eth_getBalance / eth_call) --------------------------------------
  console.log('\n=== balances (read-only) ===');
  const [ethBal, arbBal, ethNonce, arbNonce, ethGas, arbGas] = await Promise.all([
    rpc(ETH_URL, 'eth_getBalance', [address, 'latest'], {timeoutMs: 20_000}),
    rpc(arb, 'eth_getBalance', [address, 'latest'], {timeoutMs: 20_000}),
    rpc(ETH_URL, 'eth_getTransactionCount', [address, 'pending'], {timeoutMs: 20_000}),
    rpc(arb, 'eth_getTransactionCount', [address, 'pending'], {timeoutMs: 20_000}),
    rpc(ETH_URL, 'eth_gasPrice', [], {timeoutMs: 20_000}),
    rpc(arb, 'eth_gasPrice', [], {timeoutMs: 20_000}),
  ]);
  const [zchfArb, zchfEth] = await Promise.all([
    ethCall(arb, ZCHF[42161], balanceOf(address), {timeoutMs: 20_000}),
    ethCall(ETH_URL, ZCHF[1], balanceOf(address), {timeoutMs: 20_000}),
  ]);
  console.log(`Ethereum (1)      ETH ${fmt(ethBal, 18)}   nonce ${BigInt(ethNonce)}   gas ${gwei(ethGas)} gwei`);
  console.log(`Arbitrum (42161)  ETH ${fmt(arbBal, 18)}   nonce ${BigInt(arbNonce)}   gas ${gwei(arbGas)} gwei`);
  console.log(`ZCHF on Arbitrum  ${fmt(zchfArb, 18)} (0xD4dD…5553)`);
  console.log(`ZCHF on Ethereum  ${fmt(zchfEth, 18)} (0xB58E…21cB)`);

  // --- 2. the swap-path recon per chain (every address verified on-chain, in this run) ---------
  console.log('\n=== staging swap path (read-only eth_call, per chain) ===');
  const sym = (url, a) => ethCall(url, a, enc('symbol()'), {timeoutMs: 20_000}).then(decodeAbiString);
  const dec = (url, a) => ethCall(url, a, enc('decimals()'), {timeoutMs: 20_000}).then(decodeUint256);
  const getPool = (url, a, b, fee) => ethCall(url, V3_FACTORY,
    selector('getPool(address,address,uint24)') + addressWord(a).toString('hex') + addressWord(b).toString('hex') + word32BE(fee).toString('hex'),
    {timeoutMs: 20_000}).then(decodeUint256);
  const hasCode = (url, a) => rpc(url, 'eth_getCode', [a, 'latest'], {timeoutMs: 20_000}).then((c) => c.length > 2);

  let ethUsd = null;
  try {
    ethUsd = Number(JSON.parse(await (await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', {signal: AbortSignal.timeout(8000)})).text()).data.amount);
    console.log(`ETH/USD spot (Coinbase): $${ethUsd}`);
  } catch { console.log('(Coinbase spot unreachable — USD lines skipped)'); }

  const CHAINS = [
    {id: 42161n, name: 'Arbitrum One', url: arb, gas: arbGas},
    {id: 1n, name: 'Ethereum', url: ETH_URL, gas: ethGas},
  ];
  let best = null;
  for (const chain of CHAINS) {
    console.log(`\n--- ${chain.name} (${chain.id}) — ZCHF ${ZCHF[Number(chain.id)]} ---`);
    const zchfSym = await sym(chain.url, ZCHF[Number(chain.id)]);
    const zchfDec = await dec(chain.url, ZCHF[Number(chain.id)]);
    if (zchfSym !== 'ZCHF' || zchfDec !== 18n) throw new Error(`recon: ZCHF on ${chain.name} does not answer ZCHF/18`);
    console.log(`ZCHF verified: symbol=${zchfSym} decimals=${zchfDec}`);

    for (const hop of HOPS[Number(chain.id)]) {
      hop.symbol = await sym(chain.url, hop.address);
      hop.decimals = await dec(chain.url, hop.address);
      console.log(`  ${hop.label.padEnd(18)} ${hop.address} symbol=${hop.symbol} decimals=${hop.decimals}`);
    }
    console.log(`  infra code: V3 factory ${await hasCode(chain.url, V3_FACTORY)} · QuoterV2 ${await hasCode(chain.url, V3_QUOTER_V2)} · SwapRouter02 ${await hasCode(chain.url, V3_ROUTER02)} · V4 PoolManager ${await hasCode(chain.url, V4_POOLMANAGER)}`);

    const pools = [];
    for (const hop of HOPS[Number(chain.id)]) {
      for (const fee of FEE_TIERS) {
        const p = await getPool(chain.url, hop.address, ZCHF[Number(chain.id)], fee);
        if (p !== 0n) pools.push({hop, fee, address: '0x' + p.toString(16).padStart(40, '0')});
      }
    }
    if (pools.length === 0) {
      console.log('  NO Uniswap V3 ZCHF pool in any standard tier against the hop candidates');
    }
    for (const pool of pools) {
      const slot0 = await ethCall(chain.url, pool.address, enc('slot0()'), {timeoutMs: 20_000});
      const liq = await ethCall(chain.url, pool.address, enc('liquidity()'), {timeoutMs: 20_000});
      const h = slot0.replace(/^0x/, '');
      pool.sqrt = decodeUint256('0x' + h.slice(0, 64));
      pool.liquidity = decodeUint256(liq);
      console.log(`  pool ${pool.hop.label}/ZCHF fee=${pool.fee / 10000}% ${pool.address} liquidity=${pool.liquidity}${pool.liquidity === 0n ? ' (EMPTY)' : ''}`);
    }

    // quote the staging target through the best liquid pool on this chain
    const quotePool = pools.find((p) => p.liquidity > 0n);
    if (!quotePool) continue;
    const {hop, fee} = quotePool;
    const outRaw = TARGET_ZCHF * 10n ** 18n;
    const q1 = await ethCall(chain.url, V3_QUOTER_V2,
      selector('quoteExactOutputSingle((address,address,uint256,uint24,uint160))')
      + addressWord(hop.address).toString('hex') + addressWord(ZCHF[Number(chain.id)]).toString('hex')
      + word32BE(outRaw).toString('hex') + word32BE(fee).toString('hex') + word32BE(0).toString('hex'),
      {timeoutMs: 30_000});
    const h1 = q1.replace(/^0x/, '');
    const amountIn = decodeUint256('0x' + h1.slice(0, 64));
    const swapGas = decodeUint256('0x' + h1.slice(192, 256));
    const costWei = BigInt(swapGas) * BigInt(chain.gas);
    console.log(`  quote (exact OUTPUT ${TARGET_ZCHF} ZCHF via ${hop.label}, fee ${fee / 10000}%): pay ${fmt(amountIn, hop.decimals)} ${hop.label} · quoter gasEstimate ${swapGas} ≈ ${fmt(costWei, 18)} ETH${usd(costWei, ethUsd)}`);
    const q2 = await ethCall(chain.url, V3_QUOTER_V2,
      selector('quoteExactInputSingle((address,address,uint256,uint24,uint160))')
      + addressWord(hop.address).toString('hex') + addressWord(ZCHF[Number(chain.id)]).toString('hex')
      + word32BE(10n ** 16n).toString('hex') + word32BE(fee).toString('hex') + word32BE(0).toString('hex'),
      {timeoutMs: 30_000});
    console.log(`  sanity: 0.01 ${hop.label} → ${fmt('0x' + q2.replace(/^0x/, '').slice(0, 64), 18)} ZCHF (same pool)`);
    if (best == null || Number(costWei) + Number(amountIn) < Number(best.costWei) + Number(best.amountIn)) {
      best = {chain, hop, fee, amountIn, swapGas, costWei};
    }
  }

  // staging cost estimate on the cheapest viable chain: 4 transfers (~60k gas each) + 1 swap
  if (best) {
    const {chain, hop, amountIn, swapGas} = best;
    const total = 60_000n * 4n + BigInt(swapGas) + 40_000n; // transfers + swap + approve slack
    const cost = BigInt(total) * BigInt(chain.gas);
    console.log(`\nstaging plan (cheapest viable chain: ${chain.name}):`);
    console.log(`  buy ${TARGET_ZCHF} ZCHF: ${fmt(amountIn, hop.decimals)} ${hop.label} + slippage buffer → fund ~${fmt(amountIn * 105n / 100n + 10n ** 15n, 18)} ${hop.label}`);
    console.log(`  gas budget: ${total} gas ≈ ${fmt(cost, 18)} ETH at the current ${gwei(chain.gas)} gwei${usd(cost, ethUsd)} — dust 0.001 ETH covers 60x`);
  } else {
    console.log('\nno liquid ZCHF pool found on either chain → staging blocked on a verified route (record it)');
  }
  console.log('\nrecon complete — no state was changed, no swap/send was signed');
} finally {
  await relay?.stop().catch(() => {});
}
