/**
 * CkErc20DepositSheet — watch honesty (verifier P2#5, 2026-08-20).
 *
 * The watching poll used to treat a NULL startBal (the connect-time snapshot failed) as
 * "any-positive balance ⇒ done" — so a wallet that ALREADY held the chain-key asset
 * false-positived 'done' on the very first poll, and a mint landing between a failed snapshot
 * and the first poll could too. The honest contract under test:
 *   - null baseline → the FIRST successful railBalanceOf read SETS the baseline (never done);
 *   - done requires OBSERVED GROWTH from a real baseline (cmpRaw(bal, startBal) > 0) — an
 *     equal-or-lower balance keeps watching;
 *   - persistence is unchanged: watching persists only once a real baseline exists, done clears it.
 *
 * Drives the REAL component wiring (connect → enter → submit → watching) with the wallet/rail
 * boundaries mocked; the connect-time snapshot is made to FAIL (null startBal), so the watching
 * poll is the only balance source — the exact P2#5 precondition.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('../services/native', () => ({
  DpayCore: {icpSelfPrincipal: jest.fn(async () => 'td2nx-oaaaa-aaaab-qhdnq-cai')},
}));
jest.mock('../services/relay', () => ({
  ckerc20OnrampParams: jest.fn(async () => ({
    helper_address: '0x' + '11'.repeat(20),
    erc20_address: '0x' + '22'.repeat(20),
    kind: 'erc20' as const,
  })),
}));
jest.mock('../services/rail', () => ({
  railBalanceOf: jest.fn(),
}));
jest.mock('../wallet', () => ({
  resolveOnrampProvider: jest.fn(async () => ({})),
  connectWallet: jest.fn(async () => '0xAbC0000000000000000000000000000000000dEaD'),
  getChainId: jest.fn(async () => 1),
  sendTransaction: jest.fn(async () => '0x' + 'aa'.repeat(32)),
  waitForReceipt: jest.fn(async () => undefined),
  ReceiptReverted: class ReceiptReverted extends Error {},
  ReceiptTimeout: class ReceiptTimeout extends Error {},
  pairOnrampWallet: jest.fn(async () => false),
  openWalletApp: jest.fn(async () => false),
}));
// The pairing-QR branch is unreachable here (wcUri only goes non-null on native via WalletConnect)
// but the module pulls react-native-svg — stub it like ReceiveMode stubs QrScanner.
jest.mock('../components/QrCode', () => ({QrCode: () => null}));

import {railBalanceOf} from '../services/rail';
import {loadDeposit} from '../services/ckerc20Persist';
import {CkErc20DepositSheet} from '../components/CkErc20DepositSheet';
import type {FamilyDisplay} from '../config/catalog';
import type {Identity} from '../lib/types';

const IDENTITY: Identity = {secretHex: '11'.repeat(32), publicHex: '22'.repeat(32), username: 'Bob'};
const LEDGER = 'td2nx-oaaaa-aaaab-qhdnq-cai';
const DISPLAY: FamilyDisplay = {
  networkLabel: 'Ethereum', nativeAsset: 'USDC',
  amountDecimals: 6, blockMin: 1, withdrawMinRaw: 1, addressPlaceholder: '0x…',
};

// The component warns on the deliberately-failed snapshot + poll errors — silence the noise.
// (Referenced so the strict noUnusedLocals gate keeps the spy declared.)
const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
void warnSpy;

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

function mountSheet() {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <CkErc20DepositSheet
        identity={IDENTITY} relayUrl="http://relay.test" currency={2} decimals={6}
        display={DISPLAY} chainId={null} nativeEth={false} ledger={LEDGER}
        onClose={() => {}}
      />,
    );
  });
  return tree;
}

/** connect → enter → submit: lands the sheet in 'watching'. railBalanceOf call #1 (the connect-time
 *  snapshot) must already be queued to REJECT, so startBal is null entering the watch. */
async function driveToWatching(tree: renderer.ReactTestRenderer) {
  await act(async () => { await Promise.resolve(); }); // let the mount effects (params, principal) settle
  await act(async () => {
    await tree.root.findByProps({testID: 'btn-connect-wallet'}).props.onPress();
  });
  await act(async () => {
    tree.root.findByProps({testID: 'ckerc20-amount'}).props.onChangeText('1');
  });
  await act(async () => {
    await tree.root.findByProps({testID: 'btn-approve'}).props.onPress();
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear(); // persisted watches must not leak across tests
});

describe('CkErc20DepositSheet — null-baseline watch honesty (P2#5)', () => {
  test('null baseline: the FIRST successful read SETS the baseline — never done, even with a pre-existing balance', async () => {
    // Snapshot fails at connect (null startBal); the wallet ALREADY holds 5 USDC. The first
    // watching read sees that balance — the old any-positive fallback would declare done here.
    jest.mocked(railBalanceOf)
      .mockRejectedValueOnce(new Error('ledger unreachable')) // connect-time snapshot → null
      .mockResolvedValueOnce('5000000')                       // first watching read → SETS baseline
      .mockImplementationOnce(() => new Promise<string>(() => {})); // post-baseline read — held
    const tree = mountSheet();
    await driveToWatching(tree);

    // Still watching (never done), and the baseline-set is observable in the PERSISTED record.
    expect(has(tree, 'btn-ckerc20-deposit-done')).toBe(false);
    const status = tree.root.findByProps({testID: 'ckerc20-status'}).props.children;
    expect(String(status)).toContain('Waiting for confirmation');
    const saved = await loadDeposit(IDENTITY.publicHex, 2);
    expect(saved?.phase).toBe('watching');
    expect(saved?.startBal).toBe('5000000'); // the baseline the first read set
    act(() => { tree.unmount(); });
  });

  test('growth after the baseline → done (observed growth is the only done path)', async () => {
    jest.mocked(railBalanceOf)
      .mockRejectedValueOnce(new Error('ledger unreachable')) // connect-time snapshot → null
      .mockResolvedValueOnce('5000000')                       // baseline
      .mockResolvedValueOnce('6000000');                      // the mint lands — growth
    const tree = mountSheet();
    await driveToWatching(tree);

    expect(has(tree, 'btn-ckerc20-deposit-done')).toBe(true); // the done screen
    expect(await loadDeposit(IDENTITY.publicHex, 2)).toBeNull(); // done cleared the key
    act(() => { tree.unmount(); });
  });

  test('an EQUAL balance after the baseline keeps watching (growth required, not mere presence)', async () => {
    jest.mocked(railBalanceOf)
      .mockRejectedValueOnce(new Error('ledger unreachable')) // connect-time snapshot → null
      .mockResolvedValueOnce('5000000')                       // baseline
      .mockResolvedValueOnce('5000000');                      // equal → cmpRaw == 0 → keep watching
    const tree = mountSheet();
    await driveToWatching(tree);

    expect(has(tree, 'btn-ckerc20-deposit-done')).toBe(false);
    expect(String(tree.root.findByProps({testID: 'ckerc20-status'}).props.children))
      .toContain('Waiting for confirmation');
    act(() => { tree.unmount(); });
  });
});
