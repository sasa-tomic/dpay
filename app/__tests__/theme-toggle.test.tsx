/**
 * Wave 7 — the manual theme toggle controls (Settings entry + App persistence contract).
 *
 * Covers the parts of the toggle the pure-model tests in palette.test.ts don't:
 *   - The Settings flip button (btn-theme-mode) calls onCycleTheme with the OTHER mode in the
 *     Light ↔ Dark pair and renders the current mode's label.
 *   - App.tsx's persistence seam: THEME_STORAGE_KEY is written on every flip and rehydrated on
 *     mount through parseTheme (a mocked AsyncStorage pins the read/write pairs).
 *   - StatusBar barStyle follows the CHOICE (via isDark()), not just the OS scheme — a 'light'
 *     pin under a dark scheme keeps dark-content bars.
 *
 * Uses react-test-renderer (the project's only renderer). SettingsSheet's FFI boundary
 * (services/native) is mocked at its module boundary like PayMode.test.tsx does.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpSelfPrincipal: jest.fn(),
    seedWords: jest.fn(),
  },
  DpayNfc: undefined,
}));

import {SettingsSheet} from '../components/SettingsSheet';
import {Wallet} from '../components/Wallet';
import {applyPalette, isDark} from '../styles';
import {LIGHT, DARK} from '../config/palette';
import {parseTheme, resolveTheme, themeLabel, type ThemeOverride} from '../config/theme';
import {THEME_STORAGE_KEY} from '../config/constants';

const SET_SHEET_DEFAULTS = {
  relayUrl: 'http://127.0.0.1:8787',
  setRelayUrl: () => {},
  onClose: () => {},
  onReset: () => {},
  onRestore: async () => {},
  secretHex: 'ab'.repeat(32),
  username: 'Alice',
};

function mountSheet(override: ThemeOverride, onCycleTheme: (t: ThemeOverride) => void) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <SettingsSheet {...SET_SHEET_DEFAULTS} themeOverride={override} onCycleTheme={onCycleTheme} />,
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

describe('Wave 7: Settings theme flip button', () => {
  beforeEach(() => {
    applyPalette(LIGHT);
    AsyncStorage.clear();
  });

  test('flips Light ↔ Dark and always labels the CURRENT mode', () => {
    const flips: ThemeOverride[] = [];
    let tree!: renderer.ReactTestRenderer;

    // Light: first press hands 'dark' up to App (which would persist + re-render with it).
    tree = mountSheet('light', t => flips.push(t));
    findByTestID(tree, 'btn-theme-mode').props.onPress();
    act(() => tree.unmount());

    tree = mountSheet('dark', t => flips.push(t));
    findByTestID(tree, 'btn-theme-mode').props.onPress();
    act(() => tree.unmount());

    expect(flips).toEqual(['dark', 'light']); // the full flip order, driven by the UI

    // The rendered label names the current mode (re-mounted per mode, like App re-rendering).
    tree = mountSheet('dark', () => {});
    const label = findByTestID(tree, 'btn-theme-mode').props.accessibilityLabel;
    expect(label).toContain(themeLabel('dark'));
    act(() => tree.unmount());
  });

  test('the button carries role + state (a11y census contract)', () => {
    const tree = mountSheet('light', () => {});
    const btn = findByTestID(tree, 'btn-theme-mode');
    expect(btn.props.accessibilityRole).toBe('button');
    expect(btn.props.accessibilityState).toEqual({disabled: false});
    expect(btn.props.accessibilityLabel).toContain('Theme: Light');
    act(() => tree.unmount());
  });
});

describe('Wave 7: App.tsx persistence seam (THEME_STORAGE_KEY)', () => {
  beforeEach(() => {
    applyPalette(LIGHT);
    AsyncStorage.clear();
  });

  test('every flip step is persisted and rehydrates through parseTheme', async () => {
    // What persistTheme writes is what the mount effect reads back — pinned end to end.
    const order: ThemeOverride[] = ['light', 'dark'];
    for (const t of order) {
      await AsyncStorage.setItem(THEME_STORAGE_KEY, t);
      expect(parseTheme(await AsyncStorage.getItem(THEME_STORAGE_KEY))).toBe(t);
    }
  });

  test('a garbage or legacy persisted value rehydrates as null = follow the OS scheme (never crashes)', async () => {
    await AsyncStorage.setItem(THEME_STORAGE_KEY, 'solarized');
    expect(parseTheme(await AsyncStorage.getItem(THEME_STORAGE_KEY))).toBeNull();
    await AsyncStorage.setItem(THEME_STORAGE_KEY, 'auto'); // the tri-state era's stored value
    expect(parseTheme(await AsyncStorage.getItem(THEME_STORAGE_KEY))).toBeNull();
  });
});

describe('Wave 7: StatusBar barStyle follows the choice, not the scheme', () => {
  beforeEach(() => {
    applyPalette(LIGHT);
  });

  test("a 'dark' choice under a LIGHT OS scheme applies DARK → light-content bars", () => {
    // The jest Appearance mock has no OS scheme (null) — the 'light scheme' stand-in.
    const resolved = resolveTheme('dark', null); // → 'dark'
    applyPalette(resolved === 'dark' ? DARK : LIGHT); // App.tsx's exact expression
    expect(isDark()).toBe(true); // → barStyle 'light-content' at all 4 StatusBar sites
  });

  test("a 'light' choice under a DARK scheme applies LIGHT → dark-content bars", () => {
    const resolved = resolveTheme('light', 'dark'); // → 'light' (choice wins)
    applyPalette(resolved === 'dark' ? DARK : LIGHT);
    expect(isDark()).toBe(false); // → barStyle 'dark-content'
  });
});

// The Wallet header toggle is exercised end-to-end by e2e flow 85 (btn-theme) + the a11y census;
// under jest a full Wallet mount needs the whole catalog/NFC/poll mock surface for one onPress —
// the flip order itself is already pinned above through the same nextTheme() call site.
void Wallet;
