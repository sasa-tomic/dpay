/**
 * AppModal — the ONE platform-aware full-screen surface host (UX hardening 2026-08-23).
 *
 * Why it exists: react-native-web portals a RN <Modal> to a fixed FULL-VIEWPORT layer at the
 * document root, ESCAPING App.tsx's centered 480px app column (`screenFrame` → `root`) — on any
 * viewport wider than a phone, a hosted full-screen surface (the Settings "How dpay works"
 * replay, the Trip Readiness archive) rendered as a plain <Modal> spans the whole browser while
 * the app sits as a centered phone column ("screens show up outside the app screen" — founder
 * report, confirmed in e2e/shots/ux B03/B04).
 *
 * The fix is the house pattern, not a new one: on web the surface renders inside a
 * <SheetOverlay> — an absolutely-positioned layer WITHIN the app tree (the exact discipline
 * BalancesSheet/SettingsSheet already use, which is why they never escape). On native, RN
 * <Modal> stays the platform-correct host (full-screen slide + hardware-back via
 * onRequestClose). Callers keep the full-mount/unmount discipline: render <AppModal> only while
 * open (never visible=false + animate-out — RNW keeps hidden children alive when animationend
 * never fires, e.g. under the e2e harness's animation-freeze CSS).
 *
 * Escape handling stays with the CONTENT (e.g. Walkthrough's useEscapeToClose); the parent sheet
 * gates its own Esc handler while this surface is open (one Esc closes one thing).
 */
import React from 'react';
import {Modal, Platform} from 'react-native';
import {SheetOverlay} from './SheetOverlay';

export function AppModal({onRequestClose, children}: {
  /** Native only: Android hardware-back / the Modal's dismiss request. */
  onRequestClose: () => void;
  children: React.ReactNode;
}) {
  if (Platform.OS === 'web') {
    // Contained: absolute inset WITHIN the app column — can never escape the 480px frame.
    return <SheetOverlay>{children}</SheetOverlay>;
  }
  return (
    <Modal visible animationType="slide" onRequestClose={onRequestClose}>
      {children}
    </Modal>
  );
}
