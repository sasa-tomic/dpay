// Minimal Solana JSON-RPC 2.0 client over `fetch` with bounded timeouts. NETWORK module —
// dynamic-imported from the seam `app/solana.ts` so `@solana/*` (here: none) and real RPC never run
// under jest/e2e (the seam no-ops when `solanaRpcUrl()` is empty, which jest.setup.js + the e2e
// driver set). Exposes the online SOL MVP + offline-pay rail calls:
//   getBalance, getLatestBlockhash, sendTransaction, confirmTransaction (poll getSignatureStatuses).
//
// # The candidate walk (R2 multi-home, the R1 policy applied to the SOL rail)
//
// Every exported call takes the endpoint as a LIST (`string | readonly string[]` — the seam
// passes `solanaRpcUrls()`), walked ONCE in order, no mid-call retries. Per candidate:
//   transport failure (fetch threw, or the call's own timeout fired — NOT a caller abort)
//     → try the next home;
//   HTTP ≥500, or a body carrying the relay's `dpayRelayError` marker (see below) → try the
//     next home (a relay that is 500ing or whose SOLANA leg is dead is not this request's answer);
//   an OPEN 429-cooldown on that URL → SKIP it, still try the next home;
//   HTTP 4xx (incl. 404) or a 429 → an ANSWER: brand SolanaEndpointRefused/SolanaRateLimited
//     and STOP — 4xx never fails over (it says something about THIS request, not the home);
//   2xx → the answer; cooldown cleared; RETURN — a 2xx is never walked past.
//
// THE SEND-PREFLIGHT EXCEPTION (attempt-#6, 2026-09-21 — sendTransaction ONLY): a
// Blockhash-not-found refusal is the answering node's preflight STATE, not a verdict on the
// bytes — proven live when the head refused the same signed deposit 8/8 while a byte-exact
// replay to the public endpoint was ACCEPTED and FINALIZED. So for sendTransaction (and only
// sendTransaction, via `walkBlockhashRefusal`), that one refusal — however wrapped (a 2xx body
// carrying the JSON-RPC `error` object, or an HTTP-level error body naming the state) — WALKS:
// the SAME signed bytes go to the next candidate, no re-sign (the signature is valid on any
// endpoint; Solana dedups identical bytes by signature). Every OTHER refusal — an instruction
// error, insufficient funds — is a verdict on the transaction itself and refuses in place: a
// genuinely invalid tx would be refused everywhere, and hammering failover homes with it buys
// nothing. At exhaustion, when EVERY answering home refused with that state and no home died
// silently, the walk throws the refusal verbatim (host + raw message) — the seam that called
// it owns whatever comes next. POSTURE NOTE (the same day, attempts #5/#6/#8 resolution): the
// PAYMENT seam (`broadcastSignedWithFreshBlockhash`) now broadcasts `skipPreflight: true`, so
// its provider should never answer with this preflight state at all — this walk stays LIVE for
// the paths that still run preflight (`submitRawSolTx`'s venue hand-off,
// `broadcastSolPayment`'s merchant rail) and is defensive parity for the skipPreflight seam
// (a blockhash-shaped answer, if one ever came, would just walk the same bytes — no re-sign
// anywhere in the walk).
//
// EXHAUSTION precedence (what the walk throws when no candidate answered):
//   1. any candidate answered with the relay's marker → SolanaRelayPathDown (transport-class:
//      the relay answered HTTP, so the phone is online — its Solana leg is what is dead);
//   2. else any candidate answered with a relayed upstream HTTP status (5xx passed through
//      verbatim) → SolanaEndpointRefused with THAT status — provider-side refusal copy;
//   3. else if every candidate was cooldown-gated → SolanaRateLimited for the first gate;
//   4. else all-transport-dead → rethrow the LAST transport error verbatim, so R3's
//      classifyTransportFailure can probe the IC boundary (offline vs unreachable).
//
// The `dpayRelayError` marker is the relay's OWN failure body — `{"dpayRelayError":
// "solana-upstream-unreachable"|"solana-unconfigured", "detail"?}` (crates/dpay-relay/src/
// solana.rs "Failure semantics"; a body marker because response headers are unreadable
// cross-origin). A provider's error body never carries it, which is exactly how the client
// tells "dpay's relay can't reach Solana" from "the provider refused us".
//
// # Broadcast safety (sendTransaction)
//
// The walk applies to broadcasts too, and is SAFE there: Solana dedups identical signed
// transactions by signature, so resubmitting identical bytes to the next home is idempotent
// (worst case the second relay's provider answers "already processed/known" — an answer the
// merchant state machine treats as submitted-unknown, never a broadcast-time rejection;
// solana.ts broadcastSolPayment). The one forbidden move — walking after a 2xx — cannot
// happen: a 2xx returns immediately.
//
// Timeouts use the shared `lib/timeout.ts` compose (NOT AbortSignal.any/AbortSignal.timeout —
// those ES2024/ES2022 statics are absent from this project's TS `lib` and not guaranteed on
// Hermes/RN). A caller signal (first-abort-wins) is forwarded in.
//
// ATTEMPT DEADLINES (the R1 lesson `services/relay.ts` relayFetch learned the hard way): whenever
// the walk has a SECOND candidate, EVERY attempt — attempt 0 included — runs under its own
// always-armed internal deadline; attempt 0 gets the FULL `timeoutMs` (a slow-but-alive preferred
// home keeps working exactly as before), failover attempt i gets `timeoutMs >> i` floored at 1 s,
// bounding the whole walk at ≈2×timeoutMs (a geometric sum). A SINGLE-candidate list keeps the
// caller-owns-the-deadline contract byte-for-byte (`composeTimeout`): no failover to fuel, and
// arming would cap caller-granted headroom at `timeoutMs`. An attempt's own expiry counts as
// transport-dead (next candidate; exhaustion rung 4) — only a CALLER abort throws out of the walk
// immediately.
//
// E2E STUB SEAM: when `globalThis.__DPAY_TEST_SOLANA_RPC_STUB` is set (by jest.setup.js or the e2e
// driver), every `rpcFetch` routes to that object keyed by raw RPC method name instead of `fetch`.
// This lets the offline e2e loop (flow 46) exercise sign/broadcast against a deterministic in-memory
// Solana simulator with zero real network — mirroring the `__DPAY_TEST_NFC_SESSION` precedent. The
// stub is checked per-call (runtime), so setting/clearing it between tests takes effect immediately.
// The stub runs BEFORE the walk (a stubbed environment has no homes to fail between) and its
// throws propagate untouched.

