/**
 * NFC auto-sign adapter tests (one-press rule, founder directive 2026-08-24).
 *
 * HARD FOUNDER RULE: the payer presses EXACTLY ONE button before money moves — the "Pay Now"
 * gate that arms camera + card IS that press. These tests pin the adapter side of that rule
 * on the IC + SOL rails:
 *
 *   IC  — a payable request AUTO-SIGNS on arrival (expiry gate → prepareNfcTransfer →
 *         approveCard(nonce-bound)); the review card NEVER mounts (no Approve/Decline buttons,
 *         no countdown chip); fail-closed legs (unpayable/undisclosable/expired) auto-decline
 *         WITHOUT signing; a duplicate request during the sign is dead (latch).
 *   SOL — a solreq AUTO-SIGNS on arrival (isSolReqV2Expired re-check → offline sign → cached
 *         solpay:v2 served via approveSolCard); rid-dedup: after the sign fired, later
 *         requests (same OR different rid) are dropped — the signed payment owns the UI.
 *
 * The shared-hook contract (no review phase, awaitingApproval→exchanging mapping, chatter
 * stickiness) is pinned in useNfcTapState.test.tsx; the status card contract in
 * nfc-tap-view*.test — these tests exercise the FULL adapter: real hook + real NfcTapView +
 * real QR codecs, mocked only at the native-module/rail/sign boundaries.
 *
 * Events fire through the REAL DeviceEventEmitter (what NativeEventEmitter subscribes via on
 * Android/jest-preset) — the same dispatch path the e2e seam uses. Title/sub lines carry no
 * testIDs (e2e matches them by textContent) — tests here match them by rendered text.
 */
import React from 'react';
import {describe, it, expect, jest, afterEach} from '@jest/globals';
import Renderer, {act} from 'react-test-renderer';
import {DeviceEventEmitter} from 'react-native';
import type {CurrencyDescriptor} from '../config/catalog';
import {encodeSolReq} from '../solana/qr';
import {NfcTap} from '../components/NfcTap';
import {SolNfcTap} from '../components/SolNfcTap';
import {DpayNfc, DpaySolNfc} from '../services/native';
import {prepareNfcTransfer} from '../services/rail';
import {signSolPayment} from '../solana';
import {nowSecs} from '../lib/format';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {JOURNEY_STAMPS, hasStamp, loadJourney} from '../lib/journey';

jest.mock('../services/native', () => ({
  DpayNfc: {
    addListener: (_eventType: string) => ({remove: () => {}}),
    removeListeners: (_count: number) => {},
    armCard: jest.fn(async () => {}),
    disarmCard: jest.fn(async () => {}),
    approveCard: jest.fn(async () => {}),
    declineCard: jest.fn(async () => {}),
    startReader: jest.fn(async (_p: string) => {}),
    stopReader: jest.fn(async () => {}),
    confirmResult: jest.fn(async () => {}),
  },
  DpaySolNfc: {
    addListener: (_eventType: string) => ({remove: () => {}}),
    removeListeners: (_count: number) => {},
    armCard: jest.fn(async () => {}),
    disarmCard: jest.fn(async () => {}),
    approveSolCard: jest.fn(async (_uri: string) => {}),
    declineSolCard: jest.fn(async () => {}),
    startSolReader: jest.fn(async (_p: string) => {}),
    stopSolReader: jest.fn(async () => {}),
    confirmSolReceipt: jest.fn(async () => {}),
  },
}));

jest.mock('../services/rail', () => ({
  prepareNfcTransfer: jest.fn(async () => ({
    ledger: 'l'.repeat(27),
    envelopeHex: 'ee'.repeat(80),
    requestIdHex: 'ff'.repeat(32),
    amount: '50000',
    currency: 1,
    memoHex: 'ab'.repeat(16),
    readStateEnvelopeHex: 'aa'.repeat(80),
  })),
  submitNfcTransfer: jest.fn(async () => ({kind: 'unknown'})),
  confirmIncomingTransfer: jest.fn(async () => false),
}));

