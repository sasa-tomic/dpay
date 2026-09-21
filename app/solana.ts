// SOL native device-key rail — the isolation-boundary seam (mirrors `app/wallet.ts`→
// `app/walletconnect.ts`). Statically imports ONLY the PURE modules (`solana/identity`,
// `solana/tx`, `solana/spl`, `solana/qr`, `payments` — no network, no `@solana/*` SDK, safe under
// jest/e2e). The network module `solana/rpc` is reached via a lazy `await import('./solana/rpc')`
// INSIDE the async network functions, gated by a non-empty `solanaRpcUrl()` (the operator slot in
// config/constants.ts — a baked default that a persisted choice can replace). With the URL empty
// (jest.setup.js + the e2e driver set `__DPAY_TEST_SOLANA_RPC_URL=''`), these functions no-op /
// throw — so the offline inner loop never imports the network module and never touches devnet.
//
// v2 recent-blockhash payment lifecycle (the durable-nonce rail was REMOVED — see
// 2026-08-12-solana-recent-blockhash-rewrite-plan.md):
//   createSolPaymentRequest — ONLINE merchant fetches genesis hash + fresh blockhash + builds SolReqV2.
//   signSolPayment / signSplPayment — OFFLINE payer signs the canonical message (no network).
//   broadcastSolPayment — ONLINE merchant strictly verifies, freshness-checks, broadcasts, confirms.
// (The v1 durable-nonce reclaim tool was removed 2026-08-14: no user ever held v1 nonce funds.)

import bs58 from 'bs58';
import {solanaRpcUrl, solanaRpcUrls, solanaBroadcastRpcUrls, icGatewayUrl, SOL_GENESIS_HASH, SOL_PAYMENT_MAX_WINDOW_SECONDS, SOL_PAYMENT_COMMITMENT, SOL_BROADCAST_TIMEOUT_MS, SOL_RPC_IMPORT_DEADLINE_MS} from './config/constants';
import {solanaTokenAvailable} from './config/assets';
import {deriveSolanaKeypair, deriveSolanaAddress} from './solana/identity';
import {SOL_DECIMALS, SOL_UNIT} from './solana/identity';
import {fmtAssetCompact} from './lib/format';
import {base58Decode32, buildSignedTransfer, signTransaction, assembleMessage, buildCanonicalSolMessage, verifySolPayment, extractSignedTxParts, buildMemoInstruction, buildSolTransferInstruction, type Instruction} from './solana/tx';
import {buildSplTransferInstruction, buildTransferCheckedInstruction, buildCreateAtaIdempotentInstruction, buildCanonicalSplMessage, deriveAta, decodeSplTokenAmount, decodeSplMintDecimals, SOL_ATA_SETUP_MIN_LAMPORTS} from './solana/spl';
import {isEndpointRefusal, isRelayPathDown, isSolBlockhashNotFound} from './solana/errors';
import {base64ToBytes} from './lib/base64';
import {solanaTokenInfo, solanaTokenOfMint} from './solana/tokens';
import {utf8ToBytes} from './lib/base64url';
import {encodeSolReq, generateRid} from './solana/qr';
import type {SolReqV2, SolPayV2, SolReceiptV2, SolReqInput, SolPayInput} from './solana/qr';
import type {SolanaSignatureStatus, SolanaTransactionDetail, SolanaAccountInfo} from './solana/rpc';
import type {SolanaHistory, SolanaHistoryRow} from './solana/history';
import {verifySettledTransaction} from './solana/settleVerify';
import {RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE, RECEIPT_MISMATCH} from './solana/payments';
import {M} from './i18n';

export {deriveSolanaAddress};
// Type-only re-export: the history hook consumes these shapes but must reach the network module
// only through this seam. `export type` is erased, so nothing is pulled into the bundle.
export type {SolanaHistory, SolanaHistoryRow} from './solana/history';

/** The send seam's deadline GUARANTEE: the returned promise settles the moment `signal` aborts,
 *  even if the underlying work never does. Why it exists: every layer below this seam is
 *  *supposed* to honor the caller's abort (rpcFetch composes it into fetch; confirmTransaction
 *  checks it each poll; sleep rejects on it), but "supposed to" is not "always does" — the 2026-09-21
 *  EURC send-sheet hang (twice, live, past the 60s SOL_SEND_TIMEOUT with the sheet stuck in
 *  `submitting`) is exactly the shape an un-honored abort produces: no throw, no phase change,
 *  a spinner forever. A send that outlives its own deadline must REJECT — the caller (the sheet)
 *  then flips to the honest unknown-outcome state instead of spinning. The aborted send's error
 *  message matches `friendlySolError`'s timeout class, so a caller that doesn't branch on it
 *  still shows honest "timed out" copy. `what` names the operation in the message (diagnosis
 *  without a debugger). The underlying promise's eventual settlement is harmless: its handlers
 *  resolve/reject an already-settled promise, a no-op. */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined, what: string): Promise<T> {
  if (signal === undefined) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(`${what} aborted (deadline)`));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, {once: true});
    p.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}
// Same reason: `getSolSignatureStatus` hands its caller the chain's verdict verbatim, so the shape
// of that verdict has to be nameable without importing the network module.
export type {SolanaSignatureStatus} from './solana/rpc';

// ============================================================================
// The send path's module load — bounded, preloaded, traced (2026-09-21 root cause).
//
// THE DIAGNOSIS. Three live EURC sends (2026-09-21) sat down BEFORE any RPC fired and never
// broadcast: the first await inside sendSol/sendSpl is `await import('./solana/rpc')` — a LAZY
// CHUNK in the served web build (`rpc-*.js`, fetched from the relay origin) — and a module load
// carries NO abort signal and NO timeout. It is the one await in the send chain the caller's 60s
// deadline cannot cut from below and the one that ignores `abortable` from above: attempts 1-2
// hung the sheet in `submitting` FOREVER (every RPC honors the signal; the import does not), and
// when the same stalled origin connection failed the IC balance poll 3× (attempt 3's offline
// flip) the gate then ate the sheet's error surface too. Nothing broadcast; curl from the host
// stayed healthy because the stall was in the page's own origin connections.
//
// So the money path now: (1) PRELOADS the module when the send sheet mounts (minutes before any
// click — the normal click-time import is already resolved); (2) races the click-time import
// against a bound (`SOL_RPC_IMPORT_DEADLINE_MS`) and fails with classified, actionable copy
// (`M.sol.engineLoad`) instead of hanging; (3) TRACES each step to console.warn — the on-device
// log mirror (services/log.ts installLogSink) captures warn, so the last traced line names the
// exact hung step on any future live attempt. The prefix matches `logMoney`'s so the file reads
// as one story; the services layer itself is NOT imported from here (it pulls the native module,
// which this seam must never do under jest/e2e).
// ============================================================================

/** One warn line in the money-log's own dialect. console.warn is the transport because the
 *  on-device log mirror already captures it — never a services import from this seam. */
function traceSend(msg: string): void {
  console.warn(`money: sol send ${msg}`);
}

let rpcPreloadStarted = false;

/** Warm the network module OFF the money path. Fired when the send sheet mounts (and re-armable
 *  after a failed load): by the time a user has typed a destination and an amount the chunk is
 *  loaded, so the click-time import in `loadRpcForSend` resolves instantly. A no-op when the rail
 *  is off (`solanaRpcUrl()` empty — the jest/e2e isolation contract: the offline loop never
 *  imports the network module) and when a preload already started. */
export function preloadSolanaRpc(): void {
  if (rpcPreloadStarted || !solanaRpcUrl()) return;
  rpcPreloadStarted = true;
  void import('./solana/rpc').catch(() => {
    // A failed warm must be retryable — the send path's bounded load re-imports on demand.
    rpcPreloadStarted = false;
  });
}

/** The bounded module load for every MONEY path that awaits the network module. Races the import
 *  against `SOL_RPC_IMPORT_DEADLINE_MS`; on expiry throws the engine-load class (friendlySolError
 *  → `M.sol.engineLoad`: check your connection, reopen, retry) instead of hanging the send for
 *  the caller's whole deadline on a stalled chunk. The underlying import keeps loading and its
 *  eventual resolution warms the module map — the RETRY then succeeds without re-fetching. The
 *  loader is injectable for tests. */
