import {describe, it, expect, beforeEach, afterEach, jest} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadTxNotes,
  saveTxNote,
  txNotesKey,
  txNoteIndex,
  salvageTxNotes,
  mergeTxNote,
  annotateTxn,
  subscribeTxNotes,
  MAX_TX_NOTES,
  type TxNote,
} from '../services/txNotes';

// Device-side payment annotations (services/txNotes): the peer NAME and human MESSAGE a payment
// carried at the time it was made — neither survives on-chain (the IC memo is the frozen 16-byte
// nonce; SOL messages are never re-read). The contract under test: notes are keyed by the value
// that DOES survive the round trip (IC memo hex / SOL signature) and lowercased on both ends, a
// re-annotation of the same key replaces (never duplicates), the store is capped by evicting the
// oldest, a corrupt blob costs at most the corrupt rows, and a write NEVER throws at a payment
// flow. `nowMs` is injected, so every ordering assertion is exact rather than timing-dependent.

const ALICE = 'a'.repeat(64); // payer-side identity (public hex)
const BOB = 'b'.repeat(64); // a second wallet — proves per-identity isolation

const T0 = 1_760_000_000_000;

const NONCE = '9f2c00112233445566778899aabbccdd'; // an IC request nonce = on-chain memo hex
const SIG = '5Nq1FakeSig11111111111111111111111111111111111111111111111111111111'; // a SOL signature

let warn: ReturnType<typeof jest.spyOn>;