import {composeArmedTimeout, composeTimeout as composeTimeoutShared} from '../lib/timeout';
import {bytesToBase64} from '../lib/base64';
import {SOL_PAYMENT_COMMITMENT} from '../config/constants';
// The two thrown-error SHAPES live in the pure module (`solana/errors.ts`) because the offline
// seam and the sign gates branch on them and neither may statically import this network module.
// `isSolBlockhashNotFound` is the attempt-#6 walk's classifier — the SAME predicate the seam's
// refresh branches on, so walk and seam can never disagree about what the state is.
import {SolanaEndpointRefused, SolanaRateLimited, SolanaRelayPathDown, isSolBlockhashNotFound} from './errors';

/** A fetched recent blockhash + its validity window + the context slot it was observed at. The v2
 *  payment rail threads `contextSlot` as the `minContextSlot` for every downstream freshness call
 *  (isBlockhashValid, getBlockHeight, sendTransaction) so reorg-aware RPC behavior is consistent. */
export interface SolanaBlockhash {
  /** base58-encoded recent blockhash (raw RPC shape — decode to 32 bytes at the call site). */
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  /** context.slot from the getLatestBlockhash response — passed as minContextSlot downstream. */
  readonly slot: number;
  /** alias for `slot` (the context slot); kept explicit so the freshness state machine reads clearly. */
  readonly contextSlot: number;
}

export interface SolanaRpcOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** confirmTransaction poll spacing (default 1.5s). */
  pollMs?: number;
  /** minContextSlot for RPC methods that support it (getBlockHeight, isBlockhashValid,
   *  getFeeForMessage, sendTransaction). Threads the request's context slot for reorg-awareness. */
  minContextSlot?: number;
  /** SEND-ONLY (set by `sendTransaction`, never by a caller): a Blockhash-not-found refusal is
   *  walk-worthy preflight state (module header, "The send-preflight exception") instead of a
   *  stop-the-walk answer. Every other method/classifies-refusal-in-place behavior is unchanged. */
  walkBlockhashRefusal?: boolean;
  /** Send-walk tracer, wired by `sendTransaction` to the money log: fired each time the walk
   *  ADVANCES to the next candidate (transport death, relay marker, provider 5xx, cooldown
   *  skip, or the blockhash walk), NEVER at exhaustion (the thrown error is that story) and
   *  never for a last candidate. `from`/`to` are HOSTS — never URLs: the shipped RPC URL
   *  carries the provider key as a query parameter, and a log line is exactly where a key
   *  must not appear. */
  onFailover?: (from: string, to: string, why: string) => void;
}

export interface SolanaSignatureStatus {
  readonly confirmationStatus?: 'processed' | 'confirmed' | 'finalized';
  readonly err?: unknown;
}

/** A raw JSON-RPC method handler used by the e2e stub simulator (`__DPAY_TEST_SOLANA_RPC_STUB`).
 *  Returns the `result` field of the JSON-RPC response. */
export type SolanaRpcStubHandler = (params: unknown[]) => unknown | Promise<unknown>;

/** The e2e stub simulator: keyed by RPC method name (e.g. `'getBalance'`, `'getAccountInfo'`). Any
 *  method absent from the stub throws a typed error (never silently falls through to `fetch`). */
export type SolanaRpcStub = Partial<Record<string, SolanaRpcStubHandler>>;

const DEFAULT_TIMEOUT_MS = 8000;
const CONFIRM_TIMEOUT_MS = 30000;
const CONFIRM_POLL_MS = 1500;
/** Per-attempt deadline floor for the multi-candidate walk (module header): once the
 *  `timeoutMs >> i` halving reaches this, every further attempt costs the floor — the geometric
 *  sum that bounds a walk at ≈2×timeoutMs instead of N×timeoutMs. */
const ATTEMPT_TIMEOUT_FLOOR_MS = 1000;
/** Marker-parse body cap: a real `dpayRelayError` body is ~100 bytes of JSON, so nothing longer
 *  is ever parsed as a candidate marker — the walk is checking whose failure body this is, and it
 *  will not feed an unbounded blob to JSON.parse to find out. */
const MARKER_BODY_CAP = 65536;

/** First cooldown after a 429 that carried no `Retry-After` — longer than the 2.5s balance poll,
 *  so the very next tick is skipped rather than re-sending the volley that was just refused. */
export const RATE_LIMIT_BASE_MS = 5000;
/** Cooldown ceiling. Bounded on purpose: an unbounded backoff turns a temporary limit into a wallet
 *  that never reads a balance again, which looks broken and is not more polite than probing once a
 *  minute. */
export const RATE_LIMIT_MAX_MS = 60000;

/** Per-endpoint cooldown: when a 429 arrives, no request goes to that URL until `until`, and the
 *  next refusal doubles the interval. Keyed by URL so one throttled endpoint never silences
 *  another. Cleared by any success — the limit is over when the endpoint says it is, by answering.
 *
 *  It gates EVERY caller, reads and broadcasts alike. A 429 is the server instructing this client
 *  to stop; sending a transaction into it would very likely be refused too, and `SolanaRateLimited`
 *  names the wait, which is a better thing to put in front of a user than a bare `http 429`. */
