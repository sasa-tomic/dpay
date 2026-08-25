/**
 * Walkthrough — the first-run 3-scene pager (Trip Ready J1, 2026-08-22) and its Settings replay
 * ("How dpay works"). THE education surface: it renders WALKTHROUGH_SCENES verbatim from
 * config/education.ts (the comprehension contract — never paraphrase here).
 *
 * Design voice — "Traveler Paper" travel document:
 *   - a left-aligned editorial header (mono eyebrow → Space Grotesk title → measured body),
 *   - an illustration STAGE: one raised paper plate the three scenes share (same size, same
 *     corner marker "01 — SIGNAL"), so the pager reads as one document with three stamps,
 *   - a footer of progress dots + the primary Next (final label "Get started").
 *
 * The illustrations are hand-built from Views + react-native-svg strokes — no stock art, no
 * emoji. Motion: staggered entrances (title → body → stage → in-stage beat), spring settles and
 * inOut arcs (never default-linear); every element is reachable the moment it mounts (motion
 * never blocks comprehension or a control). Reduced motion (useReducedMotion or the
 * `reducedMotion` override) collapses every animation to instant final state.
 *
 * Variants:
 *   - first-run (Onboarding): `onSkip` shows the boxed top-right affordance as Skip; `onDone`
 *     fires on the final "Get started" (Onboarding awards walkthroughDone on either exit).
 *   - replay (Settings Modal): `onClose` shows the same boxed affordance as a close instead
 *     of skip; "Get started" then also exits via onDone.
 *
 * Trip-prep auto-detection (founder rule 2026-08-24): MOUNTING the walkthrough awards
 * `flowUnderstood` (idempotent) — viewing the intro IS seeing the flow, first-run or replay.
 *
 * testID contract (e2e flows 88/89 + the skip helper): root `walkthrough`; per-scene
 * `walkthrough-scene-1|2|3` (ONLY the active scene is mounted); `btn-walkthrough-next`,
 * `btn-walkthrough-skip`, `btn-walkthrough-close`, `btn-walkthrough-back`, `walkthrough-dots`.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, Pressable, SafeAreaView, ScrollView, StatusBar, Text, View} from 'react-native';
import Svg, {Circle, G, Line, Path, Rect} from 'react-native-svg';
import {C} from '../config/palette';
import {S, isDark} from '../styles';
import {CAMPAIGN_LINE, JourneyHowItWorksTitle, WALKTHROUGH_SCENES, type WalkthroughVisual} from '../config/education';
import {useReducedMotion} from '../hooks/useReducedMotion';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {JOURNEY_STAMPS, awardStamp} from '../lib/journey';
import {IconCheck, IconClose} from './icons';

// The shared illustration frame — every scene draws inside the SAME 292×218 frame centered on
// the stage plate, so scene advances feel like pages of one document (continuity by geometry).
const STAGE_W = 292;
const STAGE_H = 218;

// NOTE: svg elements are never wrapped in Animated.createAnimatedComponent — RN-web's
// useAnimatedProps force-injects `collapsable: false` into every animated component, and svg
// elements forward unknown props to the DOM (`Received false for a non-boolean attribute
// collapsable`, which fails the e2e diagnostics gate). Animated svg fragments are drawn in
// LOCAL coordinates inside a mini <Svg> hosted by an absolutely-positioned Animated.View
// overlay on the 292×218 stage box (RN View filters the injected prop correctly) — the same
// pattern the traveling ticket and receipt stamp already use.

/** out(cubic) — the house entrance curve for text; never default-linear. */
const EASE_OUT = Easing.out(Easing.cubic);
/** outExpo-ish for the stage plate settle. */
const EASE_PLATE = Easing.bezier(0.22, 1, 0.36, 1);

// ─── Entrance atoms ──────────────────────────────────────────────────────────────────────────

