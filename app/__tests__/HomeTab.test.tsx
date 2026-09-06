/**
 * HomeTab — the balance-first home surface (O4). Two contracts are pinned here:
 *
 *   • The HEADLINE mirrors the header's eyebrow rules EXACTLY: the home rail names the
 *     CURRENCY ("Swiss francs · Main"), any other selection names the ASSET ("DEMO balance"),
 *     and the offline approximation marker OUTRANKS both — naming the currency changes the
 *     NAME, never the online/offline distinction. The amount is the selected asset's OWN
 *     balance in its own token unit (the header's displayText), never a portfolio sum.
 *   • The action row is capability-dispatched: the DEMO selection's Add money fires the
 *     faucet (busy/err machinery, honest fail-closed copy); any real asset's Add money lands
 *     the deposit surface for THAT asset. One chrome, no per-asset special cases.
 *
 * The activity feed is capped at 3 rows of the merged ledger, rendered through the same
 * HistoryRow as the Transactions tab but under its OWN home-hist-* testIDs.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {HomeTab} from '../components/HomeTab';
import {buildSelectableAssets} from '../config/assets';
import {buildAssetBalances} from '../lib/assetBalances';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {preferredRail} from '../config/currency';
import {M} from '../i18n';
import type {AssetId, Txn} from '../lib/types';

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {
  showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: BUNDLED_NETWORKS,
});
const DEMO = ASSETS.find(a => a.id === 'ic:0')!;
const VCHF = ASSETS.find(a => a.id === 'ic:7')!;
const HOME = 'CHF' as const;
const HOME_RAIL = preferredRail(HOME, ASSETS);

const TS = 1_756_000_200;

function txn(assetId: AssetId, amount: string, ts: number, overrides: Partial<Txn> = {}): Txn {
  return {
    nonce: `${assetId}:${ts}`,
    amount,
    who: 'someone',
    memo: '',
    time: Number.isFinite(ts) ? 'Aug 24' : '—',
    ts,
    dir: 'out',
    assetId,
    ...overrides,
  };
}

/** Every rendered <Text>'s content, in render order. */
function texts(tree: renderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(n => {
    const c = n.props.children;
    return Array.isArray(c) ? c.filter(x => typeof x === 'string' || typeof x === 'number').join('') : String(c ?? '');
  });
}

function textOf(tree: renderer.ReactTestRenderer, testID: string): string {
  const node = tree.root.find(n => n.props?.testID === testID);
  const c = node.props.children;
  return Array.isArray(c) ? c.filter(x => typeof x === 'string' || typeof x === 'number').join('') : String(c ?? '');
}

function testIDs(tree: renderer.ReactTestRenderer): string[] {
  return [...new Set(tree.root.findAll(n => typeof n.props?.testID === 'string').map(n => String(n.props.testID)))];
}

function pressable(tree: renderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll(n => n.props?.testID === testID && typeof n.props.onPress === 'function')[0];
}

function balancesFor(over: Partial<Parameters<typeof buildAssetBalances>[0]> = {}) {
  return buildAssetBalances({
    catalog: CATALOG,
    assets: ASSETS,
    icBalances: {7: '120000000'},
    primaryBalance: '12345',
    online: true,
    solState: {balance: null, status: 'unavailable'},
    tokenStates: {},
    ...over,
  });
}

function mountHome(props: Partial<Parameters<typeof HomeTab>[0]> = {}): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <HomeTab
        assets={ASSETS}
        selectedAsset={DEMO}
        selectedId={DEMO.id}
        balances={balancesFor()}
        catalog={CATALOG}
        homeCurrency={HOME}
        homeAsset={HOME_RAIL}
        online={true}
        history={[]}
        topUpBusy={false}
        topUpErr={null}
        hasTestnet={false}
        showTestnet={false}
        onToggleTestnet={jest.fn()}
        onPay={jest.fn()}
        onReceive={jest.fn()}
        onDeposit={jest.fn()}
        onTopUp={jest.fn()}
        onSelect={jest.fn()}
        onSeeAll={jest.fn()}
        {...props}
      />,
    );
  });
  return tree;
}

describe('HomeTab — the headline', () => {
  test('a non-home selection names the ASSET and shows its OWN token-unit balance', () => {
    const tree = mountHome();
    expect(textOf(tree, 'home-headline-label')).toBe(M.wallet.balance.of('DEMO'));
    expect(textOf(tree, 'home-headline-amount')).toBe('∂123.45');
    act(() => { tree.unmount(); });
  });

  test('the home rail names the CURRENCY with the Main label, amount still in the token unit', () => {
    const tree = mountHome({selectedAsset: VCHF});
    expect(textOf(tree, 'home-headline-label')).toBe(M.wallet.homeCurrency.mainLabel(M.wallet.homeCurrency.name[HOME]));
    expect(textOf(tree, 'home-headline-amount')).toBe('1.20 VCHF');
    act(() => { tree.unmount(); });
  });

  test('offline OUTRANKS the main label — never a main-currency reading over a stale figure', () => {
    const tree = mountHome({selectedAsset: VCHF, online: false, balances: balancesFor({online: false})});
    expect(textOf(tree, 'home-headline-label')).toBe(M.wallet.balance.approx(M.wallet.homeCurrency.name[HOME]));
    expect(textOf(tree, 'home-headline-label')).not.toContain('Main');
    act(() => { tree.unmount(); });
  });

  test('offline approx also applies to a non-home selection', () => {
    const tree = mountHome({online: false, balances: balancesFor({online: false})});
    expect(textOf(tree, 'home-headline-label')).toBe(M.wallet.balance.approx('DEMO'));
    act(() => { tree.unmount(); });
  });

  test('a selection that is the home CURRENCY but not the home RAIL keeps the plain asset label', () => {
    // USD is the bundled two-rail case: ckUSDC@IC is the preferred rail, USDC@Solana shares the
    // currency. Selecting the Solana half must NOT earn the Main label — "US dollars · Main" over
    // a Solana balance would misname which rail holds the money.
    const usdcSol = ASSETS.find(a => a.id === 'solana:USDC')!;
    const tree = mountHome({
      homeCurrency: 'USD',
      homeAsset: preferredRail('USD', ASSETS),
      selectedAsset: usdcSol,
      balances: balancesFor(),
    });
    expect(textOf(tree, 'home-headline-label')).toBe(M.wallet.balance.of('USDC·Sol'));
    expect(textOf(tree, 'home-headline-label')).not.toContain('Main');
    act(() => { tree.unmount(); });
  });
});

