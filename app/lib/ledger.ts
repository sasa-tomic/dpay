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

// The join key a SETTLED row reconciles a pending record by — the same dispatch `annotateTxn`
// (services/txNotes) uses, so the merge below, the annotation resolver and Wallet's persisted
// reconciliation (removePendingPays) can never disagree about which field identifies a payment:
// a Solana row is its transaction SIGNATURE (`nonce`), an IC row the on-chain MEMO (`memo`).
export function settledJoinKey(t: Txn): string {
  return (t.assetId.startsWith('solana:') ? t.nonce : t.memo).trim().toLowerCase();
}

/**
 * Fold the offline outbox's projected rows (services/pendingPays → Wallet) into the settled list —
 * founder requirement 1: an offline NFC/QR payment appears in the LOCAL list, and we ASSUME the
 * transfer completed. Newest-first by `ts`, a pending row FIRST among equal timestamps (it is the
 * payment the user just made; the settled row it will become cannot also be present — see the
 * drop), and timeless settled rows stay last exactly as `mergeHistoryByTime` orders them.
 *
 * RECONCILIATION HAPPENS HERE TOO, not only in Wallet's persisted drop: a settled row whose join
 * key matches a pending record removes the projected row from the render in the SAME render pass
 * the real row arrives — otherwise the interval between the history refresh and the async store
 * removal shows the payment twice. The persisted drop follows for durability (cap-bounded storage);
 * this filter makes the list self-healing regardless of storage timing.
 */
export function mergePendingByTime(pendingRows: Txn[], settled: Txn[]): Txn[] {
  if (pendingRows.length === 0) return settled;
  const settledKeys = new Set<string>();
  for (const t of settled) settledKeys.add(settledJoinKey(t));
  const live = pendingRows.filter(p => !settledKeys.has(p.nonce.trim().toLowerCase()));
  if (live.length === 0) return settled;
  return [...live, ...settled].sort((a, b) => {
    const aTimed = Number.isFinite(a.ts);
    const bTimed = Number.isFinite(b.ts);
    if (aTimed !== bTimed) return aTimed ? -1 : 1;
    if (aTimed && a.ts !== b.ts) return b.ts - a.ts;
    if (aTimed) return a.pending && !b.pending ? -1 : b.pending && !a.pending ? 1 : 0;
    return 0;
  });
}
