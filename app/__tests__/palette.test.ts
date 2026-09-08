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
import {C, DARK, LIGHT, withAlpha} from '../config/palette';
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

  test('a status wash is DERIVED from the token it tints, in both themes', () => {
    // v5 deleted the `badRGB`/`warnRGB` stems: a wash is now `withAlpha(token, p.wash)`, so it
    // cannot survive a change to the token it is a tint of. That is the whole point of the
    // helper, and this is what proves the derivation is live rather than a copied literal.
    expect(S.qrOfflinePill.backgroundColor).toBe(withAlpha(LIGHT.bad, LIGHT.wash));
    expect(S.assetBadge.backgroundColor).toBe(withAlpha(LIGHT.warn, LIGHT.wash));
    applyPalette(DARK);
    expect(S.qrOfflinePill.backgroundColor).toBe(withAlpha(DARK.bad, DARK.wash));
    expect(S.assetBadge.backgroundColor).toBe(withAlpha(DARK.warn, DARK.wash));
  });

  test('checkAlready is the theme\'s own warn FILL — `warnDeep` is gone', () => {
    // v4 carried a second warn token whose only job was "dark enough for a white glyph". v5's
    // fills take `brandInk`, which flips with the theme, so one warn serves both jobs and the
    // duplicate is deleted rather than kept in sync.
    applyPalette(DARK);
    expect(S.checkAlready.backgroundColor).toBe(DARK.warn);
    applyPalette(LIGHT);
    expect(S.checkAlready.backgroundColor).toBe(LIGHT.warn);
  });

  test('glyphFor follows the applied theme', () => {
    const {glyphFor} = require('../components/AssetGlyph');
    // Fixture mirrors config/assets.ts DEMO shape (see __tests__/icons.test.tsx).
    const demo = {
      id: 'ic:0', protocol: 'ic', currency: 0, symbol: 'DEMO', networkLabel: 'Internet Computer',
      // `linkToken` is required on every SelectableAsset and `glyphFor` now reads it (via
      // currencyOfAsset) to decide whether the asset wears a home-currency mark. Omitting it made
      // this fixture a shape production cannot produce, and `tokenEq` refuses such a row loudly
      // rather than absorbing it (config/assets.ts) — so the omission threw here.
      linkToken: 'DEMO', network: null, minFractionDigits: 0,
      decimals: 2, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, visible: true, testKey: 'demo',
    } as const;
    // The ∂ chip IS the brand, read live — v5 deleted its private copy of the tangerine, so this
    // asserts the derivation rather than a pair of hexes that would need editing next time.
    applyPalette(LIGHT);
    expect(glyphFor(demo)).toEqual({glyph: '∂', color: LIGHT.brandText, bg: withAlpha(LIGHT.brandText, LIGHT.wash)});
    applyPalette(DARK);
    expect(glyphFor(demo)).toEqual({glyph: '∂', color: DARK.brandText, bg: withAlpha(DARK.brandText, DARK.wash)});
  });
});

describe('Wave 7: manual theme model (config/theme.ts, two-state Light/Dark)', () => {
  afterEach(() => {
    applyPalette(LIGHT);
  });

  test('toggle order is Light ↔ Dark', () => {
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('light');
  });

  test('resolveTheme: no stored choice follows the OS scheme; light/dark pin regardless of scheme', () => {
    // null choice delegates to the scheme (scheme null — mocked Appearance — resolves light, like App boot).
    expect(resolveTheme(null, 'dark')).toBe('dark');
    expect(resolveTheme(null, 'light')).toBe('light');
    expect(resolveTheme(null, null)).toBe('light');
    // The stored choice WINS over any scheme — the whole point of the manual toggle.
    expect(resolveTheme('dark', 'light')).toBe('dark');
    expect(resolveTheme('light', 'dark')).toBe('light');
  });

  test('parseTheme coerces unknown/garbage stored values (incl. legacy tri-state "auto") to null', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('auto')).toBeNull(); // legacy tri-state value → follow the OS scheme again
    expect(parseTheme(null)).toBeNull();
    expect(parseTheme(undefined)).toBeNull();
    expect(parseTheme('')).toBeNull();
    expect(parseTheme('blue')).toBeNull(); // legacy/garbage keys never crash the app
  });

  test('themeLabel renders the Settings/a11y display name', () => {
    expect(themeLabel('light')).toBe('Light');
    expect(themeLabel('dark')).toBe('Dark');
  });

  test('the choice drives the applied palette (App.tsx contract: resolveTheme → applyPalette)', () => {
    // Light choice under a DARK scheme must still apply LIGHT — the pin beats the OS.
    let resolved: 'light' | 'dark' = resolveTheme('light', 'dark');
    applyPalette(resolved === 'dark' ? DARK : LIGHT);
    expect(isDark()).toBe(false);
    expect(S.root.backgroundColor).toBe(LIGHT.bg);
    // Dark choice under a LIGHT/null scheme must apply DARK.
    resolved = resolveTheme('dark', undefined);
    applyPalette(resolved === 'dark' ? DARK : LIGHT);
    expect(isDark()).toBe(true);
    expect(S.root.backgroundColor).toBe(DARK.bg);
    // The StatusBar barStyle sites read isDark() — the choice (not the scheme) must drive it:
    // a 'light' choice keeps dark-content bars even when the OS is dark, and vice versa.
    expect(isDark()).toBe(resolveTheme('dark', 'light') === 'dark');
  });

  test('persistence key round-trips through parseTheme (dpay.theme.v1 contract)', () => {
    // What App.tsx writes is what parseTheme reads back — the storage contract.
    for (const t of ['light', 'dark'] as const) {
      expect(parseTheme(t)).toBe(t);
    }
  });
});
