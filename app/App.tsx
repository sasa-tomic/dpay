/**
 * dpay — peer-to-peer wallet. Each phone has its OWN on-device key (generated once, persisted) and a
 * username. Two modes:
 *   • Pay     — scan someone's request QR → "Pay $X to <name>" → Approve → sign offline in the Rust
 *               core; if online, submit directly; else show a signed QR for the receiver to scan.
 *   • Receive — enter an amount → show a request QR (carries your account + name); the payer scans
 *               it; you either see it settle (payer paid directly) or scan the payer's signed QR.
 *
 * Money/protocol calls go through DpayCore → UniFFI → libdpay_ffi.so (the shared dpay-core). The
 * request QR is `<base64url request>|<username>`: the request is the signed, money-critical payload;
 * the username is unsigned display metadata (the account is the source of truth).
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  SafeAreaView, ScrollView, StatusBar, View, Text, Pressable, TextInput, StyleSheet, NativeModules,
  Share, AppState, ActivityIndicator, NativeEventEmitter,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {Camera, useCameraDevice, useCameraPermission, useCodeScanner} from 'react-native-vision-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {RELAY_DEFAULT} from './relayConfig';
import {
  classifyPayHttp, receiptCodeFor, decidePayerReceipt, rejectionMessage, isNonceReused,
  type SettleOutcome,
} from './payments';

const {DpayCore, DpayNfc} = NativeModules as {DpayCore: DpayCoreApi; DpayNfc: DpayNfcApi};

// NFC tap transport (see android/com/dpay/DpayNfc*). Pay mode = HCE card (payer is tapped);
// Receive mode = reader (merchant reads the tap). Lifecycle arrives as `DpayNfcEvent`s.
type DpayNfcApi = {
  armCard(): Promise<void>;
  disarmCard(): Promise<void>;
  approveCard(wireHex: string): Promise<void>;
  declineCard(): Promise<void>;
  buildRequest(toHex: string, amount: number, nonceHex: string, expiry: number): Promise<string>;
  startReader(requestHex: string): Promise<void>;
  stopReader(): Promise<void>;
  // Merchant: after settling online, hand the outcome back to the payer. `status` is the receipt
  // code (0 settled, 1 rejected, 2 unreachable); `nonceHex` is the authoritative payment nonce so
  // the payer can confirm the receipt answers the exact payment it signed.
  confirmReceipt(status: number, nonceHex: string): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

type NfcEvent =
  | {type: 'phase'; role: 'card' | 'reader'; phase: NfcPhaseName}
  | {type: 'request'; role: 'card'; toHex: string; amount: number; nonceHex: string; expiry: number}
  | {type: 'done'; role: 'reader'; wireHex: string}
  | {type: 'receipt'; role: 'card'; settled: boolean; status: number; nonceHex: string}
  | {type: 'confirmed'; role: 'reader'}
  | {type: 'error'; role: 'card' | 'reader'; reason: string};

type NfcPhaseName = 'listening' | 'linking' | 'exchanging' | 'awaitingApproval' | 'settling' | 'success' | 'declined' | 'pending';

type Req = {toHex: string; amount: number; nonceHex: string; expiry: number};
type Identity = {secretHex: string; publicHex: string; username: string};
type Txn = {nonce: string; amount: number; who: string; time: string; dir: 'out' | 'in'};
type DpayCoreApi = {
  generateKeypair(): Promise<{secretHex: string; publicHex: string}>;
  signAuthorization(secretHex: string, toHex: string, amount: number, nonceHex: string, expiry: number): Promise<string>;
  encodeRequest(toHex: string, amount: number, nonceHex: string, expiry: number): Promise<string>;
  decodeRequest(qr: string): Promise<Req>;
  encodeQr(wireHex: string): Promise<string>;
  verifyWire(wireHex: string): Promise<boolean>;
  // Device NFC radio state for the status chip: 'ready' | 'off' | 'unsupported' | 'unknown'.
  // Optional so an app built before the native method exists degrades to 'unknown' (chip hidden).
  nfcStatus?(): Promise<string>;
};

type NfcStatus = 'ready' | 'off' | 'unsupported' | 'unknown';

const C = {bg: '#ffffff', ink: '#0b0b0f', sub: '#6b7280', brand: '#4f46e5', brandInk: '#ffffff', ok: '#16a34a', bad: '#dc2626', warn: '#b45309', line: '#e5e7eb', field: '#f3f4f6'};
const EXPIRY_WINDOW = 600; // request valid 10 min
const DIRECT_PAY_TIMEOUT_MS = 5000;
// Merchant NFC settlement: bound the /pay call, then reconcile the ambiguous case via the
// idempotent /receipt/:nonce so a settled payment is never reported as failed.
const NFC_PAY_TIMEOUT_MS = 8000;
const RECONCILE_ATTEMPTS = 4;
const RECONCILE_INTERVAL_MS = 1200;
// Payer NFC: how long to wait for the merchant's receipt before falling back to a truthful
// "couldn't confirm" (never a false success or a false failure). Must exceed the merchant's worst
// case (pay timeout + reconciliation) so a slow-but-successful settle still delivers its receipt.
const RECEIPT_WAIT_MS = 20000;
const STORAGE_KEY = 'dpay.identity.v1';

const usd = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const short = (h: string) => `${h.slice(0, 8)}…`;
const clock = () => { const d = new Date(); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
const nowSecs = () => Math.floor(Date.now() / 1000);
function randNonceHex(): string {
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return s;
}
function toCents(s: string): number { const n = Math.round(parseFloat(s || '0') * 100); return Number.isFinite(n) && n > 0 ? n : 0; }
const base = (u: string) => u.replace(/\/$/, '');
// request QR = "<base64url request>|<username>"; base64url has no '|', so split on the first one.
function parseRequestQR(raw: string): {reqB64: string; name: string} {
  const t = raw.trim(); const i = t.indexOf('|');
  return i < 0 ? {reqB64: t, name: ''} : {reqB64: t.slice(0, i), name: t.slice(i + 1)};
}

export default function App() {
  const [identity, setIdentity] = useState<Identity | null | undefined>(undefined); // undefined = loading
  const [relayUrl, setRelayUrl] = useState(RELAY_DEFAULT);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then(v => setIdentity(v ? JSON.parse(v) : null))
      .catch(() => setIdentity(null));
  }, []);

  // On-device self-check → logcat (proves the running app calls dpay-core), independent of identity.
  useEffect(() => {
    (async () => {
      try {
        const kp = await DpayCore.generateKeypair();
        const wire = await DpayCore.signAuthorization(kp.secretHex, kp.publicHex, 1, randNonceHex(), 4102444800);
        console.log(`DPAY_SELFCHECK ${(await DpayCore.verifyWire(wire)) && wire.length === 384 ? 'PASS' : 'FAIL'}`);
      } catch (e: any) { console.log(`DPAY_SELFCHECK FAIL ${String(e?.message ?? e)}`); }
    })();
  }, []);

  const onReset = useCallback(async () => { await AsyncStorage.removeItem(STORAGE_KEY); setIdentity(null); }, []);

  if (identity === undefined) {
    return <SafeAreaView style={[S.root, S.centerAll]}><ActivityIndicator color={C.brand} /></SafeAreaView>;
  }
  if (identity === null) {
    return <Onboarding relayUrl={relayUrl} onCreated={setIdentity} />;
  }
  return <Wallet identity={identity} relayUrl={relayUrl} setRelayUrl={setRelayUrl} onReset={onReset} />;
}

function Onboarding({relayUrl, onCreated}: {relayUrl: string; onCreated: (id: Identity) => void}) {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    const name = username.trim() || 'me';
    setBusy(true); setErr(null);
    try {
      const kp = await DpayCore.generateKeypair();
      const id: Identity = {secretHex: kp.secretHex, publicHex: kp.publicHex, username: name};
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(id));
      // Fund the new account from the demo faucet (best-effort — works when the ledger is reachable).
      try {
        await fetch(`${base(relayUrl)}/api/v1/faucet`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({account: id.publicHex})});
      } catch { /* offline: created with $0, can be funded later */ }
      onCreated(id);
    } catch (e: any) { setErr(String(e?.message ?? e)); setBusy(false); }
  }

  return (
    <SafeAreaView style={S.root}>
      <StatusBar barStyle="dark-content" backgroundColor={C.bg} />
      <View style={S.onboard}>
        <Text style={S.brandBig}>dpay</Text>
        <Text style={S.onboardSub}>Create your wallet</Text>
        <Text style={S.label}>Choose a username</Text>
        <TextInput style={S.usernameInput} value={username} onChangeText={setUsername} placeholder="e.g. Alice" autoCapitalize="words" autoCorrect={false} />
        {err ? <Text style={S.err}>{err}</Text> : null}
        <Pressable testID="btn-create" style={[S.primary, busy && S.dim]} disabled={busy} onPress={create}>
          <Text style={S.primaryText}>{busy ? 'Creating…' : 'Create & fund wallet'}</Text>
        </Pressable>
        <Text style={S.dim2}>Generates a key on this device and funds it with $100 to start.</Text>
      </View>
    </SafeAreaView>
  );
}