const cooldowns = new Map<string, {until: number; waitMs: number}>();

/** `Retry-After` in ms when the endpoint sent a usable one (delta-seconds form — the only form
 *  Solana RPC providers send), else null so the caller applies its own backoff. */
function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get('Retry-After');
  if (raw === null) return null;
  const secs = Number(raw.trim());
  return Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : null;
}

/** Record a refusal and return the wait it opens: the endpoint's own `Retry-After`, else this
 *  client's interval, doubling per consecutive refusal up to the cap. */
function openCooldown(url: string, fromHeader: number | null): number {
  const prev = cooldowns.get(url);
  const waitMs = fromHeader ?? Math.min(prev ? prev.waitMs * 2 : RATE_LIMIT_BASE_MS, RATE_LIMIT_MAX_MS);
  cooldowns.set(url, {until: Date.now() + waitMs, waitMs});
  return waitMs;
}

let nextId = 1;

function activeStub(): SolanaRpcStub | undefined {
  return (globalThis as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB;
}

/** The endpoint argument as the ordered, de-duplicated candidate list. `solanaRpcUrls()` is
 *  already clean; this also tolerates hand-built lists (tests) and a bare string (every
 *  pre-walk caller shape). An empty string candidate is dropped — the seam no-ops on the
 *  rail being off long before this module runs. */
function candidatesOf(url: string | readonly string[]): string[] {
  const input = typeof url === 'string' ? [url] : url;
  const out: string[] = [];
  for (const u of input) {
    if (typeof u !== 'string' || u === '' || out.includes(u)) continue;
    out.push(u);
  }
  return out;
}

/** Parse a relay-originated error body — the marker contract (module header). `{"dpayRelayError":
 *  <code>, "detail"?: <phrase>}`; null for anything else (provider bodies, prose, HTML), so
 *  only the relay's own two failures classify as relay-path trouble. */
function relayErrorMarker(body: string): {dpayRelayError: string; detail?: string} | null {
  try {
    const j = JSON.parse(body) as {dpayRelayError?: unknown; detail?: unknown};
    if (typeof j?.dpayRelayError === 'string' && j.dpayRelayError.length > 0) {
      return {dpayRelayError: j.dpayRelayError, detail: typeof j.detail === 'string' ? j.detail : undefined};
    }
    return null;
  } catch {
    return null;
  }
}

/** The marker check with an honest body cap: a body DECLARING (via content-length) more than
 *  `MARKER_BODY_CAP` bytes is not parsed as a candidate marker at all, and a body of unknown
 *  declared length is parsed only up to the cap. */
function markerCapped(headers: Headers, body: string): {dpayRelayError: string; detail?: string} | null {
  const declared = headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MARKER_BODY_CAP) return null;
  }
  return relayErrorMarker(body.slice(0, MARKER_BODY_CAP));
}

/** One walk, one call. The policy lives in the module header ("The candidate walk"); this is
 *  its mechanical truth: one pass, in order, no candidate tried twice, no candidate retried.
 *  Reads and broadcasts share it — see "Broadcast safety" for why that is safe. */
