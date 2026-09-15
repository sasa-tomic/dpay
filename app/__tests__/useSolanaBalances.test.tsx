/**
 * useSolanaBalances — the hook that reads the SOL rail's balances.
 *
 * It polls native SOL lamports AND every visible mint's token balance in ONE request per tick
 * (`readSolanaBalances`, the seam), keeps a separate status per rail, and never turns an
 * unverifiable read into a number. Key behaviors under test:
 *   - ONE request answers every rail — the whole point of the 2026-09-08 demand cut. Two mints do
 *     not cost two requests, and five did not become five again.
 *   - Missing token account → that mint's status 'absent' (NOT 'error', NOT a zeroed amount).
 *   - A failed read preserves the prior amount (status 'error', amount kept — NEVER zeroed) and
 *     records WHY it failed, because "the endpoint refused us" and "nothing answered" are
 *     different things to tell a user.
 *   - A confirmed fact is never downgraded by a later degraded read, and survives a restart.
 *   - Per-mint independence — one mint's unreadable account does not flip its sibling or SOL.
 *   - refreshSol / refreshToken(mint) / refreshTokens each read again NOW.
 *   - Membership change: a NEW mint seeds 'loading' without flashing existing mints; a REMOVED
 *     mint drops out of the record.
 *   - Offline (empty RPC URL) → 'unavailable' everywhere, NO network call.
 *   - Generation guard: changing identity/address aborts in-flight + drops stale results.
 *
 * The seam is mocked so the test exercises HOOK LOGIC only; the seam's own contract (one request,
 * null ⇒ absent, no network when offline) is proven in solana-seam.test.ts against the real codec.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

// Mock the seam — the hook imports { readSolanaBalances } from '../solana'.
jest.mock('../solana', () => ({
  readSolanaBalances: jest.fn(),
}));

import {readSolanaBalances} from '../solana';
import type {SolanaBalancesRead} from '../solana';
import {USDC_MINT_ADDRESS, EURC_MINT_ADDRESS} from '../solana/tokens';
import {POLL} from '../config/constants';
import {useSolanaBalances} from '../hooks/useSolanaBalances';
import {resetSolTokenStateCache} from '../services/solTokenStatePersist';
import AsyncStorage from '@react-native-async-storage/async-storage';

const mockedRead = readSolanaBalances as jest.MockedFunction<typeof readSolanaBalances>;

const SECRET_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const SOL_ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const IDLE_TOKEN = {amount: null, decimals: null, status: 'loading', failure: null} as const;

type Api = ReturnType<typeof useSolanaBalances>;

/** A read result, spelled the way the seam spells it. */
const read = (
  sol: SolanaBalancesRead['sol'],
  tokens: SolanaBalancesRead['tokens'],
): SolanaBalancesRead => ({sol, tokens});
const lamports = (v: string): SolanaBalancesRead['sol'] => ({kind: 'lamports', lamports: v});
const balance = (amount: string, decimals = 6) => ({kind: 'balance', amount, decimals} as const);

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

/** Flush microtasks until the queue settles (the async-poll → setState chain under fake timers can
 *  take a few ticks). act() flushes React updates; this flushes the JS promise chain in between. */
