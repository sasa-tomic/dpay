/**
 * usePollCadence — the rate at which the SOL rail reads a paid endpoint.
 *
 * This is the hook that answers the measured cause of the 2026-09-08 outage: a wallet nobody was
 * touching read 128 times a minute, and a backgrounded phone read exactly as often as one in a
 * user's hand (`docs/specs/2026-09-08-solana-rpc-plan.md`). What is asserted here is therefore not
 * a preference but a budget:
 *   - one read when the poll comes into view, then the ACTIVE cadence for the window;
 *   - the IDLE cadence once the window has passed with nothing happening;
 *   - NOTHING while the app is backgrounded, and an immediate read when it returns;
 *   - `bump()` (a send confirmed, a user asked) reads now and re-opens the active window;
 *   - a new `key` (identity, or the set of things polled) restarts with an immediate read.
 *
 * `react-native` is mocked down to `AppState` so the test can put the app in the background — the
 * one input the hook has that a test cannot otherwise produce. The mock mirrors the real contract
 * exactly: a `currentState` getter and an `addEventListener` returning `{remove}`.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

// The factory is hoisted above every declaration in this file, so the boxes it reads through must
// be named `mock*` — jest's own escape hatch for exactly this.
const mockAppStateRef = {value: undefined as string | undefined};
const mockHandlerRef = {value: null as ((s: string) => void) | null};
jest.mock('react-native', () => ({
  AppState: {
    get currentState() { return mockAppStateRef.value; },
    addEventListener: (type: string, handler: (s: string) => void) => {
      if (type !== 'change') throw new Error(`unexpected AppState event: ${type}`);
      mockHandlerRef.value = handler;
      return {remove: () => { mockHandlerRef.value = null; }};
    },
  },
}));

import {usePollCadence} from '../hooks/usePollCadence';
import {SOL_ACTIVE_POLL_WINDOW_MS} from '../config/constants';

const ACTIVE_MS = 2500;
const IDLE_MS = 30000;

type Api = ReturnType<typeof usePollCadence>;

function Harness({run, enabled, keyValue, apiRef}: {
  run: () => void;
  enabled: boolean;
  keyValue: string;
  apiRef: React.MutableRefObject<Api | null>;
}) {
  apiRef.current = usePollCadence(run, enabled, ACTIVE_MS, IDLE_MS, keyValue);
  return <></>;
}

function render(run: () => void, enabled = true, keyValue = 'k1') {
  const apiRef: React.MutableRefObject<Api | null> = {current: null};
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<Harness run={run} enabled={enabled} keyValue={keyValue} apiRef={apiRef} />);
  });
  return {apiRef, tree};
}

/** Put the app in the background / foreground the way the platform does. */
function setAppState(state: string) {
  mockAppStateRef.value = state;
  act(() => { mockHandlerRef.value?.(state); });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  mockAppStateRef.value = 'active';
  mockHandlerRef.value = null;
});
afterEach(() => {
  jest.useRealTimers();
});

