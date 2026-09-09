/**
 * CoachTip — the one-time contextual first-use card (Trip Ready J4, 2026-08-22).
 *
 * A small dismissible paper card mounted INLINE at the surface its truth applies to (never an
 * overlay — it can never block the primary action). Shown only until dismissed: the gate reads
 * the journey store's `seen` markers, and a dismissal writes one via `markSeen`. Unmounting the
 * surface simply takes it along (no state to clean; re-entering before dismissing shows it
 * again — the memory is the DISMISSAL, not the visit).
 *
 * Copy lives in the message catalog (`M.education.coachTips` — the pinned contract, never
 * paraphrased here). Entrance is a single subtle 6px rise + fade; reduced motion renders it at rest.
 *
 * testID contract (e2e flow 91): card `coach-<key>`, dismiss `btn-coach-<key>-dismiss`.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, Pressable, Text, View} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {M} from '../i18n';
import {type CoachTipKey} from '../config/education';
import {hasSeen, loadJourney, markSeen} from '../lib/journey';
import {useReducedMotion} from '../hooks/useReducedMotion';
import {IconClock, IconClose, IconQr, IconWifiOff} from './icons';

// The per-surface glyph — the icon restates the tip's truth at a glance (outgoing payment,
// request code, no signal, unresolved clock). Never a celebration mark.
//
// `tint` is the palette KEY, not a colour: `C` is mutated in place when the theme flips, so a
// module-level table that stored `C.brandText` would freeze whichever theme happened to be
// resolved at import. That was invisible while both themes shared one tangerine and is a visible
// wrong-colour icon now that they do not — the same reason `styles.ts` rebuilds `S` rather than
// caching hexes.
const TIP_ICONS: Record<CoachTipKey, {icon: React.FC<{size?: number; color?: string}>; tint: 'brandText' | 'warn'}> = {
  receiveRequest: {icon: IconQr, tint: 'brandText'},
  offlineQr: {icon: IconWifiOff, tint: 'warn'},
  pendingOutcome: {icon: IconClock, tint: 'warn'},
};

export function CoachTip({tipKey, reducedMotion}: {tipKey: CoachTipKey; reducedMotion?: boolean}) {
  const hookReduced = useReducedMotion();
  const reduced = reducedMotion ?? hookReduced;
  const tip = M.education.coachTips[tipKey];

  // Tri-state: 'checking' → the journey hasn't loaded (render nothing — the surface must never
  // shift under the user while storage resolves); true → show; false → already seen.
  const [show, setShow] = useState<'checking' | boolean>('checking');
  useEffect(() => {
    let alive = true;
    loadJourney().then(j => { if (alive) setShow(!hasSeen(j, tipKey)); }).catch(() => { if (alive) setShow(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Entrance: one 6px rise + fade (260ms). Reduced → at rest.
  const op = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const ty = useRef(new Animated.Value(reduced ? 0 : 6)).current;
  useEffect(() => {
    if (reduced || show !== true) return;
    const a = Animated.parallel([
      Animated.timing(op, {toValue: 1, duration: 260, delay: 220, easing: Easing.out(Easing.cubic), useNativeDriver: false}),
      Animated.timing(ty, {toValue: 0, duration: 260, delay: 220, easing: Easing.out(Easing.cubic), useNativeDriver: false}),
    ]);
    a.start();
    return () => { a.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  if (show !== true) return null;
  const {icon: Glyph, tint} = TIP_ICONS[tipKey];
  return (
    <Animated.View testID={`coach-${tipKey}`} style={[S.coachCard, {opacity: op, transform: [{translateY: ty}]}]}>
      <View style={S.coachRow}>
        <View style={S.coachIcon}><Glyph size={15} color={C[tint]} /></View>
        <View style={S.coachText}>
          <Text style={S.coachTitle}>{tip.title}</Text>
          <Text style={S.coachBody}>{tip.body}</Text>
        </View>
        <Pressable
          testID={`btn-coach-${tipKey}-dismiss`}
          style={S.coachDismiss}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 4}}
          onPress={() => { setShow(false); void markSeen(tipKey); }}
          accessibilityRole="button"
          accessibilityLabel={M.education.coachDismiss(tip.title)}
          accessibilityHint={M.education.coachDismissHint}
          accessibilityState={{disabled: false}}>
          <IconClose size={14} color={C.sub2} />
        </Pressable>
      </View>
    </Animated.View>
  );
}
