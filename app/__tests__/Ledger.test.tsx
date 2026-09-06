/**
 * The Transactions surface, now carrying BOTH rails: the IC ledger and the native Solana
 * device-key rail. Two things had to become rail-agnostic for that, and both are pinned here:
 *
 *   • `lib/ledger.ts#mergeHistoryByTime` — the ONE ordering rule over `Txn.ts` (raw seconds), with
 *     a timeless Solana row (no `blockTime`) sorted last rather than given an invented position.
 *   • `components/Ledger.tsx` — amounts formatted in each row's OWN units (an IC row through the
 *     catalog, a Solana row through its SelectableAsset's decimals + symbol) and one filter chip
 *     per PRESENT asset, keyed on `AssetId` so `solana:SOL` and `ic:0` cannot collide.
 *
 * Real builders throughout (`icpCatalogOf` / `buildSelectableAssets` over the bundled networks) —
 * a hand-written catalog fixture would pin this test to a shape the app no longer ships.
 */
import {describe, test, expect} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {Ledger} from '../components/Ledger';
import {mergeHistoryByTime} from '../lib/ledger';
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

/** The DISTINCT testIDs in the tree (a Pressable renders several nested nodes carrying its own). */
function testIDs(tree: renderer.ReactTestRenderer): string[] {
  return [...new Set(tree.root.findAll(n => typeof n.props?.testID === 'string').map(n => String(n.props.testID)))];
}

function mount(history: Txn[], dropped = 0): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(<Ledger history={history} catalog={CATALOG} assets={ASSETS} dropped={dropped} />); });
  return tree;
}

describe('mergeHistoryByTime', () => {
  test('interleaves the two rails newest-first by ts, not by which rail they came from', () => {
    const ic = [txn('ic:0', '2500', TS_NEW), txn('ic:0', '100', TS_OLD)];
    const sol = [txn('solana:SOL', '1000000000', TS_NEW - 100)];
    expect(mergeHistoryByTime(ic, sol).map(t => t.ts)).toEqual([TS_NEW, TS_NEW - 100, TS_OLD]);
  });

  test('a timeless row (NaN ts) sorts AFTER every timed row instead of claiming to be newest', () => {
    const sol = [txn('solana:SOL', '1', Number.NaN), txn('solana:SOL', '2', TS_OLD)];
    const merged = mergeHistoryByTime([txn('ic:0', '3', TS_NEW)], sol);
    expect(merged.map(t => t.amount)).toEqual(['3', '2', '1']);
  });

  test('rows sharing a timestamp keep their incoming order (stable), IC before SOL', () => {
    const merged = mergeHistoryByTime([txn('ic:0', 'ic', TS_NEW)], [txn('solana:SOL', 'sol', TS_NEW)]);
    expect(merged.map(t => t.amount)).toEqual(['ic', 'sol']);
  });

  test('several timeless rows keep their rail order rather than shuffling', () => {
    const sol = [txn('solana:SOL', 'first', Number.NaN), txn('solana:SOL', 'second', Number.NaN)];
    expect(mergeHistoryByTime([], sol).map(t => t.amount)).toEqual(['first', 'second']);
  });
});

