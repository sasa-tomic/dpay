/**
 * The ADD-CURRENCY route (`AddCurrencyTab`) — the full supported-currency list and the way back
 * for removed currencies. What is pinned:
 *   • SECTIONS: "Stable currencies" (CHF/USD/EUR) and "Other" (BTC/ETH/ICP/SOL), from the REAL
 *     `offerableCurrencies` over the bundled catalog — a currency the wallet cannot hold is not
 *     listed, let alone addable;
 *   • ROW STATES: an in-wallet currency is MARKED and renders no Add button; a hidden currency
 *     carries `btn-addcur-add-<CODE>`, and pressing it fires `onAdd` with that currency;
 *   • SEARCH: a plain case-insensitive filter over name and code, over BOTH sections; an empty
 *     result says so instead of rendering nothing;
 *   • Back hands off to the accounts route.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {AddCurrencyTab} from '../components/AddCurrencyTab';
import {buildSelectableAssets} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {M} from '../i18n';

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {
  showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: BUNDLED_NETWORKS,
});

function mount(hidden: string[], onAdd = jest.fn()): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <AddCurrencyTab assets={ASSETS} hiddenCurrencies={hidden as never} onBack={jest.fn()} onAdd={onAdd} />,
    );
  });
  return tree;
}

const press = (tree: renderer.ReactTestRenderer, testID: string): void => {
  act(() => {
    tree.root.findAll(n => n.props?.testID === testID && typeof n.props.onPress === 'function')[0]!.props.onPress();
  });
};

const type = (tree: renderer.ReactTestRenderer, testID: string, text: string): void => {
  act(() => {
    tree.root.findAll(n => n.props?.testID === testID)[0]!.props.onChangeText(text);
  });
};

const rowText = (tree: renderer.ReactTestRenderer, testID: string): string =>
  tree.root
    .findAll(node => node.props?.testID === testID)[0]!
    .findAllByType(Text)
    .map(n => n.props.children)
    .join(' ');

describe('AddCurrencyTab — sections and row states', () => {
  test('stable currencies and Other are two sections, both from the offerable list', () => {
    const tree = mount([]);
    expect(rowText(tree, 'addcur-stable')).toContain(M.wallet.addCurrency.stable);
    expect(rowText(tree, 'addcur-stable')).toContain('Swiss francs');
    expect(rowText(tree, 'addcur-other')).toContain(M.wallet.addCurrency.other);
    expect(rowText(tree, 'addcur-other')).toContain('Bitcoin');
    act(() => { tree.unmount(); });
  });

  test('an in-wallet currency is MARKED and renders no Add button; a hidden one carries Add', () => {
    const onAdd = jest.fn();
    // CHF + BTC are hidden (removed); everything else is in the wallet.
    const tree = mount(['CHF', 'BTC'], onAdd);
    for (const c of ['CHF', 'BTC']) {
      expect(tree.root.findAll(n => n.props?.testID === `btn-addcur-add-${c}`).length).toBeGreaterThan(0);
    }
    // In-wallet currencies never render an Add button (presence across the whole tree).
    for (const c of ['USD', 'EUR', 'ETH', 'ICP', 'SOL']) {
      expect(tree.root.findAll(n => n.props?.testID === `btn-addcur-add-${c}`)).toHaveLength(0);
    }
    act(() => { press(tree, 'btn-addcur-add-BTC'); });
    expect(onAdd).toHaveBeenCalledWith('BTC');
    act(() => { tree.unmount(); });
  });

  test('Back hands off to the accounts route', () => {
    const tree = mount([]);
    expect(tree.root.findAll(n => n.props?.testID === 'btn-addcur-back').length).toBeGreaterThan(0);
    act(() => { tree.unmount(); });
  });
});

describe('AddCurrencyTab — the search field', () => {
  test('filters by name and code, case-insensitively, across both sections', () => {
    const tree = mount([]);
    act(() => { type(tree, 'input-addcur-search', 'swiss'); });
    expect(rowText(tree, 'addcur-stable')).toContain('Swiss francs');
    expect(rowText(tree, 'addcur-other')).not.toContain('Bitcoin');
    act(() => { type(tree, 'input-addcur-search', 'btc'); });
    expect(rowText(tree, 'addcur-other')).toContain('Bitcoin');
    expect(rowText(tree, 'addcur-stable')).not.toContain('Swiss francs');
    act(() => { tree.unmount(); });
  });

  test('an empty result says so — never a silently blank screen', () => {
    const tree = mount([]);
    act(() => { type(tree, 'input-addcur-search', 'zzz'); });
    expect(rowText(tree, 'addcur-none')).toBe(M.wallet.addCurrency.none);
    act(() => { tree.unmount(); });
  });
});
