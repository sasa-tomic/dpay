/**
 * PassportArchive render smoke (Trip Ready J5b) — the archive contract under
 * react-test-renderer: slot fill states + n-of-4 eyebrow + award dates, the ONE
 * next-step hint, NO Done affordance while incomplete, the live capstone (4th stamp
 * observed in-session → TRIP READY → Done retires the home strip + closes), and the
 * completed retired journey (static TRIP READY mark, Done still offered until the
 * user presses it once). Fake timers own the capstone clock.
 *
 * UX round 4 (2026-08-23): the Balances CARD variant is gone — the archive (opened
 * from the home TripStrip or Settings) is the one full-page surface AND the
 * celebration surface. The strip retires when Done is pressed here.
 *
 * The component reads the real journey store (AsyncStorage-mocked); each test seeds
 * stamps directly, then asserts — the award wiring itself (PayMode/ReceiveMode/SOL)
 * is e2e's job.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {describe, expect, test, jest, beforeEach, afterEach} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {JOURNEY_STORAGE_KEY} from '../config/constants';
import {PassportArchive} from '../components/TripPassport';
import {SettingsSheet} from '../components/SettingsSheet';
import {READINESS_STAMPS, type ReadinessKey} from '../lib/readiness';
import {useReducedMotion} from '../hooks/useReducedMotion';

// The reduced-motion seam, mocked suite-wide (default OFF; the one reduced test flips it).
// jest.mock (hoisted) is the pattern that works against the transpiled ESM namespace —
// a runtime jest.spyOn on the namespace object is non-writable and throws.
jest.mock('../hooks/useReducedMotion', () => ({useReducedMotion: jest.fn(() => false)}));
const reducedMock = useReducedMotion as unknown as jest.Mock;

type Tree = renderer.ReactTestRenderer;

function findByTestID(tree: Tree, id: string): renderer.ReactTestInstance {
  const matches = tree.root.findAll(node => node.props && node.props.testID === id);
  if (matches.length === 0) throw new Error(`no node with testID=${id}`);
  return matches[0];
}

function hasTestID(tree: Tree, id: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === id).length > 0;
}

async function render(props: {onStep?: (key: ReadinessKey) => void} = {}): Promise<Tree> {
  let tree!: Tree;
  await act(async () => { tree = renderer.create(<PassportArchive onClose={() => {}} {...props} />); });
  // Let the mount-time journey load resolve into state.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return tree;
}

/** Seed the persisted journey store (stamps + optional seen markers). */
async function seedJourney(stamps: string[], seen: string[] = []): Promise<void> {
  await AsyncStorage.setItem(
    JOURNEY_STORAGE_KEY,
    JSON.stringify({stamps, at: Object.fromEntries(stamps.map(s => [s, 1])), seen}),
  );
}

