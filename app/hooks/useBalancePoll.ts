import {useCallback, useEffect, useRef, useState} from 'react';
import {type CurrencyDescriptor} from '../config/catalog';
import {POLL, BALANCE_TIMEOUT_MS} from '../config/constants';
import {base} from '../lib/format';
import {fetchWithTimeout} from '../services/relay';

type Args = {
  relayUrl: string;
  publicHex: string;
  displayAssets: CurrencyDescriptor[];
  displayCurrencyIds: string;
};

/**
 * The primary (`$` DEMO) + per-asset balance poll. Extracted from Wallet.tsx (Effect B):
 *   - SINGLE batch fetch (`GET /api/v1/balances/<account>`) returns EVERY catalog currency's balance
 *     in one response — replacing the old N+1 loop (1 primary fetch + 1 per-asset, each a relay→IC
 *     round trip). With 6 production currencies that's 1 HTTP request per poll instead of 6.
 *   - The relay fans the per-currency ledger queries out concurrently + best-effort (a hiccup on one
 *     asset's ledger OMITS it from the response, never failing the whole batch), so a slow ledger for
 *     one asset never flips the primary offline. A missing entry keeps the prior value (no flap).
 *   - MC5 offline-deduction resets are COUPLED to a successful per-currency read and stay INTERNAL:
 *     the primary read resets currency-0; each successful per-asset read resets that currency. These
 *     never fire on a miss (the authoritative balance must land before the optimistic view is cleared).
 *   - The effect dep is `displayCurrencyIds` (a stable STRING signature), NOT `displayAssets` (a new
 *     array each render) — so the poll resets only when a currency is added/removed, not every frame.
 *   - Relay-retarget race fix (OPEN_ISSUES #6): on teardown (relayUrl/displayCurrencyIds change) the
 *     effect aborts the in-flight batch fetch via an AbortController, and a generation ref rejects any
 *     poll whose result lands after a newer generation started. This closes the window where an old
 *     relay's slow in-flight poll could resolve after the new relay's poll and shadow the new balance
 *     (the `alive` closure flag is retained as a secondary gate).
 *
 * `markOfflinePaid` is the offline QR/NFC hand-off debit (BigInt-summed; negative = the refund-on-
 * failed-but-signed path). `resetDeduction` is exposed for Wallet's faucet `topUp`, which credits the
 * DEMO balance out-of-band and must clear the currency-0 deduction without waiting on the next poll.
 * `setBalance`/`setOnline` are exposed for that same `topUp` immediate-refresh path (the faucet
 * response carries the new balance → show it instantly; the next poll overwrites both authoritatively).
 */
