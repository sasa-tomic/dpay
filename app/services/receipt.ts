import {DpayCore} from './native';

// R2: verify a settled receipt's canister/ledger Ed25519 signature before trusting the outcome.
// Returns true only if `receipt_sig` verifies under `pubkey` over the canonical ReceiptClaim built
// from the receipt's fields. A merchant/relay cannot forge this; an unverifiable receipt is treated
// as UNKNOWN (honest, never a fake "Paid ✓"). The nonce match is enforced by the caller.
export async function verifyOutcomeReceipt(receipt: any): Promise<boolean> {
  const sigHex = receipt?.receipt_sig;
  const pubHex = receipt?.pubkey;
  if (typeof sigHex !== 'string' || typeof pubHex !== 'string') return false;
  try {
    return await DpayCore.verifyReceiptSig(
      String(receipt.nonce), String(receipt.from), String(receipt.to),
      Number(receipt.amount), Number(receipt.currency),
      Number(receipt.block_index), Number(receipt.settle_ts),
      sigHex, pubHex,
    );
  } catch {
    return false;
  }
}
