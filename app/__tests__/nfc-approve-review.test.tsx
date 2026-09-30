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
import {describe, it, expect, jest, beforeEach, afterEach} from '@jest/globals';
import Renderer, {act} from 'react-test-renderer';
import bs58 from 'bs58';
import {DeviceEventEmitter} from 'react-native';
import type {CurrencyDescriptor} from '../config/catalog';
import {icpCatalogOf, fmtCurrencyAmountCompact, BUNDLED_NETWORKS} from '../config/catalog';
import {encodeSolReq} from '../solana/qr';
import {NfcTap} from '../components/NfcTap';
import {SolNfcTap} from '../components/SolNfcTap';
import {DpayNfc, DpaySolNfc} from '../services/native';
import {prepareNfcTransfer, fetchLedgerFee} from '../services/rail';
import {rememberLedgerFee} from '../services/ledgerFees';
import * as txNotes from '../services/txNotes';
import {signSolPayment, signSplPayment} from '../solana';
import {USDC_MINT_ADDRESS, EURC_MINT_ADDRESS} from '../solana/tokens';
import type {SolMintStates} from '../config/assets';
import {M} from '../i18n';
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
  // The live icrc1_fee query behind the gross readout (founder rule 2026-09-14). The fixture
  // catalog below carries NO ledger, so the auto-sign tests never reach it; the offline-display
  // describe configures it per test.
  fetchLedgerFee: jest.fn(),
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
  wrapper_name: null, backing_symbol: null, network: null, display_decimals: null, min_fraction_digits: null,
  fee: null, cap: null, chain_id: null, token_contract: null, gas_ledger: null,
  onramp: 'Unavailable', offramp: 'Unavailable', liquidity: null, ramp_partner: null, testnet: false, ...d,
});
const CATALOG: CurrencyDescriptor[] = [mk({
  currency: 1, minter: 'm', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8,
  wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin', display_decimals: 8,
})];

const IDENTITY = {secretHex: '9f'.repeat(32), publicHex: '11'.repeat(32), username: 'test'};
const MERCHANT_HEX = '22'.repeat(32);

