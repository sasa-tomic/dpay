/**
 * Rehearsal — the 3-beat payment rehearsal (Trip Ready J3, 2026-08-22).
 *
 * Shown ONCE, in-memory, right after the RECOVERY SAVED beat on the create path (Onboarding's
 * finishCreate success → 'rehearsal'; there is deliberately NO stored "must show" state — an app
 * killed mid-rehearsal simply resumes into the wallet next launch, which the spec accepts).
 *
 * Three beats tell ONE honest payment (request → approve → settle) with the walkthrough's cast
 * and paper-cut grammar — same stage frame, same live-arc shop terminal, same traveler phone —
 * so the rehearsal reads as the walkthrough's story continued, not a new metaphor. Copy is
 * verbatim from config/education.ts REHEARSAL_STEPS; the closing line REHEARSAL_PUNCHLINE is
 * the comprehension pin (approval + handoff need no signal). Nothing here fabricates a
 * transaction — it is explicitly a rehearsal, and the exit line says so.
 *
 * Advancement: auto-advance every beat with a hairline progress affordance, AND a Next tap
 * (final label "Try with demo funds" → onTry; "Explore wallet" top-right → onSkip at any beat).
 * Reaching beat 3 awards the flowUnderstood stamp (idempotent). Reduced motion: no auto-advance
 * (nothing moves unless tapped), entrances render at rest, no breathing arcs.
 *
 * testID contract (e2e flow 90): root `rehearsal`, steps `rehearsal-step-1..3`, bodies
 * `rehearsal-body-1..3`, punchline `rehearsal-punchline`, `btn-rehearsal-next`, `btn-rehearsal-skip`.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, Pressable, SafeAreaView, StatusBar, Text, View} from 'react-native';
import Svg, {Circle, Line, Path, Rect} from 'react-native-svg';
import {C} from '../config/palette';
import {S, isDark} from '../styles';
import {REHEARSAL_STEPS, REHEARSAL_PUNCHLINE} from '../config/education';
import {JOURNEY_STAMPS, awardStamp} from '../lib/journey';
import {useReducedMotion} from '../hooks/useReducedMotion';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {IconCheck} from './icons';

const STAGE_W = 292;
const STAGE_H = 218;
const LAST = REHEARSAL_STEPS.length - 1;
const EASE_OUT = Easing.out(Easing.cubic);
const EASE_PLATE = Easing.bezier(0.22, 1, 0.36, 1);
/** Per-beat auto-advance window — long enough to read a beat, short enough to feel alive. */
const ADVANCE_MS = 6000;
const STAGE_TAGS = ['01 — REQUEST', '02 — APPROVE', '03 — SETTLE'] as const;

// ─── Shared choreography primitives (same grammar as Walkthrough; local copies because the
// Walkthrough's are module-private — the two pagers stay independently tweakable) ────────────

