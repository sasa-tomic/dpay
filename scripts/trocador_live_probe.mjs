#!/usr/bin/env node
/* OPT-IN LIVE Trocador partner probe — the key-gated measurement the partner agreement makes
   executable on key arrival (docs/specs/2026-09-22-trocador-partner-agreement.md §3 step 3).

   ⚠️  THIS TOOL MAKES LIVE KEY-GATED CALLS to the real venue. It is UNWIRED from the offline
   loop BY DESIGN (like e2e-live-testnet): never part of `just verify` / `just check`, NEVER run
   in tests or CI. Run it by hand, with the founder's partner key:
     DPAY_TROCADOR_API_KEY=… just trocador-probe

   What it does (read-only — a rate quote commits nothing, creates nothing):
     1. GET {DPAY_TROCADOR_API_BASE:-https://api.trocador.app}/coins — prints the FULL
        coin/network vocabulary (pretty JSON), then the rows relevant to dpay's pins (ICP, SOL,
        USDC, EURC on Solana/mainnet) NEXT TO the adapter's currently pinned codes, flagging any
        MISMATCH.
     2. ONE rate probe for the registered pair (ICP↔SOL, fixed=True, best_only=True,
        min_kycrating=A, markup=0, small amount) — prints the venue's attributed quote and, if
        the response carries one, the status vocabulary.

   Why: every /coins and /trade answer is key-gated (measured 2026-09-20: 401 without a key), so
   the adapter's pinned ticker/network codes (crates/dpay-relay/src/trocador.rs TROCADOR_ASSETS)
   follow the docs' example vocabulary and are UNVERIFIED until this probe runs. A wrong code
   fails loudly at the venue — at trade time, which is too late. Re-pin BEFORE the first real
   trade. Exit 0 = vocabulary matches + quote answered; exit 2 = MISMATCH; exit 1 = refused or
   transport failure. Node ≥18 (global fetch), no new deps.
*/

const API_KEY = process.env.DPAY_TROCADOR_API_KEY;
const BASE = process.env.DPAY_TROCADOR_API_BASE || 'https://api.trocador.app';
const AMOUNT = process.env.DPAY_TROCADOR_PROBE_AMOUNT || '0.1'; // small; a quote moves nothing
const TIMEOUT_MS = 20_000; // the relay's own per-upstream bound is 15 s (trocador.rs DEFAULT_TIMEOUT)

// The adapter's CURRENTLY PINNED venue codes — DUPLICATED (the probe must run without a Rust
// toolchain) from crates/dpay-relay/src/trocador.rs `TROCADOR_ASSETS`. On a MISMATCH below, the
// RUST TABLE IS THE THING TO EDIT (then this copy, to keep them in step).
//
// Source: crates/dpay-relay/src/trocador.rs:162-175 (`const TROCADOR_ASSETS`), tuples
// (rail id, venue ticker, venue network, addr-check kind). Rail ids live in
// crates/dpay-relay/src/catalog.rs (ICP_LEDGER_PRINCIPAL / WRAPPED_SOL_MINT).
const EXPECTED = [
  // trocador.rs:163-168 — rail crate::catalog::ICP_LEDGER_PRINCIPAL
  { label: 'ICP', ticker: 'icp', network: 'Mainnet', pinned: true },
  // trocador.rs:169-174 — rail crate::catalog::WRAPPED_SOL_MINT
  { label: 'SOL', ticker: 'sol', network: 'Mainnet', pinned: true },
];
// Future pairs WITHOUT a pin today (trocador.rs:150-157: USDC/EURC extend TROCADOR_ASSETS
// "WITH measurement, the sideshift-usdc coverage-expansion pattern"). Printed for reference
// only — reading their real venue rows off /coins is exactly what a future pin needs.
const REFERENCE_TOKENS = ['usdc', 'eurc'];

function fail(msg, code = 1) {
  console.error(`\n✗ ${msg}`);
  process.exit(code);
}

