import {useCallback, useEffect, useRef, useState} from 'react';
import {POLL} from '../config/constants';
import {readEvmBalances, seedEvmPermitNonces, type EvmBalancesRead} from '../evm';
import type {EvmKey, EvmReadFailure} from '../evm';
import {usePollCadence} from './usePollCadence';

/** The per-row storage key: `${chainId}:${token}` — the EvmBalancesRead map's own key shape. */
export const evmBalanceKey = (chainId: number, token: string): string => `${chainId}:${token}`;

/** EVM per-asset balance state. NO 'absent' status (the D10 note): an EVM balanceOf answers 0
 *  for any address, so a known zero is a 'balance' zero — never a zero-by-absence. */
export type EvmTokenStatus = 'loading' | 'balance' | 'unavailable' | 'error';
export type EvmTokenBalanceState = {amount: string | null; decimals: number | null; status: EvmTokenStatus; failure: EvmReadFailure | null};
export type EvmGasStatus = 'loading' | 'ok' | 'unavailable' | 'error';
/** The NATIVE (gas) balance of one chain — the D19 visibility leg (the send sheet's honesty
 *  gate and the receive address's "Gas:" line read it, without a selectable ETH row). */
export type EvmGasState = {wei: string | null; status: EvmGasStatus; failure: EvmReadFailure | null};

const TOKEN_IDLE: EvmTokenBalanceState = {amount: null, decimals: null, status: 'loading', failure: null};
const GAS_IDLE: EvmGasState = {wei: null, status: 'loading', failure: null};
const NONCE_SEED_EVERY = 5; // D16: every 5th tick (≈12.5s active / 150s idle) seeds the permit-nonce cache

/**
 * The EVM rail's balance poll — the `useSolanaBalances` twin over the seam's `readEvmBalances`
 * (D16): one `eth_getBalance` per CHAIN (gas honesty even at zero tokens) + one `eth_call
 * balanceOf` per visible token row, at the shared active/idle cadence, nothing while
 * backgrounded. Per-row statuses are independent; a failed read PRESERVES the prior amount and
 * carries the classified `failure` (never a zeroed row); an empty key list polls nothing.
 *
 * Permit-nonce piggyback (D22.1): every NONCE_SEED_EVERY-th tick the poll also asks the seam to
 * read `nonces(owner)` per configured (chain, token) into the claim queue's cache — the payer's
 * "last online moment", amortized to one extra eth_call per row per ≈12.5s.
 *
 * Generation guard: changing `secretHex` or the key list aborts the in-flight read and drops
 * stale results (the SOL hook's discipline).
 */
