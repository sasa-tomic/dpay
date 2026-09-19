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
//   node scripts/agent-key.mjs balance P   measure ANY principal — agent-funds watches the
//                                          abandoned one through this; needs no key at all
//   node scripts/agent-key.mjs history     recent ICP ledger transactions for this key (no decryption)
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

/** Every mainnet ICRC ledger in the bundled catalog, DERIVED from catalog_truth.json — the honest
 *  census. A ledger added there appears here automatically; restating a list would silently hide
 *  holdings the moment the catalog grows (the ckUSDC/ckETH omission that motivated this). The
 *  balance is the only statement of what the float holds, so it must enumerate everything or it
 *  lies by omission — a hidden zero and a hidden holding are the same lie.
 *
 *  Non-census keys, by rule: `demo_ledger` (local-replica token, not a mainnet float asset),
 *  `testnet_*` (IC-testnet chain-key canisters), everything without a `_ledger` suffix (minters,
 *  the index, the Solana eurc_mint). Ledgers sharing a principal are measured once
 *  (`cketh_gas_ledger` IS `cketh_ledger`). Display order is presentation only. */
function census(truth) {
  const ORDER = ['icp', 'vchf', 'ckusdc', 'ckbtc', 'cketh']; // stable display order for the known five
  const LABELS = {icp: 'ICP', vchf: 'VCHF', ckusdc: 'ckUSDC', ckbtc: 'ckBTC', cketh: 'ckETH'};
  const DEC_KEY = {cketh: 'eth'}; // ckETH's decimals pin rides the `eth` key (the 18-dec row)
  const stems = Object.keys(truth.principals)
    .filter(k => k.endsWith('_ledger') && !k.startsWith('testnet_') && k !== 'demo_ledger')
    .map(k => k.slice(0, -'_ledger'.length))
    .sort((a, b) => ((ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b));
  const seen = new Set();
  return stems
    .filter(stem => { const p = truth.principals[`${stem}_ledger`]; if (seen.has(p)) return false; seen.add(p); return true; })
    .map(stem => ({label: LABELS[stem] ?? stem.toUpperCase(), ledgerKey: `${stem}_ledger`, decKey: DEC_KEY[stem] ?? stem}));
}

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
  // Paste-hazard guard: a top-up sent to a wrong string is unrecoverable, so the funding address
  // is never handed over without its procedure. The destroyed principal is named SHORTENED on
  // purpose — the full string must not be one careless copy away (full form: docs/AGENT-FUNDS.md).
  console.log('\nFunding safety (docs/AGENT-FUNDS.md "Funding the float — do not guess the address"):');
  console.log('  1. copy the address printed ABOVE — never one from memory or chat scrollback');
  console.log('  2. paste-send the top-up');
  console.log('  3. within a minute run `just agent-history` and CONFIRM the IN row — only then is it landed');
  console.log('The pre-rotation principal lrdna-…-mqe is DESTROYED and unrecoverable: a misdirected send');
  console.log('there is gone forever. `just agent-funds` watches it and trips if funds ever appear.');
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
  // An explicit principal measures THAT principal (agent-funds' abandoned-principal watch passes
  // one) and deliberately needs no key file at all — ledger balances are public.
  const principal = process.argv[3] ?? readPub().principal;
  const truth = JSON.parse(readFileSync(TRUTH, 'utf8'));
  const assets = census(truth);
  console.log(`principal ${principal}`);
  for (const a of assets) {
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


/** The ICP index canister, pinned by the same truth file the relay's adapter pins it from. It is
 *  the ONLY way to see what a payment actually did: `balance` says how much is left, this says
 *  where it went, in what amount, and — the part that matters after an OpenCryptoPay payment — at
 *  which BLOCK INDEX, since that index is the exact proof the wallet reports to the provider.
 *
 *  Read-only, no decryption, no cycles. Amounts are e8s (ICP is 8-decimal) and the ledger reports
 *  legacy ACCOUNT IDENTIFIERS on both sides, so the key's own is derived here to tell an incoming
 *  transfer from an outgoing one rather than guessing from the sign of a balance change. */
async function cmdHistory() {
  const {principal} = readPub();
  const truth = JSON.parse(readFileSync(TRUTH, 'utf8'));
  const index = truth.principals.icp_index;
  if (!index) die('catalog_truth.json is missing principals.icp_index');
  const self = await accountIdOf(principal);
  console.log(`principal ${principal}`);
  console.log(`account   ${self}`);
  let out;
  try {
    out = execFileSync('dfx', [
      'canister', 'call', '--network', 'ic', '--query', index, 'get_account_transactions',
      `(record { account = record { owner = principal "${principal}"; subaccount = null }; start = null; max_results = 10 : nat })`,
    ], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000});
  } catch (e) {
    // Never print "no transactions" for a query that failed — an unreachable index is not an empty
    // history, and after a real payment that difference is the whole answer.
    die(`index UNREADABLE (${e.message.split('\n')[0]})`);
  }
  // Candid text, parsed positionally: each record carries an id, then a Transfer with to/from/
  // amount/fee. Enough to answer "did it move, where to, how much, which block".
  const txs = [...out.matchAll(/id = ([\d_]+) : nat64;[\s\S]*?Transfer = record \{\s*to = "([0-9a-f]+)";\s*fee = record \{ e8s = ([\d_]+)[\s\S]*?from = "([0-9a-f]+)";\s*amount = record \{ e8s = ([\d_]+)/g)];
  if (txs.length === 0) { console.log('  (no transfers on this account yet)'); return; }
  for (const [, id, to, fee, from, amount] of txs) {
    const num = t => BigInt(t.replace(/_/g, ''));
    const e8s = v => { const s = v.toString().padStart(9, '0'); return `${s.slice(0, -8)}.${s.slice(-8)}`; };
    const outgoing = from === self;
    console.log(`  block ${id.replace(/_/g, '').padEnd(10)} ${outgoing ? 'OUT' : 'IN '} ${e8s(num(amount)).padStart(14)} ICP`
      + ` ${outgoing ? '->' : '<-'} ${outgoing ? to : from}${outgoing ? ` (fee ${e8s(num(fee))})` : ''}`);
  }
}

/** The key's own 64-hex account identifier — what the ICP ledger names it in transaction records.
 *  Derived through the SAME wasm core the app uses, for the same reason `principalOf` is. */
async function accountIdOf(principal) {
  const {instance} = await WebAssembly.instantiate(readFileSync(WASM), {});
  const ex = instance.exports;
  const put = t => { const b = new TextEncoder().encode(t); const ptr = ex.w_alloc(b.length); new Uint8Array(ex.memory.buffer).set(b, ptr); return [ptr, b.length]; };
  const [op, ol] = put(principal);
  const [sp, sl] = put('');
  const outPtr = ex.w_alloc(128);
  const n = ex.w_icp_account_id_from_principal(op, ol, sp, sl, outPtr, 128);
  if (n <= 3) die('core refused to derive the account identifier');
  return new TextDecoder().decode(new Uint8Array(ex.memory.buffer, outPtr, n));
}

const CMDS = {init: cmdInit, principal: cmdPrincipal, seed: cmdSeed, balance: cmdBalance, history: cmdHistory};
const cmd = process.argv[2];
if (!CMDS[cmd]) die(`usage: agent-key.mjs <${Object.keys(CMDS).join('|')}>`);
await CMDS[cmd]();
