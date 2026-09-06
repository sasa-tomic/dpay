/**
 * HomeCurrencyChooser — the per-rail detail expansion (EUR dual-rail Stage 5).
 *
 * What these tests pin, and why each is load-bearing:
 *   • Tapping a MULTI-rail row opens the detail panel INSIDE that card; a single-rail row (CHF)
 *     NEVER expands — its confirmation behaviour is byte-identical to pre-detail.
 *   • The panel renders one block per rail in `currencyRails` order (EURC — the deep-liquidity
 *     stated preference — before VEUR), each stating ONLY catalog-backed facts: rail line, chain
 *     tag, fee in the rail's own unit (`M.receive.rail` vocabulary — the same voice the Receive
 *     disclosure uses), liquidity (thin→warn, deep→pro), ramp capability.
 *   • The default-pick reason appears on EXACTLY the rail `chooseRail` picks — never on the
 *     sibling.
 *   • The STRUCTURAL PIN: a COLLAPSED card carries only the currency name + its rail lines — no
 *     fee, no liquidity, no ramp string ever leaks into the collapsed shape (the "no fourth
 *     string" rule that keeps the chooser's preamble-compatible surface byte-stable).
 *   • Back collapses the panel WITHOUT unpicking: the check stays and Continue still commits the
 *     picked currency.
 *   • `home-currency-<CCY>` + `btn-home-currency-continue` are mounted and byte-stable — the
 *     ~106-flow preamble rides them.
 *
 * Uses react-test-renderer with the BUNDLED catalog (VEUR thin + DFX sellable, EURC deep, both
 * fee-carrying) — the same inputs the offline cold-start chooser renders.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {HomeCurrencyChooser} from '../components/HomeCurrencyChooser';
import {buildSelectableAssets} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const assets = buildSelectableAssets(CATALOG, {
  showTestnet: false,
  solanaEnabled: true,
  solanaTokens: true,
});

function mountChooser(onChoose = jest.fn()): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <HomeCurrencyChooser assets={assets} balances={null} catalog={CATALOG} onChoose={onChoose} />,
    );
  });
  return tree;
}

const press = (tree: renderer.ReactTestRenderer, testID: string): void => {
  // The testID sits on the Pressable element itself (card rows and buttons alike), so the first
  // match's own onPress is the gesture — no descendant hunting that could hit the detail panel's
  // Back button inside an expanded card.
  act(() => {
    tree.root.findAll(node => node.props && node.props.testID === testID)[0]!.props.onPress();
  });
};

const cardText = (tree: renderer.ReactTestRenderer, testID: string): string =>
  tree.root
    .findAll(node => node.props && node.props.testID === testID)[0]!
    .findAllByType(Text)
    .map(n => n.props.children)
    .join(' ');

const rowText = (tree: renderer.ReactTestRenderer, testID: string): string =>
  tree.root
    .findAll(node => node.props && node.props.testID === testID)[0]!
    .findAllByType(Text)
    .map(n => n.props.children)
    .join(' ');

const isPresent = (tree: renderer.ReactTestRenderer, testID: string): boolean =>
  tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;

describe('HomeCurrencyChooser — per-rail detail (Stage 5)', () => {
  test('a collapsed multi-rail card carries ONLY the name + rail lines (no fourth string)', () => {
    const tree = mountChooser();
    // EUR is offered (both rails catalogued) and its collapsed card names both rail lines…
    const eur = cardText(tree, 'home-currency-EUR');
    expect(eur).toContain('EURC · Solana');
    expect(eur).toContain('VEUR · Internet Computer');
    // …and NOTHING from the detail vocabulary: no fee, no liquidity statement, no ramp line, no
    // chain tag. The collapsed shape is the pre-detail shape, byte for byte.
    for (const absent of ['Fee', 'Very little', 'Circulates', 'DFX', 'fiat ramp', 'SOLANA', 'IC']) {
      expect(eur).not.toContain(absent);
    }
    expect(isPresent(tree, 'home-currency-detail')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('tapping the EUR row opens the detail INSIDE the card; CHF never expands', () => {
    const tree = mountChooser();
    press(tree, 'home-currency-EUR');
    expect(isPresent(tree, 'home-currency-detail')).toBe(true);
    // Back collapses it again (covered below); collapse first, then prove the single-rail rule.
    press(tree, 'btn-home-currency-back');
    expect(isPresent(tree, 'home-currency-detail')).toBe(false);

    press(tree, 'home-currency-CHF');
    expect(isPresent(tree, 'home-currency-detail')).toBe(false);
    expect(isPresent(tree, 'btn-home-currency-back')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('both rail blocks render, EURC first, each with its chain tag', () => {
    const tree = mountChooser();
    press(tree, 'home-currency-EUR');
    const blocks = tree.root.findAll(node => node.props && node.props.testID === 'rail-detail-sol-eurc');
    expect(blocks.length).toBeGreaterThan(0);
    expect(isPresent(tree, 'rail-detail-veur')).toBe(true);
    // Preferred-first order: the EURC block precedes the VEUR block in the panel's children.
    const panel = tree.root.findAll(node => node.props && node.props.testID === 'home-currency-detail')[0]!;
    const order = [...new Set(panel
      .findAll(node => node.props && /^rail-detail-(sol-eurc|veur)$/.test(node.props.testID))
      .map(node => node.props.testID as string))];
    // Each testID matches its RN composite + host node pair; deduped, the order is exactly the
    // preference order — EURC before VEUR.
    expect(order).toEqual(['rail-detail-sol-eurc', 'rail-detail-veur']);
    expect(rowText(tree, 'rail-detail-sol-eurc')).toContain('SOLANA');
    expect(rowText(tree, 'rail-detail-veur')).toContain('IC');
    act(() => { tree.unmount(); });
  });

  test('each block states its OWN facts: fee in own unit, liquidity, ramp', () => {
    const tree = mountChooser();
    press(tree, 'home-currency-EUR');
    // Fee facts — the M.receive.rail vocabulary, each rail in its own unit:
    expect(rowText(tree, 'rail-detail-fee-sol-eurc')).toBe(
      'Solana · Fee 0.000005000 SOL + one-time account rent 0.002039280 SOL',
    );
    expect(rowText(tree, 'rail-detail-fee-veur')).toBe('Internet Computer · Fee 0.00010000 VEUR');
    // Liquidity: deep on EURC (pro line), thin on VEUR (warn statement, named by ledger token).
    expect(rowText(tree, 'rail-detail-liquidity-sol-eurc')).toBe('Circulates widely on-chain today.');
    expect(rowText(tree, 'rail-detail-liquidity-veur')).toBe(
      'Very little VEUR exists on-chain today — receiving can be hard, and paying needs someone who holds it.',
    );
    // Ramp: VEUR is DFX-sellable; EURC has no fiat ramp today.
    expect(rowText(tree, 'rail-detail-ramp-veur')).toBe('DFX lists this token as sellable; buying is not available today.');
    expect(rowText(tree, 'rail-detail-ramp-sol-eurc')).toBe('No fiat ramp today — it moves wallet to wallet.');
    act(() => { tree.unmount(); });
  });

  test('the default-pick reason sits on EXACTLY the rail chooseRail picks', () => {
    const tree = mountChooser();
    press(tree, 'home-currency-EUR');
    // Fresh wallet, no balances: EURC is the stated preference → its block (and only its block)
    // carries the reason line.
    const reason = "EURC · Solana — dpay's default rail";
    expect(rowText(tree, 'rail-detail-sol-eurc')).toContain(reason);
    expect(rowText(tree, 'rail-detail-veur')).not.toContain('dpay');
    act(() => { tree.unmount(); });
  });

  test('Back collapses without unpicking; Continue still commits the picked currency', () => {
    const onChoose = jest.fn();
    const tree = mountChooser(onChoose);
    press(tree, 'home-currency-EUR');
    press(tree, 'btn-home-currency-back');
    expect(isPresent(tree, 'home-currency-detail')).toBe(false);
    // The row stays picked: the collapsed card still carries the reason-marked preferred line.
    expect(cardText(tree, 'home-currency-EUR')).toContain("EURC · Solana — dpay's default rail");
    press(tree, 'btn-home-currency-continue');
    expect(onChoose).toHaveBeenCalledWith('EUR');
    act(() => { tree.unmount(); });
  });
});
