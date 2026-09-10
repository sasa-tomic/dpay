/**
 * FundedSiblingRail — the funded-account pointer. State matrix: every branch of its null/button
 * logic, because a misrendered pointer is the difference between a dead end and a one-tap switch.
 *
 * The RANKING is tested against `fundedAlternative` in currency.test.ts (its one owner); what is
 * pinned here is the RENDERING, and specifically the three things that must never be confused:
 *   • which sentence each kind gets — practice money never borrows "You hold …", because that
 *     sentence beside a merchant's price would be a lie by omission;
 *   • which noun each BUTTON names — the CHAIN for a same-currency rail (the only thing telling
 *     two rails of one currency apart) and the ASSET otherwise (two accounts can share a chain);
 *   • that the switch is a USER gesture only — the press routes Wallet's `payRailSelect`, itself
 *     under `shouldAllowUserSelect`; with no `onSwitch` the pointer names the account WITHOUT the
 *     button, because knowledge is never gated on the selection lock, affordances are.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {View} from 'react-native';
import {FundedSiblingRail} from '../components/FundedSiblingRail';
import {buildSelectableAssets} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {M} from '../i18n';

const ASSETS = buildSelectableAssets(icpCatalogOf(BUNDLED_NETWORKS), {
  showTestnet: false,
  solanaEnabled: true,
  solanaTokens: true,
});

// Wrapped in a host View so the NULL renders (the pointer's most common case) still leave a
// traversable tree — a component that renders null has no `tree.root` to walk. The create sits
// inside act like every other mount in this suite family: React 19 commits asynchronously.
function mount(props: Partial<Parameters<typeof FundedSiblingRail>[0]> = {}) {
  const onSwitch = jest.fn();
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <View>
        <FundedSiblingRail
          homeCurrency={null}
          assets={ASSETS}
          balances={{}}
          selectedAssetId={null}
          purpose="pay"
          onSwitch={onSwitch}
          {...props}
        />
      </View>,
    );
  });
  return {tree, onSwitch};
}

function textOf(tree: renderer.ReactTestRenderer, testID: string): string {
  return tree.root.findByProps({testID}).props.children;
}

function hasTestID(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props.testID === testID).length > 0;
}

/** The switch button's label. Read off `accessibilityLabel`, which the component sets from the
 *  SAME string it renders — so the screen reader and the visible button can never disagree. */
function ctaOf(tree: renderer.ReactTestRenderer): string {
  return tree.root.findByProps({testID: 'btn-fund-sibling-switch'}).props.accessibilityLabel;
}

