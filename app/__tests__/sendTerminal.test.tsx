/**
 * sendTerminal — the ONE surface both send rails end on (2026-09 stream D).
 *
 * Three contracts, in the order the streams own them:
 *
 *  1. THE COMPONENT's status→copy mapping (SendTerminal rendered directly): settled/pending/failed
 *     pick the glyph, the headline testID and the note; the action matrix is status-gated —
 *     Check status is pending-only (and IC passes no handler at all), the receipt is hidden on a
 *     fee-only failure (nothing was delivered, so there is no payment to receipt), the copy and
 *     Done are always there. The testID grammar (`<prefix>-…`) is what the e2e flows pin, so it
 *     is asserted literally here.
 *
 *  2. THE RECEIPT Txn each sheet builds — the object handed to `onOpenReceipt` is the same
 *     `TxnReceipt` the History rows open, so its fields are money facts, not display strings:
 *     direction, asset, counterparty, the rail's reference (SOL signature / IC block index /
 *     pending memo) and the honest `pending` flag that makes the receipt say "not confirmed yet".
 *     Pinned through BOTH sheets: SOL via the check-status flip (pending → settled, the flag
 *     drops), IC via a mocked settle.
 *
 *  3. THE IC RAIL's throw classification (the twin of the SOL sheet's `broadcast.sig` split): a
 *     throw before the envelope is signed is "nothing was sent" — the form returns with the line
 *     and a retry is safe; a throw AFTER signing is the honest unknown — no resend invite, the
 *     reference is the handle the ledger will carry. A ledger rejection is a definitive refusal:
 *     form + the reason + the nothing-sent line.
 *
 * The rail mocks are the same module-boundary doubles the sheet suites use; nothing here reaches
 * the network.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('../solana', () => ({
  sendSol: jest.fn(),
  sendSpl: jest.fn(),
  getSolSignatureStatus: jest.fn(),
  preloadSolanaRpc: () => {},
}));
jest.mock('../services/native', () => ({
  DpayCore: {
    icpSelfPrincipal: jest.fn(),
    icpAccountIdFromPrincipal: jest.fn(),
    icpValidateIcrcAccount: jest.fn(),
    icpValidateAccountId: jest.fn(),
  },
}));
jest.mock('../services/rail', () => ({
  prepareTransfer: jest.fn(),
  prepareLegacyTransfer: jest.fn(),
  submitTransfer: jest.fn(),
  decodeLegacyReply: jest.fn(),
  fetchLedgerFee: jest.fn(),
}));
jest.mock('../components/WithdrawSheet', () => ({
  WithdrawSheet: (_props: {address: string}) => null,
}));

import {sendSol, getSolSignatureStatus} from '../solana';
import {DpayCore} from '../services/native';
import {fetchLedgerFee, prepareTransfer, submitTransfer} from '../services/rail';
import {SendTerminal} from '../components/SendTerminal';
import {SolanaWithdrawSheet} from '../components/SolanaWithdrawSheet';
import {SendSheet} from '../components/SendSheet';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import type {CurrencyDescriptor} from '../config/catalog';
import type {Identity, Txn} from '../lib/types';
import {M} from '../i18n';

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  jest.mocked(fetchLedgerFee).mockResolvedValue('10000');
  jest.mocked(DpayCore.icpSelfPrincipal).mockResolvedValue('3nrdb-dxqqw-mc4gr-fbwxc-ynsdh-2e72e-urieh-mx52v-moiye-hff4l-4qe');
  jest.mocked(DpayCore.icpAccountIdFromPrincipal).mockResolvedValue('ff'.repeat(32));
  jest.mocked(DpayCore.icpValidateIcrcAccount).mockResolvedValue({
    owner: 'k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae', subaccountHex: '',
  });
});

const has = (tree: renderer.ReactTestRenderer, testID: string): boolean =>
  tree.root.findAll(n => n.props != null && n.props.testID === testID).length > 0;

// ============================================================================
// 1 — the component: status → glyph, headline, note, actions
// ============================================================================
describe('SendTerminal — the status→copy mapping and the status-gated action matrix', () => {
  type Props = Parameters<typeof SendTerminal>[0];

  /** Mount one terminal in the given status with EVERY handler armed, so each test asserts the
   *  GATING (which actions a status offers) rather than the caller's wiring. */
  async function mountTerminal(over: Partial<Props> = {}) {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SendTerminal
          settled={false}
          headline="H"
          amountText="1.00 T"
          destinationLabel="To"
          destination="DEST"
          pendingBody="PENDING-BODY"
          failedBody="FAILED-BODY"
          referenceLabel="Ref"
          reference="REF"
          refTestID="t-ref"
          prefix="t"
          onOpenReceipt={() => {}}
          onCheckStatus={() => {}}
          onDone={() => {}}
          {...over}
        />,
      );
    });
    return tree;
  }

  test('settled → the outcome headline, no notes, no check, receipt + copy + done', async () => {
    const tree = await mountTerminal({settled: true});
    expect(has(tree, 't-outcome')).toBe(true);
    expect(has(tree, 't-unknown-title')).toBe(false);
    expect(has(tree, 't-failed-title')).toBe(false);
    expect(has(tree, 't-unknown-note')).toBe(false); // no pending body on a settled send
    expect(has(tree, 't-failed-note')).toBe(false);
    expect(has(tree, 'btn-t-check')).toBe(false); // a settled send needs no re-read
    expect(has(tree, 'btn-t-receipt')).toBe(true);
    expect(has(tree, 'btn-t-copy')).toBe(true);
    expect(has(tree, 'btn-t-done')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('pending → the honest-unknown headline + body, the read offered, the receipt says pending', async () => {
    const tree = await mountTerminal({settled: false});
    expect(has(tree, 't-unknown-title')).toBe(true);
    expect(has(tree, 't-unknown-note')).toBe(true);
    expect(has(tree, 'btn-t-check')).toBe(true);
    expect(has(tree, 'btn-t-receipt')).toBe(true); // present, flagged pending by the Txn (§2)
    expect(has(tree, 'btn-t-copy')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('a pending terminal without a check handler (IC) offers NO check — the rail that cannot re-read says so by absence', async () => {
    const tree = await mountTerminal({settled: false, onCheckStatus: undefined});
    expect(has(tree, 't-unknown-title')).toBe(true);
    expect(has(tree, 'btn-t-check')).toBe(false);
    expect(has(tree, 'btn-t-receipt')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('failed → the fee-only failure: its headline + body, the reference KEPT, no receipt, no check, no resend', async () => {
    const tree = await mountTerminal({settled: false, failed: true});
    expect(has(tree, 't-failed-title')).toBe(true);
    expect(has(tree, 't-failed-note')).toBe(true);
    expect(has(tree, 't-unknown-note')).toBe(false); // the pending body never rides a verdict
    expect(has(tree, 't-ref')).toBe(true); // the signature stays as the proof
    expect(has(tree, 'btn-t-receipt')).toBe(false); // nothing was delivered — no payment to receipt
    expect(has(tree, 'btn-t-check')).toBe(false); // the verdict is reached; the read is done
    expect(has(tree, 'btn-t-copy')).toBe(true);
    expect(has(tree, 'btn-t-done')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('copy is the reference and nothing else — pressing it never fires another handler', async () => {
    const receipt = jest.fn();
    const tree = await mountTerminal({settled: true, onOpenReceipt: receipt});
    await act(async () => { tree.root.findByProps({testID: 'btn-t-copy'}).props.onPress(); });
    expect(receipt).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });
});

// ============================================================================
// 2 — the receipt Txn, built by the SOL sheet across the check-status flip
// ============================================================================
describe('SolanaWithdrawSheet — the receipt Txn: pending truth, then the settled proof', () => {
  const SIG = '5ig'.repeat(10);
  const SOL_DEST = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const IDENT: Identity = {secretHex: 'ab'.repeat(32), publicHex: 'cd'.repeat(32), username: 't'};

  /** Send with the deadline firing over an ACCEPTED broadcast (the unknown terminal), collecting
   *  every Txn the receipt affordance hands up. */
  async function sendToUnknown(receipts: Txn[]) {
    jest.mocked(sendSol).mockImplementation((_seed, _dest, _amt, _signal, onBroadcast) => {
      onBroadcast?.(SIG);
      return Promise.reject(new Error('sol send aborted (deadline)'));
    });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SolanaWithdrawSheet
          identity={IDENT}
          token="SOL"
          balance="2000000000"
          onSent={() => {}}
          onClose={() => {}}
          onOpenReceipt={t => receipts.push(t)}
        />,
      );
    });
    await act(async () => {
      tree.root.findByProps({testID: 'sol-send-address-input'}).props.onChangeText(SOL_DEST);
      tree.root.findByProps({testID: 'sol-send-amount-input'}).props.onChangeText('0.5');
    });
    await act(async () => { await tree.root.findByProps({testID: 'btn-sol-send-confirm'}).props.onPress(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    return tree;
  }

  const press = async (tree: renderer.ReactTestRenderer, testID: string) => {
    await act(async () => { await tree.root.findByProps({testID}).props.onPress(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  };

  test('the PENDING receipt: dir out, the signature as reference, the counterparty, and pending: true', async () => {
    const receipts: Txn[] = [];
    const tree = await sendToUnknown(receipts);
    expect(has(tree, 'sol-send-unknown-title')).toBe(true);
    await press(tree, 'btn-sol-send-receipt');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      nonce: SIG,
      dir: 'out',
      assetId: 'solana:SOL',
      counterparty: SOL_DEST,
      ledgerRef: SIG,
      pending: true, // the receipt must say "not confirmed yet", never print a proof
    });
    act(() => { tree.unmount(); });
  });

  test('after Check status CONFIRMS, the receipt is the same payment without the pending flag', async () => {
    jest.mocked(getSolSignatureStatus).mockResolvedValue({confirmationStatus: 'confirmed', err: null});
    const receipts: Txn[] = [];
    const tree = await sendToUnknown(receipts);
    await press(tree, 'btn-sol-send-check'); // the read flips the panel to settled
    expect(has(tree, 'sol-send-outcome')).toBe(true);
    await press(tree, 'btn-sol-send-receipt');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      nonce: SIG,
      dir: 'out',
      assetId: 'solana:SOL',
      counterparty: SOL_DEST,
      ledgerRef: SIG, // the SAME payment the pending receipt named — one signature
    });
    expect(receipts[0].pending).toBeUndefined(); // confirmed now: no pending disclaimer
    act(() => { tree.unmount(); });
  });
});

// ============================================================================
// 3 — the IC sheet: the settled receipt Txn + the throw classification at the signature boundary
// ============================================================================
describe('SendSheet — the signature boundary: nothing-sent vs the honest unknown', () => {
  const OISY = '3nrdb-dxqqw-mc4gr-fbwxc-ynsdh-2e72e-urieh-mx52v-moiye-hff4l-4qe';
  const K2 = 'k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae';
  const CATALOG: CurrencyDescriptor[] = icpCatalogOf(BUNDLED_NETWORKS);
  const VCHF = CATALOG.find(c => c.currency === 7)!;
  const IDENTITY: Identity = {secretHex: '11'.repeat(32), publicHex: '22'.repeat(32), username: 'Ada'};
  const PREPARED = {
    ledger: VCHF.ledger!, envelopeHex: 'ab', requestIdHex: 'cd'.repeat(32),
    amount: '100000000', currency: 7, memoHex: 'ef',
  };

  type Props = Parameters<typeof SendSheet>[0];

  async function armedSend(over: Partial<Props> = {}) {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SendSheet
          identity={IDENTITY}
          catalog={CATALOG}
          desc={VCHF}
          balance="500000000"
          family={null}
          display={null}
          tokenContract={null}
          onSent={() => {}}
          onClose={() => {}}
          {...over}
        />,
      );
    });
    await act(async () => {});
    // The REAL shared AddressField renders the input (testID `<prefix>-address-input`) — the same
    // way the SOL suite drives it; no double is installed in this file.
    await act(async () => { tree.root.findByProps({testID: 'send-address-input'}).props.onChangeText(K2); });
    await act(async () => {}); // the validators are async
    await act(async () => { tree.root.findByProps({testID: 'send-amount-input'}).props.onChangeText('1.00000000'); });
    return tree;
  }

  const press = async (tree: renderer.ReactTestRenderer, testID: string) => {
    await act(async () => { await tree.root.findByProps({testID}).props.onPress(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  };

  test('a settled send hands the receipt the REAL Txn: block index, memo hex, destination, dir out', async () => {
    jest.mocked(prepareTransfer).mockResolvedValue(PREPARED);
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'settled', blockIndex: '8168'});
    const receipts: Txn[] = [];
    const tree = await armedSend({onOpenReceipt: t => receipts.push(t)});
    await press(tree, 'btn-send-confirm');
    expect(has(tree, 'send-outcome')).toBe(true);
    await press(tree, 'btn-send-receipt');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      dir: 'out',
      assetId: 'ic:7',
      counterparty: K2,
      ledgerRef: '8168',
    });
    expect(receipts[0].memo).toMatch(/^[0-9a-f]{32}$/); // the fresh memo IS the reference
    expect(receipts[0].pending).toBeUndefined();
    act(() => { tree.unmount(); });
  });

  test('a throw AFTER the envelope was signed is the honest UNKNOWN — no resend invite, the reference survives', async () => {
    jest.mocked(prepareTransfer).mockResolvedValue(PREPARED);
    jest.mocked(submitTransfer).mockRejectedValue(new Error('network unreachable'));
    const tree = await armedSend({onOpenReceipt: () => {}});
    await press(tree, 'btn-send-confirm');
    expect(has(tree, 'send-unknown-title')).toBe(true); // the pending terminal, NOT the form
    expect(has(tree, 'btn-send-confirm')).toBe(false); // THE INVARIANT: no resend over a signed send
    expect(has(tree, 'send-ref')).toBe(true);
    expect(has(tree, 'btn-send-receipt')).toBe(true); // the pending receipt says "not confirmed yet"
    expect(submitTransfer).toHaveBeenCalledTimes(1); // one submission — nothing re-armed behind the user's back
    act(() => { tree.unmount(); });
  });

  test('a throw BEFORE the envelope exists is "nothing was sent" — the form returns and a retry is safe', async () => {
    jest.mocked(prepareTransfer).mockRejectedValue(new Error('clock skew'));
    const tree = await armedSend();
    await press(tree, 'btn-send-confirm');
    expect(has(tree, 'send-unknown-title')).toBe(false); // never a pending claim — nothing is out there
    expect(has(tree, 'send-nothing-sent')).toBe(true);
    expect(has(tree, 'btn-send-confirm')).toBe(true); // the form IS the retry, and it is safe
    expect(submitTransfer).not.toHaveBeenCalled(); // the boundary held: nothing was submitted
    act(() => { tree.unmount(); });
  });

  test('a ledger REJECTION is definitive — the reason shows, the nothing-sent line rides it', async () => {
    jest.mocked(prepareTransfer).mockResolvedValue(PREPARED);
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'rejected', reason: 'fee too low'});
    const tree = await armedSend();
    await press(tree, 'btn-send-confirm');
    expect(has(tree, 'send-unknown-title')).toBe(false);
    expect(String(tree.root.findByProps({testID: 'send-err'}).props.children)).toBe('fee too low');
    expect(has(tree, 'send-nothing-sent')).toBe(true);
    expect(has(tree, 'btn-send-confirm')).toBe(true);
    act(() => { tree.unmount(); });
  });
});
