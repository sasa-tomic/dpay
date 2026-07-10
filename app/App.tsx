/**
 * dpay — offline-pay / online-confirm, on a real phone.
 *
 * Two-scan flow (the robust, amount-bound one):
 *   1. The merchant shows a request QR {to, amount, request_id, expiry}.
 *   2. This app SCANS it, shows "Pay $X to <merchant>", and on Approve signs an Authorization that
 *      copies those fields (nonce = request_id) — offline, in the shared Rust core.
 *   3. The app shows a signed QR; the merchant scans it and settles.
 *
 * Every money/protocol call goes through the DpayCore native module → the UniFFI Kotlin binding →
 * libdpay_ffi.so, i.e. the exact dpay-core the canister/relay/sim/tests use. Demo payer is a fixed,
 * pre-funded account (= account_a); a production build would generate a per-device key + fund it.
 */
import React, {useEffect, useRef, useState} from 'react';
import {
  SafeAreaView,
  ScrollView,
  StatusBar,
  View,
  Text,
  Pressable,
  TextInput,
  StyleSheet,
  NativeModules,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';

const {DpayCore} = NativeModules as {DpayCore: DpayCoreApi};

type Req = {toHex: string; amount: number; nonceHex: string; expiry: number};
type DpayCoreApi = {
  signAuthorization(secretHex: string, toHex: string, amount: number, nonceHex: string, expiry: number): Promise<string>;
  decodeRequest(qr: string): Promise<Req>;
  encodeQr(wireHex: string): Promise<string>;
  verifyWire(wireHex: string): Promise<boolean>;
  validate(amount: number, now: number, expiry: number, cap: number, balance: number, nonceSeen: boolean, sigOk: boolean): Promise<string | null>;
};

const C = {bg: '#ffffff', ink: '#0b0b0f', sub: '#6b7280', brand: '#4f46e5', brandInk: '#ffffff', ok: '#16a34a', line: '#e5e7eb', field: '#f3f4f6'};

// Fixed demo payer = seed [1;32] = account_a ($100 opening). Merchant = seed [2;32] = account_b.
const PAYER_SECRET_HEX = '01'.repeat(32);
const PAYER_PUBLIC_HEX = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';
const MERCHANT_HEX = '8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394';
const CAP = 100000;
const EXPIRY = 4102444800;

const usd = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const merchantName = (toHex: string) => (toHex === MERCHANT_HEX ? 'Café Demo' : `${toHex.slice(0, 10)}…`);

export default function App() {
  const [err, setErr] = useState<string | null>(null);

  // On-device self-check → logcat marker (proves the running app calls dpay-core).
  useEffect(() => {
    (async () => {
      try {
        const nonce = '2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a';
        const wire = await DpayCore.signAuthorization(PAYER_SECRET_HEX, MERCHANT_HEX, 2500, nonce, EXPIRY);
        const verify = await DpayCore.verifyWire(wire);
        const expired = await DpayCore.validate(2500, 5000000000, EXPIRY, CAP, 10000, false, true);
        const pass = verify && expired === 'expired' && wire.length === 384;
        console.log(`DPAY_SELFCHECK ${pass ? 'PASS' : 'FAIL'} wireLen=${wire.length / 2} verify=${verify} expiredRule=${expired}`);

        // Exercise the full merchant-request path on-device: decode a real request → sign over it
        // (nonce = the merchant's request_id) → verify. Proves the scan→review→sign chain (the camera
        // only supplies this string). Request: to=merchant, $25.00, nonce=33…, expiry set.
        const reqStr = 'gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5TECQAAAAAAADMzMzMzMzMzMzMzMzMzMzOA2NtwAAAAAA';
        const req = await DpayCore.decodeRequest(reqStr);
        const rw = await DpayCore.signAuthorization(PAYER_SECRET_HEX, req.toHex, req.amount, req.nonceHex, req.expiry);
        const reqOk = req.toHex === MERCHANT_HEX && req.amount === 2500 && req.nonceHex === '33'.repeat(16) && (await DpayCore.verifyWire(rw));
        console.log(`DPAY_REQCHECK ${reqOk ? 'PASS' : 'FAIL'} to=${req.toHex.slice(0, 8)}… amount=${req.amount} nonce=${req.nonceHex.slice(0, 6)}…`);
      } catch (e: any) {
        console.log(`DPAY_SELFCHECK FAIL ${String(e?.message ?? e)}`);
      }
    })();
  }, []);

  return (
    <SafeAreaView style={S.root}>
      <StatusBar barStyle="dark-content" backgroundColor={C.bg} />
      <View style={S.header}>
        <Text style={S.brand}>dpay</Text>
        <Text style={S.role}>Pay</Text>
      </View>
      <ScrollView contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        {err ? <Text testID="err" style={S.err}>{`error: ${err}`}</Text> : <PayFlow onError={setErr} />}
      </ScrollView>
      <Text testID="acct" style={S.acct}>{`account ${PAYER_PUBLIC_HEX.slice(0, 10)}… · $100.00 · key by dpay-core`}</Text>
    </SafeAreaView>
  );
}

function PayFlow({onError}: {onError: (s: string) => void}) {
  const [phase, setPhase] = useState<'scan' | 'review' | 'qr'>('scan');
  const [req, setReq] = useState<Req | null>(null);
  const [qr, setQr] = useState<{code: string; amount: number} | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);

  const {hasPermission, requestPermission} = useCameraPermission();
  const device = useCameraDevice('back');
  useEffect(() => { if (!hasPermission) requestPermission(); }, [hasPermission, requestPermission]);

  async function onRequestString(code: string) {
    if (handled.current) return;
    handled.current = true;
    try {
      const r = await DpayCore.decodeRequest(code.trim());
      setReq(r);
      setPhase('review');
    } catch (e: any) {
      handled.current = false;
      onError(`bad request QR: ${String(e?.message ?? e)}`);
    }
  }

  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: codes => {
      const v = codes[0]?.value;
      if (v) onRequestString(v);
    },
  });

  async function approve() {
    if (!req) return;
    setBusy(true);
    try {
      const wireHex = await DpayCore.signAuthorization(PAYER_SECRET_HEX, req.toHex, req.amount, req.nonceHex, req.expiry);
      const verified = await DpayCore.verifyWire(wireHex);
      if (!verified) throw new Error('local verify failed');
      const code = await DpayCore.encodeQr(wireHex);
      setQr({code, amount: req.amount});
      setPhase('qr');
    } catch (e: any) {
      onError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    handled.current = false;
    setReq(null); setQr(null); setManual(''); setPhase('scan');
  }

  if (phase === 'qr' && qr) {
    return (
      <View style={S.center}>
        <Text style={S.label}>Show this to the merchant</Text>
        <View style={S.qrCard}><QRCode value={qr.code} size={250} ecl="L" /></View>
        <Text style={S.amountBig}>{usd(qr.amount)}</Text>
        <Text style={S.badgeOk}>signed offline ✓ — airplane mode OK</Text>
        <Pressable testID="btn-new" style={S.linkBtn} onPress={reset}><Text style={S.linkText}>New payment</Text></Pressable>
      </View>
    );
  }

  if (phase === 'review' && req) {
    return (
      <View style={S.center}>
        <Text style={S.label}>Review payment</Text>
        <Text testID="pay-amount" style={S.reviewAmount}>{`Pay ${usd(req.amount)} to ${merchantName(req.toHex)}`}</Text>
        <Pressable testID="btn-approve" style={[S.primary, busy && S.dim]} disabled={busy} onPress={approve}>
          <Text style={S.primaryText}>{busy ? 'Signing…' : 'Approve'}</Text>
        </Pressable>
        <Pressable style={S.linkBtn} onPress={reset}><Text style={S.linkTextMuted}>Cancel</Text></Pressable>
        <Text style={S.dim2}>Signs offline on this device.</Text>
      </View>
    );
  }

  // phase 'scan'
  return (
    <View style={S.center}>
      <Text style={S.label}>Scan the merchant's request</Text>
      <View style={S.camBox}>
        {hasPermission && device ? (
          <Camera style={StyleSheet.absoluteFill} device={device} isActive={true} codeScanner={codeScanner} />
        ) : (
          <View style={S.camPlaceholder}>
            <Text style={S.dim2}>{hasPermission ? 'no camera' : 'camera permission needed'}</Text>
            {!hasPermission ? (
              <Pressable style={S.smallBtn} onPress={requestPermission}><Text style={S.smallBtnText}>Grant camera</Text></Pressable>
            ) : null}
          </View>
        )}
      </View>
      <Text style={S.dim2}>Point at the merchant's QR</Text>
      <View style={S.manualRow}>
        <TextInput
          testID="manual-input"
          style={S.manualInput}
          value={manual}
          onChangeText={setManual}
          placeholder="…or paste the request code"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable testID="btn-manual" style={S.smallBtn} onPress={() => manual.trim() && onRequestString(manual)}>
          <Text style={S.smallBtnText}>Use</Text>
        </Pressable>
      </View>
    </View>
  );
}

