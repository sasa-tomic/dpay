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
// The send-to-address body is exercised in SendSheet.test.tsx; here it is stubbed so this suite
// stays a pure PayMode test (SendSheet queries the ledger fee and derives the self-account), while
// the props PayMode hands it — the scanned-address prefill — stay assertable.
jest.mock('../components/SendSheet', () => ({
  SendSheet: (_props: {prefillAddress?: string | null}) => null,
}));
// The provider calls are exercised for real in opencryptopayClient.test.ts (recorded bodies, no
// network). Here they are stubbed so this stays a component test: what it pins is the WIRING — that
// a scanned till code lands on the review without signing, that Approve runs the payment through
// `payAndReport` exactly once, and that each of its three outcomes renders the right honest screen.
// `ocpTimeRefusal` is NOT stubbed: it is the module's ONE approve deadline, shared by the resolver,
// the countdown and both rails, and a hand-written copy of it here would be a second rule that can
// drift from the one under test.
jest.mock('../services/opencryptopay', () => ({
  ocpTimeRefusal: jest.requireActual<typeof import('../services/opencryptopay')>('../services/opencryptopay').ocpTimeRefusal,
  resolveOcpScan: jest.fn(),
  payAndReport: jest.fn(),
}));

import {DpayCore} from '../services/native';
import {prepareTransfer, submitTransfer, pollTransfer, envelopeToQrPayload, wireRequestToIntent, type RailPrepared} from '../services/rail';
import {payAndReport, resolveOcpScan, type OcpSendResult, type OcpTarget} from '../services/opencryptopay';
import {PayMode} from '../components/PayMode';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {buildSelectableAssets} from '../config/assets';
import {POLL} from '../config/constants';
import {IC_READ_STATE_TIMEOUT_MS, IC_SUBMIT_TIMEOUT_MS} from '../services/icp';
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
      relayUrl="https://relay.test"
      online={false}
      nfcStatus="unknown"
      onSettled={() => {}}
      onOfflinePaid={() => {}}
      shownBalance="10000"
      catalog={[]}
      assets={[]}
      assetBalances={{}}
      withdrawCurrency={0}
      withdrawDisplay={null}
      withdrawFamily={null}
      withdrawTokenContract={null}
      withdrawBalance="10000"
      subMode="scan"
      onSubModeChange={() => {}}
      onScannedLink={() => {}}
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
  // Honest pending by default. Reset here rather than only where it is exercised: a value left over
  // from a previous test would silently settle the NEXT test's hand-off out from under it.
  jest.mocked(pollTransfer).mockReset().mockResolvedValue({kind: 'unknown'});
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
      tree.update(payElement({online: false}));
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

