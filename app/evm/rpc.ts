// Minimal EVM JSON-RPC 2.0 client over `fetch` with bounded timeouts. NETWORK module —
// dynamically imported from the seam `app/evm.ts` (via `evm/service.ts`) so real RPC never runs
// under jest/e2e (the seam no-ops when `evmRpcUrl(chainId)` is empty, which jest.setup.js and
// the e2e driver set). The `solana/rpc.ts` header is the spec; this module mirrors its walk
// line for line, minus the SOL-specific preflight exception.
//
// # The candidate walk
//
// Every exported call takes the endpoint as a LIST (`string | readonly string[]` — the callers
// pass `evmRpcUrls(chainId)`), walked ONCE in order, no mid-call retries. Per candidate:
//   transport failure (fetch threw, or the call's own timeout fired — NOT a caller abort)
//     → try the next home;
//   HTTP ≥500, or a body carrying the relay's `dpayRelayError` marker → try the next home;
//   an OPEN 429-cooldown on that URL → SKIP it, still try the next home;
//   HTTP 4xx (incl. 404) or a 429 → an ANSWER: brand EvmEndpointRefused/EvmRateLimited and
//     STOP — 4xx never fails over (it says something about THIS request, not the home);
//   2xx → the answer; cooldown cleared; RETURN — a 2xx is never walked past.
//
// A 2xx body carrying the relay marker is a broken/hostile relay (markers ride 503/504 by
// contract, crates/dpay-relay/src/evm.rs) — treated as the relay-marker failure, never decoded
// as a JSON-RPC envelope.
//
// EXHAUSTION precedence (what the walk throws when no candidate answered):
//   1. any candidate answered with the marker → EvmRelayPathDown (transport-class: the relay
//      answered HTTP, so the phone is online — its EVM leg is what is dead);
//   2. else any candidate answered with a relayed upstream HTTP status (5xx verbatim) →
//      EvmEndpointRefused with THAT status;
//   3. else every candidate was cooldown-gated and none was asked → EvmRateLimited;
//   4. else all-transport-dead → rethrow the LAST transport error verbatim, so the caller's
//      offline/unreachable oracle can classify it.
//
// # Send safety (eth_sendRawTransaction)
//
// Broadcasts ride the same walk and that is safe: EVM nodes dedup by tx HASH — resubmitting the
// IDENTICAL signed bytes to the next home is idempotent (worst case a second "already known"
// answer). The one forbidden move — walking after a 2xx — cannot happen: a 2xx returns
// immediately, so an accepted broadcast is sent exactly once as far as this client can tell.
// `eth_sendRawTransaction` is NEVER cached relay-side (the relay passes it through uncached by
// contract), and this client never re-signs: the same bytes walk, nothing else.
//
// Timeouts use the shared `lib/timeout.ts` compose. Whenever the walk has a SECOND candidate,
// EVERY attempt runs under its own always-armed deadline (attempt 0 = the FULL `timeoutMs`,
// attempt i = `timeoutMs >> i` floored at 1 s — the walk is bounded at ≈2×timeoutMs); a
// single-candidate list keeps the caller-owns-the-deadline contract. An attempt's own expiry
// counts as transport-dead; only a CALLER abort throws out of the walk immediately.

import {composeArmedTimeout, composeTimeout} from '../lib/timeout';
import {EvmEndpointRefused, EvmRateLimited, EvmRelayPathDown, isEvmEndpointRefusal} from './errors';

export interface EvmRpcOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
/** Per-attempt deadline floor for the multi-candidate walk (module header). */
const ATTEMPT_TIMEOUT_FLOOR_MS = 1000;
/** Marker-parse body cap: a real `dpayRelayError` body is ~100 bytes of JSON, so nothing longer
 *  is ever parsed as a candidate marker. */
const MARKER_BODY_CAP = 65536;

