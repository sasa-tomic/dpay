/**
 * rail.ts — truthful pollTransfer outcomes.
 *
 *  - Duplicate is settled at duplicate_of: the ledger proves the exact transfer already executed.
 *  - Other decoded TransferErrors carry their structured variant for honest UI reasons.
 *  - Canister-level rejects (read_state state==='rejected') and ingress rejections have no decoded
 *    ICRC variant — variant stays undefined there.
 *
 * icp.ts is mocked at its module boundary; DpayCore (services/native) is mocked so
 * icpDecodeTransferResult replies are scriptable.
 */
import {beforeEach, describe, expect, jest, test} from '@jest/globals';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpDecodeTransferResult: jest.fn(),
    icpDecodeMinterOk: jest.fn(),
    icpPrincipalFromPubkey: jest.fn(),
    icpTransferArg: jest.fn(),
    icpSignUpdate: jest.fn(),
    icpSignReadState: jest.fn(),
    icpSelfPrincipal: jest.fn(),
    icpMinterAccountArg: jest.fn(),
    icpDecodeText: jest.fn(),
  },
}));
jest.mock('../services/icp', () => ({
  icSubmit: jest.fn(),
  icPollRequestStatus: jest.fn(),
  icPollSignedRequestStatus: jest.fn(),
  icStampExpiry: jest.fn(),
  IC_SUBMIT_TIMEOUT_MS: 8000,
  INGRESS_AHEAD_S: 300,
}));
jest.mock('../services/relay', () => ({fetchWithTimeout: jest.fn()}));

import {confirmIncomingTransfer, pollTransfer, prepareNfcTransfer, railBtcDepositAddress, submitAndConfirmIncomingTransfer, submitNfcTransfer, submitTransfer, transferRejectionMessage} from '../services/rail';
import {DpayCore} from '../services/native';
import {icPollRequestStatus, icPollSignedRequestStatus, icStampExpiry, icSubmit} from '../services/icp';
import {fetchWithTimeout} from '../services/relay';

const PREPARED = {ledger: 'td2nx-oaaaa-aaaab-qhdnq-cai', requestIdHex: 'cd'.repeat(32)};

test('offline NFC preparation signs update + reusable read_state without fetching a clock', async () => {
  jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue('receiver-principal' as never);
  jest.mocked(DpayCore.icpTransferArg).mockResolvedValue('arg' as never);
  jest.mocked(DpayCore.icpSignUpdate).mockResolvedValue({envelopeHex: 'update', requestIdHex: PREPARED.requestIdHex} as never);
  jest.mocked(DpayCore.icpSignReadState).mockResolvedValue('read-state' as never);
  const prepared = await prepareNfcTransfer('11'.repeat(32), {
    currencies: [{currency: 4, ledger: PREPARED.ledger, fee: '10'}],
  }, {toHex: '22'.repeat(32), amount: '1000', currency: 4, nonceHex: 'aa'.repeat(16), expiry: 1_800_000_240});
  expect(DpayCore.icpSignUpdate).toHaveBeenCalledWith(
    expect.any(String), PREPARED.ledger, 'icrc1_transfer', 'arg', '1800000240000000000',
  );
  expect(DpayCore.icpSignReadState).toHaveBeenCalledWith(
    expect.any(String), [PREPARED.requestIdHex], false, '1800000300000000000',
  );
  expect(prepared.readStateEnvelopeHex).toBe('read-state');
});

test('merchant NFC settlement polls the exact payer-signed read_state envelope', async () => {
  jest.mocked(icSubmit).mockResolvedValue({kind: 'unknown'} as never);
  jest.mocked(icPollSignedRequestStatus).mockResolvedValue({state: 'replied', replyArgHex: 'ab'} as never);
  jest.mocked(DpayCore.icpDecodeTransferResult).mockResolvedValue({ok: true, blockIndex: '90'} as never);
  const out = await submitNfcTransfer({
    ...PREPARED, envelopeHex: 'update', readStateEnvelopeHex: 'signed-read',
  }, {attempts: 2, intervalMs: 3});
  expect(out).toEqual({kind: 'settled', blockIndex: '90'});
  expect(icPollSignedRequestStatus).toHaveBeenCalledWith(
    PREPARED.ledger, PREPARED.requestIdHex, 'signed-read', {attempts: 2, intervalMs: 3},
  );
});

