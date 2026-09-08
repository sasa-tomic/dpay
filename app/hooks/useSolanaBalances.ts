import {useCallback, useEffect, useRef, useState} from 'react';
import {POLL} from '../config/constants';
import {getSolanaBalance, getSolanaTokenBalance} from '../solana';
import type {SolanaTokenBalanceResult} from '../solana';
import {loadSolTokenState, recordSolTokenFact} from '../services/solTokenStatePersist';

/** SOL rail balance status — distinct from the token status (plan invariant #10). */
export type SolBalanceStatus = 'loading' | 'ok' | 'unavailable' | 'error';

/** SPL-token rail balance status — keeps "absent" distinct from "balance" with a zero amount, and
 *  both distinct from "unavailable" (offline/incoherent) and "error" (RPC failure). */
export type SolTokenStatus = 'loading' | 'absent' | 'balance' | 'unavailable' | 'error';

export type SolBalanceState = {balance: string | null; status: SolBalanceStatus};
export type SolTokenBalanceState = {amount: string | null; decimals: number | null; status: SolTokenStatus};

/** Back-compat alias: the per-mint token state carries the exact shape the former USDC-only state
 *  had (same statuses, same invariants — absent ≠ zero, error preserves amount). */
export type SolUsdcBalanceState = SolTokenBalanceState;
export type SolUsdcStatus = SolTokenStatus;

/** The default state of a mint's row before its first result (also the state of a mint dropped
 *  from the visible list: no claim is made about a token the wallet no longer shows). */
const TOKEN_IDLE: SolTokenBalanceState = {amount: null, decimals: null, status: 'loading'};

/**
 * Polls native SOL lamports AND the device's per-mint SPL token balances CONCURRENTLY with
 * INDEPENDENT statuses, generation guards, and AbortControllers (Phase 2 — 2026-08-12 unified
 * asset selection rewrite; generalized per-mint 2026-09-06).
 *
 * Separate effects (NOT one combined effect) so a SOL stub change does NOT disturb any token
 * status and vice versa; targeted `refreshSol` / `refreshToken` let a confirmed SOL send refresh
 * SOL only and a confirmed SPL send refresh exactly its mint.
 *
 * `mints` is the list of mint pubkeys to poll — supplied by the Wallet from the VISIBLE solana
 * assets (the catalog rows with a mint). A mint entering the list starts polling it; a mint
 * leaving the list drops its row. One effect per LIST identity, one generation guard for the
 * whole set (a list change aborts every in-flight read for the old set and restarts clean).
 *
 * Invariants honored (plan Phase 2, per mint):
 *  - missing token account → `status: 'absent'` (NOT 'error', NOT a zeroed balance — a known zero).
 *  - a CONFIRMED result ('absent' | 'balance') is a FACT and is persisted (services/
 *    solTokenStatePersist) + never downgraded: a later degraded poll ('offline'/'error') keeps
 *    the last fact instead of flipping the status (only the owner can close an ATA, and dpay has
 *    no close path — so an existence fact cannot silently go stale).
 *  - on (re)start the rows seed from the persisted store — an offline restart keeps the gate
 *    (config/assets.ts solSplSignGate) working instead of failing open from 'loading'.
 *  - RPC failure with NO known fact preserves the prior amount (status flips to 'error', the
 *    amount is kept — it NEVER turns a prior value into zero).
 *  - offline (RPC URL empty / mint incoherent) → `status: 'unavailable'` (same no-fact rule);
 *    the seam no-ops without touching the network (the hook does not re-verify that — it's the
 *    seam's job).
 *  - generation guard: changing `solAddress` / `secretHex` / the mint list aborts in-flight
 *    requests and drops any stale result that resolves after the switch.
 *
 * `solAddress` (already-derived or null) drives the SOL effect; `secretHex` drives the token
 * effect (ATA derivation needs the seed). Both null → both rails idle (`loading`, no polling).
 */
