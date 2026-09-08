/**
 * The ACCOUNTS route (`AccountsTab`) — the per-asset balance list, moved off the Home tab
 * 2026-09-08 (it was ~80% of that surface, nine of ten rows zero on a new wallet — X2). Rows are
 * byte-identical to the Home-inlined era; only the container name changed. The tests that used to
 * live here for the Home tab moved with the rows, verbatim where the contract did not change.
 *
 * The list is a PURE renderer over the Wallet-owned selection contract. What is pinned:
 *   • zero-balance VCHF/ICP rows REMAIN VISIBLE with honest "0.00 VCHF"/"0 ICP" amounts (the
 *     asset-first rule survives the move: nothing hides behind a positive balance);
 *   • the DEMO faucet (`btn-topup`) is still the only per-row funding action;
 *   • the home-currency group is MARKED, never summed: MAIN on the preferred rail, the sibling
 *     badged with its own rail line;
 *   • ORDER (X22): home rails, then funded accounts, then unfunded, then the practice rail under
 *     a divider that says in a sentence what it is;
 *   • Convert (`btn-accounts-convert`) is on the SELECTED row and nowhere else — uniform for every
 *     asset by the same gesture, with no inert buttons on the other nine.
 *
 * Uses react-test-renderer (the project's only renderer); no module mocks needed — the list is a
 * pure renderer and the assets/balances inputs are built with the REAL pure builders.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {AccountsTab, orderAccounts} from '../components/AccountsTab';
import {DEMO_ASSET_ID, buildSelectableAssets} from '../config/assets';
import {preferredRail} from '../config/currency';
import {buildAssetBalances} from '../lib/assetBalances';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {M} from '../i18n';

const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);

function mount(
  assets: ReturnType<typeof buildSelectableAssets>,
  balances: ReturnType<typeof buildAssetBalances>,
  props: Partial<Parameters<typeof AccountsTab>[0]> = {},
): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <AccountsTab
        assets={assets}
        selectedId={DEMO_ASSET_ID}
        balances={balances}
        homeCurrency="CHF"
        demoFaucetAvailable={true}
        topUpBusy={false}
        topUpErr={null}
        hasTestnet={false}
        showTestnet={false}
        onToggleTestnet={jest.fn()}
        onBack={jest.fn()}
        onSelect={jest.fn()}
        onTopUp={jest.fn()}
        onConvert={jest.fn()}
        {...props}
      />,
    );
  });
  return tree;
}

const rowText = (tree: renderer.ReactTestRenderer, testID: string): string =>
  tree.root
    .findAll(node => node.props && node.props.testID === testID)[0]!
    .findAllByType(Text)
    .map(n => n.props.children)
    .join(' ');

const has = (tree: renderer.ReactTestRenderer, testID: string): boolean =>
  tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;

const pressable = (tree: renderer.ReactTestRenderer, testID: string) =>
  tree.root.findAll(n => n.props?.testID === testID && typeof n.props.onPress === 'function')[0];

describe('AccountsTab — bundled VCHF/ICP rows (zero-balance visible, no ramp actions)', () => {
  const assets = buildSelectableAssets(BUNDLED, {showTestnet: false, solanaEnabled: false});
  // Never-polled IC balances: every IC asset (incl. VCHF/ICP) reads '0' → status 'zero' (dimmed)
  // but still renders — this is exactly the cold-start wallet state for the two new rows.
  const balances = buildAssetBalances({
    catalog: BUNDLED,
    assets,
    icBalances: {},
    primaryBalance: null,
    online: true,
    solState: {balance: null, status: 'unavailable'},
    tokenStates: {},
  });

  test('zero-balance VCHF + ICP rows remain visible with honest "0 VCHF"/"0 ICP" amounts', () => {
    const tree = mount(assets, balances);
    const vchf = rowText(tree, 'asset-vchf');
    const icp = rowText(tree, 'asset-icp');
    expect(vchf).toContain('0.00 VCHF');
    expect(icp).toContain('0 ICP');
    // The network label distinguishes the IC rows honestly (M.wallet.asset.networkLabel renders
    // "VCHF · Internet Computer" from the descriptor's own network string).
    expect(vchf).toContain('Internet Computer');
    expect(icp).toContain('Internet Computer');
    expect(vchf).not.toMatch(/Bitcoin|Ethereum/);
    act(() => { tree.unmount(); });
  });

  test('NO Add money / Cash out action is emitted for VCHF/ICP (only DEMO keeps its faucet)', () => {
    const tree = mount(assets, balances);
    // The DEMO faucet (`btn-topup`) is the list's ONLY per-row funding action: it renders inside
    // the DEMO row (findAll matches layered composite+host nodes per Pressable, so presence — not
    // count — is the assertion) and inside NEITHER direct-ICRC row.
    const demoRow = tree.root.findAll(node => node.props && node.props.testID === 'asset-demo')[0]!;
    expect(demoRow.findAll(node => node.props && node.props.testID === 'btn-topup').length).toBeGreaterThan(0);
    for (const testID of ['asset-vchf', 'asset-icp']) {
      const row = tree.root.findAll(node => node.props && node.props.testID === testID)[0]!;
      expect(row.findAll(node => node.props && node.props.testID === 'btn-topup')).toHaveLength(0);
    }
    act(() => { tree.unmount(); });
  });

  test('the container is `accounts-list`, and a row select hands its id up', () => {
    const onSelect = jest.fn();
    const tree = mount(assets, balances, {onSelect});
    expect(has(tree, 'accounts-list')).toBe(true);
    expect(has(tree, 'home-accounts')).toBe(false);
    act(() => { pressable(tree, 'asset-vchf-select').props.onPress(); });
    expect(onSelect).toHaveBeenCalledWith('ic:7');
    act(() => { tree.unmount(); });
  });

  test('Back hands off to the surface the route was entered from', () => {
    const onBack = jest.fn();
    const tree = mount(assets, balances, {onBack});
    act(() => { pressable(tree, 'btn-accounts-back').props.onPress(); });
    expect(onBack).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });
});

describe('AccountsTab — home-currency rail badges (mark every rail, never sum the group)', () => {
  // The full two-rail USD group: ckUSDC on the IC + USDC on Solana (solanaUsdc forced on so the
  // row is present regardless of the offline test loop's empty RPC URL).
  const assets = buildSelectableAssets(BUNDLED, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
  const balances = buildAssetBalances({
    catalog: BUNDLED,
    assets,
    icBalances: {},
    primaryBalance: null,
    online: true,
    solState: {balance: null, status: 'unavailable'},
    tokenStates: {},
  });

  const badgeText = (tree: renderer.ReactTestRenderer, testID: string): string =>
    tree.root
      .findAll(node => node.props && node.props.testID === testID)[0]!
      .findAllByType(Text)
      .map(n => n.props.children)
      .join(' ');

  test('home=USD: MAIN on ckUSDC only; the Solana sibling wears a badge NAMING its rail', () => {
    const tree = mount(assets, balances, {homeCurrency: 'USD'});
    // The preferred rail keeps the one MAIN badge.
    expect(has(tree, 'asset-ckusdc-main')).toBe(true);
    expect(has(tree, 'asset-sol-usdc-main')).toBe(false);
    expect(has(tree, 'asset-ckusdc-rail')).toBe(false);
    // The sibling rail's badge names the rail with the S1 rail-line vocabulary — never "MAIN".
    expect(has(tree, 'asset-sol-usdc-rail')).toBe(true);
    expect(badgeText(tree, 'asset-sol-usdc-rail')).toBe('USDC · Solana');
    // No OTHER row gains a badge: VCHF settles CHF (a different currency), ICP/ckETH settle none.
    for (const key of ['asset-vchf', 'asset-icp', 'asset-cketh', 'asset-sol', 'asset-sol-eurc', 'asset-demo']) {
      expect(has(tree, `${key}-rail`)).toBe(false);
      expect(has(tree, `${key}-main`)).toBe(false);
    }
    act(() => { tree.unmount(); });
  });

  test('home=CHF: single-rail group renders exactly as before — MAIN on VCHF, no rail badges', () => {
    const tree = mount(assets, balances, {homeCurrency: 'CHF'});
    expect(has(tree, 'asset-vchf-main')).toBe(true);
    for (const key of ['asset-vchf', 'asset-ckusdc', 'asset-sol-usdc', 'asset-icp', 'asset-cketh', 'asset-sol', 'asset-sol-eurc', 'asset-demo']) {
      expect(has(tree, `${key}-rail`)).toBe(false);
    }
    act(() => { tree.unmount(); });
  });
});

describe('AccountsTab — Convert lives on the selected row (X15)', () => {
  const assets = buildSelectableAssets(BUNDLED, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
  const balances = buildAssetBalances({
    catalog: BUNDLED, assets, icBalances: {}, primaryBalance: null, online: true,
    solState: {balance: null, status: 'unavailable'}, tokenStates: {},
  });

  test('EVERY asset reaches Convert by the SAME gesture — select the row, tap Convert', () => {
    // The uniform-IA hard rule reads on RAILS, not on button counts: no asset may have a path to
    // Convert that another asset lacks. Selecting any row puts the identical control on it.
    for (const asset of assets) {
      const onConvert = jest.fn();
      const tree = mount(assets, balances, {selectedId: asset.id, onConvert});
      const row = tree.root.findAll(n => n.props && n.props.testID === `asset-${asset.testKey}`)[0]!;
      expect(row.findAll(n => n.props?.testID === 'btn-accounts-convert').length).toBeGreaterThan(0);
      act(() => { pressable(tree, 'btn-accounts-convert').props.onPress(); });
      expect(onConvert).toHaveBeenCalledTimes(1);
      act(() => { tree.unmount(); });
    }
  });

  test('exactly ONE Convert control exists — the other nine rows carry no inert button', () => {
    const tree = mount(assets, balances, {selectedId: 'ic:7'});
    const hosts = tree.root.findAll(n => n.props?.testID === 'btn-accounts-convert' && typeof n.props.onPress === 'function');
    expect(hosts.length).toBe(1);
    const vchfRow = tree.root.findAll(n => n.props && n.props.testID === 'asset-vchf')[0]!;
    expect(vchfRow.findAll(n => n.props?.testID === 'btn-accounts-convert').length).toBeGreaterThan(0);
    act(() => { tree.unmount(); });
  });

  test('no selection ⇒ no Convert control at all (nothing to convert)', () => {
    const tree = mount(assets, balances, {selectedId: null});
    expect(has(tree, 'btn-accounts-convert')).toBe(false);
    act(() => { tree.unmount(); });
  });
});

describe('orderAccounts — X22: play money is never the biggest number on screen', () => {
  const assets = buildSelectableAssets(BUNDLED, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
  const view = (displayText: string, status: 'ok' | 'zero') => ({displayText, status});

  test('the practice rail sorts LAST even when it is the only funded account', () => {
    // The exact defect: a fresh wallet holds ∂100.00 and nothing else, and DEMO led the list with
    // the largest number on screen, above BTC and USDC.
    const balances = {[DEMO_ASSET_ID]: view('∂100.00', 'ok')} as Parameters<typeof orderAccounts>[1];
    const order = orderAccounts(assets, balances, 'CHF');
    expect(order[order.length - 1]!.id).toBe(DEMO_ASSET_ID);
    expect(order[0]!.id).toBe(preferredRail('CHF', assets)!.id);
  });

  test('the home currency\'s rails lead, preferred first, then the group\'s siblings', () => {
    const order = orderAccounts(assets, {}, 'USD');
    expect(order[0]!.id).toBe(preferredRail('USD', assets)!.id);
    expect(order[1]!.id).toBe('solana:USDC');
  });

  test('funded accounts precede unfunded ones, catalog order preserved inside each bucket', () => {
    const balances = {
      'ic:6': view('0.5 ETH', 'ok'),
      'ic:1': view('0 BTC', 'zero'),
    } as Parameters<typeof orderAccounts>[1];
    const order = orderAccounts(assets, balances, 'CHF').map(a => a.id);
    expect(order.indexOf('ic:6')).toBeLessThan(order.indexOf('ic:1'));
    // The unfunded bucket keeps catalog order: ckBTC (1) before ckUSDC (2) before ICP (8).
    expect(order.indexOf('ic:1')).toBeLessThan(order.indexOf('ic:2'));
    expect(order.indexOf('ic:2')).toBeLessThan(order.indexOf('ic:8'));
  });

  test('every asset appears exactly once — the buckets partition the list', () => {
    const order = orderAccounts(assets, {}, 'EUR');
    expect(order).toHaveLength(assets.length);
    expect(new Set(order.map(a => a.id)).size).toBe(assets.length);
  });

  test('the rendered list carries the practice divider immediately above the practice row', () => {
    const balances = buildAssetBalances({
      catalog: BUNDLED, assets, icBalances: {}, primaryBalance: '10000', online: true,
      solState: {balance: null, status: 'unavailable'}, tokenStates: {},
    });
    const tree = mount(assets, balances);
    const list = tree.root.findAll(n => n.props && n.props.testID === 'accounts-list')[0]!;
    const marks = list.findAll(n => n.props?.testID === 'accounts-practice-note' || n.props?.testID === 'asset-demo')
      .map(n => String(n.props.testID));
    expect(marks[0]).toBe('accounts-practice-note');
    expect(rowText(tree, 'accounts-practice-note')).toBe(M.wallet.accounts.practice);
    act(() => { tree.unmount(); });
  });
});