test('an unknown submit response still polls the immutable request ID', async () => {
  jest.mocked(icSubmit).mockResolvedValue({kind: 'unknown'} as never);
  jest.mocked(icPollRequestStatus).mockResolvedValue({state: 'replied', replyArgHex: 'ab'} as never);
  jest.mocked(DpayCore.icpDecodeTransferResult).mockResolvedValue({ok: true, blockIndex: '88'} as never);
  const out = await submitTransfer({...PREPARED, envelopeHex: 'abcd'}, '11'.repeat(32), {attempts: 1, intervalMs: 0});
  expect(out).toEqual({kind: 'settled', blockIndex: '88'});
  expect(icPollRequestStatus).toHaveBeenCalledWith(expect.any(String), PREPARED.ledger, PREPARED.requestIdHex, {attempts: 1, intervalMs: 0});
});

test('a 4xx submit response still polls before any terminal verdict', async () => {
  jest.mocked(icSubmit).mockResolvedValue({kind: 'rejected', status: 429, bodyText: 'busy'} as never);
  jest.mocked(icPollRequestStatus).mockResolvedValue({state: 'replied', replyArgHex: 'ab'} as never);
  jest.mocked(DpayCore.icpDecodeTransferResult).mockResolvedValue({ok: true, blockIndex: '89'} as never);
  const out = await submitTransfer({...PREPARED, envelopeHex: 'abcd'}, '11'.repeat(32), {attempts: 1, intervalMs: 0});
  expect(out).toEqual({kind: 'settled', blockIndex: '89'});
});

describe('receiver history confirmation', () => {
  const expected = {
    relayUrl: 'https://relay.test', receiverPublicHex: '22'.repeat(32),
    currency: 4, amount: '1000', memoHex: 'aa'.repeat(16),
  };

  test('requires recipient, currency, amount, and memo to match the open request', async () => {
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue('receiver-principal' as never);
    jest.mocked(fetchWithTimeout)
      .mockResolvedValueOnce({ok: true, json: async () => ({transactions: [{
        from: 'payer', to: 'receiver-principal', amount: '999', nonce: '', currency: 4,
        timestamp: 1, from_name: '', to_name: '', memo: 'aa'.repeat(16),
      }, {
        from: 'payer', to: 'someone-else', amount: '1000', nonce: '', currency: 4,
        timestamp: 1, from_name: '', to_name: '', memo: 'aa'.repeat(16),
      }, {
        from: 'payer', to: 'receiver-principal', amount: '1000', nonce: '', currency: 9,
        timestamp: 1, from_name: '', to_name: '', memo: 'aa'.repeat(16),
      }, {
        from: 'payer', to: 'receiver-principal', amount: '1000', nonce: '', currency: 4,
        timestamp: 1, from_name: '', to_name: '', memo: 'bb'.repeat(16),
      }]})} as never)
      .mockResolvedValueOnce({ok: true, json: async () => ({transactions: [{
        from: 'payer', to: 'receiver-principal', amount: '1000', nonce: '', currency: 4,
        timestamp: 2, from_name: '', to_name: '', memo: 'aa'.repeat(16),
      }]})} as never);
    await expect(confirmIncomingTransfer(expected, {attempts: 2, intervalMs: 0})).resolves.toBe(true);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(fetchWithTimeout).toHaveBeenCalledWith(expect.stringContaining(`limit=1&memo=${'aa'.repeat(16)}`), undefined, expect.any(Number));
  });

  test('submits payer bytes verbatim before checking ledger history', async () => {
    jest.mocked(icSubmit).mockResolvedValue({kind: 'unknown'} as never);
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue('receiver-principal' as never);
    jest.mocked(fetchWithTimeout).mockResolvedValue({ok: true, json: async () => ({transactions: []})} as never);
    await expect(submitAndConfirmIncomingTransfer(PREPARED.ledger, 'cafe', expected, {attempts: 1, intervalMs: 0})).resolves.toBe(false);
    expect(icSubmit).toHaveBeenCalledWith(PREPARED.ledger, 'call', 'cafe', 8000);
  });
});