export function useSolanaBalances(
  secretHex: string | null,
  solAddress: string | null,
  mints: string[],
): {
  sol: SolBalanceState;
  tokens: Record<string, SolTokenBalanceState>;
  refreshSol: () => void;
  refreshToken: (mint: string) => void;
  refreshTokens: () => void;
} {
  const [sol, setSol] = useState<SolBalanceState>({balance: null, status: 'loading'});
  const [tokens, setTokens] = useState<Record<string, SolTokenBalanceState>>({});
  const solGenRef = useRef(0);
  const tokenGenRef = useRef(0);
  const [solTick, setSolTick] = useState(0);
  const [tokenTick, setTokenTick] = useState(0);
  // The live single-mint poll entry point, assigned by the effect below. `refreshToken` calls it
  // directly so a targeted refresh NEVER restarts the set's effect (which would flash every other
  // mint through 'loading').
  const pollMintRef = useRef<((mint: string) => void) | null>(null);
  // Stable list identity: the effect must not restart on every render when the caller passes a
  // fresh array of the same mints.
  const mintKey = mints.join(',');

  // --- SOL effect: independent generation guard + AbortController + interval ---
  useEffect(() => {
    if (!solAddress) {
      setSol({balance: null, status: 'loading'});
      return;
    }
    let alive = true;
    const gen = ++solGenRef.current;
    const ctrl = new AbortController();
    const fresh = () => alive && gen === solGenRef.current;
    // In-flight guard: a tick that arrives while the previous read is still outstanding is SKIPPED,
    // not queued. Without it a slow endpoint raises the request rate instead of lowering it — the
    // 8-reads-in-20s-with-3-concurrent behaviour measured against a 6s-latency RPC (2026-09-08),
    // which is exactly how a rate limit stays open. It defers, it never disables: the next tick
    // after the read answers polls normally.
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const b = await getSolanaBalance(solAddress, ctrl.signal);
        if (!fresh()) return;
        if (b === null) {
          // The seam returns null only when SOLANA_RPC_URL is empty (offline). Distinct from a throw.
          setSol({balance: null, status: 'unavailable'});
        } else {
          setSol({balance: b, status: 'ok'});
        }
      } catch (e) {
        console.warn(`useSolanaBalances SOL poll failed for ${solAddress}:`, e instanceof Error ? e.message : String(e));
        if (!fresh()) return;
        // Preserve the prior balance (do NOT zero it — plan line ~189). Only flip the status.
        setSol((prev) => ({balance: prev.balance, status: 'error'}));
      } finally {
        inFlight = false;
      }
    };
    poll();
    const id = setInterval(poll, POLL.balance);
    return () => { alive = false; clearInterval(id); ctrl.abort(); };
  }, [solAddress, solTick]);

  // --- per-mint token effect: one generation guard for the whole mint set ---
  useEffect(() => {
    const mints = mintKey.split(',').filter(m => m.length > 0);
    if (!secretHex || mints.length === 0) {
      setTokens({});
      return;
    }
    let alive = true;
    const gen = ++tokenGenRef.current;
    const ctrl = new AbortController();
    const fresh = () => alive && gen === tokenGenRef.current;
    // Persisted last-known facts (memoized storage read). Populated async; until it lands, rows
    // poll as before ('loading' → first result). A fact here is a sticky existence proof — see
    // services/solTokenStatePersist.ts.
    const persistedFacts: Record<string, SolTokenBalanceState> = {};
    void loadSolTokenState().then((store) => {
      if (!fresh()) return;
      for (const [mint, f] of Object.entries(store)) {
        persistedFacts[mint] = {amount: f.amount, decimals: f.decimals, status: f.status};
      }
      // Re-seed any row still in a NON-fact state (loading, or degraded by a first poll that
      // raced this load) with its persisted fact — the offline-restart seeding path.
      setTokens((prev) => {
        const next: Record<string, SolTokenBalanceState> = {};
        let changed = false;
        for (const mint of mints) {
          const live = prev[mint];
          const pf = persistedFacts[mint];
          if (live != null && (live.status === 'absent' || live.status === 'balance')) {
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
    // The SOL effect's in-flight guard, per mint: one outstanding read each, so a stuck mint skips
    // its own ticks without ever stalling a sibling (see that effect for why the guard exists).
    const inFlight = new Set<string>();
    const pollMint = async (mint: string) => {
      if (inFlight.has(mint)) return;
      inFlight.add(mint);
      try {
        const r: SolanaTokenBalanceResult = await getSolanaTokenBalance(secretHex, mint, ctrl.signal);
        if (!fresh()) return;
        switch (r.kind) {
          case 'absent':
            setTokens((prev) => ({...prev, [mint]: {amount: null, decimals: null, status: 'absent'}}));
            void recordSolTokenFact(mint, {status: 'absent', amount: null, decimals: null, at: Date.now()});
            break;
          case 'balance':
            setTokens((prev) => ({...prev, [mint]: {amount: r.amount, decimals: r.decimals, status: 'balance'}}));
            void recordSolTokenFact(mint, {status: 'balance', amount: r.amount, decimals: r.decimals, at: Date.now()});
            break;
          case 'offline':
          case 'error': {
            // Degraded result — it observes NOTHING. A live fact stays (never downgraded);
            // else a persisted fact seeds the row; else today's degraded shape.
            const status = r.kind === 'offline' ? 'unavailable' : 'error';
            setTokens((prev) => {
              const live = prev[mint];
              if (live != null && (live.status === 'absent' || live.status === 'balance')) return prev;
              const pf = persistedFacts[mint];
              if (pf) return {...prev, [mint]: pf};
              return {...prev, [mint]: {...(live ?? TOKEN_IDLE), status}};
            });
            break;
          }
        }
      } catch (e) {
        console.warn(`useSolanaBalances token poll failed for mint ${mint}:`, e instanceof Error ? e.message : String(e));
        if (!fresh()) return;
        setTokens((prev) => {
          const live = prev[mint];
          if (live != null && (live.status === 'absent' || live.status === 'balance')) return prev;
          const pf = persistedFacts[mint];
          if (pf) return {...prev, [mint]: pf};
          return {...prev, [mint]: {...(live ?? TOKEN_IDLE), status: 'error'}};
        });
      } finally {
        inFlight.delete(mint);
      }
    };
    pollMintRef.current = (mint: string) => { pollMint(mint); };
    // Seed ONLY the membership delta (a newly-visible mint reads 'loading', never a stale row;
    // a mint still in the list KEEPS its displayed state — no flash on list churn), and drop rows
    // for mints that left the visible list.
    setTokens((prev) => {
      const next: Record<string, SolTokenBalanceState> = {};
      for (const mint of mints) next[mint] = prev[mint] ?? TOKEN_IDLE;
      return next;
    });
    for (const mint of mints) pollMint(mint);
    const id = setInterval(() => { for (const mint of mints) pollMint(mint); }, POLL.balance);
    return () => {
      alive = false;
      clearInterval(id);
      ctrl.abort();
      if (pollMintRef.current && tokenGenRef.current === gen) pollMintRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secretHex, mintKey, tokenTick]);

  const refreshSol = useCallback(() => setSolTick((t) => t + 1), []);
  // Targeted per-mint refresh (a confirmed SPL send refreshes exactly its mint). Goes through the
  // live poll entry point — guarded by the CURRENT generation, aborting with the set's controller.
  const refreshToken = useCallback((mint: string) => {
    pollMintRef.current?.(mint);
  }, []);
  // Refresh every tracked mint at once (the pre-send recheck path).
  const refreshTokens = useCallback(() => setTokenTick((t) => t + 1), []);
  return {sol, tokens, refreshSol, refreshToken, refreshTokens};
}