async function rpcFetch(url: string | readonly string[], method: string, params: unknown[], opts?: SolanaRpcOpts): Promise<unknown> {
  const stub = activeStub();
  if (stub) {
    const handler = stub[method];
    if (typeof handler !== 'function') {
      throw new Error(`solana rpc stub: method ${method} not implemented`);
    }
    return await handler(params);
  }
  const candidates = candidatesOf(url);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const walkBlockhash = opts?.walkBlockhashRefusal === true;
  const onFailover = opts?.onFailover;
  // The exhaustion facts, first-seen wins (the FIRST relay to say its leg is down, the FIRST
  // provider status to arrive — earlier candidates are the preferred homes; their verdict
  // describes the world more faithfully than a later failover's echo).
  let relayMarker: {url: string; code: string; detail?: string} | null = null;
  let upstreamStatus: {url: string; status: number; body: string} | null = null;
  let cooldownGate: {url: string; remainingMs: number} | null = null;
  let lastTransport: unknown = null;
  // The attempt-#6 send-preflight fact: the FIRST Blockhash-not-found refusal, verbatim. Only
  // ever set when `walkBlockhashRefusal` is on (sendTransaction) — reads classify in place.
  let blockhashRefusal: {url: string; message: string} | null = null;
  let asked = 0; // candidates that actually got a request out (not cooldown-skipped)
  // ONE id per LOGICAL request: every failover attempt of this call reuses it, so the resubmit
  // carries byte-identical bytes (Solana dedups by tx signature; the relay's canonical-body
  // cache key matches across attempts too).
  const requestId = nextId++;
  for (let ci = 0; ci < candidates.length; ci++) {
    const candidate = candidates[ci];
    // The walk ADVANCED to the next candidate — the tracer event (`onFailover`, sendTransaction
    // only). Fired only when a NEXT candidate exists: the move is the event, exhaustion is the
    // thrown error's story. Hosts only, never URLs — the URL carries the provider key.
    const failover = (why: string) => {
      if (onFailover !== undefined && ci + 1 < candidates.length) {
        onFailover(hostOf(candidate), hostOf(candidates[ci + 1]), why);
      }
    };
    // The cooldown gate is PER CANDIDATE: an open one on A skips A (no packet leaves the
    // device toward A) while B — a different endpoint with its own limit state — still gets
    // its chance. Only when EVERY candidate is gated does the gate answer (below).
    const cooling = cooldowns.get(candidate);
    if (cooling !== undefined) {
      const remaining = cooling.until - Date.now();
      if (remaining > 0) {
        if (cooldownGate === null) cooldownGate = {url: candidate, remainingMs: remaining};
        failover('cooldown');
        continue;
      }
    }
    asked++;
    // Attempt deadlines (module header "ATTEMPT DEADLINES"): attempt 0 gets the FULL `timeoutMs`
    // armed on a fresh internal controller; each failover halves, floored at 1 s (`asked` is the
    // 1-based request counter, so `asked - 1` is this attempt's index — a cooldown-SKIPPED
    // candidate sends no request and consumes no budget). Armed only when a second candidate
    // exists; a single-candidate list keeps the caller-owns-the-deadline contract byte-for-byte.
    // An armed expiry aborts the composed signal only — the catch below reads it as
    // transport-dead and walks on; a CALLER abort rethrows out of the walk immediately.
    const attemptMs = Math.max(timeoutMs >> (asked - 1), ATTEMPT_TIMEOUT_FLOOR_MS);
    const armed = candidates.length > 1;
    const {signal, cancel} = armed
      ? composeArmedTimeout(opts?.signal, attemptMs)
      : composeTimeoutShared(opts?.signal, attemptMs);
    let r: Response;
    try {
      r = await fetch(candidate, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        // ONE id per LOGICAL request, minted below the loop and reused by every failover
        // attempt: the resubmit to the next home carries byte-identical bytes (Solana dedups
        // by tx signature; the relay's canonical-body cache key matches across attempts).
        body: JSON.stringify({jsonrpc: '2.0', id: requestId, method, params}),
        signal,
      });
    } catch (e) {
      // A CALLER abort is the caller ending the call — never a walk signal; a timeout (the
      // compose's own timer, which leaves opts.signal untouched) is this home being too slow
      // — exactly what the next home exists for.
      cancel();
      if (opts?.signal?.aborted) throw e;
      lastTransport = e;
      failover('transport');
      continue;
    }
    try {
      if (r.status === 429) throw new SolanaRateLimited(candidate, openCooldown(candidate, retryAfterMs(r.headers)));
      if (!r.ok) {
        // The status alone was never enough to act on: a Helius 401 and a 403 mean different things
        // and both say WHICH in the body. Named endpoint (host only — the URL carries the API key),
        // method and the first of the body.
        const body = await r.text().catch((e: unknown) => `<body unreadable: ${e instanceof Error ? e.message : String(e)}>`);
        const marker = markerCapped(r.headers, body);
        if (marker !== null) {
          // dpay's OWN failure body (module header): this home's Solana leg is down. The next
          // home may be healthy; exhaustion remembers the marker with top precedence.
          if (relayMarker === null) relayMarker = {url: candidate, code: marker.dpayRelayError, detail: marker.detail};
          failover('relay-marker');
          continue;
        }
        if (r.status >= 500) {
          // A ≥500 without the marker is the PROVIDER's status relayed verbatim — walk on (the
          // next home fronts a different provider instance), and exhaustion reports it as the
          // provider-side refusal it is.
          if (upstreamStatus === null) upstreamStatus = {url: candidate, status: r.status, body: body.slice(0, 200)};
          failover(`http ${r.status}`);
          continue;
        }
        // A 4xx body naming the blockhash state is the send-preflight exception (module header,
        // "The send-preflight exception"): an HTTP-wrapped refusal of the SAME preflight state
        // the 2xx JSON-RPC `error` shape carries — walk-worthy for sendTransaction, in place
        // for everything else.
        if (walkBlockhash && isSolBlockhashNotFound(body)) {
          if (blockhashRefusal === null) blockhashRefusal = {url: candidate, message: body.slice(0, 200)};
          failover('blockhash-not-found');
          continue;
        }
        // 4xx is an ANSWER about this request: no walk, today's brand, today's message shape.
        throw new SolanaEndpointRefused(`solana rpc ${method} → ${hostOf(candidate)}: HTTP ${r.status}: ${body.slice(0, 200)}`, r.status);
      }
      // A 2xx body carrying the relay's `dpayRelayError` marker is a broken or hostile relay:
      // markers ride 503/504 by contract (crates/dpay-relay/src/solana.rs "Failure semantics"),
      // so this endpoint is honoring neither its own contract nor its status line. The
      // machine-readable field outranks the status — treat it as the relay-marker failure (walk
      // on; exhaustion rung 1) instead of reading it as a JSON-RPC envelope, whose `result`
      // would be undefined and die a raw, unclassified TypeError downstream.
      const j: {dpayRelayError?: unknown; detail?: unknown; error?: {message?: string}; result?: unknown} = await r.json();
      // The endpoint answered: whatever it said, it is talking to us again, so the gate is done.
      // Cleared on an RPC-level error too — a rejected METHOD is not a refused CLIENT.
      cooldowns.delete(candidate);
      if (typeof j?.dpayRelayError === 'string' && j.dpayRelayError.length > 0) {
        if (relayMarker === null) {
          relayMarker = {url: candidate, code: j.dpayRelayError, detail: typeof j.detail === 'string' ? j.detail : undefined};
        }
        failover('relay-marker');
        continue;
      }
      if (j.error) {
        // THE ATTEMPT-#6 WALK (sendTransaction only): a Blockhash-not-found JSON-RPC error is
        // the answering node's send-preflight STATE, not a verdict on the bytes — proven live
        // by the byte-exact replay of the refused signed tx to the next endpoint (accepted +
        // finalized). The signature is valid on any endpoint, so the SAME bytes walk to the
        // next candidate; NO re-sign here — the seam's one refresh-and-resign owns re-signing,
        // and fires only when EVERY candidate has refused (exhaustion, below). Every OTHER
        // JSON-RPC error (an instruction error, insufficient funds, …) is a verdict on the
        // transaction itself: refused in place, never walked, never refreshed.
        const rawMsg = typeof j.error.message === 'string' ? j.error.message : String(j.error.message ?? 'error');
        if (walkBlockhash && isSolBlockhashNotFound(rawMsg)) {
          if (blockhashRefusal === null) blockhashRefusal = {url: candidate, message: rawMsg};
          failover('blockhash-not-found');
          continue;
        }
        throw new SolanaEndpointRefused(`solana rpc: ${j.error.message ?? 'error'}`, null);
      }
      return j.result;
    } finally {
      cancel();
    }
  }
  // EXHAUSTED — no candidate returned an answer. The precedence (module header):
  //   1. MARKER, 2. UPSTREAM STATUS, then 3. the send-preflight blockhash refusal (send-only,
  // unanimous), 4. ALL-GATED, 5. TRANSPORT, 6. the no-candidate guard.
  if (relayMarker !== null) {
    throw new SolanaRelayPathDown(
      `solana rpc ${method}: dpay's relay ${hostOf(relayMarker.url)} could not reach Solana ` +
        `(${relayMarker.code}${relayMarker.detail ? `: ${relayMarker.detail.slice(0, 140)}` : ''})`,
      relayMarker.code,
    );
  }
  if (upstreamStatus !== null) {
    throw new SolanaEndpointRefused(
      `solana rpc ${method} → ${hostOf(upstreamStatus.url)}: HTTP ${upstreamStatus.status}: ${upstreamStatus.body}`,
      upstreamStatus.status,
    );
  }
  if (blockhashRefusal !== null && lastTransport === null) {
    // THE SEND-PREFLIGHT REFUSAL, UNANIMOUS (sendTransaction only — the fact is only recorded
    // under `walkBlockhashRefusal`): every home that ANSWERED refused this broadcast with the
    // blockhash-not-found state, and no home died silently — a transport death would make the
    // agreement unreadable, so the strict all-refused rule defers to it. The message carries
    // the raw refusal verbatim (host + raw state) for the caller to surface honestly. The
    // payment seam no longer refresh-and-resigns on it (skipPreflight posture — see the
    // sendTransaction doc); a tx silently dropped for a dead blockhash stays the caller's
    // honest unknown, and the walk itself still never re-signs.
    throw new SolanaEndpointRefused(
      `solana rpc ${method} → ${hostOf(blockhashRefusal.url)}: ${blockhashRefusal.message}`,
      null,
    );
  }
  if (asked === 0 && cooldownGate !== null) {
    // Every home is inside its own 429 window: the endpoints' own instruction, held.
    throw new SolanaRateLimited(cooldownGate.url, cooldownGate.remainingMs);
  }
  if (lastTransport !== null) throw lastTransport;
  throw new Error(`solana rpc ${method}: no usable candidate endpoint (${candidates.length} configured)`);
}

