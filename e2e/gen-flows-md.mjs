// Regenerate FLOWS.md from the test metadata. Single source of truth: every flow's id/name/journey/
// covers/verifies lives in its `meta` export; this script reads them all and writes the catalog.
//
// The journey-grouped flow tables are FULLY GENERATED (never hand-edit them — edit the `meta` and
// re-run). The hand-maintained prose sections (Coverage gaps, How to add a flow, Conventions) are
// emitted from the constants at the bottom of this file so the whole document is reproducible.
//
// Usage: `node e2e/gen-flows-md.mjs` (writes FLOWS.md at the repo root; run from anywhere).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadTestsMeta, JOURNEYS, JOURNEY_TITLE } from './harness/meta.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const OUT = join(REPO_ROOT, 'FLOWS.md');

const mdEscape = (s) => String(s).replace(/\|/g, '\\|');

function journeyTable(tests, journey) {
  const inJ = tests.filter((t) => t.meta.journey === journey);
  if (inJ.length === 0) return '';
  const rows = inJ
    .map((t) => {
      // Optional flows stay cataloged (they exist + are runnable) but are marked: they are excluded
      // from the default `just e2e` enumeration and run via their dedicated filter token instead.
      const name = t.meta.optional ? `${mdEscape(t.meta.name)} — optional (\`just e2e-store\`)` : mdEscape(t.meta.name);
      return `| ${t.meta.id} | ${name} | ${mdEscape(t.meta.verifies ?? '')} | ${(t.meta.covers ?? []).map(mdEscape).join(', ')} |`;
    })
    .join('\n');
  return `### ${JOURNEY_TITLE[journey] ?? journey}\n\n| # | Flow | Verifies | Covers |\n|---|------|----------|--------|\n${rows}\n`;
}

function coverageGapsSection() {
  return [
    '## Coverage gaps (honestly documented)',
    '',
    'These flows are **not** covered and why:',
    '',
    '- **Exact 2/6/8/18-decimal amount transport at the JS/Kotlin boundary** — `29-exact-amount` proves the >2^53 raw amount round-trips byte-exact through the TS↔relay stack, but values around `2^53` and excess fractional input at the Kotlin/UniFFI boundary are not exercised.',
    '- **Non-dollar NFC consent over the radio** — `11-nfc` + `32-nfc-disclosure` inject JS phase/request events; they do not carry a real nonzero-currency request over the actual ISO-DEP radio (physical-device gate).',
    '- **Android React Native bridge parity** — instrumented tests mostly exercise UniFFI directly, not the full `NativeModules` argument/return surface.',
    '- **External-credit balance freshness** — deposit tests assert direct ledger/FakeLedger credit while missing stale facade `BAL_CACHE` behavior.',
    '- **NFC radio round trip** (two phones, HCE↔reader, full DPN2 + signed-result transit over ISO-DEP) — physical-device gate. Flows 86/87 prove the merchant and offline-payer ownership halves; `just ondevice` proves request→fragmented bundle→authenticated C6 result through the real core/UniFFI state machines. Only antenna coupling and Android AID routing between two physical phones remain.',
    '- **ckUSDC onramp final ETH hop** (wallet signs → tx mined → minter scrapes ~20min) — inherent outer-loop gate; offline e2e proves the calldata wiring + byte-exactness.',
    '- **ckBTC live deposit/withdrawal with real BTC** — requires real mainnet funds; offline path proven via FakeLedger seed (issues 1/8 in OPEN_ISSUES.md).',
    '',
    '> **Closed gaps:** destination-address format validation (`18-withdraw-errors`); the multi-currency Ledger row exact units (folded into `27-asset-pay`); the withdraw UI balance delta (folded into `15-withdraw`); malformed-QR scanning (`36-bad-qr`); onboarding-time faucet failure against a dead relay (`37-onboard-no-faucet`).',
  ].join('\n');
}

