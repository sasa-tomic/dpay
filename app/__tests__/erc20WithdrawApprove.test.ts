/**
 * prepareErc20Withdrawal (app/services/rail.ts) — the ckERC20 dual-ledger offramp's approve
 * amounts. The minter's async burn of `amount` goes through icrc2_transfer_from, and ICRC-2
 * draws the ledger fee from the allowance ON TOP of the amount: an exact-amount approve is
 * InsufficientAllowance by exactly one ledger fee. Caught LIVE 2026-09-21 on mainnet (the
 * ckETH minter accepted the request, pulled the gas toll, failed the ckUSDC burn, reimbursed
 * the toll — FailedErc20WithdrawalRequest, no transaction ever created; the dpay approve was
 * 10_000 subunits short). The approve-amount leg must therefore be amount + ledger fee.
 * The arg/envelope BYTES are the compiled core's; the FFI is mocked and its CALLS pinned.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpApproveArg: jest.fn(),
    icpWithdrawErc20Arg: jest.fn(),
    icpSignUpdate: jest.fn(),
    icpDecodeInt: jest.fn(),
  },
}));
jest.mock('../services/icp', () => ({
  icStampExpiry: jest.fn(),
  icQuery: jest.fn(),
  EMPTY_DIDL_ARG_HEX: '',
}));
jest.mock('../services/ledgerFees', () => ({rememberLedgerFee: jest.fn()}));
jest.mock('../services/relay', () => ({relayFetch: jest.fn()}));

import {DpayCore} from '../services/native';
import {icStampExpiry, icQuery} from '../services/icp';
import {prepareErc20Withdrawal} from '../services/rail';

const SECRET = 'aa'.repeat(32);
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKETH_LEDGER = 'ss3zol-vqaaa-aaaar-qacpa-cai';
const MINTER = 'sv3dd-oaaaa-aaaar-qacoa-cai';
const RECIPIENT = '0x6B1C4D33832ba8B21Fa454C1F16E332D4c1183b9';
const AMOUNT = '168587000'; // 0.168587 ckUSDC (6 decimals)
const CKUSDC_FEE = '10000'; // the ckUSDC ledger fee
const GAS_FEE_WEI = '139728817410'; // the minter's live gas figure
const CKETH_FEE = '10000000000'; // the ckETH ledger fee

describe('prepareErc20Withdrawal — the approve amounts', () => {
  beforeEach(async () => {
    jest.resetAllMocks();
    (AsyncStorage as unknown as {clear: () => void}).clear = jest.fn();
    jest.mocked(icStampExpiry).mockResolvedValue(1_000_000_000_000n as unknown as Awaited<ReturnType<typeof icStampExpiry>>);
    // icrc1_fee: ckETH first, then ckUSDC (call order in prepareErc20Withdrawal).
    jest.mocked(icQuery).mockResolvedValue('reply-hex' as never);
    jest.mocked(DpayCore.icpDecodeInt)
      .mockResolvedValueOnce(CKETH_FEE as never)
      .mockResolvedValueOnce(CKUSDC_FEE as never);
    jest.mocked(DpayCore.icpSignUpdate).mockResolvedValue({
      envelopeHex: 'envelope-hex',
      requestIdHex: 'request-id-hex',
    } as never);
    jest.mocked(DpayCore.icpWithdrawErc20Arg).mockResolvedValue('withdraw-arg-hex' as never);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('the amount approve carries amount + ledger fee — an exact-amount approve burns one fee and fails the withdrawal', async () => {
    await prepareErc20Withdrawal(SECRET, CKUSDC_LEDGER, CKETH_LEDGER, MINTER, RECIPIENT, AMOUNT, GAS_FEE_WEI);

    const approve = jest.mocked(DpayCore.icpApproveArg).mock.calls;
    expect(approve).toHaveLength(2);
    // Leg 1 — the gas toll on ckETH: the minter's live gas figure, the gas ledger's own fee.
    expect(approve[0]).toEqual([MINTER, '', '', GAS_FEE_WEI, '', '', '', CKETH_FEE]);
    // Leg 2 — the amount on ckUSDC: amount + the ckUSDC ledger fee (ICRC-2 draws the fee
    // from the allowance on top of the amount).
    expect(approve[1]).toEqual([MINTER, '', '', '168597000', '', '', '', CKUSDC_FEE]);
    // The burn request itself stays EXACTLY the amount.
    expect(jest.mocked(DpayCore.icpWithdrawErc20Arg).mock.calls).toEqual([
      [AMOUNT, CKUSDC_LEDGER, RECIPIENT, '', ''],
    ]);
  });

  test('the signed envelopes: three steps — approve-gas, approve-amount, withdraw', async () => {
    const steps = await prepareErc20Withdrawal(SECRET, CKUSDC_LEDGER, CKETH_LEDGER, MINTER, RECIPIENT, AMOUNT, GAS_FEE_WEI);

    expect(steps.map(s => s.label)).toEqual(['approve-gas', 'approve-amount', 'withdraw']);
    expect(steps.map(s => s.ledger)).toEqual([CKETH_LEDGER, CKUSDC_LEDGER, MINTER]);
    expect(jest.mocked(DpayCore.icpSignUpdate).mock.calls.map(c => c[2])).toEqual([
      'icrc2_approve', 'icrc2_approve', 'withdraw_erc20',
    ]);
  });
});
