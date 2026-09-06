/**
 * The MERCHANT half of an IC tap, and the only question it has to answer: may the cashier hand over
 * the goods?
 *
 * Three verdicts, three screens (`MerchantVerdict` in `components/NfcTap.tsx`). This suite pins the
 * two that are NOT a settlement, because those are the ones a counter gets wrong:
 *
 *   * the ledger's own answer said the transfer did not execute — where a payer holding no VCHF, or
 *     too little, arrives — and no history row appeared. It is NOT shown as a decline: `read_state`
 *     trees are decoded but not BLS-verified on this device, so the phone cannot prove the refusal.
 *     It is reported as doubt WITH the doubt named, and the copy never states a cause.
 *   * nothing observed inside the poll budget. Honest absence — the transfer may still be in flight.
 *
 * Both must stay on the `pending` ("Not confirmed") screen and both must return RESULT_UNKNOWN (2)
 * to the payer: a false decline on either phone is worse than an honest unknown. The regression this
 * guards is the collapse the two used to share — one payer-flavoured line ("check the balance
 * shortly") that told a cashier nothing about handing over goods.
 *
 * NOT re-tested here: the card-side auto-sign rule (`nfc-approve-review.test.tsx`), the shared
 * phase machine (`useNfcTapState.test.tsx`), the status card's title/sub mapping
 * (`nfc-tap-view.test.ts`), and the settled path end to end (e2e flows 86/87 + `just ondevice`).
 */
import {describe, it, expect, jest, afterEach} from '@jest/globals';
import React from 'react';
import Renderer, {act} from 'react-test-renderer';
import {DeviceEventEmitter, Text} from 'react-native';

jest.mock('../services/native', () => ({
  DpayNfc: {
    addListener: (_eventType: string) => ({remove: () => {}}),
    removeListeners: (_count: number) => {},
    armCard: jest.fn(async () => {}),
    disarmCard: jest.fn(async () => {}),
    startReader: jest.fn(async (_p: string) => {}),
    stopReader: jest.fn(async () => {}),
    confirmResult: jest.fn(async () => {}),
  },
}));

jest.mock('../services/rail', () => ({
  prepareNfcTransfer: jest.fn(),
  submitNfcTransfer: jest.fn(async () => ({kind: 'unknown'})),
  confirmIncomingTransfer: jest.fn(async () => false),
}));

import type {CurrencyDescriptor} from '../config/catalog';
import {NfcTap} from '../components/NfcTap';
import {DpayNfc} from '../services/native';
import {submitNfcTransfer, confirmIncomingTransfer} from '../services/rail';
import {M} from '../i18n';

const mk = (d: Partial<CurrencyDescriptor> & Pick<CurrencyDescriptor, 'currency' | 'minter_family'>): CurrencyDescriptor => ({
  ledger: '', mintable: false, minter: null, symbol: null, decimals: null,
  wrapper_name: null, backing_symbol: null, network: null, display_decimals: null, min_fraction_digits: null,
  fee: null, cap: null, chain_id: null, token_contract: null, gas_ledger: null,
  onramp: 'Unavailable', offramp: 'Unavailable', liquidity: null, ramp_partner: null, testnet: false, ...d,
});
// VCHF — the asset a dpay till settles in, and the one a merchant reader is realistically armed on.
const CATALOG: CurrencyDescriptor[] = [mk({
  currency: 7, minter_family: null, ledger: 'ly36x-wiaaa-aaaai-aqj7q-cai', symbol: 'CHF', decimals: 8,
  wrapper_name: 'VCHF', backing_symbol: 'CHF', network: 'Internet Computer', display_decimals: 2,
})];

const IDENTITY = {secretHex: '9f'.repeat(32), publicHex: '11'.repeat(32), username: 'Bahnhof Kiosk'};
const NONCE = 'ab'.repeat(16);
const REQ_ID = 'ff'.repeat(32);

const RESULT_UNKNOWN = 2;

let tree: Renderer.ReactTestRenderer | null = null;
afterEach(async () => {
  // Unmount inside act — React 19 defers passive-effect destroy, and the view's motion beats keep
  // an rAF chain alive past teardown otherwise (same idiom as nfc-approve-review.test.tsx).
  if (tree) { const t = tree; tree = null; await act(async () => { t.unmount(); }); }
  jest.clearAllMocks();
});

