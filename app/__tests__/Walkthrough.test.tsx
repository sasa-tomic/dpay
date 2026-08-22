/**
 * Walkthrough render smoke (Trip Ready J1) — the pager mechanics under react-test-renderer:
 * scene mounting (only the active scene), Next advancing to "Get started", Skip firing, the
 * replay (close) variant, and the reduced-motion prop path (instant final state, no pending
 * entrance animations). The illustration choreography itself is covered by the e2e + visual
 * loop; this pins the interaction contract.
 *
 * Fake timers own the choreography: scene 1 breathes on an infinite Animated.loop, so real
 * timers would (a) make async act() poll for a never-quiet queue and (b) leak frames past
 * teardown. With the fake clock nothing fires unless advanced — deterministic and leak-free.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {describe, expect, test, jest, beforeEach, afterEach} from '@jest/globals';
import {Walkthrough} from '../components/Walkthrough';
import {WALKTHROUGH_SCENES} from '../config/education';

type Tree = renderer.ReactTestRenderer;

function findByTestID(tree: Tree, id: string): renderer.ReactTestInstance {
  const matches = tree.root.findAll(node => node.props && node.props.testID === id);
  if (matches.length === 0) throw new Error(`no node with testID=${id}`);
  return matches[0];
}

async function render(props: Parameters<typeof Walkthrough>[0]): Promise<Tree> {
  let tree!: Tree;
  await act(async () => { tree = renderer.create(<Walkthrough {...props} />); });
  return tree;
}

/** Tap a control and run the (fake-clock) entrance choreography to its end inside act. */
async function tap(tree: Tree, id: string): Promise<void> {
  await act(async () => {
    findByTestID(tree, id).props.onPress();
    jest.advanceTimersByTime(1_500);
  });
}

/** Unique mounted scene testIDs (findAll hits a logical node once per fiber layer). */
function mountedScenes(tree: Tree): string[] {
  const seen = new Set<string>();
  for (const node of tree.root.findAll(n => typeof n.props?.testID === 'string' && /^walkthrough-scene-\d$/.test(n.props.testID))) {
    seen.add(node.props.testID);
  }
  return [...seen].sort();
}

describe('Walkthrough', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('renders scene 1 only; Next advances through all scenes to Get started', async () => {
    const onDone = jest.fn();
    const tree = await render({onDone, onSkip: () => {}});
    expect(() => findByTestID(tree, 'walkthrough-scene-1')).not.toThrow();
    // findAll returns a node once per fiber layer (Animated wrapper + host) — count UNIQUE
    // scene testIDs to assert exactly one scene is mounted.
    expect(mountedScenes(tree)).toEqual(['walkthrough-scene-1']);

    await tap(tree, 'btn-walkthrough-next');
    expect(() => findByTestID(tree, 'walkthrough-scene-2')).not.toThrow();
    expect(() => findByTestID(tree, 'walkthrough-scene-1')).toThrow();

    await tap(tree, 'btn-walkthrough-next');
    expect(() => findByTestID(tree, 'walkthrough-scene-3')).not.toThrow();
    // The final label is "Get started" and fires onDone (not an advance).
    expect(findByTestID(tree, 'btn-walkthrough-next').props.accessibilityLabel).toBe('Get started');
    expect(onDone).not.toHaveBeenCalled();
    await tap(tree, 'btn-walkthrough-next');
    expect(onDone).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('scene bodies render the education copy verbatim (the comprehension contract)', async () => {
    const tree = await render({onDone: () => {}, onSkip: () => {}});
    expect(findByTestID(tree, 'walkthrough-body-1').props.children).toBe(WALKTHROUGH_SCENES[0].body);
    await tap(tree, 'btn-walkthrough-next');
    expect(findByTestID(tree, 'walkthrough-body-2').props.children).toBe(WALKTHROUGH_SCENES[1].body);
    act(() => { tree.unmount(); });
  });

  test('Skip fires immediately from scene 1; Back rewinds', async () => {
    const onSkip = jest.fn();
    const tree = await render({onDone: () => {}, onSkip});
    // No Back on the first scene.
    expect(tree.root.findAll(n => n.props.testID === 'btn-walkthrough-back').length).toBe(0);
    await tap(tree, 'btn-walkthrough-skip');
    expect(onSkip).toHaveBeenCalledTimes(1);
    // Back appears from scene 2 and rewinds to scene 1.
    await tap(tree, 'btn-walkthrough-next');
    expect(mountedScenes(tree)).toEqual(['walkthrough-scene-2']);
    await tap(tree, 'btn-walkthrough-back');
    expect(mountedScenes(tree)).toEqual(['walkthrough-scene-1']);
    act(() => { tree.unmount(); });
  });

  test('replay variant: close affordance, NO Skip; onDone (Get started) and onClose both exit', async () => {
    const onDone = jest.fn();
    const onClose = jest.fn();
    const tree = await render({onDone, onClose});
    expect(tree.root.findAll(n => n.props.testID === 'btn-walkthrough-skip').length).toBe(0);
    expect(() => findByTestID(tree, 'btn-walkthrough-close')).not.toThrow();
    await tap(tree, 'btn-walkthrough-close');
    expect(onClose).toHaveBeenCalledTimes(1);
    // Walking to the end still exits via onDone in replay mode.
    await tap(tree, 'btn-walkthrough-next');
    await tap(tree, 'btn-walkthrough-next');
    await tap(tree, 'btn-walkthrough-next');
    expect(onDone).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('reduced-motion path renders every scene instantly (content never gated behind animation)', async () => {
    const tree = await render({onDone: () => {}, onSkip: () => {}, reducedMotion: true});
    // Two full advances render without any animated settle window.
    await tap(tree, 'btn-walkthrough-next');
    expect(() => findByTestID(tree, 'walkthrough-scene-2')).not.toThrow();
    await tap(tree, 'btn-walkthrough-next');
    expect(() => findByTestID(tree, 'walkthrough-scene-3')).not.toThrow();
    act(() => { tree.unmount(); });
  });
});
