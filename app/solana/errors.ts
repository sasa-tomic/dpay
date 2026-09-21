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

/**
 * The endpoint ANSWERED, and the answer was not the data: an HTTP status (429/401/403/5xx) or a
 * JSON-RPC error object. It lives HERE, in the pure module, rather than beside the fetch that
 * throws it (`solana/rpc.ts`), because the classification is what the offline seam and the sign
 * gates branch on and neither may statically import the network module.
 *
 * The distinction it carries is the one the wallet had no way to make: "this endpoint is not
 * serving us" versus "nothing answered". A transport failure observes NOTHING about the endpoint —
 * a payer in airplane mode produces exactly that, and that payer must keep signing. An endpoint
 * that answers 429 for hours is a different fact about the world and gets different copy.
 */
export class SolanaEndpointRefused extends Error {
  /** The HTTP status when the refusal was one; null for a JSON-RPC-level error. */
  readonly status: number | null;
  /** The BRAND, and the reason `isEndpointRefusal` exists rather than a bare `instanceof`: this
   *  class is thrown inside the dynamically-imported network module and caught in the seam that
   *  imports it statically. Two module instances mean two class objects and an `instanceof` that
   *  silently answers false — which here would misreport a dead endpoint as an offline phone, the
   *  exact distinction this type was added to make. A field cannot be duplicated apart. */
  readonly dpayEndpointRefused = true;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'SolanaEndpointRefused';
    this.status = status;
  }
}

/** Did the ENDPOINT answer and refuse us (vs nothing answering at all)? The one supported test —
 *  never `instanceof` (see the brand above), never message text. */
export function isEndpointRefusal(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as {dpayEndpointRefused?: unknown}).dpayEndpointRefused === true;
}

/**
 * The RELAY answered, but its Solana leg is dead: every candidate in the walk came back with
 * the relay's own `dpayRelayError` marker (`solana-upstream-unreachable`, or
 * `solana-unconfigured` — the relay's deploy is missing `DPAY_SOLANA_RPC_URL`). Thrown by the
 * candidate walk in `solana/rpc.ts` at exhaustion, when at least one candidate produced that
 * marker (marker beats a relayed upstream status — one dead relay leg says more about the
 * path than a provider 5xx says about the provider).
 *
 * Classification (R3, `app/solana.ts`): this is TRANSPORT-class — 'unreachable' — NOT a
 * refusal. The distinction it carries: the phone IS online (a dpay relay answered HTTP) and
 * the IC boundary is fine, so R3's connectivity re-probe of icp-api.io would be a pointless
 * 2.5s round trip to confirm a fact this error already proves. The seam maps it directly to
 * 'unreachable' without probing — the same truthful copy ("dpay's relay can't reach Solana")
 * the probe path yields, minus the detour.
 *
 * Branded with a field for the same two-module-instances reason as `SolanaEndpointRefused`:
 * thrown inside the dynamically-imported network module, caught in the statically-imported
 * seam, where `instanceof` would silently answer false.
 */
export class SolanaRelayPathDown extends Error {
  /** The BRAND — see `isRelayPathDown`; the field cannot be duplicated apart across the two
   *  module instances the way a class object can. */
  readonly dpayRelayPathDown = true;
  /** The marker code the relay sent (`solana-upstream-unreachable` | `solana-unconfigured`) —
   *  carried for logs/diagnosis; the copy keys off the class, not the code. */
  readonly relayErrorCode: string;
  constructor(message: string, relayErrorCode: string) {
    super(message);
    this.name = 'SolanaRelayPathDown';
    this.relayErrorCode = relayErrorCode;
  }
}

/** Was this failure the relay's Solana leg being down (vs an endpoint refusing, vs nothing
 *  answering)? The one supported test — the brand field, never `instanceof`. */
export function isRelayPathDown(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as {dpayRelayPathDown?: unknown}).dpayRelayPathDown === true;
}

/**
 * The endpoint refused this request with HTTP 429, or a previous 429's cooldown has not elapsed.
 * Carries the wait the ENDPOINT asked for (`Retry-After`) or the interval this client chose, so
 * the caller can say what is happening and when it will retry rather than showing a bare failure.
 *
 * A cooldown refusal is still a refusal BY THE ENDPOINT (it is the endpoint's own 429, held for
 * the window it asked for), which is why this extends `SolanaEndpointRefused`.
 */
export class SolanaRateLimited extends SolanaEndpointRefused {
  readonly retryAfterMs: number;
  constructor(url: string, retryAfterMs: number) {
    super(
      `solana rpc rate limit (HTTP 429) at ${url} — the endpoint is refusing requests from this ` +
        `wallet; not sending again for ${Math.round(retryAfterMs / 1000)}s`,
      429,
    );
    this.name = 'SolanaRateLimited';
    this.retryAfterMs = retryAfterMs;
  }
}

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
  // The send path's lazily-loaded network module never arrived (loadRpcForSend's bound — the
  // served web build fetches `rpc-*.js` as a chunk, and a stalled origin fetch stalled three live
  // sends there in 2026-09-21). Checked BEFORE the timeout class: this failure needs its own
  // instruction (reopen the screen — the reload re-fetches the chunk), not generic "timed out".
  if (/rpc module failed to load/i.test(msg)) {
    return M.sol.engineLoad;
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
  // The broadcast seam's refused-twice class (attempt-#5 fix): the network's preflight
  // simulation refused the transfer on Blockhash-not-found, the ONE diagnosed refresh
  // (re-fetch + re-sign + broadcast once) ALSO came back refused, and nothing was accepted.
  // Checked BEFORE the plain blockhash class: this message contains "Blockhash not found" too,
  // but the copy must name the double refusal + the nothing-sent fact, not a busy network.
  if (/refused twice/i.test(msg)) {
    return M.sol.blockhashTwice;
  }
  if (/blockhash/i.test(msg)) {
    return M.sol.blockhash;
  }
  return msg;
}

/** Is this the preflight simulation's Blockhash-not-found refusal — the ONE broadcast failure
 *  the diagnosed single refresh owns (both the prose and the enum spellings; RPC versions
 *  differ)? The message names the state itself: the simulating node's blockhash queue does not
 *  hold the message's recent blockhash — a provider-side state anomaly on a fresh
 *  'confirmed'-commitment hash (the 2026-09-21 attempt-#5 live signature), never a bytes
 *  problem. Anything else (an instruction error, insufficient funds, …) must NOT refresh: there
 *  a re-sign on a new block would be a blind retry, which the founder rules forbid. */
export function isSolBlockhashNotFound(msg: string): boolean {
  return /transaction simulation failed.*(?:blockhash not found|blockhashnotfound)/i.test(msg);
}

/** Did the network INCLUDE this transaction and then fail it? `confirmTransaction` (`solana/rpc.ts`)
 *  throws `transaction failed: <err>` for exactly that case — a `getSignatureStatuses` entry with a
 *  non-null `err` — and nothing else in this app throws that prefix.
 *
 *  It exists because that outcome is the one post-broadcast failure that is DEFINITE: no lamports
 *  moved and none ever will, unlike a confirmation timeout over a transaction that may still land.
 *  A caller that treats every post-broadcast throw the same way tells the payer "don't pay again"
 *  about a payment they must in fact make again (`SolPayMode.sendSolForOcp` is why this is here).
 *  Classification only — the copy belongs to the message catalog, like every other class above. */
export function isSolTransactionFailed(msg: string): boolean {
  return /^transaction failed:/i.test(msg.trim());
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
