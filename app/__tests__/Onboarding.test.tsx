/**
 * Onboarding — the create path's FUNDING DECISION, and the one thing that made it unreliable.
 *
 * The relay capability probe starts on mount; `finishCreate` runs the instant the user taps
 * Continue on the backup screen. Those two race, and the user wins it routinely — a phone on a
 * hotel wifi, a relay a continent away, a person who has already written their words down. Reading
 * the probe's answer as a BOOLEAN sampled at that instant means "not answered yet" and "this relay
 * has no faucet" are the same value, so a wallet is created unfunded against a perfectly healthy
 * relay and nothing on screen or in the log says why. Awaiting the PROMISE is the fix, and these
 * tests are the race, run deliberately: the capability answer is held back until after the tap.
 *
 * Both directions are pinned, because "always ask the faucet" would pass a one-sided test: a relay
 * that answers `demo_faucet:false` must be taken at its word and never asked.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {describe, expect, test, jest, beforeEach, afterEach} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {JOURNEY_STORAGE_KEY} from '../config/constants';
import {Onboarding} from '../components/Onboarding';

const PUBLIC_HEX = 'ab'.repeat(32);

// The device key is the native core's business, not this screen's — stub it so the test is about
// the funding decision and nothing else.
jest.mock('../services/native', () => ({
  DpayCore: {
    generateKeypair: async () => ({secretHex: '11'.repeat(32), publicHex: 'ab'.repeat(32)}),
    keypairFromSecret: async (secretHex: string) => ({secretHex, publicHex: 'ab'.repeat(32)}),
  },
}));

type Tree = renderer.ReactTestRenderer;

function findByTestID(tree: Tree, id: string): renderer.ReactTestInstance {
  const matches = tree.root.findAll(node => node.props && node.props.testID === id);
  if (matches.length === 0) throw new Error(`no node with testID=${id}`);
  return matches[0];
}

function isPresent(tree: Tree, id: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === id).length > 0;
}

const realFetch = globalThis.fetch;

/**
 * A relay whose `/api/v1/capabilities` answer is DEFERRED until the test releases it, and whose
 * faucet records every POST. Returns the release handle and the recorded faucet bodies.
 */
function installDeferredRelay() {
  const faucetPosts: string[] = [];
  let release!: (capabilities: {checkout: boolean; demo_faucet: boolean}) => void;
  const answered = new Promise<{checkout: boolean; demo_faucet: boolean}>(r => { release = r; });
  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    if (String(url).includes('/api/v1/capabilities')) {
      return answered.then(body => ({ok: true, status: 200, json: () => Promise.resolve(body)} as unknown as Response));
    }
    if (String(url).includes('/api/v1/faucet')) {
      faucetPosts.push(String(init?.body ?? ''));
      return Promise.resolve({ok: true, status: 200, json: () => Promise.resolve({balance: '10000'})} as unknown as Response);
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  (globalThis as unknown as {fetch: unknown}).fetch = fetchMock;
  return {faucetPosts, release};
}

/** Mount the create screen past the first-run walkthrough gate, and tap through to Continue. */
async function createUpToContinue(): Promise<Tree> {
  await AsyncStorage.setItem(
    JOURNEY_STORAGE_KEY,
    JSON.stringify({stamps: ['walkthroughDone'], at: {walkthroughDone: 1}, seen: []}),
  );
  let tree!: Tree;
  await act(async () => {
    tree = renderer.create(<Onboarding relayUrl="http://relay.example" onCreated={() => {}} onRestored={() => {}} />);
  });
  // The journey read resolves → the create form replaces the walkthrough gate.
  await act(async () => {});
  await act(async () => { findByTestID(tree, 'btn-create').props.onPress(); });
  // The backup gate: acknowledge the words, then Continue — the tap that races the probe.
  await act(async () => { findByTestID(tree, 'mnemonic-backup-checkbox').props.onPress(); });
  await act(async () => { findByTestID(tree, 'btn-mnemonic-continue').props.onPress(); });
  return tree;
}

describe('Onboarding — demo funding waits for the relay to answer', () => {
  beforeEach(() => AsyncStorage.clear());
  afterEach(() => { (globalThis as unknown as {fetch: unknown}).fetch = realFetch; });

  test('a Continue tapped BEFORE the capability answer still funds the wallet once the relay says it has a faucet', async () => {
    const {faucetPosts, release} = installDeferredRelay();
    const tree = await createUpToContinue();

    // The probe has not answered yet, so nothing has been asked of the faucet.
    expect(faucetPosts).toEqual([]);

    await act(async () => { release({checkout: false, demo_faucet: true}); });

    expect(faucetPosts).toHaveLength(1);
    expect(faucetPosts[0]).toContain(PUBLIC_HEX);
    // …and the sequence moves on to the RECOVERY SAVED beat, funded.
    expect(isPresent(tree, 'recovery-saved-stamp')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('a relay that answers "no faucet" is taken at its word — no request, no error screen', async () => {
    const {faucetPosts, release} = installDeferredRelay();
    const tree = await createUpToContinue();

    await act(async () => { release({checkout: false, demo_faucet: false}); });

    expect(faucetPosts).toEqual([]);
    // Wallet creation never depended on funding: the user lands on the same beat, with $0.
    expect(isPresent(tree, 'recovery-saved-stamp')).toBe(true);
    act(() => { tree.unmount(); });
  });

  // The other half of waiting: what the user is looking AT while it happens. This window is short
  // against a fast relay and is exactly the slow one against a slow one, and it used to render the
  // logo and tagline over an empty page — a hang, at the moment the user has just been told their
  // words are the only way back.
  test('the wait renders a working state, not an empty page', async () => {
    const {release} = installDeferredRelay();
    const tree = await createUpToContinue();

    expect(isPresent(tree, 'onboard-finishing')).toBe(true);
    expect(isPresent(tree, 'recovery-saved-stamp')).toBe(false);

    await act(async () => { release({checkout: false, demo_faucet: false}); });

    expect(isPresent(tree, 'onboard-finishing')).toBe(false);
    act(() => { tree.unmount(); });
  });
});
