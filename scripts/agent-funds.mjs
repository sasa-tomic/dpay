#!/usr/bin/env node
// One command that prints EVERY wallet the agent controls, EVERY live balance, the SUM of it all
// in CHF, and every fee the ledger recorded. The founder's ask (2026-09-19): a fresh session
// should need exactly one command to know what exists, where it lives, and what it holds —
// `just timing` is to suites what this is to wallets. The 2026-09-27 follow-up: the same command
// answers "where are all the funds, in one number" and "how much did fees cost in total".
//
// Design notes that are NOT obvious from the code:
//
//  - Balances are NOT re-implemented here. The IC section is `agent-key.mjs balance` and the SOL
//    section is `agent-sol.mjs balance`, spawned as children with `--json` — so there is exactly
//    one balance implementation per chain and this file only orchestrates (it never touches the
//    age identity itself). This file re-renders the children's exact human format from their JSON
//    (one measure per wallet — running each child twice would double every chain query), so the
//    section lines match `just funds balance <W>` by construction of the format, not by sharing
//    the code. If a child's format ever changes, change the renderer here with it.
//
//  - The wallet LIST comes from the COMMITTED `funds/wallets.json` (founder ask 2026-09-19: the
//    record is version-controlled — a fresh clone finds every wallet). That file replaced the
//    gitignored `.dev/agent-wallets.json`, which is retired. The same file renders the registry
//    table in docs/AGENT-FUNDS.md and feeds `funds reconcile`.
//
//  - A section that cannot be measured prints UNREADABLE and makes the whole command exit 1 — a
//    wallet overview that silently skipped a chain would be worse than a failing one. Same for
//    UNVALUED: an asset with no CHF price is excluded from the totals LOUDLY and exits 1 — a
//    total that silently dropped an asset would understate the funds.
//
//  - CHF prices come from one CoinGecko call at spot; VCHF is fixed at 1 (CHF-pegged by
//    construction, no oracle). Spot prices move — the total is a live valuation, not an audit.
//    The audit answer is `just funds reconcile` (ledger math vs MEASURED, exit 1 on drift); this
//    command only points at it.
//
// Usage:
//   node scripts/agent-funds.mjs           every wallet + every live balance + CHF totals + fees (no decryption)
//   node scripts/agent-funds.mjs --seed    additionally print the SOL seed hex — DECRYPTS
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WALLETS = join(ROOT, 'funds/wallets.json'); // committed registry — the single source
const LEDGER = join(ROOT, 'funds/ledger.jsonl'); // committed movement record — the fee source

const SCRIPT_OF = {icp: 'scripts/agent-key.mjs', solana: 'scripts/agent-sol.mjs', evm: 'scripts/agent-evm.mjs'};

/** Chains whose `balance` takes an explicit public address (keyless). The IC census instead
 *  measures EVERY catalog ledger for its own key's principal and takes no address here. */
const TAKES_ADDRESS = new Set(['solana', 'evm']);

/** CHF spot via one CoinGecko call — every label the census can produce must appear here or in
 *  FIXED_CHF, or the totals section reports UNVALUED and the command exits 1. */
const COINGECKO_ID = {
  ICP: 'internet-computer', ckBTC: 'bitcoin', ckETH: 'ethereum', ETH: 'ethereum',
  SOL: 'solana', ckUSDC: 'usd-coin', USDC: 'usd-coin', EURC: 'euro-coin',
};
const FIXED_CHF = {VCHF: 1}; // CHF-pegged by construction — no oracle, no drift

function die(msg) {
  console.error(`agent-funds: ${msg}`);
  process.exit(1);
}

function walletList() {
  let reg;
  try {
    reg = JSON.parse(readFileSync(WALLETS, 'utf8'));
  } catch (e) {
    die(`wallet registry ${WALLETS} is missing or unreadable (${e.message.split('\n')[0]}) — it is committed; restore it with git`);
  }
  if (!reg.wallets?.length) die(`wallet registry ${WALLETS} lists no wallets`);
  return reg.wallets;
}

