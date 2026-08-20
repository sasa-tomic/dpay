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
  },
  DpayNfc: undefined,
}));
jest.mock('../services/rail', () => ({
  prepareTransfer: jest.fn(),
  submitTransfer: jest.fn(),
  pollTransfer: jest.fn(),
  envelopeToQrPayload: jest.fn(),
}));
jest.mock('../components/QrScanner', () => ({
  QrScanner: (_props: {onScan: (raw: string) => void}) => null,
}));

import {DpayCore} from '../services/native';
import {prepareTransfer, submitTransfer, pollTransfer, envelopeToQrPayload, type RailPrepared} from '../services/rail';
import {PayMode} from '../components/PayMode';
import {POLL} from '../config/constants';
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
// A fixed prepared IC-rail transfer (the payer's signed /call envelope + its request_id).
const PREPARED: RailPrepared = {
  ledger: 'td2nx-oaaaa-aaaab-qhdnq-cai',
  envelopeHex: 'ee'.repeat(195),
  requestIdHex: 'cd'.repeat(32),
  amount: '2500',
  currency: 0,
  memoHex: 'ab'.repeat(16),
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
  // Real timers leak past the test's end (poll intervals keep the loop alive outside act). Fake
  // timers, but a REAL Date — the request fixtures compute expiry/iat from Date.now().
  jest.useFakeTimers({doNotFake: ['Date']});
  shareSpy.mockReset().mockResolvedValue({action: 'sharedAction' as const});
  // The rail mocks: prepareTransfer returns a fixed prepared envelope; submitTransfer defaults to
  // unknown (offline-style handoff) so the flows land in the qr phase; envelopeToQrPayload is
  // identity-shaped so the share assertions can pin the exact payload.
  jest.mocked(prepareTransfer).mockReset().mockResolvedValue(PREPARED);
  jest.mocked(submitTransfer).mockReset().mockResolvedValue({kind: 'unknown'});
  jest.mocked(envelopeToQrPayload).mockReset().mockImplementation((hex: string) => `QR:${hex.slice(0, 8)}`);
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
    const tree = mountPay({online: false});
    await scanToReview(tree, REQ);
    pressByTestID(tree, 'btn-approve');
    await act(async () => {}); // flush prepareTransfer → the qr phase (submit unknown by default)
    expect(texts(tree)).toContain('Share auth code');
    await pressByLabel(tree, 'Share auth code');
    expect(shareSpy).toHaveBeenCalledWith({message: `QR:${'ee'.repeat(4)}`});
    expect(texts(tree)).toContain('Copied ✓');
    expect(texts(tree)).not.toContain('Share auth code');
    act(() => {
      tree.unmount();
    });
  });

  test('paid screen (web): "Share receipt" flips to "Link copied ✓" after the share resolves (testID unchanged)', async () => {
    asWeb();
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'settled', blockIndex: '42'});
    const tree = mountPay({online: true});
    await scanToReview(tree, REQ);
    pressByTestID(tree, 'btn-approve');
    await act(async () => {}); // flush submit → settled → the paid phase
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

