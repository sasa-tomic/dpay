/**
 * THE ONE REFRESH pin (founder 2026-10-05: "Refresh Solana balances and transactions same way
 * we do for ICP"). The Check-again affordance on the Pay surfaces is ONE handler backed by ONE
 * hook; pressing it re-polls BOTH rails' balances AND BOTH histories - exactly once each, no
 * rail left behind - and keeps the busy affordance the per-rail rechecks always had: on
 * immediately, self-clears on the short timer, a second press re-arms instead of stacking, and
 * unmount cancels the pending timer.
 *
 * The POST-ACTION WINDOW pin (same founder day: "Solana refresh => should be done also
 * periodically and/or for some time after making payments and after conversions"). `armSolWindow`
 * is the same hook's second half: a BOUNDED re-poll of the SOL seams (balances, tokens, history —
 * balances+tokens are ONE request) for a few minutes after a Solana-rail payment or a
 * Solana-payout conversion, then it stops for good. Pinned here: tick 0 is immediate; the IC and
 * EVM seams are never touched by the window; the window closes exactly at its deadline; a re-arm
 * extends instead of stacking; backgrounded phones read NOTHING (the deadline stands, so a
 * wallet reopened after the window reads nothing extra either); unmount cancels.
 *
 * The seams (the seven refresh functions) are mocked; the hook owns only the composition and
 * the busy flag. Wallet wires its real refresh fns into this hook - the per-rail recheck
 * handlers it used to carry (IC balances only / SOL balances only / EVM balances only) are gone.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

// The window must STOP while the app is backgrounded (the usePollCadence law), so react-native
// is mocked down to AppState exactly like usePollCadence.test.tsx — the one input the hook has
// that a test cannot otherwise produce.
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

import {useRecheckAll, type RecheckSeams} from '../hooks/useRecheckAll';

function makeSeams(): RecheckSeams {
  return {
    refreshIcBalances: jest.fn<() => void>(),
    refreshIcHistory: jest.fn<() => void>(),
    refreshSolBalances: jest.fn<() => void>(),
    refreshSolTokens: jest.fn<() => void>(),
    refreshSolHistory: jest.fn<() => void>(),
    refreshEvmBalances: jest.fn<() => void>(),
    refreshEvmHistory: jest.fn<() => void>(),
  };
}

type Api = ReturnType<typeof useRecheckAll>;

// The useCopyFeedback.test.tsx harness: the hook's state + action exposed via a ref the
// renderer holds across re-renders (no @testing-library/react-hooks in this project).
function Harness({seams, windowOpts, apiRef}: {seams: RecheckSeams; windowOpts?: {intervalMs?: number; windowMs?: number}; apiRef: React.MutableRefObject<Api | null>}) {
  const api = useRecheckAll(seams, windowOpts);
  apiRef.current = api;
  return <></>;
}

async function mount(seams: RecheckSeams, windowOpts?: {intervalMs?: number; windowMs?: number}): Promise<{apiRef: React.MutableRefObject<Api | null>; tree: renderer.ReactTestRenderer}> {
  const apiRef: React.MutableRefObject<Api | null> = {current: null};
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(<Harness seams={seams} windowOpts={windowOpts} apiRef={apiRef} />); });
  return {apiRef, tree};
}

/** Put the app in the background / foreground the way the platform does. */
function setAppState(state: string) {
  mockAppStateRef.value = state;
  act(() => { mockHandlerRef.value?.(state); });
}

describe('the one refresh (founder 2026-10-05): one affordance re-polls every rail, balances AND history', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('one press re-polls IC + Solana balances and both histories, exactly once each', async () => {
    const seams = makeSeams();
    const {apiRef, tree} = await mount(seams);
    expect(apiRef.current!.recheckBusy).toBe(false);

    act(() => { apiRef.current!.recheckAll(); });

    expect(seams.refreshIcBalances).toHaveBeenCalledTimes(1);
    expect(seams.refreshIcHistory).toHaveBeenCalledTimes(1);
    expect(seams.refreshSolBalances).toHaveBeenCalledTimes(1);
    expect(seams.refreshSolTokens).toHaveBeenCalledTimes(1);
    expect(seams.refreshSolHistory).toHaveBeenCalledTimes(1);
    expect(seams.refreshEvmBalances).toHaveBeenCalledTimes(1);
    expect(seams.refreshEvmHistory).toHaveBeenCalledTimes(1);
    expect(apiRef.current!.recheckBusy).toBe(true);

    act(() => { jest.advanceTimersByTime(1500); });
    expect(apiRef.current!.recheckBusy).toBe(false);
    // one press = one re-poll: the timer clears the FLAG, it never re-fires the polls
    expect(seams.refreshIcBalances).toHaveBeenCalledTimes(1);
    expect(seams.refreshSolHistory).toHaveBeenCalledTimes(1);

    act(() => { tree.unmount(); });
  });

  test('a second press re-arms the busy window instead of stacking timers', async () => {
    const seams = makeSeams();
    const {apiRef, tree} = await mount(seams);

    act(() => { apiRef.current!.recheckAll(); });
    act(() => { jest.advanceTimersByTime(1000); });
    act(() => { apiRef.current!.recheckAll(); });

    // 600ms after the second press the FIRST window (1500ms from press 1) has expired - with
    // the stacked-timer bug the flag would have flipped false mid-check.
    act(() => { jest.advanceTimersByTime(600); });
    expect(apiRef.current!.recheckBusy).toBe(true);
    act(() => { jest.advanceTimersByTime(900); });
    expect(apiRef.current!.recheckBusy).toBe(false);
    // two presses = two re-polls, never more
    expect(seams.refreshIcBalances).toHaveBeenCalledTimes(2);
    expect(seams.refreshSolBalances).toHaveBeenCalledTimes(2);

    act(() => { tree.unmount(); });
  });

  test('unmount cancels the pending busy timer (no setState-after-unmount)', async () => {
    const seams = makeSeams();
    const {apiRef, tree} = await mount(seams);
    act(() => { apiRef.current!.recheckAll(); });
    act(() => { tree.unmount(); });
    act(() => { jest.advanceTimersByTime(5000); });
    expect(apiRef.current!.recheckBusy).toBe(true); // stale ref: the timer never fired
  });
});

