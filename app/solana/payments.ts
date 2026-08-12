/**
 * solana/payments — the SOL durable-nonce receipt outcome logic, as PURE functions.
 *
 * This is the SOL analog of payments.ts:decidePayerReceipt, but for Solana's "adopt nextNonce
 * optimistically" model (the receipt-nonce-relay). The money-critical decision of what the payer
 * believes after handing off an offline-signed tx to the merchant lives here in one place:
 *
 *   The merchant's broadcast result is the source of truth. A settled receipt whose nonce account
 *   matches the payer's is SUCCESS, and the payer ADOPTS the handed-back nextNonce so the NEXT
 *   offline payment needs NO online resync. A rejected receipt is a definitive failure (mark the
 *   nonce stale). An unreachable receipt is honest-unknown (keep the value; the tx MAY still land).
 *   A receipt for a different nonce account is IGNORED.
 *
 * Dependency-free (no react-native, no fetch, no globals) so it runs under jest on the fast inner
 * loop. Receipt codes are imported from payments.ts (single source of truth — RECEIPT_SETTLED etc.
 * are the SAME codes the merchant's broadcastSolPayment emits).
 */
import {RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE} from '../payments';

/**
 * The payer's terminal state, derived from a SolReceipt received over QR/NFC from the merchant:
 *  - `success` + `adoptNonce` — the broadcast settled THIS payment. The payer ADOPTS `adoptNonce` as
 *    the new stored nonce value (the receipt-nonce-relay win: the next offline payment is signable
 *    immediately, NO online resync). `adoptNonce` is null when the payment settled but the merchant
 *    couldn't read the advanced nonce (getNonceAccount failed after confirm) — the payer shows
 *    "Paid ✓" but must resync before the next offline sign (no loss of funds; the transfer landed).
 *  - `declined` — the broadcast was definitively rejected (InstructionError, insufficient funds,
 *    nonce mismatch). The payer marks its nonce STALE (the stored value can't be trusted anymore).
 *  - `pending` — the merchant couldn't confirm (network/timeout). The outcome is genuinely unknown
 *    (the tx MAY still land). Keep the value; the next broadcast is the truth-check. NEVER a failure.
 *  - `ignore` — the receipt's nonce account is NOT the payer's (it answers a different payment).
 *
 * `expectedNpub` is the payer's nonce account address (base58). Matching on it is what stops a
 * stale or cross-tap receipt from being believed for the wrong payment — the SOL analog of the IC
 * nonce compare. NOTE: base58 is CASE-SENSITIVE (unlike hex), so the compare is EXACT, not
 * lowercased — lowercasing a base58 string changes its meaning.
 */
export type SolPayerOutcome =
  | {outcome: 'success'; adoptNonce: string | null}
  | {outcome: 'declined'}
  | {outcome: 'pending'}
  | {outcome: 'ignore'};

/**
 * Decide the payer's outcome from a merchant receipt. Pure + total (never throws).
 *
 * Binding: `receipt.npub` must EXACTLY equal `expectedNpub` (base58 is case-sensitive). A mismatch
 * (including an empty expected) → 'ignore'. The nextNonce-adoption on success is the SOL-specific
 * behavior with no IC equivalent — it is OPTIMISTIC: if a malicious merchant hands a wrong value,
 * the payer's NEXT offline sign produces a tx that Solana rejects on-chain → 'declined' → resync.
 * Never a loss of funds (the payer only ever signs its own transfer out).
 */
export function decideSolPayerReceipt(
  receipt: {status: number; npub: string; nextNonce: string | null; sig: string | null},
  expectedNpub: string,
): SolPayerOutcome {
  // base58 is case-sensitive — exact compare, NOT lowercased (unlike the IC hex nonce compare).
  if (!expectedNpub || receipt.npub !== expectedNpub) {
    return {outcome: 'ignore'};
  }
  switch (receipt.status) {
    case RECEIPT_SETTLED:
      return {outcome: 'success', adoptNonce: receipt.nextNonce};
    case RECEIPT_REJECTED:
      return {outcome: 'declined'};
    case RECEIPT_UNREACHABLE:
      return {outcome: 'pending'};
    default:
      // An unknown receipt code (future/undocumented) — honest unknown, NEVER a false failure.
      return {outcome: 'pending'};
  }
}

/**
 * Whether a `solreq` has expired. The SOL rail has NO server (the payer signs fully offline, the
 * merchant broadcasts), so unlike the IC rail there is no canister to reject a stale request — the
 * client MUST enforce `exp` itself. A stale/replayed solreq is otherwise fully signable.
 *
 * `exp` is unix SECONDS (the solreq codec's frozen v1 field). `nowMs` defaults to `Date.now()` but
 * is a parameter so the boundary is unit-testable. Contract: a request is valid THROUGH its expiry
 * second (`nowSecs === exp` ⇒ NOT expired); one second later it is. This mirrors the IC rail's
 * "valid through the window" semantics (a request built with `exp = now + 300` is signable at the
 * 300th second).
 */
