import AsyncStorage from '@react-native-async-storage/async-storage';
import type {SolReqV2} from '../solana/qr';

// Merchant-side durable request state for the v2 recent-blockhash SOL payment path (invariants #10,
// #11, #12 of 2026-08-12-solana-recent-blockhash-rewrite-plan.md).
//
// The merchant creates a SolReqV2 ONLINE (fetches genesis hash + fresh blockhash), then shows the QR
// or exposes NFC. The payer signs OFFLINE and hands back the signed SolPayV2. The merchant then
// broadcasts. Because the merchant app can be killed/restarted at any point in this flow — after
// showing the QR but before a payer taps, or mid-broadcast after accepting a signed tx — the open
// request + any atomically-reserved accepted tx MUST survive restart so the merchant can reconcile.
//
// Lifecycle transitions (driven by SolReceiveMode):
//   - makeRequest success → save {req, uri, acceptedSignature:null, acceptedTx:null, outcome:'open'}.
//   - on scan of a signed payment (before first network send) → set acceptedSignature + acceptedTx,
//     outcome='broadcasting', save (atomic reservation — invariant #11).
//   - broadcast SETTLED → clear (done — invariant #10 clears on settle).
//   - broadcast REJECTED → clear (the payment is definitively dead).
//   - broadcast UNREACHABLE → keep with outcome='unknown' (the tx MAY still land; preserve for
//     reconciliation — invariant #12 never false-fails).
//
// A PURE AsyncStorage wrapper, best-effort (a malformed/corrupt
// value is swallowed — load → null, never thrown, so a storage glitch can never crash the resume path).

/**
 * The merchant's view of an open payment's progress. Only 'open' and 'broadcasting' are live states
 * the merchant UI can reconcile; 'settled'/'rejected' are transient (cleared immediately); 'unknown'
 * is a reconciliation-needed state (the broadcast timed out and the tx may or may not have landed).
 */
export type SolMerchantOutcome = 'open' | 'broadcasting' | 'settled' | 'rejected' | 'unknown';

/**
 * The persisted merchant request state. Keyed solely by the merchant's identity pubkey (one open
 * request per merchant at a time — a new makeRequest supersedes any prior state).
 *   - `req`: the SolReqV2 (for display + expiry countdown + NFC reader framing).
 *   - `uri`: the canonical `solreq:v2?<base64url>` URI — the authority for strict verify in broadcast.
 *   - `acceptedSignature`: the first verified tx signature (base58), reserved atomically BEFORE the
 *     first network send (invariant #11). null until a payment is accepted.
 *   - `acceptedTx`: the canonical base64url of the accepted signed tx bytes (for rebroadcast on
 *     reconcile). null until a payment is accepted.
 *   - `outcome`: see SolMerchantOutcome.
 */
export type SolMerchantRequestState = {
  req: SolReqV2;
  uri: string;
  acceptedSignature: string | null;
  acceptedTx: string | null;
  outcome: SolMerchantOutcome;
};

const SCHEMA = 1;

interface SchemaEnvelope {
  schema: number;
  state: SolMerchantRequestState;
}

/**
 * The storage key for a merchant's open request state. Per-merchant namespaced by the identity pubkey
 * (mirrors the `dpay.*` conventions). The `.v1` suffix is a schema-version namespace so a future
 * incompatible shape can migrate without colliding with stale keys.
 */
export function solMerchantKey(pubkeyHex: string): string {
  return `dpay.sol.merchant.v1.${pubkeyHex}`;
}

/**
 * Load the persisted merchant state. Returns null when no key exists, the JSON is malformed, or the
 * parsed value fails `hydrateSolMerchantState`'s shape check. NEVER throws — a storage glitch reports
 * "no state" so the caller starts fresh rather than crashing.
 */
export async function loadSolMerchantState(pubkeyHex: string): Promise<SolMerchantRequestState | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(solMerchantKey(pubkeyHex));
  } catch (e) {
    console.warn(`sol merchant persist: reading ${solMerchantKey(pubkeyHex)} failed:`, e instanceof Error ? e.message : String(e));
    return null;
  }
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`sol merchant persist: ${solMerchantKey(pubkeyHex)} holds ${raw.length} bytes that are not JSON:`, e instanceof Error ? e.message : String(e));
    return null; // malformed JSON — swallow, never throw
  }
  return hydrateSolMerchantState(parsed);
}

