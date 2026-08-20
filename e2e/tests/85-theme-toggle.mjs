// Flow 85 — Manual theme toggle (Wave 7): Light/Dark/Auto cycle, persistence, auto-follow.
//
// Proves the manual override on top of the Wave-4 auto theme:
//   1. The wallet-header compact toggle (btn-theme) cycles Auto → Light → Dark → Auto and the
//      rendered root background flips between the light (#F4F1E8) and dark (#141210) palette
//      values — the same computed-style probe flow 84 uses, so a broken applyPalette shows up
//      as a bg that never flips.
//   2. The choice PERSISTS: after a reload (fresh JS context, localStorage-backed AsyncStorage
//      rehydrating App.tsx's themeOverride) the dark palette is still applied pre-assertion.
//   3. 'Auto' returns to the EMULATED scheme: cycling back to Auto under an emulated-light OS
//      resolves light again (the override stops pinning the palette).
//   4. The Settings sheet toggle (btn-theme-mode) drives the SAME state (label + bg flip).
//
// Default setup runs under the browser's light scheme (only flow 84 opts into dark emulation),
// so the cycle's Auto steps resolve light here — the persistence + pinning semantics are the
// point; the dark-scheme rendering itself is flow 84's job.
import { setup, assert, assertEq, onboardWallet } from '../harness/lib.mjs';

export const meta = {
  id: '85',
  name: 'theme-toggle',
  journey: 'tour',
  covers: ['theme-toggle', 'dark-theme', 'persistence', 'settings'],
  verifies: 'Manual theme override: header + Settings toggles cycle Auto/Light/Dark, root bg flips, choice survives reload, Auto follows the OS scheme.',
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

    // Sanity: the browser session is emulated light, so Auto boots light.
    const emulatedDark = await driver.eval(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
    assert(!emulatedDark, 'flow 85 expects the default (light) emulated scheme — flow 84 covers dark');
    assertEq(await rootBg(), LIGHT_BG, 'auto + light scheme → light root bg');

    // 2. Header cycle: Auto → Light (bg already light; the LABEL is the observable) → Dark (bg flips).
    assertEq(await headerLabel(), 'Theme: Auto', 'header toggle starts at Auto');
    await driver.click('btn-theme');
    assertEq(await headerLabel(), 'Theme: Light', 'click 1 → Light');
    assertEq(await rootBg(), LIGHT_BG, 'light pin keeps the light bg');
    await driver.click('btn-theme');
    assertEq(await headerLabel(), 'Theme: Dark', 'click 2 → Dark');
    assertEq(await rootBg(), DARK_BG, 'dark pin flips the root bg');
    console.log('[85-theme-toggle] ✓ header cycle Auto→Light→Dark flips the rendered palette');

    // 3. Persistence: reload the page — a fresh JS context must rehydrate the Dark override from
    //    storage and apply it before these assertions run (domcontentloaded; polls stall networkidle0).
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(relayBaseURL)}`, {
      waitUntil: 'domcontentloaded',
      timeoutMs: 8_000,
    });
    await driver.waitReady({ timeoutMs: 10_000 });
    await driver.waitForText('∂100.00');
    assertEq(await rootBg(), DARK_BG, 'dark survives a reload (persisted override rehydrates)');
    assertEq(await headerLabel(), 'Theme: Dark', 'header still reports Dark after reload');
    console.log('[85-theme-toggle] ✓ Dark choice persisted across reload');

    // 4. Settings sheet drives the same state: Dark → Auto returns to the emulated (light) scheme.
    await driver.click('btn-settings');
    const settingsBtn = await driver.findByTestID('btn-theme-mode');
    const settingsLabel = await settingsBtn.evaluate((n) => n.getAttribute('aria-label') ?? '');
    assert(settingsLabel.startsWith('Theme: Dark'),
      `Settings theme entry should report Dark, got "${settingsLabel}"`);
    await driver.click('btn-theme-mode');
    assertEq(await rootBg(), LIGHT_BG, 'Settings cycle Dark→Auto follows the emulated light scheme');
    await driver.click('btn-settings-close');
    assertEq(await headerLabel(), 'Theme: Auto', 'header reflects the Auto override driven from Settings');
    console.log('[85-theme-toggle] ✓ Settings toggle cycles the same state; Auto follows the OS scheme');

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
