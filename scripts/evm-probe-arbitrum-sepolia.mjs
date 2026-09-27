#!/usr/bin/env node
// evm-probe-arbitrum-sepolia.mjs — the D29 free-path probe (spec 2026-09-26 §6 D29). READ-ONLY,
// KEYLESS, OPT-IN: signed queries only against public RPC endpoints, never in verify/check
// (needs the network — the inner loop is offline by design).
//
//   node scripts/evm-probe-arbitrum-sepolia.mjs
//   DPAY_EVM_PROBE_ARB_SEPOLIA_URL=… node scripts/evm-probe-arbitrum-sepolia.mjs
//   DPAY_EVM_SEPOLIA_TOKEN=… node scripts/evm-probe-arbitrum-sepolia.mjs   # after deploying MockZCHF
//
// ZCHF is ABSENT from Arbitrum Sepolia by design (no real Frankencoin exists on any testnet), so
// there is no pinned token to tripwire. Instead the probe asserts the things a Sepolia round trip
// actually stands on:
//   1. dfx/catalog_truth.json pins the chain id (421614) and pins NO ZCHF contract for it —
//      the fail-closed absence the catalog's dev-token rows build on;
//   2. the public RPC answers and IS Arbitrum Sepolia (eth_chainId == 421614);
//   3. the chain is ALIVE — eth_blockNumber advances at Arbitrum's ~250ms-1s cadence;
//   4. the dev-token env row mechanism: with DPAY_EVM_SEPOLIA_TOKEN set, the address at least
//      answers as a MockZCHF-shaped ERC-20PermitLight on-chain (code / symbol / decimals /
//      balanceOf(0) / the MINIMAL permit domain for THIS chain) — a wrong domain here means the
//      mock cannot stand in for ZCHF permit signing on 421614;
//   5. the relay halves of the same mechanism, booted from the harness build (the PIPE's chain
//      multiplexing is static — SERVED_CHAINS pins 421614 — while the catalog ROW is env-gated,
//      so the two halves assert different things):
//        a. NO envs at all → the catalog serves NO Arbitrum Sepolia section, the pipe answers
//           the honest 503 evm-unconfigured refusal naming DPAY_EVM_RPC_URL_421614 (never a
//           fake success), and an UNSERVED chain (11155111) is a 404 evm-unknown-chain;
//        b. upstream env only, still no token row → the pipe forwards eth_chainId for 421614
//          (the pipe serves the CHAIN; the token row gates only the asset);
//        c. token env SET → the catalog section appears with exactly that address.
//
// Human cross-checks (cast is NOT required by this script):
//   cast chain-id --rpc-url https://sepolia-rollup.arbitrum.io/rpc          # → 421614
//   cast block-number --rpc-url https://sepolia-rollup.arbitrum.io/rpc
//   cast call <token> "symbol()(string)" --rpc-url https://sepolia-rollup.arbitrum.io/rpc
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {
  ethCall, rpc, selector, decodeUint256, decodeTransferLog, domainSeparatorMinimal,
} from '../e2e/harness/evm/evm-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ZERO = '0x' + '0'.repeat(40);
const CHAIN_ID = 421614n;
const RPC = process.env.DPAY_EVM_PROBE_ARB_SEPOLIA_URL ?? 'https://sepolia-rollup.arbitrum.io/rpc';
const TOKEN = (process.env.DPAY_EVM_SEPOLIA_TOKEN ?? '').trim() || null;

