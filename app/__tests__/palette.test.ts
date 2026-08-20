/**
 * Wave-4 dual theme — the palette-application machinery.
 *
 * The theme model: `C` (config/palette) and `S` (styles) are MUTABLE singletons initialized
 * from LIGHT; `applyPalette(p)` Object.assigns both IN PLACE (never reassigns the export
 * bindings) so every `C.x`/`S.x` read site observes the swap after the app re-renders. These
 * tests pin that contract: identity stability of the holders, key swaps, the camBox
 * theme-invariance (campreview gate), and idempotent restore.
 */
import {describe, test, expect, afterEach} from '@jest/globals';
import {C, DARK, LIGHT} from '../config/palette';
import {S, applyPalette, isDark} from '../styles';
import {nextTheme, resolveTheme, parseTheme, themeLabel} from '../config/theme';

describe('dual theme: applyPalette', () => {
  afterEach(() => {
    applyPalette(LIGHT);
  });

  test('jest boots LIGHT (no OS scheme under the mocked Appearance)', () => {
    // The RN jest preset has no real Appearance — the module-load probe must fall back to
    // light, and the very first assertions on the untouched module prove it.
    expect(isDark()).toBe(false);
    expect(C.bg).toBe(LIGHT.bg);
    expect(S.root.backgroundColor).toBe(LIGHT.bg);
  });

  test('applyPalette(DARK) swaps S keys AND the palette C in place', () => {
    applyPalette(DARK);
    expect(isDark()).toBe(true);
    expect(S.root.backgroundColor).toBe(DARK.bg); // #141210 warm near-black
    expect(S.sheet.backgroundColor).toBe(DARK.bg);
    expect(S.wordmark.color).toBe(DARK.ink);
    expect(C.ink).toBe(DARK.ink);
    expect(C.bg).toBe(DARK.bg);
  });

  test('the S and C holder identities are STABLE; keys are swapped in place', () => {
    const sBefore = S;
    const cBefore = C;
    applyPalette(DARK);
    expect(S).toBe(sBefore);
    expect(C).toBe(cBefore);
    // Key replacement semantics: applyPalette swaps S's KEYS (S.root becomes a new object), so
    // every render-time read (style={S.root} — the ONLY usage pattern in the app tree; verified:
    // no component captures an S.x reference outside render) sees the new theme…
    expect(S.root.backgroundColor).toBe(DARK.bg);
    // …while a stale captured reference keeps its old bytes (harmless — none exist in the app).
    const stale = S.root;
    applyPalette(LIGHT);
    expect(S.root.backgroundColor).toBe(LIGHT.bg);
    expect(S.root).not.toBe(stale);
  });

  test('applyPalette is idempotent per palette and restores LIGHT cleanly', () => {
    applyPalette(DARK);
    applyPalette(DARK); // no-op
    expect(isDark()).toBe(true);
    applyPalette(LIGHT);
    expect(isDark()).toBe(false);
    expect(S.tab.backgroundColor).toBe(LIGHT.card);
    expect(C.warn).toBe(LIGHT.warn);
  });

  test('camBox fill is theme-invariant (campreview pixel gate)', () => {
    const light = S.camBox.backgroundColor;
    applyPalette(DARK);
    expect(S.camBox.backgroundColor).toBe(light);
    expect(S.camBox.backgroundColor).toBe('#17150F');
  });

  test('dark status-wash literals swap via the rgb stems (bad/warn tints)', () => {
    const lightPill = S.qrOfflinePill.backgroundColor;
    applyPalette(DARK);
    expect(S.qrOfflinePill.backgroundColor).not.toBe(lightPill);
    expect(S.qrOfflinePill.backgroundColor).toContain(DARK.badRGB);
    expect(S.assetBadge.backgroundColor).not.toContain('180,83,9'); // light warn stem gone
    expect(S.assetBadge.backgroundColor).toContain(DARK.warnRGB);
  });

  test('checkAlready uses the deep warn FILL in dark (white glyph on top)', () => {
    applyPalette(DARK);
    expect(S.checkAlready.backgroundColor).toBe('#B45309');
    applyPalette(LIGHT);
    expect(S.checkAlready.backgroundColor).toBe(LIGHT.warn);
  });

  test('glyphFor follows the applied theme', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {glyphFor} = require('../components/AssetGlyph');
    // Fixture mirrors config/assets.ts DEMO shape (see __tests__/icons.test.tsx).
    const demo = {
      id: 'ic:0', protocol: 'ic', currency: 0, symbol: 'DEMO', networkLabel: 'Internet Computer',
      decimals: 2, visible: true, capabilities: {onramp: 'Direct', offramp: 'Unavailable'}, testKey: 'demo',
    } as const;
    applyPalette(LIGHT);
    expect(glyphFor(demo)).toEqual({glyph: '∂', color: '#D8450D', bg: 'rgba(255,90,31,0.10)'});
    applyPalette(DARK);
    const g = glyphFor(demo);
    expect(g.color).toBe('#FF7A45');
    expect(g.bg).toBe('rgba(255,122,69,0.14)');
  });
});