let tree: Renderer.ReactTestRenderer | null = null;
afterEach(async () => {
  // Unmount INSIDE act — React 19 defers passive-effect DESTROY, so a bare `tree.unmount()` leaves
  // every `useEffect` cleanup unrun until the next act() (i.e. the next test, and never for the
  // last one). That is how the tap view's motion beats stayed animating past the suite: their
  // requestAnimationFrame chain kept firing after jest tore the environment down. Matches the
  // idiom every other component suite here uses.
  if (tree) { const t = tree; tree = null; await act(async () => { t.unmount(); }); }
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
async function mountSol(tokenBalances?: SolMintStates) {
  await act(async () => {
    tree = Renderer.create(
      <SolNfcTap role="card" identity={IDENTITY} tokenBalances={tokenBalances} onClose={() => {}} />,
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
    expect(hasText('Paying 0.0005 BTC on Bitcoin')).toBe(true);
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
    expect(hasText('This request expired — ask for a fresh one')).toBe(true);
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

describe("NfcTap (IC) offline fee display — the payer still reads the price (founder rule 2026-09-14)", () => {
  // The offline half of the rule: the payer taps with NO network, the live icrc1_fee query
  // fails — yet the readout must still headline the TYPED PRICE (wire + fee), not the netted
  // wire the request carries. The chain falls back to the fee this very ledger last answered
  // (services/ledgerFees, persisted by every successful query) and then the catalog row's
  // drift-alarmed fee. The catalog fixture is the REAL bundled VCHF row (fee '10000' raw = the
  // 0.0001 VCHF the founder's 1.00-price example nets out); ckBTC/DEMO register no fee anywhere
  // and keep the honest wire-only readout (the ckBTC tests above pin that surface).
  const VCHF_CATALOG: CurrencyDescriptor[] = icpCatalogOf(BUNDLED_NETWORKS).filter(c => c.currency === 7);
  const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
  const REQ_VCHF = {currency: 7, amount: '99990000'}; // price 1.00 → wire 0.9999 (fee netted out)

  beforeEach(() => {
    // The offline default: the live query rejects, exactly as it does with no network. The
    // suite-level afterEach clears calls (implementations persist), so each test re-arms this.
    jest.mocked(fetchLedgerFee).mockReset().mockRejectedValue(new Error('offline'));
  });

  async function mountVchfCard() {
    await act(async () => {
      tree = Renderer.create(
        <NfcTap role="card" identity={IDENTITY} catalog={VCHF_CATALOG} onClose={() => {}} />,
      );
    });
  }

  it('persisted ledger fee carries the price — "Paying 1.00 VCHF", not the 0.9999 wire', async () => {
    await rememberLedgerFee(VCHF_LEDGER, '10000'); // what the ledger answered on some earlier online day
    await mountVchfCard();
    await emitIc(icRequest(REQ_VCHF));
    expect(fetchLedgerFee).toHaveBeenCalledTimes(1); // the live query WAS attempted first — and lost
    expect(hasText(M.nfc.paying(fmtCurrencyAmountCompact(VCHF_CATALOG, 7, '100000000'), 'Internet Computer'))).toBe(true);
    expect(hasText(M.nfc.paying(fmtCurrencyAmountCompact(VCHF_CATALOG, 7, '99990000'), 'Internet Computer'))).toBe(false); // the wire never headlines
  });

  it('no cache: the bundled catalog row stands in (drift-alarmed display metadata)', async () => {
    await mountVchfCard(); // afterEach cleared AsyncStorage — no persisted answer
    await emitIc(icRequest(REQ_VCHF));
    expect(hasText(M.nfc.paying(fmtCurrencyAmountCompact(VCHF_CATALOG, 7, '100000000'), 'Internet Computer'))).toBe(true);
  });

  it('a stale cache never beats a live answer — the ledger stays authoritative', async () => {
    await rememberLedgerFee(VCHF_LEDGER, '20000'); // stale
    jest.mocked(fetchLedgerFee).mockResolvedValue('10000'); // live wins
    await mountVchfCard();
    await emitIc(icRequest(REQ_VCHF));
    expect(hasText(M.nfc.paying(fmtCurrencyAmountCompact(VCHF_CATALOG, 7, '100000000'), 'Internet Computer'))).toBe(true); // 1.00, never the 1.0001 the stale cache would give
  });

  it('the offline note still records the price — {gross: wire+fee, fee} from the fallback', async () => {
    await rememberLedgerFee(VCHF_LEDGER, '10000');
    const noteSpy = jest.spyOn(txNotes, 'saveTxNote');
    await mountVchfCard();
    await emitIc(icRequest(REQ_VCHF));
    await act(async () => {}); // flush the chained fee promise into the note save
    expect(noteSpy).toHaveBeenCalledTimes(1);
    const [who, note] = noteSpy.mock.calls[0];
    expect(who).toBe(IDENTITY.publicHex);
    expect(note.k).toBe('ab'.repeat(16)); // the request nonce — the on-chain reconciliation key
    expect(note.gross).toBe('100000000'); // the price, not the 99990000 wire
    expect(note.fee).toBe('10000');
    noteSpy.mockRestore();
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
    expect(hasText('Paying 0.001005 SOL')).toBe(true);
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
    expect(hasText('This payment request expired')).toBe(true);
  });

  // ── Per-request-mint sign gate (OPEN_ISSUES 6(a)) ─────────────────────────────────────────
  // The solreq names its OWN mint; a KNOWN-absent mint would sign pure against an ATA that
  // doesn't exist and the merchant's broadcast would be REJECTED (dead tap). Decline by name.
  const SPL_DEST_ATA = '9AkkgHAxGYiX6RXhXbkVhFiyMAK81GYcj4zDtk9wbT4u'; // any valid base58 pubkey
  const UNREGISTERED_MINT = 'So11111111111111111111111111111111111111112'; // wrapped SOL — real mainnet mint dpay doesn't carry
  const splReq = (mint: string, cur: string) => solreqUri({cur, mint, toAta: SPL_DEST_ATA, amt: '1500000'});

  it('a solreq naming a KNOWN-absent mint auto-declines at the sign gate — nothing ever signs', async () => {
    await mountSol({[EURC_MINT_ADDRESS]: {amount: null, status: 'absent'}});
    await emitSol({type: 'request', role: 'card', solreqUri: splReq(EURC_MINT_ADDRESS, 'EURC')});
    expect(signSolPayment).not.toHaveBeenCalled();
    expect(signSplPayment).not.toHaveBeenCalled();
    expect(DpaySolNfc.approveSolCard).not.toHaveBeenCalled();
    expect(DpaySolNfc.declineSolCard).toHaveBeenCalled();
    expect(hasText(M.errors.solana.senderNoTokenAccount('EURC'))).toBe(true);
  });

  it('an unregistered mint auto-declines with the named unknown-mint copy', async () => {
    await mountSol({});
    await emitSol({type: 'request', role: 'card', solreqUri: splReq(UNREGISTERED_MINT, 'USDC')});
    expect(signSplPayment).not.toHaveBeenCalled();
    expect(DpaySolNfc.declineSolCard).toHaveBeenCalled();
    expect(hasText(M.pay.spay.unknownMint(UNREGISTERED_MINT))).toBe(true);
  });

  it('a FUNDED request-mint still signs (balance of any amount ⇒ the ATA exists)', async () => {
    await mountSol({[USDC_MINT_ADDRESS]: {amount: '0', status: 'balance'}});
    await emitSol({type: 'request', role: 'card', solreqUri: splReq(USDC_MINT_ADDRESS, 'USDC')});
    expect(signSplPayment).toHaveBeenCalledTimes(1);
    expect(DpaySolNfc.approveSolCard).toHaveBeenCalledWith(expect.stringMatching(/^solpay:v2\?/));
    expect(DpaySolNfc.declineSolCard).not.toHaveBeenCalled();
  });

  it('fail-open: an unconfirmed request-mint state (and a legacy mount with no states) signs', async () => {
    for (const states of [
      {[EURC_MINT_ADDRESS]: {amount: null, status: 'loading'}},
      {[EURC_MINT_ADDRESS]: {amount: null, status: 'unavailable'}},
      {[EURC_MINT_ADDRESS]: {amount: '0', status: 'error'}},
    ] as Record<string, {amount: string | null; status: string}>[]) {
      await mountSol(states);
      await emitSol({type: 'request', role: 'card', solreqUri: splReq(EURC_MINT_ADDRESS, 'EURC')});
      expect(signSplPayment).toHaveBeenCalledTimes(1);
      expect(DpaySolNfc.declineSolCard).not.toHaveBeenCalled();
      if (tree) { const t = tree; tree = null; await act(async () => { t.unmount(); }); }
      jest.clearAllMocks();
    }
    await mountSol(); // no tokenBalances at all (reader-style/legacy mount)
    await emitSol({type: 'request', role: 'card', solreqUri: splReq(EURC_MINT_ADDRESS, 'EURC')});
    expect(signSplPayment).toHaveBeenCalledTimes(1);
  });

  // ── The DISCLOSURE half (M1) ───────────────────────────────────────────────────────────────
  // A tap auto-signs with no review, so there is no screen to caveat BEFORE the payment leaves the
  // phone. The terminal message is the only sentence this flow ever shows the payer — so that is
  // where a fact-less signature has to own up. `expectedSig` is bs58 of the mocked tx's 64 sig
  // bytes; the receipt must match rid+sig exactly or the adapter ignores it (cross-tap defence).
  const EXPECTED_SIG = bs58.encode(new Uint8Array(64).fill(7));
  const receipt = (status: number) =>
    ({type: 'receipt', role: 'card', status, rid: 'c'.repeat(32), sig: EXPECTED_SIG});

  it('a DECLINE after a fact-less signature says what could not be checked and what to do', async () => {
    await mountSol({[EURC_MINT_ADDRESS]: {amount: null, status: 'loading'}});
    await emitSol({type: 'request', role: 'card', solreqUri: splReq(EURC_MINT_ADDRESS, 'EURC')});
    expect(signSplPayment).toHaveBeenCalledTimes(1); // it still SIGNED — a caveat is not a block
    await emitSol(receipt(1)); // RECEIPT_REJECTED — exactly what an absent token account produces
    expect(hasText(`${M.errors.tap.paymentRejected}. ${M.errors.solana.senderTokenAccountUnverified('EURC')}`)).toBe(true);
  });

  it('an UNKNOWN outcome carries it too — and a refusing endpoint gets the rail-down copy', async () => {
    await mountSol({[EURC_MINT_ADDRESS]: {amount: null, status: 'error', failure: 'refused'}});
    await emitSol({type: 'request', role: 'card', solreqUri: splReq(EURC_MINT_ADDRESS, 'EURC')});
    await emitSol(receipt(2)); // RECEIPT_UNREACHABLE → honest pending
    expect(hasText(`${M.errors.tap.couldntConfirm}. ${M.errors.solana.senderTokenAccountUnverifiedRailDown('EURC')}`)).toBe(true);
  });

  it('a SETTLED tap says nothing about the account — the chain just proved it exists', async () => {
    await mountSol({[EURC_MINT_ADDRESS]: {amount: null, status: 'loading'}});
    await emitSol({type: 'request', role: 'card', solreqUri: splReq(EURC_MINT_ADDRESS, 'EURC')});
    await emitSol(receipt(0)); // RECEIPT_SETTLED
    expect(hasText(M.errors.solana.senderTokenAccountUnverified('EURC'))).toBe(false);
  });

  it('a decline after a signature made ON a fact is unchanged — no caveat is invented', async () => {
    await mountSol({[USDC_MINT_ADDRESS]: {amount: '5000000', status: 'balance'}});
    await emitSol({type: 'request', role: 'card', solreqUri: splReq(USDC_MINT_ADDRESS, 'USDC')});
    await emitSol(receipt(1));
    expect(hasText(M.errors.tap.paymentRejected)).toBe(true);
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
