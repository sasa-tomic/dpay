/**
 * ReceiveMode — the merchant request screen's share affordance (U-F1, 2026-08-16 UX finding).
 *
 * "Share request link" fires Share.share with no in-DOM confirmation (a known cosmetic gap on
 * web, where the code path is Web Share + clipboard fallback). The fix mirrors the DepositSheet
 * useCopyFeedback pattern: after the share resolves with sharedAction the label flips to
 * 'Link copied ✓' for the 1500ms dwell. The testID stays `btn-share-request` (the e2e contract)
 * and a dismissal leaves the label honest.
 *
 * Uses react-test-renderer (the project's only renderer). The native encode + ledger-history
 * confirmation are mocked at their module boundaries; QrScanner is stubbed (the camera never opens —
 * the request-QR branch only mounts it while scanning, which this flow never enters).
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Share, Platform, Text} from 'react-native';

jest.mock('../services/native', () => ({
  DpayCore: {
    encodeRequest: jest.fn(),
    // The wallet's own ICRC-1 account — the destination of the shareable payment link.
    icpSelfPrincipal: jest.fn(async () => 'ryjl3-tyaaa-aaaaa-aaaba-cai'),
  },
  DpayNfc: {
    buildRequest: jest.fn(),
  },
}));
jest.mock('../services/icp', () => ({icStampExpiry: jest.fn()}));
jest.mock('../services/relay', () => ({
  fetchWithTimeout: jest.fn(async () => ({ok: false})),
}));
jest.mock('../services/rail', () => ({
  confirmIncomingTransfer: jest.fn(),
  submitAndConfirmIncomingTransfer: jest.fn(),
  qrPayloadToEnvelopeHex: jest.fn(),
}));
jest.mock('../components/QrScanner', () => ({
  QrScanner: (_props: {onScan: (raw: string) => void}) => null,
}));
jest.mock('../components/NfcTap', () => ({NfcTap: jest.fn(() => null)}));

import {DpayCore, DpayNfc} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {confirmIncomingTransfer} from '../services/rail';
import {ReceiveMode} from '../components/ReceiveMode';
import {NfcTap} from '../components/NfcTap';
import {receiptShareBlob} from '../lib/deepLink';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {S} from '../styles';
import type {CurrencyDescriptor} from '../config/catalog';
import type {SelectableAsset} from '../config/assets';
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

// The wallet's own ICRC-1 account (mocked DpayCore.icpSelfPrincipal) — the destination of the
// shareable payment link built from an open request.
const SELF_PRINCIPAL = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
// The selected asset the share link names. DEMO settles on the Internet Computer like every other
// IC row, so its link reads `?asset=DEMO&network=internet-computer`.
const DEMO_ASSET: SelectableAsset = {
  id: 'ic:0', protocol: 'ic', currency: 0, symbol: 'DEMO', linkToken: 'DEMO',
  networkLabel: 'play money', network: null, decimals: 2, visible: true,
  capabilities: {onramp: 'Direct', offramp: 'Unavailable'}, testKey: 'demo',
};

const shareSpy = jest.spyOn(Share, 'share');

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
    assets: [DEMO_ASSET],
    selectedAssetId: 'ic:0',
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
  test('NFC request uses a certified short ingress expiry while QR keeps its 15-minute expiry', async () => {
    jest.mocked(icStampExpiry).mockResolvedValue('1800000240123456789');
    jest.mocked(DpayNfc.buildRequest).mockResolvedValue('nfc-request');
    const tree = mountReceive({nfcReady: true});
    await makeRequest(tree);
    expect(DpayNfc.buildRequest).toHaveBeenCalledWith(
      IDENTITY.publicHex, '2500', expect.any(String), 1_800_000_240, 0, IDENTITY.username, '',
    );
    const qrExpiry = jest.mocked(DpayCore.encodeRequest).mock.calls[0][3];
    expect(qrExpiry).not.toBe(1_800_000_240);
    expect(qrExpiry).toBeGreaterThan(Math.floor(Date.now() / 1000) + 800);
  });

  test('expired short NFC request is no longer advertised while the QR remains valid', async () => {
    let nowMs = 1_800_000_000_000;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    jest.mocked(icStampExpiry).mockResolvedValue('1800000002000000000');
    jest.mocked(DpayNfc.buildRequest).mockResolvedValue('nfc-request');
    const tree = mountReceive({nfcReady: true});
    await makeRequest(tree);
    expect(texts(tree).join(' ')).toContain('or let them tap');

    nowMs += 3_000;
    act(() => jest.advanceTimersByTime(1_000));
    const visible = texts(tree).join(' ');
    expect(visible).toContain('NFC tap expired');
    expect(visible).not.toContain('or let them tap');
    expect(hasTestID(tree, 'request-qr')).toBe(true);
    dateSpy.mockRestore();
  });

  test('an active NFC settlement survives request expiry for a result-only re-tap', async () => {
    let nowMs = 1_800_000_000_000;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    jest.mocked(icStampExpiry).mockResolvedValue('1800000002000000000');
    jest.mocked(DpayNfc.buildRequest).mockResolvedValue('nfc-request');
    const tree = mountReceive({nfcReady: true});
    await makeRequest(tree);

    const props = jest.mocked(NfcTap).mock.calls.at(-1)?.[0];
    expect(props).toBeDefined();
    act(() => props?.onActive?.());
    const callsBeforeExpiry = jest.mocked(NfcTap).mock.calls.length;
    nowMs += 3_000;
    act(() => jest.advanceTimersByTime(1_000));
    expect(jest.mocked(NfcTap).mock.calls.length).toBeGreaterThan(callsBeforeExpiry);
    expect(texts(tree).join(' ')).not.toContain('NFC tap expired');
    dateSpy.mockRestore();
  });

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
    // The shared payload is the PAYMENT LINK: this wallet's own account in the path, the exact
    // asset + settlement chain and the typed amount in the query, and the request nonce as `ref`
    // so a link payment reconciles against this very request. On web it carries the page origin
    // (empty in jest — a relative URL is still openable same-origin).
    const shared = jest.mocked(shareSpy).mock.calls[0][0] as {message: string};
    expect(shared.message).toContain(`/wallet/pay/${SELF_PRINCIPAL}?`);
    const q = new URL(shared.message, 'https://dpay.invalid').searchParams;
    expect(q.get('asset')).toBe('DEMO');
    expect(q.get('network')).toBe('internet-computer');
    expect(q.get('amount')).toBe('25'); // the amount makeRequest types
    expect(q.get('label')).toBe(IDENTITY.username);
    expect(q.get('ref')).toMatch(/^[0-9a-f]{32}$/);
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
    // On native there is no page origin to read, so the link carries the canonical public wallet
    // origin — a link shared from a phone must open for a recipient who has never heard of this
    // device's relay setting.
    expect(shareSpy).toHaveBeenCalledWith({message: expect.stringContaining(`https://dpay.kalaj.org/wallet/pay/${SELF_PRINCIPAL}?`)});
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

// --- F2/F6: a rail-proof deeplink is only a trigger; exact ledger history is authoritative --------
describe('ReceiveMode — rail-proof deeplink is history-gated, never fabricated', () => {
  const CATALOG: CurrencyDescriptor[] = [{
    currency: 0, ledger: 'td2nx-oaaaa-aaaab-qhdnq-cai', mintable: true, minter: null,
    minter_family: null, symbol: null, decimals: 2, wrapper_name: null, backing_symbol: null,
    network: null, display_decimals: 2, fee: null, cap: null, chain_id: null, token_contract: null,
    gas_ledger: null, onramp: 'Unavailable', offramp: 'Unavailable', testnet: false,
  }];
  const FORGED = receiptShareBlob({request_id: '00'.repeat(32), block_index: '7', ledger: 'x'});

  beforeEach(() => {
    jest.mocked(confirmIncomingTransfer).mockReset();
  });

  test('a forged-but-well-formed proof cannot render Received without an exact history match', async () => {
    const onReceived = jest.fn();
    const tree = mountReceive({catalog: CATALOG, onReceived});
    await makeRequest(tree);
    expect(hasTestID(tree, 'request-qr')).toBe(true);
    jest.mocked(confirmIncomingTransfer).mockResolvedValue(false);
    rerenderReceive(tree, {catalog: CATALOG, onReceived, prefillReceipt: FORGED});
    await act(async () => {});
    expect(confirmIncomingTransfer).toHaveBeenCalledWith(expect.objectContaining({
      receiverPublicHex: IDENTITY.publicHex, currency: 0, amount: '2500',
    }), expect.any(Object));
    expect(texts(tree).join(' ')).not.toContain('Received'); // the F2 invariant
    expect(onReceived).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('the same proof flips to Received only when exact ledger history confirms the open request', async () => {
    const onReceived = jest.fn();
    const tree = mountReceive({catalog: CATALOG, onReceived});
    await makeRequest(tree);
    jest.mocked(confirmIncomingTransfer).mockResolvedValue(true);
    rerenderReceive(tree, {catalog: CATALOG, onReceived, prefillReceipt: FORGED});
    await act(async () => {});
    expect(texts(tree).join(' ')).toContain('Received');
    expect(onReceived).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('a proof with no open request is ignored — no fabricated amount or settlement', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const onReceived = jest.fn();
    try {
      const tree = mountReceive({catalog: CATALOG, onReceived, prefillReceipt: FORGED});
      await act(async () => {});
      expect(confirmIncomingTransfer).not.toHaveBeenCalled();
      expect(texts(tree).join(' ')).not.toContain('Received');
      expect(onReceived).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no open request'));
      act(() => { tree.unmount(); });
    } finally {
      warn.mockRestore();
    }
  });

  test('a malformed proof is refused before any history lookup', async () => {
    const tree = mountReceive({catalog: CATALOG});
    await makeRequest(tree);
    const bad = receiptShareBlob({request_id: 'zz', block_index: '7'}); // fails the 64-hex gate
    rerenderReceive(tree, {catalog: CATALOG, prefillReceipt: bad});
    await act(async () => {});

    expect(texts(tree).join(' ')).toContain("This receipt doesn't match your open request.");
    expect(texts(tree).join(' ')).not.toContain('Received');
    expect(confirmIncomingTransfer).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });
});

// --- U2 (2026-08-28): the Receive amount prefix renders the honest VCHF/ICP unit text ------------
// currencySymbol now returns the exact payment-unit text for a COMPLETE trusted direct-ICRC row
// ('VCHF'/'ICP' — not '?'). These pin the RENDERED prefix (the `req-prefix` pressable) + the layout
// invariants that keep it visible at every width: the container is content-sized (no fixed width
// can clip) and the widest honest unit fits the narrowest mobile viewport (320dp) under a
// conservative glyph bound. This file is in the scan-screen layout tree, so the change is surgical:
// ReceiveMode.tsx + styles.ts are UNTOUCHED — these tests pin why that is safe.
describe('ReceiveMode — VCHF/ICP amount prefix (U2 honest textual units)', () => {
  const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);

  /** The unit text rendered inside the `req-prefix` pressable (before the chevron icon). */
  const prefixText = (tree: renderer.ReactTestRenderer): string => {
    const node = tree.root.findAll(n => n.props && n.props.testID === 'req-prefix')[0];
    const unit = node.findAllByType(Text)[0];
    return textOf(unit.props.children);
  };

  test('mounts with the exact unit text VCHF (currency 7) — not "?"', () => {
    const tree = mountReceive({catalog: BUNDLED, selectedCurrency: 7});
    expect(prefixText(tree)).toBe('VCHF');
    act(() => { tree.unmount(); });
  });

  test('mounts with the exact unit text ICP (currency 8) — not "?"', () => {
    const tree = mountReceive({catalog: BUNDLED, selectedCurrency: 8});
    expect(prefixText(tree)).toBe('ICP');
    act(() => { tree.unmount(); });
  });

  test('the prefix container is CONTENT-SIZED — no fixed width can clip the unit text', () => {
    // S.prefixBtn must carry no width/minWidth/maxWidth: the flex:1 amount input yields space, so
    // the widest honest unit never truncates. Read from S so a future style edit that pins a width
    // fails HERE (deterministically, offline) instead of on a device.
    const prefixBtn = S.prefixBtn as Record<string, unknown>;
    expect(prefixBtn.width).toBeUndefined();
    expect(prefixBtn.minWidth).toBeUndefined();
    expect(prefixBtn.maxWidth).toBeUndefined();
    expect((S.amountInput as Record<string, unknown>).flex).toBe(1);
  });

  test('the VCHF prefix fits the NARROWEST mobile width (320dp) under a conservative glyph bound', () => {
    // Budget at 320dp (the smallest RN baseline viewport): viewport − body paddingHorizontal×2 −
    // amountRow paddingHorizontal×2. Worst-case prefix: 4 chars × 0.75em (bold advance) × fontSize
    // 34 + chevron 20 + prefixBtn paddingRight 12. Every number is read from S so a style change
    // that shrinks the budget (or grows the prefix font) fails here, not on a device.
    const NARROWEST_VIEWPORT = 320;
    const budget =
      NARROWEST_VIEWPORT -
      2 * Number(S.body.paddingHorizontal) -
      2 * Number(S.amountRow.paddingHorizontal);
    const glyphPx = Number(S.currency.fontSize) * 0.75;
    const worstCasePrefix =
      'VCHF'.length * glyphPx + 20 /* IconChevronDown size */ + Number(S.prefixBtn.paddingRight);
    expect(worstCasePrefix).toBeLessThanOrEqual(budget);
    // Desktop/web is capped WIDER (root maxWidth 480 ≥ 320), so the mobile bound subsumes it.
    expect(Number(S.root.maxWidth)).toBeGreaterThanOrEqual(NARROWEST_VIEWPORT);
  });

  test('(web) the same honest prefix at desktop width — the unit text is platform-independent', () => {
    asWeb();
    const tree = mountReceive({catalog: BUNDLED, selectedCurrency: 7});
    expect(prefixText(tree)).toBe('VCHF');
    act(() => { tree.unmount(); });
  });
});
