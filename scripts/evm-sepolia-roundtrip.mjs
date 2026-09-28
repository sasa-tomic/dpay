#!/usr/bin/env node
// evm-sepolia-roundtrip.mjs — the D29 FUNDED half: a REAL Arbitrum Sepolia round trip THROUGH
// the relay pipe (spec 2026-09-26 §6 D29; the pipe-smoke shape, live). STATUS 2026-09-27:
// written + the unfunded path exercised, but never executed — BLOCKED ON FAUCET GAS (see
// docs/live-testing/networks.md: every no-login faucet refuses an address without mainnet ETH
// and the agent float is empty). Run this the moment the dev address holds Sepolia ETH:
//
//   node scripts/evm-sepolia-roundtrip.mjs                                  # deploys MockZCHF first
//   DPAY_EVM_SEPOLIA_TOKEN=<0x…> node scripts/evm-sepolia-roundtrip.mjs     # reuses that token
//
// Every app-like call dials the harness relay's POST /api/v1/evm/rpc/421614 (upstream
// DPAY_EVM_RPC_URL_421614, catalog row gated by DPAY_EVM_SEPOLIA_TOKEN — both halves of the
// dev-token env-row mechanism re-asserted here). Signing is evm-core.mjs — the SAME
// keccak/SLIP-10/EIP-1559 path the app ships; the device account resolves through the
// anvil.mjs env ladder (DPAY_EVM_DEVICE_KEY | DPAY_EVM_DEV_SEED | the documented valueless
// dev seed). The counterparty is the SAME seed at index 1 (m/44'/60'/0'/0/1) — harness-derived
// on both sides; a raw DPAY_EVM_DEVICE_KEY device has no seed to extend, so its counterparty
// is the well-known valueless anvil account #1. NEVER prints key material — addresses, hashes,
// numbers only.
//
// Sequence: chainId → gas preflight (honest refusal when unfunded) → [deploy MockZCHF] →
// relay boot (env row + pipe asserts) → native ETH drip device→counterparty (their gas) →
// ZCHF device→counterparty→device through the pipe → receipts, gas, latency, Transfer logs,
// balance deltas → getLogs range the public RPC tolerates (D29 item 4, for app/evm/chains.ts).
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {startRelay} from '../e2e/harness/relay.mjs';
import {
  eip55, evmAddressOf, keccak, rpc, ethCall, decodeUint256,
  signEip1559, sendRawRpc, sendRawAndWait, encodeErc20Transfer, encodeErc20BalanceOf,
  TRANSFER_TOPIC, decodeTransferLog, deriveSlip10Secp256k1Node,
} from '../e2e/harness/evm/evm-core.mjs';
import {resolveDeviceAccount, DEV_SEED} from '../e2e/harness/evm/anvil.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHAIN_ID = 421614n;
const RPC_URL = process.env.DPAY_EVM_SEPOLIA_RPC ?? 'https://sepolia-rollup.arbitrum.io/rpc';
const TOKEN_ENV = (process.env.DPAY_EVM_SEPOLIA_TOKEN ?? '').trim() || null;
const AMOUNT_RAW = 25n * 10n ** 18n; // 25 mock ZCHF each way
const DRIP_WEI = 10n ** 14n;         // 0.0001 native ETH for the counterparty's gas
const TIP = 10_000_000n;             // 0.01 gwei priority — lands with dust tips on Sepolia
const assert = (ok, msg) => { if (!ok) throw new Error(`sepolia-roundtrip: ${msg}`); };

// The committed MockZCHF blob, re-verified the same way anvil.mjs verifies it before deploying.
function readBlob() {
  const dir = join(ROOT, 'e2e', 'harness', 'evm');
  const hex = readFileSync(join(dir, 'MockZCHF.hex'), 'utf8').trim();
  const json = JSON.parse(readFileSync(join(dir, 'MockZCHF.json'), 'utf8'));
  const got = '0x' + keccak(Buffer.from(hex.slice(2), 'hex')).toString('hex');
  assert(json.bytecode_keccak256 === got, 'MockZCHF.hex does not match MockZCHF.json — the committed pair is half-updated');
  return hex;
}

// The device account (env ladder) + its counterparty (same seed, index 1).
const HARDENED = 0x80000000;
const IDX1 = [44, 60, 0].map((i) => i + HARDENED).concat([0, 1]);
function accounts() {
  const device = resolveDeviceAccount();
  assert(device.privHex != null, 'the device account must carry signing material — set DPAY_EVM_DEVICE_KEY or DPAY_EVM_DEV_SEED (a bare DPAY_EVM_DEV_ADDR cannot sign)');
  if (device.source === 'DPAY_EVM_DEVICE_KEY') {
    // A raw key has no seed to extend: use the well-known valueless anvil account #1 instead.
    const priv = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    return {device, counterparty: {address: eip55(evmAddressOf(priv)), privHex: priv, source: 'anvil well-known #1'}};
  }
  const seedHex = device.source === 'DPAY_EVM_DEV_SEED' ? process.env.DPAY_EVM_DEV_SEED : DEV_SEED;
  const leaf = deriveSlip10Secp256k1Node(Buffer.from(seedHex, 'hex'), IDX1);
  return {device, counterparty: {address: eip55(evmAddressOf(leaf.privateKey.toString('hex'))), privHex: leaf.privateKey.toString('hex'), source: `${device.source} @ m/44'/60'/0'/0/1`}};
}

