#!/usr/bin/env node
// evm-probe-zchf-mainnet.mjs — the D30 custody-semantics gate as a standing tripwire (spec
// 2026-09-26 §6 D30; first run 2026-09-26, receipts in the spec's addendum 1). READ-ONLY,
// KEYLESS, OPT-IN: signed queries only against public RPC endpoints, never in verify/check
// (needs the network — the inner loop is offline by design).
//
//   node scripts/evm-probe-zchf-mainnet.mjs
//   DPAY_EVM_PROBE_ETH_URL=… DPAY_EVM_PROBE_ARB_URL=… node scripts/evm-probe-zchf-mainnet.mjs
//
// For BOTH pinned ZCHF deployments (Ethereum 0xB58E…21cB, Arbitrum One 0xD4dD…5553) it asserts:
//   1. eth_chainId is the chain the catalog pins (1 / 42161);
//   2. symbol() == 'ZCHF' and decimals() == 18 (the ERC-20 facts the app's registry carries);
//   3. balanceOf(0x0) == 0 (the token answers, and answers zero at a zero address — no
//      proxy/mint-account weirdness);
//   4. DOMAIN_SEPARATOR() == the LOCALLY COMPUTED MINIMAL-domain separator
//      (ERC20PermitLight: no name/version — spec addendum 1). A mismatch means the permit
//      domain kind in app/evm/chains.ts is wrong and permit signing is BLOCKED until fixed;
//   5. both address literals byte-match dfx/catalog_truth.json (the drift alarm's own source).
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {
  ethCall, selector, decodeUint256, domainSeparatorMinimal,
} from '../e2e/harness/evm/evm-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ZERO = '0x' + '0'.repeat(40);

const ETH_URL = process.env.DPAY_EVM_PROBE_ETH_URL ?? 'https://ethereum-rpc.publicnode.com';
const ARB_URL = process.env.DPAY_EVM_PROBE_ARB_URL ?? 'https://arb1.arbitrum.io/rpc';

// The relay's catalog consts are the pins under test (dfx/catalog_truth.json cross-checks them).
const truth = JSON.parse(readFileSync(join(ROOT, 'dfx/catalog_truth.json'), 'utf8'));
const ROWS = [
  {chain: 'Ethereum', chainId: 1n, url: ETH_URL, address: truth.erc20_contracts.zchf_ethereum, truthKey: 'zchf_ethereum'},
  {chain: 'Arbitrum One', chainId: 42161n, url: ARB_URL, address: truth.erc20_contracts.zchf_arbitrum, truthKey: 'zchf_arbitrum'},
];

/** Decode an ABI-encoded string return (offset 0x20, length word, bytes). */
function decodeAbiString(hex) {
  const h = hex.replace(/^0x/, '');
  const len = Number(BigInt('0x' + h.slice(64, 128)));
  return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8');
}

let failed = 0;
const assert = (ok, msg) => {
  if (!ok) { failed++; console.error(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`);
};

for (const row of ROWS) {
  console.log(`[${row.chain}] ${row.address}`);
  assert(row.address === truth.erc20_contracts[row.truthKey], 'address matches dfx/catalog_truth.json');

  const answered = BigInt(await rpc_(row.url, 'eth_chainId'));
  assert(answered === row.chainId, `eth_chainId == ${row.chainId}`);

  const symbol = decodeAbiString(await ethCall(row.url, row.address, selector('symbol()')));
  assert(symbol === 'ZCHF', `symbol() == ZCHF (got ${JSON.stringify(symbol)})`);

  const decimals = decodeUint256(await ethCall(row.url, row.address, selector('decimals()')));
  assert(decimals === BigInt(truth.decimals.zchf) && decimals === 18n, `decimals() == 18`);

  const zero = decodeUint256(await ethCall(row.url, row.address, encodeBalanceOf(ZERO)));
  assert(zero === 0n, 'balanceOf(0x0) == 0');

  const onChain = await ethCall(row.url, row.address, selector('DOMAIN_SEPARATOR()'));
  const local = domainSeparatorMinimal({chainId: row.chainId, verifyingContract: row.address});
  assert(onChain.toLowerCase() === local.toLowerCase(),
    'DOMAIN_SEPARATOR() == the MINIMAL domain (ERC20PermitLight — permit signing is legal)');
}
if (failed > 0) {
  console.error(`\nevm-probe-zchf-mainnet: ${failed} check(s) FAILED — fix the pin before signing permits against this token`);
  process.exit(1);
}
console.log('\nevm-probe-zchf-mainnet: PASS — both deployments answer the pinned facts, minimal permit domain verified');

// Local helpers (kept beside the asserts so the file reads top-down).
function encodeBalanceOf(owner) { return selector('balanceOf(address)') + owner.replace(/^0x/, '').toLowerCase().padStart(64, '0'); }
async function rpc_(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