/** Exact decimal at a common 1e18 scale — the only way to add 8-dec ICP to 9-dec SOL to wei
 *  without floating-point loss. `fallbackDec` covers integer strings (EVM returns wei and
 *  subunits, not dotted decimals). */
const DEC18 = 10n ** 18n;
function scaled18(s, fallbackDec = 0) {
  s = String(s).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a decimal amount: ${s}`);
  const [int, frac = ''] = s.split('.');
  if (frac.length > 18) throw new Error(`more than 18 decimals: ${s}`);
  return BigInt(int || '0') * DEC18 + BigInt(frac.padEnd(18, '0'));
}
function unscaled18(v) {
  const int = v / DEC18;
  const frac = (v % DEC18).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int.toString();
}

const fmtWei = w => {
  const s = w.toString().padStart(19, '0');
  return `${s.slice(0, -18)}.${s.slice(-18)}`;
};

/** One census entry: a scaled amount, or the reason it could not be measured. */
const amount = scaled => ({scaled});
const unreadable = why => ({why});

/** Render one wallet section exactly as the chain's own human format and return its census
 *  entries. Throws only on a malformed child payload — which the caller reports UNREADABLE. */
function renderCensus(chain, json) {
  const entries = [];
  const push = e => entries.push(e);
  if (chain === 'icp' || chain === 'solana') {
    const head = chain === 'icp' ? `principal ${json.principal}` : `address   ${json.address}`;
    console.log(head);
    for (const r of json.rows) {
      if (r.unreadable !== undefined) { console.log(`  ${r.label.padEnd(6)} UNREADABLE (${r.unreadable})`); push(unreadable(r.unreadable)); }
      else { console.log(`  ${r.label.padEnd(6)} ${r.value}`); push(amount(scaled18(r.value))); }
    }
  } else if (chain === 'evm') {
    console.log(`address   ${json.address}`);
    for (const r of json.rows) {
      if (r.unreadable !== undefined) { console.log(`  ${r.label.padEnd(6)} UNREADABLE (${r.unreadable})`); push(unreadable(r.unreadable)); }
      else if (r.label === 'ETH') {
        // ETH's JSON value is integer wei — the one chain that does not send a dotted decimal.
        const wei = BigInt(r.value);
        console.log(`  ${r.label.padEnd(6)} ${fmtWei(wei)}  (${wei} wei)`);
        push(amount(scaled18(r.value, 18)));
      } else {
        // The child's human line names the raw subunits; the JSON sends the dotted decimal,
        // so reconstruct the integer for the suffix (e.g. "0.128500" -> 128500 subunits).
        const raw = r.value.replace('.', '');
        console.log(`  ${r.label.padEnd(6)} ${r.value}  (${BigInt(raw)} subunits)`);
        push(amount(scaled18(r.value)));
      }
    }
  } else throw new Error(`unknown chain "${chain}"`);
  return entries.map((e, i) => ({label: json.rows[i].label, ...e}));
}

/** Run one chain's balance child with --json, render it, return census rows. Loud, never silent. */
function runBalance(entry) {
  const script = SCRIPT_OF[entry.chain];
  if (!script) { console.log('  UNREADABLE (registry entry has unknown chain)'); return null; }
  let out;
  try {
    out = spawnSync(process.execPath,
      [join(ROOT, script), 'balance', ...(TAKES_ADDRESS.has(entry.chain) ? [entry.address] : []), '--json'], {
      encoding: 'utf8', cwd: ROOT, timeout: 300_000,
      stdio: ['ignore', 'pipe', 'inherit'], // the child's own die() guidance must reach the user
    });
  } catch (e) {
    console.log(`  UNREADABLE (${e.message.split('\n')[0]})`);
    return null;
  }
  const line = (out.stdout ?? '').split('\n').map(l => l.trim()).findLast(l => l.startsWith('{'));
  if (line) {
    try { return renderCensus(entry.chain, JSON.parse(line)); }
    catch (e) { console.log(`  UNREADABLE (child payload unusable: ${e.message.split('\n')[0]})`); return null; }
  }
  const why = out.error ? out.error.message.split('\n')[0] : `exit ${out.status}`;
  console.log(`  UNREADABLE (${why})`);
  return null;
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
    const out = spawnSync(process.execPath, [join(ROOT, SCRIPT_OF.icp), 'balance', w.address], {
      encoding: 'utf8', cwd: ROOT, timeout: 300_000,
      stdio: ['ignore', 'pipe', 'inherit'], // the child's own die() guidance must reach the user
    });
    const lines = (out.stdout ?? '').split('\n').filter(l => l.trim() && !l.startsWith('principal '));
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

/** One CoinGecko spot call for every census label; VCHF stays fixed. Throws on any failure —
 *  the caller then reports the affected assets UNVALUED instead of printing a short total. */
async function chfPrices(labels) {
  const prices = {};
  for (const l of labels) if (l in FIXED_CHF) prices[l] = FIXED_CHF[l];
  const ids = [...new Set(labels.map(l => COINGECKO_ID[l]).filter(Boolean))];
  if (!ids.length) return prices;
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=chf`;
  const res = await fetch(url, {signal: AbortSignal.timeout(20_000)});
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const j = await res.json();
  for (const [label, id] of Object.entries(COINGECKO_ID)) {
    if (labels.includes(label) && j[id]?.chf != null) prices[label] = j[id].chf;
  }
  return prices;
}

