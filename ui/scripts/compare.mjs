// Visual regression: compare shots/ against golden/.
//   - first run (no golden): copy shots -> golden, report "seeded", exit 0.
//   - later runs: pixelmatch each shot; if >0.1% of pixels differ, write a diff PNG
//     to diff/ and exit 1. Otherwise exit 0.
import {
  existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, '..');
const SHOTS = join(UI_DIR, 'shots');
const GOLDEN = join(UI_DIR, 'golden');
const DIFF = join(UI_DIR, 'diff');

const THRESHOLD_RATIO = 0.001; // 0.1% of pixels

function pngNames(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
}

function main() {
  const shots = pngNames(SHOTS);
  if (shots.length === 0) {
    console.error('[compare] no screenshots in shots/ — nothing to compare');
    process.exit(1);
  }

  // Seed mode: golden doesn't exist yet (or is empty).
  if (!existsSync(GOLDEN) || pngNames(GOLDEN).length === 0) {
    mkdirSync(GOLDEN, { recursive: true });
    for (const f of shots) copyFileSync(join(SHOTS, f), join(GOLDEN, f));
    console.log(`[compare] seeded golden/ with ${shots.length} baseline screenshot(s): ${shots.join(', ')}`);
    console.log('[compare] SEEDED (exit 0)');
    process.exit(0);
  }

  // Compare mode.
  mkdirSync(DIFF, { recursive: true });
  let failed = false;
  for (const f of shots) {
    const goldenPath = join(GOLDEN, f);
    if (!existsSync(goldenPath)) {
      console.error(`[compare] FAIL ${f}: no golden baseline (new screenshot)`);
      failed = true;
      continue;
    }
    const img = PNG.sync.read(readFileSync(join(SHOTS, f)));
    const ref = PNG.sync.read(readFileSync(goldenPath));
    if (img.width !== ref.width || img.height !== ref.height) {
      console.error(`[compare] FAIL ${f}: size ${img.width}x${img.height} != golden ${ref.width}x${ref.height}`);
      failed = true;
      continue;
    }
    const { width, height } = img;
    const diff = new PNG({ width, height });
    const changed = pixelmatch(img.data, ref.data, diff.data, width, height, { threshold: 0.1 });
    const ratio = changed / (width * height);
    if (ratio > THRESHOLD_RATIO) {
      const diffPath = join(DIFF, f);
      writeFileSync(diffPath, PNG.sync.write(diff));
      console.error(`[compare] FAIL ${f}: ${changed} px differ (${(ratio * 100).toFixed(3)}%) > ${(THRESHOLD_RATIO * 100).toFixed(1)}% -> ${diffPath}`);
      failed = true;
    } else {
      console.log(`[compare] OK   ${f}: ${changed} px differ (${(ratio * 100).toFixed(3)}%)`);
    }
  }

  if (failed) {
    console.error('[compare] MISMATCH (exit 1)');
    process.exit(1);
  }
  console.log('[compare] all screenshots match golden (exit 0)');
  process.exit(0);
}

main();
