/**
 * RailLiquidityNote — the rail-health line.
 *
 * One component, one testID (`rail-liquidity-note`), two tones, and the rule that makes the
 * "thin rails only" Balances assertion true: the TONE gates the tier. A warn note renders exactly
 * for a THIN rail (the liquidity statement, alert icon, warn colour — the established warnRow
 * idiom); a pro note renders exactly for a DEEP rail (a plain sub-line, no icon, so it never reads
 * as praise-from-a-caution-icon). Null-tier assets (SOL, USDC, VCHF — the catalog says nothing)
 * render NOTHING in either tone: no speculative copy for a tier the catalog cannot name.
 *
 * NO bundled row is tiered thin any more (the 2026-09-19 VEUR retirement), so the thin specimen
 * here is the legacy SERVED row — the same retired row prod still serves until the founder
 * redeploys. That is the tolerance contract: the retired row renders as a normal thin rail
 * through the SAME generic component and testID as every other row; EURC stays the deep specimen.
 */
import {describe, test, expect} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {RailLiquidityNote} from '../components/RailLiquidityNote';
import {buildSelectableAssets} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';

// A legacy SERVED catalog: the bundled rows PLUS the retired VEUR row (currency 9, removed from
// the bundle 2026-09-19 but still served by prod until the founder's redeploy) — thin +
// Partner/DFX. The note must render it like any other thin rail: GENERIC machinery, no
// VEUR-specific branch anywhere.
const LEGACY_VEUR_ROW: CurrencyDescriptor = {
  ...icpCatalogOf(BUNDLED_NETWORKS)[0],
  currency: 9, ledger: 'wu6g4-6qaaa-aaaan-qmrza-cai', mintable: false, minter: null, minter_family: null,
  symbol: 'VEUR', decimals: 8, wrapper_name: 'VEUR', backing_symbol: 'VEUR', network: 'Internet Computer',
  display_decimals: 8, min_fraction_digits: 2, fee: '10000', cap: '1000000000000',
  chain_id: null, token_contract: null, gas_ledger: null,
  onramp: 'Unavailable', offramp: 'Partner', liquidity: 'thin', ramp_partner: 'DFX', testnet: false,
};
const assets = buildSelectableAssets(
  [...icpCatalogOf(BUNDLED_NETWORKS), LEGACY_VEUR_ROW],
  {
    showTestnet: false,
    solanaEnabled: true,
    solanaTokens: true,
  },
);
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
  test('warn on a THIN rail (the legacy served VEUR row): the 2–3-word liquidity statement', () => {
    const tree = renderNote('ic:9', 'warn')!;
    expect(hasNote(tree)).toBe(true);
    expect(noteText(tree)).toBe('Thin liquidity');
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
    expect(noteText(tree)).toBe('Circulates widely.');
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
