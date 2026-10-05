/**
 * hooks/useRecheckAll - THE ONE REFRESH (founder 2026-10-05: "Refresh Solana balances and
 * transactions same way we do for ICP"). Every Pay surface's Check-again affordance calls ONE
 * handler, and that handler re-polls BOTH rails' balances AND BOTH histories (the IC ledger
 * walk + the Solana RPC history) plus the EVM rail when it is configured - never a
 * rail-scoped subset. The seams are the plain refresh functions Wallet already owns; this hook
 * owns only the composition and the self-clearing busy flag (the same affordance the per-rail
 * rechecks carried: fire-and-forget polls have no completion signal, so the flag is a UI-level
 * "Checking…" dwell, not a poll-lifecycle tracker).
 *
 * THE POST-ACTION WINDOW (`armSolWindow`, founder directive, same day): "Solana refresh =>
 * should be done also periodically and/or for some time after making payments and after
 * conversions." The one-shot recheck answers "did it land NOW"; the window answers the payout
 * that lands in a minute: after a Solana-rail payment or a Solana-payout conversion, the SOL
 * seams re-poll at POST_ACTION_REPOLL_INTERVAL_MS until POST_ACTION_REPOLL_WINDOW_MS has passed
 * since the LAST armed action, then stop for good (bounded — never a poll-forever loop). The
 * window re-polls through the SAME seams as `recheckAll` (one shared recheck primitive, both
 * rails), reads NOTHING while the app is backgrounded (the deadline is absolute, so a wallet
 * reopened after the window finds nothing extra armed), and stops at unmount. Which actions
 * earn a Solana window is lib/postActionRepoll.ts's pure call (`convertRecordPayoutRail` +
 * `repollWantedForPayoutRail`); this hook only runs the clock.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {POST_ACTION_REPOLL_INTERVAL_MS, POST_ACTION_REPOLL_WINDOW_MS} from '../config/constants';
import {extendRepollDeadline, nextRepollDelayMs} from '../lib/postActionRepoll';
import {useAppActive} from './useAppActive';

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

/** Explicit per-test timing (the sibling convention: jest suites that need speed never depend
 *  on module state). Prod arms with the constants above. */
export type RecheckWindowOpts = {intervalMs?: number; windowMs?: number};

export function useRecheckAll(seams: RecheckSeams, windowOpts: RecheckWindowOpts = {}): {recheckAll: () => void; recheckBusy: boolean; armSolWindow: () => void} {
  const [recheckBusy, setRecheckBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current != null) clearTimeout(timer.current); }, []);

  // ── the post-action window ────────────────────────────────────────────────────────────────
  const intervalMs = windowOpts.intervalMs ?? POST_ACTION_REPOLL_INTERVAL_MS;
  const windowMs = windowOpts.windowMs ?? POST_ACTION_REPOLL_WINDOW_MS;
  const appActive = useAppActive();
  // Absolute epoch-ms deadline of the armed window (0 = not armed). A re-arm extends it; the
  // ticks fire while Date.now() is before it and never after.
  const windowUntilRef = useRef(0);
  const windowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Window ticks read the LATEST seams through a ref (the seams object is memoized upstream,
  // but the ref makes the tick stable against any future re-memoization too).
  const seamsRef = useRef(seams);
  seamsRef.current = seams;
  // The rescheduler, re-assigned every render (the usePollCadence runRef pattern): `tick` and
  // this function reference each other, so they live through refs, not through closure identity.
  const scheduleWindowRef = useRef<() => void>(() => {});

  const stopWindowTimer = () => {
    if (windowTimerRef.current != null) {
      clearTimeout(windowTimerRef.current);
      windowTimerRef.current = null;
    }
  };

  // One tick: re-poll the SOL seams, then re-arm ONLY if the window is still open. Balances and
  // tokens are ONE request (useSolanaBalances reads every rail in a single getMultipleAccounts),
  // so the "balances + transactions" window costs one balance read + one history walk per tick.
  scheduleWindowRef.current = () => {
    stopWindowTimer();
    const now = Date.now();
    const delay = nextRepollDelayMs(now, windowUntilRef.current, intervalMs);
    if (delay == null) return;
    windowTimerRef.current = setTimeout(() => {
      windowTimerRef.current = null;
      if (Date.now() >= windowUntilRef.current) return; // closed while the timer sat queued
      seamsRef.current.refreshSolBalances();
      seamsRef.current.refreshSolTokens();
      seamsRef.current.refreshSolHistory();
      scheduleWindowRef.current();
    }, delay);
  };

  // Backgrounded phones read NOTHING (the usePollCadence law). The deadline is absolute: a
  // wallet back in view inside the window resumes its remaining ticks; back after it, nothing.
  useEffect(() => {
    if (!appActive) {
      stopWindowTimer();
      return;
    }
    scheduleWindowRef.current();
    return () => { stopWindowTimer(); };
  }, [appActive]);

  const armSolWindow = useCallback(() => {
    windowUntilRef.current = extendRepollDeadline(windowUntilRef.current, Date.now(), windowMs);
    // Tick 0 is the action's own immediate re-poll (the old `refreshSol` + `refreshSolHistory`
    // pair on a confirmed send — subsumed, tokens included, since the balance read answers
    // every rail in one request). The hooks' own in-flight guards dedupe any overlap with a
    // caller's direct refresh of the same seams.
    seamsRef.current.refreshSolBalances();
    seamsRef.current.refreshSolTokens();
    seamsRef.current.refreshSolHistory();
    scheduleWindowRef.current();
  }, [windowMs]);
  useEffect(() => () => { stopWindowTimer(); }, []); // unmount: the window dies with the wallet

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
  return {recheckAll, recheckBusy, armSolWindow};
}
