/**
 * HomeCurrencyChooser — the per-rail detail expansion.
 *
 * What these tests pin, and why each is load-bearing:
 *   • Tapping a MULTI-rail row opens the detail panel INSIDE that card; single-rail rows (CHF,
 *     and EUR since the 2026-09-19 VEUR retirement) NEVER expand — their confirmation behaviour
 *     is byte-identical to pre-detail.
 *   • The panel renders one block per rail in `currencyRails` order (ckUSDC — the stated
 *     preference — before the Solana USDC row), each stating ONLY catalog-backed facts: rail
 *     line, chain tag, fee in the rail's own unit (`M.receive.rail` vocabulary — the same voice
 *     the Receive disclosure uses), liquidity (thin→warn, deep→pro), ramp capability.
 *   • Preference still determines rail order, but is never rendered as a reason suffix
 *     (docs/specs/2026-09-07-ux-decisions.md).
 *   • The STRUCTURAL PIN: a COLLAPSED card carries only the currency name + its rail lines — no
 *     fee, no liquidity, no ramp string ever leaks into the collapsed shape (the "no fourth
 *     string" rule that keeps the chooser's preamble-compatible surface byte-stable).
 *   • Back collapses the panel WITHOUT unpicking: the check stays and Continue still commits the
 *     picked currency.
 *   • `home-currency-<CCY>` + `btn-home-currency-continue` are mounted and byte-stable — the
 *     ~106-flow preamble rides them.
 *
 * Uses react-test-renderer with the BUNDLED catalog — the same inputs the offline cold-start
 * chooser renders. USD is the live multi-rail case (ckUSDC + Solana USDC); EUR now lists exactly
 * one rail (EURC) since VEUR was retired, and no bundled row carries a thin tier.
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

describe('HomeCurrencyChooser — per-rail detail', () => {
  test('requires an explicit currency choice, and SAYS SO when Continue is pressed early (X5)', () => {
    // The measured dead end: Continue rendered at 40% opacity in the primary colour, looked
    // pressable, and swallowed the tap in total silence — no shake, no hint, nothing. The
    // no-preselect decision stays (docs/specs/2026-09-07-ux-decisions.md §2); what changes is that
    // a control which LOOKS pressable IS pressable and answers with the missing step.
    const onChoose = jest.fn();
    const tree = mountChooser(onChoose);
    expect(isPresent(tree, 'home-currency-pick-first')).toBe(false);
    press(tree, 'btn-home-currency-continue');
    expect(onChoose).not.toHaveBeenCalled();
    expect(rowText(tree, 'home-currency-pick-first')).toBe('Pick a currency first.');
    // Picking clears the prompt and Continue commits — the instruction never outlives its cause.
    press(tree, 'home-currency-CHF');
    expect(isPresent(tree, 'home-currency-pick-first')).toBe(false);
    press(tree, 'btn-home-currency-continue');
    expect(onChoose).toHaveBeenCalledWith('CHF');
    act(() => { tree.unmount(); });
  });

  test('a collapsed multi-rail card carries ONLY the name + rail lines (no fourth string)', () => {
    const tree = mountChooser();
    // USD is offered (both rails catalogued) and its collapsed card names both rail lines…
    const usd = cardText(tree, 'home-currency-USD');
    expect(usd).toContain('ckUSDC · Internet Computer');
    expect(usd).toContain('USDC · Solana');
    // …and NOTHING from the detail vocabulary: no fee, no liquidity statement, no ramp line, no
    // chain tag. The collapsed shape is the pre-detail shape, byte for byte.
    for (const absent of ['Fee', 'Thin liquidity', 'Circulates', 'Deposit and cash-out', 'fiat ramp', 'SOLANA', 'IC']) {
      expect(usd).not.toContain(absent);
    }
    expect(isPresent(tree, 'home-currency-detail')).toBe(false);
    // EUR is offered through its ONE rail (EURC — sole EUR rail since the VEUR retirement); the
    // served-legacy VEUR row is not a rail, so no VEUR line can leak into the collapsed card.
    const eur = cardText(tree, 'home-currency-EUR');
    expect(eur).toContain('EURC · Solana');
    expect(eur).not.toContain('VEUR');
    act(() => { tree.unmount(); });
  });

  test('tapping a multi-rail row opens the detail INSIDE the card; single-rail rows never expand', () => {
    const tree = mountChooser();
    press(tree, 'home-currency-USD');
    expect(isPresent(tree, 'home-currency-detail')).toBe(true);
    // Back collapses it again (covered below); collapse first, then prove the single-rail rule.
    press(tree, 'btn-home-currency-back');
    expect(isPresent(tree, 'home-currency-detail')).toBe(false);

    press(tree, 'home-currency-CHF');
    expect(isPresent(tree, 'home-currency-detail')).toBe(false);
    expect(isPresent(tree, 'btn-home-currency-back')).toBe(false);
    // EUR joined the single-rail set when VEUR retired (2026-09-19): one rail, no expansion.
    press(tree, 'home-currency-EUR');
    expect(isPresent(tree, 'home-currency-detail')).toBe(false);
    expect(isPresent(tree, 'btn-home-currency-back')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('both rail blocks render, ckUSDC first, each with its chain tag', () => {
    const tree = mountChooser();
    press(tree, 'home-currency-USD');
    const blocks = tree.root.findAll(node => node.props && node.props.testID === 'rail-detail-ckusdc');
    expect(blocks.length).toBeGreaterThan(0);
    expect(isPresent(tree, 'rail-detail-sol-usdc')).toBe(true);
    // Preferred-first order: the ckUSDC block precedes the Solana block in the panel's children.
    const panel = tree.root.findAll(node => node.props && node.props.testID === 'home-currency-detail')[0]!;
    const order = [...new Set(panel
      .findAll(node => node.props && /^rail-detail-(ckusdc|sol-usdc)$/.test(node.props.testID))
      .map(node => node.props.testID as string))];
    // Each testID matches its RN composite + host node pair; deduped, the order is exactly the
    // preference order — ckUSDC before Solana USDC.
    expect(order).toEqual(['rail-detail-ckusdc', 'rail-detail-sol-usdc']);
    expect(rowText(tree, 'rail-detail-ckusdc')).toContain('IC');
    expect(rowText(tree, 'rail-detail-sol-usdc')).toContain('SOLANA');
    act(() => { tree.unmount(); });
  });

  test('each block states its OWN facts: fee in own unit, liquidity, ramp', () => {
    const tree = mountChooser();
    press(tree, 'home-currency-USD');
    // Fee facts — the M.receive.rail vocabulary, each rail in its own unit:
    expect(rowText(tree, 'rail-detail-fee-ckusdc')).toBe('Internet Computer · Fee 0.01 ckUSDC');
    expect(rowText(tree, 'rail-detail-fee-sol-usdc')).toBe(
      'Solana · Fee 0.000005 SOL + one-time account rent 0.00203928 SOL',
    );
    // Liquidity: NO bundled USD rail is tiered, so NEITHER block makes a liquidity statement —
    // after the VEUR retirement the thin branch has no bundled row to fire on (its generic
    // machinery stays covered by RailLiquidityNote's served-legacy suite).
    expect(isPresent(tree, 'rail-detail-liquidity-ckusdc')).toBe(false);
    expect(isPresent(tree, 'rail-detail-liquidity-sol-usdc')).toBe(false);
    // Ramp: ckUSDC is wired both ways; Solana USDC has no fiat ramp today.
    expect(rowText(tree, 'rail-detail-ramp-ckusdc')).toBe('Deposit and cash-out are wired in.');
    expect(rowText(tree, 'rail-detail-ramp-sol-usdc')).toBe('No fiat ramp - wallet to wallet only.'); // copy-economy sweep: em-dash to plain hyphen
    act(() => { tree.unmount(); });
  });

  test('the preferred rail stays first without a default-rail suffix', () => {
    const tree = mountChooser();
    press(tree, 'home-currency-USD');
    expect(rowText(tree, 'rail-detail-ckusdc')).toContain('ckUSDC · Internet Computer');
    expect(rowText(tree, 'rail-detail-ckusdc')).not.toContain('default rail');
    expect(rowText(tree, 'rail-detail-sol-usdc')).not.toContain('default rail');
    act(() => { tree.unmount(); });
  });

  test('Back collapses without unpicking; Continue still commits the picked currency', () => {
    const onChoose = jest.fn();
    const tree = mountChooser(onChoose);
    press(tree, 'home-currency-USD');
    press(tree, 'btn-home-currency-back');
    expect(isPresent(tree, 'home-currency-detail')).toBe(false);
    // The row stays picked and the preferred line remains first without implementation jargon.
    expect(cardText(tree, 'home-currency-USD')).toContain('ckUSDC · Internet Computer');
    expect(cardText(tree, 'home-currency-USD')).not.toContain('default rail');
    press(tree, 'btn-home-currency-continue');
    expect(onChoose).toHaveBeenCalledWith('USD');
    act(() => { tree.unmount(); });
  });
});
