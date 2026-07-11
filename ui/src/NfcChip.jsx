import { View, Text } from 'react-native';
import { C, FONT } from './theme.js';

// Truthful NFC radio-status chip. It reports the device's NFC *adapter* state only — on / off /
// absent — which is exactly "is NFC enabled". It does NOT claim the tap-to-pay transport works:
// that radio hop is wired and exercised on a physical device (the HCE glue), while QR remains the
// always-available path. On web there is no NFC adapter, so the status is injected via the seam in
// App (window.__DPAY_TEST_NFC / ?nfc=), which is also how the screenshot harness covers each state.
const MAP = {
  ready: { dot: C.ok, label: 'NFC on', testid: 'nfc-ready' },
  off: { dot: C.warn, label: 'NFC off', testid: 'nfc-off' },
  unsupported: { dot: C.sub, label: 'No NFC', testid: 'nfc-unsupported' },
};

export default function NfcChip({ status }) {
  const s = MAP[status];
  if (!s) return null; // 'unknown' / not-yet-checked → render nothing rather than a wrong claim
  return (
    <View testID={s.testid} style={ST.chip}>
      <View style={[ST.dot, { backgroundColor: s.dot }]} />
      <Text style={ST.label}>{s.label}</Text>
    </View>
  );
}

const ST = {
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    height: 26,
    borderRadius: 13,
    backgroundColor: C.field,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { fontFamily: FONT, fontSize: 13, fontWeight: '600', color: C.sub },
};
