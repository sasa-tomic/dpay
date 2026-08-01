import {DpayCore} from './native';

// R2: verify a settled receipt's canister/ledger Ed25519 signature before trusting the outcome.
// Returns true only if `receipt_sig` verifies under `pubkey` over the canonical ReceiptClaim built
// from the receipt's fields. A merchant/relay cannot forge this; an unverifiable receipt is treated
// as UNKNOWN (honest, never a fake "Paid ✓"). The nonce match is enforced by the caller.
//
// MC1 units 2-4: amount/currency/block_index/settle_ts cross the JSON boundary as decimal-digit
// STRINGS (raw u64). They are passed through to `verifyReceiptSig` verbatim (the FFI parses them);
// `currency` is a small u32 and carried as a number/string interchangeably. No `Number()` coercion
// anywhere on the amount path (that would be lossy above 2^53).
export async function verifyOutcomeReceipt(receipt: any): Promise<boolean> {
  const sigHex = receipt?.receipt_sig;
  const pubHex = receipt?.pubkey;
  if (typeof sigHex !== 'string' || typeof pubHex !== 'string') return false;
  try {
    return await DpayCore.verifyReceiptSig(
      String(receipt.nonce), String(receipt.from), String(receipt.to),
      String(receipt.amount), Number(receipt.currency),
      String(receipt.block_index), String(receipt.settle_ts),
      sigHex, pubHex,
    );
  } catch {
    return false;
  }
}
