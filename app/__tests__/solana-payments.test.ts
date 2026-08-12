import {describe, it, expect} from '@jest/globals';
import {decideSolPayerReceipt, isSolReqExpired, solpayMatchesReq, decideUsdcAtaGate} from '../solana/payments';
import type {SolPayerOutcome, UsdcAtaStatus} from '../solana/payments';
import {RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE} from '../payments';

// U7 — the SOL receipt-nonce-relay outcome logic (the analog of payments.ts:decidePayerReceipt, but
// for Solana's durable-nonce model). The merchant hands back a SolReceipt {status, npub, nextNonce,
// sig} after broadcasting the payer's offline-signed tx. The payer decides:
//   - settled + npub is mine → SUCCESS + adopt nextNonce (the receipt-nonce-relay win: the NEXT
//     offline payment needs NO online resync — the handed-back value IS the new on-chain current).
//   - rejected + npub is mine → DECLINED (definitive broadcast failure; mark the nonce stale).
//   - unreachable + npub is mine → PENDING (honest "couldn't confirm"; keep the value — the tx MAY
//     still land; the next broadcast is the truth-check).
//   - npub is NOT mine → IGNORE (the receipt answers a different payment; do not act on it).
//
// The binding key is the payer's nonce ACCOUNT pubkey (npub) — STABLE across advances (the account
// is created once; only its stored value rotates). This is the SOL analog of the IC nonce compare,
// but base58 is CASE-SENSITIVE (unlike hex) so the compare is exact, NOT lowercased.

const MY_NPUB = 'GZXyfzSTCBmA7rpeDLrmUbiSA45H5EEwJhoBeR6ZNb3u';
const OTHER_NPUB = 'HedniqrC67EqZD68nxfBXv6pp6DFRiL8WLgFPx5izMnV';
const NEXT_NONCE = '9otJS8smVKNb1SyjTUEFtYJzjB4ASKA8Pvk8Z5wiKcpV';

describe('decideSolPayerReceipt — SOL receipt outcome (receipt-nonce-relay)', () => {
  it('settled + npub matches → success + adopt nextNonce', () => {
    const o = decideSolPayerReceipt(
      {status: RECEIPT_SETTLED, npub: MY_NPUB, nextNonce: NEXT_NONCE, sig: 'sig123'},
      MY_NPUB,
    );
    expect(o).toEqual({outcome: 'success', adoptNonce: NEXT_NONCE});
  });

  it('rejected + npub matches → declined', () => {
    const o = decideSolPayerReceipt(
      {status: RECEIPT_REJECTED, npub: MY_NPUB, nextNonce: null, sig: null},
      MY_NPUB,
    );
    expect(o.outcome).toBe('declined');
  });

  it('unreachable + npub matches → pending (keep value; tx may still land)', () => {
    const o = decideSolPayerReceipt(
      {status: RECEIPT_UNREACHABLE, npub: MY_NPUB, nextNonce: null, sig: null},
      MY_NPUB,
    );
    expect(o.outcome).toBe('pending');
  });

  it('npub mismatch → ignore (receipt for a different payment)', () => {
    const o = decideSolPayerReceipt(
      {status: RECEIPT_SETTLED, npub: OTHER_NPUB, nextNonce: NEXT_NONCE, sig: 'sig'},
      MY_NPUB,
    );
    expect(o.outcome).toBe('ignore');
  });

  it('settled + npub matches BUT nextNonce is null → success with null adoptNonce (resync needed)', () => {
    // Defensive edge: the payment DID settle (funds moved) but the merchant couldn't read the new
    // nonce value (getNonceAccount failed after confirm). The payer shows "Paid ✓" but must resync
    // before the next offline sign — adoptNonce:null signals "settled, can't adopt, resync".
    const o = decideSolPayerReceipt(
      {status: RECEIPT_SETTLED, npub: MY_NPUB, nextNonce: null, sig: 'sig'},
      MY_NPUB,
    );
    expect(o).toEqual({outcome: 'success', adoptNonce: null});
  });

  it('base58 npub compare is CASE-SENSITIVE (unlike hex) — different case is a different address', () => {
    // Base58 has no case-insensitivity: 'GZXy...' ≠ 'gzxy...' (distinct characters). Lowercasing a
    // base58 string CHANGES its meaning. This locks in exact compare and guards against a future
    // "helpful" toLowerCase() regression that would silently match the wrong nonce account.
    const lower = MY_NPUB.toLowerCase();
    const o = decideSolPayerReceipt(
      {status: RECEIPT_SETTLED, npub: lower, nextNonce: NEXT_NONCE, sig: 'sig'},
      MY_NPUB,
    );
    expect(o.outcome).toBe('ignore');
  });

  it('empty expectedNpub → ignore (defensive: nothing to bind to)', () => {
    const o = decideSolPayerReceipt(
      {status: RECEIPT_SETTLED, npub: MY_NPUB, nextNonce: NEXT_NONCE, sig: 'sig'},
      '',
    );
    expect(o.outcome).toBe('ignore');
  });

  it('every status code maps to exactly one outcome (no fallthrough gaps)', () => {
    const statuses = [RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE];
    for (const status of statuses) {
      const o = decideSolPayerReceipt(
        {status, npub: MY_NPUB, nextNonce: NEXT_NONCE, sig: 'sig'},
        MY_NPUB,
      );
      expect(['success', 'declined', 'pending']).toContain(o.outcome);
    }
  });

  it('an unknown status code (>2) is treated as pending (honest unknown, never a false failure)', () => {
    // A future/undocumented receipt code must NEVER be shown as success or failure — pending is the
    // honest "we don't know" posture (mirrors decidePayerReceipt's default branch).
    const o = decideSolPayerReceipt(
      {status: 99 as never, npub: MY_NPUB, nextNonce: null, sig: null},
      MY_NPUB,
    );
    expect(o.outcome).toBe('pending');
  });
});

