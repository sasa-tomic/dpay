// Flow 84 — Visual regression, DARK THEME (Wave 4 dual theme).
//
// Same five-surface walkthrough as flow 40 (the light visual-regression gate), but the driver
// emulates an OS dark scheme (page.emulateMediaFeatures prefers-color-scheme: dark) BEFORE any
// page script runs — RNW's Appearance resolves dark at bundle init, so the app boots straight
// into the DARK palette with no light flash. This is the gate that dark mode actually RENDERS
// everywhere the light flow walks: wallet/Pay, Receive request-QR, Balances, Settings, Ledger.
//
// Baselines live in their OWN dir (shots/baselines-dark/) — the light baselines stay the
// authority for "light is visually unchanged" (flow 40). Seed with:
//   cd e2e && DPAY_E2E_REGEN_BASELINES=1 DPAY_E2E_FILTER=84 node run.mjs
// (same seeding policy as flow 40: REGEN only overwrites baselines that drifted past tolerance,
// so a seed commit shows only genuinely-moved surfaces).
import { setup, onboardWallet, assert } from '../harness/lib.mjs';
import { comparePng } from '../harness/pixel.mjs';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = join(__dirname, '..', 'shots');
const BASELINES_DIR = join(SHOTS_DIR, 'baselines-dark');

// Same 6 primary surfaces, in the same capture order as flow 40 (mirrors its tour = flow 35).
// Baseline names are identical so the two dirs diff key-for-key; capture filenames carry the
// 84-vr-dark- prefix so the two flows never collide in e2e/shots/.
const SURFACES = [
  { capture: '84-vr-dark-wallet-pay', baseline: 'wallet-pay' },
  // request-qr is masked in BOTH flows: the QR encodes a per-run signed request (fresh key +
  // timestamp), so its module pixels can never be deterministic.
  { capture: '84-vr-dark-receive-request', baseline: 'receive-request', masksFromTestID: 'request-qr' },
  { capture: '84-vr-dark-home', baseline: 'home' },
  { capture: '84-vr-dark-accounts', baseline: 'accounts' },
  { capture: '84-vr-dark-settings', baseline: 'settings' },
  { capture: '84-vr-dark-ledger', baseline: 'ledger', masksFromTestID: 'hist-time-0' },
];

const REGEN = process.env.DPAY_E2E_REGEN_BASELINES === '1';
const TOLERANCE_PCT = 0.5;
const DEVICE_PIXEL_RATIO = 2; // driver.mjs VIEWPORT.deviceScaleFactor
const MASK_PAD_CSS = 4;       // pad the mask rect in CSS px to absorb sub-pixel render shifts

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '84',
  name: 'visual-dark',
  journey: 'tour',
  covers: ['visual-regression', 'pixel-diff', 'dark-theme'],
  verifies:
    'Pixel-diff the 5 primary surfaces under an emulated OS dark scheme (prefers-color-scheme: dark) vs the dark-theme baselines in shots/baselines-dark/; the gate that the DARK palette renders on every surface the light flow walks.',
  timeoutMs: 25_000,
};

export async function run() {
  const start = Date.now();
  console.log('[84-visual-dark] setup (relay + web + browser, dark scheme)…');
  const env = await setup({ dark: true });
  try {
    const { driver } = env;

    // The page must report the emulated dark scheme — asserts the harness opt reached the page
    // (an emulation regression would otherwise silently pixel-test LIGHT against dark baselines).
    const darkReported = await driver.eval(
      () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    );
    assert(darkReported === true, 'page reports prefers-color-scheme: dark (driver dark emulation active)');

    // Also assert the app RESOLVED dark (RNW Appearance) — proves the bundle's module-load probe
    // + useColorScheme wiring saw the emulated media, not just the raw CSS media query.
    const bg = await driver.eval(() => getComputedStyle(document.querySelector('#root > div')).backgroundColor);
    assert(
      bg === 'rgb(20, 18, 16)',
      `app root renders DARK bg (expected rgb(20, 18, 16)=#141210, got ${bg})`,
    );

    const masks = {};

    // 1. Onboard a funded wallet ($100 demo). The harness preamble leaves the app on the Pay tab.
    console.log('[84-visual-dark] onboarding…');
    await onboardWallet(driver, 'e2e-visual-dark');
    await driver.waitForText('∂100.00', { timeoutMs: 5_000 });
    await driver.findByTestID('pay-scan', { timeoutMs: 5_000 });

    // 2. Capture wallet-Pay surface. The TripStrip is Home-only since 2026-09-08, so its fade is
    //    waited out on the Home surface below instead — mirrors flow 40.
    await driver.screenshot(SURFACES[0].capture);

    // 3. Receive → enter an amount → request QR screen.
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '42.50', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });
    // Trip Ready J4: let the receiveRequest coach card's ~480ms rise+fade entrance settle to rest
    // so the capture (and the baseline contract) are deterministic — mirrors flow 40.
    await driver.waitAtRest('coach-receiveRequest', { timeoutMs: 8_000 });
    masks['request-qr'] = await getTestIDRectDevicePx(driver, 'request-qr');
    await driver.screenshot(SURFACES[1].capture);

    // 4. Home tab (the landing overview; also dismisses the request screen via the ever-present
    //    bottom tab bar). The TripStrip's 260ms entrance fade is the last thing moving here —
    //    waited in FRAMES, mirrors flow 40. A bright strip against black moves far more per
    //    channel than the same strip on white, so this surface is the one that needs it most.
    await driver.click('tab-home', { timeoutMs: 5_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    await driver.waitAtRest('trip-strip', { timeoutMs: 8_000 });
    await driver.screenshot(SURFACES[2].capture);

    // 4b. The accounts route — its own surface since 2026-09-08 (mirrors flow 40).
    await driver.click('btn-home-accounts', { timeoutMs: 5_000 });
    await driver.findByTestID('accounts-list', { timeoutMs: 5_000 });
    await driver.screenshot(SURFACES[3].capture);
    await driver.click('btn-accounts-back', { timeoutMs: 4_000 });
    await driver.click('tab-pay', { timeoutMs: 4_000 });

    // 5. Settings (Advanced disclosure defaults COLLAPSED — matches flow 40's baseline state).
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-advanced-toggle', { timeoutMs: 5_000 });
    await driver.screenshot(SURFACES[4].capture);
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });

    // 6. Ledger (one faucet row for a fresh wallet). Mask the row TIMESTAMP — same time-varying
    //    flake fix as flow 40's ledger surface.
    await driver.click('tab-transactions', { timeoutMs: 5_000 });
    await driver.waitForText('No payments yet', { timeoutMs: 3_000 }).catch(() => {});
    if (await driver.isPresent('hist-time-0')) {
      masks['hist-time-0'] = await getTestIDRectDevicePx(driver, 'hist-time-0');
    }
    await driver.screenshot(SURFACES[5].capture);

    // 7. Diff each capture against its dark baseline (or seed if missing + REGEN).
    await mkdir(BASELINES_DIR, { recursive: true });
    const summary = [];
    for (const s of SURFACES) {
      const capturePath = join(SHOTS_DIR, `${s.capture}.png`);
      const baselinePath = join(BASELINES_DIR, `${s.baseline}.png`);
      const surfaceMasks = s.masksFromTestID ? (masks[s.masksFromTestID] ? [masks[s.masksFromTestID]] : []) : [];
      const line = await diffOrSeed(baselinePath, capturePath, s.baseline, surfaceMasks);
      summary.push(line);
    }

    console.log('\n[84-visual-dark] per-surface summary:');
    for (const line of summary) console.log(`  ${line}`);

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    const failures = summary.filter((l) => l.startsWith('✗'));
    if (failures.length > 0) {
      throw new Error(
        `[84-visual-dark] ${failures.length} surface(s) drifted past tolerance (${TOLERANCE_PCT}%):\n` +
        failures.join('\n'),
      );
    }
    console.log(`[84-visual-dark] GREEN in ${elapsed}s (0 diffs > ${TOLERANCE_PCT}%)`);
    assert(true, 'dark visual regression passed');
  } finally {
    await env.stop();
  }
}

