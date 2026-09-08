/**
 * HomeTab — the LANDING surface since 2026-09-08. Three contracts are pinned here:
 *
 *   • The HEADLINE is the HOME CURRENCY's, always. It names the currency ("Swiss francs · Main")
 *     over the home rail's own token unit, and the offline approximation marker OUTRANKS the main
 *     label — naming the currency changes the NAME, never the online/offline distinction. What it
 *     does NOT do is follow the transient selection: that was X4, where any account tap or rail
 *     toggle silently rewrote the setting onboarding exists to establish.
 *   • SCAN is the primary action and lands the camera; Receive navigates; Add money acts on the
 *     HOME RAIL — the account the screen is showing — so nothing on Home moves money in or out of
 *     an account the screen is not naming.
 *   • The accounts LIST is not here (it is the accounts route — HomeAccounts.test.tsx); Home
 *     carries only the affordance that opens it, labelled with the count.
 *
 * The activity feed is capped at ACTIVITY_ROWS rows of the merged ledger, rendered through the
 * same HistoryRow as the Transactions tab but under its OWN home-hist-* testIDs.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {ACTIVITY_ROWS, HomeTab} from '../components/HomeTab';
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
        balances={balancesFor()}
        catalog={CATALOG}
        homeCurrency={HOME}
        homeAsset={HOME_RAIL}
        online={true}
        history={[]}
        topUpErr={null}
        onScan={jest.fn()}
        onReceive={jest.fn()}
        onDeposit={jest.fn()}
        onOpenAccounts={jest.fn()}
        onSeeAll={jest.fn()}
        {...props}
      />,
    );
  });
  return tree;
}

describe('HomeTab — the headline is the home currency (X4)', () => {
  test('names the CURRENCY with the Main label over the home rail\'s own token unit', () => {
    const tree = mountHome();
    expect(textOf(tree, 'home-headline-label')).toBe(M.wallet.homeCurrency.mainLabel(M.wallet.homeCurrency.name[HOME]));
    expect(textOf(tree, 'home-headline-amount')).toBe('1.20 VCHF');
    act(() => { tree.unmount(); });
  });

  test('the DEMO balance never reaches the headline, however big it is', () => {
    // X4's exact shape: the wallet holds ∂123.45 of practice money and 1.20 VCHF of the currency
    // it was set up in. The headline is the francs — the practice pile is not the user's money
    // and, more to the point, is not the currency they chose.
    const tree = mountHome();
    expect(textOf(tree, 'home-headline-amount')).not.toContain('∂');
    act(() => { tree.unmount(); });
  });

  test('the home currency changes the headline; nothing else can', () => {
    const tree = mountHome({homeCurrency: 'USD', homeAsset: preferredRail('USD', ASSETS)});
    expect(textOf(tree, 'home-headline-label')).toBe(M.wallet.homeCurrency.mainLabel(M.wallet.homeCurrency.name.USD));
    act(() => { tree.unmount(); });
  });

  test('offline OUTRANKS the main label — never a main-currency reading over a stale figure', () => {
    const tree = mountHome({online: false, balances: balancesFor({online: false})});
    expect(textOf(tree, 'home-headline-label')).toBe(M.wallet.balance.approx(M.wallet.homeCurrency.name[HOME]));
    expect(textOf(tree, 'home-headline-label')).not.toContain('Main');
    act(() => { tree.unmount(); });
  });

  test('a currency the catalog cannot realise shows "—", never a borrowed number', () => {
    const tree = mountHome({homeAsset: null});
    expect(textOf(tree, 'home-headline-amount')).toBe('—');
    act(() => { tree.unmount(); });
  });
});

describe('HomeTab — the accounts affordance', () => {
  test('names the account COUNT and opens the accounts route', () => {
    const onOpenAccounts = jest.fn();
    const tree = mountHome({onOpenAccounts});
    // Both the rendered label and the accessible name carry the count — one string, one source.
    const btn = tree.root.findAll(n => n.props?.testID === 'btn-home-accounts')[0]!;
    expect(btn.findAllByType(Text).map(n => String(n.props.children)).join(' ')).toContain(String(ASSETS.length));
    expect(String(btn.props.accessibilityLabel)).toContain(String(ASSETS.length));
    act(() => { pressable(tree, 'btn-home-accounts').props.onPress(); });
    expect(onOpenAccounts).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('the accounts LIST itself is not on Home — no row, no faucet, no testnet toggle', () => {
    const ids = testIDs(mountHome());
    for (const gone of ['accounts-list', 'home-accounts', 'asset-vchf', 'asset-demo', 'btn-topup', 'btn-toggle-testnet', 'btn-home-convert']) {
      expect(ids).not.toContain(gone);
    }
  });
});

describe('HomeTab — the action row', () => {
  test('Scan is present and hands off to the scanner (the one-tap till gesture)', () => {
    const onScan = jest.fn();
    const tree = mountHome({onScan});
    act(() => { pressable(tree, 'btn-home-scan').props.onPress(); });
    expect(onScan).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('Receive navigates by mode switch, not by asset capability', () => {
    const onReceive = jest.fn();
    const tree = mountHome({onReceive});
    act(() => { pressable(tree, 'btn-home-receive').props.onPress(); });
    expect(onReceive).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('Add money funds the HOME RAIL — the account the headline is showing', () => {
    const onDeposit = jest.fn();
    const tree = mountHome({onDeposit});
    act(() => { pressable(tree, 'btn-home-add-money').props.onPress(); });
    expect(onDeposit).toHaveBeenCalledWith(HOME_RAIL!.id);
    act(() => { tree.unmount(); });
  });

  test('Add money is disabled — and fires nothing — when the currency has no rail', () => {
    const onDeposit = jest.fn();
    const tree = mountHome({homeAsset: null, onDeposit});
    const btn = pressable(tree, 'btn-home-add-money');
    expect(btn.props.disabled).toBe(true);
    act(() => { btn.props.onPress(); });
    expect(onDeposit).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('a faucet failure is surfaced on Home — the T hotkey fires from here and must not fail silently', () => {
    const err = M.wallet.faucet.unavailableOnRelay;
    const tree = mountHome({topUpErr: err});
    expect(textOf(tree, 'home-faucet-err')).toBe(err);
    act(() => { tree.unmount(); });
    const quiet = mountHome();
    expect(testIDs(quiet)).not.toContain('home-faucet-err');
    act(() => { quiet.unmount(); });
  });
});

describe('HomeTab — the inline activity feed', () => {
  test(`renders the first ${ACTIVITY_ROWS} ledger rows in their own token units, capped`, () => {
    const history = Array.from({length: ACTIVITY_ROWS + 2}, (_, i) => txn('ic:0', `${(i + 1) * 100}`, TS - i * 100));
    const tree = mountHome({
      history: [
        txn('ic:0', '2500', TS, {memo: 'newest'}),
        txn('solana:SOL', '1000000000', TS - 100, {dir: 'in'}),
        txn('ic:7', '120000000', TS - 200),
        ...history.slice(3),
      ],
    });
    const all = texts(tree);
    expect(all).toContain('−∂25.00');
    expect(all).toContain('+1 SOL');
    expect(all).toContain('−1.20 VCHF');
    const ids = testIDs(tree);
    expect(ids).toContain('home-hist-time-0');
    expect(ids).toContain(`home-hist-time-${ACTIVITY_ROWS - 1}`);
    expect(ids).not.toContain(`home-hist-time-${ACTIVITY_ROWS}`);
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
