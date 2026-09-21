#!/usr/bin/env node
// EVM half of the agent test float — keyless visibility for a public Ethereum address.
// Extracted 2026-09-20 from the inline curl in scripts/funds.mjs (commit a317f97 measured it
// there) so the repo invariant holds — exactly one balance implementation per chain, and the
// overview (agent-funds.mjs) renders the EVM section like every other chain. The address is
// public (secrets/agent-evm.pub.json); NOTHING here decrypts — `seed` has no EVM form, the
// signing key is only ever unlocked by importing it into standard tooling for an approved spend.
//
// Native ETH only. An ERC-20 census (the CCTP-burned USDC) needs one eth_call per contract —
// added when the wallet actually holds one, not speculatively.
//
// Usage:
//   node scripts/agent-evm.mjs balance [A] [--json]   eth_getBalance ("latest") — no decryption
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'secrets/agent-evm.pub.json');
const RPC = process.env.DPAY_LIVE_EVM_RPC ?? 'https://ethereum-rpc.publicnode.com';

function die(msg) {
  console.error(`agent-evm: ${msg}`);
  process.exit(1);
}

function fmt(wei) {
  const s = wei.toString().padStart(19, '0');
  return `${s.slice(0, -18)}.${s.slice(-18)}`;
}

async function main() {
  const argv = process.argv.slice(3);
  const json = argv.includes('--json');
  const addr = argv.filter(a => a !== '--json')[0]
    ?? (JSON.parse(readFileSync(PUB, 'utf8')).address ?? die(`${PUB} has no address`));
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) die(`not a 20-byte hex address: ${addr}`);
  let wei;
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [addr, 'latest']}),
      signal: AbortSignal.timeout(20_000),
    });
    const j = await res.json();
    if (j.error) die(`eth_getBalance error ${j.error.code}: ${j.error.message}`);
    wei = BigInt(j.result);
  } catch (e) {
    const why = String(e.message).split('\n')[0];
    // Never print a zero we did not measure — an unreachable RPC is not an empty balance.
    if (json) console.log(JSON.stringify({address: addr, rows: [{label: 'ETH', unreadable: why}]}));
    else console.log(`address   ${addr}\n  ${'ETH'.padEnd(6)} UNREADABLE (${why})`);
    process.exit(1);
  }
  // USDC census (the CCTP-burned USDC lands here) — one eth_call; a failed call is UNKNOWN, never 0.
  let usdc;
  try {
    const data = '0x70a08231' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const res2 = await fetch(RPC, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', data}, 'latest']}),
      signal: AbortSignal.timeout(20_000),
    });
    const j2 = await res2.json();
    if (!j2.error) usdc = BigInt(j2.result);
  } catch { usdc = undefined; }
  const usdcDec = usdc === undefined ? undefined : (() => { const s = usdc.toString().padStart(7, '0'); return `${s.slice(0, -6)}.${s.slice(-6)}`; })();
  if (json) console.log(JSON.stringify({address: addr, rows: [{label: 'ETH', value: wei.toString()}, ...(usdcDec !== undefined ? [{label: 'USDC', value: usdcDec}] : [{label: 'USDC', unreadable: 'eth_call failed'}])]}));
  else console.log(`address   ${addr}\n  ${'ETH'.padEnd(6)} ${fmt(wei)}  (${wei} wei)` + (usdc !== undefined ? `\n  ${'USDC'.padEnd(6)} ${(Number(usdc) / 1e6).toFixed(6)}  (${usdc} subunits)` : ''));
}

await main();
