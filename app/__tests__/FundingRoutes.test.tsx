/**
 * FundingRoutes — the interactive Mt Pelerin row (plan R1 step 3, §8 item 2). Pins:
 *
 *   • With the opener present, the row renders as an ALPHABETICAL peer among the inert provider
 *     rows: between MoonPay and Ramp today (the slot is DERIVED from the list, never a hardcoded
 *     index). No highlight, no "best" — the external-link glyph is the only affordance cue.
 *   • A press hands off to the opener (the sheet is the owner's; this row opens nothing itself).
 *   • Without the opener, the row is absent and the card renders exactly as before.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {FundingRoutes} from '../components/FundingRoutes';
import {M} from '../i18n';
import type {EvmSelectableAsset} from '../lib/evmCatalog';

const EVM_ROW: EvmSelectableAsset = {
  id: 'evm:42161:ZCHF', protocol: 'evm', token: 'ZCHF', symbol: 'ZCHF',
  chainId: 42161, chainName: 'Arbitrum One', address: '0x1111111111111111111111111111111111111111',
  linkToken: 'ZCHF', networkLabel: 'ZCHF · Arbitrum One', network: 'Arbitrum One', decimals: 18,
  minFractionDigits: 2, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable',
  rampPartner: null, visible: true, testKey: 'evm-zchf-arbitrum', testnet: false,
};

function ids(tree: renderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  tree.root.findAll(n => { if (n.props && typeof n.props.testID === 'string') out.push(n.props.testID); return false; });
  return out;
}

function textOf(tree: renderer.ReactTestRenderer, testID: string): string {
  const node = tree.root.find(n => n.props?.testID === testID);
  return node.findAllByType(Text).map(t => String(t.props.children ?? '')).join('');
}

function mount(onBuy?: () => void) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <FundingRoutes asset={EVM_ROW} isTestnet={false} mechanism="send-to-address" homeCurrency="CHF" onBuy={onBuy} />,
    );
  });
  return tree;
}

describe('FundingRoutes — the Mt Pelerin provider row', () => {
  test('alphabetical peer: the row sorts between MoonPay and Ramp, grammar intact', () => {
    const tree = mount(jest.fn());
    const list = ids(tree);
    const at = (t: string) => list.indexOf(t);
    expect(at('funding-provider-mtp')).toBeGreaterThan(-1);
    expect(at('funding-provider-moonpay')).toBeLessThan(at('funding-provider-mtp'));
    expect(at('funding-provider-mtp')).toBeLessThan(at('funding-provider-ramp'));
    // Row grammar: the provider name and its one-line differentiator, no ranking claim.
    expect(textOf(tree, 'funding-provider-mtp')).toContain('Mt Pelerin');
    expect(textOf(tree, 'funding-provider-mtp')).toContain(M.deposit.mtp.fundingLine);
    expect(textOf(tree, 'funding-provider-mtp')).not.toMatch(/\bbest\b/i);
    act(() => { tree.unmount(); });
  });

  test('the press hands off to the opener', () => {
    const onBuy = jest.fn();
    const tree = mount(onBuy);
    const node = tree.root.findAll(n => n.props && n.props.testID === 'funding-provider-mtp')[0];
    act(() => { (node.props as {onPress: () => void}).onPress(); });
    expect(onBuy).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('no opener: the row is absent, the card renders exactly as before', () => {
    const tree = mount(undefined);
    expect(ids(tree)).not.toContain('funding-provider-mtp');
    expect(ids(tree)).toContain('funding-provider-coinbase');
    expect(ids(tree)).toContain('funding-provider-ramp');
    act(() => { tree.unmount(); });
  });
});
