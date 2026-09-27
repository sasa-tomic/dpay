#!/usr/bin/env node
// The ONLY interfaces to the agent-funds record — the testruns.py precedent, applied to money
// (founder ask 2026-09-19: the record must be version-controlled, and using the tooling is a HARD
// rule, not a habit). The custody scripts (agent-key.mjs / agent-sol.mjs / agent-funds.mjs) stay
// the per-chain mechanism; this file is the single CLI on top of them — every subcommand is
// reachable as `just funds <subcommand>` (founder ask 2026-09-20: ONE way to do all of it; the
// old `just agent-*` recipe names were deleted 2026-09-20 — no forwarding stubs).
//
//   (bare)        overview — every wallet + every live balance + the abandoned-principal watch
//   balance [W]   one wallet's live census, measured (default: the IC float; UNREADABLE never 0)
//   history [W]   what the money DID: ICP transfers + block indexes (IC wallets; default icp-float)
//   address [W]   the funding address, no decryption (default: icp-float; + funding-safety block)
//   seed <W>      the seed hex — DECRYPTS; only immediately before an approved spend
//   init <W>      generate a NEW key for that wallet (refuses if one exists)
//   add           append ONE validated movement to funds/ledger.jsonl. The JSONL is append-only
//                 and this is its only writer — corrections are NEW `correction` rows referencing
//                 the original, never edits.
//   import F      append many validated rows from a JSON array file (backfill / ingesting rows
//                 that were hand-written into the doc before this tooling existed).
//   doc           re-render the two GENERATED tables in docs/AGENT-FUNDS.md from funds/ (the
//                 FLOWS.md pattern: committed doc, rendered tables, hand-written prose around
//                 them).
//   reconcile     computed-from-ledger vs MEASURED live balances per wallet/asset. The carelessness
//                 tripwire: any movement after a wallet's genesis anchor that has no ledger row is
//                 a loud DRIFT and a nonzero exit — an unrecorded movement can never look clean.
//
// Wallet ids come from funds/wallets.json, the authoritative registry: icp-float, sol-float,
// icp-float-old. Addresses are public; seeds stay sops-encrypted under secrets/ — nothing in
// funds/ is secret. Genesis rows anchor each wallet/asset at a MEASURED balance; rows dated before
// the anchor are absorbed history (kept for audit), rows after it must be explained exactly by the
// math, or reconcile fails.
//
// Usage:
//   just funds                 (bare = overview)
//   just funds add --kind spend --wallet icp-float --asset ICP --amount 0.01 \
//        --direction out --counterparty "..." --tx icp:12345 --purpose "..."
//   just funds import /tmp/opencode/backfill.json   (shred the file afterwards)
//   just funds doc | reconcile | balance [W] | history [W] | address [W] | seed <W> | init <W>
import {readFileSync, writeFileSync, existsSync, appendFileSync} from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = join(ROOT, 'funds/ledger.jsonl');
const WALLETS = join(ROOT, 'funds/wallets.json');
const DOC = join(ROOT, 'docs/AGENT-FUNDS.md');
const KEY = join(ROOT, 'scripts/agent-key.mjs');
const SOL = join(ROOT, 'scripts/agent-sol.mjs');
const EVM = join(ROOT, 'scripts/agent-evm.mjs');
const OVERVIEW = join(ROOT, 'scripts/agent-funds.mjs');
const KINDS = ['genesis', 'deposit', 'spend', 'convert', 'fee', 'correction'];
const FIELDS = ['ts', 'kind', 'wallet', 'asset', 'amount', 'direction', 'counterparty', 'tx', 'purpose'];
const DEC = /^\d+(\.\d+)?$/;
const TS = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/;

function die(msg) {
  console.error(`funds: ${msg}`);
  process.exit(1);
}

function wallets() {
  return JSON.parse(readFileSync(WALLETS, 'utf8')).wallets;
}

