/**
 * useNfcTapState — session-lifecycle regression tests.
 *
 * The 2026-08-13 fcd2afd regression: NfcTap/SolNfcTap pass their adapter callbacks as INLINE
 * arrows (fresh identity every render), and the hook's subscribe→arm→cleanup effect originally
 * listed them in its deps. Every mid-tap re-render (each phase event calls setPhase) re-ran the
 * effect → cleanup called disarmCard/stopReader MID-TAP → disableReaderMode killed the RF field →
 * TagLostException ("Phones moved apart — try again") → re-arm → re-detect loop: many tap sounds,
 * zero completed payments. Invisible to e2e (RNW event shim), jest (hook never mounted), and
 * `just ondevice` (drives Kotlin directly).
 *
 * These tests mount the hook through a harness that recreates the adapter object inline on every
 * render — exactly how NfcTap.tsx/SolNfcTap.tsx build it — and prove the native session survives
 * re-renders: arm/start exactly once, stop/disarm exactly once at unmount, one subscription, and
 * the ALWAYS-LATEST callbacks are invoked through the ref.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

// The hook imports ONLY {NativeEventEmitter} from react-native, and the harness renders no RN
// components — so a minimal module mock suffices. (jest.requireActual('react-native') inside the
// factory eagerly evaluates the full RN index, which throws on the DevMenu turbo module here.)
jest.mock('react-native', () => {
  class FakeNativeEventEmitter {
    static instances: FakeNativeEventEmitter[] = [];
    listeners: Array<(e: unknown) => void> = [];
    constructor(public module: unknown) {
      FakeNativeEventEmitter.instances.push(this);
    }
    addListener(_eventName: string, handler: (e: unknown) => void) {
      this.listeners.push(handler);
      return {remove: () => {}};
    }
  }
  return {NativeEventEmitter: FakeNativeEventEmitter};
});

import {NativeEventEmitter} from 'react-native';
import {useNfcTapState, type NfcTapAdapter} from '../hooks/useNfcTapState';

type Ev = {kind: string};

function emitters() {
  return (NativeEventEmitter as unknown as {instances: {listeners: Array<(e: unknown) => void>}[]})
    .instances;
}

/** Emit to the (single, current) subscription — the seam a native phase/request event drives. */
function emit(e: unknown) {
  const last = emitters()[emitters().length - 1];
  if (!last) throw new Error('no emitter subscribed');
  act(() => {
    for (const l of last.listeners) l(e);
  });
}

/**
 * Mirrors NfcTap.tsx/SolNfcTap.tsx: the adapter is rebuilt INLINE on every render, so every
 * callback has a fresh identity per render — the pattern that caused the mid-tap teardown.
 */
type TestAdapter = ReturnType<typeof makeAdapter>;

function Harness(props: {
  role: 'card' | 'reader';
  readerPayload?: string;
  tick: number; // prop churn → re-render → fresh inline adapter identities
  adapter: TestAdapter;
}) {
  const {role, readerPayload, adapter, tick} = props;
  const state = useNfcTapState<Ev>({
    role,
    readerPayload,
    onActive: adapter.onActive,
    eventName: adapter.eventName,
    nativeModule: adapter.nativeModule,
    armCard: () => adapter.armCard(),
    disarmCard: () => adapter.disarmCard(),
    startReader: p => adapter.startReader(p),
    stopReader: () => adapter.stopReader(),
    onSettling: () => adapter.onSettling(),
    onRequest: (e, ctx) => adapter.onRequest(e, ctx),
    onSubmit: (e, ctx) => adapter.onSubmit(e, ctx),
    onReceipt: (e, ctx) => adapter.onReceipt(e, ctx),
  });
  void tick; // read so the prop drives re-renders without a typecheck complaint
  void state.phase; // the harness re-renders when the hook's phase state changes
  return null;
}

function makeAdapter(nativeModule?: {addListener: jest.Mock; removeListeners: jest.Mock}) {
  const arm = () => jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const handler = <T extends (...args: never[]) => void>() => jest.fn<T>();
  return {
    eventName: 'DpayNfcEvent',
    nativeModule: nativeModule ?? {addListener: jest.fn(), removeListeners: jest.fn()},
    armCard: arm(),
    disarmCard: arm(),
    startReader: jest.fn<(p: string) => Promise<void>>().mockResolvedValue(undefined),
    stopReader: arm(),
    onActive: handler<() => void>(),
    onSettling: handler<() => void>(),
    onRequest: handler<(e: Ev, ctx: unknown) => void>(),
    onSubmit: handler<(e: Ev, ctx: unknown) => void>(),
    onReceipt: handler<(e: Ev, ctx: unknown) => void>(),
  } satisfies Omit<NfcTapAdapter<Ev>, 'onActive'> & {onActive: (e: Ev) => void};
}

