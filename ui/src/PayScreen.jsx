import { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { C, FONT } from './theme.js';
import NfcChip from './NfcChip.jsx';

// Payer side of the two-scan flow. `scan` is the parsed request payload injected
// by the camera SEAM in App (window.__DPAY_TEST_SCAN / ?scan=). There is no real
// camera on web by design.
//   waiting -> (scan injected) review "Pay $X to <merchant>" -> Approve -> "Paid ✓ $X"
export default function PayScreen({ scan, nfc }) {
  const [paid, setPaid] = useState(false);

  const amount = scan && scan.amount ? String(scan.amount) : null;
  const payee = (scan && scan.to) || 'Café Demo';

  return (
    <View style={S.screen}>
      <View style={S.header}>
        <View>
          <Text style={S.brand}>dpay</Text>
          <Text style={S.role}>Pay</Text>
        </View>
        <NfcChip status={nfc} />
      </View>

      <View style={S.body}>
        {!scan ? (
          <View testID="pay-waiting" style={S.center}>
            <View style={S.scanFrame} />
            <Text style={S.waitText}>Scan to pay…</Text>
          </View>
        ) : paid ? (
          <View style={S.center}>
            <View style={S.checkCircle}>
              <Text style={S.checkMark}>✓</Text>
            </View>
            <Text testID="pay-paid" style={S.paidText}>{`Paid ✓ $${amount}`}</Text>
            <Text style={S.paidSub}>{`to ${payee}`}</Text>
          </View>
        ) : (
          <View style={S.center}>
            <Text style={S.reviewLabel}>Review payment</Text>
            <Text testID="pay-amount" style={S.reviewAmount}>
              {`Pay $${amount} to ${payee}`}
            </Text>
            <Pressable
              testID="btn-approve"
              style={S.primaryBtn}
              onPress={() => setPaid(true)}
            >
              <Text style={S.primaryBtnText}>Approve</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const S = {
  screen: { flex: 1, backgroundColor: C.bg, fontFamily: FONT },
  header: {
    paddingTop: 56,
    paddingHorizontal: 24,
    paddingBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  brand: { fontFamily: FONT, fontSize: 26, fontWeight: '700', color: C.brand },
  role: { fontFamily: FONT, fontSize: 15, color: C.sub, marginTop: 2 },
  body: { flex: 1, paddingHorizontal: 24, justifyContent: 'center' },
  center: { alignItems: 'center' },
  scanFrame: {
    width: 220,
    height: 220,
    borderRadius: 20,
    borderWidth: 3,
    borderColor: C.line,
    borderStyle: 'dashed',
    marginBottom: 24,
  },
  waitText: { fontFamily: FONT, fontSize: 18, color: C.sub },
  reviewLabel: { fontFamily: FONT, fontSize: 14, color: C.sub, marginBottom: 12 },
  reviewAmount: {
    fontFamily: FONT,
    fontSize: 26,
    fontWeight: '700',
    color: C.ink,
    textAlign: 'center',
    marginBottom: 36,
  },
  primaryBtn: {
    backgroundColor: C.brand,
    borderRadius: 14,
    height: 56,
    width: 260,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: { fontFamily: FONT, color: C.brandInk, fontSize: 18, fontWeight: '600' },
  checkCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: C.ok,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  checkMark: { fontFamily: FONT, color: '#ffffff', fontSize: 52, fontWeight: '700', lineHeight: 60 },
  paidText: { fontFamily: FONT, fontSize: 28, fontWeight: '700', color: C.ok },
  paidSub: { fontFamily: FONT, fontSize: 16, color: C.sub, marginTop: 6 },
};