// The camera's second opinion (defects found 2026-08-30). "Not a 132-byte wire request" used to be
// the end of the conversation, which made two legitimate codes dead ends: a printed PAYMENT LINK
// (only ever reachable through an OS App Link) and a plain wallet ADDRESS (including the principal
// dpay's own Receive ▸ My address renders). Founder rule 2026-08-29: every error path gives the
// user something to do. Classification itself is pinned in scan.test.ts; these pin the ROUTING.
describe('PayMode — what the camera does with a code that is not a payment request', () => {
  const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
  const CKBTC = CATALOG.find(c => c.currency === 1)!;
  const PAY_LINK = `https://dpay.kalaj.org/wallet/pay/${PAYEE_PRINCIPAL}?asset=ckBTC&network=internet-computer&amount=0.001`;
  const IC_ACCOUNT = 'k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae';

  /** Scan a payload the wire codec REFUSES — the entry to the fallback classifier. */
  async function scanUnreadable(tree: renderer.ReactTestRenderer, raw: string) {
    jest.mocked(DpayCore.decodeRequest).mockRejectedValue(new Error('bad wire request'));
    pressByTestID(tree, 'btn-start-scan');
    const scanner = tree.root.find(node => typeof node.props.onScan === 'function');
    await act(async () => {
      scanner.props.onScan(raw);
    });
  }

  /** A send-capable asset (ckBTC): a scanned address has somewhere to go. */
  function sendCapableProps() {
    return {catalog: CATALOG, withdrawCurrency: 1, withdrawFamily: 'CkBtcUtxo' as const, assetBalances: {1: '100000'}};
  }

  test('a scanned payment LINK is handed to the Wallet link pipeline VERBATIM — one link, one resolution', async () => {
    const scanned: string[] = [];
    const tree = mountPay({onScannedLink: (u: string) => scanned.push(u)});
    await scanUnreadable(tree, `  ${PAY_LINK}\n`);
    // Trimmed but otherwise untouched: PayMode must not re-parse or re-derive what the Wallet's
    // link pipeline already owns (catalog resolution, per-part error copy, cross-rail routing).
    expect(scanned).toEqual([PAY_LINK]);
    expect(texts(tree)).not.toContain(M.pay.notAPaymentCode);
    expect(jest.mocked(prepareTransfer).mock.calls.length).toBe(0); // a link NEVER auto-signs
    act(() => { tree.unmount(); });
  });

  test('a scanned ADDRESS switches to Send to address and prefills the destination', async () => {
    const modes: string[] = [];
    const tree = mountPay({...sendCapableProps(), online: true, onSubModeChange: (m: string) => modes.push(m)});
    await scanUnreadable(tree, IC_ACCOUNT);
    expect(modes).toEqual(['send']);
    expect(texts(tree)).not.toContain(M.pay.notAPaymentCode);
    // Wallet owns subMode, so re-render as it would: the send body receives the scanned address.
    act(() => { tree.update(payElement({...sendCapableProps(), online: true, subMode: 'send'})); });
    const sheet = tree.root.find(node => node.props && 'prefillAddress' in node.props);
    expect(sheet.props.prefillAddress).toBe(IC_ACCOUNT);
    act(() => { tree.unmount(); });
  });

  test('a scanned address for an asset that cannot leave the wallet refuses BY NAME and stays on scan', async () => {
    // DEMO has no on-chain identity, so there is no send form to open — the refusal has to be the
    // instruction, and it has to name the asset rather than shrug at the code.
    const modes: string[] = [];
    const tree = mountPay({catalog: CATALOG, withdrawCurrency: 0, onSubModeChange: (m: string) => modes.push(m)});
    await scanUnreadable(tree, IC_ACCOUNT);
    expect(modes).toEqual([]);
    expect(texts(tree)).toContain(M.pay.scannedAddressNotSendable('DEMO'));
    act(() => { tree.unmount(); });
  });

  test('a payload NOTHING recognises keeps the honest "not a payment code" refusal', async () => {
    const scanned: string[] = [];
    const modes: string[] = [];
    const tree = mountPay({...sendCapableProps(), onScannedLink: (u: string) => scanned.push(u), onSubModeChange: (m: string) => modes.push(m)});
    await scanUnreadable(tree, 'this is definitely not a valid request QR!!!');
    expect(texts(tree)).toContain(M.pay.notAPaymentCode);
    expect(scanned).toEqual([]);
    expect(modes).toEqual([]);
    act(() => { tree.unmount(); });
  });

  // The Pay tab's two halves have OPPOSITE connectivity truths and only one was ever stated. An
  // address send is submitted by THIS phone; offline it used to render the full form, disable Max
  // with no reason (the fee query failed silently) and fail at Confirm with a raw error string.
  test('offline, Send to address states the constraint and offers the rail that DOES work offline', () => {
    const modes: string[] = [];
    const tree = mountPay({...sendCapableProps(), online: false, subMode: 'send', onSubModeChange: (m: string) => modes.push(m)});
    expect(hasTestID(tree, 'pay-send-offline')).toBe(true);
    expect(tree.root.findAll(node => node.props && 'prefillAddress' in node.props)).toHaveLength(0);
    expect(texts(tree)).toContain(M.pay.offlineSendBody(CKBTC.backing_symbol ?? ''));
    pressByTestID(tree, 'pay-send-offline-go');
    expect(modes).toEqual(['scan']); // the primary is the way out, not a dead end
    act(() => { tree.unmount(); });
  });

  test('online, Send to address renders the form — the gate is connectivity, nothing else', () => {
    const tree = mountPay({...sendCapableProps(), online: true, subMode: 'send'});
    expect(hasTestID(tree, 'pay-send-offline')).toBe(false);
    expect(tree.root.findAll(node => node.props && 'prefillAddress' in node.props)).toHaveLength(1);
    act(() => { tree.unmount(); });
  });
});

