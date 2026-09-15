/**
 * pendingPays — the persisted outbox of payments handed off UNCONFIRMED (2026-09-15 founder
 * requirements: offline payments appear in the LOCAL list with the balance deducted, and both the
 * row and the deduction survive a restart). These are the SERVICE contracts, in the txNotes test's
 * house style: per-identity storage, replace-by-key (the double-pay guard's re-approve re-displays
 * the same envelope), the cap that bounds never-settling hand-offs, per-record salvage, the
 * never-throw rule, and the announce-driven refresh the hook rides.
 *
 * The reconciliation half of the contract — which settled row RETIRES which record — is the
 * mergePendingByTime/settledJoinKey pair from lib/ledger, pinned here in the same file because it
 * is the same feature's two ends: the seam writes under a join key, the history read drops by it.
 *
 * AsyncStorage is the jest mock from jest.setup.js; every test starts from a cleared store.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  addPendingPays,
  isPendingPay,
  listPendingPays,
  MAX_PENDING_PAYS,
  normalizePendingKey,
  pendingPaysKey,
  removePendingPays,
  salvagePendingPays,
  subscribePendingPays,
  type PendingPay,
} from '../services/pendingPays';
import {mergePendingByTime, settledJoinKey} from '../lib/ledger';
import type {AssetId, Txn} from '../lib/types';

const ID = 'ab'.repeat(32);
const KEY = pendingPaysKey(ID);

/** A minimal valid record — every test overrides what it cares about. */
function rec(over: Partial<PendingPay> = {}): PendingPay {
  return {
    k: 'aabbcc',
    assetId: 'ic:0',
    currency: 0,
    wireAmount: '2500',
    fee: '10',
    gross: '2510',
    who: 'Café Sunrise',
    ts: 1_000,
    kind: 'ic-qr',
    ...over,
  };
}

beforeEach(() => AsyncStorage.clear());

describe('pendingPays — persistence and retrieval', () => {
  test('a written record round-trips under the per-identity key', async () => {
    await addPendingPays(ID, [rec()]);
    const raw = await AsyncStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    await expect(listPendingPays(ID)).resolves.toHaveLength(1);
  });

  test('identities are isolated — one wallet never reads another\'s hand-offs', async () => {
    await addPendingPays(ID, [rec()]);
    await expect(listPendingPays('cd'.repeat(32))).resolves.toEqual([]);
  });

  test('re-writing the SAME join key replaces instead of duplicating (the re-approve path)', async () => {
    await addPendingPays(ID, [rec()]);
    // PayMode's submittedEnv re-display re-saves the same nonce with a later hand-off time.
    await addPendingPays(ID, [rec({ts: 2_000, gross: '2600'})]);
    const all = await listPendingPays(ID);
    expect(all).toHaveLength(1);
    expect(all[0].ts).toBe(2_000);
    expect(all[0].gross).toBe('2600');
  });

  test('the key normalizes, so one spelling replaces the other (the txNotes rule)', async () => {
    await addPendingPays(ID, [rec({k: '  AABBCC  '})]);
    await addPendingPays(ID, [rec({k: 'aabbcc', ts: 2_000})]);
    await expect(listPendingPays(ID)).resolves.toHaveLength(1);
  });

  test('the cap drops the OLDEST records and keeps insertion order among survivors', async () => {
    const many: PendingPay[] = [];
    for (let i = 0; i < MAX_PENDING_PAYS + 5; i++) many.push(rec({k: `k${i}`, ts: i}));
    await addPendingPays(ID, many);
    const all = await listPendingPays(ID);
    expect(all).toHaveLength(MAX_PENDING_PAYS);
    // The five oldest (k0..k4) aged out; k5 survives and the ascending arrival order holds.
    expect(all.map(r => r.k).slice(0, 2)).toEqual(['k5', 'k6']);
  });

  test('removePendingPays drops by normalized key and stays silent when nothing matched', async () => {
    await addPendingPays(ID, [rec(), rec({k: 'deadbeef', kind: 'ic-nfc'})]);
    await removePendingPays(ID, ['AABBCC']);
    const left = await listPendingPays(ID);
    expect(left).toHaveLength(1);
    expect(left[0].k).toBe('deadbeef');
    const before = await AsyncStorage.getItem(KEY);
    await removePendingPays(ID, ['nonsense']);
    expect(await AsyncStorage.getItem(KEY)).toBe(before); // no rewrite, no announce
  });
});

