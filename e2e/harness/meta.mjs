// Shared test-metadata loader. Each `e2e/tests/NN-name.mjs` exports a `meta` object:
//   export const meta = {
//     id: '07',                       // zero-padded number (matches filename prefix)
//     name: 'scan-pay',               // slug (matches filename, no extension, no prefix)
//     journey: 'pay',                 // the user-journey group (wire|onboard|pay|offline|deposit|withdraw|nfc|system|tour)
//     covers: ['scan', 'sign', ...],  // short slugs of the behaviors this flow verifies (filterable)
//     verifies: 'Payer scans → ...',  // concise one-liner for the FLOWS.md catalog (human prose)
//     timeoutMs: 20000,               // per-test timeout the orchestrator enforces (hang backstop)
//   };
//
// This module is the SINGLE reader both `run.mjs` (filter + coverage matrix + per-test timeout) and
// `gen-flows-md.mjs` (FLOWS.md generation) call, so the catalog can never drift from the tests.
//
// `loadTestsMeta()` dynamic-imports every test module (cheap: top-level code only defines `run` +
// `meta`; the `if (import.meta.url === ...)` guard prevents `run()` from firing when imported here).
// ES modules evaluate once per process, so the later `import()` inside `run.mjs`'s worker is a cache
// hit — no double evaluation, no side effects.
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = join(__dirname, '..', 'tests');

/** Canonical journey order for stable summaries + the FLOWS.md table. */
export const JOURNEYS = [
  'wire', 'onboard', 'pay', 'offline', 'deposit', 'withdraw', 'nfc', 'system', 'tour',
];

/** Human-readable one-line description per journey (used by the matrix + FLOWS.md headings). */
export const JOURNEY_TITLE = {
  wire: 'Wire-format cross-validation (no browser)',
  onboard: 'Onboarding & funding',
  pay: 'Payments (the core offline-pay flow)',
  offline: 'Offline hand-off (the signature feature)',
  deposit: 'Deposits & onramp (ckBTC + ckUSDC + ckERC20)',
  withdraw: 'Withdrawal (ckBTC cash-out)',
  nfc: 'NFC (tap-to-pay)',
  system: 'Settings & system',
  tour: 'Visual capture (UX tour)',
};

const FALLBACK_TIMEOUT_MS = 60_000; // generous default if a flow omits timeoutMs (never false-fires)

/**
 * Scan `e2e/tests/`, import each module, and return its metadata. Always returns an entry per file
 * (with a fallback `meta` if the file has not yet been migrated), so a half-migrated suite still
 * runs. Sorted by filename (numeric order).
 *
 * @returns {Promise<Array<{file: string, id: string, name: string, path: string, meta: object}>>}
 */
export async function loadTestsMeta() {
  const files = (await readdir(TESTS_DIR))
    .filter((f) => /^\d{2}-.+\.mjs$/.test(f))
    .sort();
  const out = [];
  for (const f of files) {
    const path = join(TESTS_DIR, f);
    const mod = await import(`file://${path}`);
    const id = f.slice(0, 2);
    const name = basename(f, '.mjs').slice(3);
    const meta = mod.meta
      ? { ...mod.meta }
      : { id, name, journey: 'uncategorized', covers: [], timeoutMs: FALLBACK_TIMEOUT_MS };
    // Defensive: the filename is the source of truth for id/name (never trust a hand-typed mismatch).
    meta.id = id;
    meta.name = name;
    if (typeof meta.timeoutMs !== 'number' || meta.timeoutMs <= 0) meta.timeoutMs = FALLBACK_TIMEOUT_MS;
    out.push({ file: f, id, name, path, meta });
  }
  return out;
}

/**
 * Apply the DPAY_E2E_FILTER to the loaded tests. A token matches a test if ANY is true:
 *   - the filename contains the token           (legacy: `DPAY_E2E_FILTER=07` → file has "07")
 *   - meta.id === token                          (`07`)
 *   - meta.name === token                        (`scan-pay`)
 *   - meta.journey === token                     (`pay` → every pay-journey flow)
 *   - meta.covers includes the token             (`receipt`)
 * Comma-separated for several (`DPAY_E2E_FILTER=07,13,15` or `pay,offline`). Empty filter = all.
 */
export function filterByToken(tests, filterRaw) {
  const tokens = (filterRaw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) return tests;
  return tests.filter((t) =>
    tokens.some((tok) =>
      t.file.includes(tok) ||
      t.meta.id === tok ||
      t.meta.name === tok ||
      t.meta.journey === tok ||
      (Array.isArray(t.meta.covers) && t.meta.covers.includes(tok)),
    ),
  );
}