const S = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg},
  header: {paddingTop: 24, paddingHorizontal: 24, paddingBottom: 12},
  brand: {fontSize: 28, fontWeight: '700', color: C.brand},
  role: {fontSize: 15, color: C.sub, marginTop: 2},
  body: {flexGrow: 1, paddingHorizontal: 24, paddingTop: 12, justifyContent: 'center'},
  center: {alignItems: 'center'},
  label: {fontSize: 15, color: C.sub, marginBottom: 16, textAlign: 'center'},
  err: {color: '#dc2626', fontSize: 14, textAlign: 'center'},
  dim2: {fontSize: 13, color: C.sub, marginTop: 10, textAlign: 'center'},
  camBox: {width: 260, height: 260, borderRadius: 20, overflow: 'hidden', backgroundColor: '#111827', borderWidth: 1, borderColor: C.line},
  camPlaceholder: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  reviewAmount: {fontSize: 24, fontWeight: '700', color: C.ink, textAlign: 'center', marginBottom: 28, marginTop: 8},
  primary: {backgroundColor: C.brand, borderRadius: 14, height: 56, minWidth: 240, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center', marginTop: 8},
  dim: {opacity: 0.6},
  primaryText: {color: C.brandInk, fontSize: 18, fontWeight: '600'},
  qrCard: {backgroundColor: '#fff', padding: 16, borderRadius: 18, borderWidth: 1, borderColor: C.line, marginBottom: 18},
  amountBig: {fontSize: 32, fontWeight: '800', color: C.ink},
  badgeOk: {marginTop: 12, fontSize: 14, fontWeight: '600', color: '#166534', backgroundColor: '#dcfce7', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, overflow: 'hidden'},
  linkBtn: {marginTop: 20},
  linkText: {color: C.brand, fontWeight: '600', fontSize: 16},
  linkTextMuted: {color: C.sub, fontWeight: '600', fontSize: 15},
  manualRow: {flexDirection: 'row', alignItems: 'center', marginTop: 18, alignSelf: 'stretch', gap: 8},
  manualInput: {flex: 1, backgroundColor: C.field, borderRadius: 10, paddingHorizontal: 12, height: 44, fontSize: 12, color: C.ink},
  smallBtn: {backgroundColor: C.brand, borderRadius: 10, paddingHorizontal: 16, height: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8},
  smallBtnText: {color: C.brandInk, fontWeight: '600'},
  acct: {textAlign: 'center', fontSize: 11, color: C.sub, paddingVertical: 8},
});
