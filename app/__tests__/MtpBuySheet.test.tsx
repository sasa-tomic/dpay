/**
 * MtpBuySheet — the Mt Pelerin on-ramp's ONE surface (plan R1 step 3). The pins:
 *
 *   • The review line states the three facts the signature binds: the exact message
 *     (`MtPelerin-{code}`, the per-address derivation), the receiving address (EIP-55), the
 *     delivery chain. ZCHF has one chain and renders NO picker; USDC has two and renders the
 *     toggle, whose switch changes the review + the link.
 *   • Approve signs with the DEVICE key (signPersonalBase64 over the validation message) and
 *     opens the golden widget URL - every parameter spelled as their docs pin them (net, dnet,
 *     bsc, bdc, addr, code, hash). Success flips the sheet to the opened line; open failure keeps
 *     the sheet with the failed-link note and the retry button (the TrustWallet pattern).
 *   • Cancel is the TYPED user-rejected path: the onReject observer receives MtpBuyUserRejected
 *     and the sheet closes. Backdrop close is a dismissal, not a rejection.
 *   • The fee facts render verbatim with their as-of date, and the counterparty is named.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Linking, Text} from 'react-native';
import {MtpBuySheet, MtpBuyUserRejected} from '../components/MtpBuySheet';
import {deriveEvmKeypair, toChecksumAddress} from '../evm/identity';
import {signPersonalBase64} from '../evm/personalSign';
import {buildMtpWidgetLink, deriveValidationCode, validationMessage} from '../ramp/mtpelerin';
import {M} from '../i18n';
import type {Identity} from '../lib/types';

const IDENTITY: Identity = {secretHex: '11'.repeat(32), publicHex: '22'.repeat(32), username: 'Bob'};
const DEVICE = deriveEvmKeypair(IDENTITY.secretHex);
const ADDR = toChecksumAddress(DEVICE.address);
const CODE = deriveValidationCode(DEVICE.address);

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

function textOf(tree: renderer.ReactTestRenderer, testID: string): string {
  const node = tree.root.find(n => n.props?.testID === testID);
  return node.findAllByType(Text).map(t => String(t.props.children ?? '')).join('');
}

function press(tree: renderer.ReactTestRenderer, testID: string): void {
  const node = tree.root.findAll(n => n.props && n.props.testID === testID)[0];
  if (!node) throw new Error(`no node with testID=${testID}`);
  act(() => { node.props.onPress(); });
}

/** A press whose handler continues on promise chains (the approve path): the microtasks pump
 *  INSIDE the act so the continuation's state lands before the assertion (the DepositSheet.test
 *  mount idiom). */
async function pressAsync(tree: renderer.ReactTestRenderer, testID: string): Promise<void> {
  const node = tree.root.findAll(n => n.props && n.props.testID === testID)[0];
  if (!node) throw new Error(`no node with testID=${testID}`);
  await act(async () => {
    node.props.onPress();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(token: 'ZCHF' | 'USDC', handlers: {onClose?: () => void; onReject?: (e: MtpBuyUserRejected) => void} = {}): Promise<renderer.ReactTestRenderer> {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <MtpBuySheet
        identity={IDENTITY}
        token={token}
        onClose={handlers.onClose ?? (() => {})}
        onReject={handlers.onReject}
      />,
    );
  });
  // Flush the validation-code effect: the per-address salt read (AsyncStorage) resolves a tick
  // after mount; the awaited-act microtasks land the derived code into the review line (the
  // DepositSheet.test mount idiom).
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  return tree;
}

let mockOpenURL: jest.Mock<(uri: string) => Promise<void>>;

beforeEach(() => {
  mockOpenURL = jest.fn<(uri: string) => Promise<void>>().mockResolvedValue(undefined);
  (Linking.openURL as unknown) = mockOpenURL;
});

