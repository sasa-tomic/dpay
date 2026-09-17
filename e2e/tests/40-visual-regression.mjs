// Flow 40 — Visual regression: pixel-diff the primary surfaces + the convert surfaces against
// committed LIGHT baselines.
//
// Flow 35 (ux-tour) CAPTURES screenshots of every major surface but never compares them — a
// style/layout regression (the documented styles.ts single-block blind spot, a dropped import, an
// overflow, a contrast change) sails through `just verify` and only explodes on a device. This flow
// re-captures the SAME surfaces flow 35 tours and diffs each against a committed baseline PNG via
// the pure pixel comparator in harness/pixel.mjs. Fails on pixel drift beyond a tolerance
// (default 0.5% — well above the residual font-AA variance under the FREEZE_CSS + srgb stabilization).
//
// 2026-09-11: the surface set grew from 6 to 8 — the convert venue-CHOOSER (two venues, quotes
// settled, nothing picked) and the pre-sign CHECKLIST under a pick are now pinned in LIGHT too
// (they were dark-only, flow 84). The convert surfaces need determinism the shared relay cannot
// give (a second venue + a funded ICP row), so the flow runs on its OWN relay (startRelay, the
// flow-84/166/167 pattern): the fixture-B venue knob arms the second venue BEFORE onboarding, the
// faucet funds 3 ICP only AFTER the ledger capture (a new ledger row would break the ledger
// baseline), and the quote TIMESTAMP lines are masked (per-run clock) — all mirroring flow 84,
// which owns the dark twins of the same two surfaces.
//
// The baselines ARE the contract — a future PR that intentionally changes a surface regenerates them
// (DPAY_E2E_REGEN_BASELINES=1) and the diff is reviewable in the commit. Mirrors the
// DPAY_E2E_REGEN_LAYOUT pattern (lib.mjs) for the wire-layout golden.
//
// Navigation mirrors flow 35 EXACTLY (already tuned — `tab-home` for the Home surface, the header
// `balance` chip for the Accounts route, `btn-settings-close` to dismiss the Settings sheet). Capture filenames are DISTINCT from flow 35
// (40-vr-<surface> vs 35-tour-<surface>) so the two flows never collide on disk.
import { setup, onboardWallet, assert, openBalances, selectCurrency, accountOf, faucetAccount } from '../harness/lib.mjs';
import { startRelay } from '../harness/relay.mjs';
import { comparePng } from '../harness/pixel.mjs';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = join(__dirname, '..', 'shots');
const BASELINES_DIR = join(SHOTS_DIR, 'baselines');

// The surfaces, in capture order. Each entry pairs the per-run capture filename (what
// driver.screenshot writes) with the baseline name (the contract under e2e/shots/baselines/).
// Mirrors flow 35's tour order so the two flows exercise the identical navigation.
//
// `masksFromTestIDs` (ARRAY — the flow-84 form): for surfaces with non-deterministic regions (a
// QR bitmap that encodes a per-run random nonce + a fresh per-onboarding pubkey, clock lines),
// name the testIDs whose bounding rects are queried post-capture and passed to comparePng as
// masks (in device pixels, padded ±4 to absorb sub-pixel render shifts at the boundary). The
// surrounding layout is still diffed.
const SURFACES = [
  { capture: '40-vr-wallet-pay', baseline: 'wallet-pay' },
  { capture: '40-vr-receive-request', baseline: 'receive-request', masksFromTestIDs: ['request-qr'] },
  { capture: '40-vr-home', baseline: 'home' },
  // The accounts list became its own surface on 2026-09-08 (it was ~80% of the Home screen). It
  // carries the per-rail rows, the MAIN badge, the practice divider and the Convert action, so it
  // needs its own pixel contract — none of that is visible on Home any more.
  { capture: '40-vr-accounts', baseline: 'accounts' },
  { capture: '40-vr-settings', baseline: 'settings' },
  { capture: '40-vr-ledger', baseline: 'ledger', masksFromTestIDs: ['hist-time-0'] },
  // The convert venue chooser (light twin of flow 84's): two rows, each with its own quote,
  // NOTHING picked (V5). Both per-row quote-attribution clock lines are masked.
  { capture: '40-vr-convert-chooser', baseline: 'convert-chooser',
    masksFromTestIDs: ['convert-venue-icpswap-source', 'convert-venue-icpswap-fixture-b-source'] },
  // The convert pre-sign checklist (light twin) under a pick (the real venue): fees,
  // counterparty, refusal — the active quote's timestamp is masked.
  { capture: '40-vr-convert-checklist', baseline: 'convert-checklist',
    masksFromTestIDs: ['convert-quote-source'] },
];

const SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON)
const FIXTURE_VENUE = 'icpswap-fixture-b';

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
  covers: ['visual-regression', 'pixel-diff', 'row-layout', 'convert', 'venue-chooser'],
  verifies: 'Pixel-diff the 8 surfaces (6 primary — Pay, Receive+QR, Home, Accounts, Settings, Ledger — plus the convert venue-chooser and pre-sign checklist, on a private two-venue relay) vs committed light baselines, failing on drift >0.5%; and prove the ledger amount cannot be moved by a wider timestamp, so a baseline can only go red for a code change.',
  timeoutMs: 90_000,
};

export async function run() {
  const start = Date.now();
  console.log('[40-visual-regression] setup (own relay + web + browser)…');
  const env = await setup();
  // Own relay for the WHOLE run (flow-84 pattern): the convert surfaces need the fixture-B venue
  // knob + ICP funding, which must not touch a sibling flow's shared relay. The 6 primary surfaces
  // are deterministic on a private relay exactly as they are on the shared one (flow 84 baselines
  // the same six from a private relay for dark).
  const r2 = await startRelay();
  try {
    const { driver, webBaseURL } = env;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});

    // Arm the second venue BEFORE the wallet mounts (the convert surface loads /api/v1/venues on
    // mount) — the chooser baseline shows TWO rows.
    const arm = await fetch(`${r2.baseURL}/api/v1/test/venue`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({venue_id: FIXTURE_VENUE, served: true}),
    });
    assert(arm.ok, `venue knob armed (status ${arm.status})`);

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
    if (await driver.isPresent('hist-time-0')) {
      masks['hist-time-0'] = await getTestIDRectDevicePx(driver, 'hist-time-0');
    }
    await driver.screenshot(SURFACES[5].capture);

    // 6b. THE LEDGER ROW'S LAYOUT INVARIANT, asserted rather than assumed — and asserted HERE
    //     because it is what makes the baseline above trustworthy. A masked region hides what is
    //     inside it; it cannot hide what moves BESIDE it. Until 2026-09-08 the timestamp sat to the
    //     right of the amount, so the one character the wall clock gains every day when the hour
    //     crosses 1↔2 digits pushed the amount 7.2 px sideways — a measured 0.153%-per-row drift
    //     with no code change behind it, i.e. a baseline that could go red for a non-reason. The
    //     amount is now the last item on the row (`S.histAmt` carries the rule); this proves it, by
    //     widening the rendered timestamp by exactly that one character and re-measuring. It runs
    //     AFTER the capture and the mask rect, so it perturbs neither.
    if (await driver.isPresent('hist-amt-0')) {
      const rectOf = (testID) => driver.eval(
        (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x, w: r.width }; },
        `[data-testid="${testID}"]`,
      );
      const amt0 = await rectOf('hist-amt-0');
      const time0 = await rectOf('hist-time-0');
      // Widen by prepending a digit rather than by pattern-matching the hour.
      //
      // THE BUG THIS REPLACES, because it made the gate lie for most of every day: the probe used
      // to insert a digit with `/(\D)(\d:\d\d)/`, which by construction cannot match a timestamp
      // whose hour is ALREADY two digits — the character before the `\d:\d\d` is then a digit, not
      // a `\D`. So from 10:00 to 23:59 the replace was a no-op, the width did not change, and this
      // assertion failed on a tree where nothing was wrong. A gate that is red for 14 hours a day
      // is worse than no gate: it teaches everyone to ignore it.
      //
      // Prepending is format-agnostic — 24-hour, 12-hour, with or without a date prefix — and it
      // reproduces the thing under test exactly, which is one extra character of timestamp width,
      // not the specific hour that produced it.
      await driver.eval(
        (sel) => { const el = document.querySelector(sel); el.textContent = `8${el.textContent}`; },
        '[data-testid="hist-time-0"]',
      );
      const time1 = await rectOf('hist-time-0');
      const amt1 = await rectOf('hist-amt-0');
      assert(time1.w > time0.w, `the probe must actually widen the timestamp (was ${time0.w}, now ${time1.w})`);
      assert(
        amt1.x === amt0.x,
        `the amount moved ${(amt1.x - amt0.x).toFixed(2)} px when the hour gained a digit — a timestamp must never be able to push the amount (see S.histAmt)`,
      );
      console.log(`[40-visual-regression] ✓ ledger amount pinned at x=${amt0.x.toFixed(2)} across a ${(time1.w - time0.w).toFixed(1)}px timestamp change`);
    }

    // 6c. CONVERT surfaces (the light twins of flow 84's; dark had them alone until now). Fund
    //     ICP only NOW — after the ledger capture — so the faucet row cannot perturb the ledger
    //     baseline; then open Convert from the ICP row (the V11-gated entry), key 1 ICP, and wait
    //     for BOTH venue quotes to settle (a spinner mid-fetch is nondeterministic pixels).
    console.log('[40-visual-regression] convert surfaces (chooser + checklist)…');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED, {currency: 8});
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);

    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', {timeoutMs: 6_000});
    await driver.type('convert-amount', '1');
    await driver.findByTestID('convert-venue-icpswap-quote', {timeoutMs: 10_000});
    await driver.findByTestID(`convert-venue-${FIXTURE_VENUE}-quote`, {timeoutMs: 10_000});
    await driver.eval(() => window.scrollTo(0, 0));
    for (const tid of SURFACES[6].masksFromTestIDs) {
      masks[tid] = await getTestIDRectDevicePx(driver, tid);
    }
    await driver.screenshot(SURFACES[6].capture);

    // The checklist under a pick: click the REAL venue row, wait for the math to derive (the
    // minimum is the last MAIN-surface line) and the quote attribution to render, then
    // capture — anchored at the CHECKLIST card (scrollIntoView block:'start'), not the page
    // top: the compact decision surface (slippage → minimum → Details control) is under
    // contract and renders below the headline + venue rows. Everything above the anchor is
    // fully off-frame, so no clock text can leak in; the quote-source mask stays as a safety
    // net (it self-skips when off-frame). (10x-verbosity pass 2026-09-16: convert-net is gone
    // and the fee census folds behind the convert-details control — the main surface shrank.)
    await driver.click('convert-venue-icpswap', {timeoutMs: 5_000});
    await driver.findByTestID('convert-min-out', {timeoutMs: 10_000});
    await driver.findByTestID('convert-quote-source', {timeoutMs: 5_000});
    await driver.eval(() => {
      document.querySelector('[data-testid="convert-min-out"]').scrollIntoView({block: 'start'});
    });
    await driver.settleFrames(3);
    for (const tid of SURFACES[7].masksFromTestIDs) {
      masks[tid] = await getTestIDRectDevicePx(driver, tid);
    }
    await driver.screenshot(SURFACES[7].capture);

    // 7. Diff each capture against its baseline (or seed if missing + REGEN).
    await mkdir(BASELINES_DIR, { recursive: true });
    const summary = [];
    for (const s of SURFACES) {
      const capturePath = join(SHOTS_DIR, `${s.capture}.png`);
      const baselinePath = join(BASELINES_DIR, `${s.baseline}.png`);
      const surfaceMasks = (s.masksFromTestIDs ?? []).map(k => masks[k]).filter(Boolean);
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
    await r2.stop();
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
  //
  // KNOW ITS TRAP: a real UI change that lands UNDER tolerance is never re-seeded, so the baseline
  // keeps the old pixels and the surface sits at a permanent non-zero diff that eats the margin
  // meant for the NEXT change. Measured 2026-09-08: `wallet-pay` and `receive-request` had held
  // 0.465% of a 0.5% budget across every run since the header block moved 16 px right (the other
  // four baselines already carried the new position) — a gate with 7% of its margin left, for a
  // change everyone had already accepted. When a surface reads a stable non-zero diff, LOOK at the
  // diff png and then DELETE that baseline so REGEN seeds it fresh; do not leave it riding.
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
