// Solana RPC error → human copy. PURE (no react-native, no fetch, no globals) so it runs under
// jest on the fast inner loop. This is the SINGLE source of truth for translating raw Solana RPC
// errors into actionable user-facing text — used by the SOL send sheet (sendSol) and the SOL
// merchant broadcast surface (broadcastSolPayment).
//
// Why this exists: a payer with no balance hit the verbatim string "solana rpc: Transaction
// simulation failed: Attempt to debit on account but found no record of a prior credit" — a raw
// blockchain error with no guidance. That "no record of a prior credit" class is the #1 error an
// unfunded account produces (the source account does not exist on-chain). Unknown errors fall
// through VERBATIM — never hide a novel failure, only reword the classes a user can act on.
//
// The copy itself lives in the message catalog; this module owns the CLASSIFICATION (which raw
// error means what), which is locale-invariant. `M` is a pure data module — no react-native, no
// globals — so this stays jest-safe on the fast inner loop.
import {M} from '../i18n';

/** Map a raw Solana error message (RPC body, AbortError, confirmation timeout) to human copy.
 *  Returns the original string unchanged when no known class matches — diagnosis stays possible. */
export function friendlySolError(msg: string): string {
  // Account does not exist on-chain / has never been credited (zero balance). This is the "no
  // funds" error — distinct from "insufficient" (account exists but can't cover amount+fee). NOTE:
  // on a load-balanced public endpoint (the shipped devnet default), a freshly-credited account can
  // be invisible to the simulating node and produce the SAME string transiently — so the copy covers
  // both the genuine unfunded case and the devnet-pool-lag case rather than asserting "no SOL".
  if (/no record of a prior credit|found no record/i.test(msg)) {
    return M.sol.noRecordOfCredit;
  }
  if (/abort|timed out|timeout|confirmation timeout/i.test(msg)) {
    return M.sol.timedOut;
  }
  if (/insufficient/i.test(msg)) {
    return M.sol.insufficient;
  }
  if (/rent\s*exempt|rent-exempt|not exempt/i.test(msg)) {
    return M.sol.rentExempt;
  }
  if (/blockhash/i.test(msg)) {
    return M.sol.blockhash;
  }
  return msg;
}

/** NFC-tap variant of `friendlySolError`: NEVER returns the raw string. The tap status view
 *  renders its sub-line verbatim, so an unrecognized exception must map to honest generic copy
 *  (A2 — no raw `e.message` from NFC paths in the UI); the caller console.warn's the raw message
 *  so the dev loop stays fail-loud. `fallback` lets outcome-unknown (pending) call sites use
 *  check-your-balance copy instead of a retry instruction. */
export function friendlySolTapError(msg: string, fallback = M.sol.tapFailed): string {
  const mapped = friendlySolError(msg);
  return mapped !== msg ? mapped : fallback;
}
