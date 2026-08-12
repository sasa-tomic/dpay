/**
 * solana/payments — the SOL recent-blockhash receipt outcome logic, as PURE functions.
 *
 * Phase 1 rewrite: the durable-nonce "adopt nextNonce" model is gone. SolReqV2 carries a request
 * id (`rid`) and the signed SolPayV2 echoes the SAME `rid`; the receipt's `sig` is the on-chain
 * signature. The money-critical decision of what the payer believes after handing off an
 * offline-signed tx to the merchant lives here in one place:
 *
 *   The merchant's broadcast result is the source of truth. A receipt is believed ONLY if both
 *   `rid` and `sig` match the payer's open request — otherwise it is IGNORED (a stale or cross-tap
 *   receipt must never be believed for the wrong payment). On match: settled→success, rejected→
 *   declined, unreachable→pending. An unknown status code is honest-unknown→pending (never a false
 *   failure).
 *
 * Dependency-free (no react-native, no fetch, no globals) so it runs under jest on the fast inner
 * loop. Receipt codes are imported from payments.ts (single source of truth — RECEIPT_SETTLED etc.
 * are the SAME codes the merchant's broadcastSolPayment emits).
 */
import {RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE} from '../payments';

/**
 * The payer's terminal state, derived from a SolReceiptV2 received over QR/NFC from the merchant:
 *  - `success` — the broadcast settled THIS payment (rid+sig both match). The transfer landed.
 *  - `declined` — the broadcast was definitively rejected (InstructionError, insufficient funds).
 *  - `pending` — the merchant couldn't confirm (network/timeout). The outcome is genuinely unknown
 *    (the tx MAY still land). NEVER a failure.
 *  - `ignore` — the receipt's rid or sig does NOT match the payer's open request (it answers a
 *    different payment, or is a stale/cross-tap receipt).
 *
 * Binding is `rid` (32 lowercase hex from the solreq:v2 codec) AND `sig` (base58 on-chain
 * signature). Both are CASE-SENSITIVE — hex case and base58 case both carry meaning, so the compare
 * is EXACT, never lowercased.
 */
export type SolPayerOutcomeV2 =
  | {outcome: 'success'}
  | {outcome: 'declined'}
  | {outcome: 'pending'}
  | {outcome: 'ignore'};

/**
 * The v2 receipt shape the merchant hands back. `status` is a ReceiptCode (0=settled, 1=rejected,
 * 2=unreachable — the SAME codes payments.ts defines). `rid` echoes the solreq:v2 request id;
 * `sig` is the on-chain transaction signature (base58). Neither is a trusted claim — both must
 * match what the payer signed.
 */
export interface SolReceiptV2 {
  status: number;
  rid: string;
  sig: string;
}

/**
 * Decide the payer's outcome from a merchant receipt. Pure + total (never throws).
 *
 * Binding: `receipt.rid` must EXACTLY equal `expectedRid` (32 lowercase hex, case-sensitive) AND
 * `receipt.sig` must EXACTLY equal `expectedSig` (base58, case-sensitive). A mismatch on EITHER
 * (including an empty expected) → 'ignore'. There is no "partial match" — a receipt that gets one
 * right and the other wrong is NOT believed (it answers a different payment).
 */
export function decideSolPayerReceiptV2(
  receipt: SolReceiptV2,
  expectedRid: string,
  expectedSig: string,
): SolPayerOutcomeV2 {
  // Both bindings are case-sensitive. An empty expected (the payer has no open request) → ignore.
  if (!expectedRid || !expectedSig || receipt.rid !== expectedRid || receipt.sig !== expectedSig) {
    return {outcome: 'ignore'};
  }
  switch (receipt.status) {
    case RECEIPT_SETTLED:
      return {outcome: 'success'};
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
 * Whether a `solreq:v2` has expired. The SOL rail has NO server (the payer signs fully offline,
 * the merchant broadcasts), so unlike the IC rail there is no canister to reject a stale request
 * — the client MUST enforce `exp` itself. A stale/replayed solreq is otherwise fully signable.
 *
 * `exp`/`iat` are unix SECONDS (the solreq:v2 codec's frozen fields). `nowMs` defaults to
 * `Date.now()` but is a parameter so the boundary is unit-testable. Contract: a request is valid
 * THROUGH its expiry second (`nowSecs === exp` ⇒ NOT expired); one second later it is.
 *
 * Advisory cap: even if the local clock says not-yet-expired, a request whose window exceeds
 * `iat + 90` is treated as expired — the producer is broken or hostile (the codec REJECTS such a
 * request at decode time, so this is a defense-in-depth for a hand-built req that bypassed the
 * codec). The boundary `exp === iat + 90` is the maximum legal window and is NOT expired.
 */
export function isSolReqV2Expired(req: {iat: number; exp: number}, nowMs: number = Date.now()): boolean {
  if (req.exp > req.iat + 90) {
    return true;
  }
  return Math.floor(nowMs / 1000) > req.exp;
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
