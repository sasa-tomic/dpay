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

jest.mock('../solana', () => ({getSolanaHistory: jest.fn()}));

import {getSolanaHistory} from '../solana';
import type {SolanaHistory, SolanaHistoryRow} from '../solana';
import {useSolanaHistory} from '../hooks/useSolanaHistory';
import {POLL} from '../config/constants';
import {M} from '../i18n';
import type {Txn} from '../lib/types';

const mockedGetSolanaHistory = getSolanaHistory as jest.MockedFunction<typeof getSolanaHistory>;

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

function history(rows: SolanaHistoryRow[], dropped = 0): SolanaHistory {
  return {rows, dropped};
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

  test('the rail being OFF (seam returns null) leaves the list untouched, with no network claim', async () => {
    mockedGetSolanaHistory.mockResolvedValue(null);
    const {rows, tree} = await mount();
    expect(mockedGetSolanaHistory).toHaveBeenCalledWith(ADDRESS);
    expect(rows()).toEqual([]);
    act(() => { tree.unmount(); });
  });

  test('a failed poll KEEPS the prior list and logs the address (an outage is not an empty ledger)', async () => {
    mockedGetSolanaHistory.mockResolvedValue(history([row()]));
    const {rows, apiRef, tree} = await mount();
    expect(rows()).toHaveLength(1);

    mockedGetSolanaHistory.mockRejectedValue(new Error('RPC node degraded'));
    await act(async () => { await apiRef.current!.refreshHistory(); });
    expect(rows()).toHaveLength(1); // unchanged
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(ADDRESS), expect.any(Error));
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
});
