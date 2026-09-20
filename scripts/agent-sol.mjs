#!/usr/bin/env node
// Solana half of the agent test float — custody + visibility for the agent's mainnet SOL key.
// Same split as scripts/agent-key.mjs (that file is the IC half): this file is the mechanism,
// docs/AGENT-FUNDS.md is the policy, and neither restates the other.
//
// Design notes that are NOT obvious from the code:
//
//  - The key IS a raw 32-byte Ed25519 seed; the Solana address is the base58 of the public key
//    OpenSSL derives from it. Base58 is implemented here (10 lines) rather than added as a
//    dependency — scripts in this repo stay dependency-free node.
//
//  - The PUBLIC half (address) is stored in plaintext beside the encrypted seed, so `principal`
//    and `balance` — the two commands used constantly — never touch the age identity at all. Only
//    `seed`, the deliberate spend unlock, decrypts. Same shape as the IC half.
//
//  - `init` refuses to overwrite. Overwriting a funded key destroys the funds, and "the script
//    clobbered it" must not be a reachable state.
//
//  - Balances come from the keyless public mainnet RPC. It can rate-limit or be down, so every
//    source is guarded: a failed query prints UNREADABLE, never a zero we did not measure. Absent
//    SPL accounts are the one exception — their zero is a measured answer (the RPC said so), not a
//    failed lookup.
//
// Usage:
//   node scripts/agent-sol.mjs init          generate the key (once); prints the address only
//   node scripts/agent-sol.mjs principal [A] print the funding address, or A (no decryption)
//   node scripts/agent-sol.mjs balance [A]   live mainnet balances (no decryption); A measures ANY
//                                            address — the app-derived sol-rail is keyless here
//   node scripts/agent-sol.mjs seed          print the seed hex — DECRYPTS; only for a spend
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {createPrivateKey, createPublicKey, generateKeyPairSync} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEC = join(ROOT, 'secrets/agent-sol.sops.json');
const PUB = join(ROOT, 'secrets/agent-sol.pub.json');
const AGE_KEY = join(ROOT, '.dev/age/agent-key.txt');
const RPC = 'https://api.mainnet-beta.solana.com';

