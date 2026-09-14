/**
 * Icon system + AssetGlyph — P0 design-core smoke tests (2026-08-16 visual overhaul).
 *
 * icons.tsx: every icon in the ICONS registry must render an <Svg> with the 24-grid viewBox and
 * at least one drawn primitive — catches a factory regression (empty icon = silent invisible UI)
 * and keeps the registry export in sync with the individual exports.
 *
 * AssetGlyph: `glyphFor` is a PURE mapping from a SelectableAsset to its family chip spec
 * (glyph + hues). Family is derived from the asset shape alone (protocol/token/symbol) — the
 * fixtures mirror config/assets.ts shapes including the fallback path (unknown IC symbol →
 * first letter, brand hue). If a fixture drifts from the real SelectableAsset shape, the
 * type-check in this file fails at compile time (SelectiveAsset is imported as a type).
 */
import {C, withAlpha} from '../config/palette';
import {describe, test, expect} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Svg} from 'react-native-svg';
import {ICONS} from '../components/icons';
import {AssetGlyph, glyphFor} from '../components/AssetGlyph';
import type {SelectableAsset} from '../config/assets';
import {USDC_MINT_ADDRESS, EURC_MINT_ADDRESS} from '../solana/tokens';
import {HOME_CURRENCIES, currencyOfAsset} from '../config/currency';

describe('icons registry', () => {
  test('every icon renders a 24-grid Svg with at least one primitive', () => {
    for (const [, Icon] of Object.entries(ICONS)) {
      let tree!: renderer.ReactTestRenderer;
      act(() => {
        tree = renderer.create(<Icon size={22} color="#ffffff" />);
      });
      const svgs = tree.root.findAllByType(Svg);
      expect(svgs.length).toBeGreaterThanOrEqual(1);
      const svg = svgs[0];
      expect(svg.props.viewBox).toBe('0 0 24 24');
      expect(svg.props.width).toBe(22);
      expect(svg.props.height).toBe(22);
      // At least one child primitive (Path/Line/Circle/Rect/Polyline) — an icon that draws
      // nothing is a silent visual hole.
      expect(React.Children.count(svg.props.children)).toBeGreaterThan(0);
      act(() => {
        tree.unmount();
      });
    }
  });

  test('renders with defaults (no size/color props) without throwing', () => {
    for (const Icon of Object.values(ICONS)) {
      let tree!: renderer.ReactTestRenderer;
      act(() => {
        tree = renderer.create(<Icon />);
      });
      expect(tree.root.findAllByType(Svg).length).toBeGreaterThanOrEqual(1);
      act(() => {
        tree.unmount();
      });
    }
  });
});

// Fixtures — real SelectableAsset shapes from config/assets.ts.
const ASSETS: SelectableAsset[] = [
  {id: 'ic:0', protocol: 'ic', currency: 0, symbol: 'DEMO', networkLabel: 'Internet Computer', network: null, decimals: 2, linkToken: 'DEMO', minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'demo'},
  {id: 'ic:1', protocol: 'ic', currency: 1, symbol: 'ckBTC', networkLabel: 'Bitcoin', network: 'Bitcoin', decimals: 8, linkToken: 'ckBTC', minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'ckbtc'},
  {id: 'ic:2', protocol: 'ic', currency: 2, symbol: 'ckETH', networkLabel: 'Ethereum', network: 'Ethereum', decimals: 18, linkToken: 'ckETH', minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'cketh'},
  {id: 'ic:3', protocol: 'ic', currency: 3, symbol: 'ckUSDC', networkLabel: 'Ethereum', network: 'Ethereum', decimals: 6, linkToken: 'ckUSDC', minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'ckusdc'},
  {id: 'solana:SOL', protocol: 'solana', token: 'SOL', symbol: 'SOL', networkLabel: 'Solana', network: 'Solana', mint: null, decimals: 9, linkToken: 'SOL', minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, visible: true, testKey: 'sol'},
  {id: 'solana:USDC', protocol: 'solana', token: 'USDC', symbol: 'USDC', networkLabel: 'Solana', network: 'Solana', mint: USDC_MINT_ADDRESS, decimals: 6, linkToken: 'USDC', minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, visible: true, testKey: 'sol-usdc'},
  {id: 'ic:9', protocol: 'ic', currency: 9, symbol: 'CHF', networkLabel: 'Swiss Franc', network: 'Swiss Franc', decimals: 2, linkToken: 'CHF', minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'chf'},
  // The home-currency rails (config/currency.ts CURRENCY_RAILS), matched by `linkToken`.
  {id: 'ic:7', protocol: 'ic', currency: 7, symbol: 'VCHF', networkLabel: 'Internet Computer', network: 'Internet Computer', decimals: 8, linkToken: 'VCHF', minFractionDigits: 2, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'vchf'},
  {id: 'ic:10', protocol: 'ic', currency: 10, symbol: 'VEUR', networkLabel: 'Internet Computer', network: 'Internet Computer', decimals: 8, linkToken: 'VEUR', minFractionDigits: 2, liquidity: null, onramp: 'Unavailable', offramp: 'Partner', rampPartner: 'DFX', gasToken: null, visible: true, testKey: 'veur'},
  {id: 'solana:EURC', protocol: 'solana', token: 'EURC', symbol: 'EURC', networkLabel: 'Solana', network: 'Solana', mint: EURC_MINT_ADDRESS, decimals: 6, linkToken: 'EURC', minFractionDigits: 2, liquidity: 'deep', onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, visible: true, testKey: 'sol-eurc'},
];

