/**
 * useEvmHistory — the EVM rail's half of the Transactions list, focused on the ONE behavior the
 * seam suite (`evm-history.test.ts`, the reader) cannot see: the `lastSuccessAt` staleness clock.
 * The clock moves ONLY on a fully clean read (every leg answered); one persistently failing leg
 * keeps it old, because its rows keep aging. The merged-list staleness note (Ledger's
 * `tx-stale-note`) is driven from the OLDEST rail's clock — founder 2026-10-16: an age statement,
 * never a failure verdict.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

jest.mock('../evm', () => ({
  getEvmHistory: jest.fn(),
}));

import {getEvmHistory} from '../evm';
import type {EvmHistoryResult} from '../evm';
import {useEvmHistory} from '../hooks/useEvmHistory';
import {POLL} from '../config/constants';

const mockedGetEvmHistory = getEvmHistory as jest.MockedFunction<typeof getEvmHistory>;

const ADDRESS = '0x9a7E7AE9e4125A6a04a4b76899fA7E9e4125A6a0';
const KEYS = [
  {chainId: 1, token: 'ZCHF', tokenAddress: '0x1111111111111111111111111111111111111111', decimals: 6},
  {chainId: 42161, token: 'USDC', tokenAddress: '0x2222222222222222222222222222222222222222', decimals: 6},
] as const;

/** One leg's clean answer: a single transfer row (shape only needs rows/dropped). */
function okLeg(): Extract<EvmHistoryResult, {kind: 'history'}> {
  return {
    kind: 'history',
    rows: [{
      txHash: '0x' + 'a'.repeat(64),
      blockNumber: 100,
      dir: 'out' as const,
      amount: '1000000',
      counterparty: '0x' + 'b'.repeat(40),
      ts: 1_756_000_000,
    }],
    dropped: 0,
  };
}

function errLeg(): Extract<EvmHistoryResult, {kind: 'error'}> {
  return {kind: 'error', failure: 'refused' as const};
}

/** Exposes the hook's live return value to the test across re-renders. */
function Harness({address, apiRef}: {address: string | null; apiRef: React.MutableRefObject<ReturnType<typeof useEvmHistory> | null>}) {
  apiRef.current = useEvmHistory(address, KEYS);
  return <></>;
}

async function mount(address: string | null = ADDRESS) {
  const apiRef: React.MutableRefObject<ReturnType<typeof useEvmHistory> | null> = {current: null};
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(<Harness address={address} apiRef={apiRef} />); });
  return {apiRef, tree, rows: () => apiRef.current!.history};
}

let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  jest.useFakeTimers();
  mockedGetEvmHistory.mockReset();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  jest.useRealTimers();
});

describe('useEvmHistory — lastSuccessAt moves only on a fully clean read', () => {
  test('a full success stamps the clock; a failing leg keeps it old; a clean read refreshes it', async () => {
    // Both legs fail: no clock, rows empty.
    mockedGetEvmHistory.mockResolvedValue(errLeg());
    const failing = await mount();
    expect(failing.apiRef.current!.lastSuccessAt).toBe(null);
    expect(failing.rows()).toEqual([]);
    act(() => { failing.tree.unmount(); });

    // Both legs clean: clock stamped.
    mockedGetEvmHistory.mockResolvedValue(okLeg());
    const ok = await mount();
    const first = ok.apiRef.current!.lastSuccessAt;
    expect(first).toBeGreaterThan(0);

    // ONE failing leg: rows for the healthy leg refresh, the clock does NOT move (the failing
    // leg's rows keep aging — the list's age must age with them).
    await act(async () => { jest.advanceTimersByTime(5_000); });
    mockedGetEvmHistory.mockImplementation(async (chainId: number) => (chainId === 42161 ? errLeg() : okLeg()));
    await act(async () => { await ok.apiRef.current!.refreshHistory(); });
    expect(ok.apiRef.current!.lastSuccessAt).toBe(first);
    expect(ok.rows().length).toBeGreaterThan(0); // the healthy leg's rows still landed

    // Back to full clean: the clock moves.
    mockedGetEvmHistory.mockResolvedValue(okLeg());
    await act(async () => { await ok.apiRef.current!.refreshHistory(); });
    expect(ok.apiRef.current!.lastSuccessAt).toBe(first! + 5_000);
    act(() => { ok.tree.unmount(); });
  });

  test('a whole-poll throw and a rail-off mount never stamp the clock; switching off nulls it', async () => {
    mockedGetEvmHistory.mockRejectedValue(new Error('fetch failed'));
    const thrown = await mount();
    expect(thrown.apiRef.current!.lastSuccessAt).toBe(null);
    expect(warn).toHaveBeenCalled();
    act(() => { thrown.tree.unmount(); });

    mockedGetEvmHistory.mockResolvedValue(okLeg());
    const ok = await mount();
    expect(ok.apiRef.current!.lastSuccessAt).toBeGreaterThan(0);
    await act(async () => { ok.tree.update(<Harness address={null} apiRef={ok.apiRef} />); });
    expect(ok.apiRef.current!.lastSuccessAt).toBe(null);
    act(() => { ok.tree.unmount(); });
  });

  test('the empty-key (rail off) mount polls nothing and stays null', async () => {
    const off = await mount(null);
    expect(mockedGetEvmHistory).not.toHaveBeenCalled();
    expect(off.apiRef.current!.lastSuccessAt).toBe(null);
    act(() => { off.tree.unmount(); });
  });

  test('sanity: the cadence still polls at POLL.history around a money flow', async () => {
    mockedGetEvmHistory.mockResolvedValue(okLeg());
    const {tree} = await mount();
    expect(mockedGetEvmHistory).toHaveBeenCalledTimes(KEYS.length);
    await act(async () => { jest.advanceTimersByTime(POLL.history); });
    expect(mockedGetEvmHistory).toHaveBeenCalledTimes(2 * KEYS.length);
    act(() => { tree.unmount(); });
  });
});
