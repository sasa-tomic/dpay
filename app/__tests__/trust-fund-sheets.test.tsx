/**
 * Trust-button sheet wiring (2026-08-17 plan) — the GATE matrix on the two surfaces that host
 * TrustWalletFundButton, plus the integration truth: the address the sheet shows is the address
 * the deep link pre-fills.
 *
 *   DepositSheet (IC rail)     : mainnet ckBTC + address loaded → button; testnet ckBTC → none.
 *   SolanaReceiveSheet (SOL)   : SOL + USDC variants → button (jest runs mainnet RPC config).
 *   Platform                   : android renders; ios/web → absent (plan: android-only).
 *
 * jest.setup sets __DPAY_TEST_SOLANA_RPC_URL='' → IS_SOLANA_DEVNET=false → the SOL sheet runs
 * its mainnet branch here; the devnet branch (copy/QR status quo) is pinned at the call site
 * via the IS_SOLANA_DEVNET read in SolanaReceiveSheet. DepositSheet's async address fetch is
 * mocked at the services/rail seam (the smallest boundary); deposit info is left to fail
 * best-effort (the sheet tolerates a null info by design).
 */
import {describe, test, expect, beforeEach, afterEach, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Platform, Linking} from 'react-native';

import {DepositSheet} from '../components/DepositSheet';
import {SolanaReceiveSheet} from '../components/SolanaReceiveSheet';
import {BUNDLED_CATALOG, familyDisplay} from '../config/catalog';
import type {Identity} from '../lib/types';

jest.mock('../services/rail', () => ({
  railBtcDepositAddress: jest.fn(() => Promise.resolve('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh')),
  railBalanceOf: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('../services/relay', () => ({
  depositInfo: jest.fn(() => Promise.reject(new Error('offline test'))),
}));

const IDENTITY: Identity = {secretHex: '11'.repeat(32), publicHex: '22'.repeat(32), username: 'test'};
const BTC_ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const SOL_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const setOS = (os: string) => { (Platform as {OS: string}).OS = os; };

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

function pressByTestID(tree: renderer.ReactTestRenderer, testID: string): void {
  const node = tree.root.findAll(node => node.props && node.props.testID === testID)[0];
  if (!node) throw new Error(`no node with testID=${testID}`);
  act(() => { node.props.onPress(); });
}

// Testnet ckBTC = the mainnet descriptor on a non-mainnet network (how the testnet toggle row
// actually arrives). Currency id 3 matches the e2e testnet-toggle convention.
const TESTNET_CATALOG = [
  ...BUNDLED_CATALOG,
  {...BUNDLED_CATALOG.find(c => c.currency === 1)!, currency: 3, network: 'Bitcoin Testnet'},
];

let mockLinkingOpenURL: jest.Mock<(uri: string) => Promise<void>>;

beforeEach(() => {
  setOS('android');
  mockLinkingOpenURL = jest.fn<(uri: string) => Promise<void>>().mockResolvedValue(undefined);
  (Linking.openURL as unknown) = mockLinkingOpenURL;
});
afterEach(() => { setOS('android'); });

describe('DepositSheet — Trust gate (IC rail, mainnet CkBtcUtxo only)', () => {
  test('mainnet ckBTC + address loaded → Trust button; tap deep-links the DEPOSIT address', async () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DepositSheet identity={IDENTITY} relayUrl="https://relay.test" catalog={BUNDLED_CATALOG}
          currency={1} display={familyDisplay(BUNDLED_CATALOG, 1)!} onClose={() => {}} />,
      );
    });
    // Flush the async address fetch (mocked at the rail seam).
    await act(async () => { await Promise.resolve(); });
    expect(has(tree, 'deposit-address')).toBe(true);
    expect(has(tree, 'btn-trust-fund')).toBe(true);
    await act(async () => { pressByTestID(tree, 'btn-trust-fund'); });
    expect(mockLinkingOpenURL).toHaveBeenCalledWith(`https://link.trustwallet.com/send?asset=c0&address=${BTC_ADDR}`);
    act(() => { tree.unmount(); });
  });

  test('testnet ckBTC → copy/QR status quo, NO Trust button (no testnet UAI exists)', async () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DepositSheet identity={IDENTITY} relayUrl="https://relay.test" catalog={TESTNET_CATALOG}
          currency={3} display={familyDisplay(TESTNET_CATALOG, 3)!} onClose={() => {}} />,
      );
    });
    await act(async () => { await Promise.resolve(); });
    expect(has(tree, 'deposit-address')).toBe(true);   // the address + QR path is intact
    expect(has(tree, 'btn-trust-fund')).toBe(false);   // …just no Trust deep link
    act(() => { tree.unmount(); });
  });

  test('web → no Trust button (web keeps the copy/QR story)', async () => {
    setOS('web');
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <DepositSheet identity={IDENTITY} relayUrl="https://relay.test" catalog={BUNDLED_CATALOG}
          currency={1} display={familyDisplay(BUNDLED_CATALOG, 1)!} onClose={() => {}} />,
      );
    });
    await act(async () => { await Promise.resolve(); });
    expect(has(tree, 'deposit-address')).toBe(true);
    expect(has(tree, 'btn-trust-fund')).toBe(false);
    act(() => { tree.unmount(); });
  });
});

describe('SolanaReceiveSheet — Trust gate (native SOL rail)', () => {
  const mount = (token: 'SOL' | 'USDC') => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SolanaReceiveSheet address={SOL_ADDR} token={token} onClose={() => {}} />);
    });
    return tree;
  };

  test('SOL (mainnet) → Trust button deep-links the shown SOL address', async () => {
    const tree = mount('SOL');
    expect(has(tree, 'btn-trust-fund')).toBe(true);
    await act(async () => { pressByTestID(tree, 'btn-trust-fund'); });
    expect(mockLinkingOpenURL).toHaveBeenCalledWith(`https://link.trustwallet.com/send?asset=c501&address=${SOL_ADDR}`);
    act(() => { tree.unmount(); });
  });

  test('USDC (mainnet) → Trust button with the SPL asset id + this ATA', async () => {
    const tree = mount('USDC');
    expect(has(tree, 'btn-trust-fund')).toBe(true);
    await act(async () => { pressByTestID(tree, 'btn-trust-fund'); });
    expect(mockLinkingOpenURL).toHaveBeenCalledWith(
      `https://link.trustwallet.com/send?asset=c501_tEPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&address=${SOL_ADDR}`);
    act(() => { tree.unmount(); });
  });

  test('web → no Trust button', () => {
    setOS('web');
    const tree = mount('SOL');
    expect(has(tree, 'btn-trust-fund')).toBe(false);
    act(() => { tree.unmount(); });
  });
});
