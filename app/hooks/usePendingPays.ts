import {useEffect, useState} from 'react';
import {type PendingPay, listPendingPays, subscribePendingPays} from '../services/pendingPays';

// Authority: the read half of the offline-payment outbox (services/pendingPays). Loads one
// identity's handed-off-unconfirmed records and re-reads whenever any seam writes or reconciles
// (the store announces its own changes — the `useTxNotes` pattern), so Wallet's deduction, its
// pending rows and the store can never disagree for longer than one storage round-trip.
//
// Like `useTxNotes`, this hook has NO failure state by design: a store that will not load degrades
// to an empty list and the wallet renders exactly as it did before the outbox existed — a broken
// cache must never take the balances or the history down with it. The `alive` guard discards a
// stale load across identity switches; a notification racing an in-flight read is harmless (both
// paths converge on the same persisted state).
//
// Mutations are the SERVICE functions (`addPendingPays` / `removePendingPays` at the payment
// seams), not hook methods: the seams are deep in the payment trees and already import the store
// directly for the same reason they import `saveTxNote` — a mutate-then-refresh method here would
// be a second name for the same announce-driven refresh the subscription already performs.
export function usePendingPays(publicHex: string): PendingPay[] {
  const [records, setRecords] = useState<PendingPay[]>(() => []);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const entries = await listPendingPays(publicHex);
      if (alive) setRecords(prev => (prev === entries ? prev : entries));
    };
    void read();
    const off = subscribePendingPays(changed => {
      if (changed === publicHex) void read();
    });
    return () => {
      alive = false;
      off();
    };
  }, [publicHex]);
  return records;
}