/** Registry lookup for the custody subcommands. Default = the first live wallet (the IC float);
 *  `seed`/`init` require an explicit id — an ambiguous decrypt or init is how mistakes happen. */
function resolveWallet(name, required = false) {
  const all = wallets();
  const ids = all.map(w => w.id).join(', ');
  if (!name) {
    if (required) die(`a wallet id is required — funds/wallets.json lists: ${ids}`);
    const live = all.find(w => w.status.startsWith('live'));
    if (!live) die('no live wallet in funds/wallets.json');
    return live;
  }
  const w = all.find(w => w.id === name);
  if (!w) die(`unknown wallet "${name}" — funds/wallets.json lists: ${ids}`);
  return w;
}

/** Run a custody script as if the user ran it — byte-identical output, exit code propagated. */
function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], {cwd: ROOT, stdio: 'inherit', timeout: 300_000});
  if (r.error) die(`${script} failed to start (${r.error.message.split('\n')[0]})`);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function rows() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf8').split('\n').filter(l => l.trim()).map((l, i) => {
    try { return JSON.parse(l); }
    catch (e) { die(`${LEDGER}:${i + 1} is not valid JSON — the ledger is corrupt; repair by APPENDING a correction row, never by editing (${e.message})`); }
  });
}

/** Validate one row and return it serialized in canonical field order. Dies loudly — a ledger
 *  row that cannot be parsed later is worse than no row. */
function validate(r) {
  const miss = FIELDS.filter(f => r[f] === undefined);
  if (miss.length) die(`row is missing field(s): ${miss.join(', ')}`);
  if (!KINDS.includes(r.kind)) die(`bad kind "${r.kind}" — one of ${KINDS.join('|')}`);
  if (!['in', 'out'].includes(r.direction)) die(`bad direction "${r.direction}" — in|out`);
  if (!DEC.test(r.amount)) die(`bad amount "${r.amount}" — plain decimal string like 0.02`);
  if (!TS.test(r.ts)) die(`bad ts "${r.ts}" — ISO date (2026-09-19) or full ISO timestamp`);
  if (typeof r.purpose !== 'string' || !r.purpose.trim()) {
    die('purpose is required — the ledger records what moved, the purpose records WHY');
  }
  if (r.kind === 'genesis' && r.direction !== 'in') die('genesis rows are direction in');
  if (r.kind === 'deposit' && r.direction !== 'in') die('deposit rows are direction in');
  if (['spend', 'fee'].includes(r.kind) && r.direction !== 'out') die(`${r.kind} rows are direction out`);
  if (!wallets().some(w => w.id === r.wallet)) die(`unknown wallet "${r.wallet}" — funds/wallets.json is the registry`);
  for (const f of ['counterparty', 'tx']) {
    if (r[f] !== null && typeof r[f] !== 'string') die(`${f} must be a string or null`);
  }
  return JSON.stringify({
    ts: r.ts, kind: r.kind, wallet: r.wallet, asset: r.asset, amount: r.amount,
    direction: r.direction, counterparty: r.counterparty ?? null, tx: r.tx ?? null, purpose: r.purpose,
  });
}

function append(line) {
  appendFileSync(LEDGER, line + '\n');
}

function cmdAdd() {
  const a = process.argv.slice(3);
  if (a.length % 2) die('usage: funds.mjs add --field value ... (--ts/--counterparty/--tx optional)');
  const r = {};
  for (let i = 0; i < a.length; i += 2) {
    if (!a[i].startsWith('--')) die(`expected --field at "${a[i]}"`);
    r[a[i].slice(2)] = a[i + 1];
  }
  if (!r.ts) r.ts = new Date().toISOString();
  if (!r.ts.includes('T')) die('add requires a FULL ISO timestamp — bare dates are for import (history rows only); a bare date can sort before today\'s genesis instant and be silently absorbed');
  const line = validate(r);
  append(line);
  const n = rows().length;
  console.log(`funds: appended row ${n} — ${r.kind} ${r.direction} ${r.amount} ${r.asset} (${r.wallet})`);
}

