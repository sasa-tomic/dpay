import {describe, it, expect, beforeEach, jest} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {encodeSolReq, type SolReqV2} from '../solana/qr';
import {
  loadSolMerchantState,
  saveSolMerchantState,
  clearSolMerchantState,
  hydrateSolMerchantState,
  solMerchantKey,
  type SolMerchantRequestState,
} from '../services/solMerchantPersist';

// Merchant-side durable request state for the v2 recent-blockhash SOL payment path (invariants #10,
// #11, #12). The merchant creates a SolReqV2 ONLINE, shows the QR/NFC, the payer signs OFFLINE, and
// the merchant broadcasts. The open request + any atomically-reserved accepted tx MUST survive
// restart so the merchant can reconcile. A CORRUPT blob must NEVER be used to display a stale QR or
// rebroadcast a corrupt tx — `hydrateSolMerchantState` returns null for any malformed value so the
// caller discards it + starts fresh (fail-closed).
//
// Mirrors sol-nonce-persist.test.ts: best-effort CRUD (never throws on storage glitch) + the pure
// hydrate reducer probed at every corruption boundary.

const PUBKEY = 'a'.repeat(64); // 32-byte Ed25519 device pubkey as hex (the merchant's identity)
const MERCHANT = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJ8qZnxnWUqiLT92r';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MERCHANT_USDC_ATA = 'C9dhv75Qeu2NLrEprtNNMageKX6z2bsysrdRTNFB3nbk';
const BLOCKHASH = 'GZXyfzSTCBmA7rpeDLrmUbiSA45H5EEwJhoBeR6ZNb3u';
const RID = '0123456789abcdef0123456789abcdef'; // 32 lowercase hex (16 random bytes)

const SOL_REQ: SolReqV2 = {
  v: 2,
  rid: RID,
  net: 'mainnet-beta',
  bh: BLOCKHASH,
  lvh: 300_000_000,
  slot: 290_000_000,
  iat: 1_760_000_000,
  exp: 1_760_000_060,
  to: MERCHANT,
  amt: '2000000',
  cur: 'SOL',
  mint: null,
  toAta: null,
  name: 'Cafe Sol',
  memo: 'table 7',
};

const SOL_REQ_URI = encodeSolReq({
  rid: SOL_REQ.rid, net: SOL_REQ.net, bh: SOL_REQ.bh, lvh: SOL_REQ.lvh, slot: SOL_REQ.slot,
  iat: SOL_REQ.iat, exp: SOL_REQ.exp, to: SOL_REQ.to, amt: SOL_REQ.amt, cur: SOL_REQ.cur,
  mint: null, toAta: null, name: SOL_REQ.name, memo: SOL_REQ.memo,
});

const OPEN: SolMerchantRequestState = {
  req: SOL_REQ,
  uri: SOL_REQ_URI,
  acceptedSignature: null,
  acceptedTx: null,
  outcome: 'open',
};

const BROADCASTING: SolMerchantRequestState = {
  req: SOL_REQ,
  uri: SOL_REQ_URI,
  acceptedSignature: 'sigABC',
  acceptedTx: 'AAAA',
  outcome: 'broadcasting',
};

