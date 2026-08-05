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
 *   - Primary fetch + each per-asset fetch run on their OWN timeout (BALANCE_TIMEOUT_MS); a hiccup
 *     on one asset's ledger never flips the primary offline or fails its poll (separate ledgers).
 *     A null asset result keeps the prior value (no flap on a single miss).
 *   - MC5 offline-deduction resets are COUPLED to a successful fetch and stay INTERNAL: the primary
 *     poll resets currency-0; each successful per-asset poll resets that currency. These never fire
 *     on a miss (the authoritative balance must land before the optimistic view is cleared).
 *   - The effect dep is `displayCurrencyIds` (a stable STRING signature), NOT `displayAssets` (a new
 *     array each render) — so the poll resets only when a currency is added/removed, not every frame.
 *   - Relay-retarget race fix (OPEN_ISSUES #6): on teardown (relayUrl/displayCurrencyIds change) the
 *     effect aborts ALL in-flight fetches via an AbortController, and a generation ref rejects any
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
    // AbortController tied to this effect's lifetime. On teardown it aborts EVERY in-flight fetch
    // (primary + per-asset) IMMEDIATELY, so a slow old-relay poll cannot resolve after the new relay's
    // poll and overwrite the fresh balance. fetchWithTimeout uses the caller signal AS-IS when present
    // (see services/relay.ts composeTimeout), so the per-fetch BALANCE_TIMEOUT_MS is composed below
    // via `timed` (first-abort-wins: the effect controller OR the per-fetch timeout).
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
      // Non-primary asset balances run in PARALLEL + best-effort, each with its own timeout, so a
      // hiccup on one asset's ledger can never flip the primary `$` balance offline or fail its
      // poll. The assets live on separate ledgers — fetching one must not affect another's display. A
      // null result keeps the prior value (no flap on a single miss). Covers EVERY non-primary catalog
      // currency (ramp + no-minter ICRC), so an unfunded asset still reads its real zero balance.
      const assetFetches = displayAssets.map(a => {
        const t = timed(BALANCE_TIMEOUT_MS);
        return fetchWithTimeout(`${base(relayUrl)}/api/v1/balance/${publicHex}?currency=${a.currency}`, {signal: t.signal}, BALANCE_TIMEOUT_MS)
          .then(r => r.ok ? r.json().catch(() => null) : null)
          .then(j => (j && typeof j.balance === 'string') ? (j.balance as string) : null)
          .catch(() => null)
          .then(b => { t.stop(); return {currency: a.currency, balance: b}; });
      });
      try {
        const t = timed(BALANCE_TIMEOUT_MS);
        try {
          const r = await fetchWithTimeout(`${base(relayUrl)}/api/v1/balance/${publicHex}`, {signal: t.signal}, BALANCE_TIMEOUT_MS);
          const j = await r.json();
          // MC5: reset ONLY the DEMO (currency-0) offline deduction on a successful primary poll — the
          // authoritative balance replaces the local optimistic view, and any pending offline DEMO
          // hand-off has either settled (reflected in this balance) or never will (stale). Per-asset
          // deductions reset on their own per-currency poll below (same rationale, per asset).
          if (fresh() && r.ok && typeof j.balance === 'string') { setBalance(j.balance); setOnline(true); setOfflineSpent(prev => prev[0] != null && prev[0] !== '0' ? {...prev, 0: '0'} : prev); }
          else if (fresh()) setOnline(false);
        } finally { t.stop(); }
      } catch { if (fresh()) setOnline(false); }
      // Settle the asset balances after the primary poll resolves; merge keeping prior on null.
      // MC5: a successful asset poll resets that currency's offline deduction (the authoritative
      // polled balance replaces the optimistic local view — same rationale as the DEMO reset above).
      const results = await Promise.all(assetFetches);
      if (fresh()) {
        setAssetBalances(prev => {
          const next = {...prev};
          for (const {currency, balance} of results) if (balance != null) next[currency] = balance;
          return next;
        });
        setOfflineSpent(prev => {
          let changed = false;
          const next = {...prev};
          for (const {currency, balance} of results) {
            if (balance != null && next[currency] != null && next[currency] !== '0') { next[currency] = '0'; changed = true; }
          }
          return changed ? next : prev;
        });
      }
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
