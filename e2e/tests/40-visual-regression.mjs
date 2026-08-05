// Flow 40 — Visual regression: pixel-diff the 5 primary surfaces against committed baselines.
//
// Flow 35 (ux-tour) CAPTURES screenshots of every major surface but never compares them — a
// style/layout regression (the documented styles.ts single-block blind spot, a dropped import, an
// overflow, a contrast change) sails through `just verify` and only explodes on a device. This flow
// re-captures the SAME 5 surfaces flow 35 tours and diffs each against a committed baseline PNG via
// the pure pixel comparator in harness/pixel.mjs. Fails on pixel drift beyond a tolerance
// (default 0.5% — well above the residual font-AA variance under the FREEZE_CSS + srgb stabilization).
//
// The baselines ARE the contract — a future PR that intentionally changes a surface regenerates them
// (DPAY_E2E_REGEN_BASELINES=1) and the diff is reviewable in the commit. Mirrors the
// DPAY_E2E_REGEN_LAYOUT pattern (lib.mjs) for the wire-layout golden.
//
// Navigation mirrors flow 35 EXACTLY (already tuned — `balance` tap → Balances hub,
// `btn-balances-close`/`btn-settings-close` to dismiss). Capture filenames are DISTINCT from flow 35
// (40-vr-<surface> vs 35-tour-<surface>) so the two flows never collide on disk.
import { setup, onboardWallet, assert } from '../harness/lib.mjs';
import { comparePng } from '../harness/pixel.mjs';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = join(__dirname, '..', 'shots');
const BASELINES_DIR = join(SHOTS_DIR, 'baselines');

// The 5 primary surfaces, in capture order. Each entry pairs the per-run capture filename (what
// driver.screenshot writes) with the baseline name (the contract under e2e/shots/baselines/).
// Mirrors flow 35's tour order so the two flows exercise the identical navigation.
//
// `masksFromTestID` (optional): for surfaces with a non-deterministic region (a QR bitmap that
// encodes a per-run random nonce + a fresh per-onboarding pubkey), name a testID whose bounding
// rect is queried post-capture and passed to comparePng as a mask (in device pixels, padded ±4 to
// absorb sub-pixel render shifts at the boundary). The surrounding layout is still diffed.
const SURFACES = [
  { capture: '40-vr-wallet-pay', baseline: 'wallet-pay' },
  { capture: '40-vr-receive-request', baseline: 'receive-request', masksFromTestID: 'request-qr' },
  { capture: '40-vr-balances', baseline: 'balances' },
  { capture: '40-vr-settings', baseline: 'settings' },
  { capture: '40-vr-ledger', baseline: 'ledger' },
];

const REGEN = process.env.DPAY_E2E_REGEN_BASELINES === '1';
const TOLERANCE_PCT = 0.5;
const DEVICE_PIXEL_RATIO = 2; // driver.mjs VIEWPORT.deviceScaleFactor
const MASK_PAD_CSS = 4;       // pad the mask rect in CSS px to absorb sub-pixel render shifts

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '40',
  name: 'visual-regression',
  journey: 'tour',
  covers: ['visual-regression', 'pixel-diff'],
  verifies: 'Pixel-diff the 5 primary surfaces (Pay, Receive+QR, Balances, Settings, Ledger) vs committed baselines; fails on drift >0.5%.',
  timeoutMs: 25_000,
};

export async function run() {
  const start = Date.now();
  console.log('[40-visual-regression] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // masks[testID] = {x,y,w,h} in DEVICE pixels (collected post-capture via getBoundingClientRect).
    const masks = {};

    // 1. Onboard a funded wallet ($100 demo). Lands on the Pay tab.
    console.log('[40-visual-regression] onboarding…');
    await onboardWallet(driver, 'e2e-visual');
    await driver.waitForText('∂100.00', { timeoutMs: 5_000 });

    // 2. Capture wallet-Pay surface.
    await driver.screenshot(SURFACES[0].capture);

    // 3. Receive → enter an amount → request QR screen.
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '42.50', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });
    // Collect the QR's device-pixel rect for the post-capture mask BEFORE screenshotting (the rect
    // is stable while the element is mounted; capturing then querying in either order is fine, but
    // doing it before keeps the masking self-contained per surface).
    masks['request-qr'] = await getTestIDRectDevicePx(driver, 'request-qr');
    await driver.screenshot(SURFACES[1].capture);

    // 4. Balances hub — opened by tapping the header balance (mirrors flow 35). The header balance
    //    is always present (even over the request card), so this also dismisses the request screen.
    await driver.click('balance', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-balances-close', { timeoutMs: 5_000 });
    await driver.screenshot(SURFACES[2].capture);
    await driver.click('btn-balances-close', { timeoutMs: 4_000 });

    // 5. Settings (relay config + reset).
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await driver.findByTestID('settings-relay', { timeoutMs: 5_000 });
    await driver.screenshot(SURFACES[3].capture);
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });

    // 6. Ledger (transaction history — empty initially for a fresh wallet).
    await driver.click('tab-transactions', { timeoutMs: 5_000 });
    await driver.waitForText('No transactions', { timeoutMs: 3_000 }).catch(() => {});
    await driver.screenshot(SURFACES[4].capture);

    // 7. Diff each capture against its baseline (or seed if missing + REGEN).
    await mkdir(BASELINES_DIR, { recursive: true });
    const summary = [];
    for (const s of SURFACES) {
      const capturePath = join(SHOTS_DIR, `${s.capture}.png`);
      const baselinePath = join(BASELINES_DIR, `${s.baseline}.png`);
      const surfaceMasks = s.masksFromTestID ? (masks[s.masksFromTestID] ? [masks[s.masksFromTestID]] : []) : [];
      const line = await diffOrSeed(baselinePath, capturePath, s.baseline, surfaceMasks);
      summary.push(line);
    }

    console.log('\n[40-visual-regression] per-surface summary:');
    for (const line of summary) console.log(`  ${line}`);

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    const failures = summary.filter((l) => l.startsWith('✗'));
    if (failures.length > 0) {
      throw new Error(
        `[40-visual-regression] ${failures.length} surface(s) drifted past tolerance (${TOLERANCE_PCT}%):\n` +
        failures.join('\n'),
      );
    }
    console.log(`[40-visual-regression] GREEN in ${elapsed}s (0 diffs > ${TOLERANCE_PCT}%)`);
    assert(true, 'visual regression passed');
  } finally {
    await env.stop();
  }
}

