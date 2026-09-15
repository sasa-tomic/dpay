/**
 * usePendingPays — the read half of the offline-payment outbox. The hook's whole contract is
 * announce-driven freshness: hydrate on identity, re-read whenever any seam writes or reconciles,
 * and NEVER surface a failure (an unreadable store is an empty one — useTxNotes' rule — so a broken
 * cache cannot take the balances or the history down with it). Wallet's deduction, its pending rows
 * and the persisted store may disagree for one storage round-trip and no longer.
 *
 * AsyncStorage is the jest mock from jest.setup.js; mutations go through the SERVICE functions
 * exactly as the seams call them (the hook exposes no mutate method by design).
 */
import {describe, test, expect, beforeEach, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {usePendingPays} from '../hooks/usePendingPays';
import {addPendingPays, pendingPaysKey, removePendingPays, type PendingPay} from '../services/pendingPays';

const ID = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

function rec(k: string, ts = 1_000): PendingPay {
  return {k, assetId: 'ic:0', currency: 0, wireAmount: '2500', fee: '10', gross: '2510', who: 'Café Sunrise', ts, kind: 'ic-qr'};
}

/** Mount the hook and return a live handle on its latest value. */
function mountHook(publicHex: string): {latest: () => PendingPay[]; tree: renderer.ReactTestRenderer} {
  let latest: PendingPay[] = [];
  function Probe() {
    latest = usePendingPays(publicHex);
    return <Text>{''}</Text>;
  }
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(<Probe />); });
  return {latest: () => latest, tree};
}

/** Flush the async storage round-trip (the load, then the announce re-read). */
async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => {});
}

beforeEach(() => AsyncStorage.clear());

describe('usePendingPays — hydrate, announce, reconcile', () => {
  test('hydrates from the persisted store on mount (the restart case, founder requirement 3)', async () => {
    await addPendingPays(ID, [rec('aabbcc')]);
    const {latest, tree} = mountHook(ID);
    await flush();
    expect(latest()).toHaveLength(1);
    expect(latest()[0].k).toBe('aabbcc');
    act(() => { tree.unmount(); });
  });

  test('a seam\'s WRITE re-reads through the announce — the balance deduction follows with no prop threading', async () => {
    const {latest, tree} = mountHook(ID);
    await flush();
    expect(latest()).toEqual([]);

    await act(async () => { await addPendingPays(ID, [rec('deadbeef')]); });
    await flush();
    expect(latest()).toHaveLength(1);

    // The RECONCILIATION write (history showed the settled row) re-reads the same way.
    await act(async () => { await removePendingPays(ID, ['deadbeef']); });
    await flush();
    expect(latest()).toEqual([]);
    act(() => { tree.unmount(); });
  });

  test('another identity\'s write does not re-read this one (per-wallet isolation)', async () => {
    await addPendingPays(ID, [rec('mine')]);
    const {latest, tree} = mountHook(ID);
    await flush();
    expect(latest()).toHaveLength(1);

    await act(async () => { await addPendingPays(OTHER, [rec('theirs')]); });
    await flush();
    expect(latest()).toHaveLength(1); // still exactly my record
    expect(pendingPaysKey(OTHER)).not.toBe(pendingPaysKey(ID));
    act(() => { tree.unmount(); });
  });

  test('an identity SWITCH loads the new wallet\'s records (the alive guard discards the stale read)', async () => {
    await addPendingPays(ID, [rec('mine')]);
    await addPendingPays(OTHER, [rec('theirs', 2_000)]);

    let publicHex = ID;
    let latest: PendingPay[] = [];
    function Probe() {
      latest = usePendingPays(publicHex);
      return <Text>{''}</Text>;
    }
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<Probe />); });
    await flush();
    expect(latest.map(r => r.k)).toEqual(['mine']);

    act(() => { publicHex = OTHER; tree.update(<Probe />); });
    await flush();
    expect(latest.map(r => r.k)).toEqual(['theirs']);
    act(() => { tree.unmount(); });
  });

  test('a corrupt store degrades to an empty list — the hook has no failure state', async () => {
    await AsyncStorage.setItem(pendingPaysKey(ID), '{{{not json');
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const {latest, tree} = mountHook(ID);
    await flush();
    expect(latest()).toEqual([]);
    spy.mockRestore();
    act(() => { tree.unmount(); });
  });
});