/** The endpoint's HOST, never its URL: the shipped RPC URL carries an API key as a query
 *  parameter, and a log line is exactly where a key must not appear. */
function hostOf(url: string): string {
  const scheme = url.indexOf('://');
  const rest = scheme < 0 ? url : url.slice(scheme + 3);
  const end = rest.search(/[/?#]/);
  return end < 0 ? rest : rest.slice(0, end);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, {once: true});
  });
}

/** Read an account's lamport balance as a decimal-digit string (lamports < 2^53 for all real
 *  supplies, but String() keeps the app-wide "amounts are strings" invariant). */
export async function getBalance(url: string | readonly string[], address: string, opts?: SolanaRpcOpts): Promise<string> {
  const result = (await rpcFetch(url, 'getBalance', [address], opts)) as {value: number};
  return String(result.value);
}

/** Fetch a fresh recent blockhash + its last-valid block height (needed to build + track a tx).
 *  v2: also captures `context.slot` (the slot the blockhash was observed at, threaded as
 *  `minContextSlot` for every downstream freshness call). Backward-compatible — callers reading
 *  `.blockhash`/`.lastValidBlockHeight` keep working; the new `slot`/`contextSlot` are additive. */
export async function getLatestBlockhash(url: string | readonly string[], opts?: SolanaRpcOpts): Promise<SolanaBlockhash> {
  const result = (await rpcFetch(url, 'getLatestBlockhash', [{commitment: SOL_PAYMENT_COMMITMENT}], opts)) as {
    context: {slot: number};
    value: {blockhash: string; lastValidBlockHeight: number};
  };
  const contextSlot = result.context.slot;
  return {
    blockhash: result.value.blockhash,
    lastValidBlockHeight: result.value.lastValidBlockHeight,
    slot: contextSlot,
    contextSlot,
  };
}

/** Broadcast a raw signed transaction (bytes). Base64-encodes internally for the wire. Returns the
 *  transaction signature (base58).
 *
 *  v2: when `opts.config` is provided, its `{commitment, minContextSlot, skipPreflight, maxRetries}`
 *  are passed through as the second RPC param (the v2 freshness state machine sets these for
 *  preflight + context slot binding). Without `opts.config` the original `{encoding:'base64'}`-only
 *  shape is sent, so the v1 callers (submitRawSolTx's venue hand-off) stay byte-identical.
 *  THE PAYMENT SEAM'S POSTURE (2026-09-21, attempts #5/#6/#8): `broadcastSignedWithFreshBlockhash`
 *  passes `{skipPreflight: true, maxRetries: 0}` — the provider's preflight simulation layer was the
 *  proven 9+ refusal source (its "Blockhash not found" STATE, not a bytes verdict), so the payment
 *  seam bypasses it and the chain is the referee; maxRetries: 0 keeps re-attempts app-owned (the
 *  walk + the callers' re-submit seams). `broadcastSolPayment` (merchant rail) keeps preflight ON.
 *
 *  WALK SAFETY (module header, "Broadcast safety"): `url` is the candidate LIST and a
 *  broadcast that dies transport-dead or on the relay's marker at home A is re-SENT, same
 *  bytes, at home B. That is safe by Solana's own dedup: identical signed transactions are
 *  idempotent by signature, so the worst case across homes is a second "already processed/
 *  known" answer. A 2xx is NEVER walked past — it returns immediately, so a broadcast that
 *  any home accepted is sent exactly once as far as this client can tell.
 *
 *  THE ATTEMPT-#6 WALK (2026-09-21): this method sets `walkBlockhashRefusal`, so a
 *  Blockhash-not-found refusal — however wrapped — walks the SAME signed bytes to the next
 *  candidate instead of refusing in place (module header, "The send-preflight exception"; the
 *  signature is valid on any endpoint — the live replay proved it). Each advance traces
 *  `money: sol send step rpc-failover <from> → <to> (why)` — hosts only — so the money log's
 *  step story stays unbroken on device. Exhaustion on a unanimous blockhash refusal throws the
 *  refusal verbatim. LIVE for the preflight-running paths (submitRawSolTx, broadcastSolPayment);
 *  DEFENSIVE PARITY for the skipPreflight payment seam — there walk-worthy refusals are the
 *  transport classes, and a blockhash-shaped answer (no layer should emit one) still just walks
 *  the same bytes; the seam itself re-signs nothing. */
