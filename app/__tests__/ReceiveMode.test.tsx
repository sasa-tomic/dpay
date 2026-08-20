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
import {Share, Platform, Text} from 'react-native';

jest.mock('../services/native', () => ({
  DpayCore: {
    encodeRequest: jest.fn(),
  },
}));
jest.mock('../services/relay', () => ({
  fetchWithTimeout: jest.fn(async () => ({ok: false})),
  payAndClassify: jest.fn(),
}));
jest.mock('../services/rail', () => ({
  pollTransfer: jest.fn(),
  submitTransfer: jest.fn(),
  qrPayloadToEnvelopeHex: jest.fn(),
}));
jest.mock('../components/QrScanner', () => ({
  QrScanner: (_props: {onScan: (raw: string) => void}) => null,
}));

import {DpayCore} from '../services/native';
import {pollTransfer} from '../services/rail';
import {ReceiveMode} from '../components/ReceiveMode';
import {receiptShareBlob} from '../lib/deepLink';
import {POLL, PROOF_POLL_BUDGET} from '../config/constants';
import type {CurrencyDescriptor} from '../config/catalog';
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

// The settlement poll fires at POLL.receiptRcv — under fake timers this is the REAL 1500ms (the
// __DPAY_TEST_POLL override is an e2e-driver injection, not set here).
const POLL_TIME = POLL.receiptRcv;

type ReceiveModeProps = Parameters<typeof ReceiveMode>[0];

function fullProps(over: Partial<ReceiveModeProps> = {}): ReceiveModeProps {
  return {
    identity: IDENTITY,
    relayUrl: 'http://relay.test',
    online: true,
    nfcReady: false,
    onReceived: () => {},
    catalog: [],
    depositCurrency: 0,
    depositDisplay: null,
    depositChainId: null,
    depositNativeEth: false,
    depositFamily: null,
    subMode: 'request',
    onSubModeChange: () => {},
    selectedCurrency: 0,
    assets: [],
    selectedAssetId: null,
    balances: BALANCES,
    onSelectAsset: () => {},
    ...over,
  };
}

function mountReceive(props: Partial<ReceiveModeProps> = {}) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<ReceiveMode {...fullProps(props)} />);
  });
  return tree;
}

/** Re-render with overrides — how Wallet delivers a dpay:pay blob AFTER a request is open. */
function rerenderReceive(tree: renderer.ReactTestRenderer, over: Partial<ReceiveModeProps>) {
  act(() => {
    tree.update(<ReceiveMode {...fullProps(over)} />);
  });
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
  (Platform as {OS: string}).OS = 'ios'; // restore the jest-preset default (webLabel() tests mutate it)
});

// The jest preset pins Platform.OS to 'ios' (native). shareConfirmLabel: web says what the
// fallback DID ('Link copied ✓' — the no-Web-Share path copies), native says 'Shared ✓' (the real
// Share sheet was the feedback, nothing was copied). The flip test runs as WEB; native has its own.
function asWeb() {
  (Platform as {OS: string}).OS = 'web';
}