beforeEach(async () => {
  await AsyncStorage.clear();
  // Silence + capture the service's warns; several cases assert one was emitted.
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('txNotesKey', () => {
  it('namespaces per identity under dpay.* with the v1 schema suffix', () => {
    expect(txNotesKey(ALICE)).toBe(`dpay.txnotes.v1.${ALICE}`);
  });
});

describe('save / load round-trip', () => {
  it('an identity that never annotated loads as an empty list, silently', async () => {
    expect(await loadTxNotes(ALICE)).toEqual([]);
    // A first-time wallet is not an error condition — no warn noise on every open.
    expect(warn).not.toHaveBeenCalled();
  });

  it('saves the trimmed name and message with the caller-supplied clock, verbatim on reload', async () => {
    await saveTxNote(ALICE, {k: NONCE, who: '  Bob ', msg: ' coffee '}, T0);
    expect(await loadTxNotes(ALICE)).toEqual([{k: NONCE, who: 'Bob', msg: 'coffee', at: T0}]);
  });

  it('normalizes the join key (the read side lowercases whatever the rail echoed back)', async () => {
    await saveTxNote(ALICE, {k: NONCE.toUpperCase(), who: 'Bob'}, T0);
    const notes = await loadTxNotes(ALICE);
    expect(notes).toHaveLength(1);
    expect(notes[0].k).toBe(NONCE);
  });

  it('drops a whitespace-only name and message; neither surviving is a NO-OP', async () => {
    await saveTxNote(ALICE, {k: NONCE, who: '   ', msg: ''}, T0);
    expect(await loadTxNotes(ALICE)).toEqual([]);
    expect(await AsyncStorage.getItem(txNotesKey(ALICE))).toBeNull(); // nothing was written at all
  });

  it('a note with only a message (a payee-side request memo) saves without a who', async () => {
    await saveTxNote(ALICE, {k: NONCE, msg: 'table 4'}, T0);
    expect(await loadTxNotes(ALICE)).toEqual([{k: NONCE, msg: 'table 4', at: T0}]);
  });

  it('re-annotating the same join key REPLACES the entry, never duplicates it', async () => {
    await saveTxNote(ALICE, {k: NONCE, who: 'Bob'}, T0);
    await saveTxNote(ALICE, {k: NONCE, who: 'Bob', msg: 'coffee'}, T0 + 5);
    expect(await loadTxNotes(ALICE)).toEqual([{k: NONCE, who: 'Bob', msg: 'coffee', at: T0 + 5}]);
  });

  it('keeps two identities\' stores independent (notes about money belong to the wallet that moved it)', async () => {
    await saveTxNote(ALICE, {k: NONCE, who: 'Bob'}, T0);
    await saveTxNote(BOB, {k: SIG, msg: 'order 42'}, T0 + 1);
    expect(await loadTxNotes(ALICE)).toEqual([{k: NONCE, who: 'Bob', at: T0}]);
    expect(await loadTxNotes(BOB)).toEqual([{k: SIG.toLowerCase(), msg: 'order 42', at: T0 + 1}]); // k normalized on the way in
  });
});

describe('the change notification', () => {
  it('saveTxNote announces WHICH identity\'s store changed; a no-op announces nothing', async () => {
    const seen: string[] = [];
    const off = subscribeTxNotes(id => seen.push(id));
    try {
      await saveTxNote(ALICE, {k: NONCE, who: 'Bob'}, T0);
      expect(seen).toEqual([ALICE]);
      await saveTxNote(ALICE, {k: '', who: 'Bob'}, T0); // invalid key → skipped silently
      expect(seen).toEqual([ALICE]);
    } finally {
      off();
    }
  });

  it('a listener that throws is contained (one bad subscriber cannot break the save)', async () => {
    const off = subscribeTxNotes(() => { throw new Error('boom'); });
    try {
      await expect(saveTxNote(ALICE, {k: NONCE, who: 'Bob'}, T0)).resolves.toBeUndefined();
      expect(await loadTxNotes(ALICE)).toHaveLength(1); // the write itself still landed
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('txnotes: listener failed'));
    } finally {
      off();
    }
  });
});

describe('mergeTxNote (pure)', () => {
  it('appends without touching existing entries under the cap', () => {
    const a: TxNote = {k: 'aa', who: 'A', at: T0};
    const b: TxNote = {k: 'bb', msg: 'b', at: T0 + 1};
    expect(mergeTxNote([a], b)).toEqual([a, b]);
  });

  it('is idempotent for the same note — saving twice leaves ONE entry', () => {
    const n: TxNote = {k: NONCE, who: 'Bob', msg: 'coffee', at: T0};
    expect(mergeTxNote(mergeTxNote([], n), n)).toEqual([n]);
  });

  it(`evicts the OLDEST once ${MAX_TX_NOTES + 1} distinct keys exist`, () => {
    const entries: TxNote[] = Array.from({length: MAX_TX_NOTES}, (_, i) => ({k: `k${i}`, msg: `m${i}`, at: T0 + i}));
    const merged = mergeTxNote(entries, {k: 'newcomer', who: 'N', at: T0 + MAX_TX_NOTES});
    expect(merged).toHaveLength(MAX_TX_NOTES);
    expect(merged.some(e => e.k === 'k0')).toBe(false); // oldest `at` — and only it — is gone
    expect(merged.some(e => e.k === 'k1')).toBe(true);
    expect(merged.some(e => e.k === 'newcomer')).toBe(true);
  });

  it('the cap also holds through the persisted path (501 real saves load back as 500)', async () => {
    for (let i = 0; i < MAX_TX_NOTES + 1; i++) {
      await saveTxNote(ALICE, {k: `key-${i}`, msg: `m${i}`}, T0 + i);
    }
    const notes = await loadTxNotes(ALICE);
    expect(notes).toHaveLength(MAX_TX_NOTES);
    expect(notes.some(e => e.k === 'key-0')).toBe(false);
    expect(notes.some(e => e.k === `key-${MAX_TX_NOTES}`)).toBe(true);
  });
});

describe('corrupt storage degrades honestly', () => {
  it('malformed JSON loads as an empty list and logs with context', async () => {
    await AsyncStorage.setItem(txNotesKey(ALICE), '[{"k":');
    expect(await loadTxNotes(ALICE)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`txnotes ${txNotesKey(ALICE)} load failed`),
    );
  });

  it('a stored value that parses to a non-array loads as an empty list', async () => {
    await AsyncStorage.setItem(txNotesKey(ALICE), '42');
    expect(salvageTxNotes(42)).toEqual([]);
    expect(salvageTxNotes({k: 'x'})).toEqual([]);
    expect(salvageTxNotes(null)).toEqual([]);
    expect(await loadTxNotes(ALICE)).toEqual([]);
  });

  it('drops malformed entries individually and keeps the valid ones', () => {
    const good1: TxNote = {k: NONCE, who: 'Bob', at: T0 + 1};
    const good2: TxNote = {k: SIG, msg: 'order 42', at: T0 + 2};
    const salvaged = salvageTxNotes([
      good1,
      {k: '', who: 'no identity', at: T0 + 9}, // no join key → unusable
      {k: 'bb', who: 42, at: T0 + 8}, // who is not a string
      {k: 'cc', msg: 'x', at: Number.NaN}, // unusable clock
      'not even an object',
      good2,
    ]);
    expect(salvaged).toEqual([good1, good2]);
    expect(warn).toHaveBeenCalledTimes(4); // one per dropped row, never a whole-store failure
  });

  it('a getItem throw loads as an empty list and logs (never rejects)', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk gone') as never);
    await expect(loadTxNotes(ALICE)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('load failed'));
  });

  it('a setItem throw resolves (never rejects) and logs — a display note must not crash a payment', async () => {
    await saveTxNote(ALICE, {k: NONCE, who: 'Bob'}, T0); // seed a readable store
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full') as never);
    await expect(saveTxNote(ALICE, {k: 'dd', msg: 'x'}, T0 + 1)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('save failed'));
  });
});

