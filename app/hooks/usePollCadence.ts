import {useCallback, useEffect, useRef} from 'react';
import {SOL_ACTIVE_POLL_WINDOW_MS} from '../config/constants';
import {useAppActive} from './useAppActive';

/**
 * A poll whose rate reflects what the user is actually doing, and which STOPS while the app is not
 * in front of them.
 *
 * Three rates, and the reason each exists (measurements + arithmetic:
 * `docs/specs/2026-09-08-solana-rpc-plan.md`):
 *   • ACTIVE (`activeMs`) — for the seconds around a money flow: the wallet just opened, a send
 *     just confirmed, the user just asked to check again. A number on screen is about to change
 *     and someone is watching for it.
 *   • IDLE (`idleMs`) — every other second the app is open. Nothing is expected to change; reading
 *     a paid endpoint twenty-four times a minute to watch nothing happen is what emptied a month
 *     of quota in five days.
 *   • STOPPED — while the app is backgrounded. Not slower: stopped. A phone face-down on a table
 *     was the single largest consumer of the rail that broke.
 *
 * `bump()` is the money-flow signal: poll NOW and hold the active cadence for
 * `SOL_ACTIVE_POLL_WINDOW_MS`. `key` is the caller's generation — change it (identity, the set of
 * things polled) and the cadence restarts with an immediate read, which is also what happens when
 * the app comes back to the foreground.
 *
 * It is a self-rescheduling timeout rather than an interval on purpose: the delay is chosen fresh
 * each time from the state at that moment, so leaving the active window costs nothing to notice.
 * `run` is held in a ref so a new closure every render never restarts the timer.
 */
export function usePollCadence(
  run: () => void,
  enabled: boolean,
  activeMs: number,
  idleMs: number,
  key: string,
): () => void {
  const runRef = useRef(run);
  runRef.current = run;
  // When the active window ends. Read at each reschedule; never a dependency (changing it must not
  // restart anything — `bump` reschedules explicitly).
  const activeUntilRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRef = useRef<(() => void) | null>(null);
  const appActive = useAppActive();

  useEffect(() => {
    if (!enabled || !appActive) {
      scheduleRef.current = null;
      return;
    }
    let alive = true;
    const schedule = () => {
      if (!alive) return;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      const delay = Date.now() < activeUntilRef.current ? activeMs : idleMs;
      timerRef.current = setTimeout(() => {
        if (!alive) return;
        runRef.current();
        schedule();
      }, delay);
    };
    scheduleRef.current = schedule;
    // Coming into view — a fresh identity, a new mint set, or the app returning to the foreground —
    // reads immediately. A user who reopens the wallet must not look at a number from before.
    activeUntilRef.current = Date.now() + SOL_ACTIVE_POLL_WINDOW_MS;
    runRef.current();
    schedule();
    return () => {
      alive = false;
      scheduleRef.current = null;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, appActive, activeMs, idleMs, key]);

  return useCallback(() => {
    activeUntilRef.current = Date.now() + SOL_ACTIVE_POLL_WINDOW_MS;
    runRef.current();
    // Re-time from now, at the active cadence. Null while the poll is stopped (disabled, or the
    // app is backgrounded): a refresh request then still reads once, which is what a caller acting
    // on a confirmed send needs, and the schedule resumes when the app does.
    scheduleRef.current?.();
  }, []);
}
