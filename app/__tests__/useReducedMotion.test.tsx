/**
 * useReducedMotion (Trip Ready J1) — the one prefers-reduced-motion seam. Under jest the RN
 * preset runs Platform.OS='ios' → the native AccessibilityInfo path, where the mock resolves
   false (or lacks the API entirely — the hook must null-safe to `false` either way). This pins
 * the null-safety contract; the live web matchMedia path is covered by the real-browser e2e.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {describe, expect, test} from '@jest/globals';
import {useReducedMotion} from '../hooks/useReducedMotion';

describe('useReducedMotion', () => {
  test('defaults to false and never throws under the RN jest environment', async () => {
    let seen: boolean | undefined;
    function Probe() {
      seen = useReducedMotion();
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Probe />); });
    expect(seen).toBe(false);
    act(() => { tree.unmount(); });
  });
});
