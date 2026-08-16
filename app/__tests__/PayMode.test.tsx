/**
 * PayMode — the payer-side review + share affordances (U-F1/U-F5, 2026-08-16 UX findings).
 *
 *   - U-F5: the review screen shows the payee's SHORT pubkey (first 8 hex + '…') as a subdued
 *     secondary line under the display name, so the payer can verify the destination beyond a
 *     claimed name (phishing surface). Only when a name is shown — the no-name fallback already
 *     renders the short key as the primary "to" line.
 *   - U-F1: the two share buttons (receipt link on the paid screen, auth code on the offline QR
 *     screen) flip to a visible 'Link copied ✓' / 'Copied ✓' confirmation after Share resolves
 *     with sharedAction. A dismissal resolves dismissedAction and leaves the label honest.
 *     Mirrors the DepositSheet useCopyFeedback pattern; testIDs stay untouched (e2e contract).
 *
 * Uses react-test-renderer (the project's only renderer). The native/relay/receipt services are
 * mocked at their module boundaries; QrScanner is stubbed so its onScan prop can be driven
 * directly (the camera never opens under jest).
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Share, Platform, Text} from 'react-native';

jest.mock('../services/native', () => ({
  DpayCore: {
    decodeRequest: jest.fn(),
    signAuthorization: jest.fn(),
    verifyWire: jest.fn(),
    encodeQr: jest.fn(),
  },
}));
jest.mock('../services/relay', () => ({
  fetchWithTimeout: jest.fn(async () => ({ok: false})),
  readJsonOrEmpty: jest.fn(),
  payAndClassify: jest.fn(),
}));
jest.mock('../services/receipt', () => ({
  verifyOutcomeReceipt: jest.fn(),
}));
jest.mock('../components/QrScanner', () => ({
  QrScanner: (_props: {onScan: (raw: string) => void}) => null,
}));

import {DpayCore} from '../services/native';
import {payAndClassify} from '../services/relay';
import {verifyOutcomeReceipt} from '../services/receipt';
import {PayMode} from '../components/PayMode';
import type {Req, Identity} from '../lib/types';

const IDENTITY: Identity = {secretHex: '11'.repeat(32), publicHex: '22'.repeat(32), username: 'Alice'};
const PAYEE_HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const REQ: Req = {
  toHex: PAYEE_HEX,
  amount: '2500',
  nonceHex: 'ab'.repeat(16),
  expiry: Math.floor(Date.now() / 1000) + 600,
  currency: 0,
  toName: 'Cafe',
  memo: '',
};

const shareSpy = jest.spyOn(Share, 'share');

type PayModeProps = Parameters<typeof PayMode>[0];

function mountPay(props: Partial<PayModeProps> = {}) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <PayMode
        identity={IDENTITY}
        online={false}
        relayUrl="http://relay.test"
        nfcStatus="unknown"
        onSettled={() => {}}
        onOfflinePaid={() => {}}
        shownBalance="10000"
        catalog={[]}
        assetBalances={{}}
        withdrawCurrency={0}
        withdrawDisplay={null}
        withdrawFamily={null}
        withdrawTokenContract={null}
        withdrawBalance="10000"
        subMode="scan"
        onSubModeChange={() => {}}
        onShowDepositAddress={() => {}}
        {...props}
      />,
    );
  });
  return tree;
}

/** Drive the camera-scan decode path (the same path a deeplink prefill reuses). */
async function scanToReview(tree: renderer.ReactTestRenderer, req: Req) {
  jest.mocked(DpayCore.decodeRequest).mockResolvedValue(req);
  const scanner = tree.root.find(node => typeof node.props.onScan === 'function');
  await act(async () => {
    scanner.props.onScan('abcdef123456');
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

function textByTestID(tree: renderer.ReactTestRenderer, testID: string): string {
  const node = tree.root.findAll(node => node.props && node.props.testID === testID)[0];
  return node ? textOf(node.props.children) : '';
}

function pressByTestID(tree: renderer.ReactTestRenderer, testID: string) {
  const node = tree.root.findAll(node => node.props && node.props.testID === testID)[0];
  if (!node) throw new Error(`no node with testID=${testID}`);
  act(() => {
    node.props.onPress();
  });
}

async function pressByLabel(tree: renderer.ReactTestRenderer, label: string) {
  const node = tree.root.findAll(node => node.props && node.props.accessibilityLabel === label)[0];
  if (!node) throw new Error(`no node with accessibilityLabel=${label}`);
  await act(async () => {
    node.props.onPress();
  });
}

beforeEach(() => {
  // Real timers leak past the test's end (the direct-pay timeout wrapper keeps the loop alive and
  // ReceiveMode-style 1s clocks fire outside act). Fake timers, but a REAL Date — the request
  // fixtures compute expiry/iat from Date.now().
  jest.useFakeTimers({doNotFake: ['Date']});
  shareSpy.mockReset().mockResolvedValue({action: 'sharedAction' as const});
  jest.mocked(payAndClassify).mockReset();
  jest.mocked(verifyOutcomeReceipt).mockReset().mockResolvedValue(true);
});

afterEach(() => {
  jest.useRealTimers(); // fake timers leak past suite end if left installed (force-exited worker)
  (Platform as {OS: string}).OS = 'ios'; // restore the jest-preset default (webLabel() tests mutate it)
});

// The jest preset pins Platform.OS to 'ios' (native). The share confirmation label is
// platform-aware (shareConfirmLabel): web says what the fallback DID ('Copied ✓' / 'Link copied
// ✓' — the no-Web-Share path copies), native says 'Shared ✓' (the real Share sheet was the
// feedback, nothing was copied). The flip tests below run as WEB; the native side has its own test.
function asWeb() {
  (Platform as {OS: string}).OS = 'web';
}

describe('PayMode — review short pubkey (U-F5)', () => {
  test('a named payee shows the short pubkey as a subdued second line under "to <name>"', async () => {
    const tree = mountPay();
    await scanToReview(tree, REQ);
    expect(texts(tree)).toContain('to Cafe');
    expect(hasTestID(tree, 'review-payee')).toBe(true);
    expect(textByTestID(tree, 'review-payee')).toBe('a1b2c3d4…');
    act(() => {
      tree.unmount();
    });
  });

  test('an unnamed payee keeps the short key as the primary "to" line — no duplicate second line', async () => {
    const tree = mountPay();
    await scanToReview(tree, {...REQ, toName: ''});
    expect(texts(tree)).toContain(`to ${PAYEE_HEX.slice(0, 8)}…`);
    expect(hasTestID(tree, 'review-payee')).toBe(false);
    act(() => {
      tree.unmount();
    });
  });
});

describe('PayMode — share feedback (U-F1)', () => {
  test('offline QR screen (web): "Share auth code" flips to "Copied ✓" after the share resolves', async () => {
    asWeb();
    jest.mocked(DpayCore.signAuthorization).mockResolvedValue('99'.repeat(162));
    jest.mocked(DpayCore.verifyWire).mockResolvedValue(true);
    jest.mocked(DpayCore.encodeQr).mockResolvedValue('SIGNEDQRCODE');
    const tree = mountPay({online: false});
    await scanToReview(tree, REQ);
    pressByTestID(tree, 'btn-approve');
    await act(async () => {}); // flush the sign promise chain to the qr phase
    expect(texts(tree)).toContain('Share auth code');
    await pressByLabel(tree, 'Share auth code');
    expect(shareSpy).toHaveBeenCalledWith({message: 'SIGNEDQRCODE'});
    expect(texts(tree)).toContain('Copied ✓');
    expect(texts(tree)).not.toContain('Share auth code');
    act(() => {
      tree.unmount();
    });
  });

  test('paid screen (web): "Share receipt" flips to "Link copied ✓" after the share resolves (testID unchanged)', async () => {
    asWeb();
    jest.mocked(DpayCore.signAuthorization).mockResolvedValue('99'.repeat(162));
    jest.mocked(DpayCore.verifyWire).mockResolvedValue(true);
    jest.mocked(DpayCore.encodeQr).mockResolvedValue('SIGNEDQRCODE');
    jest.mocked(payAndClassify).mockResolvedValue({outcome: 'settled', body: {receipt: {nonce: 'x'}, replayed: false}});
    const tree = mountPay({online: true});
    await scanToReview(tree, REQ);
    pressByTestID(tree, 'btn-approve');
    await act(async () => {}); // flush the online settle path to the paid phase
    expect(hasTestID(tree, 'btn-share-receipt')).toBe(true);
    pressByTestID(tree, 'btn-share-receipt');
    await act(async () => {});
    expect(texts(tree)).toContain('Link copied ✓');
    expect(texts(tree)).not.toContain('Share receipt');
    act(() => {
      tree.unmount();
    });
  });

  test('native: a completed Share sheet flips to "Shared ✓" — never "Copied ✓" (nothing was copied)', async () => {
    jest.mocked(DpayCore.signAuthorization).mockResolvedValue('99'.repeat(162));
    jest.mocked(DpayCore.verifyWire).mockResolvedValue(true);
    jest.mocked(DpayCore.encodeQr).mockResolvedValue('SIGNEDQRCODE');
    const tree = mountPay({online: false});
    await scanToReview(tree, REQ);
    pressByTestID(tree, 'btn-approve');
    await act(async () => {});
    await pressByLabel(tree, 'Share auth code');
    expect(texts(tree)).toContain('Shared ✓');
    expect(texts(tree)).not.toContain('Copied ✓');
    act(() => {
      tree.unmount();
    });
  });

  test('a dismissed share sheet leaves the label honest (dismissedAction does not flip)', async () => {
    jest.mocked(DpayCore.signAuthorization).mockResolvedValue('99'.repeat(162));
    jest.mocked(DpayCore.verifyWire).mockResolvedValue(true);
    jest.mocked(DpayCore.encodeQr).mockResolvedValue('SIGNEDQRCODE');
    shareSpy.mockResolvedValue({action: 'dismissedAction' as const});
    const tree = mountPay({online: false});
    await scanToReview(tree, REQ);
    pressByTestID(tree, 'btn-approve');
    await act(async () => {});
    await pressByLabel(tree, 'Share auth code');
    expect(texts(tree)).toContain('Share auth code');
    expect(texts(tree)).not.toContain('Copied ✓');
    act(() => {
      tree.unmount();
    });
  });
});