// Type-level guard: the success variant always carries adoptNonce (string | null); the other
// variants carry no extra data. This is the contract SolPayMode relies on to drive persistence.
describe('SolPayerOutcome — type contract', () => {
  it('success always carries an adoptNonce field', () => {
    const o: SolPayerOutcome = {outcome: 'success', adoptNonce: NEXT_NONCE};
    expect(o).toEqual({outcome: 'success', adoptNonce: NEXT_NONCE});
  });

  it('declined carries no extra field', () => {
    const o: SolPayerOutcome = {outcome: 'declined'};
    expect(o.outcome).toBe('declined');
  });
});

// A1 — the SOL rail has no server, so request expiry MUST be enforced client-side. The IC rail
// enforces `exp` in the canister; `isSolReqExpired` is the SOL analog (the solreq's `exp` is unix
// seconds). A stale/replayed solreq would otherwise be fully signable. The boundary contract: a
// request is valid THROUGH its expiry second (now == exp is NOT expired); one second later it is.
describe('isSolReqExpired — SOL request expiry (client-enforced; no server on this rail)', () => {
  it('a fresh request (exp well in the future) is NOT expired', () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    expect(isSolReqExpired({exp})).toBe(false);
  });

  it('a request whose expiry is in the past IS expired', () => {
    const exp = Math.floor(Date.now() / 1000) - 60;
    expect(isSolReqExpired({exp})).toBe(true);
  });

  it('exact boundary: nowSecs == exp → NOT expired (valid through its expiry second)', () => {
    expect(isSolReqExpired({exp: 1000}, 1000_000)).toBe(false);
  });

  it('one second past expiry → expired', () => {
    expect(isSolReqExpired({exp: 1000}, 1001_000)).toBe(true);
  });

  it('one second before expiry → NOT expired', () => {
    expect(isSolReqExpired({exp: 1000}, 999_000)).toBe(false);
  });
});

