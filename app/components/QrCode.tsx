import {View, Text} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {C} from '../config/palette';

/**
 * QrCode — the ONE branded QR surface for every asset rail (IC + Solana, request / signed /
 * deposit / pairing codes). Wraps `react-native-qrcode-svg` with dpay's house style so Android
 * and the web wallet render the SAME code (the web shim in e2e/web/qrcode.tsx matches the
 * upstream butt-cap path byte-for-byte):
 *
 *   - crisp square modules, near-black ink on pure white (max scanner contrast)
 *   - a quiet zone built into the component (NOT just the card padding) so the code is valid
 *     wherever it is placed
 *   - a small centered brand mark (the dpay "∂" on a white rounded pad) — ~14% of the code,
 *     safely inside the error-correction budget at ecl M (and ≤ L's 7% for the dense wire code:
 *     14% side = ~2% area occlusion). Sizing/occlusion is PINNED by the e2e pixel-decode gate
 *     (flow qr-scannable rasterizes the rendered SVG and jsQR-decodes it) — if you touch the
 *     mark's size or the ecl here, that flow is the proof it still scans.
 *
 * `testID` lands on the outer wrapper (the anchor the e2e harness + campreview crop against).
 */
export function QrCode({value, size, ecl = 'M', testID}: {value: string; size: number; ecl?: 'L' | 'M' | 'Q' | 'H'; testID?: string}) {
  // Quiet zone: 4 modules is the QR spec minimum; ~7% of the rendered side reads generously
  // without shrinking the data area. The white plate behind it guarantees the zone even on
  // non-white parents (e.g. a future dark card).
  const quiet = Math.max(8, Math.round(size * 0.07));
  const plate = size + quiet * 2;
  const mark = Math.round(plate * 0.14);
  return (
    <View testID={testID} style={{width: plate, height: plate, backgroundColor: '#ffffff', borderRadius: 8, alignItems: 'center', justifyContent: 'center'}}>
      <QRCode value={value} size={size} ecl={ecl} color="#1B1A17" backgroundColor="#ffffff" />
      <View style={{position: 'absolute', width: mark, height: mark, borderRadius: mark * 0.28, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.line}}>
        <Text style={{fontSize: Math.round(mark * 0.62), fontWeight: '700', color: C.brand2, lineHeight: Math.round(mark * 0.72)}}>∂</Text>
      </View>
    </View>
  );
}
