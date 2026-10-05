/**
 * hooks/useRecheckAll.ts - THE ONE REFRESH (founder 2026-10-05: "Refresh Solana balances and
 * transactions same way we do for ICP"). Every Pay surface's Check-again affordance calls ONE
 * handler, and that handler re-polls BOTH rails' balances AND BOTH histories (the IC ledger
 * walk + the Solana RPC history) plus the EVM rail when it is configured - never a
 * rail-scoped subset. The seams are the plain refresh functions Wallet already owns; this hook
 * owns only the composition and the self-clearing busy flag (the same affordance the per-rail
 * rechecks carried: fire-and-forget polls have no completion signal, so the flag is a UI-level
 * "Checking…" dwell, not a poll-lifecycle tracker).
 */
import {useCallback, useEffect, useRef, useState} from 'react';

/** The busy dwell. Matches the per-rail rechecks' 1500 ms (useBalancePoll's own cadence and
 *  generation gate remain the source of truth for the data itself). */
const RECHECK_BUSY_MS = 1500;

export interface RecheckSeams {
  refreshIcBalances: () => void;
  refreshIcHistory: () => void;
  refreshSolBalances: () => void;
  refreshSolTokens: () => void;
  refreshSolHistory: () => void;
  refreshEvmBalances: () => void;
  refreshEvmHistory: () => void;
}

export function useRecheckAll(seams: RecheckSeams): {recheckAll: () => void; recheckBusy: boolean} {
  const [recheckBusy, setRecheckBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current != null) clearTimeout(timer.current); }, []);
  const recheckAll = useCallback(() => {
    seams.refreshIcBalances();
    seams.refreshIcHistory();
    seams.refreshSolBalances();
    seams.refreshSolTokens();
    seams.refreshSolHistory();
    seams.refreshEvmBalances();
    seams.refreshEvmHistory();
    setRecheckBusy(true);
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setRecheckBusy(false), RECHECK_BUSY_MS);
  }, [seams]);
  return {recheckAll, recheckBusy};
}
