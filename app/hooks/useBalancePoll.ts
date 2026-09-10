import {useCallback, useEffect, useRef, useState} from 'react';
import {type CurrencyDescriptor} from '../config/catalog';
import {POLL, BALANCE_TIMEOUT_MS} from '../config/constants';
import {relayFetch} from '../services/relay';

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
  refresh: () => void;
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
  // Latest poll of the CURRENT effect (null between effects) — the "Check again" escape hatch.
  const pollRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    let alive = true;
    const gen = ++genRef.current;
    // AbortController tied to this effect's lifetime. On teardown it aborts the in-flight batch fetch
    // IMMEDIATELY, so a slow old-relay poll cannot resolve after the new relay's poll and overwrite the
    // fresh balance. The walk (relayFetch) arms its own per-attempt internal deadlines, so the
    // per-fetch outer bound is composed below via `timed` (first-abort-wins: the effect controller
    // OR the outer timer — which sits 1 s after the walk's attempt-0 budget; see below).
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
    // Overlap guard: the interval fires every POLL.balance (2.5 s) while a walk may legitimately
    // still be in flight (BALANCE_TIMEOUT_MS 4 s attempt budget; a multi-address walk ≈ 2×), so
    // two polls of the SAME generation routinely overlap — and `fresh()` (generation-only) lets a
    // sibling's write through. The glitch this guards: the OLDER poll's late timeout abort lands
    // AFTER a newer poll's success and setOnline(false) — the "green for a moment, then gray
    // again" flicker. Rule (deliberately ASYMMETRIC):
    //   • a SUCCESS always writes — an older poll's failover answer is real, current connectivity
    //     information (the wave-2 "online from B within the FIRST poll" behavior relies on it;
    //     worst case a slower stale answer lands for one interval, the next poll re-verifies);
    //   • a FAILURE writes only when no success completed AFTER this failing poll STARTED — i.e.
    //     a success that arrived on top of a still-hanging older attempt retires that attempt's
    //     eventual timeout. Newest OBSERVATION wins; a stale abort is not an observation.
    let successCount = 0;

    const poll = async () => {
      const startSuccesses = successCount;
      // A failure whose poll was overtaken by a sibling SUCCESS (completed after this poll
      // started) is retired, not observed — every failure write below gates on !staleFailure().
      const staleFailure = () => !fresh() || successCount !== startSuccesses;
      // SINGLE batch fetch — the relay returns EVERY catalog currency's balance in one response
      // (a flat map {currency: minor-units-string}), replacing the old N+1 loop (1 primary + 1 per
      // asset, each a relay→IC round trip). The relay fans the per-currency queries out concurrently
      // + best-effort (a hiccup on one ledger OMITS that currency, never failing the batch), so a
      // missing entry keeps the prior value (no flap on a single miss). Covers EVERY catalog currency
      // (primary 0 + every non-primary), so an unfunded asset still reads its real zero balance.
      // Wave-2: the outer timer sits 1 s STRICTLY AFTER the walk's own BALANCE_TIMEOUT_MS
      // budget. The walk's attempt-0 internal deadline (BALANCE_TIMEOUT_MS) must win the tie
      // against this outer timer: at a tied 4000/4000 the caller's abort fired first, so a hung
      // preferred relay read as a CALLER decision (unmount) — never a transport failure — and
      // never failed over, never cooled the address; every 2.5 s poll re-hung on the same dead
      // address forever. OUR timer classifying the hang is what arms failover + cooldown; the
      // +1000 keeps this caller signal the walk's hard cap, just strictly after attempt 0.
      const t = timed(BALANCE_TIMEOUT_MS + 1000);
      try {
        try {
          const r = await relayFetch(relayUrl, `/api/v1/balances/${publicHex}`, {signal: t.signal}, BALANCE_TIMEOUT_MS);
          if (r.ok) {
            // The body is a flat {currency: minor-units-string} map (JSON keys are strings). A parse
            // failure / non-object body is treated like an offline blip (no state change to balances).
            const j: unknown = await r.json().catch(() => null);
            const map = (j && typeof j === 'object' && !Array.isArray(j)) ? j as Record<string, string> : null;
            if (!map) { if (!staleFailure()) setOnline(false); return; }
            // Primary (currency 0): a successful read sets the balance + flips online + resets the
            // DEMO offline deduction (the authoritative balance replaces the optimistic local view).
            // A missing/non-string primary in an otherwise-200 batch → offline (primary ledger hiccup).
            const primary = map['0'];
            if (fresh() && typeof primary === 'string') {
              successCount++; // completed success — retires every still-in-flight sibling timeout
              setBalance(primary);
              setOnline(true);
              setOfflineSpent(prev => prev[0] != null && prev[0] !== '0' ? {...prev, 0: '0'} : prev);
            } else if (!staleFailure()) {
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
            if (!staleFailure()) setOnline(false);
          }
        } finally { t.stop(); }
      } catch (e) { console.warn('balance poll failed:', e instanceof Error ? e.message : String(e)); if (!staleFailure()) setOnline(false); }
    };
    poll(); const id = setInterval(poll, POLL.balance);
    // Manual-refresh handle (2026-08-16 zero-funds UX): the fund-first panel's "Check again" re-fires
    // the CURRENT poll immediately instead of waiting for the next POLL.tick. The ref always points at
    // the live effect's poll (generation-gated by `fresh()` inside), so a stale relay's handle can
    // never write after a retarget.
    pollRef.current = poll;
    return () => { alive = false; clearInterval(id); ctrl.abort(); pollRef.current = null; };
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

  // Manual refresh for the fund-first panel's "Check again" (same shape as the SOL rail's
  // refreshSol — an immediate re-poll, generation-safe).
  const refresh = useCallback(() => { pollRef.current?.(); }, []);

  return {balance, online, assetBalances, offlineSpent, markOfflinePaid, resetDeduction, setBalance, setOnline, refresh};
}