jest.mock('../solana', () => {
  // Hand-crafted signed-tx bytes: compact-u16 sigCount=1 ‖ 64 sig bytes ‖ message — shaped for the
  // REAL extractSignedTxParts (imported by the adapter from ../solana/tx, not mocked): the message
  // needs a 3-byte header + compact-u16 account count + ≥32 bytes of keys, or the parser returns
  // null and the adapter's receipt binding (expectedSig) stays empty.
  const tx = new Uint8Array([1, ...new Array(64).fill(7), 0, 0, 0, 1, ...new Array(32).fill(9)]);
  return {
    signSolPayment: jest.fn(() => ({v: 2, rid: 'c'.repeat(32), tx})),
    signSplPayment: jest.fn(() => ({v: 2, rid: 'c'.repeat(32), tx})),
    broadcastSolPayment: jest.fn(async () => ({status: 0, rid: '', sig: ''})),
  };
});

// Catalog fixture — same shape as nfc-disclosure.test.ts's KNOWN_CATALOG (ckBTC, 8 decimals).
const mk = (d: Partial<CurrencyDescriptor> & Pick<CurrencyDescriptor, 'currency' | 'minter_family'>): CurrencyDescriptor => ({
  ledger: '', mintable: false, minter: null, symbol: null, decimals: null,
  wrapper_name: null, backing_symbol: null, network: null, display_decimals: null,
  fee: null, cap: null, chain_id: null, token_contract: null, gas_ledger: null,
  onramp: 'Unavailable', offramp: 'Unavailable', testnet: false, ...d,
});
const CATALOG: CurrencyDescriptor[] = [mk({
  currency: 1, minter: 'm', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8,
  wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin', display_decimals: 8,
})];

const IDENTITY = {secretHex: '9f'.repeat(32), publicHex: '11'.repeat(32), username: 'test'};
const MERCHANT_HEX = '22'.repeat(32);

let tree: Renderer.ReactTestRenderer | null = null;
afterEach(async () => {
  if (tree) { tree.unmount(); tree = null; }
  jest.clearAllMocks();
  await AsyncStorage.clear();
});

/** Exact rendered-text finder (title/sub/memo/offline-note lines carry no testID). */
const hasText = (t: string): boolean =>
  tree!.root.findAll(n => typeof n.type === 'string' && n.props.children === t).length > 0;
/** Any host node carrying the testID (review-card residue detector). */
const hasID = (id: string): boolean =>
  tree!.root.findAll(n => n.props.testID === id && typeof n.type === 'string').length > 0;

const icRequest = (over: Record<string, unknown> = {}) => ({
  type: 'request', role: 'card',
  toHex: MERCHANT_HEX, amount: '50000', nonceHex: 'ab'.repeat(16), expiry: nowSecs() + 300,
  currency: 1, toName: 'merchant', memo: 'two coffees', ...over,
});
async function mountIc() {
  await act(async () => {
    tree = Renderer.create(
      <NfcTap role="card" identity={IDENTITY} catalog={CATALOG} onClose={() => {}} />,
    );
  });
}
const emitIc = async (ev: unknown) => { await act(async () => { DeviceEventEmitter.emit('DpayNfcEvent', ev); }); };

const SOL_TO = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const BH = 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN';
function solreqUri(over: Record<string, unknown> = {}): string {
  const iat = nowSecs();
  return encodeSolReq({
    rid: 'c'.repeat(32), net: 'mainnet-beta', bh: BH, lvh: 300000000, slot: 250000000,
    iat, exp: iat + 90, to: SOL_TO, amt: '1000000', cur: 'SOL', mint: null, toAta: null,
    name: 'merchant', memo: '', ...over,
  } as never);
}
async function mountSol() {
  await act(async () => {
    tree = Renderer.create(
      <SolNfcTap role="card" identity={IDENTITY} onClose={() => {}} />,
    );
  });
}
const emitSol = async (ev: unknown) => { await act(async () => { DeviceEventEmitter.emit('DpaySolNfcEvent', ev); }); };

