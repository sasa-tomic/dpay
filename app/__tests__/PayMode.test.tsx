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
    // The self-send guard derives the wallet's own principal on mount. A fixed value that matches
    // no test payee keeps every OTHER test in this file on the no-warning path, so the tests below
    // that DO assert the warning have to name the destination themselves.
    icpSelfPrincipal: jest.fn(async () => 'aaaaa-aa'),
  },
  DpayNfc: {},
}));
jest.mock('../services/rail', () => ({
  prepareTransfer: jest.fn(),
  submitTransfer: jest.fn(),
  pollTransfer: jest.fn(),
  envelopeToQrPayload: jest.fn(),
  // The review-time fee query behind the total-debit display (founder rules 2026-09-13/-14). Each
  // total-display test pins its own answer; DEMO mounts never ask.
  fetchLedgerFee: jest.fn(),
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
import {prepareTransfer, submitTransfer, pollTransfer, envelopeToQrPayload, fetchLedgerFee, wireRequestToIntent, type RailPrepared} from '../services/rail';
import {payAndReport, resolveOcpScan, type OcpSendResult, type OcpTarget} from '../services/opencryptopay';
// Spied (not mocked) in the till-note tests: the store's own write behaviour is txNotes.test.ts's
// to pin; here only the SEAM's arguments matter, and the real write keeps the rest honest.
import * as txNotes from '../services/txNotes';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {rememberLedgerFee} from '../services/ledgerFees';
import {PayMode} from '../components/PayMode';
import {BUNDLED_NETWORKS, icpCatalogOf, fmtCurrencyAmountCompact} from '../config/catalog';
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
  toAccount: PAYEE_PRINCIPAL,
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
      assets={[]}
      assetBalances={{}}
      homeCurrency={null}
      balances={{}}
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
  // Same discipline for the fee query: a value left over from a previous test would quietly
  // answer the NEXT test's review.
  jest.mocked(fetchLedgerFee).mockReset();
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

// The payer's amount is the TOTAL DEBIT (founder rule 2026-09-14): a netted request payment is
// not a "price" in display terms — EVERY payer-facing amount shows wire + fee when the fee is
// known, the wire alone when it is not (never a guessed number). This suite pins the camera-entry
// review surface, the one that used to render the bare wire: the founder asked for 0.01 VCHF and
// both devices read 0.0099. The signed envelope is unchanged — `prepareTransfer` still gets the
// wire, exactly as the auto-sign tests above assert.
describe('PayMode — the payer reads the TOTAL DEBIT, never the bare wire (founder rule 2026-09-14)', () => {
  const CATALOG_V = icpCatalogOf(BUNDLED_NETWORKS);
  const VCHF_ASSET = buildSelectableAssets(CATALOG_V, {showTestnet: false, solanaEnabled: false}).filter(a => a.id === 'ic:7');
  // The founder's numbers: price 1.00 VCHF → wire 0.9999 (fee 0.0001 nets out of the request).
  const REQ_VCHF: Req = {...REQ, amount: '99990000', currency: 7};
  /** Mount on VCHF (offline: the classic hand-off, no review block). */
  const mountVchf = () => mountPay({catalog: CATALOG_V, assets: VCHF_ASSET});

  test('camera-entry review headlines wire + fee — 1.00 VCHF, not the 0.9999 wire', async () => {
    jest.mocked(fetchLedgerFee).mockResolvedValue('10000');
    jest.mocked(prepareTransfer).mockReset().mockImplementation(() => new Promise<RailPrepared>(() => {})); // keep the signing surface put
    const tree = mountVchf();
    await scanToSign(tree, REQ_VCHF);
    await act(async () => {}); // flush the fee fetch into feeRaw
    expect(textByTestID(tree, 'pay-amount')).toBe(M.pay.payAmount(fmtCurrencyAmountCompact(CATALOG_V, 7, '100000000')));
    expect(textByTestID(tree, 'pay-amount')).not.toContain('0.9999'); // the wire never headlines
    // The envelope stays honest: what is signed is the WIRE — the fee is never added to the money
    // the rail moves, only to the number the payer reads.
    expect(jest.mocked(prepareTransfer).mock.calls[0][2]?.amount).toBe('99990000');
    act(() => {
      tree.unmount();
    });
  });

  test('unknown fee (DEMO, no ledger): the review falls back to the wire alone — no guessed total', async () => {
    jest.mocked(prepareTransfer).mockReset().mockImplementation(() => new Promise<RailPrepared>(() => {}));
    const tree = mountPay(); // DEMO (currency 0) is the default fixture; its fee never fetches
    await scanToSign(tree, REQ);
    expect(fetchLedgerFee).not.toHaveBeenCalled(); // play money has no honest fee to add
    expect(textByTestID(tree, 'pay-amount')).toBe(M.pay.payAmount(fmtCurrencyAmountCompact(icpCatalogOf(BUNDLED_NETWORKS), 0, '2500')));
    act(() => {
      tree.unmount();
    });
  });

  test('the signed note carries the price — {gross: wire+fee, fee} rides the join key (the log row headlines it)', async () => {
    jest.mocked(fetchLedgerFee).mockResolvedValue('10000');
    const noteSpy = jest.spyOn(txNotes, 'saveTxNote');
    const tree = mountVchf();
    await scanToSign(tree, REQ_VCHF); // auto-sign runs to the qr phase; the note saved pre-prepare
    expect(noteSpy).toHaveBeenCalledTimes(1);
    const [who, note] = noteSpy.mock.calls[0];
    expect(who).toBe(IDENTITY.publicHex);
    expect(note.k).toBe(REQ_VCHF.nonceHex);
    expect(note.who).toBe('Cafe');
    expect(note.gross).toBe('100000000'); // the price, not the 99990000 wire
    expect(note.fee).toBe('10000');
    act(() => {
      tree.unmount();
    });
    noteSpy.mockRestore();
  });

  test('DEMO wire note stays wire-shaped: fee unknown → neither gross nor fee is saved (no guessed numbers)', async () => {
    const noteSpy = jest.spyOn(txNotes, 'saveTxNote');
    const tree = mountPay();
    await scanToSign(tree, REQ);
    const note = noteSpy.mock.calls[0]?.[1];
    expect(note.gross).toBeUndefined();
    expect(note.fee).toBeUndefined();
    act(() => {
      tree.unmount();
    });
    noteSpy.mockRestore();
  });
});

describe("PayMode — offline, the total falls back to the ledger's own past answers (2026-09-14)", () => {
  // The OFFLINE half of the same founder rule: the live icrc1_fee query is exactly what an
  // offline payer cannot run — and signature NFC/QR IS the offline use case, so while every
  // online path read 0.01, the offline payer's screen and saved note regressed to the bare
  // 0.0099 wire. The display chain now falls back to the fee the ledger ITSELF last answered
  // (services/ledgerFees — persisted per ledger by rail's write-through) and then the bundled
  // catalog row; both local reads, both the ledger's own fact by another road, never a guess.
  // The signed envelope is untouched (prepareTransfer still gets the wire), and a LIVE answer
  // still beats a stale cache.
  const CATALOG_V = icpCatalogOf(BUNDLED_NETWORKS);
  const VCHF_ASSET = buildSelectableAssets(CATALOG_V, {showTestnet: false, solanaEnabled: false}).filter(a => a.id === 'ic:7');
  const REQ_VCHF: Req = {...REQ, amount: '99990000', currency: 7};
  const mountVchf = () => mountPay({catalog: CATALOG_V, assets: VCHF_ASSET});

  beforeEach(async () => {
    await AsyncStorage.clear(); // the fee cache is shared in-memory state between these tests
  });
  afterEach(async () => {
    await AsyncStorage.clear(); // never leak a seeded fee into later suites' mounts
  });

  test('live query REJECTS (offline): the catalog fee stands in — the review still reads 1.00 VCHF', async () => {
    jest.mocked(fetchLedgerFee).mockRejectedValue(new Error('offline'));
    jest.mocked(prepareTransfer).mockReset().mockImplementation(() => new Promise<RailPrepared>(() => {})); // keep the signing surface put
    const tree = mountVchf();
    await scanToSign(tree, REQ_VCHF);
    await act(async () => {}); // flush the rejected query → the local fallback → feeRaw
    expect(jest.mocked(fetchLedgerFee).mock.calls.length).toBeGreaterThan(0); // live WAS attempted first — and lost
    expect(textByTestID(tree, 'pay-amount')).toBe(M.pay.payAmount(fmtCurrencyAmountCompact(CATALOG_V, 7, '100000000')));
    expect(textByTestID(tree, 'pay-amount')).not.toContain('0.9999'); // the netted wire never headlines offline either
    expect(jest.mocked(prepareTransfer).mock.calls[0][2]?.amount).toBe('99990000'); // the envelope stays the WIRE
    act(() => {
      tree.unmount();
    });
  });

  test('offline note still records the price — {gross, fee} from the catalog fallback', async () => {
    jest.mocked(fetchLedgerFee).mockRejectedValue(new Error('offline'));
    const noteSpy = jest.spyOn(txNotes, 'saveTxNote');
    const tree = mountVchf();
    await scanToSign(tree, REQ_VCHF); // auto-sign runs to the qr phase; the note saved pre-prepare
    expect(noteSpy).toHaveBeenCalledTimes(1);
    const [who, note] = noteSpy.mock.calls[0];
    expect(who).toBe(IDENTITY.publicHex);
    expect(note.k).toBe(REQ_VCHF.nonceHex);
    expect(note.gross).toBe('100000000'); // the price, not the 99990000 wire
    expect(note.fee).toBe('10000'); // the catalog row's fee — the ledger's registered answer
    act(() => {
      tree.unmount();
    });
    noteSpy.mockRestore();
  });

  test('the persisted ledger fee beats the catalog row (a fresher word from the same ledger)', async () => {
    await rememberLedgerFee(VCHF_LEDGER, '20000'); // what this ledger last answered online
    jest.mocked(fetchLedgerFee).mockRejectedValue(new Error('offline'));
    jest.mocked(prepareTransfer).mockReset().mockImplementation(() => new Promise<RailPrepared>(() => {}));
    const tree = mountVchf();
    await scanToSign(tree, REQ_VCHF);
    await act(async () => {});
    expect(textByTestID(tree, 'pay-amount')).toBe(M.pay.payAmount(fmtCurrencyAmountCompact(CATALOG_V, 7, '100010000')));
    act(() => {
      tree.unmount();
    });
  });

  test('a LIVE answer beats the stale cache — the ledger is authoritative whenever it can be asked', async () => {
    await rememberLedgerFee(VCHF_LEDGER, '20000'); // stale
    jest.mocked(fetchLedgerFee).mockResolvedValue('10000'); // live wins
    jest.mocked(prepareTransfer).mockReset().mockImplementation(() => new Promise<RailPrepared>(() => {}));
    const tree = mountVchf();
    await scanToSign(tree, REQ_VCHF);
    await act(async () => {});
    expect(textByTestID(tree, 'pay-amount')).toBe(M.pay.payAmount(fmtCurrencyAmountCompact(CATALOG_V, 7, '100000000')));
    expect(textByTestID(tree, 'pay-amount')).not.toContain('1.0001'); // the stale cache's total never shows
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

  test('a payment link shows the FULL destination account — the account IS the check, with no caveat line', async () => {
    // The account is the identity; the label is only what the sender wrote into the URL. The
    // account is therefore on screen in full, and the sentence that used to say the name was
    // unverified is NOT: it warned about a name while the checkable thing sat right under it, and
    // no payer could act on it (founder, 2026-09-09).
    const tree = mountPay({prefillIntent: LINK_INTENT, onPrefillConsumed: () => {}});
    await act(async () => {});
    expect(textByTestID(tree, 'review-payee')).toBe(PAYEE_PRINCIPAL);
    expect(hasTestID(tree, 'review-claimed')).toBe(false);
    act(() => {
      tree.unmount();
    });
  });

  test('paying your OWN account is warned about — the same warning Send-to-address gives', async () => {
    // X20. `CLAUDE.md` documented the self-send warning on Send-to-address and it existed nowhere
    // else, so a link naming your own principal — or your own request QR scanned back — reviewed in
    // silence, and the money round-tripped minus a ledger fee. Same rule, same sentence, and a
    // WARNING rather than a block: it is your money and there are legitimate reasons to do it.
    jest.mocked(DpayCore.icpSelfPrincipal).mockResolvedValue(PAYEE_PRINCIPAL);
    const tree = mountPay({prefillIntent: {...LINK_INTENT, toAccount: PAYEE_PRINCIPAL}, onPrefillConsumed: () => {}});
    await act(async () => {});
    expect(textByTestID(tree, 'review-self')).toBe(M.withdraw.send.selfWarning);
    expect(hasTestID(tree, 'btn-approve')).toBe(true); // warned, never blocked
    act(() => {
      tree.unmount();
    });
  });

  test('a link to SOMEONE ELSE carries no self warning — the guard is a comparison, not a banner', async () => {
    jest.mocked(DpayCore.icpSelfPrincipal).mockResolvedValue('aaaaa-aa');
    const tree = mountPay({prefillIntent: LINK_INTENT, onPrefillConsumed: () => {}});
    await act(async () => {});
    expect(hasTestID(tree, 'review-self')).toBe(false);
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

  test('a scanned bitcoin: request is refused BY NAME and stays on scan', async () => {
    const scanned: string[] = [];
    const modes: string[] = [];
    const tree = mountPay({...sendCapableProps(), onScannedLink: (u: string) => scanned.push(u), onSubModeChange: (m: string) => modes.push(m)});
    await scanUnreadable(tree, `BITCOIN:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=0.001`);
    expect(texts(tree)).toContain(M.pay.scannedCoinRequest('Bitcoin', 'bitcoin:'));
    expect(texts(tree)).not.toContain(M.pay.notAPaymentCode);
    expect(scanned).toEqual([]);
    expect(modes).toEqual([]);
    act(() => { tree.unmount(); });
  });

  // The mirror of the coin-request refusal, with the difference that matters: this wallet CAN pay
  // a Solana Pay request — one rail over. The refusal must say so (the switch instruction), not
  // lump a payable standard in with the ones that need another wallet.
  test('a scanned solana: request is refused BY NAME with the switch-to-Solana instruction', async () => {
    const scanned: string[] = [];
    const modes: string[] = [];
    const tree = mountPay({...sendCapableProps(), onScannedLink: (u: string) => scanned.push(u), onSubModeChange: (m: string) => modes.push(m)});
    await scanUnreadable(tree, `SOLANA:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM?amount=0.001&reference=9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`);
    expect(texts(tree)).toContain(M.pay.spay.wrongRail);
    expect(texts(tree)).not.toContain(M.pay.notAPaymentCode);
    expect(scanned).toEqual([]);
    expect(modes).toEqual([]);
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
/** The VCHF ledger (== `vchf_ledger` in dfx/catalog_truth.json) — the ledger this till's own URI
 *  names, and therefore the one a settled index is reported against. */
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
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
    // What this charge is for — the dpay till's own `note`, carried as claimed display text.
    claimedNote: '2× Kafi, Tisch 4',
    requestedAmount: {asset: 'CHF', amount: '1'},
    transferAmounts: [{method: 'InternetComputer', available: true, assets: [{asset: 'VCHF', amount: '1.'}]}],
  },
  host: 'api.dfx.swiss',
  method: 'InternetComputer',
  asset: 'VCHF',
  // The mounted PayMode's selected asset (currency 0) — which asset a till offer resolves TO is
  // decided in `resolveOcpScan` and tested there; here it only has to match the mount.
  assetId: 'ic:0',
  // The VCHF ledger, as the provider's own URI named it. It is what decides how a settled block
  // index is SPELLED back to the provider (`ocpIcTxId`), which is what the reporting tests pin.
  ledger: VCHF_LEDGER,
  to: TILL_PRINCIPAL,
  rawAmount: '100',
  // No reference: DFX's measured URI names none, so this fixture is the provider that gives the
  // wallet nothing to echo. The till that DOES give one is the dpay-served case below.
  reference: null,
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
    // ONE line carries the provider's price and the host that set it — the attribution IS the host.
    expect(textByTestID(tree, 'ocp-price')).toContain('api.dfx.swiss');
    expect(hasTestID(tree, 'review-claimed')).toBe(false);
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

  test('the till’s own reference becomes the transfer’s on-chain memo, and its absence mints one', async () => {
    // THE MATCH. A provider that names a `ref` matches its ledger history on exactly that memo
    // (dpay's till mints one per charge, `crates/dpay-relay/src/till.rs`), so a transfer signed
    // with the wallet's own nonce instead would move the money and leave the sale uncredited.
    const REF = '19ff3250469370d21a04c100ad5ab8bb';
    jest.mocked(resolveOcpScan).mockResolvedValue({kind: 'ok', target: {...OCP_TARGET, reference: REF}});
    const tree = mountTill();
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);
    await (jest.mocked(payAndReport).mock.calls[0][3] as () => Promise<OcpSendResult>)();

    expect(prepareTransfer).toHaveBeenCalledTimes(1);
    expect(jest.mocked(prepareTransfer).mock.calls[0][2].nonceHex).toBe(REF);

    // A provider that names none — the measured DFX till — still pays: the wallet mints its own
    // 16-byte memo, which is what every till payment carried before references existed. It must be
    // a real nonce, not an empty string, or the transfer would carry no memo at all.
    jest.mocked(prepareTransfer).mockClear();
    jest.mocked(resolveOcpScan).mockResolvedValue({kind: 'ok', target: OCP_TARGET});
    const plain = mountTill();
    await scanTill(plain);
    await pressByLabel(plain, M.pay.approveA11y);
    await (jest.mocked(payAndReport).mock.calls[1][3] as () => Promise<OcpSendResult>)();

    const minted = jest.mocked(prepareTransfer).mock.calls[0][2].nonceHex;
    expect(minted).toMatch(/^[0-9a-f]{32}$/);
    expect(minted).not.toBe(REF);
  });

  test('the till’s claimed note rides the review’s memo line and the payer’s history annotation', async () => {
    // SAME SURFACE, not a parallel one (founder rule): a payment link's `memo=` already renders on
    // `review-memo`, and the txNote seam already saves `msg` from the intent's memo — `landOcp`
    // landing the claimed note in `intent.memo` lights up BOTH with no new surface. The ON-CHAIN
    // memo is untouched by it: that stays `nonceHex`, the till reference the test above pins.
    const tree = mountTill();
    await scanTill(tree);
    expect(textByTestID(tree, 'review-memo')).toBe('2× Kafi, Tisch 4');

    const noteSpy = jest.spyOn(txNotes, 'saveTxNote');
    await pressByLabel(tree, M.pay.approveA11y);
    const saved = noteSpy.mock.calls.map(([, n]) => n).find(n => n.msg === '2× Kafi, Tisch 4');
    // Keyed by the on-chain memo (a minted nonce for this reference-less fixture), named by the
    // claimed merchant — the history row then reads: Test Shop — 2× Kafi, Tisch 4.
    expect(saved).toBeDefined();
    expect(saved?.k).toMatch(/^[0-9a-f]{32}$/);
    expect(saved?.who).toBe('Test Shop');
    noteSpy.mockRestore();
  });

  test('a till that sent no note shows no memo line and saves no msg', async () => {
    // Null is the absence contract: the line renders nothing, and the annotation keeps only `who`.
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, details: {...OCP_TARGET.details, claimedNote: null}},
    });
    const tree = mountTill();
    await scanTill(tree);
    expect(hasTestID(tree, 'review-memo')).toBe(false);

    const noteSpy = jest.spyOn(txNotes, 'saveTxNote');
    await pressByLabel(tree, M.pay.approveA11y);
    const notes = noteSpy.mock.calls.map(([, n]) => n);
    expect(notes).toHaveLength(1);
    expect(notes[0].msg).toBeUndefined();
    expect(notes[0].who).toBe('Test Shop');
    noteSpy.mockRestore();
  });

  test('the IC rail reports a CONFIRMED block index, ON ITS OWN LEDGER, and anything else as unknown', async () => {
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
      // The VCHF ledger's own index, spelled the way that ledger requires (`ocpIcTxId`). A BARE
      // '8168' here is the 2026-09-03 defect exactly: the provider would look 8168 up on the native
      // ICP ledger, and the payer's VCHF would be gone with the sale uncredited.
      txId: `${VCHF_LEDGER}:8168`,
      // The REFERENCE stays the bare index: it is what the payer reads out to the merchant, not
      // what goes on the wire, and the merchant already knows which asset they were paid in.
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

  test('a settled transfer whose till named no ledger is NOT reported, and says why', async () => {
    // The negative half of the spelling rule. `OcpTarget.ledger` is null only on Solana, so an IC
    // target without one is an inconsistency — and the safe answer to "which ledger do I report
    // this index against?" being unanswerable is to not report it. Reporting a bare index on a
    // guess is the 2026-09-03 loss; a warn keeps the impossible case debuggable instead of silent.
    jest.mocked(resolveOcpScan).mockResolvedValue({kind: 'ok', target: {...OCP_TARGET, ledger: null}});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const tree = mountTill();
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);
    const send = jest.mocked(payAndReport).mock.calls[0][3] as () => Promise<OcpSendResult>;

    jest.mocked(submitTransfer).mockResolvedValue({kind: 'settled', blockIndex: '8168'});
    await expect(send()).resolves.toEqual({kind: 'unknown'});
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('named no ledger');
    warn.mockRestore();
  });

  test('the review states the till’s own price and the host that set it, in ONE line', async () => {
    // `1.00000000 VCHF` is uncheckable on its own: the number on the till and in the cashier's
    // mouth is "CHF 1", so without it the payer approves an amount they cannot compare against the
    // price of the sale. It is the PROVIDER's own `requestedAmount`, never a figure this wallet
    // derived — and naming the host in the same line IS that attribution, which is why the policy
    // sentence that used to follow it ("dpay doesn't convert") is gone: it addressed dpay, not the
    // person at the till (founder, 2026-09-09).
    const tree = mountTill();
    await scanTill(tree);

    expect(textByTestID(tree, 'ocp-price')).toBe(M.pay.ocp.tillPrice('CHF 1', 'api.dfx.swiss'));
    expect(textByTestID(tree, 'ocp-price')).not.toContain('convert');
  });

  test('a till that states no price of its own still names the host, and still pays', async () => {
    // Display context never blocks a payment: a provider that sends no readable `requestedAmount`
    // loses the PRICE, not the host beside it and not the Approve button — the host is the trust
    // fact, and it is available whether or not a price came with it.
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, details: {...OCP_TARGET.details, requestedAmount: null}},
    });
    const tree = mountTill();
    await scanTill(tree);

    expect(textByTestID(tree, 'ocp-price')).toBe(M.pay.ocp.providerHost('api.dfx.swiss'));
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
  test('the countdown stays off while there is runway, and appears counting to the PAYABLE deadline', async () => {
    const now = Date.now();
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, expiresAt: now + 300_000, payableUntil: now + 185_000},
    });
    let tree = mountTill();
    await scanTill(tree);
    // ~3 min of runway: a countdown here changes nothing a payer would do, and is one more thing
    // to read at a till. It is not rendered at all.
    expect(hasTestID(tree, 'ocp-expiry')).toBe(false);

    // Inside the last minute it IS the reason to hurry, so it appears — and it counts to the last
    // instant Approve can be pressed, NOT to the quote's expiry. Showing the quote's own deadline
    // would invite a press the sequence cannot complete: the funds move first and the ONE proof
    // submission then lands on a dead quote, spending everything for nothing.
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, expiresAt: now + 120_000, payableUntil: now + 42_000},
    });
    tree = mountTill();
    await scanTill(tree);
    // A range, not an exact second: the test's own wall clock runs between the mock and the read.
    // What is pinned is which deadline it counts to — 42s of PAYABLE runway inside a 2-minute
    // quote reads as seconds-to-payable, never as the quote's own minute and a half.
    expect(textByTestID(tree, 'ocp-expiry')).toMatch(/^Expires in 0:4[01]$/);
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

    expect(sends[1]).toEqual({kind: 'settled', txId: `${VCHF_LEDGER}:8168`, reference: M.pay.ocp.ref.icBlock('8168')});
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

describe('PayMode — the fund-first surfaces: the camera, and the funded account (X1/X3)', () => {
  const USD_CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
  const USD_ASSETS = buildSelectableAssets(USD_CATALOG, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
  /** An ONLINE wallet whose SELECTED asset is a known zero — the state that used to hide the
   *  scanner. `over` names the rest of the situation. */
  const unfunded = (over: Partial<PayModeProps> = {}) => mountPay({
    online: true,
    catalog: USD_CATALOG,
    assets: USD_ASSETS,
    assetBalances: {2: '0'},
    withdrawCurrency: 2,
    withdrawBalance: '0',
    homeCurrency: 'USD',
    balances: {},
    ...over,
  });

  test('X3: a zero SELECTED balance no longer hides the camera — the request names the asset', () => {
    // The measured defect: ∂100 DEMO held, VCHF selected, and the Pay tab answered "No VCHF
    // available" with no camera at all — so a payer holding exactly what the merchant asked for
    // could not even READ the request. The scan surface must stay reachable, and the funding
    // instruction must survive as a companion rather than a replacement.
    const tree = unfunded();
    expect(hasTestID(tree, 'btn-start-scan')).toBe(true);
    expect(hasTestID(tree, 'pay-fund')).toBe(true);
    // ...and one press really opens the lens (the scanner stub carries onScan).
    pressByTestID(tree, 'btn-start-scan');
    expect(scannerNodes(tree)).not.toHaveLength(0);
    // Once the payer has asked for the camera, the screen is the camera's.
    expect(hasTestID(tree, 'pay-fund')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('X3: the SEND sub-mode keeps its full gate — there is no request to read there', () => {
    const tree = unfunded({subMode: 'send', withdrawFamily: 'CkEthErc20'});
    expect(hasTestID(tree, 'pay-fund')).toBe(true);
    expect(texts(tree)).toContain('This wallet has no USDC. To send USDC, first receive USDC at your address.');
    act(() => { tree.unmount(); });
  });

  test('X1: the practice balance a new wallet holds is NAMED, and is one tap away', () => {
    const onSwitchRail = jest.fn();
    const tree = unfunded({balances: {'ic:0': {displayText: '∂100.00', status: 'ok', failure: null}}, onSwitchRail});
    expect(textByTestID(tree, 'fund-sibling-holds')).toBe(M.pay.fundSibling.practice('∂100.00'));
    pressByTestID(tree, 'btn-fund-sibling-switch');
    expect(onSwitchRail).toHaveBeenCalledWith('ic:0');
    act(() => { tree.unmount(); });
  });

  test('X1: practice money is not offered on the SEND surface — it cannot leave the wallet', () => {
    const tree = unfunded({
      subMode: 'send',
      withdrawFamily: 'CkEthErc20',
      balances: {'ic:0': {displayText: '∂100.00', status: 'ok', failure: null}},
    });
    expect(hasTestID(tree, 'pay-fund')).toBe(true);
    expect(hasTestID(tree, 'fund-sibling-rail')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('an unfunded ckUSDC surface with a funded USDC sibling names it and offers the one-tap switch', () => {
    const onSwitchRail = jest.fn();
    const tree = unfunded({balances: {'solana:USDC': {displayText: '2.50 USDC', status: 'ok', failure: null}}, onSwitchRail});
    expect(textByTestID(tree, 'fund-sibling-holds')).toBe('You hold 2.50 USDC on USDC · Solana');
    pressByTestID(tree, 'btn-fund-sibling-switch');
    expect(onSwitchRail).toHaveBeenCalledWith('solana:USDC');
    act(() => { tree.unmount(); });
  });

  test('nothing funded anywhere: the instruction renders alone — no pointer, no switch', () => {
    const tree = unfunded({balances: {'solana:USDC': {displayText: '0.00 USDC', status: 'zero', failure: null}}});
    expect(hasTestID(tree, 'pay-fund')).toBe(true);
    expect(hasTestID(tree, 'fund-sibling-rail')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('a foreign-currency selection now points too — the funded account is a fact either way', () => {
    // Widened 2026-09-08 (X1): a ckBTC surface has no same-currency sibling, but the wallet holds
    // dollars, and refusing to say so was the dead end. The button names the ASSET, not the chain.
    const onSwitchRail = jest.fn();
    const tree = unfunded({
      assetBalances: {1: '0'},
      withdrawCurrency: 1,
      balances: {'solana:USDC': {displayText: '2.50 USDC', status: 'ok', failure: null}},
      onSwitchRail,
    });
    expect(textByTestID(tree, 'fund-sibling-holds')).toBe('You hold 2.50 USDC on USDC · Solana');
    pressByTestID(tree, 'btn-fund-sibling-switch');
    expect(onSwitchRail).toHaveBeenCalledWith('solana:USDC');
    act(() => { tree.unmount(); });
  });

  test('no switch passed while locked (Wallet withholds it): the rail is named, the button is gone', () => {
    const tree = unfunded({balances: {'solana:USDC': {displayText: '2.50 USDC', status: 'ok', failure: null}}});
    expect(textByTestID(tree, 'fund-sibling-holds')).toBe('You hold 2.50 USDC on USDC · Solana');
    expect(hasTestID(tree, 'btn-fund-sibling-switch')).toBe(false);
    act(() => { tree.unmount(); });
  });
});

describe('PayMode — what the affordability gate is allowed to read, and what it does when it refuses', () => {
  /** Re-render the SAME mounted PayMode with new props (state survives) — how a balance poll
   *  landing mid-review reaches the component in the real app. */
  function repoll(tree: renderer.ReactTestRenderer, props: Partial<PayModeProps>) {
    act(() => { tree.update(payElement(props)); });
  }

  test('a transient low balance must not be a terminal refusal: once the balance covers it, the payer can sign', async () => {
    // The measured shape (2026-09-08): the camera path decides ONCE, at decode, whether to
    // auto-sign. A balance that was momentarily low — a faucet credit or an incoming transfer not
    // yet in the poll's answer — suppressed that one decision, and nothing ever re-fired it. The
    // payer was parked on a read-only card whose only control was Cancel, in front of a merchant,
    // holding money the wallet could see in its own header a second later. The gate itself is
    // right; being unable to act on its own change of mind is the bug.
    const props = {online: true, shownBalance: '0'};
    const tree = mountPay(props);
    await scanToSign(tree, REQ); // ∂25.00 against a ∂0.00 reading

    // The refusal is honest while it lasts, and it signs nothing.
    expect(prepareTransfer).not.toHaveBeenCalled();
    expect(textByTestID(tree, 'review-lowbal')).toBe(M.pay.notEnoughBalance);
    // Flow 19's contract, byte-for-byte: while the payment IS unaffordable there is no sign control
    // at all — the gate is structural, never a disabled button.
    expect(hasTestID(tree, 'btn-approve')).toBe(false);

    // The poll lands. The header now reads ∂100.00 from this very scalar.
    repoll(tree, {...props, shownBalance: '10000'});
    expect(hasTestID(tree, 'review-lowbal')).toBe(false);

    // …and the payer has a way to pay: a DELIBERATE press, never a silent re-sign. Auto-signing a
    // payment the user watched get refused would move money without a gesture at a moment they did
    // not choose; a press is strictly more consent than the one-press rule already asks for.
    expect(hasTestID(tree, 'btn-approve')).toBe(true);
    await act(async () => { tree.root.findAll(n => n.props && n.props.testID === 'btn-approve')[0].props.onPress(); });
    await act(async () => {});
    expect(prepareTransfer).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('an UNKNOWN balance is not a zero balance: a currency the app has never read still signs', async () => {
    // The rule the gate must never break. `assetBalances` carries an entry only for a currency the
    // relay actually answered for; an absent entry means "not read", and refusing a signature on it
    // would decline a payment the wallet can make. Offline the same rule already applies (flow 19).
    const tree = mountPay({online: true, shownBalance: null, assetBalances: {}});
    await scanToSign(tree, REQ);
    expect(hasTestID(tree, 'review-lowbal')).toBe(false);
    expect(prepareTransfer).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('an UNKNOWN non-primary balance is not a zero balance either', async () => {
    // VCHF (currency 7) with an empty poll map: the ledger has not answered once. Sign.
    const tree = mountPay({
      online: true,
      catalog: icpCatalogOf(BUNDLED_NETWORKS),
      shownBalance: '0',
      assetBalances: {},
    });
    await scanToSign(tree, {...REQ, currency: 7, amount: '100000000'});
    expect(hasTestID(tree, 'review-lowbal')).toBe(false);
    expect(prepareTransfer).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('the gate reads the REQUESTED currency\'s own balance — the one the header prints, and no other', async () => {
    // The assertion that would have caught a header/review disagreement. DEMO's balance reaches
    // this component as ONE scalar (`shownBalance`) — the identical value `buildAssetBalances`
    // turns into the header's `ic:0` row — so a second, contradicting source in `assetBalances` is
    // planted here deliberately: if the check ever starts reading it, these two flip.
    const funded = mountPay({online: true, shownBalance: '10000', assetBalances: {0: '0'}});
    await scanToSign(funded, REQ);
    expect(hasTestID(funded, 'review-lowbal')).toBe(false);
    expect(prepareTransfer).toHaveBeenCalledTimes(1);
    act(() => { funded.unmount(); });

    jest.mocked(prepareTransfer).mockClear();
    const empty = mountPay({online: true, shownBalance: '0', assetBalances: {0: '10000'}});
    await scanToSign(empty, REQ);
    expect(textByTestID(empty, 'review-lowbal')).toBe(M.pay.notEnoughBalance);
    expect(prepareTransfer).not.toHaveBeenCalled();
    act(() => { empty.unmount(); });
  });

  test('offline, a balance that cannot cover the amount still signs — with the honest warning', async () => {
    // Flow 19's other half, pinned here at component level: offline the local balance is stale by
    // definition, so it warns and the merchant's online verify is the real gate. The signer is hung
    // so the read-only surface that carries the note stays on screen to be read.
    jest.mocked(prepareTransfer).mockImplementation(() => new Promise<RailPrepared>(() => {}));
    const tree = mountPay({online: false, shownBalance: '0'});
    await scanToSign(tree, REQ);
    expect(textByTestID(tree, 'review-lowbal')).toBe(M.pay.localBalanceMayNotCover);
    // It SIGNED (the envelope is being built) — and no sign control was needed or offered.
    expect(prepareTransfer).toHaveBeenCalledTimes(1);
    expect(hasTestID(tree, 'btn-approve')).toBe(false);
    act(() => { tree.unmount(); });
  });
});
