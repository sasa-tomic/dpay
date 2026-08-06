import {describe, it, expect} from '@jest/globals';
import {decideSolPayerReceipt} from '../solana/payments';
import type {SolPayerOutcome} from '../solana/payments';
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
