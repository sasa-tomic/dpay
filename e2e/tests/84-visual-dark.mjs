// Flow 84 — Visual regression, DARK THEME (Wave 4 dual theme).
//
// Same six-surface walkthrough as flow 40 (the light visual-regression gate), but the driver
// emulates an OS dark scheme (page.emulateMediaFeatures prefers-color-scheme: dark) BEFORE any
// page script runs — RNW's Appearance resolves dark at bundle init, so the app boots straight
// into the DARK palette with no light flash. This is the gate that dark mode actually RENDERS
// everywhere the light flow walks: wallet/Pay, Receive request-QR, Balances, Settings, Ledger —
// plus TWO convert surfaces light flow 40 does not carry: the venue CHOOSER (two venues, quotes
// settled, nothing picked) and the pre-sign CHECKLIST under a pick. Convert is the newest money
// surface (V1–V11), so its dark palette is pinned here, not assumed.
//
// The convert surfaces need determinism the shared relay cannot give (a second venue + a funded
// ICP row), so the flow runs on its OWN relay (startRelay, the flow-166/167 pattern): the
// fixture-B venue knob arms the second venue, the faucet funds 3 ICP AFTER the ledger capture
// (a new ledger row would break the ledger baseline). Quote values are deterministic on a fresh
// private pool; the quote TIMESTAMP lines are masked (per-run clock).
//
// Baselines live in their OWN dir (shots/baselines-dark/) — the light baselines stay the
// authority for "light is visually unchanged" (flow 40). Seed with:
//   cd e2e && DPAY_E2E_REGEN_BASELINES=1 DPAY_E2E_FILTER=84 node run.mjs
// (same seeding policy as flow 40: REGEN only overwrites baselines that drifted past tolerance,
// so a seed commit shows only genuinely-moved surfaces).
import { setup, onboardWallet, assert, openBalances, selectCurrency, accountOf, faucetAccount, openConvertFor, openOtherVenues, typeConvertAmount } from '../harness/lib.mjs';
import { startRelay } from '../harness/relay.mjs';
import { comparePng } from '../harness/pixel.mjs';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = join(__dirname, '..', 'shots');
const BASELINES_DIR = join(SHOTS_DIR, 'baselines-dark');

const SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON)
const FIXTURE_VENUE = 'icpswap-fixture-b';

// Same 6 primary surfaces, in the same capture order as flow 40 (mirrors its tour = flow 35),
// then the 2 convert surfaces. Baseline names are identical across flows so the dirs diff
// key-for-key; capture filenames carry the 84-vr-dark- prefix so the flows never collide in
// e2e/shots/.
//
// `masksFromTestIDs` (ARRAY — a flow-84 extension): non-deterministic regions (QR bitmaps, clock
// lines) named by testID; each rect is collected post-capture and passed to comparePng as a mask
// (device px, padded ±4). The chooser masks BOTH quote-attribution timestamps (one per row); the
// checklist masks the active quote's timestamp.
const SURFACES = [
  { capture: '84-vr-dark-wallet-pay', baseline: 'wallet-pay' },
  // request-qr is masked in BOTH flows: the QR encodes a per-run signed request (fresh key +
  // timestamp), so its module pixels can never be deterministic.
  { capture: '84-vr-dark-receive-request', baseline: 'receive-request', masksFromTestIDs: ['request-qr'] },
  { capture: '84-vr-dark-home', baseline: 'home' },
  { capture: '84-vr-dark-accounts', baseline: 'accounts' },
  { capture: '84-vr-dark-settings', baseline: 'settings' },
  { capture: '84-vr-dark-ledger', baseline: 'ledger', masksFromTestIDs: ['hist-time-0'] },
  // The convert venue chooser: two rows, each with its own quote, NOTHING picked (V5). Both
  // per-row quote-attribution clock lines are masked.
  { capture: '84-vr-dark-convert-chooser', baseline: 'convert-chooser',
    masksFromTestIDs: ['convert-quote-source'] },
  // The convert pre-sign checklist under a pick (the real venue): fees, counterparty, refusal —
  // the active quote's timestamp is masked.
  { capture: '84-vr-dark-convert-checklist', baseline: 'convert-checklist',
    masksFromTestIDs: ['convert-quote-source'] },
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
  covers: ['visual-regression', 'pixel-diff', 'dark-theme', 'convert', 'venue-chooser'],
  verifies:
    'Pixel-diff the 8 surfaces (6 primary + the convert venue-chooser and pre-sign checklist, on a private two-venue relay) under an emulated OS dark scheme (prefers-color-scheme: dark) vs the dark-theme baselines in shots/baselines-dark/; the gate that the DARK palette renders on every surface the light flow walks.',
  timeoutMs: 90_000,
};