// Double-pay / silent-spin guards (post-cutover audit 2026-08-20, items 3+4).
//
// Item 3 — the offline-QR reconcile poll treated ONLY 'settled' as actionable; a terminal ledger
// REJECTION of the envelope spun silently forever (the payer kept showing a dead QR). Fix: mirror
// the ReceiveMode settlement poll — surface the reason (qr-err testID) + stop polling; 'unknown'
// stays honest-pending.
//
// Item 4 — after an online submit ended 'unknown' the envelope fell to the QR hand-off (correct),
// but reset() + re-scan + Approve RE-SIGNED a fresh envelope (new request_id). If the merchant
// scanned the first QR, both could settle. Fix: retain the submitted envelope; a re-approve of the
// SAME request (nonce match) re-displays THAT envelope's QR — prepareTransfer never runs again.
describe('PayMode — offline-QR reconcile + re-approve guards', () => {
  async function approveToQr(tree: renderer.ReactTestRenderer, req: Req) {
    await scanToReview(tree, req);
    await act(async () => {
      pressByTestID(tree, 'btn-approve');
    });
    // one macrotask drain: submitTransfer + the first reconcile poll fire on approve
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
  }

  test('a TERMINAL rejection in the QR reconcile poll surfaces the reason and STOPS polling', async () => {
    jest.mocked(pollTransfer).mockReset().mockResolvedValue({kind: 'rejected', reason: 'Not enough balance'});
    const tree = mountPay({online: false});
    await approveToQr(tree, REQ);
    expect(hasTestID(tree, 'qr-err')).toBe(true);
    expect(textByTestID(tree, 'qr-err')).toBe('Not enough balance');
    const calls = jest.mocked(pollTransfer).mock.calls.length;
    // the effect re-runs on the err state change (err gates the poll off); no further ticks fire
    jest.advanceTimersByTime(POLL.receiptPay * 3);
    await act(async () => {});
    expect(jest.mocked(pollTransfer).mock.calls.length).toBe(calls);
    act(() => {
      tree.unmount();
    });
  });

  test("'unknown' in the reconcile poll stays honest-pending — no qr-err, polling continues", async () => {
    jest.mocked(pollTransfer).mockReset().mockResolvedValue({kind: 'unknown'});
    const tree = mountPay({online: false});
    await approveToQr(tree, REQ);
    expect(hasTestID(tree, 'qr-err')).toBe(false);
    jest.advanceTimersByTime(POLL.receiptPay * 2);
    await act(async () => {});
    expect(jest.mocked(pollTransfer).mock.calls.length).toBeGreaterThan(1);
    act(() => {
      tree.unmount();
    });
  });

  test('re-approve after an online UNKNOWN re-displays the SAME envelope — prepareTransfer never re-signs', async () => {
    // online submit ends unknown → the envelope falls to the QR hand-off and is retained.
    const tree = mountPay({online: true});
    await approveToQr(tree, REQ);
    expect(jest.mocked(prepareTransfer).mock.calls.length).toBe(1);
    expect(texts(tree)).toContain('Waiting for Cafe to scan…'); // online waiting copy, no Cancel
    // The payer can only back out once the connection drops (the offline variant shows Cancel).
    act(() => {
      tree.update(
        <PayMode
          identity={IDENTITY}
          online={false}
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
        />,
      );
    });
    // reset via Cancel — then re-scan the SAME request + re-approve → the SAME envelope's QR,
    // no fresh signature (the merchant may already have scanned the first QR).
    pressByTestID(tree, 'btn-notpaid');
    await scanToReview(tree, REQ);
    await act(async () => {
      pressByTestID(tree, 'btn-approve');
    });
    await act(async () => {});
    expect(jest.mocked(prepareTransfer).mock.calls.length).toBe(1); // NEVER re-signed
    expect(jest.mocked(submitTransfer).mock.calls.length).toBe(1); // not re-submitted either
    expect(jest.mocked(envelopeToQrPayload).mock.calls.length).toBe(2);
    expect(jest.mocked(envelopeToQrPayload).mock.calls[1][0]).toBe(PREPARED.envelopeHex); // same bytes
    expect(hasTestID(tree, 'btn-notpaid')).toBe(true); // QR phase re-displayed
    act(() => {
      tree.unmount();
    });
  });

  test('an offline QR hand-off is retained too — Cancel + re-approve re-displays the same bytes', async () => {
    const tree = mountPay({online: false});
    await approveToQr(tree, REQ);
    expect(jest.mocked(prepareTransfer).mock.calls.length).toBe(1);
    pressByTestID(tree, 'btn-notpaid'); // Cancel after the merchant may have scanned
    await scanToReview(tree, REQ);
    await act(async () => {
      pressByTestID(tree, 'btn-approve');
    });
    await act(async () => {});
    expect(jest.mocked(prepareTransfer).mock.calls.length).toBe(1); // NEVER re-signed
    expect(jest.mocked(envelopeToQrPayload).mock.calls[1][0]).toBe(PREPARED.envelopeHex);
    act(() => {
      tree.unmount();
    });
  });

  test('a FRESH request after reset prepares a fresh envelope (retention is nonce-scoped, not global)', async () => {
    const tree = mountPay({online: false});
    await approveToQr(tree, REQ);
    expect(jest.mocked(prepareTransfer).mock.calls.length).toBe(1);
    pressByTestID(tree, 'btn-notpaid');
    const FRESH: Req = {...REQ, nonceHex: 'cd'.repeat(16)};
    await scanToReview(tree, FRESH);
    await act(async () => {
      pressByTestID(tree, 'btn-approve');
    });
    await act(async () => {});
    expect(jest.mocked(prepareTransfer).mock.calls.length).toBe(2); // fresh signature allowed
    act(() => {
      tree.unmount();
    });
  });
});