describe('txNoteIndex (the read-side lookup)', () => {
  it('normalizes join keys on the way into the map — the one seam both ends meet at', () => {
    const idx = txNoteIndex([{k: NONCE.toUpperCase(), who: 'Bob', at: T0}]);
    // An entry that entered uppercase is found by the LOWERCASE probe annotateTxn makes (the
    // relay echoes lowercase; the write side lowercases too — this closes the loop).
    expect(idx.get(NONCE)?.who).toBe('Bob');
  });
});

describe('annotateTxn (the row resolver — precedence is the contract)', () => {
  const PRINCIPAL = 'nsjm5-jybxu-3hbey-npic6-nbmjf-3ub7i-6zwzc-wibfz-y6dbd-yhqly-xae';
  const SOL_PUBKEY = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  // The row halves the resolver reads (a full Txn satisfies this too — Pick on purpose).
  const icRow = {assetId: 'ic:0', memo: NONCE, nonce: '', counterparty: PRINCIPAL} as const;
  const solRow = {assetId: 'solana:SOL', memo: '', nonce: SIG, counterparty: SOL_PUBKEY} as const;

  it('the payment-time note beats the address-book label, which beats the principal prefix', () => {
    const notes = txNoteIndex([{k: NONCE, who: 'Bob', at: T0}]);
    const labels = new Map([['ic:0', new Map([[PRINCIPAL, 'Saved name']])]]);
    // Note wins over the label…
    expect(annotateTxn(icRow, notes, labels)?.who).toBe('Bob');
    // …and the label alone still names the row when no note exists.
    expect(annotateTxn(icRow, txNoteIndex([]), labels)?.who).toBe('Saved name');
    // With neither, there is NO annotation — the renderer falls back to the row's own principal.
    expect(annotateTxn(icRow, txNoteIndex([]), new Map())).toBeUndefined();
  });

  it('the note\'s message rides along; without one there is nothing to annotate the memo line with', () => {
    const notes = txNoteIndex([{k: NONCE, who: 'Bob', msg: 'coffee', at: T0}]);
    expect(annotateTxn(icRow, notes, new Map())).toEqual({who: 'Bob', msg: 'coffee'});
    // A label-only annotation has no msg — the row keeps its hex memo as the reconciliation ref.
    const labels = new Map([['ic:0', new Map([[PRINCIPAL, 'Saved name']])]]);
    expect(annotateTxn(icRow, txNoteIndex([]), labels)).toEqual({who: 'Saved name'});
  });

  it('joins an IC row by its memo hex, case-insensitively (the relay echoes lowercase)', () => {
    const notes = txNoteIndex([{k: NONCE.toUpperCase(), who: 'Bob', at: T0}]);
    expect(annotateTxn(icRow, notes, new Map())?.who).toBe('Bob');
  });

  it('joins a SOL row by its signature (also normalized on both ends)', () => {
    const notes = txNoteIndex([{k: SIG.toLowerCase(), msg: 'order 42', at: T0}]);
    expect(annotateTxn(solRow, notes, new Map())).toEqual({msg: 'order 42'});
  });

  it('an IC row with no memo has no join key — no annotation, whatever the store holds', () => {
    const noMemo = {assetId: 'ic:0', memo: '', nonce: '', counterparty: PRINCIPAL} as const;
    expect(annotateTxn(noMemo, txNoteIndex([{k: '', who: 'Bob', at: T0}]), new Map())).toBeUndefined();
  });

  it('a label for a DIFFERENT asset or address does not leak into the row', () => {
    const labels = new Map([
      ['ic:2', new Map([[PRINCIPAL, 'wrong asset']])],
      ['ic:0', new Map([['someone-else', 'wrong address']])],
    ]);
    expect(annotateTxn(icRow, txNoteIndex([]), labels)).toBeUndefined();
  });
});
