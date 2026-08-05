import {useCallback, useEffect, useMemo, useState} from 'react';
import {type CurrencyDescriptor} from '../config/catalog';
import {POLL, BALANCE_TIMEOUT_MS} from '../config/constants';
import {short, isMintSentinel, fmtTime, base} from '../lib/format';
import {fetchWithTimeout} from '../services/relay';
import type {Txn, TransactionsRow} from '../lib/types';

type Args = {
  relayUrl: string;
  publicHex: string;
  catalog: CurrencyDescriptor[];
};

/**
 * Durable transaction history sourced from the ledger (the canister records every settled payment;
 * the relay surfaces it at GET /api/v1/transactions/{hex}). Extracted verbatim from Wallet.tsx
 * (Effect C) — behavior byte-identical:
 *
 *   - H2: history is fetched for EVERY catalog currency (not just currency=0). Each currency lives on
 *     a separate ledger and `transactions_of` is per-currency, so a single hardcoded currency=0 hid
 *     every ckBTC/ckUSDC payment. We fan out one bounded fetch per currency, best-effort per currency
 *     (a transient failure on one must NOT blank the others), union the rows, dedup by nonce, sort
 *     newest-first. If EVERY fetch fails (offline), the prior list is kept — an outage never blanks
 *     the RECENT card.
 *   - Each row's direction (in/out) is derived by comparing the queried account to `from`. The
 *     counterparty display name rides the signed wire (from_name/to_name); the short hex is the
 *     fallback only when no name was signed; the mint sentinel keeps its label.
 *
 * `catalogCurrencyIds` (the stable STRING signature) is the refreshHistory dep — `catalog` is a new
 * array each render, so the dep mirrors displayCurrencyIds in useBalancePoll (retrigger only when a
 * currency is added/removed). Fetch on mount + re-poll every POLL.history (5s); clears on unmount.
 */
export function useTransactionHistory(args: Args): {history: Txn[]; refreshHistory: () => Promise<void>} {
  const {relayUrl, publicHex, catalog} = args;
  const [history, setHistory] = useState<Txn[]>([]);
  // The full set of currency ids to fetch HISTORY for (H2): every catalog currency (DEMO_USD + every
  // non-primary asset). Stable signature for the refreshHistory deps (mirrors displayCurrencyIds).
  const catalogCurrencyIds = useMemo(() => catalog.map(c => c.currency).join(','), [catalog]);

  const refreshHistory = useCallback(async () => {
    const currencies = catalog.map(c => c.currency);
    let anySucceeded = false;
    const perCurrency = await Promise.all(currencies.map(async (currency) => {
      try {
        const r = await fetchWithTimeout(`${base(relayUrl)}/api/v1/transactions/${publicHex}?currency=${currency}&limit=20`, undefined, BALANCE_TIMEOUT_MS);
        const j = await r.json().catch(() => null);
        if (r.ok && j && Array.isArray(j.transactions)) { anySucceeded = true; return j.transactions as TransactionsRow[]; }
        return [];
      } catch { return []; }
    }));
    if (!anySucceeded) return; // offline / all failed: keep the existing list
    const me = publicHex.toLowerCase();
    // Dedup by nonce (a payment id is globally unique) across currencies, then sort the UNION
    // newest-first by raw timestamp — each per-currency fetch is already newest-first within its own
    // currency, but mixed currencies must interleave by time.
    const seen = new Set<string>();
    const all: TransactionsRow[] = [];
    for (const rows of perCurrency) {
      for (const rec of rows) {
        if (seen.has(rec.nonce)) continue;
        seen.add(rec.nonce);
        all.push(rec);
      }
    }
    all.sort((a, b) => b.timestamp - a.timestamp);
    setHistory(all.map((rec): Txn => {
      const dir: 'out' | 'in' = rec.from.toLowerCase() === me ? 'out' : 'in';
      const counterparty = dir === 'out' ? rec.to.toLowerCase() : rec.from.toLowerCase();
      const fromName = rec.from_name ?? '';
      const toName = rec.to_name ?? '';
      const memo = rec.memo ?? '';
      // N6/H3 RESOLVED: the counterparty's display name now rides the signed wire (from_name/to_name)
      // and is returned per row by the relay. For an OUT row (I am `from`) the counterparty is `to`
      // → show to_name; for an IN row the counterparty is `from` → show from_name. Fall back to the
      // short hex ONLY when no name was signed (unnamed payment); the mint sentinel keeps its label.
      const who = isMintSentinel(counterparty)
        ? (dir === 'in' ? 'Demo funds' : 'Withdrawal')
        : (dir === 'out' ? (toName || short(rec.to)) : (fromName || short(rec.from)));
      return {nonce: rec.nonce, amount: rec.amount, who, memo, time: fmtTime(rec.timestamp), dir, currency: rec.currency};
    }));
    // `catalog` is captured by closure but intentionally NOT a dep — it's a new array each render;
    // `catalogCurrencyIds` (a stable string) is the signature that retriggers the fetch only when a
    // currency is actually added/removed. Mirrors the original Wallet.tsx useCallback verbatim.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, publicHex, catalogCurrencyIds]);

  // Fetch on mount and re-poll while online (the balance poll runs every 2.5s; history every 5s is
  // plenty for a list that only changes when a payment settles). Clears on unmount.
  useEffect(() => {
    let alive = true;
    const wrapped = () => { if (alive) refreshHistory(); };
    wrapped();
    const id = setInterval(wrapped, POLL.history);
    return () => { alive = false; clearInterval(id); };
  }, [refreshHistory]);

  return {history, refreshHistory};
}
