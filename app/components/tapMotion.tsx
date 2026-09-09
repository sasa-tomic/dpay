/**
 * tapMotion.tsx — the functional tap-state motion system (Trip Ready J5, 2026-08-22).
 *
 * Every NFC phase gets honest, distinct, PREMIUM motion in the established passport-stamp /
 * Traveler Paper language (Rehearsal + Onboarding's RECOVERY SAVED beat): springs with
 * friction 5 / tension 64, cubic-out entrances, ink-stamp presses with a slight tilt. ONE
 * grammar — this file reads as the same system as the education surfaces, not a new metaphor.
 *
 * Choreography rules (spec + AGENTS blind-spot hardening):
 *   - Animations are keyed on PHASE TRANSITIONS, never render count — Wallet re-renders on
 *     live balance polls; a re-render must never re-trigger or restart a beat. Each element
 *     below runs its effect on mount/`deps` only.
 *   - Every LOOP is stopped in its effect's cleanup, so it runs only while mounted in that
 *     phase. That cleanup earns its keep on a deps change (`reduced` flips): the effect re-runs
 *     while the component stays mounted, and without the stop the previous loop would spin on
 *     beside the new one forever.
 *   - FINITE beats need no cleanup and deliberately do not all have one (`TapProgressLine`'s
 *     segment fills start without a stop — as do TripStrip, Onboarding's recovery stamp and
 *     Walkthrough's dots). Every animated value here is bound straight to an `Animated.*`
 *     component, and unmounting one detaches its props down to the value: `AnimatedProps.__detach`
 *     → `AnimatedStyle.__detach` → `AnimatedValue.__detach`, which calls `stopAnimation()`
 *     (read in `react-native/Libraries/Animated/nodes/`). So unmount already stops them, and a
 *     re-run merely retargets the same value. Do NOT "fix" these into having stops — there is no
 *     leak to fix, and a stop that can never fire is dead code.
 *   - useNativeDriver: false everywhere (RNW collapsable constraint — svg elements are never
 *     wrapped in Animated.createAnimatedComponent; animated fragments draw in LOCAL coords
 *     inside a static-geometry canvas, only opacity/transform animate).
 *   - Reduced motion: every element renders at its REST values — static, no loops; finite
 *     beats collapse to a simple fade or instant.
 *   - Honest-money rule: NOTHING here can read as success. Pending renders stillness (the
 *     visual opposite); the success phase is carried by the badge + title alone (the dpay
 *     stamp ring was dropped by founder directive 2026-08-24).
 *
 * testID contract (e2e flows 93): `tap-breath` (listening), `tap-progress` + `tap-progress-seg-N`
 * (active phases), `tap-key-beat` (awaitingApproval), `tap-ellipsis` (pending).
 */
import React, {useEffect, useRef} from 'react';
import {Animated, Easing, View} from 'react-native';
import Svg, {Circle, Rect} from 'react-native-svg';
import {C} from '../config/palette';
import {S} from '../styles';
import {useReducedMotion} from '../hooks/useReducedMotion';
import {IconKey} from './icons';

const EASE_OUT = Easing.out(Easing.cubic);
const EASE_PLATE = Easing.bezier(0.22, 1, 0.36, 1);
const EASE_IN_OUT_SINE = Easing.bezier(0.37, 0, 0.63, 1);

/** listening — the slow breathing ring around the NFC mark (2.8s loop; alive, waiting). */
export function TapBreathRing({tone}: {tone: string}) {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(reduced ? 1.06 : 1)).current;
  const op = useRef(new Animated.Value(reduced ? 0.35 : 0.45)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale, {toValue: 1.22, duration: 1400, easing: EASE_IN_OUT_SINE, useNativeDriver: false}),
          Animated.timing(scale, {toValue: 1, duration: 1400, easing: EASE_IN_OUT_SINE, useNativeDriver: false}),
        ]),
        Animated.sequence([
          Animated.timing(op, {toValue: 0.05, duration: 1400, easing: EASE_IN_OUT_SINE, useNativeDriver: false}),
          Animated.timing(op, {toValue: 0.45, duration: 1400, easing: EASE_IN_OUT_SINE, useNativeDriver: false}),
        ]),
      ]),
    );
    loop.start();
    return () => { loop.stop(); };
  }, [op, scale, reduced]);
  return (
    <Animated.View
      testID="tap-breath"
      style={[S.nfcBreath, {borderColor: tone, opacity: op, transform: [{scale}]}]}
      pointerEvents="none"
    />
  );
}

/**
 * The itinerary-line progression: payer phone · link · node · exchange · node · settle · merchant
 * phone. Each active phase lights the next segment (linking=1, exchanging=2, awaitingApproval
 * holds at 2 while the key beat breathes, settling=3). A subtle ink-fill draws the LIT segment;
 * the unlit track stays hairline. Phone marks are the walkthrough grammar's device silhouettes,
 * scaled down; the node dots are the network hops (the request hop, then the settle hop).
 */
