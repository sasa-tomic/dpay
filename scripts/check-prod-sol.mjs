#!/usr/bin/env node
// Prod-build guard for the Solana RPC endpoint. The SOL rail's config/constants.ts bakes a default
// SOLANA_RPC_URL; a release build must NOT ship pointing at devnet/testnet (a user's mainnet SOL
// would be invisible / a devnet-funded pilot key would be silently used) or at the rate-limited
// public mainnet (api.mainnet-beta.solana.com — 40 req/10s, blown by the 2.5s balance poll alone).
//
// This runs on the release path (build-apk.sh, after the relay-URL check). It reads the BAKED
// default from config/constants.ts — the value a fresh install uses when no test override is present
// — and fails the build if it's unsafe for production. An operator who has not yet set a paid
// mainnet provider (Helius/QuickNode) sees a clear actionable error instead of shipping a fund-loss
// trap. Override the expected endpoint with DPAY_SOL_RPC to pass the check after flipping the const.
//
// Usage: node scripts/check-prod-sol.mjs   (exit 0 = safe, exit 1 = unsafe)
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const constantsPath = join(here, '..', 'app', 'config', 'constants.ts');
const src = readFileSync(constantsPath, 'utf8');

// Extract the baked default from: export const SOLANA_RPC_URL = ((...).__DPAY_TEST_SOLANA_RPC_URL ?? '<url>');
const m = src.match(/export const SOLANA_RPC_URL\s*=[\s\S]*?\?\?\s*'([^']+)'/);
if (!m) {
  console.error('FAIL: could not find SOLANA_RPC_URL baked default in app/config/constants.ts');
  process.exit(1);
}
const baked = m[1];

// An operator may set the expected endpoint at build time (e.g. a paid provider). When set, the
// baked const must match it exactly — catching a stale const after the operator flipped the value.
const expected = process.env.DPAY_SOL_RPC;
if (expected !== undefined && baked !== expected) {
  console.error(`FAIL: SOLANA_RPC_URL baked default is '${baked}' but DPAY_SOL_RPC expects '${expected}'.`);
  console.error('       Edit app/config/constants.ts so the ?? default matches before building a release.');
  process.exit(1);
}

const UNSAFE = [
  /devnet/i,
  /testnet/i,
  /api\.mainnet-beta\.solana\.com/i, // rate-limited public mainnet (40 req/10s)
];
if (UNSAFE.some((re) => re.test(baked))) {
  console.error(`FAIL: SOLANA_RPC_URL bakes an unsafe endpoint for production: '${baked}'.`);
  console.error('       Set a paid mainnet provider (e.g. Helius/QuickNode) in app/config/constants.ts,');
  console.error('       or pass DPAY_SOL_RPC=<url> to acknowledge the choice. Shipping devnet/public-mainnet');
  console.error('       risks lost funds (mainnet SOL invisible) or balance-poll rate limiting.');
  process.exit(1);
}

console.log(`== solana RPC verified safe for production: ${baked} ==`);