export async function loadRpcForSend(
  deadlineMs: number = SOL_RPC_IMPORT_DEADLINE_MS,
  load: () => Promise<typeof import('./solana/rpc')> = () => import('./solana/rpc'),
): Promise<typeof import('./solana/rpc')> {
  preloadSolanaRpc(); // in the normal case the sheet's mount preload already resolved this
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      rpcPreloadStarted = false; // a timed-out load must be retryable
      reject(new Error(`solana rpc module failed to load within ${deadlineMs}ms (the payment engine chunk never arrived — check the connection to the relay and retry)`));
    }, deadlineMs);
  });
  try {
    return await Promise.race([load(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ============================================================================
// The broadcast seam's diagnosed blockhash refresh (the 2026-09-21 attempt-#5 live signature).
//
// The first clean live send failure died mid-broadcast with the preflight simulation's
// "Transaction simulation failed: Blockhash not found" ~1s after a fresh
// 'confirmed'-commitment fetch (tracer: … → sign → blockhash → broadcast FAILED). The code
// exonerates every client-side suspect: the signed tx carries the EXACT blockhash from the one
// `getLatestBlockhash` on the path (no earlier fetch exists — quote/fee/ATA preflight fetch
// nothing), the fetch commitment is SOL_PAYMENT_COMMITMENT='confirmed', the relay forwards
// `sendTransaction` as a pure uncached pipe (crates/dpay-relay/src/solana.rs READ_METHOD_TTLS),
// and the ATA-create instruction is assembled once, before the fetch, never rebuilt. The
// remaining mechanism is the provider's own preflight node missing a FRESH blockhash from its
// queue — a load-balanced shard lagging the confirmed tip, a provider-side state anomaly, not
// a bytes problem. That refusal is also SAFE to recover from: a preflight-simulation refusal is
// returned as an error and the tx is dropped BEFORE acceptance/forwarding, so nothing was
// broadcast and re-signing on a fresh blockhash cannot double-send.
//
// So every money path broadcasts through ONE helper: fetch the blockhash ONCE, at the right
// point, and sign with THAT exact value — the tracer reads blockhash → sign → broadcast
// (sendSpl's labels used to read sign → blockhash, a mislabel that sent the attempt-#5
// diagnosis hunting a stale hash). On a CLASSIFIED blockhash-not-found refusal it refreshes +
// re-signs + re-broadcasts EXACTLY ONCE (tracer: `step blockhash-refresh-retry`) — a diagnosed
// state refresh, never a blind loop (founder rule). A second refusal throws the refused-twice
// class the sheet renders as its own honest copy; any OTHER error never refreshes.
//
// ATTEMPT-#6 COMPOSITION (2026-09-21): each broadcast attempt is now a full CANDIDATE WALK over
// `solanaBroadcastRpcUrls()` — the relay-derived homes + the public mainnet tail. The walk
// re-sends the SAME signed bytes to the next home on a blockhash-not-found refusal (no re-sign;
// the signature is valid on any endpoint — the live replay proved it), so the refresh below
// fires only when EVERY candidate refused: the once-only refresh bound is untouched, and the
// refused-twice class + its honest copy are untouched. The tracer gains one inner step per
// advance (`rpc-failover`, emitted by the walk itself), so the story reads
// broadcast → rpc-failover → [accepted | blockhash-refresh-retry → …].
// ============================================================================

/** The structural RPC subset the broadcast helper needs — satisfied by solana/rpc.ts's
 *  `getLatestBlockhash`/`sendTransaction` as every send path already destructures them. */
interface BroadcastRpc {
  getLatestBlockhash: (url: string[], opts?: {signal?: AbortSignal}) => Promise<{blockhash: string}>;
  sendTransaction: (url: string[], raw: Uint8Array, opts?: {signal?: AbortSignal}) => Promise<string>;
}

/** The classified refusal → whether the diagnosed refresh owns it. Kept as a named predicate so
 *  the refresh condition reads as the decision it is (see `isSolBlockhashNotFound` for why this
 *  failure class and no other). */
function isBlockhashNotFoundRefusal(e: unknown): boolean {
  return e instanceof Error && isSolBlockhashNotFound(e.message);
}

/** Fetch a fresh blockhash, sign with THAT exact value, broadcast — refreshing ONCE on a
 *  classified blockhash-not-found preflight refusal (module comment above). `sign` receives the
 *  base58 blockhash and returns the signed raw bytes; it must depend ONLY on its input, so the
 *  refresh re-signs the SAME transaction over the NEW blockhash. Returns the signature of the
 *  attempt the network accepted — `confirm` and `onBroadcast` stay the caller's. */
async function broadcastSignedWithFreshBlockhash(
  rpc: BroadcastRpc,
  signal: AbortSignal | undefined,
  at: (step: string) => void,
  sign: (blockhashB58: string) => Uint8Array,
): Promise<string> {
  // The broadcast walk's candidate list — derived homes + the public tail (attempt-#6). The
  // blockhash fetch rides the SAME list: the tail is same-cluster mainnet, so a relay leg
  // that is down no longer kills the send at the first await.
  const urls = solanaBroadcastRpcUrls();
  at('blockhash');
  const {blockhash} = await rpc.getLatestBlockhash(urls, {signal});
  at('sign');
  const raw = sign(blockhash);
  at('broadcast');
  try {
    return await rpc.sendTransaction(urls, raw, {signal});
  } catch (e: unknown) {
    if (!isBlockhashNotFoundRefusal(e)) throw e;
    // The one diagnosed refresh: the error names the state (the simulating node's blockhash
    // queue missed a fresh hash), the remedy is that state's refresh, and attempt one is
    // provably unsent (preflight refusal = dropped before acceptance). Exactly once — a second
    // refusal is the honest refused-twice class, never a loop. (With the attempt-#6 walk this
    // fires only after EVERY candidate refused the SAME state — the walk already re-sent the
    // identical bytes down the list first.)
    at('blockhash-refresh-retry');
    const {blockhash: fresh} = await rpc.getLatestBlockhash(urls, {signal});
    at('sign');
    const reRaw = sign(fresh);
    at('broadcast');
    try {
      return await rpc.sendTransaction(urls, reRaw, {signal});
    } catch (e2: unknown) {
      if (isBlockhashNotFoundRefusal(e2)) {
        throw new Error(`sol broadcast refused twice (fresh block re-signed once): ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
      throw e2;
    }
  }
}

// --- existing exports (unchanged) ----------------------------------------------

// ============================================================================
// Honest Solana balances — native SOL and every visible SPL mint, in ONE request (2026-09-08).
//
// The wallet must render a distinct row per Solana asset AND keep five states distinguishable
// (plan invariant #10): loading, known-absent token account, known zero balance,
// stale/unavailable, and read error — the last one now WITH its reason. `readSolanaBalances` is
// the discriminated-union reader; the `useSolanaBalances` hook translates it into per-rail state.
// ============================================================================

/** The per-mint balance result — the states that must stay distinct at the seam boundary. See
 *  `readSolanaBalances` for what each one means and how it is produced. */
export type SolanaTokenBalanceResult =
  | {kind: 'offline'}
  | {kind: 'absent'}
  | {kind: 'balance'; amount: string; decimals: number}
  | {kind: 'error'; failure: SolanaReadFailure};

/** Why a read produced no fact — the distinction a user has to be told apart, because the actions
 *  differ (spec 2026-09-09-relay-ha-and-solana-proxy §"What the app says…": three states, never
 *  collapsed into one). `refused`: the endpoint ANSWERED and did not serve us (HTTP status, 429,
 *  RPC error) — this device is online and the RAIL is what is broken. `offline`: nothing answered
 *  anywhere — the rail's endpoint AND the IC boundary probe both failed, so the phone has no
 *  connectivity; no one is at fault, and dpay must not claim an outage it cannot see. This is the
 *  payer's normal, designed state. `unreachable`: nothing answered on the rail's path while the
 *  phone IS online — reached one of two ways: every walk candidate died on transport AND the IC
 *  boundary probe answered (`classifyTransportFailure` below), or the walk exhausted with the
 *  relay's own `dpayRelayError` marker on every candidate (`SolanaRelayPathDown` from
 *  `solana/rpc.ts` — the relay itself answered HTTP and reported its Solana leg dead, so no
 *  probe is needed; the fast path, checked first in the catches). `unreadable`: the endpoint
 *  answered with bytes that cannot be trusted. */
export type SolanaReadFailure = 'refused' | 'offline' | 'unreachable' | 'unreadable';

/** The native-SOL half of one balance read. `lamports` is an exact decimal-digit string. */
export type SolanaSolBalanceResult =
  | {kind: 'offline'}
  | {kind: 'lamports'; lamports: string}
  | {kind: 'error'; failure: SolanaReadFailure};

/** One balance read: native SOL and every requested mint, from ONE request. */
export type SolanaBalancesRead = {
  sol: SolanaSolBalanceResult;
  tokens: Record<string, SolanaTokenBalanceResult>;
};

/** How long the offline/unreachable oracle waits for the IC boundary's answer. Short on purpose:
 *  it informs COPY, not money decisions, and a user waiting on a note should not wait on a probe. */
const CONNECTIVITY_PROBE_MS = 2500;
/** Dedupe window for the connectivity probe. The probe exists so a FAILING poll can tell "this
 *  phone has no connectivity" from "the service side is down" — and the balance poll fails once
 *  per `POLL.balance` tick (2.5s in a shipped build), which is FASTER than this window on purpose:
 *  without the memo every failing active tick would fire a fresh probe (the 2s pre-audit value did
 *  exactly that). 10s bounds the probe to ~1 per decade of ticks while the rail is down and still
 *  re-probes soon enough that a phone that came back is re-classified within a few ticks. */
const CONNECTIVITY_PROBE_TTL_MS = 10000;
let connectivityMemo: {probeUrl: string; at: number; result: 'unreachable' | 'offline'} | null = null;

/** The IC boundary origin the oracle probes — the SAME resolution `services/icp.ts` submits to
 *  (`icGatewayUrl()` in config/constants: the operator override, then the per-call
 *  `__DPAY_TEST_IC_GATEWAY` seam, then icp-api.io). This seam must not statically import the
 *  services layer — icp.ts pulls the native DpayCore module, and the offline jest/e2e loop must
 *  never load it from here — which is exactly why the resolution lives in config/constants, the
 *  one pure module both sides can share (before the operator override existed the literal was
 *  duplicated here; the duplication ended when the two resolutions had to agree). Read PER CALL,
 *  exactly like icp.ts, so the e2e harness's fake-IC gateway redirect covers the oracle too: in
 *  e2e the probe lands on the in-process gateway (a known origin), never on the real icp-api.io. */
const icProbeUrl = (): string => icGatewayUrl();

/**
 * The offline/unreachable oracle (R3, spec 2026-09-09: "the phone has no connectivity" vs "the
 * rail is unreachable while the phone is online" are different facts with different blame). A
 * transport failure on the Solana rail's path proves only that NOTHING answered there; to tell "no
 * connectivity" from "the service side is down" the seam asks a host that is deliberately OFF that
 * path: the IC boundary (`https://icp-api.io` — the app's other value rail, which never touches
 * the Solana path). Any HTTP answer from it — 200, 404, 405, all of it — proves the phone is
 * online, so the rail's path is what is down ('unreachable'); that answer is also what
 * substantiates the unreachable copy's "your Internet Computer payments still work" claim, because
 * the probe literally is the IC check. No answer there either means nothing is reachable from this
 * phone ('offline') — and the copy must not blame dpay, the endpoint, or anyone, because the
 * wallet cannot see that far.
 *
 * The reference host CANNOT be the relay: post-proxy (spec direction 1) the Solana rail path IS
 * the relay, so a relay outage would fail both the read AND a relay probe — the phone would be
 * told "you are offline" while dpay is down, the exact collapse R3 exists to prevent. Probing the
 * IC boundary instead keeps the two facts independent in every topology.
 *
 * Checked BEFORE any network probe, in order: (1) the test override
 * `__DPAY_TEST_SOLANA_CONNECTIVITY: 'offline' | 'online'` (hermetic jest; the e2e driver injects
 * it per stage); (2) `navigator.onLine === false`, the web's own free signal (absent on RN —
 * harmless); (3) the probe, deduped per probe URL for CONNECTIVITY_PROBE_TTL_MS.
 */
export async function classifyTransportFailure(): Promise<'unreachable' | 'offline'> {
  const override =
    (globalThis as unknown as {__DPAY_TEST_SOLANA_CONNECTIVITY?: 'offline' | 'online'}).__DPAY_TEST_SOLANA_CONNECTIVITY;
  if (override === 'offline') return 'offline';
  if (override === 'online') return 'unreachable';
  const nav = (globalThis as unknown as {navigator?: {onLine?: boolean}}).navigator;
  if (nav?.onLine === false) return 'offline';
  const probeUrl = icProbeUrl();
  if (connectivityMemo != null && connectivityMemo.probeUrl === probeUrl
      && Date.now() - connectivityMemo.at < CONNECTIVITY_PROBE_TTL_MS) {
    return connectivityMemo.result;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONNECTIVITY_PROBE_MS);
  let result: 'unreachable' | 'offline';
  try {
    // ANY HTTP answer — 200, 4xx, 405 on HEAD, all of it — proves transport off the Solana path
    // works. icp-api.io has no health path; the bare origin IS the reference.
    await fetch(probeUrl, {method: 'HEAD', signal: ctrl.signal});
    result = 'unreachable';
  } catch {
    result = 'offline';
  } finally {
    clearTimeout(timer);
  }
  connectivityMemo = {probeUrl, at: Date.now(), result};
  return result;
}

/**
 * ONE request for the whole wallet: native SOL lamports and every requested mint's token balance,
 * read as accounts in a single `getMultipleAccounts` (`solana/rpc.ts`) instead of one
 * `getBalance` plus two calls per mint.
 *
 * The account list is [wallet, (token account, mint) per mint]: the token account carries the raw
 * amount and the MINT account carries `decimals`, so the chain still states the scale it is
 * counted in — that fact is read from the chain every poll, exactly as `getTokenAccountBalance`
 * used to state it, not assumed from the local registry.
 *
 * States are the ones the wallet must keep apart (plan invariant #10), unchanged:
 *   - `offline`: `solanaRpcUrl()` empty, or `solanaTokenAvailable(mint)` false for that mint (a
 *     mainnet mint pointed at a non-mainnet RPC). No network call is made for it.
 *   - `absent`: the account does NOT exist — a `null` entry, which is what a Solana node answers
 *     for an address nothing was ever created at (measured against mainnet 2026-09-08). A KNOWN
 *     zero, and the fact the SPL sign gate is allowed to refuse on.
 *   - `balance`: the exact raw amount as a decimal-digit STRING (money-critical: never through JS
 *     `number`) plus the mint's own decimals.
 *   - `error`: the read produced no fact, WITH the reason (`SolanaReadFailure`) — because "the
 *     endpoint refused us" and "nothing answered" are different things to tell a user, and the
 *     second one is the ordinary state of an offline payer.
 *
 * A wallet account that does not exist reads as `lamports: '0'` — measured: `getBalance` answers
 * exactly 0 for such an address, so nothing is lost by the one call replacing both.
 */
export async function readSolanaBalances(
  secretHex: string,
  mints: string[],
  signal?: AbortSignal,
): Promise<SolanaBalancesRead> {
  const mapMints = (list: string[], r: SolanaTokenBalanceResult): Record<string, SolanaTokenBalanceResult> =>
    Object.fromEntries(list.map((m) => [m, r]));
  if (!solanaRpcUrl()) return {sol: {kind: 'offline'}, tokens: mapMints(mints, {kind: 'offline'})};

  const address = deriveSolanaAddress(secretHex);
  // A mint the current cluster cannot coherently answer for is not asked about at all — and is
  // reported 'offline' whatever the request does, because no request was made for it.
  const asked = mints.filter((m) => solanaTokenAvailable(m));
  const tokens: Record<string, SolanaTokenBalanceResult> = mapMints(
    mints.filter((m) => !asked.includes(m)),
    {kind: 'offline'},
  );
  // [wallet, ata(mint₀), mint₀, ata(mint₁), mint₁, …] — positional, and read back positionally.
  const addresses = [address, ...asked.flatMap((m) => [bs58.encode(deriveAta(address, m)), m])];

  const {getMultipleAccounts} = await import('./solana/rpc');
  let accounts: (SolanaAccountInfo | null)[];
  try {
    accounts = await getMultipleAccounts(solanaRpcUrls(), addresses, {signal});
  } catch (e) {
    // A CALLER-ABORTED read is not a failure to classify (audit F6): unmount/mint-change aborts
    // used to run the oracle — firing a stray connectivity probe — and log a bogus cause. Rethrow;
    // the caller that aborted already knows why.
    if (signal?.aborted) throw e;
    // Branching on the error SHAPE, never on message text, in precedence order:
    //   1. `SolanaRelayPathDown` (brand `dpayRelayPathDown`, from `solana/rpc.ts`'s candidate
    //      walk) — the relay ANSWERED HTTP but its Solana leg is dead. That fact already
    //      proves the phone is online, so it maps STRAIGHT to 'unreachable' without the IC
    //      probe below (the probe would spend its 2.5s budget re-confirming what the relay's
    //      own marker just proved — this is the dedicated fast path R3's doc allows).
    //   2. `SolanaEndpointRefused` (brand `dpayEndpointRefused`) — the endpoint answered and
    //      did not serve us.
    //   3. everything else is a transport failure — and "this phone has no connectivity" vs
    //      "the rail's path is down while the phone is online" is a distinction the oracle
    //      owns, not a guess.
    const failure: SolanaReadFailure = isRelayPathDown(e)
      ? 'unreachable'
      : isEndpointRefusal(e)
        ? 'refused'
        : await classifyTransportFailure();
    console.warn(`readSolanaBalances: ${failure} for ${address}:`, e instanceof Error ? e.message : String(e));
    return {sol: {kind: 'error', failure}, tokens: {...tokens, ...mapMints(asked, {kind: 'error', failure})}};
  }

  const wallet = accounts[0];
  const sol: SolanaSolBalanceResult = {kind: 'lamports', lamports: wallet === null ? '0' : String(wallet.lamports)};
  asked.forEach((mint, i) => {
    const ata = accounts[1 + i * 2];
    const mintAccount = accounts[2 + i * 2];
    if (ata === null) {
      tokens[mint] = {kind: 'absent'};
      return;
    }
    try {
      if (mintAccount === null) throw new Error(`mint account ${mint} does not exist on this cluster`);
      const amount = decodeSplTokenAmount(base64ToBytes(ata.data[0]), mint);
      const decimals = decodeSplMintDecimals(base64ToBytes(mintAccount.data[0]));
      tokens[mint] = {kind: 'balance', amount: amount.toString(), decimals};
    } catch (e) {
      // The endpoint answered; its bytes are the problem. Never a zero — the hook keeps the last
      // known fact and says nothing new.
      console.warn(`readSolanaBalances: unreadable account for mint ${mint}:`, e instanceof Error ? e.message : String(e));
      tokens[mint] = {kind: 'error', failure: 'unreadable'};
    }
  });
  return {sol, tokens};
}

/** The SOL history read's honest states — the same discriminated-union contract `readSolanaBalances`
 *  established (R3, spec 2026-09-09 §"What the app says…"): 'offline' is the rail being OFF (not an
 *  error — the jest/e2e default), 'history' is a read fact, and 'error' carries WHY the read
 *  produced no fact (`SolanaReadFailure`, classified HERE at the seam — never guessed at the
 *  component). Happy-path rows/dropped keep `SolanaHistory`'s exact shape. */
export type SolanaHistoryResult =
  | {kind: 'offline'}
  | {kind: 'history'; rows: readonly SolanaHistoryRow[]; dropped: number}
  | {kind: 'error'; failure: SolanaReadFailure};

/** Recent SOL + USDC movements for `address`, newest-first (the SOL rail's half of the Transactions
 *  list). Answers `{kind:'offline'}` (no throw, no network, no dynamic import) when SOL is offline
 *  (`solanaRpcUrl()` empty) — the SAME offline contract as `readSolanaBalances`, so the offline
 *  inner loop never reaches the network module. A configured-but-failing read answers
 *  `{kind:'error', failure}` instead of throwing raw: the caller keeps the last known list and can
 *  mark it stale, so a stale ledger never renders as current indefinitely. An ABORTED signal is the
 *  one exception — it rethrows untouched (a caller's cancellation is not a rail fact).
 *  Individually unreadable transactions are logged and counted in `dropped`. */
export async function getSolanaHistory(address: string, signal?: AbortSignal): Promise<SolanaHistoryResult> {
  if (!solanaRpcUrl()) return {kind: 'offline'};
  const {fetchSolanaHistory} = await import('./solana/history');
  try {
    const history: SolanaHistory = await fetchSolanaHistory(solanaRpcUrls(), address, {signal});
    return {kind: 'history', rows: history.rows, dropped: history.dropped};
  } catch (e) {
    // An aborted read is the CALLER's cancellation, not a rail fact — it must survive this seam
    // untouched so the poll that cancelled can retry without inheriting a phantom failure state.
    if (signal?.aborted) throw e;
    // Same classification order as `readSolanaBalances`: the relay-path brand first (maps
    // straight to 'unreachable' — the relay answered, so the phone is online; no probe), then
    // the refusal brand (the endpoint ANSWERED and did not serve us), then the offline/
    // unreachable oracle for everything else.
    const failure: SolanaReadFailure = isRelayPathDown(e)
      ? 'unreachable'
      : isEndpointRefusal(e)
        ? 'refused'
        : await classifyTransportFailure();
    console.warn(`getSolanaHistory: ${failure} for ${address}:`, e instanceof Error ? e.message : String(e));
    return {kind: 'error', failure};
  }
}

/** Build, sign, broadcast, and confirm a System Program Transfer of `lamports` to `toAddress`.
 *  Signs LOCALLY with the device-derived key (no relay, no DpayCore — non-custodial). Throws if SOL
 *  is offline, on a network/RPC error, or if the transaction fails on-chain. Returns the signature.
 *
 *  `onBroadcast` fires the moment the network ACCEPTS the transaction, before confirmation — i.e.
 *  the first instant at which a throw can no longer mean "nothing happened". A throw after it may
 *  be a confirmation timeout over a transfer that lands seconds later, so a caller that must tell
 *  "definitely not sent" from "unknown" (the OpenCryptoPay report is one-shot and irreversible —
 *  `services/opencryptopay.ts`) needs the signature to survive the failure. Callers that treat any
 *  throw as a failed send simply omit it. */
export async function sendSol(
  secretHex: string,
  toAddress: string,
  lamports: bigint,
  signal?: AbortSignal,
  onBroadcast?: (signature: string) => void,
): Promise<string> {
  if (!solanaRpcUrl()) throw new Error(M.errors.solana.offline);
  return abortable((async () => {
    let step = 'module-load';
    // Step-ENTRY tracing: a STALL never reaches the catch below (the abortable deadline rejects
    // the OUTER promise), so the last traced line is the only witness to which await hung —
    // exactly the diagnostic the three 2026-09-21 live sends could not produce.
    const at = (s: string) => { step = s; traceSend(`step ${s}`); };
    traceSend(`SOL start to=${toAddress} amount=${lamports}`);
    try {
      const {seed, publicKey} = deriveSolanaKeypair(secretHex);
      const {getLatestBlockhash, sendTransaction, confirmTransaction} = await loadRpcForSend();
      const signature = await broadcastSignedWithFreshBlockhash(
        {getLatestBlockhash, sendTransaction}, signal, at,
        (bh) => buildSignedTransfer(seed, publicKey, toAddress, lamports, base58Decode32(bh)),
      );
      traceSend(`BROADCAST accepted sig=${signature}`);
      onBroadcast?.(signature);
      at('confirm');
      await confirmTransaction(solanaRpcUrls(), signature, {signal});
      traceSend(`confirmed sig=${signature}`);
      return signature;
    } catch (e: unknown) {
      traceSend(`FAILED at step=${step}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  })(), signal, 'sol send');
}

/** The chain's own verdict on a signature this device already broadcast — null when the cluster has
 *  never heard of it. History-aware (`searchTransactionHistory:true`), so a transaction that landed
 *  while the app was not looking is still observable after it drops out of the recent-status cache.
 *
 *  It exists for the one caller that must resolve a transfer AFTER `sendSol` threw: the
 *  OpenCryptoPay report is one-shot and irreversible, so a broadcast whose confirmation failed is
 *  the payer's only claim on the money and its verdict has to be readable again later
 *  (`SolPayMode`, findings doc "The loss path"). Reading is safe to repeat — nothing here signs or
 *  moves anything.
 *
 *  Throws when the rail is offline, exactly like `sendSol`: a signature can only exist because a
 *  broadcast succeeded, so an RPC that has since gone missing is a state the caller must see and
 *  retry, never one to answer with a silent "not found" (which reads as "it never landed"). */
export async function getSolSignatureStatus(
  signature: string,
  signal?: AbortSignal,
): Promise<SolanaSignatureStatus | null> {
  if (!solanaRpcUrl()) throw new Error(M.errors.solana.offline);
  const {getSignatureStatusesForSig} = await loadRpcForSend();
  const {status} = await getSignatureStatusesForSig(solanaRpcUrls(), signature, {signal});
  return status;
}

// ---------------------------------------------------------------------------
// Convert seams (solana_amm venues — Jupiter, 2026-09-15). The submission path is EXACTLY the
// SOL payment rail's: `sendTransaction` over `solanaBroadcastRpcUrls()` (the relay's pure RPC
// proxy homes — an allowlisted read cache around a verbatim pipe, `solana.rs` — plus the
// public mainnet failover tail, the attempt-#6 fix). These functions
// never sign anything — the signed bytes arrive from the convert record (the device signed
// them against the venue's UNSIGNED tx before the record was written) — and they never invent
// a verdict: the chain's own status/token-balance replies are the only inputs.
// ---------------------------------------------------------------------------

/** Submit ALREADY-SIGNED raw transaction bytes through the same RPC path SOL payments use.
 *  Returns the node's signature (base58). Throws on refusal/transport failure — a refusal here
 *  is definitive-unless-proven-otherwise: Solana preflight rejections are instruction errors,
 *  but a timeout is NOT a refusal (the caller's recovery path re-reads the status, never
 *  re-signs, and resubmits only the IDENTICAL bytes, which the chain dedups by signature).
 *  ATTEMPT-#6: the broadcast walks `solanaBroadcastRpcUrls()` — the attempt-6 live refusal was
 *  THIS path (the EURC→ICP deposit hand-off): the Helius head refused the same valid signed
 *  bytes 8/8 on preflight state while the public tail accepted them on replay. The walk now
 *  re-sends the identical bytes to the tail on exactly that refusal — no re-sign anywhere. */
export async function submitRawSolTx(raw: Uint8Array, signal?: AbortSignal): Promise<string> {
  if (!solanaRpcUrl()) throw new Error(M.errors.solana.offline);
  const {sendTransaction} = await loadRpcForSend();
  let step = 'broadcast';
  try {
    const sig = await sendTransaction(solanaBroadcastRpcUrls(), raw, {signal});
    traceSend(`raw submit (convert) BROADCAST accepted sig=${sig}`);
    return sig;
  } catch (e: unknown) {
    traceSend(`raw submit (convert) FAILED at step=${step}: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

/** The chain's current height — the death clock for a swap tx's recent-blockhash. */
export async function getSolBlockHeight(signal?: AbortSignal): Promise<number> {
  if (!solanaRpcUrl()) throw new Error(M.errors.solana.offline);
  const {getBlockHeight} = await import('./solana/rpc');
  return getBlockHeight(solanaRpcUrls(), {signal});
}

/** The realized lamport fee of an already-built (unsigned) message, for honest pre-sign
 *  disclosure. Null when the RPC cannot compute it — the caller displays nothing rather than
 *  an invented figure. */
export async function quoteSolMessageFee(
  message: Uint8Array,
  signal?: AbortSignal,
): Promise<bigint | null> {
  if (!solanaRpcUrl()) throw new Error(M.errors.solana.offline);
  const {getFeeForMessage} = await import('./solana/rpc');
  const {bytesToBase64} = await import('./lib/base64');
  return getFeeForMessage(solanaRpcUrls(), bytesToBase64(message), {signal});
}

/**
 * The user's realized token delta from a CONFIRMED transaction: (post − pre) of the token
 * balance for `mint` whose owner is `ownerAddress`. Null when the tx detail is unreadable or
 * carries no such balance movement — the caller then falls back to the quote's floor instead
 * of claiming the estimate as fact. Pure over the rpc reply; never throws across the boundary.
 */
export async function getSolTokenCredit(
  signature: string,
  ownerAddress: string,
  mint: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!solanaRpcUrl()) throw new Error(M.errors.solana.offline);
  const {getTransaction} = await import('./solana/rpc');
  let detail;
  try {
    detail = await getTransaction(solanaRpcUrls(), signature, {signal});
  } catch {
    return null;
  }
  const meta = detail?.meta;
  if (meta == null) return null;
  const keys = detail?.transaction?.message?.accountKeys;
  if (!Array.isArray(keys)) return null;
  const balanceOf = (
    list: readonly {accountIndex: number; mint: string; owner?: string}[] | undefined,
  ): bigint | null => {
    if (!Array.isArray(list)) return null;
    for (const b of list) {
      if (
        typeof b.accountIndex === 'number' &&
        b.mint === mint &&
        b.owner === ownerAddress &&
        b.accountIndex < keys.length
      ) {
        const amt = (b as {uiTokenAmount?: {amount?: unknown}}).uiTokenAmount?.amount;
        if (typeof amt !== 'string' || !/^\d+$/.test(amt)) return null;
        return BigInt(amt);
      }
    }
    return null;
  };
  const pre = balanceOf(meta.preTokenBalances);
  const post = balanceOf(meta.postTokenBalances);
  if (post == null) return null;
  if (pre == null) return post.toString(10);
  const delta = post - pre;
  return delta < 0n ? null : delta.toString(10);
}

/**
 * The user's realized NATIVE-SOL delta from a CONFIRMED transaction they paid for (post − pre
 * of the fee payer's lamports — for a swap that unwraps to SOL this is payout MINUS the network
 * fee, which is the honest realized figure, not the quote). Null when unreadable. The SOL-out
 * analog of `getSolTokenCredit`; never throws across the boundary.
 */
export async function getSolNativeCredit(
  signature: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!solanaRpcUrl()) throw new Error(M.errors.solana.offline);
  const {getTransaction} = await import('./solana/rpc');
  let detail;
  try {
    detail = await getTransaction(solanaRpcUrls(), signature, {signal});
  } catch {
    return null;
  }
  const meta = detail?.meta;
  if (meta == null) return null;
  const keys = detail?.transaction?.message?.accountKeys;
  if (!Array.isArray(keys) || keys.length < 1) return null;
  // Account 0 is the fee payer — the user, on every tx this wallet signs.
  const pre = meta.preBalances[0];
  const post = meta.postBalances[0];
  if (typeof pre !== 'number' || typeof post !== 'number') return null;
  const delta = BigInt(post) - BigInt(pre);
  return delta < 0n ? null : delta.toString(10);
}

/** Phase 6 — Build, sign, broadcast, and confirm an SPL Token `transfer` of `amount` raw units of
 *  the registry token `mint` (at its `decimals`) to `destAddress`. The recipient is a base58 Solana
 *  WALLET address (the same shape SOL send takes); the recipient's Associated Token Account for the
 *  mint is DERIVED from it. Signs LOCALLY with the device-derived key (non-custodial — same shape
 *  as sendSol).
 *
 *  FAIL-CLOSED sender check: the device's source ATA must exist on-chain (you cannot send tokens
 *  you don't hold an account for — the error names the sender, the first check).
 *
 *  RECIPIENT AUTO-CREATE (2026-08-14 founder-approved): if the recipient's ATA is missing, the SAME
 *  transaction carries an AssociatedTokenProgram.createIdempotent instruction BEFORE the transfer —
 *  the sender pays the recipient's one-time account rent (≈0.002 SOL, disclosed on the review
 *  screen). createIdempotent is a no-op when the ATA exists, so a TOCTOU race (created between
 *  check + submit) is harmless. This is a real on-chain instruction in the real signed tx — nothing
 *  simulated, nothing hidden.
 *
 *  Throws if SOL is offline, if the sender ATA is missing, on a network/RPC error, or if the
 *  on-chain tx fails. Returns the signature. Reuses the byte-exact `buildSplTransferInstruction` +
 *  `buildCreateAtaIdempotentInstruction` (proven in solana-spl.test.ts).
 *
 *  `onBroadcast` + the deadline guarantee mirror `sendSol` exactly: the signature is handed to
 *  `onBroadcast` the instant the network accepts (before confirming), and the promise settles the
 *  moment `signal` aborts even if a lower layer ignores it — so a caller can always tell
 *  "definitely not sent" from "unknown" and never spins past its own deadline. */
export async function sendSpl(
  secretHex: string,
  destAddress: string,
  amount: bigint,
  mint: string,
  signal?: AbortSignal,
  onBroadcast?: (signature: string) => void,
): Promise<string> {
  if (!solanaRpcUrl()) throw new Error(M.errors.solana.offline);
  return abortable((async () => {
    let step = 'module-load';
    // Step-ENTRY tracing (see sendSol): the last traced line names a stalled await.
    const at = (s: string) => { step = s; traceSend(`step ${s}`); };
    traceSend(`SPL(${solanaTokenOfMint(mint) ?? mint}) start to=${destAddress} amount=${amount}`);
    try {
      const token = solanaTokenOfMint(mint);
      const {seed, publicKey} = deriveSolanaKeypair(secretHex);
      const senderAddress = bs58.encode(publicKey);
      const senderAta = deriveAta(senderAddress, mint);
      const recipientAta = deriveAta(destAddress, mint);
      const {accountExists, getBalance, getLatestBlockhash, sendTransaction, confirmTransaction} = await loadRpcForSend();

      // Sender ATA first — the device must hold the token account to debit from (fail-closed).
      at('sender-ata-check');
      if (!(await accountExists(solanaRpcUrls(), bs58.encode(senderAta), {signal}))) {
        throw new Error(M.errors.solana.senderNoTokenAccount(token ?? mint));
      }
      // Recipient ATA — if missing, create it in the same tx (sender pays the one-time rent, disclosed
      // upstream on the review screen; idempotent so a race with another creator is harmless).
      at('recipient-ata-check');
      const ixs: Instruction[] = [];
      if (!(await accountExists(solanaRpcUrls(), bs58.encode(recipientAta), {signal}))) {
        traceSend('recipient ATA missing — createIdempotent joins the tx');
        // Honest cost pre-check (mirrors createTokenAta): without it the send passes review and dies at
        // broadcast with a raw "custom program error: 0x1" that no friendlySolError pattern matches.
        at('sender-balance-check');
        const lamports = await getBalance(solanaRpcUrls(), senderAddress, {signal});
        if (BigInt(lamports) < SOL_ATA_SETUP_MIN_LAMPORTS) {
          throw new Error(M.errors.solana.recipientNoTokenAccount(fmtAssetCompact(String(SOL_ATA_SETUP_MIN_LAMPORTS), SOL_DECIMALS, SOL_UNIT), token ?? mint));
        }
        ixs.push(buildCreateAtaIdempotentInstruction(publicKey, recipientAta, base58Decode32(destAddress), base58Decode32(mint)));
      }
      ixs.push(buildSplTransferInstruction(senderAta, recipientAta, publicKey, amount));

      // Broadcast through the one helper: it fetches the blockhash, signs with THAT exact value,
      // and owns the diagnosed blockhash-refresh-retry (the tracer reads blockhash → sign →
      // broadcast — the pre-2026-09-21 labels read sign → blockhash, a mislabel that made the
      // first clean live failure LOOK like a stale-hash send).
      const signature = await broadcastSignedWithFreshBlockhash(
        {getLatestBlockhash, sendTransaction}, signal, at,
        (bh) => signTransaction(assembleMessage(publicKey, ixs, base58Decode32(bh)), seed),
      );
      traceSend(`BROADCAST accepted sig=${signature}`);
      onBroadcast?.(signature);
      at('confirm');
      await confirmTransaction(solanaRpcUrls(), signature, {signal});
      traceSend(`confirmed sig=${signature}`);
      return signature;
    } catch (e: unknown) {
      traceSend(`FAILED at step=${step}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  })(), signal, 'spl send');
}

/** What a Solana Pay transfer carries beyond a plain send (see sendSolanaPay). `amount` is RAW
 *  integer units at the asset's decimals (lamports for SOL, 6-decimal base units for USDC) — the
 *  caller parsed the URI's decimal string at review time; `references` are the scanned URI's
 *  base58 reference pubkeys (possibly empty — the spec makes the param optional); `memo` is the
 *  SPL Memo program's on-chain text (null when the URI carried none). */
export type SolanaPayTransfer = {
  recipient: string;
  splToken: string | null;
  amount: bigint;
  references: string[];
  memo: string | null;
};

/** Build, sign, broadcast, and confirm a scanned Solana Pay request (`solana:<recipient>?…`, the
 *  open standard this wallet's own receive QR emits — `solana/payments.ts` is the format's home).
 *  Signs LOCALLY with the device-derived key, exactly like sendSol/sendSpl — non-custodial; dpay
 *  never holds keys or funds, and paying another wallet's standard never becomes a swap.
 *
 *  What makes it a Solana Pay transfer rather than a plain send:
 *    • `reference` — the merchant's matching mechanism. Each reference pubkey is attached to the
 *      transfer instruction as an additional READONLY non-signing account key (the System/Token
 *      programs ignore it; the merchant finds the payment by the key). NOT a memo — the spec's
 *      matching story is account keys, full stop.
 *    • `memo` — the SPL Memo program's text, as its OWN instruction before the transfer (per
 *      spec ordering) when the URI carried one.
 *    • `spl-token` — the URI recipient is the wallet OWNER; the transfer target is the derived
 *      Associated Token Account for (owner, mint), auto-created idempotently when missing with
 *      the same rent pre-check + disclosure sendSpl has. SOL path uses a System transfer, the
 *      USDC path uses `transferChecked` (commits mint + decimals, the solana-pay SDK's choice).
 *
 *  Supports exactly the mints the token registry supports (`solana/tokens.ts` — USDC + EURC
 *  mainnet) — anything else is refused by name at the scan surface AND here, so reaching this seam
 *  with a foreign mint is a wiring error and is thrown as such (the error NAMES the mint pubkey).
 *  `onBroadcast` carries the same "accepted, pre-confirmation" contract as sendSol. Throws
 *  offline / on RPC error / on-chain failure; returns the signature. */
export async function sendSolanaPay(
  secretHex: string,
  transfer: SolanaPayTransfer,
  signal?: AbortSignal,
  onBroadcast?: (signature: string) => void,
): Promise<string> {
  if (!solanaRpcUrl()) throw new Error(M.errors.solana.offline);
  if (transfer.splToken !== null) {
    const token = solanaTokenOfMint(transfer.splToken);
    if (token === null) {
      throw new Error(`unsupported spl-token mint for Solana Pay: ${transfer.splToken}`);
    }
  }
  const {seed, publicKey} = deriveSolanaKeypair(secretHex);
  const {accountExists, getBalance, getLatestBlockhash, sendTransaction, confirmTransaction} = await loadRpcForSend();
  let step = 'build';
  // Step-ENTRY tracing (see sendSol): the last traced line names a stalled await.
  const at = (s: string) => { step = s; traceSend(`step ${s}`); };
  traceSend(`solana-pay(${transfer.splToken === null ? 'SOL' : solanaTokenOfMint(transfer.splToken) ?? transfer.splToken}) start to=${transfer.recipient} amount=${transfer.amount}`);
  try {
    return await abortable((async () => {
      const referenceKeys = transfer.references.map(base58Decode32);
      const ixs: Instruction[] = [];
      if (transfer.memo !== null) ixs.push(buildMemoInstruction(utf8ToBytes(transfer.memo)));
      if (transfer.splToken === null) {
        ixs.push(buildSolTransferInstruction(publicKey, base58Decode32(transfer.recipient), transfer.amount, referenceKeys));
      } else {
        const senderAddress = bs58.encode(publicKey);
        const senderAta = deriveAta(senderAddress, transfer.splToken);
        const recipientAta = deriveAta(transfer.recipient, transfer.splToken);
        const token = solanaTokenOfMint(transfer.splToken) ?? transfer.splToken;
        // Sender ATA first — the device must hold the token account to debit from (fail-closed, same
        // as sendSpl).
        at('sender-ata-check');
        if (!(await accountExists(solanaRpcUrls(), bs58.encode(senderAta), {signal}))) {
          throw new Error(M.errors.solana.senderNoTokenAccount(token));
        }
        at('recipient-ata-check');
        if (!(await accountExists(solanaRpcUrls(), bs58.encode(recipientAta), {signal}))) {
          // Same honest cost pre-check as sendSpl: without it the payment passes review and dies at
          // broadcast with a raw program error no friendlySolError pattern matches.
          at('sender-balance-check');
          const lamports = await getBalance(solanaRpcUrls(), senderAddress, {signal});
          if (BigInt(lamports) < SOL_ATA_SETUP_MIN_LAMPORTS) {
            throw new Error(M.errors.solana.recipientNoTokenAccount(fmtAssetCompact(String(SOL_ATA_SETUP_MIN_LAMPORTS), SOL_DECIMALS, SOL_UNIT), token));
          }
          ixs.push(buildCreateAtaIdempotentInstruction(publicKey, recipientAta, base58Decode32(transfer.recipient), base58Decode32(transfer.splToken)));
        }
        // The registry's decimals for this mint — transferChecked commits to mint + decimals, so a
        // foreign/wrong decimals can never satisfy the payment.
        const decimals = solanaTokenInfo(solanaTokenOfMint(transfer.splToken) ?? '')?.decimals;
        if (decimals == null) throw new Error(`unsupported spl-token mint for Solana Pay: ${transfer.splToken}`);
        ixs.push(buildTransferCheckedInstruction(senderAta, base58Decode32(transfer.splToken), recipientAta, publicKey, transfer.amount, decimals, referenceKeys));
      }

      const signature = await broadcastSignedWithFreshBlockhash(
        {getLatestBlockhash, sendTransaction}, signal, at,
        (bh) => signTransaction(assembleMessage(publicKey, ixs, base58Decode32(bh)), seed),
      );
      traceSend(`BROADCAST accepted sig=${signature}`);
      onBroadcast?.(signature);
      at('confirm');
      await confirmTransaction(solanaRpcUrls(), signature, {signal});
      traceSend(`confirmed sig=${signature}`);
      return signature;
    })(), signal, 'solana pay send');
  } catch (e: unknown) {
    traceSend(`FAILED at step=${step}: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

/** One-time token account (ATA) setup for THIS device's wallet — the receiver-side onboarding for
 *  a registered Solana SPL token (2026-08-14; generalized per-mint 2026-09-06). Builds, signs
 *  LOCALLY (device key), broadcasts, and confirms a single AssociatedTokenProgram.createIdempotent
 *  instruction (payer = owner = the device key, mint = `mint`). Non-custodial: the device key
 *  signs; dpay never holds keys or funds.
 *
 *  Honest cost: the one-time account rent + transaction fee come out of the device's SOL balance.
 *  Pre-checked with a friendly error when the balance can't cover the ESTIMATE (the chain enforces
 *  the real value — the constant is display/pre-check only, never trust-bearing). Throws when SOL
 *  is offline, when the rail is incoherent (mainnet mint on a non-mainnet RPC), on insufficient
 *  SOL, or on any RPC/on-chain failure. Returns the transaction signature. */
export async function createTokenAta(secretHex: string, mint: string, signal?: AbortSignal): Promise<string> {
  const token = solanaTokenOfMint(mint);
  if (!solanaRpcUrl() || !solanaTokenAvailable(mint)) throw new Error(M.errors.solana.tokenUnavailable(token ?? mint));
  const {seed, publicKey} = deriveSolanaKeypair(secretHex);
  const ownerAddress = bs58.encode(publicKey);
  const ata = deriveAta(ownerAddress, mint);
  const {getBalance, getLatestBlockhash, sendTransaction, confirmTransaction} = await loadRpcForSend();

  let step = 'balance-check';
  try {
    const lamports = await getBalance(solanaRpcUrls(), ownerAddress, {signal});
    if (BigInt(lamports) < SOL_ATA_SETUP_MIN_LAMPORTS) {
      throw new Error(M.errors.solana.ownTokenAccountRent(fmtAssetCompact(String(SOL_ATA_SETUP_MIN_LAMPORTS), SOL_DECIMALS, SOL_UNIT), token ?? mint));
    }

    const ix = buildCreateAtaIdempotentInstruction(publicKey, ata, publicKey, base58Decode32(mint));
    return await abortable((async () => {
      // Same step tracing as the send paths (the ATA setup is a money path too — one broadcast
      // seam, one tracer dialect).
      const at = (s: string) => { step = s; traceSend(`step ${s}`); };
      const signature = await broadcastSignedWithFreshBlockhash(
        {getLatestBlockhash, sendTransaction}, signal, at,
        (bh) => signTransaction(assembleMessage(publicKey, [ix], base58Decode32(bh)), seed),
      );
      traceSend(`ATA setup BROADCAST accepted sig=${signature}`);
      at('confirm');
      await confirmTransaction(solanaRpcUrls(), signature, {signal});
      traceSend(`ATA setup confirmed sig=${signature}`);
      return signature;
    })(), signal, 'ata setup');
  } catch (e: unknown) {
    traceSend(`ATA setup FAILED at step=${step}: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

// --- existing exports (unchanged) ----------------------------------------------

/** Whether the Solana RPC rail is configured (RPC URL non-empty). A pure sync read of the constant —
 *  independent of relay `online` (plan invariant #9 — the relay could be reachable while SOL RPC is
 *  not, or vice versa). The token-coherence sense (a mainnet mint pointed at a non-mainnet RPC) is
 *  the separate `solanaTokenAvailable(mint)` predicate. */
export function isSolanaRpcAvailable(): boolean {
  return solanaRpcUrl() !== '';
}

// ============================================================================
// v2 recent-blockhash payment seam — the ONLY Solana payment path (the durable-nonce rail was
// deleted). The lifecycle:
//   createSolPaymentRequest — ONLINE merchant fetches genesis hash + fresh blockhash + builds SolReqV2.
//   signSolPayment / signSplPayment — OFFLINE payer signs the canonical message (no network).
//   broadcastSolPayment — ONLINE merchant strictly verifies, freshness-checks, broadcasts, confirms.
// See `2026-08-12-solana-recent-blockhash-rewrite-plan.md` "Freshness rules" + invariants #4/#5/#12/#13.
// ============================================================================

/** ONLINE merchant. Fetches the cluster genesis hash (cached) + a fresh blockhash (with its context
 *  slot), builds a `SolReqV2` with `iat = now` and `exp = iat + SOL_PAYMENT_MAX_WINDOW_SECONDS`, and
 *  encodes to the canonical `solreq:v2?<base64url>` URI.
 *
 *  Throws on RPC failure, genesis mismatch (wrong cluster — invariant #4 fail-closed), or when the
 *  rail is offline (`solanaRpcUrl()` empty). Never returns a silent empty result. */
export async function createSolPaymentRequest(
  input: {
    to: string;
    amt: string;
    cur: string;
    mint: string | null;
    toAta: string | null;
    name: string;
    memo: string;
  },
  signal: AbortSignal,
): Promise<{request: SolReqV2; uri: string}> {
  if (!isSolanaRpcAvailable()) throw new Error(M.errors.solana.offline);
  const rpc = await import('./solana/rpc');

  // Cluster identity check — fail-closed on a non-mainnet endpoint (genesis hash is immutable).
  const genesis = await rpc.getGenesisHash(solanaRpcUrls(), {signal});
  if (genesis !== SOL_GENESIS_HASH) {
    throw new Error(`createSolPaymentRequest: cluster genesis mismatch (got ${genesis}, expected ${SOL_GENESIS_HASH})`);
  }

  // Fresh blockhash + its observation slot. The context slot threads as `minContextSlot` for every
  // downstream freshness call in broadcastSolPayment so reorg-awareness is consistent.
  const bh = await rpc.getLatestBlockhash(solanaRpcUrls(), {signal});

  // iat captured when the RPC result is in hand; exp = iat + the codec's frozen max lifetime.
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + SOL_PAYMENT_MAX_WINDOW_SECONDS;

  const reqInput: SolReqInput = {
    rid: generateRid(),
    net: 'mainnet-beta',
    bh: bh.blockhash,
    lvh: bh.lastValidBlockHeight,
    slot: bh.contextSlot,
    iat,
    exp,
    to: input.to,
    amt: input.amt,
    cur: input.cur,
    mint: input.mint,
    toAta: input.toAta,
    name: input.name,
    memo: input.memo,
  };
  const uri = encodeSolReq(reqInput);
  const request: SolReqV2 = {v: 2, ...reqInput};
  return {request, uri};
}

/** OFFLINE payer (SOL). NO network. Derives the payer keypair from `secretHex`, builds the canonical
 *  SOL message (`{Memo, System.transfer}` bound to the request URI + amount), signs it, and returns
 *  the `SolPayV2 {v:2, rid, tx}`. Pure + synchronous. */
export function signSolPayment(secretHex: string, request: SolReqV2): SolPayV2 {
  if (request.cur !== 'SOL') throw new Error('signSolPayment: expected SOL currency');
  const {seed, publicKey} = deriveSolanaKeypair(secretHex);
  const message = buildCanonicalSolMessage(publicKey, request);
  const tx = signTransaction(message, seed);
  const payInput: SolPayInput = {rid: request.rid, tx};
  return {v: 2, ...payInput};
}

/** OFFLINE payer (any registered SPL token — USDC, EURC, …). NO network. Same as `signSolPayment`
 *  with the generic SPL canonical builder (`{Memo, Token.transferChecked}` — commits to the
 *  request mint + ITS registry decimals + ATAs). Dispatch is per token: the decimals come from
 *  the registry via the request's `cur`/`mint`, never from a hard-coded literal. */
export function signSplPayment(secretHex: string, request: SolReqV2): SolPayV2 {
  if (request.cur === 'SOL') throw new Error('signSplPayment: expected an SPL-token currency (not SOL)');
  if (!request.mint || !request.toAta) throw new Error('signSplPayment: mint and toAta required for an SPL token');
  const info = solanaTokenInfo(request.cur);
  const decimals = info?.mint === request.mint ? info.decimals : solanaTokenInfo(solanaTokenOfMint(request.mint) ?? '')?.decimals;
  if (decimals == null) throw new Error(`signSplPayment: unsupported spl-token (cur=${request.cur}, mint=${request.mint})`);
  const {seed, publicKey} = deriveSolanaKeypair(secretHex);
  const message = buildCanonicalSplMessage(publicKey, request, decimals);
  const tx = signTransaction(message, seed);
  const payInput: SolPayInput = {rid: request.rid, tx};
  return {v: 2, ...payInput};
}

/** ONLINE merchant broadcast + confirm. STRICT. Runs the canonical-message rebuild + Ed25519 verify
 *  BEFORE any network send, freshness-checks the blockhash + block height against the request, then
 *  broadcasts with preflight and confirms via history-aware signature status polling — and before
 *  answering SETTLED, re-reads the confirmed transaction and requires its body to BE the canonical
 *  message (settle-verify, OPEN_ISSUES 6(b): a signature confirming is not the same as THIS
 *  payment confirming).
 *
 *  Money-critical freshness state machine (invariants #4/#5/#10/#12/#13):
 *    • URI ≠ request          → throw (programming error, never silent).
 *    • Malformed payment      → REJECTED, sig='' (definitive — never broadcast).
 *    • Strict verify fails    → REJECTED, sig='' (sig/parse/semantic failure is BLOCKING).
 *    • Blockhash invalid OR
 *      height > lvh pre-send  → REJECTED, sig=<verified> (authoritative on-chain expiry).
 *    • sendTransaction RPC sig
 *      ≠ local verified sig   → UNREACHABLE, sig=<verified> (honest unknown — never assume success).
 *    • sendTransaction
 *      InstructionError/etc.  → REJECTED, sig=<verified> (definitive Solana rejection).
 *    • sendTransaction other
 *      error                  → UNREACHABLE, sig=<verified> (honest unknown — tx MAY still land).
 *    • Confirm: status w/err  → REJECTED, sig=<verified> (on-chain rejection).
 *    • Confirm: confirmed +
 *      re-read body verified  → SETTLED, sig=<verified> (recompiled body == canonical, err==null).
 *    • Confirm: confirmed +
 *      re-read body err≠null  → REJECTED, sig=<verified> (the chain's own failure record).
 *    • Confirm: confirmed +
 *      re-read body ≠
 *      canonical              → MISMATCH(3), sig=<verified> (terminal doubt — well-formed confirmed
 *                               body that isn't this request, incl. v0/ALT claims; merchant must
 *                               NOT treat it as received, payer gets honest pending, never a
 *                               decline).
 *    • Confirm: confirmed but
 *      body unreadable
 *      (null/malformed/trans-
 *      ient RPC)             → keep polling to the deadline (unverifiable is NEVER a verdict).
 *    • Confirm timeout +
 *      authoritative expiry
 *      (height>lvh AND bh
 *      invalid@ctx≥slot AND
 *      history status null
 *      @ctx≥invaliditySlot)   → REJECTED, sig=<verified> (the tx CANNOT land — blockhash dead).
 *    • Confirm timeout,
 *      anything else          → UNREACHABLE, sig=<verified> (honest unknown — invariant #12).
 *
 *  `opts.confirmTimeoutMs` / `opts.pollMs` default to `SOL_BROADCAST_TIMEOUT_MS` / 200ms; tests pass
 *  shorter values so the timeout branches are exercisable in milliseconds. */
export async function broadcastSolPayment(
  request: SolReqV2,
  canonicalRequestUri: string,
  payment: SolPayV2,
  signal: AbortSignal,
  opts?: {confirmTimeoutMs?: number; pollMs?: number},
): Promise<SolReceiptV2> {
  // 1. Defense: the canonical URI must match the request. A mismatch is a programming error (caller
  //    passed a stale/foreign URI for this request); throw rather than risk broadcasting under wrong
  //    claims. Strip `v` (the codec stamps it) before re-encoding.
  const {v: _dropV, ...reqInput} = request;
  void _dropV;
  if (encodeSolReq(reqInput) !== canonicalRequestUri) {
    throw new Error('broadcastSolPayment: canonicalRequestUri does not match request (programming error)');
  }
  const rid = request.rid;

  // 2. Extract the payer pubkey from the signed transaction. Malformed → definitive reject (no sig
  //    trusted, no broadcast).
  const parts = extractSignedTxParts(payment.tx);
  if (!parts) {
    console.warn(`broadcastSolPayment: malformed payment tx for rid=${rid}`);
    return {status: RECEIPT_REJECTED, rid, sig: ''};
  }

  // 3. Build the expected canonical message from the open request + extracted payer. Non-SOL
  //    requests carry a registry mint; the canonical builder commits to ITS registry decimals.
  let expectedMessage: Uint8Array;
  if (request.cur === 'SOL') {
    expectedMessage = buildCanonicalSolMessage(parts.feePayer, request);
  } else {
    const info = solanaTokenInfo(request.cur);
    const decimals = info?.mint === request.mint ? info.decimals : solanaTokenInfo(solanaTokenOfMint(request.mint ?? '') ?? '')?.decimals;
    if (decimals == null) throw new Error(`broadcastSolPayment: unsupported spl-token mint ${request.mint}`);
    expectedMessage = buildCanonicalSplMessage(parts.feePayer, request, decimals);
  }

  // 4. STRICT verify: signed message must be byte-equal to the canonical rebuild + Ed25519 valid.
  //    Failure is BLOCKING (invariant #5) — never broadcast a semantically wrong signature.
  const verifyResult = verifySolPayment(expectedMessage, payment);
  if (!verifyResult.ok) {
    console.warn(`broadcastSolPayment: strict verify failed (${verifyResult.reason}) for rid=${rid}`);
    return {status: RECEIPT_REJECTED, rid, sig: ''};
  }

  // 5. The verified first signature is the stable payment identity for the receipt (invariant #10:
  //    the same signed bytes can be rebroadcast idempotently). Used for all downstream receipt codes.
  const sig = verifyResult.signature;

  if (!isSolanaRpcAvailable()) throw new Error(M.errors.solana.offline);
  const rpc = await import('./solana/rpc');

  // 6. Freshness pre-broadcast (invariant #4). The request's `slot` is `minContextSlot` so reorg-aware
  //    behavior is consistent. Blockhash invalid OR current height past lvh → authoritative on-chain
  //    expiry → definitive reject (not unreachable — the tx cannot land).
  let bhValid: {valid: boolean; contextSlot: number};
  let currentHeight: number;
  try {
    [bhValid, currentHeight] = await Promise.all([
      rpc.isBlockhashValid(solanaRpcUrls(), request.bh, {signal, minContextSlot: request.slot}),
      rpc.getBlockHeight(solanaRpcUrls(), {signal, minContextSlot: request.slot}),
    ]);
  } catch (e) {
    // A freshness-check RPC failure is NOT an authoritative reject — the RPC is unavailable, not the
    // blockhash. Honest unknown (the tx MAY still be broadcastable on retry).
    console.warn(`broadcastSolPayment: freshness RPC failure for rid=${rid}:`, e instanceof Error ? e.message : String(e));
    return {status: RECEIPT_UNREACHABLE, rid, sig};
  }
  if (!bhValid.valid || currentHeight > request.lvh) {
    console.warn(`broadcastSolPayment: pre-broadcast expiry (bhValid=${bhValid.valid}, height=${currentHeight}, lvh=${request.lvh}) for rid=${rid}`);
    return {status: RECEIPT_REJECTED, rid, sig};
  }

  // 7. Broadcast with preflight (skipPreflight:false) + the request's minContextSlot. The RPC-returned
  //    signature MUST exactly equal the locally-extracted `sig` — a mismatch means the node accepted a
  //    DIFFERENT transaction than the one we verified (honest unknown; do NOT assume success).
  let broadcastSig: string;
  try {
    broadcastSig = await rpc.sendTransaction(solanaBroadcastRpcUrls(), payment.tx, {
      signal,
      minContextSlot: request.slot,
      config: {commitment: SOL_PAYMENT_COMMITMENT, minContextSlot: request.slot, skipPreflight: false},
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    console.warn(`broadcastSolPayment: sendTransaction error for rid=${rid}: ${msg}`);
    // "…already…" is NOT a rejection — it is the cross-home resubmit's echo (R2): home A may have
    // ACCEPTED the identical bytes before dying transport-dead, and home B's "Transaction already
    // processed/known" answer means the cluster knows this signature — exactly what a transaction
    // that may be ON CHAIN looks like from the next home's seat. The signature status is the
    // authority, so we proceed to the confirm loop with the locally VERIFIED `sig` exactly as a
    // successful broadcast would; confirmation settles SETTLED / REJECTED-authoritatively (a
    // blockhash that "already expired" re-derives the same verdict there via the expiry gates).
    if (/already/i.test(msg)) {
      broadcastSig = sig;
    } else if (/Instruction|insufficient|no record of a prior credit|simulation failed|debit|custom|blockhash|nonce/i.test(msg)) {
      // A class of error that's a definitive Solana rejection (the tx was definitively NOT accepted).
      return {status: RECEIPT_REJECTED, rid, sig};
    } else {
      return {status: RECEIPT_UNREACHABLE, rid, sig};
    }
  }
  if (broadcastSig !== sig) {
    console.warn(`broadcastSolPayment: sig identity mismatch (broadcast=${broadcastSig}, local=${sig}) for rid=${rid}`);
    return {status: RECEIPT_UNREACHABLE, rid, sig};
  }

  // 8. Confirm via history-aware signature status polling + block-height observation. Each RPC call is
  //    try/caught — a transient failure during confirm continues polling up to the timeout; only the
  //    timeout boundary triggers the authoritative-expiry decision (invariant #12).
  const deadline = Date.now() + (opts?.confirmTimeoutMs ?? SOL_BROADCAST_TIMEOUT_MS);
  const pollMs = opts?.pollMs ?? 200;
  let latestHeight: number | null = null;
  let latestHistoryStatus: {status: SolanaSignatureStatus | null; contextSlot: number} | null = null;

  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('aborted');

    try {
      const statusResult = await rpc.getSignatureStatusesForSig(solanaRpcUrls(), sig, {signal});
      latestHistoryStatus = statusResult;
      if (statusResult.status) {
        if (statusResult.status.err != null) {
          console.warn(`broadcastSolPayment: on-chain rejection for rid=${rid}: ${JSON.stringify(statusResult.status.err)}`);
          return {status: RECEIPT_REJECTED, rid, sig};
        }
        if (statusResult.status.confirmationStatus === 'confirmed' || statusResult.status.confirmationStatus === 'finalized') {
          // Confirmed alone is NOT settled (OPEN_ISSUES 6(b)): the signature says some transaction
          // with this id confirmed — the re-read must prove the confirmed body IS the canonical
          // message this merchant verified before broadcasting. No new budget: this rides the same
          // confirm deadline; every failure of the re-read keeps polling (unverifiable is NEVER a
          // verdict — three-verdict discipline, see services/rail.ts).
          let detail: SolanaTransactionDetail | null = null;
          let detailRead = false;
          try {
            detail = await rpc.getTransaction(solanaRpcUrls(), sig, {signal});
            detailRead = true;
          } catch (e) {
            console.warn(`broadcastSolPayment: transient getTransaction failure for rid=${rid}:`, e instanceof Error ? e.message : String(e));
          }
          if (detailRead) {
            const evidence = verifySettledTransaction(expectedMessage, detail);
            if (evidence.kind === 'verified') {
              return {status: RECEIPT_SETTLED, rid, sig};
            }
            if (evidence.kind === 'onchain-error') {
              console.warn(`broadcastSolPayment: on-chain error record for rid=${rid}`);
              return {status: RECEIPT_REJECTED, rid, sig};
            }
            if (evidence.kind === 'mismatch') {
              // TERMINAL doubt — the signature confirms a DIFFERENT well-formed transaction. The
              // merchant must not treat it as received; the payer hears honest pending (code 3).
              console.warn(`broadcastSolPayment: settle-verify mismatch for rid=${rid}: ${evidence.reason}`);
              return {status: RECEIPT_MISMATCH, rid, sig};
            }
            console.warn(`broadcastSolPayment: settle-verify unverifiable for rid=${rid}: ${evidence.reason}`);
          }
        }
      }
    } catch (e) {
      console.warn(`broadcastSolPayment: transient getSignatureStatuses failure for rid=${rid}:`, e instanceof Error ? e.message : String(e));
    }

    try {
      latestHeight = await rpc.getBlockHeight(solanaRpcUrls(), {signal, minContextSlot: request.slot});
    } catch (e) {
      console.warn(`broadcastSolPayment: transient getBlockHeight failure for rid=${rid}:`, e instanceof Error ? e.message : String(e));
    }

    await new Promise(r => setTimeout(r, pollMs));
  }

  // Timeout — determine AUTHORITATIVE expiry (invariants #12/#13 + "Record the context slot" rule).
  // Authoritative-expiry requires ALL THREE:
  //   (a) currentHeight > request.lvh (blockhash window passed), AND
  //   (b) isBlockhashValid returns false at contextSlot >= request.slot (reorg-safe observation), AND
  //   (c) history-aware signature status is null at contextSlot >= invalidityContextSlot (proves the
  //       tx never landed — observed AFTER the blockhash was demonstrably dead).
  // The isBlockhashValid + getSignatureStatuses calls are done in that order so the sig-status context
  // is >= the invalidity context. Anything inconsistent/unavailable → honest unknown (UNREACHABLE).
  const heightExpired = latestHeight !== null && latestHeight > request.lvh;

  let invalidityContextSlot = 0;
  try {
    const bhv = await rpc.isBlockhashValid(solanaRpcUrls(), request.bh, {signal, minContextSlot: request.slot});
    if (!bhv.valid && bhv.contextSlot >= request.slot) {
      invalidityContextSlot = bhv.contextSlot;
    }
  } catch (e) {
    console.warn(`broadcastSolPayment: timeout isBlockhashValid failure for rid=${rid}:`, e instanceof Error ? e.message : String(e));
  }

  let historyProvesAbsent = false;
  try {
    const statusResult = await rpc.getSignatureStatusesForSig(solanaRpcUrls(), sig, {signal});
    latestHistoryStatus = statusResult;
    if (
      invalidityContextSlot >= request.slot &&
      statusResult.status === null &&
      statusResult.contextSlot >= invalidityContextSlot
    ) {
      historyProvesAbsent = true;
    }
  } catch (e) {
    console.warn(`broadcastSolPayment: timeout getSignatureStatuses failure for rid=${rid}:`, e instanceof Error ? e.message : String(e));
  }

  if (heightExpired && invalidityContextSlot >= request.slot && historyProvesAbsent) {
    console.warn(`broadcastSolPayment: authoritative expiry for rid=${rid} (height=${latestHeight}, lvh=${request.lvh}, invaliditySlot=${invalidityContextSlot})`);
    return {status: RECEIPT_REJECTED, rid, sig};
  }
  console.warn(`broadcastSolPayment: honest unknown for rid=${rid} (height=${latestHeight}, lvh=${request.lvh}, invaliditySlot=${invalidityContextSlot}, historyPresent=${latestHistoryStatus?.status != null})`);
  return {status: RECEIPT_UNREACHABLE, rid, sig};
}