/** First cooldown after a 429 that carried no `Retry-After` — longer than the 2.5s balance
 *  poll, so the very next tick is skipped rather than re-sending the refused volley. */
export const RATE_LIMIT_BASE_MS = 5000;
/** Cooldown ceiling: an unbounded backoff turns a temporary limit into a wallet that never
 *  reads a balance again. */
export const RATE_LIMIT_MAX_MS = 60000;

/** Per-endpoint cooldown, keyed by URL so one throttled endpoint never silences another.
 *  Cleared by any success — the limit is over when the endpoint says it is, by answering. */
const cooldowns = new Map<string, {until: number; waitMs: number}>();

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get('Retry-After');
  if (raw === null) return null;
  const secs = Number(raw.trim());
  return Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : null;
}

function openCooldown(url: string, fromHeader: number | null): number {
  const prev = cooldowns.get(url);
  const waitMs = fromHeader ?? Math.min(prev ? prev.waitMs * 2 : RATE_LIMIT_BASE_MS, RATE_LIMIT_MAX_MS);
  cooldowns.set(url, {until: Date.now() + waitMs, waitMs});
  return waitMs;
}

let nextId = 1;

/** The endpoint argument as the ordered, de-duplicated candidate list. An empty string
 *  candidate is dropped — the seam no-ops on the rail being off long before this module runs. */
function candidatesOf(url: string | readonly string[]): string[] {
  const input = typeof url === 'string' ? [url] : url;
  const out: string[] = [];
  for (const u of input) {
    if (typeof u !== 'string' || u === '' || out.includes(u)) continue;
    out.push(u);
  }
  return out;
}

/** Parse a relay-originated error body — `{"dpayRelayError": <code>, "detail"?: <phrase>}`;
 *  null for anything else (provider bodies, prose, HTML). */
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

/** The marker check with an honest body cap (a declared-huge body is never parsed at all). */
function markerCapped(headers: Headers, body: string): {dpayRelayError: string; detail?: string} | null {
  const declared = headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MARKER_BODY_CAP) return null;
  }
  return relayErrorMarker(body.slice(0, MARKER_BODY_CAP));
}

/** The endpoint's HOST, never its URL: a provider URL can carry an api key as a query
 *  parameter, and a log line is exactly where a key must not appear. */