function cmdImport() {
  const file = process.argv[3];
  if (!file) die('usage: funds.mjs import <file-with-JSON-array> — shred the file afterwards');
  const list = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(list)) die(`${file} must contain a JSON array of rows`);
  for (const r of list) append(validate(r));
  console.log(`funds: appended ${list.length} rows (${rows().length} total)`);
}

/** The two GENERATED regions in docs/AGENT-FUNDS.md, rendered from funds/. Idempotent: the same
 *  funds/ always renders the same bytes. Hand-edits inside the markers are LOST on the next
 *  render — that is the point; rows are ingested through add/import instead. */
function cmdDoc() {
  const rs = rows().slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const wtab = [
    '| Wallet | Chain | Address | Secret | Status | What it is for |',
    '|--------|-------|---------|--------|--------|----------------|',
    ...wallets().map(w =>
      `| \`${w.id}\` | ${w.chain} | \`${w.address}\` | ${w.secret ? `\`${w.secret}\`` : 'none (destroyed)'} | `
      + `${w.status === 'abandoned-never-fund' ? '**abandoned — NEVER FUND**' : w.status} | ${w.purpose}`
      + `${w.custody ? `; custody \`${w.custody}\`` : ''} |`),
  ];
  const stab = [
    '| Date | Kind | Wallet | Asset | Amount | To / From | Tx | Purpose |',
    '|------|------|--------|-------|--------|-----------|----|---------|',
    ...rs.map(r =>
      `| ${r.ts.slice(0, 10)} | ${r.kind} | \`${r.wallet}\` | ${r.asset} | `
      + `${r.direction === 'in' ? '+' : '-'}${r.amount} | ${r.counterparty ?? '—'} | `
      + `${r.tx ? `\`${r.tx}\`` : '—'} | ${r.purpose} |`),
  ];
  renderRegion(wtab, 'wallets');
  renderRegion(stab, 'spendlog');
  console.log('funds: rendered docs/AGENT-FUNDS.md GENERATED tables (wallets, spendlog)');
}

function renderRegion(lines, name) {
  const open = `<!-- GENERATED:${name} -->`;
  const close = `<!-- /GENERATED:${name} -->`;
  const src = readFileSync(DOC, 'utf8');
  const a = src.indexOf(open);
  const b = src.indexOf(close);
  if (a < 0 || b < 0 || b < a) die(`${DOC}: GENERATED markers for ${name} are missing — re-add them before rendering`);
  const note = '_GENERATED by `scripts/funds.mjs doc` from `funds/` — do not hand-edit. '
    + 'Record a movement with `just funds add …` (HARD HARD RULE — CLAUDE.md), then re-render with `just funds doc`._';
  writeFileSync(DOC, `${src.slice(0, a + open.length)}\n${note}\n\n${lines.join('\n')}\n${src.slice(b)}`);
}

// --- reconcile -------------------------------------------------------------

/** Decimal string → BigInt at a fixed scale, so 0.129610 === 0.12961 compares equal. */
function scaled(s, scale) {
  const [i, f = ''] = s.split('.');
  return BigInt(i + f.padEnd(scale, '0'));
}
function fracLen(s) { return s.includes('.') ? s.split('.')[1].length : 0; }
function eq(a, b) { const m = Math.max(fracLen(a), fracLen(b)); return scaled(a, m) === scaled(b, m); }

/** Ledger math: per wallet/asset, the genesis anchor plus every movement dated AFTER it.
 *  Rows dated before the anchor are absorbed history — audit-only by design. */
function computed() {
  const map = new Map();
  for (const r of rows()) {
    const k = `${r.wallet}/${r.asset}`;
    if (r.kind === 'genesis') {
      if (map.has(k)) die(`two genesis anchors for ${k} — corrections are rows, never a second anchor`);
      map.set(k, {gen: r.amount, genTs: r.ts, moves: []});
      continue;
    }
    const e = map.get(k);
    if (e) e.moves.push(r); // no anchor yet → absorbed history; after the anchor → counted
  }
  return map;
}

/** MEASURED balances through the custody scripts' own `balance --json` (one balance
 *  implementation per chain; the abandoned principal and the derived sol-rail need no key at
 *  all — their addresses are public). */
function measure(w) {
  const script = w.status === 'abandoned-never-fund' ? [KEY, 'balance', w.address, '--json']
    : w.chain === 'icp' ? [KEY, 'balance', '--json']
    : w.chain === 'solana' ? [SOL, 'balance', w.address, '--json'] // keyless: registry address; sol-rail derives from the IC seed
    : w.chain === 'evm' ? [EVM, 'balance', w.address, '--json']
    : null;
  if (!script) return null;
  try {
    const out = execFileSync(process.execPath, script, {
      encoding: 'utf8', cwd: ROOT, timeout: 300_000, stdio: ['ignore', 'pipe', 'inherit'],
    });
    return JSON.parse(out);
  } catch (e) {
    return null; // every pair of this wallet becomes UNKNOWN — never zero
  }
}

function cmdReconcile() {
  const comp = computed();
  let bad = 0, unknown = 0, pairs = 0;
  const fail = m => { console.log(m); bad++; };
  console.log('funds reconcile — computed-from-ledger vs MEASURED live (an unrecorded movement cannot look clean)');
  for (const w of wallets()) {
    const m = measure(w);
    if (!m) { unknown++; console.log('  (wallet measure failed — every asset UNKNOWN, never zero)'); continue; }
    const measured = new Map((m.rows ?? []).map(r => [r.label, r]));
    console.log(`\nwallet ${w.id} (${w.status})${m ? '' : ' — UNREADABLE'}`);
    const seen = new Set();
    for (const r of m?.rows ?? []) {
      if (r.unreadable !== undefined) { unknown++; console.log(`  ${r.label.padEnd(6)} UNKNOWN  (measure failed: ${r.unreadable})`); continue; }
      const k = `${w.id}/${r.label}`;
      const e = comp.get(k);
      seen.add(r.label);
      if (!e) { fail(`  ${r.label.padEnd(6)} DRIFT    measured ${r.value} — no genesis anchor in the ledger; add one`); continue; }
      let sum = 0n;
      const scale = Math.max(fracLen(e.gen), ...e.moves.map(x => fracLen(x.amount)), fracLen(r.value));
      for (const x of e.moves) sum += scaled(x.amount, scale) * (x.direction === 'in' ? 1n : -1n);
      // A negative computed sum (over-recorded history, mid-arbitration) must render honestly,
      // never crash: padStart on the signed string would insert zeros BEFORE the '-' sign
      // (0-6441354) and the sliced halves would feed BigInt garbage. Strip the sign first,
      // format the magnitude, then re-attach it.
      const total = scaled(e.gen, scale) + sum;
      const neg = total < 0n;
      const digits = (neg ? -total : total).toString().padStart(scale + 1, '0');
      const computedStr = (neg ? '-' : '') + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits); // scale 0 (integer wei rows): no dot
      pairs++;
      if (eq(computedStr, r.value)) console.log(`  ${r.label.padEnd(6)} OK       computed ${computedStr}  measured ${r.value}`);
      else fail(`  ${r.label.padEnd(6)} DRIFT    computed ${computedStr}  measured ${r.value} — a movement has no ledger row; record it (just funds add) and re-run`);
    }
    for (const [k, e] of comp) {
      if (!k.startsWith(`${w.id}/`)) continue;
      const asset = k.split('/')[1];
      if (!seen.has(asset)) fail(`  ${asset.padEnd(6)} MAPPING  in the ledger but not in the balance output — asset name and balance label disagree`);
    }
  }
  console.log(`\nresult: ${pairs} pair(s) checked — ${bad === 0 && unknown === 0 ? 'CLEAN' : `${bad} drift/mapping, ${unknown} unknown`}`);
  if (bad || unknown) {
    console.log('A DRIFT is an unrecorded movement: append the missing row(s) — never edit existing ones.');
    console.log('UNKNOWN is not clean either: a balance that cannot be measured cannot be certified.');
    process.exit(1);
  }
}

// --- the ONE entry point: custody subcommands over the per-chain scripts --------------------

function cmdOverview() { run(OVERVIEW, []); }

function cmdBalance() {
  const w = resolveWallet(process.argv[3]);
  if (w.chain === 'icp') run(KEY, ['balance', w.address]); // explicit principal: keyless, byte-identical
  else if (w.chain === 'solana') run(SOL, ['balance', w.address]); // keyless by address (sol-rail has no key file)
  else if (w.chain === 'evm') run(EVM, ['balance', w.address]);
  else die(`wallet ${w.id} has unknown chain "${w.chain}"`);
}

/** A derived wallet has NO seed of its own — its key material is the root wallet's seed plus a
 *  documented SLIP-10 path. `seed`/`init` on it would silently act on the WRONG key (init would
 *  mint an independent one the app can never sign from), so both refuse and point at the root. */
function guardDerived(w, what) {
  if (!w.derived_from) return;
  die(`${w.id} has no seed of its own — it is derived from ${w.derived_from.wallet} at ${w.derived_from.path} `
      + `(${w.derived_from.code}). The secret file is ${w.secret}; ${what} acts on the ROOT key: `
      + `\`just funds ${what} ${w.derived_from.wallet}\``);
}

