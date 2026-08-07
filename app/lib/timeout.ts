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

export function withTimeout(timeoutMs: number): {signal: AbortSignal; cancel: () => void} {
  return composeTimeout(undefined, timeoutMs);
}
