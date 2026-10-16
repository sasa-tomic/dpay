import {useCallback, useEffect, useRef, useState} from 'react';
import {POLL} from '../config/constants';
import {M} from '../i18n';
import {short, fmtTime} from '../lib/format';
import {getSolanaHistory} from '../solana';
import type {SolanaHistoryRow} from '../solana';
import type {Txn} from '../lib/types';
import {usePollCadence} from './usePollCadence';

/**
 * The SOL rail's half of the Transactions list — the mirror of `useTransactionHistory` (the IC
 * half), so the Wallet merges two lists of the SAME `Txn` shape rather than two rail-specific ones.
 *
 * Reads through the seam (`solana.ts#getSolanaHistory` → `solana/history.ts`), which no-ops without
 * touching the network when the SOL rail is off (`solanaRpcUrl()` empty — the offline inner loop).
 * Best-effort exactly like the IC hook: a failed poll KEEPS the prior list (an RPC outage must
 * never blank the ledger), logs the classified cause, and lets the cadence retry — the list itself
 * never claims to be out of date (founder 2026-10-16: the old stale banner read as a lie while the
 * rows shown were current; a failed refresh is silent, the retry is not). A null `address` (no
 * device key) polls nothing.
 *
 * CADENCE (`usePollCadence`): `POLL.history` around a money flow — the wallet just opened, a send
 * just confirmed — and `POLL.historyIdle` the rest of the time, and nothing at all while the app is
 * backgrounded. One history tick costs one signature query per address the wallet's money can
 * sit at (the owner and one token account per registered mint), so the cadence is what keeps the
 * per-mint pages this reader now fetches inside a budget instead of on top of one.
 *
 * The reader also reports how many transactions it could NOT parse (`dropped`) — the hook surfaces
 * that count alongside the rows so the ledger can say the list may be short (each unreadable
 * transaction still exists on-chain; the short list is never silently short).
 *
 * `lastSuccessAt` is the ONE honest staleness input: the wall clock of the last CLEAN read, null
 * until one lands (and nulled again when the rail switches off). It says NOTHING about failures —
 * the Wallet takes the oldest rail's value and the Ledger shows an age note only after
 * HISTORY_STALE_AFTER_MS (founder 2026-10-16: the note must appear when refreshing "actually fails
 * for real for some time", phrased as an age, never as a failure verdict).
 */
export function useSolanaHistory(address: string | null): {history: Txn[]; dropped: number; lastSuccessAt: number | null; refreshHistory: () => void} {
  const [history, setHistory] = useState<Txn[]>([]);
  const [dropped, setDropped] = useState(0);
  // Wall clock of the last clean read; null = never read (or the rail switched off). Failure
  // classification is deliberately NOT tracked here anymore — age, not verdicts.
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const genRef = useRef(0);
  // The live poll, assigned by the effect below and driven by the cadence hook. Held in a ref so
  // the cadence never restarts just because this component re-rendered.
  const pollRef = useRef<() => void>(() => {});
  // One outstanding read at a time: a tick arriving while the previous walk is still out is
  // SKIPPED, never queued (queuing would re-raise the request rate against a slow endpoint —
  // the measured failure this guard exists to prevent). Scope NOTE: unlike the balance poll,
  // whose inFlight is a plain local INSIDE its effect, this ref is shared across address
  // generations — a poll aborted by an address change still holds the slot until it settles, so
  // the new generation's FIRST tick can be skipped too. Accepted: a skipped tick observes
  // nothing and reports nothing; the next cadence tick reads (POLL.history: 15s in prod,
  // 150ms under the e2e override).
  const inFlight = useRef(false);

  useEffect(() => {
    if (address === null) {
      pollRef.current = () => {};
      setLastSuccessAt(null); // the rail switched off: an unknown must not keep aging as stale
      return;
    }
    let alive = true;
    const gen = ++genRef.current;
    const ctrl = new AbortController();
    const fresh = () => alive && gen === genRef.current;

    const poll = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      let result;
      try {
        result = await getSolanaHistory(address, ctrl.signal);
      } catch (e) {
        // An aborted read is the CALLER's cancellation (the seam rethrows it untouched when the
        // signal it was passed is aborted — and this poll's signal is aborted exactly by the
        // cleanup below): classify nothing, log nothing beyond the defect note.
        if (ctrl.signal.aborted || !fresh()) return;
        console.warn(`useSolanaHistory fetch failed for ${address}: `, e);
        return; // keep the existing list — an unreadable poll is not an empty ledger
      } finally {
        inFlight.current = false;
      }
      if (!fresh()) return; // a poll from a previous address must not overwrite the current list
      if (result.kind === 'offline') return; // SOL rail off (empty RPC URL): nothing was read, nothing changes
      if (result.kind === 'error') {
        // No fact this poll. The prior rows are still the last truth so they stay; the failure is
        // logged, not surfaced — the poll retries on its own cadence and the list never claims to
        // be out of date (founder 2026-10-16, the stale-banner removal).
        console.warn(`useSolanaHistory: history read failed (${result.failure}) for ${address} — keeping the last known list`);
        return;
      }
      if (result.dropped > 0) {
        // Each dropped transaction was already logged with its signature + reason by the reader; this
        // records the COUNT so a short list is never silently short.
        console.warn(`useSolanaHistory: ${result.dropped} transaction(s) unreadable for ${address} (each logged above)`);
      }
      // Set on EVERY poll (not only when > 0): a clean read after a dirty one clears the note.
      setDropped(result.dropped);
      setLastSuccessAt(Date.now()); // the ONLY clock write: a clean read, never a failure
      setHistory(result.rows.map(toTxn));
    };
    pollRef.current = () => { void poll(); };

    return () => {
      alive = false;
      ctrl.abort();
      pollRef.current = () => {};
    };
  }, [address]);

  // The cadence: active around a money flow, idle otherwise, stopped while backgrounded. Declared
  // AFTER the effect above so the poll it drives is already assigned when it fires the first read.
  const refreshHistory = usePollCadence(
    useCallback(() => { pollRef.current(); }, []),
    address !== null,
    POLL.history,
    POLL.historyIdle,
    address ?? '',
  );

  return {history, dropped, lastSuccessAt, refreshHistory};
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
    // The row's own token symbol — `solana:SOL`, `solana:USDC`, `solana:EURC`, … — the exact id
    // `buildSelectableAssets` spells for that rail (config/assets.ts). It used to map every
    // non-SOL row to `solana:USDC`, which filed a EURC payment under the dollar account.
    assetId: `solana:${row.token}`,
    // The receipt's two fields (X6). The FULL base58 counterparty, '' when it is not uniquely
    // determinable (same rule as `who` above, unabbreviated); and the transaction SIGNATURE, which
    // is this rail's proof — Solana records no dpay reference, so the receipt says that instead of
    // rendering an empty Reference row.
    counterparty: row.counterparty ?? '',
    ledgerRef: row.signature,
  };
}