let failed = 0;
let skipped = 0;
const assert = (ok, msg) => {
  if (!ok) { failed++; console.error(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`);
};
const skip = (msg) => { skipped++; console.log(`  - SKIP: ${msg}`); };

// --- 1. the truth file pins the chain and NO ZCHF for it --------------------------------------
console.log('[truth] dfx/catalog_truth.json');
const truth = JSON.parse(readFileSync(join(ROOT, 'dfx/catalog_truth.json'), 'utf8'));
assert(truth.chains?.arbitrum_sepolia === 421614, 'chains.arbitrum_sepolia == 421614');
assert(!('zchf_arbitrum_sepolia' in (truth.erc20_contracts ?? {})),
  'NO zchf pin for arbitrum_sepolia — ZCHF absent by design (dev-token env rows are the only Sepolia source)');

// --- 2+3. the public RPC answers, IS Sepolia, and the chain advances ---------------------------
console.log(`[rpc] ${RPC}`);
let chainId;
try {
  chainId = BigInt(await rpc(RPC, 'eth_chainId', [], {timeoutMs: 15_000}));
} catch (e) {
  console.error(`  ✗ RPC unreachable: ${e instanceof Error ? e.message : String(e)}`);
  console.error('\nevm-probe-arbitrum-sepolia: FAIL — the public RPC is unreachable; nothing else can be asserted');
  process.exit(1);
}
assert(chainId === CHAIN_ID, `eth_chainId == 421614 (got ${chainId})`);

const b1 = BigInt(await rpc(RPC, 'eth_blockNumber', [], {timeoutMs: 15_000}));
const BLOCK_POLL_MS = 2_500;
await new Promise((r) => setTimeout(r, BLOCK_POLL_MS));
const b2 = BigInt(await rpc(RPC, 'eth_blockNumber', [], {timeoutMs: 15_000}));
assert(b2 > b1, `eth_blockNumber advances (${b1} → ${b2} in ${(b2 - b1)} blocks / ${BLOCK_POLL_MS}ms)`);

const gasPrice = BigInt(await rpc(RPC, 'eth_gasPrice', [], {timeoutMs: 15_000}));
console.log(`  · eth_gasPrice ${gasPrice} wei (${Number(gasPrice) / 1e9} gwei — a ~60k transfer ≈ ${(Number(gasPrice) * 60_000) / 1e18} ETH)`);

// --- 4. the dev token itself (only when the operator engaged the mechanism) --------------------
if (TOKEN) {
  console.log(`[token] DPAY_EVM_SEPOLIA_TOKEN ${TOKEN}`);
  const code = await rpc(RPC, 'eth_getCode', [TOKEN, 'latest'], {timeoutMs: 15_000});
  assert(code != null && code !== '0x' && code.length > 4, 'eth_getCode non-empty — an actual contract');
  const symbol = decodeAbiString(await ethCall(RPC, TOKEN, selector('symbol()'), {timeoutMs: 15_000}));
  assert(symbol === 'ZCHF', `symbol() == ZCHF (got ${JSON.stringify(symbol)})`);
  const decimals = decodeUint256(await ethCall(RPC, TOKEN, selector('decimals()'), {timeoutMs: 15_000}));
  assert(decimals === 18n, 'decimals() == 18');
  const zero = decodeUint256(await ethCall(RPC, TOKEN, encodeBalanceOf(ZERO), {timeoutMs: 15_000}));
  assert(zero === 0n, 'balanceOf(0x0) == 0');
  const onChain = await ethCall(RPC, TOKEN, selector('DOMAIN_SEPARATOR()'), {timeoutMs: 15_000});
  const local = domainSeparatorMinimal({chainId: CHAIN_ID, verifyingContract: TOKEN});
  assert(onChain.toLowerCase() === local.toLowerCase(),
    'DOMAIN_SEPARATOR() == the MINIMAL domain for chain 421614 (permit signing is legal)');
} else {
  skip('DPAY_EVM_SEPOLIA_TOKEN unset — no dev token deployed/engaged; on-chain token checks need a funded deploy (scripts/evm-sepolia-roundtrip.mjs)');
}

// --- 5. the relay halves of the env-row mechanism (harness build; offline except the pipe) -----
console.log('[relay] the harness build\'s catalog + pipe behavior');
const {startRelay} = await import('../e2e/harness/relay.mjs');

// 5a. NO envs: no section, honest 503 on the served-but-unconfigured chain, 404 on an unserved one.
{
  const relay = await startRelay({env: {}});
  try {
    const cats = JSON.parse(await (await fetch(`${relay.baseURL}/api/v1/currencies`)).text());
    const sepoliaSections = (cats.networks ?? []).filter((n) => n.protocol === 'evm' && n.name === 'Arbitrum Sepolia');
    assert(sepoliaSections.length === 0, 'catalog: NO Arbitrum Sepolia section when DPAY_EVM_SEPOLIA_TOKEN is unset');
    const unconf = await pipeError(relay.baseURL, '421614', 'eth_chainId');
    assert(unconf?.code === 'evm-unconfigured' && (unconf?.detail ?? '').includes('DPAY_EVM_RPC_URL_421614'),
      `pipe 421614 with no upstream → 503 evm-unconfigured naming DPAY_EVM_RPC_URL_421614 (got ${JSON.stringify(unconf)})`);
    const unknown = await pipeError(relay.baseURL, '11155111', 'eth_chainId');
    assert(unknown?.code === 'evm-unknown-chain',
      `pipe 11155111 (an unserved chain) → 404 evm-unknown-chain (got ${JSON.stringify(unknown)})`);
  } finally {
    await relay.stop().catch(() => {});
  }
}

// 5b. upstream env only, still no token row: the pipe forwards (chain multiplexing is static).
{
  const relay = await startRelay({env: {DPAY_EVM_RPC_URL_421614: RPC}});
  try {
    const piped = await rpc(`${relay.baseURL}/api/v1/evm/rpc/421614`, 'eth_chainId', [], {timeoutMs: 15_000});
    assert(BigInt(piped) === CHAIN_ID, `pipe 421614 forwards eth_chainId == 421614 with no token row (got ${piped})`);
  } finally {
    await relay.stop().catch(() => {});
  }
}

// 5c. token env SET: the catalog section appears with exactly that address.
if (TOKEN) {
  const relay = await startRelay({env: {DPAY_EVM_RPC_URL_421614: RPC, DPAY_EVM_SEPOLIA_TOKEN: TOKEN}});
  try {
    const cats = JSON.parse(await (await fetch(`${relay.baseURL}/api/v1/currencies`)).text());
    const sec = (cats.networks ?? []).find((n) => n.protocol === 'evm' && n.name === 'Arbitrum Sepolia');
    assert(sec != null && sec.environment === 'testnet', 'catalog: the Arbitrum Sepolia TESTNET section appears with the env set');
    const asset = sec?.assets?.find?.((a) => a.chain_id === 421614) ?? null;
    assert(asset != null && asset.address?.toLowerCase() === TOKEN.toLowerCase(),
      `catalog: the section's ZCHF address is exactly ${TOKEN}`);
  } finally {
    await relay.stop().catch(() => {});
  }
} else {
  skip('half 5c needs a deployed token address in DPAY_EVM_SEPOLIA_TOKEN (run scripts/evm-sepolia-roundtrip.mjs first, then re-run this probe with the env set)');
}

if (failed > 0) {
  console.error(`\nevm-probe-arbitrum-sepolia: ${failed} check(s) FAILED, ${skipped} skipped`);
  process.exit(1);
}
console.log(`\nevm-probe-arbitrum-sepolia: PASS — Sepolia RPC alive at 421614, dev-token env-row mechanism verified (${skipped} skipped)`);

// --- local helpers -----------------------------------------------------------------------------
function encodeBalanceOf(owner) { return selector('balanceOf(address)') + owner.replace(/^0x/, '').toLowerCase().padStart(64, '0'); }

/** Decode an ABI-encoded string return (offset 0x20, length word, bytes). */
function decodeAbiString(hex) {
  const h = String(hex ?? '').replace(/^0x/, '');
  const len = Number(BigInt('0x' + h.slice(64, 128)));
  return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8');
}

/** POST one call through the relay pipe and return the relay's error MARKER {code, detail}, or null on success. */
async function pipeError(baseURL, chainPath, method) {
  const res = await fetch(`${baseURL}/api/v1/evm/rpc/${chainPath}`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params: []}),
  });
  if (res.ok) return null;
  const body = await res.json().catch(() => ({}));
  return {status: res.status, code: body.dpayRelayError, detail: body.detail};
}

// decodeTransferLog is imported for the round-trip script's shared asserts (kept here so both
// files read the same way); the probe itself makes no transfers.
void decodeTransferLog;
