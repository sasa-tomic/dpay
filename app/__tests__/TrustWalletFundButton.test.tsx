/**
 * TrustWalletFundButton — render + interaction (jest; android-gated, so the web e2e harness is
 * structurally blind to it — jest owns this coverage by design, 2026-08-17 plan).
 *
 * No react-native module mock (requireActual throws under this preset — DevMenu turbo module —
 * and a minimal mock would gut StyleSheet for the styles import; same choice as
 * SolanaReceiveSheet.test.tsx). The two seams the button touches are patched in place:
 * Platform.OS is a plain mutable field (set per test — the button reads it at render time),
 * Linking.openURL is replaced with a jest fn. Everything else (palette, styles, icons) runs
 * real — the button must match the app's ghost tier with the real S.ghostBtn.
 */
import {describe, test, expect, beforeEach, afterEach, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Platform, Linking} from 'react-native';

import {TrustWalletFundButton} from '../components/TrustWalletFundButton';
import {S} from '../styles';

const ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const setOS = (os: string) => { (Platform as {OS: string}).OS = os; };

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

function pressByTestID(tree: renderer.ReactTestRenderer, testID: string): void {
  const node = tree.root.findAll(node => node.props && node.props.testID === testID)[0];
  if (!node) throw new Error(`no node with testID=${testID}`);
  act(() => { node.props.onPress(); });
}

function mount(asset: 'BTC' | 'SOL' | 'SOL-USDC') {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<TrustWalletFundButton asset={asset} address={ADDR} />);
  });
  return tree;
}

let mockLinkingOpenURL: jest.Mock<(uri: string) => Promise<void>>;

beforeEach(() => {
  setOS('android');
  mockLinkingOpenURL = jest.fn<(uri: string) => Promise<void>>().mockResolvedValue(undefined);
  (Linking.openURL as unknown) = mockLinkingOpenURL;
});
afterEach(() => { setOS('android'); });

describe('TrustWalletFundButton', () => {
  test('android + mainnet BTC → visible, ghost tier, correct external-link label', () => {
    const tree = mount('BTC');
    const btn = tree.root.findAll(n => n.props && n.props.testID === 'btn-trust-fund')[0];
    expect(btn).toBeDefined();
    expect(btn.props.accessibilityRole).toBe('button');
    expect(btn.props.accessibilityLabel).toBe('Fund from Trust Wallet');
    expect(btn.props.style).toBe(S.ghostBtn); // the app's ghost tier — no bespoke styling
    act(() => { tree.unmount(); });
  });

  test('tap SOL → Linking.openURL with the golden c501 send link (fire-and-forget)', async () => {
    const tree = mount('SOL');
    await act(async () => { pressByTestID(tree, 'btn-trust-fund'); });
    expect(mockLinkingOpenURL).toHaveBeenCalledTimes(1);
    expect(mockLinkingOpenURL).toHaveBeenCalledWith(
      `https://link.trustwallet.com/send?asset=c501&address=${ADDR}`);
    expect(has(tree, 'trust-fund-err')).toBe(false); // no failure copy on success
    act(() => { tree.unmount(); });
  });

  test('tap SOL-USDC → golden SPL link (c501_t<mint>)', async () => {
    const tree = mount('SOL-USDC');
    await act(async () => { pressByTestID(tree, 'btn-trust-fund'); });
    expect(mockLinkingOpenURL).toHaveBeenCalledWith(
      `https://link.trustwallet.com/send?asset=c501_tEPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&address=${ADDR}`);
    act(() => { tree.unmount(); });
  });

  test('openURL rejects (transient / no handler) → honest failure copy, NOT a crash', async () => {
    mockLinkingOpenURL.mockRejectedValue(new Error('No activity found'));
    const tree = mount('SOL');
    await act(async () => { pressByTestID(tree, 'btn-trust-fund'); });
    expect(has(tree, 'trust-fund-err')).toBe(true);
    // Recovery: a retry that succeeds clears the copy.
    mockLinkingOpenURL.mockResolvedValue(undefined);
    await act(async () => { pressByTestID(tree, 'btn-trust-fund'); });
    expect(has(tree, 'trust-fund-err')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('web → button absent (web keeps the copy/QR + WalletConnect story)', () => {
    setOS('web');
    const tree = mount('BTC');
    expect(has(tree, 'btn-trust-fund')).toBe(false);
    expect(mockLinkingOpenURL).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });
});
