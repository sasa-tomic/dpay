/**
 * dpay — offline-pay / online-confirm wallet (payer side).
 *
 * Flow: SCAN the merchant's request QR → review "Pay $X to <merchant>" → Approve → sign offline in
 * the shared Rust core (nonce = the merchant's request_id) → show a signed QR the merchant scans.
 *
 * Balance is the REAL ledger balance, polled from the relay when reachable (so it drops after the
 * merchant settles); when the relay is unreachable the wallet shows the last-known balance and marks
 * itself offline. Every money/protocol call goes through DpayCore → UniFFI → libdpay_ffi.so.
 *
 * Demo payer is a fixed pre-funded account (= account_a). A real build would generate a per-device
 * key + a funding flow. On a real phone, set the ledger URL below to the laptop's LAN address that
 * `just demo` prints (the 10.0.2.2 default only works from the Android emulator → host).
 */
import React, {useEffect, useRef, useState, useCallback} from 'react';
import {
  SafeAreaView, ScrollView, StatusBar, View, Text, Pressable, TextInput, StyleSheet, NativeModules, Share, AppState,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {Camera, useCameraDevice, useCameraPermission, useCodeScanner} from 'react-native-vision-camera';
import {RELAY_DEFAULT} from './relayConfig';

const {DpayCore} = NativeModules as {DpayCore: DpayCoreApi};

type Req = {toHex: string; amount: number; nonceHex: string; expiry: number};
type DpayCoreApi = {
  signAuthorization(secretHex: string, toHex: string, amount: number, nonceHex: string, expiry: number): Promise<string>;
  decodeRequest(qr: string): Promise<Req>;
  encodeQr(wireHex: string): Promise<string>;
  verifyWire(wireHex: string): Promise<boolean>;
  validate(amount: number, now: number, expiry: number, cap: number, balance: number, nonceSeen: boolean, sigOk: boolean): Promise<string | null>;
};

const C = {bg: '#ffffff', ink: '#0b0b0f', sub: '#6b7280', brand: '#4f46e5', brandInk: '#ffffff', ok: '#16a34a', bad: '#dc2626', line: '#e5e7eb', field: '#f3f4f6'};

const PAYER_SECRET_HEX = '01'.repeat(32);
const PAYER_PUBLIC_HEX = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';
const MERCHANT_HEX = '8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394';
const NAMES: {[hex: string]: string} = {[MERCHANT_HEX]: 'Café Demo'};
const CAP = 100000;
const EXPIRY = 4102444800;
const DIRECT_PAY_TIMEOUT_MS = 5000; // if the phone is online, submit directly but fall back to QR after this

const usd = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const nameOf = (h: string) => NAMES[h] || `${h.slice(0, 8)}…`;
const now = () => { const d = new Date(); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

type Txn = {nonce: string; amount: number; merchant: string; time: string};

export default function App() {
  const [err, setErr] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null); // last-known LEDGER balance
  const [online, setOnline] = useState(false);
  const [offlineSpent, setOfflineSpent] = useState(0); // cents the payer marked paid while offline
  const [relayUrl, setRelayUrl] = useState(RELAY_DEFAULT);
  const [history, setHistory] = useState<Txn[]>([]);

  // Poll the real ledger balance from the relay; success ⇒ online, failure ⇒ keep last-known + offline.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      // Fail fast so an unreachable ledger (e.g. Tailscale down) can't hang/pile up. This is purely
      // background — it never gates the camera/scanner, which are on-device and network-independent.
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch(`${relayUrl.replace(/\/$/, '')}/balance/${PAYER_PUBLIC_HEX}`, {signal: ctrl.signal});
        const j = await r.json();
        // Online → the ledger is authoritative: take its balance and clear the offline estimate.
        if (alive && r.ok && typeof j.balance === 'number') { setBalance(j.balance); setOnline(true); setOfflineSpent(0); }
        else if (alive) setOnline(false);
      } catch { if (alive) setOnline(false); } finally { clearTimeout(t); }
    };
    poll();
    const id = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [relayUrl]);

  // On-device self-check → logcat (proves the running app calls dpay-core, incl. the request path).
  useEffect(() => {
    (async () => {
      try {
        const nonce = '2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a';
        const wire = await DpayCore.signAuthorization(PAYER_SECRET_HEX, MERCHANT_HEX, 2500, nonce, EXPIRY);
        const verify = await DpayCore.verifyWire(wire);
        const expired = await DpayCore.validate(2500, 5000000000, EXPIRY, CAP, 10000, false, true);
        console.log(`DPAY_SELFCHECK ${verify && expired === 'expired' && wire.length === 384 ? 'PASS' : 'FAIL'} verify=${verify} expiredRule=${expired}`);
        const reqStr = 'gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5TECQAAAAAAADMzMzMzMzMzMzMzMzMzMzOA2NtwAAAAAA';
        const req = await DpayCore.decodeRequest(reqStr);
        const rw = await DpayCore.signAuthorization(PAYER_SECRET_HEX, req.toHex, req.amount, req.nonceHex, req.expiry);
        console.log(`DPAY_REQCHECK ${req.toHex === MERCHANT_HEX && req.amount === 2500 && (await DpayCore.verifyWire(rw)) ? 'PASS' : 'FAIL'} amount=${req.amount}`);
      } catch (e: any) { console.log(`DPAY_SELFCHECK FAIL ${String(e?.message ?? e)}`); }
    })();
  }, []);

  // Record a CONFIRMED settlement, deduped by request_id — so a duplicate/replayed submission (which
  // the ledger refuses to settle again) never adds a second row, and unconfirmed attempts add none.
  const recordSettlement = useCallback((nonce: string, amount: number, merchant: string) => {
    setHistory(h => (h.some(t => t.nonce === nonce) ? h : [{nonce, amount, merchant, time: now()}, ...h].slice(0, 8)));
  }, []);
  // The payer confirmed an OFFLINE payment locally → draw down the local balance until we can
  // reconcile with the ledger (which then becomes authoritative and clears this).
  const markOfflinePaid = useCallback((amount: number) => setOfflineSpent(s => s + amount), []);

  // What the wallet shows: the ledger balance when online, else the last-known minus offline spend.
  const shownBalance = balance == null ? null : online ? balance : Math.max(0, balance - offlineSpent);

  return (
    <SafeAreaView style={S.root}>
      <StatusBar barStyle="dark-content" backgroundColor={C.bg} />
      <View style={S.header}>
        <View>
          <Text style={S.brand}>dpay</Text>
          <Text style={S.who}>You · {PAYER_PUBLIC_HEX.slice(0, 8)}…</Text>
        </View>
        <View style={S.balBox}>
          <View style={S.balLabelRow}>
            <View style={[S.dot, {backgroundColor: online ? C.ok : '#9ca3af'}]} />
            <Text style={S.balLabel}>{online ? 'balance' : 'offline'}</Text>
          </View>
          <Text testID="balance" style={S.balAmt}>{shownBalance == null ? '—' : usd(shownBalance)}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        {err
          ? <View style={S.center}><Text testID="err" style={S.err}>{`error: ${err}`}</Text><Pressable style={S.linkBtn} onPress={() => setErr(null)}><Text style={S.linkText}>Back</Text></Pressable></View>
          : <PayFlow onError={setErr} onSettled={recordSettlement} onOfflinePaid={markOfflinePaid} online={online} relayUrl={relayUrl} />}
        {history.length > 0 ? (
          <View style={S.histCard}>
            <Text style={S.histTitle}>Recent</Text>
            {history.map((t, i) => (
              <View key={i} style={S.histRow}>
                <Text style={S.histMerchant}>{t.merchant}</Text>
                <Text style={S.histAmt}>{`−${usd(t.amount)}`}</Text>
                <Text style={S.histTime}>{t.time}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View style={S.settings}>
        <Text style={S.settingsLabel}>ledger</Text>
        <TextInput
          testID="relay-url"
          style={S.settingsInput}
          value={relayUrl}
          onChangeText={setRelayUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="http://<laptop-ip>:8787"
        />
      </View>
    </SafeAreaView>
  );
}

function PayFlow({onError, onSettled, onOfflinePaid, online, relayUrl}: {onError: (s: string) => void; onSettled: (nonce: string, amount: number, merchant: string) => void; onOfflinePaid: (amount: number) => void; online: boolean; relayUrl: string}) {
  const [phase, setPhase] = useState<'scan' | 'review' | 'qr' | 'paid'>('scan');
  const [req, setReq] = useState<Req | null>(null);
  const [qr, setQr] = useState<{code: string; amount: number; merchant: string; nonce: string} | null>(null);
  const [paid, setPaid] = useState<{amount: number; merchant: string; already: boolean} | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);

  const {hasPermission, requestPermission} = useCameraPermission();
  const device = useCameraDevice('back');
  useEffect(() => { if (!hasPermission) requestPermission(); }, [hasPermission, requestPermission]);

  // Tie the camera to app focus so it (re)starts when the app returns to the foreground — e.g. it
  // was launched while the phone was locked (Android blocks the camera then). Without this the
  // scanner can come up dead until the screen is re-navigated.
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);

  // In the QR fallback the phone didn't settle directly — confirm via the ledger so the payment
  // enters Recent exactly once, and only after the merchant actually settles it.
  useEffect(() => {
    if (phase !== 'qr' || !qr) return;
    let alive = true;
    const check = async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch(`${relayUrl.replace(/\/$/, '')}/receipt/${qr.nonce}`, {signal: ctrl.signal});
        if (alive && r.ok) { onSettled(qr.nonce, qr.amount, qr.merchant); setPaid({amount: qr.amount, merchant: qr.merchant, already: false}); setPhase('paid'); }
      } catch {} finally { clearTimeout(t); }
    };
    check();
    const id = setInterval(check, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [phase, qr, relayUrl, onSettled]);

  async function onRequestString(code: string) {
    if (handled.current) return;
    handled.current = true;
    try {
      const r = await DpayCore.decodeRequest(code.trim());
      setReq(r);
      setPhase('review');
    } catch (e: any) { handled.current = false; onError(`bad request QR: ${String(e?.message ?? e)}`); }
  }

  const codeScanner = useCodeScanner({codeTypes: ['qr'], onCodeScanned: codes => { const v = codes[0]?.value; if (v) onRequestString(v); }});

  async function approve() {
    if (!req) return;
    setBusy(true);
    try {
      const wireHex = await DpayCore.signAuthorization(PAYER_SECRET_HEX, req.toHex, req.amount, req.nonceHex, req.expiry);
      if (!(await DpayCore.verifyWire(wireHex))) throw new Error('local verify failed');
      const code = await DpayCore.encodeQr(wireHex);
      const merchant = nameOf(req.toHex);
      const nonce = req.nonceHex;
      // Online: submit straight to the ledger, capped at 5s. If it doesn't land (flaky link/timeout),
      // fall back to the QR "dance" — the merchant scans the code instead.
      if (online) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), DIRECT_PAY_TIMEOUT_MS);
        try {
          const r = await fetch(`${relayUrl.replace(/\/$/, '')}/pay`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({qr: code}), signal: ctrl.signal,
          });
          clearTimeout(timer);
          const j = await r.json().catch(() => ({} as any));
          if (r.ok) {
            // The ledger is authoritative: `replayed` means this request_id already settled (the
            // nonce is single-use). Record ONLY a fresh settlement — a replay must not add a row.
            if (!j.replayed) onSettled(nonce, req.amount, merchant);
            setPaid({amount: req.amount, merchant, already: !!j.replayed});
            setPhase('paid');
            return;
          }
          if (typeof j.error === 'string' && j.error.includes('NonceReused')) {
            setPaid({amount: req.amount, merchant, already: true}); // already settled → no new row
            setPhase('paid');
            return;
          }
          // any other rejection → let the payer show the QR instead
        } catch { /* timeout / network error → fall through to the QR */ }
        clearTimeout(timer);
      }
      setQr({code, amount: req.amount, merchant, nonce});
      setPhase('qr');
    } catch (e: any) { onError(String(e?.message ?? e)); } finally { setBusy(false); }
  }

  function reset() { handled.current = false; setReq(null); setQr(null); setPaid(null); setManual(''); setPhase('scan'); }

  if (phase === 'paid' && paid) {
    return (
      <View style={S.center}>
        <View style={[S.check, paid.already && S.checkAlready]}><Text style={S.checkMark}>{paid.already ? '↩' : '✓'}</Text></View>
        <Text style={[S.paidText, paid.already && S.alreadyText]}>{paid.already ? 'Already paid' : `Paid ✓ ${usd(paid.amount)}`}</Text>
        <Text style={S.paidSub}>{paid.already ? `${usd(paid.amount)} to ${paid.merchant} · not charged again` : `to ${paid.merchant}`}</Text>
        <Pressable testID="btn-new" style={S.linkBtn} onPress={reset}><Text style={S.linkText}>New payment</Text></Pressable>
      </View>
    );
  }

  if (phase === 'qr' && qr) {
    return (
      <View style={S.center}>
        <Text style={S.label}>Show this to the merchant</Text>
        <View style={S.qrCard}><QRCode value={qr.code} size={230} ecl="L" /></View>
        <Text style={S.amountBig}>{`${usd(qr.amount)} to ${qr.merchant}`}</Text>
        <Text style={S.badgeOk}>signed on this device ✓</Text>
        {online ? (
          <Text style={S.qrHint}>Waiting for the merchant to scan…</Text>
        ) : (
          <>
            <Text style={S.qrHint}>Offline — did the merchant confirm the payment?</Text>
            <View style={S.confirmRow}>
              <Pressable
                testID="btn-paid"
                style={S.paidBtn}
                onPress={() => { onSettled(qr.nonce, qr.amount, qr.merchant); onOfflinePaid(qr.amount); setPaid({amount: qr.amount, merchant: qr.merchant, already: false}); setPhase('paid'); }}>
                <Text style={S.paidBtnText}>Mark as paid</Text>
              </Pressable>
              <Pressable testID="btn-notpaid" style={S.notPaidBtn} onPress={reset}>
                <Text style={S.notPaidText}>Not paid</Text>
              </Pressable>
            </View>
          </>
        )}
        <Pressable testID="btn-share" style={S.linkBtn} onPress={() => Share.share({message: qr.code})}><Text style={S.linkText}>Share auth code</Text></Pressable>
      </View>
    );
  }

  if (phase === 'review' && req) {
    return (
      <View style={S.center}>
        <Text style={S.label}>Review payment</Text>
        <Text testID="pay-amount" style={S.reviewAmount}>{`Pay ${usd(req.amount)}`}</Text>
        <Text style={S.reviewTo}>{`to ${nameOf(req.toHex)} · ${req.toHex.slice(0, 8)}…`}</Text>
        <Text style={S.reviewReq}>{`request ${req.nonceHex.slice(0, 12)}…`}</Text>
        <Pressable testID="btn-approve" style={[S.primary, busy && S.dim]} disabled={busy} onPress={approve}>
          <Text style={S.primaryText}>{busy ? 'Signing…' : 'Approve'}</Text>
        </Pressable>
        <Pressable style={S.linkBtn} onPress={reset}><Text style={S.linkTextMuted}>Cancel</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={S.center}>
      <Text style={S.label}>Scan the merchant's request</Text>
      <View style={S.camBox}>
        {hasPermission && device ? (
          <Camera style={StyleSheet.absoluteFill} device={device} isActive={appActive} codeScanner={codeScanner} />
        ) : (
          <View style={S.camPlaceholder}>
            <Text style={S.dim2}>{hasPermission ? 'no camera' : 'camera permission needed'}</Text>
            {!hasPermission ? <Pressable style={S.smallBtn} onPress={requestPermission}><Text style={S.smallBtnText}>Grant camera</Text></Pressable> : null}
          </View>
        )}
      </View>
      <Text style={S.dim2}>Point at the merchant's QR</Text>
      <View style={S.manualRow}>
        <TextInput testID="manual-input" style={S.manualInput} value={manual} onChangeText={setManual} placeholder="…or paste the request code" autoCapitalize="none" autoCorrect={false} />
        <Pressable testID="btn-manual" style={S.smallBtn} onPress={() => manual.trim() && onRequestString(manual)}><Text style={S.smallBtnText}>Use</Text></Pressable>
      </View>
    </View>
  );
}