function RiseText({children, style, delay, reduced, testID}: {
  children: string; style?: object | object[]; delay: number; reduced: boolean; testID?: string;
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
    return () => { a.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Animated.Text testID={testID} style={[style, {opacity: op, transform: [{translateY: ty}]}]}>{children}</Animated.Text>;
}

/** The stage plate entrance: settle + a 10px rise (per-beat — lives inside Beat). */
function useStageEntrance(reduced: boolean) {
  const op = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const ty = useRef(new Animated.Value(reduced ? 0 : 10)).current;
  const sc = useRef(new Animated.Value(reduced ? 1 : 0.985)).current;
  useEffect(() => {
    if (reduced) return;
    const a = Animated.parallel([
      Animated.timing(op, {toValue: 1, duration: 320, delay: 200, easing: EASE_PLATE, useNativeDriver: false}),
      Animated.timing(ty, {toValue: 0, duration: 320, delay: 200, easing: EASE_PLATE, useNativeDriver: false}),
      Animated.timing(sc, {toValue: 1, duration: 340, delay: 200, easing: EASE_PLATE, useNativeDriver: false}),
    ]);
    a.start();
    return () => { a.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return {op, ty, sc};
}

/** Dot width 6↔18 while active (called unconditionally per dot, Walkthrough pattern). */
function useDotWidth(active: boolean) {
  const w = useRef(new Animated.Value(active ? 18 : 6)).current;
  useEffect(() => {
    const a = Animated.timing(w, {toValue: active ? 18 : 6, duration: 220, easing: EASE_PLATE, useNativeDriver: false});
    a.start();
    return () => { a.stop(); };
  }, [active, w]);
  return w;
}

// ─── Beat illustrations ──────────────────────────────────────────────────────────────────────
// CRITICAL (same constraint as Walkthrough): svg elements are NEVER wrapped in
// Animated.createAnimatedComponent — RNW forwards RN's `collapsable` prop onto the DOM node,
// which trips e2e diagnostics. Animated fragments are drawn in LOCAL coordinates inside a mini
// <Svg> hosted by an absolutely-positioned Animated.View overlay. Radii are therefore STATIC;
// only opacities/transforms animate.

/** The shop terminal silhouette — the walkthrough's terminal, now the protagonist. */
function TerminalStatic({x}: {x: number}) {
  return (
    <>
      <Rect x={x} y={94} width={78} height={98} rx={12} fill={C.card} stroke={C.line2} strokeWidth={1.5} />
      <Rect x={x + 12} y={124} width={54} height={44} rx={8} fill={C.panel2} stroke={C.line} strokeWidth={1} />
      {/* the terminal's screen: one exact amount row (tangerine chip) + a ghost row */}
      <Line x1={x + 19} y1={136} x2={x + 40} y2={136} stroke={C.sub2} strokeWidth={3} strokeLinecap="round" />
      <Line x1={x + 19} y1={147} x2={x + 33} y2={147} stroke={C.line} strokeWidth={3} strokeLinecap="round" />
      <Rect x={x + 44} y={132} width={16} height={16} rx={5} fill={C.brand} opacity={0.92} />
      <Line x1={x + 26} y1={192} x2={x + 52} y2={192} stroke={C.line2} strokeWidth={3} strokeLinecap="round" />
    </>
  );
}

/** Infinite "connection breathing" arcs over the terminal — the shop's OWN live connection. */
function TerminalBreather({x, reduced}: {x: number; reduced: boolean}) {
  const a1 = useRef(new Animated.Value(reduced ? 0.9 : 0)).current;
  const a2 = useRef(new Animated.Value(reduced ? 0.4 : 0)).current;
  const a3 = useRef(new Animated.Value(reduced ? 0.25 : 0)).current;
  useEffect(() => {
    if (reduced) return;
    const arcs = [a1, a2, a3].map((v, i) =>
      Animated.loop(Animated.sequence([
        Animated.timing(v, {toValue: [0.9, 0.45, 0.28][i], duration: 900, delay: i * 300, easing: EASE_PLATE, useNativeDriver: false}),
        Animated.timing(v, {toValue: 0.08, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: false}),
      ])));
    arcs.forEach(a => a.start());
    return () => { arcs.forEach(a => a.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const cx = x + 39;
  return (
    <View style={{position: 'absolute', left: 0, top: 0, width: STAGE_W, height: STAGE_H}}>
      <Animated.View style={{position: 'absolute', left: 0, top: 0, width: STAGE_W, height: STAGE_H, opacity: a1}}>
        <Svg width={STAGE_W} height={STAGE_H} style={{position: 'absolute', left: 0, top: 0}}>
          <Circle cx={cx} cy={112} r={10} stroke={C.brand} strokeWidth={1.6} fill="none" />
        </Svg>
      </Animated.View>
      <Animated.View style={{position: 'absolute', left: 0, top: 0, width: STAGE_W, height: STAGE_H, opacity: a2}}>
        <Svg width={STAGE_W} height={STAGE_H} style={{position: 'absolute', left: 0, top: 0}}>
          <Circle cx={cx} cy={112} r={17} stroke={C.brand} strokeWidth={1.4} fill="none" />
        </Svg>
      </Animated.View>
      <Animated.View style={{position: 'absolute', left: 0, top: 0, width: STAGE_W, height: STAGE_H, opacity: a3}}>
        <Svg width={STAGE_W} height={STAGE_H} style={{position: 'absolute', left: 0, top: 0}}>
          <Circle cx={cx} cy={112} r={24} stroke={C.brand} strokeWidth={1.2} fill="none" />
        </Svg>
      </Animated.View>
    </View>
  );
}

/** Hatched "no signal" arcs + strike — the payer's phone, happily offline. */
function OfflineArcs({cx, cy}: {cx: number; cy: number}) {
  return (
    <>
      <Path d={`M ${cx - 14} ${cy + 6} a 20 20 0 0 1 28 0`} stroke={C.sub2} strokeWidth={1.6} fill="none" strokeDasharray="3 3" />
      <Path d={`M ${cx - 7} ${cy + 12} a 12 12 0 0 1 14 0`} stroke={C.sub2} strokeWidth={1.6} fill="none" strokeDasharray="3 3" />
      <Line x1={cx + 16} y1={cy - 4} x2={cx - 16} y2={cy + 16} stroke={C.bad} strokeWidth={1.6} strokeLinecap="round" />
    </>
  );
}

/** BEAT 1 — the shop requests: terminal shows the exact amount; the request code pops out. */
function ShopRequestVisual({reduced}: {reduced: boolean}) {
  const X = 107; // terminal left edge; the code chip springs out to its top-right
  const codeOp = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const codeTy = useRef(new Animated.Value(reduced ? 0 : 14)).current;
  const codeSc = useRef(new Animated.Value(reduced ? 1 : 0.4)).current;
  useEffect(() => {
    if (reduced) return;
    const seq = Animated.sequence([
      Animated.delay(430),
      Animated.parallel([
        Animated.spring(codeSc, {toValue: 1, friction: 5, tension: 64, useNativeDriver: false}),
        Animated.timing(codeOp, {toValue: 1, duration: 200, easing: EASE_OUT, useNativeDriver: false}),
        Animated.timing(codeTy, {toValue: 0, duration: 300, easing: EASE_OUT, useNativeDriver: false}),
      ]),
    ]);
    seq.start();
    return () => { seq.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <View style={{width: STAGE_W, height: STAGE_H}}>
      <Svg width={STAGE_W} height={STAGE_H} style={{position: 'absolute', left: 0, top: 0}}>
        <TerminalStatic x={X} />
        {/* dashed lane — where the code is heading (the payer arrives in beat 2) */}
        <Path d="M 250 58 L 270 58" stroke={C.sub2} strokeWidth={1.4} strokeDasharray="4 4" fill="none" />
        <Path d="M 265 54 L 270 58 L 265 62" stroke={C.sub2} strokeWidth={1.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
      <TerminalBreather x={X} reduced={reduced} />
      {/* the request code — a QR-cut chip with a tangerine ring, sprung out of the terminal */}
      <Animated.View style={{position: 'absolute', left: 196, top: 34, opacity: codeOp, transform: [{translateY: codeTy}, {scale: codeSc}]}}>
        <View style={{width: 48, height: 48, borderRadius: 12, backgroundColor: C.card, borderWidth: 1.5, borderColor: C.brand, alignItems: 'center', justifyContent: 'center'}}>
          <View style={{width: 24, height: 24}}>
            <View style={{position: 'absolute', left: 0, top: 0, width: 7, height: 7, borderRadius: 2, backgroundColor: C.ink}} />
            <View style={{position: 'absolute', right: 0, top: 0, width: 7, height: 7, borderRadius: 2, backgroundColor: C.ink}} />
            <View style={{position: 'absolute', left: 0, bottom: 0, width: 7, height: 7, borderRadius: 2, backgroundColor: C.ink}} />
            <View style={{position: 'absolute', right: 3, bottom: 3, width: 4, height: 4, borderRadius: 1, backgroundColor: C.brand}} />
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

/** BEAT 2 — you review and approve: the traveler phone (offline) with the review card; YOUR key lands on the approve pill. */
function PayerReviewVisual({reduced}: {reduced: boolean}) {
  const cardOp = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const cardTy = useRef(new Animated.Value(reduced ? 0 : 10)).current;
  const keySc = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) return;
    const card = Animated.parallel([
      Animated.timing(cardOp, {toValue: 1, duration: 300, delay: 160, easing: EASE_PLATE, useNativeDriver: false}),
      Animated.timing(cardTy, {toValue: 0, duration: 300, delay: 160, easing: EASE_PLATE, useNativeDriver: false}),
    ]);
    const key = Animated.spring(keySc, {toValue: 1, friction: 5, tension: 64, delay: 620, useNativeDriver: false});
    card.start();
    key.start();
    return () => { card.stop(); key.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <View style={{width: STAGE_W, height: STAGE_H}}>
      <Svg width={STAGE_W} height={STAGE_H} style={{position: 'absolute', left: 0, top: 0}}>
        {/* traveler phone silhouette */}
        <Rect x={118} y={58} width={56} height={116} rx={13} fill={C.card} stroke={C.line2} strokeWidth={1.5} />
        <Rect x={138} y={63} width={16} height={3.5} rx={1.75} fill={C.line2} />
        {/* airplane-mode pill — this approval needs no signal */}
        <Rect x={136} y={72} width={20} height={9} rx={4.5} fill={C.panel2} stroke={C.line} strokeWidth={1} />
        <OfflineArcs cx={146} cy={40} />
      </Svg>
      {/* the review card ON the phone's screen — exactly what you're paying */}
      <Animated.View style={{position: 'absolute', left: 124, top: 88, opacity: cardOp, transform: [{translateY: cardTy}]}}>
        <View style={{width: 44, height: 56, borderRadius: 9, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, alignItems: 'center', paddingTop: 5}}>
          <View style={{width: 22, height: 2.5, borderRadius: 1.25, backgroundColor: C.sub2}} />
          <View style={{width: 30, height: 3, borderRadius: 1.5, backgroundColor: C.ink, marginTop: 6}} />
          <View style={{width: 18, height: 2, borderRadius: 1, backgroundColor: C.line, marginTop: 4}} />
          {/* the approve pill — tangerine outline, waiting for the key */}
          <View style={{marginTop: 9, width: 32, height: 11, borderRadius: 5.5, borderWidth: 1.5, borderColor: C.brand}} />
        </View>
      </Animated.View>
      {/* the key mark springs onto the pill's corner — YOUR key, not the shop's */}
      <Animated.View style={{position: 'absolute', left: 158, top: 118, opacity: keySc, transform: [{scale: keySc}]}}>
        <View style={{width: 18, height: 18, borderRadius: 9, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center', shadowColor: C.brand2, shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: {width: 0, height: 2}, elevation: 2}}>
          <IconCheck size={10} color={C.brandInk} />
        </View>
      </Animated.View>
    </View>
  );
}

/** BEAT 3 — the shop settles: the phone stays offline; the shop's connection prints the receipt + confirms on ITS screen. */
function ShopSettlesVisual({reduced}: {reduced: boolean}) {
  const slipTy = useRef(new Animated.Value(reduced ? 0 : 16)).current;
  const slipOp = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const stampSc = useRef(new Animated.Value(reduced ? 1 : 0.3)).current;
  useEffect(() => {
    if (reduced) return;
    const slip = Animated.parallel([
      Animated.timing(slipTy, {toValue: 0, duration: 420, delay: 300, easing: EASE_PLATE, useNativeDriver: false}),
      Animated.timing(slipOp, {toValue: 1, duration: 260, delay: 300, easing: EASE_OUT, useNativeDriver: false}),
    ]);
    const stamp = Animated.spring(stampSc, {toValue: 1, friction: 5, tension: 64, delay: 700, useNativeDriver: false});
    slip.start();
    stamp.start();
    return () => { slip.stop(); stamp.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <View style={{width: STAGE_W, height: STAGE_H}}>
      <Svg width={STAGE_W} height={STAGE_H} style={{position: 'absolute', left: 0, top: 0}}>
        {/* traveler phone, left — still happily offline */}
        <Rect x={36} y={118} width={44} height={88} rx={11} fill={C.card} stroke={C.line2} strokeWidth={1.5} />
        <OfflineArcs cx={58} cy={102} />
        {/* the handoff lane — the payment traveled without the phone ever getting signal */}
        <Path d="M 88 158 C 120 138 152 138 186 146" stroke={C.sub2} strokeWidth={1.4} strokeDasharray="4 4" fill="none" />
        <TerminalStatic x={186} />
      </Svg>
      <TerminalBreather x={186} reduced={reduced} />
      {/* the receipt slip — printed UP out of the terminal's slot */}
      <Animated.View style={{position: 'absolute', left: 200, top: 50, opacity: slipOp, transform: [{translateY: slipTy}]}}>
        <View style={{width: 50, height: 40, borderRadius: 6, backgroundColor: C.card, borderWidth: 1, borderColor: C.line2, alignItems: 'center', paddingTop: 6}}>
          <View style={{width: 28, height: 2.5, borderRadius: 1.25, backgroundColor: C.sub2}} />
          <View style={{width: 34, height: 3, borderRadius: 1.5, backgroundColor: C.ink, marginTop: 5}} />
          <View style={{width: 20, height: 2, borderRadius: 1, backgroundColor: C.line, marginTop: 4}} />
        </View>
      </Animated.View>
      {/* the confirmed stamp — on the SHOP's screen, where the confirmation actually lives */}
      <Animated.View style={{position: 'absolute', left: 232, top: 130, opacity: stampSc, transform: [{scale: stampSc}]}}>
        <View style={[S.walkStampBadge, {marginLeft: 0}]} testID="rehearsal-settle-stamp">
          <IconCheck size={14} color={C.brandInk} />
        </View>
      </Animated.View>
    </View>
  );
}

const VISUALS: Record<string, React.FC<{reduced: boolean}>> = {
  shopRequest: ShopRequestVisual,
  payerReview: PayerReviewVisual,
  shopSettles: ShopSettlesVisual,
};

// ─── The pager ───────────────────────────────────────────────────────────────────────────────

function Beat({i, reduced}: {i: number; reduced: boolean}) {
  const step = REHEARSAL_STEPS[i];
  const entrance = useStageEntrance(reduced);
  const Visual = VISUALS[step.visual];
  return (
    <View testID={`rehearsal-step-${i + 1}`} style={S.walkBody}>
      <RiseText style={S.walkEyebrow} delay={0} reduced={reduced}>{'THE REHEARSAL'}</RiseText>
      <RiseText style={S.walkTitle} delay={70} reduced={reduced}>{step.title}</RiseText>
      <RiseText style={S.walkText} delay={140} reduced={reduced} testID={`rehearsal-body-${i + 1}`}>{step.body}</RiseText>
      <Animated.View style={[S.walkStage, {opacity: entrance.op, transform: [{translateY: entrance.ty}, {scale: entrance.sc}]}]}>
        <Text style={S.walkStageTag}>{STAGE_TAGS[i]}</Text>
        <View style={{width: STAGE_W, height: STAGE_H, alignItems: 'center', justifyContent: 'center'}}>
          <Visual reduced={reduced} />
        </View>
      </Animated.View>
    </View>
  );
}

function Dot({active}: {active: boolean}) {
  const w = useDotWidth(active);
  return <Animated.View style={[S.walkDot, active ? S.walkDotOn : null, {width: w}]} />;
}

export function Rehearsal({onTry, onSkip, reducedMotion}: {onTry: () => void; onSkip: () => void; reducedMotion?: boolean}) {
  const hookReduced = useReducedMotion();
  const reduced = reducedMotion ?? hookReduced;
  const [i, setI] = useState(0);
  const last = i === LAST;
  useEscapeToClose(onSkip);

  // Auto-advance with a hairline progress affordance. Never fires from the LAST beat (the exit
  // is always a choice), never fires under reduced motion (nothing moves unless tapped).
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced || last) return;
    progress.setValue(0);
    const a = Animated.timing(progress, {toValue: 1, duration: ADVANCE_MS, easing: Easing.linear, useNativeDriver: false});
    a.start(({finished}) => { if (finished) setI(v => Math.min(v + 1, LAST)); });
    return () => { a.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, reduced]);

  // Reaching the settle beat = the flow is understood (idempotent award; skipped-before-beat-3
  // runs never stamp it — the user must actually SEE the settle truth).
  useEffect(() => {
    if (i === LAST) void awardStamp(JOURNEY_STAMPS.flowUnderstood);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  return (
    <SafeAreaView testID="rehearsal" style={S.walkRoot}>
      <StatusBar barStyle={isDark() ? 'light-content' : 'dark-content'} backgroundColor={C.bg} translucent={false} />
      <View style={S.walkTop}>
        <Text style={S.wordmarkPay}>∂pay</Text>
        <Pressable
          testID="btn-rehearsal-skip"
          style={S.walkSkipBtn}
          onPress={onSkip}
          accessibilityRole="button"
          accessibilityLabel="Explore wallet"
          accessibilityHint="Skip the rehearsal and open your wallet">
          <Text style={S.walkSkipText}>Explore wallet</Text>
        </Pressable>
      </View>
      {/* Only the ACTIVE beat is mounted — advancing remounts the scene and replays its choreography. */}
      <Beat key={i} i={i} reduced={reduced} />
      <View style={S.walkFooter}>
        {last ? (
          <RiseText
            style={[S.walkCampaignText, {textAlign: 'center', textTransform: 'none', letterSpacing: 0.4, fontSize: 12.5, lineHeight: 18, flex: 0}]}
            delay={140}
            reduced={reduced}
            testID="rehearsal-punchline">{REHEARSAL_PUNCHLINE}</RiseText>
        ) : null}
        {/* The auto-advance hairline — the beat moves itself; tapping Next just moves it sooner. */}
        {reduced ? null : (
          <View style={S.rehProgressRail}>
            <Animated.View style={[S.rehProgressFill, {transform: [{scaleX: last ? 1 : progress}]}]} />
          </View>
        )}
        <View testID="rehearsal-dots" style={S.walkNavRow}>
          {REHEARSAL_STEPS.map((s, idx) => <Dot key={s.id} active={idx === i} />)}
        </View>
        <Pressable
          testID="btn-rehearsal-next"
          style={S.primary}
          onPress={() => { last ? onTry() : setI(i + 1); }}
          accessibilityRole="button"
          accessibilityLabel={last ? 'Try with demo funds' : 'Next rehearsal step'}
          accessibilityState={{disabled: false}}>
          <Text style={S.primaryText}>{last ? 'Try with demo funds' : 'Next'}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
