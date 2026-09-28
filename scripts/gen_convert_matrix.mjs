#!/usr/bin/env node
/* GENERATED convert-coverage doc — docs/CONVERT_MATRIX.md — ONE DERIVED SOURCE.
 *
 * Reads dpay's own registries and renders the conversion matrix as a VIEW:
 *   - dfx/catalog_truth.json  venues[] + principals (the drift-alarmed venue registry)
 *   - dfx/venue_health.json   settlement-SLA measurements (the relay's health source)
 *   - app/solana/tokens.ts    the SPL mint registry (the app's one copy of each mint)
 *   - per-family static facts (below): rate type + the last MEASURED probe per venue family
 *
 * The app's pickers derive from the SAME registry (app/config/venues.ts — drift-alarmed
 * against the truth file): this doc is never an input to the app, and the app never reads
 * a number from here. Probe dates are RECORDS of measurements (where to re-check), never
 * cached venue numbers. Testnet rows (the offline fixture) are excluded.
 *
 * Usage: node scripts/gen_convert_matrix.mjs           (regenerate the doc)
 *        node scripts/gen_convert_matrix.mjs --check    (exit 1 + diff when stale/hand-edited)
 * Wired as `just convert-matrix`, gated inside `just check` beside flows-md, and pinned by
 * app/__tests__/convertMatrix.test.ts (regenerate-and-diff + registry coverage).
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SOLANA_TOKENS, WRAPPED_SOL_MINT_ADDRESS} from '../app/solana/tokens.ts';
// The EVM-native cefi rows (2026-09-27) live OUTSIDE the truth file's venues[] — native ETH
// has no catalog row, so their venue rows are adapter-owned (the relay's sideshift adapter +
// the app's bundled twin). This module is dependency-free PURE by contract, so the generator
// can import it: the doc stays a VIEW over the app's own registries.
import {EVM_NATIVE_VENUES, ETH_NATIVE_RAIL_ID} from '../app/config/evmConvert.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TRUTH = JSON.parse(readFileSync(join(ROOT, 'dfx/catalog_truth.json'), 'utf8'));
const HEALTH = JSON.parse(readFileSync(join(ROOT, 'dfx/venue_health.json'), 'utf8'));

/** Ledger-key → display symbol for the IC ledgers a venue row may name (the truth file's
 *  own principals keys — a venue row naming an UNKNOWN ledger is generator FAILURE, never
 *  a placeholder line). Rail-qualified ambiguity (ckUSDC vs USDC-on-Solana) is what the
 *  rail column is for. */
const IC_LEDGER_SYMBOLS = {
  icp_ledger: 'ICP',
  vchf_ledger: 'VCHF',
  ckusdc_ledger: 'ckUSDC',
  ckbtc_ledger: 'ckBTC',
  cketh_ledger: 'ckETH',
  demo_ledger: 'DEMO',
};

/** The venue's own min/max, when the registry or health data carries one. The REGISTRY
 *  publishes none (min/max are the venue's own per-quote facts — the app shows them from
 *  the quote), so this is an em-dash today; the column earns its place the day a probe
 *  record lands one here. */
const minMaxOf = () => '\u2014';

/** Per-family static facts. RATE TYPE: a cefi trade pins the venue's own fixed rate
 *  relay-side (sideshift commissionRate "0" + fixed-rate shifts; trocador `fixed=True`,
 *  pinned in crates/dpay-relay/src/trocador.rs) — dpay adds nothing; an AMM quote floats
 *  and the app signs a 1% slippage floor (CONVERT_SLIPPAGE_BPS_DEFAULT). PROBE: the last
 *  MEASURED live probe per venue family — a dated RECORD with its primary source, never
 *  a number the app trusts (the app only ever shows a quote it just fetched). */
const FAMILIES = {
  ic_amm: {
    rateType: 'floating (1% slippage floor)',
    probe: {
      date: '2026-09-16',
      status: 'pool metadata re-asserted on-chain (just swap-venue-probe; dfx fixture records)',
      source: 'dfx/catalog_truth.json venues[].fixture',
    },
  },
  solana_amm: {
    rateType: 'floating (1% slippage floor)',
    probe: {
      date: '2026-09-19',
      status: 'quotes measured live, keyless, both directions',
      source: 'dfx/catalog_truth.json venues[] row records',
    },
  },
  cefi: {
    rateType: 'fixed (venue rate pinned relay-side)',
    probe: {
      date: '2026-09-24',
      status: 'sideshift: pairs verified live keyless 2026-09-19; trocador: pins verified, ICP pairs listed-but-UNQUOTED (control pair quoted)',
      source: 'just trocador-probe \u2192 docs/specs/2026-09-22-trocador-partner-agreement.md \u00a73.3',
    },
  },
};

/** Mint identifier → display symbol (the app registry is the one copy; the wrapped-SOL
 *  mint IS the registry's id for the native side). Unknown mint → generator failure. */
function symbolOfLedger(ledger) {
  if (ledger === WRAPPED_SOL_MINT_ADDRESS) return 'SOL';
  if (ledger === ETH_NATIVE_RAIL_ID) return 'ETH (native)';
  for (const [sym, info] of Object.entries(SOLANA_TOKENS)) {
    if (info.mint === ledger) return sym;
  }
  for (const [key, sym] of Object.entries(IC_LEDGER_SYMBOLS)) {
    if (TRUTH.principals[key] === ledger) return sym;
  }
  throw new Error(`venue pair names an identifier no registry knows: ${ledger} — extend the registry or the generator's symbol tables`);
}