async function GET(path, params) {
  const url = new URL(path, BASE);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'API-Key': API_KEY, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error', // one hop only, surfaced not chased — the relay's own client discipline
    });
  } catch (e) {
    fail(`venue unreachable at ${BASE} (${e.name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS} ms` : 'connection failed'})`);
  }
  const text = await res.text();
  if (!res.ok) {
    fail(`venue answered ${res.status} for ${url.pathname}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`venue body for ${url.pathname} is not JSON: ${text.slice(0, 400)}`);
  }
}

// The /coins row shape is itself a key-gated fact (undocumented until the key answers), so the
// field names are probed tolerantly instead of assumed. A row "mentions" a token when the token
// appears anywhere in its JSON — robust to any envelope the venue picks.
const field = (row, names) => {
  for (const n of names) if (row && typeof row === 'object' && row[n] != null) return String(row[n]);
  return undefined;
};
const tickerOf = (r) => field(r, ['ticker', 'symbol', 'code', 'name', 'coin']);
const networkOf = (r) => field(r, ['network', 'network_name', 'chain', 'chain_name', 'net']);
const mentions = (row, token) => JSON.stringify(row).toLowerCase().includes(token);

function coinRows(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const v of Object.values(data)) if (Array.isArray(v)) return v;
  }
  return null;
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────
console.log(`
──────────────────────────────────────────────────────────────────────────────
⚠️  LIVE PROBE — this tool makes REAL key-gated calls to ${BASE} using the
    partner credential DPAY_TROCADOR_API_KEY. It must NEVER run in tests/CI
    (unwired from just verify/check by design). Read-only: /coins and ONE
    new_rate quote commit nothing and create nothing.
──────────────────────────────────────────────────────────────────────────────`);

if (process.env.CI === 'true' || process.env.CI === '1' || process.env.GITHUB_ACTIONS === 'true') {
  fail('refusing to run: CI detected (CI/GITHUB_ACTIONS env) — this probe is manual-only, live-key-gated, never in tests/CI');
}
if (!API_KEY) {
  fail(
    'refusing to run: DPAY_TROCADOR_API_KEY is not set.\n' +
      '  This probe calls the LIVE Trocador API, which is key-gated on every method\n' +
      '  (401 "Missing API key" without one — measured 2026-09-20). Set the partner key:\n' +
      '    DPAY_TROCADOR_API_KEY=… just trocador-probe\n' +
      '  (key access enabled 2026-09-22 — their proxy may need up to 60 min from the email)',
  );
}

// ── 1. /coins — the full vocabulary, then the rows next to our pins ─────────────────────────
console.log(`\n▶ GET ${BASE}/coins  (full coin/network vocabulary)`);
const coins = await GET('coins');
const rows = coinRows(coins);
console.log(JSON.stringify(coins, null, 2));

