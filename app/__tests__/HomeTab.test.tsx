/**
 * HomeTab — the LANDING surface since 2026-09-08. Three contracts are pinned here:
 *
 *   • The HEADLINE is the HOME CURRENCY's, always. It names the currency ("Swiss francs · Main")
 *     over the home rail's own token unit, and the offline approximation marker OUTRANKS the main
 *     label — naming the currency changes the NAME, never the online/offline distinction. What it
 *     does NOT do is follow the transient selection: that was X4, where any account tap or rail
 *     toggle silently rewrote the setting onboarding exists to establish.
 *   • The action row is three EQUAL cards since 2026-09-14 (founder killed the oversized "Scan to
 *     pay" button): Pay is honestly named — the screen behind it scans, taps and beams — and lands
 *     the camera; Receive navigates; Add money acts on the HOME RAIL — the account the screen is
 *     showing — so nothing on Home moves money in or out of an account the screen is not naming.
 *   • The accounts LIST is not here (it is the accounts route — HomeAccounts.test.tsx); the
 *     AFFORDANCE is the headline block itself since 2026-09-14 (founder: "if the user clicks on
 *     the balance, they should be taken to the accounts and balances") — the whole eyebrow+amount
 *     block is the button, carrying `btn-home-accounts`.
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
    counterparty: 'aaaaa-aa',
    ledgerRef: '4211',
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

/** All rendered text INSIDE the node carrying `testID` (for wrappers that hold an icon + a line). */
function textUnder(tree: renderer.ReactTestRenderer, testID: string): string {
  const node = tree.root.find(n => n.props?.testID === testID);
  return node.findAllByType(Text).map(t => String(t.props.children ?? '')).join('');
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
        onPay={jest.fn()}
        onReceive={jest.fn()}
        onDeposit={jest.fn()}
        onOpenAccounts={jest.fn()}
        onSeeAll={jest.fn()}
        onOpenReceipt={jest.fn()}
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
    // approx marks the DEMO read stale the way the wallet's 60 s rule does (2026-09-15).
    const tree = mountHome({online: false, balances: balancesFor({approx: {'ic:0': true}})});
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

// The landing screen's largest number is the one most worth being honest about. Until now Home
// rendered `displayText ?? '—'` with no status branch at all, so an endpoint refusing this wallet
// (the measured HTTP 429) and a first poll still in flight printed the identical dash. The
// accounts route has told that apart since flow 147; this is the same fact, said by the same
// renderer, on the screen the user actually lands on.
describe('HomeTab — an UNREADABLE home rail says so (M2)', () => {
  const EUR_RAIL = preferredRail('EUR', ASSETS);
  // The preferred EUR rail is EURC on Solana — the only family whose balance can report 'error'
  // at all (an IC read either answers or leaves the wallet offline). If the catalog ever moves EUR
  // onto another rail this narrowing fails loudly rather than silently testing nothing.
  const EUR_MINT = EUR_RAIL?.protocol === 'solana' ? EUR_RAIL.mint : null;

  /** The EUR home rail with its endpoint refusing — the outage this copy exists for. */
  const eurUnreadable = () => balancesFor({
    tokenStates: {[EUR_MINT ?? '']: {amount: null, decimals: null, status: 'error'}},
  });

  test('a refusing endpoint grows the network line under the headline — the dash is not the whole story', () => {
    const tree = mountHome({homeCurrency: 'EUR', homeAsset: EUR_RAIL, balances: eurUnreadable()});
    expect(textOf(tree, 'home-headline-amount')).toBe('—');
    expect(textUnder(tree, 'rail-unreadable-solana')).toBe(M.errors.rail.unreadable('Solana'));
    act(() => { tree.unmount(); });
  });

  test('the line is the ACCOUNTS route\'s, word for word — one fact, one owner', () => {
    // If these two ever diverge, one of them was re-worded in place instead of the shared source.
    const tree = mountHome({homeCurrency: 'EUR', homeAsset: EUR_RAIL, balances: eurUnreadable()});
    const line = textUnder(tree, 'rail-unreadable-solana');
    expect(line).toContain('Solana');
    expect(line).toContain('Nothing moved');
    expect(line).toContain('other accounts still work');
    expect(line).toContain('keeps retrying');
    act(() => { tree.unmount(); });
  });

  test('a readable rail says nothing, and neither does a rail still loading', () => {
    const loading = mountHome({homeCurrency: 'EUR', homeAsset: EUR_RAIL, balances: balancesFor()});
    expect(testIDs(loading)).not.toContain('rail-unreadable-solana');
    act(() => { loading.unmount(); });
    const ok = mountHome(); // CHF/VCHF, a real balance
    expect(testIDs(ok).filter(id => id.startsWith('rail-unreadable-'))).toEqual([]);
    act(() => { ok.unmount(); });
  });

  test('no home rail at all cannot name a network, so it says nothing', () => {
    const tree = mountHome({homeAsset: null, balances: eurUnreadable()});
    expect(testIDs(tree).filter(id => id.startsWith('rail-unreadable-'))).toEqual([]);
    act(() => { tree.unmount(); });
  });
});

describe('HomeTab — the accounts affordance IS the headline (2026-09-14)', () => {
  test('the balance block opens the accounts route — labelled with the ACTION, never a re-read of the balance', () => {
    const onOpenAccounts = jest.fn();
    const tree = mountHome({onOpenAccounts});
    // The whole eyebrow+amount block is the button; its accessible name states what the tap DOES
    // (a second copy of the balance would be an announcement with no action attached to it).
    const btn = tree.root.findAll(n => n.props?.testID === 'btn-home-accounts')[0]!;
    expect(String(btn.props.accessibilityLabel)).toBe(M.wallet.home.accounts.openLabel);
    expect(String(btn.props.accessibilityHint)).toBe(M.wallet.home.accounts.openHint);
    // The amount stays inside the tappable — the founder's rule was that TAPPING THE BALANCE is
    // the gesture, so shrinking the target to the pill again would quietly undo it. (findAll
    // counts the Text wrapper AND its host instance — presence, not count, is the contract.)
    expect(btn.findAll(n => n.props?.testID === 'home-headline-amount').length).toBeGreaterThan(0);
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

describe('HomeTab — the action row is three EQUAL cards (2026-09-14)', () => {
  test('Pay is honestly named and hands off to the pay screen (the one-tap till gesture)', () => {
    const onPay = jest.fn();
    const tree = mountHome({onPay});
    const btn = pressable(tree, 'btn-home-pay');
    // The label is "Pay", never "Scan to pay" — the screen behind it scans, taps and beams.
    expect(String(btn.props.accessibilityLabel)).toBe(M.wallet.home.actions.pay);
    expect(M.wallet.home.actions.pay).not.toContain('Scan');
    act(() => { btn.props.onPress(); });
    expect(onPay).toHaveBeenCalledTimes(1);
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
