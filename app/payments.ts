/**
 * payments — the money-critical settlement-outcome logic, as PURE functions.
 *
 * This is deliberately dependency-free (no react-native, no fetch, no globals) so it runs under
 * jest on the fast inner loop. The rule the whole app obeys lives here in one place:
 *
 *   The **ledger is the single source of truth.** A payment is "settled" only when the ledger
 *   says so (IC read_state request_status on the user-principal rail); a transport/network hiccup
 *   is *unknown*, never a failure; and the payer only believes an outcome that answers the exact
 *   payment it signed (by nonce).
 *
 * Getting this wrong is precisely what produced false "failed" reports on payments that actually
 * settled, and false "paid" reports on payments that didn't — so every branch is unit-tested.
 */

// Receipt status codes carried back to the offline payer over the NFC tap (mirror dpay_core
// RECEIPT_*). This 17-byte outcome channel survives the IC-rail cutover unchanged: the merchant's
// submit verdict (settled/rejected/unknown) maps 1:1 onto these codes.
export const RECEIPT_SETTLED = 0;
export const RECEIPT_REJECTED = 1;
export const RECEIPT_UNREACHABLE = 2;
export type ReceiptCode = typeof RECEIPT_SETTLED | typeof RECEIPT_REJECTED | typeof RECEIPT_UNREACHABLE;

/**
 * The authoritative outcome of one rail submission attempt, as the merchant must treat it:
 *  - `settled`  — the ledger committed (read_state replied with the transfer's block index).
 *  - `rejected` — a *definitive* refusal (decoded transfer error, gateway 4xx). Safe to report as
 *                 failure; the ledger did NOT move funds.
 *  - `unknown`  — we did not get a clean answer (5xx, timeout, poll budget exhausted). The ledger
 *                 MAY have committed. Never shown as a hard failure until reconciliation proves it.
 */
export type SettleOutcome = 'settled' | 'rejected' | 'unknown';

/** The receipt code the merchant hands the offline payer for a given authoritative outcome. */
export function receiptCodeFor(o: SettleOutcome): ReceiptCode {
  switch (o) {
    case 'settled':
      return RECEIPT_SETTLED;
    case 'rejected':
      return RECEIPT_REJECTED;
    case 'unknown':
      return RECEIPT_UNREACHABLE;
  }
}

/**
 * The payer's terminal state, derived from a receipt received over the tap.
 *  - `success`  — the ledger settled THIS payment.
 *  - `declined` — the ledger definitively refused THIS payment.
 *  - `pending`  — the merchant couldn't reach the ledger; the outcome is genuinely unknown (it may
 *                 still settle). Reported truthfully as "couldn't confirm", NEVER as failed.
 *  - `ignore`   — the receipt is for some other payment (nonce mismatch); it says nothing about
 *                 the one we signed, so we must not act on it.
 *
 * `signedNonceHex` is the nonce the payer actually signed. Matching on it is what stops a stale or
 * cross-tap receipt from being believed for the wrong payment.
 */
export type PayerOutcome = 'success' | 'declined' | 'pending' | 'ignore';

export function decidePayerReceipt(
  receipt: {status: number; nonceHex: string},
  signedNonceHex: string,
): PayerOutcome {
  if (!signedNonceHex || receipt.nonceHex.toLowerCase() !== signedNonceHex.toLowerCase()) {
    return 'ignore';
  }
  switch (receipt.status) {
    case RECEIPT_SETTLED:
      return 'success';
    case RECEIPT_REJECTED:
      return 'declined';
    default:
      return 'pending'; // RECEIPT_UNREACHABLE (or any unknown code) — outcome not known, not failed
  }
}

// (isReceiptForRequest retired with the canister-signed receipt: goods-binding on the IC rail is
// the request_id carried in the envelope the merchant itself submitted — a replayed proof for a
// different payment has a different request_id and never matches the watched one.)

// (rejectionMessage / isNonceReused / withdrawRejectionMessage retired with the relay surface —
// the IC rail classifies rejections from decoded transfer errors; see transferRejectionMessage +
// ingressRejectMessage in services/rail.ts.)

// (RECEIPT_CLAIM_LEN retired with the canister-signed receipt — the wire drift pin pointed at the
// facade's 108-byte signed claim, which no longer exists. Outcomes ride read_state + the 17-byte
// NFC receipt codes above.)
