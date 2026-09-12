/**
 * useTxNotes — the hook that feeds HistoryRow's device-saved annotations.
 *
 * The service under it (services/txNotes) has its own suite; what is pinned HERE is the hook's
 * three behavioural edges, because the hook is what a live Wallet renders through:
 *   1. the initial load lands (an identity's saved notes are in the map after mount),
 *   2. a saveTxNote for THIS identity re-reads the store (a payment made seconds after boot
 *      annotates its rows the moment the history poll surfaces them) — and a save for a
 *      DIFFERENT identity re-reads nothing,
 *   3. a read that was in flight when the identity changed is DISCARDED (the `alive` guard):
 *      wallet A's notes must never render against wallet B's rows.
 *
 * `loadTxNotes` alone is mocked (deferred control for the race); everything else in the module —
 * the save path, the change notification, the index — is the REAL code under test.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('../services/txNotes', () => {
  const actual = jest.requireActual('../services/txNotes') as typeof import('../services/txNotes');
  return {...actual, loadTxNotes: jest.fn()};
});

import {loadTxNotes, saveTxNote, type TxNote} from '../services/txNotes';
import {useTxNotes} from '../hooks/useTxNotes';

const mockedLoad = loadTxNotes as jest.MockedFunction<typeof loadTxNotes>;
const actualLoad = (jest.requireActual('../services/txNotes') as typeof import('../services/txNotes')).loadTxNotes;

const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const T0 = 1_760_000_000_000;

const NONCE = '9f2c00112233445566778899aabbccdd'; // an IC request nonce = on-chain memo hex
const SIG = '5Nq1FakeSig11111111111111111111111111111111111111111111111111111111'; // a SOL signature

/** Exposes the hook's live return value to the test across re-renders. */
function Harness({publicHex, notesRef}: {publicHex: string; notesRef: React.MutableRefObject<ReadonlyMap<string, TxNote> | null>}) {
  notesRef.current = useTxNotes(publicHex);
  return <></>;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return {promise, resolve};
}

beforeEach(async () => {
  await AsyncStorage.clear();
  // Default: delegate to the real reader so the hook sees persisted truth.
  mockedLoad.mockReset().mockImplementation(id => actualLoad(id));
});

describe('useTxNotes — mount, notification, and the identity-change race', () => {
  test('mount loads the identity\'s saved notes into the map (initial load)', async () => {
    await saveTxNote(ALICE, {k: NONCE, who: 'Bob', msg: 'coffee'}, T0);
    const notesRef: React.MutableRefObject<ReadonlyMap<string, TxNote> | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness publicHex={ALICE} notesRef={notesRef} />); });
    expect(notesRef.current!.get(NONCE)).toEqual({k: NONCE, who: 'Bob', msg: 'coffee', at: T0});
    act(() => { tree.unmount(); });
  });

  test('a save for THIS identity re-reads; a save for another identity re-reads nothing', async () => {
    const notesRef: React.MutableRefObject<ReadonlyMap<string, TxNote> | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness publicHex={ALICE} notesRef={notesRef} />); });
    expect(notesRef.current!.size).toBe(0);
    const readsAfterMount = mockedLoad.mock.calls.length;

    // A payment on BOB's wallet changes BOB's store — ALICE's hook must not so much as re-read.
    await act(async () => { await saveTxNote(BOB, {k: SIG, msg: 'order 42'}, T0); });
    expect(mockedLoad.mock.calls.length).toBe(readsAfterMount);
    expect(notesRef.current!.size).toBe(0);

    // The same save on ALICE's wallet announces ALICE → the hook re-reads and the new note lands
    // (this is the "row annotates itself the moment the payment is made" path).
    await act(async () => { await saveTxNote(ALICE, {k: SIG, who: 'Coffee Bar', msg: 'order 42'}, T0 + 1); });
    expect(mockedLoad.mock.calls.length).toBe(readsAfterMount + 1);
    expect(notesRef.current!.get(SIG.toLowerCase())).toEqual({k: SIG.toLowerCase(), who: 'Coffee Bar', msg: 'order 42', at: T0 + 1});
    act(() => { tree.unmount(); });
  });

  test('a read still in flight when the identity changes is DISCARDED (no cross-wallet bleed)', async () => {
    await saveTxNote(ALICE, {k: NONCE, who: 'Bob'}, T0);
    await saveTxNote(BOB, {k: SIG, msg: 'order 42'}, T0 + 1);

    // ALICE's read parks on a promise this test resolves manually.
    const alice = deferred<TxNote[]>();
    mockedLoad.mockImplementation(id => (id === ALICE ? alice.promise : actualLoad(id)));

    const notesRef: React.MutableRefObject<ReadonlyMap<string, TxNote> | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness publicHex={ALICE} notesRef={notesRef} />); });

    // Identity switches to BOB mid-flight: the cleanup flips `alive`, BOB's own read resolves.
    await act(async () => { tree.update(<Harness publicHex={BOB} notesRef={notesRef} />); });
    expect(notesRef.current!.get(SIG.toLowerCase())?.msg).toBe('order 42');

    // ALICE's read resolves LATE. The guard must bin it — the map still holds BOB's wallet only.
    await act(async () => { alice.resolve([{k: NONCE, who: 'Bob', at: T0}]); });
    expect(notesRef.current!.get(NONCE)).toBeUndefined();
    expect(notesRef.current!.get(SIG.toLowerCase())?.msg).toBe('order 42');
    act(() => { tree.unmount(); });
  });
});
