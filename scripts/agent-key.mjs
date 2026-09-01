#!/usr/bin/env node
// Custody + visibility for the agent's funded mainnet test key. See docs/AGENT-FUNDS.md for the
// operating rules (ceiling, spend policy, ledger) — this file is the mechanism, that file is the
// policy, and neither restates the other.
//
// Design notes that are NOT obvious from the code:
//
//  - The seed is derived into a principal by the SAME committed wasm core the app signs with
//    (`crates/dpay-relay/assets/dpay-core.wasm`, `w_icp_self_principal`). This is deliberate: a
//    hand-rolled JS reimplementation of `self_authenticating_ed25519` would be a second money-
//    critical code path that could silently disagree with the product. There is one derivation.
//
//  - The PUBLIC half (principal) is stored in plaintext beside the encrypted seed, so `principal`
//    and `balance` — the two commands used constantly — never touch the age identity at all. Only
//    `seed`, the deliberate spend unlock, decrypts.
//
//  - `init` refuses to overwrite. Overwriting a funded key destroys the funds, and "the script
//    clobbered it" must not be a reachable state.
//
//  - Ledger principals and decimals are read from `dfx/catalog_truth.json`, never restated here.
//
// Usage:
//   node scripts/agent-key.mjs init        generate the key (once); prints the principal only
//   node scripts/agent-key.mjs principal   print the funding address (no decryption)
//   node scripts/agent-key.mjs balance     query live mainnet balances (no decryption)
//   node scripts/agent-key.mjs seed        print the seed hex — DECRYPTS; only for a spend
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WASM = join(ROOT, 'crates/dpay-relay/assets/dpay-core.wasm');
const TRUTH = join(ROOT, 'dfx/catalog_truth.json');
const SEC = join(ROOT, 'secrets/agent-icp.sops.json');
const PUB = join(ROOT, 'secrets/agent-icp.pub.json');
const AGE_KEY = join(ROOT, '.dev/age/agent-key.txt');

/** The assets this float can hold. Keys index `principals` and `decimals` in catalog_truth.json —
 *  the ledger ids and decimals themselves are never copied here. */
const ASSETS = [
  {label: 'ICP', ledgerKey: 'icp_ledger', decKey: 'icp'},
  {label: 'VCHF', ledgerKey: 'vchf_ledger', decKey: 'vchf'},
  {label: 'ckBTC', ledgerKey: 'ckbtc_ledger', decKey: 'ckbtc'},
];

function die(msg) {
  console.error(`agent-key: ${msg}`);
  process.exit(1);
}

/** Self-authenticating IC principal for a 32-byte Ed25519 seed, via the committed wasm core. */
async function principalOf(seed) {
  if (seed.length !== 32) die(`seed must be 32 bytes, got ${seed.length}`);
  const {instance} = await WebAssembly.instantiate(readFileSync(WASM));
  const ex = instance.exports;
  if (ex.w_abi_version() !== 1) die(`unexpected wasm core ABI ${ex.w_abi_version()}`);
  const sp = ex.w_alloc(32);
  new Uint8Array(ex.memory.buffer, sp, 32).set(seed);
  const out = ex.w_alloc(128);
  const len = ex.w_icp_self_principal(sp, out, 128);
  if (len === 0) die('wasm core refused the seed (w_icp_self_principal returned 0)');
  return new TextDecoder().decode(new Uint8Array(ex.memory.buffer, out, len));
}

function sops(args) {
  if (!existsSync(AGE_KEY)) {
    die(`age identity missing at ${AGE_KEY}\n` +
        '  Restore it from your password manager, or run `just agent-key-init` for a NEW key\n' +
        '  (which strands any funds held by the old one).');
  }
  return execFileSync('sops', args, {
    encoding: 'utf8',
    env: {...process.env, SOPS_AGE_KEY_FILE: AGE_KEY},
  });
}

function readPub() {
  if (!existsSync(PUB)) die(`no key yet — run \`just agent-key-init\` (${PUB} missing)`);
  return JSON.parse(readFileSync(PUB, 'utf8'));
}

async function cmdInit() {
  if (existsSync(SEC) || existsSync(PUB)) {
    die('a key already exists — refusing to overwrite (that would strand any funds it holds).\n' +
        '  To deliberately rotate: move the float out first, then delete secrets/agent-icp.*');
  }
  const seed = randomBytes(32);
  const principal = await principalOf(seed);

  mkdirSync(join(ROOT, 'secrets'), {recursive: true});
  const plain = join(ROOT, 'secrets/.agent-icp.plain.json');
  writeFileSync(plain, JSON.stringify({seed_hex: seed.toString('hex')}, null, 2) + '\n', {mode: 0o600});
  try {
    // `--filename-override` makes sops match the `secrets/*.sops.json` creation rule in .sops.yaml
    // against the DESTINATION name while reading the temp file, so the age recipient is configured
    // in exactly one place and never restated here.
    const enc = execFileSync('sops', [
      '--encrypt', '--filename-override', 'secrets/agent-icp.sops.json', plain,
    ], {encoding: 'utf8', cwd: ROOT});
    writeFileSync(SEC, enc);
  } finally {
    // The plaintext seed must not survive this process under any outcome, success or throw.
    execFileSync('shred', ['-u', plain]);
  }

  writeFileSync(PUB, JSON.stringify({
    principal,
    purpose: 'Agent-operated low-value mainnet test float. Rules: docs/AGENT-FUNDS.md',
    created: new Date().toISOString().slice(0, 10),
  }, null, 2) + '\n');

  console.log(principal);
}

async function cmdPrincipal() {
  console.log(readPub().principal);
}

async function cmdSeed() {
  const out = JSON.parse(sops(['--decrypt', SEC]));
  if (!out.seed_hex) die('decrypted secret has no seed_hex');
  // Parity guard: a seed that no longer derives the recorded principal means the secret and the
  // public record have diverged — refuse rather than sign with a key we cannot account for.
  const got = await principalOf(Buffer.from(out.seed_hex, 'hex'));
  const want = readPub().principal;
  if (got !== want) die(`seed derives ${got} but ${PUB} records ${want} — refusing`);
  console.log(out.seed_hex);
}

async function cmdBalance() {
  const {principal} = readPub();
  const truth = JSON.parse(readFileSync(TRUTH, 'utf8'));
  console.log(`principal ${principal}`);
  for (const a of ASSETS) {
    const ledger = truth.principals[a.ledgerKey];
    const dec = truth.decimals[a.decKey];
    if (!ledger || dec === undefined) die(`catalog_truth.json is missing ${a.ledgerKey}/${a.decKey}`);
    let raw;
    try {
      const out = execFileSync('dfx', [
        'canister', 'call', '--network', 'ic', '--query', ledger, 'icrc1_balance_of',
        `(record { owner = principal "${principal}" })`,
      ], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000});
      raw = BigInt(out.replace(/[^0-9]/g, ''));
    } catch (e) {
      // Never print a zero we did not measure — an unreachable ledger is not an empty balance.
      console.log(`  ${a.label.padEnd(6)} UNREADABLE (${e.message.split('\n')[0]})`);
      continue;
    }
    const s = raw.toString().padStart(dec + 1, '0');
    console.log(`  ${a.label.padEnd(6)} ${s.slice(0, -dec)}.${s.slice(-dec)}`);
  }
}

const CMDS = {init: cmdInit, principal: cmdPrincipal, seed: cmdSeed, balance: cmdBalance};
const cmd = process.argv[2];
if (!CMDS[cmd]) die(`usage: agent-key.mjs <${Object.keys(CMDS).join('|')}>`);
await CMDS[cmd]();