export async function run() {
  const start = Date.now();
  console.log('[84-visual-dark] setup (own relay + web + browser, dark scheme)…');
  const env = await setup({ dark: true });
  const r2 = await startRelay(); // own relay: the venue knob + ICP funding cannot touch a sibling flow
  try {
    const { driver, webBaseURL } = env;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});

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
      bg === 'rgb(12, 19, 18)',
      `app root renders DARK bg (expected rgb(12, 19, 18)=#0C1312, got ${bg})`,
    );

    const masks = {};

    // Arm the second venue BEFORE the wallet mounts (the convert surface loads /api/v1/venues on
    // mount) — the chooser baseline shows TWO rows.
    const arm = await fetch(`${r2.baseURL}/api/v1/test/venue`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({venue_id: FIXTURE_VENUE, served: true}),
    });
    assert(arm.ok, `venue knob armed (status ${arm.status})`);

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
    if (await driver.isPresent('hist-time-0')) {
      masks['hist-time-0'] = await getTestIDRectDevicePx(driver, 'hist-time-0');
    }
    await driver.screenshot(SURFACES[5].capture);

    // 6c. CONVERT surfaces (this flow's own; flow 40 does not carry them): the intent sheet
    //     (the 2026-09-26 two-tap surface). Fund ICP only NOW — after the ledger capture — so
    //     the faucet row cannot perturb the ledger baseline. Shot A: the sheet with the
    //     Other-venues expander OPEN (both venue rows, each with its own quote). Shot B: the
    //     review card under the ONE-TAP override to the real venue, with the fee census open —
    //     anchored at the floor line; every clock line is masked.
    console.log('[84-visual-dark] convert surfaces (sheet + census)…');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED, {currency: 8});
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);

    await openConvertFor(driver, 'icp');
    await typeConvertAmount(driver, '1');
    await driver.findByTestID('convert-venue-auto', {timeoutMs: 10_000});
    await openOtherVenues(driver);
    // The sheet grammar: ICPSwap is the auto pick (its number backs the card, attributed via
    // convert-quote-source); the fixture venue waits behind the expander with its OWN quote.
    await driver.findByTestID(`convert-venue-${FIXTURE_VENUE}-quote`, {timeoutMs: 10_000});
    await driver.eval(() => window.scrollTo(0, 0));
    for (const tid of SURFACES[6].masksFromTestIDs) {
      masks[tid] = await getTestIDRectDevicePx(driver, tid);
    }
    await driver.screenshot(SURFACES[6].capture);

    await driver.click(`convert-venue-${FIXTURE_VENUE}`, {timeoutMs: 5_000});
    await driver.findByTestID('convert-min-out', {timeoutMs: 10_000});
    await driver.findByTestID('convert-quote-source', {timeoutMs: 5_000});
    await driver.click('convert-details', {timeoutMs: 5_000});
    await driver.eval(() => {
      document.querySelector('[data-testid="convert-min-out"]').scrollIntoView({block: 'start'});
    });
    await driver.settleFrames(3);
    for (const tid of SURFACES[7].masksFromTestIDs) {
      masks[tid] = await getTestIDRectDevicePx(driver, tid);
    }
    await driver.screenshot(SURFACES[7].capture);

    // 7. Diff each capture against its dark baseline (or seed if missing + REGEN).
    await mkdir(BASELINES_DIR, { recursive: true });
    const summary = [];
    for (const s of SURFACES) {
      const capturePath = join(SHOTS_DIR, `${s.capture}.png`);
      const baselinePath = join(BASELINES_DIR, `${s.baseline}.png`);
      const surfaceMasks = (s.masksFromTestIDs ?? []).map(k => masks[k]).filter(Boolean);
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
    // env.stop() first (flow-38 convention): quiesce the page's polls before killing the relay.
    await env.stop();
    await r2.stop();
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