describe('usePollCadence', () => {
  test('reads once on mount, then at the ACTIVE cadence for the money-flow window', () => {
    let calls = 0;
    const {tree} = render(() => { calls++; });
    expect(calls).toBe(1); // coming into view reads immediately

    // Inside the window: one read per ACTIVE interval.
    for (let i = 0; i < 4; i++) act(() => { jest.advanceTimersByTime(ACTIVE_MS); });
    expect(calls).toBe(5);
    act(() => { tree.unmount(); });
  });

  test('falls back to the IDLE cadence once the window passes — the whole point of the change', () => {
    let calls = 0;
    const {tree} = render(() => { calls++; });
    // Run out the active window at the active cadence.
    act(() => { jest.advanceTimersByTime(SOL_ACTIVE_POLL_WINDOW_MS + ACTIVE_MS); });
    const afterWindow = calls;
    // …now an ACTIVE interval buys nothing: the next read is a whole IDLE interval away.
    act(() => { jest.advanceTimersByTime(ACTIVE_MS * 4); });
    expect(calls).toBe(afterWindow);
    act(() => { jest.advanceTimersByTime(IDLE_MS); });
    expect(calls).toBe(afterWindow + 1);
    act(() => { tree.unmount(); });
  });

  test('a backgrounded app reads NOTHING, and reads immediately when it returns', () => {
    let calls = 0;
    const {tree} = render(() => { calls++; });
    act(() => { jest.advanceTimersByTime(SOL_ACTIVE_POLL_WINDOW_MS * 2); });
    const beforeBackground = calls;
    expect(beforeBackground).toBeGreaterThan(1);

    setAppState('background');
    // Ten idle intervals in the background. A phone face-down on a table is the single largest
    // consumer this hook exists to stop.
    act(() => { jest.advanceTimersByTime(IDLE_MS * 10); });
    expect(calls).toBe(beforeBackground);

    setAppState('active');
    expect(calls).toBe(beforeBackground + 1); // returning to the foreground reads NOW
    act(() => { tree.unmount(); });
  });

  test('bump() reads now and re-opens the active window (a send just confirmed)', () => {
    let calls = 0;
    const {apiRef, tree} = render(() => { calls++; });
    act(() => { jest.advanceTimersByTime(SOL_ACTIVE_POLL_WINDOW_MS + IDLE_MS); }); // settle into idle
    const settled = calls;

    act(() => { apiRef.current!(); });
    expect(calls).toBe(settled + 1); // read NOW, not at the next idle tick
    // …and the fast cadence is back for the window.
    act(() => { jest.advanceTimersByTime(ACTIVE_MS); });
    expect(calls).toBe(settled + 2);
    act(() => { tree.unmount(); });
  });

  test('bump() while backgrounded still reads once — a confirmed send is not a cadence question', () => {
    let calls = 0;
    const {apiRef, tree} = render(() => { calls++; });
    setAppState('background');
    const stopped = calls;
    act(() => { apiRef.current!(); });
    expect(calls).toBe(stopped + 1);
    // …but it does not restart the schedule while the app is away.
    act(() => { jest.advanceTimersByTime(IDLE_MS * 4); });
    expect(calls).toBe(stopped + 1);
    act(() => { tree.unmount(); });
  });

  test('disabled polls nothing at all', () => {
    let calls = 0;
    const {tree} = render(() => { calls++; }, false);
    act(() => { jest.advanceTimersByTime(IDLE_MS * 5); });
    expect(calls).toBe(0);
    act(() => { tree.unmount(); });
  });

  test('a new key restarts with an immediate read (a new identity, a new set of rails)', () => {
    let calls = 0;
    const run = () => { calls++; };
    const apiRef: React.MutableRefObject<Api | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Harness run={run} enabled keyValue="k1" apiRef={apiRef} />);
    });
    act(() => { jest.advanceTimersByTime(SOL_ACTIVE_POLL_WINDOW_MS + IDLE_MS); });
    const before = calls;
    act(() => { tree.update(<Harness run={run} enabled keyValue="k2" apiRef={apiRef} />); });
    expect(calls).toBe(before + 1);
    act(() => { tree.unmount(); });
  });

  test('unmounting stops the schedule (no timer outlives the screen)', () => {
    let calls = 0;
    const {tree} = render(() => { calls++; });
    const atUnmount = calls;
    act(() => { tree.unmount(); });
    act(() => { jest.advanceTimersByTime(IDLE_MS * 5); });
    expect(calls).toBe(atUnmount);
  });

  test('a re-render with a NEW run closure does not restart the schedule', () => {
    // The poll is held in a ref on purpose: a caller that rebuilds its closure every render must
    // not reset the cadence (which would poll on every render — the opposite of the fix).
    let calls = 0;
    const apiRef: React.MutableRefObject<Api | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Harness run={() => { calls++; }} enabled keyValue="k1" apiRef={apiRef} />);
    });
    expect(calls).toBe(1);
    for (let i = 0; i < 5; i++) {
      act(() => { tree.update(<Harness run={() => { calls++; }} enabled keyValue="k1" apiRef={apiRef} />); });
    }
    expect(calls).toBe(1);
    act(() => { tree.unmount(); });
  });

  test('an unreported app state keeps polling — never a wallet that silently stopped reading', () => {
    // The RN jest preset reports `undefined`; a platform that reports nothing must not be treated
    // as "backgrounded", because a wallet that stopped reading without saying so is worse than one
    // that reads too often.
    mockAppStateRef.value = undefined;
    let calls = 0;
    const {tree} = render(() => { calls++; });
    expect(calls).toBe(1);
    act(() => { jest.advanceTimersByTime(ACTIVE_MS); });
    expect(calls).toBe(2);
    act(() => { tree.unmount(); });
  });
});