/**
 * Get an element's bounding rect in DEVICE pixels (CSS × DEVICE_PIXEL_RATIO) with MASK_PAD_CSS
 * padding on each side. Returns null if the element isn't found (the mask is then skipped, which
 * surfaces as drift on a non-deterministic surface — a useful signal, not a silent miss).
 */
async function getTestIDRectDevicePx(driver, testID) {
  try {
    const rect = await driver.eval(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      },
      `[data-testid="${testID}"]`,
    );
    if (!rect) {
      console.warn(`[40-visual-regression] mask source testID=${testID} not found; surface will not be masked`);
      return null;
    }
    return {
      x: Math.max(0, (rect.x - MASK_PAD_CSS) * DEVICE_PIXEL_RATIO),
      y: Math.max(0, (rect.y - MASK_PAD_CSS) * DEVICE_PIXEL_RATIO),
      w: (rect.w + 2 * MASK_PAD_CSS) * DEVICE_PIXEL_RATIO,
      h: (rect.h + 2 * MASK_PAD_CSS) * DEVICE_PIXEL_RATIO,
    };
  } catch (e) {
    console.warn(`[40-visual-regression] mask source testID=${testID} lookup failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * Diff one capture against its baseline, or seed the baseline if missing + REGEN. Returns a single
 * summary line for the per-surface report. Throws on missing-baseline-without-regen (clear message
 * naming the surface + the regen command) and propagates comparator failures.
 */
async function diffOrSeed(baselinePath, capturePath, baselineName, masks = []) {
  const baselineExists = existsSync(baselinePath);
  if (!baselineExists) {
    if (REGEN) {
      await copyFile(capturePath, baselinePath);
      console.log(`[40-visual-regression] seeded baseline ${baselineName} → ${baselinePath}`);
      return `✓ ${baselineName.padEnd(18)} SEEDED (baseline written; commit it)`;
    }
    // Missing baseline without REGEN is a hard failure with the exact remediation — never silently
    // pass. This is what makes the contract enforceable: a new surface without a baseline REDS.
    throw new Error(
      `[40-visual-regression] baseline missing for ${baselineName}; run with DPAY_E2E_REGEN_BASELINES=1 to seed`,
    );
  }

  const validMasks = masks.filter(Boolean);
  const r = await comparePng(baselinePath, capturePath, { tolerancePct: TOLERANCE_PCT, masks: validMasks });
  const mark = r.ok ? '✓' : '✗';
  const maskNote = validMasks.length > 0 ? ` (masked:${validMasks.length})` : '';
  const diffNote = r.diffPath ? ` diff=${r.diffPath}` : '';
  if (!r.ok) {
    // Surface drifted past tolerance. Log the diff path + diffPct for immediate triage, then mark
    // the summary line so the run reports RED with all surfaces (not just the first).
    console.error(
      `[40-visual-regression] ✗ ${baselineName} drifted: ${r.diffPct.toFixed(3)}% diff (tolerance ${TOLERANCE_PCT}%)${maskNote}.${diffNote}`,
    );
    return `${mark} ${baselineName.padEnd(18)} DRIFT ${r.diffPct.toFixed(3)}% > ${TOLERANCE_PCT}%${maskNote}${diffNote}`;
  }
  return `${mark} ${baselineName.padEnd(18)} ok   ${r.diffPct.toFixed(3)}% ≤ ${TOLERANCE_PCT}%${maskNote}${diffNote}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[40-visual-regression] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
