#!/usr/bin/env node
// EVM half of the agent test float — keyless visibility for a public Ethereum address.
// Extracted 2026-09-20 from the inline curl in scripts/funds.mjs (commit a317f97 measured it
// there) so the repo invariant holds — exactly one balance implementation per chain, and the
// overview (agent-funds.mjs) renders the EVM section like every other chain. The address is
// public (secrets/agent-evm.pub.json); NOTHING here decrypts — `seed` has no EVM form.
//
// Two census modes:
//   float (default) — the evm-float dust wallet: chain-1 ETH + USDC (the CCTP-burned USDC),
//     labels `ETH`/`USDC` (stable ledger keys since 2026-09-20).
//   rail — the app-derived evm-rail wallet (`--census rail`): BOTH mainnet chains, ETH gas +
//     ZCHF from dfx/catalog_truth.json erc20_contracts (derived from truth, never restated),
//     chain-qualified labels `ETH·Eth`/`ZCHF·Eth`/`ETH·Arb`/`ZCHF·Arb` (reconcile keys).
// A failed read is UNKNOWN, never 0 — an unreachable RPC is not an empty balance.
//
// Usage:
//   node scripts/agent-evm.mjs balance [A] [--census float|rail] [--json]   no decryption
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'secrets/agent-evm.pub.json');
const TRUTH = join(ROOT, 'dfx/catalog_truth.json');
const RPC_ETH = process.env.DPAY_LIVE_EVM_RPC ?? 'https://ethereum-rpc.publicnode.com';
const RPC_ARB = process.env.DPAY_LIVE_EVM_RPC_42161 ?? 'https://arbitrum-one-rpc.publicnode.com';

function die(msg) {
  console.error(`agent-evm: ${msg}`);
  process.exit(1);
}

function fmt(wei) {
  const s = wei.toString().padStart(19, '0');
  return `${s.slice(0, -18)}.${s.slice(-18)}`;
}

/** ZCHF contracts come from the drift-alarmed truth file — the catalog is the census source. */
function zchfOf(truth) {
  const c = truth.erc20_contracts ?? {};
  if (!c.zchf_ethereum || !c.zchf_arbitrum) die('catalog_truth.json erc20_contracts lost a ZCHF pin — fix the truth file first');
  return {eth: c.zchf_ethereum, arb: c.zchf_arbitrum};
}

async function rpcCall(url, method, params, id) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id, method, params}),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method} error ${j.error.code}: ${j.error.message}`);
  return j.result;
}

/** Native ETH, BigInt. Throws on any failure — the caller renders UNKNOWN, never 0. */
async function ethBalance(url, addr) {
  return BigInt(await rpcCall(url, 'eth_getBalance', [addr, 'latest'], 1));
}

/** ERC-20 balanceOf, BigInt; an empty/reverted payload is a throw (UNKNOWN), never 0. */
async function tokenBalance(url, token, addr) {
  const data = '0x70a08231' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const out = await rpcCall(url, 'eth_call', [{to: token, data}, 'latest'], 2);
  if (typeof out !== 'string' || out === '0x' || out.length !== 66) throw new Error('balanceOf returned no uint256');
  return BigInt(out);
}

async function main() {
  const argv = process.argv.slice(3);
  const json = argv.includes('--json');
  const mode = argv.includes('--census') ? (argv[argv.indexOf('--census') + 1] ?? die('--census needs float|rail')) : 'float';
  if (mode !== 'float' && mode !== 'rail') die(`unknown census mode "${mode}" (float|rail)`);
  const addr = argv.filter(a => a !== '--json' && !a.startsWith('--census') && a !== 'float' && a !== 'rail')[0]
    ?? (JSON.parse(readFileSync(PUB, 'utf8')).address ?? die(`${PUB} has no address`));
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) die(`not a 20-byte hex address: ${addr}`);

  if (mode === 'float') return floatCensus(addr, json);
  return railCensus(addr, json);
}

/** evm-float: chain-1 ETH + USDC — the 2026-09-20 labels, byte-stable for the ledger. */
async function floatCensus(addr, json) {
  let wei;
  try {
    wei = await ethBalance(RPC_ETH, addr);
  } catch (e) {
    const why = String(e.message).split('\n')[0];
    if (json) console.log(JSON.stringify({address: addr, rows: [{label: 'ETH', unreadable: why}]}));
    else console.log(`address   ${addr}\n  ${'ETH'.padEnd(6)} UNREADABLE (${why})`);
    process.exit(1);
  }
  let usdc;
  try {
    usdc = await tokenBalance(RPC_ETH, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', addr);
  } catch { usdc = undefined; }
  const usdcDec = usdc === undefined ? undefined : (() => { const s = usdc.toString().padStart(7, '0'); return `${s.slice(0, -6)}.${s.slice(-6)}`; })();
  if (json) console.log(JSON.stringify({address: addr, rows: [{label: 'ETH', value: wei.toString()}, ...(usdcDec !== undefined ? [{label: 'USDC', value: usdcDec}] : [{label: 'USDC', unreadable: 'eth_call failed'}])]}));
  else console.log(`address   ${addr}\n  ${'ETH'.padEnd(6)} ${fmt(wei)}  (${wei} wei)` + (usdc !== undefined ? `\n  ${'USDC'.padEnd(6)} ${(Number(usdc) / 1e6).toFixed(6)}  (${usdc} subunits)` : ''));
}

/** evm-rail: both mainnet chains, ETH gas + ZCHF, chain-qualified labels. */
async function railCensus(addr, json) {
  const zchf = zchfOf(JSON.parse(readFileSync(TRUTH, 'utf8')));
  const chains = [
    {suffix: 'Eth', rpc: RPC_ETH, url: 'ethereum-rpc.publicnode.com', token: zchf.eth},
    {suffix: 'Arb', rpc: RPC_ARB, url: 'arbitrum-one-rpc.publicnode.com', token: zchf.arb},
  ];
  const rows = await Promise.all(chains.map(async c => {
    try {
      const wei = await ethBalance(c.rpc, addr);
      let zchfWei;
      try {
        zchfWei = await tokenBalance(c.rpc, c.token, addr);
      } catch { zchfWei = undefined; }
      return [
        {chain: c.suffix, label: `ETH·${c.suffix}`, value: wei.toString()},
        zchfWei === undefined
          ? {chain: c.suffix, label: `ZCHF·${c.suffix}`, unreadable: `balanceOf failed via ${c.url}`}
          : {chain: c.suffix, label: `ZCHF·${c.suffix}`, value: zchfWei.toString()},
      ];
    } catch (e) {
      const why = String(e.message).split('\n')[0];
      return [
        {chain: c.suffix, label: `ETH·${c.suffix}`, unreadable: why},
        {chain: c.suffix, label: `ZCHF·${c.suffix}`, unreadable: why},
      ];
    }
  }));
  const flat = rows.flat();
  if (json) return void console.log(JSON.stringify({address: addr, rows: flat}));
  console.log(`address   ${addr}`);
  let bad = false;
  for (const r of flat) {
    if (r.unreadable !== undefined) { bad = true; console.log(`  ${r.label.padEnd(8)} UNREADABLE (${r.unreadable})`); continue; }
    const wei = BigInt(r.value);
    console.log(`  ${r.label.padEnd(8)} ${fmt(wei)}  (${wei} wei)`);
  }
  if (bad) process.exit(1);
}

await main();
