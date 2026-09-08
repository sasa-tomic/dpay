import {useEffect, useRef, useState} from 'react';
import {View, Text, Pressable, StyleSheet, AppState} from 'react-native';
import {Camera, useCameraDevice, useCameraPermission, useCodeScanner} from 'react-native-vision-camera';
import {S} from '../styles';
import {M} from '../i18n';

/** Reusable camera scanner (permission + focus-aware). Fires onScan once per mount. */
export function QrScanner({onScan}: {onScan: (v: string) => void}) {
  const {hasPermission, requestPermission} = useCameraPermission();
  const device = useCameraDevice('back');
  // NO mount-effect permission request: the camera permission is asked for only on the explicit
  // scan intent (tapping the camera box / the "Allow camera scan" button below). Auto-requesting
  // on mount made every fresh wallet-open fire a getUserMedia/vision-camera permission prompt the
  // user never asked for (web-prod: the onboarding tap still satisfies the gesture heuristic, so
  // the prompt appeared on first open; native: the OS dialog on every fresh install).
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
          <Pressable testID="btn-allow-camera" style={S.smallBtn} onPress={requestPermission} accessibilityRole="button" accessibilityLabel={M.pay.allowCameraScan} accessibilityHint={M.pay.allowCameraScanHint} accessibilityState={{disabled: false}}><Text style={S.smallBtnText}>{M.pay.allowCameraScan}</Text></Pressable>
        </Pressable>
      )}
    </View>
  );
}
