/**
 * payments — the money-critical settlement-outcome logic, as PURE functions.
 *
 * This is deliberately dependency-free (no react-native, no fetch, no globals) so it runs under
 * jest on the fast inner loop. The rule the whole app obeys lives here in one place:
 *
 *   The **ledger receipt is the single source of truth.** A payment is "settled" only when the
 *   ledger says so; a transport/network hiccup is *unknown*, never a failure; and the payer only
 *   believes a receipt that answers the exact payment it signed (by nonce).
 *
 * Getting this wrong is precisely what produced false "failed" reports on payments that actually
 * settled, and false "paid" reports on payments that didn't — so every branch is unit-tested.
 */

// Receipt status codes carried back to the offline payer (mirror dpay_core RECEIPT_*).
export const RECEIPT_SETTLED = 0;
export const RECEIPT_REJECTED = 1;
export const RECEIPT_UNREACHABLE = 2;
export type ReceiptCode = typeof RECEIPT_SETTLED | typeof RECEIPT_REJECTED | typeof RECEIPT_UNREACHABLE;

/**
 * The authoritative outcome of one `/pay` attempt, as the merchant must treat it:
 *  - `settled`  — the ledger committed (the response body carries the receipt).
 *  - `rejected` — a *definitive* policy refusal (insufficient funds, expired, over cap, bad sig,
 *                 nonce reused). Safe to report as failure; the ledger did NOT move funds.
 *  - `unknown`  — we did not get a clean answer (5xx, timeout, dropped connection). The ledger MAY
 *                 have committed. This must be reconciled, and must NEVER be shown as a hard
 *                 failure until reconciliation proves it didn't settle.
 */
export type SettleOutcome = 'settled' | 'rejected' | 'unknown';

/**
 * Map an HTTP `/pay` result to an authoritative outcome. `res` is `null` when `fetch` threw
 * (network error / timeout / abort) — inherently `unknown`.
 *
 *  - 2xx  → settled
 *  - 422  → rejected (the relay's only *definitive* client rejection: a `dpay_core::PayError`)
 *  - else → unknown  (503 ledger-unavailable, 500, and every non-2xx we can't interpret)
 */
export function classifyPayHttp(res: {ok: boolean; status: number} | null): SettleOutcome {
  if (!res) return 'unknown';
  if (res.ok) return 'settled';
  if (res.status === 422) return 'rejected';
  return 'unknown';
}

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

/**
 * Turn the relay's raw rejection string (e.g. `"InsufficientFunds"`, `"rejected: Expired"`) into a
 * short human line for the merchant. `nonceReused` is surfaced separately (via `isNonceReused`)
 * because it is not a real refusal — it means this exact payment already settled — so the caller
 * reconciles to the real receipt instead of showing a decline.
 */
export function rejectionMessage(reason: string | null | undefined): string {
  const r = (reason || '').toLowerCase();
  if (r.includes('insufficient')) return 'Not enough balance';
  if (r.includes('expired')) return 'The request expired';
  if (r.includes('overcap') || r.includes('over_cap') || r.includes('cap')) return 'Amount over the limit';
  if (r.includes('signature') || r.includes('badsignature')) return 'Invalid signature';
  if (r.includes('zeroamount') || r.includes('zero_amount')) return 'Amount must be greater than zero';
  return 'The ledger declined the payment';
}

/** True when a rejection string indicates the nonce was already spent (i.e. already settled). */
export function isNonceReused(reason: string | null | undefined): boolean {
  return /nonce/i.test(reason || '');
}
