// IC user-principal rail client — the app-side /api/v2 submission transport.
//
// The app signs FULL IC request envelopes locally (DpayCore.icpSign* → dpay-icp via UniFFI/wasm,
// byte-identical to ic-agent) and this module forwards the envelope bytes straight to the IC
// boundary node: POST {base}/api/v2/canister/<canister>/call|query|read_state with
// Content-Type application/cbor. The facade and relay leave the value-movement path entirely.
//
// Load-bearing semantics (2026-08-18-user-principal-rail.md — do not re-derive):
//  - RETRY = identical-byte resubmit ONLY. Re-signing produces a new request_id = double-pay.
//    Nothing here ever re-signs; callers resubmit the SAME envelope bytes.
//  - Ingress window ≈ 5.5 min from the envelope's own expiry stamp. "Not submitted in time"
//    is an honest pending/unknown, never a failure claim.
//  - Clock: GET /api/v2/status is unauthenticated but on icp-api.io does NOT carry ic:time
//    (measured: root_key + replica_health_status only). The certified clock source is the
//    `time` leaf of a signed read_state response — icNowNs() below, whose sync round-trip is
//    stamped with the DEVICE clock (requiring certified time to fetch certified time recurses
//    forever). Value-envelope signing goes through icStampExpiry(), which REFUSES to stamp on
//    unreachable clock or large skew.
//  - Queries + read_state are free; updates cost only the ledger's icrc1_fee (reverse gas).
//  - The read_state certificate is DECODED, not BLS-verified (W6 follow-up) — outcomes are
//    honestly labeled as such in the UI.
import {DpayCore} from './native';
import {fetchWithTimeout, readBodyWithin} from './relay';
import {hexToBytes, bytesToHex} from '../lib/format';
import type {IcpStateRead} from '../lib/types';
import {M} from '../i18n';
import {icGatewayUrl} from '../config/constants';

// The /api/v2 gateway base lives in ONE place now — `config/constants.ts` `icGatewayUrl()` — with
// the operator override (Settings ▸ Advanced, `IC_GATEWAY_STORAGE_KEY`) on top, then the
// `__DPAY_TEST_IC_GATEWAY` test/harness seam (read PER CALL there, so a test can flip the gateway
// at runtime — the only way the harness can simulate an IC-unreachable payer for the offline
// handoff flow), then the production default icp-api.io. See that module for the full precedence.

// Timeout budget: the boundary node answers a call POST with 202 quickly, but a cold or far
// replica can take a few seconds. 8s bounds every submit; read_state polls use 5s.
export const IC_SUBMIT_TIMEOUT_MS = 8000;
export const IC_QUERY_TIMEOUT_MS = 8000;
export const IC_READ_STATE_TIMEOUT_MS = 5000;

// Ingress expiry stamped AHEAD of the certified IC clock. The plan pins 240–300s; 300s sits
// inside the measured [now, now+5:30] acceptance window with margin for the merchant-submission
// (offline NFC handoff) case — the payer stamps, the merchant may submit minutes later.
export const INGRESS_AHEAD_S = 300;
// Poll envelopes get a short ahead window; their exact expiry never affects correctness (dedup
// is on request_id; a rejected POLL is simply retried).
const POLL_AHEAD_S = 60;
// Device-clock fallback ahead window for poll envelopes when the certified clock is unavailable.
// Deliberately DOUBLE POLL_AHEAD_S: the fallback path only runs after the certified fetch already
// failed (network down / clock skew), so the extra headroom absorbs the longer real-world latency
// before the retry that will follow; a poll rejected for staleness is retried, never lost.
const POLL_FALLBACK_AHEAD_S = 120;
// read_state routing target for the certified [[time]] leaf. The time leaf lives in EVERY
// subnet's certified tree, so any ROUTABLE canister works — but it must actually route:
// icp-api.io 400s read_state at the management canister ('aaaaa-aa' → canister_not_found,
// measured 2026-08-21 3/3) because the gateway only routes registered canister ids to
// subnets. The prod DUSD ledger (canister_ids.json icrc_ledger.ic) is an always-there
// canister the app talks to anyway (balance /query). The offline fake gateway skips
// canister-known validation for read_state (relay ic_gateway.rs), so the offline suites
// are agnostic to this id.
const IC_TIME_ROUTING_CANISTER = 'td2nx-oaaaa-aaaab-qhdnq-cai';
// The routing target follows the CATALOG's DEMO row when one is loaded (Wallet wires it,
// `setIcClockRoutingCanister`): on mainnet that row IS the same prod DUSD principal above
// (byte-identical routing), and on a demo relay (Settings ▸ Advanced IC-gateway override →
// local replica) the row is the replica's own icrc_ledger — a dfx replica 400s read_state
// with canister_not_found for ANY id it does not host (measured 2026-09-12: td2nx and even
// 'aaaaa-aa' both refuse; a hosted ledger answers 200 with a decodable time leaf). Unset
// (catalog not loaded yet) keeps the mainnet default.
let clockRoutingCanister: string | null = null;
/** Point the certified-clock read_state at the given canister (the catalog's DEMO ledger).
 * Null/empty resets to the mainnet default. No validation: the value comes from the app's
 * own catalog parse, not user input. */