describe('NfcTap (IC) auto-sign (one-press rule)', () => {
  it('a payable request signs IMMEDIATELY: prepareNfcTransfer + approveCard, no review card', async () => {
    await mountIc();
    await emitIc(icRequest());
    expect(prepareNfcTransfer).toHaveBeenCalledTimes(1);
    expect(DpayNfc.approveCard).toHaveBeenCalledTimes(1);
    expect(DpayNfc.approveCard).toHaveBeenCalledWith('ee'.repeat(80), 'aa'.repeat(80), 'ab'.repeat(16));
    expect(DpayNfc.declineCard).not.toHaveBeenCalled();
    // The review card NEVER mounts — no buttons, no countdown, no parked amount testID.
    expect(hasID('btn-nfc-approve')).toBe(false);
    expect(hasID('btn-nfc-decline')).toBe(false);
    expect(hasID('nfc-countdown')).toBe(false);
    expect(hasID('nfc-pay-amount')).toBe(false);
    // The status carries the read-only amount + the hold-to-send hint (e2e flow 32 contract).
    expect(hasText('Hold the phones together to send')).toBe(true);
    expect(hasText('Paying 0.00050000 BTC on Bitcoin')).toBe(true);
  });

  it('a duplicate request during the sign is dead (signing latch + hook drop)', async () => {
    let release!: (v: unknown) => void;
    (prepareNfcTransfer as jest.Mock).mockImplementationOnce(() => new Promise(r => {release = r;}));
    await mountIc();
    await emitIc(icRequest());
    await emitIc(icRequest()); // transport re-push while the first sign is in flight
    release({});
    await act(async () => {});
    expect(prepareNfcTransfer).toHaveBeenCalledTimes(1);
    expect(DpayNfc.approveCard).toHaveBeenCalledTimes(1);
  });

  it('expired request auto-declines at the sign gate — nothing ever signs', async () => {
    await mountIc();
    await emitIc(icRequest({expiry: nowSecs() - 10}));
    expect(prepareNfcTransfer).not.toHaveBeenCalled();
    expect(DpayNfc.approveCard).not.toHaveBeenCalled();
    expect(DpayNfc.declineCard).toHaveBeenCalledWith('ab'.repeat(16));
    expect(hasText('This request expired — ask for a fresh request')).toBe(true);
  });

  it('fail-closed: unpayable currency auto-declines WITHOUT a review card', async () => {
    await mountIc();
    await emitIc(icRequest({currency: 99}));
    expect(DpayNfc.declineCard).toHaveBeenCalledWith('ab'.repeat(16));
    expect(hasID('btn-nfc-approve')).toBe(false); // not a consent decision — nothing payable
    expect(hasText('Unsupported asset (currency 99)')).toBe(true);
  });

  it('sign failure → best-effort declineCard + the honest error surface', async () => {
    (prepareNfcTransfer as jest.Mock).mockImplementationOnce(async () => { throw new Error('boom'); });
    await mountIc();
    await emitIc(icRequest());
    expect(DpayNfc.approveCard).not.toHaveBeenCalled();
    expect(DpayNfc.declineCard).toHaveBeenCalledWith('ab'.repeat(16));
    expect(hasText('Couldn’t authorize payment — try again')).toBe(true);
  });
});

describe('SolNfcTap (SOL) auto-sign (one-press rule)', () => {
  it('a solreq signs IMMEDIATELY: signSolPayment + approveSolCard(solpay:v2), no review card', async () => {
    await mountSol();
    await emitSol({type: 'request', role: 'card', solreqUri: solreqUri()});
    expect(signSolPayment).toHaveBeenCalledTimes(1);
    expect(DpaySolNfc.approveSolCard).toHaveBeenCalledTimes(1);
    expect((DpaySolNfc.approveSolCard as jest.Mock).mock.calls[0][0]).toMatch(/^solpay:v2\?/);
    expect(DpaySolNfc.declineSolCard).not.toHaveBeenCalled();
    expect(hasID('btn-nfc-approve')).toBe(false);
    expect(hasID('btn-nfc-decline')).toBe(false);
    expect(hasID('nfc-pay-amount')).toBe(false);
    // Card-role exchanging: hold-to-send + the read-only amount (no network label on SOL).
    expect(hasText('Hold the phones together to send')).toBe(true);
    expect(hasText('Paying 0.001000000 SOL')).toBe(true);
  });

  it('rid dedup: a re-tap pushing the SAME solreq after the sign changes nothing', async () => {
    await mountSol();
    const uri = solreqUri();
    await emitSol({type: 'request', role: 'card', solreqUri: uri});
    await emitSol({type: 'request', role: 'card', solreqUri: uri}); // re-tap duplicate
    expect(signSolPayment).toHaveBeenCalledTimes(1);
    expect(DpaySolNfc.approveSolCard).toHaveBeenCalledTimes(1);
  });

  it('a DIFFERENT rid after the sign is dropped too — the signed payment owns the UI', async () => {
    await mountSol();
    await emitSol({type: 'request', role: 'card', solreqUri: solreqUri()});
    await emitSol({type: 'request', role: 'card', solreqUri: solreqUri({rid: 'd'.repeat(32), amt: '2000000'})});
    // No re-sign, no amount swap: the payment that already left the payer's phone is the one
    // bound to the wire (last-writer-wins review parking is gone with the review).
    expect(signSolPayment).toHaveBeenCalledTimes(1);
    expect((signSolPayment as jest.MockedFunction<typeof signSolPayment>).mock.calls[0][1].rid).toBe('c'.repeat(32));
    expect(DpaySolNfc.approveSolCard).toHaveBeenCalledTimes(1);
  });

  it('expired solreq auto-declines at the sign gate — nothing ever signs', async () => {
    await mountSol();
    const iat = nowSecs() - 85;
    // exp=iat+80 ≤ iat+90 passes the codec; now > exp makes isSolReqV2Expired true at sign.
    await emitSol({type: 'request', role: 'card', solreqUri: solreqUri({iat, exp: iat + 80})});
    expect(signSolPayment).not.toHaveBeenCalled();
    expect(DpaySolNfc.approveSolCard).not.toHaveBeenCalled();
    expect(DpaySolNfc.declineSolCard).toHaveBeenCalled();
    expect(hasText('This payment request has expired')).toBe(true);
  });
});

