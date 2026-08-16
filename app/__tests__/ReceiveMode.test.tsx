/**
 * ReceiveMode — the merchant request screen's share affordance (U-F1, 2026-08-16 UX finding).
 *
 * "Share request link" fires Share.share with no in-DOM confirmation (a known cosmetic gap on
 * web, where the code path is Web Share + clipboard fallback). The fix mirrors the DepositSheet
 * useCopyFeedback pattern: after the share resolves with sharedAction the label flips to
 * 'Link copied ✓' for the 1500ms dwell. The testID stays `btn-share-request` (the e2e contract)
 * and a dismissal leaves the label honest.
 *
 * Uses react-test-renderer (the project's only renderer). The native encode + the settlement
 * poll are mocked at their module boundaries; QrScanner is stubbed (the camera never opens —
 * the request-QR branch only mounts it while scanning, which this flow never enters).
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Share, Text} from 'react-native';

jest.mock('../services/native', () => ({
  DpayCore: {
    encodeRequest: jest.fn(),
  },
}));
jest.mock('../services/relay', () => ({
  fetchWithTimeout: jest.fn(async () => ({ok: false})),
  payAndClassify: jest.fn(),
}));
jest.mock('../components/QrScanner', () => ({
  QrScanner: (_props: {onScan: (raw: string) => void}) => null,
}));

import {DpayCore} from '../services/native';
import {ReceiveMode} from '../components/ReceiveMode';
import type {AssetId} from '../lib/types';
import type {BalanceView} from '../lib/assetBalances';
import type {Identity} from '../lib/types';

const IDENTITY: Identity = {secretHex: '11'.repeat(32), publicHex: '22'.repeat(32), username: 'Bob'};

// Record<AssetId, BalanceView> requires both SOL keys (the ic:${number} template adds none). The
// request flow never reads them; a minimal honest view keeps the prop type-checkable.
const BALANCES: Record<AssetId, BalanceView> = {
  'solana:SOL': {displayText: '—', status: 'unavailable'},
  'solana:USDC': {displayText: '—', status: 'unavailable'},
};

const shareSpy = jest.spyOn(Share, 'share');

type ReceiveModeProps = Parameters<typeof ReceiveMode>[0];

function mountReceive(props: Partial<ReceiveModeProps> = {}) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <ReceiveMode
        identity={IDENTITY}
        relayUrl="http://relay.test"
        online={true}
        nfcReady={false}
        onReceived={() => {}}
        catalog={[]}
        depositCurrency={0}
        depositDisplay={null}
        depositChainId={null}
        depositNativeEth={false}
        depositFamily={null}
        subMode="request"
        onSubModeChange={() => {}}
        selectedCurrency={0}
        assets={[]}
        selectedAssetId={null}
        balances={BALANCES}
        onSelectAsset={() => {}}
        {...props}
      />,
    );
  });
  return tree;
}

/** Enter an amount + press Request — drives makeRequest into the request-QR branch. */
async function makeRequest(tree: renderer.ReactTestRenderer) {
  jest.mocked(DpayCore.encodeRequest).mockResolvedValue('REQB64VALUE');
  const input = tree.root.findAll(node => node.props && node.props.testID === 'amount-input')[0];
  act(() => {
    input.props.onChangeText('25');
  });
  const btn = tree.root.findAll(node => node.props && node.props.testID === 'btn-request')[0];
  await act(async () => {
    btn.props.onPress();
  });
}

/** Depth-first text of a props.children tree — strings, numbers, arrays, nested elements. */
function textOf(children: unknown): string {
  if (children == null || typeof children === 'boolean') return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  const el = children as {props?: {children?: unknown}};
  return el.props ? textOf(el.props.children) : '';
}

/** All visible text of Text nodes — the assertion target for label flips. */
function texts(tree: renderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(n => textOf(n.props.children));
}

function hasTestID(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

beforeEach(() => {
  // Fake timers: the request-QR branch runs a 1s `now` display clock whose tick lands outside act
  // and past the test's end. Date stays real (the request expiry math uses Date.now()).
  jest.useFakeTimers({doNotFake: ['Date']});
  shareSpy.mockReset().mockResolvedValue({action: 'sharedAction' as const});
});

afterEach(() => {
  jest.useRealTimers(); // the 1s display clock + the share dwell would keep the worker alive
});

describe('ReceiveMode — share request feedback (U-F1)', () => {
  test('"Share request link" flips to "Link copied ✓" after the share resolves (testID unchanged)', async () => {
    const tree = mountReceive();
    await makeRequest(tree);
    expect(hasTestID(tree, 'btn-share-request')).toBe(true);
    expect(texts(tree)).toContain('Share request link');
    const btn = tree.root.findAll(node => node.props && node.props.testID === 'btn-share-request')[0];
    await act(async () => {
      btn.props.onPress();
    });
    expect(shareSpy).toHaveBeenCalledWith({message: expect.stringContaining('dpay:req/')});
    expect(texts(tree)).toContain('Link copied ✓');
    expect(texts(tree)).not.toContain('Share request link');
    expect(hasTestID(tree, 'btn-share-request')).toBe(true);
    act(() => {
      tree.unmount();
    });
  });

  test('a dismissed share sheet leaves the label honest (dismissedAction does not flip)', async () => {
    shareSpy.mockResolvedValue({action: 'dismissedAction' as const});
    const tree = mountReceive();
    await makeRequest(tree);
    const btn = tree.root.findAll(node => node.props && node.props.testID === 'btn-share-request')[0];
    await act(async () => {
      btn.props.onPress();
    });
    expect(texts(tree)).toContain('Share request link');
    expect(texts(tree)).not.toContain('Link copied ✓');
    act(() => {
      tree.unmount();
    });
  });
});
