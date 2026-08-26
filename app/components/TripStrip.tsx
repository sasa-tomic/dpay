// TripStrip — Trip Ready J5b home-surface presence (UX hardening 2026-08-23).
//
// WHY: the passport lived ONLY inside the Balances sheet + a Settings row — zero presence on the
// wallet home, so the whole arc was invisible until you went digging ("the new screens are hard
// to find"). The strip is the fix: ONE slim line between the header and the tabs that (a) shows
// live progress ("3 OF 4 · one payment to go"), (b) taps straight into the passport, and (c)
// RETIRES itself the moment readiness completes (founder rule 2026-08-23: "when fully done, the
// bar disappears" — the passport archive in Settings remains the permanent home).
//
// DRY: it renders NO stamp definitions of its own — PASSPORT_STAMPS/computeReadiness
// (lib/readiness) are the single source.
// Reads journey via useJourney (fail-soft, checking = render nothing until loaded).
import React, {useEffect, useMemo, useRef} from 'react';
import {Animated, Pressable, Text, View} from 'react-native';
import {S} from '../styles';
import {M} from '../i18n';
import {C} from '../config/palette';
import {useJourney} from '../lib/journey';
import {PASSPORT_STAMPS, computeReadiness} from '../lib/readiness';
import {useReducedMotion} from '../hooks/useReducedMotion';
import {IconArrowUpRight} from './icons';

const TILT = [-4, 3, -2, 5];

export function TripStrip({onOpen}: {onOpen: () => void}) {
  const {journey, loaded} = useJourney();
  const reducedMotion = useReducedMotion();
  const op = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  useEffect(() => {
    if (!loaded || reducedMotion) return;
    Animated.timing(op, {toValue: 1, duration: 260, useNativeDriver: false}).start();
  }, [loaded, reducedMotion, op]);

  const readiness = useMemo(() => computeReadiness(journey), [journey]);
  // Retire the moment readiness is complete (founder rule 2026-08-23: "when fully done, the
  // bar disappears") — the passport capstone + Done already archive it in Settings; keeping the
  // strip alive until that marker was read just made the finished row linger.
  const retired = readiness.complete;
  if (!loaded || retired) return null;

  const next = readiness.next;
  return (
    <Animated.View style={{opacity: op}} testID="trip-strip">
      <Pressable
        testID="btn-trip-strip"
        style={S.tripStrip}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={M.education.passport.stripLabel(readiness.filled.length)}
        accessibilityHint={next ? next.hint : M.education.passport.ready}
        accessibilityState={{disabled: false}}>
        <View style={S.tripStripDots}>
          {PASSPORT_STAMPS.map((s, i) => {
            const filled = readiness.filled.includes(s.key);
            return (
              <View
                key={s.key}
                testID={`trip-strip-dot-${s.key}${filled ? '-filled' : ''}`}
                style={[
                  S.tripStripDot,
                  filled ? S.tripStripDotFilled : null,
                  filled ? {transform: [{rotate: `${TILT[i]}deg`}],} : null,
                ]}
              />
            );
          })}
        </View>
        {/* UX round 4: the dots already encode n-of-4 — the phrase alone is warmer and shorter
            (was "3 OF 4 · one payment to go": the count twice in one slim line). */}
        <Text style={S.tripStripText} numberOfLines={1}>
          {next ? next.short.toUpperCase() : ''}
        </Text>
        {/* UX 2026-08-23: a trailing arrow reads "opens a page" — the strip was discoverable but
            its affordance was invisible (a label with dots, no chevron). Points up: it opens a
            sheet over the wallet. */}
        <View style={S.tripStripArrow}><IconArrowUpRight size={14} color={C.sub} /></View>
      </Pressable>
    </Animated.View>
  );
}
