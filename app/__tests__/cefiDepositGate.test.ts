// The record-lifecycle cefi-deposit gate (2026-10-02 P0): the predicate that decides whether
// a convert record's IC-source deposit still needs taking. Money-defining: a record that
// passes this gate gets its deposit SENT with the device key - a false positive is a
// double-send (a rebuilt envelope is a fresh transfer), a false negative strands the venue
// order unfunded. Exactly-once keys on the persisted marker; the step vocabulary is the
// provider driver's own.
import {describe, test, expect} from '@jest/globals';
import {cefiDepositOutstanding} from '../lib/ataSetup';

const outstanding = {
  step: 'awaiting_deposit' as const,
  inCurrency: 8,
  amountIn: '90000000',
  providerDeposit: {depositAddress: '2vxsx-fae'},
};

describe('the cefi-deposit once-only gate (record lifecycle, 2026-10-02 P0)', () => {
  test('an unmarked awaiting_deposit record with an IC source and a deposit target is outstanding', () => {
    expect(cefiDepositOutstanding(outstanding)).toBe(true);
  });

  test('the persisted marker makes it never-outstanding again - the exactly-once key', () => {
    expect(cefiDepositOutstanding({...outstanding, depositSentAtMs: 1727870400000})).toBe(false);
  });

  test('another-rail sources and missing deposit targets are never outstanding', () => {
    expect(cefiDepositOutstanding({...outstanding, inCurrency: null})).toBe(false);
    expect(cefiDepositOutstanding({...outstanding, providerDeposit: null})).toBe(false);
    expect(cefiDepositOutstanding({...outstanding, providerDeposit: {depositAddress: ''}})).toBe(false);
  });

  test('past the handoff step (or terminal) the venue poll owns the record, never the deposit sender', () => {
    expect(cefiDepositOutstanding({...outstanding, step: 'provider_processing'})).toBe(false);
    expect(cefiDepositOutstanding({...outstanding, step: 'done'})).toBe(false);
    expect(cefiDepositOutstanding({...outstanding, step: 'quote_expired'})).toBe(false);
    expect(cefiDepositOutstanding({...outstanding, step: 'aborted'})).toBe(false);
  });
});
