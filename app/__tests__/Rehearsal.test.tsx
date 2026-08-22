/**
 * Rehearsal render smoke (Trip Ready J3) — the 3-beat pager mechanics under
 * react-test-renderer: beat mounting (only the active beat), Next advancing to
 * "Try with demo funds" (onTry), "Explore wallet" (onSkip) available at every beat,
 * the offline punchline appearing on the final beat, the flowUnderstood stamp award
 * on reaching beat 3, and the reduced-motion path (no auto-advance timing).
 *
 * Fake timers own the choreography (Walkthrough.test.tsx pattern): the settle beat
 * breathes on an infinite Animated.loop and auto-advance runs a 6s linear timing, so
 * the fake clock keeps act() deterministic and leak-free.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {describe, expect, test, jest, beforeEach, afterEach} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {Rehearsal} from '../components/Rehearsal';
import {REHEARSAL_STEPS, REHEARSAL_PUNCHLINE} from '../config/education';
import {JOURNEY_STORAGE_KEY} from '../config/constants';

type Tree = renderer.ReactTestRenderer;

function findByTestID(tree: Tree, id: string): renderer.ReactTestInstance {
  const matches = tree.root.findAll(node => node.props && node.props.testID === id);
  if (matches.length === 0) throw new Error(`no node with testID=${id}`);
  return matches[0];
}

async function render(props: Parameters<typeof Rehearsal>[0]): Promise<Tree> {
  let tree!: Tree;
  await act(async () => { tree = renderer.create(<Rehearsal {...props} />); });
  return tree;
}

/** Tap a control and run the (fake-clock) entrance choreography to its end inside act. */
async function tap(tree: Tree, id: string): Promise<void> {
  await act(async () => {
    findByTestID(tree, id).props.onPress();
    jest.advanceTimersByTime(1_500);
  });
}

function mountedBeats(tree: Tree): string[] {
  const seen = new Set<string>();
  for (const node of tree.root.findAll(inst => typeof inst.props?.testID === 'string' && /^rehearsal-step-\d$/.test(inst.props.testID))) {
    seen.add(node.props.testID);
  }
  return [...seen].sort();
}

describe('Rehearsal', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    return AsyncStorage.clear();
  });
  afterEach(() => { jest.useRealTimers(); });

  test('renders beat 1 only; Next advances through all beats to "Try with demo funds"', async () => {
    const onTry = jest.fn();
    const onSkip = jest.fn();
    const tree = await render({onTry, onSkip});
    expect(mountedBeats(tree)).toEqual(['rehearsal-step-1']);
    expect(findByTestID(tree, 'btn-rehearsal-next').props.accessibilityLabel).toBe('Next rehearsal step');

    await tap(tree, 'btn-rehearsal-next');
    expect(mountedBeats(tree)).toEqual(['rehearsal-step-2']);
    expect(() => findByTestID(tree, 'rehearsal-step-1')).toThrow();

    await tap(tree, 'btn-rehearsal-next');
    expect(mountedBeats(tree)).toEqual(['rehearsal-step-3']);
    // The final label fires onTry (not an advance).
    expect(findByTestID(tree, 'btn-rehearsal-next').props.accessibilityLabel).toBe('Try with demo funds');
    expect(onTry).not.toHaveBeenCalled();
    await tap(tree, 'btn-rehearsal-next');
    expect(onTry).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('beat bodies render the education copy verbatim (the comprehension contract)', async () => {
    const tree = await render({onTry: () => {}, onSkip: () => {}});
    expect(findByTestID(tree, 'rehearsal-body-1').props.children).toBe(REHEARSAL_STEPS[0].body);
    await tap(tree, 'btn-rehearsal-next');
    expect(findByTestID(tree, 'rehearsal-body-2').props.children).toBe(REHEARSAL_STEPS[1].body);
    await tap(tree, 'btn-rehearsal-next');
    expect(findByTestID(tree, 'rehearsal-body-3').props.children).toBe(REHEARSAL_STEPS[2].body);
    // The punchline mounts ONLY on the final beat.
    expect(findByTestID(tree, 'rehearsal-punchline').props.children).toBe(REHEARSAL_PUNCHLINE);
    act(() => { tree.unmount(); });
  });

  test('"Explore wallet" (onSkip) fires from every beat — always-available exit', async () => {
    const onSkip = jest.fn();
    const tree = await render({onTry: () => {}, onSkip});
    await tap(tree, 'btn-rehearsal-skip');
    expect(onSkip).toHaveBeenCalledTimes(1);
    await tap(tree, 'btn-rehearsal-next');
    await tap(tree, 'btn-rehearsal-skip');
    expect(onSkip).toHaveBeenCalledTimes(2);
    act(() => { tree.unmount(); });
  });

  test('reaching beat 3 awards the flowUnderstood stamp exactly once (persisted)', async () => {
    const tree = await render({onTry: () => {}, onSkip: () => {}});
    await tap(tree, 'btn-rehearsal-next');
    await tap(tree, 'btn-rehearsal-next');
    // Let the award effect's async persist settle on the fake clock.
    await act(async () => { jest.advanceTimersByTime(300); });
    const raw = await AsyncStorage.getItem(JOURNEY_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const j = JSON.parse(raw as string);
    expect(j.stamps).toEqual(['flowUnderstood']);
    act(() => { tree.unmount(); });
  });

  test('auto-advance: with real-motion timing the beat walks forward on its own (fake clock)', async () => {
    const tree = await render({onTry: () => {}, onSkip: () => {}});
    expect(mountedBeats(tree)).toEqual(['rehearsal-step-1']);
    await act(async () => { jest.advanceTimersByTime(6_100); });
    expect(mountedBeats(tree)).toEqual(['rehearsal-step-2']);
    // The final beat stays put — auto-advance never exits the rehearsal on its own.
    await act(async () => { jest.advanceTimersByTime(6_100); });
    expect(mountedBeats(tree)).toEqual(['rehearsal-step-3']);
    await act(async () => { jest.advanceTimersByTime(6_100); });
    expect(mountedBeats(tree)).toEqual(['rehearsal-step-3']);
    act(() => { tree.unmount(); });
  });

  test('reduced-motion path: renders instantly, no auto-advance, manual Next still works', async () => {
    const tree = await render({onTry: () => {}, onSkip: () => {}, reducedMotion: true});
    expect(mountedBeats(tree)).toEqual(['rehearsal-step-1']);
    // No auto-advance under reduced motion — the clock passing must not move the beat.
    await act(async () => { jest.advanceTimersByTime(20_000); });
    expect(mountedBeats(tree)).toEqual(['rehearsal-step-1']);
    await tap(tree, 'btn-rehearsal-next');
    expect(mountedBeats(tree)).toEqual(['rehearsal-step-2']);
    act(() => { tree.unmount(); });
  });
});
