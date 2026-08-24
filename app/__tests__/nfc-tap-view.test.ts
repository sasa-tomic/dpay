import {describe, it, expect} from '@jest/globals';
import {computeTapStatus} from '../components/NfcTapView';

// Pure phase→title/sub logic extracted from the merged NfcTap/SolNfcTap terminal render. Both
// adapters render via <NfcTapView>, so these cases pin the behavior the e2e flows assert:
//   - flow 11 (IC): linking→"Connecting…", exchanging→"Communicating…", success→"Paid ✓"
//   - flow 32 (IC disclosure): exchanging card-side shows "Paying <amt> on <network>"
//   - flow 47 (SOL): exchanging shows "Communicating…", success→"Paid ✓" (no network label)
// The SOL rail passes no networkLabel (native SOL, no ICRC network); the IC card-side passes the
// disclosure's networkLabel. Reader-side never shows a network label.

describe('computeTapStatus — transitional phases (shared IC + SOL)', () => {
  it('linking renders "Connecting…" with a terminal=false (Cancel button)', () => {
    const r = computeTapStatus('linking', null, 'card', null);
    expect(r.title).toBe('Connecting…');
    expect(r.sub).toBe('Linking the two phones');
    expect(r.terminal).toBe(false);
  });

  it('exchanging renders "Communicating…" (asserted by flows 11 + 47)', () => {
    const r = computeTapStatus('exchanging', null, 'card', null);
    expect(r.title).toBe('Communicating…');
    expect(r.sub).toBe('Keep the phones together');
    expect(r.terminal).toBe(false);
  });

  it('settling renders "Confirming…" (active window)', () => {
    const r = computeTapStatus('settling', null, 'card', null);
    expect(r.title).toBe('Confirming…');
    expect(r.terminal).toBe(false);
  });
});

describe('computeTapStatus — success (card = Paid, reader = Received)', () => {
  it('card success shows "Paid ✓ <amt>" (asserted by flows 11 + 47)', () => {
    const r = computeTapStatus('success', null, 'card', '0.00050000 BTC');
    expect(r.title).toBe('Paid ✓ 0.00050000 BTC');
    expect(r.sub).toBe('The payment settled');
    expect(r.terminal).toBe(true);
  });

  it('reader success shows "Received ✓ <amt>"', () => {
    const r = computeTapStatus('success', null, 'reader', '0.001 SOL');
    expect(r.title).toBe('Received ✓ 0.001 SOL');
  });

  it('success with no amount trims the trailing space', () => {
    const r = computeTapStatus('success', null, 'card', null);
    expect(r.title).toBe('Paid ✓');
  });
});

describe('computeTapStatus — active asset disclosure (MC8 U1, flow 32)', () => {
  it('IC card-side exchanging shows "Paying <amt> on <network>" once the amount resolves', () => {
    const r = computeTapStatus('exchanging', null, 'card', '0.00050000 BTC', 'Bitcoin');
    expect(r.title).toBe('Communicating…');
    expect(r.sub).toBe('Paying 0.00050000 BTC on Bitcoin');
  });

  it('IC card-side settling shows "Paying <amt> on <network>"', () => {
    const r = computeTapStatus('settling', null, 'card', '0.00050000 BTC', 'Bitcoin');
    expect(r.sub).toBe('Paying 0.00050000 BTC on Bitcoin');
  });

  it('SOL card-side exchanging shows "Paying <amt>" with NO network label', () => {
    const r = computeTapStatus('exchanging', null, 'card', '0.001 SOL', null);
    expect(r.sub).toBe('Paying 0.001 SOL');
  });

  // The pure helper appends networkLabel whenever it is passed; the IC ADAPTER is responsible for
  // passing null on the reader side (reader never resolves a disclosure). Documented here so the
  // role-gating contract lives with the render logic it governs.
  it('reader-side Collecting verb is used, and a passed networkLabel is appended verbatim', () => {
    const r = computeTapStatus('exchanging', null, 'reader', '0.00050000 BTC', 'Bitcoin');
    expect(r.sub).toBe('Collecting 0.00050000 BTC on Bitcoin');
  });

  it('reader-side with no networkLabel (the IC adapter contract) shows "Collecting <amt>"', () => {
    const r = computeTapStatus('exchanging', null, 'reader', '0.00050000 BTC', null);
    expect(r.sub).toBe('Collecting 0.00050000 BTC');
  });

  it('active with no amount yet falls back to the phase default sub', () => {
    const r = computeTapStatus('exchanging', null, 'card', null, 'Bitcoin');
    expect(r.sub).toBe('Keep the phones together');
  });
});

describe('computeTapStatus — terminal error/declined/pending surface the reason', () => {
  it('error shows the reason text (overriding the default sub)', () => {
    const r = computeTapStatus('error', 'Move the phones together', 'card', null);
    expect(r.title).toBe('Tap failed');
    expect(r.sub).toBe('Move the phones together');
    expect(r.terminal).toBe(true);
  });

  it('declined shows the reason text', () => {
    const r = computeTapStatus('declined', 'The ledger declined the payment', 'card', null);
    expect(r.title).toBe('Declined');
    expect(r.sub).toBe('The ledger declined the payment');
    expect(r.terminal).toBe(true);
  });

  it('pending shows the reason text', () => {
    const r = computeTapStatus('pending', 'Couldn’t confirm', 'card', null);
    expect(r.title).toBe('Not confirmed');
    expect(r.sub).toBe('Couldn’t confirm');
    expect(r.terminal).toBe(true);
  });

  it('terminal with no reason falls back to the phase default sub', () => {
    const r = computeTapStatus('declined', null, 'card', null);
    expect(r.sub).toBe('The payment was declined');
  });
});

// One-press rule: the review park is gone (a payable request auto-signs — the "Pay Now" gate was
// the press). awaitingApproval is reader-only now and keeps its role-aware copy even with an amount.
describe('computeTapStatus — role-aware awaitingApproval (reader-only)', () => {
  it('awaitingApproval (reader) shows "Waiting for the payer…" / "They’re signing the payment"', () => {
    const s = computeTapStatus('awaitingApproval', null, 'reader', '0.001 SOL', null);
    expect(s.title).toBe('Waiting for the payer…');
    expect(s.sub).toBe('They’re signing the payment');
    expect(s.terminal).toBe(false);
  });

  it('the retired "Authorizing…" copy is gone from every phase', () => {
    for (const p of ['listening', 'linking', 'exchanging', 'awaitingApproval', 'settling'] as const) {
      const s = computeTapStatus(p, null, 'card', null, null);
      expect(s.title).not.toContain('Authorizing');
      expect(s.sub).not.toContain('Signing on the payer');
    }
  });
});
