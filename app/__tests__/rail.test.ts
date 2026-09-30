/**
 * rail.ts — the signed transfer argument, and truthful pollTransfer outcomes.
 *
 *  - `prepareTransfer` addresses the ICRC-1 ACCOUNT it was given, subaccount included.
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
    icpValidateIcrcAccount: jest.fn(),
    icpTransferArg: jest.fn(),
    icpSignUpdate: jest.fn(),
    icpSignReadState: jest.fn(),
    icpSelfPrincipal: jest.fn(),
    icpMinterAccountArg: jest.fn(),
    icpDecodeText: jest.fn(),
    icpDecodeInt: jest.fn(),
    icpIngressExpiry: jest.fn(),
  },
}));
jest.mock('../services/icp', () => ({
  icSubmit: jest.fn(),
  icQuery: jest.fn(),
  icPollRequestStatus: jest.fn(),
  icPollSignedRequestStatus: jest.fn(),
  icStampExpiry: jest.fn(),
  IC_SUBMIT_TIMEOUT_MS: 8000,
  INGRESS_AHEAD_S: 300,
  // The REAL class: rail.ts branches on `instanceof IcClockUnreachable`, and both rail.ts and
  // this file import it from the SAME mocked module — a factory-fresh class would make the
  // offline-handoff branch (and its tests) see two incompatible constructors.
  IcClockUnreachable: jest.requireActual<typeof import('../services/icp')>('../services/icp').IcClockUnreachable,
}));
jest.mock('../services/relay', () => ({
  relayFetch: jest.fn(), // R1: rail's relay seam moved from fetchWithTimeout(url) to relayFetch(relay, path)
  // The body-read bound is the REAL one. A stub returning undefined here would make a matching
  // history row read as "no confirmation", which is the shape of the bug this module exists to
  // avoid — the mock must not be able to invent that answer.
  readBodyWithin: jest.requireActual<typeof import('../services/relay')>('../services/relay').readBodyWithin,
}));

import {confirmIncomingTransfer, fetchLedgerFee, pollTransfer, prepareNfcTransfer, prepareTransfer, railBtcDepositAddress, submitAndConfirmIncomingTransfer, submitNfcTransfer, submitTransfer, transferRejectionMessage, wireRequestToIntent} from '../services/rail';
import {DpayCore} from '../services/native';
import {icPollRequestStatus, icPollSignedRequestStatus, icQuery, icStampExpiry, icSubmit, IcClockUnreachable} from '../services/icp';
import {relayFetch} from '../services/relay';
import {M} from '../i18n';

const PREPARED = {ledger: 'td2nx-oaaaa-aaaab-qhdnq-cai', requestIdHex: 'cd'.repeat(32)};

// The ONE assertion that would have caught the 2026-09-04 defect: what the SIGNED transfer argument
// addresses. Everything above it (the resolver's verdict, the review row, the address book) had
// tests; the argument did not, so a destination the user read as `owner.subaccount` was signed as
// `owner` — the same wallet's DEFAULT account — and shipped.
describe('prepareTransfer — the account signed is the account it was handed', () => {
  const SECRET = '11'.repeat(32);
  const NONCE = 'aa'.repeat(16);
  const CATALOG = {currencies: [{currency: 7, ledger: PREPARED.ledger, fee: '10000'}]};
  const OWNER = 'k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae';
  const ACCOUNT = `${OWNER}-6cc627i.1`; // the ICRC-1 textual form naming subaccount 0x…01

  const prepare = (toAccount: string) =>
    prepareTransfer(SECRET, CATALOG, {toAccount, amount: '100', currency: 7, nonceHex: NONCE});

  beforeEach(() => {
    jest.mocked(DpayCore.icpTransferArg).mockReset().mockResolvedValue('arg' as never);
    jest.mocked(DpayCore.icpSignUpdate).mockReset()
      .mockResolvedValue({envelopeHex: 'envelope', requestIdHex: PREPARED.requestIdHex} as never);
    jest.mocked(icStampExpiry).mockReset().mockResolvedValue('1800000000000000000' as never);
    jest.mocked(DpayCore.icpValidateIcrcAccount).mockReset();
  });

  test('a subaccount destination credits THAT subaccount', async () => {
    jest.mocked(DpayCore.icpValidateIcrcAccount).mockResolvedValue({owner: OWNER, subaccountHex: '01'} as never);
    const prepared = await prepare(ACCOUNT);
    expect(DpayCore.icpValidateIcrcAccount).toHaveBeenCalledWith(ACCOUNT);
    // Argument order: (toOwner, toSubaccount, fromSubaccount, amount, fee, memo). The SECOND slot
    // is the whole defect: it used to be a hardcoded ''.
    expect(DpayCore.icpTransferArg).toHaveBeenCalledWith(OWNER, '01', '', '100', '10000', NONCE);
    expect(DpayCore.icpSignUpdate).toHaveBeenCalledWith(SECRET, PREPARED.ledger, 'icrc1_transfer', 'arg', '1800000000000000000');
    expect(prepared.memoHex).toBe(NONCE);
  });

  test('a bare owner principal credits the DEFAULT subaccount', async () => {
    // The other half of the pair: the common case must still address `subaccount: None`, which is
    // what every dpay-issued receive address, deposit and balance read means.
    jest.mocked(DpayCore.icpValidateIcrcAccount).mockResolvedValue({owner: OWNER, subaccountHex: ''} as never);
    await prepare(OWNER);
    expect(DpayCore.icpTransferArg).toHaveBeenCalledWith(OWNER, '', '', '100', '10000', NONCE);
  });

  test('a destination the core cannot read is thrown, never signed around', async () => {
    jest.mocked(DpayCore.icpValidateIcrcAccount).mockRejectedValue(new Error('bad checksum'));
    await expect(prepare('k2t6j-nope')).rejects.toThrow('bad checksum');
    expect(DpayCore.icpTransferArg).not.toHaveBeenCalled();
    expect(DpayCore.icpSignUpdate).not.toHaveBeenCalled();
  });
});

// The offline QR hand-off (2026-09-16): a fully-offline payer — relay AND IC gateway dead, the
// camera path's "IC clock unreachable" wall — signs anyway on a DEVICE-clock stamp, the same trust
// the NFC hand-off already extends (prepareNfcTransfer stamps at the request's expiry because the
// merchant submits on their own online phone). Pins the three load-bearing edges: the fallback is
// OPT-IN (every other value signer still refuses), typed to the unreachable failure only (a skew
// refusal stays a refusal — a reading that exists and disagrees is distrusted, offlineHandoff or
// not), and capped at the request's own expiry so the envelope never outlives the request that
// authorized it.
describe('prepareTransfer — the offline hand-off stamps from the device clock when the IC clock is unreachable', () => {
  const SECRET = '11'.repeat(32);
  const NONCE = 'aa'.repeat(16);
  const CATALOG = {currencies: [{currency: 7, ledger: PREPARED.ledger, fee: '10000'}]};
  const REQ = {toAccount: 'o', amount: '100', currency: 7, nonceHex: NONCE};
  const PINNED_NOW_MS = 1_700_000_000_000;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(DpayCore.icpTransferArg).mockReset().mockResolvedValue('arg' as never);
    jest.mocked(DpayCore.icpSignUpdate).mockReset()
      .mockResolvedValue({envelopeHex: 'envelope', requestIdHex: PREPARED.requestIdHex} as never);
    jest.mocked(DpayCore.icpValidateIcrcAccount).mockReset().mockResolvedValue({owner: 'o', subaccountHex: ''} as never);
    // The stamp arithmetic runs through the real ingress-expiry shape: now + ahead seconds.
    jest.mocked(DpayCore.icpIngressExpiry).mockReset()
      .mockImplementation(((now: string, ahead: number) => (BigInt(now) + BigInt(ahead) * 1_000_000_000n).toString()) as never);
  });

  test('default (no opts): an unreachable clock still refuses — nothing is signed', async () => {
    jest.mocked(icStampExpiry).mockRejectedValue(new IcClockUnreachable() as never);
    await expect(prepareTransfer(SECRET, CATALOG, REQ)).rejects.toThrow('unreachable');
    expect(DpayCore.icpSignUpdate).not.toHaveBeenCalled();
  });

  test('offlineHandoff + unreachable: signs with device-now + INGRESS_AHEAD_S, unexpired request', async () => {
    jest.mocked(icStampExpiry).mockRejectedValue(new IcClockUnreachable() as never);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(PINNED_NOW_MS);
    try {
      // Request expiry 600s out — farther than the 300s ahead window, so the WINDOW binds.
      await prepareTransfer(SECRET, CATALOG, {...REQ, expiry: 1_700_000_600}, {offlineHandoff: true});
      expect(DpayCore.icpIngressExpiry).toHaveBeenCalledWith((BigInt(PINNED_NOW_MS / 1000) * 1_000_000_000n).toString(), 300);
      expect(DpayCore.icpSignUpdate).toHaveBeenCalledWith(SECRET, PREPARED.ledger, 'icrc1_transfer', 'arg', '1700000300000000000');
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('offlineHandoff: the stamp is CAPPED at the request expiry — the envelope dies with the request', async () => {
    jest.mocked(icStampExpiry).mockRejectedValue(new IcClockUnreachable() as never);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(PINNED_NOW_MS);
    try {
      // Request expiry only 120s out — nearer than the ahead window, so the REQUEST binds.
      await prepareTransfer(SECRET, CATALOG, {...REQ, expiry: 1_700_000_120}, {offlineHandoff: true});
      expect(DpayCore.icpIngressExpiry).toHaveBeenCalledWith((BigInt(PINNED_NOW_MS / 1000) * 1_000_000_000n).toString(), 120);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('offlineHandoff: a link (expiry null) uses the full ahead window — the envelope bounds itself', async () => {
    jest.mocked(icStampExpiry).mockRejectedValue(new IcClockUnreachable() as never);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(PINNED_NOW_MS);
    try {
      await prepareTransfer(SECRET, CATALOG, {...REQ, expiry: null}, {offlineHandoff: true});
      expect(DpayCore.icpIngressExpiry).toHaveBeenCalledWith((BigInt(PINNED_NOW_MS / 1000) * 1_000_000_000n).toString(), 300);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('offlineHandoff + SKEW still refuses — the fallback is typed to "no reading", not "bad reading"', async () => {
    jest.mocked(icStampExpiry).mockRejectedValue(new Error('device clock disagrees with IC time') as never);
    await expect(prepareTransfer(SECRET, CATALOG, {...REQ, expiry: 1_700_000_600}, {offlineHandoff: true})).rejects.toThrow('disagrees');
    expect(DpayCore.icpSignUpdate).not.toHaveBeenCalled();
  });
});

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

describe('wireRequestToIntent — the seam where a scanned/tapped request becomes something a screen renders', () => {
  const WIRE = {
    toHex: '22'.repeat(32),
    amount: '1000',
    nonceHex: 'aa'.repeat(16),
    expiry: 1_800_000_240,
    currency: 4,
    toName: 'Cafe Kalaj',
    memo: 'table 4',
  };

  beforeEach(() => {
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockReset().mockResolvedValue('payee-principal' as never);
  });

  test('an ordinary name and memo cross unchanged', async () => {
    const intent = await wireRequestToIntent(WIRE);
    expect(intent.toName).toBe('Cafe Kalaj');
    expect(intent.memo).toBe('table 4');
    expect(intent.source).toBe('wire');
  });

  test('a name of blank lines cannot clear the review screen', async () => {
    // The request came off a QR a stranger printed, or off a phone that tapped this one. The wire's
    // 32-byte NAME_LEN bounds the LENGTH, but length was never the weapon: React Native `Text`
    // renders newlines, so ~32 of them push the destination account, the amount and the memo off a
    // phone screen — deleting exactly the lines that make a hostile payee answerable.
    const intent = await wireRequestToIntent({...WIRE, toName: 'Cafe\n\n\n\n\n\n\n\n\n\n\n\nKalaj', memo: 'a b\r\nc'});
    expect(intent.toName).toBe('Cafe Kalaj');
    expect(intent.memo).toBe('a b c');
  });

  test('invisible characters that could only be there to hide something are removed', async () => {
    // Zero-width padding and the bidi overrides — the pair that lets a name read as one merchant
    // while spelling another. Same rule, same helper as the payment link's label and the
    // OpenCryptoPay merchant name; ZWJ stays, because it joins rather than hides.
    const intent = await wireRequestToIntent({...WIRE, toName: '‮Kalaj​﻿', memo: '‍ok'});
    expect(intent.toName).toBe('Kalaj');
    expect(intent.memo).toBe('‍ok');
  });

  test('nothing the payer authorizes reads these fields', async () => {
    // The safety of sanitising here rests on the name and memo being DISPLAY ONLY on this rail:
    // `prepareTransfer` signs {toAccount, amount, currency, nonceHex} and the ICRC memo is the
    // nonce, so no cleaned character can change what the payer's signature commits to.
    const intent = await wireRequestToIntent({...WIRE, toName: '‮Kalaj'});
    expect(intent.toAccount).toBe('payee-principal');
    expect(intent.amount).toBe(WIRE.amount);
    expect(intent.currency).toBe(WIRE.currency);
    expect(intent.nonceHex).toBe(WIRE.nonceHex);
    expect(intent.expiry).toBe(WIRE.expiry);
  });
});

describe('receiver history confirmation', () => {
  const expected = {
    relayUrl: 'https://relay.test', receiverPublicHex: '22'.repeat(32),
    currency: 4, amount: '1000', memoHex: 'aa'.repeat(16),
  };

  test('requires recipient, currency, amount, and memo to match the open request', async () => {
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue('receiver-principal' as never);
    jest.mocked(relayFetch)
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
    expect(relayFetch).toHaveBeenCalledTimes(2);
    expect(relayFetch).toHaveBeenCalledWith(expect.any(String), expect.stringContaining(`limit=1&memo=${'aa'.repeat(16)}`), undefined, expect.any(Number));
  });

  test('submits payer bytes verbatim before checking ledger history', async () => {
    jest.mocked(icSubmit).mockResolvedValue({kind: 'unknown'} as never);
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue('receiver-principal' as never);
    jest.mocked(relayFetch).mockResolvedValue({ok: true, json: async () => ({transactions: []})} as never);
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

  // The ICP ledger's legacy `transfer` is the one method that CAN answer this — it fills in a
  // `created_at_time` of its own when the caller sends none, so its duplicate check is live where
  // every icrc1_transfer's is not. Its spelling must reach the same settled outcome, or a send to
  // an account identifier could report a decline for money that moved.
  test('the legacy TxDuplicate spelling settles too, never rejects', async () => {
    jest.mocked(icPollRequestStatus).mockResolvedValue({state: 'replied', replyArgHex: 'ab'} as never);
    const decode = async () => ({ok: false, errVariant: 'TxDuplicate', errDetail: 'duplicate_of 77'});
    const out = await pollTransfer(PREPARED, '11'.repeat(32), {attempts: 1, intervalMs: 0}, decode);
    expect(out).toEqual({kind: 'settled', blockIndex: '77'});
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

  test('a rejected request_status → null, AND the minter\'s own reason is on the record', async () => {
    // `null` is the right answer to the caller (the sheet shows a transient state and re-polls),
    // but the reject message is the only thing that explains WHY no deposit address appeared — the
    // mainnet minter's "Canister has no query method get_btc_address" is exactly this branch.
    // Discarding it left a user with a blank sheet and a maintainer with nothing to read.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      jest.mocked(icPollRequestStatus).mockResolvedValue({
        state: 'rejected', rejectMessage: 'Canister has no query method get_btc_address',
      } as never);
      await expect(railBtcDepositAddress(SECRET, MINTER)).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Canister has no query method get_btc_address'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(MINTER));
    } finally {
      warn.mockRestore();
    }
  });

  test('a rejection with no reason still says so, rather than saying nothing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      jest.mocked(icPollRequestStatus).mockResolvedValue({state: 'rejected'} as never);
      await expect(railBtcDepositAddress(SECRET, MINTER)).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('the minter gave no reason'));
    } finally {
      warn.mockRestore();
    }
  });

  test('an EMPTY decoded address is refused and named — never shown as an address', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      jest.mocked(icPollRequestStatus).mockResolvedValue({state: 'replied', replyArgHex: 'reply'} as never);
      jest.mocked(DpayCore.icpDecodeText).mockResolvedValue('' as never);
      await expect(railBtcDepositAddress(SECRET, MINTER)).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('EMPTY address'));
    } finally {
      warn.mockRestore();
    }
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

describe('fetchLedgerFee — the classified fee-unavailable copy (work order 2026-09-30)', () => {
  // "Couldn't fetch the ledger fee. Check connection." fired on every failed icrc1_fee read —
  // including when the phone was ONLINE and the IC boundary was the side that was down (the
  // founder's 2026-09-29 finding). The blame is now classified at the seam (the shared oracle,
  // `classifyIcReadFailure`, probing the SOL rail head — off the IC path), and the thrown
  // message is the matching honest sentence. The `__DPAY_TEST_SOLANA_CONNECTIVITY` override
  // short-circuits the oracle, so these pins are hermetic: no fetch, no probe.
  const SECRET = '22'.repeat(32);
  const LEDGER = 'td2nx-oaaaa-aaaab-qhdnq-cai';
  const g = globalThis as unknown as {__DPAY_TEST_SOLANA_CONNECTIVITY?: 'offline' | 'online'};

  test('no answer while the phone is offline ⇒ the offline sentence (nobody is blamed)', async () => {
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'offline';
    jest.mocked(icQuery).mockResolvedValue(null as never);
    const err = await fetchLedgerFee(SECRET, LEDGER).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe(M.errors.ic.feeUnavailableOffline);
  });

  test('no answer while the phone is online ⇒ the unreachable sentence (the IC side is named)', async () => {
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'online';
    jest.mocked(icQuery).mockResolvedValue(null as never);
    const err = await fetchLedgerFee(SECRET, LEDGER).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe(M.errors.ic.feeUnavailableUnreachable);
    expect(err!.message).not.toContain('Check connection');
  });

  test('a real answer still decodes and is written through to the display cache', async () => {
    g.__DPAY_TEST_SOLANA_CONNECTIVITY = 'online';
    jest.mocked(icQuery).mockResolvedValue('fee-reply' as never);
    jest.mocked(DpayCore.icpDecodeInt).mockResolvedValue('10000' as never);
    await expect(fetchLedgerFee(SECRET, LEDGER)).resolves.toBe('10000');
  });

  test('the two arms are distinct, name the facts, and never say "check connection"', async () => {
    expect(M.errors.ic.feeUnavailableOffline).not.toBe(M.errors.ic.feeUnavailableUnreachable);
    expect(M.errors.ic.feeUnavailableOffline).toMatch(/offline/i);
    expect(M.errors.ic.feeUnavailableUnreachable).toMatch(/connection is fine/i);
    expect(M.errors.ic.feeUnavailableUnreachable).toMatch(/Internet Computer/);
    expect(M.errors.ic.feeUnavailableOffline).not.toMatch(/check your connection/i);
    expect(M.errors.ic.feeUnavailableUnreachable).not.toMatch(/check connection|check your connection/i);
  });
});
