/**
 * useSolanaHistory — the SOL rail's half of the Transactions list.
 *
 * The unit under test is the MAPPING from a `SolanaHistoryRow` (what the chain did) to a `Txn`
 * (what the user reads) plus the hook's poll/best-effort lifecycle. The reader that produces those
 * rows has its own suite (`solana-history.test.ts`); the seam is mocked here so nothing overlaps.
 *
 * What the mapping must never do is the point of most of these: invent a timestamp for a block the
 * node has no time for, name a counterparty it could not determine, or let a FAILED transaction —
 * which is charged the fee and transfers nothing — read as a small successful payment.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

jest.mock('../solana', () => ({
  getSolanaHistory: jest.fn(),
}));
jest.mock('../transportFailure', () => ({
  classifyTransportFailure: jest.fn(async () => 'unreachable' as const),
}));

import {getSolanaHistory} from '../solana';
import {classifyTransportFailure} from '../transportFailure';
import type {SolanaHistoryResult, SolanaHistoryRow} from '../solana';
import {useSolanaHistory} from '../hooks/useSolanaHistory';
import {POLL, SOL_ACTIVE_POLL_WINDOW_MS} from '../config/constants';
import {M} from '../i18n';
import {errorsEn} from '../i18n/domains/en/errors';
import {errorsDe} from '../i18n/domains/de/errors';
import {errorsEs} from '../i18n/domains/es/errors';
import {errorsFr} from '../i18n/domains/fr/errors';
import type {Txn} from '../lib/types';

const mockedGetSolanaHistory = getSolanaHistory as jest.MockedFunction<typeof getSolanaHistory>;
const mockedClassify = classifyTransportFailure as jest.MockedFunction<typeof classifyTransportFailure>;

const ADDRESS = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const PEER = 'Cy5PMxYMFTs4NoSxyUtp54G2HPbmvJr8qZnxnWUqiLT9';
const BLOCK_TIME = 1_756_000_000;

/** A readable, on-chain-successful outgoing SOL movement — the shape each test perturbs. */
function row(overrides: Partial<SolanaHistoryRow> = {}): SolanaHistoryRow {
  return {
    signature: 'Sig1111111111111111111111111111111111111111',
    slot: 250_000_000,
    blockTime: BLOCK_TIME,
    token: 'SOL',
    direction: 'out',
    amount: '1000000000',
    feeLamports: '5000',
    counterparty: PEER,
    ok: true,
    ...overrides,
  };
}

function history(rows: SolanaHistoryRow[], dropped = 0): SolanaHistoryResult {
  return {kind: 'history', rows, dropped};
}

/** Exposes the hook's live return value to the test across re-renders. */
function Harness({address, apiRef}: {address: string | null; apiRef: React.MutableRefObject<ReturnType<typeof useSolanaHistory> | null>}) {
  apiRef.current = useSolanaHistory(address);
  return <></>;
}

/** Mount the hook and flush its mount fetch; returns the ref + the tree (unmount it when done). */
async function mount(address: string | null = ADDRESS) {
  const apiRef: React.MutableRefObject<ReturnType<typeof useSolanaHistory> | null> = {current: null};
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(<Harness address={address} apiRef={apiRef} />); });
  return {apiRef, tree, rows: () => apiRef.current!.history};
}

let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  jest.useFakeTimers();
  mockedGetSolanaHistory.mockReset();
  mockedClassify.mockReset();
  mockedClassify.mockResolvedValue('unreachable');
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  jest.useRealTimers();
});