let adapter: ReturnType<typeof makeAdapter>;

function mount(role: 'card' | 'reader', readerPayload?: string) {
  const build = (tick: number) => (
    <Harness role={role} readerPayload={readerPayload} tick={tick} adapter={adapter} />
  );
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(build(0));
  });
  return {tree, rerender: (tick: number) => act(() => tree.update(build(tick)))};
}

beforeEach(() => {
  adapter = makeAdapter();
  emitters().length = 0;
});

describe('useNfcTapState — session survives re-renders (fcd2afd regression)', () => {
  test('reader: startReader fires exactly once across prop re-renders AND mid-tap phase events; stopReader only at unmount', () => {
    const {tree, rerender} = mount('reader', 'aabb');
    expect(adapter.startReader).toHaveBeenCalledTimes(1);
    expect(adapter.startReader).toHaveBeenCalledWith('aabb');
    expect(adapter.stopReader).not.toHaveBeenCalled();

    // A mid-tap phase event re-renders the harness (setPhase) — the exact live-bug trigger.
    emit({role: 'reader', type: 'phase', phase: 'linking'});
    emit({role: 'reader', type: 'phase', phase: 'exchanging'});
    rerender(1);
    emit({role: 'reader', type: 'phase', phase: 'settling'});
    rerender(2);

    expect(adapter.startReader).toHaveBeenCalledTimes(1); // still exactly one session
    expect(adapter.stopReader).not.toHaveBeenCalled(); // never torn down mid-tap
    expect(emitters()).toHaveLength(1); // one subscription, not one per render

    act(() => {
      tree.unmount();
    });
    expect(adapter.stopReader).toHaveBeenCalledTimes(1);
    expect(adapter.startReader).toHaveBeenCalledTimes(1); // no re-arm after unmount
  });

  test('card: armCard fires exactly once; disarmCard only at unmount', () => {
    const {tree} = mount('card');
    expect(adapter.armCard).toHaveBeenCalledTimes(1);
    emit({role: 'card', type: 'phase', phase: 'linking'});
    emit({role: 'card', type: 'phase', phase: 'exchanging'});
    emit({role: 'card', type: 'phase', phase: 'settling'});
    expect(adapter.armCard).toHaveBeenCalledTimes(1);
    expect(adapter.disarmCard).not.toHaveBeenCalled();
    expect(adapter.onSettling).toHaveBeenCalledTimes(1);

    act(() => {
      tree.unmount();
    });
    expect(adapter.disarmCard).toHaveBeenCalledTimes(1);
    expect(adapter.armCard).toHaveBeenCalledTimes(1);
  });

  test('protocol events reach the LATEST adapter callbacks (ref freshness, not first-render freeze)', () => {
    const {tree} = mount('card');
    emit({role: 'card', type: 'request', wire: 'deadbeef'});
    expect(adapter.onRequest).toHaveBeenCalledTimes(1);
    expect(adapter.onRequest.mock.calls[0][0]).toEqual({role: 'card', type: 'request', wire: 'deadbeef'});

    // Swap in fresh CALLBACKS (identity change mid-session, like a parent state change) while the
    // session seams (eventName, nativeModule) stay identical — subsequent events must hit the new
    // callbacks without disturbing the armed session.
    const before = adapter;
    adapter = makeAdapter(before.nativeModule);
    act(() => {
      tree.update(<Harness role="card" tick={1} adapter={adapter} />);
    });
    emit({role: 'card', type: 'phase', phase: 'exchanging'});
    emit({role: 'card', type: 'done', wire: 'cafebabe'});
    expect(before.onRequest).toHaveBeenCalledTimes(1); // not the stale one
    expect(adapter.onSubmit).toHaveBeenCalledTimes(1);
    expect(adapter.armCard).not.toHaveBeenCalled(); // no re-arm — the session carried over
    act(() => {
      tree.unmount();
    });
    expect(adapter.disarmCard).toHaveBeenCalledTimes(1); // teardown uses the LATEST adapter too
  });

  test('events for the other role are ignored', () => {
    const {tree} = mount('reader', 'aabb');
    emit({role: 'card', type: 'phase', phase: 'exchanging'});
    expect(adapter.onRequest).not.toHaveBeenCalled();
    expect(adapter.onSubmit).not.toHaveBeenCalled();
    act(() => {
      tree.unmount();
    });
  });
});
