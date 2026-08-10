import {useCallback, useEffect, useRef, useState} from 'react';
import {POLL} from '../config/constants';
import {getSolanaBalance} from '../solana';

/**
 * Polls the native SOL balance for a device-derived Solana address on the SOL direct-RPC rail (no
 * relay). Mirrors useBalancePoll's generation-gate + AbortController teardown pattern, adapted to a
 * single account.
 *
 * Offline-loop-safe: when SOLANA_RPC_URL is empty (jest/e2e injection), `getSolanaBalance` resolves
 * null WITHOUT touching the network, so the SOL card renders `—` and the inner loop never hits
 * devnet. `refresh` lets the send sheet trigger an immediate re-poll after a confirmed transfer
 * instead of waiting on the next POLL.balance tick.
 */
export function useSolanaBalance(address: string | null): {balance: string | null; refresh: () => void} {
  const [balance, setBalance] = useState<string | null>(null);
  const genRef = useRef(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!address) {
      setBalance(null);
      return;
    }
    let alive = true;
    const gen = ++genRef.current;
    const ctrl = new AbortController();
    const fresh = () => alive && gen === genRef.current;
    const poll = async () => {
      try {
        const b = await getSolanaBalance(address, ctrl.signal);
        if (fresh()) setBalance(b);
      } catch (e) {
        console.warn(`useSolanaBalance poll failed for ${address}: `, e);
        if (fresh()) setBalance(null);
      }
    };
    poll();
    const id = setInterval(poll, POLL.balance);
    return () => { alive = false; clearInterval(id); ctrl.abort(); };
  }, [address, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return {balance, refresh};
}
