#!/usr/bin/env node
// Agent fund LEASES — who is holding the float right now, and is anything LOST (founder ask
// 2026-09-29: agents may draw on the float at any time, but funds must never be lost silently).
// The ledger (funds/ledger.jsonl, append-only) records what money DID; a lease records what an
// agent CLAIMS BEFORE it touches the float and what it RECONCILES when done:
//
//   (bare) | report   every open lease (agent, worktree, branch, mandate, cap, claims, age),
//                    per-lease claimed vs MEASURED vs ledger math, every unaccounted delta as a
//                    loud LOSS line, and open-cap exposure vs the CHF 25 ceiling
//   open        declare a lease BEFORE touching the float: --agent <session-id> --mandate "…"
//               --cap-chf N [--claim WALLET/ASSET=AMOUNT]… [--worktree P] [--branch B]
//   close <id>  close it: measures the claimed wallets, appends a close event with the final
//               holdings + reconciliation; exits 1 on any loss (the close itself still lands)
//
// Design notes that are NOT obvious from the code:
//
//  - The store is `<main checkout>/funds/leases/` — one JSON file per lease, gitignored
//    (transient per-host claims; the ledger stays tracked). It resolves the MAIN checkout via
//    `git worktree list` no matter which worktree the command runs in, so every worktree sees
//    ONE shared store and the founder ask ("which agent in which worktree") has one answer.
//    Rationale documented in docs/AGENT-FUNDS.md.
//
//  - Balances are NOT re-implemented: the same chain children `just funds` uses
//    (agent-key/agent-sol/agent-evm `balance --json`) are spawned here. Ledger math mirrors
//    funds.mjs `computed()` exactly (genesis anchor + file-ordered moves), so this report can
//    never disagree with `just funds reconcile` about what the ledger says.
//
//  - Leases never rewrite history: a lease file is written once at open and only ever gains
//    `events` entries (close). The LEDGER stays append-only through `just funds add` — a lease
//    has no write path to it at all.
//
//  - A close that measures nothing is refused (UNREADABLE is never zero, never a clean close);
//    a close WITH loss still closes (a lingering open lease hides exposure) but exits 1.
//
// Usage:
//   just funds-agents                       the report (exit 1 on any loss / ceiling breach)
//   just funds-agents open --agent ses_x --mandate "D32 round trip" --cap-chf 2 \
//        --claim icp-float/ICP=0.01
//   just funds-agents close <lease-id> [--note "…"]
import {readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join, resolve} from 'node:path';
import {hostname} from 'node:os';

const SCRIPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CEILING_CHF = '25';
const STALE_MS = 24 * 3600 * 1000;
const DEC = /^\d+(\.\d+)?$/;

/** The MAIN checkout anchors ALL funds state (ledger, registry, lease store): worktrees are
 *  ephemeral, the record is not. First entry of `git worktree list` is the main working tree. */
function mainRoot() {
  try {
    const out = spawnSync('git', ['-C', SCRIPT_ROOT, 'worktree', 'list', '--porcelain'],
      {encoding: 'utf8', timeout: 10_000});
    const line = (out.stdout ?? '').split('\n').find(l => l.startsWith('worktree '));
    if (line) return line.slice('worktree '.length).trim();
  } catch { /* fall through */ }
  return SCRIPT_ROOT;
}

let _main = null;
const MAIN = () => (_main ??= mainRoot());
const LEDGER = () => join(MAIN(), 'funds/ledger.jsonl');
const WALLETS = () => join(MAIN(), 'funds/wallets.json');
const LEASES = () => join(MAIN(), 'funds/leases');
const KEY = () => join(MAIN(), 'scripts/agent-key.mjs');
const SOL = () => join(MAIN(), 'scripts/agent-sol.mjs');
const EVM = () => join(MAIN(), 'scripts/agent-evm.mjs');

function die(msg) {
  console.error(`funds-agents: ${msg}`);
  process.exit(1);
}

// --- decimal math (same shape as funds.mjs: exact BigInt at a common scale) ------------------

