import { View, Text, ActivityIndicator } from 'react-native';
import { C, FONT } from './theme.js';

// Live NFC-tap status. The `phase` mirrors the core state machine's lifecycle
// (dpay_core::nfc::SessionPhase, exposed over FFI as NfcPhase) plus two UI-only states the phase
// deliberately never claims: `listening` (idle + radio ready) and `error` (a caught protocol
// failure or a platform tag-loss). A dpay tap is single-frame and near-instant, so the honest
// "communicating" affordance is a spinner, not a filling progress bar.
//
// On device this is fed by reading the session phase during the tap; here the screenshot harness
// drives it via ?phase= / window.__DPAY_TEST_NFC_SESSION so every state is visually regression-tested.
const SPIN = new Set(['linking', 'exchanging', 'awaitingApproval']);

const MAP = {
  listening: { tone: C.brand, glyph: '⌁', title: 'Hold near the other phone', sub: 'dpay is listening for a tap' },
  linking: { tone: C.brand, title: 'Connecting…', sub: 'Linking the two phones' },
  exchanging: { tone: C.brand, title: 'Communicating…', sub: 'Keep the phones together' },
  awaitingApproval: { tone: C.brand, title: 'Waiting for approval…', sub: 'Confirm the amount on the other phone' },
  success: { tone: C.ok, glyph: '✓', title: 'Paid ✓', sub: 'The payment settled' },
  declined: { tone: C.sub, glyph: '✕', title: 'Declined', sub: 'The payer declined the payment' },
  error: { tone: C.bad, glyph: '!', title: 'Tap failed', sub: 'Move the phones together and try again' },
};

export default function NfcSession({ phase, reason }) {
  const m = MAP[phase] || MAP.listening;
  const spinning = SPIN.has(phase);
  const sub = phase === 'error' && reason ? reason : m.sub;

  return (
    <View style={S.screen}>
      <View style={S.header}>
        <Text style={S.brand}>dpay</Text>
        <Text style={S.role}>Tap to pay</Text>
      </View>

      <View style={S.body} testID={`nfc-session-${phase}`}>
        <View style={[S.badge, { borderColor: m.tone }]}>
          {spinning ? (
            <ActivityIndicator size="large" color={m.tone} />
          ) : (
            <Text style={[S.glyph, { color: m.tone }]}>{m.glyph}</Text>
          )}
        </View>
        <Text style={S.title}>{m.title}</Text>
        <Text style={S.sub}>{sub}</Text>
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
  body: { flex: 1, paddingHorizontal: 24, justifyContent: 'center', alignItems: 'center' },
  badge: {
    width: 108,
    height: 108,
    borderRadius: 54,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
  },
  glyph: { fontFamily: FONT, fontSize: 56, fontWeight: '700', lineHeight: 64 },
  title: { fontFamily: FONT, fontSize: 24, fontWeight: '700', color: C.ink, textAlign: 'center' },
  sub: { fontFamily: FONT, fontSize: 15, color: C.sub, marginTop: 10, textAlign: 'center' },
};