/** Identical to flow 40's helper (device-px rect ± pad for the QR mask). */
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
      console.warn(`[84-visual-dark] mask source testID=${testID} not found; surface will not be masked`);
      return null;
    }
    return {
      x: Math.max(0, (rect.x - MASK_PAD_CSS) * DEVICE_PIXEL_RATIO),
      y: Math.max(0, (rect.y - MASK_PAD_CSS) * DEVICE_PIXEL_RATIO),
      w: (rect.w + 2 * MASK_PAD_CSS) * DEVICE_PIXEL_RATIO,
      h: (rect.h + 2 * MASK_PAD_CSS) * DEVICE_PIXEL_RATIO,
    };
  } catch (e) {
    console.warn(`[84-visual-dark] mask source testID=${testID} lookup failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Identical policy to flow 40's diffOrSeed: missing baseline hard-fails without REGEN; REGEN
  * only overwrites baselines that drifted past tolerance (clean seed commits). */
async function diffOrSeed(baselinePath, capturePath, baselineName, masks = []) {
  const baselineExists = existsSync(baselinePath);
  const validMasks = masks.filter(Boolean);
  if (!baselineExists) {
    if (REGEN) {
      await mkdir(dirname(baselinePath), { recursive: true });
      await copyFile(capturePath, baselinePath);
      console.log(`[84-visual-dark] seeded baseline ${baselineName} → ${baselinePath}`);
      return `✓ ${baselineName.padEnd(18)} SEEDED (baseline written; commit it)`;
    }
    throw new Error(
      `[84-visual-dark] baseline missing for ${baselineName}; run with DPAY_E2E_REGEN_BASELINES=1 to seed`,
    );
  }

  const r = await comparePng(baselinePath, capturePath, { tolerancePct: TOLERANCE_PCT, masks: validMasks });
  const maskNote = validMasks.length > 0 ? ` (masked:${validMasks.length})` : '';
  if (REGEN && !r.ok) {
    await copyFile(capturePath, baselinePath);
    console.log(`[84-visual-dark] re-seeded drifted baseline ${baselineName} (${r.diffPct.toFixed(3)}% → 0%) → ${baselinePath}`);
    return `✓ ${baselineName.padEnd(18)} RE-SEEDED (was ${r.diffPct.toFixed(3)}%; overwritten; commit it)`;
  }
  const mark = r.ok ? '✓' : '✗';
  const diffNote = r.diffPath ? ` diff=${r.diffPath}` : '';
  if (!r.ok) {
    console.error(
      `[84-visual-dark] ✗ ${baselineName} drifted: ${r.diffPct.toFixed(3)}% diff (tolerance ${TOLERANCE_PCT}%)${maskNote}.${diffNote}`,
    );
    return `${mark} ${baselineName.padEnd(18)} DRIFT ${r.diffPct.toFixed(3)}% > ${TOLERANCE_PCT}%${maskNote}${diffNote}`;
  }
  return `${mark} ${baselineName.padEnd(18)} ok   ${r.diffPct.toFixed(3)}% ≤ ${TOLERANCE_PCT}%${maskNote}${diffNote}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[84-visual-dark] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