function Wallet({identity, relayUrl, setRelayUrl, onReset}: {identity: Identity; relayUrl: string; setRelayUrl: (s: string) => void; onReset: () => void}) {
  const [mode, setMode] = useState<'pay' | 'receive'>('pay');
  const [balance, setBalance] = useState<number | null>(null);
  const [online, setOnline] = useState(false);
  const [offlineSpent, setOfflineSpent] = useState(0);
  const [history, setHistory] = useState<Txn[]>([]);
  const [nfc, setNfc] = useState<NfcStatus>('unknown');

  // Read the device NFC radio state once (re-checked when the app returns to the foreground, since
  // the user may toggle NFC in system settings). Purely informational for the status chip; failure
  // or a missing native method leaves it 'unknown' and the chip hidden.
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const s = (await DpayCore.nfcStatus?.()) as NfcStatus | undefined;
        if (alive) setNfc(s ?? 'unknown');
      } catch { if (alive) setNfc('unknown'); }
    };
    read();
    const sub = AppState.addEventListener('change', x => { if (x === 'active') read(); });
    return () => { alive = false; sub.remove(); };
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch(`${base(relayUrl)}/api/v1/balance/${identity.publicHex}`, {signal: ctrl.signal});
        const j = await r.json();
        if (alive && r.ok && typeof j.balance === 'number') { setBalance(j.balance); setOnline(true); setOfflineSpent(0); }
        else if (alive) setOnline(false);
      } catch { if (alive) setOnline(false); } finally { clearTimeout(t); }
    };
    poll(); const id = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [relayUrl, identity.publicHex]);

  const record = useCallback((t: Txn) => setHistory(h => (h.some(x => x.nonce === t.nonce) ? h : [t, ...h].slice(0, 10))), []);
  const markOfflinePaid = useCallback((amount: number) => setOfflineSpent(s => s + amount), []);
  const shownBalance = balance == null ? null : online ? balance : Math.max(0, balance - offlineSpent);

  return (
    <SafeAreaView style={S.root}>
      <StatusBar barStyle="dark-content" backgroundColor={C.bg} />
      <View style={S.header}>
        <View>
          <Text style={S.brand}>dpay</Text>
          <Text style={S.who}>{identity.username} · {short(identity.publicHex)}</Text>
          <NfcPill status={nfc} />
        </View>
        <View style={S.balBox}>
          <View style={S.balLabelRow}><View style={[S.dot, {backgroundColor: online ? C.ok : '#9ca3af'}]} /><Text style={S.balLabel}>{online ? 'balance' : 'offline'}</Text></View>
          <Text testID="balance" style={S.balAmt}>{shownBalance == null ? '—' : usd(shownBalance)}</Text>
        </View>
      </View>

      <View style={S.tabs}>
        <Tab label="Pay" active={mode === 'pay'} onPress={() => setMode('pay')} />
        <Tab label="Receive" active={mode === 'receive'} onPress={() => setMode('receive')} />
      </View>

      <ScrollView contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        {mode === 'pay'
          ? <PayMode identity={identity} online={online} relayUrl={relayUrl} nfcReady={nfc === 'ready'} onSettled={record} onOfflinePaid={markOfflinePaid} />
          : <ReceiveMode identity={identity} relayUrl={relayUrl} nfcReady={nfc === 'ready'} onReceived={record} />}
        {history.length > 0 ? (
          <View style={S.histCard}>
            <Text style={S.histTitle}>Recent</Text>
            {history.map((t, i) => (
              <View key={i} style={S.histRow}>
                <Text style={S.histWho}>{t.dir === 'out' ? `to ${t.who || '—'}` : `from ${t.who || '—'}`}</Text>
                <Text style={[S.histAmt, {color: t.dir === 'out' ? C.ink : C.ok}]}>{`${t.dir === 'out' ? '−' : '+'}${usd(t.amount)}`}</Text>
                <Text style={S.histTime}>{t.time}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View style={S.settings}>
        <Text style={S.settingsLabel}>ledger</Text>
        <TextInput style={S.settingsInput} value={relayUrl} onChangeText={setRelayUrl} autoCapitalize="none" autoCorrect={false} placeholder="http://<ip>:8787" />
        <Pressable onPress={onReset}><Text style={S.resetLink}>reset</Text></Pressable>
      </View>
    </SafeAreaView>
  );
}

function Tab({label, active, onPress}: {label: string; active: boolean; onPress: () => void}) {
  return (
    <Pressable onPress={onPress} style={[S.tab, active && S.tabActive]} testID={`tab-${label.toLowerCase()}`}>
      <Text style={[S.tabText, active && S.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

// Truthful NFC radio-status chip. Reports the device adapter state only (on / off / absent) — the
// tap-to-pay HCE transport is a separate, device-gated feature and QR always works. 'unknown'
// (probe failed or the native method is absent) renders nothing rather than a misleading claim.
const NFC_PILL: Record<NfcStatus, {dot: string; label: string} | null> = {
  ready: {dot: C.ok, label: 'NFC on'},
  off: {dot: C.warn, label: 'NFC off'},
  unsupported: {dot: '#9ca3af', label: 'No NFC'},
  unknown: null,
};

function NfcPill({status}: {status: NfcStatus}) {
  const s = NFC_PILL[status];
  if (!s) return null;
  return (
    <View style={S.nfcPill} testID={`nfc-${status}`}>
      <View style={[S.dot, {backgroundColor: s.dot}]} />
      <Text style={S.nfcLabel}>{s.label}</Text>
    </View>
  );
}

/** Reusable camera scanner (permission + focus-aware). Fires onScan once per mount. */
function QrScanner({onScan}: {onScan: (v: string) => void}) {
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
          {!hasPermission ? <Pressable style={S.smallBtn} onPress={requestPermission}><Text style={S.smallBtnText}>Grant camera</Text></Pressable> : null}
        </View>
      )}
    </View>
  );
}

// Phase → status-view presentation (mirrors ui/src/NfcSession.jsx). `spin` renders a spinner.
const NFC_UI: Record<string, {tone: string; glyph?: string; spin?: boolean; title: string; sub: string}> = {
  listening: {tone: C.brand, glyph: '⌁', title: 'Hold near the other phone', sub: 'dpay is listening for a tap'},
  linking: {tone: C.brand, spin: true, title: 'Connecting…', sub: 'Linking the two phones'},
  exchanging: {tone: C.brand, spin: true, title: 'Communicating…', sub: 'Keep the phones together'},
  awaitingApproval: {tone: C.brand, spin: true, title: 'Authorizing…', sub: 'Signing on the payer’s phone'},
  settling: {tone: C.brand, spin: true, title: 'Confirming…', sub: 'Keep the phones together while the merchant settles'},
  success: {tone: C.ok, glyph: '✓', title: 'Done ✓', sub: ''},
  declined: {tone: C.sub, glyph: '✕', title: 'Declined', sub: 'The payment was declined'},
  // Genuinely-unknown outcome (couldn't reach the ledger / no receipt in time). Truthful, distinct
  // from both success and failure — the balance reconciles when back online.
  pending: {tone: C.warn, glyph: '?', title: 'Not confirmed', sub: 'Couldn’t reach the ledger'},
  error: {tone: C.bad, glyph: '!', title: 'Tap failed', sub: 'Move the phones together and try again'},
};

/**
 * Drives one NFC tap through the native glue (DpayNfc): Pay mode arms the HCE card (payer is tapped),
 * Receive mode runs the reader (merchant reads the tap). The **tap itself is the consent** — when a
 * request arrives the payer's phone signs and serves it immediately (contactless tap-to-pay, no
 * extra Approve button). It renders the live phase the core emits and, on the merchant side, submits
 * the reassembled wire and hands the receipt back. The radio hop is a physical-device gate.
 */
function NfcTap({role, identity, relayUrl, requestHex, reqInfo, onSettled, onOfflinePaid, onActive, onClose}: {
  role: 'card' | 'reader';
  identity: Identity;
  relayUrl: string;
  requestHex?: string;
  reqInfo?: {amount: number; nonce: string; who: string};
  onSettled?: (t: Txn) => void;
  onOfflinePaid?: (amount: number) => void;
  onActive?: () => void; // fired the moment a real tap starts (so the parent can hide the QR/scanner)
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<NfcPhaseName | 'error'>('listening');
  const [reason, setReason] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState<number | null>(null);
  const sentRef = useRef<{amount: number; who: string; nonce: string} | null>(null);
  const finalized = useRef(false);
  const recordedRef = useRef(false);
  const activeRef = useRef(false);
  // Set once the authorization is in flight to settlement (merchant: the wire is submitting; payer:
  // the wire has left the phone). After this point the ledger outcome is decided elsewhere (the
  // /pay result, or the receipt / its timeout), so a *transport* error — e.g. the phones parting
  // during the receipt hand-back — must NOT be shown as a payment failure. This is the guard that
  // stops a settled payment from being reported as "Tap failed".
  const committed = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // False once the tap view is torn down (user hit Cancel/Done). An in-flight submit/sign promise
  // that resolves after that must not touch state — it would warn and, worse, could flip a screen
  // the user already left.
  const aliveRef = useRef(true);
  // Keep onActive in a ref so markActive has a stable identity (the effect must not re-subscribe /
  // re-arm on every parent render just because an inline callback changed).
  const onActiveRef = useRef(onActive);
  onActiveRef.current = onActive;
  const markActive = useCallback(() => {
    if (!activeRef.current) { activeRef.current = true; onActiveRef.current?.(); }
  }, []);

  const clearSettleTimer = useCallback(() => {
    if (settleTimer.current) { clearTimeout(settleTimer.current); settleTimer.current = null; }
  }, []);

  const finalize = useCallback((p: NfcPhaseName | 'error', r?: string) => {
    if (finalized.current || !aliveRef.current) return; // first terminal wins; ignore after teardown
    finalized.current = true;
    clearSettleTimer();
    setReason(r ?? null);
    setPhase(p);
  }, [clearSettleTimer]);

  const record = useCallback((amount: number, who: string, dir: 'out' | 'in', nonce: string) => {
    if (recordedRef.current || !onSettled) return;
    recordedRef.current = true;
    onSettled({nonce, amount, who, time: clock(), dir});
  }, [onSettled]);

  // POST /pay once, bounded by a timeout. Returns the (ok,status) + parsed body, or a null result
  // when fetch threw (network/timeout/abort) — which the caller treats as UNKNOWN, not failure.
  const postPay = useCallback(async (code: string) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), NFC_PAY_TIMEOUT_MS);
    try {
      const r = await fetch(`${base(relayUrl)}/api/v1/pay`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({qr: code}), signal: ctrl.signal});
      const body = await r.json().catch(() => ({} as any));
      return {res: {ok: r.ok, status: r.status}, body};
    } catch {
      return {res: null as {ok: boolean; status: number} | null, body: {} as any};
    } finally { clearTimeout(t); }
  }, [relayUrl]);

  // Reconcile an ambiguous outcome via the idempotent GET /receipt/:nonce. Returns the settled
  // receipt (or null if not settled after a few polls). Safe by construction: the nonce is
  // single-use, so this can never cause a second charge — it only *reads* whether it landed.
  const reconcile = useCallback(async (nonceHex: string) => {
    for (let i = 0; i < RECONCILE_ATTEMPTS; i++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      try {
        const r = await fetch(`${base(relayUrl)}/api/v1/receipt/${nonceHex}`, {signal: ctrl.signal});
        if (r.ok) { const j = await r.json().catch(() => ({} as any)); clearTimeout(t); return j.receipt ?? {}; }
      } catch { /* keep polling */ } finally { clearTimeout(t); }
      await new Promise(res => setTimeout(res, RECONCILE_INTERVAL_MS));
    }
    return null;
  }, [relayUrl]);

  // Merchant side: submit the reassembled wire, decide the authoritative outcome, then hand it back
  // to the payer over the same tap. The ledger is the source of truth; an ambiguous transport/HTTP
  // result is reconciled by nonce before we ever call a payment failed.
  const submitWire = useCallback(async (wireHex: string) => {
    const nonceHex = reqInfo?.nonce ?? null;
    const code = await DpayCore.encodeQr(wireHex).catch(() => null);
    if (!code) { finalize('error', 'Could not encode the authorization'); return; } // pre-settlement

    const {res, body} = await postPay(code);
    let outcome: SettleOutcome = classifyPayHttp(res);
    let settledNonceHex: string | null = nonceHex;

    if (outcome === 'settled') {
      settledNonceHex = body?.receipt?.nonce ?? nonceHex;
    } else if (outcome === 'rejected') {
      // "Nonce reused" is not a real refusal — it means this exact payment already settled.
      // Reconcile to the real receipt instead of showing a scary (and false) decline.
      if (isNonceReused(body?.error) && nonceHex) {
        const rec = await reconcile(nonceHex);
        if (rec) { outcome = 'settled'; settledNonceHex = rec.nonce ?? nonceHex; }
      }
    } else if (nonceHex) {
      // UNKNOWN (network drop / timeout / 5xx): the ledger MAY have committed. Reconcile before
      // deciding — this is the fix for "settled but reported as failed".
      const rec = await reconcile(nonceHex);
      if (rec) { outcome = 'settled'; settledNonceHex = rec.nonce ?? nonceHex; }
    }

    if (outcome === 'settled') {
      if (reqInfo) record(reqInfo.amount, reqInfo.who, 'in', reqInfo.nonce);
      finalize('success');
    } else if (outcome === 'rejected') {
      finalize('declined', rejectionMessage(typeof body?.error === 'string' ? body.error : null));
    } else {
      // Genuinely unknown even after reconciliation — truthful, never a fake success or failure.
      finalize('pending', 'Couldn’t confirm with the ledger — check the balance');
    }
    // Best-effort: hand the outcome back to the payer, stamped with the authoritative nonce.
    try { await DpayNfc.confirmReceipt(receiptCodeFor(outcome), settledNonceHex ?? nonceHex ?? ''); } catch {}
  }, [relayUrl, reqInfo, record, finalize, postPay, reconcile]);

  // Payer side: the tap is the consent — sign the incoming request and serve it right away.
  const autoSign = useCallback(async (req: {toHex: string; amount: number; nonceHex: string; expiry: number}) => {
    try {
      const wireHex = await DpayCore.signAuthorization(identity.secretHex, req.toHex, req.amount, req.nonceHex, req.expiry);
      if (!(await DpayCore.verifyWire(wireHex))) throw new Error('local verify failed');
      sentRef.current = {amount: req.amount, who: short(req.toHex), nonce: req.nonceHex};
      setPayAmount(req.amount);
      await DpayNfc.approveCard(wireHex);
    } catch (e: any) { finalize('error', String(e?.message ?? e)); }
  }, [identity, finalize]);

  useEffect(() => {
    const emitter = new NativeEventEmitter(DpayNfc as any);
    const sub = emitter.addListener('DpayNfcEvent', (e: NfcEvent) => {
      if (e.role !== role) return;
      if (e.type === 'error') {
        markActive();
        // Once the payment is in flight to settlement, a transport error says nothing about whether
        // the ledger settled — the outcome is owned by submitWire / the receipt path. Don't let it
        // overwrite a decided (or about-to-be-decided) outcome with a false failure.
        if (finalized.current || committed.current) return;
        finalize('error', e.reason);
        return;
      }
      if (finalized.current) return; // terminal reached; ignore late phase/confirmed events
      if (e.type === 'request') { markActive(); setPhase('exchanging'); autoSign({toHex: e.toHex, amount: e.amount, nonceHex: e.nonceHex, expiry: e.expiry}); }
      else if (e.type === 'done') { markActive(); committed.current = true; submitWire(e.wireHex); }
      else if (e.type === 'receipt') {
        // The payer's outcome, learned offline over the tap — believed only if it answers the exact
        // payment we signed (nonce match). UNREACHABLE ⇒ pending (unknown), never a false decline.
        const outcome = decidePayerReceipt({status: e.status, nonceHex: e.nonceHex}, sentRef.current?.nonce ?? '');
        if (outcome === 'ignore') return; // a receipt for some other payment — keep waiting
        if (outcome === 'success') {
          const s = sentRef.current;
          if (s) { record(s.amount, s.who, 'out', s.nonce); onOfflinePaid?.(s.amount); }
          finalize('success');
        } else if (outcome === 'declined') {
          finalize('declined', 'The ledger declined the payment');
        } else {
          finalize('pending', 'Couldn’t confirm — check your balance when back online');
        }
      } else if (e.type === 'phase') {
        if (e.phase !== 'listening') markActive();
        // The payer's wire has left the phone: from here the outcome depends on the receipt. Arm a
        // timeout so we never spin on "Confirming…" forever if the receipt never arrives.
        if (role === 'card' && e.phase === 'settling') {
          committed.current = true;
          if (!settleTimer.current) {
            settleTimer.current = setTimeout(() => {
              finalize('pending', 'Couldn’t confirm — check your balance when back online');
            }, RECEIPT_WAIT_MS);
          }
        }
        setPhase(e.phase);
      }
      // 'confirmed' (reader): the receipt reached the payer; the merchant already finalized on submit.
    });
    if (role === 'card') DpayNfc.armCard().catch((e: any) => finalize('error', String(e?.message ?? e)));
    else if (requestHex) DpayNfc.startReader(requestHex).catch((e: any) => finalize('error', String(e?.message ?? e)));
    return () => {
      aliveRef.current = false;
      clearSettleTimer();
      sub.remove();
      if (role === 'card') DpayNfc.disarmCard().catch(() => {});
      else DpayNfc.stopReader().catch(() => {});
    };
  }, [role, requestHex, submitWire, autoSign, finalize, markActive, clearSettleTimer, onOfflinePaid, record]);

  // While merely armed/listening (no tap yet) render nothing, so the parent's QR/scanner shows and
  // the phone can be tapped OR scanned with no mode switch.
  if (phase === 'listening' && !activeRef.current) return null;

  const m = NFC_UI[phase] ?? NFC_UI.listening;
  const terminal = phase === 'success' || phase === 'declined' || phase === 'error' || phase === 'pending';
  const amt = role === 'card' ? payAmount : reqInfo?.amount;
  const active = phase === 'exchanging' || phase === 'settling' || phase === 'awaitingApproval';
  const title = phase === 'success'
    ? `${role === 'card' ? 'Paid' : 'Received'} ✓ ${amt != null ? usd(amt) : ''}`.trim()
    : m.title;
  const sub = (phase === 'error' || phase === 'declined' || phase === 'pending') && reason ? reason
    : phase === 'success' ? 'The payment settled'
    : active && amt != null ? `${role === 'card' ? 'Paying' : 'Collecting'} ${usd(amt)}`
    : m.sub;
  return (
    <View style={S.center}>
      <View style={[S.nfcBadge, {borderColor: m.tone}]}>
        {m.spin ? <ActivityIndicator size="large" color={m.tone} /> : <Text style={[S.nfcGlyph, {color: m.tone}]}>{m.glyph}</Text>}
      </View>
      <Text style={S.nfcTitle}>{title}</Text>
      {sub ? <Text style={S.nfcSub}>{sub}</Text> : null}
      <Pressable style={S.linkBtn} onPress={onClose}><Text style={S.linkText}>{terminal ? 'Done' : 'Cancel'}</Text></Pressable>
    </View>
  );
}

function PayMode({identity, online, relayUrl, nfcReady, onSettled, onOfflinePaid}: {identity: Identity; online: boolean; relayUrl: string; nfcReady: boolean; onSettled: (t: Txn) => void; onOfflinePaid: (amount: number) => void}) {
  const [phase, setPhase] = useState<'scan' | 'review' | 'qr' | 'paid'>('scan');
  const [req, setReq] = useState<(Req & {name: string}) | null>(null);
  const [qr, setQr] = useState<{code: string; amount: number; who: string; nonce: string} | null>(null);
  // `pending` = handed to the merchant offline but NOT confirmed by the ledger (we can't claim it
  // settled). `already` = the ledger reported this nonce was already settled (idempotent replay).
  const [paid, setPaid] = useState<{amount: number; who: string; already: boolean; pending?: boolean} | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A tap arriving on the always-armed card takes over the scan screen; nfcKey re-arms after each.
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);

  async function onRequestString(raw: string) {
    try {
      const {reqB64, name} = parseRequestQR(raw);
      const r = await DpayCore.decodeRequest(reqB64);
      setReq({...r, name}); setErr(null); setPhase('review');
    } catch (e: any) { setErr(`bad request QR: ${String(e?.message ?? e)}`); }
  }

  // Confirm an offline (QR-dance) settlement via the ledger, so it lands in Recent once, when settled.
  useEffect(() => {
    if (phase !== 'qr' || !qr) return;
    let alive = true;
    const check = async () => {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch(`${base(relayUrl)}/api/v1/receipt/${qr.nonce}`, {signal: ctrl.signal});
        if (alive && r.ok) { onSettled({nonce: qr.nonce, amount: qr.amount, who: qr.who, time: clock(), dir: 'out'}); setPaid({amount: qr.amount, who: qr.who, already: false}); setPhase('paid'); }
      } catch {} finally { clearTimeout(t); }
    };
    check(); const id = setInterval(check, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [phase, qr, relayUrl, onSettled]);

  async function approve() {
    if (!req) return;
    setBusy(true);
    try {
      const wireHex = await DpayCore.signAuthorization(identity.secretHex, req.toHex, req.amount, req.nonceHex, req.expiry);
      if (!(await DpayCore.verifyWire(wireHex))) throw new Error('local verify failed');
      const code = await DpayCore.encodeQr(wireHex);
      const who = req.name || short(req.toHex);
      const nonce = req.nonceHex;
      if (online) {
        const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), DIRECT_PAY_TIMEOUT_MS);
        let res: {ok: boolean; status: number} | null = null;
        let j: any = {};
        try {
          const r = await fetch(`${base(relayUrl)}/api/v1/pay`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({qr: code}), signal: ctrl.signal});
          res = {ok: r.ok, status: r.status};
          j = await r.json().catch(() => ({} as any));
        } catch { res = null; /* network/timeout → unknown, fall back to the QR hand-off below */ } finally { clearTimeout(timer); }
        const outcome = classifyPayHttp(res);
        if (outcome === 'settled') {
          if (!j.replayed) onSettled({nonce, amount: req.amount, who, time: clock(), dir: 'out'});
          setPaid({amount: req.amount, who, already: !!j.replayed}); setPhase('paid'); return;
        }
        if (outcome === 'rejected') {
          // A definitive refusal: show WHY (e.g. "Not enough balance") rather than silently
          // dropping to the QR screen, which reads as if the payment is fine. NonceReused is the
          // exception — it means this exact payment already settled.
          if (isNonceReused(j?.error)) { setPaid({amount: req.amount, who, already: true}); setPhase('paid'); return; }
          setErr(rejectionMessage(typeof j?.error === 'string' ? j.error : null)); return;
        }
        // outcome === 'unknown': couldn't reach the ledger cleanly. Fall through to the offline QR
        // hand-off (the merchant can still scan it) — the /receipt poll reconciles if it settles.
      }
      setQr({code, amount: req.amount, who, nonce});
      setPhase('qr');
    } catch (e: any) { setErr(String(e?.message ?? e)); } finally { setBusy(false); }
  }

  function reset() { setReq(null); setQr(null); setPaid(null); setManual(''); setErr(null); setPhase('scan'); }

  if (phase === 'paid' && paid) {
    const warn = paid.already || paid.pending;
    const glyph = paid.pending ? '⋯' : paid.already ? '↩' : '✓';
    const headline = paid.pending ? `Sent ${usd(paid.amount)}` : paid.already ? 'Already paid' : `Paid ✓ ${usd(paid.amount)}`;
    const sub = paid.pending ? `to ${paid.who} · awaiting the merchant’s confirmation`
      : paid.already ? `${usd(paid.amount)} to ${paid.who} · not charged again`
      : `to ${paid.who}`;
    return (
      <View style={S.center}>
        <View style={[S.check, warn && S.checkAlready]}><Text style={S.checkMark}>{glyph}</Text></View>
        <Text style={[S.paidText, warn && S.alreadyText]}>{headline}</Text>
        <Text style={S.paidSub}>{sub}</Text>
        <Pressable testID="btn-new" style={S.linkBtn} onPress={reset}><Text style={S.linkText}>New payment</Text></Pressable>
      </View>
    );
  }

  if (phase === 'qr' && qr) {
    return (
      <View style={S.center}>
        <Text style={S.label}>Show this to {qr.who}</Text>
        <View style={S.qrCard}><QRCode value={qr.code} size={220} ecl="L" /></View>
        <Text style={S.amountBig}>{`${usd(qr.amount)} to ${qr.who}`}</Text>
        <Text style={S.badgeOk}>signed on this device ✓</Text>
        {online ? <Text style={S.qrHint}>Waiting for {qr.who} to scan…</Text> : (
          <>
            <Text style={S.qrHint}>Offline — {qr.who} settles this when they submit it. You’ll see it on your balance once you’re back online.</Text>
            <View style={S.confirmRow}>
              {/* Offline we CANNOT know the ledger settled it, so this is an honest "handed off",
                  not "Paid ✓". It optimistically reduces the local balance; the real balance
                  reconciles on the next online poll. It does NOT fabricate a settled history entry. */}
              <Pressable testID="btn-paid" style={S.paidBtn} onPress={() => { onOfflinePaid(qr.amount); setPaid({amount: qr.amount, who: qr.who, already: false, pending: true}); setPhase('paid'); }}><Text style={S.paidBtnText}>Handed to {qr.who}</Text></Pressable>
              <Pressable testID="btn-notpaid" style={S.notPaidBtn} onPress={reset}><Text style={S.notPaidText}>Cancel</Text></Pressable>
            </View>
          </>
        )}
        <Pressable style={S.linkBtn} onPress={() => Share.share({message: qr.code})}><Text style={S.linkText}>Share auth code</Text></Pressable>
      </View>
    );
  }

  if (phase === 'review' && req) {
    return (
      <View style={S.center}>
        <Text style={S.label}>Review payment</Text>
        <Text testID="pay-amount" style={S.reviewAmount}>{`Pay ${usd(req.amount)}`}</Text>
        <Text style={S.reviewTo}>{`to ${req.name || short(req.toHex)}`}</Text>
        <Text style={S.reviewReq}>{`request ${req.nonceHex.slice(0, 12)}…`}</Text>
        <Pressable testID="btn-approve" style={[S.primary, busy && S.dim]} disabled={busy} onPress={approve}><Text style={S.primaryText}>{busy ? 'Signing…' : 'Approve'}</Text></Pressable>
        {err ? <Text testID="review-err" style={S.err}>{err}</Text> : null}
        <Pressable style={S.linkBtn} onPress={reset}><Text style={S.linkTextMuted}>Cancel</Text></Pressable>
      </View>
    );
  }

  // Scan screen: the card is armed in the background (if NFC is ready) AND the QR scanner is live at
  // the same time — the payer taps the merchant's phone OR scans its QR, with no button in between.
  return (
    <View style={S.center}>
      {nfcReady && DpayNfc ? (
        <NfcTap
          key={nfcKey} role="card" identity={identity} relayUrl={relayUrl}
          onSettled={onSettled} onOfflinePaid={onOfflinePaid}
          onActive={() => setNfcActive(true)}
          onClose={() => { setNfcActive(false); setNfcKey(k => k + 1); }}
        />
      ) : null}
      {!nfcActive ? (
        <>
          <Text style={S.label}>{nfcReady ? 'Tap or scan to pay' : 'Scan a request to pay'}</Text>
          <QrScanner onScan={onRequestString} />
          <Text style={S.dim2}>{nfcReady ? "Tap the merchant's phone, or point at its request QR" : "Point at the payee's request QR"}</Text>
          {err ? <Text style={S.err}>{err}</Text> : null}
          <View style={S.manualRow}>
            <TextInput testID="manual-input" style={S.manualInput} value={manual} onChangeText={setManual} placeholder="…or paste the request code" autoCapitalize="none" autoCorrect={false} />
            <Pressable testID="btn-manual" style={S.smallBtn} onPress={() => manual.trim() && onRequestString(manual)}><Text style={S.smallBtnText}>Use</Text></Pressable>
          </View>
        </>
      ) : null}
    </View>
  );
}

