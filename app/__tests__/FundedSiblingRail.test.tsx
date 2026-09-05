/**
 * FundedSiblingRail — the pay-side funded-sibling pointer (Objective 2, S5). State matrix:
 * every branch of the pointer's null/button logic, because a misrendered gate is the difference
 * between a dead end and a one-tap rail switch. The switch must be a USER gesture only (the
 * press routes Wallet's `payRailSelect`, itself under `shouldAllowUserSelect`); with no
 * `onSwitch` the pointer names the rail WITHOUT the button — knowledge is never gated on the
 * selection lock, affordances are.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {View} from 'react-native';
import {FundedSiblingRail} from '../components/FundedSiblingRail';
import {buildSelectableAssets} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {M} from '../i18n';

const ASSETS = buildSelectableAssets(icpCatalogOf(BUNDLED_NETWORKS), {
  showTestnet: false,
  solanaEnabled: true,
  solanaUsdc: true,
});

// Wrapped in a host View so the NULL renders (the pointer's most common case) still leave a
// traversable tree — a component that renders null has no `tree.root` to walk. The create sits
// inside act like every other mount in this suite family: React 19 commits asynchronously.
function mount(props: Partial<Parameters<typeof FundedSiblingRail>[0]> = {}) {
  const onSwitch = jest.fn();
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <View>
        <FundedSiblingRail
          homeCurrency={null}
          assets={ASSETS}
          balances={{}}
          selectedAssetId={null}
          onSwitch={onSwitch}
          {...props}
        />
      </View>,
    );
  });
  return {tree, onSwitch};
}

function textOf(tree: renderer.ReactTestRenderer, testID: string): string {
  return tree.root.findByProps({testID}).props.children;
}

function hasTestID(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props.testID === testID).length > 0;
}

describe('FundedSiblingRail — when the pointer renders at all', () => {
  test('no home currency: never a pointer', () => {
    const {tree} = mount({homeCurrency: null, selectedAssetId: 'ic:2', balances: {'solana:USDC': {displayText: '2.50 USDC', status: 'ok'}}});
    expect(hasTestID(tree, 'fund-sibling-rail')).toBe(false);
  });

  test('a funded sibling of the same currency: the pointer names rail and amount, one tap switches', () => {
    const {tree, onSwitch} = mount({
      homeCurrency: 'USD',
      selectedAssetId: 'ic:2',
      balances: {'solana:USDC': {displayText: '2.50 USDC', status: 'ok'}},
    });
    expect(textOf(tree, 'fund-sibling-holds')).toBe(M.pay.fundSibling.holds('2.50 USDC', 'USDC · Solana'));
    expect(textOf(tree, 'fund-sibling-holds')).toBe('You hold 2.50 USDC on USDC · Solana');
    act(() => { tree.root.findByProps({testID: 'btn-fund-sibling-switch'}).props.onPress(); });
    expect(onSwitch).toHaveBeenCalledWith('solana:USDC');
  });

  test('the unfunded twin renders nothing — a zero/absent/unavailable sibling is not a pointer', () => {
    for (const status of ['zero', 'absent', 'unavailable', 'error', 'loading'] as const) {
      const {tree} = mount({homeCurrency: 'USD', selectedAssetId: 'ic:2', balances: {'solana:USDC': {displayText: '0.00 USDC', status}}});
      expect(hasTestID(tree, 'fund-sibling-rail')).toBe(false);
    }
  });

  test('selection on the OTHER rail points back at a funded ckUSDC', () => {
    const {tree, onSwitch} = mount({
      homeCurrency: 'USD',
      selectedAssetId: 'solana:USDC',
      balances: {'ic:2': {displayText: '5.00 ckUSDC', status: 'ok'}},
    });
    expect(textOf(tree, 'fund-sibling-holds')).toBe('You hold 5.00 ckUSDC on ckUSDC · Internet Computer');
    act(() => { tree.root.findByProps({testID: 'btn-fund-sibling-switch'}).props.onPress(); });
    expect(onSwitch).toHaveBeenCalledWith('ic:2');
  });

  test('with BOTH siblings funded, preference order wins — the chooser rail is the pointer', () => {
    const {tree} = mount({
      homeCurrency: 'USD',
      selectedAssetId: 'solana:USDC',
      balances: {
        'ic:2': {displayText: '5.00 ckUSDC', status: 'ok'},
        'solana:USDC': {displayText: '0.00 USDC', status: 'zero'},
      },
    });
    expect(textOf(tree, 'fund-sibling-holds')).toContain('ckUSDC');
  });

  test('a single-rail currency (CHF) points nowhere, even funded', () => {
    const {tree} = mount({
      homeCurrency: 'CHF',
      selectedAssetId: 'ic:7',
      balances: {'ic:7': {displayText: '0.00 VCHF', status: 'zero'}},
    });
    expect(hasTestID(tree, 'fund-sibling-rail')).toBe(false);
  });
});

describe('FundedSiblingRail — the lock is an affordance gate, not a knowledge gate', () => {
  test('no onSwitch (Wallet passes none while locked): the rail is still named, the button is gone', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <View>
          <FundedSiblingRail
            homeCurrency="USD"
            assets={ASSETS}
            balances={{'solana:USDC': {displayText: '2.50 USDC', status: 'ok'}}}
            selectedAssetId="ic:2"
          />
        </View>,
      );
    });
    expect(textOf(tree, 'fund-sibling-holds')).toBe('You hold 2.50 USDC on USDC · Solana');
    expect(hasTestID(tree, 'btn-fund-sibling-switch')).toBe(false);
  });
});
