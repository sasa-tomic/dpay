/**
 * WithdrawSheet double-burn guard (P0, post-cutover audit 2026-08-20).
 *
 * The bug: any failure (reject OR unknown) → phase 'error' → a re-Confirm re-ran
 * prepareBtcWithdrawal/prepareEthWithdrawal/prepareErc20Withdrawal = FRESH signed envelopes
 * (new request_ids) for steps possibly already in flight = the same withdrawal can execute twice.
 *
 * The fix (services/offrampRetry.ts + offrampPersist.ts): once a sequence is prepared its steps
 * are RETAINED (component state + AsyncStorage). planOfframpConfirm(retained) decides each
 * Confirm: null → prepare fresh (safe: nothing in flight — first attempt or a clean pre-submit
 * failure such as the gas-fee fetch throwing before any envelope is signed); non-null → RESUME
 * the SAME envelope bytes from the first not-yet-settled step (identical-byte resubmission is
 * request_id-dedup'd; a re-signed envelope never exists). Deliberately editing the form drops
 * the retention (a NEW withdrawal intent).
 *
 * This suite pins BOTH layers:
 *  - pure: planOfframpConfirm + hydrateOfframp decisions (no rendering);
 *  - component: retry-after-unknown reuses identical envelope bytes (prepare* called ONCE, the
 *    SAME step bytes resubmitted), persisted across a remount (restart-mid-offramp resume), and
 *    editing the form re-enables fresh preparation.
 *
 * The DESTINATION is a PROP (SendSheet owns the one shared address field — see components/
 * SendSheet.tsx + AddressField.tsx), so "the user edited the destination" is modelled here as a
 * re-render with a new `address`, and the two callbacks that cross that boundary are asserted
 * directly: `onResumeAddress` pushes a hydrated in-flight destination back UP into the shared
 * field, and `onSaveAddress` hands the settled destination to the shared address book.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

jest.mock('../services/native', () => ({DpayCore: {}}));
jest.mock('../services/relay', () => ({fetchWithTimeout: jest.fn()}));
jest.mock('../services/rail', () => ({
  prepareBtcWithdrawal: jest.fn(),
  prepareEthWithdrawal: jest.fn(),
  prepareErc20Withdrawal: jest.fn(),
  submitOfframpStep: jest.fn(),
  fetchGasFeeWei: jest.fn(),
}));

import {
  prepareEthWithdrawal,
  submitOfframpStep,
} from '../services/rail';
import {planOfframpConfirm} from '../services/offrampRetry';
import {hydrateOfframp, offrampKey} from '../services/offrampPersist';
import {WithdrawSheet} from '../components/WithdrawSheet';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {OfframpStep} from '../services/rail';
import type {Identity} from '../lib/types';
import type {CurrencyDescriptor, FamilyDisplay, MinterFamily} from '../config/catalog';

const IDENTITY: Identity = {secretHex: '11'.repeat(32), publicHex: '22'.repeat(32), username: 'Bob'};

const ETH_DEST = '0x1234567890abcdef1234567890abcdef12345678';
const DESC: CurrencyDescriptor = {
  currency: 4, ledger: 'ryjxe-uaaaa-aaaaa-aaabq-cai', mintable: false,
  minter: 'sv3dd-oaaaa-aaaar-qacoa-cai', minter_family: 'CkEthErc20' as MinterFamily,
  symbol: 'ckETH', decimals: 18, wrapper_name: 'ckETH', backing_symbol: 'ETH',
  network: 'Ethereum', display_decimals: 6,
  fee: '20000000000000', cap: null, chain_id: 1, token_contract: null, gas_ledger: null,
  onramp: 'Direct', offramp: 'Direct', testnet: false,
};
const DISPLAY: FamilyDisplay = {
  networkLabel: 'Ethereum', nativeAsset: 'ETH',
  amountDecimals: 6, blockMin: 1, withdrawMinRaw: 35_000_000_000_000, addressPlaceholder: '0x…',
};

// react-test-renderer renders <Text> fine; only Pressable/TextInput need nothing special under
// the RN jest preset. (Keep the import above referenced so noUnusedLocals-style lint stays happy.)
void Text;

const STEPS: OfframpStep[] = [
  {ledger: 'ryjxe-uaaaa-aaaaa-aaabq-cai', envelopeHex: 'aa' + '01'.repeat(100), requestIdHex: 'r1', label: 'approve gas'},
  {ledger: 'ryjxe-uaaaa-aaaaa-aaabq-cai', envelopeHex: 'bb' + '02'.repeat(100), requestIdHex: 'r2', label: 'withdraw'},
];

/** The sheet element for a given shared-field destination. Factored out so a test can RE-RENDER
 *  with a different `address` — that is what "the user edited the destination" now looks like from
 *  this component's side, since the field itself lives in SendSheet. */
