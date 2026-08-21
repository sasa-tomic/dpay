// Flow 85 — Manual theme toggle (Wave 7, two-state): Light/Dark flip, persistence, OS seeding.
//
// Proves the two-state manual toggle (2026-08-21: the tri-state Auto cycle retired):
//   1. With no stored choice the theme SEEDS from the OS scheme — under the default emulated-light
//      browser the app boots Light and the header reports 'Theme: Light' (not 'Auto').
//   2. The wallet-header toggle (btn-theme) flips Light ↔ Dark with a single click and the
//      rendered root background flips between the light (#F4F1E8) and dark (#141210) palette
//      values — the same computed-style probe flow 84 uses, so a broken applyPalette shows up
//      as a bg that never flips.
//   3. The choice PERSISTS: after a reload (fresh JS context, localStorage-backed AsyncStorage
//      rehydrating App.tsx's themeChoice) the dark palette is still applied pre-assertion.
//   4. The Settings sheet toggle (btn-theme-mode) drives the SAME state (label + bg flip).
//
// Default setup runs under the browser's light scheme (only flow 84 opts into dark emulation),
// so the seeded state resolves light here — the persistence + pinning semantics are the point;
// the dark-scheme rendering itself is flow 84's job.
import { setup, assert, assertEq, onboardWallet } from '../harness/lib.mjs';

export const meta = {
  id: '85',
  name: 'theme-toggle',
  journey: 'tour',
  covers: ['theme-toggle', 'dark-theme', 'persistence', 'settings'],
  verifies: 'Two-state theme toggle: seeds from the OS scheme, header + Settings flip Light↔Dark on a single click, root bg flips, choice survives reload.',
  timeoutMs: 25_000,
};

const LIGHT_BG = 'rgb(244, 241, 232)'; // palette LIGHT bg #F4F1E8
const DARK_BG = 'rgb(20, 18, 16)';     // palette DARK bg  #141210

export async function run() {
  const start = Date.now();
  console.log('[85-theme-toggle] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, webBaseURL, relayBaseURL } = env;

    const rootBg = () =>
      driver.eval(() => getComputedStyle(document.querySelector('#root > div')).backgroundColor);
    const headerLabel = () =>
      driver.eval(() => document.querySelector('[data-testid="btn-theme"]')?.getAttribute('aria-label') ?? '');

    // 1. Onboard to reach the Wallet (the header toggle only exists there).
    console.log('[85-theme-toggle] onboarding…');
    await onboardWallet(driver, 'e2e-theme');
    await driver.waitForText('∂100.00');

    // Sanity: the browser session is emulated light, so the seeded theme boots Light.
    const emulatedDark = await driver.eval(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
    assert(!emulatedDark, 'flow 85 expects the default (light) emulated scheme — flow 84 covers dark');
    assertEq(await rootBg(), LIGHT_BG, 'no stored choice + light scheme → seeded light root bg');
    assertEq(await headerLabel(), 'Theme: Light', 'header reports the seeded Light (no Auto state)');

    // 2. Header flip: Light → Dark (bg flips) → Light (bg flips back).
    await driver.click('btn-theme');
    assertEq(await headerLabel(), 'Theme: Dark', 'click 1 → Dark');
    assertEq(await rootBg(), DARK_BG, 'dark flips the root bg');
    await driver.click('btn-theme');
    assertEq(await headerLabel(), 'Theme: Light', 'click 2 → back to Light');
    assertEq(await rootBg(), LIGHT_BG, 'light flips the root bg back');
    console.log('[85-theme-toggle] ✓ header flips Light↔Dark on a single click');

    // 3. Persistence: pin Dark, reload the page — a fresh JS context must rehydrate the Dark
    //    choice from storage and apply it before these assertions run (domcontentloaded;
    //    polls stall networkidle0).
    await driver.click('btn-theme');
    assertEq(await headerLabel(), 'Theme: Dark', 're-pin Dark for the reload leg');
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(relayBaseURL)}`, {
      waitUntil: 'domcontentloaded',
      timeoutMs: 8_000,
    });
    await driver.waitReady({ timeoutMs: 10_000 });
    await driver.waitForText('∂100.00');
    assertEq(await rootBg(), DARK_BG, 'dark survives a reload (persisted choice rehydrates)');
    assertEq(await headerLabel(), 'Theme: Dark', 'header still reports Dark after reload');
    console.log('[85-theme-toggle] ✓ Dark choice persisted across reload');

    // 4. Settings sheet drives the same state: Dark → Light via the sheet's toggle.
    await driver.click('btn-settings');
    const settingsBtn = await driver.findByTestID('btn-theme-mode');
    const settingsLabel = await settingsBtn.evaluate((n) => n.getAttribute('aria-label') ?? '');
    assert(settingsLabel.startsWith('Theme: Dark'),
      `Settings theme entry should report Dark, got "${settingsLabel}"`);
    await driver.click('btn-theme-mode');
    assertEq(await rootBg(), LIGHT_BG, 'Settings flip Dark→Light under the emulated light scheme');
    await driver.click('btn-settings-close');
    assertEq(await headerLabel(), 'Theme: Light', 'header reflects the Light choice driven from Settings');
    console.log('[85-theme-toggle] ✓ Settings toggle flips the same state');

    await driver.screenshot('85-theme-toggle');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[85-theme-toggle] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

// Allow `node tests/85-theme-toggle.mjs` to run standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[85-theme-toggle] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