// One signed type-2 tx to ANY url (upstream for the deploy, the pipe for everything else).
async function sendTx(url, {privHex, to = null, data = '0x', value = 0n, gasLimit}) {
  const from = eip55(evmAddressOf(privHex));
  const nonce = BigInt(await rpc(url, 'eth_getTransactionCount', [from, 'pending'], {timeoutMs: 20_000}));
  const head = await rpc(url, 'eth_getBlockByNumber', ['latest', false], {timeoutMs: 20_000});
  const maxFeePerGas = BigInt(head.baseFeePerGas) * 4n + TIP;
  const {rawTx, txHash} = signEip1559({privHex, chainId: CHAIN_ID, nonce, maxFeePerGas, maxPriorityFeePerGas: TIP, gasLimit, to, value, data});
  const t0 = Date.now();
  const {hash, receipt, reverted} = await sendRawAndWait(url, rawTx, {timeoutMs: 180_000, pollMs: 1_000});
  assert(!reverted, `tx ${txHash} REVERTED (status ${receipt.status})`);
  return {hash, receipt, latencyMs: Date.now() - t0, gasUsed: BigInt(receipt.gasUsed), gasPrice: BigInt(receipt.effectiveGasPrice ?? maxFeePerGas)};
}

const ethBalance = (url, owner) => rpc(url, 'eth_getBalance', [owner, 'latest'], {timeoutMs: 20_000}).then((h) => BigInt(h));
const balanceOf = (pipe, token, owner) => ethCall(pipe, token, encodeErc20BalanceOf(owner), {timeoutMs: 20_000}).then(decodeUint256);
const gwei = (w) => `${Number(w) / 1e9} gwei`;