export function useBalancePoll(args: Args): {
  balance: string | null;
  online: boolean;
  assetBalances: Record<number, string>;
  offlineSpent: Record<number, string>;
  markOfflinePaid: (amount: string, currency: number) => void;
  resetDeduction: (currency: number) => void;
  setBalance: (b: string | null) => void;
  setOnline: (o: boolean) => void;
} {
  const {relayUrl, publicHex, displayAssets, displayCurrencyIds} = args;
  const [balance, setBalance] = useState<string | null>(null);
  // Non-primary assets — each is a SEPARATE asset on a separate ledger, polled in parallel on the
  // same cadence. A "0" entry means "not yet funded"; the card still renders (muted) so the full
  // asset rail is always visible. MC1 units 2-4: balances are raw-u64 decimal STRINGS (never number).
  const [assetBalances, setAssetBalances] = useState<Record<number, string>>({});
  const [online, setOnline] = useState(false);
  // MC5 — currency-KEYED offline deduction. A per-currency map of raw-u64 decimal strings (missing
  // key ⇒ '0' spent ⇒ no deduction). The offline QR/NFC hand-off (markOfflinePaid) debits THIS
  // asset's entry. Source of truth for every "shown" balance via the applyOffline helper.
  const [offlineSpent, setOfflineSpent] = useState<Record<number, string>>({});

  // Relay-retarget race fix (OPEN_ISSUES #6): a monotonically-increasing generation id. Every effect
  // run captures its generation; before ANY state write, a poll re-checks the ref — if a newer
  // generation started (relayUrl/displayCurrencyIds changed under it), the result is from a STALE
  // relay and is dropped. This is a value-level gate that survives any ordering of microtask
  // scheduling between the old poll's `.then()` and React's commit phase, closing the window the
  // `alive` closure flag alone could not fully cover.
  const genRef = useRef(0);

  useEffect(() => {
    let alive = true;
    const gen = ++genRef.current;
    // AbortController tied to this effect's lifetime. On teardown it aborts the in-flight batch fetch
    // IMMEDIATELY, so a slow old-relay poll cannot resolve after the new relay's poll and overwrite the
    // fresh balance. fetchWithTimeout uses the caller signal AS-IS when present (see services/relay.ts
    // composeTimeout), so the per-fetch BALANCE_TIMEOUT_MS is composed below via `timed` (first-abort-
    // wins: the effect controller OR the per-fetch timeout).
    const ctrl = new AbortController();

    // Compose the effect's abort signal with a per-fetch timeout. First abort wins; never throws.
    // Returns the composed signal + a `stop()` that clears the timer + detaches the parent listener
    // so no dangling no-op abort fires after the fetch settles. Manual compose (AbortSignal.any /
    // AbortSignal.timeout are ES2024+ statics not in this project's TS lib / not on every Hermes).
    const timed = (timeoutMs: number): {signal: AbortSignal; stop: () => void} => {
      const c = new AbortController();
      const timer = setTimeout(() => c.abort(), timeoutMs);
      const onParent = () => c.abort();
      if (ctrl.signal.aborted) c.abort();
      else ctrl.signal.addEventListener('abort', onParent, {once: true});
      const stop = () => { clearTimeout(timer); ctrl.signal.removeEventListener('abort', onParent); };
      return {signal: c.signal, stop};
    };
    // `fresh` is the write gate: true only while THIS effect is current (alive) AND no newer
    // generation has started. Checked immediately before every setState below.
    const fresh = () => alive && gen === genRef.current;

    const poll = async () => {
      // SINGLE batch fetch — the relay returns EVERY catalog currency's balance in one response
      // (a flat map {currency: minor-units-string}), replacing the old N+1 loop (1 primary + 1 per
      // asset, each a relay→IC round trip). The relay fans the per-currency queries out concurrently
      // + best-effort (a hiccup on one ledger OMITS that currency, never failing the batch), so a
      // missing entry keeps the prior value (no flap on a single miss). Covers EVERY catalog currency
      // (primary 0 + every non-primary), so an unfunded asset still reads its real zero balance.
      const t = timed(BALANCE_TIMEOUT_MS);
      try {
        try {
          const r = await fetchWithTimeout(`${base(relayUrl)}/api/v1/balances/${publicHex}`, {signal: t.signal}, BALANCE_TIMEOUT_MS);
          if (r.ok) {
            // The body is a flat {currency: minor-units-string} map (JSON keys are strings). A parse
            // failure / non-object body is treated like an offline blip (no state change to balances).
            const j: unknown = await r.json().catch(() => null);
            const map = (j && typeof j === 'object' && !Array.isArray(j)) ? j as Record<string, string> : null;
            if (!map) { if (fresh()) setOnline(false); return; }
            // Primary (currency 0): a successful read sets the balance + flips online + resets the
            // DEMO offline deduction (the authoritative balance replaces the optimistic local view).
            // A missing/non-string primary in an otherwise-200 batch → offline (primary ledger hiccup).
            const primary = map['0'];
            if (fresh() && typeof primary === 'string') {
              setBalance(primary);
              setOnline(true);
              setOfflineSpent(prev => prev[0] != null && prev[0] !== '0' ? {...prev, 0: '0'} : prev);
            } else if (fresh()) {
              setOnline(false);
            }
            if (!fresh()) return;
            // Non-primary assets: merge keeping prior on a missing entry (the relay omits a currency
            // whose ledger hiccupped — best-effort, no flap). MC5: a successful per-asset read resets
            // that currency's offline deduction (the authoritative polled balance replaces the local
            // optimistic view — same rationale as the DEMO reset above).
            setAssetBalances(prev => {
              let changed = false;
              const next = {...prev};
              for (const a of displayAssets) {
                const v = map[String(a.currency)];
                if (typeof v === 'string') { next[a.currency] = v; changed = true; }
              }
              return changed ? next : prev;
            });
            setOfflineSpent(prev => {
              let changed = false;
              const next = {...prev};
              for (const a of displayAssets) {
                const v = map[String(a.currency)];
                if (typeof v === 'string' && next[a.currency] != null && next[a.currency] !== '0') { next[a.currency] = '0'; changed = true; }
              }
              return changed ? next : prev;
            });
          } else {
            // Non-2xx: no silent errors — log the status + body so a relay 5xx/4xx is debuggable, then
            // flip offline (the next poll retries). The body is tiny JSON; read best-effort.
            const bodyText = await r.text().catch(() => '<unreadable>');
            console.warn(`balances ${r.status}: ${bodyText}`);
            if (fresh()) setOnline(false);
          }
        } finally { t.stop(); }
      } catch (e) { console.warn('balance poll failed:', e instanceof Error ? e.message : String(e)); if (fresh()) setOnline(false); }
    };
    poll(); const id = setInterval(poll, POLL.balance);
    return () => { alive = false; clearInterval(id); ctrl.abort(); };
    // `displayAssets` is captured by closure but intentionally NOT a dep — it's a new array each
    // render; `displayCurrencyIds` (a stable string) is the signature that retriggers the poll only
    // when a currency is actually added/removed. Mirrors the original Wallet.tsx effect verbatim.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, publicHex, displayCurrencyIds]);

  // MC5 — currency-KEYED offline deduction. The reducer sums BigInt(amount) under the given currency
  // key; the negative case (the refund-on-failed-but-signed NFC path) UNDOES a prior deduction. MC1
  // units 2-4: amount is a raw-u64 decimal STRING; never `+`/`-` on strings.
  const markOfflinePaid = useCallback((amount: string, currency: number) => setOfflineSpent(prev => {
    const cur = prev[currency] ?? '0';
    const next = BigInt(cur) + BigInt(amount);
    return {...prev, [currency]: (next < 0n ? 0n : next).toString()};
  }), []);

  // Exposed for Wallet's faucet topUp: crediting the DEMO balance out-of-band must clear the
  // currency-0 deduction immediately (no waiting on the 2.5s poll). Generalized per-currency to
  // match the poll's own reset shape. No-op when the entry is already '0' / absent (avoids a
  // needless new object → no spurious re-render of the derived displayAssetBalances memo).
  const resetDeduction = useCallback((currency: number) => setOfflineSpent(prev => prev[currency] != null && prev[currency] !== '0' ? {...prev, [currency]: '0'} : prev), []);

  return {balance, online, assetBalances, offlineSpent, markOfflinePaid, resetDeduction, setBalance, setOnline};
}