/** Text entrance: opacity + an 8px rise at `delay`. Reduced → instant. */
function RiseText({children, style, delay, reduced, testID}: {
  children: React.ReactNode; style: object; delay: number; reduced: boolean; testID?: string;
}) {
  const op = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const ty = useRef(new Animated.Value(reduced ? 0 : 8)).current;
  useEffect(() => {
    if (reduced) return;
    const a = Animated.parallel([
      Animated.timing(op, {toValue: 1, duration: 280, delay, easing: EASE_OUT, useNativeDriver: false}),
      Animated.timing(ty, {toValue: 0, duration: 280, delay, easing: EASE_OUT, useNativeDriver: false}),
    ]);
    a.start();
    return () => { a.stop(); }; // pending delayed frames never fire on an unmounted scene
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Animated.Text testID={testID} style={[style, {opacity: op, transform: [{translateY: ty}]}]}>
      {children}
    </Animated.Text>
  );
}

/** The scene's illustration slot: plate rises with a soft settle, then the in-stage beat runs. */
function useStageEntrance(reduced: boolean) {
  const op = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const ty = useRef(new Animated.Value(reduced ? 0 : 10)).current;
  const sc = useRef(new Animated.Value(reduced ? 1 : 0.985)).current;
  useEffect(() => {
    if (reduced) return;
    const a = Animated.parallel([
      Animated.timing(op, {toValue: 1, duration: 320, delay: 200, easing: EASE_OUT, useNativeDriver: false}),
      Animated.timing(ty, {toValue: 0, duration: 320, delay: 200, easing: EASE_PLATE, useNativeDriver: false}),
      Animated.timing(sc, {toValue: 1, duration: 340, delay: 200, easing: EASE_PLATE, useNativeDriver: false}),
    ]);
    a.start();
    return () => { a.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return {op, ty, sc};
}

/** The shared paper-plate frame + corner tag. Every scene's illustration mounts inside it. */
function Stage({entrance, tag, children}: {
  entrance: {op: Animated.Value; ty: Animated.Value; sc: Animated.Value};
  tag: string;
  children: React.ReactNode;
}) {
  return (
    <Animated.View
      style={[S.walkStage, {opacity: entrance.op, transform: [{translateY: entrance.ty}, {scale: entrance.sc}]}]}>
      <Text style={S.walkStageTag}>{tag}</Text>
      <View style={{flex: 1, alignItems: 'center', justifyContent: 'center'}}>
        <View style={{width: STAGE_W, height: STAGE_H}}>{children}</View>
      </View>
    </Animated.View>
  );
}

// ─── Scene 1 — the offline handoff ("the asymmetry is the picture") ──────────────────────────
// Left: the traveler's phone, airplane-mode pill + HATCHED no-signal arcs with a strike — its
// radio is off. Right: the shop terminal with LIVE signal arcs (breathing) — the shop is online.
// Between them a dashed lane: the payment ticket leaves the phone, arcs across, and the shop's
// confirmed receipt lands as a tangerine stamp on the terminal. The truth, drawn: the SHOP's
// connection carries the payment.

function OfflineHandoffVisual({reduced}: {reduced: boolean}) {
  // In-stage beat (starts after the plate settle ≈ 520ms in): ticket fades in at the phone's
  // edge, travels the dashed lane on an inOut arc, then the receipt stamp springs onto the
  // terminal. Reduced → everything at final state instantly (ticket delivered, stamp down).
  const ticketOp = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const ticketX = useRef(new Animated.Value(0)).current;
  const ticketLift = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const stamp = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  // The shop's live arcs breathe in a slow offset wave (online ≠ static). Reduced → steady.
  const arc1 = useRef(new Animated.Value(1)).current;
  const arc2 = useRef(new Animated.Value(1)).current;
  const arc3 = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduced) return;
    const beat = Animated.sequence([
      Animated.timing(ticketOp, {toValue: 1, duration: 160, delay: 520, easing: EASE_OUT, useNativeDriver: false}),
      Animated.parallel([
        Animated.timing(ticketX, {toValue: 1, duration: 780, easing: Easing.inOut(Easing.quad), useNativeDriver: false}),
        Animated.timing(ticketLift, {toValue: 1, duration: 780, easing: Easing.inOut(Easing.quad), useNativeDriver: false}),
      ]),
      Animated.spring(stamp, {toValue: 1, friction: 5, tension: 64, useNativeDriver: false}),
    ]);
    beat.start();
    // The shop's live arcs breathe forever while mounted — infinite loops MUST be stopped on
    // unmount or their timers fire on a dead tree (jest teardown / scene advance).
    const breathe = (v: Animated.Value, phase: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, {toValue: 0.4, duration: 800, delay: phase, easing: Easing.inOut(Easing.sin), useNativeDriver: false}),
          Animated.timing(v, {toValue: 1, duration: 800, easing: Easing.inOut(Easing.sin), useNativeDriver: false}),
        ]),
      );
    const breathers = [breathe(arc1, 0), breathe(arc2, 260), breathe(arc3, 520)];
    for (const b of breathers) b.start();
    return () => { beat.stop(); for (const b of breathers) b.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ticket arc: x runs 0→1 across the lane (86px); lift parabola 0 → −13px → 0.
  const ticketTx = ticketX.interpolate({inputRange: [0, 1], outputRange: [0, 86]});
  const ticketTy = ticketLift.interpolate({inputRange: [0, 0.5, 1], outputRange: [0, -13, 0]});
  const stampScale = stamp.interpolate({inputRange: [0, 1], outputRange: [0.2, 1]});

  return (
    <View style={{flex: 1}}>
      <Svg width={STAGE_W} height={STAGE_H} viewBox={`0 0 ${STAGE_W} ${STAGE_H}`} fill="none">
        {/* The dashed handoff lane */}
        <Line x1={104} y1={124} x2={196} y2={124} stroke={C.sub2} strokeWidth={1.5} strokeDasharray="2 6" strokeLinecap="round" />

        {/* Traveler's phone (left) */}
        <Rect x={16} y={62} width={78} height={122} rx={14} stroke={C.ink} strokeWidth={2} fill={C.card} />
        {/* airplane-mode pill above the screen */}
        <Rect x={30} y={30} width={50} height={17} rx={8.5} stroke={C.sub2} strokeWidth={1.5} fill={C.panel} />
        <Path d="M46 43.5 L54 36.5 L51.5 43.5 L54 50.5 Z" fill={C.sub2} />
        <Line x1={49} y1={43.5} x2={57} y2={43.5} stroke={C.sub2} strokeWidth={1.5} strokeLinecap="round" />
        {/* hatched "no signal" arcs + the strike — the radio is OFF */}
        <Path d="M42 52 A 16 16 0 0 1 68 52" stroke={C.sub2} strokeWidth={1.5} strokeDasharray="3 4" strokeLinecap="round" />
        <Path d="M36 46 A 24 24 0 0 1 74 46" stroke={C.sub2} strokeWidth={1.5} strokeDasharray="3 4" strokeLinecap="round" />
        <Line x1={38} y1={34} x2={72} y2={58} stroke={C.ink} strokeWidth={2} strokeLinecap="round" />
        {/* phone screen: the ∂ balance mark + hairlines */}
        <Circle cx={55} cy={108} r={11} stroke={C.sub2} strokeWidth={1.5} />
        <Line x1={55} y1={119} x2={55} y2={127} stroke={C.sub2} strokeWidth={1.5} strokeLinecap="round" />
        <Line x1={34} y1={142} x2={76} y2={142} stroke={C.line2} strokeWidth={1.5} strokeLinecap="round" />
        <Line x1={40} y1={152} x2={70} y2={152} stroke={C.line2} strokeWidth={1.5} strokeLinecap="round" />

        {/* Shop terminal (right) — the LIVE arcs are animated overlays above the body */}
        <Rect x={198} y={56} width={78} height={128} rx={14} stroke={C.ink} strokeWidth={2} fill={C.card} />
        {/* terminal face: counter strip, amounts, card slot */}
        <Line x1={198} y1={78} x2={276} y2={78} stroke={C.line2} strokeWidth={1.5} />
        <Line x1={210} y1={96} x2={252} y2={96} stroke={C.sub2} strokeWidth={2} strokeLinecap="round" />
        <Line x1={210} y1={106} x2={238} y2={106} stroke={C.line2} strokeWidth={2} strokeLinecap="round" />
        <Rect x={210} y={122} width={54} height={22} rx={6} stroke={C.line2} strokeWidth={1.5} />
        <Line x1={222} y1={158} x2={252} y2={158} stroke={C.line2} strokeWidth={3} strokeLinecap="round" />
      </Svg>

      {/* The shop's breathing arcs (online ≠ static) — mini-Svg overlays, one per arc so the
          wave phases stay independent. Local paths = stage coords − the box origin. */}
      <Animated.View style={{position: 'absolute', left: 222, top: 30, width: 30, height: 16, opacity: arc1}}>
        <Svg width={30} height={16} viewBox="0 0 30 16" fill="none">
          <Path d="M3 14 A 12 12 0 0 1 27 14" stroke={C.sub} strokeWidth={2} strokeLinecap="round" />
        </Svg>
      </Animated.View>
      <Animated.View style={{position: 'absolute', left: 215, top: 14, width: 44, height: 26, opacity: arc2}}>
        <Svg width={44} height={26} viewBox="0 0 44 26" fill="none">
          <Path d="M3 23 A 20 20 0 0 1 41 23" stroke={C.sub} strokeWidth={2} strokeLinecap="round" />
        </Svg>
      </Animated.View>
      <Animated.View style={{position: 'absolute', left: 208, top: 0, width: 58, height: 32, opacity: arc3}}>
        <Svg width={58} height={32} viewBox="0 0 58 32" fill="none">
          <Path d="M3 30 A 28 28 0 0 1 55 30" stroke={C.sub2} strokeWidth={2} strokeLinecap="round" />
        </Svg>
      </Animated.View>

      {/* The traveling payment ticket (RN overlay so it can arc + land) */}
      <Animated.View
        style={{
          position: 'absolute', left: 56, top: 102, width: 46, height: 36,
          opacity: ticketOp, transform: [{translateX: ticketTx}, {translateY: ticketTy}],
        }}>
        <View style={{flex: 1, backgroundColor: C.card, borderRadius: 9, borderWidth: 1.5, borderColor: C.ink, alignItems: 'center', justifyContent: 'center'}}>
          <Text style={{fontSize: 15, fontWeight: '700', color: C.ink, fontFamily: 'space_grotesk_700'}}>∂</Text>
          <View style={{width: 20, height: 2, borderRadius: 1, backgroundColor: C.line2, marginTop: 2}} />
        </View>
      </Animated.View>

      {/* The confirmed-receipt stamp on the terminal — tangerine, spring-settled (the energy moment) */}
      <Animated.View style={{position: 'absolute', left: 252, top: 152, opacity: stamp, transform: [{scale: stampScale}]}}>
        <View style={S.walkStampBadge}>
          <IconCheck size={15} color={C.brandInk} />
        </View>
      </Animated.View>
    </View>
  );
}

// ─── Scene 2 — the key stays on the device ───────────────────────────────────────────────────
// The phone silhouette holds the tangerine key, resting on a dashed shelf line inside the screen.
// Outside, left and right: two reach-arcs curving toward the phone — each struck through. dpay's
// hands (or anyone's) do not reach the key. The beat: key drops + spring-settles onto the shelf,
// the strikes stamp in, then a quiet dashed halo marks where the key lives.

function KeyOnDeviceVisual({reduced}: {reduced: boolean}) {
  const keyOp = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const keyTy = useRef(new Animated.Value(reduced ? 0 : -20)).current;
  const keyRot = useRef(new Animated.Value(reduced ? 0 : 8)).current;
  const strikes = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const halo = useRef(new Animated.Value(reduced ? 1 : 0)).current;

  useEffect(() => {
    if (reduced) return;
    const a = Animated.sequence([
      Animated.parallel([
        Animated.spring(keyTy, {toValue: 0, friction: 6, tension: 60, delay: 520, useNativeDriver: false}),
        Animated.timing(keyOp, {toValue: 1, duration: 200, delay: 520, easing: EASE_OUT, useNativeDriver: false}),
        Animated.spring(keyRot, {toValue: 0, friction: 6, tension: 60, delay: 520, useNativeDriver: false}),
      ]),
      Animated.timing(strikes, {toValue: 1, duration: 260, delay: 120, easing: EASE_OUT, useNativeDriver: false}),
      Animated.timing(halo, {toValue: 1, duration: 420, easing: EASE_OUT, useNativeDriver: false}),
    ]);
    a.start();
    return () => { a.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The key's settle wobble: 8deg → 0 alongside the drop (interpolated below).
  const keyRotDeg = keyRot.interpolate({inputRange: [0, 8], outputRange: ['0deg', '8deg']});

  return (
    <View style={{flex: 1}}>
      <Svg width={STAGE_W} height={STAGE_H} viewBox={`0 0 ${STAGE_W} ${STAGE_H}`} fill="none">
        {/* Phone silhouette */}
        <Rect x={98} y={30} width={96} height={156} rx={18} stroke={C.ink} strokeWidth={2} fill={C.card} />
        <Line x1={134} y1={40} x2={158} y2={40} stroke={C.line2} strokeWidth={2} strokeLinecap="round" />
        <Line x1={134} y1={176} x2={158} y2={176} stroke={C.line2} strokeWidth={2} strokeLinecap="round" />
        {/* the dashed shelf the key rests on */}
        <Line x1={114} y1={152} x2={178} y2={152} stroke={C.line2} strokeWidth={1.5} strokeDasharray="3 4" strokeLinecap="round" />
      </Svg>

      {/* The quiet halo — where the key lives (local circle = stage (146,116) − box (112,82)) */}
      <Animated.View style={{position: 'absolute', left: 112, top: 82, width: 68, height: 68, opacity: halo}}>
        <Svg width={68} height={68} viewBox="0 0 68 68" fill="none">
          <Circle cx={34} cy={34} r={30} stroke={C.line} strokeWidth={1.5} strokeDasharray="2 5" />
        </Svg>
      </Animated.View>

      {/* The key — tangerine strokes, dropped + spring-settled onto the shelf. Local geometry =
          stage coords − box (118,76); the static −26° tilt stays an svg group transform, the
          settle wobble rides the overlay View. */}
      <Animated.View
        style={{
          position: 'absolute', left: 118, top: 76, width: 58, height: 76,
          opacity: keyOp, transform: [{translateY: keyTy}, {rotate: keyRotDeg}],
        }}>
        <Svg width={58} height={76} viewBox="0 0 58 76" fill="none">
          <G transform="rotate(-26 28 42)">
            <Circle cx={28} cy={16} r={13} stroke={C.brand} strokeWidth={2.5} />
            <Line x1={28} y1={29} x2={28} y2={72} stroke={C.brand} strokeWidth={2.5} strokeLinecap="round" />
            <Line x1={28} y1={58} x2={39} y2={58} stroke={C.brand} strokeWidth={2.5} strokeLinecap="round" />
            <Line x1={28} y1={69} x2={42} y2={69} stroke={C.brand} strokeWidth={2.5} strokeLinecap="round" />
          </G>
        </Svg>
      </Animated.View>

      {/* The no-reach strikes: reach-arcs curving toward the phone, each struck through
          (local = stage coords − box (53,63)) */}
      <Animated.View style={{position: 'absolute', left: 53, top: 63, width: 186, height: 72, opacity: strikes}}>
        <Svg width={186} height={72} viewBox="0 0 186 72" fill="none">
          <Path d="M5 3 C 21 19, 21 53, 5 69" stroke={C.sub2} strokeWidth={2} strokeLinecap="round" />
          <Line x1={3} y1={21} x2={27} y2={51} stroke={C.ink} strokeWidth={2.5} strokeLinecap="round" />
          <Path d="M181 3 C 165 19, 165 53, 181 69" stroke={C.sub2} strokeWidth={2} strokeLinecap="round" />
          <Line x1={159} y1={21} x2={183} y2={51} stroke={C.ink} strokeWidth={2.5} strokeLinecap="round" />
        </Svg>
      </Animated.View>
    </View>
  );
}

// ─── Scene 3 — exactly one asset ─────────────────────────────────────────────────────────────
// A real request card: eyebrow "SHOP REQUESTS", ONE highlighted exact-asset row (chip + name +
// amount + the tangerine reviewed stamp), and below it two GHOST rows — other balances that stay
// put, dimmed, with no badges. The beat: the exact row's tangerine edge sweeps in, the stamp
// pops, then the ghosts fade up at rest — untouched is the point.

function ExactAssetVisual({reduced}: {reduced: boolean}) {
  const sweep = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const stamp = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const ghosts = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const amt = useRef(new Animated.Value(reduced ? 1 : 0)).current;

  useEffect(() => {
    if (reduced) return;
    const a = Animated.sequence([
      Animated.parallel([
        Animated.timing(sweep, {toValue: 1, duration: 300, delay: 520, easing: EASE_PLATE, useNativeDriver: false}),
        Animated.timing(amt, {toValue: 1, duration: 260, delay: 560, easing: EASE_OUT, useNativeDriver: false}),
      ]),
      Animated.spring(stamp, {toValue: 1, friction: 5, tension: 64, useNativeDriver: false}),
      Animated.timing(ghosts, {toValue: 1, duration: 380, easing: EASE_OUT, useNativeDriver: false}),
    ]);
    a.start();
    return () => { a.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stampScale = stamp.interpolate({inputRange: [0, 1], outputRange: [0.2, 1]});
  const ghostOp = ghosts.interpolate({inputRange: [0, 1], outputRange: [0, 0.42]});

  return (
    <View style={{flex: 1, justifyContent: 'center'}}>
      <View style={S.walkReqCard}>
        <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}}>
          <Text style={S.walkReqEyebrow}>Shop requests</Text>
          <Text style={[S.walkReqEyebrow, {letterSpacing: 0.5}]}>#0042</Text>
        </View>

        {/* THE exact row — tangerine left edge (the assetCardActive language) + reviewed stamp */}
        <View style={{marginTop: 6, borderRadius: 12, backgroundColor: C.panel2, paddingVertical: 8, paddingLeft: 13, paddingRight: 12}}>
          <Animated.View
            style={{
              position: 'absolute', left: 0, top: 6, bottom: 6, width: 3, borderRadius: 2,
              backgroundColor: C.brand, transform: [{scaleY: sweep}],
            }}
          />
          <View style={S.walkAssetRow}>
            <View style={S.walkAssetChip}><Text style={S.walkAssetChipText}>$</Text></View>
            <View style={{flex: 1}}>
              <Text style={S.walkAssetName}>USDC</Text>
              <Text style={S.walkAssetSub}>Internet Computer</Text>
            </View>
            <Animated.Text style={[S.walkAssetAmt, {opacity: amt}]}>12.50</Animated.Text>
            <Animated.View style={{opacity: stamp, transform: [{scale: stampScale}]}}>
              <View style={S.walkStampBadge}><IconCheck size={14} color={C.brandInk} /></View>
            </Animated.View>
          </View>
        </View>

        {/* Ghost rows — other balances, present and untouched (they never convert) */}
        <Animated.View style={{opacity: ghostOp}}>
          <View style={[S.walkAssetRow, {marginTop: 2}]}>
            <View style={[S.walkAssetChip, {backgroundColor: 'transparent'}]}><Text style={[S.walkAssetChipText, {color: C.sub}]}>₿</Text></View>
            <View style={{flex: 1}}>
              <Text style={[S.walkAssetName, {color: C.sub, fontWeight: '600', fontFamily: 'space_grotesk_600'}]}>Bitcoin</Text>
            </View>
            <Text style={[S.walkAssetAmt, {color: C.sub, fontWeight: '600', fontFamily: 'space_grotesk_600'}]}>0.0421</Text>
          </View>
          <View style={[S.walkAssetRow, {marginTop: 0, marginBottom: 2}]}>
            <View style={[S.walkAssetChip, {backgroundColor: 'transparent'}]}><Text style={[S.walkAssetChipText, {color: C.sub}]}>◊</Text></View>
            <View style={{flex: 1}}>
              <Text style={[S.walkAssetName, {color: C.sub, fontWeight: '600', fontFamily: 'space_grotesk_600'}]}>Ethereum</Text>
            </View>
            <Text style={[S.walkAssetAmt, {color: C.sub, fontWeight: '600', fontFamily: 'space_grotesk_600'}]}>0.15</Text>
          </View>
        </Animated.View>
      </View>
    </View>
  );
}

const VISUALS: Record<WalkthroughVisual, React.FC<{reduced: boolean}>> = {
  offlineHandoff: OfflineHandoffVisual,
  keyOnDevice: KeyOnDeviceVisual,
  exactlyOneAsset: ExactAssetVisual,
};

// The travel-document corner tag per scene (mono, on the plate).
const STAGE_TAGS = ['01 — SIGNAL', '02 — KEY', '03 — ASSET'] as const;

/** One scene: staggered header entrance (eyebrow → title → body), then the stage + its beat. */
function Scene({index, reduced}: {index: number; reduced: boolean}) {
  const scene = WALKTHROUGH_SCENES[index];
  const entrance = useStageEntrance(reduced);
  const Visual = VISUALS[scene.visual];
  return (
    <View testID={`walkthrough-scene-${index + 1}`}>
      <RiseText style={S.walkEyebrow} delay={0} reduced={reduced}>{scene.eyebrow}</RiseText>
      <RiseText style={S.walkTitle} delay={70} reduced={reduced}>{scene.title}</RiseText>
      <RiseText style={S.walkText} delay={140} reduced={reduced} testID={`walkthrough-body-${index + 1}`}>{scene.body}</RiseText>
      <Stage entrance={entrance} tag={STAGE_TAGS[index]}>
        <Visual reduced={reduced} />
      </Stage>
    </View>
  );
}

// ─── The pager ───────────────────────────────────────────────────────────────────────────────

export type WalkthroughProps = {
  /** Final scene's "Get started" — first-run: award + reveal the create form; replay: close. */
  onDone: () => void;
  /** First-run variant: shows the top-right Skip. */
  onSkip?: () => void;
  /** Replay variant (Settings): shows the top-left close affordance instead of Skip. */
  onClose?: () => void;
  /** Test seam for the reduced-motion path (defaults to the real preference). */
  reducedMotion?: boolean;
};

export function Walkthrough({onDone, onSkip, onClose, reducedMotion}: WalkthroughProps) {
  const hookReduced = useReducedMotion();
  const reduced = reducedMotion ?? hookReduced;
  const [i, setI] = useState(0);
  const last = i === WALKTHROUGH_SCENES.length - 1;
  useEscapeToClose(() => { if (onSkip) onSkip(); else onClose?.(); });

  // Trip-prep auto-detection: viewing the walkthrough (either variant) IS "saw the flow".
  useEffect(() => { void awardStamp(JOURNEY_STAMPS.flowUnderstood); }, []);

  const next = () => { if (last) onDone(); else setI(i + 1); };
  const back = () => { if (i > 0) setI(i - 1); };

  // Active dot: a pill that widens on switch (width 6→18), never linear-feeling.
  const dotW = WALKTHROUGH_SCENES.map((_, k) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useDotWidth(k === i);
  });

  return (
    <SafeAreaView style={S.walkRoot} testID="walkthrough">
      <StatusBar barStyle={isDark() ? 'light-content' : 'dark-content'} backgroundColor={C.bg} translucent={false} />

      {/* Header — the app's standard sheet chrome (SettingsSheet grammar): title left, the
          44pt boxed affordance top-right (replay: close · first-run: skip). */}
      <View style={S.sheetHead}>
        <Text style={S.sheetTitle}>{JourneyHowItWorksTitle}</Text>
        {onClose ? (
          <Pressable
            testID="btn-walkthrough-close"
            style={S.sheetClose}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close how dpay works"
            accessibilityState={{disabled: false}}>
            <IconClose size={18} color={C.sub} />
          </Pressable>
        ) : null}
        {onSkip ? (
          <Pressable
            testID="btn-walkthrough-skip"
            style={S.sheetClose}
            onPress={onSkip}
            accessibilityRole="button"
            accessibilityLabel="Skip walkthrough"
            accessibilityHint="Go straight to creating your wallet"
            accessibilityState={{disabled: false}}>
            <IconClose size={18} color={C.sub} />
          </Pressable>
        ) : null}
      </View>

      {/* Only the ACTIVE scene is mounted — advancing re-mounts the next scene so its entrance
          choreography replays (and the e2e net can assert scene-by-scene presence). The body
          scrolls (short screens / display-zoom fonts must never clip the stage plate);
          S.walkBody carries the same 22dp side margins as the sheet header above it. */}
      <ScrollView style={{flex: 1}} contentContainerStyle={S.walkBody}>
        {WALKTHROUGH_SCENES.map((_scene, k) => (k === i ? <Scene key={k} index={k} reduced={reduced} /> : null))}
      </ScrollView>

      {/* Footer: the campaign line runs under EVERY scene (UX hardening 2026-08-23: was
          final-scene-only — the message the whole walkthrough exists for wasn't visible until
          the last tap) · Back + dots · Next/Get started */}
      <View style={S.walkFooter}>
        <CampaignStrip reduced={reduced} />
        <View style={S.walkNavRow}>
          {i > 0 ? (
            <Pressable
              testID="btn-walkthrough-back"
              style={{position: 'absolute', left: 0, minHeight: 44, paddingHorizontal: 4, justifyContent: 'center'}}
              onPress={back}
              accessibilityRole="button"
              accessibilityLabel="Previous scene"
              accessibilityState={{disabled: false}}>
              <Text style={S.walkBackText}>Back</Text>
            </Pressable>
          ) : null}
          <View testID="walkthrough-dots" style={{flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 34, justifyContent: 'center'}}>
            {dotW.map((w, k) => (
              <Animated.View key={k} style={[S.walkDot, k === i && S.walkDotOn, {width: w}]} />
            ))}
          </View>
        </View>
        <Pressable
          testID="btn-walkthrough-next"
          style={S.primary}
          onPress={next}
          accessibilityRole="button"
          accessibilityLabel={last ? 'Get started' : 'Next scene'}
          accessibilityHint={last ? 'Continue to creating your wallet' : 'Show the next scene'}
          accessibilityState={{disabled: false}}>
          <Text style={S.primaryText}>{last ? 'Get started' : 'Next'}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

/** The active dot's animated width. `useDotWidth(active)` per dot (call unconditionally). */
function useDotWidth(active: boolean): Animated.Value {
  const w = useRef(new Animated.Value(active ? 18 : 6)).current;
  useEffect(() => {
    Animated.timing(w, {toValue: active ? 18 : 6, duration: 220, easing: EASE_PLATE, useNativeDriver: false}).start();
  }, [active, w]);
  return w;
}

/** "— SIGNAL? DON'T NEED IT. —" — the campaign send-off on the final scene. */
function CampaignStrip({reduced}: {reduced: boolean}) {
  const op = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const sx = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) return;
    const a = Animated.parallel([
      Animated.timing(op, {toValue: 1, duration: 420, delay: 300, easing: EASE_OUT, useNativeDriver: false}),
      Animated.timing(sx, {toValue: 1, duration: 520, delay: 300, easing: EASE_PLATE, useNativeDriver: false}),
    ]);
    a.start();
    return () => { a.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <View style={S.walkCampaign}>
      <Animated.View style={[S.walkCampaignRule, {transform: [{scaleX: sx}]}]} />
      <Animated.Text style={[S.walkCampaignText, {opacity: op}]}>{CAMPAIGN_LINE.toUpperCase()}</Animated.Text>
      <Animated.View style={[S.walkCampaignRule, {transform: [{scaleX: sx}]}]} />
    </View>
  );
}
