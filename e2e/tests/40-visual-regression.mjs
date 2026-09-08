// Flow 40 — Visual regression: pixel-diff the 6 primary surfaces against committed baselines.
//
// Flow 35 (ux-tour) CAPTURES screenshots of every major surface but never compares them — a
// style/layout regression (the documented styles.ts single-block blind spot, a dropped import, an
// overflow, a contrast change) sails through `just verify` and only explodes on a device. This flow
// re-captures the SAME surfaces flow 35 tours and diffs each against a committed baseline PNG via
// the pure pixel comparator in harness/pixel.mjs. Fails on pixel drift beyond a tolerance
// (default 0.5% — well above the residual font-AA variance under the FREEZE_CSS + srgb stabilization).
//
// The baselines ARE the contract — a future PR that intentionally changes a surface regenerates them
// (DPAY_E2E_REGEN_BASELINES=1) and the diff is reviewable in the commit. Mirrors the
// DPAY_E2E_REGEN_LAYOUT pattern (lib.mjs) for the wire-layout golden.
//
// Navigation mirrors flow 35 EXACTLY (already tuned — `tab-home` for the Home surface, the header
// `balance` chip for the Accounts route, `btn-settings-close` to dismiss the Settings sheet). Capture filenames are DISTINCT from flow 35
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