/**
 * Persist the merchant state. Best-effort: a thrown AsyncStorage error swallows (never rejects). The
 * caller (SolReceiveMode lifecycle) only ever writes a fully-formed state.
 */
export async function saveSolMerchantState(pubkeyHex: string, state: SolMerchantRequestState): Promise<void> {
  const envelope: SchemaEnvelope = {schema: SCHEMA, state};
  try {
    await AsyncStorage.setItem(solMerchantKey(pubkeyHex), JSON.stringify(envelope));
  } catch (e) {
    console.warn(`sol merchant persist: writing ${solMerchantKey(pubkeyHex)} failed — a restart will not reconcile this request:`, e instanceof Error ? e.message : String(e));
    /* best-effort — a missed persist just means a restart won't reconcile (merchant re-makes request) */
  }
}

/** Remove the persisted merchant state. Best-effort: a thrown AsyncStorage error swallows. */
export async function clearSolMerchantState(pubkeyHex: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(solMerchantKey(pubkeyHex));
  } catch (e) {
    console.warn(`sol merchant persist: clearing ${solMerchantKey(pubkeyHex)} failed — a stale request may resume:`, e instanceof Error ? e.message : String(e));
    /* best-effort */
  }
}

/**
 * The pure resume reducer. Given an unknown value (typically `JSON.parse` of the stored blob), validate
 * it is a well-formed schema envelope + merchant state and return the hydrated slice; anything else
 * returns null (the caller discards + clears the key + starts fresh). Extracted as a pure function so
 * the resume logic is unit-testable without a React tree, and so `loadSolMerchantState` can reuse the
 * same shape check after parsing.
 *
 * Defense-in-depth: even though `saveSolMerchantState` only ever writes well-formed states, a
 * hand-edited / migrated / corrupted blob might carry a wrong shape. Returning null for any malformed
 * value is the load-bearing guard that a corrupt request is NEVER used to display a stale QR or
 * rebroadcast a corrupt tx. The `uri` must be a v2 solreq URI (the strict-verify authority in
 * broadcast); the `req` is validated structurally (the real byte-equality check happens in
 * `broadcastSolPayment` which re-encodes `req` and compares to `uri`).
 */
export function hydrateSolMerchantState(raw: unknown): SolMerchantRequestState | null {
  if (!raw || typeof raw !== 'object') return null;
  const env = raw as Record<string, unknown>;
  if (env.schema !== SCHEMA) return null;
  const s = env.state;
  if (!s || typeof s !== 'object') return null;
  const st = s as Record<string, unknown>;

  if (st.outcome !== 'open' && st.outcome !== 'broadcasting' && st.outcome !== 'settled' &&
      st.outcome !== 'rejected' && st.outcome !== 'unknown') {
    return null;
  }
  if (typeof st.uri !== 'string' || !st.uri.startsWith('solreq:v2?')) return null;
  if (st.acceptedSignature !== null && typeof st.acceptedSignature !== 'string') return null;
  if (st.acceptedTx !== null && typeof st.acceptedTx !== 'string') return null;

  // Structural validation of req (the SolReqV2). The authoritative byte check is in broadcastSolPayment;
  // here we just verify the shape is plausible so a corrupt blob can't display a broken QR.
  const req = st.req;
  if (!req || typeof req !== 'object') return null;
  const r = req as Record<string, unknown>;
  if (r.v !== 2) return null;
  if (typeof r.rid !== 'string' || r.rid === '') return null;
  if (typeof r.net !== 'string') return null;
  if (typeof r.bh !== 'string' || r.bh === '') return null;
  if (typeof r.lvh !== 'number') return null;
  if (typeof r.slot !== 'number') return null;
  if (typeof r.iat !== 'number') return null;
  if (typeof r.exp !== 'number') return null;
  if (typeof r.to !== 'string' || r.to === '') return null;
  if (typeof r.amt !== 'string' || r.amt === '') return null;
  if (r.cur !== 'SOL' && r.cur !== 'USDC') return null;
  if (r.mint !== null && typeof r.mint !== 'string') return null;
  if (r.toAta !== null && typeof r.toAta !== 'string') return null;
  if (typeof r.name !== 'string') return null;
  if (typeof r.memo !== 'string') return null;

  return {
    req: r as unknown as SolReqV2,
    uri: st.uri,
    acceptedSignature: st.acceptedSignature as string | null,
    acceptedTx: st.acceptedTx as string | null,
    outcome: st.outcome as SolMerchantOutcome,
  };
}