const fracLen = s => (String(s).includes('.') ? String(s).split('.')[1].length : 0);
function scaled(s, scale) {
  const [i, f = ''] = String(s).split('.');
  return BigInt((i || '0') + f.padEnd(scale, '0'));
}
/** Exact signed decimal a-b at the max scale of both, trailing zeros trimmed, '-0' → '0'. */
function deltaOf(a, b) {
  const scale = Math.max(fracLen(a), fracLen(b));
  return formatSigned(scaled(a, scale) - scaled(b, scale), scale);
}
function formatSigned(v, scale) {
  if (v === 0n) return '0';
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(scale + 1, '0');
  let s = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  if (scale) s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return neg ? `-${s}` : s;
}
/** Sum decimal strings exactly; the scale covers every input. */
function sumDecimals(list) {
  const scale = Math.max(0, ...list.map(fracLen));
  return formatSigned(list.reduce((acc, s) => acc + scaled(s, scale), 0n), scale);
}

// --- shared inputs: wallets registry, ledger, live census ------------------------------------

function wallets() {
  try {
    return JSON.parse(readFileSync(WALLETS(), 'utf8')).wallets;
  } catch (e) {
    return die(`${WALLETS()} unreadable (${e.message.split('\n')[0]}) — it is committed; restore with git`);
  }
}

function ledgerRows() {
  const p = LEDGER();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map((l, i) => {
    try { return JSON.parse(l); }
    catch (e) { die(`${p}:${i + 1} is not valid JSON — repair by APPENDING a correction row via just funds add, never by editing`); }
  });
}

/** Per wallet/asset computed balance: the genesis anchor plus every later ledger row (file
 *  order — the same semantics as funds.mjs computed(), so the two can never disagree). */
function computedBalances() {
  const map = new Map();
  for (const r of ledgerRows()) {
    const k = `${r.wallet}/${r.asset}`;
    if (r.kind === 'genesis') { map.set(k, {gen: r.amount, moves: []}); continue; }
    const e = map.get(k);
    if (e) e.moves.push(r);
  }
  const out = new Map();
  for (const [k, e] of map) {
    const scale = Math.max(fracLen(e.gen), ...e.moves.map(x => fracLen(x.amount)), 0);
    const total = e.moves.reduce((acc, x) => acc + scaled(x.amount, scale) * (x.direction === 'in' ? 1n : -1n), scaled(e.gen, scale));
    out.set(k, formatSigned(total, scale));
  }
  return out;
}

function censusArgs(w) { return w.census ? ['--census', w.census] : []; }

/** MEASURED census for one wallet through the same chain child `just funds` uses. Returns
 *  {rows:[{label, value|unreadable}]} or null when the child could not run at all. */
function measure(w) {
  const script = w.status === 'abandoned-never-fund' ? [KEY(), 'balance', w.address, '--json']
    : w.chain === 'icp' ? [KEY(), 'balance', '--json']
    : w.chain === 'solana' ? [SOL(), 'balance', w.address, '--json']
    : w.chain === 'evm' ? [EVM(), 'balance', w.address, '--json', ...censusArgs(w)]
    : null;
  if (!script) return null;
  try {
    const out = spawnSync(process.execPath, script,
      {encoding: 'utf8', cwd: MAIN(), timeout: 300_000, stdio: ['ignore', 'pipe', 'inherit']});
    const line = (out.stdout ?? '').split('\n').map(l => l.trim()).findLast(l => l.startsWith('{'));
    if (!line) return null;
    const j = JSON.parse(line);
    return {rows: (j.rows ?? []).map(r => {
      if (r.unreadable !== undefined) return {label: r.label, unreadable: r.unreadable};
      // The EVM child sends native ETH as integer wei and everything else dotted.
      const value = w.chain === 'evm' && !String(r.value).includes('.') ? formatSigned(BigInt(r.value), 18) : String(r.value);
      return {label: r.label, value};
    })};
  } catch { return null; }
}

/** Resolve a claimed asset label to the wallet's census label: exact first, else unique
 *  base-name match (a claim of ETH·Eth against a census row plain "ETH" still resolves). */
function resolveLabel(asset, rows) {
  if (rows.some(r => r.label === asset)) return asset;
  const base = asset.includes('·') ? asset.split('·')[0] : asset;
  const hits = rows.filter(r => (r.label.includes('·') ? r.label.split('·')[0] : r.label) === base);
  return hits.length === 1 ? hits[0].label : null;
}

