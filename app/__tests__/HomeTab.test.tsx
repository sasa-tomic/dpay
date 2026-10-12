/**
 * HomeTab — the LANDING surface, currency-first (2026-09-24 redesign). Three contracts are pinned:
 *
 *   • The HEADLINE is the founder sketch verbatim: the eyebrow names the MAIN currency as its
 *     short code ("Balance CHF") and the amount is that currency's SUMMED balance in the CURRENCY
 *     unit ("1.20 Fr" — forks #2 + #4; the sum itself is buildCurrencyBalances' contract, tested
 *     in currencyBalances.test.ts). The offline approximation marker OUTRANKS everything — a
 *     wallet that is not connected renders its best-known figure, marked. The DEMO balance never
 *     reaches the headline (practice money is not the user's currency).
 *   • The action row is fork #1's three cells: Add funds / Withdraw funds / [...]. Convert is
 *     NOT in the row any more (founder 2026-10-05): ONE Convert button sits at the TOP RIGHT of
 *     the screen, above the headline, and opens the convert sheet with NO preset source - the
 *     sheet's own FROM selector (funded currencies only) makes the source explicit. The money
 *     actions disable together when the catalog cannot realise the currency or a setup run owns
 *     the money movement. The [...] opens the overflow menu (Wallet owns the sheet; the menu's
 *     guard logic is tested in currency.test.ts).
 *   • The currency LIST is not here (it is the accounts route — HomeAccounts.test.tsx); the
 *     AFFORDANCE is the headline block itself (`btn-home-accounts`, kept from 2026-09-14).
 *
 * The activity feed is capped at ACTIVITY_ROWS rows of the merged ledger, rendered through the
 * same HistoryRow as the Transactions tab but under its OWN home-hist-* testIDs.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Linking, Text} from 'react-native';
import {ACTIVITY_ROWS, HomeTab} from '../components/HomeTab';
import {AtaSetupCard} from '../components/AtaSetupCard';
import {buildSelectableAssets} from '../config/assets';
import {buildAssetBalances, buildCurrencyBalances} from '../lib/assetBalances';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {offerableCurrencies, preferredRail} from '../config/currency';
import {M} from '../i18n';
import type {AssetId, Txn} from '../lib/types';
import type {BalanceView} from '../lib/assetBalances';

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {
  showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: BUNDLED_NETWORKS,
});
const VISIBLE = offerableCurrencies(ASSETS);
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

function viewsFor(over: Partial<Parameters<typeof buildAssetBalances>[0]> = {}) {
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

/** The per-currency sums, from the same views — the Wallet pipeline in miniature. */
function sumsFor(
  views: Readonly<Partial<Record<AssetId, BalanceView>>>,
  over: Partial<Parameters<typeof buildCurrencyBalances>[0]> = {},
) {
  return buildCurrencyBalances({
    currencies: VISIBLE,
    assets: ASSETS,
    catalog: CATALOG,
    views,
    icBalances: {7: '120000000'},
    solBalance: null,
    tokenAmounts: {},
    approx: {},
    ...over,
  });
}

function mountHome(props: Partial<Parameters<typeof HomeTab>[0]> = {}): renderer.ReactTestRenderer {
  const views = props.balances ?? viewsFor();
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <HomeTab
        assets={ASSETS}
        balances={views}
        currencyBalances={sumsFor(views)}
        catalog={CATALOG}
        homeCurrency={HOME}
        homeAsset={HOME_RAIL}
        online={true}
        history={[]}
        onDeposit={jest.fn()}
        onConvert={jest.fn()}
        onWithdraw={jest.fn()}
        onOpenMenu={jest.fn()}
        onOpenAccounts={jest.fn()}
        onSeeAll={jest.fn()}
        onOpenReceipt={jest.fn()}
        {...props}
      />,
    );
  });
  return tree;
}