// The 6 primary surfaces, in capture order. Each entry pairs the per-run capture filename (what
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
  { capture: '40-vr-home', baseline: 'home' },
  // The accounts list became its own surface on 2026-09-08 (it was ~80% of the Home screen). It
  // carries the per-rail rows, the MAIN badge, the practice divider and the Convert action, so it
  // needs its own pixel contract — none of that is visible on Home any more.
  { capture: '40-vr-accounts', baseline: 'accounts' },
  { capture: '40-vr-settings', baseline: 'settings' },
  { capture: '40-vr-ledger', baseline: 'ledger', masksFromTestID: 'hist-time-0' },
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
  verifies: 'Pixel-diff the 5 primary surfaces (Pay, Receive+QR, Home, Settings, Ledger) vs committed baselines; fails on drift >0.5%.',
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

    // 1. Onboard a funded wallet ($100 demo). The harness preamble leaves the app on the Pay tab.
    console.log('[40-visual-regression] onboarding…');
    await onboardWallet(driver, 'e2e-visual');
    await driver.waitForText('∂100.00', { timeoutMs: 5_000 });
    await driver.findByTestID('pay-scan', { timeoutMs: 5_000 });

    // 2. Capture wallet-Pay surface. The TripStrip no longer renders here (it is Home-only since
    //    2026-09-08), so the fade this capture used to wait out has moved to the Home surface
    //    below — where it is still waited out, for exactly the reason recorded there.
    await driver.screenshot(SURFACES[0].capture);

    // 3. Receive → enter an amount → request QR screen.
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '42.50', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });
    // Trip Ready J4: the first-use receiveRequest coach card mounts with this screen and plays a
    // ~480ms rise+fade entrance — the LAST thing on this surface to stop moving. Capturing
    // mid-animation is nondeterministic frame-to-frame (the original 3.7%→12% "drift" was just
    // animation state, not layout). Wait for the card's own opacity+transform to stop changing
    // across a rendered frame, which is true at the same point in the animation on an idle host
    // and on a loaded one.
    await driver.waitAtRest('coach-receiveRequest', { timeoutMs: 8_000 });
    // Collect the QR's device-pixel rect for the post-capture mask BEFORE screenshotting (the rect
    // is stable while the element is mounted; capturing then querying in either order is fine, but
    // doing it before keeps the masking self-contained per surface).
    masks['request-qr'] = await getTestIDRectDevicePx(driver, 'request-qr');
    await driver.screenshot(SURFACES[1].capture);

    // 4. Home tab — the landing overview. The bottom tab bar is always present, so this also
    //    dismisses the request screen.
    await driver.click('tab-home', { timeoutMs: 5_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    // Determinism: the TripStrip's 260ms entrance fade is the last thing moving on this surface.
    // Capturing mid-fade samples a partial opacity, which is why the old wallet-Pay capture
    // drifted between 0.2% and 0.55% run to run on identical code. Waited in FRAMES, not
    // milliseconds: `Animated` runs off requestAnimationFrame, so a fixed 500ms was a bet on the
    // host's frame rate. Same idiom as the coach-card settle above.
    await driver.waitAtRest('trip-strip', { timeoutMs: 8_000 });
    await driver.screenshot(SURFACES[2].capture);

    // 4b. The accounts route — the per-rail rows, reached the way a user reaches them.
    await driver.click('btn-home-accounts', { timeoutMs: 5_000 });
    await driver.findByTestID('accounts-list', { timeoutMs: 5_000 });
    await driver.screenshot(SURFACES[3].capture);
    await driver.click('btn-accounts-back', { timeoutMs: 4_000 });
    await driver.click('tab-pay', { timeoutMs: 4_000 });

    // 5. Settings (relay config + reset). The "Advanced" disclosure defaults COLLAPSED now (the
    //    founder-directed consumer posture: relay URL hidden unless explicitly expanded). The
    //    captured baseline reflects the collapsed state.
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-advanced-toggle', { timeoutMs: 5_000 });
    await driver.screenshot(SURFACES[4].capture);
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });

    // 6. Ledger (transaction history — one faucet row for a fresh wallet). The row's TIMESTAMP is
    //    inherently time-varying (minute digits + 1↔2-digit hour width flips the changed-pixel
    //    count), so mask it (same mechanism as the request QR) — an unmasked diff was a standing
    //    flake riding just under the 0.5% tolerance.
    await driver.click('tab-transactions', { timeoutMs: 5_000 });
    await driver.waitForText('No payments yet', { timeoutMs: 3_000 }).catch(() => {});
    if (await driver.isPresent('hist-time-0')) {
      masks['hist-time-0'] = await getTestIDRectDevicePx(driver, 'hist-time-0');
    }
    await driver.screenshot(SURFACES[5].capture);

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
  const validMasks = masks.filter(Boolean);
  // Missing baseline: hard-fail unless REGEN, in which case seed it. This is what makes the contract
  // enforceable: a new surface without a baseline REDS until it's deliberately seeded.
  if (!baselineExists) {
    if (REGEN) {
      await mkdir(dirname(baselinePath), { recursive: true });
      await copyFile(capturePath, baselinePath);
      console.log(`[40-visual-regression] seeded baseline ${baselineName} → ${baselinePath}`);
      return `✓ ${baselineName.padEnd(18)} SEEDED (baseline written; commit it)`;
    }
    throw new Error(
      `[40-visual-regression] baseline missing for ${baselineName}; run with DPAY_E2E_REGEN_BASELINES=1 to seed`,
    );
  }

  // Compare the capture against the existing baseline (masked regions ignored).
  const r = await comparePng(baselinePath, capturePath, { tolerancePct: TOLERANCE_PCT, masks: validMasks });
  const maskNote = validMasks.length > 0 ? ` (masked:${validMasks.length})` : '';
  // REGEN mode: only OVERWRITE a baseline that actually DRIFTED past tolerance. Stable surfaces keep
  // their original baseline → the seed commit shows ONLY the surfaces that genuinely changed (clean,
  // reviewable). Without this gate, `just e2e-visual-seed` would overwrite every baseline with a
  // fresh capture (incl. non-deterministic masked regions like the random request QR), making the
  // commit diff noisy and obscuring which surface actually moved.
  if (REGEN && !r.ok) {
    await copyFile(capturePath, baselinePath);
    console.log(`[40-visual-regression] re-seeded drifted baseline ${baselineName} (${r.diffPct.toFixed(3)}% → 0%) → ${baselinePath}`);
    return `✓ ${baselineName.padEnd(18)} RE-SEEDED (was ${r.diffPct.toFixed(3)}%; overwritten; commit it)`;
  }
  const mark = r.ok ? '✓' : '✗';
  const diffNote = r.diffPath ? ` diff=${r.diffPath}` : '';
  if (!r.ok) {
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
