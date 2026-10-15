/**
 * EvmPayMode — the withdraw flow's Mt Pelerin cash-out entry (plan R2 step 2, the pay-side peer
 * row).
 *
 * The home Withdraw press keeps its pre-wave single path into this surface; the off-ramp is
 * discovered INSIDE it, per asset, exactly where the deposit twin discovers the buy: the row
 * renders only when the SELECTED asset is an eligible EVM row (funding.ts's `mtpCashOutTokenOf`)
 * AND the caller bound the sheet behind it. The entry rides the FUNDED send branch — the offline
 * and unfunded gates above it stay entry-free (a balance the send cannot move is not a balance
 * the sale can sell). The send-to-address body has its own suite; stubbed here so this stays a
 * pure wiring test.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

jest.mock('../components/QrScanner', () => ({QrScanner: () => null}));
jest.mock('../components/EvmWithdrawSheet', () => ({
  EvmWithdrawSheet: () => {
    const {createElement} = jest.requireActual('react') as {createElement: (t: unknown, p: unknown) => unknown};
    const {View} = jest.requireActual('react-native') as {View: unknown};
    return createElement(View, {testID: 'stub-evm-send-sheet'});
  },
}));

import {EvmPayMode} from '../components/EvmPayMode';
import type {SelectableAsset} from '../config/assets';
import type {EvmSelectableAsset} from '../lib/evmCatalog';

const IDENTITY = {secretHex: '11'.repeat(32), publicHex: '22'.repeat(32), username: 'test'};

/** An eligible EVM row: mainnet Ethereum ZCHF with the offramp flip landed. */
function zchfRow(): SelectableAsset & {protocol: 'evm'} {
  return {
    id: 'evm:1:ZCHF', protocol: 'evm', token: 'ZCHF', symbol: 'ZCHF',
    chainId: 1, chainName: 'Ethereum', address: '0x2222222222222222222222222222222222222222',
    linkToken: 'ZCHF', networkLabel: 'ZCHF · Ethereum', network: 'Ethereum', decimals: 18,
    minFractionDigits: 2, liquidity: null, onramp: 'Partner', offramp: 'Partner',
    rampPartner: null, visible: true, testKey: 'evm-zchf-ethereum', testnet: false,
  } as EvmSelectableAsset;
}

/** The same row with the offramp capability off: no cash-out route, every entry fails closed. */
function zchfNoOfframpRow(): SelectableAsset & {protocol: 'evm'} {
  return {...zchfRow(), offramp: 'Unavailable'} as EvmSelectableAsset;
}

function mount(props: Partial<Parameters<typeof EvmPayMode>[0]>): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <EvmPayMode
        identity={IDENTITY}
        online={true}
        asset={zchfRow()}
        balance="1000000000000000000"
        gasWei={null}
        gasChecking={false}
        subMode="send"
        onSubModeChange={() => {}}
        onScannedLink={() => {}}
        onSent={() => {}}
        onRecheckBalances={() => {}}
        {...props}
      />,
    );
  });
  return tree;
}

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

describe('EvmPayMode — the cash-out entry inside the withdraw flow', () => {
  test('eligible asset + bound opener: the row renders beside the send form and fires it once', () => {
    const onCashOut = jest.fn();
    const tree = mount({onCashOut});
    expect(has(tree, 'btn-pay-cashout')).toBe(true);
    expect(has(tree, 'stub-evm-send-sheet')).toBe(true);
    const row = tree.root.find(node => node.props.testID === 'btn-pay-cashout');
    act(() => { row.props.onPress(); });
    expect(onCashOut).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('ineligible asset (offramp Unavailable): no row, the send form is byte-unchanged', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <EvmPayMode
          identity={IDENTITY}
          online={true}
          asset={zchfNoOfframpRow()}
          balance="1000000000000000000"
          gasWei={null}
          subMode="send"
          onSubModeChange={() => {}}
          onScannedLink={() => {}}
          onSent={() => {}}
          onRecheckBalances={() => {}}
          onCashOut={() => {}}
        />,
      );
    });
    expect(has(tree, 'btn-pay-cashout')).toBe(false);
    expect(has(tree, 'stub-evm-send-sheet')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('no bound opener (the direct-mount harness contract): no row renders', () => {
    const tree = mount({});
    expect(has(tree, 'btn-pay-cashout')).toBe(false);
    expect(has(tree, 'stub-evm-send-sheet')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('a known-zero balance keeps the fund gate: no row, no send form', () => {
    const tree = mount({onCashOut: () => {}, balance: '0'});
    expect(has(tree, 'btn-pay-cashout')).toBe(false);
    expect(has(tree, 'stub-evm-send-sheet')).toBe(false);
    expect(has(tree, 'evm-send-fund')).toBe(true);
    act(() => { tree.unmount(); });
  });
});
