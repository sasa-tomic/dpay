import {describe, it, expect} from '@jest/globals';
import {
  decideSolPayerReceiptV2,
  isSolReqV2Expired,
  decideUsdcAtaGate,
} from '../solana/payments';
import type {SolPayerOutcomeV2, SolReceiptV2, UsdcAtaStatus} from '../solana/payments';

// =============================================================================================
// Phase 1 v2 receipt outcome + request-lifetime logic — replaces the v1 durable-nonce receipt
// (npub+nextNonce) model with a rid+sig matcher. The merchant's broadcast returns
// {status, rid, sig}; the payer believes it ONLY when both rid and the expected transaction
// signature match exactly. A mismatch is 'ignore' (the receipt answers a different payment). An
// unknown status code (or any value other than 0/1/2) is honest-unknown pending — never a false
// success or failure.
//
// rid compare is exact case-sensitive hex (the codec emits lowercase, so case-sensitivity is mostly
// moot but still locked in). sig compare is exact case-sensitive base58 (base58 case is semantic).
// =============================================================================================

const MY_RID = '0123456789abcdef0123456789abcdef';
const OTHER_RID = 'fedcba9876543210fedcba9876543210';
const MY_SIG = '5LJx7Qq5jZfVd6N9u3y1ZsQwKpX8mB2vRgYAtoFqHnC4eUjTt8s9rB2nXy1ZmKqLp';
const OTHER_SIG = '2vRgYAtoFqHnC4eUjTt8s9rB2nXy1ZmKqLp5LJx7Qq5jZfVd6N9u3y1ZsQwKpX8mB';

describe('decideSolPayerReceiptV2 — SOL receipt outcome (rid + sig matcher)', () => {
  it('status=0 settled + rid AND sig match → success', () => {
    const r: SolReceiptV2 = {status: 0, rid: MY_RID, sig: MY_SIG};
    const o = decideSolPayerReceiptV2(r, MY_RID, MY_SIG);
    expect(o).toEqual({outcome: 'success'});
  });

  it('status=1 rejected + rid AND sig match → declined', () => {
    const r: SolReceiptV2 = {status: 1, rid: MY_RID, sig: MY_SIG};
    const o = decideSolPayerReceiptV2(r, MY_RID, MY_SIG);
    expect(o.outcome).toBe('declined');
  });

  it('status=2 unknown + rid AND sig match → pending (honest unknown)', () => {
    const r: SolReceiptV2 = {status: 2, rid: MY_RID, sig: MY_SIG};
    const o = decideSolPayerReceiptV2(r, MY_RID, MY_SIG);
    expect(o.outcome).toBe('pending');
  });

  it('rid mismatch → ignore (receipt for a different payment)', () => {
    const r: SolReceiptV2 = {status: 0, rid: OTHER_RID, sig: MY_SIG};
    const o = decideSolPayerReceiptV2(r, MY_RID, MY_SIG);
    expect(o.outcome).toBe('ignore');
  });

  it('sig mismatch → ignore (receipt for a different payment)', () => {
    const r: SolReceiptV2 = {status: 0, rid: MY_RID, sig: OTHER_SIG};
    const o = decideSolPayerReceiptV2(r, MY_RID, MY_SIG);
    expect(o.outcome).toBe('ignore');
  });

  it('any unknown status code (not 0/1/2) → pending (honest unknown, never false success)', () => {
    const r = {status: 99, rid: MY_RID, sig: MY_SIG} as unknown as SolReceiptV2;
    const o = decideSolPayerReceiptV2(r, MY_RID, MY_SIG);
    expect(o.outcome).toBe('pending');
  });

  it('rid compare is exact case-sensitive hex (uppercase rid is a different rid)', () => {
    // The codec emits lowercase hex; uppercase is a different rid here even though it would have
    // failed decode. Locks in the exact compare and guards against a future toLowerCase() regression.
    const r = {status: 0, rid: MY_RID.toUpperCase(), sig: MY_SIG} as unknown as SolReceiptV2;
    const o = decideSolPayerReceiptV2(r, MY_RID, MY_SIG);
    expect(o.outcome).toBe('ignore');
  });

  it('sig compare is exact case-sensitive base58 (case change is a different signature)', () => {
    // Base58 has no case-insensitivity — lowercasing a base58 string changes its bytes. The signature
    // is the unique payment identity; this guards against a future normalize-and-compare regression.
    const r = {status: 0, rid: MY_RID, sig: MY_SIG.toLowerCase()} as unknown as SolReceiptV2;
    const o = decideSolPayerReceiptV2(r, MY_RID, MY_SIG);
    expect(o.outcome).toBe('ignore');
  });

  it('empty expectedRid → ignore (defensive: nothing to bind to)', () => {
    const r: SolReceiptV2 = {status: 0, rid: MY_RID, sig: MY_SIG};
    const o = decideSolPayerReceiptV2(r, '', MY_SIG);
    expect(o.outcome).toBe('ignore');
  });

  it('empty expectedSig → ignore (defensive: nothing to bind to)', () => {
    const r: SolReceiptV2 = {status: 0, rid: MY_RID, sig: MY_SIG};
    const o = decideSolPayerReceiptV2(r, MY_RID, '');
    expect(o.outcome).toBe('ignore');
  });

  it('every settled/unknown/rejected code maps to exactly one outcome when rid+sig match', () => {
    for (const status of [0, 1, 2] as const) {
      const o = decideSolPayerReceiptV2({status, rid: MY_RID, sig: MY_SIG}, MY_RID, MY_SIG);
      expect(['success', 'declined', 'pending']).toContain(o.outcome);
    }
  });
});

