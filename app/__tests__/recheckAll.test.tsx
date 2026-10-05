/**
 * THE ONE REFRESH pin (founder 2026-10-05: "Refresh Solana balances and transactions same way
 * we do for ICP"). The Check-again affordance on the Pay surfaces is ONE handler backed by ONE
 * hook; pressing it re-polls BOTH rails' balances AND BOTH histories - exactly once each, no
 * rail left behind - and keeps the busy affordance the per-rail rechecks always had: on
 * immediately, self-clears on the short timer, a second press re-arms instead of stacking, and
 * unmount cancels the pending timer.
 *
 * The seams (the seven refresh functions) are mocked; the hook owns only the composition and
 * the busy flag. Wallet wires its real refresh fns into this hook - the per-rail recheck
 * handlers it used to carry (IC balances only / SOL balances only / EVM balances only) are gone.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

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
function Harness({seams, apiRef}: {seams: RecheckSeams; apiRef: React.MutableRefObject<Api | null>}) {
  const api = useRecheckAll(seams);
  apiRef.current = api;
  return <></>;
}

async function mount(seams: RecheckSeams): Promise<{apiRef: React.MutableRefObject<Api | null>; tree: renderer.ReactTestRenderer}> {
  const apiRef: React.MutableRefObject<Api | null> = {current: null};
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(<Harness seams={seams} apiRef={apiRef} />); });
  return {apiRef, tree};
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
