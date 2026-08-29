/**
 * PayMode — auto-sign + share affordances (U-F1/U-F5, 2026-08-16 UX findings; one-press rule
 * founder directive 2026-08-24).
 *
 *   - One-press rule: the camera-scan path AUTO-SIGNS on decode (the "Pay Now" gate press that
 *     armed the scanner IS the single deliberate press) — scan lands directly in the sign
 *     handoff/paid surfaces, never a review with an Approve button. The DEEPLINK entry is a
 *     zero-press arrival and keeps today's review card with its single Approve.
 *   - U-F5: the sign/paid surfaces show the payee's SHORT pubkey (first 8 hex + '…') as a
 *     subdued secondary line under the display name, so the payer can verify the destination
 *     beyond a claimed name (phishing surface). Only when a name is shown — the no-name
 *     fallback already renders the short key as the primary "to" line.
 *   - U-F1: the two share buttons (receipt link on the paid screen, auth code on the offline QR
 *     screen) flip to a visible 'Link copied ✓' / 'Copied ✓' confirmation after Share resolves
 *     with sharedAction. A dismissal resolves dismissedAction and leaves the label honest.
 *     Mirrors the DepositSheet useCopyFeedback pattern; testIDs stay untouched (e2e contract).
 *
 * Uses react-test-renderer (the project's only renderer). The native/relay/receipt services are
 * mocked at their module boundaries; QrScanner + NfcTap are stubbed so the camera/HCE rails never
 * open under jest while their MOUNT presence stays assertable (the pay-intent gate tests below).
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Share, Platform, Text} from 'react-native';

jest.mock('../services/native', () => ({
  DpayCore: {
    decodeRequest: jest.fn(),
  },
  DpayNfc: {},
}));
jest.mock('../services/rail', () => ({
  prepareTransfer: jest.fn(),
  submitTransfer: jest.fn(),
  pollTransfer: jest.fn(),
  envelopeToQrPayload: jest.fn(),
  // The wire→intent conversion is exercised for real in rail.test.ts; here it is stubbed so this
  // suite stays a pure component test (no DpayCore principal derivation on the scan path).
  wireRequestToIntent: jest.fn(),
}));
jest.mock('../components/QrScanner', () => ({
  QrScanner: (_props: {onScan: (raw: string) => void}) => null,
}));
jest.mock('../components/NfcTap', () => ({
  NfcTap: (_props: {role: string}) => null,
}));

import {DpayCore} from '../services/native';
import {prepareTransfer, submitTransfer, pollTransfer, envelopeToQrPayload, wireRequestToIntent, type RailPrepared} from '../services/rail';
import {PayMode} from '../components/PayMode';
import {POLL} from '../config/constants';
import type {Req, Identity, PayIntent} from '../lib/types';
import {M} from '../i18n';

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
// The payee's ICRC-1 account — what a payment LINK names directly (a scanned request names the
// pubkey above and the principal is derived from it).
const PAYEE_PRINCIPAL = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
// The intent a scanned wire request converts to (rail.wireRequestToIntent is stubbed in this suite).
const WIRE_INTENT: PayIntent = {
  toPrincipal: PAYEE_PRINCIPAL,
  toName: 'Cafe',
  toAccountText: 'a1b2c3d4…',
  amount: '2500',
  currency: 0,
  nonceHex: 'ab'.repeat(16),
  memo: '',
  expiry: REQ.expiry,
  source: 'wire',
};
// The intent a shared payment link resolves to: the destination is the full principal, there is no
// request expiry, and the name is whatever the sender wrote into the URL.
const LINK_INTENT: PayIntent = {
  ...WIRE_INTENT,
  toAccountText: PAYEE_PRINCIPAL,
  expiry: null,
  source: 'link',
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

function payElement(props: Partial<PayModeProps> = {}) {
  return (
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
    />
  );
}

function mountPay(props: Partial<PayModeProps> = {}) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(payElement(props));
  });
  return tree;
}

/** Drive the camera-scan decode path — the AUTO-SIGN entry (the "Pay Now" gate press armed it,
 *  so a payable request signs immediately; no Approve press exists on this path). Arms the
 *  pay-intent gate first — the scanner stub is not mounted until "Pay Now" is pressed. */
async function scanToSign(tree: renderer.ReactTestRenderer, req: Req) {
  jest.mocked(DpayCore.decodeRequest).mockResolvedValue(req);
  jest.mocked(wireRequestToIntent).mockResolvedValue({...WIRE_INTENT, amount: req.amount, currency: req.currency, nonceHex: req.nonceHex, expiry: req.expiry, toName: req.toName, memo: req.memo});
  pressByTestID(tree, 'btn-start-scan');
  const scanner = tree.root.find(node => typeof node.props.onScan === 'function');
  await act(async () => {
    scanner.props.onScan('abcdef123456');
  });
  await act(async () => {}); // flush the auto-sign's prepare/submit promises
}

