/** Shared timeout-signal composition — the single source of truth for the `AbortController +
 *  setTimeout` incantation used by the relay clients (`services/relay.ts`) and the Solana RPC
 *  client (`solana/rpc.ts`).
 *
 *  When the caller provides a signal it is returned AS-IS — the caller owns the deadline. Its timer
 *  may be SHORTER than the backstop (every fast poll) or LONGER (a slow IC update like ckBTC
 *  `deposit_address`, 5–7s+ on mainnet, for which DepositSheet arms a 20s controller). Arming the
 *  backstop unconditionally would cap every caller at the backstop ("first abort wins"), silently
 *  overriding a deliberate longer deadline. So when a caller signal is present the backstop does
 *  NOT arm; it arms only for omitted-signal callers. */

export function composeTimeout(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): {signal: AbortSignal; cancel: () => void} {
  if (callerSignal) return {signal: callerSignal, cancel: () => {}};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return {signal: ctrl.signal, cancel: () => clearTimeout(timer)};
}

/** ALWAYS-armed timeout composition: unlike `composeTimeout` above (where a caller signal means the
 *  caller owns the deadline and the backstay does not arm), this arms `timeoutMs` on a fresh
 *  internal controller EVERY call and forwards a caller signal first-wins via an `abort` listener.
 *  It exists for per-ATTEMPT deadlines inside a multi-address walk (`services/relay.ts`): each
 *  attempt needs its own real deadline regardless of any walk-level signal, so one hung address
 *  burns only its attempt's budget and the walk moves on — while a caller abort still ends the
 *  whole walk at once. `cancel()` clears the timer AND detaches the listener, so a settled attempt
 *  leaves neither a live timer nor a dangling no-op abort. */
export function composeArmedTimeout(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): {signal: AbortSignal; cancel: () => void} {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onCaller = () => ctrl.abort();
  if (callerSignal?.aborted) ctrl.abort();
  else callerSignal?.addEventListener('abort', onCaller, {once: true});
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCaller);
    },
  };
}

export function withTimeout(timeoutMs: number): {signal: AbortSignal; cancel: () => void} {
  return composeTimeout(undefined, timeoutMs);
}