describe('the post-action window (armSolWindow): a bounded Solana re-poll after a payment or a Solana-payout conversion', () => {
  // Short opts are explicit per-test args — the sibling convention (jest suites that need speed
  // never depend on module state). 100ms interval, 350ms window → ticks at 0,100,200,300.
  const OPTS = {intervalMs: 100, windowMs: 350};

  beforeEach(() => {
    jest.useFakeTimers();
    mockAppStateRef.value = 'active';
    mockHandlerRef.value = null;
  });
  afterEach(() => { jest.useRealTimers(); });

  test('tick 0 is immediate, ticks continue at the cadence, the window closes exactly at its end', async () => {
    const seams = makeSeams();
    const {apiRef, tree} = await mount(seams, OPTS);

    act(() => { apiRef.current!.armSolWindow(); });
    expect(seams.refreshSolBalances).toHaveBeenCalledTimes(1);
    expect(seams.refreshSolTokens).toHaveBeenCalledTimes(1);
    expect(seams.refreshSolHistory).toHaveBeenCalledTimes(1);

    await act(async () => { jest.advanceTimersByTime(100); });
    expect(seams.refreshSolBalances).toHaveBeenCalledTimes(2);
    await act(async () => { jest.advanceTimersByTime(100); });
    expect(seams.refreshSolBalances).toHaveBeenCalledTimes(3);
    await act(async () => { jest.advanceTimersByTime(100); });
    expect(seams.refreshSolBalances).toHaveBeenCalledTimes(4);
    // t=350: the timer fires one last time and finds the window over — no more reads, ever.
    await act(async () => { jest.advanceTimersByTime(2000); });
    expect(seams.refreshSolBalances).toHaveBeenCalledTimes(4);

    act(() => { tree.unmount(); });
  });

  test('the window re-polls ONLY the Solana seams — IC and EVM have their own polls', async () => {
    const seams = makeSeams();
    const {apiRef, tree} = await mount(seams, OPTS);
    act(() => { apiRef.current!.armSolWindow(); });
    await act(async () => { jest.advanceTimersByTime(400); });
    expect(seams.refreshIcBalances).not.toHaveBeenCalled();
    expect(seams.refreshIcHistory).not.toHaveBeenCalled();
    expect(seams.refreshEvmBalances).not.toHaveBeenCalled();
    expect(seams.refreshEvmHistory).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('a re-arm EXTENDS the window and never stacks timers', async () => {
    const seams = makeSeams();
    const {apiRef, tree} = await mount(seams, OPTS);

    act(() => { apiRef.current!.armSolWindow(); }); // tick 0 @0, deadline 350
    await act(async () => { jest.advanceTimersByTime(300); }); // ticks @100,200,300 → 4 calls
    expect(seams.refreshSolBalances).toHaveBeenCalledTimes(4);
    // Re-arm with a tick already pending: the old timer is replaced, never stacked (a stacked
    // implementation would GROW the timer count; the delta stays 0).
    const timersBeforeRearm = jest.getTimerCount();
    act(() => { apiRef.current!.armSolWindow(); }); // immediate re-poll (5) + deadline → 650
    expect(jest.getTimerCount()).toBe(timersBeforeRearm);
    expect(seams.refreshSolBalances).toHaveBeenCalledTimes(5);

    await act(async () => { jest.advanceTimersByTime(400); }); // ticks @400,500,600 → 8
    expect(seams.refreshSolBalances).toHaveBeenCalledTimes(8);
    await act(async () => { jest.advanceTimersByTime(2000); }); // @650 the window closes for good
    expect(seams.refreshSolBalances).toHaveBeenCalledTimes(8);

    act(() => { tree.unmount(); });
  });

  test('backgrounded: no ticks; back in view inside the window: they resume; the expired window never re-fires', async () => {
    const seams = makeSeams();
    const {apiRef, tree} = await mount(seams, {intervalMs: 100, windowMs: 1000});

    act(() => { apiRef.current!.armSolWindow(); }); // tick 0 @0, deadline 1000
    setAppState('background');
    await act(async () => { jest.advanceTimersByTime(500); });
    expect(seams.refreshSolBalances).toHaveBeenCalledTimes(1); // a backgrounded phone reads NOTHING

    setAppState('active');
    await act(async () => { jest.advanceTimersByTime(100); }); // resumed inside the window
    expect(seams.refreshSolBalances).toHaveBeenCalledTimes(2);

    setAppState('background');
    await act(async () => { jest.advanceTimersByTime(3000); }); // the window expires unseen
    setAppState('active');
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(seams.refreshSolBalances).toHaveBeenCalledTimes(2); // bounded means bounded

    act(() => { tree.unmount(); });
  });

  test('unmount cancels the window timer (no reads after the wallet is gone)', async () => {
    const seams = makeSeams();
    const {apiRef, tree} = await mount(seams, {intervalMs: 100, windowMs: 1000});
    act(() => { apiRef.current!.armSolWindow(); });
    act(() => { tree.unmount(); });
    await act(async () => { jest.advanceTimersByTime(5000); });
    expect(seams.refreshSolBalances).toHaveBeenCalledTimes(1); // tick 0 only
  });
});