beforeEach(() => {
  AsyncStorage.clear();
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// storage key
// ────────────────────────────────────────────────────────────────────────────────────────────
describe('solMerchantKey', () => {
  it('namespaces per-merchant pubkey with the v1 schema suffix', () => {
    expect(solMerchantKey(PUBKEY)).toBe(`dpay.sol.merchant.v1.${PUBKEY}`);
  });
  it('different pubkeys produce different keys', () => {
    expect(solMerchantKey('a'.repeat(64))).not.toBe(solMerchantKey('b'.repeat(64)));
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// CRUD round-trip (load / save / clear)
// ────────────────────────────────────────────────────────────────────────────────────────────
describe('load / save / clear', () => {
  it('returns null when no state exists', async () => {
    expect(await loadSolMerchantState(PUBKEY)).toBeNull();
  });

  it('round-trips an open state (no accepted payment yet)', async () => {
    await saveSolMerchantState(PUBKEY, OPEN);
    const loaded = await loadSolMerchantState(PUBKEY);
    expect(loaded).not.toBeNull();
    expect(loaded!.outcome).toBe('open');
    expect(loaded!.req.rid).toBe(RID);
    expect(loaded!.uri).toBe(SOL_REQ_URI);
    expect(loaded!.acceptedSignature).toBeNull();
    expect(loaded!.acceptedTx).toBeNull();
  });

  it('round-trips a broadcasting state (accepted tx reserved)', async () => {
    await saveSolMerchantState(PUBKEY, BROADCASTING);
    const loaded = await loadSolMerchantState(PUBKEY);
    expect(loaded).toEqual(BROADCASTING);
  });

  it('clear removes the state', async () => {
    await saveSolMerchantState(PUBKEY, OPEN);
    await clearSolMerchantState(PUBKEY);
    expect(await loadSolMerchantState(PUBKEY)).toBeNull();
  });

  it('namespaces states per merchant pubkey', async () => {
    await saveSolMerchantState(PUBKEY, OPEN);
    const other = 'b'.repeat(64);
    expect(await loadSolMerchantState(other)).toBeNull();
  });

  it('every outcome value round-trips', async () => {
    for (const outcome of ['open', 'broadcasting', 'settled', 'rejected', 'unknown'] as const) {
      await saveSolMerchantState(PUBKEY, {...OPEN, outcome});
      const loaded = await loadSolMerchantState(PUBKEY);
      expect(loaded!.outcome).toBe(outcome);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// best-effort: never throws on a storage glitch
// ────────────────────────────────────────────────────────────────────────────────────────────
describe('best-effort (never throws)', () => {
  it('load swallows a getItem throw → null', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk gone'));
    await expect(loadSolMerchantState(PUBKEY)).resolves.toBeNull();
  });

  it('save swallows a setItem throw (does not reject)', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    await expect(saveSolMerchantState(PUBKEY, OPEN)).resolves.toBeUndefined();
  });

  it('clear swallows a removeItem throw (does not reject)', async () => {
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('disk gone'));
    await expect(clearSolMerchantState(PUBKEY)).resolves.toBeUndefined();
  });

  it('load swallows malformed JSON → null', async () => {
    await AsyncStorage.setItem(solMerchantKey(PUBKEY), '{not json');
    await expect(loadSolMerchantState(PUBKEY)).resolves.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// hydrateSolMerchantState — the pure fail-closed reducer
// ────────────────────────────────────────────────────────────────────────────────────────────
describe('hydrateSolMerchantState', () => {
  const wrap = (state: unknown) => ({schema: 1, state});

  it('hydrates a valid open state', () => {
    expect(hydrateSolMerchantState(wrap(OPEN))).toEqual(OPEN);
  });

  it('hydrates a valid broadcasting state with accepted tx', () => {
    expect(hydrateSolMerchantState(wrap(BROADCASTING))).toEqual(BROADCASTING);
  });

  it('returns null for non-object input', () => {
    expect(hydrateSolMerchantState(null)).toBeNull();
    expect(hydrateSolMerchantState('string')).toBeNull();
    expect(hydrateSolMerchantState(42)).toBeNull();
    expect(hydrateSolMerchantState(undefined)).toBeNull();
  });

  it('returns null for a wrong schema version', () => {
    expect(hydrateSolMerchantState({schema: 2, state: OPEN})).toBeNull();
    expect(hydrateSolMerchantState({schema: 0, state: OPEN})).toBeNull();
  });

  it('returns null for a missing schema field', () => {
    expect(hydrateSolMerchantState({state: OPEN})).toBeNull();
  });

  it('returns null for a missing/invalid state object', () => {
    expect(hydrateSolMerchantState(wrap(null))).toBeNull();
    expect(hydrateSolMerchantState(wrap('string'))).toBeNull();
  });

  it('returns null for an invalid outcome', () => {
    expect(hydrateSolMerchantState(wrap({...OPEN, outcome: 'done'}))).toBeNull();
    expect(hydrateSolMerchantState(wrap({...OPEN, outcome: ''}))).toBeNull();
  });

  it('returns null when the uri is not a solreq:v2 URI', () => {
    expect(hydrateSolMerchantState(wrap({...OPEN, uri: 'solreq:v1?abc'}))).toBeNull();
    expect(hydrateSolMerchantState(wrap({...OPEN, uri: 'https://x'}))).toBeNull();
    expect(hydrateSolMerchantState(wrap({...OPEN, uri: ''}))).toBeNull();
  });

  it('returns null when acceptedSignature is a non-string non-null', () => {
    expect(hydrateSolMerchantState(wrap({...OPEN, acceptedSignature: 42}))).toBeNull();
  });

  it('returns null when acceptedTx is a non-string non-null', () => {
    expect(hydrateSolMerchantState(wrap({...OPEN, acceptedTx: true}))).toBeNull();
  });

  // req structural validation — every field probed
  it('returns null when req is missing', () => {
    expect(hydrateSolMerchantState(wrap({...OPEN, req: null}))).toBeNull();
  });

  it('returns null when req.v is not 2', () => {
    expect(hydrateSolMerchantState(wrap({...OPEN, req: {...SOL_REQ, v: 1}}))).toBeNull();
  });

  it('returns null when req.rid is empty or missing', () => {
    expect(hydrateSolMerchantState(wrap({...OPEN, req: {...SOL_REQ, rid: ''}}))).toBeNull();
    expect(hydrateSolMerchantState(wrap({...OPEN, req: {...SOL_REQ, rid: undefined}}))).toBeNull();
  });

  it('returns null when req.bh is empty or missing', () => {
    expect(hydrateSolMerchantState(wrap({...OPEN, req: {...SOL_REQ, bh: ''}}))).toBeNull();
  });

  it('returns null when req.to is empty or missing', () => {
    expect(hydrateSolMerchantState(wrap({...OPEN, req: {...SOL_REQ, to: ''}}))).toBeNull();
  });

  it('returns null when req.amt is empty or missing', () => {
    expect(hydrateSolMerchantState(wrap({...OPEN, req: {...SOL_REQ, amt: ''}}))).toBeNull();
  });

  it('returns null when req.cur is not SOL/USDC', () => {
    expect(hydrateSolMerchantState(wrap({...OPEN, req: {...SOL_REQ, cur: 'BTC'}}))).toBeNull();
  });

  it('returns null when numeric req fields are wrong type', () => {
    expect(hydrateSolMerchantState(wrap({...OPEN, req: {...SOL_REQ, lvh: 'x'}}))).toBeNull();
    expect(hydrateSolMerchantState(wrap({...OPEN, req: {...SOL_REQ, slot: true}}))).toBeNull();
    expect(hydrateSolMerchantState(wrap({...OPEN, req: {...SOL_REQ, iat: 'x'}}))).toBeNull();
    expect(hydrateSolMerchantState(wrap({...OPEN, req: {...SOL_REQ, exp: null}}))).toBeNull();
  });

  it('returns null when mint/toAta are wrong type', () => {
    expect(hydrateSolMerchantState(wrap({...OPEN, req: {...SOL_REQ, mint: 42}}))).toBeNull();
    expect(hydrateSolMerchantState(wrap({...OPEN, req: {...SOL_REQ, toAta: true}}))).toBeNull();
  });

  it('hydrates a valid USDC request (mint + toAta present)', () => {
    const usdcReq: SolReqV2 = {
      ...SOL_REQ,
      cur: 'USDC',
      mint: USDC_MINT,
      toAta: MERCHANT_USDC_ATA,
    };
    const usdcUri = encodeSolReq({
      rid: usdcReq.rid, net: usdcReq.net, bh: usdcReq.bh, lvh: usdcReq.lvh, slot: usdcReq.slot,
      iat: usdcReq.iat, exp: usdcReq.exp, to: usdcReq.to, amt: usdcReq.amt, cur: 'USDC',
      mint: USDC_MINT, toAta: MERCHANT_USDC_ATA, name: usdcReq.name, memo: usdcReq.memo,
    });
    const state: SolMerchantRequestState = {
      req: usdcReq,
      uri: usdcUri,
      acceptedSignature: null,
      acceptedTx: null,
      outcome: 'open',
    };
    expect(hydrateSolMerchantState(wrap(state))).toEqual(state);
  });
});
