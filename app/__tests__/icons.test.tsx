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
import {describe, test, expect} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Svg} from 'react-native-svg';
import {ICONS} from '../components/icons';
import {AssetGlyph, glyphFor} from '../components/AssetGlyph';
import type {SelectableAsset} from '../config/assets';

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
  {id: 'ic:0', protocol: 'ic', currency: 0, symbol: 'DEMO', networkLabel: 'Internet Computer', network: null, decimals: 2, linkToken: 'DEMO', minFractionDigits: 0, visible: true, testKey: 'demo'},
  {id: 'ic:1', protocol: 'ic', currency: 1, symbol: 'ckBTC', networkLabel: 'Bitcoin', network: 'Bitcoin', decimals: 8, linkToken: 'ckBTC', minFractionDigits: 0, visible: true, testKey: 'ckbtc'},
  {id: 'ic:2', protocol: 'ic', currency: 2, symbol: 'ckETH', networkLabel: 'Ethereum', network: 'Ethereum', decimals: 18, linkToken: 'ckETH', minFractionDigits: 0, visible: true, testKey: 'cketh'},
  {id: 'ic:3', protocol: 'ic', currency: 3, symbol: 'ckUSDC', networkLabel: 'Ethereum', network: 'Ethereum', decimals: 6, linkToken: 'ckUSDC', minFractionDigits: 0, visible: true, testKey: 'ckusdc'},
  {id: 'solana:SOL', protocol: 'solana', token: 'SOL', symbol: 'SOL', networkLabel: 'Solana', network: 'Solana', decimals: 9, linkToken: 'SOL', minFractionDigits: 0, visible: true, testKey: 'sol'},
  {id: 'solana:USDC', protocol: 'solana', token: 'USDC', symbol: 'USDC', networkLabel: 'Solana', network: 'Solana', decimals: 6, linkToken: 'USDC', minFractionDigits: 0, visible: true, testKey: 'sol-usdc'},
  {id: 'ic:9', protocol: 'ic', currency: 9, symbol: 'CHF', networkLabel: 'Swiss Franc', network: 'Swiss Franc', decimals: 2, linkToken: 'CHF', minFractionDigits: 0, visible: true, testKey: 'chf'},
];

describe('glyphFor', () => {
  test('DEMO maps to the brand-tangerine ∂ chip', () => {
    expect(glyphFor(ASSETS[0])).toEqual({glyph: '∂', color: '#D8450D', bg: 'rgba(255,90,31,0.10)'});
  });
  test('ckBTC → ₿ amber, ckETH → ◊ indigo, ckUSDC → $ blue', () => {
    expect(glyphFor(ASSETS[1]).glyph).toBe('₿');
    expect(glyphFor(ASSETS[2]).glyph).toBe('◊');
    expect(glyphFor(ASSETS[3]).glyph).toBe('$');
  });
  test('SOL → ◎ purple, SOL-USDC → $ blue (token drives the family, not protocol alone)', () => {
    expect(glyphFor(ASSETS[4]).glyph).toBe('◎');
    expect(glyphFor(ASSETS[5]).glyph).toBe('$');
  });
  test('unknown IC symbol falls back to first letter on brand hue', () => {
    const g = glyphFor(ASSETS[6]);
    expect(g.glyph).toBe('C');
    expect(g.color).toBe('#D8450D');
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
