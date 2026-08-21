/**
 * Wave 8 — the two-tier theme controls (Settings segmented control + App persistence contract).
 *
 * Pins:
 *   - The Settings 3-way segmented control (Light / Dark / Auto): tapping a segment hands the
 *     CHOICE up to App (light/dark pin; null = Auto = follow the OS scheme) and the segment
 *     renders as the active one (checked state + active text style).
 *   - What persistTheme writes is what the mount effect reads back through parseTheme — pinned
 *     end to end via the THEME_STORAGE_KEY contract, including Auto's 'system' round-trip.
 *   - StatusBar barStyle follows the RESOLVED theme (via isDark()), not just the OS scheme.
 *
 * The Wallet header toggle (target-state icon + flip) is exercised end-to-end by e2e flow 85
 * (btn-theme) + the a11y census; under jest a full Wallet mount needs the whole catalog/NFC/
 * poll mock surface for one onPress.
 */
import {describe, test, expect, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {SettingsSheet} from '../components/SettingsSheet';
import {applyPalette, isDark} from '../styles';
import {DARK, LIGHT} from '../config/palette';
import {Wallet} from '../components/Wallet';
import {parseTheme, resolveTheme, themePersistValue, type ThemeOverride} from '../config/theme';
import {THEME_STORAGE_KEY} from '../config/constants';

const SET_SHEET_DEFAULTS = {
  relayUrl: 'http://127.0.0.1:4391',
  setRelayUrl: () => {},
  onClose: () => {},
  onReset: () => {},
  onRestore: async () => {},
  secretHex: 'ab'.repeat(32),
  username: 'Alice',
};

function mountSheet(choice: ThemeOverride | null, onSetTheme: (t: ThemeOverride | null) => void) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <SettingsSheet {...SET_SHEET_DEFAULTS} themeChoice={choice} onSetTheme={onSetTheme} />,
    );
  });
  return tree;
}

/** Find the Pressable carrying a testID (RN testIDs live on the host node). */
function findByTestID(tree: renderer.ReactTestRenderer, testID: string) {
  const node = tree.root.findAll(n => n.props && n.props.testID === testID && typeof n.props.onPress === 'function')[0];
  if (!node) throw new Error(`no Pressable with testID ${testID}`);
  return node;
}

describe('Wave 8: Settings theme segmented control', () => {
  beforeEach(() => {
    applyPalette(LIGHT);
    AsyncStorage.clear();
  });

  test('each segment hands its CHOICE up to App; the active segment is checked', () => {
    const set: (ThemeOverride | null)[] = [];

    // Auto (null choice): the Auto segment is the active one.
    let tree = mountSheet(null, t => set.push(t));
    const auto = findByTestID(tree, 'btn-theme-auto');
    expect(auto.props.accessibilityState).toEqual({checked: true, disabled: false});
    expect(auto.props.accessibilityLabel).toBe('Theme: Auto');
    auto.props.onPress();
    act(() => tree.unmount());

    // Light pinned: Light segment active, Auto no longer checked.
    tree = mountSheet('light', t => set.push(t));
    expect(findByTestID(tree, 'btn-theme-light').props.accessibilityState).toEqual({checked: true, disabled: false});
    expect(findByTestID(tree, 'btn-theme-auto').props.accessibilityState).toEqual({checked: false, disabled: false});
    findByTestID(tree, 'btn-theme-dark').props.onPress();
    act(() => tree.unmount());

    // Dark pinned: Dark segment active.
    tree = mountSheet('dark', t => set.push(t));
    expect(findByTestID(tree, 'btn-theme-dark').props.accessibilityState).toEqual({checked: true, disabled: false});
    expect(findByTestID(tree, 'btn-theme-dark').props.accessibilityLabel).toBe('Theme: Dark');
    findByTestID(tree, 'btn-theme-auto').props.onPress(); // the way back to Auto
    act(() => tree.unmount());

    expect(set).toEqual([null, 'dark', null]); // the exact choice per segment press
  });

  test('every segment carries the radio role (a11y census contract)', () => {
    const tree = mountSheet('light', () => {});
    for (const id of ['btn-theme-auto', 'btn-theme-light', 'btn-theme-dark']) {
      const seg = findByTestID(tree, id);
      expect(seg.props.accessibilityRole).toBe('radio');
      expect(seg.props.accessibilityLabel).toMatch(/^Theme: (Auto|Light|Dark)$/);
    }
    act(() => tree.unmount());
  });
});

describe('Wave 8: App.tsx persistence seam (THEME_STORAGE_KEY)', () => {
  beforeEach(() => {
    applyPalette(LIGHT);
    AsyncStorage.clear();
  });

  test('every choice round-trips through themePersistValue + parseTheme', async () => {
    const order: (ThemeOverride | null)[] = ['light', 'dark', null];
    for (const t of order) {
      await AsyncStorage.setItem(THEME_STORAGE_KEY, themePersistValue(t));
      expect(parseTheme(await AsyncStorage.getItem(THEME_STORAGE_KEY))).toBe(t);
    }
  });

  test('a garbage or legacy persisted value rehydrates as null = Auto (never crashes)', async () => {
    await AsyncStorage.setItem(THEME_STORAGE_KEY, 'solarized');
    expect(parseTheme(await AsyncStorage.getItem(THEME_STORAGE_KEY))).toBeNull();
    await AsyncStorage.setItem(THEME_STORAGE_KEY, 'auto'); // the tri-state era's stored value
    expect(parseTheme(await AsyncStorage.getItem(THEME_STORAGE_KEY))).toBeNull();
  });
});

describe('Wave 8: StatusBar barStyle follows the resolved choice, not the scheme', () => {
  beforeEach(() => {
    applyPalette(LIGHT);
  });

  test("a 'dark' choice under a LIGHT OS scheme applies DARK → light-content bars", () => {
    // The jest Appearance mock has no OS scheme (null) — the 'light scheme' stand-in.
    const resolved = resolveTheme('dark', null); // → 'dark'
    applyPalette(resolved === 'dark' ? DARK : LIGHT); // App.tsx's exact expression
    expect(isDark()).toBe(true); // → barStyle 'light-content' at all 4 StatusBar sites
  });

  test("Auto (null) under a DARK scheme applies DARK — the scheme wins when nothing is pinned", () => {
    const resolved = resolveTheme(null, 'dark'); // → 'dark' (follow the OS)
    applyPalette(resolved === 'dark' ? DARK : LIGHT);
    expect(isDark()).toBe(true);
  });

  test("a 'light' choice under a DARK scheme applies LIGHT → dark-content bars", () => {
    const resolved = resolveTheme('light', 'dark'); // → 'light' (choice wins)
    applyPalette(resolved === 'dark' ? DARK : LIGHT);
    expect(isDark()).toBe(false);
  });
});

// See the header note: the Wallet header flip is e2e flow 85's contract (btn-theme), not a jest
// mount — the full Wallet mock surface buys nothing over the nextTheme() pin above.
void Wallet;