// --- CHF valuation (one spot call; ZCHF/VCHF pegged at 1 by construction) --------------------

const COINGECKO_ID = {
  ICP: 'internet-computer', ckBTC: 'bitcoin', ckETH: 'ethereum', ETH: 'ethereum',
  SOL: 'solana', ckUSDC: 'usd-coin', USDC: 'usd-coin', EURC: 'euro-coin',
};
const FIXED_CHF = {VCHF: 1, ZCHF: 1};
function priceFor(label, prices) {
  if (label in FIXED_CHF) return FIXED_CHF[label];
  const base = label.includes('·') ? label.split('·')[0] : label;
  if (base in FIXED_CHF) return FIXED_CHF[base];
  return prices[COINGECKO_ID[label] ?? COINGECKO_ID[base] ?? label] ?? null;
}
async function fetchPrices(labels) {
  const ids = [...new Set(labels.map(l => COINGECKO_ID[l] ?? COINGECKO_ID[l.includes('·') ? l.split('·')[0] : l]).filter(Boolean))];
  const out = {};
  if (!ids.length) return out;
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=chf`, {signal: AbortSignal.timeout(20_000)});
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const j = await res.json();
  for (const id of ids) if (j[id]?.chf != null) out[id] = j[id].chf;
  return out;
}
const fmtChf = v => (v >= 1 ? v.toFixed(2) : v.toPrecision(4));

// --- the lease store -------------------------------------------------------------------------

function leaseFiles() {
  const dir = LEASES();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).sort();
}
function loadLease(file) {
  try { return JSON.parse(readFileSync(join(LEASES(), file), 'utf8')); }
  catch (e) { die(`${file} is not valid JSON — a lease file is never hand-edited (${e.message.split('\n')[0]})`); }
}
const isClosed = lease => lease.events.some(e => e.event === 'close');
const leaseAge = lease => Date.now() - Date.parse(lease.opened_at);

function humanAge(ms) {
  if (ms < 0) ms = 0;
  const m = Math.floor(ms / 60_000), s = Math.floor(ms / 1000);
  if (m < 1) return `${s}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 48) return rm ? `${h}h${rm}m` : `${h}h`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

// --- arg parsing -----------------------------------------------------------------------------
// just joins recipe args with spaces and the shell quotes do NOT survive (`just funds-agents
// open --mandate "two words"` arrives as bare tokens). So option values are parsed GREEDILY:
// a value is every following token up to the next --flag. Works identically through just and
// through a direct `node scripts/funds-agents.mjs …` call with real quotes.

/** Split argv into {flags: {name: [values]}, positional: [...]} with greedy multi-token values. */
function parseArgs(a) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (!t.startsWith('--')) { positional.push(t); continue; }
    const name = t.slice(2);
    const vals = [];
    while (i + 1 < a.length && !a[i + 1].startsWith('--')) vals.push(a[++i]);
    flags[name] = vals;
  }
  return {flags, positional};
}

function parseClaims(list) {
  const claims = [];
  for (const c of list ?? []) {
    const eq = c.indexOf('=');
    const slash = c.indexOf('/');
    if (eq < 1 || slash < 1 || slash > eq - 1) die(`bad --claim "${c}" — the form is WALLET/ASSET=AMOUNT (e.g. icp-float/ICP=0.01)`);
    const wallet = c.slice(0, slash), asset = c.slice(slash + 1, eq), amount = c.slice(eq + 1);
    const w = wallets().find(x => x.id === wallet);
    if (!w) die(`claim names unknown wallet "${wallet}" — funds/wallets.json lists: ${wallets().map(x => x.id).join(', ')}`);
    if (w.status === 'abandoned-never-fund') die(`claim names ${wallet} — ABANDONED, NEVER FUND`);
    if (!asset.trim() || asset.includes('/')) die(`bad asset in --claim "${c}"`);
    if (!DEC.test(amount) || Number(amount) <= 0) die(`bad amount in --claim "${c}" — plain decimal > 0, like 0.01`);
    claims.push({wallet, asset, amount});
  }
  return claims;
}

function openLeases(all) { return all.filter(l => !isClosed(l)); }

