import {useCallback, useEffect, useState} from 'react';
import {POLL} from '../config/constants';
import {M} from '../i18n';
import {short, fmtTime} from '../lib/format';
import {getSolanaHistory} from '../solana';
import type {SolanaHistoryRow} from '../solana';
import type {Txn} from '../lib/types';

/**
 * The SOL rail's half of the Transactions list — the mirror of `useTransactionHistory` (the IC
 * half), so the Wallet merges two lists of the SAME `Txn` shape rather than two rail-specific ones.
 *
 * Reads through the seam (`solana.ts#getSolanaHistory` → `solana/history.ts`), which no-ops without
 * touching the network when the SOL rail is off (`SOLANA_RPC_URL` empty — the offline inner loop).
 * Best-effort exactly like the IC hook: a failed poll KEEPS the prior list (an RPC outage must never
 * blank the ledger) and is logged with the address. Fetch on mount + re-poll every `POLL.history`;
 * the interval clears on unmount. A null `address` (no device key) polls nothing.
 *
 * The reader also reports how many transactions it could NOT parse (`dropped`) — the hook surfaces
 * that count alongside the rows so the ledger can say the list may be short (each unreadable
 * transaction still exists on-chain; the short list is never silently short).
 */
export function useSolanaHistory(address: string | null): {history: Txn[]; dropped: number; refreshHistory: () => Promise<void>} {
  const [history, setHistory] = useState<Txn[]>([]);
  const [dropped, setDropped] = useState(0);

  const refreshHistory = useCallback(async () => {
    if (address === null) return;
    let result;
    try {
      result = await getSolanaHistory(address);
    } catch (e) {
      console.warn(`useSolanaHistory fetch failed for ${address}: `, e);
      return; // keep the existing list — an unreadable poll is not an empty ledger
    }
    if (result === null) return; // SOL rail off (empty RPC URL): nothing was read, nothing changes
    if (result.dropped > 0) {
      // Each dropped transaction was already logged with its signature + reason by the reader; this
      // records the COUNT so a short list is never silently short.
      console.warn(`useSolanaHistory: ${result.dropped} transaction(s) unreadable for ${address} (each logged above)`);
    }
    // Set on EVERY poll (not only when > 0): a clean read after a dirty one clears the note.
    setDropped(result.dropped);
    setHistory(result.rows.map(toTxn));
  }, [address]);

  useEffect(() => {
    let alive = true;
    const wrapped = () => { if (alive) refreshHistory(); };
    wrapped();
    const id = setInterval(wrapped, POLL.history);
    return () => { alive = false; clearInterval(id); };
  }, [refreshHistory]);

  return {history, dropped, refreshHistory};
}

/** One `SolanaHistoryRow` as a ledger row. Pure; every honesty decision it makes is documented. */
function toTxn(row: SolanaHistoryRow): Txn {
  // A block the node has no time for stays TIMELESS: NaN, never `now` and never the slot number.
  // `fmtTime` renders it '—' and `mergeHistoryByTime` sorts it after every timed row — a row that
  // cannot say when it happened does not get to claim a position among rows that can.
  const ts = row.blockTime ?? Number.NaN;
  return {
    // The transaction signature is the row's natural unique id (a signature yields at most one row
    // per token, and `Ledger` keys on index + this).
    nonce: row.signature,
    amount: row.amount,
    // The counterparty is null when it is not UNIQUELY determinable (a multi-recipient batch, a swap
    // route, or a failed transaction that moved nothing). '' is what `Ledger` already renders as
    // '—' on the IC rail — the honest "we don't know", never a plausible-looking address.
    who: row.counterparty === null ? '' : short(row.counterparty),
    // A FAILED transaction transferred nothing and was charged only the fee, so the honest delta is
    // a small debit — which without this line reads as a tiny successful payment. The memo slot is
    // where the row says what it actually is (SOL rows carry no user memo of their own).
    memo: row.ok ? '' : M.wallet.ledger.failed,
    time: fmtTime(ts),
    ts,
    dir: row.direction,
    assetId: row.token === 'SOL' ? 'solana:SOL' : 'solana:USDC',
  };
}
