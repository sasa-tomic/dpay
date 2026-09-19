#!/usr/bin/env node
// One command that prints EVERY wallet the agent controls and EVERY live balance. The founder's
// ask (2026-09-19): a fresh session should need exactly one command to know what exists, where it
// lives, and what it holds — `just timing` is to suites what this is to wallets.
//
// Design notes that are NOT obvious from the code:
//
//  - Balances are NOT re-implemented here. The IC section is `agent-key.mjs balance` and the SOL
//    section is `agent-sol.mjs balance`, spawned as children — so `agent-funds` renders each
//    section byte-identically to the single-wallet commands, and there is exactly one balance
//    implementation per chain. This file only orchestrates and never touches the age identity
//    itself (the `--seed` path decrypts by delegating to agent-sol.mjs, keeping one sops caller
//    per chain).
//
//  - The wallet LIST comes from `.dev/agent-wallets.json` (gitignored, machine-readable — treated
//    like `.dev/testruns.db`). A missing or unreadable registry is tolerated: this file falls back
//    to what the custody scripts themselves know (`secrets/*.pub.json`) plus the public record of
//    the abandoned principal, so a fresh clone still shows everything except curated notes. The
//    committed copy of the registry lives in docs/AGENT-FUNDS.md ("Wallet registry").
//
//  - A section that cannot be measured prints UNREADABLE and makes the whole command exit 1 — a
//    wallet overview that silently skipped a chain would be worse than a failing one.
//
// Usage:
//   node scripts/agent-funds.mjs           every wallet + every live balance (no decryption)
//   node scripts/agent-funds.mjs --seed    additionally print the SOL seed hex — DECRYPTS
import {readFileSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REG = join(ROOT, '.dev/agent-wallets.json');

/** Fallback record for the compromised pre-rotation float principal. Public information (it is in
 *  the docs/AGENT-FUNDS.md spend log) — no secret has existed for it since the 2026-09-05 rotation,
 *  and it must never be funded again. Kept here so even a registry-less fresh clone sees it. */
const ABANDONED_ICP = {
  chain: 'icp',
  address: 'lrdna-ain6m-ja6ko-ac4j2-jqk3t-nqs22-4irws-bsm3b-trzzq-3yfz6-mqe',
  secret: null,
  status: 'abandoned-never-fund',
  note: 'compromised 2026-09-05 (partial key disclosure), emptied by rotation — NEVER fund',
};

const SCRIPT_OF = {icp: 'scripts/agent-key.mjs', solana: 'scripts/agent-sol.mjs'};

function die(msg) {
  console.error(`agent-funds: ${msg}`);
  process.exit(1);
}

function loadRegistry() {
  if (!existsSync(REG)) return null;
  try {
    return JSON.parse(readFileSync(REG, 'utf8'));
  } catch (e) {
    die(`registry ${REG} is unreadable (${e.message.split('\n')[0]}) — fix it or delete it; continuing on the pub-file fallback`);
  }
}

/** Registry present? Use it. Missing? Rebuild from the custody scripts' own public halves. */
function walletList() {
  const reg = loadRegistry();
  if (reg?.wallets?.length) return reg.wallets;
  const wallets = [];
  for (const [chain, pub] of [['icp', 'secrets/agent-icp.pub.json'], ['solana', 'secrets/agent-sol.pub.json']]) {
    const p = join(ROOT, pub);
    if (!existsSync(p)) continue; // that chain has no key yet — its section below says so loudly
    const j = JSON.parse(readFileSync(p, 'utf8'));
    wallets.push({chain, address: j.address ?? j.principal, secret: pub.replace('.pub.', '.sops.'), status: 'live'});
  }
  wallets.push(ABANDONED_ICP);
  return wallets;
}

/** Run one chain's balance command and stream its output verbatim. Loud, never silent. */
function runBalance(entry) {
  const script = SCRIPT_OF[entry.chain];
  if (!script) { console.log(`  UNREADABLE (registry entry has unknown chain "${entry.chain}")`); return false; }
  try {
    const out = execFileSync(process.execPath, [join(ROOT, script), 'balance'], {
      encoding: 'utf8', cwd: ROOT, timeout: 300_000,
      stdio: ['ignore', 'pipe', 'inherit'], // the child's own die() guidance must reach the user
    });
    process.stdout.write(out);
    return true;
  } catch (e) {
    console.log(`  UNREADABLE (${e.message.split('\n')[0]})`);
    return false;
  }
}

/** Watch the abandoned principal. It has no key — its seed was destroyed in the 2026-09-05
 *  rotation — but it still has a PUBLIC address anyone can paste by mistake, and a payment rail
 *  accepts transfers to it silently. So every agent-funds run measures the full IC census for it
 *  through `agent-key.mjs balance <principal>` (which needs no key) and trips LOUDLY if funds
 *  ever appear: funds on a destroyed key are unrecoverable by construction, and the only honest
 *  responses are alarm and post-mortem. Returns true on alarm or unreadable watch (exit 1),
 *  false when measured zero on every ledger. */
function watchAbandoned(w) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, SCRIPT_OF.icp), 'balance', w.address], {
      encoding: 'utf8', cwd: ROOT, timeout: 300_000,
      stdio: ['ignore', 'pipe', 'inherit'], // the child's own die() guidance must reach the user
    });
    const lines = out.split('\n').filter(l => l.trim() && !l.startsWith('principal '));
    for (const l of lines) console.log(`  ${l}`);
    const measured = lines.map(l => l.match(/^  (\S+)\s+(\d+)\.(\d+)$/)).filter(Boolean)
      .map(m => ({label: m[1], val: `${m[2]}.${m[3]}`}));
    const nonzero = measured.filter(r => !/^0\.0*$/.test(r.val));
    if (nonzero.length > 0) {
      console.log('');
      console.log('   !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      console.log('   !! MISDIRECTED FUNDING — funds found on a key whose seed is DESTROYED !!');
      console.log(`   !! ${nonzero.map(r => `${r.label} ${r.val}`).join(', ')} on ${w.address}`);
      console.log('   !! They are unrecoverable. NEVER fund this address; record how they arrived.');
      console.log('   !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      return true;
    }
    if (lines.some(l => l.includes('UNREADABLE'))) {
      console.log('   watch   ledger UNREADABLE above — cannot certify this principal empty');
      return true;
    }
    console.log('   watch   measured 0 on every catalog ledger — still empty');
    return false;
  } catch (e) {
    console.log(`   watch   UNREADABLE (${e.message.split('\n')[0]})`);
    return true;
  }
}