describe('glyphFor', () => {
  test('DEMO maps to the brand-tangerine ∂ chip', () => {
    // Asserted through the palette, not against a hex: the ∂ chip IS the brand (palette v5
    // deleted its private copy of the tangerine), and a literal here would have to be re-typed on
    // the next brand change — which is the drift the derivation exists to remove.
    expect(glyphFor(ASSETS[0])).toEqual({glyph: '∂', color: C.brandText, bg: withAlpha(C.brandText, C.wash)});
  });
  test('ckBTC → ₿ amber, ckETH → ◊ indigo, ckUSDC → $ blue', () => {
    expect(glyphFor(ASSETS[1]).glyph).toBe('₿');
    expect(glyphFor(ASSETS[2]).glyph).toBe('◊');
    expect(glyphFor(ASSETS[3]).glyph).toBe('$');
  });
  test('SOL → • purple, SOL-USDC → $ blue (token drives the family, not protocol alone)', () => {
    expect(glyphFor(ASSETS[4]).glyph).toBe('•');
    expect(glyphFor(ASSETS[5]).glyph).toBe('$');
  });
  test('unknown IC symbol falls back to first letter on brand hue', () => {
    const g = glyphFor(ASSETS[6]);
    expect(g.glyph).toBe('C');
    expect(g.color).toBe(C.brandText);
  });

  // A home-currency rail wears its CURRENCY's mark, never its rail's. The chooser and the accounts
  // list both render this one chip, so the rule is pinned here rather than in either surface.
  // Before this rule, EURC-on-Solana wore the SOL mark (it looked like a SOL row) and VCHF
  // fell through to the first-letter fallback 'V'.
  describe('home-currency rails carry the currency mark, not the rail token mark', () => {
    const byId = (id: string) => ASSETS.find(a => a.id === id)!;

    test('CHF: the VCHF rail wears CHF', () => {
      expect(glyphFor(byId('ic:7')).glyph).toBe('CHF');
    });

    test('EUR: BOTH rails wear € — the Solana rail is a euro row, not a SOL row', () => {
      expect(glyphFor(byId('solana:EURC')).glyph).toBe('€');
      expect(glyphFor(byId('ic:10')).glyph).toBe('€');
      // …and they are the same chip, so the two EUR rails read as one currency on two rails.
      expect(glyphFor(byId('solana:EURC'))).toEqual(glyphFor(byId('ic:10')));
    });

    test('USD: both rails keep $ (the rule that already held, now derived from the currency)', () => {
      expect(glyphFor(byId('ic:3')).glyph).toBe('$');
      expect(glyphFor(byId('solana:USDC')).glyph).toBe('$');
      expect(glyphFor(byId('ic:3'))).toEqual(glyphFor(byId('solana:USDC')));
    });

    test('an asset OUTSIDE the home-currency model keeps its own family mark', () => {
      // Native SOL is held and spent, but it is not a currency the wallet is "in".
      expect(currencyOfAsset(byId('solana:SOL'))).toBeNull();
      expect(glyphFor(byId('solana:SOL')).glyph).toBe('•');
    });

    test('every offerable currency has a distinct mark and hue (no two currencies look alike)', () => {
      const rails = [byId('ic:7'), byId('ic:3'), byId('solana:EURC')];
      expect(rails.map(currencyOfAsset)).toEqual([...HOME_CURRENCIES]);
      const specs = rails.map(glyphFor);
      expect(new Set(specs.map(s => s.glyph)).size).toBe(3);
      expect(new Set(specs.map(s => s.color)).size).toBe(3);
    });
  });
});

describe('AssetGlyph component', () => {
  test('renders the family glyph text inside a tinted chip', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<AssetGlyph asset={ASSETS[0]} />);
    });
    const texts = tree.root.findAll(node => typeof node.props.children === 'string');
    expect(texts.some(t => t.props.children === '∂')).toBe(true);
    act(() => {
      tree.unmount();
    });
  });
});