const S = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg},
  header: {paddingTop: 20, paddingHorizontal: 22, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottomWidth: 1, borderBottomColor: C.line},
  brand: {fontSize: 26, fontWeight: '800', color: C.brand},
  who: {fontSize: 12, color: C.sub, marginTop: 2},
  balBox: {alignItems: 'flex-end'},
  balLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 5},
  balLabel: {fontSize: 12, color: C.sub},
  dot: {width: 8, height: 8, borderRadius: 4},
  balAmt: {fontSize: 26, fontWeight: '800', color: C.ink},
  body: {flexGrow: 1, paddingHorizontal: 22, paddingTop: 16, justifyContent: 'center'},
  center: {alignItems: 'center'},
  label: {fontSize: 15, color: C.sub, marginBottom: 14, textAlign: 'center'},
  err: {color: C.bad, fontSize: 14, textAlign: 'center'},
  dim: {opacity: 0.6},
  dim2: {fontSize: 13, color: C.sub, marginTop: 10, textAlign: 'center'},
  camBox: {width: 250, height: 250, borderRadius: 20, overflow: 'hidden', backgroundColor: '#111827', borderWidth: 1, borderColor: C.line},
  camPlaceholder: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  reviewAmount: {fontSize: 30, fontWeight: '800', color: C.ink, textAlign: 'center'},
  reviewTo: {fontSize: 16, color: C.ink, marginTop: 6, textAlign: 'center'},
  reviewReq: {fontSize: 12, color: C.sub, fontFamily: 'monospace', marginTop: 6, marginBottom: 24},
  primary: {backgroundColor: C.brand, borderRadius: 14, height: 56, minWidth: 240, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center', marginTop: 8},
  primaryText: {color: C.brandInk, fontSize: 18, fontWeight: '600'},
  qrCard: {backgroundColor: '#fff', padding: 16, borderRadius: 18, borderWidth: 1, borderColor: C.line, marginBottom: 16},
  amountBig: {fontSize: 22, fontWeight: '800', color: C.ink, textAlign: 'center'},
  badgeOk: {marginTop: 10, fontSize: 13, fontWeight: '600', color: '#166534', backgroundColor: '#dcfce7', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, overflow: 'hidden'},
  qrHint: {marginTop: 16, fontSize: 13, color: C.sub, textAlign: 'center'},
  confirmRow: {flexDirection: 'row', gap: 12, marginTop: 12},
  paidBtn: {backgroundColor: C.ok, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 24},
  paidBtnText: {color: '#fff', fontWeight: '700', fontSize: 16},
  notPaidBtn: {backgroundColor: C.field, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 24},
  notPaidText: {color: C.sub, fontWeight: '600', fontSize: 16},
  check: {width: 92, height: 92, borderRadius: 46, backgroundColor: C.ok, alignItems: 'center', justifyContent: 'center', marginBottom: 18},
  checkAlready: {backgroundColor: '#b45309'},
  checkMark: {color: '#fff', fontSize: 50, fontWeight: '700'},
  paidText: {fontSize: 30, fontWeight: '800', color: C.ok},
  alreadyText: {color: '#b45309'},
  paidSub: {fontSize: 16, color: C.sub, marginTop: 6},
  linkBtn: {marginTop: 18},
  linkText: {color: C.brand, fontWeight: '600', fontSize: 16},
  linkTextMuted: {color: C.sub, fontWeight: '600', fontSize: 15},
  smallBtn: {backgroundColor: C.brand, borderRadius: 10, paddingHorizontal: 16, height: 44, alignItems: 'center', justifyContent: 'center'},
  smallBtnText: {color: C.brandInk, fontWeight: '600'},
  manualRow: {flexDirection: 'row', alignItems: 'center', marginTop: 18, alignSelf: 'stretch', gap: 8},
  manualInput: {flex: 1, backgroundColor: C.field, borderRadius: 10, paddingHorizontal: 12, height: 44, fontSize: 12, color: C.ink},
  histCard: {marginTop: 28, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 14},
  histTitle: {fontSize: 13, fontWeight: '700', color: C.sub, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6},
  histRow: {flexDirection: 'row', alignItems: 'baseline', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line},
  histMerchant: {flex: 1, fontSize: 15, color: C.ink},
  histAmt: {fontSize: 15, fontWeight: '700', color: C.ink, marginRight: 12},
  histTime: {fontSize: 12, color: C.sub, fontFamily: 'monospace'},
  settings: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 22, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.line},
  settingsLabel: {fontSize: 12, color: C.sub},
  settingsInput: {flex: 1, fontSize: 12, color: C.ink, fontFamily: 'monospace', paddingVertical: 4},
});
