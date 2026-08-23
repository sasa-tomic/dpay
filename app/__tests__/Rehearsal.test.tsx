/**
 * Rehearsal render smoke (Trip Ready J3, re-paged 2026-08-23) — the ONE-page rehearsal under
 * react-test-renderer: all three steps mount together (the whole flow is visible at a glance),
 * the bodies render the education copy verbatim (the comprehension contract), the punchline is
 * pinned, mounting the page awards the flowUnderstood stamp exactly once (seeing the page IS
 * seeing the flow), onTry/onSkip fire, and the reduced-motion path renders entrances at rest.
 *
 * Fake timers own the entrance choreography (Walkthrough.test.tsx pattern) so act() stays
 * deterministic and leak-free.
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

/** Run the (fake-clock) entrance choreography to its end inside act(). */
async function settle(tree: Tree): Promise<void> {
  await act(async () => { jest.advanceTimersByTime(1_500); });
}

describe('Rehearsal (one page)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    return AsyncStorage.clear();
  });
  afterEach(() => { jest.useRealTimers(); });

  test('renders all three steps on one page; "Try with demo funds" fires onTry', async () => {
    const onTry = jest.fn();
    const tree = await render({onTry, onSkip: () => {}});
    const ids = new Set<string>(
      tree.root.findAll(
        inst => typeof inst.props?.testID === 'string' && /^rehearsal-step-\d$/.test(inst.props.testID),
      ).map(s => s.props.testID),
    );
    expect([...ids].sort()).toEqual(['rehearsal-step-1', 'rehearsal-step-2', 'rehearsal-step-3']);
    expect(findByTestID(tree, 'btn-rehearsal-next').props.accessibilityLabel).toBe('Try with demo funds');
    await settle(tree);
    act(() => { findByTestID(tree, 'btn-rehearsal-next').props.onPress(); });
    expect(onTry).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('bodies render the education copy verbatim + the punchline is pinned (comprehension contract)', async () => {
    const tree = await render({onTry: () => {}, onSkip: () => {}});
    expect(findByTestID(tree, 'rehearsal-body-1').props.children).toBe(REHEARSAL_STEPS[0].body);
    expect(findByTestID(tree, 'rehearsal-body-2').props.children).toBe(REHEARSAL_STEPS[1].body);
    expect(findByTestID(tree, 'rehearsal-body-3').props.children).toBe(REHEARSAL_STEPS[2].body);
    expect(findByTestID(tree, 'rehearsal-punchline').props.children).toBe(REHEARSAL_PUNCHLINE);
    act(() => { tree.unmount(); });
  });

  test('"Explore wallet" (onSkip) fires — always-available exit', async () => {
    const onSkip = jest.fn();
    const tree = await render({onTry: () => {}, onSkip});
    await settle(tree);
    act(() => { findByTestID(tree, 'btn-rehearsal-skip').props.onPress(); });
    expect(onSkip).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('mounting the page awards the flowUnderstood stamp exactly once (persisted)', async () => {
    const tree = await render({onTry: () => {}, onSkip: () => {}});
    // Let the award effect's async persist settle on the fake clock.
    await act(async () => { jest.advanceTimersByTime(300); });
    const raw = await AsyncStorage.getItem(JOURNEY_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const j = JSON.parse(raw as string);
    expect(j.stamps).toEqual(['flowUnderstood']);
    act(() => { tree.unmount(); });
  });

  test('reduced-motion path: entrances render at rest, page complete, stamp still awarded', async () => {
    const tree = await render({onTry: () => {}, onSkip: () => {}, reducedMotion: true});
    expect(findByTestID(tree, 'rehearsal-body-3')).toBeTruthy();
    await act(async () => { jest.advanceTimersByTime(300); });
    const raw = await AsyncStorage.getItem(JOURNEY_STORAGE_KEY);
    expect(raw && JSON.parse(raw).stamps).toEqual(['flowUnderstood']);
    act(() => { tree.unmount(); });
  });
});
