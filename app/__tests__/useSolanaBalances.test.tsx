/**
 * useSolanaBalances — Phase 2 hook that polls native SOL lamports AND the device's token accounts
 * (per-mint, one independent status each) CONCURRENTLY with generation guards + AbortControllers.
 * The rails are fully decoupled so a confirmed SOL send refreshes SOL only and a confirmed SPL
 * send refreshes only the mint that moved (no conflation). Key behaviors under test:
 *   - SOL and token polls are independent — a SOL stub change doesn't disturb any mint and vice versa.
 *   - Per-mint independence — a USDC poll failure does not flip the EURC status.
 *   - Missing account → that mint's status 'absent' (NOT 'error', NOT zeroed amount).
 *   - RPC failure preserves the prior amount (status 'error', amount kept — NEVER zeroed).
 *   - refreshSol / refreshToken(mint) targeted refresh — each re-polls its own rail only.
 *   - Membership change: a NEW mint seeds 'loading' without flashing existing mints; a REMOVED
 *     mint drops out of the record.
 *   - Offline (empty RPC URL) → 'unavailable' everywhere, NO network call.
 *   - Generation guard: changing identity/address aborts in-flight + drops stale results.
 *
 * The seam (`getSolanaBalance` / `getSolanaTokenBalance`) is mocked so the test exercises HOOK
 * LOGIC only; the seam-level "no network when offline" behavior is proven in solana-seam.test.ts.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

// Mock the seam — the hook imports { getSolanaBalance, getSolanaTokenBalance } from '../solana'.
// Each test configures the mock returns to exercise a specific hook behavior.
jest.mock('../solana', () => ({
  getSolanaBalance: jest.fn(),
  getSolanaTokenBalance: jest.fn(),
}));

import {getSolanaBalance, getSolanaTokenBalance} from '../solana';
import {USDC_MINT_ADDRESS, EURC_MINT_ADDRESS} from '../solana/tokens';
import {POLL} from '../config/constants';
import {useSolanaBalances} from '../hooks/useSolanaBalances';
import {resetSolTokenStateCache} from '../services/solTokenStatePersist';
import AsyncStorage from '@react-native-async-storage/async-storage';

const mockedGetSolanaBalance = getSolanaBalance as jest.MockedFunction<typeof getSolanaBalance>;
const mockedGetSolanaTokenBalance = getSolanaTokenBalance as jest.MockedFunction<typeof getSolanaTokenBalance>;

// POLL.balance is captured by constants.ts at module-load time; the per-file __DPAY_TEST_POLL
// override would be set too late. Tests advance by the live value instead so they're robust to
// the prod default (2500ms) and any test-harness override.

const SECRET_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const SOL_ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const IDLE_TOKEN = {amount: null, decimals: null, status: 'loading'} as const;

type Api = ReturnType<typeof useSolanaBalances>;

// Minimal harness: exposes the hook's state + actions to the test via a stable ref the renderer
// holds across re-renders. Avoids @testing-library/react-hooks (not a project dep) — mirrors the
// useCopyFeedback.test.tsx idiom.
function Harness({
  secretHex, solAddress, mints, apiRef,
}: {
  secretHex: string | null;
  solAddress: string | null;
  mints: string[];
  apiRef: React.MutableRefObject<Api | null>;
}) {
  const api = useSolanaBalances(secretHex, solAddress, mints);
  apiRef.current = api;
  return <></>;
}

function renderHook(secretHex: string | null, solAddress: string | null, mints: string[] = []) {
  const apiRef: React.MutableRefObject<Api | null> = {current: null};
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <Harness secretHex={secretHex} solAddress={solAddress} mints={mints} apiRef={apiRef} />,
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
  beforeEach(async () => {
    jest.useFakeTimers();
    mockedGetSolanaBalance.mockReset();
    mockedGetSolanaTokenBalance.mockReset();
    // The per-mint fact store is module-cached + AsyncStorage-backed — both leak across tests
    // unless reset (a stored fact from an earlier test would seed this test's rows).
    resetSolTokenStateCache();
    await AsyncStorage.clear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('initial state is loading on every rail', () => {
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {})); // never resolves
    mockedGetSolanaTokenBalance.mockReturnValue(new Promise(() => {}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    expect(apiRef.current!.sol).toEqual({balance: null, status: 'loading'});
    expect(apiRef.current!.tokens).toEqual({[USDC_MINT_ADDRESS]: IDLE_TOKEN});
    act(() => { tree.unmount(); });
  });

  test('SOL poll success → sol.status "ok" + balance', async () => {
    mockedGetSolanaBalance.mockResolvedValue('1500000000');
    mockedGetSolanaTokenBalance.mockReturnValue(new Promise(() => {}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.sol).toEqual({balance: '1500000000', status: 'ok'});
    act(() => { tree.unmount(); });
  });

  test('token poll returns balance → per-mint status "balance" with exact amount + decimals', async () => {
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaTokenBalance.mockResolvedValue({kind: 'balance', amount: '1234567', decimals: 6});
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(mockedGetSolanaTokenBalance).toHaveBeenCalledWith(SECRET_HEX, USDC_MINT_ADDRESS, expect.anything());
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: '1234567', decimals: 6, status: 'balance'});
    act(() => { tree.unmount(); });
  });

  test('missing account → that mint is "absent" (NOT "error", NOT zeroed amount)', async () => {
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaTokenBalance.mockResolvedValue({kind: 'absent'});
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: null, decimals: null, status: 'absent'});
    act(() => { tree.unmount(); });
  });

  test('offline → "unavailable" everywhere, no rail activity', async () => {
    // The seam returns null / {kind:'offline'} when SOLANA_RPC_URL is empty (jest.setup.js sets it
    // to ''). The hook translates those into 'unavailable' and MUST NOT touch the network.
    mockedGetSolanaBalance.mockResolvedValue(null);
    mockedGetSolanaTokenBalance.mockResolvedValue({kind: 'offline'});
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.sol).toEqual({balance: null, status: 'unavailable'});
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: null, decimals: null, status: 'unavailable'});
    act(() => { tree.unmount(); });
  });

  test('SOL and token polls are independent — a SOL failure does not flip any mint status', async () => {
    // SOL rejects (RPC error), the mint resolves cleanly. The statuses must stay independent.
    mockedGetSolanaBalance.mockRejectedValue(new Error('sol rpc node degraded'));
    mockedGetSolanaTokenBalance.mockResolvedValue({kind: 'balance', amount: '500', decimals: 6});
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.sol.status).toBe('error');
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: '500', decimals: 6, status: 'balance'});
    act(() => { tree.unmount(); });
  });

  test('per-mint independence — a USDC failure does not flip the EURC status', async () => {
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaTokenBalance.mockImplementation((_secret, mint) =>
      mint === USDC_MINT_ADDRESS ? Promise.reject(new Error('rpc blip')) : Promise.resolve({kind: 'balance', amount: '42', decimals: 6}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS, EURC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS].status).toBe('error');
    expect(apiRef.current!.tokens[EURC_MINT_ADDRESS]).toEqual({amount: '42', decimals: 6, status: 'balance'});
    act(() => { tree.unmount(); });
  });

  test('SOL RPC failure preserves the prior balance (status "error", balance kept — NEVER zeroed)', async () => {
    // First poll: SOL resolves '2000000000'. Second poll: SOL rejects. The balance must persist.
    mockedGetSolanaBalance.mockResolvedValueOnce('2000000000');
    mockedGetSolanaBalance.mockRejectedValueOnce(new Error('transient rpc failure'));
    mockedGetSolanaTokenBalance.mockReturnValue(new Promise(() => {}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); }); // first poll resolves
    expect(apiRef.current!.sol).toEqual({balance: '2000000000', status: 'ok'});
    await act(async () => { jest.advanceTimersByTime(POLL.balance); await flushMicrotasks(); }); // second poll rejects
    expect(apiRef.current!.sol).toEqual({balance: '2000000000', status: 'error'}); // balance PRESERVED
    act(() => { tree.unmount(); });
  });

  test('a degraded poll NEVER downgrades a confirmed fact (status stays "balance", amount kept)', async () => {
    // OPEN_ISSUES 6(a): an existence fact is sticky — only the owner can close an ATA, so an RPC
    // error after a confirmed balance must leave the FACT intact (the sign gate trusts it).
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaTokenBalance.mockResolvedValueOnce({kind: 'balance', amount: '7000000', decimals: 6});
    mockedGetSolanaTokenBalance.mockResolvedValueOnce({kind: 'error'});
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); }); // first poll → balance
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: '7000000', decimals: 6, status: 'balance'});
    await act(async () => { jest.advanceTimersByTime(POLL.balance); await flushMicrotasks(); }); // second poll → error
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: '7000000', decimals: 6, status: 'balance'}); // fact PRESERVED
    act(() => { tree.unmount(); });
  });

  test('a degraded first poll with NO known fact still reports the honest degraded status', async () => {
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaTokenBalance.mockResolvedValue({kind: 'error'});
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS].status).toBe('error');
    act(() => { tree.unmount(); });
  });

  test('refreshSol re-polls SOL without disturbing any mint', async () => {
    let solCalls = 0;
    mockedGetSolanaBalance.mockImplementation(() => Promise.resolve(String(++solCalls * 1000)));
    let tokenCalls = 0;
    mockedGetSolanaTokenBalance.mockImplementation(() => {
      ++tokenCalls;
      return Promise.resolve({kind: 'balance', amount: '99', decimals: 6});
    });
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    const tokenCallsAfterFirst = tokenCalls;
    const tokenStateAfterFirst = apiRef.current!.tokens[USDC_MINT_ADDRESS];

    await act(async () => { apiRef.current!.refreshSol(); await flushMicrotasks(); });
    expect(solCalls).toBeGreaterThanOrEqual(2); // SOL was re-polled
    expect(tokenCalls).toBe(tokenCallsAfterFirst); // the mint was NOT re-polled
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toBe(tokenStateAfterFirst); // mint state untouched
    act(() => { tree.unmount(); });
  });

  test('refreshToken(mint) re-polls ONE mint without disturbing SOL or the sibling mint', async () => {
    let solCalls = 0;
    mockedGetSolanaBalance.mockImplementation(() => Promise.resolve(String(++solCalls * 1000)));
    const calls: Record<string, number> = {[USDC_MINT_ADDRESS]: 0, [EURC_MINT_ADDRESS]: 0};
    mockedGetSolanaTokenBalance.mockImplementation((_secret, mint) => {
      ++calls[mint];
      return Promise.resolve({kind: 'balance', amount: String(calls[mint]), decimals: 6});
    });
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS, EURC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    const solCallsAfterFirst = solCalls;
    const solStateAfterFirst = apiRef.current!.sol;
    const usdcCallsAfterFirst = calls[USDC_MINT_ADDRESS];

    await act(async () => { apiRef.current!.refreshToken(EURC_MINT_ADDRESS); await flushMicrotasks(); });
    expect(calls[EURC_MINT_ADDRESS]).toBeGreaterThanOrEqual(2); // EURC was re-polled
    expect(calls[USDC_MINT_ADDRESS]).toBe(usdcCallsAfterFirst); // USDC NOT re-polled
    expect(solCalls).toBe(solCallsAfterFirst); // SOL NOT re-polled
    expect(apiRef.current!.sol).toBe(solStateAfterFirst); // SOL state untouched
    act(() => { tree.unmount(); });
  });

  test('membership change: a NEW mint seeds loading + a REMOVED mint drops out (no flashes)', async () => {
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaTokenBalance.mockResolvedValue({kind: 'balance', amount: '5', decimals: 6});
    const apiRef: React.MutableRefObject<Api | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Harness secretHex={SECRET_HEX} solAddress={SOL_ADDRESS} mints={[USDC_MINT_ADDRESS]} apiRef={apiRef} />);
    });
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: '5', decimals: 6, status: 'balance'});
    // Grow the membership: EURC seeds 'loading'; USDC must NOT flash back to loading.
    act(() => {
      tree.update(<Harness secretHex={SECRET_HEX} solAddress={SOL_ADDRESS} mints={[USDC_MINT_ADDRESS, EURC_MINT_ADDRESS]} apiRef={apiRef} />);
    });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: '5', decimals: 6, status: 'balance'});
    expect(apiRef.current!.tokens[EURC_MINT_ADDRESS]).toEqual(IDLE_TOKEN);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[EURC_MINT_ADDRESS]).toEqual({amount: '5', decimals: 6, status: 'balance'});
    // Shrink the membership: the dropped mint disappears entirely.
    act(() => {
      tree.update(<Harness secretHex={SECRET_HEX} solAddress={SOL_ADDRESS} mints={[USDC_MINT_ADDRESS]} apiRef={apiRef} />);
    });
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[EURC_MINT_ADDRESS]).toBeUndefined();
    act(() => { tree.unmount(); });
  });

  test('generation guard: changing solAddress drops a stale SOL result', async () => {
    // First address: poll resolves SLOWLY with 'OLD'. Switch address before it resolves; the OLD
    // result MUST NOT land in state.
    let oldResolve!: (v: string) => void;
    const oldPromise = new Promise<string>((r) => { oldResolve = r; });
    mockedGetSolanaBalance.mockReturnValueOnce(oldPromise);
    mockedGetSolanaBalance.mockResolvedValue('NEW');
    mockedGetSolanaTokenBalance.mockReturnValue(new Promise(() => {}));

    const apiRef: React.MutableRefObject<Api | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Harness secretHex={SECRET_HEX} solAddress={'OldAddr'} mints={[USDC_MINT_ADDRESS]} apiRef={apiRef} />);
    });
    // Switch the address before the OLD poll resolves.
    act(() => {
      tree.update(<Harness secretHex={SECRET_HEX} solAddress={'NewAddr'} mints={[USDC_MINT_ADDRESS]} apiRef={apiRef} />);
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
    mockedGetSolanaTokenBalance.mockReturnValue(new Promise(() => {}));
    const {apiRef, tree} = renderHook(SECRET_HEX, null, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(mockedGetSolanaBalance).not.toHaveBeenCalled();
    expect(apiRef.current!.sol).toEqual({balance: null, status: 'loading'});
    act(() => { tree.unmount(); });
  });

  test('null secretHex → no token polling (rail idle)', async () => {
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaTokenBalance.mockResolvedValue({kind: 'balance', amount: '1', decimals: 6});
    const {apiRef, tree} = renderHook(null, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(mockedGetSolanaTokenBalance).not.toHaveBeenCalled();
    expect(apiRef.current!.tokens).toEqual({});
    act(() => { tree.unmount(); });
  });
});

describe('useSolanaBalances — per-mint fact persistence (OPEN_ISSUES 6(a))', () => {
  const STORE_KEY = 'dpay.sol.tokenState.v1';

  beforeEach(async () => {
    jest.useFakeTimers();
    mockedGetSolanaBalance.mockReset();
    mockedGetSolanaTokenBalance.mockReset();
    resetSolTokenStateCache();
    await AsyncStorage.clear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a confirmed balance is persisted (fact write)', async () => {
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaTokenBalance.mockResolvedValue({kind: 'balance', amount: '1234567', decimals: 6});
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS].status).toBe('balance');
    const raw = await AsyncStorage.getItem(STORE_KEY);
    expect(raw).toBeTruthy();
    const store = JSON.parse(raw!) as Record<string, {status: string; amount: string | null; decimals: number | null; at: number}>;
    expect(store[USDC_MINT_ADDRESS]).toEqual({status: 'balance', amount: '1234567', decimals: 6, at: expect.any(Number)});
    act(() => { tree.unmount(); });
  });

  test('a confirmed absence is persisted too (the sign gate trusts exactly this fact)', async () => {
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaTokenBalance.mockResolvedValue({kind: 'absent'});
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS].status).toBe('absent');
    const store = JSON.parse((await AsyncStorage.getItem(STORE_KEY))!) as Record<string, {status: string}>;
    expect(store[USDC_MINT_ADDRESS].status).toBe('absent');
    act(() => { tree.unmount(); });
  });

  test('a degraded poll NEVER writes a fact', async () => {
    const setSpy = jest.spyOn(AsyncStorage, 'setItem');
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaTokenBalance.mockResolvedValueOnce({kind: 'error'});
    mockedGetSolanaTokenBalance.mockResolvedValueOnce({kind: 'offline'});
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS].status).toBe('error');
    await act(async () => { jest.advanceTimersByTime(POLL.balance); await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS].status).toBe('unavailable');
    expect(setSpy).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(STORE_KEY)).toBeNull();
    setSpy.mockRestore();
    act(() => { tree.unmount(); });
  });

  test('an offline restart seeds rows from the persisted store — the gate works offline', async () => {
    // The wallet saw USDC absent in an earlier session; now it is offline from the very first
    // render. The row must seed the persisted FACT (not 'loading'), so the per-request-mint
    // sign gate refuses instead of failing open.
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify({
      [USDC_MINT_ADDRESS]: {status: 'absent', amount: null, decimals: null, at: 1},
    }));
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaTokenBalance.mockReturnValue(new Promise(() => {})); // no poll ever lands
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: null, decimals: null, status: 'absent'});
    act(() => { tree.unmount(); });
  });

  test('a persisted fact survives a degraded first poll that races the storage read', async () => {
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify({
      [USDC_MINT_ADDRESS]: {status: 'balance', amount: '9', decimals: 6, at: 1},
    }));
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaTokenBalance.mockResolvedValue({kind: 'offline'});
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); }); // offline poll + the storage load both land
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: '9', decimals: 6, status: 'balance'});
    act(() => { tree.unmount(); });
  });

  test('mint-list churn: a dropped mint keeps its fact and re-seeds on return', async () => {
    mockedGetSolanaBalance.mockReturnValue(new Promise(() => {}));
    mockedGetSolanaTokenBalance.mockImplementation((_secret, mint) =>
      mint === USDC_MINT_ADDRESS ? Promise.resolve({kind: 'balance', amount: '5', decimals: 6}) : Promise.resolve({kind: 'absent'}));
    const apiRef: React.MutableRefObject<Api | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Harness secretHex={SECRET_HEX} solAddress={SOL_ADDRESS} mints={[USDC_MINT_ADDRESS]} apiRef={apiRef} />);
    });
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: '5', decimals: 6, status: 'balance'});
    // Drop the membership entirely — the record empties but the FACT stays persisted.
    act(() => {
      tree.update(<Harness secretHex={SECRET_HEX} solAddress={SOL_ADDRESS} mints={[]} apiRef={apiRef} />);
    });
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens).toEqual({});
    // Return with the RPC degraded: the effect re-seeds from the store, the poll must not
    // downgrade the fact.
    mockedGetSolanaTokenBalance.mockResolvedValue({kind: 'error'});
    act(() => {
      tree.update(<Harness secretHex={SECRET_HEX} solAddress={SOL_ADDRESS} mints={[USDC_MINT_ADDRESS]} apiRef={apiRef} />);
    });
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: '5', decimals: 6, status: 'balance'});
    act(() => { tree.unmount(); });
  });
});