type Handlers = {onResumeAddress?: (a: string) => void; onSaveAddress?: (a: string) => void};
function sheet(address: string, h: Handlers = {}) {
  return (
    <WithdrawSheet
      identity={IDENTITY} catalog={[DESC]} currency={4} decimals={18} display={DISPLAY}
      family={'CkEthErc20' as MinterFamily} tokenContract={null} balance="1000000000000000"
      address={address}
      onResumeAddress={h.onResumeAddress ?? (() => {})}
      onSaveAddress={h.onSaveAddress ?? (() => {})}
      onClose={() => {}} onWithdrawn={() => {}}
    />
  );
}

async function renderSheet(address = ETH_DEST, h: Handlers = {}) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(sheet(address, h)); });
  return tree;
}

async function driveConfirm(root: renderer.ReactTestRenderer) {
  const btn = root.root.findByProps({testID: 'btn-withdraw-confirm'});
  await act(async () => { await btn.props.onPress(); });
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear(); // in-flight records must not leak across tests
  // Deterministic defaults; individual tests override with mockResolvedValueOnce chains.
  jest.mocked(prepareEthWithdrawal).mockReset().mockResolvedValue(STEPS.map(s => ({...s})));
  jest.mocked(submitOfframpStep).mockReset().mockResolvedValue({kind: 'settled', blockIndex: '1'});
  const {fetchGasFeeWei} = await import('../services/rail');
  jest.mocked(fetchGasFeeWei).mockReset().mockResolvedValue('1000');
});

describe('planOfframpConfirm (pure retry decision)', () => {
  test('no retained offramp → prepare fresh (first attempt / clean pre-submit failure)', () => {
    expect(planOfframpConfirm(null)).toEqual({kind: 'prepare'});
  });

  test('retained → resume the SAME steps from the first not-yet-settled index', () => {
    const plan = planOfframpConfirm({steps: STEPS, nextIdx: 1, destination: ETH_DEST, amountRaw: '1000'});
    expect(plan.kind).toBe('resume');
    if (plan.kind !== 'resume') return;
    expect(plan.from).toBe(1);
    expect(plan.record.steps).toBe(STEPS); // the very same array — no re-signing, no copying semantics
  });

  test('out-of-range nextIdx clamps to a valid pending step, never past the end', () => {
    expect(planOfframpConfirm({steps: STEPS, nextIdx: 99, destination: ETH_DEST, amountRaw: '1'}).kind).toBe('resume');
    const clamped = planOfframpConfirm({steps: STEPS, nextIdx: -3, destination: ETH_DEST, amountRaw: '1'});
    if (clamped.kind !== 'resume') throw new Error('expected resume');
    expect(clamped.from).toBe(0);
  });

  test('empty steps → prepare (a degenerate record is treated as nothing-in-flight)', () => {
    expect(planOfframpConfirm({steps: [], nextIdx: 0, destination: '', amountRaw: ''})).toEqual({kind: 'prepare'});
  });
});