describe('pendingPays — salvage and the never-throw rule', () => {
  test('one corrupt record is dropped INDIVIDUALLY; its neighbours keep their row and deduction', () => {
    const good = rec();
    const salvaged = salvagePendingPays([good, {k: 'x', assetId: 'ic:0', wireAmount: '-5', ts: 1, kind: 'ic-qr'}]);
    expect(salvaged).toEqual([good]);
  });

  test('a non-array blob (corrupt JSON, a legacy shape) has nothing salvageable', () => {
    expect(salvagePendingPays(null)).toEqual([]);
    expect(salvagePendingPays({k: 'x'})).toEqual([]);
  });

  test('the shape gate refuses a record missing any honest field', () => {
    expect(isPendingPay(rec())).toBe(true);
    // The invalid variants are cast through unknown on PURPOSE — the gate exists for data that
    // never should have compiled, so the compiler's opinion is not wanted here.
    expect(isPendingPay(rec({wireAmount: '2.5'}))).toBe(false); // raw units are digit strings
    expect(isPendingPay(rec({fee: '1.0'}))).toBe(false);
    expect(isPendingPay(rec({kind: 'sol-cash' as unknown as PendingPay['kind']}))).toBe(false);
    expect(isPendingPay(rec({ts: Number.NaN}))).toBe(false);
    expect(isPendingPay(rec({currency: '0' as unknown as number}))).toBe(false);
  });

  test('a malformed WRITE is refused, not stored — and never throws at the seam', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(addPendingPays(ID, [{k: '', assetId: 'ic:0', currency: 0, wireAmount: '1', ts: 1, kind: 'ic-qr'} as PendingPay])).resolves.toBeUndefined();
    await expect(listPendingPays(ID)).resolves.toEqual([]);
    spy.mockRestore();
  });

  test('an unreadable store degrades to [] (the cache must never crash the wallet)', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await AsyncStorage.setItem(KEY, '{{{not json');
    await expect(listPendingPays(ID)).resolves.toEqual([]);
    spy.mockRestore();
  });
});

describe('pendingPays — the announce-driven refresh', () => {
  test('every persisted change announces the identity IT wrote — listeners do the filtering', async () => {
    const seen: string[] = [];
    const off = subscribePendingPays(changed => { seen.push(changed); });
    await addPendingPays(ID, [rec()]);
    await addPendingPays('cd'.repeat(32), [rec()]); // same store, a different wallet's seam
    await removePendingPays('cd'.repeat(32), ['aabbcc']); // a MATCH there → announces again
    expect(seen).toEqual([ID, 'cd'.repeat(32), 'cd'.repeat(32)]);
    off();
  });

  test('a no-op removal announces nothing', async () => {
    const seen: string[] = [];
    const off = subscribePendingPays(changed => { seen.push(changed); });
    await addPendingPays(ID, [rec()]);
    seen.length = 0;
    await removePendingPays(ID, ['not-a-key']);
    expect(seen).toEqual([]);
    off();
  });

  test('a listener that throws never blocks the write', async () => {
    const off = subscribePendingPays(() => { throw new Error('subscriber bug'); });
    await expect(addPendingPays(ID, [rec()])).resolves.toBeUndefined();
    await expect(listPendingPays(ID)).resolves.toHaveLength(1);
    off();
  });
});

/** A settled-shaped Txn for the reconciliation tests. */
function settledRow(assetId: AssetId, joinValue: string, ts: number): Txn {
  const sol = assetId.startsWith('solana:');
  return {
    nonce: sol ? joinValue : 'sig',
    amount: '2500',
    who: 'someone',
    memo: sol ? '' : joinValue,
    time: 'Aug 24',
    ts,
    dir: 'out',
    assetId,
    counterparty: 'aaaaa-aa',
    ledgerRef: '4211',
  };
}

/** A pending-shaped Txn EXACTLY as Wallet projects a record: the join key rides in `nonce` on BOTH
 *  rails (mergePendingByTime's comparison field), `pending` set, no ledger ref. */
function pendingRow(assetId: AssetId, k: string, ts: number): Txn {
  return {
    nonce: k,
    amount: '2500',
    who: 'someone',
    memo: '',
    time: 'Aug 24',
    ts,
    dir: 'out',
    assetId,
    counterparty: '',
    ledgerRef: '',
    pending: true,
  };
}

describe('reconciliation — the settled row retires the projected one by JOIN KEY', () => {
  test('settledJoinKey reads the SIGNATURE on Solana rows and the MEMO on IC rows', () => {
    expect(settledJoinKey(settledRow('solana:SOL', 'SigBase58x', 1))).toBe('sigbase58x');
    expect(settledJoinKey(settledRow('ic:0', 'NonceHex9', 1))).toBe('noncehex9');
  });

  test('a settled row with the record\'s key removes the projected row in the SAME render pass', () => {
    const out = mergePendingByTime(
      [pendingRow('ic:0', 'aabbcc', 2_000)],
      [settledRow('ic:0', 'AABBCC', 1_999)], // history echoes the memo in ANY casing
    );
    expect(out).toHaveLength(1);
    expect(out[0].pending).toBeUndefined(); // the ledger's own row won
  });

  test('unmatched pending rows render (founder requirement 1), newest-first, pending first on ties', () => {
    const out = mergePendingByTime(
      [pendingRow('ic:0', 'aa', 1_500), pendingRow('ic:0', 'bb', 2_000)],
      [settledRow('ic:0', 'zz', 2_000)], // SAME ts as pending bb — the hand-off outranks it
    );
    expect(out.map(t => t.pending)).toEqual([true, undefined, true]); // bb, settled zz, aa
  });

  test('an empty outbox is the settled list untouched', () => {
    const rows = [settledRow('ic:0', 'm', 1)];
    expect(mergePendingByTime([], rows)).toBe(rows);
  });

  test('normalizePendingKey is the merge\'s own comparison rule (one spelling everywhere)', () => {
    expect(normalizePendingKey('  AABBCC ')).toBe('aabbcc');
  });
});