describe('PassportArchive (the one full-page surface)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    AsyncStorage.clear();
  });
  afterEach(() => {
    AsyncStorage.clear();
    jest.useRealTimers();
  });

  test('incomplete: 3/4 eyebrow, slot fill states, award dates, ONE hint, NO Done affordance', async () => {
    await seedJourney(['walkthroughDone', 'recoverySaved', 'fundsReady']);
    const tree = await render();
    expect(hasTestID(tree, 'passport-archive')).toBe(true);
    expect(findByTestID(tree, 'passport-count').props.children).toBe('2 OF 4');
    expect(hasTestID(tree, 'passport-slot-recoverySaved-filled')).toBe(true);
    expect(hasTestID(tree, 'passport-slot-fundsReady-filled')).toBe(true);
    expect(hasTestID(tree, 'passport-slot-flowUnderstood')).toBe(true);
    expect(hasTestID(tree, 'passport-slot-paymentTested')).toBe(true);
    // The ONE contextual next step names the first missing capability.
    expect(findByTestID(tree, 'passport-hint').props.children).toBe('Watch the rehearsal when creating a wallet — or make any payment');
    // Incomplete NEVER retires — no Done button exists.
    expect(hasTestID(tree, 'btn-passport-done')).toBe(false);
  });

  test('empty journey: 0 OF 4, hint = first stamp', async () => {
    await seedJourney([]);
    const tree = await render();
    expect(findByTestID(tree, 'passport-count').props.children).toBe('0 OF 4');
    expect(findByTestID(tree, 'passport-hint').props.children).toBe('Copy your backup words in Settings');
  });

  test('complete but NOT yet tripReady (first observation after the 4th stamp): capstone plays, then Done retires the strip', async () => {
    // The 4th stamp is always awarded while this page is unmounted (payments happen on the
    // Pay/Receive screens) — so "live" = first observation of the complete page. Seed all
    // four WITHOUT the tripReady stamp: the page must award + press, then offer Done.
    await seedJourney(['recoverySaved', 'flowUnderstood', 'fundsReady', 'paymentTested']);
    const tree = await render();
    expect(hasTestID(tree, 'passport-archive')).toBe(true);

    // The capstone overlay is playing immediately after load (the one-shot beat).
    await act(async () => { await Promise.resolve(); });
    expect(hasTestID(tree, 'trip-ready-capstone')).toBe(true);
    // Done does NOT exist while the press plays (one affordance at a time).
    expect(hasTestID(tree, 'btn-passport-done')).toBe(false);

    // The press runs its full clock, then lifts to reveal the static page + Done.
    await act(async () => { jest.advanceTimersByTime(2_400); });
    expect(hasTestID(tree, 'trip-ready-capstone')).toBe(false);
    expect(hasTestID(tree, 'btn-passport-done')).toBe(true);

    // Done → retire: tripReady + the seen-marker persist (the home strip reads them).
    await act(async () => { findByTestID(tree, 'btn-passport-done').props.onPress(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const raw = await AsyncStorage.getItem(JOURNEY_STORAGE_KEY) as string;
    const persisted = JSON.parse(raw);
    expect(persisted.stamps).toContain('tripReady');
    expect(persisted.seen).toContain('passportCollapsed');
  });

  test('the capstone NEVER replays: complete + tripReady already stamped (pre-Done) shows Done directly', async () => {
    // e.g. the archive was closed mid-press or re-rendered: the stamp latched, so the next
    // mount shows the static complete page + Done — no second press.
    await seedJourney([...READINESS_STAMPS, 'tripReady']);
    const tree = await render();
    expect(hasTestID(tree, 'passport-archive')).toBe(true);
    expect(hasTestID(tree, 'trip-ready-capstone')).toBe(false);
    expect(hasTestID(tree, 'btn-passport-done')).toBe(true);
  });

  test('complete + retired journey (Done pressed in an earlier session): the durable record, no capstone, no Done', async () => {
    await seedJourney([...READINESS_STAMPS, 'tripReady'], ['passportCollapsed']);
    const tree = await render();
    expect(hasTestID(tree, 'passport-archive')).toBe(true);
    expect(hasTestID(tree, 'trip-ready-capstone')).toBe(false);
    expect(hasTestID(tree, 'btn-passport-done')).toBe(false);
    // The completed page's durable mark + promise line are present.
    const texts = tree.root.findAll(n => typeof n.props?.children === 'string').map(n => n.props.children);
    expect(texts).toContain('Trip ready');
    expect(texts).toContain('You can pay even when your phone has no signal.');
  });

  test('reduced motion: complete un-stamped journey still reaches Done — via the at-rest 200ms beat, no animated press', async () => {
    reducedMock.mockReturnValue(true);
    try {
      await seedJourney(['recoverySaved', 'flowUnderstood', 'fundsReady', 'paymentTested']);
      const tree = await render();
      // No animated press overlay (the beat is instant at rest); Done appears after the brief
      // settle tick — same information, none of the motion.
      expect(hasTestID(tree, 'passport-archive')).toBe(true);
      await act(async () => { jest.advanceTimersByTime(400); });
      expect(hasTestID(tree, 'trip-ready-capstone')).toBe(false);
      expect(hasTestID(tree, 'btn-passport-done')).toBe(true);
    } finally {
      reducedMock.mockReturnValue(false);
    }
  });
});

describe('PassportArchive deep-link (unfilled-stamp routing — founder ask 2026-08-24)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    AsyncStorage.clear();
  });
  afterEach(() => {
    AsyncStorage.clear();
    jest.useRealTimers();
  });

  test('onStep: unfilled slots are pressable and fire their key; filled slots stay inert', async () => {
    await seedJourney(['recoverySaved', 'fundsReady']);
    const steps: string[] = [];
    const tree = await render({onStep: key => steps.push(key)});
    // Filled → the inked slot exists but has NO button wrapper (nothing left to complete).
    expect(hasTestID(tree, 'passport-slot-recoverySaved-filled')).toBe(true);
    expect(hasTestID(tree, 'passport-slot-btn-recoverySaved')).toBe(false);
    expect(hasTestID(tree, 'passport-slot-btn-fundsReady')).toBe(false);
    // Unfilled → the button wrapper exists and fires onStep with its exact key.
    expect(hasTestID(tree, 'passport-slot-btn-flowUnderstood')).toBe(true);
    expect(hasTestID(tree, 'passport-slot-btn-paymentTested')).toBe(true);
    await act(async () => { findByTestID(tree, 'passport-slot-btn-flowUnderstood').props.onPress(); });
    await act(async () => { findByTestID(tree, 'passport-slot-btn-paymentTested').props.onPress(); });
    expect(steps).toEqual(['flowUnderstood', 'paymentTested']);
  });

  test('no onStep: NO slot is pressable (back-compat — the plain archive)', async () => {
    await seedJourney([]);
    const tree = await render();
    const slotBtns = tree.root.findAll(n => typeof n.props?.testID === 'string' && n.props.testID.startsWith('passport-slot-btn-'));
    expect(slotBtns.length).toBe(0);
    // The bare slots still render with their pinned contract testIDs.
    for (const key of READINESS_STAMPS) expect(hasTestID(tree, `passport-slot-${key}`)).toBe(true);
  });

  test('onStep: btn-passport-next routes through onStep with the first-missing key', async () => {
    await seedJourney(['recoverySaved']);
    const steps: string[] = [];
    const tree = await render({onStep: key => steps.push(key)});
    expect(hasTestID(tree, 'btn-passport-next')).toBe(true);
    await act(async () => { findByTestID(tree, 'btn-passport-next').props.onPress(); });
    expect(steps).toEqual(['flowUnderstood']);
  });
});

