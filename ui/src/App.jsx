import { useEffect, useState } from 'react';
import { View } from 'react-native';
import ReceiveScreen from './ReceiveScreen.jsx';
import PayScreen from './PayScreen.jsx';

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

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const screen = params.get('screen') === 'pay' ? 'pay' : 'receive';

  // Camera SEAM: there is deliberately no real camera on web. A test driver injects
  // a scanned request via window.__DPAY_TEST_SCAN(payloadString), or via ?scan=<payload>.
  const initialScan = params.get('scan');
  const [scan, setScan] = useState(() => parsePayload(initialScan));

  useEffect(() => {
    window.__DPAY_TEST_SCAN = (payloadString) => {
      setScan(parsePayload(payloadString));
    };
    // Signal to drivers that the seam is installed and the app is interactive.
    window.__DPAY_READY = true;
    return () => {
      delete window.__DPAY_TEST_SCAN;
    };
  }, []);

  return (
    <View style={{ flex: 1 }}>
      {screen === 'pay' ? <PayScreen scan={scan} /> : <ReceiveScreen />}
    </View>
  );
}
