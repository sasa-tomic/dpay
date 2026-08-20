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
