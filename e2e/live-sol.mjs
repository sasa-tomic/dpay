// LIVE mainnet measurement of the float's APP-DERIVED Solana address.
//
// NOT part of the offline e2e suite. Read-only. The app (app/solana/identity.ts) derives the
// Solana rail key by SLIP-10 ed25519 at m/44'/501'/0'/0' FROM THE IC IDENTITY SEED — so the
// address the app controls (and the one a CeFi shift settles at, ConvertMode.tsx:496) is NOT the
// registered `sol-float` wallet (an independent raw-seed key the app cannot sign from; see the
// docs/AGENT-FUNDS.md finding). This tool derives that in-app address from the IC float seed
// IN-PROCESS (the seed is decrypted via scripts/agent-key.mjs and NEVER printed) and measures:
//
//   node e2e/live-sol.mjs          → address + SOL lamports + USDC/EURC SPL balances (RPC, keyless)
//
// Every balance claim for the app-derived SOL rail comes from HERE, never from memory.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');

const RPC = process.env.DPAY_LIVE_SOL_RPC ?? 'https://api.mainnet-beta.solana.com';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
  });
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function main() {
  const seedHex = execFileSync('node', ['scripts/agent-key.mjs', 'seed'], {encoding: 'utf8', cwd: REPO_ROOT})
    .split('\n').filter((l) => /^[0-9a-f]{64}$/.test(l.trim()))[0]?.trim();
  if (!seedHex) throw new Error('could not capture the IC float seed hex');
  const {deriveSolanaKeypair} = await import('./harness/jupiter.mjs');
  const {address} = deriveSolanaKeypair(seedHex);
  console.log('app-derived SOL address (SLIP-10 m/44\'/501\'/0\'/0\' of the IC float seed):');
  console.log(' ', address);

  const lamports = await rpc('getBalance', [address, {commitment: 'confirmed'}]);
  console.log(`  SOL: ${Number(lamports.value) / 1e9} (lamports ${lamports.value})`);

  const tas = await rpc('getTokenAccountsByOwner', [address, {programId: TOKEN_PROGRAM}, {encoding: 'jsonParsed', commitment: 'confirmed'}]);
  const byMint = new Map();
  for (const {account} of tas.value ?? []) {
    const info = account.data.parsed.info;
    byMint.set(info.mint, info.tokenAmount);
  }
  for (const [name, mint, dec] of [['USDC', USDC_MINT, 6], ['EURC', EURC_MINT, 6]]) {
    const t = byMint.get(mint);
    console.log(`  ${name}: ${t ? Number(t.uiAmountString) : 0}${t ? '' : ' (no token account — measured zero)'}`);
  }
  const extra = [...byMint.keys()].filter((m) => m !== USDC_MINT && m !== EURC_MINT);
  if (extra.length > 0) console.log('  other SPL mints present:', extra.join(', '));
}

main().catch((e) => { console.error('live-sol FAILED:', e.message); process.exit(1); });
