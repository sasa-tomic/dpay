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
 * True iff `receipt` answers the exact payment identified by `expectedNonceHex`. Mirrors the
 * case-insensitive nonce compare in `decidePayerReceipt` (the payer-side guard) but operates on the
 * raw receipt object the relay/FakeLedger emits (nonce under the `nonce` key). This is the
 * MERCHANT-side guard that closes the goods-fraud hole: a malicious relay returning any past valid
 * canister-signed receipt for a DIFFERENT payment is rejected here, before the signature check.
 *
 * Empty `expectedNonceHex` → false (defensive — without a request nonce there is nothing to bind
 * the receipt to, so we do not believe it). A missing/non-string `receipt.nonce` → false.
 */
export function isReceiptForRequest(
  receipt: {nonce?: string} | null | undefined,
  expectedNonceHex: string,
): boolean {
  if (!expectedNonceHex) return false;
  if (!receipt || typeof receipt.nonce !== 'string') return false;
  return receipt.nonce.toLowerCase() === expectedNonceHex.toLowerCase();
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

/**
 * Map a raw withdraw-rejection string (the relay/canister 422 body surfaced by `withdrawFunds`,
 * e.g. `"InsufficientFunds: balance 0"`, `"nonce already used"`, `"bad signature"`, `"amount
 * below retrieve_btc_min_amount (50000)"`) to friendly copy for the WithdrawSheet. Mirrors
 * `rejectionMessage` (the /pay twin) with withdraw-specific guidance. Unknown strings fall back
 * to a generic retry line — the caller ALWAYS console.warn's the raw body, so diagnosis stays
 * possible without leaking protocol jargon into the UI.
 */
export function withdrawRejectionMessage(reason: string): string {
  const r = reason.toLowerCase();
  // Order matters: the hex-decode rejects ("bad from/nonce/sig hex: …") must not fall into the
  // nonce-reserve branch below, and allowance failures read as "not enough" to the user.
  if (r.includes('hex')) return 'Withdrawal rejected — please try again.';
  if (r.includes('nonce')) return 'This withdrawal was already submitted — check your balance before retrying.';
  if (r.includes('insufficient')) return 'Not enough balance for this withdrawal.';
  if (r.includes('bad signature') || r.includes('bad_signature')) return 'Withdrawal rejected — please try again.';
  if (r.includes('expired')) return 'The withdrawal request expired — please try again.';
  if (r.includes('below') || r.includes('too low')) return 'Amount is below the minimum withdrawal.';
  if (r.includes('zero amount')) return 'Enter an amount above zero.';
  return 'Withdrawal failed — please try again';
}

// --- canister-signed receipt (R2 outcome attestation) ----------------------------------------
// The ledger/canister signs a canonical encoding of the settled outcome; the app verifies that
// signature (via DpayCore) before showing "Paid ✓" so the outcome rests on a canister/ledger-
// authenticated signature, not merchant/relay honesty. The FROZEN 108-byte LE layout that is signed:
//   nonce(16) | from(32) | to(32) | amount_le(8) | currency_le(4) | block_index_le(8) | settle_ts_le(8)
// The signed bytes are built + verified inside the Rust core (dpay-ffi `verify_receipt_sig`); only
// the length constant below lives on the TS side, as the wire-layout drift pin.

/**
 * Length of the canonical receipt claim (== dpay_core::RECEIPT_CLAIM_LEN).
 *
 * Source of truth: `dfx/wire_layout.json`'s `receipt.fixed_len` (itself generated from the Rust
 * named sum by `just wire-layout`). Kept as the explicit per-field sum here only to avoid a JSON
 * import in the prod bundle (the app has no JSON imports); the jest suite in
 * `__tests__/payments.test.ts` asserts this equals the JSON value plus every per-field offset/len,
 * so a Rust receipt-field resize → `just wire-layout` regen → that test goes RED until this sum is
 * updated in lockstep (the wire is mutable since 2026-08-07).
 */
export const RECEIPT_CLAIM_LEN = 16 + 32 + 32 + 8 + 4 + 8 + 8; // 108