describe('HomeTab — the capability-dispatched action row', () => {
  test('DEMO add-money fires the faucet, not the deposit surface', () => {
    const onTopUp = jest.fn();
    const onDeposit = jest.fn();
    const tree = mountHome({onTopUp, onDeposit});
    act(() => { pressable(tree, 'btn-home-add-money').props.onPress(); });
    expect(onTopUp).toHaveBeenCalledTimes(1);
    expect(onDeposit).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('a real asset\'s add-money lands the deposit surface for THAT asset', () => {
    const onTopUp = jest.fn();
    const onDeposit = jest.fn();
    const tree = mountHome({selectedAsset: VCHF, onTopUp, onDeposit});
    act(() => { pressable(tree, 'btn-home-add-money').props.onPress(); });
    expect(onDeposit).toHaveBeenCalledWith(VCHF.id);
    expect(onTopUp).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('add-money is disabled while the faucet is busy (the Balances row\'s rule)', () => {
    const tree = mountHome({topUpBusy: true});
    expect(pressable(tree, 'btn-home-add-money').props.disabled).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('a faucet failure renders the honest error line — DEMO-scoped, like the Balances row', () => {
    const err = M.wallet.faucet.unavailableOnRelay;
    const tree = mountHome({topUpErr: err});
    expect(textOf(tree, 'home-faucet-err')).toBe(err);
    act(() => { tree.unmount(); });
    const real = mountHome({selectedAsset: VCHF, topUpErr: err});
    expect(testIDs(real)).not.toContain('home-faucet-err');
    act(() => { real.unmount(); });
  });

  test('Pay and Receive navigate by mode switch, not by asset capability', () => {
    const onPay = jest.fn();
    const onReceive = jest.fn();
    const tree = mountHome({selectedAsset: VCHF, onPay, onReceive});
    act(() => { pressable(tree, 'btn-home-pay').props.onPress(); });
    act(() => { pressable(tree, 'btn-home-receive').props.onPress(); });
    expect(onPay).toHaveBeenCalledTimes(1);
    expect(onReceive).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });
});

describe('HomeTab — the inline accounts list (O4 S3, the retired Balances sheet)', () => {
  test('every row renders under home-accounts; tapping a row hands the id to onSelect', () => {
    const onSelect = jest.fn();
    const tree = mountHome({onSelect});
    expect(testIDs(tree)).toContain('home-accounts');
    // The DEMO row keeps its faucet button; a row select fires the ONE selection callback with
    // that row's id (Wallet owns the lock gate — the Home tab never re-implements it).
    expect(testIDs(tree)).toContain('btn-topup');
    const row = pressable(tree, 'asset-vchf-select');
    act(() => { row.props.onPress(); });
    expect(onSelect).toHaveBeenCalledWith('ic:7');
    act(() => { tree.unmount(); });
  });
});

describe('HomeTab — the inline activity feed', () => {
  test('renders the first 3 ledger rows in their own token units, capped', () => {
    const history = [
      txn('ic:0', '2500', TS, {memo: 'newest'}),
      txn('solana:SOL', '1000000000', TS - 100, {dir: 'in'}),
      txn('ic:7', '120000000', TS - 200),
      txn('ic:0', '100', TS - 300),
      txn('ic:0', '200', TS - 400),
    ];
    const tree = mountHome({history});
    const all = texts(tree);
    expect(all).toContain('−∂25.00');
    expect(all).toContain('+1 SOL');
    expect(all).toContain('−1.20 VCHF');
    const ids = testIDs(tree);
    expect(ids).toContain('home-hist-time-0');
    expect(ids).toContain('home-hist-time-2');
    expect(ids).not.toContain('home-hist-time-3');
    // The Ledger's own anchors are never reused on this surface.
    expect(ids.some(id => id.startsWith('hist-'))).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('an empty ledger renders the honest empty line plus the See-all link', () => {
    const tree = mountHome({history: []});
    expect(texts(tree)).toContain(M.wallet.home.activity.empty);
    expect(testIDs(tree)).toContain('btn-home-activity-all');
    act(() => { tree.unmount(); });
  });

  test('See all hands off to the Transactions tab', () => {
    const onSeeAll = jest.fn();
    const tree = mountHome({history: [txn('ic:0', '100', TS)], onSeeAll});
    act(() => { pressable(tree, 'btn-home-activity-all').props.onPress(); });
    expect(onSeeAll).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });
});