describe('pollTransfer — truthful terminal outcomes', () => {
  test('Duplicate is settled at the ledger-provided block', async () => {
    jest.mocked(icPollRequestStatus).mockResolvedValue({state: 'replied', replyArgHex: 'ab'} as never);
    jest.mocked(DpayCore.icpDecodeTransferResult).mockResolvedValue({
      ok: false, errVariant: 'Duplicate', errDetail: '1234',
    } as never);
    const out = await pollTransfer(PREPARED, '11'.repeat(32), {attempts: 1, intervalMs: 0});
    expect(out).toEqual({kind: 'settled', blockIndex: '1234'});
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
  // returns null and the caller MUST treat that as unknown (never a decline). The UI stays honest
  // pending; later balance/history refreshes can reconcile without inventing a second verdict.
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

describe('transferRejectionMessage', () => {
  test('Duplicate renders the already-paid copy', () => {
    expect(transferRejectionMessage('Duplicate', '5')).toBe('Already paid');
  });
  test('known variants render friendly copy; unknown ones fall back to the raw detail', () => {
    expect(transferRejectionMessage('InsufficientFunds', '')).toBe('Not enough balance');
    expect(transferRejectionMessage('BadFee', 'x')).toContain('fee');
    expect(transferRejectionMessage('SomethingNew', 'raw detail')).toContain('raw detail');
  });
});

// 2026-08-23 prod bug (physical device): the real ckBTC minter exposes get_btc_address as an
// UPDATE only — the signed QUERY died on mainnet with "Canister has no query method
// 'get_btc_address'" while the offline fake gateway accepted it (prod-only blind spot). These
// pin the update-call contract: sign ONCE with a certified-clock expiry, POST the exact bytes,
// poll the immutable request_id, decode the text reply — null on anything short of `replied`.
describe('railBtcDepositAddress — get_btc_address as an UPDATE call', () => {
  const SECRET = '11'.repeat(32);
  const MINTER = 'mqygn-kiaaa-aaaar-qaadq-cai';
  const RID = 'cd'.repeat(32);

  beforeEach(() => {
    jest.clearAllMocks(); // call-count assertions need a clean slate (counts, not implementations)
    jest.mocked(DpayCore.icpSelfPrincipal).mockResolvedValue('owner-principal' as never);
    jest.mocked(DpayCore.icpMinterAccountArg).mockResolvedValue('acct-arg' as never);
    jest.mocked(icStampExpiry).mockResolvedValue('1800000240000000000' as never);
    jest.mocked(DpayCore.icpSignUpdate).mockResolvedValue({envelopeHex: 'env', requestIdHex: RID} as never);
    jest.mocked(icSubmit).mockResolvedValue({kind: 'accepted'} as never);
  });

  test('signs once with the stamped expiry, submits the exact bytes, polls the request_id, decodes the text', async () => {
    jest.mocked(icPollRequestStatus).mockResolvedValue({state: 'replied', replyArgHex: 'reply'} as never);
    jest.mocked(DpayCore.icpDecodeText).mockResolvedValue('bc1qdpay0011ccdd22' as never);
    await expect(railBtcDepositAddress(SECRET, MINTER)).resolves.toBe('bc1qdpay0011ccdd22');
    expect(icStampExpiry).toHaveBeenCalledWith(SECRET, 300, undefined);
    expect(DpayCore.icpSignUpdate).toHaveBeenCalledTimes(1);
    expect(DpayCore.icpSignUpdate).toHaveBeenCalledWith(SECRET, MINTER, 'get_btc_address', 'acct-arg', '1800000240000000000');
    expect(icSubmit).toHaveBeenCalledWith(MINTER, 'call', 'env', 8000, undefined);
    expect(icPollRequestStatus).toHaveBeenCalledWith(SECRET, MINTER, RID, {attempts: 12, intervalMs: 500, signal: undefined});
    expect(DpayCore.icpDecodeText).toHaveBeenCalledWith('reply');
  });

  test('an unreachable clock (icStampExpiry throws) → null, nothing signed', async () => {
    jest.mocked(icStampExpiry).mockRejectedValue(new Error('IC clock unreachable') as never);
    await expect(railBtcDepositAddress(SECRET, MINTER)).resolves.toBeNull();
    expect(DpayCore.icpSignUpdate).not.toHaveBeenCalled();
  });

  test('a rejected request_status → null', async () => {
    jest.mocked(icPollRequestStatus).mockResolvedValue({state: 'rejected', rejectMessage: 'nope'} as never);
    await expect(railBtcDepositAddress(SECRET, MINTER)).resolves.toBeNull();
  });

  test('poll budget exhausted (null status) → null — no re-sign, no second submit', async () => {
    jest.mocked(icPollRequestStatus).mockResolvedValue(null as never);
    await expect(railBtcDepositAddress(SECRET, MINTER)).resolves.toBeNull();
    expect(DpayCore.icpSignUpdate).toHaveBeenCalledTimes(1);
    expect(icSubmit).toHaveBeenCalledTimes(1);
  });

  test('terminal-but-opaque state (done, no reply arg) → null', async () => {
    jest.mocked(icPollRequestStatus).mockResolvedValue({state: 'done'} as never);
    await expect(railBtcDepositAddress(SECRET, MINTER)).resolves.toBeNull();
    expect(DpayCore.icpDecodeText).not.toHaveBeenCalled();
  });
});
