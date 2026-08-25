/**
 * Rehearsal — the one-page payment rehearsal (Trip Ready J3, re-paged 2026-08-23).
 *
 * Shown ONCE, in-memory, right after the RECOVERY SAVED beat on the create path (Onboarding's
 * finishCreate success → 'rehearsal'; there is deliberately NO stored "must show" state — an app
 * killed mid-rehearsal simply resumes into the wallet next launch, which the spec accepts).
 *
 * ONE page tells ONE honest payment (request → approve → settle): three badge+line rows — the
 * same postage-mark grammar as the walkthrough's stage tags — with copy verbatim from
 * config/education.ts REHEARSAL_STEPS; the closing line REHEARSAL_PUNCHLINE is the
 * comprehension pin (approval + handoff need no signal). Nothing here fabricates a transaction —
 * it is explicitly a rehearsal, and the exit line says so.
 *
 * (Was a 3-beat auto-advancing pager — 18s of passive paging doing one screen's job; the round-2
 * UX audit collapsed it to this single scannable page. The whole flow, settle truth included, is
 * visible at a glance, so MOUNTING the page awards the flowUnderstood stamp (idempotent) — a skip
 * from this page has still seen the flow. Reduced motion: entrances render at rest.)
 *
 * testID contract (e2e flow 90): root `rehearsal`, steps `rehearsal-step-1..3` (all mounted
 * together), bodies `rehearsal-body-1..3`, punchline `rehearsal-punchline`, `btn-rehearsal-next`
 * ("Try with demo funds" → onTry), `btn-rehearsal-skip` ("Explore wallet" → onSkip).
 */
import React, {useEffect, useRef} from 'react';
import {Animated, Easing, Pressable, SafeAreaView, ScrollView, StatusBar, Text, View} from 'react-native';
import {C} from '../config/palette';
import {S, isDark} from '../styles';
import {REHEARSAL_STEPS, REHEARSAL_PUNCHLINE, REHEARSAL_TITLE} from '../config/education';
import {JOURNEY_STAMPS, awardStamp} from '../lib/journey';
import {useReducedMotion} from '../hooks/useReducedMotion';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {IconClose} from './icons';

const EASE_OUT = Easing.out(Easing.cubic);
const STAGE_TAGS = ['01 — REQUEST', '02 — APPROVE', '03 — SETTLE'] as const;

/** Rise-in text (Walkthrough grammar): 8px rise + fade, one delay slot per element. */
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

export function Rehearsal({onTry, onSkip, reducedMotion}: {onTry: () => void; onSkip: () => void; reducedMotion?: boolean}) {
  const hookReduced = useReducedMotion();
  const reduced = reducedMotion ?? hookReduced;
  useEscapeToClose(onSkip);

  // The whole flow — settle truth included — is on this one page, so MOUNTING it is seeing it.
  // Idempotent; skipped-after-mount runs still stamped (the skip button lives on this page).
  useEffect(() => { void awardStamp(JOURNEY_STAMPS.flowUnderstood); }, []);

  return (
    <SafeAreaView testID="rehearsal" style={S.walkRoot}>
      <StatusBar barStyle={isDark() ? 'light-content' : 'dark-content'} backgroundColor={C.bg} translucent={false} />
      {/* Header — the app's standard sheet chrome (SettingsSheet grammar): title left, the
          44pt boxed affordance top-right ("Explore wallet" — skip to the funded wallet). */}
      <View style={S.sheetHead}>
        <Text style={S.sheetTitle}>Rehearsal</Text>
        <Pressable
          testID="btn-rehearsal-skip"
          style={S.sheetClose}
          onPress={onSkip}
          accessibilityRole="button"
          accessibilityLabel="Explore wallet"
          accessibilityHint="Skip the rehearsal and open your wallet"
          accessibilityState={{disabled: false}}>
          <IconClose size={18} color={C.sub} />
        </Pressable>
      </View>
      <ScrollView style={S.walkScroll} contentContainerStyle={S.walkBody}>
        <RiseText style={S.walkTitle} delay={0} reduced={reduced}>{REHEARSAL_TITLE}</RiseText>
        {REHEARSAL_STEPS.map((step, i) => (
          <View key={step.id} testID={`rehearsal-step-${i + 1}`} style={S.rehStep}>
            <View style={S.rehBadge}><Text style={S.rehBadgeText}>{STAGE_TAGS[i]}</Text></View>
            <RiseText style={S.rehStepTitle} delay={120 + i * 90} reduced={reduced}>{step.title}</RiseText>
            <RiseText style={S.rehStepBody} delay={160 + i * 90} reduced={reduced} testID={`rehearsal-body-${i + 1}`}>{step.body}</RiseText>
          </View>
        ))}
      </ScrollView>
      <View style={S.walkFooter}>
        <RiseText
          style={[S.walkCampaignText, {textAlign: 'center', textTransform: 'none', letterSpacing: 0.4, fontSize: 12.5, lineHeight: 18, flex: 0}]}
          delay={240}
          reduced={reduced}
          testID="rehearsal-punchline">{REHEARSAL_PUNCHLINE}</RiseText>
        <Pressable
          testID="btn-rehearsal-next"
          style={S.primary}
          onPress={onTry}
          accessibilityRole="button"
          accessibilityLabel="Try with demo funds"
          accessibilityState={{disabled: false}}>
          <Text style={S.primaryText}>Try with demo funds</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