describe('hydrateOfframp (persisted-record validation)', () => {
  test('round-trips a well-formed in-flight record', () => {
    const rec = hydrateOfframp({currency: 4, destination: ETH_DEST, amountRaw: '1000', steps: STEPS, nextIdx: 1});
    expect(rec?.steps).toEqual(STEPS);
    expect(rec?.nextIdx).toBe(1);
  });

  test('rejects a record whose nextIdx is past every step (fully settled must never persist)', () => {
    expect(hydrateOfframp({currency: 4, destination: ETH_DEST, amountRaw: '1000', steps: STEPS, nextIdx: STEPS.length})).toBeNull();
  });

  test('rejects malformed shapes (no crash on corrupt storage)', () => {
    expect(hydrateOfframp(null)).toBeNull();
    expect(hydrateOfframp('watching')).toBeNull();
    expect(hydrateOfframp({currency: 4, destination: 7, amountRaw: '1', steps: STEPS, nextIdx: 0})).toBeNull();
    expect(hydrateOfframp({currency: 4, destination: ETH_DEST, amountRaw: '1', steps: [{ledger: 'x'}], nextIdx: 0})).toBeNull();
  });

  test('key names off pubkey + currency (per-user, per-asset namespace)', () => {
    expect(offrampKey('ab'.repeat(32), 4)).toBe(`dpay.offramp.${'ab'.repeat(32)}.4`);
  });
});

