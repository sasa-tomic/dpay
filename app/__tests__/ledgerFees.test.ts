/**
 * ledgerFees — the LOCAL half of the fee-display chain (founder rule 2026-09-14).
 *
 * The payer reads the GROSS (typed price = wire + fee) on every netted request payment, and is
 * OFFLINE exactly when the live icrc1_fee query cannot run — so these tests pin the store that
 * keeps that display honest with no network:
 *   - a remembered fee round-trips per LEDGER (the store is global: a fee is a property of the
 *     ledger, not of the wallet that asked), and a re-answer replaces it;
 *   - a corrupt blob costs at most its corrupt entries (per-entry salvage, the txNotes
 *     convention) — never the whole store, never a crash;
 *   - nothing here ever throws at a payment flow (reads degrade to null, writes are swallowed);
 *   - the fallback chain is cache-then-catalog, with the catalog the last local word.
 *
 * The LIVE answer's precedence over both local answers is the SEAMS' contract (PayMode.test.tsx,
 * nfc-approve-review.test.tsx); the signing invariant (live only, never a cached fee in a
 * signature) is rail.ts's own. AsyncStorage is the official in-memory jest mock.
 */
import {describe, it, expect, beforeEach, afterEach, jest} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  LEDGER_FEES_KEY,
  rememberLedgerFee,
  cachedLedgerFee,
  catalogLedgerFee,
  fallbackLedgerFee,
  salvageLedgerFees,
} from '../services/ledgerFees';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';

const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CATALOG = icpCatalogOf(BUNDLED_NETWORKS); // the real bundled rows: VCHF/ICP '10000', ckBTC '10' (MEASURED 2026-09-18), DEMO null

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.spyOn(console, 'warn').mockImplementation(() => {}); // corruption tests warn by design
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('ledgerFees — persistence (the write-through rail performs)', () => {
  it('round-trips one ledger fee: remember → cached', async () => {
    await rememberLedgerFee(VCHF_LEDGER, '10000');
    await expect(cachedLedgerFee(VCHF_LEDGER)).resolves.toBe('10000');
  });

  it('merges across ledgers and replaces on a re-answer (the latest live word wins)', async () => {
    await rememberLedgerFee(VCHF_LEDGER, '10000');
    await rememberLedgerFee(ICP_LEDGER, '10000');
    await expect(cachedLedgerFee(VCHF_LEDGER)).resolves.toBe('10000');
    await expect(cachedLedgerFee(ICP_LEDGER)).resolves.toBe('10000');
    await rememberLedgerFee(VCHF_LEDGER, '20000'); // the ledger changed its fee
    await expect(cachedLedgerFee(VCHF_LEDGER)).resolves.toBe('20000');
    await expect(cachedLedgerFee(ICP_LEDGER)).resolves.toBe('10000'); // sibling untouched
  });

  it('an unknown or empty ledger reads null — no cache is no answer, never a default', async () => {
    await rememberLedgerFee(VCHF_LEDGER, '10000');
    await expect(cachedLedgerFee('aaaaa-aa')).resolves.toBeNull();
    await expect(cachedLedgerFee('')).resolves.toBeNull();
  });

  it('refuses to cache a non-digit fee (a producer bug, not a cacheable answer)', async () => {
    await rememberLedgerFee(VCHF_LEDGER, '0.0001'); // formatted/decimal — not a raw amount
    await rememberLedgerFee('', '10000'); // no ledger at all
    await expect(cachedLedgerFee(VCHF_LEDGER)).resolves.toBeNull();
    await expect(AsyncStorage.getItem(LEDGER_FEES_KEY)).resolves.toBeNull(); // nothing persisted
  });

  it('a failing write never throws at the caller — the payment flow is untouched', async () => {
    await expect(rememberLedgerFee(VCHF_LEDGER, '10000')).resolves.toBeUndefined(); // baseline: persists
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('quota'));
    await expect(rememberLedgerFee(ICP_LEDGER, '10000')).resolves.toBeUndefined(); // swallowed, logged
    await expect(cachedLedgerFee(ICP_LEDGER)).resolves.toBeNull(); // the failed write left no trace
    await expect(cachedLedgerFee(VCHF_LEDGER)).resolves.toBe('10000'); // the store it raced survives
  });
});

