import {useCallback, useEffect, useRef, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {POLL} from '../config/constants';
import {classifyTransportFailure, readSolanaBalances} from '../solana';
import type {SolanaBalancesRead, SolanaReadFailure, SolanaTokenBalanceResult} from '../solana';
import {loadSolTokenState, recordSolTokenFact} from '../services/solTokenStatePersist';
import {usePollCadence} from './usePollCadence';

/** Storage key for the cross-restart NATIVE-SOL balance cache (founder requirement 2026-09-15 #3).
 *  Keyed by secretHex — the same identity the rail derives its accounts from (token FACTS have
 *  their own store, services/solTokenStatePersist, which already survives restart). */
const SOL_BALANCE_CACHE_PREFIX = 'dpay.solbalance.v1';
const solBalanceCacheKey = (secretHex: string): string => `${SOL_BALANCE_CACHE_PREFIX}.${secretHex}`;

type SolBalanceCache = {at: number; balance: string};

// Best-effort by the house convention (txNotes/pendingPays): an unreadable or corrupt cache is
// simply absent — never an exception into the poll that asked for it.
async function loadSolBalanceCache(secretHex: string): Promise<SolBalanceCache | null> {
  try {
    const raw = await AsyncStorage.getItem(solBalanceCacheKey(secretHex));
    if (raw === null) return null;
    const j: unknown = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const c = j as Record<string, unknown>;
    if (typeof c.at !== 'number' || !Number.isFinite(c.at)) return null;
    if (typeof c.balance !== 'string' || !/^\d+$/.test(c.balance)) return null;
    return {at: c.at, balance: c.balance};
  } catch {
    return null;
  }
}

function saveSolBalanceCache(secretHex: string, balance: string, at: number): void {
  void AsyncStorage.setItem(solBalanceCacheKey(secretHex), JSON.stringify({at, balance} as SolBalanceCache)).catch(() => {});
}

/** SOL rail balance status — distinct from the token status (plan invariant #10). */
export type SolBalanceStatus = 'loading' | 'ok' | 'unavailable' | 'error';

/** SPL-token rail balance status — keeps "absent" distinct from "balance" with a zero amount, and
 *  both distinct from "unavailable" (offline/incoherent) and "error" (RPC failure). */
export type SolTokenStatus = 'loading' | 'absent' | 'balance' | 'unavailable' | 'error';

/** Native-SOL rail state. `failure` says WHY an 'error' status has no fact (see
 *  `SolanaReadFailure`); null on every other status — the same contract the token rows carry. */
export type SolBalanceState = {balance: string | null; status: SolBalanceStatus; failure: SolanaReadFailure | null};
/** `failure` says WHY an 'error' row has no fact — `refused` (the endpoint answered and did not
 *  serve us: the rail is down and this device is online), `offline` (nothing answered anywhere,
 *  the IC boundary probe included: this phone has no connectivity — the payer's normal state),
 *  `unreachable` (nothing answered on the rail's path while the phone IS online: the service
 *  side), `unreadable` (bytes we cannot trust). Null on every status that is not 'error'. The
 *  SPL sign gate reads it: what a wallet may tell a user about an unverified token account
 *  depends entirely on which of those it is. */
export type SolTokenBalanceState = {
  amount: string | null;
  decimals: number | null;
  status: SolTokenStatus;
  failure: SolanaReadFailure | null;
};

/** Back-compat alias: the per-mint token state carries the exact shape the former USDC-only state
 *  had (same statuses, same invariants — absent ≠ zero, error preserves amount). */
export type SolUsdcBalanceState = SolTokenBalanceState;
export type SolUsdcStatus = SolTokenStatus;

/** The default state of a mint's row before its first result (also the state of a mint dropped
 *  from the visible list: no claim is made about a token the wallet no longer shows). */
const TOKEN_IDLE: SolTokenBalanceState = {amount: null, decimals: null, status: 'loading', failure: null};

/** A confirmed existence fact — the only states that may overwrite a previous one. */
function isFact(s: SolTokenBalanceState | undefined): boolean {
  return s != null && (s.status === 'absent' || s.status === 'balance');
}

/**
 * Polls native SOL lamports AND the device's per-mint SPL token balances in ONE request per tick,
 * at a cadence that reflects what the user is doing, and not at all while the app is backgrounded.
 *
 * ONE REQUEST. `readSolanaBalances` (the seam) reads the wallet account, each mint's token account
 * and each mint's own mint account in a single `getMultipleAccounts`. It replaced a fan-out of one
 * `getBalance` plus two calls per mint — five requests every 2.5 seconds for the three shipped
 * rails, forever, whether or not anyone was looking. What that cost, and what it costs now, is in
 * `docs/specs/2026-09-08-solana-rpc-plan.md`.
 *
 * ONE POLL, TWO STATES. SOL and the tokens come back together, so they are read together; they
 * keep INDEPENDENT statuses because they answer different questions (a decodable token account
 * with unreadable bytes must not blank the SOL balance). `refreshSol` / `refreshToken(mint)` /
 * `refreshTokens` all mean the same thing now — "something just moved, read again NOW" — and all
 * three also hold the fast cadence open for a while, because a send that just confirmed is exactly
 * when a user is watching the number.
 *
 * Invariants honored (plan Phase 2, per mint):
 *  - missing token account → `status: 'absent'` (NOT 'error', NOT a zeroed balance — a known zero).
 *  - a CONFIRMED result ('absent' | 'balance') is a FACT and is persisted (services/
 *    solTokenStatePersist) + never downgraded: a later degraded poll ('offline'/'error') keeps
 *    the last fact instead of flipping the status (only the owner can close a token account, and
 *    dpay has no close path — so an existence fact cannot silently go stale).
 *  - on (re)start the rows seed from the persisted store — an offline restart keeps the gate
 *    (config/assets.ts solSplSignGate) working instead of failing open from 'loading'.
 *  - a failed read with NO known fact preserves the prior amount (status flips to 'error', the
 *    amount is kept — it NEVER turns a prior value into zero) and records WHY it failed.
 *  - offline (RPC URL empty / mint incoherent) → `status: 'unavailable'` (same no-fact rule);
 *    the seam no-ops without touching the network.
 *  - generation guard: changing `solAddress` / `secretHex` / the mint list aborts the in-flight
 *    request and drops any stale result that resolves after the switch.
 *
 * `solAddress` (already-derived or null) is the rail's on/off switch — no device key, no polling;
 * `secretHex` is what the seam derives the wallet's own accounts from.
 */
export function useSolanaBalances(
  secretHex: string | null,
  solAddress: string | null,
  mints: string[],
): {
  sol: SolBalanceState;
  tokens: Record<string, SolTokenBalanceState>;
  /** Date.now() of the last successful read (0 until one lands — including a cache hydrate, which
   *  seeds it with the CACHED `at`). The freshness authority for the SOL rail's approx marker and
   *  its pending-payment subtraction: one clock for both consumers, the IC poll's `atByCurrency`
   *  made per-rail. */
  freshAt: number;
  refreshSol: () => void;
  refreshToken: (mint: string) => void;
  refreshTokens: () => void;
} {
  const [sol, setSol] = useState<SolBalanceState>({balance: null, status: 'loading', failure: null});
  const [tokens, setTokens] = useState<Record<string, SolTokenBalanceState>>({});
  const [freshAt, setFreshAt] = useState(0);
  const genRef = useRef(0);
  // The live poll, assigned by the effect below and driven by the cadence hook. Held in a ref so
  // the cadence never restarts just because this component re-rendered.
  const pollRef = useRef<() => void>(() => {});
  // Stable list identity: the effect must not restart on every render when the caller passes a
  // fresh array of the same mints.
  const mintKey = mints.join(',');
  const enabled = secretHex !== null && solAddress !== null;

  useEffect(() => {
    if (!enabled || secretHex === null) {
      setSol({balance: null, status: 'loading', failure: null});
      setTokens({});
      setFreshAt(0);
      pollRef.current = () => {};
      return;
    }
    const mintList = mintKey.split(',').filter(m => m.length > 0);
    let alive = true;
    const gen = ++genRef.current;
    const ctrl = new AbortController();
    const fresh = () => alive && gen === genRef.current;

    // Persisted last-known facts (memoized storage read). Populated async; until it lands, rows
    // poll as before ('loading' → first result). A fact here is a sticky existence proof — see
    // services/solTokenStatePersist.ts.
    const persistedFacts: Record<string, SolTokenBalanceState> = {};
    void loadSolTokenState().then((store) => {
      if (!fresh()) return;
      for (const [mint, f] of Object.entries(store)) {
        persistedFacts[mint] = {amount: f.amount, decimals: f.decimals, status: f.status, failure: null};
      }
      // Re-seed any row still in a NON-fact state (loading, or degraded by a first poll that
      // raced this load) with its persisted fact — the offline-restart seeding path.
      setTokens((prev) => {
        const next: Record<string, SolTokenBalanceState> = {};
        let changed = false;
        for (const mint of mintList) {
          const live = prev[mint];
          const pf = persistedFacts[mint];
          if (isFact(live)) {
            next[mint] = live;
          } else if (pf) {
            next[mint] = pf;
            changed = true;
          } else {
            next[mint] = live ?? TOKEN_IDLE;
          }
        }
        return changed ? next : prev;
      });
    });

    // Founder requirement #3 — hydrate the last good NATIVE-SOL read (tokens seed above; the
    // native balance had no cross-restart home, so a funded-at-home wallet opened offline showed
    // '—'). Seeded as status 'ok' so it RENDERS; its age travels via freshAt (seeded from the
    // cache's own `at`) and the approx marker says "stale" once it is. Only seeds the virgin
    // 'loading' row — a real read that raced the cache wins.
    void loadSolBalanceCache(secretHex).then((cached) => {
      if (!fresh() || cached === null) return;
      setSol((prev) => (prev.status === 'loading' && prev.balance == null ? {balance: cached.balance, status: 'ok', failure: null} : prev));
      setFreshAt((prev) => (prev === 0 ? cached.at : prev));
    });

    // Seed ONLY the membership delta (a newly-visible mint reads 'loading', never a stale row;
    // a mint still in the list KEEPS its displayed state — no flash on list churn), and drop rows
    // for mints that left the visible list.
    setTokens((prev) => {
      const next: Record<string, SolTokenBalanceState> = {};
      for (const mint of mintList) next[mint] = prev[mint] ?? TOKEN_IDLE;
      return next;
    });

    // In-flight guard: a tick that arrives while the previous read is still outstanding is
    // SKIPPED, not queued. Without it a slow endpoint raises the request rate instead of lowering
    // it — the 8-reads-in-20s-with-3-concurrent behaviour measured against a 6s-latency RPC
    // (2026-09-08), which is exactly how a rate limit stays open. It defers, it never disables:
    // the next tick after the read answers polls normally.
    let inFlight = false;
    /** One degraded token result: it observes NOTHING. A live fact stays (never downgraded); else
     *  a persisted fact seeds the row; else today's degraded shape, carrying the reason. */
    const degrade = (mint: string, status: SolTokenStatus, failure: SolanaReadFailure | null) =>
      setTokens((prev) => {
        const live = prev[mint];
        if (isFact(live)) return prev;
        const pf = persistedFacts[mint];
        if (pf) return {...prev, [mint]: pf};
        return {...prev, [mint]: {...(live ?? TOKEN_IDLE), status, failure}};
      });

    const applyToken = (mint: string, r: SolanaTokenBalanceResult) => {
      switch (r.kind) {
        case 'absent':
          setTokens((prev) => ({...prev, [mint]: {amount: null, decimals: null, status: 'absent', failure: null}}));
          void recordSolTokenFact(mint, {status: 'absent', amount: null, decimals: null, at: Date.now()});
          break;
        case 'balance':
          setTokens((prev) => ({...prev, [mint]: {amount: r.amount, decimals: r.decimals, status: 'balance', failure: null}}));
          void recordSolTokenFact(mint, {status: 'balance', amount: r.amount, decimals: r.decimals, at: Date.now()});
          break;
        case 'offline':
          degrade(mint, 'unavailable', null);
          break;
        case 'error':
          degrade(mint, 'error', r.failure);
          break;
      }
    };

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const read: SolanaBalancesRead = await readSolanaBalances(
          secretHex,
          mintList,
          ctrl.signal,
        );
        if (!fresh()) return;
        switch (read.sol.kind) {
          case 'lamports': {
            setSol({balance: read.sol.lamports, status: 'ok', failure: null});
            // The ONE successful-read clock for the rail: the approx marker's staleness test and
            // the pending-payment subtraction's "has an authoritative read postdated the hand-off?"
            // test both read it. Also the cross-restart cache write (founder requirement #3).
            const at = Date.now();
            setFreshAt(at);
            saveSolBalanceCache(secretHex, read.sol.lamports, at);
            break;
          }
          case 'offline':
            // The seam returns 'offline' only when `solanaRpcUrl()` is empty. Distinct from a failure.
            // PRESERVE a prior/hydrated balance (founder requirement #3): the wallet keeps its
            // number, the 'unavailable' status + the aging freshAt clock carry that it is not
            // verified live — solView renders it approx-marked instead of '—'.
            setSol((prev) => ({balance: prev.balance, status: 'unavailable', failure: null}));
            break;
          case 'error': {
            // Preserve the prior balance (do NOT zero it). Only the status flips — WITH the cause
            // (captured before the callback: the closure would re-widen the union).
            const {failure} = read.sol;
            setSol((prev) => ({balance: prev.balance, status: 'error', failure}));
            break;
          }
        }
        for (const mint of mintList) {
          const r = read.tokens[mint];
          if (r === undefined) {
            // The seam answers for every mint it was asked about; a gap is a wiring error, not a
            // balance, and it is never rendered as one.
            console.warn(`useSolanaBalances: no result for mint ${mint} — the read answered for ${Object.keys(read.tokens).join(',')}`);
            degrade(mint, 'error', 'unreadable');
            continue;
          }
          applyToken(mint, r);
        }
      } catch (e) {
        // The seam classifies its own failures and RETHROWS caller aborts (audit F6): an aborted
        // read is the cleanup path, not a poll failure — classify nothing, log nothing.
        if (ctrl.signal.aborted || !fresh()) return;
        // Reaching here with a live signal is a defect in the seam.
        console.warn(`useSolanaBalances poll threw for ${solAddress}:`, e instanceof Error ? e.message : String(e));
        // The oracle decides the cause — never a hard-coded guess. Wrapped so a defect in the
        // oracle can never turn a defect here into a crash: if it throws, 'unreachable' stands.
        let failure: SolanaReadFailure = 'unreachable';
        try {
          failure = await classifyTransportFailure();
        } catch {
          failure = 'unreachable';
        }
        if (!fresh()) return;
        setSol((prev) => ({balance: prev.balance, status: 'error', failure}));
        for (const mint of mintList) degrade(mint, 'error', failure);
      } finally {
        inFlight = false;
      }
    };
    pollRef.current = () => { void poll(); };

    return () => {
      alive = false;
      ctrl.abort();
      pollRef.current = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, secretHex, solAddress, mintKey]);

  // The cadence: active around a money flow, idle otherwise, stopped while backgrounded. Declared
  // AFTER the effect above so the poll it drives is already assigned when it fires the first read.
  const pollNow = usePollCadence(
    useCallback(() => pollRef.current(), []),
    enabled,
    POLL.balance,
    POLL.balanceIdle,
    `${secretHex ?? ''}|${solAddress ?? ''}|${mintKey}`,
  );

  // The three refresh entry points are the same act — "something moved, read again now" — and are
  // kept distinct only because their callers are (a confirmed SOL send, a confirmed token send, a
  // user-pressed recheck). One request answers for every rail, so splitting them would buy nothing
  // but extra requests.
  const refreshSol = pollNow;
  const refreshToken = useCallback((_mint: string) => pollNow(), [pollNow]);
  const refreshTokens = pollNow;
  return {sol, tokens, freshAt, refreshSol, refreshToken, refreshTokens};
}
