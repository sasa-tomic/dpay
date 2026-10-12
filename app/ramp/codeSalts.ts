// Per-address Mt Pelerin validation-code salts — the collision fallback's persisted half.
//
// app/ramp/mtpelerin.ts derives each address's validation code deterministically; a derivation is
// per-address by construction but CANNOT guarantee distinct codes across a user's addresses, and
// Mt Pelerin rejects a code re-used across addresses. The fallback: the caller detects a collision
// (driven by the caller — it knows the full address set) and persists a fresh random salt for ONE
// of the colliding addresses; `deriveValidationCode(address, salt)` then yields a distinct code.
// Validation binds (addr, code, hash), so a salted address still validates with its own code.
//
// One AsyncStorage key per address (`dpay.ramp.mtpValidationSalt.<lowercase 40-hex>`), written on
// first need and read on every derivation after — PURE AsyncStorage wrapper, best-effort like
// services/ckerc20Persist.ts: a storage glitch degrades to "no salt", never a crash.

import AsyncStorage from '@react-native-async-storage/async-storage';

const SALT_KEY_PREFIX = 'dpay.ramp.mtpValidationSalt.';

/** The storage key for one address's salt (keyed by the lowercase 40-hex body, 0x optional). */
export function validationSaltKey(address: string): string {
  const body = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(body)) throw new Error(`not a 20-byte EVM address: ${address}`);
  return SALT_KEY_PREFIX + body;
}

/** Load a persisted salt; null when none was ever written. NEVER throws. */
export async function loadValidationSalt(address: string): Promise<string | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(validationSaltKey(address));
  } catch (e) {
    console.warn('mtp salt store: read failed:', e instanceof Error ? e.message : String(e));
    return null;
  }
  return raw;
}

/** Persist a salt (the caller generates it — e.g. 16 bytes of crypto.getRandomValues hex).
 *  Best-effort: a failed write resolves anyway; the NEXT derivation just re-collides and the
 *  caller retries, so a missed persist can never silently produce a duplicate code at the
 *  provider (their validation rejects the duplicate — visible, not corrupting). */
export async function saveValidationSalt(address: string, salt: string): Promise<void> {
  try {
    await AsyncStorage.setItem(validationSaltKey(address), salt);
  } catch (e) {
    console.warn('mtp salt store: write failed:', e instanceof Error ? e.message : String(e));
  }
}
