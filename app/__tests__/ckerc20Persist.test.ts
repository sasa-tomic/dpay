import {describe, it, expect, beforeEach, jest} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadDeposit,
  saveDeposit,
  clearDeposit,
  hydrateWatch,
  type Ckerc20DepositState,
} from '../services/ckerc20Persist';

// MC8 U5 — persist the ckERC20 deposit's WATCHING phase across app restart. The watching poll hits
// the RELAY balance (NOT Ethereum), so it is resumable WITHOUT the wallet session: an app restart
// mid-watch rehydrates amount/account/startBal/txHashes and the relay balance poll picks back up,
// while the ephemeral wallet-bound phases (connect/enter/sending) are honestly discarded (an EIP-1193
// session does NOT survive restart). Only `phase: 'watching'` is ever persisted.
//
// These tests exercise the pure AsyncStorage wrapper (load/save/clear round-trip, malformed-JSON →
// null, clear removes the key) AND the pure `hydrateWatch` reducer (the sheet's resume logic).

const PUBKEY = 'a'.repeat(64); // 32-byte Ed25519 pubkey as hex (the user's identity)
const CURRENCY = 2; // ckUSDC

const WATCHING: Ckerc20DepositState = {
  currency: CURRENCY,
  amount: '100.00',
  account: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  startBal: '0',
  txHashes: ['0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32)],
  phase: 'watching',
};

describe('ckerc20Persist — AsyncStorage wrapper (key shape + best-effort)', () => {
  beforeEach(async () => {
    // The official AsyncStorage mock holds state in a per-test in-memory map; flush between cases.
    await AsyncStorage.clear();
  });

  it('save → load round-trips a watching state byte-for-byte', async () => {
    await saveDeposit(PUBKEY, CURRENCY, WATCHING);
    const got = await loadDeposit(PUBKEY, CURRENCY);
    expect(got).toEqual(WATCHING);
  });

  it('load returns null when no key was ever written', async () => {
    expect(await loadDeposit(PUBKEY, CURRENCY)).toBeNull();
  });

  it('clear removes the key (a subsequent load returns null)', async () => {
    await saveDeposit(PUBKEY, CURRENCY, WATCHING);
    expect(await loadDeposit(PUBKEY, CURRENCY)).not.toBeNull();
    await clearDeposit(PUBKEY, CURRENCY);
    expect(await loadDeposit(PUBKEY, CURRENCY)).toBeNull();
  });

  it('the key is namespaced per-(pubkey,currency) — a different pubkey does not collide', async () => {
    await saveDeposit(PUBKEY, CURRENCY, WATCHING);
    const other = await loadDeposit('b'.repeat(64), CURRENCY);
    expect(other).toBeNull();
  });

  it('the key is namespaced per-currency — the same pubkey, a different currency does not collide', async () => {
    await saveDeposit(PUBKEY, CURRENCY, WATCHING);
    const other = await loadDeposit(PUBKEY, 5);
    expect(other).toBeNull();
  });

  it('malformed JSON in storage → load returns null (NEVER throws)', async () => {
    // Simulate a corrupted/partial write. The wrapper must swallow the parse error and report "no
    // state" rather than crashing the resume path on the user's next launch.
    const key = `dpay.ckerc20.deposit.${PUBKEY}.${CURRENCY}`;
    await AsyncStorage.setItem(key, '{not valid json');
    expect(await loadDeposit(PUBKEY, CURRENCY)).toBeNull();
  });

  it('a JSON value that is not an object → load returns null (NEVER throws)', async () => {
    const key = `dpay.ckerc20.deposit.${PUBKEY}.${CURRENCY}`;
    await AsyncStorage.setItem(key, '"a string"');
    expect(await loadDeposit(PUBKEY, CURRENCY)).toBeNull();
  });

  it('save is best-effort — a thrown AsyncStorage error swallows (never rejects)', async () => {
    // Force AsyncStorage.setItem to throw; saveDeposit must NOT propagate.
    const spy = jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    await expect(saveDeposit(PUBKEY, CURRENCY, WATCHING)).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('clear is best-effort — a thrown AsyncStorage error swallows (never rejects)', async () => {
    await saveDeposit(PUBKEY, CURRENCY, WATCHING);
    const spy = jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('locked'));
    await expect(clearDeposit(PUBKEY, CURRENCY)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

// The pure "resume reducer" — given an unknown value read from storage, validate it is a well-formed
// WATCHING deposit state and return the hydrated sheet slice; anything else returns null (the sheet
// discards + clears the key). This is the logic the sheet's mount effect runs to decide whether to
// resume the relay-poll WITHOUT a wallet reconnect or to surface the "interrupted; start again" notice.
describe('hydrateWatch — pure resume reducer', () => {
  it('hydrates a well-formed watching state into the sheet slice', () => {
    const h = hydrateWatch(WATCHING);
    expect(h).not.toBeNull();
    expect(h!.phase).toBe('watching');
    expect(h!.amount).toBe('100.00');
    expect(h!.account).toBe(WATCHING.account);
    expect(h!.startBal).toBe('0');
    expect(h!.txHashes).toEqual(WATCHING.txHashes);
  });

  it('returns null for null (no persisted state)', () => {
    expect(hydrateWatch(null)).toBeNull();
  });

  it('returns null for a non-object value', () => {
    expect(hydrateWatch('watching')).toBeNull();
    expect(hydrateWatch(42)).toBeNull();
    expect(hydrateWatch(true)).toBeNull();
  });

  it('returns null when phase is missing or not "watching" (ephemeral phases are NEVER resumed)', () => {
    // connect/enter/sending are wallet-bound; an EIP-1193 session does not survive restart, so a
    // persisted state in any of those phases is stale → discard. Only 'watching' is resumable
    // (the relay poll needs no wallet session).
    expect(hydrateWatch({...WATCHING, phase: 'connect'})).toBeNull();
    expect(hydrateWatch({...WATCHING, phase: 'enter'})).toBeNull();
    expect(hydrateWatch({...WATCHING, phase: 'sending'})).toBeNull();
    expect(hydrateWatch({...WATCHING, phase: undefined})).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    expect(hydrateWatch({...WATCHING, amount: undefined})).toBeNull();
    expect(hydrateWatch({...WATCHING, account: undefined})).toBeNull();
    expect(hydrateWatch({...WATCHING, startBal: undefined})).toBeNull();
    expect(hydrateWatch({...WATCHING, txHashes: undefined})).toBeNull();
  });

  it('returns null when txHashes is not an array', () => {
    expect(hydrateWatch({...WATCHING, txHashes: '0xaa'})).toBeNull();
    expect(hydrateWatch({...WATCHING, txHashes: {0: '0xaa'}})).toBeNull();
  });

  it('returns null when amount/account/startBal are not strings (type-coercion guard)', () => {
    expect(hydrateWatch({...WATCHING, amount: 100})).toBeNull();
    expect(hydrateWatch({...WATCHING, account: 0xabc})).toBeNull();
    expect(hydrateWatch({...WATCHING, startBal: 0})).toBeNull();
  });

  it('preserves the original txHashes array contents (no mutation)', () => {
    const h = hydrateWatch(WATCHING);
    expect(h!.txHashes).toEqual(['0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32)]);
  });
});
