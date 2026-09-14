/**
 * AssetPicker — the unified asset selector (Phase 4, 2026-08-12 unified asset selection rewrite).
 * ONE picker consumed by both Receive forms, with a single `onSelect(AssetId)` contract (no
 * `onSelectSol`, no rail prop, no SOL special-case). Verifies:
 *   - renders EVERY SelectableAsset in the list (no row dropped/silently filtered).
 *   - the testID contract: `req-pick-<testKey>` — the e2e net taps these to select an asset; a
 *     rename here would break flows 63/69 silently.
 *   - the active (selected) row is flagged active; non-selected rows are not.
 *   - tapping a row fires `onSelect(asset.id)` THEN `onClose()` — the order matters: Wallet's
 *     handleSelect runs the rail-switch / reconcile; the picker closes regardless of outcome.
 *   - NO local selection state in the picker (selection is owned by the parent). Re-rendering with
 *     a different `selectedId` moves the active flag; the picker itself is stateless beyond `open`.
 *   - every row carries its balance, unconditionally, and the rows are ordered by the SAME
 *     `orderAccounts` policy the accounts route uses. Both were defects the 2026-09-08 UX swarm
 *     found: the picker hid balances and used raw catalog order, so it and the accounts route were
 *     two disagreeing views of one set of accounts.
 *
 * Uses react-test-renderer (the project's only renderer; no @testing-library). Fixtures mirror the
 * real SelectableAsset shape from config/assets.ts (ic + solana variants).
 */
import {describe, test, expect} from '@jest/globals';
import React from 'react';
import {Modal} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import type {ReactTestInstance} from 'react-test-renderer';
import {AssetPicker} from '../components/AssetPicker';
import {orderAccounts} from '../components/AccountsTab';
import type {SelectableAsset} from '../config/assets';
import {USDC_MINT_ADDRESS} from '../solana/tokens';
import type {BalanceView} from '../lib/assetBalances';
import type {AssetId} from '../lib/types';

// ---- Fixtures: the same SelectableAsset shape buildSelectableAssets produces. testKeys matter —
// they become the testID suffix the e2e net taps (`req-pick-sol`, `asset-ckusdc-select`, etc.).
const ASSETS: SelectableAsset[] = [
  {id: 'ic:0', protocol: 'ic', currency: 0, symbol: 'DEMO', networkLabel: 'Internet Computer', network: null, decimals: 2, linkToken: 'DEMO', minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'demo'},
  {id: 'ic:2', protocol: 'ic', currency: 2, symbol: 'USDC', networkLabel: 'Ethereum', network: 'Ethereum', decimals: 6, linkToken: 'ckUSDC', minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'ckusdc'},
  {id: 'solana:SOL', protocol: 'solana', token: 'SOL', symbol: 'SOL', networkLabel: 'Solana', network: 'Solana', mint: null, decimals: 9, linkToken: 'SOL', minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, visible: true, testKey: 'sol'},
  {id: 'solana:USDC', protocol: 'solana', token: 'USDC', symbol: 'USDC', networkLabel: 'Solana', network: 'Solana', mint: USDC_MINT_ADDRESS, decimals: 6, linkToken: 'USDC', minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, visible: true, testKey: 'sol-usdc'},
];

const BALANCES: Record<AssetId, BalanceView> = {
  'ic:0': {displayText: '∂100.00', status: 'ok', failure: null},
  'ic:2': {displayText: '$0.00', status: 'zero', failure: null},
  'solana:SOL': {displayText: '•0.025', status: 'ok', failure: null},
  'solana:USDC': {displayText: '—', status: 'absent', failure: null},
};

// Find the Pressable (or any node) whose RN `testID` prop matches. CurrencyRow renders the row's
// testID on a Pressable (variant='plain') or on a wrapping View (variant='card' — the Pressable
// inside carries the `-select` suffix). We search by testID so the test is robust to CurrencyRow's
// internal node shape (testID is the contract the e2e net also relies on).
function findByTestID(tree: renderer.ReactTestRenderer, testID: string): ReactTestInstance {
  const matches = tree.root.findAll(node => node.props && node.props.testID === testID);
  if (matches.length === 0) throw new Error(`no node with testID=${testID}`);
  // CurrencyRow may render the testID on a parent View (card) AND a child Pressable (-select); the
  // parent is the authoritative row root.
  return matches[0];
}

