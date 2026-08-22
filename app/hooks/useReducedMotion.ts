/**
 * useReducedMotion — the ONE prefers-reduced-motion seam (Trip Ready Wave 1A).
 * Wave C (celebrations) reuses this; every animated surface goes through it.
 *
 *   - native: `AccessibilityInfo.isReduceMotionEnabled` + the `reduceMotionChanged`
 *     listener (Android "Remove animations" / iOS Reduce Motion).
 *   - web (RNW): `matchMedia('(prefers-reduced-motion: reduce)')` + its change event.
 *
 * Null-safe everywhere: a missing API (old RNW, jsdom, SSR-ish environments) yields
 * `false` — reduced motion OFF by default, never a throw. Downstream contract:
 * reduced → entrance becomes a simple fade or instant; NEVER block content behind a
 * running animation.
 */
import {useEffect, useState} from 'react';
import {AccessibilityInfo, Platform} from 'react-native';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let alive = true;
    const set = (v: boolean) => { if (alive) setReduced(v); };

    if (Platform.OS === 'web') {
      // RNW: the media query is the source of truth. Guard every DOM touch — this
      // module can load in environments with no window (jest node env, workers).
      const w = globalThis as unknown as {
        matchMedia?: (q: string) => {matches: boolean; addEventListener?: (t: 'change', fn: () => void) => void; removeEventListener?: (t: 'change', fn: () => void) => void; addListener?: (fn: () => void) => void; removeListener?: (fn: () => void) => void};
      };
      const mm = typeof w.matchMedia === 'function' ? w.matchMedia('(prefers-reduced-motion: reduce)') : null;
      if (!mm) return;
      set(!!mm.matches);
      const onChange = () => set(!!mm.matches);
      // Modern browsers expose addEventListener; Safari <14 still needs addListener.
      if (typeof mm.addEventListener === 'function') {
        mm.addEventListener('change', onChange);
        return () => { if (alive) { alive = false; mm.removeEventListener?.('change', onChange); } };
      }
      if (typeof mm.addListener === 'function') {
        mm.addListener(onChange);
        return () => { if (alive) { alive = false; mm.removeListener?.(onChange); } };
      }
      return;
    }

    // Native: the RN AccessibilityInfo seam. isReduceMotionEnabled is a promise;
    // reduceMotionChanged pushes live changes. Guard both — jest's RN mock and
    // exotic embedders may lack them.
    const ai = AccessibilityInfo as unknown as {
      isReduceMotionEnabled?: () => Promise<boolean>;
      addEventListener?: (event: 'reduceMotionChanged', handler: (v: boolean) => void) => {remove?: () => void};
    };
    if (typeof ai?.isReduceMotionEnabled === 'function') {
      ai.isReduceMotionEnabled().then(set).catch(() => {});
    }
    let sub: {remove?: () => void} | undefined;
    if (typeof ai?.addEventListener === 'function') {
      sub = ai.addEventListener('reduceMotionChanged', set);
    }
    return () => {
      alive = false;
      sub?.remove?.();
    };
  }, []);

  return reduced;
}
