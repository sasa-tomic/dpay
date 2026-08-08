// Solana RPC error → human copy. PURE (no react-native, no fetch, no globals) so it runs under
// jest on the fast inner loop. This is the SINGLE source of truth for translating raw Solana RPC
// errors into actionable user-facing text — used by the SOL pay setup (createNonceAccount), the
// SOL send sheet (sendSol), and the SOL merchant broadcast surface (broadcastSolPayment).
//
// Why this exists: a payer with no balance hit the verbatim string "solana rpc: Transaction
// simulation failed: Attempt to debit on account but found no record of a prior credit" — a raw
// blockchain error with no guidance. That "no record of a prior credit" class is the #1 error an
// unfunded account produces (the source account does not exist on-chain). Unknown errors fall
// through VERBATIM — never hide a novel failure, only reword the classes a user can act on.

/** Map a raw Solana error message (RPC body, AbortError, confirmation timeout) to human copy.
 *  Returns the original string unchanged when no known class matches — diagnosis stays possible. */
export function friendlySolError(msg: string): string {
  // Account does not exist on-chain / has never been credited (zero balance). This is the "no
  // funds" error — distinct from "insufficient" (account exists but can't cover amount+fee).
  if (/no record of a prior credit|found no record/i.test(msg)) {
    return "Your account has no SOL yet. Deposit SOL to your address first, then try again.";
  }
  if (/abort|timed out|timeout|confirmation timeout/i.test(msg)) {
    return "Timed out. Check your connection and try again.";
  }
  if (/insufficient/i.test(msg)) {
    return "Not enough SOL for this send plus the network fee.";
  }
  if (/rent\s*exempt|rent-exempt|not exempt/i.test(msg)) {
    return "After this send, your account would fall below the minimum balance. Send a smaller amount.";
  }
  if (/blockhash/i.test(msg)) {
    return "The network was too busy. Try again.";
  }
  return msg;
}