export async function sendTransaction(url: string | readonly string[], rawBytes: Uint8Array, opts?: SolanaRpcOpts & {
  config?: {commitment?: 'confirmed' | 'processed' | 'finalized'; minContextSlot?: number; skipPreflight?: boolean; maxRetries?: number};
}): Promise<string> {
  const params: unknown[] = opts?.config
    ? [bytesToBase64(rawBytes), {encoding: 'base64', ...opts.config}]
    : [bytesToBase64(rawBytes), {encoding: 'base64'}];
  const result = (await rpcFetch(url, 'sendTransaction', params, {
    ...opts,
    walkBlockhashRefusal: true,
    onFailover: (from, to, why) => console.warn(`money: sol send step rpc-failover ${from} → ${to} (${why})`),
  })) as string;
  return result;
}

/** Poll `getSignatureStatuses` until the transaction is confirmed/finalized. Throws on a reported
 *  transaction error or a timeout (the tx may still land after a timeout — the caller surfaces that
 *  truthfully, never as a false success). */
export async function confirmTransaction(url: string | readonly string[], signature: string, opts?: SolanaRpcOpts): Promise<void> {
  const deadline = Date.now() + (opts?.timeoutMs ?? CONFIRM_TIMEOUT_MS);
  while (true) {
    if (opts?.signal?.aborted) throw new Error('aborted');
    // Each poll's `{signal, timeoutMs: 8000}` is REAL budget under a multi-home walk: rpcFetch's
    // armed attempt deadlines mean one hung home can stall a single poll, never the whole confirm
    // loop; the `deadline` above remains the loop's caller-facing bound.
    const result = (await rpcFetch(url, 'getSignatureStatuses', [[signature]], {
      signal: opts?.signal,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })) as {value: (SolanaSignatureStatus | null)[]};
    const status = result.value?.[0];
    if (status) {
      if (status.err != null) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return;
    }
    if (Date.now() >= deadline) throw new Error('solana confirmation timeout');
    await sleep(opts?.pollMs ?? CONFIRM_POLL_MS, opts?.signal);
  }
}

/** Whether an on-chain account exists at `address` — a non-null `getAccountInfo` result. True for
 *  any funded/owned account; false for a never-created account (the F4 ATA gate: a missing USDC
 *  Associated Token Account makes an offline USDC payment unfulfillable). Throws on a network/RPC
 *  error so the caller can surface "couldn't verify" honestly (a failed check is never silent). */
export async function accountExists(url: string | readonly string[], address: string, opts?: SolanaRpcOpts): Promise<boolean> {
  const result = (await rpcFetch(url, 'getAccountInfo', [address, {encoding: 'base64'}], opts)) as {
    value: unknown;
  };
  return result.value !== null && result.value !== undefined;
}

/** One account as `getMultipleAccounts` returns it. `data` is the RPC's `[base64, 'base64']` pair;
 *  `owner` is the PROGRAM that owns the account (the System program for a plain wallet, the SPL
 *  Token program for a mint or a token account) — the field that says what the bytes in `data`
 *  ARE, and the reason a decoder never has to guess. */
export interface SolanaAccountInfo {
  readonly lamports: number;
  readonly owner: string;
  readonly data: readonly [string, string];
}

/**
 * Read several accounts in ONE request. This is the whole balance poll: the wallet's own account
 * (whose `lamports` are exactly what `getBalance` answers — measured against mainnet 2026-09-08,
 * same account, same slot) plus, per rail, its token account and that token's mint account — one
 * round trip in place of five.
 *
 * A `null` entry means the account DOES NOT EXIST — measured against mainnet, not assumed — which
 * is what preserves the money-critical distinction the ATA gates rest on: a missing token account
 * is KNOWN absent, never merely unread.
 *
 * The response is POSITIONAL, so a length disagreement is a hard failure: attributing account #2's
 * balance to address #1 is the one bug class that must never degrade into a wrong number on a
 * screen. Every field the caller reads is validated here for the same reason.
 */
export async function getMultipleAccounts(
  url: string | readonly string[],
  addresses: string[],
  opts?: SolanaRpcOpts,
): Promise<(SolanaAccountInfo | null)[]> {
  const result = (await rpcFetch(url, 'getMultipleAccounts', [addresses, {encoding: 'base64'}], opts)) as {
    value?: unknown;
  };
  const value = result?.value;
  if (!Array.isArray(value) || value.length !== addresses.length) {
    throw new Error(
      `solana rpc: getMultipleAccounts answered ${Array.isArray(value) ? `${value.length} entries` : 'a non-array'} for ${addresses.length} addresses`,
    );
  }
  return value.map((v, i) => {
    if (v === null || v === undefined) return null;
    const a = v as {lamports?: unknown; owner?: unknown; data?: unknown};
    if (typeof a.lamports !== 'number' || !Number.isSafeInteger(a.lamports) || a.lamports < 0) {
      throw new Error(`solana rpc: getMultipleAccounts returned malformed lamports for ${addresses[i]}`);
    }
    if (typeof a.owner !== 'string' || a.owner.length === 0) {
      throw new Error(`solana rpc: getMultipleAccounts named no owning program for ${addresses[i]}`);
    }
    if (!Array.isArray(a.data) || typeof a.data[0] !== 'string' || a.data[1] !== 'base64') {
      throw new Error(`solana rpc: getMultipleAccounts returned non-base64 data for ${addresses[i]}`);
    }
    return {lamports: a.lamports, owner: a.owner, data: [a.data[0], 'base64'] as const};
  });
}