function cmdHistory() {
  const w = resolveWallet(process.argv[3]);
  if (w.chain !== 'icp') die(`history is implemented for IC wallets only (the pinned ICP index) — ${w.id} is on ${w.chain}`);
  run(KEY, ['history', w.address]);
}

function cmdAddress() {
  const w = resolveWallet(process.argv[3]);
  if (w.status === 'abandoned-never-fund') {
    die(`${w.id} is ABANDONED — NEVER FUND (its seed is destroyed; a send there is unrecoverable). `
        + 'Its address is only ever listed by `just funds`, never handed out for funding.');
  }
  if (w.chain === 'icp') run(KEY, ['principal']);
  else if (w.chain === 'solana') run(SOL, ['principal', w.address]); // registry address: sol-rail has no pub file
  else if (w.chain === 'evm') console.log(w.address); // public, committed in secrets/agent-evm.pub.json
  else die(`wallet ${w.id} has unknown chain "${w.chain}"`);
}

function cmdSeed() {
  const w = resolveWallet(process.argv[3], true);
  guardDerived(w, 'seed');
  if (w.chain === 'icp') run(KEY, ['seed']);
  else if (w.chain === 'solana') run(SOL, ['seed']);
  else die(`wallet ${w.id} has unknown chain "${w.chain}"`);
}

function cmdInit() {
  const w = resolveWallet(process.argv[3], true);
  guardDerived(w, 'init');
  if (w.chain === 'icp') run(KEY, ['init']);
  else if (w.chain === 'solana') run(SOL, ['init']);
  else die(`wallet ${w.id} has unknown chain "${w.chain}"`);
}

const CMDS = {
  add: cmdAdd, import: cmdImport, doc: cmdDoc, reconcile: cmdReconcile,
  overview: cmdOverview, balance: cmdBalance, history: cmdHistory,
  address: cmdAddress, seed: cmdSeed, init: cmdInit,
};
const cmd = process.argv[2];
if (cmd === undefined) CMDS.overview();
else if (!CMDS[cmd]) die(`usage: just funds <${Object.keys(CMDS).join('|')}>  (bare = overview)`);
else CMDS[cmd]();