describe('Passport deep-link wiring (the SettingsSheet host)', () => {
  const SHEET_DEFAULTS = {
    relayUrl: 'http://127.0.0.1:4391',
    setRelayUrl: () => {},
    localeChoice: null,
    onSetLocale: () => {},
    onClose: () => {},
    onReset: () => {},
    onRestore: async () => {},
    secretHex: 'ab'.repeat(32),
    username: 'Alice',
    themeChoice: null,
    onSetTheme: () => {},
  };

  beforeEach(() => {
    jest.useFakeTimers();
    AsyncStorage.clear();
  });
  afterEach(() => {
    AsyncStorage.clear();
    jest.useRealTimers();
  });

  async function mountSheet(extra: Partial<React.ComponentProps<typeof SettingsSheet>> = {}): Promise<Tree> {
    let tree!: Tree;
    await act(async () => { tree = renderer.create(<SettingsSheet {...SHEET_DEFAULTS} {...extra} />); });
    return tree;
  }

  /** Open the sheet's archive (Learn → Trip readiness) and let the journey load resolve. */
  async function openArchive(tree: Tree): Promise<void> {
    await act(async () => { findByTestID(tree, 'btn-trip-readiness').props.onPress(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  test('openBackup: the backup reveal opens on mount (the BACKED UP stamp destination)', async () => {
    const tree = await mountSheet({openBackup: true});
    expect(hasTestID(tree, 'mnemonic-words')).toBe(true);
    expect(hasTestID(tree, 'btn-backup')).toBe(false); // past the entry + confirm gate
  });

  test('archive onStep: recoverySaved reveals the backup LOCALLY (Settings stays open); fundsReady closes + hands the key up', async () => {
    await seedJourney([]); // all four unfilled
    const closed: string[] = [];
    const steps: string[] = [];
    const tree = await mountSheet({onClose: () => closed.push('settings'), onOpenStep: key => steps.push(key)});

    await openArchive(tree);
    expect(hasTestID(tree, 'passport-archive')).toBe(true);

    // recoverySaved → LOCAL reveal: the archive closes, the seed shows, Settings does NOT.
    await act(async () => { findByTestID(tree, 'passport-slot-btn-recoverySaved').props.onPress(); });
    expect(hasTestID(tree, 'passport-archive')).toBe(false);
    expect(hasTestID(tree, 'mnemonic-words')).toBe(true);
    expect(hasTestID(tree, 'btn-settings-close')).toBe(true);
    expect(closed).toEqual([]);

    // fundsReady → wallet-home step: Settings closes itself + the key goes up to Wallet's map.
    await openArchive(tree);
    await act(async () => { findByTestID(tree, 'passport-slot-btn-fundsReady').props.onPress(); });
    expect(steps).toEqual(['fundsReady']);
    expect(closed).toEqual(['settings']);
  });
});
