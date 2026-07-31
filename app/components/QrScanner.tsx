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
    <View style={S.camBox}>
      {hasPermission && device ? (
        <Camera style={StyleSheet.absoluteFill} device={device} isActive={appActive} codeScanner={codeScanner} />
      ) : (
        <View style={S.camPlaceholder}>
          <Text style={S.dim2}>{hasPermission ? 'no camera' : 'camera permission needed'}</Text>
          {!hasPermission ? <Pressable style={S.smallBtn} onPress={requestPermission} accessibilityRole="button" accessibilityLabel="Grant camera permission" accessibilityState={{disabled: false}}><Text style={S.smallBtnText}>Grant camera</Text></Pressable> : null}
        </View>
      )}
    </View>
  );
}