describe('WithdrawSheet retry-after-unknown (double-burn guard)', () => {
  test('re-Confirm after an UNKNOWN step resubmits the IDENTICAL envelope bytes (prepare* runs ONCE)', async () => {
    jest.mocked(submitOfframpStep)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'})   // approve settles
      .mockResolvedValueOnce({kind: 'unknown'})   // withdraw unknown → error phase
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'})   // retry: same withdraw envelope settles
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'});

    const onSaveAddress = jest.fn();
    const root = await renderSheet(ETH_DEST, {onSaveAddress});
    await act(async () => {
      root.root.findByProps({testID: 'withdraw-amount-input'}).props.onChangeText('0.001');
    });
    await driveConfirm(root);

    // First attempt: prepared once, step[0] settled, step[1] unknown → error surfaced.
    expect(prepareEthWithdrawal).toHaveBeenCalledTimes(1);
    expect(root.root.findByProps({testID: 'withdraw-err'}).props.children).toContain("Couldn't confirm the withdrawal");

    // Retry: the SAME step[1] bytes are resubmitted — prepare* NOT called again.
    await driveConfirm(root);
    expect(prepareEthWithdrawal).toHaveBeenCalledTimes(1);
    const calls = jest.mocked(submitOfframpStep).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[1][0].envelopeHex).toBe(STEPS[1].envelopeHex);
    expect(calls[2][0].envelopeHex).toBe(STEPS[1].envelopeHex);
    expect(calls[2][0].envelopeHex).not.toBe(STEPS[0].envelopeHex);

    // Settled end-to-end: done screen, retention cleared (no resume card), record removed, and the
    // settled destination handed to the shared address book EXACTLY once (not per submitted step).
    expect(root.root.findByProps({testID: 'withdraw-status'}).props.children).toBe('Withdrawn ✓');
    expect(await AsyncStorage.getItem(offrampKey(IDENTITY.publicHex, 4))).toBeNull();
    expect(onSaveAddress.mock.calls).toEqual([[ETH_DEST]]);
    act(() => { root.unmount(); });
  });

  test('restart-mid-offramp: a persisted record resumes the SAME bytes without re-preparing', async () => {
    // Simulate the crash: approve settled, withdraw unknown, record persisted at nextIdx=1.
    jest.mocked(submitOfframpStep)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'})
      .mockResolvedValueOnce({kind: 'unknown'})
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'});

    const first = await renderSheet();
    await act(async () => {
      first.root.findByProps({testID: 'withdraw-amount-input'}).props.onChangeText('0.001');
    });
    await driveConfirm(first);
    expect(jest.mocked(submitOfframpStep).mock.calls).toHaveLength(2);
    act(() => { first.unmount(); });

    // Fresh mount (restart) — the shared destination field starts EMPTY, as it does after an app
    // restart. The resume effect hydrates the record and pushes the in-flight destination back up
    // to the parent field; Confirm then resumes verbatim.
    const onResumeAddress = jest.fn();
    const second = await renderSheet('', {onResumeAddress});
    await act(async () => { await Promise.resolve(); }); // let the load effects settle
    expect(second.root.findByProps({testID: 'withdraw-resume'}).props.testID).toBe('withdraw-resume');
    expect(onResumeAddress.mock.calls).toEqual([[ETH_DEST]]);
    await driveConfirm(second);
    expect(prepareEthWithdrawal).toHaveBeenCalledTimes(1); // signed ONCE — before the "crash"
    const calls = jest.mocked(submitOfframpStep).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[2][0].envelopeHex).toBe(STEPS[1].envelopeHex);
    act(() => { second.unmount(); });
  });

  test('editing the form = a NEW withdrawal intent: retention dropped, fresh prepare allowed', async () => {
    jest.mocked(submitOfframpStep)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'})
      .mockResolvedValueOnce({kind: 'unknown'})
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'})
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'});

    const root = await renderSheet();
    await act(async () => {
      root.root.findByProps({testID: 'withdraw-amount-input'}).props.onChangeText('0.001');
    });
    await driveConfirm(root); // error phase, retained

    // User edits the destination in the SHARED field — it arrives here as a new `address` prop, and
    // the in-flight envelopes no longer match the form intent.
    const NEW_DEST = '0x9999999999999999999999999999999999999999';
    await act(async () => { root.update(sheet(NEW_DEST)); });
    // The review card (not the resume card) is back: this Confirm prepares FRESH envelopes.
    expect(root.root.findByProps({testID: 'withdraw-review'})).toBeDefined();
    await driveConfirm(root);
    expect(prepareEthWithdrawal).toHaveBeenCalledTimes(2);
    // prepareEthWithdrawal(secretHex, ckethLedger, minter, recipient, amountWei, gasFeeWei)
    expect(jest.mocked(prepareEthWithdrawal).mock.calls[1][3]).toBe(NEW_DEST);
    act(() => { root.unmount(); });
  });

  test('clean pre-submit failure (gas fetch null) re-prepares on retry — nothing was signed', async () => {
    // native-ETH path needs fetchGasFeeWei; mock it failing then succeeding.
    const {fetchGasFeeWei} = await import('../services/rail');
    jest.mocked(fetchGasFeeWei)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('1000');
    jest.mocked(submitOfframpStep).mockResolvedValue({kind: 'settled', blockIndex: '1'});

    const root = await renderSheet();
    await act(async () => {
      root.root.findByProps({testID: 'withdraw-amount-input'}).props.onChangeText('0.001');
    });
    await driveConfirm(root); // gas fetch null → clean pre-submit error
    expect(root.root.findByProps({testID: 'withdraw-err'}).props.children).toContain("Couldn't fetch the live gas fee");
    expect(prepareEthWithdrawal).not.toHaveBeenCalled(); // nothing was ever signed
    await driveConfirm(root); // retry — preparing fresh is SAFE (no envelope was ever submitted)
    // The first attempt threw at the gas fetch, BEFORE any prepare — so the retry's prepare is the
    // FIRST and only signature (a retained record never existed to resume).
    expect(prepareEthWithdrawal).toHaveBeenCalledTimes(1);
    expect(jest.mocked(submitOfframpStep).mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(root.root.findByProps({testID: 'withdraw-status'}).props.children).toBe('Withdrawn ✓');
    act(() => { root.unmount(); });
  });
});
