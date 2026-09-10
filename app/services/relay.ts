import {base} from '../lib/format';
import {composeArmedTimeout, composeTimeout} from '../lib/timeout';
import {DEPOSIT_TIMEOUT_MS} from '../config/constants';
import {relayAddresses, relayAddressesRevision} from './relayAddresses';
// --- ck-deposit (ckBTC-style top-up) response shapes -----------------------------------------
// MC1 units 2-4: protocol u64 amounts cross the JSON boundary as decimal-digit STRINGS.
export type DepositInfo = {min_confirmations: number; deposit_fee: string; deposit_min_amount: string | null};

// Safety-net default for every relay fetch — bounds a caller that omits its own signal so a hung
// relay can't produce an infinite spinner. `fetchWithTimeout` (used DIRECTLY only by the till
// client) forwards a caller signal AS-IS and arms the backstop only when it is absent — the
// caller owns the deadline outright. The multi-address walk (`relayFetch`) instead arms an
// internal per-ATTEMPT deadline on EVERY attempt (attempt 0 included, at the full `timeoutMs`)
// whenever a second address exists, via `composeArmedTimeout`; a single-address walk keeps the
// caller-owns-the-deadline contract byte-for-byte (see relayFetch for why both halves are
// load-bearing). Composed manually with AbortController + setTimeout instead of
// AbortSignal.any/AbortSignal.timeout — those are ES2024 / ES2022 statics not present in this
// project's TS `lib` (which tops out at es2022) and not guaranteed on every RN/Hermes runtime
// the app targets, so the manual compose is the portable choice.
const DEFAULT_RELAY_TIMEOUT_MS = 10000;

// `fetch` + a caller-configurable timeout — the single source of truth for the inline
// `AbortController + setTimeout + fetch + clearTimeout` incantation previously duplicated across
// Wallet.tsx + the component sheets + catalog.ts. A caller signal is forwarded AS-IS and the
// backstop does NOT arm then — the caller owns the deadline outright — and CLEARS the timer in
// `finally` so no lingering no-op abort fires after the fetch settles (matches the inline
// pattern's semantics byte-for-byte). `{...init, signal}` overrides any caller `init.signal` with
// the composed one (fetch rejects a double assignment; the caller's signal is already forwarded
// into the composed controller). Default timeout is the 10s relay backstop; callers pass a
// shorter named timeout (BALANCE_TIMEOUT_MS / FAUCET_TIMEOUT_MS etc.) to bound fast polls.
// NOTE: this timer covers the fetch (HEADERS) settle only — the abort signal is released
// once the Response object exists. The BODY read that follows is bounded separately, by
// [`readBodyWithin`] below, because a server that answers `200 OK` and then stops writing would
// otherwise hold the caller forever — exactly what this helper exists to prevent.
export async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = DEFAULT_RELAY_TIMEOUT_MS): Promise<Response> {
  const {signal, cancel} = composeTimeout(init?.signal, timeoutMs);
  try {
    return await fetch(url, {...init, signal});
  } finally {
    cancel();
  }
}

/** One ARMED fetch — a real internal deadline on a fresh controller, the caller's signal
 *  forwarded first-wins (`composeArmedTimeout`). Used by the drift probes below; the walk itself
 *  composes the exact same shape INLINE so it can tell WHO aborted (its own internal deadline →
 *  transport failure, failover + cooldown fuel; the caller's signal → rethrow, never a
 *  failover). An armed deadline is what makes a hung transport — a relay that accepts the
 *  connection but never answers — reject on OUR clock instead of stalling for the full caller
 *  budget. Private to this module; `fetchWithTimeout`'s caller-owns-the-deadline contract (e.g.
 *  a 20 s deposit modal) is untouched. */
async function attemptFetch(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  const {signal, cancel} = composeArmedTimeout(init?.signal, timeoutMs);
  try {
    return await fetch(url, {...init, signal});
  } finally {
    cancel();
  }
}

/** How long a body may take to finish arriving once its headers have. Every body this app reads is
 *  a few hundred bytes of JSON or CBOR, so this is a stall detector rather than a budget. */
export const BODY_READ_TIMEOUT_MS = 10000;