describe('useSolanaHistory — row mapping', () => {
  test('maps an incoming USDC row to solana:USDC with its direction, raw amount and short counterparty', async () => {
    mockedGetSolanaHistory.mockResolvedValue(history([
      row({token: 'USDC', direction: 'in', amount: '2500000', counterparty: PEER}),
    ]));
    const {rows, tree} = await mount();
    expect(rows()).toHaveLength(1);
    const t: Txn = rows()[0];
    expect(t.assetId).toBe('solana:USDC');
    expect(t.dir).toBe('in');
    expect(t.amount).toBe('2500000');           // raw units, verbatim — never a number
    expect(t.who).toBe(`${PEER.slice(0, 8)}…`); // the shortened counterparty, not the full address
    expect(t.nonce).toBe(row().signature);      // the signature is the row's unique id
    expect(t.memo).toBe('');                    // a successful transfer carries no status line
    expect(t.ts).toBe(BLOCK_TIME);
    expect(t.time).not.toBe('—');               // a known time renders as a time
    act(() => { tree.unmount(); });
  });

  test('maps an outgoing native row to solana:SOL', async () => {
    mockedGetSolanaHistory.mockResolvedValue(history([row({token: 'SOL', direction: 'out'})]));
    const {rows, tree} = await mount();
    expect(rows()[0].assetId).toBe('solana:SOL');
    expect(rows()[0].dir).toBe('out');
    act(() => { tree.unmount(); });
  });

  test('a null blockTime stays TIMELESS: ts is NaN and the time renders "—" (no invented timestamp)', async () => {
    mockedGetSolanaHistory.mockResolvedValue(history([row({blockTime: null})]));
    const {rows, tree} = await mount();
    const t = rows()[0];
    expect(Number.isFinite(t.ts)).toBe(false);
    expect(t.time).toBe('—');
    // The rest of the row is intact — a missing time hides the time, not the money.
    expect(t.amount).toBe('1000000000');
    expect(t.dir).toBe('out');
    act(() => { tree.unmount(); });
  });

  test('a FAILED row is labelled as failed, so a fee-only debit cannot read as a payment', async () => {
    mockedGetSolanaHistory.mockResolvedValue(history([
      row({ok: false, amount: '5000', counterparty: null}),
    ]));
    const {rows, tree} = await mount();
    expect(rows()[0].memo).toBe(M.wallet.ledger.failed);
    expect(rows()[0].amount).toBe('5000'); // the fee really left the wallet — still shown
    act(() => { tree.unmount(); });
  });

  test('an undeterminable counterparty maps to an EMPTY who (never a plausible-looking address)', async () => {
    mockedGetSolanaHistory.mockResolvedValue(history([row({counterparty: null})]));
    const {rows, tree} = await mount();
    expect(rows()[0].who).toBe('');
    act(() => { tree.unmount(); });
  });

  // X6 — the receipt's two fields. `who` is a truncated LABEL and proves nothing; the receipt needs
  // the full address and the rail's own id for the row, and an undeterminable counterparty must
  // stay empty here too rather than be filled with the truncation.
  test('carries the FULL counterparty and the signature for the receipt, and empties the unknown one', async () => {
    mockedGetSolanaHistory.mockResolvedValue(history([row({counterparty: PEER})]));
    const full = await mount();
    expect(full.rows()[0].counterparty).toBe(PEER);
    expect(full.rows()[0].ledgerRef).toBe(row().signature);
    act(() => { full.tree.unmount(); });

    mockedGetSolanaHistory.mockResolvedValue(history([row({counterparty: null})]));
    const unknown = await mount();
    expect(unknown.rows()[0].counterparty).toBe('');
    act(() => { unknown.tree.unmount(); });
  });

  test('a transaction producing two rows (USDC transfer + its SOL rent) keeps both, per token', async () => {
    mockedGetSolanaHistory.mockResolvedValue(history([
      row({token: 'USDC', direction: 'out', amount: '2500000'}),
      row({token: 'SOL', direction: 'out', amount: '2039280'}),
    ]));
    const {rows, tree} = await mount();
    expect(rows().map(t => t.assetId)).toEqual(['solana:USDC', 'solana:SOL']);
    act(() => { tree.unmount(); });
  });
});

