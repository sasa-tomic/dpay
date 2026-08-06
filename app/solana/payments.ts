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