export function useEvmBalances(
  secretHex: string | null,
  keys: readonly EvmKey[],
): {
  tokens: Record<string, EvmTokenBalanceState>;
  gas: Record<number, EvmGasState>;
  /** Date.now() of the last successful read (0 until one lands) — the approx marker's clock. */
  freshAt: number;
  refresh: () => void;
} {
  const [tokens, setTokens] = useState<Record<string, EvmTokenBalanceState>>({});
  const [gas, setGas] = useState<Record<number, EvmGasState>>({});
  const [freshAt, setFreshAt] = useState(0);
  const genRef = useRef(0);
  const pollRef = useRef<() => void>(() => {});
  const keySig = keys.map(k => `${k.chainId}:${k.token}:${k.tokenAddress}:${k.decimals}`).join('|');
  const enabled = secretHex !== null && keys.length > 0;
  const tick = useRef(0);

  useEffect(() => {
    if (!enabled || secretHex === null) {
      setTokens({});
      setGas({});
      setFreshAt(0);
      pollRef.current = () => {};
      return;
    }
    const list = keySig.split('|').filter(s => s.length > 0).map(s => {
      const [chainId, token, tokenAddress, decimals] = s.split(':');
      return {chainId: Number(chainId), token, tokenAddress, decimals: Number(decimals)};
    });
    let alive = true;
    const gen = ++genRef.current;
    const ctrl = new AbortController();
    const fresh = () => alive && gen === genRef.current;

    // Membership delta only: a newly-visible row reads 'loading'; rows that left stop rendering.
    setTokens(prev => {
      const next: Record<string, EvmTokenBalanceState> = {};
      let changed = false;
      for (const k of list) {
        const key = evmBalanceKey(k.chainId, k.token);
        next[key] = prev[key] ?? TOKEN_IDLE;
        if (next[key] !== prev[key]) changed = true;
      }
      return changed || Object.keys(prev).length !== Object.keys(next).length ? next : prev;
    });

    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const everyNth = tick.current++ % NONCE_SEED_EVERY === NONCE_SEED_EVERY - 1;
      try {
        const read: EvmBalancesRead = await readEvmBalances(secretHex, list, ctrl.signal);
        if (!fresh()) return;
        // Tokens: apply per-row results (preserve prior on degraded rows — the hook contract).
        setTokens(prev => {
          const next: Record<string, EvmTokenBalanceState> = {...prev};
          for (const k of list) {
            const key = evmBalanceKey(k.chainId, k.token);
            const r = read.tokens[key];
            if (r === undefined) continue; // the seam answers for every key it was asked
            switch (r.kind) {
              case 'balance':
                next[key] = {amount: r.amount, decimals: k.decimals, status: 'balance', failure: null};
                break;
              case 'offline':
                next[key] = {...(prev[key] ?? TOKEN_IDLE), status: 'unavailable', failure: null};
                break;
              case 'error':
                next[key] = {...(prev[key] ?? TOKEN_IDLE), status: 'error', failure: r.failure};
                break;
            }
          }
          return next;
        });
        // Gas: preserve the prior wei on degraded reads (the number survives a failed poll).
        setGas(prev => {
          const next: Record<number, EvmGasState> = {...prev};
          const chainIds = new Set(list.map(k => k.chainId));
          for (const chainId of chainIds) {
            const r = read.gas[chainId];
            if (r === undefined) continue;
            switch (r.kind) {
              case 'balance':
                next[chainId] = {wei: r.wei, status: 'ok', failure: null};
                break;
              case 'offline':
                next[chainId] = {...(prev[chainId] ?? GAS_IDLE), status: 'unavailable', failure: null};
                break;
              case 'error':
                next[chainId] = {...(prev[chainId] ?? GAS_IDLE), status: 'error', failure: r.failure};
                break;
            }
          }
          return next;
        });
        if (list.some(k => read.tokens[evmBalanceKey(k.chainId, k.token)]?.kind === 'balance')) {
          // The ONE successful-read clock for the rail (the approx marker's staleness test).
          setFreshAt(Date.now());
        }
      } catch (e) {
        // An aborted read is the cleanup path (the seam rethrows caller aborts untouched).
        if (ctrl.signal.aborted || !fresh()) return;
        console.warn('useEvmBalances poll threw:', e instanceof Error ? e.message : String(e));
        setTokens(prev => {
          const next: Record<string, EvmTokenBalanceState> = {...prev};
          for (const k of list) {
            const key = evmBalanceKey(k.chainId, k.token);
            next[key] = {...(prev[key] ?? TOKEN_IDLE), status: 'error', failure: 'unreachable'};
          }
          return next;
        });
      } finally {
        inFlight = false;
      }
      // AFTER the balance read settles: the nonce-cache piggyback rides the same tick's
      // completion, best-effort, never blocking the next cadence tick.
      if (everyNth) {
        void seedEvmPermitNonces(secretHex, list).catch(() => {});
      }
    };
    pollRef.current = () => { void poll(); };

    return () => {
      alive = false;
      ctrl.abort();
      pollRef.current = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, secretHex, keySig]);

  const refresh = usePollCadence(
    useCallback(() => pollRef.current(), []),
    enabled,
    POLL.balance,
    POLL.balanceIdle,
    `${secretHex ?? ''}|${keySig}`,
  );

  return {tokens, gas, freshAt, refresh};
}