// A2 — the merchant must NOT broadcast a solpay that doesn't match the open solreq. A cheating payer
// could otherwise broadcast a mismatched amount and the merchant would surface the payer's claimed
// amount. `solpayMatchesReq` binds to/cur/amt (the three fields a replay/swap would alter); npub is
// the payer's own (not a match target — the merchant doesn't know it ahead of time).
describe('solpayMatchesReq — solpay→solreq binding (merchant broadcast integrity)', () => {
  const req = {to: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', cur: 'SOL' as const, amt: '5000000'};

  it('matches when to/cur/amt all equal', () => {
    expect(solpayMatchesReq({to: req.to, cur: 'SOL', amt: '5000000'}, req)).toBe(true);
  });

  it('mismatched amount → false (the cheating-payer case)', () => {
    expect(solpayMatchesReq({to: req.to, cur: 'SOL', amt: '1'}, req)).toBe(false);
  });

  it('mismatched recipient → false', () => {
    expect(solpayMatchesReq({to: 'Di1y6TQ37kbdCdy2FwfUnq9kePKgVe5LSjL8m5pXyWrB', cur: 'SOL', amt: '5000000'}, req)).toBe(false);
  });

  it('mismatched currency → false', () => {
    expect(solpayMatchesReq({to: req.to, cur: 'USDC', amt: '5000000'}, req)).toBe(false);
  });

  it('base58 to compare is CASE-SENSITIVE (distinct address, not a case variant)', () => {
    expect(solpayMatchesReq({to: req.to.toLowerCase(), cur: 'SOL', amt: '5000000'}, req)).toBe(false);
  });
});

// F4 (Phase 4) — the fail-closed USDC ATA gate. Pre-Phase-4 the gate let an 'unknown' (offline /
// RPC-failure / inconclusive) state FALL THROUGH TO ALLOW, leaking an unfulfillable USDC request
// (the merchant's `toAta` is encoded in the request; without the device's on-chain ATA the payer's
// source ATA can't be debited to it). The new gate BLOCKS on every non-'present' state with honest
// copy + a retryable affordance for the unverifiable case. These tests pin the matrix:
//   - present + online → ALLOW (the only allowed cell).
//   - absent / checking / unknown + online → BLOCK (with the right reason + retryable flag).
//   - offline (regardless of status) → BLOCK with the 'offline' reason (the probe was skipped).
// The gate is pure + total — it never throws, so the matrix is exhaustive over (status × online).
describe('decideUsdcAtaGate (fail-closed USDC ATA gate)', () => {
  it('present + online → allowed (the ONLY allow cell)', () => {
    const g = decideUsdcAtaGate('present', true);
    expect(g.allowed).toBe(true);
  });

  it('absent + online → blocked, NOT retryable (user must set up the ATA out-of-band)', () => {
    const g = decideUsdcAtaGate('absent', true);
    if (g.allowed) throw new Error('expected blocked');
    expect(g.reason).toBe('absent');
    expect(g.retryable).toBe(false);
    expect(g.message).toMatch(/USDC account/i);
  });

  it('checking + online → blocked, not retryable (transient — the probe is in flight)', () => {
    const g = decideUsdcAtaGate('checking', true);
    if (g.allowed) throw new Error('expected blocked');
    expect(g.reason).toBe('checking');
    expect(g.retryable).toBe(false);
  });

  // THE LOAD-BEARING CHANGE: 'unknown' used to fall through to allow. It now BLOCKS + is RETRYABLE
  // (a transient RPC failure / inconclusive probe — the user re-probes; the next attempt may succeed).
  it('unknown + online → BLOCKED + RETRYABLE (the fail-closed change — was previously allowed)', () => {
    const g = decideUsdcAtaGate('unknown', true);
    if (g.allowed) throw new Error('expected blocked — unknown must NOT fall through to allow');
    expect(g.reason).toBe('unverified');
    expect(g.retryable).toBe(true);
    expect(g.message).toMatch(/couldn't verify/i);
  });

  // Offline dominates: even 'present' would be stale (the probe was skipped because !online), so the
  // gate reports 'offline' regardless of the cached status. The button is disabled + the copy tells
  // the user to reconnect (NOT retryable from the button — a tap won't bring the network back).
  it('offline → blocked with reason "offline" regardless of cached status (offline dominates)', () => {
    for (const status of ['present', 'absent', 'checking', 'unknown'] as UsdcAtaStatus[]) {
      const g = decideUsdcAtaGate(status, false);
      if (g.allowed) throw new Error(`expected blocked for status=${status} when offline`);
      expect(g.reason).toBe('offline');
      expect(g.retryable).toBe(false);
    }
  });

  it('every blocked decision carries a non-empty message (honest copy — no silent block)', () => {
    for (const status of ['absent', 'checking', 'unknown'] as UsdcAtaStatus[]) {
      const g = decideUsdcAtaGate(status, true);
      if (g.allowed) throw new Error('expected blocked');
      expect(typeof g.message).toBe('string');
      expect(g.message.length).toBeGreaterThan(0);
    }
  });
});
