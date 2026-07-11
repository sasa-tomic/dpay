import { useEffect, useState } from 'react';
import { View } from 'react-native';
import ReceiveScreen from './ReceiveScreen.jsx';
import PayScreen from './PayScreen.jsx';
import NfcSession from './NfcSession.jsx';

// Parse an opaque scan payload string into an object. The harness uses a small JSON
// sample like {"amount":"5.00","to":"Café Demo"}, but the string is treated as
// opaque: unparseable input still flips the payer into the "review" state.
function parsePayload(raw) {
  if (raw == null) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') return obj;
  } catch (_) {
    /* opaque / non-JSON payload */
  }
  return { amount: '5.00', to: 'Café Demo', raw: String(raw) };
}

// The NFC radio states the chip can show. On a real device this comes from the native NfcAdapter;
// on web it's injected (there is no adapter). 'ready' is the default so the common state is visible.
const NFC_STATES = ['ready', 'off', 'unsupported'];
function parseNfc(raw) {
  return NFC_STATES.includes(raw) ? raw : 'ready';
}

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const screenParam = params.get('screen');
  const screen = screenParam === 'pay' || screenParam === 'nfc' ? screenParam : 'receive';

  // Camera SEAM: there is deliberately no real camera on web. A test driver injects
  // a scanned request via window.__DPAY_TEST_SCAN(payloadString), or via ?scan=<payload>.
  const initialScan = params.get('scan');
  const [scan, setScan] = useState(() => parsePayload(initialScan));

  // NFC SEAM: there is no NFC adapter on web. A driver sets the radio status via
  // window.__DPAY_TEST_NFC('ready'|'off'|'unsupported'), or via ?nfc=<status>.
  const [nfc, setNfc] = useState(() => parseNfc(params.get('nfc')));

  // NFC SESSION SEAM: the live tap-lifecycle status (the phase the core state machine emits, plus
  // the UI-only 'listening'/'error' states). Driven via ?phase=&reason= or __DPAY_TEST_NFC_SESSION.
  const [session, setSession] = useState(() => ({
    phase: params.get('phase') || 'listening',
    reason: params.get('reason') || null,
  }));

  useEffect(() => {
    window.__DPAY_TEST_SCAN = (payloadString) => {
      setScan(parsePayload(payloadString));
    };
    window.__DPAY_TEST_NFC = (status) => {
      setNfc(parseNfc(status));
    };
    window.__DPAY_TEST_NFC_SESSION = (phase, reason) => {
      setSession({ phase, reason: reason || null });
    };
    // Signal to drivers that the seams are installed and the app is interactive.
    window.__DPAY_READY = true;
    return () => {
      delete window.__DPAY_TEST_SCAN;
      delete window.__DPAY_TEST_NFC;
      delete window.__DPAY_TEST_NFC_SESSION;
    };
  }, []);

  return (
    <View style={{ flex: 1 }}>
      {screen === 'nfc' ? (
        <NfcSession phase={session.phase} reason={session.reason} />
      ) : screen === 'pay' ? (
        <PayScreen scan={scan} nfc={nfc} />
      ) : (
        <ReceiveScreen nfc={nfc} />
      )}
    </View>
  );
}
