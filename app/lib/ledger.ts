// The Transactions list's ONE ordering rule. The IC rail and the Solana device-key rail each
// produce their own newest-first list (`hooks/useTransactionHistory.ts` / `hooks/useSolanaHistory.ts`);
// this is where they become the single list the user reads.
//
// Ordering is on `Txn.ts` (raw unix seconds) and NOT on `Txn.time`, which is already a formatted,
// locale-relative string. A row whose source has no time carries `NaN` (see `Txn` in lib/types.ts)
// and sorts AFTER every timed row, keeping its rail's relative order: a Solana block the node has
// no `blockTime` for cannot be placed among timed rows without inventing a timestamp, and putting
// it first would claim it is the newest activity. Last is the one position that claims nothing,
// and the row still renders in full with '—' for its time.
//
// `Array#sort` is stable (ES2019), so rows sharing a timestamp — and every timeless row — keep the
// order they arrived in, which is each rail's own newest-first order.

import type {Txn} from './types';

export function mergeHistoryByTime(icRows: Txn[], solRows: Txn[]): Txn[] {
  return [...icRows, ...solRows].sort((a, b) => {
    const aTimed = Number.isFinite(a.ts);
    const bTimed = Number.isFinite(b.ts);
    if (aTimed !== bTimed) return aTimed ? -1 : 1;
    return aTimed ? b.ts - a.ts : 0;
  });
}
