import AsyncStorage from '@react-native-async-storage/async-storage';

// U6 — persist the payer's SOL durable-nonce account state across app restart.
//
// The offline-pay rail signs against the STORED durable nonce value (no live blockhash needed), so
// the payer MUST remember its nonce account {address, value, status} across restarts or it cannot
// sign another offline payment after a kill/restart. This mirrors services/ckerc20Persist.ts: a
// PURE AsyncStorage wrapper, best-effort (a malformed/corrupt value is swallowed — load → null,
// never thrown, so a storage glitch can never crash the resume path).
//
// The `status` field tracks freshness:
//   - 'ready': the stored value is the on-chain current value (safe to sign against offline).
//   - 'stale': a broadcast was rejected OR the value may have drifted (MUST resync online via
//     resyncNonce before the next offline sign — signing against a stale value produces a tx that
//     will be rejected on-chain, no loss of funds but a failed payment).
//
// Lifecycle transitions (driven by the caller — SolPayMode/U5 functions):
//   - createNonceAccount → save {address, value, 'ready'} (initial).
//   - settled broadcast → load, set value = nextNonce, status = 'ready', save (the receipt-nonce-
//     relay win: the NEXT offline payment needs NO online resync).
//   - rejected/unreachable broadcast → load, set status = 'stale', save (value retained for display).
//   - resyncNonce (online) → load, set value = freshOnChainValue, status = 'ready', save.

/**
 * Whether the stored nonce value is safe to sign against offline.
 * - 'ready': matches the on-chain current value.
 * - 'stale': may have drifted; resync online before the next offline sign.
 */
export type SolNonceStatus = 'ready' | 'stale';

/**
 * The persisted nonce-account state. There is exactly ONE nonce account per payer identity (derived
 * deterministically at SLIP-10 path m/44'/501'/0'/1' from the device seed), so this is keyed solely
 * by the payer's identity pubkey — no per-account namespace needed.
 *   - `address`: the base58 nonce account pubkey. STABLE across advances (the account is created
 *     once; only its stored value rotates). Used to read the on-chain state via getNonceAccount.
 *   - `value`: the base58 current durable nonce value. The offline sign uses this as recentBlockhash.
 *   - `status`: freshness — see SolNonceStatus.
 */
export type SolNonceState = {
  address: string;
  value: string;
  status: SolNonceStatus;
};

/**
 * The storage key for a payer's nonce state. Per-payer namespaced (mirrors the `dpay.*` conventions
 * and ckerc20Persist's `depositKey`). The `.v1` suffix is a schema-version namespace so a future
 * incompatible shape can migrate without colliding with stale keys.
 */
export function nonceKey(pubkeyHex: string): string {
  return `dpay.sol.nonce.v1.${pubkeyHex}`;
}

/**
 * Load the persisted nonce state. Returns null when no key exists, the JSON is malformed, or the
 * parsed value fails `hydrateNonce`'s shape check. NEVER throws — a storage glitch reports "no
 * state" so the caller degrades to a fresh createNonceAccount rather than crashing.
 */
export async function loadSolNonce(pubkeyHex: string): Promise<SolNonceState | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(nonceKey(pubkeyHex));
  } catch {
    return null;
  }
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed JSON — swallow, never throw
  }
  return hydrateNonce(parsed);
}

/**
 * Persist the nonce state. Best-effort: a thrown AsyncStorage error swallows (never rejects). The
 * caller is the offline-pay lifecycle (createNonceAccount / settle-adopt / reject-mark-stale /
 * resync), which only ever writes a fully-formed state.
 */
export async function saveSolNonce(pubkeyHex: string, state: SolNonceState): Promise<void> {
  try {
    await AsyncStorage.setItem(nonceKey(pubkeyHex), JSON.stringify(state));
  } catch {
    /* best-effort — a missed persist just means a restart won't resume the nonce (resync needed) */
  }
}

/** Remove the persisted nonce state. Best-effort: a thrown AsyncStorage error swallows. */
export async function clearSolNonce(pubkeyHex: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(nonceKey(pubkeyHex));
  } catch {
    /* best-effort */
  }
}

/**
 * The pure resume reducer. Given an unknown value (typically `JSON.parse` of the stored blob),
 * validate it is a well-formed nonce state and return the hydrated slice; anything else returns
 * null (the caller discards + clears the key + re-runs createNonceAccount). Extracted as a pure
 * function so the resume logic is unit-testable without a React tree, and so `loadSolNonce` can
 * reuse the same shape check after parsing.
 *
 * Defense-in-depth: even though `saveSolNonce` only ever writes well-formed states, a hand-edited /
 * migrated / corrupted blob might carry a wrong shape or status. Returning null for any malformed
 * value is the load-bearing guard that a corrupt nonce value is NEVER used to sign an offline tx
 * (which would produce a tx rejected on-chain — no loss of funds, but a failed payment + confusion).
 * Empty-string fields are also rejected (guard against a zero-state / migration artifact).
 */
export function hydrateNonce(state: unknown): SolNonceState | null {
  if (!state || typeof state !== 'object') return null;
  const s = state as Record<string, unknown>;
  if (s.status !== 'ready' && s.status !== 'stale') return null;
  if (typeof s.address !== 'string' || s.address === '') return null;
  if (typeof s.value !== 'string' || s.value === '') return null;
  return {
    address: s.address,
    value: s.value,
    status: s.status,
  };
}
