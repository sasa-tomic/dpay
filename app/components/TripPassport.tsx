/**
 * TripPassport.tsx — the Trip Readiness passport (Trip Ready J5b, 2026-08-22).
 *
 * A PRIVATE capability credential rendered as a travel document page: four finite stamp
 * positions (recovery saved / flow understood / funds ready / payment tested) on a porcelain
 * card with a fine rule and a mono eyebrow ("TRIP READINESS · n OF 4"). Empty positions are
 * debossed dashes — a place not yet stamped; filled positions are inked rings with the
 * two-line caps label inside, each at its own slight rotation so the set reads hand-stamped.
 * There is NO checklist ✓, no counters beyond n/4, no amounts, no streaks, nothing public.
 *
 * Surfaces:
 *   • BalancesSheet card (`variant="card"`) — the live journey view. When the 4th stamp
 *     fills IN THIS SESSION, the capstone plays: a full-card TRIP READY stamp press (~1s,
 *     reduced-motion → instant), then Done (`btn-passport-done`) collapses the card forever
 *     (`passportCollapsed` seen-marker). Incomplete never collapses, but stays visually
 *     quiet — one compact card, ONE contextual next-step hint, no badges anywhere else.
 *   • SettingsSheet archive modal (`variant="archive"`) — the permanent read-only home:
 *     the same page statically (complete → the TRIP READY mark inked; incomplete → same
 *     view as Balances, helping re-find what's left).
 *
 * The `tripReady` capstone stamp is awarded HERE, in the same effect that plays the
 * animation (idempotent — a session that mounts already-complete never replays the moment;
 * re-renders never replay rewards).
 *
 * testID contract (e2e flow 94): card `trip-passport`, slots `passport-slot-<key>` +
 * `passport-slot-<key>-filled`, progress `passport-count`, hint `passport-hint`, capstone
 * `trip-ready-capstone`, Done `btn-passport-done`, archive card `passport-archive`.
 *
 * Reduced motion: the capstone renders at rest (no animated values) on the same auto-Done
 * timer — same information, none of the motion. The static card never animates on first
 * render (visual baselines capture Balances immediately on open).
 */
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, Pressable, SafeAreaView, StatusBar, Text, View} from 'react-native';
import {C} from '../config/palette';
import {S, isDark} from '../styles';
import {JOURNEY_STAMPS, hasStamp, markSeen, useJourney} from '../lib/journey';
import {PASSPORT_STAMPS, PASSPORT_TITLE, PASSPORT_COLLAPSED_KEY, computeReadiness} from '../lib/readiness';
import {useReducedMotion} from '../hooks/useReducedMotion';
import {IconClose} from './icons';

const EASE_OUT = Easing.out(Easing.cubic);
const EASE_PLATE = Easing.bezier(0.22, 1, 0.36, 1);
const CAPSTONE_MS = 2200;

/** Fixed per-slot rotations (deterministic — a stamped set never re-shuffles on re-render). */
const SLOT_TILT = [-4, 3, -2, 5] as const;

