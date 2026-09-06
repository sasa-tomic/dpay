/**
 * RailLiquidityNote — the rail-health line (EUR dual-rail Stage 4/5).
 *
 * One component, one testID (`rail-liquidity-note`), two tones, and the rule that makes flow 130's
 * "on VEUR only" assertion true in Balances: the TONE gates the tier. A warn note renders exactly
 * for a THIN rail (the liability statement, alert icon, warn colour — the established warnRow
 * idiom); a pro note renders exactly for a DEEP rail (a plain sub-line, no icon, so it never reads
 * as praise-from-a-caution-icon). Null-tier assets (SOL, USDC, VCHF — the catalog says nothing)
 * render NOTHING in either tone: no speculative copy for a tier the catalog cannot name.
 *
 * The assets are built from the BUNDLED catalog with the solana rows forced on — the same inputs
 * the offline cold-start wallet renders, carrying the Stage-1 facts verbatim (VEUR thin + DFX,
 * EURC deep).
 */
import {describe, test, expect} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {RailLiquidityNote} from '../components/RailLiquidityNote';
import {buildSelectableAssets} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';

const assets = buildSelectableAssets(icpCatalogOf(BUNDLED_NETWORKS), {
  showTestnet: false,
  solanaEnabled: true,
  solanaTokens: true,
});
const find = (id: string) => assets.find(a => a.id === id)!;

function renderNote(assetId: string, tone: 'warn' | 'pro'): renderer.ReactTestRenderer | null {
  let tree: renderer.ReactTestRenderer | null = null;
  act(() => {
    tree = renderer.create(<RailLiquidityNote asset={find(assetId)} tone={tone} />);
  });
  return tree;
}

// All Text under the note, joined — the note's whole statement.
const noteText = (tree: renderer.ReactTestRenderer): string =>
  tree.root.findAllByType(Text).map(n => n.props.children).join(' ');

const hasNote = (tree: renderer.ReactTestRenderer | null): boolean =>
  tree != null && tree.root.findAll(node => node.props && node.props.testID === 'rail-liquidity-note').length > 0;

describe('RailLiquidityNote — tone gates tier, catalog gates everything', () => {
  test('warn on a THIN rail (VEUR): the liability statement, named by LEDGER token', () => {
    const tree = renderNote('ic:9', 'warn')!;
    expect(hasNote(tree)).toBe(true);
    expect(noteText(tree)).toBe(
      'Very little VEUR exists on-chain today — receiving can be hard, and paying needs someone who holds it.',
    );
    act(() => { tree.unmount(); });
  });

  test('warn on a DEEP rail renders nothing — no caution icon on "circulates widely"', () => {
    const tree = renderNote('solana:EURC', 'warn')!;
    expect(hasNote(tree)).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('pro on a DEEP rail (EURC): the plain fact line, no icon, same testID', () => {
    const tree = renderNote('solana:EURC', 'pro')!;
    expect(hasNote(tree)).toBe(true);
    expect(noteText(tree)).toBe('Circulates widely on-chain today.');
    act(() => { tree.unmount(); });
  });

  test('pro on a THIN rail renders nothing — the warn copy is the only thin statement', () => {
    const tree = renderNote('ic:9', 'pro')!;
    expect(hasNote(tree)).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('a null-tier asset (SOL/USDC/VCHF) renders nothing in EITHER tone', () => {
    for (const id of ['solana:SOL', 'solana:USDC', 'ic:7']) {
      for (const tone of ['warn', 'pro'] as const) {
        const tree = renderNote(id, tone)!;
        expect(hasNote(tree)).toBe(false);
        act(() => { tree.unmount(); });
      }
    }
  });
});
