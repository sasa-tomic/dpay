/**
 * The Settings language control + the App persistence contract, mirroring the theme controls it
 * sits directly under.
 *
 * Pins:
 *   - The segmented control offers Auto plus every shipped locale, each named in its OWN language.
 *   - Tapping a segment hands the CHOICE up to App (a tag pins it; null = Auto = follow the device)
 *     and that segment renders as the active one.
 *   - What persistLocale writes is what the mount effect reads back through parseLocale — pinned
 *     end to end via the LOCALE_STORAGE_KEY contract, including Auto's 'system' round-trip.
 *   - The sheet re-reads the live catalog, so a switch is visible without remounting a provider.
 *
 * Catalog completeness and the resolver's own truth table live in i18n-catalogs.test.ts and
 * locale.test.ts; this file is only about the control and the wiring around it.
 */
import {describe, test, expect, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {SettingsSheet} from '../components/SettingsSheet';
import {M, applyLocale} from '../i18n';
import {de} from '../i18n/de.ts';
import {LOCALES, LOCALE_ENDONYM, localePersistValue, parseLocale, type LocaleChoice} from '../i18n/locale';
import {LOCALE_STORAGE_KEY} from '../config/constants';

const SHEET_DEFAULTS = {
  setSolanaRpc: () => {},
  onSolanaRpcApplied: () => {},
  relayUrls: ['http://127.0.0.1:4391'],
  setRelayUrls: () => {},
  onClose: () => {},
  onReset: () => {},
  onRestore: async () => {},
  secretHex: 'ab'.repeat(32),
  username: 'Alice',
  themeChoice: null,
  onSetTheme: () => {},
  homeCurrency: 'CHF' as const,
  onSetHomeCurrency: () => {},
  assets: [],
};

// Async: the sheet subscribes to the journey store on mount, and that load resolves a tick later.
// Settling it INSIDE act keeps the state update from landing after the test has torn down.
async function mountSheet(choice: LocaleChoice, onSetLocale: (l: LocaleChoice) => void) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <SettingsSheet {...SHEET_DEFAULTS} localeChoice={choice} onSetLocale={onSetLocale} />,
    );
  });
  return tree;
}

const pill = (tree: renderer.ReactTestRenderer, id: string) =>
  tree.root.findAll(n => n.props.testID === id)[0];

beforeEach(() => AsyncStorage.clear());
afterEach(() => { applyLocale('en', 'en-US'); });

describe('the Settings language control', () => {
  test('offers Auto plus every shipped locale', async () => {
    const tree = await mountSheet(null, () => {});
    expect(pill(tree, 'btn-lang-auto')).toBeTruthy();
    for (const tag of LOCALES) expect(pill(tree, `btn-lang-${tag}`)).toBeTruthy();
    tree.unmount();
  });

  test('names every language in ITSELF, so a lost user can find their way back', async () => {
    // "Deutsch" stays "Deutsch" on an English phone. Translating the option list is what strands
    // someone who cannot read the language the app is currently in.
    const tree = await mountSheet(null, () => {});
    const labels = LOCALES.map(tag => {
      const texts: string[] = [];
      pill(tree, `btn-lang-${tag}`).findAllByType('Text' as never)
        .forEach(n => texts.push(String(n.props.children)));
      return texts.join('');
    });
    expect(labels).toEqual(LOCALES.map(tag => LOCALE_ENDONYM[tag]));
    tree.unmount();
  });

  test('hands the chosen tag up, and null for Auto', async () => {
    const got: LocaleChoice[] = [];
    const tree = await mountSheet('en', (l) => got.push(l));
    act(() => { pill(tree, 'btn-lang-de').props.onPress(); });
    act(() => { pill(tree, 'btn-lang-auto').props.onPress(); });
    expect(got).toEqual(['de', null]);
    tree.unmount();
  });

  test('marks exactly the active choice as checked', async () => {
    const tree = await mountSheet('fr', () => {});
    expect(pill(tree, 'btn-lang-fr').props.accessibilityState.checked).toBe(true);
    expect(pill(tree, 'btn-lang-de').props.accessibilityState.checked).toBe(false);
    expect(pill(tree, 'btn-lang-auto').props.accessibilityState.checked).toBe(false);
    tree.unmount();
  });

  test('Auto is checked when no language is pinned', async () => {
    const tree = await mountSheet(null, () => {});
    expect(pill(tree, 'btn-lang-auto').props.accessibilityState.checked).toBe(true);
    tree.unmount();
  });

  test('renders the live catalog, so a switch lands without remounting a provider', async () => {
    applyLocale('de', 'en-US');
    const tree = await mountSheet('de', () => {});
    const labelled = tree.root.findAll(n => n.props.accessibilityLabel === M.settings.language.label);
    expect(labelled.length).toBeGreaterThan(0);
    expect(M.settings.language.label).toBe(de.settings.language.label);
    tree.unmount();
  });
});

describe('the LOCALE_STORAGE_KEY persistence contract', () => {
  test('round-trips every choice through what App actually writes and reads', async () => {
    for (const choice of [null, ...LOCALES] as LocaleChoice[]) {
      await AsyncStorage.setItem(LOCALE_STORAGE_KEY, localePersistValue(choice));
      expect(parseLocale(await AsyncStorage.getItem(LOCALE_STORAGE_KEY))).toBe(choice);
    }
  });

  test('an absent key reads as Auto rather than pinning English', async () => {
    expect(parseLocale(await AsyncStorage.getItem(LOCALE_STORAGE_KEY))).toBeNull();
  });
});
