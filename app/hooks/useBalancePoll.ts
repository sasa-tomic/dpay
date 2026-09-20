import {useCallback, useEffect, useRef, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {type CurrencyDescriptor} from '../config/catalog';
import {POLL, BALANCE_TIMEOUT_MS, BALANCE_OFFLINE_AFTER_FAILURES} from '../config/constants';
import {relayFetch} from '../services/relay';

type Args = {
  relayUrl: string;
  publicHex: string;
  displayAssets: CurrencyDescriptor[];
  displayCurrencyIds: string;
};

/** The storage key prefix for the cross-restart balance cache (founder requirement 2026-09-15 #3). */
const BALANCE_CACHE_PREFIX = 'dpay.balances.v1';

type BalanceCache = {at: number; balance: string | null; assetBalances: Record<number, string>};

const balanceCacheKey = (publicHex: string): string => `${BALANCE_CACHE_PREFIX}.${publicHex}`;

// Best-effort cache read (the txNotes convention): a corrupt or unreadable cache degrades to
// "nothing cached" — a cold start, which the app already handles — never an exception into the
// first render.
async function loadBalanceCache(publicHex: string): Promise<BalanceCache | null> {
  try {
    const raw = await AsyncStorage.getItem(balanceCacheKey(publicHex));
    if (raw === null) return null;
    const j: unknown = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const c = j as Record<string, unknown>;
    if (typeof c.at !== 'number' || !Number.isFinite(c.at)) return null;
    const balance = typeof c.balance === 'string' || c.balance === null ? c.balance : null;
    const assets = (c.assetBalances && typeof c.assetBalances === 'object' && !Array.isArray(c.assetBalances))
      ? Object.fromEntries(Object.entries(c.assetBalances as Record<string, unknown>).filter(([, v]) => typeof v === 'string') as [string, string][])
      : {};
    const assetBalances: Record<number, string> = {};
    for (const k of Object.keys(assets)) {
      const n = Number(k);
      if (Number.isInteger(n) && n >= 0) assetBalances[n] = assets[k];
    }
    return {at: c.at, balance, assetBalances};
  } catch {
    return null;
  }
}

/**
 * The primary (`$` DEMO) + per-asset balance poll. Extracted from Wallet.tsx (Effect B):
 *   - SINGLE batch fetch (`GET /api/v1/balances/<account>`) returns EVERY catalog currency's balance
 *     in one response — replacing the old N+1 loop (1 primary fetch + 1 per-asset, each a relay→IC
 *     round trip). With 6 production currencies that's 1 HTTP request per poll instead of 6.
 *   - The relay fans the per-currency ledger queries out concurrently + best-effort (a hiccup on one
 *     asset's ledger OMITS it from the response, never failing the whole batch), so a slow ledger for
 *     one asset never flips the primary offline. A missing entry keeps the prior value (no flap).
 *   - The effect dep is `displayCurrencyIds` (a stable STRING signature), NOT `displayAssets` (a new
 *     array each render) — so the poll resets only when a currency is added/removed, not every frame.
 *   - Relay-retarget race fix (OPEN_ISSUES #6): on teardown (relayUrl/displayCurrencyIds change) the
 *     effect aborts the in-flight batch fetch via an AbortController, and a generation ref rejects any
 *     poll whose result lands after a newer generation started. This closes the window where an old
 *     relay's slow in-flight poll could resolve after the new relay's poll and shadow the new balance
 *     (the `alive` closure flag is retained as a secondary gate).
 *
 * 2026-09-15 offline-payments completion:
 *   - The EPHEMERAL `offlineSpent`/`markOfflinePaid` deduction is GONE. The offline debit now lives
 *     in the persisted outbox (services/pendingPays) and Wallet derives the subtraction from those
 *     records against `atByCurrency`: a handed-off payment subtracts until a SUCCESSFUL POLL for its
 *     asset lands AFTER the hand-off (`at > record.ts`) — the same per-currency "authoritative
 *     balance replaces the optimistic view" reset the ephemeral map had, now timestamp-driven so it
 *     survives a restart and fixes the off-by-fee (the record carries the GROSS; the old funnel
 *     subtracted the bare wire). In-session immediacy is unchanged in practice: the outbox write
 *     announces and the usePendingPays subscription re-reads within one storage round-trip.
 *   - `atByCurrency` records Date.now() per currency on every successful read (primary included, as
 *     key 0). It is the freshness authority for BOTH the offline subtraction above and the
 *     APPROXIMATE marker (a view whose data is older than 60 s renders "~", founder requirement #2).
 *     On a cache hit it is seeded from the cache's own `at` — a hydrate is a fact about the PAST.
 *   - CROSS-RESTART CACHE (founder requirement #3): the last good read is persisted per identity on
 *     every successful poll and hydrated on mount BEFORE the first poll can answer, so a wallet
 *     funded at home and opened offline in the city shows real numbers (and the fund gate passes).
 *     `setBalance` (the faucet topUp path) bumps key 0's timestamp too — the faucet response is an
 *     authoritative read, and a pending DEMO hand-off must stop subtracting against it exactly as it
 *     would against a poll.
 *   - OFFLINE = N CONSECUTIVE FAILURES (F4, 2026-09-20): ONE failed poll is a blip — a dropped
 *     response must not read as "the rail is down" and must never replace a mid-flow form (the SOL
 *     send sheet) with the offline panel. `setOnline(false)` fires only on
 *     BALANCE_OFFLINE_AFTER_FAILURES consecutive OBSERVED failures (stale/retired attempts count
 *     for nothing, per the overlap rule above); any success resets the streak and flips online
 *     instantly. The manual refresh ("Check again") path is untouched.
 */
export function useBalancePoll(args: Args): {
  balance: string | null;
  online: boolean;
  assetBalances: Record<number, string>;
  atByCurrency: Record<number, number>;
  setBalance: (b: string | null) => void;
  setOnline: (o: boolean) => void;
  refresh: () => void;
} {
  const {relayUrl, publicHex, displayAssets, displayCurrencyIds} = args;
  const [balance, setBalanceState] = useState<string | null>(null);
  // Non-primary assets — each is a SEPARATE asset on a separate ledger, polled in parallel on the
  // same cadence. A "0" entry means "not yet funded"; the card still renders (muted) so the full
  // asset rail is always visible. MC1 units 2-4: balances are raw-u64 decimal STRINGS (never number).
  const [assetBalances, setAssetBalances] = useState<Record<number, string>>({});
  const [online, setOnline] = useState(false);
  // Date.now() of the last SUCCESSFUL read per currency (key 0 = the primary). Drives the offline
  // subtraction's "has an authoritative balance landed since the hand-off?" test and the approx
  // marker's staleness test — one timestamp, both consumers.
  const [atByCurrency, setAtByCurrency] = useState<Record<number, number>>({});

  // Relay-retarget race fix (OPEN_ISSUES #6): a monotonically-increasing generation id. Every effect
  // run captures its generation; before ANY state write, a poll re-checks the ref — if a newer
  // generation started (relayUrl/displayCurrencyIds changed under it), the result is from a STALE
  // relay and is dropped. This is a value-level gate that survives any ordering of microtask
  // scheduling between the old poll's `.then()` and React's commit phase, closing the window the
  // `alive` closure flag alone could not fully cover.
  const genRef = useRef(0);
  // Latest poll of the CURRENT effect (null between effects) — the "Check again" escape hatch.
  const pollRef = useRef<(() => Promise<void>) | null>(null);
  // Date.now() of the last SUCCESSFUL read this mount (any generation) — 0 until one lands. The
  // hydrate effect reads it to know whether a fresh poll beat the cache to the state (then the
  // cache is strictly older information and stays unused).
  const lastSuccessAtRef = useRef(0);
  // Mirror of the asset map for the non-React setBalance path (the faucet persist needs the
  // current assets; a state read inside the callback would be a stale closure).
  const assetBalancesRef = useRef(assetBalances);
  assetBalancesRef.current = assetBalances;

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
    // F4 (2026-09-20): a single failed poll is a BLIP, not a reachability fact — the old
    // rule flipped `online=false` on the first miss and a mid-flow SOL send form was
    // replaced by the offline panel behind one dropped response. Failures now COUNT, and
    // only BALANCE_OFFLINE_AFTER_FAILURES consecutive observed failures flip the dot;
    // any success resets the count (recovery was instant before and stays instant).
    let consecutiveFailures = 0;

    const poll = async () => {
      const startSuccesses = successCount;
      // A failure whose poll was overtaken by a sibling SUCCESS (completed after this poll
      // started) is retired, not observed — every failure write below gates on !staleFailure().
      const staleFailure = () => !fresh() || successCount !== startSuccesses;
      // One observed (non-stale) failure: count it, flip offline only at the consecutive
      // threshold. Stale failures — a retired attempt's late timeout — count for nothing.
      const noteFailure = () => {
        if (staleFailure()) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= BALANCE_OFFLINE_AFTER_FAILURES) setOnline(false);
      };
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
            if (!map) { noteFailure(); return; }
            // Primary (currency 0): a successful read sets the balance + flips online + resets the
            // DEMO offline deduction (the authoritative balance replaces the optimistic local view).
            // A missing/non-string primary in an otherwise-200 batch → offline (primary ledger hiccup).
            const primary = map['0'];
            if (fresh() && typeof primary === 'string') {
              successCount++; // completed success — retires every still-in-flight sibling timeout
              consecutiveFailures = 0; // one good answer ends any failure streak
              setBalanceState(primary);
              setOnline(true);
            } else {
              noteFailure();
            }
            if (!fresh()) return;
            // Non-primary assets: merge keeping prior on a missing entry (the relay omits a currency
            // whose ledger hiccupped — best-effort, no flap). Every PRESENT entry (primary included,
            // as key 0) stamps its atByCurrency clock at the same instant — the ONE timestamp both
            // consumers read: the offline subtraction (an outbox record stops subtracting once an
            // authoritative read postdates its hand-off) and the approx marker (a view staler than
            // 60 s renders "~"). This replaces the old per-currency offlineSpent reset with the same
            // "authoritative balance replaces the optimistic view" semantics, timestamp-driven.
            const now = Date.now();
            setAssetBalances(prev => {
              let changed = false;
              const next = {...prev};
              for (const a of displayAssets) {
                const v = map[String(a.currency)];
                if (typeof v === 'string') { next[a.currency] = v; changed = true; }
              }
              return changed ? next : prev;
            });
            setAtByCurrency(() => {
              const next: Record<number, number> = {};
              if (typeof primary === 'string') next[0] = now;
              for (const a of displayAssets) {
                if (typeof map[String(a.currency)] === 'string') next[a.currency] = now;
              }
              return next;
            });
            // Founder requirement #3 — persist the last good read per identity (the cross-restart
            // balance cache). Only a batch that actually answered the primary is worth caching: a
            // primary-less body is a primary-ledger hiccup, and caching it would let a cold offline
            // start hydrate a null DEMO balance. Fire-and-forget best-effort — a failed cache write
            // never disturbs the poll (the txNotes convention).
            if (typeof primary === 'string') {
              lastSuccessAtRef.current = Math.max(lastSuccessAtRef.current, now);
              const cachedAssets: Record<number, string> = {0: primary};
              for (const a of displayAssets) {
                const v = map[String(a.currency)];
                if (typeof v === 'string') cachedAssets[a.currency] = v;
              }
              void AsyncStorage.setItem(balanceCacheKey(publicHex), JSON.stringify({at: now, balance: primary, assetBalances: cachedAssets} as BalanceCache)).catch(() => {});
            }
          } else {
            // Non-2xx: no silent errors — log the status + body so a relay 5xx/4xx is debuggable, then
            // flip offline (the next poll retries). The body is tiny JSON; read best-effort.
            const bodyText = await r.text().catch(() => '<unreadable>');
            console.warn(`balances ${r.status}: ${bodyText}`);
            noteFailure();
          }
        } finally { t.stop(); }
      } catch (e) { console.warn('balance poll failed:', e instanceof Error ? e.message : String(e)); noteFailure(); }
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

  // Founder requirement #3 — hydrate the last good read BEFORE the first poll can answer: a wallet
  // funded at home and opened offline in the city shows its real numbers (and the fund gate
  // passes) instead of '—' until a relay that will never answer times out. The cache's OWN `at`
  // seeds atByCurrency, so the hydrated numbers are honest about their age: approx-marked once
  // older than 60 s, and an outbox hand-off made after the cached read still subtracts. A fresh
  // poll that beat the cache to the state cancels the hydrate (lastSuccessAtRef) — the cache is
  // then strictly older information. Identity switch: the state RESETS first — the cache is
  // per-identity and one identity's balance must never leak into another's, even for a frame.
  useEffect(() => {
    let alive = true;
    setBalanceState(null);
    setAssetBalances({});
    setOnline(false);
    setAtByCurrency({});
    void loadBalanceCache(publicHex).then(cache => {
      if (!alive || cache === null || cache.at <= lastSuccessAtRef.current) return;
      setBalanceState(cache.balance);
      setAssetBalances(cache.assetBalances);
      const seeded: Record<number, number> = {};
      if (cache.balance != null) seeded[0] = cache.at;
      for (const k of Object.keys(cache.assetBalances)) seeded[Number(k)] = cache.at;
      setAtByCurrency(seeded);
    });
    return () => { alive = false; };
  }, [publicHex]);

  // The faucet topUp path: the response carries the new authoritative balance — show it instantly,
  // stamp currency-0's clock (an outbox hand-off must stop subtracting against a credit exactly as
  // it would against a poll; the old resetDeduction call, now derived) and refresh the cache. The
  // next poll overwrites all of it authoritatively.
  const setBalance = useCallback((b: string | null) => {
    setBalanceState(b);
    if (b == null) return;
    const now = Date.now();
    lastSuccessAtRef.current = Math.max(lastSuccessAtRef.current, now);
    setAtByCurrency(prev => ({...prev, 0: now}));
    void AsyncStorage.setItem(balanceCacheKey(publicHex), JSON.stringify({at: now, balance: b, assetBalances: assetBalancesRef.current} as BalanceCache)).catch(() => {});
  }, [publicHex]);

  // Manual refresh for the fund-first panel's "Check again" (same shape as the SOL rail's
  // refreshSol — an immediate re-poll, generation-safe).
  const refresh = useCallback(() => { pollRef.current?.(); }, []);

  return {balance, online, assetBalances, atByCurrency, setBalance, setOnline, refresh};
}