describe('NFC settle awards the trip-prep stamps (founder rule 2026-08-24)', () => {
  /** Wait out the journey store's serialized write queue (load→merge→persist per award). */
  const settleStore = async () => {
    await act(async () => {});
    await new Promise(r => setTimeout(r, 0));
    await act(async () => {});
  };

  it('IC payer: a settled result ticks FIRST PAYMENT (+ flowUnderstood co-award)', async () => {
    await mountIc();
    await emitIc(icRequest());
    // The signed payment's binding (from the prepareNfcTransfer mock): nonce 'ab'×16, rid 'ff'×32.
    await emitIc({type: 'result', role: 'card', status: 0, nonceHex: 'ab'.repeat(16), requestIdHex: 'ff'.repeat(32)});
    await settleStore();
    const j = await loadJourney();
    expect(hasStamp(j, JOURNEY_STAMPS.paymentTested)).toBe(true);
    expect(hasStamp(j, JOURNEY_STAMPS.flowUnderstood)).toBe(true);
  });

  it('IC payer: a REJECTED result ticks nothing (only confirmed settlement celebrates)', async () => {
    await mountIc();
    await emitIc(icRequest());
    await emitIc({type: 'result', role: 'card', status: 1, nonceHex: 'ab'.repeat(16), requestIdHex: 'ff'.repeat(32)});
    await settleStore();
    const j = await loadJourney();
    expect(hasStamp(j, JOURNEY_STAMPS.paymentTested)).toBe(false);
    expect(hasStamp(j, JOURNEY_STAMPS.flowUnderstood)).toBe(false);
  });

  it('SOL payer: a bound settled receipt ticks FIRST PAYMENT (+ flowUnderstood co-award)', async () => {
    await mountSol();
    await emitSol({type: 'request', role: 'card', solreqUri: solreqUri()});
    // Binding from the signSolPayment mock: rid 'c'×32; sig computed EXACTLY as the adapter
    // does at sign time (extractSignedTxParts over the crafted tx → base58 of the signature).
    const bs58 = (await import('bs58')).default;
    const {extractSignedTxParts} = await import('../solana/tx');
    const tx = new Uint8Array([1, ...new Array(64).fill(7), 0, 0, 0, 1, ...new Array(32).fill(9)]);
    const parts = extractSignedTxParts(tx); // same crafted tx the sign mock returned
    expect(parts).not.toBeNull();
    const sig = bs58.encode(parts!.signature);
    await emitSol({type: 'receipt', role: 'card', status: 0, rid: 'c'.repeat(32), sig});
    await settleStore();
    const j = await loadJourney();
    expect(hasStamp(j, JOURNEY_STAMPS.paymentTested)).toBe(true);
    expect(hasStamp(j, JOURNEY_STAMPS.flowUnderstood)).toBe(true);
  });

  it('SOL payer: an UNBOUND receipt (wrong rid) is ignored — no award', async () => {
    await mountSol();
    await emitSol({type: 'request', role: 'card', solreqUri: solreqUri()});
    await emitSol({type: 'receipt', role: 'card', status: 0, rid: 'd'.repeat(32), sig: 'x'});
    await settleStore();
    const j = await loadJourney();
    expect(hasStamp(j, JOURNEY_STAMPS.paymentTested)).toBe(false);
  });
});