// ---------------------------------------------------------------------------------------------
// OpenCryptoPay — a real merchant's till code, scanned with the dpay camera
// ---------------------------------------------------------------------------------------------
// The provider sequence itself (quote → destination → one-shot report) is
// `services/opencryptopay.ts` and is tested there against recorded bodies. What is pinned here is
// what the Pay screen does with it, and the two rules that make it safe: a till payment is NEVER
// auto-signed, and an outcome that is neither paid nor failed renders as neither.

/** A scanned till code (the LNURL a DFX till prints, uppercase as a QR encodes it). */
const TILL_QR = 'LNURL1DP68GURN8GHJ7CTSDYHXGENC9EEHW6TNWVHHVVF0D3H82UNVWQHHQMZLVFJK2ERYVG6RZCMYX33RVEPEV5YEJ9WT';
const TILL_PRINCIPAL = 'ygf2v-iniac-cojwe-damoz-s4act-k4xft-xgpjy-776wl-wr754-qxkgo-4ae';
const OCP_TARGET: OcpTarget = {
  details: {
    submitUrl: 'https://api.dfx.swiss/v1/lnurlp/tx/pl_beeddb41cd4b6d9e',
    // Where the proof goes. It equals the scanned host by construction: `fetchPaymentDetails`
    // refuses a quote whose callback names another host, which is what makes the ONE host this
    // screen shows the host that actually receives the money's proof.
    proofHost: 'api.dfx.swiss',
    quoteId: 'plq_ec214dddae51da4d',
    quoteExpiresAt: Date.now() + 300_000,
    callbackUrl: 'https://api.dfx.swiss/v1/lnurlp/cb/pl_beeddb41cd4b6d9e',
    claimedMerchantName: 'Test Shop',
    requestedAmount: {asset: 'CHF', amount: '1'},
    transferAmounts: [{method: 'InternetComputer', available: true, assets: [{asset: 'VCHF', amount: '1.'}]}],
  },
  host: 'api.dfx.swiss',
  method: 'InternetComputer',
  asset: 'VCHF',
  // The mounted PayMode's selected asset (currency 0) — which asset a till offer resolves TO is
  // decided in `resolveOcpScan` and tested there; here it only has to match the mount.
  assetId: 'ic:0',
  to: TILL_PRINCIPAL,
  rawAmount: '100',
  expiresAt: Date.now() + 300_000,
  // A live price with room to spare. The gap to `expiresAt` is what the countdown shows and what
  // Approve is gated on — see the deadline suite below.
  payableUntil: Date.now() + 180_000,
};

/** The DEMO row, so the mounted PayMode's selected asset (currency 0) is in the list. */
const DEMO_ASSET = buildSelectableAssets(icpCatalogOf(BUNDLED_NETWORKS), {showTestnet: false, solanaEnabled: false})
  .filter(a => a.id === 'ic:0');

/** Scan the till code with the camera. Resolution is async, so the returned tree is already on
 *  whatever surface the resolution produced. */
async function scanTill(tree: renderer.ReactTestRenderer) {
  jest.mocked(DpayCore.decodeRequest).mockRejectedValue(new Error('not a 132-byte request'));
  pressByTestID(tree, 'btn-start-scan');
  const scanner = tree.root.find(node => typeof node.props.onScan === 'function');
  await act(async () => {
    scanner.props.onScan(TILL_QR);
  });
  await act(async () => {});
}

function mountTill(props: Partial<PayModeProps> = {}) {
  return mountPay({online: true, catalog: icpCatalogOf(BUNDLED_NETWORKS), assets: DEMO_ASSET, ...props});
}

