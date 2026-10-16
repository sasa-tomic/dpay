import {useCallback, useEffect, useRef, useState} from 'react';
import {POLL} from '../config/constants';
import {short, fmtTime} from '../lib/format';
import {getEvmHistory, type EvmHistoryRow} from '../evm';
import type {EvmKey} from '../evm';
import type {Txn} from '../lib/types';
import {usePollCadence} from './usePollCadence';

/**
 * The EVM rail's half of the Transactions list — the `useSolanaHistory` twin over the seam's
 * `getEvmHistory` (D16): one `eth_getLogs` Transfer walk per visible (chain, token) row per
 * tick, merged into the ONE `Txn` list the Ledger renders. Best-effort: a failed poll KEEPS the
 * prior list and logs the cause, never blanking the ledger — and never marks the list stale
 * (founder 2026-10-16: a failed refresh must not claim the data is out of date). An empty key list
 * polls nothing.
 *
 * Cadence: POLL.history around a money flow, POLL.historyIdle otherwise, nothing backgrounded
 * (the shared `usePollCadence` machinery). One tick costs one getLogs walk per row — the page
 * cap (`EVM_LOG_PAGE_SIZE`) is the budget knob, never a correctness one (R4).
 */
export function useEvmHistory(
  address: string | null,
  keys: readonly EvmKey[],
): {history: Txn[]; dropped: number; refreshHistory: () => void} {
  const [history, setHistory] = useState<Txn[]>([]);
  const [dropped, setDropped] = useState(0);
  const genRef = useRef(0);
  const pollRef = useRef<() => void>(() => {});
  const inFlight = useRef(false);
  const keySig = keys.map(k => `${k.chainId}:${k.token}:${k.tokenAddress}`).join('|');
  const enabled = address !== null && keys.length > 0;

  useEffect(() => {
    if (!enabled || address === null) {
      pollRef.current = () => {};
      return;
    }
    const list = keySig.split('|').filter(s => s.length > 0).map(s => {
      const [chainId, token, tokenAddress] = s.split(':');
      return {chainId: Number(chainId), token, tokenAddress};
    });
    let alive = true;
    const gen = ++genRef.current;
    const ctrl = new AbortController();
    const fresh = () => alive && gen === genRef.current;

    const poll = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const results = await Promise.all(list.map(async k => ({
          k,
          out: await getEvmHistory(k.chainId, address, k.tokenAddress, ctrl.signal),
        })));
        if (!fresh()) return;
        let droppedTotal = 0;
        const okRows: Txn[] = [];
        const failedLegs = new Set<Txn['assetId']>(); // rows these legs own stay the last truth
        for (const {k, out} of results) {
          const legId: Txn['assetId'] = `evm:${k.chainId}:${k.token}`;
          if (out.kind === 'offline') continue; // that chain's rail is off — nothing was read
          if (out.kind === 'error') {
            console.warn(`useEvmHistory: read failed on chain ${k.chainId} (${out.failure}) — keeping that leg's last known rows`);
            failedLegs.add(legId);
            continue; // the FAILED leg's prior rows are kept below — a partial read never blanks them
          }
          droppedTotal += out.dropped;
          okRows.push(...out.rows.map(row => toTxn(row, legId)));
        }
        setDropped(droppedTotal);
        setHistory(prev => {
          const kept = prev.filter(t => failedLegs.has(t.assetId)); // failed legs: last truth stays
          const txns = [...okRows, ...kept];
          if (failedLegs.size === 0) txns.sort((a, b) => b.ts - a.ts); // newest-first across rows
          return txns;
        });
      } catch (e) {
        if (ctrl.signal.aborted || !fresh()) return;
        console.warn(`useEvmHistory fetch failed for ${address}:`, e); // keep the existing list
      } finally {
        inFlight.current = false;
      }
    };
    pollRef.current = () => { void poll(); };

    return () => {
      alive = false;
      ctrl.abort();
      pollRef.current = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, address, keySig]);

  const refreshHistory = usePollCadence(
    useCallback(() => { pollRef.current(); }, []),
    enabled,
    POLL.history,
    POLL.historyIdle,
    `${address ?? ''}|${keySig}`,
  );

  return {history, dropped, refreshHistory};
}

/** One `EvmHistoryRow` as a ledger row (the SOL `toTxn` twin). Pure; the honesty rules carry. */
function toTxn(row: EvmHistoryRow, assetId: Txn['assetId']): Txn {
  // A block the node has no time for stays TIMELESS: NaN, never `now` — fmtTime renders '—' and
  // the merge sorts it after every timed row.
  const ts = row.ts !== null ? row.ts * 1000 : Number.NaN;
  return {
    nonce: row.txHash.toLowerCase(),
    amount: row.amount,
    who: short(row.counterparty),
    memo: '',
    time: fmtTime(ts),
    ts,
    dir: row.dir,
    assetId,
    counterparty: row.counterparty,
    ledgerRef: row.txHash.toLowerCase(),
  };
}
