/**
 * TripPassport render smoke (Trip Ready J5b) — the card contract under react-test-renderer:
 * slot fill states + n-of-4 eyebrow, the ONE next-step hint, no collapse affordance while
 * incomplete, the live capstone (4th stamp fills in-session → TRIP READY → Done → card
 * collapses forever via the seen-marker), and the read-only archive variant (complete shows
 * the TRIP READY mark statically, no capstone/Done). Fake timers own the capstone clock.
 *
 * The component reads the real journey store (AsyncStorage-mocked); each test seeds stamps
 * directly, then asserts — the award wiring itself (PayMode/ReceiveMode/SOL) is e2e's job.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {describe, expect, test, jest, beforeEach, afterEach} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {JOURNEY_STORAGE_KEY} from '../config/constants';
import {TripPassport} from '../components/TripPassport';
import {READINESS_STAMPS} from '../lib/readiness';

type Tree = renderer.ReactTestRenderer;

function findByTestID(tree: Tree, id: string): renderer.ReactTestInstance {
  const matches = tree.root.findAll(node => node.props && node.props.testID === id);
  if (matches.length === 0) throw new Error(`no node with testID=${id}`);
  return matches[0];
}

function hasTestID(tree: Tree, id: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === id).length > 0;
}

async function render(props: Parameters<typeof TripPassport>[0]): Promise<Tree> {
  let tree!: Tree;
  await act(async () => { tree = renderer.create(<TripPassport {...props} />); });
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

describe('TripPassport (card variant)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    AsyncStorage.clear();
  });
  afterEach(() => {
    AsyncStorage.clear();
    jest.useRealTimers();
  });

  test('incomplete: 3/4 eyebrow, slot fill states, ONE hint, NO Done affordance', async () => {
    await seedJourney(['walkthroughDone', 'recoverySaved', 'fundsReady']);
    const tree = await render({});
    expect(findByTestID(tree, 'passport-count').props.children.join('')).toBe('2 OF 4');
    expect(hasTestID(tree, 'passport-slot-recoverySaved-filled')).toBe(true);
    expect(hasTestID(tree, 'passport-slot-fundsReady-filled')).toBe(true);
    expect(hasTestID(tree, 'passport-slot-flowUnderstood')).toBe(true);
    expect(hasTestID(tree, 'passport-slot-paymentTested')).toBe(true);
    // The ONE contextual next step names the first missing capability.
    expect(findByTestID(tree, 'passport-hint').props.children).toBe('Watch the 3-step rehearsal when creating a wallet');
    // Incomplete NEVER collapses — no Done button exists.
    expect(hasTestID(tree, 'btn-passport-done')).toBe(false);
  });

  test('empty journey: 0 OF 4, hint = first stamp', async () => {
    await seedJourney([]);
    const tree = await render({});
    expect(findByTestID(tree, 'passport-count').props.children.join('')).toBe('0 OF 4');
    expect(findByTestID(tree, 'passport-hint').props.children).toBe('Back up your wallet in Settings');
  });

  test('complete collapsed (fresh mount of a finished journey): renders NOTHING', async () => {
    await seedJourney([...READINESS_STAMPS, 'tripReady'], ['passportCollapsed']);
    const tree = await render({});
    expect(hasTestID(tree, 'trip-passport')).toBe(false);
    // No capstone replay for a session that mounts already-complete (no replayed rewards).
    expect(hasTestID(tree, 'trip-ready-capstone')).toBe(false);
  });

  test('complete but NOT yet tripReady (the first mount after the 4th stamp): the capstone plays, then Done collapses it forever', async () => {
    // The 4th stamp is always awarded while the card is unmounted (payments happen on the
    // Pay/Receive screens) — so "live" = first observation of the complete page. Seed all
    // four WITHOUT the tripReady stamp: the card must award + press, then offer Done.
    await seedJourney(['recoverySaved', 'flowUnderstood', 'fundsReady', 'paymentTested']);
    const tree = await render({});
    expect(hasTestID(tree, 'trip-passport')).toBe(true);

    // The capstone overlay is playing immediately after load (the one-shot beat).
    await act(async () => { await Promise.resolve(); });
    expect(hasTestID(tree, 'trip-ready-capstone')).toBe(true);
    // Done does NOT exist while the press plays (one affordance at a time).
    expect(hasTestID(tree, 'btn-passport-done')).toBe(false);

    // The press runs its full clock, then lifts to reveal the static page + Done.
    await act(async () => { jest.advanceTimersByTime(2_400); });
    expect(hasTestID(tree, 'trip-ready-capstone')).toBe(false);
    expect(hasTestID(tree, 'btn-passport-done')).toBe(true);

    // Done → optimistic collapse: card gone from THIS tree; tripReady + seen persisted.
    await act(async () => { findByTestID(tree, 'btn-passport-done').props.onPress(); });
    expect(hasTestID(tree, 'trip-passport')).toBe(false);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const raw = await AsyncStorage.getItem(JOURNEY_STORAGE_KEY) as string;
    const persisted = JSON.parse(raw);
    expect(persisted.stamps).toContain('tripReady');
    expect(persisted.seen).toContain('passportCollapsed');

    // A fresh mount of the finished+collapsed journey renders NOTHING (persistence).
    const tree2 = await render({});
    expect(hasTestID(tree2, 'trip-passport')).toBe(false);
    expect(hasTestID(tree2, 'trip-ready-capstone')).toBe(false);
  });

  test('the capstone NEVER replays: complete + tripReady already stamped (pre-collapse) shows Done directly', async () => {
    // e.g. the sheet was closed mid-press or re-rendered: the stamp latched, so the next
    // mount shows the static complete page + Done — no second press.
    await seedJourney([...READINESS_STAMPS, 'tripReady']);
    const tree = await render({});
    expect(hasTestID(tree, 'trip-passport')).toBe(true);
    expect(hasTestID(tree, 'trip-ready-capstone')).toBe(false);
    expect(hasTestID(tree, 'btn-passport-done')).toBe(true);
  });

  test('reduced motion: complete un-stamped journey still reaches Done — via the at-rest 200ms beat, no animated press', async () => {
    await seedJourney(['recoverySaved', 'flowUnderstood', 'fundsReady', 'paymentTested']);
    const tree = await render({reducedMotion: true});
    // No animated press overlay (the beat is instant at rest); Done appears after the brief
    // settle tick — same information, none of the motion.
    expect(hasTestID(tree, 'trip-passport')).toBe(true);
    await act(async () => { jest.advanceTimersByTime(400); });
    expect(hasTestID(tree, 'trip-ready-capstone')).toBe(false);
    expect(hasTestID(tree, 'btn-passport-done')).toBe(true);
  });
});

describe('TripPassport (archive variant)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    AsyncStorage.clear();
  });
  afterEach(() => {
    AsyncStorage.clear();
    jest.useRealTimers();
  });

  test('incomplete archive: same read-only page (helps re-find what is left)', async () => {
    await seedJourney(['recoverySaved', 'fundsReady']);
    const tree = await render({variant: 'archive'});
    expect(hasTestID(tree, 'passport-archive')).toBe(true);
    expect(hasTestID(tree, 'passport-slot-flowUnderstood')).toBe(true);
    expect(findByTestID(tree, 'passport-hint').props.children).toBe('Watch the 3-step rehearsal when creating a wallet');
  });

  test('complete archive: TRIP READY mark shown STATICALLY — never the capstone, never Done', async () => {
    await seedJourney([...READINESS_STAMPS, 'tripReady'], ['passportCollapsed']);
    const tree = await render({variant: 'archive'});
    expect(hasTestID(tree, 'passport-archive')).toBe(true);
    expect(hasTestID(tree, 'trip-ready-capstone')).toBe(false);
    expect(hasTestID(tree, 'btn-passport-done')).toBe(false);
    // The completed card's durable mark + promise line are present.
    const texts = tree.root.findAll(n => typeof n.props?.children === 'string').map(n => n.props.children);
    expect(texts).toContain('Trip ready');
    expect(texts).toContain('You can pay even when your phone has no signal.');
  });
});
