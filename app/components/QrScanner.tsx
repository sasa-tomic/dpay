import {useEffect, useRef, useState} from 'react';
import {View, Text, Pressable, StyleSheet, AppState} from 'react-native';
import {Camera, useCameraDevice, useCameraPermission, useCodeScanner} from 'react-native-vision-camera';
import {S} from '../styles';

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
          <Text style={S.dim2}>No camera found on this device.</Text>
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
          <Text style={S.reviewTo}>Point your camera at a payment code to pay</Text>
          <Text style={S.dim2}>dpay uses your camera only to scan codes — never records or uploads.</Text>
          <Pressable style={S.smallBtn} onPress={requestPermission} accessibilityRole="button" accessibilityLabel="Allow camera scan" accessibilityHint="Permission to use your camera so you can scan payment codes" accessibilityState={{disabled: false}}><Text style={S.smallBtnText}>Allow camera scan</Text></Pressable>
        </Pressable>
      )}
    </View>
  );
}