/** Mounted camera rail — the QrScanner stub carries onScan; presence = armed camera. */
function scannerNodes(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll(node => node.props && typeof node.props.onScan === 'function');
}

/** Mounted HCE rail — the NfcTap stub carries role="card"; presence = armed card. */
function cardNodes(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll(node => node.props && node.props.role === 'card');
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

describe('PayMode — sign-status short pubkey (U-F5)', () => {
  // The camera path auto-signs; the payee lines live on the READ-ONLY signing status while the
  // envelope builds. Hang prepareTransfer so the surface stays put for the assertions.
  function hangPrepare() {
    jest.mocked(prepareTransfer).mockReset().mockImplementation(() => new Promise<RailPrepared>(() => {}));
  }

  test('a named payee shows the short pubkey as a subdued second line under "to <name>"', async () => {
    hangPrepare();
    const tree = mountPay();
    await scanToSign(tree, REQ);
    expect(texts(tree)).toContain('to Cafe');
    expect(texts(tree)).toContain('Signing…');
    expect(hasTestID(tree, 'review-payee')).toBe(true);
    expect(textByTestID(tree, 'review-payee')).toBe('a1b2c3d4…');
    expect(hasTestID(tree, 'btn-approve')).toBe(false); // one-press rule: no sign button exists
    act(() => {
      tree.unmount();
    });
  });

  test('an unnamed payee keeps the short key as the primary "to" line — no duplicate second line', async () => {
    hangPrepare();
    const tree = mountPay();
    await scanToSign(tree, {...REQ, toName: ''});
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
    await scanToSign(tree, REQ); // auto-sign → prepareTransfer → the qr phase (submit unknown by default)
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
    await scanToSign(tree, REQ); // auto-sign → submit settled → the paid phase
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
    await scanToSign(tree, REQ);
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
    await scanToSign(tree, REQ);
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
  // scanToSign already signs + flushes; one more macrotask drain so submitTransfer + the first
  // reconcile poll fire (the poll effect keys on the qr phase).
  async function scanToQr(tree: renderer.ReactTestRenderer, req: Req) {
    await scanToSign(tree, req);
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
  }

  test('a TERMINAL rejection in the QR reconcile poll surfaces the reason and STOPS polling', async () => {
    jest.mocked(pollTransfer).mockReset().mockResolvedValue({kind: 'rejected', reason: 'Not enough balance'});
    const tree = mountPay({online: false});
    await scanToQr(tree, REQ);
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
    await scanToQr(tree, REQ);
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
    await scanToQr(tree, REQ);
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
    // reset via Cancel — then re-scan the SAME request (auto-sign) → the SAME envelope's QR,
    // no fresh signature (the merchant may already have scanned the first QR).
    pressByTestID(tree, 'btn-notpaid');
    await scanToSign(tree, REQ);
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
    await scanToQr(tree, REQ);
    expect(jest.mocked(prepareTransfer).mock.calls.length).toBe(1);
    pressByTestID(tree, 'btn-notpaid'); // Cancel after the merchant may have scanned
    await scanToSign(tree, REQ); // re-scan auto-signs → nonce match re-displays the retained envelope
    expect(jest.mocked(prepareTransfer).mock.calls.length).toBe(1); // NEVER re-signed
    expect(jest.mocked(envelopeToQrPayload).mock.calls[1][0]).toBe(PREPARED.envelopeHex);
    act(() => {
      tree.unmount();
    });
  });

  test('a FRESH request after reset prepares a fresh envelope (retention is nonce-scoped, not global)', async () => {
    const tree = mountPay({online: false});
    await scanToQr(tree, REQ);
    expect(jest.mocked(prepareTransfer).mock.calls.length).toBe(1);
    pressByTestID(tree, 'btn-notpaid');
    const FRESH: Req = {...REQ, nonceHex: 'cd'.repeat(16)};
    await scanToSign(tree, FRESH);
    expect(jest.mocked(prepareTransfer).mock.calls.length).toBe(2); // fresh signature allowed
    act(() => {
      tree.unmount();
    });
  });
});

// Pay-intent scan gate (founder rule 2026-08-23): the camera (QrScanner) and the HCE card (NfcTap)
// mount ONLY after the payer's explicit "Pay Now" tap — nothing scans before the user asks.
// reset() (a concluded attempt needs a fresh intent) and leaving the scan sub-mode disarm; the idle
// surface keeps the NFC status row (pay-scan) + the CTA. Deeplink prefill is unaffected by design.
describe('PayMode — pay-intent scan gate', () => {
  test('idle: NEITHER rail mounts (no camera, no card); the status row + CTA render; one tap arms BOTH rails', () => {
    const tree = mountPay({nfcStatus: 'ready'});
    expect(hasTestID(tree, 'pay-scan')).toBe(true); // idle keeps the explainer row
    expect(hasTestID(tree, 'btn-start-scan')).toBe(true);
    expect(scannerNodes(tree)).toHaveLength(0); // camera rail off
    expect(cardNodes(tree)).toHaveLength(0); // HCE rail off (nfcReady, but gated)
    pressByTestID(tree, 'btn-start-scan');
    expect(scannerNodes(tree)).toHaveLength(1);
    expect(cardNodes(tree)).toHaveLength(1);
    expect(hasTestID(tree, 'btn-start-scan')).toBe(false);
    act(() => {
      tree.unmount();
    });
  });

  test("reset() (the qr-phase Cancel) disarms — the next attempt needs a fresh intent", async () => {
    const tree = mountPay();
    await scanToSign(tree, REQ); // auto-sign → qr phase (submit unknown by default)
    expect(hasTestID(tree, 'btn-notpaid')).toBe(true); // the offline qr-phase Cancel
    pressByTestID(tree, 'btn-notpaid');
    expect(hasTestID(tree, 'btn-start-scan')).toBe(true); // idle CTA back
    expect(scannerNodes(tree)).toHaveLength(0);
    act(() => {
      tree.unmount();
    });
  });

  test('leaving the scan sub-mode disarms; flipping back shows the idle CTA again', () => {
    const tree = mountPay();
    pressByTestID(tree, 'btn-start-scan');
    expect(scannerNodes(tree)).toHaveLength(1);
    // Wallet owns subMode; a scan↔send flip must disarm even though this DEMO-shaped tree (null
    // family) keeps rendering the scan branch — the disarm is state, not branch-dependent.
    act(() => {
      tree.update(payElement({subMode: 'send'}));
    });
    expect(scannerNodes(tree)).toHaveLength(0);
    act(() => {
      tree.update(payElement({subMode: 'scan'}));
    });
    expect(hasTestID(tree, 'btn-start-scan')).toBe(true);
    expect(scannerNodes(tree)).toHaveLength(0);
    act(() => {
      tree.unmount();
    });
  });

  test('a payment link reviews from IDLE — no arming, no camera, and NO auto-sign (zero-press entry)', async () => {
    const tree = mountPay({prefillIntent: LINK_INTENT, onPrefillConsumed: () => {}});
    await act(async () => {});
    expect(texts(tree)).toContain('to Cafe'); // review reached without btn-start-scan
    expect(hasTestID(tree, 'btn-start-scan')).toBe(false);
    expect(hasTestID(tree, 'btn-approve')).toBe(true); // the kept link review: ONE deliberate press
    expect(jest.mocked(prepareTransfer).mock.calls.length).toBe(0); // nothing signed before that press
    act(() => {
      tree.unmount();
    });
  });

  test('a payment link shows the FULL destination account and marks the sender-given name as claimed', async () => {
    // The account is the identity; the label is only what the sender wrote into the URL. Both are
    // on screen, and the caveat sits with the name (phishing surface).
    const tree = mountPay({prefillIntent: LINK_INTENT, onPrefillConsumed: () => {}});
    await act(async () => {});
    expect(textByTestID(tree, 'review-payee')).toBe(PAYEE_PRINCIPAL);
    expect(hasTestID(tree, 'review-claimed')).toBe(true);
    act(() => {
      tree.unmount();
    });
  });

  test('a payment link has no request expiry — an old link still reviews and signs', async () => {
    // A wire request dies after EXPIRY_WINDOW; a link is meant to survive a chat thread, so the
    // expiry gate must not fire on it (the envelope's own IC ingress expiry still bounds signing).
    jest.mocked(prepareTransfer).mockResolvedValue(PREPARED);
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'settled', blockIndex: '7'});
    const tree = mountPay({prefillIntent: LINK_INTENT, onPrefillConsumed: () => {}});
    await act(async () => {});
    await act(async () => { pressByTestID(tree, 'btn-approve'); });
    expect(jest.mocked(prepareTransfer).mock.calls.length).toBe(1);
    expect(texts(tree)).not.toContain(M.pay.requestExpired);
    act(() => {
      tree.unmount();
    });
  });
});