export function setIcClockRoutingCanister(text: string | null): void {
  clockRoutingCanister = text != null && text.length > 0 ? text : null;
}
// REFUSE to sign value envelopes when the device clock and certified IC time disagree beyond
// this — a badly skewed stamp can land outside the ingress window and silently never execute.
export const MAX_CLOCK_SKEW_NS = 60n * 1_000_000_000n; // 60s in ns
// How long a fetched IC clock stays trusted (extrapolated with the device monotonic delta).
const CLOCK_FRESH_MS = 30_000;

export type IcSubmitOutcome =
  | {kind: 'accepted'} // 2xx — envelope is in the ingress queue; outcome comes from read_state
  | {kind: 'rejected'; status: number; bodyText: string} // definitive non-accept (bad sig, malformed, expired envelope)
  | {kind: 'unknown'}; // 5xx / network / timeout — identical-byte resubmit is safe

/** POST a signed envelope; classify the HTTP result. Never throws — transport failures map to
 * {kind:'unknown'} so callers can resubmit the SAME bytes. */
export async function icSubmit(
  canisterText: string,
  kind: 'call' | 'query' | 'read_state',
  envelopeHex: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IcSubmitOutcome> {
  const r = await postEnvelope(canisterText, kind, envelopeHex, timeoutMs, signal);
  if (r == null) return {kind: 'unknown'}; // postEnvelope already named the URL and the cause
  if (r.ok) return {kind: 'accepted'};
  if (r.status >= 400 && r.status < 500) {
    // A definitive rejection's WHOLE VALUE is its reason — the boundary node says "invalid
    // signature", "ingress expiry too far in the future", "canister not found". A body we could
    // not read is therefore named, never blanked: `''` here used to make a rejection unexplainable.
    const bodyText = await readBodyWithin(() => r.text(), `icSubmit ${kind} ${canisterText} HTTP ${r.status}`).catch((e: unknown) => {
      const detail = e instanceof Error ? e.message : String(e);
      console.warn(`icSubmit: ${kind} on ${canisterText} was rejected with HTTP ${r.status} and the body could not be read: ${detail}`);
      return `<body unreadable: ${detail}>`;
    });
    return {kind: 'rejected', status: r.status, bodyText};
  }
  // 5xx: retryable, and the caller cannot see the status because the outcome is deliberately the
  // same `unknown` a dropped connection produces. It still has to be findable.
  console.warn(`icSubmit: ${kind} on ${canisterText} answered HTTP ${r.status} — treating as unknown (an identical-byte resubmit is safe)`);
  return {kind: 'unknown'};
}

// --- single-POST round-trips ----------------------------------------------------------------------

/**
 * POST one envelope to the boundary node. `null` means "no HTTP answer at all" — DNS, TLS, an
 * abort, the timeout, a React Native network error. The caller turns that into offline / unknown,
 * which is correct, and which is exactly why the CAUSE has to be logged here: this function carries
 * every payment envelope the device signs, and a transfer that never left the phone used to produce
 * no line naming the gateway, the canister or the error. A caller's own abort is deliberately still
 * logged — one line per cancelled poll is the price of never losing a real failure.
 */
async function postEnvelope(
  canisterText: string,
  kind: 'call' | 'query' | 'read_state',
  envelopeHex: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response | null> {
  const url = `${icGatewayUrl()}/api/v2/canister/${canisterText}/${kind}`;
  try {
    return await fetchWithTimeout(
      url,
      {method: 'POST', headers: {'Content-Type': 'application/cbor'}, body: hexToBytes(envelopeHex).buffer, signal},
      timeoutMs,
    );
  } catch (e) {
    console.warn(
      `postEnvelope: POST ${url} produced no answer within ${timeoutMs} ms (or failed in transport):`,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

/** Signed query round-trip: POST the query envelope, decode the reply. Returns the reply arg
 * (hex) on success; null when unreachable/unparseable (caller treats as offline); THROWS with
 * the reject message when the CANISTER itself rejected the query (distinct failure class). */
export async function icQuery(
  secretHex: string,
  canisterText: string,
  methodName: string,
  argHex: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const expiry = await pollExpiry(secretHex, signal);
  if (expiry == null) return null;
  const envelopeHex = await DpayCore.icpSignQuery(secretHex, canisterText, methodName, argHex, expiry);
  const r = await postEnvelope(canisterText, 'query', envelopeHex, IC_QUERY_TIMEOUT_MS, signal);
  if (r == null) return null; // postEnvelope named the cause
  if (!r.ok) {
    // A boundary node answering 502/429 is NOT the same event as an unreachable network, and this
    // function reports both as `null` = offline. That collapse is deliberate (the caller retries
    // either way) but it must not be silent: a balance stuck at `—` because the gateway is rate-
    // limiting has to be findable in a log, not guessed at.
    console.warn(`icQuery: ${methodName} on ${canisterText} answered HTTP ${r.status} — reporting it as unreachable`);
    return null;
  }
  const rawHex = await bodyHex(r);
  if (rawHex == null) return null; // bodyHex named the cause
  const decoded = await DpayCore.icpDecodeQuery(rawHex);
  if (decoded.replied) return decoded.argHex ?? '';
  throw new Error(decoded.rejectMessage ?? `query rejected (${decoded.rejectCode ?? '?'})`);
}

/** One read_state round-trip over the given request_ids (+ certified time when wantTime).
 * Returns the decoded state, or null when unreachable. Request-status paths are sender-authorized:
 * the signing key must belong to the original update sender. Certified-time-only reads are separate.
 * The canister path segment is irrelevant for read_state (it targets the subnet); the PoC's
 * IcHttp always passed the ledger principal, so we do too. */
export async function icReadState(
  secretHex: string,
  canisterText: string,
  requestIdsHex: string[],
  wantTime: boolean,
  signal?: AbortSignal,
): Promise<IcpStateRead | null> {
  const expiry = await pollExpiry(secretHex, signal);
  if (expiry == null) return null;
  return readStateWithExpiry(secretHex, canisterText, requestIdsHex, wantTime, expiry, signal);
}

/** The sign+POST+decode core of a read_state round-trip, with the expiry stamped by the CALLER.
 * Split out so the certified-clock fetch (icNowNs) can sign with the DEVICE clock — requiring
 * certified time to fetch certified time is an infinite recursion (pollExpiry → icStampExpiry →
 * icNowNs → icReadState → pollExpiry → …): it never throws, so the device-clock fallback in
 * pollExpiry is never reached, and the pending await hangs the caller forever. */
async function readStateWithExpiry(
  secretHex: string,
  canisterText: string,
  requestIdsHex: string[],
  wantTime: boolean,
  expiry: string,
  signal?: AbortSignal,
): Promise<IcpStateRead | null> {
  const envelopeHex = await DpayCore.icpSignReadState(secretHex, requestIdsHex, wantTime, expiry);
  const r = await postEnvelope(canisterText, 'read_state', envelopeHex, IC_READ_STATE_TIMEOUT_MS, signal);
  if (r == null) return null; // postEnvelope named the cause
  if (!r.ok) {
    // This is the SETTLEMENT-OUTCOME read. `null` reads to the caller as "not known yet", which is
    // the honest answer either way — but a payment whose outcome is unknown because the gateway
    // answered 502 is a different thing to debug than one the subnet has not decided, and only a
    // log can tell them apart.
    console.warn(`icReadState: ${canisterText} answered HTTP ${r.status} for ${requestIdsHex.length} request id(s) — outcome stays unknown`);
    return null;
  }
  const rawHex = await bodyHex(r);
  if (rawHex == null) return null; // bodyHex named the cause
  try {
    return await DpayCore.icpDecodeReadState(rawHex, requestIdsHex);
  } catch (e) {
    // An undecodable certificate is NOT an unreachable node: the bytes arrived and the core refused
    // them. Reported as unknown (never as a decline — this phone cannot prove one), but named.
    console.warn(
      `icReadState: ${canisterText} returned a certificate this build cannot decode (${rawHex.length / 2} bytes):`,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

type RailStatusOut = IcpStateRead['statuses'][number];

/** Poll request_status for ONE request_id until a terminal state (replied/rejected/done) or
 * budget exhaustion. Non-terminal (unknown/received/processing) within the budget → 'unknown'
 * honestly (the update may still execute — never claim failure). */
export async function icPollRequestStatus(
  secretHex: string,
  canisterText: string,
  requestIdHex: string,
  opts: {attempts: number; intervalMs: number; signal?: AbortSignal},
): Promise<RailStatusOut | null> {
  for (let i = 0; i < opts.attempts; i++) {
    if (opts.signal?.aborted) return null;
    const state = await icReadState(secretHex, canisterText, [requestIdHex], i === 0, opts.signal);
    const st = state?.statuses?.[0];
    if (st && st.state !== 'unknown' && st.state !== 'received' && st.state !== 'processing') return st;
    if (i < opts.attempts - 1) await sleep(opts.intervalMs, opts.signal);
  }
  return null;
}

/** Poll request_status using one payer-signed read_state envelope supplied over NFC. Reposting the
 * identical read-only envelope is valid until its own ingress expiry and lets an online merchant
 * observe an offline payer's update without possessing the payer key. */
export async function icPollSignedRequestStatus(
  canisterText: string,
  requestIdHex: string,
  readStateEnvelopeHex: string,
  opts: {attempts: number; intervalMs: number; signal?: AbortSignal},
): Promise<RailStatusOut | null> {
  for (let i = 0; i < opts.attempts; i++) {
    if (opts.signal?.aborted) return null;
    const r = await postEnvelope(canisterText, 'read_state', readStateEnvelopeHex, IC_READ_STATE_TIMEOUT_MS, opts.signal);
    if (r?.ok) {
      const rawHex = await bodyHex(r);
      if (rawHex != null) {
        try {
          const state = await DpayCore.icpDecodeReadState(rawHex, [requestIdHex]);
          const st = state.statuses?.[0];
          if (st && st.state !== 'unknown' && st.state !== 'received' && st.state !== 'processing') return st;
        } catch (e) {
          // Stays unknown and is retried — but a certificate the core cannot decode is a real
          // failure, and this is the MERCHANT's poll of an offline payer's transfer. A tap that
          // ends in "couldn't confirm" because every certificate was rejected must leave a trail.
          console.warn(
            `icPollSignedRequestStatus: attempt ${i + 1}/${opts.attempts} for ${requestIdHex.slice(0, 16)}… returned a certificate this build cannot decode:`,
            e instanceof Error ? e.message : String(e),
          );
        }
      }
    }
    if (i < opts.attempts - 1) await sleep(opts.intervalMs, opts.signal);
  }
  return null;
}

// --- certified clock ------------------------------------------------------------------------------

let cachedIcNowNs: bigint | null = null;
let cachedAtMs = 0;
// One in-flight clock sync shared by every concurrent stamper (balance poll, history, deposit,
// pay …). Certified time is subnet state, not caller-specific — joining the first key's fetch
// is correct and stops a poll fan-out from becoming a read_state flood.
let clockInFlight: Promise<bigint | null> | null = null;
// The clock-sync round-trip stamps its envelope with the DEVICE clock at mid-window ahead
// (measured ingress window [now, now+5:30]: 240s tolerates a device clock behind by up to
// ~4 min / ahead by ~90s). Outside that the sync honestly fails → null → value signing refuses.
const CLOCK_SYNC_AHEAD_S = 240;

/** Certified IC time (ns): read_state over the [[time]] path with the user's key, decoded from
 * the certificate (read_state is free; the boundary node requires the signature). Cached and
 * extrapolated for CLOCK_FRESH_MS. Returns null when unreachable — see icStampExpiry for the
 * signer-side gate. */
export async function icNowNs(secretHex: string, signal?: AbortSignal): Promise<bigint | null> {
  const nowMs = Date.now();
  if (cachedIcNowNs !== null && nowMs - cachedAtMs < CLOCK_FRESH_MS) {
    return cachedIcNowNs + BigInt(nowMs - cachedAtMs) * 1_000_000n;
  }
  clockInFlight ??= (async () => {
    try {
      const expiry = await DpayCore.icpIngressExpiry((BigInt(Date.now()) * 1_000_000n).toString(), CLOCK_SYNC_AHEAD_S);
      const state = await readStateWithExpiry(secretHex, clockRoutingCanister ?? IC_TIME_ROUTING_CANISTER, [], true, expiry, signal);
      if (state?.timeNs != null) {
        cachedIcNowNs = BigInt(state.timeNs);
        cachedAtMs = Date.now();
        return cachedIcNowNs;
      }
      return null;
    } finally {
      clockInFlight = null;
    }
  })();
  return clockInFlight;
}

/** The certified clock could not be read at all (gateway dead / read_state refused) — as opposed
 *  to a skewed clock, where the reading EXISTS and disagrees with the device. Typed so callers can
 *  branch on the failure mode without string-matching a localized message; the ONE branch today is
 *  `prepareTransfer`'s offline hand-off (`offlineHandoff`), which falls back to a device-clock
 *  stamp here exactly because no reading exists to distrust. A skew refusal stays a refusal. */
export class IcClockUnreachable extends Error {
  constructor() {
    super(M.errors.ic.clockUnreachable);
  }
}

/** The clock-gated expiry stamp for signing VALUE envelopes. Throws when the certified time is
 *  unreachable or the device clock disagrees beyond MAX_CLOCK_SKEW_NS — callers surface honest
 *  pending (never sign on a bad clock: the plan's founder rule). */
export async function icStampExpiry(
  secretHex: string,
  aheadS = INGRESS_AHEAD_S,
  signal?: AbortSignal,
): Promise<string> {
  const icNs = await icNowNs(secretHex, signal);
  if (icNs == null) throw new IcClockUnreachable();
  const deviceNs = BigInt(Date.now()) * 1_000_000n;
  const skew = icNs > deviceNs ? icNs - deviceNs : deviceNs - icNs;
  if (skew > MAX_CLOCK_SKEW_NS) throw new Error(M.errors.ic.clockSkew);
  return DpayCore.icpIngressExpiry(icNs.toString(), aheadS);
}

/** Poll-envelope expiry: certified clock when cheap (cached), device-clock fallback otherwise —
 * a poll's exact stamp never affects correctness, only whether the boundary node accepts the
 * poll, which is retried. VALUE envelopes must go through icStampExpiry instead. */
async function pollExpiry(secretHex: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return await icStampExpiry(secretHex, POLL_AHEAD_S, signal);
  } catch (e) {
    // The certified clock was unreachable, or it disagreed with this device beyond
    // MAX_CLOCK_SKEW_NS. For a POLL that is survivable — the stamp only decides whether the
    // boundary node accepts the poll, and a rejected poll is retried — but a device whose clock is
    // badly wrong will also REFUSE to sign anything of value (icStampExpiry throws there), so this
    // is the first place that fact becomes observable.
    console.warn(
      'pollExpiry: no certified IC time for this poll, stamping with the device clock instead:',
      e instanceof Error ? e.message : String(e),
    );
    try {
      return await DpayCore.icpIngressExpiry((BigInt(Date.now()) * 1_000_000n).toString(), POLL_FALLBACK_AHEAD_S);
    } catch (inner) {
      console.warn(
        'pollExpiry: the core could not stamp an ingress expiry from the device clock either — this poll cannot be signed:',
        inner instanceof Error ? inner.message : String(inner),
      );
      return null;
    }
  }
}

// --- small local helpers --------------------------------------------------------------------------

async function bodyHex(r: Response): Promise<string | null> {
  try {
    const buf = await readBodyWithin(() => r.arrayBuffer(), `bodyHex ${r.url || 'the IC gateway'} HTTP ${r.status}`);
    return bytesToHex(new Uint8Array(buf));
  } catch (e) {
    // A 200 whose body could not be read is not "offline": the node answered and the read failed
    // (a truncated stream, a RN bridge error). The caller reports unknown; this names why.
    console.warn(
      `bodyHex: HTTP ${r.status} from ${r.url || 'the IC gateway'} answered, but its body could not be read:`,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(finish, ms);
    function finish() {
      signal?.removeEventListener('abort', finish);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', finish);
  });
}
