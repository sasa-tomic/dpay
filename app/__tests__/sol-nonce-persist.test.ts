import {describe, it, expect, beforeEach, jest} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadSolNonce,
  saveSolNonce,
  clearSolNonce,
  hydrateNonce,
  nonceKey,
  type SolNonceState,
} from '../services/solNoncePersist';

// U6 — persist the payer's SOL durable-nonce account state across app restart. The offline-pay rail
// signs against the STORED nonce value (no live blockhash), so the payer MUST remember its nonce
// account {address, value, status} across restarts or it cannot sign another offline payment. The
// status field tracks freshness: 'ready' = the stored value is the on-chain current value (safe to
// sign against); 'stale' = a broadcast was rejected or the value may have drifted (must resync
// online before the next offline sign). After a settled broadcast the payer adopts the merchant's
// handed-back nextNonce → value updates + status flips back to 'ready' (the receipt-nonce-relay win:
// the NEXT offline payment needs NO online resync).
//
// These tests exercise the pure AsyncStorage wrapper (load/save/clear round-trip, malformed-JSON →
// null, clear removes the key, per-pubkey namespacing) AND the pure `hydrateNonce` reducer. Mirrors
// ckerc20Persist.test.ts style exactly (best-effort CRUD, never throws on storage glitch).

const PUBKEY = 'a'.repeat(64); // 32-byte Ed25519 device pubkey as hex (the payer's identity)

const READY: SolNonceState = {
  address: 'GZXyfzSTCBmA7rpeDLrmUbiSA45H5EEwJhoBeR6ZNb3u', // the nonce account pubkey (stable across advances)
  value: 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN', // the current durable nonce value (sign against this)
  status: 'ready',
};