// RFC 4648 base64 of a byte array — imported from `lib/base64.ts` (the SINGLE implementation shared
// with the URL-safe codec in `lib/base64url.ts`). Standard alphabet, padded, throws-on-malformed.

// ============================================================================
// Phase 3 — v2 recent-blockhash freshness RPC methods. The merchant's broadcast state machine
// (solana.ts broadcastSolPayment) requires these to authoritatively prove a request is still
// broadcastable BEFORE sendTransaction, and to authoritatively classify a confirm timeout as
// expired vs honest-unknown. All run at SOL_PAYMENT_COMMITMENT='confirmed' and accept
// `minContextSlot` (the request's context slot) for reorg-aware behavior. See invariants #4/#12/#13
// in 2026-08-12-solana-recent-blockhash-rewrite-plan.md "Freshness rules".
// ============================================================================

// Module-level genesis-hash cache: one successful mainnet check per candidate list per app
// session (the key is the WHOLE list — same list ⇒ same question, regardless of which home
// happened to answer it). A mismatch throws (fail-closed); a cache MISS on a subsequent call
// re-fetches. Never cached on failure (a transient RPC error must not pin a wrong cluster
// identity for the session).
const genesisHashCache = new Map<string, string>();

/** The cache key for an endpoint argument: the URL itself for a single candidate, the
 *  serialized list otherwise. */
function rpcUrlKey(url: string | readonly string[]): string {
  return typeof url === 'string' ? url : JSON.stringify(url);
}

/** The cluster's immutable genesis hash (mainnet-beta's frozen value is in `SOL_GENESIS_HASH`).
 *  Cached per-list on success so the createSolPaymentRequest fast path doesn't pay a round trip per
 *  request. A mismatch with the configured `SOL_GENESIS_HASH` is a hard fail (wrong cluster). */
export async function getGenesisHash(url: string | readonly string[], opts?: SolanaRpcOpts): Promise<string> {
  const key = rpcUrlKey(url);
  const cached = genesisHashCache.get(key);
  if (cached !== undefined) return cached;
  const result = (await rpcFetch(url, 'getGenesisHash', [], opts)) as string;
  genesisHashCache.set(key, result);
  return result;
}

/** The current block height (the chain tip's slot number). Used to check whether a request's
 *  `lastValidBlockHeight` has been exceeded — the authoritative on-chain expiry signal. */
export async function getBlockHeight(url: string | readonly string[], opts?: SolanaRpcOpts): Promise<number> {
  const config: Record<string, unknown> = {commitment: SOL_PAYMENT_COMMITMENT};
  if (opts?.minContextSlot !== undefined) config.minContextSlot = opts.minContextSlot;
  const result = (await rpcFetch(url, 'getBlockHeight', [config], opts)) as number;
  return result;
}

/** Whether a given recent blockhash is still valid for transaction inclusion. Returns both the
 *  validity and the context slot of the observation (the freshness state machine requires
 *  `contextSlot >= request.slot` to treat an `invalid` result as authoritative). */
export async function isBlockhashValid(
  url: string | readonly string[],
  blockhash: string,
  opts?: SolanaRpcOpts,
): Promise<{valid: boolean; contextSlot: number}> {
  const config: Record<string, unknown> = {commitment: SOL_PAYMENT_COMMITMENT};
  if (opts?.minContextSlot !== undefined) config.minContextSlot = opts.minContextSlot;
  const result = (await rpcFetch(url, 'isBlockhashValid', [blockhash, config], opts)) as {
    context: {slot: number};
    value: boolean;
  };
  return {valid: result.value === true, contextSlot: result.context.slot};
}

/** History-aware signature status lookup for a single signature. Calls `getSignatureStatuses` with
 *  `{searchTransactionHistory:true}` so a TX that already landed (even if it dropped out of the
 *  node's recent-status cache) is still observable. Returns the parsed status (or null when the
 *  signature is unknown to the node) + the context slot of the observation.
 *
 *  Distinct from the existing `confirmTransaction` poll (which uses a non-history-aware
 *  `getSignatureStatuses` for the v1 rail). The v2 freshness state machine uses THIS helper so a
 *  confirm timeout can be authoritatively classified: a null status, combined with an expired
 *  blockhash, is definitive expiry; a present status is the on-chain verdict. */
export async function getSignatureStatusesForSig(
  url: string | readonly string[],
  signature: string,
  opts?: SolanaRpcOpts,
): Promise<{status: SolanaSignatureStatus | null; contextSlot: number}> {
  const result = (await rpcFetch(
    url,
    'getSignatureStatuses',
    [[signature], {searchTransactionHistory: true}],
    opts,
  )) as {
    context: {slot: number};
    value: (SolanaSignatureStatus | null)[];
  };
  const status = Array.isArray(result.value) ? result.value[0] ?? null : null;
  return {status, contextSlot: result.context.slot};
}

/** Quote the lamport fee for a (base64-encoded) message. Returns null when the RPC cannot compute
 *  the fee (the message references accounts not yet loadable, or is otherwise invalid). Used by
 *  the v2 path. */