/**
 * Run a body read under its own bound and REJECT if it stalls — the second half of
 * `fetchWithTimeout`'s promise. It never substitutes a value; deciding what a missing body means is
 * the caller's job, and the caller is the only one that knows whether "no body" is survivable.
 * `what` is prefixed to the error so a stalled read names the URL and status it belonged to.
 */
export async function readBodyWithin<T>(read: () => Promise<T>, what: string, timeoutMs = BODY_READ_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: the body did not finish arriving within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// PR26 — read a fetch Response's body as JSON, returning `{}` on any parse failure (a malformed
// body, an empty 5xx, a non-JSON body, a stalled read) instead of throwing. Relay bodies are
// best-effort: callers want `body.error` / payload fields if present and `{}` otherwise, never a
// throw that masks the real HTTP outcome. The line it leaves names the URL, the status and the
// cause — `'body parse failed'` on its own told a reader nothing about which of a dozen call sites
// had failed or why.
export async function readJsonOrEmpty(r: Response): Promise<any> {
  const where = `${r.url || 'the relay'} (HTTP ${r.status})`;
  try {
    return await readBodyWithin(() => r.json(), `readJsonOrEmpty: ${where}`);
  } catch (e) {
    console.warn(`readJsonOrEmpty: ${where} did not yield JSON — continuing with an empty body:`, e instanceof Error ? e.message : String(e));
    return {} as Record<string, unknown>;
  }
}

export type RelayCapabilities = {till: boolean; demoFaucet: boolean};

// ── R1: ordered multi-address selection (spec 2026-09-09 §"Direction 2 — several relays") ────
// One relay client at more than one address — NOT a fallback: no second code path, no behavior
// that differs per address. `relayFetch` walks the operator's ordered list (`relayAddresses`,
// first = preferred). WALK BUDGET (wave-2): EVERY attempt — attempt 0 included — runs under its
// OWN always-armed internal deadline whenever the walk has a second address: attempt 0 gets the
// FULL `timeoutMs` (not a budget cut — a slow-but-alive preferred relay answering at 3–4 s keeps
// working exactly as before), and failover attempt i gets `timeoutMs >> i` clamped to a 1000 ms
// floor (a 10 s slot: 10s, 5s, 2.5s, 1s, 1s, …). The caller's signal is forwarded first-wins
// into every attempt, so it remains the hard cap of the whole walk whenever it fires first. A
// SINGLE-address walk keeps the pre-R1 caller-owns-the-deadline contract byte-for-byte — there
// is no failover to fuel, and arming would cap caller-granted headroom (DepositSheet's 20 s) at
// `timeoutMs`. The falloff bounds a walk's worst case at ≈ 2×timeoutMs (a geometric sum:
// 10+5+2.5+…; once the halving reaches the floor, each further address adds the 1 s floor), so
// an all-hung list stalls ONE walk ≈ 2×timeoutMs, never N×timeoutMs with polls piling on. A
// hung attempt (accepted connection, no answer) rejects at its own deadline — a transport
// failure, i.e. failover fuel — AND (wave-2) arms the address cooldown below, so the NEXT walk
// starts at a healthier address instead of re-hanging on the same one. The spec's answer rule:
//
//   • transport failure (refused, DNS, attempt-timeout) OR HTTP >= 500 → try the next address;
//   • any answer BELOW 500 (2xx/3xx/4xx) is THE answer — a 4xx means the relay heard us and
//     refused, and asking a different replica would be asking a different question. No failover.
//
// Every read-only relay surface (catalog, balances, history, deposit info, onramp params, swap
// quote, capabilities, the till-adjacent reads) routes through here. Ledger-effecting POSTs (the
// demo faucet) stay single-address: an idempotent-looking retry against a second replica is not
// ours to decide. The TILL client deliberately does NOT route through here — till charges are
// relay-held, session-affine state (see services/till.ts for the pin).
//
// Build drift is a HARD error, never a silent mix: replicas must agree on /api/v1/version AND
// /api/v1/integrity. Before the FIRST data answer from a non-preferred address, both addresses'
// builds are fingerprinted and compared; a mismatch raises `RelayBuildDriftError` naming both
// addresses and both commits, and sticks (every subsequent call fails fast) until the operator
// fixes the list. Different builds serve different catalogs — mixing them would be dishonest.

/** The build half of the drift comparison: /api/v1/version + the stable fields of /api/v1/integrity.
 *  `live_module_hash` is DELIBERATELY excluded — it legitimately flaps during a facade upgrade
 *  window, while the relay's own commit and the pinned facade hash are baked per build. */
export type RelayBuildFingerprint = {
  commit: string;
  commitDate: string;
  facadeCanister: string | null;
  pinnedModuleHash: string | null;
};

export class RelayBuildDriftError extends Error {
  readonly kind: 'drift';
  readonly referenceAddr: string;
  readonly replicaAddr: string;
  readonly referenceCommit: string;
  readonly replicaCommit: string;
  constructor(args: {referenceAddr: string; replicaAddr: string; referenceCommit: string; replicaCommit: string}) {
    super(
      `Relay replicas run different builds — refusing to mix them. ${args.referenceAddr} runs commit ${args.referenceCommit}, but ${args.replicaAddr} runs commit ${args.replicaCommit}. Every replica in the server list must run the same build (same /api/v1/version and /api/v1/integrity); fix or remove the stale address in Settings.`,
    );
    this.name = 'RelayBuildDriftError';
    this.kind = 'drift';
    this.referenceAddr = args.referenceAddr;
    this.replicaAddr = args.replicaAddr;
    this.referenceCommit = args.referenceCommit;
    this.replicaCommit = args.replicaCommit;
  }
}

// Per-session build state. `fingerprints` memoizes successful reads so the drift check costs its
// round trips ONCE per address per list revision. `baseline` is the reference fingerprint the
// first comparison adopted (when the preferred address itself was unreachable and had never been
// seen). `drift`, once set, fails every subsequent call fast — a mixed-build list is an operator
// error, not a per-request condition to re-derive. Everything here is scoped to the list REVISION
// it was gathered under: walks capture the revision at entry and guard every write against it
// (`requireMatchingBuild`), and a latched `drift` carries its revision so one naming addresses
// that are no longer on the list is never surfaced (`relayBuildDrift` filters) — the next walk
// physically clears it in the reset below.
let fingerprints = new Map<string, RelayBuildFingerprint>();
let baseline: {addr: string; fp: RelayBuildFingerprint} | null = null;
let drift: {err: RelayBuildDriftError; revision: number} | null = null;
let cachesRevision = 0;

// Wave-2 per-address cooldown — the same idiom as the SOL rail's per-URL 429 cooldown
// (solana/rpc.ts): an address that failed by INTERNAL deadline expiry (TCP accepted, never
// answered — a hung transport) is walked LAST for the next ADDRESS_COOLDOWN_MS. Any HTTP answer
// (2xx/4xx/5xx — an answer is an answer) clears it; a CALLER abort never cools (a component
// unmount is not evidence the relay is down), and neither does a plain network refusal (the
// cooldown marks HUNG transports, whose symptom is exactly that they eat a whole deadline
// silently). A revision change (re-point/reprobe) clears every cooldown with the rest of the
// session state in `relayFetch` below — a new list gets a clean slate. This is ORDER only,
// never availability: if every address is cooled the walk uses the full original order (the
// wallet is never "offline by cooldown"). Keyed by the same `base()`-normalized address the
// walk uses; `Date.now()` rides the same fake clock as the timers in tests.
let cooldowns = new Map<string, number>();
const ADDRESS_COOLDOWN_MS = 30000;

/** The sticky drift error, if one has fired this session — Settings renders it in the server section.
 *  Revision-guarded: drift latched under an OLD list is not the new list's state. Once the list
 *  moves (edit, re-apply, or the same-address reprobe), this reads null even before a walk has
 *  physically cleared the latch — a mid-flight stale walk can never speak for the new list. */
export function relayBuildDrift(): RelayBuildDriftError | null {
  return drift != null && drift.revision === relayAddressesRevision() ? drift.err : null;
}

/** Test seam: clear the per-session build caches and the sticky drift. */
export function resetRelayBuildStateForTest(): void {
  fingerprints = new Map();
  baseline = null;
  drift = null;
  cooldowns = new Map();
  cachesRevision = relayAddressesRevision();
}

const DRIFT_PROBE_TIMEOUT_MS = 4000;

/** Probe an address's build. The probes compose the CALLING walk's signal (a caller abort ends a
 *  probe in flight) and each carries its OWN armed deadline, so a replica that answers neither
 *  probe can't stall the walk past DRIFT_PROBE_TIMEOUT_MS per attempt. */
async function fetchFingerprint(addr: string, signal: AbortSignal | undefined): Promise<RelayBuildFingerprint | null> {
  try {
    const version = await readJsonOrEmpty(await attemptFetch(`${addr}/api/v1/version`, {signal}, DRIFT_PROBE_TIMEOUT_MS));
    const integrity = await readJsonOrEmpty(await attemptFetch(`${addr}/api/v1/integrity`, {signal}, DRIFT_PROBE_TIMEOUT_MS));
    if (typeof version?.commit !== 'string' || version.commit.length === 0) return null;
    return {
      commit: version.commit,
      commitDate: typeof version?.commit_date === 'string' ? version.commit_date : '',
      facadeCanister: typeof integrity?.facade_canister === 'string' ? integrity.facade_canister : null,
      pinnedModuleHash: typeof integrity?.pinned_module_hash === 'string' ? integrity.pinned_module_hash : null,
    };
  } catch {
    return null;
  }
}

const sameBuild = (a: RelayBuildFingerprint, b: RelayBuildFingerprint) =>
  a.commit === b.commit && a.commitDate === b.commitDate && a.facadeCanister === b.facadeCanister && a.pinnedModuleHash === b.pinnedModuleHash;

/**
 * Gate a data answer from `replicaAddr` (a non-preferred address): verify its build against the
 * preferred address's. The reference is, in order: the preferred address's CACHED fingerprint for
 * this list revision (MEMOIZED after its first successful read — a preferred replica redeployed
 * MID-SESSION at the same URL keeps serving its old fingerprint here until the list is re-applied
 * or re-probed; that same-address redeploy is exactly what Settings' drift-recovery re-apply
 * exists for), else a LIVE probe of the preferred (it may just have 5xx'd the data call yet
 * still answer /version), else the session baseline (the preferred build as last seen), else —
 * neither ever seen — this replica itself becomes the baseline (first-seen; nothing has been
 * mixed yet, this is the first data to arrive). MISMATCH → the hard error, thrown to the caller
 * and STICKY. An unreadable fingerprint returns `{unverified}` instead: a replica whose build
 * cannot be read is not trusted with data, and the walk continues to the next address.
 *
 * `walkRevision` is the list revision the calling walk STARTED under, and guards every
 * shared-state write below (fingerprint memo, baseline adoption, drift latch): a walk that
 * outlived a Settings re-point must never mutate the NEW list's session state. A stale walk's
 * per-call outcome still stands (its own fetched answer is harmless), but a mismatch it finds
 * under a dead list is skipped SILENTLY — no latch, no throw; the fresh walk re-derives
 * everything under the new list.
 */
async function requireMatchingBuild(preferred: string, replicaAddr: string, walkRevision: number, signal: AbortSignal | undefined): Promise<{ok: true} | {unverified: string}> {
  const stillCurrent = () => relayAddressesRevision() === walkRevision;
  let replicaFp = fingerprints.get(replicaAddr);
  if (replicaFp == null) {
    const fetched = await fetchFingerprint(replicaAddr, signal);
    if (fetched == null) return {unverified: `its build could not be read (/api/v1/version or /api/v1/integrity unreachable or malformed)`};
    replicaFp = fetched;
    if (stillCurrent()) fingerprints.set(replicaAddr, fetched);
  }
  let reference: {addr: string; fp: RelayBuildFingerprint};
  const cachedPreferred = fingerprints.get(preferred);
  if (cachedPreferred != null) {
    reference = {addr: preferred, fp: cachedPreferred};
  } else {
    const livePreferred = await fetchFingerprint(preferred, signal);
    if (livePreferred != null) {
      if (stillCurrent()) fingerprints.set(preferred, livePreferred);
      reference = {addr: preferred, fp: livePreferred};
    } else if (baseline != null) {
      reference = baseline;
    } else {
      if (stillCurrent()) baseline = {addr: replicaAddr, fp: replicaFp};
      return {ok: true};
    }
  }
  if (!sameBuild(reference.fp, replicaFp)) {
    // The revision moved: this finding names addresses from a list the operator already replaced
    // — not the new list's state to latch. The fresh walk re-derives under the new list.
    if (!stillCurrent()) return {ok: true};
    const err = new RelayBuildDriftError({
      referenceAddr: reference.addr,
      replicaAddr,
      referenceCommit: reference.fp.commit,
      replicaCommit: replicaFp.commit,
    });
    drift = {err, revision: walkRevision};
    throw err;
  }
  return {ok: true};
}

/** Attempt-deadline floor of the walk's exponential falloff (see the R1 header above): the
 *  halving reaches this at attempt 4 of a 10 s slot; every deeper address keeps the floor, so
 *  each still gets a real — not degenerate — deadline. */
const ATTEMPT_TIMEOUT_FLOOR_MS = 1000;

/**
 * The ordered-selection fetch every read-only relay client routes through. `primaryUrl` is the
 * address the CALLER holds (App's active relay — the first entry of the operator's list); the
 * rest of the operator's list follows it in order. A single-entry world (no operator list, or one
 * address) is exactly the old single-URL fetch — one attempt, same URL, same errors. The walk
 * fails only after EVERY address refused/timed-out/5xx'd; the error names each address and its
 * reason (a bare "offline" across three addresses would be a lie about which three).
 */
export async function relayFetch(primaryUrl: string, path: string, init?: RequestInit, timeoutMs = DEFAULT_RELAY_TIMEOUT_MS): Promise<Response> {
  if (relayAddressesRevision() !== cachesRevision) {
    // The operator re-pointed the list (or re-applied/re-probed it for drift recovery): fingerprints
    // gathered for the old list (and any sticky drift) do not carry over — and neither do the
    // wave-2 address cooldowns: the new list gets a clean slate. This runs BEFORE the
    // drift latch below — moving the revision is exactly how an operator clears a drift stop after
    // fixing the stale replica.
    fingerprints = new Map();
    baseline = null;
    drift = null;
    cooldowns = new Map();
    cachesRevision = relayAddressesRevision();
  }
  // Revision-guarded: a latch from an older list revision is not this list's state (a mid-flight
  // stale walk cannot poison the session — see requireMatchingBuild).
  const latched = relayBuildDrift();
  if (latched != null) throw latched;
  // Every shared-state write this walk might make is guarded against THIS revision, captured at
  // entry — a Settings re-point that lands mid-walk leaves this walk read-only against the new
  // list's session state.
  const walkRevision = relayAddressesRevision();
  const preferred = base(primaryUrl);
  const walk: string[] = [preferred];
  for (const a of relayAddresses()) {
    const b = base(a);
    if (!walk.includes(b)) walk.push(b);
  }
  const failures: string[] = [];
  let last5xx: Response | null = null;
  // Wave-2 cooldown ordering: addresses cooled by an internal-deadline expiry walk LAST, original
  // relative order preserved in BOTH groups; if EVERY address is cooled, the original full order
  // stands — cooldown deprioritizes, it never declares the wallet offline.
  const nowMs = Date.now();
  const cooled = (a: string) => (cooldowns.get(a) ?? 0) > nowMs;
  const hot = walk.filter((a) => !cooled(a));
  const ordered = hot.length > 0 ? [...hot, ...walk.filter(cooled)] : walk;
  const stillCurrent = () => relayAddressesRevision() === walkRevision;
  for (let i = 0; i < ordered.length; i++) {
    const addr = ordered[i];
    // Exponential falloff (R1 audit fix): attempt i gets `timeoutMs >> i` — the FULL `timeoutMs`
    // at i=0 — floored at 1 s, so a hung transport fails over and the whole walk stays bounded
    // at ≈ 2×timeoutMs (see the R1 header above).
    const attemptMs = Math.max(timeoutMs >> i, ATTEMPT_TIMEOUT_FLOOR_MS);
    // Wave-2: EVERY attempt is armed — a real internal deadline on a fresh controller, the
    // caller's signal forwarded first-wins — whenever a SECOND address exists. The armed
    // attempt 0 is the hung-preferred fix: the internal deadline classifies the hang as OUR
    // transport failure (failover fuel + the cooldown below) instead of leaving the caller's
    // outer timer to fire first, which read as a caller decision and never failed over. A
    // SINGLE-address walk keeps the pre-R1 caller-owns-the-deadline contract byte-for-byte
    // (`composeTimeout`): there is no failover to fuel, and an internal cap would cut
    // caller-granted headroom (DepositSheet arms 20 s for a slow IC update) down to `timeoutMs`
    // — exactly the single-relay regression the naive always-arm fix was rejected for.
    const armed = ordered.length > 1;
    const {signal: attemptSignal, cancel} = armed
      ? composeArmedTimeout(init?.signal, attemptMs)
      : composeTimeout(init?.signal, attemptMs);
    try {
      const r = await fetch(`${addr}${path}`, {...init, signal: attemptSignal});
      // Any answer — 2xx/4xx/5xx — proves the transport lives, so it must never stay cooled.
      // Revision-guarded like every shared-state write: a stale walk does not speak for the new
      // list's session state.
      if (stillCurrent()) cooldowns.delete(addr);
      if (r.status >= 500) {
        failures.push(`${addr} (HTTP ${r.status})`);
        last5xx = r;
        continue;
      }
      // A 4xx from any address is an answer — returned as-is, no failover, no build check (the
      // refusal itself is authoritative regardless of build; only DATA answers get gated).
      if (addr !== preferred && r.ok) {
        const gate = await requireMatchingBuild(preferred, addr, walkRevision, init?.signal);
        if ('unverified' in gate) {
          failures.push(`${addr} (${gate.unverified})`);
          continue;
        }
      }
      return r;
    } catch (e: unknown) {
      // The build-drift gate's hard error must propagate, not become a walk "failure" — a
      // mismatched replica ends the call with the drift error, never a silent next address.
      if (e instanceof RelayBuildDriftError) throw e;
      // The CALLER's abort is not a transport failure — walking to another address after the
      // caller gave up would be a fetch nobody awaits, and it must not bad-mark the address
      // either (a component unmount is not evidence the relay is down). (`init.signal` fires on
      // caller aborts; the per-attempt internal deadline aborts only the composed signal.)
      if (init?.signal?.aborted) throw e;
      // Wave-2: the attempt's OWN deadline expiry — the composed signal aborted while the
      // caller's did not — is a hung transport (TCP accepted, never answered): failover fuel,
      // AND cooldown fuel. Only the armed shape can land here (a single-address attempt has no
      // internal signal of its own), and only under the walk's own list revision (a stale walk
      // must not bad-mark an address on a list the operator already replaced).
      if (armed && attemptSignal.aborted && stillCurrent()) cooldowns.set(addr, Date.now() + ADDRESS_COOLDOWN_MS);
      failures.push(`${addr} (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      cancel();
    }
  }
  // Wave-2: the caller's abort is rethrown BEFORE the aggregate — an abort that landed during a
  // drift probe (swallowed into `unverified`) or on the last address is the caller's decision,
  // not an outage, and must not be misreported as "all relay addresses failed".
  if (init?.signal?.aborted) {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  }
  // Every address was tried and none answered data. If some replica DID answer — with a 5xx —
  // that answer is what the caller sees: a reachable relay refusing to serve is a fact about the
  // service, and its error body (surfaced verbatim by the path clients) says WHY. The synthetic
  // aggregate is for the all-transport-dead case, where no relay said anything at all.
  if (last5xx != null) return last5xx;
  throw new Error(`all relay addresses failed — ${failures.join('; ')}`);
}

// What every caller starts from and what every failure path below falls back to: a relay that has
// told us nothing offers nothing. The ONE literal — a hand-written `{till: false, demoFaucet:
// false}` elsewhere is the same claim written twice.
export const NO_RELAY_CAPABILITIES: RelayCapabilities = {till: false, demoFaucet: false};

// Capability discovery is advisory and fail-closed. Older, unreachable, or malformed relays must
// never make the wallet advertise a cashier or demo-faucet action that can only end in an error.
// Failing closed QUIETLY is the bug: the wallet then hides the cashier and the top-up with nothing
// anywhere saying why, which is indistinguishable from a relay that really has neither. So every
// path out of here that isn't an answer leaves a line naming the URL asked and what came back.
export async function relayCapabilities(relayUrl: string): Promise<RelayCapabilities> {
  const url = `${base(relayUrl)}/api/v1/capabilities`;
  try {
    const r = await relayFetch(relayUrl, '/api/v1/capabilities');
    if (!r.ok) {
      console.warn(`relayCapabilities: ${url} answered HTTP ${r.status} — assuming no till and no demo faucet`);
      return NO_RELAY_CAPABILITIES;
    }
    const j = await readJsonOrEmpty(r);
    if (typeof j?.till !== 'boolean' || typeof j?.demo_faucet !== 'boolean') {
      console.warn(`relayCapabilities: ${url} returned ${JSON.stringify(j)}, not the {till, demo_faucet} booleans — assuming no till and no demo faucet`);
      return NO_RELAY_CAPABILITIES;
    }
    return {till: j.till, demoFaucet: j.demo_faucet};
  } catch (e: unknown) {
    console.warn(`relayCapabilities: ${url} unreachable — assuming no till and no demo faucet:`, e instanceof Error ? e.message : String(e));
    return NO_RELAY_CAPABILITIES;
  }
}

// Relay deposit client — routes through `relayFetch` (R1's ordered multi-address walk; the
// AbortSignal is optional, errors are thrown to the caller), which cancels its attempt timers in
// `finally`. It used to compose the signal by hand, which leaked the timer: the composed `cancel`
// was dropped on the floor, so every omitted-signal call left a live 10s timeout holding its
// AbortController closure until it fired a no-op abort.
// R1 fix (wave-3 audit): the walk arms attempt 0 at its `timeoutMs` whenever a second address
// exists, and that budget defaulted to the generic 10s backstop — silently capping the operators'
// deliberate 20s deposit budget (DEPOSIT_TIMEOUT_MS; deposit info proxies the minter's
// get_minter_info, observed at 7–15s on mainnet) on every multi-address walk. The budget is
// threaded ONLY when the caller armed a signal, so attempt 0's internal deadline equals that 20s
// grant; an omitted-signal caller keeps the generic 10s safety net (the `undefined` fall-through to
// DEFAULT_RELAY_TIMEOUT_MS — the backstop is a spinner guard, not a deposit budget), and a
// single-address walk stays byte-for-byte pre-R1 either way (unarmed: the caller's signal is
// forwarded as-is).
export async function depositInfo(relayUrl: string, currency: number, signal?: AbortSignal): Promise<DepositInfo> {
  const r = await relayFetch(relayUrl, `/api/v1/deposit/info?currency=${currency}`, {signal}, signal ? DEPOSIT_TIMEOUT_MS : undefined);
  const j = await readJsonOrEmpty(r);
  if (!r.ok) throw new Error(typeof j?.error === 'string' ? j.error : `deposit/info ${r.status}`);
  return j as DepositInfo;
}
// ckERC-20 / native-ETH onramp params (helper contract, ERC-20 address) for a CkEthErc20-family
// currency. The app builds the user's Ethereum transaction(s) from these; the user signs in their
// own wallet (non-custodial). The deposit `principal` arg is the user's OWN IC principal (derived
// in-app via DpayCore.icpSelfPrincipal; ICRC-1 default subaccount) — the relay serves no principal.
// `kind` discriminates the deposit shape:
//  - "erc20": two txs (approve the ERC-20, then depositErc20); `erc20_address` is the token contract.
//  - "native_eth": ONE payable tx (depositEth) carrying the ETH `value`; `erc20_address` is null.
// Errors throw with the status (503 = no CkEthErc20 onramp for the currency / relay unreachable).
export type CkErc20OnrampParams = {helper_address: string; erc20_address: string | null; kind: 'erc20' | 'native_eth'};
export async function ckerc20OnrampParams(relayUrl: string, currency: number, signal?: AbortSignal): Promise<CkErc20OnrampParams> {
  // Same walk-budget threading as `depositInfo` above (R1 wave-3 audit): with the caller's 20s
  // grant armed, that grant is also the walk's attempt-0 deadline, so a multi-address walk cannot
  // internally cap it at the 10s default; an omitted-signal caller keeps the generic safety net.
  const r = await relayFetch(relayUrl, `/api/v1/onramp/ckerc20?currency=${currency}`, {signal}, signal ? DEPOSIT_TIMEOUT_MS : undefined);
  const j = await readJsonOrEmpty(r);
  if (!r.ok) throw new Error(typeof j?.error === 'string' ? j.error : `onramp/ckerc20 ${r.status}`);
  return j as CkErc20OnrampParams;
}
