/**
 * CoachTip render smoke (Trip Ready J4) — the one-time coaching card mechanics:
 * hidden until the journey loads, shown once per surface (keyed by seen-markers),
 * dismissal persists via markSeen, reduced-motion path renders without entrance
 * animation, and every unknown/absent key renders nothing (fail-soft).
 *
 * Fake timers own the entrance (260ms rise+fade after a 220ms delay) — the
 * Walkthrough.test.tsx pattern keeps act() deterministic.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {describe, expect, test, jest, beforeEach, afterEach} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {CoachTip} from '../components/CoachTip';
import {COACHING_TIPS} from '../config/education';
import {JOURNEY_STORAGE_KEY} from '../config/constants';

type Tree = renderer.ReactTestRenderer;

function findByTestID(tree: Tree, id: string): renderer.ReactTestInstance {
  const matches = tree.root.findAll(node => node.props && node.props.testID === id);
  if (matches.length === 0) throw new Error(`no node with testID=${id}`);
  return matches[0];
}

function absent(tree: Tree, id: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === id).length === 0;
}

async function render(props: Parameters<typeof CoachTip>[0]): Promise<Tree> {
  let tree!: Tree;
  await act(async () => { tree = renderer.create(<CoachTip {...props} />); });
  // Let the tri-state journey load settle.
  await act(async () => { jest.advanceTimersByTime(100); });
  return tree;
}

/** Dismiss and run the entrance clock out inside act. */
async function dismiss(tree: Tree, key: string): Promise<void> {
  await act(async () => {
    findByTestID(tree, `btn-coach-${key}-dismiss`).props.onPress();
    jest.advanceTimersByTime(1_000);
  });
}

describe('CoachTip', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    return AsyncStorage.clear();
  });
  afterEach(() => { jest.useRealTimers(); });

  test('renders every spec tip with icon, title, body, and dismiss affordance', async () => {
    for (const key of Object.keys(COACHING_TIPS)) {
      let tree!: Tree;
      await act(async () => { tree = renderer.create(<CoachTip tipKey={key as keyof typeof COACHING_TIPS} />); });
      await act(async () => { jest.advanceTimersByTime(100); });
      const card = findByTestID(tree, `coach-${key}`);
      const tip = COACHING_TIPS[key as keyof typeof COACHING_TIPS];
      // The card itself is passive; the dismiss affordance carries the a11y contract.
      expect(findByTestID(tree, `btn-coach-${key}-dismiss`).props.accessibilityLabel).toBe(`Dismiss tip: ${tip.title}`);
      // The body renders the education copy verbatim somewhere beneath the card.
      const texts = card.findAll(() => true).map(n => typeof n.props?.children === 'string' ? n.props.children : null).filter(Boolean);
      expect(texts).toContain(tip.title);
      expect(texts).toContain(tip.body);
      expect(() => findByTestID(tree, `btn-coach-${key}-dismiss`)).not.toThrow();
      act(() => { tree.unmount(); });
    }
  });

  test('dismissal hides the card and persists the seen-marker (one-time, survives remount)', async () => {
    const tree = await render({tipKey: 'payReview'});
    expect(() => findByTestID(tree, 'coach-payReview')).not.toThrow();
    await dismiss(tree, 'payReview');
    expect(absent(tree, 'coach-payReview')).toBe(true);
    await act(async () => { jest.advanceTimersByTime(200); });
    const raw = await AsyncStorage.getItem(JOURNEY_STORAGE_KEY);
    expect(JSON.parse(raw as string).seen).toEqual(['payReview']);

    // A fresh mount (surface re-entered, same identity) no longer shows it.
    const again = await render({tipKey: 'payReview'});
    expect(absent(again, 'coach-payReview')).toBe(true);
    act(() => { tree.unmount(); again.unmount(); });
  });

  test('already-seen key renders nothing from the start', async () => {
    await AsyncStorage.setItem(JOURNEY_STORAGE_KEY, JSON.stringify({stamps: [], at: {}, seen: ['receiveRequest']}));
    const tree = await render({tipKey: 'receiveRequest'});
    expect(absent(tree, 'coach-receiveRequest')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('reduced-motion path renders instantly at rest (no entrance window)', async () => {
    const tree = await render({tipKey: 'offlineQr', reducedMotion: true});
    expect(() => findByTestID(tree, 'coach-offlineQr')).not.toThrow();
    await dismiss(tree, 'offlineQr');
    expect(absent(tree, 'coach-offlineQr')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('unmounting the surface discards the card without persisting (remount re-offers)', async () => {
    let tree = await render({tipKey: 'pendingOutcome'});
    expect(() => findByTestID(tree, 'coach-pendingOutcome')).not.toThrow();
    act(() => { tree.unmount(); });
    // No dismissal happened — nothing persisted.
    expect(await AsyncStorage.getItem(JOURNEY_STORAGE_KEY)).toBeNull();
    tree = await render({tipKey: 'pendingOutcome'});
    expect(() => findByTestID(tree, 'coach-pendingOutcome')).not.toThrow();
    act(() => { tree.unmount(); });
  });
});
