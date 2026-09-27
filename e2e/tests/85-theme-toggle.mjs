// Flow 85 — Two-tier theme controls (Wave 8): header flip + Settings 3-way segmented control.
//
// Proves:
//   1. With no stored choice the theme SEEDS from the OS scheme — under the default emulated-light
//      browser the app boots Light and the header toggle names the TARGET ('Switch theme to Dark',
//      the moon glyph — Wave-8 target-state semantics, not current-state).
//   2. The wallet-header toggle (btn-theme, grouped beside the settings gear) flips Light ↔ Dark
//      with a single click and the rendered root background flips between the light (#EBF0ED) and
//      dark (#0C1312) palette values — the same computed-style probe flow 84 uses, so a broken
//      applyPalette shows up as a bg that never flips.
//   3. The choice PERSISTS: after a reload (fresh JS context, localStorage-backed AsyncStorage
//      rehydrating App.tsx's themeChoice) the dark palette is still applied pre-assertion.
//   4. The Settings sheet's three-way segmented control (btn-theme-light/dark/auto radio segments)
//      drives the SAME state: picking Light flips the bg, and picking AUTO returns control to the
//      OS scheme (null choice) — the explicit way back to follow-the-system.
//
// Default setup runs under the browser's light scheme (only flow 84 opts into dark emulation),
// so the seeded/Auto state resolves light here — the persistence + pinning semantics are the
// point; the dark-scheme rendering itself is flow 84's job.
import { setup, assert, assertEq, onboardWallet } from '../harness/lib.mjs';

export const meta = {
  id: '85',
  name: 'theme-toggle',
  journey: 'tour',
  covers: ['theme-toggle', 'dark-theme', 'persistence', 'settings', 'auto-theme'],
  verifies: 'Two-tier theme: header flip toggles Light↔Dark on a single click (target-state label), root bg flips, choice survives reload; Settings 3-way control (Light/Dark/Auto) drives the same state and Auto returns to the OS scheme.',
  timeoutMs: 90000,
};

const LIGHT_BG = 'rgb(235, 240, 237)'; // palette LIGHT bg #EBF0ED
const DARK_BG = 'rgb(12, 19, 18)';     // palette DARK bg  #0C1312

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
    // RNW (this version) does not project accessibilityState → aria-checked, so the active
    // segment is probed by its computed background: railPillActive paints the palette `card`
    // (#FFFFFF light / #1F2A26 dark) inside the panel2 well.
    const segBg = (id) =>
      driver.eval((tid) => getComputedStyle(document.querySelector(`[data-testid="${tid}"]`)).backgroundColor, id);
    const ACTIVE_LIGHT_CARD = 'rgb(255, 255, 255)';

    // 1. Onboard to reach the Wallet (the header toggle only exists there).
    console.log('[85-theme-toggle] onboarding…');
    await onboardWallet(driver, 'e2e-theme');
    // (The old bare ∂100.00 wait never resolved on Pay post-currency-first; the shared preamble
    // asserts funding on the DEMO row now.)

    // Sanity: the browser session is emulated light, so the seeded theme boots Light.
    const emulatedDark = await driver.eval(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
    assert(!emulatedDark, 'flow 85 expects the default (light) emulated scheme — flow 84 covers dark');
    assertEq(await rootBg(), LIGHT_BG, 'no stored choice + light scheme → seeded light root bg');
    assertEq(await headerLabel(), 'Switch theme to Dark', 'header names the TARGET (Dark), not the current mode');

    // 2. Header flip: Light → Dark (bg flips) → Light (bg flips back).
    await driver.click('btn-theme');
    assertEq(await headerLabel(), 'Switch theme to Light', 'click 1 → Dark (label now targets Light)');
    assertEq(await rootBg(), DARK_BG, 'dark flips the root bg');
    await driver.click('btn-theme');
    assertEq(await headerLabel(), 'Switch theme to Dark', 'click 2 → back to Light');
    assertEq(await rootBg(), LIGHT_BG, 'light flips the root bg back');
    console.log('[85-theme-toggle] ✓ header flips Light↔Dark on a single click');

    // 3. Persistence: pin Dark, reload the page — a fresh JS context must rehydrate the Dark
    //    choice from storage and apply it before these assertions run (domcontentloaded;
    //    polls stall networkidle0).
    await driver.click('btn-theme');
    assertEq(await headerLabel(), 'Switch theme to Light', 're-pin Dark for the reload leg');
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(relayBaseURL)}`, {
      waitUntil: 'domcontentloaded',
      timeoutMs: 8_000,
    });
    await driver.waitReady({ timeoutMs: 10_000 });
    // The honest "app rehydrated" anchor: the wallet shell itself (the old bare ∂100.00 wait never
    // resolved on Pay post-currency-first and only burned its full timeout).
    await driver.findByTestID('tab-home', { timeoutMs: 10_000 });
    assertEq(await rootBg(), DARK_BG, 'dark survives a reload (persisted choice rehydrates)');
    assertEq(await headerLabel(), 'Switch theme to Light', 'header still targets Light after reload');
    console.log('[85-theme-toggle] ✓ Dark choice persisted across reload');

    // 4. Settings sheet drives the same state: Dark → Light via the segmented control, then
    //    Auto returns the choice to null (follow the OS scheme → light under this session).
    await driver.click('btn-settings');
    const lightSeg = await driver.findByTestID('btn-theme-light');
    const lightLabel = await lightSeg.evaluate((n) => n.getAttribute('aria-label') ?? '');
    assertEq(lightLabel, 'Theme: Light', 'Light segment carries its label');
    await driver.click('btn-theme-light');
    assertEq(await rootBg(), LIGHT_BG, 'Settings Light segment flips Dark→Light');
    await driver.click('btn-theme-auto');
    assertEq(await rootBg(), LIGHT_BG, 'Auto returns to the OS scheme (light here)');
    assertEq(await segBg('btn-theme-auto'), ACTIVE_LIGHT_CARD, 'Auto is the active segment after picking it');
    await driver.click('btn-settings-close');
    assertEq(await headerLabel(), 'Switch theme to Dark', 'header reflects Auto→light resolved state');
    console.log('[85-theme-toggle] ✓ Settings 3-way control drives the same state; Auto follows the OS');

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