describe('useSolanaHistory — lifecycle and failure handling', () => {
  test('a null address polls nothing (no device key ⇒ no rail)', async () => {
    const {rows, tree} = await mount(null);
    expect(mockedGetSolanaHistory).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    act(() => { tree.unmount(); });
  });

  test('the rail being OFF (seam answers offline) leaves the list untouched — not an error, nothing to mark', async () => {
    mockedGetSolanaHistory.mockResolvedValue({kind: 'offline'});
    const {rows, apiRef, tree} = await mount();
    expect(mockedGetSolanaHistory).toHaveBeenCalledWith(ADDRESS, expect.any(AbortSignal));
    expect(rows()).toEqual([]);
    expect(apiRef.current!.failure).toBe(null); // offline ≠ failure: no stale marker may render
    act(() => { tree.unmount(); });
  });

  test('a raw rejection with a LIVE signal is a seam defect: rows kept, cause classified (never silently current)', async () => {
    mockedGetSolanaHistory.mockResolvedValue(history([row()]));
    const {rows, apiRef, tree} = await mount();
    expect(rows()).toHaveLength(1);

    // The seam classifies every rail failure into a value; a live-signal throw reaching the hook is
    // a defect — and even that must not let stale rows render as current. The oracle (mocked here)
    // decides the cause, exactly as the balance poll's residual catch now does.
    mockedClassify.mockResolvedValueOnce('offline');
    mockedGetSolanaHistory.mockRejectedValue(new Error('fetch failed'));
    await act(async () => { await apiRef.current!.refreshHistory(); });
    expect(rows()).toHaveLength(1);                  // unchanged rows — an outage is not an empty ledger
    expect(apiRef.current!.failure).toBe('offline'); // …but the list is marked stale with the oracle's verdict
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(ADDRESS), expect.any(Error));
    act(() => { tree.unmount(); });
  });

  test('an aborted/cancelled read is silenced: the address switch aborts the signal and drops the late result (rows AND failure)', async () => {
    let oldReject!: (e: unknown) => void;
    mockedGetSolanaHistory.mockReturnValueOnce(new Promise<SolanaHistoryResult>((_, rej) => { oldReject = rej; }));
    mockedGetSolanaHistory.mockResolvedValueOnce(history([row({signature: 'Sig3333333333333333333333333333333333333333'})]));
    const apiRef: React.MutableRefObject<ReturnType<typeof useSolanaHistory> | null> = {current: null};
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness address={ADDRESS} apiRef={apiRef} />); });
    act(() => { tree.update(<Harness address={'NewAddr00000000000000000000000000000000000000'} apiRef={apiRef} />); });
    // The cancelled poll's rejection arrives AFTER the switch: its signal is aborted (the cleanup
    // path), so it sets nothing — no failure, no rows. (The new address's own initial read was
    // skipped meanwhile by the one-in-flight guard, which is correct: skip, never queue.)
    await act(async () => { oldReject(new Error('The user aborted a request.')); for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(apiRef.current!.failure).toBe(null);
    expect(apiRef.current!.history).toEqual([]);
    // The new address then reads cleanly on the next tick — the cancellation left no scar.
    await act(async () => { await apiRef.current!.refreshHistory(); });
    expect(apiRef.current!.history.map(t => t.nonce)).toEqual(['Sig3333333333333333333333333333333333333333']);
    act(() => { tree.unmount(); });
  });

  test('a classified read failure EXPOSES the cause and keeps the last known rows (never silent again)', async () => {
    mockedGetSolanaHistory.mockResolvedValue(history([row()]));
    const {rows, apiRef, tree} = await mount();
    expect(rows()).toHaveLength(1);
    expect(apiRef.current!.failure).toBe(null);

    // The seam classified this at the transport layer (endpoint answered, did not serve us); the
    // hook must NOT swallow it — the rows stay (last truth) and the cause rides out for the marker.
    mockedGetSolanaHistory.mockResolvedValue({kind: 'error', failure: 'refused'});
    await act(async () => { await apiRef.current!.refreshHistory(); });
    expect(rows()).toHaveLength(1);                        // an outage is not an empty ledger
    expect(apiRef.current!.failure).toBe('refused');      // ... but the list is now marked stale
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused'));

    // Recovery: ONE clean read and the stale marker is gone — it must not outlive the fix.
    mockedGetSolanaHistory.mockResolvedValue(history([row({signature: 'Sig2222222222222222222222222222222222222222'})]));
    await act(async () => { await apiRef.current!.refreshHistory(); });
    expect(apiRef.current!.failure).toBe(null);
    expect(rows()[0].nonce).toBe('Sig2222222222222222222222222222222222222222'); // the fresh rows replaced the old
    act(() => { tree.unmount(); });
  });

  test('unreadable transactions are counted out loud, so a short list is never silently short', async () => {
    mockedGetSolanaHistory.mockResolvedValue(history([row()], 2));
    const {rows, tree, apiRef} = await mount();
    expect(rows()).toHaveLength(1);
    expect(apiRef.current!.dropped).toBe(2); // the count rides to the ledger's honesty note
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('2 transaction(s) unreadable'));
    // A CLEAN re-poll CLEARS the count (it is set on every poll, not only raised) — a note about a
    // broken RPC must not outlive the fix, and a clean read is never re-announced.
    mockedGetSolanaHistory.mockResolvedValue(history([row()]));
    await act(async () => { jest.advanceTimersByTime(POLL.history); });
    expect(apiRef.current!.dropped).toBe(0);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('0 transaction(s) unreadable'));
    act(() => { tree.unmount(); });
  });

  test('re-polls every POLL.history and stops on unmount', async () => {
    mockedGetSolanaHistory.mockResolvedValue(history([row()]));
    const {tree} = await mount();
    expect(mockedGetSolanaHistory).toHaveBeenCalledTimes(1);

    await act(async () => { jest.advanceTimersByTime(POLL.history); });
    expect(mockedGetSolanaHistory).toHaveBeenCalledTimes(2);

    act(() => { tree.unmount(); });
    await act(async () => { jest.advanceTimersByTime(POLL.history * 3); });
    expect(mockedGetSolanaHistory).toHaveBeenCalledTimes(2); // the interval was cleared
  });

  test('periodic forever: past the active window the ledger keeps reading, at the IDLE cadence (founder 2026-10-05: Solana transactions re-poll periodically)', async () => {
    mockedGetSolanaHistory.mockResolvedValue(history([row()]));
    const {tree} = await mount();
    expect(mockedGetSolanaHistory).toHaveBeenCalledTimes(1);
    // Active-cadence ticks through the active window (SOL_ACTIVE_POLL_WINDOW_MS from mount)…
    await act(async () => { jest.advanceTimersByTime(SOL_ACTIVE_POLL_WINDOW_MS); });
    const afterWindow = mockedGetSolanaHistory.mock.calls.length;
    expect(afterWindow).toBeGreaterThan(1);
    // …then the reads continue at POLL.historyIdle, never stopping: no active-spacing tick, then
    // exactly one at the idle boundary.
    await act(async () => { jest.advanceTimersByTime(POLL.historyIdle - POLL.history); });
    expect(mockedGetSolanaHistory).toHaveBeenCalledTimes(afterWindow);
    await act(async () => { jest.advanceTimersByTime(POLL.history); });
    expect(mockedGetSolanaHistory).toHaveBeenCalledTimes(afterWindow + 1);
    act(() => { tree.unmount(); });
  });
});

describe('history staleness copy — rail.historyStale (all four locales)', () => {
  // Assertions for the key this slice ADDED live here, not in HomeRailHonesty (that file belongs to
  // the parallel balance-note work). The cause keys (refused/offline/…) stay covered there.
  const LOCALES = {en: errorsEn, de: errorsDe, es: errorsEs, fr: errorsFr};
  for (const [tag, errors] of Object.entries(LOCALES)) {
    test(`${tag}: names the network, never 'undefined', and stays a short list line`, () => {
      const line = errors.rail.historyStale('Solana');
      expect(typeof line).toBe('string');
      expect(line).toContain('Solana'); // the network name is interpolated, not dropped
      expect(line).not.toContain('undefined');
      expect(line.length).toBeGreaterThan(20); // a sentence, not a fragment
      expect(line.length).toBeLessThan(180);   // compact — the ledger's list surface
    });
  }
});