describe('FundedSiblingRail — when the pointer renders at all', () => {
  test('no home currency: the funded account is still named, as an OTHER-currency account', () => {
    // Widened 2026-09-08 (X1): without a home currency there is no "sibling", but the wallet still
    // holds dollars, and the whole defect was screens that refused to say so. The button names the
    // ASSET here — "Switch to Solana" would be meaningless about which Solana account.
    const {tree, onSwitch} = mount({homeCurrency: null, selectedAssetId: 'ic:2', balances: {'solana:USDC': {displayText: '2.50 USDC', status: 'ok', failure: null}}});
    expect(textOf(tree, 'fund-sibling-holds')).toBe('You hold 2.50 USDC on USDC · Solana');
    expect(ctaOf(tree)).toBe('Switch to USDC');
    act(() => { tree.root.findByProps({testID: 'btn-fund-sibling-switch'}).props.onPress(); });
    expect(onSwitch).toHaveBeenCalledWith('solana:USDC');
  });

  test('practice money gets its OWN sentence and its own button — never "You hold"', () => {
    // The measured X1 case: a brand-new CHF wallet, ∂100 of practice money, and until now not one
    // screen that named it. The sentence must carry both halves — you can rehearse a payment, and
    // it buys nothing real — so the offer can never read as "you have money, go spend it".
    const {tree, onSwitch} = mount({
      homeCurrency: 'CHF',
      selectedAssetId: 'ic:7',
      balances: {'ic:0': {displayText: '∂100.00', status: 'ok', failure: null}},
    });
    const line = textOf(tree, 'fund-sibling-holds');
    expect(line).toBe(M.pay.fundSibling.practice('∂100.00'));
    expect(line).toContain('practise a payment');
    expect(line).toContain('cannot pay a real merchant');
    expect(line).not.toContain('You hold');
    expect(ctaOf(tree)).toBe('Switch to practice money');
    act(() => { tree.root.findByProps({testID: 'btn-fund-sibling-switch'}).props.onPress(); });
    expect(onSwitch).toHaveBeenCalledWith('ic:0');
  });

  test('practice money is NEVER offered on a send surface — it has no route off the wallet', () => {
    const {tree} = mount({
      homeCurrency: 'CHF',
      selectedAssetId: 'ic:7',
      purpose: 'send',
      balances: {'ic:0': {displayText: '∂100.00', status: 'ok', failure: null}},
    });
    expect(hasTestID(tree, 'fund-sibling-rail')).toBe(false);
  });

  test('a funded sibling of the same currency: the pointer names rail and amount, one tap switches', () => {
    const {tree, onSwitch} = mount({
      homeCurrency: 'USD',
      selectedAssetId: 'ic:2',
      balances: {'solana:USDC': {displayText: '2.50 USDC', status: 'ok', failure: null}},
    });
    expect(textOf(tree, 'fund-sibling-holds')).toBe(M.pay.fundSibling.holds('2.50 USDC', 'USDC · Solana'));
    expect(textOf(tree, 'fund-sibling-holds')).toBe('You hold 2.50 USDC on USDC · Solana');
    act(() => { tree.root.findByProps({testID: 'btn-fund-sibling-switch'}).props.onPress(); });
    expect(onSwitch).toHaveBeenCalledWith('solana:USDC');
  });

  test('the unfunded twin renders nothing — a zero/absent/unavailable sibling is not a pointer', () => {
    for (const status of ['zero', 'absent', 'unavailable', 'error', 'loading'] as const) {
      const {tree} = mount({homeCurrency: 'USD', selectedAssetId: 'ic:2', balances: {'solana:USDC': {displayText: '0.00 USDC', status, failure: null}}});
      expect(hasTestID(tree, 'fund-sibling-rail')).toBe(false);
    }
  });

  test('selection on the OTHER rail points back at a funded ckUSDC', () => {
    const {tree, onSwitch} = mount({
      homeCurrency: 'USD',
      selectedAssetId: 'solana:USDC',
      balances: {'ic:2': {displayText: '5.00 ckUSDC', status: 'ok', failure: null}},
    });
    expect(textOf(tree, 'fund-sibling-holds')).toBe('You hold 5.00 ckUSDC on ckUSDC · Internet Computer');
    act(() => { tree.root.findByProps({testID: 'btn-fund-sibling-switch'}).props.onPress(); });
    expect(onSwitch).toHaveBeenCalledWith('ic:2');
  });

  test('with BOTH siblings funded, preference order wins — the chooser rail is the pointer', () => {
    const {tree} = mount({
      homeCurrency: 'USD',
      selectedAssetId: 'solana:USDC',
      balances: {
        'ic:2': {displayText: '5.00 ckUSDC', status: 'ok', failure: null},
        'solana:USDC': {displayText: '0.00 USDC', status: 'zero', failure: null},
      },
    });
    expect(textOf(tree, 'fund-sibling-holds')).toContain('ckUSDC');
  });

  test('a single-rail currency (CHF) points nowhere, even funded', () => {
    const {tree} = mount({
      homeCurrency: 'CHF',
      selectedAssetId: 'ic:7',
      balances: {'ic:7': {displayText: '0.00 VCHF', status: 'zero', failure: null}},
    });
    expect(hasTestID(tree, 'fund-sibling-rail')).toBe(false);
  });
});

describe('FundedSiblingRail — the lock is an affordance gate, not a knowledge gate', () => {
  test('no onSwitch (Wallet passes none while locked): the rail is still named, the button is gone', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <View>
          <FundedSiblingRail
            homeCurrency="USD"
            assets={ASSETS}
            balances={{'solana:USDC': {displayText: '2.50 USDC', status: 'ok', failure: null}}}
            selectedAssetId="ic:2"
            purpose="pay"
          />
        </View>,
      );
    });
    expect(textOf(tree, 'fund-sibling-holds')).toBe('You hold 2.50 USDC on USDC · Solana');
    expect(hasTestID(tree, 'btn-fund-sibling-switch')).toBe(false);
  });
});
