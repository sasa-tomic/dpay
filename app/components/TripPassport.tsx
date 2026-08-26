/**
 * TripPassport.tsx — the Trip Readiness archive (Trip Ready J5b, 2026-08-22).
 *
 * A PRIVATE capability credential rendered as a travel document page: four finite stamp
 * positions (backed up / saw the flow / funds loaded / first payment) on a porcelain
 * card with a fine rule and a mono count ("n OF 4"). Empty positions
 * are debossed dashes — a place not yet stamped; filled positions are inked rings with
 * the two-line caps label + the award date ('AUG 23'), each at its own slight rotation
 * so the set reads hand-stamped. There is NO checklist ✓, no counters beyond n/4, no
 * amounts, no streaks, nothing public.
 *
 * ONE surface (UX hardening round 4, 2026-08-23 founder review: the same 4 stamps were
 * rendered on THREE surfaces — home strip, a Balances card, and this archive — "widgets
 * that don't serve any purpose"). Now exactly two, each with one job:
 *   • TripStrip (home) — the LIVE one-line progress entry; taps open this archive.
 *   • THIS archive (the full-screen record, opened from the strip or Settings) — the
 *     permanent page AND the celebration surface: when the complete page is first
 *     observed, the TRIP READY capstone plays here, then Done retires the home strip
 *     forever (the `passportCollapsed` seen-marker). Before Done, the strip keeps
 *     inviting ("TRIP READY") — one tap leads to the record, Done closes the loop.
 *
 * The `tripReady` capstone stamp is awarded HERE, in the same effect that plays the
 * animation (idempotent — a session that mounts already-complete never replays the
 * moment; re-renders never replay rewards).
 *
 * testID contract (e2e flow 94): page `passport-archive`, slots `passport-slot-<key>` +
 * `passport-slot-<key>-filled`, progress `passport-count`, hint `passport-hint`, capstone
 * `trip-ready-capstone`, Done `btn-passport-done`, close `btn-passport-close`. Deep-link
 * (founder ask 2026-08-24): unfilled-slot buttons `passport-slot-btn-<key>` — present ONLY
 * when onStep is provided and the slot is UNFILLED (filled stamps stay inert).
 *
 * Reduced motion: the capstone renders at rest (no animated values) on the same auto-Done
 * timer — same information, none of the motion. The static page never animates on first
 * render (visual baselines capture immediately on open).
 */
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, Pressable, SafeAreaView, ScrollView, StatusBar, Text, View} from 'react-native';
import {C} from '../config/palette';
import {S, isDark} from '../styles';
import {M} from '../i18n';
import {JOURNEY_STAMPS, hasStamp, markSeen, useJourney} from '../lib/journey';
import {PASSPORT_STAMPS, PASSPORT_TITLE, PASSPORT_COLLAPSED_KEY, computeReadiness, type ReadinessKey} from '../lib/readiness';
import {useReducedMotion} from '../hooks/useReducedMotion';
import {IconArrowUpRight, IconClose} from './icons';

const EASE_OUT = Easing.out(Easing.cubic);
const EASE_PLATE = Easing.bezier(0.22, 1, 0.36, 1);
const CAPSTONE_MS = 2200;

/** Fixed per-slot rotations (deterministic — a stamped set never re-shuffles on re-render). */
const SLOT_TILT = [-4, 3, -2, 5] as const;

/** The archive's stamp date ('AUG 23') from the journey's wall-clock award time — a real passport
 *  page shows WHEN each stamp landed. The month names and the order live in the catalog, which is
 *  why this takes the parts rather than formatting them here. */
function stampDate(at: number): string {
  const d = new Date(at);
  return M.education.passport.stampDate(d.getMonth(), d.getDate());
}

