// The SHARED transport-failure oracle (R3 generalized).
//
// "The phone has no connectivity" and "the service side is down while the phone is online" are
// different facts with different blame, and every relay-dependent read that produces no fact must
// tell them apart instead of printing "check your connection" to an online phone (work order
// 2026-09-30). The oracle answers the question the honest way: it probes ONE reference host that
// is deliberately OFF the failing path. Any HTTP answer from that host — 200, 404, 405 on HEAD,
// all of it — proves the phone is online, so the failing path is what is down ('unreachable');
// no answer there either means nothing is reachable from this phone ('offline'), and no one may
// be blamed, because the wallet cannot see that far.
//
// WHICH reference host per rail — the two rails reference EACH OTHER, so an outage on one path
// can never collapse into "offline":
//   - SOLANA-path failures (the default, the original R3 shape): probe the IC BOUNDARY
//     (`icGatewayUrl()` — icp-api.io, or the e2e fake-IC redirect). Post-R2 the Solana rail's
//     path IS the relay, so a relay outage would fail both the read AND a relay probe.
//   - IC-path failures (`classifyIcReadFailure`): probe the SOL rail's HEAD endpoint
//     (`solanaRpcUrl()` — the relay base + proxy path, or the operator's endpoint). Probing the
//     IC boundary for an IC-path failure would ask the broken path whether it is broken.
//
// The override `__DPAY_TEST_SOLANA_CONNECTIVITY: 'offline' | 'online'` is the SHARED test seam
// (the name predates the generalization; the e2e driver injects it per stage, so it stays).
// Pure module: imports config/constants and the message catalog only — no services layer, no
// native module — so every seam (solana.ts included) may import it statically.
import {icGatewayUrl, solanaRpcUrl} from './config/constants';
import {M} from './i18n';

export type TransportBlame = 'offline' | 'unreachable';

/** How long the offline/unreachable oracle waits for the reference host's answer. Short on
 *  purpose: it informs COPY, not money decisions, and a user waiting on a note should not wait
 *  on a probe. */
const CONNECTIVITY_PROBE_MS = 2500;
/** Dedupe window for the probe, PER probe URL. The balance poll fails once per `POLL.balance`
 *  tick (2.5s shipped), which is FASTER than this window on purpose: without the memo every
 *  failing tick would fire a fresh probe. 10s bounds the probe to ~1 per decade of ticks while
 *  a path is down and still re-probes soon enough that a recovered phone is re-classified
 *  within a few ticks. */
const CONNECTIVITY_PROBE_TTL_MS = 10000;
/** Memo cap: two live reference hosts (one per rail) is the production shape; anything past the
 *  cap is a bug's worth of distinct hosts, and dropping the memo only costs extra probes. */
const MEMO_CAP = 8;
const memo = new Map<string, {at: number; result: TransportBlame}>();

/**
 * The offline/unreachable oracle. `probeUrl` is the reference host OFF the failing path;
 * omitted means the IC boundary origin (the Solana rail's reference, resolved PER CALL exactly
 * like services/icp.ts resolves it, so the e2e fake-IC gateway redirect covers the oracle too).
 * Checked BEFORE any network probe: (1) the test override `__DPAY_TEST_SOLANA_CONNECTIVITY`;
 * (2) `navigator.onLine === false` (the web's free signal; absent on RN — harmless); (3) the
 * probe, deduped per probe URL for CONNECTIVITY_PROBE_TTL_MS.
 */
export async function classifyTransportFailure(probeUrl?: string): Promise<TransportBlame> {
  const override =
    (globalThis as unknown as {__DPAY_TEST_SOLANA_CONNECTIVITY?: 'offline' | 'online'}).__DPAY_TEST_SOLANA_CONNECTIVITY;
  if (override === 'offline') return 'offline';
  if (override === 'online') return 'unreachable';
  const nav = (globalThis as unknown as {navigator?: {onLine?: boolean}}).navigator;
  if (nav?.onLine === false) return 'offline';
  const url = probeUrl ?? icGatewayUrl();
  const hit = memo.get(url);
  if (hit != null && Date.now() - hit.at < CONNECTIVITY_PROBE_TTL_MS) return hit.result;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONNECTIVITY_PROBE_MS);
  let result: TransportBlame;
  try {
    // ANY HTTP answer — 200, 4xx, 405 on HEAD, all of it — proves transport off the failing
    // path works. The bare origin IS the reference; no health path is needed.
    await fetch(url, {method: 'HEAD', signal: ctrl.signal});
    result = 'unreachable';
  } catch {
    result = 'offline';
  } finally {
    clearTimeout(timer);
  }
  if (memo.size >= MEMO_CAP) memo.clear();
  memo.set(url, {at: Date.now(), result});
  return result;
}

/**
 * The IC rail's side of the oracle: an IC-path read produced no fact (transport death, an HTTP
 * answer that is not a reply, the certified-clock gate) and the caller must say WHY. The
 * reference host is the SOL rail's head endpoint — the mirror of the SOL oracle's IC-boundary
 * probe. An empty head (no relay configured, the rail off in tests) leaves no off-path home, so
 * the oracle falls back to the IC boundary itself: with no other host to ask, a contradicting
 * answer is impossible and the probe can only ever say 'offline', which is the safe verdict.
 */
export async function classifyIcReadFailure(): Promise<TransportBlame> {
  const solHead = solanaRpcUrl();
  return classifyTransportFailure(solHead !== '' ? solHead : undefined);
}

/** The payment engine's own failure signature: the bounded module load never arrived
 *  (`loadRpcForSend` / `loadEvmRpcForSend` — the served web build fetches the rail's network
 *  module as a chunk from the page origin), or the dynamic import itself failed fast. One
 *  classifier for BOTH rails; the raw strings stay console-only diagnostics. */
const ENGINE_LOAD_CLASS = /failed to load|engine chunk|failed to fetch dynamically imported module/i;

/**
 * Classify an engine-chunk failure and return the FINAL user copy per blame — the loaders throw
 * this directly, so every surface that renders `e.message` shows the honest sentence without a
 * per-surface re-mapping. The failing path here is the page origin (the relay serving the web
 * wallet), so the reference host is the DEFAULT: the IC boundary. Returns null for every other
 * failure class — the caller keeps its own verdict for those.
 */
export async function engineLoadCopy(raw: string): Promise<string | null> {
  if (!ENGINE_LOAD_CLASS.test(raw)) return null;
  return (await classifyTransportFailure()) === 'offline'
    ? M.errors.engine.offline
    : M.errors.engine.unreachable;
}