const args = process.argv.slice(2);
const seedFlag = args.includes('--seed');
if (args.some(a => a !== '--seed')) die(`unknown argument(s): ${args.filter(a => a !== '--seed').join(' ')} — usage: agent-funds.mjs [--seed]`);

const wallets = walletList();
console.log('agent-funds — every wallet the agent controls (policy: docs/AGENT-FUNDS.md; spend ceiling CHF 25)\n');

let failed = false;
let seedShown = false;
for (const w of wallets) {
  const label = w.status === 'abandoned-never-fund' ? 'ABANDONED — NEVER FUND' : w.status.toUpperCase();
  console.log(`── ${w.chain} mainnet · ${label} ${'─'.repeat(Math.max(2, 44 - w.chain.length - label.length))}`);
  console.log(`   address ${w.address}`);
  if (w.secret) console.log(`   secret  ${w.secret}`);
  if (w.note) console.log(`   note    ${w.note}`);
  if (w.status === 'abandoned-never-fund') {
    // The abandoned WHY must be visible even though it lives in the registry's `purpose` field —
    // a fresh session seeing "never fund" should not have to ask why.
    if (w.purpose) console.log(`   note    ${w.purpose}`);
    failed = watchAbandoned(w) || failed;
    console.log('');
    continue; // never funded, but always WATCHED
  }
  if (!SCRIPT_OF[w.chain] || !runBalance(w)) failed = true;
  if (seedFlag && w.chain === 'solana' && !seedShown) {
    seedShown = true;
    try {
      const seed = execFileSync(process.execPath, [join(ROOT, SCRIPT_OF.solana), 'seed'], {
        encoding: 'utf8', cwd: ROOT, timeout: 60_000, stdio: ['ignore', 'pipe', 'inherit'],
      }).trim();
      console.log(`   seed    ${seed}  <- DECRYPTED just now; approved spend only; never paste anywhere`);
    } catch (e) {
      console.log('   seed    UNREADABLE (decrypt failed — see agent-sol error above)');
      failed = true;
    }
  }
  console.log('');
}

const missing = Object.entries(SCRIPT_OF).filter(([chain]) => !wallets.some(w => w.chain === chain && w.status !== 'abandoned-never-fund'));
for (const [chain, script] of missing) {
  console.log(`── ${chain} mainnet · NO KEY ──`);
  console.log(`   none yet — \`${script.replace('scripts/agent-', 'just agent-').replace('.mjs', '')}-init\` generates one\n`);
}

process.exit(failed ? 1 : 0);
