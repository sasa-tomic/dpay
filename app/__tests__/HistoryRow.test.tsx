/**
 * HistoryRow — the shared transaction-row renderer the Transactions tab and the Home tab's
 * inline activity feed both render through (O4 slice 2's behavior-identical extraction from
 * Ledger). The ROW assertions here are the Ledger row assertions, ported verbatim: own-unit
 * amounts per rail, the direction sign INSIDE the formatter, the fail-closed Unsupported
 * sentinel, and the failed-Solana status line. The extraction proof itself is Ledger.test.tsx
 * passing UNCHANGED on top of the shared component.
 *
 * The `testPrefix` seam is the one new fact: the Home feed renders the identical row under its
 * own home-hist-* testIDs so the two surfaces never share an e2e anchor.
 */
import {describe, test, expect} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {HistoryRow, TxnReceipt, receiptText} from '../components/HistoryRow';
import {buildSelectableAssets} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {M} from '../i18n';
import type {AssetId, Txn} from '../lib/types';

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {
  showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: BUNDLED_NETWORKS,
});

const TS_NEW = 1_756_000_200;
const TS_OLD = 1_756_000_000;

function txn(assetId: AssetId, amount: string, ts: number, overrides: Partial<Txn> = {}): Txn {
  return {
    nonce: `${assetId}:${ts}`,
    amount,
    who: 'someone',
    memo: '',
    time: Number.isFinite(ts) ? 'Aug 24' : '—',
    ts,
    dir: 'out',
    assetId,
    counterparty: 'aaaaa-aa',
    ledgerRef: '4211',
    ...overrides,
  };
}

/** Every rendered <Text>'s content, in render order. */
function texts(tree: renderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(n => {
    const c = n.props.children;
    return Array.isArray(c) ? c.filter(x => typeof x === 'string' || typeof x === 'number').join('') : String(c ?? '');
  });
}

function mount(t: Txn, i = 0, testPrefix?: string, onPress: (t: Txn) => void = () => {}): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(<HistoryRow t={t} i={i} catalog={CATALOG} assets={ASSETS} testPrefix={testPrefix} onPress={onPress} />); });
  return tree;
}

function mountReceipt(t: Txn, note?: {who?: string; msg?: string}): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(<TxnReceipt t={t} catalog={CATALOG} assets={ASSETS} note={note} onClose={() => {}} />); });
  return tree;
}

/** Mount a ROW with a device-saved annotation (the Wallet root resolves it; the row only renders). */
function mountNoted(t: Txn, note: {who?: string; msg?: string}, i = 0): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(<HistoryRow t={t} i={i} catalog={CATALOG} assets={ASSETS} note={note} onPress={() => {}} />); });
  return tree;
}