async function mountReader() {
  await act(async () => {
    tree = Renderer.create(
      <NfcTap
        role="reader"
        identity={IDENTITY}
        relayUrl="http://relay.test"
        requestHex={'dd'.repeat(66)}
        reqInfo={{amount: '450000000', nonce: NONCE, who: 'payer', currency: 7}}
        catalog={CATALOG}
        onClose={() => {}}
      />,
    );
  });
}

const emit = async (ev: unknown) => { await act(async () => { DeviceEventEmitter.emit('DpayNfcEvent', ev); }); };

/** Drive one whole merchant tap: the payer's bundle lands, then the transport confirms the result
 *  hand-back, which is the moment the merchant screen is allowed to reach a verdict. */
async function runTap() {
  await emit({
    type: 'done', role: 'reader',
    envelopeHex: 'ee'.repeat(80), requestIdHex: REQ_ID, readStateEnvelopeHex: 'aa'.repeat(80),
  });
  await emit({type: 'confirmed', role: 'reader'});
}

/** Every rendered Text — the tap view's title/sub carry no testIDs (e2e matches them by text). */
const texts = (): string[] => tree!.root.findAllByType(Text).map(n => {
  const c = n.props.children;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => typeof x === 'string').join('') : '';
});

describe('NfcTap merchant verdict — the two ways a tap ends without a settlement', () => {
  it('an unverifiable ledger refusal is reported as doubt, names no cause, and refuses the goods', async () => {
    // What the ledger said. `insufficientFunds` is the realistic instance (a payer without VCHF),
    // and the point of the assertion below is that this sentence NEVER reaches the merchant: the
    // phone cannot verify the answer, so it must not be repeated as a fact about the customer.
    jest.mocked(submitNfcTransfer).mockResolvedValue({kind: 'rejected', reason: M.rail.insufficientFunds, variant: 'InsufficientFunds'});
    jest.mocked(confirmIncomingTransfer).mockResolvedValue(false);
    await mountReader();
    await runTap();

    const shown = texts();
    expect(shown).toContain(M.nfc.phase.pending.title);       // "Not confirmed" — never "Declined"
    expect(shown).toContain(M.errors.tap.merchantRefusalUnverified);
    expect(shown).not.toContain(M.errors.tap.merchantNothingArrived);
    expect(shown.join(' ')).not.toContain(M.rail.insufficientFunds);
    // The payer is told UNKNOWN too — a merchant phone that cannot prove a refusal must not push
    // one onto the phone that signed.
    expect(DpayNfc.confirmResult).toHaveBeenCalledWith(RESULT_UNKNOWN, NONCE, REQ_ID, IDENTITY.secretHex);
  });

  it('an unanswered wait says no payment arrived, and that it can still land', async () => {
    jest.mocked(submitNfcTransfer).mockResolvedValue({kind: 'unknown'});
    jest.mocked(confirmIncomingTransfer).mockResolvedValue(false);
    await mountReader();
    await runTap();

    const shown = texts();
    expect(shown).toContain(M.nfc.phase.pending.title);
    expect(shown).toContain(M.errors.tap.merchantNothingArrived);
    expect(shown).not.toContain(M.errors.tap.merchantRefusalUnverified);
    expect(DpayNfc.confirmResult).toHaveBeenCalledWith(RESULT_UNKNOWN, NONCE, REQ_ID, IDENTITY.secretHex);
  });

  it('an exact history row outranks the ledger refusal — money that moved is a sale', async () => {
    // The positive control for the branch above: the SAME refusal, but the merchant's own durable
    // history has the row. History wins, so neither dead-end sentence may appear.
    jest.mocked(submitNfcTransfer).mockResolvedValue({kind: 'rejected', reason: M.rail.insufficientFunds, variant: 'InsufficientFunds'});
    jest.mocked(confirmIncomingTransfer).mockResolvedValue(true);
    const onSettled = jest.fn();
    await act(async () => {
      tree = Renderer.create(
        <NfcTap
          role="reader" identity={IDENTITY} relayUrl="http://relay.test"
          requestHex={'dd'.repeat(66)} reqInfo={{amount: '450000000', nonce: NONCE, who: 'payer', currency: 7}}
          catalog={CATALOG} onSettled={onSettled} onClose={() => {}}
        />,
      );
    });
    await runTap();

    const shown = texts().join(' ');
    expect(shown).not.toContain(M.errors.tap.merchantRefusalUnverified);
    expect(shown).not.toContain(M.errors.tap.merchantNothingArrived);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