/** Sum the ledger's fee rows per asset — every `fee` row since the record began, pre- and
 *  post-genesis-anchor alike (anchors absorb old balances, not old fees). */
function feeTotals() {
  const totals = new Map();
  for (const line of readFileSync(LEDGER, 'utf8').split('\n').filter(l => l.trim())) {
    const r = JSON.parse(line);
    if (r.kind !== 'fee') continue;
    totals.set(r.asset, (totals.get(r.asset) ?? 0n) + scaled18(r.amount));
  }
  return totals;
}

const fmtPrice = p => (p >= 1 ? p.toFixed(2) : p.toPrecision(4));
const fmtChf = v => (v >= 1 ? v.toFixed(2) : v.toPrecision(4));

/** The totals block: per-asset sums across wallets at spot CHF, then fees the ledger recorded. */
async function printTotals(census) {
  const labels = [...census.keys()];
  let prices = {};
  let priceWhy = null;
  try { prices = await chfPrices(labels); }
  catch (e) { priceWhy = String(e.message || e).split('\n')[0]; }

  let grand = 0;
  const unvalued = [];
  console.log(`── totals across wallets · spot CHF (CoinGecko) ${'─'.repeat(8)}`);
  for (const label of labels) {
    const amt = unscaled18(census.get(label));
    const p = prices[label];
    if (p == null) { unvalued.push(label); continue; }
    const chf = Number(amt) * p;
    grand += chf;
    console.log(`  ${label.padEnd(14)} ${amt.padEnd(24)} ${fmtChf(chf).padStart(12)} CHF  (spot ${fmtPrice(p)})`);
  }
  for (const label of unvalued) {
    console.log(`  ${label.padEnd(14)} ${unscaled18(census.get(label)).padEnd(24)} — UNVALUED, no CHF price; EXCLUDED from the total`);
  }
  if (priceWhy) console.log(`  ${'GRAND TOTAL'.padEnd(14)} ${''.padEnd(24)} UNAVAILABLE — prices failed; balances above remain exact`);
  else console.log(`  ${'GRAND TOTAL'.padEnd(14)} ${''.padEnd(24)} ${fmtChf(grand).padStart(12)} CHF`);
  if (unvalued.length) console.log(`   !! unvalued assets: ${unvalued.join(', ')} — add them to COINGECKO_ID/FIXED_CHF in scripts/agent-funds.mjs`);
  console.log('   drift check: `just funds reconcile` — ledger math vs MEASURED, exit 1 on any unrecorded movement');

  console.log('');
  console.log(`── fees paid · ledger rows kind=fee, all time ${'─'.repeat(13)}`);
  const fees = feeTotals();
  let feeGrand = 0;
  const feeUnvalued = [];
  for (const [label, v] of fees) {
    const p = prices[label];
    if (p == null) { feeUnvalued.push(label); continue; }
    const chf = Number(unscaled18(v)) * p;
    feeGrand += chf;
    console.log(`  ${label.padEnd(14)} ${unscaled18(v).padEnd(24)} ${fmtChf(chf).padStart(12)} CHF`);
  }
  for (const label of feeUnvalued) {
    console.log(`  ${label.padEnd(14)} ${unscaled18(fees.get(label)).padEnd(24)} — UNVALUED, no CHF price; EXCLUDED from the total`);
  }
  if (priceWhy) console.log(`  ${'TOTAL FEES'.padEnd(14)} ${''.padEnd(24)} UNAVAILABLE — prices failed`);
  else console.log(`  ${'TOTAL FEES'.padEnd(14)} ${''.padEnd(24)} ${fmtChf(feeGrand).padStart(12)} CHF`);
  return unvalued.length > 0 || feeUnvalued.length > 0 || priceWhy != null;
}

