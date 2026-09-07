/**
 * HomeTab accounts list — the bundled VCHF/ICP rows, rendered (U5 app half, 2026-08-28; moved
 * wholesale from the retired Balances sheet to the Home tab in O4 S3, tests ported verbatim).
 *
 * The accounts list is a PURE renderer over the Wallet-owned selection contract. These tests pin
 * the two no-minter direct-ICRC rows' RENDERING invariants (the pure-level gates live in
 * catalog.test.ts / assets.test.ts):
 *   • zero-balance VCHF/ICP rows REMAIN VISIBLE with honest "0 VCHF"/"0 ICP" amounts;
 *   • NEITHER row emits an action — the DEMO faucet (`btn-topup`) is the list's ONLY per-row
 *     action, and "Add money"/"Cash out" are ramp-gated (VCHF/ICP: onramp/offramp Unavailable,
 *     minter null), so no button is emitted for either row.
 *
 * Uses react-test-renderer (the project's only renderer); no module mocks needed — the list is a
 * pure renderer and the assets/balances inputs are built with the REAL pure builders.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {HomeTab} from '../components/HomeTab';
import {buildSelectableAssets} from '../config/assets';
import {preferredRail} from '../config/currency';
import {buildAssetBalances} from '../lib/assetBalances';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';

describe('HomeTab accounts — bundled VCHF/ICP rows (zero-balance visible, no ramp actions)', () => {
  const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
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

  function mountAccounts(): renderer.ReactTestRenderer {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <HomeTab
          assets={assets}
          selectedAsset={assets[0]!}
          selectedId="ic:0"
          balances={balances}
          catalog={BUNDLED}
          homeCurrency="CHF"
          homeAsset={preferredRail('CHF', assets)}
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
          onConvert={jest.fn()}
          onSelect={jest.fn()}
          onSeeAll={jest.fn()}
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

  test('zero-balance VCHF + ICP rows remain visible with honest "0 VCHF"/"0 ICP" amounts', () => {
    const tree = mountAccounts();
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
    const tree = mountAccounts();
    // The DEMO faucet (`btn-topup`) is the list's ONLY per-row action: it renders inside the DEMO
    // row (findAll matches layered composite+host nodes per Pressable, so presence — not count — is
    // the assertion) and inside NEITHER direct-ICRC row: no action of any kind for VCHF/ICP.
    const demoRow = tree.root.findAll(node => node.props && node.props.testID === 'asset-demo')[0]!;
    expect(demoRow.findAll(node => node.props && node.props.testID === 'btn-topup').length).toBeGreaterThan(0);
    for (const testID of ['asset-vchf', 'asset-icp']) {
      const row = tree.root.findAll(node => node.props && node.props.testID === testID)[0]!;
      expect(row.findAll(node => node.props && node.props.testID === 'btn-topup')).toHaveLength(0);
    }
    act(() => { tree.unmount(); });
  });
});

describe('HomeTab accounts — home-currency rail badges (mark every rail, never sum the group)', () => {
  const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
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

  function mountAccounts(home: 'CHF' | 'USD'): renderer.ReactTestRenderer {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <HomeTab
          assets={assets}
          selectedAsset={assets[0]!}
          selectedId="ic:0"
          balances={balances}
          catalog={BUNDLED}
          homeCurrency={home}
          homeAsset={preferredRail(home, assets)}
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
          onConvert={jest.fn()}
          onSelect={jest.fn()}
          onSeeAll={jest.fn()}
        />,
      );
    });
    return tree;
  }

  const badgeText = (tree: renderer.ReactTestRenderer, testID: string): string =>
    tree.root
      .findAll(node => node.props && node.props.testID === testID)[0]!
      .findAllByType(Text)
      .map(n => n.props.children)
      .join(' ');

  const hasBadge = (tree: renderer.ReactTestRenderer, testID: string): boolean =>
    tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;

  test('home=USD: MAIN on ckUSDC only; the Solana sibling wears a badge NAMING its rail', () => {
    const tree = mountAccounts('USD');
    // The preferred rail keeps the one MAIN badge.
    expect(hasBadge(tree, 'asset-ckusdc-main')).toBe(true);
    expect(hasBadge(tree, 'asset-sol-usdc-main')).toBe(false);
    expect(hasBadge(tree, 'asset-ckusdc-rail')).toBe(false);
    // The sibling rail's badge names the rail with the S1 rail-line vocabulary — never "MAIN".
    expect(hasBadge(tree, 'asset-sol-usdc-rail')).toBe(true);
    expect(badgeText(tree, 'asset-sol-usdc-rail')).toBe('USDC · Solana');
    // No OTHER row gains a badge: VCHF settles CHF (a different currency), ICP/ckETH settle none.
    for (const key of ['asset-vchf', 'asset-icp', 'asset-cketh', 'asset-sol', 'asset-sol-eurc', 'asset-demo']) {
      expect(hasBadge(tree, `${key}-rail`)).toBe(false);
      expect(hasBadge(tree, `${key}-main`)).toBe(false);
    }
    act(() => { tree.unmount(); });
  });

  test('home=CHF: single-rail group renders exactly as before — MAIN on VCHF, no rail badges', () => {
    const tree = mountAccounts('CHF');
    expect(hasBadge(tree, 'asset-vchf-main')).toBe(true);
    for (const key of ['asset-vchf', 'asset-ckusdc', 'asset-sol-usdc', 'asset-icp', 'asset-cketh', 'asset-sol', 'asset-sol-eurc', 'asset-demo']) {
      expect(hasBadge(tree, `${key}-rail`)).toBe(false);
    }
    act(() => { tree.unmount(); });
  });
});