describe('PayMode — OpenCryptoPay till', () => {
  beforeEach(() => {
    jest.mocked(resolveOcpScan).mockReset().mockResolvedValue({kind: 'ok', target: OCP_TARGET});
    jest.mocked(payAndReport).mockReset().mockResolvedValue({kind: 'paid'});
  });

  test('a scanned till lands on a review showing the amount, the FULL destination and the provider host — and signs nothing', async () => {
    const tree = mountTill();
    await scanTill(tree);

    expect(textByTestID(tree, 'pay-amount')).toContain('1.00');
    // The full account, not a short form: the provider chose it, so it is the checkable part.
    expect(textByTestID(tree, 'review-payee')).toBe(TILL_PRINCIPAL);
    expect(textByTestID(tree, 'ocp-host')).toBe(M.pay.ocp.providerHost('api.dfx.swiss'));
    // The merchant name came out of the provider's JSON — marked as claimed, with the OCP wording
    // rather than the payment link's.
    expect(textByTestID(tree, 'review-claimed')).toBe(M.pay.ocp.claimedMerchant);
    // NEVER auto-signed: the amount and the destination came from a stranger's server.
    expect(prepareTransfer).not.toHaveBeenCalled();
    expect(payAndReport).not.toHaveBeenCalled();
    expect(hasTestID(tree, 'btn-approve')).toBe(true);
  });

  test('Approve runs the payment through the one-shot sequence and shows Paid on acceptance', async () => {
    const tree = mountTill();
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);

    expect(payAndReport).toHaveBeenCalledTimes(1);
    const [details, method, asset] = jest.mocked(payAndReport).mock.calls[0];
    expect(details).toBe(OCP_TARGET.details);
    expect(method).toBe('InternetComputer');
    expect(asset).toBe('VCHF');
    expect(texts(tree).join(' ')).toContain(M.nfc.paidAmount('∂1.00'));
    // A till payment never becomes an offline hand-off — there is no QR for a merchant to scan.
    expect(hasTestID(tree, 'btn-paid')).toBe(false);
  });

  test('an outcome that is neither paid nor failed renders as neither, carrying the reference', async () => {
    const message = M.pay.ocp.submitUnknown(M.pay.ocp.ref.icBlock('8168'));
    jest.mocked(payAndReport).mockResolvedValue({kind: 'unresolved', message});
    const tree = mountTill();
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);

    // The outcome screen, not an error the payer could read as "try again", and not "Paid ✓".
    expect(textByTestID(tree, 'ocp-outcome')).toBe(message);
    expect(texts(tree).join(' ')).not.toContain(M.nfc.paidAmount('∂1.00'));
    expect(hasTestID(tree, 'btn-approve')).toBe(false);
  });

  test('a payment that definitively did not happen stays on the review, with the reason and no re-tap', async () => {
    // Nothing moved, so this is an error rather than an outcome — and the review's existing rule
    // applies: a shown error disables Approve, so a doomed payment cannot be tapped again.
    jest.mocked(payAndReport).mockResolvedValue({kind: 'not-paid', message: 'Not enough balance'});
    const tree = mountTill();
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);

    expect(textByTestID(tree, 'review-err')).toBe('Not enough balance');
    const approve = tree.root.findAll(n => n.props && n.props.testID === 'btn-approve')[0];
    expect(approve.props.disabled).toBe(true);
    expect(hasTestID(tree, 'ocp-outcome')).toBe(false);
  });

  test('the IC rail reports a CONFIRMED block index, and anything else as unknown', async () => {
    // The `send` half of the sequence, captured from the call above and exercised directly: it is
    // the money-critical mapping — only a settled transfer with a real block index may be reported,
    // because the provider verifies that identifier against the ledger and spends the one attempt.
    const tree = mountTill();
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);
    const send = jest.mocked(payAndReport).mock.calls[0][3] as () => Promise<OcpSendResult>;

    jest.mocked(submitTransfer).mockResolvedValue({kind: 'settled', blockIndex: '8168'});
    await expect(send()).resolves.toEqual({
      kind: 'settled',
      txId: '8168',
      reference: M.pay.ocp.ref.icBlock('8168'),
    });

    // Settled but with NO block index (a duplicate the ledger did not number): nothing the provider
    // could verify, so it is not reported.
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'settled', blockIndex: ''});
    await expect(send()).resolves.toEqual({kind: 'unknown'});

    // Not terminal within budget: the transfer may still execute — never a decline, never reported.
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'unknown'});
    await expect(send()).resolves.toEqual({kind: 'unknown'});

    // A decoded ledger refusal IS definitive: nothing moved, so the payer gets the reason.
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'rejected', reason: 'Not enough balance'});
    await expect(send()).resolves.toEqual({kind: 'refused', message: 'Not enough balance'});

    // The submit POST itself failing says nothing about whether the envelope reached consensus.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.mocked(submitTransfer).mockRejectedValue(new Error('gateway unreachable'));
    await expect(send()).resolves.toEqual({kind: 'unknown'});
    // Signing itself failing is definitive — nothing was submitted.
    jest.mocked(prepareTransfer).mockRejectedValue(new Error('IC clock unreachable'));
    await expect(send()).resolves.toEqual({kind: 'refused', message: 'IC clock unreachable'});
    warn.mockRestore();
  });

  test('the review shows what the till is charging in ITS OWN unit, as the merchant’s figure', async () => {
    // `1.00000000 VCHF` is uncheckable on its own: the number on the till and in the cashier's
    // mouth is "CHF 1", so without this line the payer approves an amount they cannot compare
    // against the price of the sale. The copy attributes it to the merchant's provider — dpay
    // neither quotes nor converts (CLAUDE.md non-negotiable) — and it is the PROVIDER's own
    // `requestedAmount`, never a figure this wallet derived.
    const tree = mountTill();
    await scanTill(tree);

    expect(textByTestID(tree, 'ocp-requested')).toBe(M.pay.ocp.tillCharging('CHF 1'));
    expect(textByTestID(tree, 'ocp-requested')).toContain('dpay doesn’t convert');
  });

  test('a till that states no price of its own simply omits the line, and still pays', async () => {
    // Display context never blocks a payment (the same rule as the claimed merchant name): a
    // provider that sends no readable `requestedAmount` loses the line, not the Approve button.
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, details: {...OCP_TARGET.details, requestedAmount: null}},
    });
    const tree = mountTill();
    await scanTill(tree);

    expect(hasTestID(tree, 'ocp-requested')).toBe(false);
    expect(hasTestID(tree, 'btn-approve')).toBe(true);
  });

  test('a refusal from the provider sequence is shown on the scan screen, and nothing is signed', async () => {
    jest.mocked(resolveOcpScan).mockResolvedValue({kind: 'refused', message: M.pay.ocp.quoteExpired});
    const tree = mountTill();
    await scanTill(tree);

    expect(texts(tree)).toContain(M.pay.ocp.quoteExpired);
    expect(hasTestID(tree, 'btn-approve')).toBe(false);
    expect(prepareTransfer).not.toHaveBeenCalled();
  });

  // The countdown counts to the last instant Approve can be pressed — NOT to the quote's expiry.
  // Showing the quote's own countdown invites a press the sequence cannot complete: the funds move
  // first and the ONE proof submission then lands on a dead quote, spending everything for nothing.
  test('the countdown runs to the payable deadline, not to the quote’s expiry', async () => {
    const now = Date.now();
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, expiresAt: now + 300_000, payableUntil: now + 185_000},
    });
    const tree = mountTill();
    await scanTill(tree);
    // ~3 min of runway inside a 5 min quote. Showing the quote's own countdown would invite a press
    // the sequence cannot complete — the funds move first and the ONE submission then lands on a
    // dead quote.
    expect(textByTestID(tree, 'ocp-expiry')).toBe(M.receive.validForMin(3));
    expect(textByTestID(tree, 'ocp-expiry')).not.toBe(M.receive.validForMin(5));
  });

  test('the resolver is told which relay this wallet trusts — the setting, not a compiled-in host', async () => {
    // The till trust rule compares the provider's host against THIS string (`OcpProvider` in
    // lib/opencryptopay.ts). If the screen stopped forwarding the configured relay — or forwarded a
    // baked constant instead — the rule would still be correct and would trust the wrong party, so
    // what is pinned here is that the payer's own setting is what reaches it.
    const tree = mountTill({relayUrl: 'https://relay.chosen.example'});
    await scanTill(tree);
    expect(jest.mocked(resolveOcpScan).mock.calls[0][1].relayUrl).toBe('https://relay.chosen.example');
  });

  test('the runway this rail asks for covers the poll budget it actually uses', async () => {
    // Derived from what the component DOES, not from a copy of its arithmetic: whatever poll budget
    // `submitTransfer` is given, the deadline handed to the resolver has to cover the submit plus
    // all of those polls. A budget that undercounts them lets a payment start that cannot finish,
    // which is the whole defect — and this stays true the day a timeout constant moves.
    const tree = mountTill();
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);
    const send = jest.mocked(payAndReport).mock.calls[0][3] as () => Promise<OcpSendResult>;
    await send();

    const opts = jest.mocked(submitTransfer).mock.calls[0][2];
    const ctxArg = jest.mocked(resolveOcpScan).mock.calls[0][1];
    expect(ctxArg.sequenceBudgetMs).toBeGreaterThanOrEqual(
      IC_SUBMIT_TIMEOUT_MS + opts.attempts * (IC_READ_STATE_TIMEOUT_MS + opts.intervalMs),
    );
  });

  test('a price with too little runway left disables Approve and says why — even though it has not expired', async () => {
    // The exact state the countdown used to invite: still ticking, but no room for the whole
    // sequence. The refusal must NOT say "expired" — the payer can see it counting down.
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, expiresAt: Date.now() + 30_000, payableUntil: Date.now() - 1_000},
    });
    const tree = mountTill();
    await scanTill(tree);

    expect(textByTestID(tree, 'review-err')).toBe(M.pay.ocp.notEnoughTime);
    expect(tree.root.findAll(n => n.props && n.props.testID === 'btn-approve')[0].props.disabled).toBe(true);
  });

  test('a press that beats the countdown by a tick is still refused, and nothing is signed', async () => {
    // The countdown ticks once a second, so the press has to re-check: a payment started in that
    // window would move irreversible money against a price that can no longer be reported.
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, expiresAt: Date.now() + 30_000, payableUntil: Date.now() - 1_000},
    });
    const tree = mountTill();
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);

    expect(payAndReport).not.toHaveBeenCalled();
    expect(prepareTransfer).not.toHaveBeenCalled();
    expect(textByTestID(tree, 'review-err')).toBe(M.pay.ocp.notEnoughTime);
  });

  test('a quote that is genuinely past its expiry says THAT, not "not enough time"', async () => {
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, expiresAt: Date.now() - 1, payableUntil: Date.now() - 120_000},
    });
    const tree = mountTill();
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);

    expect(textByTestID(tree, 'review-err')).toBe(M.pay.ocp.quoteExpired);
    expect(payAndReport).not.toHaveBeenCalled();
  });

  test('a DAMAGED till code is named as one, without contacting any provider', async () => {
    const tree = mountTill();
    jest.mocked(DpayCore.decodeRequest).mockRejectedValue(new Error('not a 132-byte request'));
    pressByTestID(tree, 'btn-start-scan');
    const scanner = tree.root.find(node => typeof node.props.onScan === 'function');
    await act(async () => {
      scanner.props.onScan(`${TILL_QR.slice(0, -1)}Q`); // one scuffed character on the sticker
    });

    expect(texts(tree)).toContain(M.pay.ocp.badCode);
    expect(resolveOcpScan).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// An OpenCryptoPay transfer the IC rail could not resolve — the RECOVERABLE loss
// ---------------------------------------------------------------------------------------------
// The likeliest failure of a till payment is not a refusal: it is a flaky connection while the
// transfer is already in consensus. The money moved, the provider was not told, the quote is still
// alive and the block index is one more `pollTransfer` away — so throwing the prepared envelope
// away turns the recoverable case into the unrecoverable one.
//
// `payAndReport` is stubbed with its OWN contract (report a settled send, never an unknown one), so
// "was the provider told?" is answerable by looking at which calls' sends settled — and the
// one-shot rule is checked by counting them.
describe('PayMode — an unresolved till transfer stays recoverable', () => {
  /** Every send verdict `payAndReport` was handed, in order. */
  let sends: OcpSendResult[];

  beforeEach(() => {
    sends = [];
    jest.mocked(resolveOcpScan).mockReset().mockResolvedValue({kind: 'ok', target: OCP_TARGET});
    jest.mocked(pollTransfer).mockReset().mockResolvedValue({kind: 'unknown'});
    jest.mocked(payAndReport).mockReset().mockImplementation(async (_quote, _method, _asset, send) => {
      const s = await send();
      sends.push(s);
      if (s.kind === 'settled') return {kind: 'paid'};
      if (s.kind === 'refused') return {kind: 'not-paid', message: s.message};
      return {kind: 'unresolved', message: M.pay.ocp.transferUnknown};
    });
  });

  /** Approve a till payment whose submit leaves the outcome indefinite. */
  async function approveIntoUnknown(tree: renderer.ReactTestRenderer) {
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'unknown'});
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);
    await act(async () => {}); // the claim's first re-poll tick
  }

  async function tick(tree: renderer.ReactTestRenderer) {
    await act(async () => { jest.advanceTimersByTime(POLL.receiptPay); });
    await act(async () => {});
    return tree;
  }

  test('a transfer that turns out to have settled is reported — once — and the sale completes', async () => {
    const tree = mountTill();
    await approveIntoUnknown(tree);
    // Indefinite: the provider was NOT told, so the one submission is still unspent.
    expect(textByTestID(tree, 'ocp-outcome')).toBe(M.pay.ocp.transferUnknown);
    expect(sends).toEqual([{kind: 'unknown'}]);

    // One more poll of the SAME request_id — the envelope that used to be discarded — finds it.
    jest.mocked(pollTransfer).mockResolvedValue({kind: 'settled', blockIndex: '8168'});
    await tick(tree);

    expect(sends[1]).toEqual({kind: 'settled', txId: '8168', reference: M.pay.ocp.ref.icBlock('8168')});
    expect(jest.mocked(pollTransfer).mock.calls[0][0]).toEqual(PREPARED); // re-polled, never re-signed
    expect(prepareTransfer).toHaveBeenCalledTimes(1);
    expect(texts(tree).join(' ')).toContain(M.nfc.paidAmount('∂1.00'));
    expect(hasTestID(tree, 'ocp-outcome')).toBe(false);

    // The claim is SPENT. `/tx` is granted exactly once in total, so no later tick may report again.
    const reports = jest.mocked(payAndReport).mock.calls.length;
    await tick(tree);
    await tick(tree);
    expect(jest.mocked(payAndReport).mock.calls.length).toBe(reports);
    act(() => { tree.unmount(); });
  });

  test('a transfer that turns out to have been REFUSED says nothing was paid, and tells nobody', async () => {
    const tree = mountTill();
    jest.mocked(pollTransfer).mockResolvedValue({kind: 'rejected', reason: 'Not enough balance'});
    await approveIntoUnknown(tree);

    // "Your money may be gone" was honest a moment ago and is a lie now: nothing moved. The screen
    // says so and puts the payer back where they can actually pay.
    expect(texts(tree)).toContain(M.pay.ocp.transferRefused('Not enough balance'));
    expect(hasTestID(tree, 'ocp-outcome')).toBe(false);
    expect(hasTestID(tree, 'btn-start-scan')).toBe(true);
    // The provider was never told about a transfer that never happened.
    expect(sends).toEqual([{kind: 'unknown'}]);
    act(() => { tree.unmount(); });
  });

  test('a transfer that settles only AFTER the price died is not reported — the claim is worth more', async () => {
    // Submitting against a dead quote is refused AND binds the transaction id to it, which is
    // exactly what would stop the merchant crediting this payment by hand. So the block index is
    // handed to the payer instead of being spent.
    const base = Date.now();
    let clock = base;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, expiresAt: base + 60_000, payableUntil: base + 30_000},
    });
    const tree = mountTill();
    await approveIntoUnknown(tree);
    expect(textByTestID(tree, 'ocp-outcome')).toBe(M.pay.ocp.transferUnknown);

    clock = base + 61_000; // the price lapses while the app is still finding out what happened
    jest.mocked(pollTransfer).mockResolvedValue({kind: 'settled', blockIndex: '8168'});
    await tick(tree);

    expect(sends).toEqual([{kind: 'unknown'}]); // the submission was NOT spent
    expect(textByTestID(tree, 'ocp-outcome')).toBe(M.pay.ocp.submitTooLate(M.pay.ocp.ref.icBlock('8168')));
    expect(texts(tree).join(' ')).not.toContain(M.nfc.paidAmount('∂1.00'));
    nowSpy.mockRestore();
    act(() => { tree.unmount(); });
  });

  test('a settled transfer with no block index stays indefinite — there is nothing to report', async () => {
    // The ledger named no block (an unnumbered duplicate): the provider verifies the identifier
    // against the chain, so reporting an absent one would spend the attempt for nothing.
    const tree = mountTill();
    await approveIntoUnknown(tree);
    jest.mocked(pollTransfer).mockResolvedValue({kind: 'settled', blockIndex: ''});
    await tick(tree);

    expect(sends).toEqual([{kind: 'unknown'}]);
    expect(textByTestID(tree, 'ocp-outcome')).toBe(M.pay.ocp.transferUnknown);
    act(() => { tree.unmount(); });
  });
});