const args = process.argv.slice(2);
const seedFlag = args.includes('--seed');
if (args.some(a => a !== '--seed')) die(`unknown argument(s): ${args.filter(a => a !== '--seed').join(' ')} — usage: agent-funds.mjs [--seed]`);

const wallets = walletList();
console.log('agent-funds — every wallet the agent controls (policy: docs/AGENT-FUNDS.md; spend ceiling CHF 25)\n');

let failed = false;
let seedShown = false;
const census = new Map(); // asset label -> scaled sum across all measured wallets
for (const w of wallets) {
  const label = w.status === 'abandoned-never-fund' ? 'ABANDONED — NEVER FUND' : w.status.toUpperCase();
  console.log(`── ${w.chain} mainnet · ${label} ${'─'.repeat(Math.max(2, 44 - w.chain.length - label.length))}`);
  console.log(`   address ${w.address}`);
  if (w.secret) console.log(`   secret  ${w.secret}`);
  if (w.purpose) console.log(`   purpose ${w.purpose}`);
  if (w.status === 'abandoned-never-fund') {
    failed = watchAbandoned(w) || failed;
    console.log('');
    continue; // never funded, but always WATCHED
  }
  const rows = runBalance(w);
  if (!rows) failed = true;
  else {
    for (const r of rows) {
      if (r.why !== undefined) failed = true;
      else census.set(r.label, (census.get(r.label) ?? 0n) + r.scaled);
    }
  }
  if (seedFlag && w.chain === 'solana' && !w.derived_from && !seedShown) {
    seedShown = true;
    const seedOut = spawnSync(process.execPath, [join(ROOT, SCRIPT_OF.solana), 'seed'], {
      encoding: 'utf8', cwd: ROOT, timeout: 60_000, stdio: ['ignore', 'pipe', 'inherit'],
    });
    const seed = (seedOut.stdout ?? '').trim();
    if (seedOut.status === 0 && seed) {
      console.log(`   seed    ${seed}  <- DECRYPTED just now; approved spend only; never paste anywhere`);
    } else {
      const why = seedOut.error ? seedOut.error.message.split('\n')[0] : `exit ${seedOut.status}`;
      console.log(`   seed    UNREADABLE (decrypt failed: ${why} — see agent-sol error above)`);
      failed = true;
    }
  }
  console.log('');
}

const missing = Object.entries(SCRIPT_OF).filter(([chain]) => !wallets.some(w => w.chain === chain && w.status !== 'abandoned-never-fund'));
const WALLET_ID = {icp: 'icp-float', solana: 'sol-float'};
for (const [chain, script] of missing) {
  console.log(`── ${chain} mainnet · NO KEY ──`);
  console.log(`   none yet — \`just funds init ${WALLET_ID[chain]}\` generates one\n`);
}

// The totals come last so a scan of the output reads balances first, then the one number.
if (census.size > 0) {
  failed = (await printTotals(census)) || failed;
} else {
  console.log('totals: no wallet measurable — nothing to value');
  failed = true;
}

process.exit(failed ? 1 : 0);