/** SPL tokens the SOL wallet tracks. Mints are public constants, not secrets. */
const TOKENS = [
  {label: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'},
  {label: 'EURC', mint: 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'},
];

function die(msg) {
  console.error(`agent-sol: ${msg}`);
  process.exit(1);
}

/** base58 (Bitcoin alphabet) — the Solana address encoding. */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt('0x' + bytes.toString('hex'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; } // leading zero bytes
  return s || '1';
}

/** The Solana address (base58 pubkey) for a 32-byte Ed25519 seed, via node's own crypto — the
 *  same OpenSSL the RPC ecosystem trusts. PKCS#8 wrap so node can parse the raw seed back. */
function addressOf(seed) {
  if (seed.length !== 32) die(`seed must be 32 bytes, got ${seed.length}`);
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const pub = createPublicKey(createPrivateKey({key: der, format: 'der', type: 'pkcs8'}))
    .export({type: 'spki', format: 'der'})
    .subarray(-32);
  return base58(pub);
}

function sops(args) {
  if (!existsSync(AGE_KEY)) {
    die(`age identity missing at ${AGE_KEY}\n` +
        '  Restore it from your password manager, or run `just funds init sol-float` for a NEW key\n' +
        '  (which strands any funds held by the old one).');
  }
  return execFileSync('sops', args, {
    encoding: 'utf8',
    env: {...process.env, SOPS_AGE_KEY_FILE: AGE_KEY},
  });
}

function readPub() {
  if (!existsSync(PUB)) die(`no key yet — run \`just funds init sol-float\` (${PUB} missing)`);
  return JSON.parse(readFileSync(PUB, 'utf8'));
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) die(`RPC ${method} HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) die(`RPC ${method} error ${j.error.code}: ${j.error.message}`);
  return j.result;
}

/** Fixed 9-decimal (SOL) / on-chain-decimal (SPL) rendering, matching the IC half's format. */
function fmt(raw, dec) {
  const s = raw.toString().padStart(dec + 1, '0');
  return `${s.slice(0, -dec)}.${s.slice(-dec)}`;
}

async function cmdInit() {
  if (existsSync(SEC) || existsSync(PUB)) {
    die('a key already exists — refusing to overwrite (that would strand any funds it holds).\n' +
        '  To deliberately rotate: move the float out first, then delete secrets/agent-sol.*');
  }
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const seed = privateKey.export({type: 'pkcs8', format: 'der'}).subarray(-32);
  const address = base58(publicKey.export({type: 'spki', format: 'der'}).subarray(-32));
  // One-time self-check: the stored seed must derive the stored address, or the two records
  // would diverge from birth. Cheap insurance against a wrapping-prefix typo.
  if (addressOf(seed) !== address) die('generated seed does not derive its own address — refusing to store');

  mkdirSync(join(ROOT, 'secrets'), {recursive: true});
  const plain = join(ROOT, 'secrets/.agent-sol.plain.json');
  writeFileSync(plain, JSON.stringify({seed_hex: seed.toString('hex')}, null, 2) + '\n', {mode: 0o600});
  try {
    // `--filename-override` makes sops match the `secrets/*.sops.json` creation rule in .sops.yaml
    // against the DESTINATION name while reading the temp file, so the age recipient is configured
    // in exactly one place and never restated here. Same invocation as the IC half.
    const enc = execFileSync('sops', [
      '--encrypt', '--filename-override', 'secrets/agent-sol.sops.json', plain,
    ], {encoding: 'utf8', cwd: ROOT});
    writeFileSync(SEC, enc);
  } finally {
    // The plaintext seed must not survive this process under any outcome, success or throw.
    execFileSync('shred', ['-u', plain]);
  }

  writeFileSync(PUB, JSON.stringify({
    address,
    purpose: 'Agent-operated Solana mainnet test wallet (SOL/USDC/EURC). Rules: docs/AGENT-FUNDS.md',
    created: new Date().toISOString().slice(0, 10),
  }, null, 2) + '\n');

  console.log(address);
}

/** Optional positional address (everything in argv except flags) — lets the funds tooling measure
 *  or name ANY public address keylessly, the way agent-key.mjs balance takes any principal. */
function positional() {
  return process.argv.slice(3).filter(a => a !== '--json')[0];
}

async function cmdPrincipal() {
  console.log(positional() ?? readPub().address);
}

async function cmdSeed() {
  const out = JSON.parse(sops(['--decrypt', SEC]));
  if (!out.seed_hex) die('decrypted secret has no seed_hex');
  // Parity guard: a seed that no longer derives the recorded address means the secret and the
  // public record have diverged — refuse rather than spend from a key we cannot account for.
  const got = addressOf(Buffer.from(out.seed_hex, 'hex'));
  const want = readPub().address;
  if (got !== want) die(`seed derives ${got} but ${PUB} records ${want} — refusing`);
  console.log(out.seed_hex);
}

async function cmdBalance() {
  // `--json` is the machine-readable form of the exact same measures (for scripts/funds.mjs
  // reconcile); the human-readable shape is unchanged. An explicit address measures that address
  // keylessly (the app-derived sol-rail has no key file of its own — its secret IS the IC seed).
  const json = process.argv.slice(3).includes('--json');
  const addr = positional();
  if (addr && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) die(`not a base58 Solana address: ${addr}`);
  const {address} = {address: addr ?? readPub().address};
  const rows = [];
  if (!json) console.log(`address   ${address}`);
  try {
    const lamports = BigInt((await rpc('getBalance', [address])).value);
    const val = fmt(lamports, 9);
    if (json) rows.push({label: 'SOL', value: val});
    else console.log(`  ${'SOL'.padEnd(6)} ${val}`);
  } catch (e) {
    // Never print a zero we did not measure — an unreachable RPC is not an empty balance.
    const why = String(e.message).split('\n')[0];
    if (json) rows.push({label: 'SOL', unreadable: why});
    else console.log(`  ${'SOL'.padEnd(6)} UNREADABLE (${why})`);
  }
  for (const t of TOKENS) {
    try {
      const accounts = (await rpc('getTokenAccountsByOwner', [address, {mint: t.mint}, {encoding: 'jsonParsed'}])).value;
      let raw = 0n, dec = 6;
      for (const acc of accounts) {
        const info = acc.account.data.parsed.info;
        raw += BigInt(info.tokenAmount.amount);
        dec = info.tokenAmount.decimals;
      }
      // An absent SPL account is a measured zero (the RPC answered), not a failed lookup.
      const val = fmt(raw, dec);
      if (json) rows.push({label: t.label, value: val});
      else console.log(`  ${t.label.padEnd(6)} ${val}`);
    } catch (e) {
      const why = String(e.message).split('\n')[0];
      if (json) rows.push({label: t.label, unreadable: why});
      else console.log(`  ${t.label.padEnd(6)} UNREADABLE (${why})`);
    }
  }
  if (json) console.log(JSON.stringify({address, rows}));
}

const CMDS = {init: cmdInit, principal: cmdPrincipal, seed: cmdSeed, balance: cmdBalance};
const cmd = process.argv[2];
if (!CMDS[cmd]) die(`usage: agent-sol.mjs <${Object.keys(CMDS).join('|')}>`);
await CMDS[cmd]();
