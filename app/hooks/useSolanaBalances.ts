import {useCallback, useEffect, useRef, useState} from 'react';
import {POLL} from '../config/constants';
import {getSolanaBalance, getSolanaUsdcBalance} from '../solana';
import type {SolanaUsdcBalanceResult} from '../solana';

/** SOL rail balance status — distinct from the USDC status (plan invariant #10). */
export type SolBalanceStatus = 'loading' | 'ok' | 'unavailable' | 'error';

/** USDC rail balance status — keeps "absent" distinct from "balance" with a zero amount, and both
 *  distinct from "unavailable" (offline/incoherent) and "error" (RPC failure). */
export type SolUsdcStatus = 'loading' | 'absent' | 'balance' | 'unavailable' | 'error';

export type SolBalanceState = {balance: string | null; status: SolBalanceStatus};
export type SolUsdcBalanceState = {amount: string | null; decimals: number | null; status: SolUsdcStatus};

/**
 * Polls native SOL lamports AND the device's USDC ATA balance CONCURRENTLY with INDEPENDENT statuses,
 * generation guards, and AbortControllers (Phase 2 — 2026-08-12 unified asset selection rewrite).
 *
 * Replaces the single-value `useSolanaBalance` hook. Two separate effects (NOT one combined effect)
 * so a SOL stub change does NOT disturb the USDC status and vice versa; targeted `refreshSol` /
 * `refreshUsdc` let a confirmed SOL send refresh SOL only and a confirmed SPL send refresh USDC only.
 *
 * Invariants honored (plan Phase 2):
 *  - missing ATA → `usdc.status: 'absent'` (NOT 'error', NOT a zeroed balance — a known zero).
 *  - RPC failure preserves the prior value (status flips to 'error', the amount/balance is kept —
 *    it NEVER turns a prior value into zero; line ~189).
 *  - offline (RPC URL empty) → `sol.status: 'unavailable'`, `usdc.status: 'unavailable'`; the seam
 *    no-ops without touching the network (the hook does not re-verify that — it's the seam's job).
 *  - generation guard: changing `solAddress` / `secretHex` aborts in-flight requests and drops any
 *    stale result that resolves after the switch (the captured `gen` no longer matches `genRef`).
 *
 * `solAddress` (already-derived or null) drives the SOL effect; `secretHex` drives the USDC effect
 * (USDC ATA derivation needs the seed). Both null → both rails idle (`loading`, no polling).
 */
export function useSolanaBalances(
  secretHex: string | null,
  solAddress: string | null,
): {
  sol: SolBalanceState;
  usdc: SolUsdcBalanceState;
  refreshSol: () => void;
  refreshUsdc: () => void;
} {
  const [sol, setSol] = useState<SolBalanceState>({balance: null, status: 'loading'});
  const [usdc, setUsdc] = useState<SolUsdcBalanceState>({amount: null, decimals: null, status: 'loading'});
  const solGenRef = useRef(0);
  const usdcGenRef = useRef(0);
  const [solTick, setSolTick] = useState(0);
  const [usdcTick, setUsdcTick] = useState(0);

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
    const poll = async () => {
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
      }
    };
    poll();
    const id = setInterval(poll, POLL.balance);
    return () => { alive = false; clearInterval(id); ctrl.abort(); };
  }, [solAddress, solTick]);

  // --- USDC effect: independent generation guard + AbortController + interval ---
  useEffect(() => {
    if (!secretHex) {
      setUsdc({amount: null, decimals: null, status: 'loading'});
      return;
    }
    let alive = true;
    const gen = ++usdcGenRef.current;
    const ctrl = new AbortController();
    const fresh = () => alive && gen === usdcGenRef.current;
    const poll = async () => {
      try {
        const r: SolanaUsdcBalanceResult = await getSolanaUsdcBalance(secretHex, ctrl.signal);
        if (!fresh()) return;
        switch (r.kind) {
          case 'offline':
            setUsdc({amount: null, decimals: null, status: 'unavailable'});
            break;
          case 'absent':
            setUsdc({amount: null, decimals: null, status: 'absent'});
            break;
          case 'balance':
            setUsdc({amount: r.amount, decimals: r.decimals, status: 'balance'});
            break;
          case 'error':
            // Preserve the prior amount + decimals (do NOT zero — plan line ~189).
            setUsdc((prev) => ({amount: prev.amount, decimals: prev.decimals, status: 'error'}));
            break;
        }
      } catch (e) {
        console.warn(`useSolanaBalances USDC poll failed:`, e instanceof Error ? e.message : String(e));
        if (!fresh()) return;
        setUsdc((prev) => ({amount: prev.amount, decimals: prev.decimals, status: 'error'}));
      }
    };
    poll();
    const id = setInterval(poll, POLL.balance);
    return () => { alive = false; clearInterval(id); ctrl.abort(); };
  }, [secretHex, usdcTick]);

  const refreshSol = useCallback(() => setSolTick((t) => t + 1), []);
  const refreshUsdc = useCallback(() => setUsdcTick((t) => t + 1), []);
  return {sol, usdc, refreshSol, refreshUsdc};
}
