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
    'These behaviors are **not** covered and why (the jest twins inherit each gap):',
    '',
    '- **Exact 2/6/8/18-decimal amount transport at the JS/Kotlin boundary** — the jest twin (`app/__tests__/flow/pay/29-exact-amount.test.tsx`) proves the >2^53 raw amount round-trips byte-exact through the TS↔relay stack, but values around `2^53` and excess fractional input at the Kotlin/UniFFI boundary are not exercised.',
    '- **Non-dollar NFC consent over the radio** — the jest twin (`app/__tests__/flow/nfc/ic-card.test.tsx`) injects JS phase/request events; it does not carry a real nonzero-currency request over the actual ISO-DEP radio (physical-device gate).',
    '- **Android React Native bridge parity** — instrumented tests mostly exercise UniFFI directly, not the full `NativeModules` argument/return surface.',
    '- **External-credit balance freshness** — the jest deposit twins assert direct ledger/FakeLedger credit while missing stale facade `BAL_CACHE` behavior.',
    '- **NFC radio round trip** (two phones, HCE↔reader, full DPN2 + signed-result transit over ISO-DEP) — physical-device gate. The jest twin (`app/__tests__/flow/nfc/error-paths.test.tsx`) proves the merchant and offline-payer ownership halves; `just ondevice` proves request→fragmented bundle→authenticated C6 result through the real core/UniFFI state machines. Only antenna coupling and Android AID routing between two physical phones remain.',
    '- **ckUSDC onramp final ETH hop** (wallet signs → tx mined → minter scrapes ~20min) — inherent outer-loop gate; the jest twin proves the calldata wiring + byte-exactness.',
    '- **ckBTC live deposit/withdrawal with real BTC** — requires real mainnet funds; offline path proven via FakeLedger seed (issues 1/8 in OPEN_ISSUES.md).',
    '',
    '> **Closed gaps:** destination-address format validation (jest `destination.test.ts` + `flow/withdraw/send-to-address.test.tsx`); the multi-currency Ledger row exact units (folded into `flow/pay/27-asset-pay.test.tsx`); the withdraw UI balance delta (folded into the withdraw jest flow); malformed-QR scanning (`flow/pay/36-bad-qr.test.tsx`); onboarding-time faucet failure against a dead relay (`flow/onboard/01-onboard.test.tsx` dead-relay branch).',
  ].join('\n');
}

function howToAddSection() {
  return [
    '## Where a new flow goes (the chrome tier is FROZEN)',
    '',
    '1. Behavioral screen flows: `app/__tests__/flow/<domain>/NN-slug.test.tsx` — a jest full-app',
    '   mount against the spawned test relay (`just flow`). Copy an existing twin; the harness lives',
    '   at `app/__tests__/flow/harness/`.',
    '2. Real-chain EVM proofs: `app/__tests__/node-anvil/` (`just node-anvil`).',
    '3. Component/service pins: `app/__tests__/*.test.*` (`just test-app`); money-defining',
    '   invariants may enter smoke via `app/__tests__/smoke/manifest.ts` (AGENTS.md test tiers).',
    '4. Do NOT add chrome flows. Chrome exists only for the visual/PWA catalog above plus the',
    '   `just e2e-visual` pixel gate.',
    '',
    '### Conventions',
    '',
    '- **testID + textContent only** in jest assertions too. Style regressions are invisible to',
    '  that net — the pixel baselines (`just e2e-visual`) own them; keep `styles.ts` as ONE',
    '  `StyleSheet.create` block.',
    '- **Fast-poll seam.** `globalThis.__DPAY_TEST_POLL` (25ms in the jest flow harness, injected',
    '  pre-mount). Never hardcode a `setTimeout` that depends on the prod poll interval.',
    '- **Fail closed.** Ported flows keep the browser-e2e rule: every request/failure is recorded,',
    '  and `driver.allowRequestFailuresFrom(origin)` pre-declares allowed dead origins — an',
    '  undeclared failure fails the jest test at teardown.',
    '- **No broad mocking.** Narrow (one route), transparent (calls through), self-uninstalling.',
    '- **Per-test timeout.** Jest\'s 30s testTimeout is the hang backstop, the e2e `meta.timeoutMs`',
    '  equivalent.',
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
    `> The authoritative catalog of the chrome flow tier (\`e2e/\`). **${count} flows**`,
    `> (${defaultCount} in the default \`just e2e\` run${optionalCount > 0 ? `, ${optionalCount} optional capture-only flow${optionalCount === 1 ? '' : 's'} via the dedicated recipe` : ''}).`,
    '> Each flow drives the **REAL** app (`app/App.tsx` via react-native-web) in a real headless Chrome',
    '> against a real test relay with an in-process fake-IC `/api/v2` gateway (offline). The app signs',
    '> real user-principal IC envelopes; the fake gateway verifies and settles them exactly like the',
    '> boundary nodes would (the relay\'s catalog/faucet sugar persists around it). No UI stubs. The',
    '> only shimmed I/O boundary is the camera scan (sanctioned smallest-boundary seam) and the NFC',
    '> radio (physical-device gate).',
    '>',
    '> **RETIRED TO JEST (2026-09):** the other 201 chrome flows no longer exist under `e2e/tests/`.',
    '> Per the jest-flow-migration porting map they run as jest twins: behavioral flows at',
    '> `app/__tests__/flow/<domain>/NN-slug.test.tsx` (`just flow`), the real-chain EVM proofs',
    '> (former flows 219/220/222) at `app/__tests__/node-anvil/` (`just node-anvil`), and the',
    '> ALREADY-COVERED ids (00, 34, 92, 105, 160) in the pre-existing jest suites the map names.',
    '> Chrome remains ONLY for this catalog (visual capture, pixel baselines, QR scannability,',
    '> viewport/layout metrics, PWA boot) plus the `just e2e-visual` pixel gate.',
    '>',
    '> **This file is GENERATED** by `node e2e/gen-flows-md.mjs` from each flow\'s `meta` export. Never',
    '> hand-edit the tables — edit the `meta` and re-run. Only the "Coverage gaps" / "Where a new flow',
    '> goes" prose is hand-maintained (inside that script).',
    '>',
    '> **Run:** `just e2e` (the visual flows — merge gate) · `DPAY_E2E_FILTER=NN node e2e/run.mjs` (one flow) ·',
    '> `just e2e-visual` (the pixel-diff gate alone) · `just e2e-store` (the Play Store capture).',
    '',
    '## Coverage matrix',
    '',
    'Flows grouped by user journey; within each table, every row lists what the flow **verifies** and',
    'the behavior **covers** slugs (the latter are filterable: `DPAY_E2E_FILTER=<slug>`).',
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