let relay = null;
try {
  const {device, counterparty} = accounts();
  // 1. preflight — the chain is Sepolia and the device holds gas
  assert(BigInt(await rpc(RPC_URL, 'eth_chainId', [], {timeoutMs: 20_000})) === CHAIN_ID, 'upstream eth_chainId != 421614');
  const deviceEth = await ethBalance(RPC_URL, device.address);
  if (deviceEth === 0n) {
    console.error(`[sepolia-roundtrip] BLOCKED ON GAS: ${device.address} holds no Arbitrum Sepolia ETH.`);
    console.error('  Fund it at any faucet, then re-run. Faucet status 2026-09-27: every no-login');
    console.error('  faucet refuses a zero-mainnet-balance address and the agent float is empty —');
    console.error('  docs/live-testing/networks.md has the dated dead-end log.');
    process.exit(1);
  }
  console.log(`[sepolia-roundtrip] device ${device.address} (${device.source}) gas ${Number(deviceEth) / 1e18} ETH`);
  console.log(`[sepolia-roundtrip] counterparty ${counterparty.address} (${counterparty.source})`);

  // 2. token: reuse or deploy (deploy goes straight to the upstream — the relay boots below)
  let token = TOKEN_ENV;
  if (token) {
    const code = await rpc(RPC_URL, 'eth_getCode', [token, 'latest'], {timeoutMs: 20_000});
    assert(code.length > 2, `DPAY_EVM_SEPOLIA_TOKEN ${token} has no code on 421614`);
    console.log(`[sepolia-roundtrip] reusing token ${token}`);
  } else {
    const dep = await sendTx(RPC_URL, {privHex: device.privHex, data: readBlob(), gasLimit: 3_200_000n});
    token = eip55(dep.receipt.contractAddress);
    console.log(`[sepolia-roundtrip] MockZCHF deployed ${token} · tx ${dep.hash} · gas ${dep.gasUsed} · ${dep.latencyMs}ms`);
    console.log(`[sepolia-roundtrip] → for the app/probe: export DPAY_EVM_SEPOLIA_TOKEN=${token}`);
  }

  // 3. relay boot with BOTH halves of the dev-token env-row mechanism engaged
  relay = await startRelay({env: {DPAY_EVM_RPC_URL_421614: RPC_URL, DPAY_EVM_SEPOLIA_TOKEN: token}});
  const pipe = `${relay.baseURL}/api/v1/evm/rpc/421614`;
  const cats = JSON.parse(await (await fetch(`${relay.baseURL}/api/v1/currencies`)).text());
  const sec = (cats.networks ?? []).find((n) => n.protocol === 'evm' && n.name === 'Arbitrum Sepolia');
  assert(sec?.environment === 'testnet' && sec.assets?.some((a) => a.chain_id === 421614 && a.address?.toLowerCase() === token.toLowerCase()),
    'the served catalog must carry the Arbitrum Sepolia TESTNET row at the deployed token');
  assert(BigInt(await rpc(pipe, 'eth_chainId', [], {timeoutMs: 20_000})) === CHAIN_ID, 'pipe eth_chainId != 421614');
  console.log(`[sepolia-roundtrip] relay pipe ${pipe} — catalog row + pipe chainId verified`);

  // 4. native drip device → counterparty (their gas for the return leg)
  let drip = null;
  if ((await ethBalance(pipe, counterparty.address)) < DRIP_WEI) {
    drip = await sendTx(pipe, {privHex: device.privHex, to: counterparty.address, value: DRIP_WEI, gasLimit: 26_000n});
    console.log(`[sepolia-roundtrip] native drip ${DRIP_WEI} wei → tx ${drip.hash} · gas ${drip.gasUsed} · ${drip.latencyMs}ms`);
  }

  // 5. the ZCHF round trip, both legs THROUGH the pipe
  const before0 = await balanceOf(pipe, token, device.address);
  const before1 = await balanceOf(pipe, token, counterparty.address);
  assert(before0 > AMOUNT_RAW, `device holds ${before0} mock-ZCHF raw — the deployer should be minted the supply; fund or redeploy`);
  const leg1 = await sendTx(pipe, {privHex: device.privHex, to: token, data: encodeErc20Transfer(counterparty.address, AMOUNT_RAW), gasLimit: 80_000n});
  const mid0 = await balanceOf(pipe, token, device.address);
  const mid1 = await balanceOf(pipe, token, counterparty.address);
  assert(before0 - mid0 === AMOUNT_RAW && mid1 - before1 === AMOUNT_RAW, 'leg-1 balance deltas wrong');
  const leg2 = await sendTx(pipe, {privHex: counterparty.privHex, to: token, data: encodeErc20Transfer(device.address, AMOUNT_RAW), gasLimit: 80_000n});
  const after0 = await balanceOf(pipe, token, device.address);
  const after1 = await balanceOf(pipe, token, counterparty.address);
  assert(after0 === before0 && after1 === before1, 'the round trip must restore both balances');

  // 6. the Transfer logs, decoded (history's raw material)
  const logs = await rpc(pipe, 'eth_getLogs', [{
    fromBlock: leg1.receipt.blockNumber, toBlock: leg2.receipt.blockNumber, address: token, topics: [TRANSFER_TOPIC],
  }], {timeoutMs: 30_000});
  const decoded = logs.map(decodeTransferLog).filter((d) => d != null && d.value === AMOUNT_RAW);
  assert(decoded.some((d) => d.to.toLowerCase() === counterparty.address.toLowerCase()), 'no decoded Transfer for the counterparty leg');
  assert(decoded.some((d) => d.to.toLowerCase() === device.address.toLowerCase()), 'no decoded Transfer for the device leg');

  // 7. getLogs range the public RPC tolerates (D29 item 4 — feeds app/evm/chains.ts logPageSize)
  const head = BigInt(await rpc(pipe, 'eth_blockNumber', [], {timeoutMs: 20_000}));
  let tolerated = 0;
  for (const range of [10_000, 50_000, 200_000]) {
    try {
      await rpc(pipe, 'eth_getLogs', [{fromBlock: '0x' + (head - BigInt(range)).toString(16), toBlock: 'latest', address: token, topics: [TRANSFER_TOPIC]}], {timeoutMs: 30_000});
      tolerated = range;
    } catch { break; }
  }

  console.log('\n[sepolia-roundtrip] PASS — record block:');
  console.log(JSON.stringify({
    chain: 'arbitrum-sepolia', chainId: 421614, rpc: RPC_URL,
    device: device.address, counterparty: counterparty.address, token,
    drip: drip ? {tx: drip.hash, gasUsed: drip.gasUsed.toString(), latencyMs: drip.latencyMs} : '(counterparty already funded)',
    leg1_deviceToCounterparty: {tx: leg1.hash, gasUsed: leg1.gasUsed.toString(), latencyMs: leg1.latencyMs, gasPrice: gwei(leg1.gasPrice)},
    leg2_counterpartyToDevice: {tx: leg2.hash, gasUsed: leg2.gasUsed.toString(), latencyMs: leg2.latencyMs, gasPrice: gwei(leg2.gasPrice)},
    transferLogsDecoded: decoded.length,
    getLogsRangeToleratedBlocks: tolerated,
  }, null, 2));
  process.exitCode = 0;
} catch (e) {
  console.error(`[sepolia-roundtrip] FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  try { await relay?.stop(); } catch {}
}
