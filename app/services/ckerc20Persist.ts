import AsyncStorage from '@react-native-async-storage/async-storage';

// MC8 U5 — persist the ckERC20 deposit's WATCHING phase across app restart.
//
// The ckERC20 deposit is a ~20-minute watch: the user connects an Ethereum wallet (MetaMask via
// EIP-1193), approves + deposits via two `sendTransaction` calls, then the sheet polls the RELAY's
// `/api/v1/balance` (NOT Ethereum) until the ckETH minter's heartbeat mints the ckERC20 to their
// account. KEY LEVERAGE: the watching poll hits the RELAY, not Ethereum, so the watching phase is
// RESUMABLE ACROSS RESTART WITHOUT re-connecting the wallet — the ETH session is only needed for
// connect/enter/sending. EIP-1193 sessions do NOT survive restart, so the wallet-bound phases are
// ephemeral and MUST be discarded on restart (with an honest notice). Only `phase: 'watching'` is
// ever persisted here; saving any other phase is a bug.
//
// This module is a PURE AsyncStorage wrapper — no @ReactMethod / NativeModules surface (mirrors
// services/withdraw.ts + services/receipt.ts style). Best-effort: a malformed/corrupt value is
// swallowed (load → null), never thrown, so a storage glitch can never crash the resume path.

/**
 * The persisted slice of a ckERC20 deposit. ONLY the watching phase is ever saved — connect/enter/
 * sending are wallet-bound and discarded on restart. Every field is what the watching poll + the
 * resumed UI need to pick back up with NO wallet session:
 *   - `currency`: the catalog currency id (ckUSDC = 2). Redundant with the key, but kept in the
 *     value as a self-describing sanity check.
 *   - `amount`: the human amount string the user entered (display only; the poll uses startBal).
 *   - `account`: the ETH account that signed (informational — surfaced so the resumed UI can name it
 *     even though the session is gone; never used to send).
 *   - `startBal`: the relay balance snapshot taken at connect. The watching poll detects the mint as
 *     a GROWTH from this value (a positive balance when startBal is null also counts).
 *   - `txHashes`: the two ETH tx hashes (approve + deposit). Informational for the resumed UI.
 *   - `phase`: always `'watching'`. Any other value here is a bug → hydrateWatch discards it.
 */
export type Ckerc20DepositState = {
  currency: number;
  amount: string;
  account: string;
  startBal: string;
  txHashes: string[];
  phase: 'watching';
};

/** The storage key for a (pubkey, currency) deposit. Mirrors the `dpay.*` namespace conventions. */
export function depositKey(pubkeyHex: string, currency: number): string {
  return `dpay.ckerc20.deposit.${pubkeyHex}.${currency}`;
}

/**
 * Load a persisted watching state. Returns null when no key exists, the JSON is malformed, or the
 * parsed value fails `hydrateWatch`'s shape check. NEVER throws — a storage glitch reports "no
 * state" so the resume path degrades to a fresh sheet rather than crashing.
 */
export async function loadDeposit(
  pubkeyHex: string,
  currency: number,
): Promise<Ckerc20DepositState | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(depositKey(pubkeyHex, currency));
  } catch (e) {
    console.warn('ckERC20 persist failed:', e instanceof Error ? e.message : String(e));
    return null;
  }
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn('ckERC20 persist failed:', e instanceof Error ? e.message : String(e));
    return null; // malformed JSON — swallow, never throw
  }
  return hydrateWatch(parsed);
}

/**
 * Persist a watching state. Best-effort: a thrown AsyncStorage error swallows (never rejects). The
 * caller is the sheet's phase-transition effect, which only calls this with `phase: 'watching'`.
 */
export async function saveDeposit(
  pubkeyHex: string,
  currency: number,
  state: Ckerc20DepositState,
): Promise<void> {
  try {
    await AsyncStorage.setItem(depositKey(pubkeyHex, currency), JSON.stringify(state));
  } catch (e) {
    console.warn('ckERC20 persist failed:', e instanceof Error ? e.message : String(e));
    /* best-effort — a missed persist just means a restart won't resume this watch */
  }
}

/** Remove a persisted watching state. Best-effort: a thrown AsyncStorage error swallows. */
export async function clearDeposit(pubkeyHex: string, currency: number): Promise<void> {
  try {
    await AsyncStorage.removeItem(depositKey(pubkeyHex, currency));
  } catch (e) {
    console.warn('ckERC20 persist failed:', e instanceof Error ? e.message : String(e));
    /* best-effort */
  }
}

/**
 * The sheet's pure resume reducer. Given an unknown value (typically `JSON.parse` of the stored
 * blob), validate it is a well-formed WATCHING deposit state and return the hydrated slice; anything
 * else returns null (the sheet then discards + clears the key + surfaces the "interrupted; start
 * again" notice). Extracted as a pure function so the resume logic is unit-testable without a React
 * tree, and so `loadDeposit` can reuse the same shape check after parsing.
 *
 * Defense-in-depth: even though `saveDeposit` only ever writes `phase: 'watching'`, a hand-edited /
 * migrated / corrupted blob might carry a different phase. Returning null for any non-watching phase
 * is the load-bearing guard that the ephemeral wallet-bound phases are NEVER resumed.
 */
export function hydrateWatch(state: unknown): Ckerc20DepositState | null {
  if (!state || typeof state !== 'object') return null;
  const s = state as Record<string, unknown>;
  if (s.phase !== 'watching') return null;
  if (typeof s.amount !== 'string') return null;
  if (typeof s.account !== 'string') return null;
  if (typeof s.startBal !== 'string') return null;
  if (!Array.isArray(s.txHashes)) return null;
  if (typeof s.currency !== 'number') return null;
  // txHashes entries should be strings; coerce defensively (a malformed entry is dropped, not fatal).
  const txHashes = (s.txHashes as unknown[]).filter((h): h is string => typeof h === 'string');
  return {
    currency: s.currency,
    amount: s.amount,
    account: s.account,
    startBal: s.startBal,
    txHashes,
    phase: 'watching',
  };
}