describe('ledgerFees — corruption tolerance (per-entry salvage, the txNotes convention)', () => {
  it('corrupt JSON degrades to an empty store, not a crash', async () => {
    await AsyncStorage.setItem(LEDGER_FEES_KEY, '{not json');
    await expect(cachedLedgerFee(VCHF_LEDGER)).resolves.toBeNull();
  });

  it('one malformed entry is dropped individually — its siblings keep their answers', async () => {
    await AsyncStorage.setItem(LEDGER_FEES_KEY, JSON.stringify({
      [VCHF_LEDGER]: {fee: '10000', at: 1},
      'bad-decimals': {fee: '0.0001', at: 2}, // formatted string, not raw digits
      'bad-missing-at': {fee: '10000'}, // no freshness stamp
      'bad-number-fee': {fee: 10000, at: 3}, // number, not string
      'bad-string-entry': '10000', // not an entry at all
      '': {fee: '10000', at: 4}, // unkeyable
    }));
    await expect(cachedLedgerFee(VCHF_LEDGER)).resolves.toBe('10000'); // the good one survives
    for (const k of ['bad-decimals', 'bad-missing-at', 'bad-number-fee', 'bad-string-entry']) {
      await expect(cachedLedgerFee(k)).resolves.toBeNull();
    }
  });

  it('salvageLedgerFees (pure): non-objects have no salvageable entries', () => {
    expect(salvageLedgerFees(null)).toStrictEqual({});
    expect(salvageLedgerFees('nope')).toStrictEqual({});
    expect(salvageLedgerFees([1, 2])).toStrictEqual({});
    expect(salvageLedgerFees({ok: {fee: '7', at: 9}})).toStrictEqual({ok: {fee: '7', at: 9}});
  });

  it('a failing read degrades to null — an unreadable cache is no cache', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage'));
    await expect(cachedLedgerFee(VCHF_LEDGER)).resolves.toBeNull();
  });
});

describe('ledgerFees — catalogLedgerFee (pure lookup of the bundled row)', () => {
  it('returns the real bundled fees: VCHF/ICP 10000 raw, ckBTC 10 (MEASURED 2026-09-18 icrc1_fee)', () => {
    expect(catalogLedgerFee(CATALOG, 7)).toBe('10000');
    expect(catalogLedgerFee(CATALOG, 8)).toBe('10000');
    expect(catalogLedgerFee(CATALOG, 1)).toBe('10'); // 10 sats — the live ckBTC ledger fee
  });

  it('returns null for rows that register no fee and for unknown currencies', () => {
    expect(catalogLedgerFee(CATALOG, 0)).toBeNull(); // DEMO is play money
    expect(catalogLedgerFee(CATALOG, 99)).toBeNull(); // unknown id — fail closed
  });

  it('rejects a malformed fee string at the shape gate (never a formatted number)', () => {
    expect(catalogLedgerFee([{currency: 5, fee: '0.0001'}], 5)).toBeNull();
    expect(catalogLedgerFee([{currency: 5, fee: null}], 5)).toBeNull();
  });
});

describe('ledgerFees — fallbackLedgerFee (the local chain: cache, then catalog)', () => {
  it('the persisted ledger fee beats the catalog row — its own past answer is the better word', async () => {
    await rememberLedgerFee(VCHF_LEDGER, '20000');
    await expect(fallbackLedgerFee(VCHF_LEDGER, CATALOG, 7)).resolves.toBe('20000');
  });

  it('no cache → the drift-alarmed catalog row stands in', async () => {
    await expect(fallbackLedgerFee(VCHF_LEDGER, CATALOG, 7)).resolves.toBe('10000');
  });

  it('neither source knows → null (the seam then shows the wire — the honest last resort)', async () => {
    await expect(fallbackLedgerFee('aaaaa-aa', CATALOG, 0)).resolves.toBeNull(); // DEMO registers no fee
    await expect(fallbackLedgerFee('aaaaa-aa', CATALOG, 99)).resolves.toBeNull(); // unknown currency
  });

  it('never rejects — a storage failure falls through to the catalog, never crashes a payment', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage'));
    await expect(fallbackLedgerFee(VCHF_LEDGER, CATALOG, 7)).resolves.toBe('10000');
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValue(new Error('storage'));
    await expect(fallbackLedgerFee(VCHF_LEDGER, [], 7)).resolves.toBeNull(); // no catalog either
  });
});