// Type-level guard: the success/declined/pending variants carry no extra data; only 'ignore' is
// distinct. This is the contract Phase 4's UI will rely on.
describe('SolPayerOutcomeV2 — type contract', () => {
  it('success carries no extra field (no adoptNonce — the v2 payer has nothing to adopt)', () => {
    const o: SolPayerOutcomeV2 = {outcome: 'success'};
    expect(o).toEqual({outcome: 'success'});
  });

  it('declined carries no extra field', () => {
    const o: SolPayerOutcomeV2 = {outcome: 'declined'};
    expect(o.outcome).toBe('declined');
  });

  it('pending carries no extra field', () => {
    const o: SolPayerOutcomeV2 = {outcome: 'pending'};
    expect(o.outcome).toBe('pending');
  });

  it('ignore carries no extra field', () => {
    const o: SolPayerOutcomeV2 = {outcome: 'ignore'};
    expect(o.outcome).toBe('ignore');
  });
});

// =============================================================================================
// isSolReqV2Expired — request lifetime + advisory lifetime cap. Contract: a request is valid
// THROUGH its expiry second (Math.floor(nowMs/1000) <= exp ⇒ NOT expired). Advisory cap: if the
// declared lifetime exceeds the protocol maximum (exp > iat + 90), the request is treated as
// expired (an offline clock can be wrong, but the payer still refuses).
// =============================================================================================
describe('isSolReqV2Expired — request lifetime boundary + advisory cap', () => {
  it('a fresh request (exp well in the future) is NOT expired', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isSolReqV2Expired({iat: now, exp: now + 60})).toBe(false);
  });

  it('a request whose expiry is in the past IS expired', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isSolReqV2Expired({iat: now - 120, exp: now - 60})).toBe(true);
  });

  it('exact boundary: nowSecs == exp → NOT expired (valid through its expiry second)', () => {
    expect(isSolReqV2Expired({iat: 1000, exp: 1060}, 1060_000)).toBe(false);
  });

  it('one second past expiry → expired', () => {
    expect(isSolReqV2Expired({iat: 1000, exp: 1060}, 1061_000)).toBe(true);
  });

  it('one second before expiry → NOT expired', () => {
    expect(isSolReqV2Expired({iat: 1000, exp: 1060}, 1059_000)).toBe(false);
  });

  it('advisory cap: exp > iat + 90 is treated as expired (even if not yet past exp)', () => {
    // The clock says we're inside the window, but the declared lifetime exceeds the protocol max.
    // The payer refuses — an offline clock can be wrong, but the producer of such a request is broken
    // or hostile.
    expect(isSolReqV2Expired({iat: 1000, exp: 1100}, 1050_000)).toBe(true); // 100s window > 90
  });

  it('advisory cap boundary: exp == iat + 90 is NOT expired (within the window)', () => {
    expect(isSolReqV2Expired({iat: 1000, exp: 1090}, 1050_000)).toBe(false);
  });
});

// =============================================================================================
// F4 (Phase 4) — fail-closed USDC ATA gate. UNCHANGED from v1; tested again here to lock the
// contract in place across the v2 codec rewrite.
// =============================================================================================
describe('decideUsdcAtaGate (fail-closed USDC ATA gate — unchanged across the v2 rewrite)', () => {
  it('present + online → allowed (the ONLY allow cell)', () => {
    expect(decideUsdcAtaGate('present', true).allowed).toBe(true);
  });

  it('absent + online → blocked, NOT retryable', () => {
    const g = decideUsdcAtaGate('absent', true);
    if (g.allowed) throw new Error('expected blocked');
    expect(g.reason).toBe('absent');
    expect(g.retryable).toBe(false);
    expect(g.message).toMatch(/USDC account/i);
  });

  it('checking + online → blocked, not retryable', () => {
    const g = decideUsdcAtaGate('checking', true);
    if (g.allowed) throw new Error('expected blocked');
    expect(g.reason).toBe('checking');
    expect(g.retryable).toBe(false);
  });

  it('unknown + online → BLOCKED + RETRYABLE (fail-closed — was previously allowed)', () => {
    const g = decideUsdcAtaGate('unknown', true);
    if (g.allowed) throw new Error('expected blocked — unknown must NOT fall through to allow');
    expect(g.reason).toBe('unverified');
    expect(g.retryable).toBe(true);
    expect(g.message).toMatch(/couldn't verify/i);
  });

  it('offline → blocked with reason "offline" regardless of cached status (offline dominates)', () => {
    for (const status of ['present', 'absent', 'checking', 'unknown'] as UsdcAtaStatus[]) {
      const g = decideUsdcAtaGate(status, false);
      if (g.allowed) throw new Error(`expected blocked for status=${status} when offline`);
      expect(g.reason).toBe('offline');
      expect(g.retryable).toBe(false);
    }
  });
});