describe('HistoryRow — one row, both rails, own units', () => {
  test('DEMO formats through the catalog in ∂, SOL in its own trimmed units', () => {
    const demo = mount(txn('ic:0', '2500', TS_NEW));
    expect(texts(demo)).toContain('−∂25.00');
    act(() => { demo.unmount(); });
    const sol = mount(txn('solana:SOL', '1000000000', TS_OLD, {dir: 'in'}), 1);
    expect(texts(sol)).toContain('+1 SOL');
    act(() => { sol.unmount(); });
  });

  test('Solana USDC formats to USDC\'s 2-decimal floor, same string as the IC rail\'s row', () => {
    const ic = mount(txn('ic:2', '2500000', TS_NEW));
    expect(texts(ic)).toContain('−2.50 USDC');
    act(() => { ic.unmount(); });
    const spl = mount(txn('solana:USDC', '2500000', TS_OLD));
    expect(texts(spl)).toContain('−2.50 USDC');
    act(() => { spl.unmount(); });
  });

  test('a row whose asset is not visible fails closed to the Unsigned Unsupported sentinel', () => {
    // Unsigned: the sentinel is not a number, so it never takes a direction sign ("−Unsupported"
    // was the old concatenate-outside artefact).
    const tree = mount(txn('ic:9999', '50000', TS_NEW));
    expect(texts(tree)).toContain(M.wallet.asset.unsupported);
    expect(texts(tree)).not.toContain(`−${M.wallet.asset.unsupported}`);
    act(() => { tree.unmount(); });
  });

  test('a failed Solana row shows its status line next to the counterparty', () => {
    const tree = mount(txn('solana:SOL', '5000', TS_NEW, {who: '', memo: M.wallet.ledger.failed}));
    const all = texts(tree);
    expect(all).toContain(M.wallet.ledger.failed);
    expect(all).toContain(M.wallet.ledger.to('—')); // no determinable counterparty
    act(() => { tree.unmount(); });
  });

  test('memo and time carry the row index as hist-memo/hist-time by default (the Ledger anchors)', () => {
    const tree = mount(txn('ic:0', '2500', TS_NEW, {memo: 'coffee'}), 2);
    const ids = [...new Set(tree.root.findAll(n => typeof n.props?.testID === 'string').map(n => String(n.props.testID)))];
    expect(ids).toContain('hist-memo-2');
    expect(ids).toContain('hist-time-2');
    act(() => { tree.unmount(); });
  });

  test('testPrefix re-namespaces the same row for the Home feed (home-hist-*, never hist-*)', () => {
    const tree = mount(txn('ic:0', '2500', TS_NEW, {memo: 'coffee'}), 1, 'home-hist');
    const ids = [...new Set(tree.root.findAll(n => typeof n.props?.testID === 'string').map(n => String(n.props.testID)))];
    expect(ids).toContain('home-hist-memo-1');
    expect(ids).toContain('home-hist-time-1');
    expect(ids.some(id => id.startsWith('hist-'))).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('the row is pressable and hands its OWN transaction to the opener (X6)', () => {
    const t = txn('ic:0', '2500', TS_NEW, {memo: 'coffee'});
    const seen: Txn[] = [];
    const tree = mount(t, 3, undefined, x => seen.push(x));
    const row = tree.root.findByProps({testID: 'hist-row-3'});
    expect(row.props.accessibilityRole).toBe('button');
    act(() => { row.props.onPress(); });
    expect(seen).toEqual([t]);
    act(() => { tree.unmount(); });
  });
});

// ── The receipt (X6) ───────────────────────────────────────────────────────────────────────────
// A merchant who was paid has to be able to show WHAT they were paid. Every assertion below is
// about a field the rail REALLY provides — the rails differ, and the absent half must say why
// rather than render a blank labelled row.
describe('TxnReceipt — the merchant-reconciliation surface', () => {
  test('an IC row shows the EXACT amount, the full account, the memo reference and the block', () => {
    const t = txn('ic:0', '2500', TS_NEW, {
      dir: 'in', who: 'Demo funds', memo: '9f2c00112233445566778899aabbccdd',
      counterparty: 'nsjm5-jybxu-3hbey-npic6-nbmjf-3ub7i-6zwzc-wibfz-y6dbd-yhqly-xae',
      ledgerRef: '81062',
    });
    const tree = mountReceipt(t);
    const all = texts(tree);
    // EXACT, never the row's compact string: a receipt is a money-committed surface.
    expect(all).toContain('+∂25.00');
    expect(all).toContain('nsjm5-jybxu-3hbey-npic6-nbmjf-3ub7i-6zwzc-wibfz-y6dbd-yhqly-xae');
    expect(all).toContain('9f2c00112233445566778899aabbccdd');
    expect(all).toContain('81062');
    expect(all).toContain(M.receipt.blockLabel);
    // The IC rail has no transaction signature — that label must not appear at all.
    expect(all).not.toContain(M.receipt.signatureLabel);
    act(() => { tree.unmount(); });
  });

  test('a Solana row shows its signature and says the rail carries no reference', () => {
    const t = txn('solana:SOL', '1500000000', TS_NEW, {
      dir: 'out', counterparty: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      ledgerRef: '5Nq1FakeSig11111111111111111111111111111111111111111111111111111111',
    });
    const tree = mountReceipt(t);
    const all = texts(tree);
    expect(all).toContain('−1.500000000 SOL');
    expect(all).toContain('5Nq1FakeSig11111111111111111111111111111111111111111111111111111111');
    expect(all).toContain(M.receipt.signatureLabel);
    expect(all).toContain(M.receipt.noReferenceSolana);
    // No block index on Solana — the label must be absent, not rendered over an empty value.
    expect(all).not.toContain(M.receipt.blockLabel);
    act(() => { tree.unmount(); });
  });

  test('a side the ledger recorded no account for says so instead of rendering an empty row', () => {
    const t = txn('ic:0', '10000', TS_NEW, {dir: 'in', who: 'Demo funds', counterparty: '', memo: ''});
    const all = texts(mountReceipt(t));
    expect(all).toContain(M.receipt.noAccount);
    expect(all).toContain(M.receipt.noReferenceIc);
  });

  test('receiptText is the copyable proof: every rendered value, no label with an empty value', () => {
    const ic = receiptText(
      txn('ic:2', '2500000', TS_NEW, {dir: 'out', who: 'Shop', counterparty: 'aaaaa-aa', memo: 'ab12', ledgerRef: '7'}),
      CATALOG, ASSETS,
    );
    expect(ic).toContain('−2.500000 USDC');
    expect(ic).toContain('aaaaa-aa');
    expect(ic).toContain('ab12');
    expect(ic).toContain('7');
    expect(ic).not.toContain(M.receipt.signatureLabel);
    // No label may be emitted with nothing after it — that is the "blank labelled row" this
    // surface exists to avoid, in the text a merchant pastes into a dispute.
    for (const line of ic.split('\n')) expect(line).not.toMatch(/:\s*$/);
  });
});

// ── Device-saved annotations (txNotes) ────────────────────────────────────────────────────────
// The rail carries no name and no human message (the IC memo is the frozen nonce hex), so both can
// only come from the device's own record of the moment it paid. The precedence under test:
// the note beats the row's principal prefix / hex memo, and a note-less row is UNCHANGED.
const NONCE_HEX = '9f2c00112233445566778899aabbccdd';
const FULL_PRINCIPAL = 'nsjm5-jybxu-3hbey-npic6-nbmjf-3ub7i-6zwzc-wibfz-y6dbd-yhqly-xae';
const PRINCIPAL_PREFIX = 'nsjm5-jy';

describe('HistoryRow — the device-saved annotation replaces display text, never ledger truth', () => {
  test('note.who replaces the truncated principal PREFIX in the who line', () => {
    const tree = mountNoted(txn('ic:0', '2500', TS_NEW, {who: PRINCIPAL_PREFIX, memo: NONCE_HEX}), {who: 'Bob'});
    const all = texts(tree);
    expect(all).toContain(M.wallet.ledger.to('Bob'));
    expect(all).not.toContain(M.wallet.ledger.to(PRINCIPAL_PREFIX));
    act(() => { tree.unmount(); });
  });

  test('note.msg replaces the hex nonce as the memo LINE (the hex stays on the receipt)', () => {
    const tree = mountNoted(txn('ic:0', '2500', TS_NEW, {who: PRINCIPAL_PREFIX, memo: NONCE_HEX}), {msg: 'coffee'});
    const all = texts(tree);
    expect(all).toContain('coffee');
    expect(all).not.toContain(NONCE_HEX);
    act(() => { tree.unmount(); });
  });

  test('a note with only a message keeps the row\'s own counterparty line', () => {
    const tree = mountNoted(txn('ic:0', '2500', TS_NEW, {who: PRINCIPAL_PREFIX, memo: NONCE_HEX}), {msg: 'coffee'});
    expect(texts(tree)).toContain(M.wallet.ledger.to(PRINCIPAL_PREFIX));
    act(() => { tree.unmount(); });
  });

  test('without a note the row renders exactly its ledger truth (fallbacks intact)', () => {
    const tree = mount(txn('ic:0', '2500', TS_NEW, {who: PRINCIPAL_PREFIX, memo: NONCE_HEX}));
    const all = texts(tree);
    expect(all).toContain(M.wallet.ledger.to(PRINCIPAL_PREFIX));
    expect(all).toContain(NONCE_HEX); // the reconciliation reference, visible in the log
    act(() => { tree.unmount(); });
  });
});

describe('TxnReceipt — Peer and Note lines are ADDITIVE to the checkable ledger fields', () => {
  const noted = () => txn('ic:0', '2500', TS_NEW, {
    dir: 'out', who: PRINCIPAL_PREFIX, memo: NONCE_HEX, counterparty: FULL_PRINCIPAL, ledgerRef: '81062',
  });

  test('a note renders Peer + Note; the account stays the FULL principal and the reference stays hex', () => {
    const tree = mountReceipt(noted(), {who: 'Bob', msg: 'coffee'});
    const all = texts(tree);
    // Under jest the RN Modal mock renders its subtree more than once, so presence is asserted
    // on the DE-DUPLICATED testID set (the house style: `texts`-contains everywhere else).
    const ids = [...new Set(
      tree.root.findAll(n => typeof n.props?.testID === 'string').map(n => String(n.props.testID)),
    )];
    expect(ids).toContain('txn-receipt-peer');
    expect(ids).toContain('txn-receipt-note');
    // Peer/Note carry the device-saved context under their own anchors.
    expect(all).toContain('Bob');
    expect(all).toContain('coffee');
    // The ledger truth they sit beside is untouched — this is the dispute surface.
    expect(all).toContain(FULL_PRINCIPAL);
    expect(all).toContain(NONCE_HEX);
    expect(all).toContain('81062');
    // An annotated receipt must not claim the ledger said the name — the conditional footer.
    expect(all).toContain(M.receipt.sourceAnnotated);
    expect(all).not.toContain(M.receipt.source);
    act(() => { tree.unmount(); });
  });

  test('without a note there is no Peer line, no Note line, and the plain source footer stands', () => {
    const tree = mountReceipt(noted());
    const ids = [...new Set(
      tree.root.findAll(n => typeof n.props?.testID === 'string').map(n => String(n.props.testID)),
    )];
    expect(ids).not.toContain('txn-receipt-peer');
    expect(ids).not.toContain('txn-receipt-note');
    expect(texts(tree)).toContain(M.receipt.source);
    act(() => { tree.unmount(); });
  });

  test('a name-only note renders Peer but not Note (no label over an absent value)', () => {
    const tree = mountReceipt(noted(), {who: 'Bob'});
    const ids = [...new Set(
      tree.root.findAll(n => typeof n.props?.testID === 'string').map(n => String(n.props.testID)),
    )];
    expect(ids).toContain('txn-receipt-peer');
    expect(ids).not.toContain('txn-receipt-note');
    expect(tree.root.findAllByProps({testID: 'txn-receipt-note'})).toHaveLength(0);
    act(() => { tree.unmount(); });
  });

  test('receiptText carries the same Peer/Note lines — what a merchant pastes matches the sheet', () => {
    const text = receiptText(noted(), CATALOG, ASSETS, {who: 'Bob', msg: 'coffee'});
    expect(text).toContain(`${M.receipt.peer}: Bob`);
    expect(text).toContain(`${M.receipt.note}: coffee`);
    // And the checkable truth is still in the copied text, not just on the screen.
    expect(text).toContain(FULL_PRINCIPAL);
    expect(text).toContain(NONCE_HEX);
    for (const line of text.split('\n')) expect(line).not.toMatch(/:\s*$/);
  });
});
