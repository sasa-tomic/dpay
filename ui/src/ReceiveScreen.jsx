import { useState } from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { C, FONT } from './theme.js';
import QrBox from './QrBox.jsx';

// Merchant side of the two-scan flow:
//   enter a $ amount -> Request -> show a request-QR for the payer to scan.
export default function ReceiveScreen() {
  const [amount, setAmount] = useState('5.00');
  const [requested, setRequested] = useState(false);

  return (
    <View style={S.screen}>
      <View style={S.header}>
        <Text style={S.brand}>dpay</Text>
        <Text style={S.role}>Receive</Text>
      </View>

      <View style={S.body}>
        <Text style={S.label}>Amount to charge</Text>
        <View style={S.amountRow}>
          <Text style={S.currency}>$</Text>
          <TextInput
            testID="amount-input"
            style={S.amountInput}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder="0.00"
          />
        </View>

        {!requested ? (
          <Pressable
            testID="btn-request"
            style={S.primaryBtn}
            onPress={() => setRequested(true)}
          >
            <Text style={S.primaryBtnText}>Request</Text>
          </Pressable>
        ) : (
          <View style={S.qrWrap}>
            <QrBox testID="request-qr" seed={`req|${amount}|Café Demo`} />
            <Text style={S.caption}>Show this to the payer</Text>
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
  },
  brand: { fontFamily: FONT, fontSize: 26, fontWeight: '700', color: C.brand },
  role: { fontFamily: FONT, fontSize: 15, color: C.sub, marginTop: 2 },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 28, alignItems: 'stretch' },
  label: { fontFamily: FONT, fontSize: 14, color: C.sub, marginBottom: 8 },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.field,
    borderRadius: 14,
    paddingHorizontal: 18,
    height: 72,
  },
  currency: { fontFamily: FONT, fontSize: 34, fontWeight: '700', color: C.ink },
  amountInput: {
    fontFamily: FONT,
    flex: 1,
    fontSize: 34,
    fontWeight: '700',
    color: C.ink,
    marginLeft: 6,
    paddingVertical: 0,
    outlineStyle: 'none',
  },
  primaryBtn: {
    marginTop: 28,
    backgroundColor: C.brand,
    borderRadius: 14,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: { fontFamily: FONT, color: C.brandInk, fontSize: 18, fontWeight: '600' },
  qrWrap: { marginTop: 32, alignItems: 'center' },
  caption: { fontFamily: FONT, marginTop: 16, fontSize: 15, color: C.sub },
};
