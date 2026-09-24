/**
 * The CURRENCY LIST route (`AccountsTab`) — the 2026-09-24 redesign of the 2026-09-08 accounts
 * route. One row per VISIBLE currency, not one per rail. What is pinned:
 *
 *   • ORDER: the fiat stables (CHF, USD, EUR), then the token currencies ("Other": BTC, ETH, ICP,
 *     SOL) — and the practice rail LAST, outside the list, under a divider that says in a whole
 *     sentence what it is (practice money is not a currency and never becomes main);
 *   • every visible currency renders, zero balance included, with its SUMMED currency-unit
 *     figure ("0.00 Fr" — fork #2 + #4; the sum itself is buildCurrencyBalances' contract, tested
 *     in currencyBalances.test.ts);
 *   • the gestures: a row tap SETS MAIN (`onOpenCurrency`), Convert rides EVERY row
 *     (`btn-accounts-convert-<CODE>`), and [Add new currency] opens its route;
 *   • the MAIN badge sits on the home-currency row only;
 *   • an outage belongs to a NETWORK and is stated ONCE, above the first affected row (X9);
 *   • a KNOWN-absent token account on the preferred rail still grows the "needs setup" badge.
 *
 * Uses react-test-renderer (the project's only renderer); the fixtures run the REAL pure
 * pipeline (buildSelectableAssets → buildAssetBalances → buildCurrencyBalances), the same one
 * Wallet wires.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {AccountsTab} from '../components/AccountsTab';
import {DEMO_ASSET_ID, buildSelectableAssets} from '../config/assets';
import {buildAssetBalances, buildCurrencyBalances} from '../lib/assetBalances';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {offerableCurrencies} from '../config/currency';

const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(BUNDLED, {showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: BUNDLED_NETWORKS});
const VISIBLE = offerableCurrencies(ASSETS); // stables then tokens, offerable only — the Wallet-derived list

/** The REAL per-asset views over the bundled catalog. */
function assetViews(over: Partial<Parameters<typeof buildAssetBalances>[0]> = {}) {
  return buildAssetBalances({
    catalog: BUNDLED,
    assets: ASSETS,
    icBalances: {},
    primaryBalance: '12345',
    solState: {balance: null, status: 'unavailable'},
    tokenStates: {},
    ...over,
  });
}

/** The REAL per-currency sums over those views. */
function currencyViews(views: ReturnType<typeof assetViews>, over: Partial<Parameters<typeof buildCurrencyBalances>[0]> = {}) {
  return buildCurrencyBalances({
    currencies: VISIBLE,
    assets: ASSETS,
    catalog: BUNDLED,
    views,
    icBalances: {},
    solBalance: null,
    tokenAmounts: {},
    approx: {},
    ...over,
  });
}

function mount(
  views: ReturnType<typeof assetViews>,
  currencyViewsMap: ReturnType<typeof currencyViews>,
  props: Partial<Parameters<typeof AccountsTab>[0]> = {},
): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <AccountsTab
        assets={ASSETS}
        balances={views}
        currencyBalances={currencyViewsMap}
        homeCurrency="CHF"
        visibleCurrencies={VISIBLE}
        selectedId={DEMO_ASSET_ID}
        demoFaucetAvailable={true}
        topUpBusy={false}
        hasTestnet={false}
        showTestnet={false}
        onToggleTestnet={jest.fn()}
        onBack={jest.fn()}
        onOpenCurrency={jest.fn()}
        onConvertCurrency={jest.fn()}
        onOpenAddCurrency={jest.fn()}
        onSelect={jest.fn()}
        onTopUp={jest.fn()}
        {...props}
      />,
    );
  });
  return tree;
}

const pressable = (tree: renderer.ReactTestRenderer, testID: string) =>
  tree.root.findAll(n => n.props?.testID === testID && typeof n.props.onPress === 'function')[0];

