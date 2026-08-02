import {DpayCore} from './native';
import {EXPECTED_RECEIPT_PUBKEY} from '../config/constants';
import {cmpRaw} from '../lib/amount';
import type {ReceiptAuth} from '../lib/types';

// MC4 U5 — independently-authenticated receipt. Three checks, in order:
//
//   1. KEY PIN (the malicious-relay close): if EXPECTED_RECEIPT_PUBKEY is non-empty, the receipt's
//      embedded `pubkey` MUST equal it. A relay can no longer fabricate its own key+sig+claim that
//      passes a self-consistency check, because the trusted key is sourced INDEPENDENTLY of the
//      receipt body (baked in app config; the e2e harness injects the FakeLedger's test key).
//      Mismatch → false EVEN IF the signature is internally valid. Empty pin = dev/unpinned fallback
//      (the receipt's own key is then trusted — the e2e/dev path; production bakes the real canister's
//      `receipt_pubkey()` here, one-time per deploy).
//
//   2. SIGNATURE: the Ed25519 `receipt_sig` verifies under the (now-pinned-trustworthy) pubkey over
//      the canonical ReceiptClaim built from the receipt's fields. Invalid → false.
//
//   3. FULL-AUTH BINDING (defense-in-depth): if `auth` is passed, the receipt's
//      {from, to, amount, currency, nonce} must match the signed authorization the payer holds. This
//      catches a stale/malicious relay returning a DIFFERENT settled payment's receipt (e.g. a replay
//      of an unrelated nonce). `amount` compares via `cmpRaw` (BigInt) — never `number` (lossy above
//      2^53) and never a lexicographic string compare (which would wrongly rank "9" > "10"). If no
//      `auth` is passed the binding is skipped (back-compat for callers that don't yet hold the auth;
//      the key-pin + signature still apply).
//
// MC1 units 2-4: amount/currency/block_index/settle_ts cross the JSON boundary as decimal-digit
// STRINGS (raw u64). They are passed through to `verifyReceiptSig` verbatim (the FFI parses them);
// `currency` is a small u32 carried as number/string interchangeably. No `Number()` coercion on the
// amount path.
export async function verifyOutcomeReceipt(receipt: any, auth?: ReceiptAuth): Promise<boolean> {
  if (!receipt || typeof receipt !== 'object') return false;
  const sigHex = receipt.receipt_sig;
  const pubHex = receipt.pubkey;
  if (typeof sigHex !== 'string' || typeof pubHex !== 'string') return false;

  // (1) Key pin — rejects a fabricated key even when the forged signature is internally valid.
  //     Case-insensitive: the relay emits lowercase hex (`hex::encode`); a prod pin baked in mixed
  //     case must still match. Precedent: `decidePayerReceipt` lower-cases its nonce compare.
  if (EXPECTED_RECEIPT_PUBKEY !== '' && pubHex.toLowerCase() !== EXPECTED_RECEIPT_PUBKEY.toLowerCase()) return false;

  // (2) Signature over the canonical ReceiptClaim.
  let sigOk: boolean;
  try {
    sigOk = await DpayCore.verifyReceiptSig(
      String(receipt.nonce), String(receipt.from), String(receipt.to),
      String(receipt.amount), Number(receipt.currency),
      String(receipt.block_index), String(receipt.settle_ts),
      sigHex, pubHex,
    );
  } catch {
    return false;
  }
  if (!sigOk) return false;

  // (3) Full-auth binding — the receipt must answer the exact payment the payer authorized. A
  //     mismatch means the receipt is for a different payment (stale relay / replay); treat as
  //     not-verified. `amount` via cmpRaw (BigInt exact); a non-digit receipt amount is malformed →
  //     cmpRaw throws TypeError, translated to `false` (never a thrown crash on the verify path).
  if (auth) {
    if (String(receipt.from) !== auth.from) return false;
    if (String(receipt.to) !== auth.to) return false;
    try {
      if (cmpRaw(String(receipt.amount), auth.amount) !== 0) return false;
    } catch {
      return false;
    }
    if (Number(receipt.currency) !== auth.currency) return false;
    if (String(receipt.nonce) !== auth.nonce) return false;
  }
  return true;
}
