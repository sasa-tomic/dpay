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
import {Modal, Platform, StatusBar, View} from 'react-native';
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
      {/* The Modal is its own Android window and does NOT inherit the root window's system-bar
          insets. SAME RULE as MainActivity's insets reservation (the main screen's sizing):
          API >= 35 enforces edge-to-edge, so the modal window starts at y=0 and needs the exact
          status-bar pad; on API <= 34 the legacy window model already reserves the bar space in
          the modal's own window — padding there double-counts and shows a white band (founder
          report, Poco X3 / API 31). Platform.Version is the device API level on Android. */}
      <View style={{flex: 1, paddingTop: Platform.OS === 'android' && Platform.Version >= 35 ? (StatusBar.currentHeight ?? 0) : 0}}>
        {children}
      </View>
    </Modal>
  );
}