if (!rows) {
  console.log(
    '\n? /coins answered a non-array envelope (printed above in full) — no automated\n' +
      '  comparison is possible. Compare the pinned codes MANUALLY against the printed rows:\n' +
      EXPECTED.map((e) => `    ${e.label}: ticker=${JSON.stringify(e.ticker)} network=${JSON.stringify(e.network)}`).join('\n'),
  );
} else {
  console.log(`\n▶ /coins vs the adapter's pinned codes (${rows.length} rows)`);
  console.log('  source of the pins: crates/dpay-relay/src/trocador.rs TROCADOR_ASSETS\n');
  let mismatches = 0;
  for (const exp of EXPECTED) {
    const byTicker = rows.filter((r) => (tickerOf(r) || '').toLowerCase() === exp.ticker.toLowerCase());
    const hits = byTicker.length
      ? byTicker
      : rows.filter((r) => mentions(r, exp.ticker.toLowerCase())); // shape without a ticker field
    if (!hits.length) {
      mismatches++;
      console.log(`  ✗ MISMATCH ${exp.label}: NO /coins row matches ticker "${exp.ticker}" — the pin is stale or the venue dropped the market`);
      continue;
    }
    for (const hit of hits.slice(0, 5)) {
      const net = networkOf(hit);
      const netNote = exp.pinned
        ? net == null
          ? '(row exposes no network field — compare manually)'
          : net.toLowerCase() === exp.network.toLowerCase()
            ? `✓ network "${net}" matches the pinned "${exp.network}"`
            : `✗ MISMATCH: row network "${net}" ≠ pinned "${exp.network}" — RE-PIN crates/dpay-relay/src/trocador.rs`
        : '(no pin yet — this is the row a future pin would cite)';
      if (exp.pinned && net != null && net.toLowerCase() !== exp.network.toLowerCase()) mismatches++;
      console.log(`  ${exp.pinned ? (net && net.toLowerCase() === exp.network.toLowerCase() ? '✓' : '⚠') : '·'} ${exp.label}: ${JSON.stringify(hit)}\n      ${netNote}`);
    }
  }
  for (const tok of REFERENCE_TOKENS) {
    const scoped = rows.filter((r) => mentions(r, tok) && (mentions(r, 'mainnet') || mentions(r, 'solana')));
    const anyTok = rows.filter((r) => mentions(r, tok));
    const show = (scoped.length ? scoped : anyTok).slice(0, 5);
    console.log(`  · ${tok.toUpperCase()} (Solana/mainnet reference rows${scoped.length ? '' : ' — no mainnet/solana-scoped match, showing any match'}):`);
    for (const hit of show) console.log(`      ${JSON.stringify(hit)}`);
    if (!show.length) console.log('      (no /coins row mentions this token)');
  }
  console.log(
    mismatches
      ? `\n✗ ${mismatches} MISMATCH(es) — re-pin crates/dpay-relay/src/trocador.rs TROCADOR_ASSETS (and the status vocabulary, below) BEFORE the first real trade, then update the EXPECTED copy in scripts/trocador_live_probe.mjs to match.`
      : '\n✓ all pinned codes match the live vocabulary',
  );
  if (mismatches) fail(`${mismatches} pin mismatch(es) — see above`, 2);
}

// ── 2. ONE rate probe — the registered pair, the founder's pins, a small amount ─────────────
console.log(`\n▶ GET ${BASE}/new_rate  (ICP↔SOL, fixed=True, best_only=True, min_kycrating=A, markup=0, amount_from=${AMOUNT})`);
const quote = await GET('new_rate', {
  ticker_from: 'icp', // pinned: trocador.rs TROCADOR_ASSETS (ICP_LEDGER_PRINCIPAL row)
  network_from: 'Mainnet',
  ticker_to: 'sol', // pinned: trocador.rs TROCADOR_ASSETS (WRAPPED_SOL_MINT row)
  network_to: 'Mainnet',
  amount_from: AMOUNT,
  min_kycrating: 'A', // the relay's own constant (trocador.rs MIN_KYCRATING)
  markup: '0', // the founder pin (trocador.rs MARKUP)
  best_only: 'True', // the aggregator's own pick — one quote (trocador.rs rate_proxy)
});
console.log('\n▼ the venue\'s attributed quote (RAW venue body — the relay\'s /api/v1/trocador/rate');
console.log('  wraps exactly this as {"venue_id":"trocador","quote":<this>,"fetched_at":<unix secs>},');
console.log('  crates/dpay-relay/src/trocador.rs rate_proxy):');
console.log(JSON.stringify(quote, null, 2));

// The status vocabulary is a /trade fact (key-gated like everything else) — it appears here only
// if the venue happens to include one. Print it when present; say so plainly when not.
const status = (v, depth = 0) => {
  if (v == null || typeof v !== 'object' || depth > 2) return [];
  return Object.entries(v).flatMap(([k, val]) =>
    /^status/i.test(k) && (typeof val === 'string' || typeof val === 'number')
      ? [`${k}=${JSON.stringify(val)}`]
      : status(val, depth + 1),
  );
};
const statuses = status(quote);
console.log(
  statuses.length
    ? `\n▶ status vocabulary present in the quote response:\n    ${statuses.join('\n    ')}`
    : '\n· the rate response carries NO status field (expected — the trade-status vocabulary is a\n' +
        '  /trade answer, visible only on a real trade). The app renders unknown status words as\n' +
        '  honest-`unknown`; pin the vocabulary from the FIRST real webhook/trade read, and keep\n' +
        '  polling ≤1/min with a hard stop at the first terminal state (agreement §1).',
);

console.log('\ndone — live probe complete. If anything printed MISMATCH, re-pin before the first real trade.');