export function PassportArchive({onClose, onNext, onStep}: {
  onClose: () => void;
  onNext?: () => void;
  /** Deep-link routing (founder ask 2026-08-24): tapping an UNFILLED stamp goes straight to
   *  the surface where that step is completed; the NEXT row routes through the same seam with
   *  the first-missing key. Filled stamps never fire it (nothing left to complete). */
  onStep?: (key: ReadinessKey) => void;
}) {
  const reduced = useReducedMotion();
  const {journey, award, loaded} = useJourney();
  const readiness = computeReadiness(journey);

  // Retired (home strip gone) once the tripReady stamp is held AND the user pressed Done
  // here once. Until then the strip keeps inviting — Done is the reliable close of the loop.
  const collapsed = hasStamp(journey, JOURNEY_STAMPS.tripReady) && journey.seen.includes(PASSPORT_COLLAPSED_KEY);
  const tripReadyStamped = hasStamp(journey, JOURNEY_STAMPS.tripReady);
  const [capstonePlaying, setCapstonePlaying] = useState(false);

  // ── The capstone: fire ONCE at first OBSERVATION of the complete page ─────────────────────
  // The 4th stamp is always awarded while this page is unmounted (payments happen on the
  // Pay/Receive screens), so "live" means: the first mount (or journey refresh — the live
  // seam pushes awards here) that sees all four stamps AND no persisted tripReady yet. The
  // persisted stamp + `celebratedRef` are the latch — re-renders, effect re-runs, remounts,
  // and fresh sessions can never replay the moment. The beat timer lives in a ref (NOT
  // effect cleanup): the award's optimistic state flip re-runs this effect immediately, and
  // the press must still run its full ~2.2s; only unmount clears it.
  const shouldCelebrate = readiness.complete && !tripReadyStamped;
  const celebratedRef = useRef(false);
  const capTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!loaded || !shouldCelebrate || celebratedRef.current) return;
    celebratedRef.current = true;
    award(JOURNEY_STAMPS.tripReady);
    setCapstonePlaying(true);
    capTimerRef.current = setTimeout(() => { setCapstonePlaying(false); }, reduced ? 200 : CAPSTONE_MS);
    // `award` is stable (useCallback []); `reduced` is captured at the beat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldCelebrate, loaded]);
  useEffect(() => () => { if (capTimerRef.current) clearTimeout(capTimerRef.current); }, []);

  // ── Capstone motion (UX hardening 2026-08-23: the ink moment) ────────────────────────────
  // One driver `capSeq` 0→1 over the beat; each of the four stamps inks in on its own SLICE of
  // the timeline (interpolated, clamped) — one animation, four staggered landings (DRY: no
  // per-stamp timers). The plate press/tilt lands the whole page at the end.
  const capOp = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const capScale = useRef(new Animated.Value(reduced ? 1 : 1.5)).current;
  const capTilt = useRef(new Animated.Value(reduced ? 1 : 0)).current; // 0→1 maps −2°→−7°
  const capSeq = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (!capstonePlaying || reduced) return;
    const press = Animated.parallel([
      Animated.timing(capOp, {toValue: 1, duration: 160, delay: 90, easing: EASE_OUT, useNativeDriver: false}),
      Animated.spring(capScale, {toValue: 1, friction: 5, tension: 64, delay: 110, useNativeDriver: false}),
      Animated.timing(capTilt, {toValue: 1, duration: 420, delay: 150, easing: EASE_PLATE, useNativeDriver: false}),
      Animated.timing(capSeq, {toValue: 1, duration: 1200, delay: 240, easing: EASE_OUT, useNativeDriver: false}),
    ]);
    press.start();
    return () => { press.stop(); };
    // The beat runs once per capstone (keyed on capstonePlaying, not renders).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capstonePlaying]);

  const onDone = () => {
    // Retire the home strip forever (the seen-marker is the durable truth; markSeen is
    // idempotent fire-and-forget) and close the archive — the loop is closed.
    void markSeen(PASSPORT_COLLAPSED_KEY);
    onClose();
  };

  const count = readiness.filled.length;
  // Done appears whenever the page is complete, not yet retired, and the capstone is not
  // pending/playing — either it just played, or a later session mounts already-latched
  // (the user never pressed Done; the strip keeps inviting until they do).
  const showDone = readiness.complete && !collapsed && !capstonePlaying;

  return (
    <SafeAreaView style={S.walkRoot}>
      <StatusBar barStyle={isDark() ? 'light-content' : 'dark-content'} backgroundColor={C.bg} translucent={false} />
      {/* Header — the app's standard sheet chrome (SettingsSheet grammar): title left, the
          44pt boxed close affordance top-right. */}
      <View style={S.sheetHead}>
        <Text style={S.sheetTitle}>{PASSPORT_TITLE}</Text>
        <Pressable
          testID="btn-passport-close"
          style={S.sheetClose}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={M.education.passport.close(PASSPORT_TITLE)}
          accessibilityState={{disabled: false}}>
          <IconClose size={18} color={C.sub} />
        </Pressable>
      </View>
      {/* The document scrolls (short screens must never clip the 2×2 grid / Done row);
          S.walkBody carries the same 22dp side margins as the sheet header above it. */}
      <ScrollView style={{flex: 1}} contentContainerStyle={S.walkBody}>
        {/* Hold render until the journey loads (no empty→filled flash mid-frame). */}
        {loaded ? (
          <View testID="passport-archive" style={S.passportCard}>
            {/* Document head: the n-of-4 count (mono caps, the only number) over the fine
                rule — the page title itself lives in the standard sheet header above. */}
            <View style={S.passportHead}>
              <Text testID="passport-count" style={S.walkEyebrow}>{M.education.passport.count(count)}</Text>
            </View>
            <View style={S.passportRule} />

            {/* The stamp page: 2×2. Filled = inked ring + label + award date at its own tilt;
                empty = debossed dashed slot + sub2 label (a place not yet stamped). */}
            <View style={S.passportGrid}>
              {PASSPORT_STAMPS.map((s, i) => {
                const filled = readiness.filled.includes(s.key);
                const tilt = {transform: [{rotate: `${SLOT_TILT[i % SLOT_TILT.length]}deg`}]};
                const slot = (
                  <View
                    testID={`passport-slot-${s.key}${filled ? '-filled' : ''}`}
                    style={filled ? S.passportSlotFilled : S.passportSlot}>
                    <Text style={filled ? [S.passportSlotTextFilled, tilt] : S.passportSlotText}>
                      {s.label}
                    </Text>
                    {filled && journey.at[s.key] ? (
                      <Text style={[S.passportSlotDate, tilt]}>{stampDate(journey.at[s.key])}</Text>
                    ) : null}
                  </View>
                );
                // Unfilled + routing available: the whole slot is tappable (the deep-link — tap
                // the missing capability, land where it happens). Filled slots stay inert and
                // the no-onStep fallback renders the bare slot exactly as before (back-compat;
                // slots are fixed 88×88 so the unstyled Pressable cannot shift the grid).
                if (filled || !onStep) return <View key={s.key}>{slot}</View>;
                return (
                  <Pressable
                    key={s.key}
                    testID={`passport-slot-btn-${s.key}`}
                    onPress={() => onStep(s.key)}
                    accessibilityRole="button"
                    accessibilityLabel={M.education.passport.goToStep(s.hint)}
                    accessibilityHint={M.education.passport.goToStepHint}
                    accessibilityState={{disabled: false}}>
                    {slot}
                  </Pressable>
                );
              })}
            </View>

            {/* Incomplete: ONE contextual next step (active voice). Complete: the durable TRIP
                READY mark + the promise line — the record, statically, forever. */}
            {readiness.complete ? (
              <View style={S.passportReadyWrap}>
                <View style={[S.stampChip, {marginTop: 2}]}>
                  <Text style={S.stampChipText}>{M.education.passport.ready}</Text>
                </View>
                <Text style={S.passportReadyLine}>{M.education.passport.readyLine}</Text>
              </View>
            ) : onNext || onStep ? (
              <Pressable
                testID="btn-passport-next"
                style={[S.ghostBtn, S.passportHint]}
                onPress={() => {
                  // NEXT = "go to the next step's surface": route through the step map when
                  // available; plain onNext otherwise (back-compat). `next` always exists in
                  // this branch (the row renders only while incomplete).
                  if (onStep && readiness.next) onStep(readiness.next.key);
                  else onNext?.();
                }}
                accessibilityRole="button"
                accessibilityLabel={M.education.passport.nextLabel(readiness.next?.hint ?? '')}
                accessibilityHint={M.education.passport.nextHint}
                accessibilityState={{disabled: false}}>
                <Text style={S.passportHintTag}>{M.education.passport.nextTag}</Text>
                <Text testID="passport-hint" style={S.passportHintText}>{readiness.next?.hint}</Text>
                <View style={S.passportHintArrow}><IconArrowUpRight size={14} color={C.sub2} /></View>
              </Pressable>
            ) : (
              <View style={S.passportHint}>
                <Text style={S.passportHintTag}>{M.education.passport.nextTag}</Text>
                <Text testID="passport-hint" style={S.passportHintText}>{readiness.next?.hint}</Text>
              </View>
            )}

            {/* Done (complete + not yet retired + capstone settled): retires the home strip
                forever and closes the archive — the reliable end of the readiness loop. */}
            {showDone ? (
              <Pressable
                testID="btn-passport-done"
                style={[S.ghostBtn, S.ghostBtnMuted]}
                onPress={onDone}
                accessibilityRole="button"
                accessibilityLabel={M.common.done}
                accessibilityHint={M.education.passport.doneHint}
                accessibilityState={{disabled: false}}>
                <Text style={S.ghostBtnText}>{M.common.done}</Text>
              </Pressable>
            ) : null}

            {/* The capstone overlay (live 4th-stamp transition only): the page INVERTS to ink
                for ~2.2s — the four stamps ink in sequence (one timeline, sliced), then the
                TRIP READY band lands — then it lifts to the durable mark + Done. */}
            {capstonePlaying ? (
              <Animated.View
                testID="trip-ready-capstone"
                style={[S.passportCapstoneInk, {
                  opacity: capOp,
                  transform: [
                    {scale: capScale},
                    {rotate: capTilt.interpolate({inputRange: [0, 1], outputRange: ['-2deg', '-7deg']})},
                  ],
                }]}
                pointerEvents="none">
                <View style={S.passportCapStamps}>
                  {PASSPORT_STAMPS.map((s, i) => {
                    // Slice i of 4 on the 0→1 capSeq timeline: each stamp lands ~300ms after the last.
                    const start = i * 0.22;
                    const op = capSeq.interpolate({inputRange: [start, Math.min(start + 0.16, 1)], outputRange: [0, 1], extrapolate: 'clamp'});
                    return (
                      <Animated.Text key={s.key} style={[S.passportCapStampText, {opacity: op}]}>
                        {s.label}
                      </Animated.Text>
                    );
                  })}
                </View>
                <Text style={S.passportCapstoneText}>{M.education.passport.capstone}</Text>
                <Text style={S.passportCapstoneMicro}>{M.education.passport.capstoneMicro}</Text>
              </Animated.View>
            ) : null}
          </View>
        ) : (
          <View style={S.passportCard} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
