import {describe, it, expect, beforeEach, afterEach, jest} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadAddressBook,
  rememberAddress,
  forgetAddress,
  addressBookKey,
  MAX_SAVED_ADDRESSES,
  type SavedAddress,
} from '../services/addressBook';

// Per-asset NAMED address book (replaces the single last-used string in services/withdraw.ts). The
// contract under test: MRU order is a pure function of the caller-supplied `nowMs`, an address is a
// unique row (insert-or-update, never duplicated), the book is capped by evicting the oldest, and a
// corrupt blob costs the user at most the corrupt rows — never the whole book, never a crash.
//
// `nowMs` is injected, so every ordering assertion below is exact rather than timing-dependent.

const IC = 'ic:2'; // ckUSDC on the Internet Computer
const SOL = 'solana:SOL'; // the native device-key rail — same store, different namespace

const A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const C = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

const T0 = 1_760_000_000_000;

const addrs = (book: SavedAddress[]) => book.map(e => e.address);

let warn: ReturnType<typeof jest.spyOn>;

beforeEach(async () => {
  await AsyncStorage.clear();
  // Silence + capture the service's warns; several cases assert one was emitted.
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('addressBookKey', () => {
  it('namespaces per asset key under dpay.* with the v1 schema suffix', () => {
    expect(addressBookKey(IC)).toBe('dpay.addrbook.v1.ic:2');
    expect(addressBookKey(SOL)).toBe('dpay.addrbook.v1.solana:SOL');
  });
});

describe('load / remember round-trip', () => {
  it('an asset that was never saved loads as an empty book, silently', async () => {
    expect(await loadAddressBook(IC)).toEqual([]);
    // A first-time user is not an error condition — no warn noise on every wallet open.
    expect(warn).not.toHaveBeenCalled();
  });

  it('remembers an address verbatim with its label and the caller-supplied clock', async () => {
    const returned = await rememberAddress(IC, A, 'Kraken', T0);
    expect(returned).toEqual([{address: A, label: 'Kraken', lastUsedMs: T0}]);
    // The return value is not a lie about what is on disk: a fresh load matches it.
    expect(await loadAddressBook(IC)).toEqual(returned);
  });

  it('accepts an empty label (an unlabelled destination is still worth saving)', async () => {
    await rememberAddress(IC, A, '', T0);
    const book = await loadAddressBook(IC);
    expect(book).toHaveLength(1);
    expect(book[0].label).toBe('');
  });

  it('rejects a caller contract violation instead of persisting a row the reader would drop', async () => {
    await expect(rememberAddress(IC, '', 'Nameless', T0)).rejects.toThrow(/invalid entry/);
    await expect(rememberAddress(IC, A, 'Kraken', Number.NaN)).rejects.toThrow(/invalid entry/);
    await expect(rememberAddress(IC, A, 'Kraken', Number.POSITIVE_INFINITY)).rejects.toThrow(
      /invalid entry/,
    );
    expect(await loadAddressBook(IC)).toEqual([]); // nothing was written
  });
});

describe('MRU ordering', () => {
  it('returns most-recently-used first regardless of insertion order', async () => {
    await rememberAddress(IC, A, 'Kraken', T0 + 1);
    await rememberAddress(IC, B, 'Cold wallet', T0 + 3);
    await rememberAddress(IC, C, 'Mum', T0 + 2);
    expect(addrs(await loadAddressBook(IC))).toEqual([B, C, A]);
  });

  it('re-using an address updates it in place — one row, new label, moved to the front', async () => {
    await rememberAddress(IC, A, 'Kraken', T0 + 1);
    await rememberAddress(IC, B, 'Cold wallet', T0 + 2);
    const book = await rememberAddress(IC, A, 'Kraken main', T0 + 3);

    expect(book).toHaveLength(2); // no duplicate row for A
    expect(book[0]).toEqual({address: A, label: 'Kraken main', lastUsedMs: T0 + 3});
    expect(book[1].address).toBe(B);
    expect(await loadAddressBook(IC)).toEqual(book);
  });
});

describe('cap and eviction', () => {
  it(`evicts the oldest entry once a ${MAX_SAVED_ADDRESSES + 1}th distinct address is saved`, async () => {
    const many = Array.from({length: MAX_SAVED_ADDRESSES + 1}, (_, i) => `addr-${i}`);
    for (const [i, address] of many.entries()) {
      await rememberAddress(IC, address, `dest ${i}`, T0 + i);
    }
    const book = await loadAddressBook(IC);

    expect(book).toHaveLength(MAX_SAVED_ADDRESSES);
    // `addr-0` had the oldest lastUsedMs, so it — and only it — is gone.
    expect(addrs(book)).not.toContain('addr-0');
    expect(addrs(book)).toEqual(many.slice(1).reverse());
  });

  it('a re-used address is rescued from eviction by its bumped lastUsedMs', async () => {
    const many = Array.from({length: MAX_SAVED_ADDRESSES}, (_, i) => `addr-${i}`);
    for (const [i, address] of many.entries()) {
      await rememberAddress(IC, address, `dest ${i}`, T0 + i);
    }
    await rememberAddress(IC, 'addr-0', 'dest 0', T0 + 100); // touch the would-be victim
    const book = await rememberAddress(IC, 'newcomer', 'new', T0 + 101);

    expect(book).toHaveLength(MAX_SAVED_ADDRESSES);
    expect(addrs(book).slice(0, 2)).toEqual(['newcomer', 'addr-0']);
    expect(addrs(book)).not.toContain('addr-1'); // now the oldest, so it is the one evicted
  });
});

describe('forgetAddress', () => {
  it('removes exactly the named address and leaves the rest MRU-ordered', async () => {
    await rememberAddress(IC, A, 'Kraken', T0 + 1);
    await rememberAddress(IC, B, 'Cold wallet', T0 + 2);
    await rememberAddress(IC, C, 'Mum', T0 + 3);

    const book = await forgetAddress(IC, B);
    expect(addrs(book)).toEqual([C, A]);
    expect(await loadAddressBook(IC)).toEqual(book);
  });

  it('logs and leaves the book untouched when the address is not in it', async () => {
    await rememberAddress(IC, A, 'Kraken', T0 + 1);
    const book = await forgetAddress(IC, C);
    expect(addrs(book)).toEqual([A]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nothing removed'));
  });
});

describe('corrupt storage degrades honestly', () => {
  it('malformed JSON loads as an empty book and logs with context', async () => {
    await AsyncStorage.setItem(addressBookKey(IC), '[{"address":');
    expect(await loadAddressBook(IC)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`address book ${addressBookKey(IC)} load failed`),
      expect.any(String),
    );
  });

  it('a stored value that is not an array loads as an empty book and logs', async () => {
    await AsyncStorage.setItem(addressBookKey(IC), '{"address":"0x1"}');
    expect(await loadAddressBook(IC)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('expected an array'));
  });

  it('drops malformed entries individually and keeps the valid ones', async () => {
    await AsyncStorage.setItem(
      addressBookKey(IC),
      JSON.stringify([
        {address: A, label: 'Kraken', lastUsedMs: T0 + 1},
        {address: '', label: 'empty address', lastUsedMs: T0 + 9}, // no identity → unusable
        {address: B, label: 42, lastUsedMs: T0 + 8}, // label is not a string
        {address: C, lastUsedMs: null}, // no label, unusable clock
        'not even an object',
        {address: B, label: 'Cold wallet', lastUsedMs: T0 + 2},
      ]),
    );
    const book = await loadAddressBook(IC);
    expect(book).toEqual([
      {address: B, label: 'Cold wallet', lastUsedMs: T0 + 2},
      {address: A, label: 'Kraken', lastUsedMs: T0 + 1},
    ]);
    expect(warn).toHaveBeenCalledTimes(4); // one per dropped row, never a whole-book failure
  });

  it('a getItem throw loads as an empty book and logs (never rejects)', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk gone') as never);
    await expect(loadAddressBook(IC)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('load failed:'), 'disk gone');
  });

  it('a setItem throw still returns the intended book and logs (never rejects)', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full') as never);
    await expect(rememberAddress(IC, A, 'Kraken', T0)).resolves.toEqual([
      {address: A, label: 'Kraken', lastUsedMs: T0},
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('save failed:'), 'disk full');
  });
});

describe('per-asset isolation', () => {
  it('two asset keys keep independent books (the SOL rail shares the store, not the rows)', async () => {
    await rememberAddress(IC, A, 'Kraken', T0 + 1);
    await rememberAddress(SOL, 'So11111111111111111111111111111111111111112', 'Phantom', T0 + 2);

    expect(addrs(await loadAddressBook(IC))).toEqual([A]);
    expect(addrs(await loadAddressBook(SOL))).toEqual([
      'So11111111111111111111111111111111111111112',
    ]);
    await forgetAddress(IC, A);
    expect(await loadAddressBook(SOL)).toHaveLength(1); // deleting one asset's row spares the other
  });
});
