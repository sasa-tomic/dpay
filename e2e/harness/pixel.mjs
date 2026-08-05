// Pure pixel-diff comparator for the visual-regression flow (40). Decodes two PNGs, counts the
// pixels whose channels differ beyond a small per-channel delta (tunes out font-AA noise), and on
// drift writes a diff-highlight PNG (the actual image dimmed, changed pixels painted red) so a human
// can see exactly where the surface drifted.
//
// PNG codec: pngjs (https://www.npmjs.com/package/pngjs) — pure JavaScript, no native build. Chosen
// over Node's canvas/sharp/zlib-native options because the inner loop must stay OFF the hot path's
// native-dep surface (a native compile failure on a fresh clone would break `just verify`, which
// violates the offline-seconds rule in CLAUDE.md). pngjs is a single pure-JS dependency, installed
// as a devDependency in e2e/package.json. It's imported via `createRequire` because pngjs ships as
// CommonJS and this file is ESM (`.mjs`).
//
// The comparator is intentionally PURE: no Chrome, no Driver, no test framework — just two file
// paths in, a result object out. The flow (40-visual-regression.mjs) wires it to the harness.
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = join(__dirname, '..', 'shots');
const DIFFS_DIR = join(SHOTS_DIR, 'diffs');

// Defaults tuned for the FREEZE_CSS + srgb color profile + font-render-hinting=none stabilization
// already applied by Driver (driver.mjs). At 390x844 @ deviceScaleFactor=2 (= 780x1688 px), a
// per-channel delta of 3 absorbs residual font-AA variance while still flagging any real layout or
// color change (which moves hundreds-to-millions of pixels by >>3 per channel). The 0.5% tolerance
// is the empirical ceiling flow 35's 5 shots stay under across commits on the seed host — anything
// above it on an UNCHANGED surface means the stabilization regressed or a baseline is stale.
const DEFAULT_TOLERANCE_PCT = 0.5;
const DEFAULT_PER_CHANNEL_DELTA = 3;
const DEFAULT_DECODE_TIMEOUT_MS = 5_000;

/**
 * Compare two PNGs pixel-by-pixel. Returns { matching, total, diffPct, matchPct, diffPath, ok }.
 *
 * - `tolerancePct` is the max ALLOWED diff percentage (default 0.5 → fail iff diffPct > 0.5).
 * - `perChannelDelta` is the max allowed per-channel drift before a pixel counts as "different"
 *   (default 3 — absorbs font-AA noise; a real style change moves pixels by orders of magnitude
 *   more).
 * - `ok = diffPct <= tolerancePct`.
 * - On ANY non-zero diff (even sub-threshold), a diff-highlight PNG is written to
 *   `e2e/shots/diffs/<basename>-<timestamp>.png` and `diffPath` is set, so a developer can see
 *   exactly which pixels drifted. `diffPath` is null only when the two images are pixel-identical.
 *
 * Throws with context on file-read or PNG-decode failure (no silent errors).
 *
 * @param {string} baselinePath  Absolute path to the committed baseline PNG.
 * @param {string} actualPath    Absolute path to the freshly-captured PNG.
 * @param {{ tolerancePct?: number, perChannelDelta?: number, decodeTimeoutMs?: number }} [opts]
 * @returns {Promise<{ matching: number, total: number, diffPct: number, matchPct: number, diffPath: string|null, ok: boolean }>}
 */
