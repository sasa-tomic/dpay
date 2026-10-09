import {useEffect, useRef, useState} from 'react';
import {View, Text, Pressable, StyleSheet, AppState} from 'react-native';
import {Camera, useCameraDevice, useCameraPermission, useCodeScanner} from 'react-native-vision-camera';
import {S} from '../styles';
import {M} from '../i18n';

/** The viewfinder's corner brackets - the ONE scan-instrument mark, shared by the idle Pay
 *  instrument (PayMode) and the live camera box (below). Absolute geometry against the camBox;
 *  theme-invariant aqua on the theme-invariant warm-black fill (contrast-gated). Overlaying the
 *  LIVE camera too is deliberate: the box reads as one instrument through permission, camera and
 *  rail - idle, armed, IC and SOL are the same mark (the uniform-surfaces rule). */
export function ViewfinderBrackets() {
  return (
    <>
      <View pointerEvents="none" style={[S.viewfinderCorner, S.viewfinderCornerTL]} />
      <View pointerEvents="none" style={[S.viewfinderCorner, S.viewfinderCornerTR]} />
      <View pointerEvents="none" style={[S.viewfinderCorner, S.viewfinderCornerBL]} />
      <View pointerEvents="none" style={[S.viewfinderCorner, S.viewfinderCornerBR]} />
    </>
  );
}

/** Reusable camera scanner (permission + focus-aware). Fires onScan once per mount. */
export function QrScanner({onScan}: {onScan: (v: string) => void}) {
  const {hasPermission, requestPermission} = useCameraPermission();
  const device = useCameraDevice('back');
  // The mount IS the scan intent now (founder 2026-10-09: the pay tab opens scanning), so this
  // component ASKS for the camera on mount instead of deferring to a tap: native fires the OS
  // dialog on the first pay-tab open (never again once granted), and a tab reached by a tap
  // satisfies the web gesture heuristic. The tap fallback (below) stays for a denial: the button
  // is the re-ask, and the one gesture some browsers insist on. askedRef latches: one ask per
  // mount, the button owns every retry.
  const askedRef = useRef(false);
  useEffect(() => {
    if (hasPermission || askedRef.current) return;
    askedRef.current = true;
    void requestPermission();
  }, [hasPermission, requestPermission]);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const s = AppState.addEventListener('change', x => {
      const active = x === 'active';
      setAppActive(active);
      // Suspend can kill the native camera session while isActive never dipped (JS frozen,
      // event delivered only at thaw) or a false->true toggle alone doesn't restart it on some
      // OEMs. Remounting the Camera on every resume re-creates the native session for sure.
      if (active) setEpoch(e => e + 1);
    });
    return () => s.remove();
  }, []);
  const fired = useRef(false);
  const codeScanner = useCodeScanner({codeTypes: ['qr'], onCodeScanned: codes => { const v = codes[0]?.value; if (v && !fired.current) { fired.current = true; onScan(v); } }});
  return (
    <View testID="scan-cam-box" style={S.camBox}>
      {hasPermission && device ? (
        <Camera key={epoch} style={StyleSheet.absoluteFill} device={device} isActive={appActive} codeScanner={codeScanner} />
      ) : hasPermission ? (
        <View style={S.camPlaceholder}>
          <Text style={S.camSubText}>{M.pay.noCameraFound}</Text>
        </View>
      ) : (
        // The WHOLE camera box is the tap target while permission is absent (defer-to-intent:
        // nothing asks for the camera until the user taps here). Deliberately NOT a
        // role="button": the real "Allow camera scan" button inside keeps the button semantics
        // for a11y, and RNW would otherwise render a nested <button> (invalid HTML + hydration
        // error). A web tap on the inner button bubbles to this wrapper — both call the same
        // requestPermission, deduped by the shim's in-flight stream promise; on native the
        // deepest touchable (the button) wins. S.camPlaceholder keeps flex:1 so the box layout
        // is unchanged.
        <Pressable style={S.camPlaceholder} onPress={requestPermission}>
          {/* X17 — on-camera-box inks, never the porcelain page's `sub` tokens (which measured
              3.0:1 here). See `S.camText`/`S.camSubText`. */}
          <Text style={S.camText}>{M.pay.pointCamera}</Text>
          <Text style={S.camSubText}>{M.pay.cameraPrivacy}</Text>
          {/* The permission gesture is a GATE a test has to pass through, so it gets a stable
              testID like every other gate in the app: `e2e/web-scan-smoke.mjs` had to address it
              by its localised aria-label, which is exactly the coupling Tab.tsx refuses for the
              same reason — the selector renames itself the moment a locale lands. */}
          <Pressable testID="btn-allow-camera" style={S.smallBtn} onPress={requestPermission} accessibilityRole="button" accessibilityLabel={M.pay.allowCameraScan} accessibilityState={{disabled: false}}><Text style={S.smallBtnText}>{M.pay.allowCameraScan}</Text></Pressable>
        </Pressable>
      )}
      {/* LAST child: the brackets must paint OVER the absoluteFill camera feed. */}
      <ViewfinderBrackets />
    </View>
  );
}