export function hostOf(url: string): string {
  const scheme = url.indexOf('://');
  const rest = scheme < 0 ? url : url.slice(scheme + 3);
  const end = rest.search(/[/?#]/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** One walk, one call. The policy lives in the module header; this is its mechanical truth:
 *  one pass, in order, no candidate tried twice, no candidate retried. Reads and broadcasts
 *  share it (see "Send safety" for why that is safe). */
async function rpcFetch(url: string | readonly string[], method: string, params: unknown[], opts?: EvmRpcOpts): Promise<unknown> {
  const candidates = candidatesOf(url);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let relayMarker: {url: string; code: string; detail?: string} | null = null;
  let upstreamStatus: {url: string; status: number; body: string} | null = null;
  let cooldownGate: {url: string; remainingMs: number} | null = null;
  let lastTransport: unknown = null;
  let asked = 0; // candidates that actually got a request out (not cooldown-skipped)
  // ONE id per LOGICAL request: every failover attempt of this call reuses it, so the resubmit
  // carries byte-identical bytes (EVM nodes dedup by tx hash; the relay's canonical-body cache
  // key matches across attempts too).
  const requestId = nextId++;
  for (let ci = 0; ci < candidates.length; ci++) {
    const candidate = candidates[ci];
    const cooling = cooldowns.get(candidate);
    if (cooling !== undefined) {
      const remaining = cooling.until - Date.now();
      if (remaining > 0) {
        if (cooldownGate === null) cooldownGate = {url: candidate, remainingMs: remaining};
        continue;
      }
    }
    asked++;
    const attemptMs = Math.max(timeoutMs >> (asked - 1), ATTEMPT_TIMEOUT_FLOOR_MS);
    const armed = candidates.length > 1;
    const {signal, cancel} = armed
      ? composeArmedTimeout(opts?.signal, attemptMs)
      : composeTimeout(opts?.signal, attemptMs);
    let r: Response;
    try {
      r = await fetch(candidate, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: requestId, method, params}),
        signal,
      });
    } catch (e) {
      // A CALLER abort is the caller ending the call — never a walk signal; a timeout is this
      // home being too slow — exactly what the next home exists for.
      cancel();
      if (opts?.signal?.aborted) throw e;
      lastTransport = e;
      continue;
    }
    try {
      if (r.status === 429) throw new EvmRateLimited(candidate, openCooldown(candidate, retryAfterMs(r.headers)));
      if (!r.ok) {
        const body = await r.text().catch((e: unknown) => `<body unreadable: ${e instanceof Error ? e.message : String(e)}>`);
        const marker = markerCapped(r.headers, body);
        if (marker !== null) {
          // dpay's OWN failure body: this home's EVM leg is down. The next home may be healthy;
          // exhaustion remembers the marker with top precedence.
          if (relayMarker === null) relayMarker = {url: candidate, code: marker.dpayRelayError, detail: marker.detail};
          continue;
        }
        if (r.status >= 500) {
          // A ≥500 without the marker is the PROVIDER's status relayed verbatim — walk on, and
          // exhaustion reports it as the provider-side refusal it is.
          if (upstreamStatus === null) upstreamStatus = {url: candidate, status: r.status, body: body.slice(0, 200)};
          continue;
        }
        throw new EvmEndpointRefused(`evm rpc ${method} → ${hostOf(candidate)}: HTTP ${r.status}: ${body.slice(0, 200)}`, r.status);
      }
      const j: {dpayRelayError?: unknown; detail?: unknown; error?: {message?: string; data?: unknown}; result?: unknown} = await r.json();
      // The endpoint answered: whatever it said, it is talking to us again, so the gate is done.
      cooldowns.delete(candidate);
      if (typeof j?.dpayRelayError === 'string' && j.dpayRelayError.length > 0) {
        if (relayMarker === null) {
          relayMarker = {url: candidate, code: j.dpayRelayError, detail: typeof j.detail === 'string' ? j.detail : undefined};
        }
        continue;
      }
      if (j.error) {
        // A JSON-RPC-level error is a verdict on THIS request (an estimate refusal, a rejected
        // raw tx, an unknown method, a contract REVERT) — refused in place, never walked. The
        // node's `error.data` (a 0x-hex revert payload when present) rides along on the thrown
        // error: the settle preflights classify a revert FROM it (evm/claims.ts reads err.data).
        const rawMsg = typeof j.error.message === 'string' ? j.error.message : String(j.error.message ?? 'error');
        throw new EvmEndpointRefused(`evm rpc: ${rawMsg}`, null, j.error.data);
      }
      return j.result;
    } finally {
      cancel();
    }
  }
  // EXHAUSTED — precedence per the module header.
  if (relayMarker !== null) {
    throw new EvmRelayPathDown(
      `evm rpc ${method}: dpay's relay ${hostOf(relayMarker.url)} could not reach the chain ` +
        `(${relayMarker.code}${relayMarker.detail ? `: ${relayMarker.detail.slice(0, 140)}` : ''})`,
      relayMarker.code,
    );
  }
  if (upstreamStatus !== null) {
    throw new EvmEndpointRefused(
      `evm rpc ${method} → ${hostOf(upstreamStatus.url)}: HTTP ${upstreamStatus.status}: ${upstreamStatus.body}`,
      upstreamStatus.status,
    );
  }
  if (asked === 0 && cooldownGate !== null) {
    throw new EvmRateLimited(cooldownGate.url, cooldownGate.remainingMs);
  }
  if (lastTransport !== null) throw lastTransport;
  throw new Error(`evm rpc ${method}: no usable candidate endpoint (${candidates.length} configured)`);
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

function asHex(result: unknown, what: string): string {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) {
    throw new EvmEndpointRefused(`evm rpc: ${what} returned ${typeof result} where a 0x-hex string was expected`, null);
  }
  return result;
}