describe('HomeTab - the per-currency setup card (2026-10-01 founder directive)', () => {
  const has = (tree: renderer.ReactTestRenderer, testID: string): boolean =>
    tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
  /** The view model Wallet hands over when the MAIN currency's SPL accounts are absent. */
  const ataVm = (over: Partial<Parameters<typeof AtaSetupCard>[0]> = {}) => ({
    targets: ['EURC'], kind: 'create' as const, costLine: '0.00204428 SOL', fundFromLine: null,
    minLine: null as string | null, confirming: false, confirmLine: null, busy: false,
    live: false, errNext: null as string | null, errCanRetry: true,
    solAddress: null as string | null, err: null as string | null, ...over,
  });

  test('the tapped currency hosts the card: per-currency prefix, ONE action, no wallet banner', () => {
    const onStart = jest.fn();
    const tree = mountHome({
      homeCurrency: 'EUR', homeAsset: preferredRail('EUR', ASSETS),
      ataSetup: ataVm(), onAtaSetupStart: onStart,
    });
    expect(has(tree, 'ata-setup-EUR-banner')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-complete')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-confirm-btn')).toBe(false);
    act(() => { pressable(tree, 'ata-setup-EUR-complete').props.onPress(); });
    expect(onStart).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('a running setup masks the money actions; navigation stays live', () => {
    const tree = mountHome({
      homeCurrency: 'EUR', homeAsset: preferredRail('EUR', ASSETS),
      ataSetup: ataVm({kind: 'fund-ic', busy: true}),
    });
    expect(pressable(tree, 'btn-home-convert').props.disabled).toBe(true);
    expect(pressable(tree, 'btn-home-add-funds').props.disabled).toBe(true);
    expect(pressable(tree, 'btn-home-withdraw').props.disabled).toBe(true);
    expect(pressable(tree, 'btn-home-more').props.disabled).toBeFalsy();
    act(() => { tree.unmount(); });
  });

  test('a LIVE record masks the money actions exactly like a busy run (2026-10-02 P0)', () => {
    // The run's own busy flag clears long before the record resolves - the live record IS
    // the run from then on, so the action row must stand down on it too.
    const tree = mountHome({
      homeCurrency: 'EUR', homeAsset: preferredRail('EUR', ASSETS),
      ataSetup: ataVm({kind: 'fund-ic', live: true}),
    });
    expect(pressable(tree, 'btn-home-convert').props.disabled).toBe(true);
    expect(pressable(tree, 'btn-home-add-funds').props.disabled).toBe(true);
    expect(pressable(tree, 'btn-home-withdraw').props.disabled).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('no view model, no card - a currency whose accounts exist renders nothing extra', () => {
    const tree = mountHome();
    expect(has(tree, 'ata-setup-EUR-banner')).toBe(false);
    expect(has(tree, 'ata-setup-CHF-banner')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('the idle card states the measured minimum up front, ONE cost line', () => {
    const tree = mountHome({
      homeCurrency: 'EUR', homeAsset: preferredRail('EUR', ASSETS),
      ataSetup: ataVm({kind: 'fund-ic', minLine: 'Needs ≈ 0.09 VCHF.'}),
    });
    const banner = textUnder(tree, 'ata-setup-EUR-banner');
    expect(banner).toContain('0.09 VCHF');
    expect(banner).not.toContain('Costs 0.00204428 SOL');
    act(() => { tree.unmount(); });
  });

  test('the swap confirm rides the same card; refuse stays the honest dead end', () => {
    const onConfirm = jest.fn();
    const confirmTree = mountHome({
      homeCurrency: 'EUR', homeAsset: preferredRail('EUR', ASSETS),
      ataSetup: ataVm({kind: 'fund-ic', confirming: true, confirmLine: 'Swaps ≈ 0.09 VCHF.'}),
      onAtaSetupConfirm: onConfirm,
    });
    expect(has(confirmTree, 'ata-setup-EUR-confirm-btn')).toBe(true);
    expect(has(confirmTree, 'ata-setup-EUR-complete')).toBe(false);
    act(() => { pressable(confirmTree, 'ata-setup-EUR-confirm-btn').props.onPress(); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    act(() => { confirmTree.unmount(); });

    const refuseTree = mountHome({
      homeCurrency: 'EUR', homeAsset: preferredRail('EUR', ASSETS),
      ataSetup: ataVm({kind: 'refuse', solAddress: 'DpaySoLAddress11111111111111111111111111'}),
      onAtaSetupShowSol: jest.fn(),
    });
    expect(has(refuseTree, 'ata-setup-EUR-refuse')).toBe(true);
    expect(has(refuseTree, 'ata-setup-EUR-complete')).toBe(false);
    act(() => { refuseTree.unmount(); });
  });
});

describe('HomeTab — the headline is the founder sketch (forks #2 + #4)', () => {
  test('eyebrow names the SHORT code, amount is the summed CURRENCY-unit figure', () => {
    const tree = mountHome();
    expect(textOf(tree, 'home-headline-label')).toBe(M.wallet.home.balanceEyebrow('CHF'));
    expect(textOf(tree, 'home-headline-label')).toBe('Balance CHF');
    // 1.20 VCHF summed into the CHF unit — "1.20 Fr", the sketch's "4,54 Fr" grammar.
    expect(textOf(tree, 'home-headline-amount')).toBe('1.20 Fr');
    act(() => { tree.unmount(); });
  });

  test('the DEMO balance never reaches the headline, however big it is', () => {
    const tree = mountHome();
    expect(textOf(tree, 'home-headline-amount')).not.toContain('∂');
    act(() => { tree.unmount(); });
  });

  test('a token-currency main renders its token unit — currency == token there', () => {
    const btcRail = preferredRail('BTC', ASSETS)!;
    const views = viewsFor({icBalances: {1: '50000'}});
    const tree = mountHome({
      homeCurrency: 'BTC', homeAsset: btcRail, balances: views,
      currencyBalances: sumsFor(views, {icBalances: {1: '50000'}}),
    });
    expect(textOf(tree, 'home-headline-label')).toBe('Balance BTC');
    expect(textOf(tree, 'home-headline-amount')).toBe('0.0005 BTC');
    act(() => { tree.unmount(); });
  });

  test('offline OUTRANKS the eyebrow — the marker wraps the whole line, never a confident figure', () => {
    const tree = mountHome({online: false, balances: viewsFor({approx: {'ic:7': true}})});
    expect(textOf(tree, 'home-headline-label')).toBe(M.wallet.balance.approx(M.wallet.home.balanceEyebrow('CHF')));
    expect(textOf(tree, 'home-headline-label')).toContain('~');
    act(() => { tree.unmount(); });
  });

  test('a currency the catalog cannot realise shows "—", never a borrowed number', () => {
    const tree = mountHome({homeAsset: null, homeCurrency: 'EUR'});
    expect(textOf(tree, 'home-headline-amount')).toBe('—');
    act(() => { tree.unmount(); });
  });
});

// The landing screen's largest number is the one most worth being honest about. An unreadable
// rail (the measured HTTP 429) and a first poll in flight printed the identical dash until flow
// 147's renderer took over; Home says the same fact the accounts route says.
describe('HomeTab — an UNREADABLE home rail says so (M2)', () => {
  const EUR_RAIL = preferredRail('EUR', ASSETS);
  const EUR_MINT = EUR_RAIL?.protocol === 'solana' ? EUR_RAIL.mint : null;

  /** The preferred EUR rail with its endpoint refusing — the outage this copy exists for. */
  const eurUnreadable = (): ReturnType<typeof viewsFor> => viewsFor({
    tokenStates: {[EUR_MINT ?? '']: {amount: null, decimals: null, status: 'error'}},
  });

  test('a refusing endpoint grows the network line under the headline — the dash is not the whole story', () => {
    const tree = mountHome({homeCurrency: 'EUR', homeAsset: EUR_RAIL, balances: eurUnreadable()});
    expect(textOf(tree, 'home-headline-amount')).toBe('—');
    expect(textUnder(tree, 'rail-unreadable-solana')).toBe(M.errors.rail.unreadable('Solana'));
    act(() => { tree.unmount(); });
  });

  test('the line is the ACCOUNTS route\'s, word for word — one fact, one owner', () => {
    const tree = mountHome({homeCurrency: 'EUR', homeAsset: EUR_RAIL, balances: eurUnreadable()});
    const line = textUnder(tree, 'rail-unreadable-solana');
    expect(line).toContain('Solana');
    expect(line).toContain('balances outdated');
    expect(line).toContain('keeps retrying');
    act(() => { tree.unmount(); });
  });

  test('a readable rail says nothing, and neither does a rail still loading', () => {
    const loading = mountHome({homeCurrency: 'EUR', homeAsset: EUR_RAIL});
    expect(testIDs(loading)).not.toContain('rail-unreadable-solana');
    act(() => { loading.unmount(); });
    const ok = mountHome(); // CHF/VCHF, a real balance
    expect(testIDs(ok).filter(id => id.startsWith('rail-unreadable-'))).toEqual([]);
    act(() => { ok.unmount(); });
  });

  test('no home rail at all cannot name a network, so it says nothing', () => {
    const tree = mountHome({homeAsset: null, homeCurrency: 'EUR', balances: eurUnreadable()});
    expect(testIDs(tree).filter(id => id.startsWith('rail-unreadable-'))).toEqual([]);
    act(() => { tree.unmount(); });
  });
});

describe('HomeTab — the accounts affordance IS the headline (kept from 2026-09-14)', () => {
  test('the balance block opens the currency list — labelled with the ACTION, never a re-read of the balance', () => {
    const onOpenAccounts = jest.fn();
    const tree = mountHome({onOpenAccounts});
    const btn = tree.root.findAll(n => n.props?.testID === 'btn-home-accounts')[0]!;
    expect(String(btn.props.accessibilityLabel)).toBe(M.wallet.home.accounts.openLabel);
    expect(btn.props.accessibilityHint).toBeUndefined();
    expect(btn.findAll(n => n.props?.testID === 'home-headline-amount').length).toBeGreaterThan(0);
    act(() => { pressable(tree, 'btn-home-accounts').props.onPress(); });
    expect(onOpenAccounts).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('the currency LIST itself is not on Home — no rows, no faucet, no testnet toggle', () => {
    const ids = testIDs(mountHome());
    for (const gone of ['accounts-list', 'home-accounts', 'asset-vchf', 'asset-demo', 'btn-topup', 'btn-toggle-testnet', 'accounts-currency-CHF']) {
      expect(ids).not.toContain(gone);
    }
  });
});

describe('HomeTab — ONE Convert at the top right, the action row is Add funds / Withdraw / [...] (founder 2026-10-05)', () => {
  test('Pay and Receive are NOT on Home — they live on the bottom tabs, unchanged', () => {
    const ids = testIDs(mountHome());
    for (const gone of ['btn-home-pay', 'btn-home-receive', 'btn-home-add-money']) {
      expect(ids).not.toContain(gone);
    }
  });

  test('EXACTLY ONE Convert button, rendered at the TOP RIGHT — above the headline, before every action cell', () => {
    const tree = mountHome();
    const ids = testIDs(tree);
    expect(ids).toContain('btn-home-convert');
    // Render order: the Convert row is HomeTab's FIRST child — above the headline affordance
    // and above the action row (the RN preset mirrors nodes 2x; order still holds).
    const raw = tree.root.findAll(n => typeof n.props?.testID === 'string').map(n => String(n.props.testID));
    expect(raw.indexOf('btn-home-convert')).toBeLessThan(raw.indexOf('btn-home-accounts'));
    expect(raw.indexOf('btn-home-convert')).toBeLessThan(raw.indexOf('btn-home-add-funds'));
    expect(raw.indexOf('btn-home-convert')).toBeLessThan(raw.indexOf('btn-home-withdraw'));
    act(() => { tree.unmount(); });
  });

  test('the Convert label is the plain i18n verb; a press opens the convert sheet', () => {
    const onConvert = jest.fn();
    const tree = mountHome({onConvert});
    expect(String(pressable(tree, 'btn-home-convert').props.accessibilityLabel)).toBe(M.wallet.home.actions.convert);
    act(() => { pressable(tree, 'btn-home-convert').props.onPress(); });
    expect(onConvert).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('Add funds funds the MAIN RAIL — the account the headline is showing', () => {
    const onDeposit = jest.fn();
    const tree = mountHome({onDeposit});
    act(() => { pressable(tree, 'btn-home-add-funds').props.onPress(); });
    expect(onDeposit).toHaveBeenCalledWith(HOME_RAIL!.id);
    act(() => { tree.unmount(); });
  });

  test('Withdraw funds hands off to the off-ramp surface', () => {
    const onWithdraw = jest.fn();
    const tree = mountHome({onWithdraw});
    act(() => { pressable(tree, 'btn-home-withdraw').props.onPress(); });
    expect(onWithdraw).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('[...] opens the overflow menu — Wallet owns the sheet', () => {
    const onOpenMenu = jest.fn();
    const tree = mountHome({onOpenMenu});
    act(() => { pressable(tree, 'btn-home-more').props.onPress(); });
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('the money actions disable when the currency has no rail; the menu stays live', () => {
    const onDeposit = jest.fn();
    const tree = mountHome({homeAsset: null, onDeposit});
    // A disabled Pressable never fires at runtime (the test renderer invokes raw handlers, so
    // the disabled PROP is the assertion — the component must not rely on handler-side guards).
    expect(pressable(tree, 'btn-home-add-funds').props.disabled).toBe(true);
    expect(pressable(tree, 'btn-home-convert').props.disabled).toBe(true);
    expect(pressable(tree, 'btn-home-withdraw').props.disabled).toBe(true);
    // The menu affordance is navigation, not money movement — it stays live.
    expect(pressable(tree, 'btn-home-more').props.disabled).toBeFalsy();
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

  test('an empty ledger still offers the See-all link — no narrating empty line (verbosity pass 2026-09-17)', () => {
    const tree = mountHome({history: []});
    expect(texts(tree)).not.toContain('No payments yet.');
    expect(testIDs(tree)).not.toContain('home-hist-time-0');
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

describe('HomeTab — the Add-funds buy route (plan R1 step 3)', () => {
  /** A buy-eligible headline: an EVM catalog row with a delivery chain in MTP_ASSET_DELIVERY. */
  const evmRow = {
    id: 'evm:42161:ZCHF' as const, protocol: 'evm' as const, token: 'ZCHF', symbol: 'ZCHF',
    chainId: 42161, chainName: 'Arbitrum One', address: '0x1111111111111111111111111111111111111111',
    linkToken: 'ZCHF', networkLabel: 'ZCHF · Arbitrum One', network: 'Arbitrum One', decimals: 18,
    minFractionDigits: 2, liquidity: null, onramp: 'Unavailable' as const, offramp: 'Unavailable' as const,
    rampPartner: null, visible: true, testKey: 'evm-zchf-arbitrum', testnet: false,
  };
  const base = {
    homeCurrency: 'CHF' as const, assets: ASSETS, online: true, history: [],
  };

  test('onBuy present: the Add-funds press routes to the buy opener, never the deposit trip', () => {
    const onBuy = jest.fn();
    const onDeposit = jest.fn();
    const tree = mountHome({...base, homeAsset: evmRow, onDeposit, onBuy});
    act(() => { pressable(tree, 'btn-home-add-funds').props.onPress(); });
    expect(onBuy).toHaveBeenCalledTimes(1);
    expect(onDeposit).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('onBuy absent (or a non-EVM headline): the press is the deposit trip, byte-unchanged', () => {
    const onDeposit = jest.fn();
    const tree = mountHome({...base, homeAsset: evmRow, onDeposit});
    act(() => { pressable(tree, 'btn-home-add-funds').props.onPress(); });
    expect(onDeposit).toHaveBeenCalledWith('evm:42161:ZCHF');
    act(() => { tree.unmount(); });
  });
});

describe('HomeTab — the withdraw control goes cash-out-aware (plan R2 step 2)', () => {
  /** A cash-out-eligible headline: an EVM row with the offramp flip landed. */
  const evmCashOutRow = {
    id: 'evm:1:ZCHF' as const, protocol: 'evm' as const, token: 'ZCHF', symbol: 'ZCHF',
    chainId: 1, chainName: 'Ethereum', address: '0x2222222222222222222222222222222222222222',
    linkToken: 'ZCHF', networkLabel: 'ZCHF · Ethereum', network: 'Ethereum', decimals: 18,
    minFractionDigits: 2, liquidity: null, onramp: 'Partner' as const, offramp: 'Partner' as const,
    rampPartner: null, visible: true, testKey: 'evm-zchf-ethereum', testnet: false,
  };
  const base = {
    homeCurrency: 'CHF' as const, assets: ASSETS, online: true, history: [],
  };

  test('both props present: the Withdraw press opens the cash-out, never the pay-surface withdraw', () => {
    const onWithdraw = jest.fn();
    const onCashOut = jest.fn();
    const tree = mountHome({...base, homeAsset: evmCashOutRow, onWithdraw, onCashOut, cashOutEligible: true});
    act(() => { pressable(tree, 'btn-home-withdraw').props.onPress(); });
    expect(onCashOut).toHaveBeenCalledTimes(1);
    expect(onWithdraw).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('props absent: the press is the pay-surface withdraw, byte-identical (the harness contract)', () => {
    const onWithdraw = jest.fn();
    const tree = mountHome({...base, homeAsset: evmCashOutRow, onWithdraw});
    act(() => { pressable(tree, 'btn-home-withdraw').props.onPress(); });
    expect(onWithdraw).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('cashOutEligible without onCashOut fails closed to the withdraw path (never a dead press)', () => {
    const onWithdraw = jest.fn();
    const tree = mountHome({...base, homeAsset: evmCashOutRow, onWithdraw, cashOutEligible: true});
    act(() => { pressable(tree, 'btn-home-withdraw').props.onPress(); });
    expect(onWithdraw).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('neither optional prop renders anything new (no extra testIDs vs the bare mount)', () => {
    const bare = testIDs(mountHome(base));
    const armed = testIDs(mountHome({...base, homeAsset: evmCashOutRow, onCashOut: () => {}, cashOutEligible: true}));
    expect(armed.sort()).toEqual(bare.sort());
  });
});

describe('HomeTab — the in-app update notice (founder 2026-10-04: newer version, 1-2 clicks)', () => {
  let mockOpenURL: jest.Mock<(uri: string) => Promise<void>>;
  beforeEach(() => {
    mockOpenURL = jest.fn<(uri: string) => Promise<void>>().mockResolvedValue(undefined);
    (Linking.openURL as unknown) = mockOpenURL;
  });

  test('when the check reports a newer build: ONE line + ONE Update button; press opens the exact URL', () => {
    const url = 'https://relay.example/download/dpay.apk?v=582be6599b1cecf6eed4e6794b3f1c99';
    const tree = mountHome({updateUrl: url});
    // Presence via the Set-deduped idiom (the RN preset mirrors every node, so raw findAll
    // counts are 2x; ONE banner + ONE button is enforced by the single conditional block and
    // the ONE-openURL-per-press pin below is the behavioral half).
    const ids = testIDs(tree);
    expect(ids).toContain('update-banner');
    expect(ids).toContain('btn-update-now');
    expect(textUnder(tree, 'update-banner')).toContain('A newer version of dpay is available.');
    expect(textUnder(tree, 'btn-update-now')).toBe(M.update.action);
    act(() => { pressable(tree, 'btn-update-now').props.onPress(); });
    expect(mockOpenURL).toHaveBeenCalledTimes(1);
    expect(mockOpenURL).toHaveBeenCalledWith(url);
    act(() => { tree.unmount(); });
  });

  test('when unavailable: renders NOTHING — no banner, no button, no reserved copy', () => {
    const tree = mountHome({updateUrl: null});
    const ids = testIDs(tree);
    expect(ids).not.toContain('update-banner');
    expect(ids).not.toContain('btn-update-now');
    expect(texts(tree)).not.toContain('A newer version of dpay is available.');
    act(() => { tree.unmount(); });
  });
});