function ReceiveMode({identity, relayUrl, nfcReady, onReceived}: {identity: Identity; relayUrl: string; nfcReady: boolean; onReceived: (t: Txn) => void}) {
  const [amount, setAmount] = useState('25.00');
  const [reqQr, setReqQr] = useState<{value: string; cents: number; nonce: string; nfcHex: string | null} | null>(null);
  const [result, setResult] = useState<{amount: number; from: string} | null>(null);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);
  // Stable across renders (NfcTap's effect depends on it) — only changes when the request does.
  const readerReqInfo = useMemo(
    () => (reqQr ? {amount: reqQr.cents, nonce: reqQr.nonce, who: 'payer'} : undefined),
    [reqQr],
  );

  async function makeRequest() {
    const cents = toCents(amount);
    if (!cents) return;
    try {
      const nonce = randNonceHex();
      const expiry = nowSecs() + EXPIRY_WINDOW;
      const reqB64 = await DpayCore.encodeRequest(identity.publicHex, cents, nonce, expiry);
      // Build the NFC request too so reader mode can start alongside the QR (best-effort).
      let nfcHex: string | null = null;
      if (nfcReady && DpayNfc) { try { nfcHex = await DpayNfc.buildRequest(identity.publicHex, cents, nonce, expiry); } catch {} }
      setReqQr({value: `${reqB64}|${identity.username}`, cents, nonce, nfcHex});
      setResult(null); setErr(null);
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }

  // Poll the ledger for this request's settlement (payer paid directly, or we submitted their QR).
  useEffect(() => {
    if (!reqQr || result) return;
    let alive = true;
    const check = async () => {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch(`${base(relayUrl)}/api/v1/receipt/${reqQr.nonce}`, {signal: ctrl.signal});
        if (alive && r.ok) { const j = await r.json(); const from = j.receipt?.from ? short(j.receipt.from) : 'payer'; setResult({amount: reqQr.cents, from}); onReceived({nonce: reqQr.nonce, amount: reqQr.cents, who: from, time: clock(), dir: 'in'}); }
      } catch {} finally { clearTimeout(t); }
    };
    check(); const id = setInterval(check, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [reqQr, result, relayUrl, onReceived]);

  async function onSignedQr(raw: string) {
    setScanning(false);
    setErr(null);
    try {
      const r = await fetch(`${base(relayUrl)}/api/v1/pay`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({qr: raw.trim()})});
      const j = await r.json().catch(() => ({} as any));
      // Only a definitive rejection is worth an error. A settled or ambiguous (network) result is
      // surfaced by the /receipt poll (which sets `result`), so we never flash a false failure on a
      // payment that actually went through.
      if (classifyPayHttp({ok: r.ok, status: r.status}) === 'rejected' && !isNonceReused(j?.error)) {
        setErr(rejectionMessage(typeof j?.error === 'string' ? j.error : null));
      }
    } catch { /* network/timeout — the /receipt poll reconciles; don't show a false error */ }
  }

  function reset() { setReqQr(null); setResult(null); setScanning(false); setErr(null); setNfcActive(false); setNfcKey(k => k + 1); }

  // While an NFC tap is mid-flow, let it own the screen (so the receipt gets back to the payer)
  // rather than the settlement poll swapping in the "Received" view underneath it.
  if (result && !nfcActive) {
    return (
      <View style={S.center}>
        <View style={S.check}><Text style={S.checkMark}>✓</Text></View>
        <Text style={S.paidText}>{`Received ${usd(result.amount)}`}</Text>
        <Text style={S.paidSub}>{`from ${result.from}`}</Text>
        <Pressable style={S.linkBtn} onPress={reset}><Text style={S.linkText}>New request</Text></Pressable>
      </View>
    );
  }

  if (reqQr) {
    return (
      <View style={S.center}>
        {/* Reader mode runs in the background while the QR is shown: the payer taps OR scans. */}
        {reqQr.nfcHex && nfcReady && DpayNfc ? (
          <NfcTap
            key={nfcKey} role="reader" identity={identity} relayUrl={relayUrl} requestHex={reqQr.nfcHex}
            reqInfo={readerReqInfo}
            onSettled={onReceived} onActive={() => setNfcActive(true)}
            onClose={() => { setNfcActive(false); reset(); }}
          />
        ) : null}
        {!nfcActive ? (
          <>
            <Text style={S.label}>Show this to the payer{reqQr.nfcHex ? ' · or let them tap' : ''}</Text>
            <View style={S.qrCard}><QRCode value={reqQr.value} size={220} ecl="M" /></View>
            <Text style={S.amountBig}>{usd(reqQr.cents)}</Text>
            <Text style={S.qrHint}>Waiting for payment…</Text>
            {scanning ? (
              <><QrScanner onScan={onSignedQr} /><Text style={S.dim2}>Scan the payer's signed QR</Text></>
            ) : (
              <Pressable style={S.linkBtn} onPress={() => setScanning(true)}><Text style={S.linkText}>Payer offline? Scan their QR</Text></Pressable>
            )}
            {err ? <Text style={S.err}>{err}</Text> : null}
            <Pressable style={S.linkBtn} onPress={reset}><Text style={S.linkTextMuted}>New request</Text></Pressable>
          </>
        ) : null}
      </View>
    );
  }

  return (
    <View style={S.center}>
      <Text style={S.label}>Amount to receive</Text>
      <View style={S.amountRow}><Text style={S.currency}>$</Text><TextInput testID="amount-input" style={S.amountInput} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" /></View>
      <Pressable testID="btn-request" style={S.primaryWide} onPress={makeRequest}><Text style={S.primaryText}>Request</Text></Pressable>
      {err ? <Text style={S.err}>{err}</Text> : null}
    </View>
  );
}