/** `eth_chainId` — the endpoint's own chain identity, as a 0x-hex string ("0x1"). The
 *  wrong-chain guard (service layer, D10/D12) compares this against the requested chain before
 *  anything is spent. The relay caches this read for an hour (chain identity does not move). */
export async function ethChainId(url: string | readonly string[], opts?: EvmRpcOpts): Promise<string> {
  return asHex(await rpcFetch(url, 'eth_chainId', [], opts), 'eth_chainId');
}

/** `eth_getBalance` — the NATIVE coin balance (gas money), as a 0x-hex wei string. */
export async function ethGetBalance(url: string | readonly string[], address: string, opts?: EvmRpcOpts): Promise<string> {
  return asHex(await rpcFetch(url, 'eth_getBalance', [address, 'latest'], opts), 'eth_getBalance');
}

/** `eth_call` with `{to, data}` at 'latest' — the balanceOf / nonces / DOMAIN_SEPARATOR read
 *  path. Returns the raw string the node answered (the CALLER decodes — evm/abi.ts — so bytes
 *  that cannot be decoded classify as 'unreadable', never as a refusal).
 *
 *  `from` sets the call's `msg.sender` when given (the settle preflights need it: the token's
 *  `transferFrom` checks `allowance[owner][msg.sender]`, so the preflight must call AS the
 *  merchant, while `permit` is ecrecover-based and msg.sender-blind). */
export async function ethCall(url: string | readonly string[], to: string, data: string, opts?: EvmRpcOpts, from?: string): Promise<string> {
  const result = await rpcFetch(url, 'eth_call', [{...(from !== undefined ? {from} : {}), to, data}, 'latest'], opts);
  if (typeof result !== 'string') {
    throw new EvmEndpointRefused(`evm rpc: eth_call returned ${typeof result} where a hex string was expected`, null);
  }
  return result;
}

/** `eth_gasPrice` — the chain's own gas-price arithmetic, 0x-hex wei. */
export async function ethGasPrice(url: string | readonly string[], opts?: EvmRpcOpts): Promise<string> {
  return asHex(await rpcFetch(url, 'eth_gasPrice', [], opts), 'eth_gasPrice');
}

/** `eth_maxPriorityFeePerGas` — the node's priority-fee suggestion, 0x-hex wei. Null when the
 *  node answers at the JSON-RPC level that it will not (an unknown method on an older node) —
 *  never invented here. Transport/cooldown/HTTP refusals still throw. */
export async function ethMaxPriorityFeePerGas(url: string | readonly string[], opts?: EvmRpcOpts): Promise<string | null> {
  try {
    return asHex(await rpcFetch(url, 'eth_maxPriorityFeePerGas', [], opts), 'eth_maxPriorityFeePerGas');
  } catch (e) {
    if (isEvmEndpointRefusal(e)) {
      const status = (e as {status?: unknown}).status;
      if (status === null || status === undefined) return null;
    }
    throw e;
  }
}

/** `eth_estimateGas` — the chain's own gas arithmetic over the caller's typed inputs
 *  (pending-state dependent; the relay never caches it). 0x-hex units of gas. */
export async function ethEstimateGas(
  url: string | readonly string[],
  tx: {from?: string; to: string; data?: string},
  opts?: EvmRpcOpts,
): Promise<string> {
  return asHex(await rpcFetch(url, 'eth_estimateGas', [tx], opts), 'eth_estimateGas');
}

/** `eth_getTransactionCount` — the account's next nonce ('pending' includes the mempool). */
export async function ethGetTransactionCount(url: string | readonly string[], address: string, opts?: EvmRpcOpts): Promise<string> {
  return asHex(await rpcFetch(url, 'eth_getTransactionCount', [address, 'pending'], opts), 'eth_getTransactionCount');
}

