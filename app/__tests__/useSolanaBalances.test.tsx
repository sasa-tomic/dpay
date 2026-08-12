/**
 * useSolanaBalances — Phase 2 hook that polls native SOL lamports AND the device's USDC ATA balance
 * CONCURRENTLY with INDEPENDENT statuses + generation guards + AbortControllers. The two rails are
 * fully decoupled so a confirmed SOL send refreshes SOL only and a confirmed SPL send refreshes USDC
 * only (no conflation). Key behaviors under test (mirrors the plan's Phase 2 invariants):
 *   - SOL and USDC poll independently — a SOL-only stub change doesn't disturb USDC status and vice versa.
 *   - Missing ATA → usdc.status 'absent' (NOT 'error', NOT zeroed balance).
 *   - RPC failure preserves the prior amount (status 'error', amount kept — NEVER zeroed).
 *   - refreshSol / refreshUsdc targeted refresh — each re-polls its own rail without disturbing the other.
 *   - Offline (empty RPC URL) → sol.status 'unavailable', usdc.status 'unavailable', NO network call.
 *   - Generation guard: changing identity/address aborts in-flight + drops stale results.
 *
 * The seam (`getSolanaBalance` / `getSolanaUsdcBalance`) is mocked so the test exercises HOOK LOGIC
 * only; the seam-level "no network when offline" behavior is proven in solana-seam.test.ts.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

// Mock the seam — the hook imports { getSolanaBalance, getSolanaUsdcBalance } from '../solana'.
// Each test configures the mock returns to exercise a specific hook behavior.
jest.mock('../solana', () => ({
  getSolanaBalance: jest.fn(),
  getSolanaUsdcBalance: jest.fn(),
}));

import {getSolanaBalance, getSolanaUsdcBalance} from '../solana';
import {POLL} from '../config/constants';
import {useSolanaBalances} from '../hooks/useSolanaBalances';

const mockedGetSolanaBalance = getSolanaBalance as jest.MockedFunction<typeof getSolanaBalance>;
const mockedGetSolanaUsdcBalance = getSolanaUsdcBalance as jest.MockedFunction<typeof getSolanaUsdcBalance>;

// POLL.balance is captured by constants.ts at module-load time; the per-file __DPAY_TEST_POLL
// override would be set too late. Tests advance by the live value instead so they're robust to
// the prod default (2500ms) and any test-harness override.

const SECRET_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const SOL_ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

type Api = ReturnType<typeof useSolanaBalances>;

// Minimal harness: exposes the hook's state + actions to the test via a stable ref the renderer
// holds across re-renders. Avoids @testing-library/react-hooks (not a project dep) — mirrors the
// useCopyFeedback.test.tsx idiom.
function Harness({
  secretHex, solAddress, apiRef,
}: {
  secretHex: string | null;
  solAddress: string | null;
  apiRef: React.MutableRefObject<Api | null>;
}) {
  const api = useSolanaBalances(secretHex, solAddress);
  apiRef.current = api;
  return <></>;
}

function renderHook(secretHex: string | null, solAddress: string | null) {
  const apiRef: React.MutableRefObject<Api | null> = {current: null};
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <Harness secretHex={secretHex} solAddress={solAddress} apiRef={apiRef} />,
    );
  });
  return {apiRef, tree};
}

// Flush microtasks until the queue settles (the async-poll → setState chain under fake timers can
// take a few ticks). act() flushes React updates; this flushes the JS promise chain in between.
async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('useSolanaBalances', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedGetSolanaBalance.mockReset();
    mockedGetSolanaUsdcBalance.mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('initial state is loading on both rails', () => {
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {})); // never resolves
    mockedGetSolanaUsdcBalance.mockReturnValue(new Promise(() => {}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS);
    expect(apiRef.current!.sol).toEqual({balance: null, status: 'loading'});
    expect(apiRef.current!.usdc).toEqual({amount: null, decimals: null, status: 'loading'});
    act(() => { tree.unmount(); });
  });

  test('SOL poll success → sol.status "ok" + balance', async () => {
    mockedGetSolanaBalance.mockResolvedValue('1500000000');
    mockedGetSolanaUsdcBalance.mockReturnValue(new Promise(() => {}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.sol).toEqual({balance: '1500000000', status: 'ok'});
    act(() => { tree.unmount(); });
  });

  test('USDC poll returns balance → usdc.status "balance" with exact amount + decimals', async () => {
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaUsdcBalance.mockResolvedValue({kind: 'balance', amount: '1234567', decimals: 6});
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.usdc).toEqual({amount: '1234567', decimals: 6, status: 'balance'});
    act(() => { tree.unmount(); });
  });

  test('missing ATA → usdc.status "absent" (NOT "error", NOT zeroed balance)', async () => {
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaUsdcBalance.mockResolvedValue({kind: 'absent'});
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.usdc).toEqual({amount: null, decimals: null, status: 'absent'});
    act(() => { tree.unmount(); });
  });

  test('offline → sol.status "unavailable", usdc.status "unavailable", no rail activity', async () => {
    // The seam returns null / {kind:'offline'} when SOLANA_RPC_URL is empty (jest.setup.js sets it
    // to ''). The hook translates those into 'unavailable' and MUST NOT touch the network.
    mockedGetSolanaBalance.mockResolvedValue(null);
    mockedGetSolanaUsdcBalance.mockResolvedValue({kind: 'offline'});
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.sol).toEqual({balance: null, status: 'unavailable'});
    expect(apiRef.current!.usdc).toEqual({amount: null, decimals: null, status: 'unavailable'});
    act(() => { tree.unmount(); });
  });

  test('SOL and USDC poll independently — a SOL failure does not flip the USDC status', async () => {
    // SOL rejects (RPC error), USDC resolves cleanly. The two statuses must stay independent.
    mockedGetSolanaBalance.mockRejectedValue(new Error('sol rpc node degraded'));
    mockedGetSolanaUsdcBalance.mockResolvedValue({kind: 'balance', amount: '500', decimals: 6});
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.sol.status).toBe('error');
    expect(apiRef.current!.usdc).toEqual({amount: '500', decimals: 6, status: 'balance'});
    act(() => { tree.unmount(); });
  });

  test('SOL RPC failure preserves the prior balance (status "error", balance kept — NEVER zeroed)', async () => {
    // First poll: SOL resolves '2000000000'. Second poll: SOL rejects. The balance must persist.
    mockedGetSolanaBalance.mockResolvedValueOnce('2000000000');
    mockedGetSolanaBalance.mockRejectedValueOnce(new Error('transient rpc failure'));
    mockedGetSolanaUsdcBalance.mockReturnValue(new Promise(() => {}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS);
    await act(async () => { await flushMicrotasks(); }); // first poll resolves
    expect(apiRef.current!.sol).toEqual({balance: '2000000000', status: 'ok'});
    await act(async () => { jest.advanceTimersByTime(POLL.balance); await flushMicrotasks(); }); // second poll rejects
    expect(apiRef.current!.sol).toEqual({balance: '2000000000', status: 'error'}); // balance PRESERVED
    act(() => { tree.unmount(); });
  });

  test('USDC RPC failure preserves the prior amount (status "error", amount kept — NEVER zeroed)', async () => {
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaUsdcBalance.mockResolvedValueOnce({kind: 'balance', amount: '7000000', decimals: 6});
    mockedGetSolanaUsdcBalance.mockResolvedValueOnce({kind: 'error'});
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS);
    await act(async () => { await flushMicrotasks(); }); // first poll → balance
    expect(apiRef.current!.usdc).toEqual({amount: '7000000', decimals: 6, status: 'balance'});
    await act(async () => { jest.advanceTimersByTime(POLL.balance); await flushMicrotasks(); }); // second poll → error
    expect(apiRef.current!.usdc).toEqual({amount: '7000000', decimals: 6, status: 'error'}); // amount PRESERVED
    act(() => { tree.unmount(); });
  });

  test('refreshSol re-polls SOL without disturbing USDC', async () => {
    let solCalls = 0;
    mockedGetSolanaBalance.mockImplementation(() => Promise.resolve(String(++solCalls * 1000)));
    let usdcCalls = 0;
    mockedGetSolanaUsdcBalance.mockImplementation(() => {
      ++usdcCalls;
      return Promise.resolve({kind: 'balance', amount: '99', decimals: 6});
    });
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS);
    await act(async () => { await flushMicrotasks(); });
    const usdcCallsAfterFirst = usdcCalls;
    const usdcStateAfterFirst = apiRef.current!.usdc;

    await act(async () => { apiRef.current!.refreshSol(); await flushMicrotasks(); });
    expect(solCalls).toBeGreaterThanOrEqual(2); // SOL was re-polled
    expect(usdcCalls).toBe(usdcCallsAfterFirst); // USDC NOT re-polled
    expect(apiRef.current!.usdc).toBe(usdcStateAfterFirst); // USDC state untouched
    act(() => { tree.unmount(); });
  });

  test('refreshUsdc re-polls USDC without disturbing SOL', async () => {
    let solCalls = 0;
    mockedGetSolanaBalance.mockImplementation(() => Promise.resolve(String(++solCalls * 1000)));
    let usdcCalls = 0;
    mockedGetSolanaUsdcBalance.mockImplementation(() => {
      ++usdcCalls;
      return Promise.resolve({kind: 'balance', amount: String(usdcCalls), decimals: 6});
    });
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS);
    await act(async () => { await flushMicrotasks(); });
    const solCallsAfterFirst = solCalls;
    const solStateAfterFirst = apiRef.current!.sol;

    await act(async () => { apiRef.current!.refreshUsdc(); await flushMicrotasks(); });
    expect(usdcCalls).toBeGreaterThanOrEqual(2); // USDC was re-polled
    expect(solCalls).toBe(solCallsAfterFirst); // SOL NOT re-polled
    expect(apiRef.current!.sol).toBe(solStateAfterFirst); // SOL state untouched
    act(() => { tree.unmount(); });
  });

  test('generation guard: changing solAddress drops a stale SOL result', async () => {
    // First address: poll resolves SLOWLY with 'OLD'. Switch address before it resolves; the OLD
    // result MUST NOT land in state.
    let oldResolve!: (v: string) => void;
    const oldPromise = new Promise<string>((r) => { oldResolve = r; });
    mockedGetSolanaBalance.mockReturnValueOnce(oldPromise);
    mockedGetSolanaBalance.mockResolvedValue('NEW');
    mockedGetSolanaUsdcBalance.mockReturnValue(new Promise(() => {}));

    const apiRef: React.MutableRefObject<Api | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Harness secretHex={SECRET_HEX} solAddress={'OldAddr'} apiRef={apiRef} />);
    });
    // Switch the address before the OLD poll resolves.
    act(() => {
      tree.update(<Harness secretHex={SECRET_HEX} solAddress={'NewAddr'} apiRef={apiRef} />);
    });
    // Now resolve the OLD poll — it must NOT update state (generation guard drops it).
    await act(async () => {
      oldResolve('OLD');
      await flushMicrotasks();
    });
    expect(apiRef.current!.sol.balance).not.toBe('OLD');
    act(() => { tree.unmount(); });
  });

  test('null solAddress → no SOL polling (rail idle)', async () => {
    mockedGetSolanaBalance.mockResolvedValue('123');
    mockedGetSolanaUsdcBalance.mockReturnValue(new Promise(() => {}));
    const {apiRef, tree} = renderHook(SECRET_HEX, null);
    await act(async () => { await flushMicrotasks(); });
    expect(mockedGetSolanaBalance).not.toHaveBeenCalled();
    expect(apiRef.current!.sol).toEqual({balance: null, status: 'loading'});
    act(() => { tree.unmount(); });
  });

  test('null secretHex → no USDC polling (rail idle)', async () => {
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaUsdcBalance.mockResolvedValue({kind: 'balance', amount: '1', decimals: 6});
    const {apiRef, tree} = renderHook(null, SOL_ADDRESS);
    await act(async () => { await flushMicrotasks(); });
    expect(mockedGetSolanaUsdcBalance).not.toHaveBeenCalled();
    expect(apiRef.current!.usdc).toEqual({amount: null, decimals: null, status: 'loading'});
    act(() => { tree.unmount(); });
  });
});
