/**
 * SolanaWithdrawSheet — the USDC needs-SOL fee warning (2026-08-16 UX review finding 13).
 *
 * Sending USDC pays network fees (and a possible recipient-ATA creation) in SOL, so a wallet
 * with a KNOWN-zero SOL balance learns the real constraint up front: `sol-send-needs-sol`
 * renders inside the send form BEFORE any amount is typed. Known-zero only — the branch
 * matrix pins the honest-state contract:
 *   - USDC + solBalance '0' + NOT checking → warning renders (the covered case)
 *   - USDC + SOL still checking            → NO warning (never claim on an unconfirmed state)
 *   - USDC + funded SOL                    → NO warning
 *   - SOL token                            → never (a SOL send needs no second asset)
 *
 * The second contract pinned here is the Trip Readiness PAYMENT TESTED stamp: `sendSol`/`sendSpl`
 * resolve only on a CONFIRMED signature and throw otherwise, so the stamp follows the resolution
 * and never the catch. e2e flow 52 drives the real send end to end but has no read of the journey
 * store, and only a mock can make the broadcast fail on demand.
 *
 * Uses react-test-renderer (the project's only renderer; no @testing-library). The sheet mounts
 * hooks (useEscapeToClose, useCopyFeedback) which are no-ops under jest — no stubs needed;
 * `identity` is only read inside confirm(), so a dummy seed renders safely with no network. The
 * Solana rail itself is mocked at its module boundary (the RPC is unreachable offline); the address
 * validator is NOT — the destination below is a real base58 Solana address.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('../solana', () => ({sendSol: jest.fn(), sendSpl: jest.fn()}));

import {sendSol} from '../solana';
import {hasStamp, loadJourney} from '../lib/journey';
import {SolanaWithdrawSheet} from '../components/SolanaWithdrawSheet';
import type {Identity} from '../lib/types';

const IDENT: Identity = {secretHex: 'ab'.repeat(32), publicHex: 'cd'.repeat(32), username: 't'};
const SOL_DEST = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear(); // the journey store is global — a stamp must not leak across tests
});

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

async function mount(props: Partial<Parameters<typeof SolanaWithdrawSheet>[0]> = {}) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <SolanaWithdrawSheet
        identity={IDENT}
        token="USDC"
        balance="2500000"
        onSent={() => {}}
        onClose={() => {}}
        {...props}
      />,
    );
  });
  return tree;
}

describe('SolanaWithdrawSheet — sol-send-needs-sol (USDC fees are paid in SOL)', () => {
  test('USDC + known-zero SOL (not checking) → the fee warning renders inside the form', async () => {
    const tree = await mount({solBalance: '0', solChecking: false});
    expect(has(tree, 'sol-send-needs-sol')).toBe(true);
    expect(has(tree, 'sol-send-address-input')).toBe(true); // the form itself stays intact
    act(() => { tree.unmount(); });
  });

  test('USDC + SOL still checking → NO warning (never claim insufficiency on an unconfirmed state)', async () => {
    const tree = await mount({solBalance: '0', solChecking: true});
    expect(has(tree, 'sol-send-needs-sol')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('USDC + funded SOL → NO warning', async () => {
    const tree = await mount({solBalance: '2044280', solChecking: false});
    expect(has(tree, 'sol-send-needs-sol')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('SOL token → never the USDC fee warning', async () => {
    const tree = await mount({token: 'SOL', balance: '2044280', solBalance: '0', solChecking: false});
    expect(has(tree, 'sol-send-needs-sol')).toBe(false);
    act(() => { tree.unmount(); });
  });
});

describe('SolanaWithdrawSheet — the PAYMENT TESTED stamp follows the CONFIRMED signature', () => {
  /** Fill the form, press Send, then give the journey store's write queue a macrotask to land. */
  async function sendAndReadStamp(tree: renderer.ReactTestRenderer): Promise<boolean> {
    await act(async () => {
      tree.root.findByProps({testID: 'sol-send-address-input'}).props.onChangeText(SOL_DEST);
      tree.root.findByProps({testID: 'sol-send-amount-input'}).props.onChangeText('0.5');
    });
    await act(async () => { await tree.root.findByProps({testID: 'btn-sol-send-confirm'}).props.onPress(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    return hasStamp(await loadJourney(), 'paymentTested');
  }

  test('a confirmed SOL transfer stamps it — the device-key rail earns the same stamp as the IC rails', async () => {
    // Rail parity (CLAUDE.md hard rule): the passport must not depend on which rail moved the money.
    jest.mocked(sendSol).mockResolvedValue('5ig'.repeat(10));
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    expect(await sendAndReadStamp(tree)).toBe(true);
    expect(has(tree, 'sol-send-signature')).toBe(true); // it really reached the confirmed screen
    act(() => { tree.unmount(); });
  });

  test('a broadcast that never confirmed stamps NOTHING — the error screen is not a payment made', async () => {
    // sendSol rejects on an RPC failure, an on-chain failure, and a confirmation timeout alike, so
    // this one catch is every unconfirmed outcome the rail has.
    jest.mocked(sendSol).mockRejectedValue(new Error('solana confirmation timeout'));
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    expect(await sendAndReadStamp(tree)).toBe(false);
    expect(has(tree, 'sol-send-err')).toBe(true);
    act(() => { tree.unmount(); });
  });
});
