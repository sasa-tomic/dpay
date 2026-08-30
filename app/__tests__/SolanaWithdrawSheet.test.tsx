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
import {deriveSolanaAddress} from '../solana/identity';
import {hasStamp, loadJourney} from '../lib/journey';
import {loadAddressBook} from '../services/addressBook';
import {SolanaWithdrawSheet} from '../components/SolanaWithdrawSheet';
import type {Identity} from '../lib/types';
import {M} from '../i18n';

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

// Rail parity for the destination field (2026-08-30). This sheet used to own a bare TextInput whose
// only verdict was "not a valid Solana address" — it could not tell a typo from a Bitcoin address
// pasted into the wrong wallet, and it had neither the scanner nor the address book the IC surface
// already had. It now runs the SHARED AddressField over the shared destination classifier, so both
// rails refuse in the same words. `destination.test.ts` pins the policy table; these pin what this
// sheet does with it.
describe('SolanaWithdrawSheet — the shared destination field', () => {
  /** The AddressField double is the real component; `status` is this sheet's verdict about the text. */
  const fieldOf = (tree: renderer.ReactTestRenderer) => tree.root.findByProps({testIDPrefix: 'sol-send'}).props;

  async function type(tree: renderer.ReactTestRenderer, text: string) {
    await act(async () => { tree.root.findByProps({testID: 'sol-send-address-input'}).props.onChangeText(text); });
  }

  test.each([
    ['a Bitcoin address', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'Bitcoin'],
    ['an Ethereum address', '0x2D39863d5A1E1B1e8b7b0b8c7c9d0e1f2a3b4c5d', 'Ethereum'],
    ['an Internet Computer principal', 'k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae', 'Internet Computer'],
  ])('%s is refused BY NAME — a wrong-chain paste is the dangerous mistake, so it gets named', async (_label, addr, chain) => {
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    await type(tree, addr);
    expect(fieldOf(tree)).toMatchObject({status: {text: M.withdraw.send.refuseWrongChain(chain, 'SOL', 'Solana'), tone: 'bad'}});
    expect(tree.root.findByProps({testID: 'btn-sol-send-confirm'}).props.disabled).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('a valid Solana address discloses the route BEFORE an amount is entered', async () => {
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    await type(tree, SOL_DEST);
    expect(fieldOf(tree)).toMatchObject({status: {text: M.withdraw.send.routeSolana('Solana'), tone: 'ok'}});
    act(() => { tree.unmount(); });
  });

  test('the wallet\'s OWN address warns without blocking — a self-send is legal, just pointless', async () => {
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    await type(tree, deriveSolanaAddress(IDENT.secretHex));
    expect(fieldOf(tree)).toMatchObject({status: {text: M.withdraw.send.selfWarning, tone: 'warn'}});
    act(() => { tree.unmount(); });
  });

  test('base58 text that is not a valid address is refused as a Solana problem, not a wrong chain', async () => {
    // Shape says base58, so the route is right and only the rail's own parser can reject it. The
    // two stages produce two different messages on purpose — "you pasted the wrong thing" and
    // "you pasted this thing wrong" need different fixes from the user.
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    await type(tree, SOL_DEST.slice(0, 33)); // right shape (33 base58 chars), decodes to 24 bytes
    expect(fieldOf(tree)).toMatchObject({status: {text: M.withdraw.badAddress('Solana'), tone: 'bad'}});
    act(() => { tree.unmount(); });
  });

  test('a confirmed send remembers the destination — the address book the IC rail already had', async () => {
    jest.mocked(sendSol).mockResolvedValue('5ig'.repeat(10));
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    await type(tree, SOL_DEST);
    await act(async () => { tree.root.findByProps({testID: 'sol-send-amount-input'}).props.onChangeText('0.5'); });
    await act(async () => { await tree.root.findByProps({testID: 'btn-sol-send-confirm'}).props.onPress(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    // Per-token key: SOL and USDC go to the same KIND of address but to different people.
    expect(await loadAddressBook('sol:SOL')).toMatchObject([{address: SOL_DEST}]);
    expect(await loadAddressBook('sol:USDC')).toEqual([]);
    act(() => { tree.unmount(); });
  });
});