export async function getFeeForMessage(
  url: string | readonly string[],
  messageBase64: string,
  opts?: SolanaRpcOpts,
): Promise<bigint | null> {
  const config: Record<string, unknown> = {commitment: SOL_PAYMENT_COMMITMENT};
  if (opts?.minContextSlot !== undefined) config.minContextSlot = opts.minContextSlot;
  const result = (await rpcFetch(url, 'getFeeForMessage', [messageBase64, config], opts)) as number | null;
  return result === null ? null : BigInt(result);
}

// ============================================================================
// Transaction history — the two reads `solana/history.ts` composes into the SOL rail's ledger.
// These stay THIN on purpose: they validate only what makes the response usable AT ALL (the
// signature list must be an ordered array of {signature, slot}), and hand the transaction detail
// back verbatim. The money-critical validation (balance arrays, token amounts, decimals) lives in
// history.ts, because there a single malformed transaction must become one logged, counted drop —
// not an exception that blanks the whole list.
// ============================================================================

/** One entry of `getSignaturesForAddress`. `slot` is the ordering key: always present and
 *  monotonic, unlike the `blockTime` the same response carries — which a node may not have, and
 *  which is read off the transaction DETAIL (one source) rather than duplicated from here. */
export interface SolanaSignatureInfo {
  readonly signature: string;
  readonly slot: number;
}

/** One pre/post SPL token balance snapshot from `meta`. `owner` is the token account's OWNER
 *  wallet (not the token account itself) — the field that says whose money this is. It is optional
 *  on the wire; history.ts refuses to guess when it is missing for a mint it is accounting. */
export interface SolanaTokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: {readonly amount: string; readonly decimals: number};
}

/** `meta` of a confirmed transaction. `preBalances`/`postBalances` are lamports indexed over the
 *  FULL account list (static message keys ++ loadedAddresses.writable ++ loadedAddresses.readonly).
 *  `err` is non-null exactly when the transaction failed on-chain (the fee is still charged). */
export interface SolanaTransactionMeta {
  readonly err: unknown;
  readonly fee: number;
  readonly preBalances: readonly number[];
  readonly postBalances: readonly number[];
  readonly preTokenBalances?: readonly SolanaTokenBalance[];
  readonly postTokenBalances?: readonly SolanaTokenBalance[];
  /** Present for versioned (v0) transactions that resolve accounts through address lookup tables. */
  readonly loadedAddresses?: {writable: readonly string[]; readonly: readonly string[]};
}

/** A confirmed transaction as returned by `getTransaction` with `encoding:'json'` (accountKeys are
 *  base58 STRINGS — `jsonParsed` would make them objects and is not requested).
 *
 * The message carries MORE than `accountKeys` on the wire (recentBlockhash, header, instructions,
 * version, addressTableLookups). Those fields are ALL-OPTIONAL here because the sole historical
 * consumer (`history.ts`) reads only `accountKeys`; the settle verifier (`settleVerify.ts`) reads
 * the full set and treats any absent field as unverifiable — never as a verdict. */
export interface SolanaTransactionDetail {
  readonly slot: number;
  readonly blockTime: number | null;
  readonly meta: SolanaTransactionMeta | null;
  readonly transaction: {
    readonly message: {
      readonly accountKeys: readonly string[];
      readonly recentBlockhash?: string;
      readonly header?: {
        readonly numRequiredSignatures: number;
        readonly numReadonlySignedAccounts: number;
        readonly numReadonlyUnsignedAccounts: number;
      };
      readonly instructions?: readonly {
        readonly programIdIndex: number;
        readonly accounts: readonly number[];
        readonly data: string;
      }[];
      /** 'legacy' for pre-v0 messages; 0 for versioned ones (a settle-verify MISMATCH claim). */
      readonly version?: 'legacy' | number;
      /** Present only on versioned messages that resolve accounts through lookup tables. */
      readonly addressTableLookups?: readonly unknown[];
    };
  };
}

/** The most recent `limit` transaction signatures that touched `address`, newest-first. Bounded by
 *  `limit` — no `before` cursor is exposed (the wallet shows a recent list, never an unbounded
 *  walk). Throws on a malformed entry: a list we cannot order is unusable, not a partial result. */
export async function getSignaturesForAddress(
  url: string | readonly string[],
  address: string,
  limit: number,
  opts?: SolanaRpcOpts,
): Promise<SolanaSignatureInfo[]> {
  const result = (await rpcFetch(
    url,
    'getSignaturesForAddress',
    [address, {limit, commitment: SOL_PAYMENT_COMMITMENT}],
    opts,
  )) as unknown;
  if (!Array.isArray(result)) {
    throw new Error(`solana rpc: getSignaturesForAddress returned a non-array for ${address}`);
  }
  return result.map((e: {signature?: unknown; slot?: unknown}) => {
    if (typeof e?.signature !== 'string' || !Number.isSafeInteger(e?.slot)) {
      throw new Error(`solana rpc: getSignaturesForAddress returned a malformed entry for ${address}`);
    }
    return {signature: e.signature, slot: e.slot as number};
  });
}

/** A confirmed transaction's detail, or `null` when the node does not have it (unknown signature,
 *  or pruned). `maxSupportedTransactionVersion:0` is REQUIRED — without it the RPC errors outright
 *  on every versioned (v0) transaction, which is most of mainnet. */
export async function getTransaction(
  url: string | readonly string[],
  signature: string,
  opts?: SolanaRpcOpts,
): Promise<SolanaTransactionDetail | null> {
  const result = (await rpcFetch(
    url,
    'getTransaction',
    [signature, {encoding: 'json', commitment: SOL_PAYMENT_COMMITMENT, maxSupportedTransactionVersion: 0}],
    opts,
  )) as unknown;
  if (result === null) return null;
  if (typeof result !== 'object') {
    throw new Error(`solana rpc: getTransaction returned a non-object for ${signature}`);
  }
  return result as SolanaTransactionDetail;
}