async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('useSolanaBalances', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    mockedRead.mockReset();
    // The per-mint fact store is module-cached + AsyncStorage-backed — both leak across tests
    // unless reset (a stored fact from an earlier test would seed this test's rows).
    resetSolTokenStateCache();
    await AsyncStorage.clear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('initial state is loading on every rail', () => {
    mockedRead.mockReturnValue(new Promise(() => {})); // never resolves
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    expect(apiRef.current!.sol).toEqual({balance: null, status: 'loading', failure: null});
    expect(apiRef.current!.tokens).toEqual({[USDC_MINT_ADDRESS]: IDLE_TOKEN});
    act(() => { tree.unmount(); });
  });

  test('ONE request answers every rail — two mints do not cost two reads', async () => {
    // The measured cause of the outage was five requests per tick (one per rail plus a second per
    // mint). This is the assertion that keeps it at one, and it is expressed PER TICK because that
    // is the unit the cost is incurred in.
    mockedRead.mockResolvedValue(read(lamports('1500000000'), {
      [USDC_MINT_ADDRESS]: balance('1234567'),
      [EURC_MINT_ADDRESS]: balance('42'),
    }));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS, EURC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(mockedRead).toHaveBeenCalledTimes(1);
    expect(mockedRead).toHaveBeenCalledWith(SECRET_HEX, [USDC_MINT_ADDRESS, EURC_MINT_ADDRESS], expect.anything());
    expect(apiRef.current!.sol).toEqual({balance: '1500000000', status: 'ok', failure: null});
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: '1234567', decimals: 6, status: 'balance', failure: null});
    expect(apiRef.current!.tokens[EURC_MINT_ADDRESS]).toEqual({amount: '42', decimals: 6, status: 'balance', failure: null});

    // …and one more tick is one more request, not three.
    await act(async () => { jest.advanceTimersByTime(POLL.balance); await flushMicrotasks(); });
    expect(mockedRead).toHaveBeenCalledTimes(2);
    act(() => { tree.unmount(); });
  });

  test('missing account → that mint is "absent" (NOT "error", NOT zeroed amount)', async () => {
    mockedRead.mockResolvedValue(read(lamports('1'), {[USDC_MINT_ADDRESS]: {kind: 'absent'}}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: null, decimals: null, status: 'absent', failure: null});
    act(() => { tree.unmount(); });
  });

  test('offline → "unavailable" everywhere, no rail activity', async () => {
    // The seam returns 'offline' when solanaRpcUrl() is empty (jest.setup.js sets it to ''). The
    // hook translates that into 'unavailable' — distinct from a failure, because nothing failed.
    mockedRead.mockResolvedValue(read({kind: 'offline'}, {[USDC_MINT_ADDRESS]: {kind: 'offline'}}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.sol).toEqual({balance: null, status: 'unavailable', failure: null});
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: null, decimals: null, status: 'unavailable', failure: null});
    act(() => { tree.unmount(); });
  });

  test('per-mint independence — one unreadable account does not flip its sibling or SOL', async () => {
    mockedRead.mockResolvedValue(read(lamports('900'), {
      [USDC_MINT_ADDRESS]: {kind: 'error', failure: 'unreadable'},
      [EURC_MINT_ADDRESS]: balance('42'),
    }));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS, EURC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.sol).toEqual({balance: '900', status: 'ok', failure: null});
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toMatchObject({status: 'error', failure: 'unreadable'});
    expect(apiRef.current!.tokens[EURC_MINT_ADDRESS]).toEqual({amount: '42', decimals: 6, status: 'balance', failure: null});
    act(() => { tree.unmount(); });
  });

  test('a failed read preserves the prior SOL balance (status "error", balance kept — NEVER zeroed)', async () => {
    mockedRead.mockResolvedValueOnce(read(lamports('2000000000'), {}));
    mockedRead.mockResolvedValueOnce(read({kind: 'error', failure: 'refused'}, {}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, []);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.sol).toEqual({balance: '2000000000', status: 'ok', failure: null});
    await act(async () => { jest.advanceTimersByTime(POLL.balance); await flushMicrotasks(); });
    expect(apiRef.current!.sol).toEqual({balance: '2000000000', status: 'error', failure: 'refused'}); // balance PRESERVED
    act(() => { tree.unmount(); });
  });

  test('WHY a token read failed is carried, so the surface can say which of three things happened', async () => {
    // 'refused' (the endpoint answered and did not serve us — this device is online and the RAIL
    // is down) must be distinguishable from 'unreachable' (nothing answered — the payer may simply
    // be offline, which is their designed state). The sign gate reads exactly this.
    mockedRead.mockResolvedValueOnce(read({kind: 'error', failure: 'refused'}, {[USDC_MINT_ADDRESS]: {kind: 'error', failure: 'refused'}}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: null, decimals: null, status: 'error', failure: 'refused'});

    mockedRead.mockResolvedValue(read({kind: 'error', failure: 'unreachable'}, {[USDC_MINT_ADDRESS]: {kind: 'error', failure: 'unreachable'}}));
    await act(async () => { jest.advanceTimersByTime(POLL.balance); await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toMatchObject({status: 'error', failure: 'unreachable'});
    act(() => { tree.unmount(); });
  });

  test('a degraded poll NEVER downgrades a confirmed fact (status stays "balance", amount kept)', async () => {
    // OPEN_ISSUES 6(a): an existence fact is sticky — only the owner can close a token account, so
    // an error after a confirmed balance must leave the FACT intact (the sign gate trusts it).
    mockedRead.mockResolvedValueOnce(read(lamports('1'), {[USDC_MINT_ADDRESS]: balance('7000000')}));
    mockedRead.mockResolvedValueOnce(read(lamports('1'), {[USDC_MINT_ADDRESS]: {kind: 'error', failure: 'refused'}}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toMatchObject({amount: '7000000', status: 'balance'});
    await act(async () => { jest.advanceTimersByTime(POLL.balance); await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toMatchObject({amount: '7000000', status: 'balance'}); // fact PRESERVED
    act(() => { tree.unmount(); });
  });

  test('a seam that answers for no mint at all is an error, never a balance', async () => {
    // A gap in the result is a wiring defect; rendering it as anything but "we do not know" would
    // be inventing a number.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockedRead.mockResolvedValue(read(lamports('1'), {}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toMatchObject({status: 'error', failure: 'unreadable'});
    expect(String(warn.mock.calls[0]?.[0])).toContain(USDC_MINT_ADDRESS);
    warn.mockRestore();
    act(() => { tree.unmount(); });
  });

  test('refreshSol / refreshToken / refreshTokens each read again NOW', async () => {
    mockedRead.mockResolvedValue(read(lamports('1000'), {[USDC_MINT_ADDRESS]: balance('99')}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(mockedRead).toHaveBeenCalledTimes(1);

    await act(async () => { apiRef.current!.refreshSol(); await flushMicrotasks(); });
    expect(mockedRead).toHaveBeenCalledTimes(2);
    await act(async () => { apiRef.current!.refreshToken(USDC_MINT_ADDRESS); await flushMicrotasks(); });
    expect(mockedRead).toHaveBeenCalledTimes(3);
    await act(async () => { apiRef.current!.refreshTokens(); await flushMicrotasks(); });
    expect(mockedRead).toHaveBeenCalledTimes(4);
    // A refresh reads; it does not blank anything while it is out.
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toMatchObject({amount: '99', status: 'balance'});
    act(() => { tree.unmount(); });
  });

  test('membership change: a NEW mint seeds loading + a REMOVED mint drops out (no flashes)', async () => {
    mockedRead.mockImplementation((_secret: unknown, mints: unknown) => Promise.resolve(read(
      lamports('1'),
      Object.fromEntries((mints as string[]).map(m => [m, balance('5')])),
    )));
    const apiRef: React.MutableRefObject<Api | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Harness secretHex={SECRET_HEX} solAddress={SOL_ADDRESS} mints={[USDC_MINT_ADDRESS]} apiRef={apiRef} />);
    });
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toMatchObject({amount: '5', status: 'balance'});
    // Grow the membership: EURC seeds 'loading'; USDC must NOT flash back to loading.
    act(() => {
      tree.update(<Harness secretHex={SECRET_HEX} solAddress={SOL_ADDRESS} mints={[USDC_MINT_ADDRESS, EURC_MINT_ADDRESS]} apiRef={apiRef} />);
    });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toMatchObject({amount: '5', status: 'balance'});
    expect(apiRef.current!.tokens[EURC_MINT_ADDRESS]).toEqual(IDLE_TOKEN);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[EURC_MINT_ADDRESS]).toMatchObject({amount: '5', status: 'balance'});
    // Shrink the membership: the dropped mint disappears entirely.
    act(() => {
      tree.update(<Harness secretHex={SECRET_HEX} solAddress={SOL_ADDRESS} mints={[USDC_MINT_ADDRESS]} apiRef={apiRef} />);
    });
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[EURC_MINT_ADDRESS]).toBeUndefined();
    act(() => { tree.unmount(); });
  });

  test('generation guard: changing solAddress drops a stale result', async () => {
    // First identity: the read resolves SLOWLY with 'OLD'. Switch before it resolves; the OLD
    // result MUST NOT land in state.
    let oldResolve!: (v: SolanaBalancesRead) => void;
    mockedRead.mockReturnValueOnce(new Promise<SolanaBalancesRead>((r) => { oldResolve = r; }));
    mockedRead.mockResolvedValue(read(lamports('NEW'), {}));

    const apiRef: React.MutableRefObject<Api | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Harness secretHex={SECRET_HEX} solAddress={'OldAddr'} mints={[]} apiRef={apiRef} />);
    });
    act(() => {
      tree.update(<Harness secretHex={SECRET_HEX} solAddress={'NewAddr'} mints={[]} apiRef={apiRef} />);
    });
    await act(async () => {
      oldResolve(read(lamports('OLD'), {}));
      await flushMicrotasks();
    });
    expect(apiRef.current!.sol.balance).not.toBe('OLD');
    act(() => { tree.unmount(); });
  });

  test('null solAddress → no polling at all (rail idle)', async () => {
    mockedRead.mockResolvedValue(read(lamports('123'), {}));
    const {apiRef, tree} = renderHook(SECRET_HEX, null, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(mockedRead).not.toHaveBeenCalled();
    expect(apiRef.current!.sol).toEqual({balance: null, status: 'loading', failure: null});
    act(() => { tree.unmount(); });
  });

  test('null secretHex → no polling at all (rail idle)', async () => {
    mockedRead.mockResolvedValue(read(lamports('1'), {[USDC_MINT_ADDRESS]: balance('1')}));
    const {apiRef, tree} = renderHook(null, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(mockedRead).not.toHaveBeenCalled();
    expect(apiRef.current!.tokens).toEqual({});
    act(() => { tree.unmount(); });
  });

  // H4 — request rate must never RISE with latency. Measured 2026-09-08 against a 6s-latency
  // endpoint: the poll fired 8 times in 20s with up to 3 generations concurrently, because the
  // interval fired regardless of what was still outstanding. Under a rate limiter that is the
  // amplifier that keeps the limit open.
  test('a SLOW endpoint does not stack polls — a tick while one is in flight is skipped, not queued', async () => {
    let resolveIt!: (v: SolanaBalancesRead) => void;
    mockedRead.mockReturnValueOnce(new Promise<SolanaBalancesRead>((r) => { resolveIt = r; }));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(mockedRead).toHaveBeenCalledTimes(1);
    // Tick by tick, flushing between: each interval really does fire and really is skipped
    // (advancing four intervals in one go would prove nothing — the callbacks would run in one
    // synchronous burst, before any read could have resolved).
    for (let i = 0; i < 4; i++) await act(async () => { jest.advanceTimersByTime(POLL.balance); await flushMicrotasks(); });
    expect(mockedRead).toHaveBeenCalledTimes(1); // four ticks passed, still ONE request
    // …and the guard DEFERS, it never disables: once the read answers, the next tick polls again.
    mockedRead.mockResolvedValue(read(lamports('7'), {[USDC_MINT_ADDRESS]: balance('1')}));
    await act(async () => { resolveIt(read(lamports('7'), {[USDC_MINT_ADDRESS]: balance('1')})); await flushMicrotasks(); });
    expect(apiRef.current!.sol).toEqual({balance: '7', status: 'ok', failure: null});
    await act(async () => { jest.advanceTimersByTime(POLL.balance); await flushMicrotasks(); });
    expect(mockedRead).toHaveBeenCalledTimes(2);
    act(() => { tree.unmount(); });
  });
});