describe('Wave 7: manual theme override model (config/theme.ts)', () => {
  afterEach(() => {
    applyPalette(LIGHT);
  });

  test('cycle order is Auto → Light → Dark → Auto', () => {
    expect(nextTheme('auto')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('auto');
  });

  test('resolveTheme: auto follows the OS scheme; light/dark pin regardless of scheme', () => {
    // auto delegates to the scheme (scheme null — mocked Appearance — resolves light, like App boot).
    expect(resolveTheme('auto', 'dark')).toBe('dark');
    expect(resolveTheme('auto', 'light')).toBe('light');
    expect(resolveTheme('auto', null)).toBe('light');
    // The override WINS over any scheme — the whole point of the manual toggle.
    expect(resolveTheme('dark', 'light')).toBe('dark');
    expect(resolveTheme('light', 'dark')).toBe('light');
  });

  test('parseTheme coerces unknown/garbage stored values to auto', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('auto')).toBe('auto');
    expect(parseTheme(null)).toBe('auto');
    expect(parseTheme(undefined)).toBe('auto');
    expect(parseTheme('')).toBe('auto');
    expect(parseTheme('blue')).toBe('auto'); // legacy/garbage keys never crash the app
  });

  test('themeLabel renders the Settings/a11y display name', () => {
    expect(themeLabel('auto')).toBe('Auto');
    expect(themeLabel('light')).toBe('Light');
    expect(themeLabel('dark')).toBe('Dark');
  });

  test('the override drives the applied palette (App.tsx contract: resolveTheme → applyPalette)', () => {
    // Light override under a DARK scheme must still apply LIGHT — the pin beats the OS.
    let resolved: 'light' | 'dark' = resolveTheme('light', 'dark');
    applyPalette(resolved === 'dark' ? DARK : LIGHT);
    expect(isDark()).toBe(false);
    expect(S.root.backgroundColor).toBe(LIGHT.bg);
    // Dark override under a LIGHT/null scheme must apply DARK.
    resolved = resolveTheme('dark', undefined);
    applyPalette(resolved === 'dark' ? DARK : LIGHT);
    expect(isDark()).toBe(true);
    expect(S.root.backgroundColor).toBe(DARK.bg);
    // The StatusBar barStyle sites read isDark() — the override (not the scheme) must drive it:
    // a 'light' override keeps dark-content bars even when the OS is dark, and vice versa.
    expect(isDark()).toBe(resolveTheme('dark', 'light') === 'dark');
  });

  test('persistence key round-trips through parseTheme (dpay.theme.v1 contract)', () => {
    // What App.tsx writes is what parseTheme reads back — the storage contract.
    for (const t of ['auto', 'light', 'dark'] as const) {
      expect(parseTheme(t)).toBe(t);
    }
  });
});