function capExposure(all) { return sumDecimals(openLeases(all).map(l => l.cap_chf)); }

// --- open ------------------------------------------------------------------------------------

function cmdOpen(a) {
  const {flags: o, positional} = parseArgs(a);
  if (positional.length) die(`unexpected argument(s) "${positional.join(' ')}" — open takes only --flags (see usage)`);
  const one = name => (o[name] ?? [undefined])[0];
  if (!one('agent')) die('open requires --agent <session-id> — a lease without a named agent is how funds get lost');
  if (one('cap-chf') === undefined) die('open requires --cap-chf N — the CHF ceiling this agent commits to (0 = watch-only)');
  const cap = one('cap-chf');
  if (!DEC.test(cap)) die(`bad --cap-chf "${cap}" — plain decimal like 2 or 0.5`);
  const agent = one('agent');
  const mandate = (o.mandate ?? []).join(' ').trim() || (process.env.FUNDS_MANDATE ?? '').trim();
  if (!mandate) die('open requires --mandate "…" (or FUNDS_MANDATE=…) — what this lease is FOR; through `just`, free text with shell metacharacters (; | $ quotes) must go via FUNDS_MANDATE');
  const claims = parseClaims(o.claim);

  const all = leaseFiles().map(loadLease);
  const open = openLeases(all);
  const mine = open.find(l => l.agent === agent);
  if (mine) die(`agent ${agent} already holds OPEN lease ${mine.id} (${mine.worktree}) — close it first: just funds-agents close ${mine.id}`);
  const exposure = capExposure(all);
  const newTotal = sumDecimals([exposure, cap]);
  if (Number(newTotal) > Number(CEILING_CHF)) {
    die(`cap refused: open leases already expose CHF ${exposure} and this adds CHF ${cap} — over the CHF ${CEILING_CHF} ceiling. Close leases or lower the cap.`);
  }

  let worktree = one('worktree'), branch = one('branch');
  if (!worktree || !branch) {
    const g = spawnSync('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], {encoding: 'utf8', timeout: 10_000});
    const lines = (g.stdout ?? '').split('\n').filter(l => l.trim());
    worktree ??= lines[0] ?? process.cwd();
    branch ??= lines[1] ?? 'unknown';
  }
  const opened_at = new Date().toISOString();
  const id = `${opened_at.replace(/[:.]/g, '-')}-${agent.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40)}`;
  const lease = {
    id,
    agent,
    host: hostname(),
    pid: process.ppid,
    worktree,
    branch,
    mandate,
    cap_chf: cap,
    claims,
    opened_at,
    events: [{ts: opened_at, event: 'open'}],
  };
  mkdirSync(LEASES(), {recursive: true});
  writeFileSync(join(LEASES(), `${id}.json`), JSON.stringify(lease, null, 2) + '\n');
  console.log(`funds-agents: lease ${id} OPENED (declared before touching float)`);
  console.log(`  agent ${agent} · ${worktree} (${branch}) · cap CHF ${cap}${claims.length ? '' : ' · no asset claims (watch-only)'}`);
  for (const c of claims) console.log(`  claim ${c.wallet} ${c.asset} ${c.amount}`);
  console.log(`  open-cap exposure now CHF ${newTotal} of CHF ${CEILING_CHF} ceiling`);
  console.log(`  close with: just funds-agents close ${id} --note "…"`);

  // The claims are a declaration, but a claim naming an asset the wallet's census never
  // produces would surface as a fake LOSS later — one cheap live check NOW, while the agent
  // is still here to fix the typo.
  if (claims.length) {
    const seen = new Map();
    for (const c of claims) if (!seen.has(c.wallet)) seen.set(c.wallet, measure(wallets().find(w => w.id === c.wallet)));
    for (const c of claims) {
      const m = seen.get(c.wallet);
      if (m && resolveLabel(c.asset, m.rows) === null && m.rows.length) {
        console.log(`  !! claim asset "${c.asset}" is NOT in ${c.wallet}'s census (it has: ${m.rows.map(r => r.label).join(', ')}) — fix or it will report as a loss`);
        process.exitCode = 1;
      }
    }
  }
}

// --- close -----------------------------------------------------------------------------------

async function cmdClose(a) {
  const {flags, positional} = parseArgs(a);
  const id = positional[0];
  const note = (flags.note ?? []).join(' ').trim() || (process.env.FUNDS_NOTE ?? '').trim() || undefined;
  if (!id) die('usage: funds-agents close <lease-id> [--note "…"]');
  const file = leaseFiles().find(f => f.startsWith(id));
  if (!file) die(`no lease file matches "${id}" — the store is ${LEASES()}`);
  if (leaseFiles().filter(f => f.startsWith(id)).length > 1) die(`"${id}" matches several leases — use a longer prefix`);
  const lease = loadLease(file);
  if (isClosed(lease)) die(`lease ${lease.id} is already closed at ${lease.events.find(e => e.event === 'close').ts} — a close is never rewritten`);

  const comp = computedBalances();
  const byWallet = new Map();
  for (const c of lease.claims) if (!byWallet.has(c.wallet)) byWallet.set(c.wallet, measure(wallets().find(w => w.id === c.wallet)));

  const rows = [];
  let losses = [];
  let drifts = [];
  for (const c of lease.claims) {
    const m = byWallet.get(c.wallet);
    if (!m) { die(`${c.wallet} could not be measured — UNREADABLE is never zero and never a clean close; retry when the chain is reachable`); }
    const label = resolveLabel(c.asset, m.rows);
    const mr = label ? m.rows.find(r => r.label === label) : null;
    if (!mr) {
      rows.push({wallet: c.wallet, asset: c.asset, claimed: c.amount, measured: null, delta: null,
        label_error: `not in ${c.wallet}'s census (${m.rows.map(r => r.label).join(', ') || 'empty'})`});
      losses.push(`${c.wallet} ${c.asset}: claimed ${c.amount}, census has no such label`);
      continue;
    }
    if (mr.unreadable !== undefined) {
      die(`${c.wallet} ${label} is UNREADABLE (${mr.unreadable}) — cannot certify the close; retry when measurable`);
    }
    const delta = deltaOf(mr.value, c.amount);
    const ledgerVal = comp.get(`${c.wallet}/${c.asset}`) ?? null;
    const ledgerOk = ledgerVal === null ? null : deltaOf(ledgerVal, mr.value) === '0';
    rows.push({wallet: c.wallet, asset: c.asset, claimed: c.amount, measured: mr.value, delta, ledger: ledgerVal, ledger_ok: ledgerOk});
    if (delta.startsWith('-')) losses.push(`${c.wallet} ${c.asset}: claimed ${c.amount}, measured ${mr.value}, delta ${delta}`);
    if (ledgerOk === false) drifts.push(`${c.wallet} ${c.asset}: ledger ${ledgerVal} vs measured ${mr.value} — an unrecorded movement (just funds add, never edit)`);
  }

  // Loss CHF at spot (display only — the asset-unit delta is the hard truth).
  let lossChf = 0, priceWhy = null, priceFail = false;
  const labels = rows.filter(r => r.measured !== null).map(r => r.asset);
  try {
    const prices = await fetchPrices(labels);
    for (const r of rows) {
      if (!(r.delta ?? '').startsWith('-')) continue;
      const p = priceFor(r.asset, prices);
      if (p == null) priceFail = true;
      else lossChf += Math.abs(Number(r.delta)) * p;
    }
  } catch (e) { priceWhy = String(e.message || e).split('\n')[0]; }

  lease.events.push({
    ts: new Date().toISOString(), event: 'close', note: note ?? null, rows,
    loss_chf: Number(lossChf.toFixed(6)),
    loss_chf_unpriced: priceFail || priceWhy != null ? true : undefined,
  });
  writeFileSync(join(LEASES(), file), JSON.stringify(lease, null, 2) + '\n');

  console.log(`funds-agents: lease ${lease.id} CLOSED — reconciliation (append-only: the close is a new event, history untouched)`);
  for (const r of rows) {
    if (r.measured === null) console.log(`  ${r.wallet.padEnd(12)} ${r.asset.padEnd(8)} claimed ${r.claimed}  ${r.label_error}`);
    else console.log(`  ${r.wallet.padEnd(12)} ${r.asset.padEnd(8)} claimed ${r.claimed.padStart(10)}  measured ${r.measured.padStart(14)}  delta ${(r.delta.startsWith('-') ? '' : '+') + r.delta}${r.ledger === null ? '  (no ledger rows for this pair)' : r.ledger_ok ? '  ledger OK' : `  ledger ${r.ledger} DRIFT`}`);
  }
  if (!rows.length) console.log('  no asset claims (watch-only) — nothing to reconcile');
  if (!losses.length && !drifts.length) console.log(`  clean — loss this lease CHF ${lossChf.toFixed(6)}`);
  for (const l of losses) console.log(`  !! LOSS ${l}${priceWhy ? `  (CHF value unavailable: ${priceWhy})` : priceFail ? '  (CHF value unavailable: no price for the asset)' : `  ≈ CHF ${lossChf.toFixed(6)}`}`);
  for (const d of drifts) console.log(`  !! DRIFT ${d}`);
  if (losses.length || drifts.length) {
    console.log('  the close is recorded; the loss is named — never silent. Recover the funds as a first-class task (CLAUDE.md float rules).');
    process.exitCode = 1;
  }
}

// --- report ----------------------------------------------------------------------------------

async function cmdReport() {
  const all = leaseFiles().map(loadLease);
  const open = openLeases(all);
  const closed = all.filter(isClosed);
  console.log(`funds-agents — agent fund leases · store ${LEASES()} (gitignored, shared via the main checkout) · ceiling CHF ${CEILING_CHF}\n`);

  // Measure every wallet any OPEN lease claims, exactly once.
  const measured = new Map();
  const comp = computedBalances();
  let measureFail = false;
  for (const l of open) {
    for (const c of l.claims) {
      if (measured.has(c.wallet)) continue;
      const w = wallets().find(x => x.id === c.wallet);
      measured.set(c.wallet, w ? measure(w) : null);
    }
  }

  let losses = [], drifts = [], unknowns = [];
  console.log(`── open leases (${open.length}) ${'─'.repeat(40)}`);
  if (!open.length) console.log('  none — the float is unclaimed right now');
  for (const l of open) {
    const age = humanAge(leaseAge(l));
    console.log(`  ${l.id}`);
    console.log(`    agent ${l.agent} · opened ${l.opened_at} · age ${age}${leaseAge(l) > STALE_MS ? `  !! STALE (>24h) — close it or say why` : ''} · cap CHF ${l.cap_chf}`);
    console.log(`    worktree ${l.worktree} · branch ${l.branch}${l.host ? ` · host ${l.host}` : ''}`);
    console.log(`    mandate ${l.mandate}`);
    if (!l.claims.length) console.log('    claims none (watch-only)');
    for (const c of l.claims) {
      const m = measured.get(c.wallet);
      if (!m) { unknowns.push(`${c.wallet}: wallet measure failed`); console.log(`    claim ${c.wallet} ${c.asset} ${c.amount} → MEASURE FAILED (never zero)`); continue; }
      const label = resolveLabel(c.asset, m.rows);
      const mr = label ? m.rows.find(r => r.label === label) : null;
      if (!mr) {
        const row = m.rows.find(r => r.label === c.asset);
        if (row?.unreadable !== undefined) { unknowns.push(`${c.wallet} ${c.asset}: ${row.unreadable}`); console.log(`    claim ${c.wallet} ${c.asset} ${c.amount} → UNREADABLE (${row.unreadable})`); }
        else { losses.push(`${c.wallet} ${c.asset}: claimed ${c.amount}, census has no such label (has: ${m.rows.map(r => r.label).join(', ') || 'empty'})`); console.log(`    claim ${c.wallet} ${c.asset} ${c.amount} → LABEL NOT IN CENSUS`); }
        continue;
      }
      if (mr.unreadable !== undefined) { unknowns.push(`${c.wallet} ${label}: ${mr.unreadable}`); console.log(`    claim ${c.wallet} ${c.asset} ${c.amount} → UNREADABLE (${mr.unreadable})`); continue; }
      const delta = deltaOf(mr.value, c.amount);
      const ledgerVal = comp.get(`${c.wallet}/${c.asset}`) ?? null;
      const ledgerOk = ledgerVal === null ? null : deltaOf(ledgerVal, mr.value) === '0';
      console.log(`    claim ${c.wallet} ${c.asset} ${c.amount} → measured ${mr.value} · delta ${(delta.startsWith('-') ? '' : '+') + delta}${ledgerVal === null ? ' · no ledger rows for this pair' : ledgerOk ? ' · ledger OK' : ` · ledger ${ledgerVal} DRIFT`}`);
      if (delta.startsWith('-')) losses.push(`${c.wallet} ${c.asset}: claimed ${c.amount}, measured ${mr.value}, delta ${delta}`);
      if (ledgerOk === false) drifts.push(`${c.wallet} ${c.asset}: ledger ${ledgerVal} vs measured ${mr.value} — an unrecorded movement (just funds add)`);
    }
  }

  // CHF value of what open leases claim, and the cap exposure vs the ceiling.
  console.log(`\n── exposure vs ceiling CHF ${CEILING_CHF} ${'─'.repeat(30)}`);
  const exposure = capExposure(all);
  const over = Number(exposure) > Number(CEILING_CHF);
  console.log(`  open-cap exposure CHF ${exposure}${over ? `  !! OVER THE CEILING by CHF ${deltaOf(exposure, CEILING_CHF)}` : `  of CHF ${CEILING_CHF}`}`);
  const claimLabels = [...new Set(open.flatMap(l => l.claims.map(c => c.asset)))];
  let claimChf = 0, priceWhy = null;
  try {
    const prices = await fetchPrices(claimLabels);
    for (const l of open) for (const c of l.claims) {
      const p = priceFor(c.asset, prices);
      if (p != null) claimChf += Number(c.amount) * p;
    }
  } catch (e) { priceWhy = String(e.message || e).split('\n')[0]; }
  console.log(`  claimed holdings ≈ CHF ${priceWhy ? `? (${priceWhy})` : fmtChf(claimChf) || '0'} at spot${priceWhy ? ' — deltas above stay exact in asset units' : ''}`);

  console.log(`\n── history ${'─'.repeat(48)}`);
  if (!closed.length) console.log('  no closed leases yet');
  else {
    let lifeLoss = 0;
    for (const l of closed) for (const e of l.events) if (e.event === 'close') lifeLoss += e.loss_chf ?? 0;
    const last = closed[closed.length - 1];
    const lastClose = last.events.find(e => e.event === 'close');
    console.log(`  closed leases ${closed.length} · all-time recorded loss CHF ${lifeLoss.toFixed(6)}${lifeLoss > 0 ? '  !! losses on record — see the close events' : ''}`);
    console.log(`  last: ${last.id} closed ${lastClose.ts}${lastClose.loss_chf ? ` with loss CHF ${lastClose.loss_chf}` : ' clean'}`);
  }

  console.log(`\n── verdict ${'─'.repeat(48)}`);
  let bad = false;
  for (const l of losses) { console.log(`  !! LOSS ${l} — UNACCOUNTED DELTA, funds may be lost; recover as a first-class task`); bad = true; }
  for (const d of drifts) { console.log(`  !! DRIFT ${d}`); bad = true; }
  for (const u of unknowns) { console.log(`  !! UNKNOWN ${u} — unmeasurable is not clean`); bad = true; }
  if (over) bad = true;
  if (!bad) console.log(`  CLEAN — every open lease holds at least what it claimed, ledger agrees, exposure within CHF ${CEILING_CHF}`);
  else console.log('  losses are never silent — fix the named gaps before any new float movement');
  process.exitCode = bad ? 1 : 0;
}

// --- entry point -----------------------------------------------------------------------------

const main = async () => {
  const a = process.argv.slice(2);
  const cmd = a[0];
  if (cmd === undefined || cmd === 'report') await cmdReport();
  else if (cmd === 'open') cmdOpen(a.slice(1));
  else if (cmd === 'close') await cmdClose(a.slice(1));
  else die(`usage: funds-agents.mjs <report|open|close>  (bare = report)`);
};

// Runnable directly AND importable for tests (scripts/funds-agents.test.mjs).
const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) await main();

export {deltaOf, formatSigned, sumDecimals, parseClaims, priceFor, humanAge, capExposure, resolveLabel, mainRoot, CEILING_CHF};