describe('Ledger — a mixed IC + Solana list', () => {
  const MIXED = mergeHistoryByTime(
    [txn('ic:0', '2500', TS_NEW)],                             // DEMO: 2500 cents
    [txn('solana:SOL', '1000000000', TS_OLD, {dir: 'in'})],    // 1 SOL in lamports
  );

  test('formats each amount in its OWN units, compactly — DEMO in ∂, SOL trimmed', () => {
    const tree = mount(MIXED);
    const all = texts(tree);
    expect(all).toContain('−∂25.00');
    expect(all).toContain('+1 SOL');
    act(() => { tree.unmount(); });
  });

  test('renders one filter chip per present asset, across both rails', () => {
    const tree = mount(MIXED);
    const ids = testIDs(tree);
    // IC chips keep the CATALOG test key (DEMO's descriptor symbol is '$'); the Solana chip uses
    // the SelectableAsset's own literal key. Both are what the e2e selectors are written against.
    expect(ids).toContain('ledger-filter-all');
    expect(ids).toContain('ledger-filter-$');
    expect(ids).toContain('ledger-filter-sol');
    // Only assets actually PRESENT in history get a chip — the catalog is much longer than this.
    expect(ids.filter(id => id.startsWith('ledger-filter-'))).toHaveLength(3);
    expect(texts(tree)).toContain('SOL');
    act(() => { tree.unmount(); });
  });

  test('a chip filters to that asset alone, leaving the other rail out', () => {
    const tree = mount(MIXED);
    const chip = tree.root.findAll(n => n.props?.testID === 'ledger-filter-sol' && typeof n.props.onPress === 'function')[0];
    act(() => { chip.props.onPress(); });
    const all = texts(tree);
    expect(all).toContain('+1 SOL');
    expect(all).not.toContain('−∂25.00');
    act(() => { tree.unmount(); });
  });

  test('a single-asset list renders no filter row at all', () => {
    const tree = mount([txn('solana:SOL', '1000000000', TS_NEW)]);
    expect(testIDs(tree).filter(id => id.startsWith('ledger-filter-'))).toEqual([]);
    act(() => { tree.unmount(); });
  });

  test('a Solana USDC row formats to USDC\'s 2-decimal floor, distinctly from the IC USDC chip', () => {
    const tree = mount(mergeHistoryByTime(
      [txn('ic:2', '2500000', TS_NEW)],
      [txn('solana:USDC', '2500000', TS_OLD)],
    ));
    const all = texts(tree);
    expect(all.filter(t => t === '−2.50 USDC')).toHaveLength(2);    // same amount, same unit…
    const ids = testIDs(tree);
    expect(ids).toContain('ledger-filter-ckusdc');                  // …but two distinct chips,
    expect(ids).toContain('ledger-filter-sol-usdc');
    expect(all).toContain('USDC·Eth');                              // …labelled by their chain
    expect(all).toContain('USDC·Sol');
    act(() => { tree.unmount(); });
  });

  test('a row whose asset is not visible fails closed to the Unsupported sentinel and gets no chip', () => {
    // The state a hidden testnet asset passes through for one poll cycle: the row still exists but
    // its asset is not in the visible list. Rendering a bare number in an unknown unit would be a
    // wrong amount; the sentinel is the honest answer.
    const tree = mount(mergeHistoryByTime(
      [txn('ic:0', '2500', TS_NEW), txn('ic:9999', '50000', TS_OLD)],
      [],
    ));
    // Unsigned: the sentinel is not a number, so it never takes a direction sign ("−Unsupported"
    // was the old concatenate-outside artefact).
    expect(texts(tree)).toContain(M.wallet.asset.unsupported);
    expect(texts(tree)).not.toContain(`−${M.wallet.asset.unsupported}`);
    expect(testIDs(tree)).not.toContain('ledger-filter-asset');
    act(() => { tree.unmount(); });
  });

  test('a failed Solana row shows its status line next to the counterparty', () => {
    const tree = mount([txn('solana:SOL', '5000', TS_NEW, {who: '', memo: M.wallet.ledger.failed})]);
    const all = texts(tree);
    expect(all).toContain(M.wallet.ledger.failed);
    expect(all).toContain(M.wallet.ledger.to('—')); // no determinable counterparty
    act(() => { tree.unmount(); });
  });

  test('an empty list renders the empty state, not an empty filter row', () => {
    const tree = mount([]);
    expect(texts(tree)).toContain(M.wallet.ledger.empty);
    expect(testIDs(tree)).toEqual(['ledger-view']);
    act(() => { tree.unmount(); });
  });
});

describe('Ledger — the dropped-transactions honesty note', () => {
  // OPEN_ISSUES 'SolanaHistory.dropped is logged, not surfaced': the reader counts transactions it
  // cannot parse; the note says plainly that they exist on-chain but are not shown. A note, never
  // an error — everything the list does show is still true.
  test('dropped > 0 renders the note naming the count, in the populated-list branch', () => {
    const tree = mount([txn('solana:SOL', '1000000000', TS_NEW)], 2);
    expect(testIDs(tree)).toContain('ledger-dropped-note');
    expect(texts(tree)).toContain(M.wallet.ledger.dropped(2));
    act(() => { tree.unmount(); });
  });

  test('dropped > 0 renders the note in the EMPTY branch too — an all-dropped poll is not "no payments"', () => {
    const tree = mount([], 3);
    expect(testIDs(tree)).toContain('ledger-dropped-note');
    expect(texts(tree)).toContain(M.wallet.ledger.dropped(3));
    act(() => { tree.unmount(); });
  });

  test('dropped = 0 (the default) renders nothing — the note is purely conditional', () => {
    const tree = mount([txn('solana:SOL', '1', TS_NEW)]);
    expect(testIDs(tree)).not.toContain('ledger-dropped-note');
    act(() => { tree.unmount(); });
    const empty = mount([]);
    expect(testIDs(empty)).not.toContain('ledger-dropped-note');
    act(() => { empty.unmount(); });
  });

  test('count 1 uses the singular sentence — the note is honest about ONE missing transaction', () => {
    const tree = mount([txn('solana:SOL', '1', TS_NEW)], 1);
    expect(texts(tree)).toContain(M.wallet.ledger.dropped(1));
    expect(texts(tree)).not.toContain(M.wallet.ledger.dropped(2));
    act(() => { tree.unmount(); });
  });
});