/** `eth_blockNumber` — the current tip, 0x-hex. */
export async function ethBlockNumber(url: string | readonly string[], opts?: EvmRpcOpts): Promise<string> {
  return asHex(await rpcFetch(url, 'eth_blockNumber', [], opts), 'eth_blockNumber');
}

/** One raw log entry as `eth_getLogs` returns it (fields optional — the decoder decides). */
export interface EvmLog {
  readonly address?: string;
  readonly topics?: readonly string[];
  readonly data?: string;
  readonly blockNumber?: string;
  readonly transactionHash?: string;
  readonly logIndex?: string;
}

export interface EvmLogFilter {
  readonly fromBlock: string;
  readonly toBlock: string;
  readonly address: string;
  /** Topic filters, position-wise: a string = exact match, null = any, an array = OR over its
   *  entries (the JSON-RPC union form; null inside an array means "any" too). */
  readonly topics: readonly (string | null | readonly (string | null)[])[];
}

/** `eth_getLogs` over a block range — the Transfer-topic history read path. */
export async function ethGetLogs(url: string | readonly string[], filter: EvmLogFilter, opts?: EvmRpcOpts): Promise<EvmLog[]> {
  const result = await rpcFetch(url, 'eth_getLogs', [filter], opts);
  if (!Array.isArray(result)) {
    throw new EvmEndpointRefused('evm rpc: eth_getLogs returned a non-array', null);
  }
  return result as EvmLog[];
}

export interface EvmReceipt {
  readonly status?: string;          // '0x1' success | '0x0' failure (post-Byzantium)
  readonly blockNumber?: string;
  readonly transactionHash?: string;
}

/** `eth_getTransactionReceipt` — null when the node has never heard of the hash (not yet
 *  mined, or dropped). */
export async function ethGetTransactionReceipt(url: string | readonly string[], txHash: string, opts?: EvmRpcOpts): Promise<EvmReceipt | null> {
  const result = await rpcFetch(url, 'eth_getTransactionReceipt', [txHash], opts);
  if (result === null || result === undefined) return null;
  if (typeof result !== 'object') {
    throw new EvmEndpointRefused('evm rpc: eth_getTransactionReceipt returned a non-object', null);
  }
  return result as EvmReceipt;
}

/** A block header as `eth_getBlockByNumber(…, false)` returns it — only the fields the
 *  history reader needs. */
export interface EvmBlockHeader {
  readonly timestamp?: string;
}

/** `eth_getBlockByNumber(number, false)` — the block timestamp for a history row. Null when
 *  pruned/unknown. */
export async function ethGetBlockByNumber(url: string | readonly string[], blockNumberHex: string, opts?: EvmRpcOpts): Promise<EvmBlockHeader | null> {
  const result = await rpcFetch(url, 'eth_getBlockByNumber', [blockNumberHex, false], opts);
  if (result === null || result === undefined) return null;
  if (typeof result !== 'object') return null;
  return result as EvmBlockHeader;
}

/** `eth_sendRawTransaction` — broadcast ALREADY-SIGNED tx bytes. NEVER cached (the relay passes
 *  it through by contract; nothing here caches either), never re-signed: the same signed bytes
 *  walk to the next home on a transport death or a relay marker, and EVM nodes dedup by hash.
 *  Returns the node's tx hash (0x-hex). */
export async function ethSendRawTransaction(url: string | readonly string[], rawHex: string, opts?: EvmRpcOpts): Promise<string> {
  const result = await rpcFetch(url, 'eth_sendRawTransaction', [rawHex], opts);
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
    throw new EvmEndpointRefused(`evm rpc: eth_sendRawTransaction answered ${String(result).slice(0, 80)} where a tx hash was expected`, null);
  }
  return result;
}

export {sleep as rpcSleep};
