#!/usr/bin/env node
// check-web-prod-seams — regression guard for test seams in the PROD web bundle.
//
// The e2e web shims (e2e/web/shims.ts) expose driver-grade seams (__DPAY_TEST_*) so the offline
// harness can drive the REAL app. Every one of them is mode-gated out of the `--mode web-prod`
// build (vite constant-folds import.meta.env.MODE → rollup dead-branch elimination — see the
// 2026-08-16 __DPAY_TEST_SHARE fix and the 2026-08-20 F1/F3 fix that gated __DPAY_TEST_CORE,
// __DPAY_TEST_CLIPBOARD, and __DPAY_TEST_IC_GATEWAY the same way). This script proves the gate
// held: it greps every byte of e2e/dist-prod (the exact bytes dpay-relay embeds at /wallet) and
// FAILS if any seam identifier appears.
//
// Why each seam must never ship:
//   __DPAY_TEST_CORE        a driver handle on the wasm money core
//   __DPAY_TEST_IC_GATEWAY  app/services/icp.ts reads it per call — a prod WRITER either 404s
//                           the whole IC value path (relay origin has no /api/v2 outside
//                           test-helpers → everything classifies 'rejected') or lets
//                           `?relay=<evil>` retarget envelope submission to an arbitrary origin.
//                           The READ side (globalThis.__DPAY_TEST_IC_GATEWAY ?? 'https://icp-api.io')
//                           is shared app code that ships: with no writer in the bundle it is
//                           inert, so this seam is checked in WRITE form only.
//   __DPAY_TEST_CLIPBOARD   clipboard-capture wrapper over the real writeText
//   __DPAY_TEST_SHARE       share-payload capture (the original 2026-08-16 gated seam)
//
// Run by `just web` (after the vite build). Fail = exit 1 with the offending file(s).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'e2e', 'dist-prod');

// `any` = any occurrence fails (no legit prod-side reference). `write` = only assignment forms
// fail (`seam=` / `["seam"]=` — not `==`); reads are shared app code that stays.
const FORBIDDEN = [
  { seam: '__DPAY_TEST_CORE', mode: 'any' },
  { seam: '__DPAY_TEST_IC_GATEWAY', mode: 'write' },
  { seam: '__DPAY_TEST_CLIPBOARD', mode: 'any' },
  { seam: '__DPAY_TEST_SHARE', mode: 'any' },
];

// Assignment shapes a minifier can emit: `x.seam = v` and `x["seam"] = v`.
const writeForm = (seam) => [
  new RegExp(`${seam}\\s*=(?!=)`),
  new RegExp(`\\["${seam}"\\]\\s*=(?!=)`),
];

if (!statSync(DIST, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('check-web-prod-seams: FAIL — e2e/dist-prod missing; run `just web` first');
  process.exit(1);
}

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    // `<file>.br` is the brotli of `<file>`, which is scanned right here — grepping the compressed
    // copy adds no coverage and can only produce a false hit on a byte run that happens to spell a
    // seam name. The BODY is what ships either way, and the body is checked.
    else if (!name.endsWith('.br')) files.push(p);
  }
};
walk(DIST);

const hits = [];
for (const f of files) {
  const bytes = readFileSync(f);
  const text = bytes.toString('latin1'); // byte-preserving: identifiers are plain ASCII
  for (const { seam, mode } of FORBIDDEN) {
    if (mode === 'any' ? text.includes(seam) : writeForm(seam).some((re) => re.test(text))) {
      hits.push(`${f.replace(DIST + '/', '')}: ${seam}${mode === 'write' ? ' (write form)' : ''}`);
    }
  }
}

if (hits.length) {
  console.error('check-web-prod-seams: FAIL — test seams leaked into the web-prod bundle:');
  for (const h of hits) console.error(`  ✗ ${h}`);
  console.error('Every __DPAY_TEST_* seam WRITER must be behind `if (import.meta.env.MODE !== \'web-prod\')` in e2e/web/shims.ts (or its shim module) so the gate constant-folds.');
  process.exit(1);
}
console.log(`check-web-prod-seams: PASS — ${FORBIDDEN.length} seams absent from ${files.length} dist-prod files`);