const S = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg},
  centerAll: {alignItems: 'center', justifyContent: 'center'},
  onboard: {flex: 1, padding: 28, justifyContent: 'center'},
  brandBig: {fontSize: 44, fontWeight: '800', color: C.brand, textAlign: 'center'},
  onboardSub: {fontSize: 16, color: C.sub, textAlign: 'center', marginTop: 4, marginBottom: 36},
  usernameInput: {backgroundColor: C.field, borderRadius: 14, height: 60, paddingHorizontal: 18, fontSize: 20, color: C.ink, marginBottom: 8},
  header: {paddingTop: 20, paddingHorizontal: 22, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottomWidth: 1, borderBottomColor: C.line},
  brand: {fontSize: 26, fontWeight: '800', color: C.brand},
  who: {fontSize: 12, color: C.sub, marginTop: 2},
  nfcPill: {flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6, alignSelf: 'flex-start', backgroundColor: C.field, borderRadius: 12, paddingHorizontal: 9, height: 22},
  nfcLabel: {fontSize: 12, fontWeight: '600', color: C.sub},
  nfcBadge: {width: 108, height: 108, borderRadius: 54, borderWidth: 4, alignItems: 'center', justifyContent: 'center', marginBottom: 26},
  nfcGlyph: {fontSize: 54, fontWeight: '700', lineHeight: 62},
  nfcTitle: {fontSize: 24, fontWeight: '800', color: C.ink, textAlign: 'center'},
  nfcSub: {fontSize: 15, color: C.sub, marginTop: 10, textAlign: 'center', paddingHorizontal: 20},
  balBox: {alignItems: 'flex-end'},
  balLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 5},
  dot: {width: 8, height: 8, borderRadius: 4},
  balLabel: {fontSize: 12, color: C.sub},
  balAmt: {fontSize: 26, fontWeight: '800', color: C.ink},
  tabs: {flexDirection: 'row', paddingHorizontal: 22, gap: 10, marginTop: 10},
  tab: {paddingVertical: 8, paddingHorizontal: 20, borderRadius: 999, backgroundColor: C.field},
  tabActive: {backgroundColor: C.brand},
  tabText: {color: C.sub, fontWeight: '600'},
  tabTextActive: {color: C.brandInk},
  body: {flexGrow: 1, paddingHorizontal: 22, paddingTop: 18, justifyContent: 'center'},
  center: {alignItems: 'center'},
  label: {fontSize: 15, color: C.sub, marginBottom: 14, textAlign: 'center'},
  err: {color: C.bad, fontSize: 14, textAlign: 'center', marginTop: 10},
  dim: {opacity: 0.6},
  dim2: {fontSize: 13, color: C.sub, marginTop: 10, textAlign: 'center'},
  camBox: {width: 250, height: 250, borderRadius: 20, overflow: 'hidden', backgroundColor: '#111827', borderWidth: 1, borderColor: C.line},
  camPlaceholder: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  reviewAmount: {fontSize: 30, fontWeight: '800', color: C.ink, textAlign: 'center'},
  reviewTo: {fontSize: 17, color: C.ink, marginTop: 6, textAlign: 'center'},
  reviewReq: {fontSize: 12, color: C.sub, fontFamily: 'monospace', marginTop: 6, marginBottom: 24},
  primary: {backgroundColor: C.brand, borderRadius: 14, height: 56, minWidth: 240, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center', marginTop: 12},
  primaryWide: {backgroundColor: C.brand, borderRadius: 14, height: 56, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', marginTop: 20},
  primaryText: {color: C.brandInk, fontSize: 18, fontWeight: '600'},
  qrCard: {backgroundColor: '#fff', padding: 16, borderRadius: 18, borderWidth: 1, borderColor: C.line, marginBottom: 16},
  amountBig: {fontSize: 24, fontWeight: '800', color: C.ink, textAlign: 'center'},
  badgeOk: {marginTop: 10, fontSize: 13, fontWeight: '600', color: '#166534', backgroundColor: '#dcfce7', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, overflow: 'hidden'},
  qrHint: {marginTop: 16, fontSize: 13, color: C.sub, textAlign: 'center'},
  confirmRow: {flexDirection: 'row', gap: 12, marginTop: 12},
  paidBtn: {backgroundColor: C.ok, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 24},
  paidBtnText: {color: '#fff', fontWeight: '700', fontSize: 16},
  notPaidBtn: {backgroundColor: C.field, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 24},
  notPaidText: {color: C.sub, fontWeight: '600', fontSize: 16},
  check: {width: 92, height: 92, borderRadius: 46, backgroundColor: C.ok, alignItems: 'center', justifyContent: 'center', marginBottom: 18},
  checkAlready: {backgroundColor: C.warn},
  checkMark: {color: '#fff', fontSize: 50, fontWeight: '700'},
  paidText: {fontSize: 30, fontWeight: '800', color: C.ok},
  alreadyText: {color: C.warn},
  paidSub: {fontSize: 16, color: C.sub, marginTop: 6},
  amountRow: {flexDirection: 'row', alignItems: 'center', backgroundColor: C.field, borderRadius: 14, paddingHorizontal: 18, height: 76, alignSelf: 'stretch'},
  currency: {fontSize: 36, fontWeight: '700', color: C.ink},
  amountInput: {flex: 1, fontSize: 36, fontWeight: '700', color: C.ink, marginLeft: 6},
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
  histWho: {flex: 1, fontSize: 15, color: C.ink},
  histAmt: {fontSize: 15, fontWeight: '700', marginRight: 12},
  histTime: {fontSize: 12, color: C.sub, fontFamily: 'monospace'},
  settings: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 22, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.line},
  settingsLabel: {fontSize: 12, color: C.sub},
  settingsInput: {flex: 1, fontSize: 12, color: C.ink, fontFamily: 'monospace', paddingVertical: 4},
  resetLink: {fontSize: 12, color: C.bad},
});
