/**
 * rail.ts — pollTransfer rejected-outcome threading + Duplicate semantics (2026-08-20 item 6).
 *
 *  - A decoded TransferError rejection carries the STRUCTURED variant (errVariant) on the RailOutcome
 *    so callers branch on variant === 'Duplicate' instead of string-matching the human message
 *    ('Already paid' copy is a rendering detail and can change voice without breaking callers).
 *  - Duplicate maps to REJECTED (variant 'Duplicate', reason 'Already paid') — NOT a settle. The old
 *    rail.ts header claim that Duplicate "maps to SETTLED" was false: wasm decode (errVariant
 *    'Duplicate') routes through transferRejectionMessage like every other TransferError.
 *  - Canister-level rejects (read_state state==='rejected') and ingress rejections have no decoded
 *    ICRC variant — variant stays undefined there.
 *
 * icp.ts is mocked at its module boundary; DpayCore (services/native) is mocked so
 * icpDecodeTransferResult replies are scriptable.
 */
import {describe, expect, jest, test} from '@jest/globals';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpDecodeTransferResult: jest.fn(),
    icpDecodeMinterOk: jest.fn(),
  },
}));
jest.mock('../services/icp', () => ({
  icPollRequestStatus: jest.fn(),
  IC_SUBMIT_TIMEOUT_MS: 8000,
}));

import {pollTransfer, transferRejectionMessage} from '../services/rail';
import {DpayCore} from '../services/native';
import {icPollRequestStatus} from '../services/icp';

const PREPARED = {ledger: 'td2nx-oaaaa-aaaab-qhdnq-cai', requestIdHex: 'cd'.repeat(32)};

describe('pollTransfer — rejected outcomes thread the structured errVariant', () => {
  test('a decoded Duplicate rejection carries variant "Duplicate" + the friendly reason', async () => {
    jest.mocked(icPollRequestStatus).mockResolvedValue({state: 'replied', replyArgHex: 'ab'} as never);
    jest.mocked(DpayCore.icpDecodeTransferResult).mockResolvedValue({
      ok: false, errVariant: 'Duplicate', errDetail: '1234',
    } as never);
    const out = await pollTransfer(PREPARED, '11'.repeat(32), {attempts: 1, intervalMs: 0});
    expect(out).toEqual({kind: 'rejected', reason: 'Already paid', variant: 'Duplicate'});
  });

  test('other TransferErrors carry their own variant (callers must not need the message text)', async () => {
    jest.mocked(icPollRequestStatus).mockResolvedValue({state: 'replied', replyArgHex: 'ab'} as never);
    jest.mocked(DpayCore.icpDecodeTransferResult).mockResolvedValue({
      ok: false, errVariant: 'InsufficientFunds', errDetail: {balance: '0'},
    } as never);
    const out = await pollTransfer(PREPARED, '11'.repeat(32), {attempts: 1, intervalMs: 0});
    expect(out).toEqual({kind: 'rejected', reason: 'Not enough balance', variant: 'InsufficientFunds'});
  });

  test('a canister-level reject (no decoded ICRC variant) leaves variant undefined', async () => {
    jest.mocked(icPollRequestStatus).mockResolvedValue({state: 'rejected', rejectMessage: 'canister refused'} as never);
    const out = await pollTransfer(PREPARED, '11'.repeat(32), {attempts: 1, intervalMs: 0});
    expect(out).toEqual({kind: 'rejected', reason: 'canister refused'});
  });

  test('settled outcomes are untouched (blockIndex passthrough)', async () => {
    jest.mocked(icPollRequestStatus).mockResolvedValue({state: 'replied', replyArgHex: 'ab'} as never);
    jest.mocked(DpayCore.icpDecodeTransferResult).mockResolvedValue({ok: true, blockIndex: '77'} as never);
    const out = await pollTransfer(PREPARED, '11'.repeat(32), {attempts: 1, intervalMs: 0});
    expect(out).toEqual({kind: 'settled', blockIndex: '77'});
  });

  // 2026-08-21 mainnet NFC failure: the in-tap poll budget ran out before the ledger's read_state
  // showed the outcome (mobile RTT pushes 12×500ms past the mainnet tail) — icPollRequestStatus
  // returns null and the caller MUST treat that as unknown (never a decline), so the reader's
  // background reconciler can finish the verdict later.
  test('poll budget exhausted (null status) → unknown, never a false decline', async () => {
    jest.mocked(icPollRequestStatus).mockResolvedValue(null as never);
    const out = await pollTransfer(PREPARED, '11'.repeat(32), {attempts: 1, intervalMs: 0});
    expect(out).toEqual({kind: 'unknown'});
  });

  test('terminal-but-opaque state (done, no reply) → unknown', async () => {
    jest.mocked(icPollRequestStatus).mockResolvedValue({state: 'done'} as never);
    const out = await pollTransfer(PREPARED, '11'.repeat(32), {attempts: 1, intervalMs: 0});
    expect(out).toEqual({kind: 'unknown'});
  });

  test('non-terminal statuses (processing) → unknown after the budget', async () => {
    jest.mocked(icPollRequestStatus).mockResolvedValue({state: 'processing'} as never);
    const out = await pollTransfer(PREPARED, '11'.repeat(32), {attempts: 1, intervalMs: 0});
    expect(out).toEqual({kind: 'unknown'});
  });
});

describe('transferRejectionMessage — Duplicate maps to a REJECTED reason, never a settle', () => {
  test('Duplicate renders the already-paid copy', () => {
    expect(transferRejectionMessage('Duplicate', '5')).toBe('Already paid');
  });
  test('known variants render friendly copy; unknown ones fall back to the raw detail', () => {
    expect(transferRejectionMessage('InsufficientFunds', '')).toBe('Not enough balance');
    expect(transferRejectionMessage('BadFee', 'x')).toContain('fee');
    expect(transferRejectionMessage('SomethingNew', 'raw detail')).toContain('raw detail');
  });
});