describe('MtpBuySheet — the review line', () => {
  test('ZCHF: message, EIP-55 address, the single delivery chain; NO chain picker', async () => {
    const tree = await mount('ZCHF');
    expect(has(tree, 'mtp-buy-sheet')).toBe(true);
    expect(textOf(tree, 'mtp-review-message')).toBe(validationMessage(CODE));
    expect(textOf(tree, 'mtp-review-address')).toBe(ADDR);
    expect(textOf(tree, 'mtp-review-chain')).toBe('Ethereum');
    expect(has(tree, 'mtp-chain-toggle')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('USDC: the two-chain picker renders and the switch changes the review + the link', async () => {
    const tree = await mount('USDC');
    expect(has(tree, 'mtp-chain-toggle')).toBe(true);
    expect(textOf(tree, 'mtp-review-chain')).toBe('Arbitrum One'); // the MTP_ASSET_DELIVERY default
    press(tree, 'mtp-chain-1'); // switch to Ethereum
    expect(textOf(tree, 'mtp-review-chain')).toBe('Ethereum');
    await pressAsync(tree, "btn-mtp-sign");
    expect(mockOpenURL).toHaveBeenCalledWith(expect.stringContaining('dnet=mainnet&'));
    expect(mockOpenURL).toHaveBeenCalledWith(expect.not.stringContaining('arbitrum'));
    act(() => { tree.unmount(); });
  });
});

describe('MtpBuySheet — the sign-confirm flow', () => {
  test('approve signs with the device key and opens the golden widget URL; the sheet flips to opened', async () => {
    const tree = await mount('ZCHF');
    await pressAsync(tree, "btn-mtp-sign");
    expect(mockOpenURL).toHaveBeenCalledTimes(1);
    const expected = buildMtpWidgetLink({
      asset: 'ZCHF', deliveryChain: 1, address: ADDR, code: CODE,
      hash: signPersonalBase64(DEVICE.privateKey, validationMessage(CODE)),
    });
    expect(mockOpenURL).toHaveBeenCalledWith(expected);
    expect(has(tree, 'mtp-opened')).toBe(true);
    expect(has(tree, 'btn-mtp-sign')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('open failure keeps the sheet with the failed-link note and a live retry', async () => {
    mockOpenURL.mockRejectedValue(new Error('No activity found'));
    const tree = await mount('ZCHF');
    await pressAsync(tree, "btn-mtp-sign");
    expect(has(tree, 'mtp-buy-sheet')).toBe(true);
    expect(has(tree, 'mtp-err')).toBe(true);
    // Retry that succeeds clears the note and opens.
    mockOpenURL.mockResolvedValue(undefined);
    await pressAsync(tree, "btn-mtp-sign");
    expect(mockOpenURL).toHaveBeenCalledTimes(2);
    expect(has(tree, 'mtp-err')).toBe(false);
    expect(has(tree, 'mtp-opened')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('Cancel is the typed user-rejected path: the observer gets MtpBuyUserRejected, the sheet closes', async () => {
    let rejected: unknown = null;
    let closed = 0;
    const tree = await mount('ZCHF', {onClose: () => { closed += 1; }, onReject: e => { rejected = e; }});
    press(tree, 'btn-mtp-cancel');
    expect(rejected).toBeInstanceOf(MtpBuyUserRejected);
    expect(closed).toBe(1);
    expect(mockOpenURL).not.toHaveBeenCalled(); // a rejection signs nothing
    act(() => { tree.unmount(); });
  });
});

describe('MtpBuySheet — the disclosure block', () => {
  test('fee facts verbatim + dated, counterparty named, bought-ETH fact present', async () => {
    const tree = await mount('ZCHF');
    const fees = textOf(tree, 'mtp-fees');
    expect(fees).toContain(M.deposit.mtp.feeBank);
    expect(fees).toContain(M.deposit.mtp.feeCard);
    expect(fees).toContain(M.deposit.mtp.feeDelivery);
    expect(fees).toContain(M.deposit.mtp.holdUnverified);
    expect(fees).toContain(M.deposit.mtp.ethGasNote);
    expect(fees).toContain('2026'); // the as-of date rides the block
    expect(textOf(tree, 'mtp-counterparty')).toContain('Mt Pelerin');
    act(() => { tree.unmount(); });
  });
});