describe('ReceiveMode — share request feedback (U-F1)', () => {
  test('(web) "Share request link" flips to "Link copied ✓" after the share resolves (testID unchanged)', async () => {
    asWeb();
    const tree = mountReceive();
    await makeRequest(tree);
    expect(hasTestID(tree, 'btn-share-request')).toBe(true);
    expect(texts(tree)).toContain('Share request link');
    const btn = tree.root.findAll(node => node.props && node.props.testID === 'btn-share-request')[0];
    await act(async () => {
      btn.props.onPress();
    });
    // web semantics (U-F1): the share payload is the /wallet?req= handoff URL — NOT the native
    // dpay:req/ scheme (shareHandoff branches on Platform.OS; this test mounts as web).
    expect(shareSpy).toHaveBeenCalledWith({message: '/wallet?req=REQB64VALUE'});
    expect(texts(tree)).toContain('Link copied ✓');
    expect(texts(tree)).not.toContain('Share request link');
    expect(hasTestID(tree, 'btn-share-request')).toBe(true);
    act(() => {
      tree.unmount();
    });
  });

  test('native: a completed Share sheet flips to "Shared ✓" — never "Link copied ✓"', async () => {
    const tree = mountReceive();
    await makeRequest(tree);
    const btn = tree.root.findAll(node => node.props && node.props.testID === 'btn-share-request')[0];
    await act(async () => {
      btn.props.onPress();
    });
    // native semantics (U-F1): the share payload is the dpay:req/ scheme URI (shareHandoff's
    // other branch) — the web test above pins the /wallet?req= handoff URL.
    expect(shareSpy).toHaveBeenCalledWith({message: expect.stringContaining('dpay:req/')});
    expect(texts(tree)).toContain('Shared ✓');
    expect(texts(tree)).not.toContain('Link copied ✓');
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

// --- F2/F6 (2026-08-20): the dpay:pay rail-proof deeplink NEVER flips the UI to Received ----------
// Trust model: the proof blob is UNTRUSTED. The handler format-checks it (parseRailProof), binds
// its request_id to the open request by setting watchRid ONLY, and lets the settlement poll flip
// the result from ON-CHAIN read_state. The pollTransfer mock IS the read_state oracle in tests:
//   unknown  → stays on the request-QR view (never Received), bounded attempts, actionable copy
//   settled  → Received (the only path), onReceived fires ONCE (from the poll, not the handler)
//   rejected → error row with the ledger reason, polling stops
//   no open request (cold launch) → ignored entirely (no fabricated ∂0.00, no onReceived)

describe('ReceiveMode — rail-proof deeplink is poll-gated (F2), never fabricated (F6)', () => {
  // Minimal honest catalog: currency 0 must resolve a ledger principal or the poll effect no-ops.
  const CATALOG: CurrencyDescriptor[] = [{
    currency: 0, ledger: 'td2nx-oaaaa-aaaab-qhdnq-cai', mintable: true, minter: null,
    minter_family: null, symbol: null, decimals: 2, wrapper_name: null, backing_symbol: null,
    network: null, display_decimals: 2, fee: null, cap: null, chain_id: null, token_contract: null,
    gas_ledger: null, onramp: 'Unavailable', offramp: 'Unavailable',
  }];
  const FORGED = receiptShareBlob({request_id: '00'.repeat(32), block_index: '7', ledger: 'x'});

  beforeEach(() => {
    jest.mocked(pollTransfer).mockReset();
  });

  test('F2: a forged-but-well-formed proof does NOT render Received — only read_state may flip it', async () => {
    const onReceived = jest.fn();
    const tree = mountReceive({catalog: CATALOG, onReceived});
    await makeRequest(tree);
    expect(hasTestID(tree, 'request-qr')).toBe(true);

    // The forged proof lands (as Wallet delivers it: a rerender with prefillReceipt set).
    rerenderReceive(tree, {catalog: CATALOG, onReceived, prefillReceipt: FORGED});

    // read_state says UNKNOWN — the honest verdict for a rid that never settles.
    jest.mocked(pollTransfer).mockResolvedValue({kind: 'unknown'});
    await act(async () => {
      await jest.advanceTimersByTimeAsync(POLL_TIME * 3);
    });

    expect(pollTransfer).toHaveBeenCalled();
    expect(texts(tree).join(' ')).not.toContain('Received'); // the F2 invariant
    expect(onReceived).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('F2: the SAME proof flips to Received once read_state says settled (the real path)', async () => {
    const onReceived = jest.fn();
    const tree = mountReceive({catalog: CATALOG, onReceived});
    await makeRequest(tree);
    jest.mocked(pollTransfer).mockResolvedValue({kind: 'unknown'});
    rerenderReceive(tree, {catalog: CATALOG, onReceived, prefillReceipt: FORGED});
    await act(async () => { await jest.advanceTimersByTimeAsync(POLL_TIME); });

    // Settlement lands on the ledger (a real pre-settled proof polls settled immediately).
    jest.mocked(pollTransfer).mockResolvedValue({kind: 'settled', blockIndex: '42'});
    await act(async () => { await jest.advanceTimersByTimeAsync(POLL_TIME); });

    expect(texts(tree).join(' ')).toContain('Received');
    expect(onReceived).toHaveBeenCalledTimes(1); // fired by the poll — never by the handler
    act(() => { tree.unmount(); });
  });

  test('F2: a rejected read_state surfaces the ledger reason and stops polling', async () => {
    const tree = mountReceive({catalog: CATALOG});
    await makeRequest(tree);
    jest.mocked(pollTransfer).mockResolvedValue({kind: 'rejected', reason: 'Insufficient funds'});
    rerenderReceive(tree, {catalog: CATALOG, prefillReceipt: FORGED});
    await act(async () => { await jest.advanceTimersByTimeAsync(POLL_TIME); });

    expect(texts(tree)).toContain('Insufficient funds');
    expect(texts(tree).join(' ')).not.toContain('Received');
    const calls = jest.mocked(pollTransfer).mock.calls.length;
    await act(async () => { await jest.advanceTimersByTimeAsync(POLL_TIME * 3); });
    expect(jest.mocked(pollTransfer).mock.calls.length).toBe(calls); // stopped
    act(() => { tree.unmount(); });
  });

  test('F2: an unknown rid stops after a bounded budget with actionable copy (no infinite hang)', async () => {
    const tree = mountReceive({catalog: CATALOG});
    await makeRequest(tree);
    jest.mocked(pollTransfer).mockResolvedValue({kind: 'unknown'});
    rerenderReceive(tree, {catalog: CATALOG, prefillReceipt: FORGED});

    // The budget (PROOF_POLL_BUDGET) counts attempts; poll fires at POLL_TIME per tick.
    await act(async () => { await jest.advanceTimersByTimeAsync(POLL_TIME * (PROOF_POLL_BUDGET + 2)); });

    const joined = texts(tree).join(' ');
    expect(joined).not.toContain('Received');
    expect(joined).toContain("Couldn’t confirm this payment yet");
    // Bounded, not one-poll-per-tick-forever (React clears the interval a few ticks after the
    // budget trips — the exact tail depends on the act flush, so allow a small margin).
    const calls = jest.mocked(pollTransfer).mock.calls.length;
    expect(calls).toBeLessThanOrEqual(PROOF_POLL_BUDGET + 4);
    // …and it STAYS stopped: more wall-clock, zero new polls.
    await act(async () => { await jest.advanceTimersByTimeAsync(POLL_TIME * 5); });
    expect(jest.mocked(pollTransfer).mock.calls.length).toBe(calls);
    act(() => { tree.unmount(); });
  });

  test('F6: a proof with NO open request is ignored — no "Received ∂0.00", no onReceived', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const onReceived = jest.fn();
    try {
      const tree = mountReceive({catalog: CATALOG, onReceived, prefillReceipt: FORGED});
      await act(async () => { await jest.advanceTimersByTimeAsync(POLL_TIME * 3); });

      expect(pollTransfer).not.toHaveBeenCalled(); // nothing to confirm against
      expect(texts(tree).join(' ')).not.toContain('Received');
      expect(onReceived).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no open request'));
      act(() => { tree.unmount(); });
    } finally {
      warn.mockRestore();
    }
  });

  test('F2: a malformed proof (bad request_id) is refused with honest copy, never Received', async () => {
    const tree = mountReceive({catalog: CATALOG});
    await makeRequest(tree);
    const bad = receiptShareBlob({request_id: 'zz', block_index: '7'}); // fails the 64-hex gate
    rerenderReceive(tree, {catalog: CATALOG, prefillReceipt: bad});
    await act(async () => { await jest.advanceTimersByTimeAsync(POLL_TIME); });

    expect(texts(tree).join(' ')).toContain("This receipt doesn't match your open request.");
    expect(texts(tree).join(' ')).not.toContain('Received');
    expect(pollTransfer).not.toHaveBeenCalled(); // never even watched
    act(() => { tree.unmount(); });
  });
});