export function isSolReqExpired(req: {exp: number}, nowMs: number = Date.now()): boolean {
  return Math.floor(nowMs / 1000) > req.exp;
}

/**
 * Whether a scanned `solpay` matches the open `solreq` (to/cur/amt). The merchant broadcasts
 * whatever the payer's solpay carries; without this binding a cheating payer could hand over a
 * signed transfer for a different amount/recipient and the merchant would surface the payer's
 * CLAIMED amount as "Received". `to`/`cur`/`amt` are the three fields a replay-or-swap would alter;
 * `npub` is the payer's own (the merchant doesn't know it ahead of time, so it's not a match target).
 *
 * Pure + total. base58 `to` is compared EXACT (case-sensitive — lowercasing a base58 string changes
 * its meaning, same as the npub compare in decideSolPayerReceipt).
 */
export function solpayMatchesReq(
  solpay: {to: string; cur: string; amt: string},
  req: {to: string; cur: string; amt: string},
): boolean {
  return solpay.to === req.to && solpay.cur === req.cur && solpay.amt === req.amt;
}

// =============================================================================================
// F4 (Phase 4) — fail-closed USDC ATA gate. Replaces the former "unknown falls through to allow"
// behavior: a Solana-USDC request is unfulfillable without the device's on-chain USDC ATA (the
// merchant's `toAta` is encoded in the request; the payer's source ATA is debited). The previous
// gate permitted an `'unknown'` (offline / RPC-failure) state to fall through to "allow", leaking
// an unfulfillable request. The new gate BLOCKS on every non-`present` state with honest copy +
// a retry affordance for the unverifiable case (plan line ~272: "retryable fail-closed UI").
// =============================================================================================

/** The ATA-existence probe states SolReceiveMode's local effect cycles through. */
export type UsdcAtaStatus = 'unknown' | 'checking' | 'present' | 'absent';

/**
 * The gate's decision: either allow the Request, or block with a typed reason + user-facing copy.
 *   - `allowed: true` — the ATA exists on-chain; the USDC request is fulfilfillable.
 *   - `allowed: false, reason: 'offline'` — the wallet is offline; cannot verify (no auto-retry).
 *   - `allowed: false, reason: 'checking'` — the probe is in flight; briefly busy (no retry).
 *   - `allowed: false, reason: 'absent'` — the ATA is known NOT to exist (no retry — the user must
 *     set one up out-of-band first; this is a definitive "not fulfllfillable", not a transient state).
 *   - `allowed: false, reason: 'unverified'` — the probe returned inconclusive / threw. RETRYABLE:
 *     the user can tap to re-probe (the next attempt may succeed). Honest copy: "Couldn't verify".
 */
export type UsdcAtaGateDecision =
  | {allowed: true}
  | {allowed: false; reason: 'offline' | 'checking' | 'absent' | 'unverified'; message: string; retryable: boolean};

/**
 * Decide whether a Solana-USDC Request is allowed given the current ATA-existence status + relay
 * online state. Pure + total — never throws. The decision drives BOTH the `btn-sol-req-make`
 * disabled-state AND the inline copy the user sees, so the gate stays consistent across the two.
 *
 * `online` here is the Solana RPC reachability proxy (the wallet's `online` flag — when the relay is
 * offline the ATA probe is skipped, so the gate reports 'offline' rather than pretending 'unknown'
 * might be 'present'). This is the load-bearing change vs the old code: 'unknown' NO LONGER falls
 * through to allow — it is now a blocking, retryable state.
 */
export function decideUsdcAtaGate(status: UsdcAtaStatus, online: boolean): UsdcAtaGateDecision {
  // Offline ⇒ the probe was skipped (SolReceiveMode's effect short-circuits on !online). The user
  // must reconnect to verify; this is NOT retryable from the button (a tap won't bring the network
  // back). Honest copy: the request is unverifiable, not "allowed".
  if (!online) {
    return {allowed: false, reason: 'offline', message: "You're offline — connect to verify your USDC account before requesting USDC.", retryable: false};
  }
  switch (status) {
    case 'present':
      return {allowed: true};
    case 'checking':
      return {allowed: false, reason: 'checking', message: 'Checking your USDC account…', retryable: false};
    case 'absent':
      return {allowed: false, reason: 'absent', message: 'No USDC account on this device — set one up online first to receive USDC.', retryable: false};
    case 'unknown':
    default:
      // The fail-closed change: 'unknown' (probe threw / returned inconclusive) used to allow the
      // request. It now BLOCKS with a retryable affordance — the user re-probes; if the RPC
      // transient failed, the next attempt may succeed. NEVER silently leak an unfulfillable request.
      return {allowed: false, reason: 'unverified', message: "Couldn't verify your USDC account — retry.", retryable: true};
  }
}
