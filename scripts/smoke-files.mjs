#!/usr/bin/env node
// The smoke runner's file feed — reads app/__tests__/smoke/manifest.ts (the ONLY admission path)
// and prints the manifest entries as space-joined `__tests__/<name>` paths, ready for
//   just smoke → npx jest --selectProjects smoke $(node ../scripts/smoke-files.mjs)
// Exits 1 with a clear message when the manifest cannot be parsed, so a broken manifest is loud
// at recipe time (and at drift-test time) instead of silently running nothing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, '..', 'app', '__tests__', 'smoke', 'manifest.ts');

const src = readFileSync(manifestPath, 'utf8');
const m = src.match(/SMOKE_FILES[^=]*=\s*\[([\s\S]*?)\]/);
if (!m) {
  console.error(`smoke-files: cannot find SMOKE_FILES in ${manifestPath}`);
  process.exit(1);
}
const files = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
if (files.length === 0) {
  console.error('smoke-files: the manifest parsed to ZERO files — refusing (an empty smoke tier is a mistake, not a pass)');
  process.exit(1);
}
process.stdout.write(files.map((f) => `__tests__/${f}`).join(' '));
