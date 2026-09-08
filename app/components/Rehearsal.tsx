/**
 * Rehearsal — the one-page payment rehearsal (Trip Ready J3, re-paged 2026-08-23).
 *
 * Shown ONCE, in-memory, right after the RECOVERY SAVED beat on the create path (Onboarding's
 * finishCreate success → 'rehearsal'; there is deliberately NO stored "must show" state — an app
 * killed mid-rehearsal simply resumes into the wallet next launch, which the spec accepts).
 *
 * ONE page holds all three practice steps as badge+line rows — the same postage-mark grammar as
 * the walkthrough's stage tags — with copy verbatim from config/education.ts `rehearsalSteps()`,
 * which owns what the page is for; the closing line (`M.education.rehearsal.punchline`) is the
 * honesty pin. Nothing here is simulated and no transfer is claimed.
 *
 * (Was a 3-beat auto-advancing pager — 18s of passive paging doing one screen's job; the round-2
 * UX audit collapsed it to this single scannable page. Every step is visible at a glance, so
 * MOUNTING the page awards the flowUnderstood stamp (idempotent) — a skip from this page has still
 * seen them. Reduced motion: entrances render at rest.)
 *
 * testID contract (e2e flow 90): root `rehearsal`, steps `rehearsal-step-1..3` (all mounted
 * together), bodies `rehearsal-body-1..3`, punchline `rehearsal-punchline`, `btn-rehearsal-next`
 * ("Choose my currency" → onTry), `btn-rehearsal-skip` ("Skip practice" → onSkip).
 */
import React, {useEffect, useRef} from 'react';
import {Animated, Easing, Pressable, SafeAreaView, ScrollView, StatusBar, Text, View} from 'react-native';
import {C} from '../config/palette';
import {S, isDark} from '../styles';
import {M} from '../i18n';
import {rehearsalSteps} from '../config/education';
import {JOURNEY_STAMPS, awardStamp} from '../lib/journey';
import {useReducedMotion} from '../hooks/useReducedMotion';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {IconClose} from './icons';

const EASE_OUT = Easing.out(Easing.cubic);

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

  // All three steps are on this one page, so MOUNTING it is seeing them.
  // Idempotent; skipped-after-mount runs still stamped (the skip button lives on this page).
  useEffect(() => { void awardStamp(JOURNEY_STAMPS.flowUnderstood); }, []);

  return (
    <SafeAreaView testID="rehearsal" style={S.walkRoot}>
      <StatusBar barStyle={isDark() ? 'light-content' : 'dark-content'} backgroundColor={C.bg} translucent={false} />
      {/* Header — the app's standard sheet chrome (SettingsSheet grammar): title left, the
          44pt boxed affordance top-right ("Skip practice" — same exit as the primary). */}
      <View style={S.sheetHead}>
        <Text style={S.sheetTitle}>{M.education.rehearsal.sheetTitle}</Text>
        <Pressable
          testID="btn-rehearsal-skip"
          style={S.sheetClose}
          onPress={onSkip}
          accessibilityRole="button"
          accessibilityLabel={M.education.rehearsal.skip}
          accessibilityHint={M.education.rehearsal.skipHint}
          accessibilityState={{disabled: false}}>
          <IconClose size={18} color={C.sub} />
        </Pressable>
      </View>
      <ScrollView style={S.walkScroll} contentContainerStyle={S.walkBody}>
        <RiseText style={S.walkTitle} delay={0} reduced={reduced}>{M.education.rehearsal.title}</RiseText>
        {rehearsalSteps().map((step, i) => (
          <View key={step.id} testID={`rehearsal-step-${i + 1}`} style={S.rehStep}>
            <View style={S.rehBadge}><Text style={S.rehBadgeText}>{M.education.rehearsal.stageTags[i]}</Text></View>
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
          testID="rehearsal-punchline">{M.education.rehearsal.punchline}</RiseText>
        <Pressable
          testID="btn-rehearsal-next"
          style={S.primary}
          onPress={onTry}
          accessibilityRole="button"
          accessibilityLabel={M.education.rehearsal.try}
          accessibilityState={{disabled: false}}>
          <Text style={S.primaryText}>{M.education.rehearsal.try}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
