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
import {fetchWithTimeout} from './relay';
import {hexToBytes, bytesToHex} from '../lib/format';
import type {IcpStateRead} from '../lib/types';

export const IC_GATEWAY_DEFAULT = 'https://icp-api.io';
// Test/harness override seam (same pattern as SOLANA_RPC_URL): the e2e fake-IC gateway and the
// dfx replica suite inject its base URL before the bundle evaluates; prod never sets it. Read
// PER CALL (not at module load) so a test can flip the gateway at runtime — the only way the
// harness can simulate an IC-unreachable (airplane-mode) payer for the offline handoff flow.
const icGatewayBase = (): string =>
  (globalThis as unknown as {__DPAY_TEST_IC_GATEWAY?: string}).__DPAY_TEST_IC_GATEWAY ?? IC_GATEWAY_DEFAULT;

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
// The IC management canister — read_state target for the certified [[time]] leaf. Its exact id is
// irrelevant for the subnet query itself; it must merely be a valid principal.
const IC_MANAGEMENT_CANISTER = 'aaaaa-aa';
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
  if (r == null) return {kind: 'unknown'};
  if (r.ok) return {kind: 'accepted'};
  if (r.status >= 400 && r.status < 500) {
    const bodyText = await r.text().catch(() => '');
    return {kind: 'rejected', status: r.status, bodyText};
  }
  return {kind: 'unknown'};
}

// --- single-POST round-trips ----------------------------------------------------------------------

async function postEnvelope(
  canisterText: string,
  kind: 'call' | 'query' | 'read_state',
  envelopeHex: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response | null> {
  try {
    return await fetchWithTimeout(
      `${icGatewayBase()}/api/v2/canister/${canisterText}/${kind}`,
      {method: 'POST', headers: {'Content-Type': 'application/cbor'}, body: hexToBytes(envelopeHex).buffer, signal},
      timeoutMs,
    );
  } catch {
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
  if (r == null || !r.ok) return null;
  const rawHex = await bodyHex(r);
  if (rawHex == null) return null;
  const decoded = await DpayCore.icpDecodeQuery(rawHex);
  if (decoded.replied) return decoded.argHex ?? '';
  throw new Error(decoded.rejectMessage ?? `query rejected (${decoded.rejectCode ?? '?'})`);
}

/** One read_state round-trip over the given request_ids (+ certified time when wantTime).
 * Returns the decoded state, or null when unreachable. Uses the caller's own key — read_state
 * must be signed by SOME principal; any key sees request_status records (they are not secret).
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
  if (r == null || !r.ok) return null;
  const rawHex = await bodyHex(r);
  if (rawHex == null) return null;
  try {
    return await DpayCore.icpDecodeReadState(rawHex, requestIdsHex);
  } catch {
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
      const state = await readStateWithExpiry(secretHex, IC_MANAGEMENT_CANISTER, [], true, expiry, signal);
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

/** The clock-gated expiry stamp for signing VALUE envelopes. Throws when the certified time is
 * unreachable or the device clock disagrees beyond MAX_CLOCK_SKEW_NS — callers surface honest
 * pending (never sign on a bad clock: the plan's founder rule). */
export async function icStampExpiry(
  secretHex: string,
  aheadS = INGRESS_AHEAD_S,
  signal?: AbortSignal,
): Promise<string> {
  const icNs = await icNowNs(secretHex, signal);
  if (icNs == null) throw new Error('IC clock unreachable');
  const deviceNs = BigInt(Date.now()) * 1_000_000n;
  const skew = icNs > deviceNs ? icNs - deviceNs : deviceNs - icNs;
  if (skew > MAX_CLOCK_SKEW_NS) throw new Error('IC clock skew too large');
  return DpayCore.icpIngressExpiry(icNs.toString(), aheadS);
}

/** Poll-envelope expiry: certified clock when cheap (cached), device-clock fallback otherwise —
 * a poll's exact stamp never affects correctness, only whether the boundary node accepts the
 * poll, which is retried. VALUE envelopes must go through icStampExpiry instead. */
async function pollExpiry(secretHex: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return await icStampExpiry(secretHex, POLL_AHEAD_S, signal);
  } catch {
    try {
      return await DpayCore.icpIngressExpiry((BigInt(Date.now()) * 1_000_000n).toString(), POLL_FALLBACK_AHEAD_S);
    } catch {
      return null;
    }
  }
}

// --- small local helpers --------------------------------------------------------------------------

async function bodyHex(r: Response): Promise<string | null> {
  try {
    const buf = await r.arrayBuffer();
    return bytesToHex(new Uint8Array(buf));
  } catch {
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
