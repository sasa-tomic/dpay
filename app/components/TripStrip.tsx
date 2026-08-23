// TripStrip — Trip Ready J5b home-surface presence (UX hardening 2026-08-23).
//
// WHY: the passport lived ONLY inside the Balances sheet + a Settings row — zero presence on the
// wallet home, so the whole arc was invisible until you went digging ("the new screens are hard
// to find"). The strip is the fix: ONE slim line between the header and the tabs that (a) shows
// live progress ("3 OF 4 · one payment to go"), (b) taps straight into the passport, and (c)
// RETIRES itself the moment readiness completes (capstone seen → collapse → gone forever — the
// passport archive in Settings remains the permanent home).
//
// DRY: it renders NO stamp definitions of its own — PASSPORT_STAMPS/computeReadiness
// (lib/readiness) are the single source; the collapse marker reuses PASSPORT_COLLAPSED_KEY.
// Reads journey via useJourney (fail-soft, checking = render nothing until loaded).
import React, {useEffect, useMemo, useRef} from 'react';
import {Animated, Pressable, Text, View} from 'react-native';
import {S} from '../styles';
import {useJourney, hasSeen} from '../lib/journey';
import {PASSPORT_STAMPS, PASSPORT_COLLAPSED_KEY, computeReadiness} from '../lib/readiness';
import {useReducedMotion} from '../hooks/useReducedMotion';

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
  // Retire: completed AND the user has seen the completion (the Balances capstone collapse marks
  // PASSPORT_COLLAPSED_KEY). Until then the strip keeps showing "TRIP READY" — honest, and it
  // disappears as soon as the passport's collapse fires.
  const retired = readiness.complete && hasSeen(journey, PASSPORT_COLLAPSED_KEY);
  if (!loaded || retired) return null;

  const next = readiness.next;
  return (
    <Animated.View style={{opacity: op}} testID="trip-strip">
      <Pressable
        testID="btn-trip-strip"
        style={S.tripStrip}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`Trip readiness ${readiness.filled.length} of 4`}
        accessibilityHint={next ? next.hint : 'Trip ready'}
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
        <Text style={S.tripStripText} numberOfLines={1}>
          {readiness.complete
            ? 'TRIP READY'
            : `${readiness.filled.length} OF 4 · ${next ? next.short : ''}`}
        </Text>
      </Pressable>
    </Animated.View>
  );
}