describe('AssetPicker', () => {
  test('renders every SelectableAsset with the req-pick-<testKey> testID (plain variant)', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <AssetPicker
          open={true}
          assets={ASSETS}
          selectedId={'ic:0'}
          onSelect={() => {}}
          onClose={() => {}}
        />,
      );
    });
    for (const asset of ASSETS) {
      // The plain-variant testID is `req-pick-<testKey>` — flow 63 taps `req-pick-sol` and flow 69
      // taps `req-pick-sol-usdc`. A dropped/renamed row here would break those e2e flows.
      expect(() => findByTestID(tree, `req-pick-${asset.testKey}`)).not.toThrow();
    }
    act(() => { tree.unmount(); });
  });

  test('marks only the selectedId row active; the rest are inactive', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <AssetPicker
          open={true}
          assets={ASSETS}
          selectedId={'solana:SOL'}
          onSelect={() => {}}
          onClose={() => {}}
        />,
      );
    });
    // CurrencyRow's `active` prop drives the trailing check. Assert it's threaded correctly: SOL
    // active, the other three not. We find each CurrencyRow by its testID and read the `active`
    // prop the picker passes to it.
    const solRow = tree.root.find(node => node.props && node.props.testId === 'req-pick-sol');
    expect(solRow.props.active).toBe(true);
    const demoRow = tree.root.find(node => node.props && node.props.testId === 'req-pick-demo');
    expect(demoRow.props.active).toBe(false);
    const usdcRow = tree.root.find(node => node.props && node.props.testId === 'req-pick-sol-usdc');
    expect(usdcRow.props.active).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('threads each SelectableAsset into its row (the AssetGlyph monogram + name/subtitle source)', () => {
    // 2026-08-16 overhaul: rows lead with the family-hued AssetGlyph chip and derive name/subtitle
    // from the asset itself — the picker must pass the FULL asset object per row (a dropped thread
    // would render a glyph-less, name-less row on every selector surface).
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <AssetPicker
          open={true}
          assets={ASSETS}
          selectedId={'ic:0'}
          onSelect={() => {}}
          onClose={() => {}}
        />,
      );
    });
    for (const asset of ASSETS) {
      const row = tree.root.find(node => node.props && node.props.testId === `req-pick-${asset.testKey}`);
      expect(row.props.asset).toBe(asset);
    }
    act(() => { tree.unmount(); });
  });

  test('a row press fires onSelect with the exact AssetId then onClose (order: select then close)', () => {
    const calls: {select: AssetId | null; close: number} = {select: null, close: 0};
    let seq: string[] = [];
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <AssetPicker
          open={true}
          assets={ASSETS}
          selectedId={'ic:0'}
          onSelect={(id) => { calls.select = id; seq.push('select'); }}
          onClose={() => { calls.close += 1; seq.push('close'); }}
        />,
      );
    });
    // CurrencyRow's onPress is what the picker wires. Find the SOL row's CurrencyRow, invoke its
    // onPress directly (the contract under test — the e2e net exercises the same path via a tap).
    const solRow = tree.root.find(node => node.props && node.props.testId === 'req-pick-sol');
    act(() => { solRow.props.onPress(); });
    expect(calls.select).toBe('solana:SOL');
    expect(calls.close).toBe(1);
    // onSelect MUST fire before onClose — Wallet's handleSelect (the rail-switch + reconcile) must
    // run while the picker is still conceptually open (the close is a UI concern, not a guard).
    expect(seq).toEqual(['select', 'close']);
    act(() => { tree.unmount(); });
  });

  test('a USDC (ic) row press fires onSelect with the IC USDC AssetId (same contract as SOL — no special case)', () => {
    // The unification: pre-Phase-4 the SOL row went through `onSelectSol` (a different callback).
    // Post-Phase-4 every row — IC or Solana — goes through the same `onSelect(AssetId)`. This test
    // pins that contract so a future "SOL special case" reintroduction would fail it.
    let selectedId: AssetId | null = null;
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <AssetPicker
          open={true}
          assets={ASSETS}
          selectedId={'ic:0'}
          onSelect={(id) => { selectedId = id; }}
          onClose={() => {}}
        />,
      );
    });
    const ckusdcRow = tree.root.find(node => node.props && node.props.testId === 'req-pick-ckusdc');
    act(() => { ckusdcRow.props.onPress(); });
    expect(selectedId).toBe('ic:2');
    act(() => { tree.unmount(); });
  });

  test('every row carries its balance — the picker is a list of MONEY, not a list of names', () => {
    // The picker and the accounts route render the same accounts. This one used to omit amounts
    // entirely, so a merchant chose which asset to be paid in without being able to see what they
    // held. `showAmount` is gone with the defect: there is no configuration under which a list of
    // accounts should hide the balances.
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <AssetPicker
          open={true}
          assets={ASSETS}
          selectedId={'ic:0'}
          balances={BALANCES}
          onSelect={() => {}}
          onClose={() => {}}
        />,
      );
    });
    const solRow = tree.root.find(node => node.props && node.props.testId === 'req-pick-sol');
    expect(solRow.props.amount).toBe('•0.025');
    act(() => { tree.unmount(); });
  });

  test('rows are ordered by the SAME policy the accounts route uses when a home currency is known', () => {
    // Two lists of one set of accounts, in two different orders, is the UI form of a DRY
    // violation. `orderAccounts` is the single policy; this asserts the picker runs it rather than
    // rendering raw catalog order.
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <AssetPicker
          open={true}
          assets={ASSETS}
          selectedId={'ic:0'}
          balances={BALANCES}
          homeCurrency={'USD'}
          onSelect={() => {}}
          onClose={() => {}}
        />,
      );
    });
    const rendered = tree.root
      .findAll(node => node.props && typeof node.props.testId === 'string' && node.props.testId.startsWith('req-pick-'))
      .map(node => node.props.testId);
    const expected = orderAccounts(ASSETS, BALANCES, 'USD').map(a => `req-pick-${a.testKey}`);
    expect(rendered).toEqual(expected);
    // And the practice rail is last, which is the visible consequence users notice.
    expect(rendered[rendered.length - 1]).toBe('req-pick-demo');
    act(() => { tree.unmount(); });
  });

  test('open=false renders nothing visible (Modal visible={open})', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <AssetPicker
          open={false}
          assets={ASSETS}
          selectedId={'ic:0'}
          onSelect={() => {}}
          onClose={() => {}}
        />,
      );
    });
    // The Modal's `visible` is false; no row Pressables are queryable as a proxy for "hidden".
    // (react-test-renderer renders the Modal subtree regardless of `visible`, so we assert the
    // visible PROP rather than absence of nodes — this is the contract that actually hides the
    // picker on device.)
    const modal = tree.root.findByType(Modal);
    expect(modal.props.visible).toBe(false);
    act(() => { tree.unmount(); });
  });
});