describe('useSolanaBalances — per-mint fact persistence (OPEN_ISSUES 6(a))', () => {
  const STORE_KEY = 'dpay.sol.tokenState.v1';

  beforeEach(async () => {
    jest.useFakeTimers();
    mockedRead.mockReset();
    resetSolTokenStateCache();
    await AsyncStorage.clear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a confirmed balance is persisted (fact write)', async () => {
    mockedRead.mockResolvedValue(read(lamports('1'), {[USDC_MINT_ADDRESS]: balance('1234567')}));
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
    mockedRead.mockResolvedValue(read(lamports('1'), {[USDC_MINT_ADDRESS]: {kind: 'absent'}}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS].status).toBe('absent');
    const store = JSON.parse((await AsyncStorage.getItem(STORE_KEY))!) as Record<string, {status: string}>;
    expect(store[USDC_MINT_ADDRESS].status).toBe('absent');
    act(() => { tree.unmount(); });
  });

  test('a degraded poll NEVER writes a fact (the confirmed SOL half still caches)', async () => {
    const setSpy = jest.spyOn(AsyncStorage, 'setItem');
    mockedRead.mockResolvedValueOnce(read(lamports('1'), {[USDC_MINT_ADDRESS]: {kind: 'error', failure: 'refused'}}));
    mockedRead.mockResolvedValueOnce(read(lamports('1'), {[USDC_MINT_ADDRESS]: {kind: 'offline'}}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS].status).toBe('error');
    await act(async () => { jest.advanceTimersByTime(POLL.balance); await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS].status).toBe('unavailable');
    // A degraded token read observes NOTHING: no write may touch the per-mint FACT store (the sign
    // gate's safety). Scoped by key since 2026-09-15 — the rails are independent, and the
    // native-SOL half of these same reads CONFIRMED lamports, which the cross-restart cache
    // (dpay.solbalance.v1, founder requirement #3) legitimately persists below.
    const factWrites = setSpy.mock.calls.filter(([k]) => k === STORE_KEY);
    expect(factWrites).toEqual([]);
    expect(await AsyncStorage.getItem(STORE_KEY)).toBeNull();
    // The intended new behavior, pinned positively: two polls, two confirmed lamports reads, two
    // SOL-cache writes — one degraded mint must not blank the SOL rail's own cache.
    const solWrites = setSpy.mock.calls.filter(([k]) => k.startsWith('dpay.solbalance.v1.'));
    expect(solWrites).toHaveLength(2);
    for (const v of solWrites.map(([, v]) => v)) {
      expect(JSON.parse(v)).toEqual({at: expect.any(Number), balance: '1'});
    }
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
    mockedRead.mockReturnValue(new Promise(() => {})); // no poll ever lands
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: null, decimals: null, status: 'absent', failure: null});
    act(() => { tree.unmount(); });
  });

  test('a persisted fact survives a degraded first poll that races the storage read', async () => {
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify({
      [USDC_MINT_ADDRESS]: {status: 'balance', amount: '9', decimals: 6, at: 1},
    }));
    mockedRead.mockResolvedValue(read(lamports('1'), {[USDC_MINT_ADDRESS]: {kind: 'offline'}}));
    const {apiRef, tree} = renderHook(SECRET_HEX, SOL_ADDRESS, [USDC_MINT_ADDRESS]);
    await act(async () => { await flushMicrotasks(); }); // the poll + the storage load both land
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toEqual({amount: '9', decimals: 6, status: 'balance', failure: null});
    act(() => { tree.unmount(); });
  });

  test('mint-list churn: a dropped mint keeps its fact and re-seeds on return', async () => {
    mockedRead.mockImplementation((_secret: unknown, mints: unknown) => Promise.resolve(read(
      lamports('1'),
      Object.fromEntries((mints as string[]).map(m => [m, balance('5')])),
    )));
    const apiRef: React.MutableRefObject<Api | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Harness secretHex={SECRET_HEX} solAddress={SOL_ADDRESS} mints={[USDC_MINT_ADDRESS]} apiRef={apiRef} />);
    });
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toMatchObject({amount: '5', status: 'balance'});
    // Drop the membership entirely — the record empties but the FACT stays persisted.
    act(() => {
      tree.update(<Harness secretHex={SECRET_HEX} solAddress={SOL_ADDRESS} mints={[]} apiRef={apiRef} />);
    });
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens).toEqual({});
    // Return with the endpoint refusing: the effect re-seeds from the store, and the failed read
    // must not downgrade the fact.
    mockedRead.mockImplementation((_secret: unknown, mints: unknown) => Promise.resolve(read(
      {kind: 'error', failure: 'refused'},
      Object.fromEntries((mints as string[]).map(m => [m, {kind: 'error', failure: 'refused'} as const])),
    )));
    act(() => {
      tree.update(<Harness secretHex={SECRET_HEX} solAddress={SOL_ADDRESS} mints={[USDC_MINT_ADDRESS]} apiRef={apiRef} />);
    });
    await act(async () => { await flushMicrotasks(); });
    expect(apiRef.current!.tokens[USDC_MINT_ADDRESS]).toMatchObject({amount: '5', status: 'balance'});
    act(() => { tree.unmount(); });
  });
});
