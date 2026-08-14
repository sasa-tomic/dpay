import {useEffect, useRef, useState} from 'react';
import {View, Text, Pressable, StyleSheet, AppState} from 'react-native';
import {Camera, useCameraDevice, useCameraPermission, useCodeScanner} from 'react-native-vision-camera';
import {S} from '../styles';

/** Reusable camera scanner (permission + focus-aware). Fires onScan once per mount. */
export function QrScanner({onScan}: {onScan: (v: string) => void}) {
  const {hasPermission, requestPermission} = useCameraPermission();
  const device = useCameraDevice('back');
  useEffect(() => { if (!hasPermission) requestPermission(); }, [hasPermission, requestPermission]);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => { const s = AppState.addEventListener('change', x => setAppActive(x === 'active')); return () => s.remove(); }, []);
  const fired = useRef(false);
  const codeScanner = useCodeScanner({codeTypes: ['qr'], onCodeScanned: codes => { const v = codes[0]?.value; if (v && !fired.current) { fired.current = true; onScan(v); } }});
  return (
    <View testID="scan-cam-box" style={S.camBox}>
      {hasPermission && device ? (
        <Camera style={StyleSheet.absoluteFill} device={device} isActive={appActive} codeScanner={codeScanner} />
      ) : (
        <View style={S.camPlaceholder}>
          {hasPermission ? (
            <Text style={S.dim2}>No camera found on this device.</Text>
          ) : (
            <>
              <Text style={S.reviewTo}>Point your camera at a payment code to pay</Text>
              <Text style={S.dim2}>dpay uses your camera only to scan codes — never records or uploads.</Text>
              <Pressable style={S.smallBtn} onPress={requestPermission} accessibilityRole="button" accessibilityLabel="Allow camera scan" accessibilityHint="Permission to use your camera so you can scan payment codes" accessibilityState={{disabled: false}}><Text style={S.smallBtnText}>Allow camera scan</Text></Pressable>
            </>
          )}
        </View>
      )}
    </View>
  );
}