export async function comparePng(baselinePath, actualPath, opts = {}) {
  const tolerancePct = opts.tolerancePct ?? DEFAULT_TOLERANCE_PCT;
  const perChannelDelta = opts.perChannelDelta ?? DEFAULT_PER_CHANNEL_DELTA;
  const decodeTimeoutMs = opts.decodeTimeoutMs ?? DEFAULT_DECODE_TIMEOUT_MS;

  const baselinePng = await decodePng(baselinePath, 'baseline', decodeTimeoutMs);
  const actualPng = await decodePng(actualPath, 'actual', decodeTimeoutMs);

  // Dimension mismatch is its own class of regression (viewport / layout shift that resized the
  // page). Report it distinctly so the failure message names the cause rather than just "100% diff".
  if (baselinePng.width !== actualPng.width || baselinePng.height !== actualPng.height) {
    const dims = {
      baseline: { w: baselinePng.width, h: baselinePng.height },
      actual: { w: actualPng.width, h: actualPng.height },
    };
    // Best-effort side-by-side so a human can see what changed. Left = baseline, right = actual,
    // on a single canvas of the larger dims; the smaller image is top-left aligned.
    const diffPath = await writeSideBySideDiff(baselinePng, actualPng, actualPath);
    return {
      matching: 0,
      total: Math.max(baselinePng.width * baselinePng.height, actualPng.width * actualPng.height),
      diffPct: 100,
      matchPct: 0,
      diffPath,
      ok: false,
      dimensionMismatch: dims,
    };
  }

  const w = baselinePng.width;
  const h = baselinePng.height;
  const total = w * h;
  const baselineData = baselinePng.data;
  const actualData = actualPng.data;

  // Build the diff-highlight PNG inline: copy the actual pixels, dim non-diff pixels (×0.25), and
  // paint diff pixels bright red. RGBA layout, stride 4.
  const diffPng = new PNG({ width: w, height: h });
  const diffData = diffPng.data;
  const dimFactor = 0.25;
  let diff = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const dr = Math.abs(baselineData[o] - actualData[o]);
    const dg = Math.abs(baselineData[o + 1] - actualData[o + 1]);
    const db = Math.abs(baselineData[o + 2] - actualData[o + 2]);
    const isDiff = dr > perChannelDelta || dg > perChannelDelta || db > perChannelDelta;
    if (isDiff) {
      diffData[o] = 255;     // R
      diffData[o + 1] = 0;   // G
      diffData[o + 2] = 0;   // B
      diffData[o + 3] = 255; // A
      diff++;
    } else {
      // Dim the actual pixel so the red splotches are the visual signal.
      diffData[o] = Math.round(actualData[o] * dimFactor);
      diffData[o + 1] = Math.round(actualData[o + 1] * dimFactor);
      diffData[o + 2] = Math.round(actualData[o + 2] * dimFactor);
      diffData[o + 3] = 255;
    }
  }

  const diffPct = total === 0 ? 0 : (diff / total) * 100;
  const matchPct = 100 - diffPct;
  const ok = diffPct <= tolerancePct;

  let diffPath = null;
  if (diff > 0) {
    diffPath = await writeDiffPng(diffPng, actualPath);
  }

  return { matching: total - diff, total, diffPct, matchPct, diffPath, ok };
}

/**
 * Decode a PNG file from disk with a hard timeout (decode of a 780×1688 PNG is sub-100ms; the
 * timeout is a generous backstop against a wedged fs or a pathological image, not a tight budget).
 * Throws with the path + role + cause on any failure.
 */
async function decodePng(path, role, timeoutMs) {
  let buf;
  try {
    buf = await withTimeout(readFile(path), timeoutMs, `read ${role} ${path}`);
  } catch (e) {
    throw new Error(`[pixel] failed to read ${role} PNG ${path}: ${e instanceof Error ? e.message : e}`);
  }
  try {
    return PNG.sync.read(buf);
  } catch (e) {
    throw new Error(`[pixel] failed to decode ${role} PNG ${path}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Race `p` against a hard timeout; reject with a labeled error on expiry. */
function withTimeout(p, timeoutMs, label) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

/** Write the diff-highlight PNG to `e2e/shots/diffs/<basename>-<timestamp>.png`. Returns its path. */
async function writeDiffPng(diffPng, actualPath) {
  await mkdir(DIFFS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = basename(actualPath, '.png');
  const out = join(DIFFS_DIR, `${base}-${ts}.png`);
  try {
    const packed = PNG.sync.write(diffPng);
    await writeFile(out, packed);
  } catch (e) {
    throw new Error(`[pixel] failed to write diff PNG ${out}: ${e instanceof Error ? e.message : e}`);
  }
  return out;
}

/** Side-by-side composite for a dimension-mismatch diff (left = baseline, right = actual). */
async function writeSideBySideDiff(baselinePng, actualPng, actualPath) {
  await mkdir(DIFFS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = basename(actualPath, '.png');
  const out = join(DIFFS_DIR, `${base}-${ts}-sxs.png`);
  const w = Math.max(baselinePng.width, actualPng.width) * 2 + 8; // 8px gutter
  const h = Math.max(baselinePng.height, actualPng.height);
  const canvas = new PNG({ width: w, height: h });
  // PNG defaults to zeros (transparent black); fill with opaque mid-gray so the smaller image
  // doesn't look like a hole.
  for (let i = 3; i < canvas.data.length; i += 4) canvas.data[i] = 255;
  for (let i = 0; i < canvas.data.length; i += 4) {
    canvas.data[i] = 32; canvas.data[i + 1] = 32; canvas.data[i + 2] = 32;
  }
  const blit = (src, xOff) => {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const si = (y * src.width + x) * 4;
        const di = (y * w + x + xOff) * 4;
        canvas.data[di] = src.data[si];
        canvas.data[di + 1] = src.data[si + 1];
        canvas.data[di + 2] = src.data[si + 2];
        canvas.data[di + 3] = src.data[si + 3];
      }
    }
  };
  blit(baselinePng, 0);
  blit(actualPng, Math.max(baselinePng.width, actualPng.width) + 8);
  try {
    const packed = PNG.sync.write(canvas);
    await writeFile(out, packed);
  } catch (e) {
    throw new Error(`[pixel] failed to write side-by-side diff PNG ${out}: ${e instanceof Error ? e.message : e}`);
  }
  return out;
}