function railOf(venue) {
  const kinds = venue.pair_ledgers.map(l => (l === WRAPPED_SOL_MINT_ADDRESS || Object.values(SOLANA_TOKENS).some(t => t.mint === l)) ? 'solana'
    : (l === ETH_NATIVE_RAIL_ID) ? 'evm-native'
    : 'ic');
  const set = [...new Set(kinds)];
  if (set.includes('evm-native')) return 'Internet Computer \u2194 Ethereum (cross-rail, native settle)';
  if (set.length === 2) return 'Internet Computer \u2194 Solana (cross-rail)';
  return set[0] === 'ic' ? 'Internet Computer' : 'Solana';
}

/** The relay derives the health verdict AT SERVE TIME (catalog::settlement_verdict:
 *  degraded = not settled, or settle_seconds > 1800). This reproduces that one rule for
 *  the doc — the demotion source stays the relay; this is its view. */
const SLA_SECONDS = 1800;
function healthOf(venueId) {
  const h = (HEALTH.venues ?? {})[venueId];
  if (h == null) return 'not measured (healthy by default \u2014 absence is never invented)';
  const degraded = !h.settled || (typeof h.settle_seconds === 'number' && h.settle_seconds > SLA_SECONDS);
  const at = h.measured_at != null
    ? new Date(typeof h.measured_at === 'number' ? h.measured_at * 1000 : h.measured_at).toISOString().slice(0, 10)
    : 'unknown date';
  return degraded
    ? `DEGRADED \u2014 last measured payout missed the 30-min SLA (measured ${at})`
    : `ok \u2014 payout landed, \u2264 ${h.settle_seconds ?? '?'} s (measured ${at})`;
}

export function generateConvertMatrix() {
  const venues = TRUTH.venues.filter(v => !v.testnet);
  // The adapter-owned EVM-native cefi rows join the registry rows: the doc is a view over
  // the app's own registries, and evmConvert.ts IS one (bundled app-side, served pair-side
  // by the relay's sideshift adapter — see that module's header for why there is no
  // catalog row).
  const all = [...venues, ...EVM_NATIVE_VENUES.filter(v => !v.testnet)];
  const header = [
    '# Convert coverage matrix',
    '',
    '<!-- GENERATED by scripts/gen_convert_matrix.mjs — do not hand-edit.',
    '     `just convert-matrix` regenerates; `just check` and',
    '     app/__tests__/convertMatrix.test.ts fail on drift. -->',
    '',
    'Every conversion dpay offers, derived from the venue registry the app itself',
    'derives from (dfx/catalog_truth.json venues[] \u2014 mirrored by app/config/venues.ts,',
    'drift-alarmed on both sides). This doc is a VIEW, never an input: the pickers read',
    'the registry, and every number a user ever sees is a quote fetched live from the',
    'venue at that moment. Probe entries below are dated measurement RECORDS, not cached',
    'facts. Both directions of a pair are offered unless stated otherwise.',
    '',
    '| from \u2192 to | rail | venue_id | kind | rate type | min/max | live probe | health |',
    '|---|---|---|---|---|---|---|---|',
  ];
  const rows = all.map(v => {
    const [a, b] = v.pair_ledgers;
    const fam = FAMILIES[v.kind];
    if (fam == null) throw new Error(`venue kind ${v.kind} has no family facts — add them to scripts/gen_convert_matrix.mjs`);
    const pair = `${symbolOfLedger(a)} \u2194 ${symbolOfLedger(b)}`;
    const cells = [
      pair,
      railOf(v),
      `\`${v.venue_id}\``,
      v.kind,
      fam.rateType,
      minMaxOf(),
      `${fam.probe.date} \u2014 ${fam.probe.status} (source: ${fam.probe.source})`,
      healthOf(v.venue_id),
    ];
    return `| ${cells.join(' | ')} |`;
  });
  const byKind = {};
  for (const v of all) byKind[v.kind] = (byKind[v.kind] ?? 0) + 1;
  const summary = [
    '',
    `${all.length} venue rows: ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ')}.`,
    'Testnet rows (offline fixtures) are excluded. dpay takes no cut on any row: relay-pinned',
    'markup/commission is zero, and dpay is never a party to a conversion.',
    '',
  ];
  return [...header, ...rows, ...summary].join('\n');
}

function main() {
  const doc = generateConvertMatrix();
  const target = join(ROOT, 'docs/CONVERT_MATRIX.md');
  const check = process.argv.includes('--check');
  if (check) {
    const onDisk = readFileSync(target, 'utf8');
    if (onDisk !== doc) {
      console.error('docs/CONVERT_MATRIX.md is STALE or hand-edited \u2014 regenerate with `just convert-matrix` and keep the new file. Diff:');
      const a = onDisk.split('\n');
      const b = doc.split('\n');
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) console.error(`  line ${i + 1}\n    disk: ${a[i] ?? '(eof)'}\n    gen:  ${b[i] ?? '(eof)'}`);
      }
      process.exit(1);
    }
    console.log('convert-matrix: docs/CONVERT_MATRIX.md is current');
    return;
  }
  writeFileSync(target, doc);
  console.log(`convert-matrix: wrote docs/CONVERT_MATRIX.md (${doc.split('\n').length} lines)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