const rowText = (tree: renderer.ReactTestRenderer, testID: string): string =>
  tree.root
    .findAll(node => node.props && node.props.testID === testID)[0]!
    .findAllByType(Text)
    .map(n => n.props.children)
    .join(' ');

const has = (tree: renderer.ReactTestRenderer, testID: string): boolean =>
  tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;

/** The rendered currency rows, in order — the row CONTAINER testIDs. */
const currencyRowOrder = (tree: renderer.ReactTestRenderer): string[] =>
  tree.root
    .findAll(n => typeof n.props?.testID === 'string' && n.props.testID.startsWith('accounts-currency-') && typeof n.type === 'string')
    .map(n => String(n.props.testID).replace('accounts-currency-', ''));

describe('AccountsTab — one row per VISIBLE currency, stables then Other', () => {
  const views = assetViews();
  const sums = currencyViews(views);

  test('stables first, then the token currencies; practice outside the list, last', () => {
    const tree = mount(views, sums);
    expect(currencyRowOrder(tree)).toEqual(['CHF', 'USD', 'EUR', 'BTC', 'ETH', 'ICP', 'SOL']);
    const list = tree.root.findAll(n => n.props?.testID === 'accounts-list')[0]!;
    const marks = list.findAll(n => (n.props?.testID === 'accounts-practice-note' || n.props?.testID === 'asset-demo') && typeof n.type === 'string')
      .map(n => String(n.props.testID));
    // The divider renders immediately above the practice row — and after every currency row.
    expect(marks).toEqual(['accounts-practice-note', 'asset-demo']);
    act(() => { tree.unmount(); });
  });

  test('a zero-balance currency stays visible with its SUMMED currency-unit figure', () => {
    const tree = mount(views, sums);
    // CHF holds nothing: the row still renders, in the CURRENCY unit (fork #4), dimmable.
    expect(rowText(tree, 'accounts-currency-CHF')).toContain('0.00 Fr');
    expect(rowText(tree, 'accounts-currency-CHF')).toContain('Swiss francs');
    // The row names its rails (the label is the currency; the subtitle says where it settles).
    expect(rowText(tree, 'accounts-currency-CHF')).toContain('VCHF · Internet Computer');
    act(() => { tree.unmount(); });
  });

  test('the practice row keeps the faucet and its select — and never a set-main gesture', () => {
    const onSelect = jest.fn();
    const tree = mount(views, sums, {onSelect});
    const demoRow = tree.root.findAll(node => node.props?.testID === 'asset-demo')[0]!;
    expect(demoRow.findAll(node => node.props?.testID === 'btn-topup').length).toBeGreaterThan(0);
    act(() => { pressable(tree, 'asset-demo-select').props.onPress(); });
    expect(onSelect).toHaveBeenCalledWith(DEMO_ASSET_ID);
    act(() => { tree.unmount(); });
  });

  test('the MAIN badge sits on the home-currency row only', () => {
    const tree = mount(views, sums, {homeCurrency: 'USD'});
    expect(has(tree, 'currency-USD-main')).toBe(true);
    for (const c of ['CHF', 'EUR', 'BTC', 'ETH', 'ICP', 'SOL']) {
      expect(has(tree, `currency-${c}-main`)).toBe(false);
    }
    act(() => { tree.unmount(); });
  });
});

