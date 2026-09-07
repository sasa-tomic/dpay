/**
 * solana/payments — the SOL recent-blockhash receipt outcome logic, as PURE functions.
 *
 * SolReqV2 carries a request id (`rid`) and the signed SolPayV2 echoes the SAME `rid`; the
 * receipt's `sig` is the on-chain signature. The money-critical decision of what the payer
 * believes after handing off an offline-signed tx to the merchant lives here in one place:
 *
 *   The merchant's broadcast result is the source of truth. A receipt is believed ONLY if both
 *   `rid` and `sig` match the payer's open request — otherwise it is IGNORED (a stale or cross-tap
 *   receipt must never be believed for the wrong payment). On match: settled→success, rejected→
 *   declined, unreachable→pending, mismatch→pending. An unknown status code is honest-unknown→
 *   pending (never a false failure).
 *
 * Dependency-free (no react-native, no fetch, no globals) so it runs under jest on the fast inner
 * loop. These receipt codes belong only to the SOL transport; IC settlement is polled directly.
 */
export const RECEIPT_SETTLED = 0;
export const RECEIPT_REJECTED = 1;
export const RECEIPT_UNREACHABLE = 2;

/**
 * 3 — the confirmed tx's body does NOT match the canonical message the merchant verified
 * (`settleVerify.ts` 'mismatch', incl. a v0/ALT claim). MERCHANT semantics: terminal doubt — do
 * NOT treat the payment as received (the signature confirms a DIFFERENT transaction), but the tx
 * may still move money, so the merchant keeps the durable unknown-state (reconcile/rebroadcast)
 * and gets the check-before-handover copy. PAYER semantics: honest pending — the payer did sign
 * and hand over a valid tx, so this is NEVER a decline; it maps to 'pending' exactly like
 * UNREACHABLE (the existing "Sent · awaiting…" copy). This keeps the three-verdict discipline: an
 * answer the payer's phone cannot verify is never promoted to a decline.
 */
export const RECEIPT_MISMATCH = 3;

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
 * 2=unreachable, 3=mismatch — see RECEIPT_MISMATCH). `rid` echoes the solreq:v2 request id;
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
    case RECEIPT_MISMATCH:
      // The merchant saw the tx confirm with a body that isn't this request — terminal doubt for
      // the MERCHANT, honest pending for the payer (see RECEIPT_MISMATCH). NEVER a decline.
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