describe('solNoncePersist — AsyncStorage wrapper (key shape + best-effort)', () => {
  beforeEach(async () => {
    // The official AsyncStorage mock holds state in a per-test in-memory map; flush between cases.
    await AsyncStorage.clear();
  });

  it('save → load round-trips a ready state byte-for-byte', async () => {
    await saveSolNonce(PUBKEY, READY);
    const got = await loadSolNonce(PUBKEY);
    expect(got).toEqual(READY);
  });

  it('load returns null when no key was ever written', async () => {
    expect(await loadSolNonce(PUBKEY)).toBeNull();
  });

  it('clear removes the key (a subsequent load returns null)', async () => {
    await saveSolNonce(PUBKEY, READY);
    expect(await loadSolNonce(PUBKEY)).not.toBeNull();
    await clearSolNonce(PUBKEY);
    expect(await loadSolNonce(PUBKEY)).toBeNull();
  });

  it('the key is namespaced per-payer — a different pubkey does not collide', async () => {
    await saveSolNonce(PUBKEY, READY);
    const other = await loadSolNonce('b'.repeat(64));
    expect(other).toBeNull();
  });

  it('a settled broadcast adopts nextNonce → value updates + status stays ready', async () => {
    // The receipt-nonce-relay win: the payer adopts the merchant's handed-back nextNonce WITHOUT an
    // online resync, so the NEXT offline payment is immediately signable. The caller does load →
    // mutate value → save; this test verifies that round-trip preserves the new value + ready status.
    await saveSolNonce(PUBKEY, READY);
    const s = await loadSolNonce(PUBKEY);
    expect(s).not.toBeNull();
    const advanced: SolNonceState = {
      address: s!.address, // address is stable across advances
      value: '9otJS8smVKNb1SyjTUEFtYJzjB4ASKA8Pvk8Z5wiKcpV', // the NEW nonce value the merchant handed back
      status: 'ready',
    };
    await saveSolNonce(PUBKEY, advanced);
    expect(await loadSolNonce(PUBKEY)).toEqual(advanced);
  });

  it('a rejected broadcast flips status to stale (value retained for display)', async () => {
    // On a rejected/unreachable broadcast the payer cannot trust the stored value matches on-chain
    // anymore → mark stale. The value is retained (displayed as "last known") but the next offline
    // sign MUST resync first. The caller does load → mutate status → save.
    await saveSolNonce(PUBKEY, READY);
    const s = await loadSolNonce(PUBKEY);
    expect(s).not.toBeNull();
    const stale: SolNonceState = {...s!, status: 'stale'};
    await saveSolNonce(PUBKEY, stale);
    const got = await loadSolNonce(PUBKEY);
    expect(got).toEqual(stale);
    expect(got!.status).toBe('stale');
    expect(got!.value).toBe(READY.value); // retained
  });

  it('a resync flips status back to ready with the fresh on-chain value', async () => {
    // After going stale, the payer resyncs online (resyncNonce) → loads the fresh on-chain value →
    // status flips back to ready. The caller does load → mutate value+status → save.
    await saveSolNonce(PUBKEY, {...READY, status: 'stale'});
    const s = await loadSolNonce(PUBKEY);
    expect(s!.status).toBe('stale');
    const resynced: SolNonceState = {
      address: s!.address,
      value: 'HedniqrC67EqZD68nxfBXv6pp6DFRiL8WLgFPx5izMnV', // fresh value from getNonceAccount
      status: 'ready',
    };
    await saveSolNonce(PUBKEY, resynced);
    expect(await loadSolNonce(PUBKEY)).toEqual(resynced);
  });

  it('malformed JSON in storage → load returns null (NEVER throws)', async () => {
    // Simulate a corrupted/partial write. The wrapper must swallow the parse error and report "no
    // state" rather than crashing the resume path on the user's next launch.
    await AsyncStorage.setItem(nonceKey(PUBKEY), '{not valid json');
    expect(await loadSolNonce(PUBKEY)).toBeNull();
  });

  it('a JSON value that is not an object → load returns null (NEVER throws)', async () => {
    await AsyncStorage.setItem(nonceKey(PUBKEY), '"a string"');
    expect(await loadSolNonce(PUBKEY)).toBeNull();
  });

  it('save is best-effort — a thrown AsyncStorage error swallows (never rejects)', async () => {
    const spy = jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    await expect(saveSolNonce(PUBKEY, READY)).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('clear is best-effort — a thrown AsyncStorage error swallows (never rejects)', async () => {
    await saveSolNonce(PUBKEY, READY);
    const spy = jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('locked'));
    await expect(clearSolNonce(PUBKEY)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

// The pure "resume reducer" — given an unknown value read from storage, validate it is a well-formed
// nonce state and return the hydrated slice; anything else returns null (the caller discards +
// clears the key). Extracted as a pure function so the resume logic is unit-testable without a React
// tree, and so `loadSolNonce` can reuse the same shape check after parsing.
describe('hydrateNonce — pure resume reducer', () => {
  it('hydrates a well-formed ready state', () => {
    const h = hydrateNonce(READY);
    expect(h).not.toBeNull();
    expect(h!.address).toBe(READY.address);
    expect(h!.value).toBe(READY.value);
    expect(h!.status).toBe('ready');
  });

  it('hydrates a well-formed stale state', () => {
    const h = hydrateNonce({...READY, status: 'stale'});
    expect(h).not.toBeNull();
    expect(h!.status).toBe('stale');
  });

  it('returns null for null (no persisted state)', () => {
    expect(hydrateNonce(null)).toBeNull();
  });

  it('returns null for a non-object value', () => {
    expect(hydrateNonce('ready')).toBeNull();
    expect(hydrateNonce(42)).toBeNull();
    expect(hydrateNonce(true)).toBeNull();
  });

  it('returns null when status is missing or not "ready"/"stale"', () => {
    expect(hydrateNonce({...READY, status: undefined})).toBeNull();
    expect(hydrateNonce({...READY, status: 'fresh'})).toBeNull();
    expect(hydrateNonce({...READY, status: 'READY'})).toBeNull(); // case-sensitive
  });

  it('returns null when a required field is missing', () => {
    expect(hydrateNonce({...READY, address: undefined})).toBeNull();
    expect(hydrateNonce({...READY, value: undefined})).toBeNull();
    expect(hydrateNonce({...READY, status: undefined})).toBeNull();
  });

  it('returns null when address/value are not strings (type-coercion guard)', () => {
    expect(hydrateNonce({...READY, address: 123})).toBeNull();
    expect(hydrateNonce({...READY, value: []})).toBeNull();
  });

  it('returns null for an empty-string address/value (guard against zero-state corruption)', () => {
    expect(hydrateNonce({...READY, address: ''})).toBeNull();
    expect(hydrateNonce({...READY, value: ''})).toBeNull();
  });
});

describe('nonceKey — storage key formatter', () => {
  it('produces a per-payer namespaced key with a v1 schema suffix', () => {
    expect(nonceKey(PUBKEY)).toBe(`dpay.sol.nonce.v1.${PUBKEY}`);
  });

  it('different pubkeys produce different keys', () => {
    expect(nonceKey('a'.repeat(64))).not.toBe(nonceKey('b'.repeat(64)));
  });
});