export function TapProgressLine({litSegments}: {litSegments: 1 | 2 | 3}) {
  const reduced = useReducedMotion();
  const segs = [useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current];
  useEffect(() => {
    // Keyed on litSegments: advancing lights the NEW segment once; a parent re-render with the
    // same count re-runs nothing (values already at 1). Reduced → all lit segments static.
    for (let i = 0; i < litSegments; i++) {
      if (reduced) { segs[i].setValue(1); continue; }
      Animated.sequence([
        Animated.timing(segs[i], {toValue: 0.4, duration: 90, easing: EASE_OUT, useNativeDriver: false}),
        Animated.timing(segs[i], {toValue: 1, duration: 260, delay: 40, easing: EASE_PLATE, useNativeDriver: false}),
      ]).start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [litSegments, reduced]);
  const seg = (i: number) => (
    <View style={S.nfcLineTrack}>
      {/* All three tracks render from the start (stable layout, no reflow on advance); the
          testID marks only the LIT segments — e2e/jest assert progression by presence. */}
      <Animated.View
        testID={i < litSegments ? `tap-progress-seg-${i + 1}` : undefined}
        style={{position: 'absolute', left: 0, top: 0, bottom: 0, alignSelf: 'stretch', backgroundColor: C.brand, opacity: segs[i], borderRadius: 1}}
      />
    </View>
  );
  return (
    <View testID="tap-progress" style={S.nfcLineRow} pointerEvents="none">
      <PhoneMark />
      {seg(0)}
      <NodeDot />
      {seg(1)}
      <NodeDot />
      {seg(2)}
      <PhoneMark />
    </View>
  );
}

/** A tiny phone silhouette (the walkthrough grammar's device, 18px) — static geometry. */
function PhoneMark() {
  return (
    <Svg width={18} height={26} viewBox="0 0 18 26">
      <Rect x={1} y={1} width={16} height={24} rx={3.5} fill="none" stroke={C.sub} strokeWidth={1.6} />
      <Rect x={5.5} y={18.5} width={7} height={2} rx={1} fill={C.sub2} />
    </Svg>
  );
}

/** The mid-line node dot — the authorization hand-off point on the itinerary. */
function NodeDot() {
  return (
    <Svg width={12} height={12} viewBox="0 0 12 12">
      <Circle cx={6} cy={6} r={4} fill={C.bg} stroke={C.line2} strokeWidth={1.6} />
    </Svg>
  );
}

/**
 * awaitingApproval — the quiet key/lock beat: the key glyph breathes at reading pace INSIDE the
 * badge, replacing the spinner (approval is YOURS — a held breath, not spinny anxiety).
 * Reduced → a static key at full presence.
 */
export function TapKeyBeat({size, tone}: {size: number; tone: string}) {
  const reduced = useReducedMotion();
  const op = useRef(new Animated.Value(reduced ? 1 : 0.45)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(op, {toValue: 1, duration: 1100, easing: EASE_IN_OUT_SINE, useNativeDriver: false}),
      Animated.timing(op, {toValue: 0.45, duration: 1100, easing: EASE_IN_OUT_SINE, useNativeDriver: false}),
    ]));
    loop.start();
    return () => { loop.stop(); };
  }, [op, reduced]);
  return (
    <Animated.View testID="tap-key-beat" style={{opacity: op}} pointerEvents="none">
      <IconKey size={size} color={tone} />
    </Animated.View>
  );
}

/**
 * pending — deliberate STILLNESS: an unhurried ellipsis pulse (2.4s per dot wave). Warn-tone,
 * slow, no scale press, no tilt — the visual OPPOSITE of the success stamp; impossible to
 * confuse with settled. Reduced → static dots.
 */
export function TapPendingStill({children}: {children?: React.ReactNode}) {
  const reduced = useReducedMotion();
  const t = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(Animated.timing(t, {toValue: 1, duration: 2400, easing: Easing.linear, useNativeDriver: false}));
    loop.start();
    return () => { loop.stop(); };
  }, [reduced, t]);
  const dots = [0, 1, 2].map(i => {
    // One wave across the three dots: dot i brightens at i*0.22, dims by 0.5+i*0.22.
    const brighten = [0, 0.22, 0.44][i];
    const dim = Math.min(1, 0.5 + brighten);
    const opacity = t.interpolate({
      inputRange: [0, brighten, dim, 1],
      outputRange: [0.25, 1, 0.25, 0.25],
    });
    return <Animated.View key={i} style={[S.nfcEllipsisDot, {opacity}]} />;
  });
  return (
    <View testID="tap-ellipsis" style={S.nfcEllipsis} pointerEvents="none">
      {dots}
      {children}
    </View>
  );
}

/**
 * declined/error — one restrained shake-settle: a single 6px lateral exhale (150ms out, 260ms
 * back), never aggressive, then stillness forever. Reduced → nothing moves at all.
 */
export function TapShakeSettle({children, testID}: {children: React.ReactElement; testID?: string}) {
  const reduced = useReducedMotion();
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return;
    const a = Animated.sequence([
      Animated.timing(x, {toValue: 6, duration: 150, easing: EASE_OUT, useNativeDriver: false}),
      Animated.timing(x, {toValue: 0, duration: 260, easing: EASE_PLATE, useNativeDriver: false}),
    ]);
    a.start();
    return () => { a.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Animated.View testID={testID} style={{transform: [{translateX: x}]}}>
      {children}
    </Animated.View>
  );
}
