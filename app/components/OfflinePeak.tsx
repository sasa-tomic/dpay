/**
 * OfflinePeak.tsx — the one-shot offline peak moment (Trip Ready J5, 2026-08-22).
 *
 * The FIRST truly-offline confirmed payment earns the campaign moment: the editorial campaign
 * line ("Signal? Don't need it." — the single-sourced CAMPAIGN_LINE constant) and the
 * "no signal the whole time" microcopy. ~2s, then it settles INTO the paid card as a quiet
 * mono remnant — it never blocks Done/actions, auto-settles, and is shown exactly once ever
 * (the gating + stamp award live in the caller; see lib/peak.ts). (The 118px "dpay" circle
 * stamp was dropped by founder directive 2026-08-24 — the copy carries the moment alone.)
 *
 * testID contract (e2e flow 92): the wrapper carries `offline-peak` for its WHOLE lifetime
 * (moment AND settled remnant — deterministic to catch), and the settled remnant additionally
 * carries `first-offline-stamp`.
 *
 * Reduced motion: the moment renders at rest (no animated values), still auto-settling on the
 * same timer — the reader gets the same information, none of the motion.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, Text, View} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {M} from '../i18n';
import {CAMPAIGN_LINE} from '../config/education';
import {useReducedMotion} from '../hooks/useReducedMotion';
import {IconWifiOff} from './icons';

const EASE_OUT = Easing.out(Easing.cubic);
const SETTLE_MS = 2000;

export function OfflinePeak() {
  const reduced = useReducedMotion();
  const [settled, setSettled] = useState(false);
  // The moment: campaign line rises, microcopy fades in.
  const lineOp = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const lineTy = useRef(new Animated.Value(reduced ? 0 : 10)).current;
  const microOp = useRef(new Animated.Value(reduced ? 1 : 0)).current;

  useEffect(() => {
    const t = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (reduced) return;
    const moment = Animated.parallel([
      Animated.timing(lineOp, {toValue: 1, duration: 300, easing: EASE_OUT, useNativeDriver: false}),
      Animated.timing(lineTy, {toValue: 0, duration: 300, easing: EASE_OUT, useNativeDriver: false}),
      Animated.timing(microOp, {toValue: 1, duration: 280, delay: 280, easing: EASE_OUT, useNativeDriver: false}),
    ]);
    moment.start();
    return () => { moment.stop(); };
    // The beat runs once per mount (the caller keys this component to the paid card).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (settled) {
    return (
      <View testID="offline-peak" style={S.peakWrap} pointerEvents="none">
        <View testID="first-offline-stamp" style={S.peakSettled}>
          <IconWifiOff size={13} color={C.sub2} />
          <Text style={S.peakSettledText}>{M.education.peak.settled}</Text>
        </View>
      </View>
    );
  }
  return (
    <View testID="offline-peak" style={S.peakWrap} pointerEvents="none">
      <Animated.Text style={[S.peakCampaign, {opacity: lineOp, transform: [{translateY: lineTy}]}]}>
        {CAMPAIGN_LINE}
      </Animated.Text>
      <Animated.Text style={[S.peakMicro, {opacity: microOp}]}>
        {M.education.peak.micro}
      </Animated.Text>
    </View>
  );
}