function howToAddSection() {
  return [
    '## How to add a new flow',
    '',
    '1. Copy `e2e/tests/NN-name.mjs` → `e2e/tests/<next>-<slug>.mjs` (zero-padded number).',
    '2. Edit the `meta` export at the top: `id`, `name` (the slug), `journey` (a value from the matrix above), `covers` (slugs), `verifies` (one line), `timeoutMs`.',
    '3. Import `{setup, onboardWallet, assert, ...}` from `../harness/lib.mjs`.',
    '4. `export async function run() { ... }` — the harness calls it; `setup()` returns `{driver, relayBaseURL, ...}`.',
    "5. Call `onboardWallet(ctx.driver, 'name')` to get a funded wallet in <1s.",
    "6. Use `findByTestID`, `waitForText`, `click`, `type` from the driver. Take a screenshot: `ctx.driver.screenshot('NN-name')`.",
    '7. Assert behavior (button states, text content, balance changes) — not pixel layout.',
    '8. Run: `DPAY_E2E_FILTER=<id|name|journey> node e2e/run.mjs` to iterate in <10s (one flow or one journey), then `just e2e` for the full suite.',
    '9. Regenerate this file: `node e2e/gen-flows-md.mjs` (commits the new row).',
    '',
    '### Conventions',
    '',
    '- **testID + textContent only.** The e2e net does NOT pixel-diff. Style regressions are invisible to the suite — keep `styles.ts` as ONE `StyleSheet.create` block.',
    '- **Fast-poll seam.** `globalThis.__DPAY_TEST_POLL` is injected by the harness (150ms intervals). Never hardcode a `setTimeout` that depends on the prod poll interval.',
    '- **One relay per run.** The relay + web server + browser are shared; each test gets a fresh incognito context (fresh identity, no cross-test state). Serialize web-building runs (the `e2e/dist` cache is a shared path).',
    '- **Browser errors fail closed.** Page exceptions, app `console.error`, `DPAY_SELFCHECK FAIL`, and failed requests make the owning flow RED at teardown. A deliberate offline flow must call `driver.allowRequestFailuresFrom(deadOrigin)` before retargeting, scoped to its unique closed-port origin.',
    '- **No broad mocking.** The `fetch` recorder in `09-double-spend` is the sanctioned pattern: narrow (one route), transparent (calls through), self-uninstalling.',
    '- **Per-test timeout.** Each flow\'s `meta.timeoutMs` is enforced by the orchestrator — a hung test fails loudly instead of stalling the pool.',
  ].join('\n');
}

async function main() {
  const tests = await loadTestsMeta();
  const count = tests.length;
  const optionalCount = tests.filter((t) => t.meta.optional).length;
  const defaultCount = count - optionalCount;
  const journeysUsed = JOURNEYS.filter((j) => tests.some((t) => t.meta.journey === j));

  const header = [
    '# E2E Test Flows — Manifest',
    '',
    `> The authoritative catalog of every user flow tested by the e2e harness (\`e2e/\`). **${count} flows**`,
    `> (${defaultCount} in the default \`just e2e\` run${optionalCount > 0 ? `, ${optionalCount} optional capture-only flow${optionalCount === 1 ? '' : 's'} via the dedicated recipe` : ''}).`,
    '> Each flow drives the **REAL** app (`app/App.tsx` via react-native-web) in a real headless Chrome',
    '> against a real test relay with an in-process fake-IC `/api/v2` gateway (offline). The app signs',
    '> real user-principal IC envelopes; the fake gateway verifies and settles them exactly like the',
    '> boundary nodes would (the relay\'s catalog/faucet sugar persists around it). No UI stubs. The',
    '> only shimmed I/O boundary is the camera scan (sanctioned smallest-boundary seam) and the NFC',
    '> radio (physical-device gate).',
    '>',
    '> **This file is GENERATED** by `node e2e/gen-flows-md.mjs` from each flow\'s `meta` export. Never',
    '> hand-edit the tables — edit the `meta` and re-run. Only the "Coverage gaps" / "How to add" prose',
    '> is hand-maintained (inside that script).',
    '>',
    '> **Run:** `just e2e` (all default flows, ~18s) · `DPAY_E2E_FILTER=07 node e2e/run.mjs` (one flow) ·',
    '> `DPAY_E2E_FILTER=pay node e2e/run.mjs` (a whole journey) · `DPAY_E2E_FILTER=07,15 node e2e/run.mjs` (subset) ·',
    '> `just e2e-store` (the optional Play Store capture flow).',
    '',
    '## Coverage matrix',
    '',
    'Flows grouped by user journey; within each table, every row lists what the flow **verifies** and',
    'the behavior **covers** slugs (the latter are filterable: `DPAY_E2E_FILTER=<slug>`). Flows marked',
    '`optional` are render-only capture harnesses excluded from the default run.',
    '',
    journeysUsed.map((j) => `${j} (${tests.filter((t) => t.meta.journey === j).length})`).join(' · '),
    '',
    '---',
    '',
  ];

  const body = journeysUsed.map((j) => journeyTable(tests, j)).filter(Boolean).join('\n');

  const out = [
    header.join('\n'),
    body,
    '---',
    '',
    coverageGapsSection(),
    '',
    '---',
    '',
    howToAddSection(),
    '',
  ].join('\n');

  writeFileSync(OUT, out);
  console.log(`[gen-flows-md] wrote ${OUT} (${count} flows across ${journeysUsed.length} journeys; ${optionalCount} optional, ${defaultCount} in the default run)`);
}

main().catch((e) => { console.error(`[gen-flows-md] FATAL: ${e.stack || e.message}`); process.exit(1); });
