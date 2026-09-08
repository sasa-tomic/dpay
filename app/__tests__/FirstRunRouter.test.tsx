/**
 * The first-run router (spec docs/specs/2026-09-08-first-run-redesign.md §7.1) — ONE router over
 * persisted facts, in App.tsx, replacing the in-memory half-router that used to live inside
 * Onboarding.
 *
 * The case that gives this file its reason to exist is the app KILL. Until now the keypair was
 * written to `dpay.identity.v1` the instant Create was pressed and the 24 words were shown
 * afterwards, so a phone that died while the words were on screen came back with an identity —
 * and `Onboarding` only renders when there is none. The backup screen was therefore skipped
 * FOREVER, for a wallet whose owner had never written anything down. The fix is that a wallet is
 * PENDING until its words are acknowledged: `create()` writes `dpay.identity.pending.v1`, and only
 * `finishCreate()` promotes it. A reload mid-onboarding lands back on the SAME words.
 *
 * The other three cases are the router's own contract: no identity → Onboarding, an identity whose
 * first-run practice has not been seen → Practice, everything else → the wallet.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {describe, expect, test, jest, beforeEach} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {STORAGE_KEY, PENDING_IDENTITY_STORAGE_KEY, JOURNEY_STORAGE_KEY} from '../config/constants';

// The wallet is a whole application behind one component; this suite is about which of three
// surfaces the router picks, so it is stubbed. Practice is stubbed for the same reason — its own
// behaviour is Practice.test.tsx's subject — but its seen-marker key is the REAL one, re-exported
// from the module under test's own source, so a rename cannot make this suite pass by accident.
jest.mock('../components/Wallet', () => {
  const {Text} = require('react-native');
  return {Wallet: () => <Text testID="stub-wallet">wallet</Text>};
});
jest.mock('../components/Practice', () => {
  const {Text} = require('react-native');
  return {
    Practice: () => <Text testID="stub-practice">practice</Text>,
    FIRST_RUN_PRACTICE: jest.requireActual<typeof import('../components/Practice')>('../components/Practice').FIRST_RUN_PRACTICE,
  };
});
// The device key + the app's on-mount self-check are the native core's business, not the router's.
jest.mock('../services/native', () => ({
  DpayCore: {
    generateKeypair: async () => ({secretHex: '11'.repeat(32), publicHex: 'ab'.repeat(32)}),
    keypairFromSecret: async (secretHex: string) => ({secretHex, publicHex: 'ab'.repeat(32)}),
    icpSelfPrincipal: async () => 'x'.repeat(50),
    icpPrincipalFromPubkey: async () => 'y'.repeat(50),
    icpTransferArg: async () => '00',
    icpSignUpdate: async () => ({envelopeHex: '0'.repeat(800), requestIdHex: 'rid'}),
    icpEnvelopeRequestId: async () => 'rid',
  },
}));

import App from '../App';
import {FIRST_RUN_PRACTICE} from '../components/Practice';

type Tree = renderer.ReactTestRenderer;

function isPresent(tree: Tree, id: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === id).length > 0;
}

const IDENTITY = {secretHex: '11'.repeat(32), publicHex: 'ab'.repeat(32), username: 'me'};

/** Mount the app root and let its batched mount reads (identity, relay, theme, locale, currency,
 *  journey) settle before anything is asserted. */
async function boot(): Promise<Tree> {
  let tree!: Tree;
  await act(async () => { tree = renderer.create(<App />); });
  await act(async () => {});
  return tree;
}

async function seedJourney(stamps: string[], seen: string[]): Promise<void> {
  await AsyncStorage.setItem(JOURNEY_STORAGE_KEY, JSON.stringify({stamps, at: {}, seen}));
}

describe('first-run router', () => {
  beforeEach(() => AsyncStorage.clear());

  test('an app killed with the 24 words on screen comes back TO the backup gate, not past it', async () => {
    // Exactly the state `create()` leaves behind: the keypair is pending, nothing is the wallet's
    // identity yet, and the walkthrough is already done.
    await seedJourney(['walkthroughDone'], []);
    await AsyncStorage.setItem(PENDING_IDENTITY_STORAGE_KEY, JSON.stringify(IDENTITY));

    const tree = await boot();

    expect(isPresent(tree, 'mnemonic-backup')).toBe(true);
    expect(isPresent(tree, 'btn-mnemonic-continue')).toBe(true);
    // The wallet is unreachable and the practice screen has not been reached either: the words
    // come first.
    expect(isPresent(tree, 'stub-wallet')).toBe(false);
    expect(isPresent(tree, 'stub-practice')).toBe(false);
    // …and the identity is still NOT the wallet's, so a second kill lands here again.
    expect(await AsyncStorage.getItem(STORAGE_KEY)).toBeNull();
    act(() => { tree.unmount(); });
  });

  test('no identity at all → the create screen', async () => {
    await seedJourney(['walkthroughDone'], []);
    const tree = await boot();
    expect(isPresent(tree, 'btn-create')).toBe(true);
    expect(isPresent(tree, 'stub-practice')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('an identity whose first run has not practised → Practice, never straight to the wallet', async () => {
    await seedJourney(['walkthroughDone', 'recoverySaved'], []);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(IDENTITY));
    const tree = await boot();
    expect(isPresent(tree, 'stub-practice')).toBe(true);
    expect(isPresent(tree, 'stub-wallet')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('once practice is seen → the wallet, and practice never returns', async () => {
    await seedJourney(['walkthroughDone', 'recoverySaved'], [FIRST_RUN_PRACTICE]);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(IDENTITY));
    const tree = await boot();
    expect(isPresent(tree, 'stub-wallet')).toBe(true);
    expect(isPresent(tree, 'stub-practice')).toBe(false);
    act(() => { tree.unmount(); });
  });
});