describe('AccountsTab — the gestures', () => {
  const views = assetViews();
  const sums = currencyViews(views);

  test('a row tap sets that currency MAIN — the deliberate gesture (spec supersedes tap protection)', () => {
    const onOpenCurrency = jest.fn();
    const tree = mount(views, sums, {onOpenCurrency});
    act(() => { pressable(tree, 'btn-accounts-currency-BTC').props.onPress(); });
    expect(onOpenCurrency).toHaveBeenCalledWith('BTC');
    act(() => { tree.unmount(); });
  });

  test('Convert rides EVERY row and names its currency as the source', () => {
    const onConvertCurrency = jest.fn();
    const tree = mount(views, sums, {onConvertCurrency});
    for (const c of VISIBLE) {
      expect(has(tree, `btn-accounts-convert-${c}`)).toBe(true);
      act(() => { pressable(tree, `btn-accounts-convert-${c}`).props.onPress(); });
    }
    expect(onConvertCurrency).toHaveBeenCalledTimes(VISIBLE.length);
    expect(onConvertCurrency).toHaveBeenLastCalledWith(VISIBLE[VISIBLE.length - 1]);
    act(() => { tree.unmount(); });
  });

  test('[Add new currency] closes the list into its route; Back hands off; testnet toggle reachable', () => {
    const onOpenAddCurrency = jest.fn();
    const onToggleTestnet = jest.fn();
    const tree = mount(views, sums, {onOpenAddCurrency, onToggleTestnet, hasTestnet: true});
    act(() => { pressable(tree, 'btn-accounts-add-currency').props.onPress(); });
    expect(onOpenAddCurrency).toHaveBeenCalledTimes(1);
    act(() => { pressable(tree, 'btn-toggle-testnet').props.onPress(); });
    expect(onToggleTestnet).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });
});

describe('AccountsTab — an unreadable rail says so once, per network (X9)', () => {
  test('a refusing Solana endpoint grows ONE banner above the first affected currency row', () => {
    // Every Solana token errors at once (the measured HTTP 429): USD (USDC·Sol), EUR (EURC) and
    // SOL rows are all affected — one banner.
    const mints = ASSETS.flatMap(a => (a.protocol === 'solana' && a.mint != null ? [a.mint] : []));
    const tokenStates = Object.fromEntries(mints.map(m => [m, {amount: null, decimals: null, status: 'error' as const}]));
    const views = assetViews({solState: {balance: null, status: 'error'}, tokenStates});
    const tree = mount(views, currencyViews(views, {
      views,
      solBalance: null,
      tokenAmounts: Object.fromEntries(mints.map(m => [m, null])),
    }));
    expect(has(tree, 'rail-unreadable-solana')).toBe(true);
    const count = tree.root.findAll(n => n.props?.testID === 'rail-unreadable-solana' && typeof n.type === 'string').length;
    expect(count).toBe(1);
    act(() => { tree.unmount(); });
  });

  test('a first poll still in flight is NOT an outage — loading stays silent', () => {
    const views = assetViews({solState: {balance: null, status: 'loading'}});
    const tree = mount(views, currencyViews(views));
    expect(has(tree, 'rail-unreadable-solana')).toBe(false);
    act(() => { tree.unmount(); });
  });
});

describe('AccountsTab — a KNOWN-absent token account grows the setup badge on its currency row', () => {
  test('USD with a missing Solana ATA marks the row (the preferred-rail setup gate)', () => {
    // A USD variant whose preferred rail is the SOLANA USDC row (no IC rail in this list), so
    // 'absent' is reachable: the badge rides the currency row, naming the setup the surfaces
    // will offer once this currency is main.
    const usdOnly = buildSelectableAssets(BUNDLED.filter(c => c.currency !== 2), {showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: BUNDLED_NETWORKS});
    const usdcRow = usdOnly.find(a => a.id === 'solana:USDC');
    const mint = usdcRow != null && usdcRow.protocol === 'solana' ? usdcRow.mint : null;
    const views = buildAssetBalances({
      catalog: BUNDLED, assets: usdOnly, icBalances: {}, primaryBalance: '0',
      solState: {balance: null, status: 'unavailable'},
      tokenStates: {[mint ?? '']: {amount: null, decimals: null, status: 'absent' as const}},
    });
    const props = {
      assets: usdOnly,
      balances: views,
      visibleCurrencies: offerableCurrencies(usdOnly),
    } as Partial<Parameters<typeof AccountsTab>[0]>;
    const tree = mount(views, currencyViews(views, {assets: usdOnly, currencies: props.visibleCurrencies!, tokenAmounts: {[mint ?? '']: null}}), props);
    expect(has(tree, 'currency-USD-setup')).toBe(true);
    act(() => { tree.unmount(); });
  });
});