// ---------------------------------------------------------------------------------------------
// The unresolved outcome screen says ONE thing — and the same thing the Solana rail says
// ---------------------------------------------------------------------------------------------
describe('PayMode — the till outcome screen does not contradict itself', () => {
  /** Mounted CoachTip elements for a key (the card itself renders only once the journey loads, so
   *  the ELEMENT is what pins whether the surface asked for the tip at all). */
  function tips(tree: renderer.ReactTestRenderer, tipKey: string) {
    return tree.root.findAll(n => n.props && n.props.tipKey === tipKey);
  }

  test('an uncredited till payment never claims a merchant is about to confirm it', async () => {
    // It used to render the offline hand-off's pending surface: "awaiting the merchant's
    // confirmation" and a "check back here" tip, directly above a note saying the provider refused
    // the proof and the sale was not credited — two contradictory statements on the payer's only
    // record of a lost payment. Nobody is going to confirm this one.
    const message = M.pay.ocp.submitRejected(M.pay.ocp.ref.icBlock('8168'), 'Transaction 8168 already assigned to another quote');
    jest.mocked(resolveOcpScan).mockReset().mockResolvedValue({kind: 'ok', target: OCP_TARGET});
    jest.mocked(payAndReport).mockReset().mockResolvedValue({kind: 'unresolved', message});
    const tree = mountTill();
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);

    expect(textByTestID(tree, 'ocp-outcome')).toBe(message);
    // The two lines the Solana rail already shows for this identical outcome, and only those.
    expect(texts(tree)).toContain(M.pay.sent('∂1.00'));
    expect(texts(tree)).toContain(M.pay.toWho('Test Shop'));
    expect(texts(tree)).not.toContain(M.pay.toWhoAwaiting('Test Shop'));
    expect(tips(tree, 'pendingOutcome')).toHaveLength(0);
    act(() => { tree.unmount(); });
  });

  test('the OFFLINE hand-off keeps its own pending surface — the fix is scoped to the till outcome', async () => {
    // The guard against over-correcting: a hand-off really is awaiting the merchant, and the
    // "pending means unknown, check back here" tip is true there.
    const tree = mountPay({online: false});
    await scanToSign(tree, REQ); // auto-sign → the offline QR hand-off
    pressByTestID(tree, 'btn-paid');

    expect(texts(tree)).toContain(M.pay.toWhoAwaiting('Cafe'));
    expect(tips(tree, 'pendingOutcome')).toHaveLength(1);
    expect(hasTestID(tree, 'ocp-outcome')).toBe(false);
    act(() => { tree.unmount(); });
  });
});