/** The archive's stamp date ('AUG 23') from the journey's wall-clock award time. Local, tiny,
 *  single-use — a real passport page shows WHEN each stamp landed. */
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function stampDate(at: number): string {
  const d = new Date(at);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export type TripPassportVariant = 'card' | 'archive';

export function TripPassport({variant = 'card', reducedMotion}: {variant?: TripPassportVariant; reducedMotion?: boolean}) {
  const hookReduced = useReducedMotion();
  const reduced = reducedMotion ?? hookReduced;
  const {journey, award, loaded} = useJourney();
  const readiness = computeReadiness(journey);

  // Collapse (card variant only): complete + Done ⇒ gone forever. The seen-marker is the
  // durable truth; the persisted `tripReady` stamp is the capstone's one-shot latch.
  const collapsed = hasStamp(journey, JOURNEY_STAMPS.tripReady) && journey.seen.includes(PASSPORT_COLLAPSED_KEY);
  const tripReadyStamped = hasStamp(journey, JOURNEY_STAMPS.tripReady);
  const [capstonePlaying, setCapstonePlaying] = useState(false);
  // Optimistic collapse of THIS card instance (Done pressed) — the persisted seen-marker
  // below is the durable truth across sessions.
  const [collapsedNow, setCollapsedNow] = useState(false);

  // ── The capstone: fire ONCE at first OBSERVATION of the complete page ─────────────────────
  // The 4th stamp is always awarded while this card is unmounted (payments happen on the
  // Pay/Receive screens), so "live" means: the first mount (or journey refresh) that sees
  // all four stamps AND no persisted tripReady yet. The persisted stamp + `celebratedRef`
  // are the latch — re-renders, effect re-runs, remounts, and fresh sessions can never
  // replay the moment. The beat timer lives in a ref (NOT effect cleanup): the award's
  // optimistic state flip re-runs this effect immediately, and the press must still run
  // its full ~1.4s; only unmount clears it.
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
    // Optimistic collapse (the local flip is immediate; the seen-marker is the durable
    // truth for future sessions — markSeen is idempotent fire-and-forget).
    setCollapsedNow(true);
    void markSeen(PASSPORT_COLLAPSED_KEY);
  };

  // Hold render until the journey loads (the card variant lives inside a sheet that mounts
  // fresh per open — no empty→filled flash mid-frame; a null placeholder keeps layout stable).
  if (variant === 'card' && (collapsed || collapsedNow)) return null;
  if (!loaded) return <View style={S.passportCard} />;

  const count = readiness.filled.length;
  const showCapstone = variant === 'card' && capstonePlaying;
  // Done appears once the page is complete AND the capstone is not pending/playing — either
  // it just played (capstoneDone) or this session mounted after it already had (latched).
  const showDone = variant === 'card' && readiness.complete && !collapsed && !shouldCelebrate && !capstonePlaying;

  return (
    <View testID={variant === 'archive' ? 'passport-archive' : 'trip-passport'} style={S.passportCard}>
      {/* Eyebrow row: the document title + the n-of-4 count (mono caps, the only number). */}
      <View style={S.passportHead}>
        <Text style={S.walkEyebrow}>{PASSPORT_TITLE.toUpperCase()}</Text>
        <Text testID="passport-count" style={S.walkEyebrow}>{count} OF 4</Text>
      </View>
      <View style={S.passportRule} />

      {/* The stamp page: 2×2. Filled = inked ring + label at its own tilt; empty = debossed
          dashed slot + sub2 label (a place not yet stamped). The ARCHIVE adds the award date
          under each inked stamp — the record-ness of a real passport page (card stays clean). */}
      <View style={S.passportGrid}>
        {PASSPORT_STAMPS.map((s, i) => {
          const filled = readiness.filled.includes(s.key);
          const tilt = {transform: [{rotate: `${SLOT_TILT[i % SLOT_TILT.length]}deg`}]};
          return (
            <View
              key={s.key}
              testID={`passport-slot-${s.key}${filled ? '-filled' : ''}`}
              style={filled ? S.passportSlotFilled : S.passportSlot}>
              <Text style={filled ? [S.passportSlotTextFilled, tilt] : S.passportSlotText}>
                {s.label}
              </Text>
              {filled && variant === 'archive' && journey.at[s.key] ? (
                <Text style={[S.passportSlotDate, tilt]}>{stampDate(journey.at[s.key])}</Text>
              ) : null}
            </View>
          );
        })}
      </View>

      {/* Incomplete: ONE contextual next step (active voice). Complete: the durable TRIP
          READY mark + the promise line — the archive shows this statically forever. */}
      {readiness.complete ? (
        <View style={S.passportReadyWrap}>
          <View style={[S.stampChip, {marginTop: 2}]}>
            <Text style={S.stampChipText}>Trip ready</Text>
          </View>
          <Text style={S.passportReadyLine}>You can pay even when your phone has no signal.</Text>
        </View>
      ) : (
        <View style={S.passportHint}>
          <Text style={S.passportHintTag}>Next</Text>
          <Text testID="passport-hint" style={S.passportHintText}>{readiness.next?.hint}</Text>
        </View>
      )}

      {/* Done (card variant, after the capstone): collapses the card forever. */}
      {showDone ? (
        <Pressable
          testID="btn-passport-done"
          style={[S.ghostBtn, S.ghostBtnMuted]}
          onPress={onDone}
          accessibilityRole="button"
          accessibilityLabel="Done"
          accessibilityHint="Collapse the trip readiness card"
          accessibilityState={{disabled: false}}>
          <Text style={S.ghostBtnText}>Done</Text>
        </Pressable>
      ) : null}

      {/* The capstone overlay (card variant, live 4th-stamp transition only): the card INVERTS
          to ink for ~2.2s — the four stamps ink in sequence (one timeline, sliced), then the
          TRIP READY band lands — then it lifts to the durable mark + Done. */}
      {showCapstone ? (
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
          <Text style={S.passportCapstoneText}>Trip{'\n'}Ready</Text>
          <Text style={S.passportCapstoneMicro}>Nothing left to set up. Go have the trip.</Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

/**
 * PassportArchive — the Modal shell for the Settings "Trip readiness" row. Mirrors the
 * How-it-works replay pattern (SafeAreaView walkRoot + top-left close). The archive is the
 * permanent home of the passport: read-only (no capstone, no Done), complete → the TRIP
 * READY mark statically. testID: `btn-passport-close`, content `passport-archive` (carried
 * by the TripPassport archive variant).
 */
export function PassportArchive({onClose}: {onClose: () => void}) {
  return (
    <SafeAreaView style={S.walkRoot}>
      <StatusBar barStyle={isDark() ? 'light-content' : 'dark-content'} backgroundColor={C.bg} translucent={false} />
      <View style={S.walkTop}>
        <Pressable
          testID="btn-passport-close"
          style={S.sheetClose}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={`Close ${PASSPORT_TITLE}`}
          accessibilityState={{disabled: false}}>
          <IconClose size={18} color={C.sub} />
        </Pressable>
      </View>
      <View style={S.walkBody}>
        <TripPassport variant="archive" />
      </View>
    </SafeAreaView>
  );
}

