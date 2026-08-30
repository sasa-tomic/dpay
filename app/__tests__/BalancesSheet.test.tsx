/**
 * BalancesSheet — the bundled VCHF/ICP rows, rendered (U5 app half, 2026-08-28).
 *
 * The Balances sheet is a PURE renderer over the Wallet-owned selection contract. These tests pin
 * the two no-minter direct-ICRC rows' RENDERING invariants (the pure-level gates live in
 * catalog.test.ts / assets.test.ts):
 *   • zero-balance VCHF/ICP rows REMAIN VISIBLE with honest "0 VCHF"/"0 ICP" amounts;
 *   • NEITHER row emits an action — the DEMO faucet (`btn-topup`) is the sheet's ONLY per-row
 *     action, and "Add money"/"Cash out" are ramp-gated (VCHF/ICP: onramp/offramp Unavailable,
 *     minter null), so no button is emitted for either row.
 *
 * Uses react-test-renderer (the project's only renderer); no module mocks needed — the sheet is a
 * pure renderer and the assets/balances inputs are built with the REAL pure builders.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {BalancesSheet} from '../components/BalancesSheet';
import {buildSelectableAssets} from '../config/assets';
import {buildAssetBalances} from '../lib/assetBalances';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';

describe('BalancesSheet — bundled VCHF/ICP rows (zero-balance visible, no ramp actions)', () => {
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
    usdcState: {amount: null, decimals: null, status: 'unavailable'},
  });

  function mountSheet(): renderer.ReactTestRenderer {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <BalancesSheet
          assets={assets}
          balances={balances}
          selectedId="ic:0"
          onSelect={jest.fn()}
          hasTestnet={false}
          onTopUp={jest.fn()}
          topUpBusy={false}
          topUpErr={null}
          showTestnet={false}
          onToggleTestnet={jest.fn()}
          onClose={jest.fn()}
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
    const tree = mountSheet();
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
    const tree = mountSheet();
    // The DEMO faucet (`btn-topup`) is the sheet's ONLY per-row action: it renders inside the DEMO
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
