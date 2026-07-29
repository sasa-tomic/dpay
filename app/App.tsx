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
  Share, AppState, ActivityIndicator, NativeEventEmitter, Platform,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import Svg, {Defs, RadialGradient, Stop, Rect, Path} from 'react-native-svg';
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
  buildRequest(toHex: string, amount: number, nonceHex: string, expiry: number, currency: number): Promise<string>;
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
  | {type: 'request'; role: 'card'; toHex: string; amount: number; nonceHex: string; expiry: number; currency: number}
  | {type: 'done'; role: 'reader'; wireHex: string}
  | {type: 'receipt'; role: 'card'; settled: boolean; status: number; nonceHex: string}
  | {type: 'confirmed'; role: 'reader'}
  | {type: 'error'; role: 'card' | 'reader'; reason: string};

type NfcPhaseName = 'listening' | 'linking' | 'exchanging' | 'awaitingApproval' | 'settling' | 'success' | 'declined' | 'pending';

type Req = {toHex: string; amount: number; nonceHex: string; expiry: number; currency: number};
type Identity = {secretHex: string; publicHex: string; username: string};
type Txn = {nonce: string; amount: number; who: string; time: string; dir: 'out' | 'in'};
// One row of the relay's GET /api/v1/transactions/{hex} response (from/to are lowercase hex).
type TransactionsRow = {from: string; to: string; amount: number; nonce: string; currency: number; timestamp: number};
type DpayCoreApi = {
  generateKeypair(): Promise<{secretHex: string; publicHex: string}>;
  signAuthorization(secretHex: string, toHex: string, amount: number, nonceHex: string, expiry: number, currency: number): Promise<string>;
  encodeRequest(toHex: string, amount: number, nonceHex: string, expiry: number, currency: number): Promise<string>;
  decodeRequest(qr: string): Promise<Req>;
  encodeQr(wireHex: string): Promise<string>;
  verifyWire(wireHex: string): Promise<boolean>;
  // Device NFC radio state for the status chip: 'ready' | 'off' | 'unsupported' | 'unknown'.
  // Optional so an app built before the native method exists degrades to 'unknown' (chip hidden).
  nfcStatus?(): Promise<string>;
};

type NfcStatus = 'ready' | 'off' | 'unsupported' | 'unknown';

// Dark premium fintech palette — matches crates/dpay-relay/assets/landing.html.
const C = {
  bg: '#06070a', panel: '#0c0f14', panel2: '#0e1218', card: 'rgba(255,255,255,0.025)',
  ink: '#f1f4f7', sub: '#a6afba', sub2: '#69727d',
  brand: '#3ee0ac', brand2: '#22b98a', brandInk: '#03170f',
  ok: '#3ee0ac', bad: '#f87171', warn: '#f0c46a',
  line: 'rgba(255,255,255,0.08)', line2: 'rgba(255,255,255,0.05)', field: '#10141a',
};
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
// Format a unix-seconds timestamp as HH:MM (24h, local) — the durable history rows are sourced from
// the ledger (which settle on `ic time / 1e9`).
const fmtTime = (ts: number) => { const d = new Date(ts * 1000); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
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

// --- ck-deposit (ckBTC-style top-up) --------------------------------------------------------
// A deposit address on a ck minter's native chain (BTC for ckBTC). The facade proxies the minter; the
// relay surfaces it at /api/v1/deposit/*. The mint lands on the user's subaccount, so the existing
// balance/history polls reflect it once confirmed. DEMO_USD (faucet) stays currency 0; ckBTC = 1.
const DEPOSIT_CURRENCY = 1;
const DEPOSIT_REFRESH_MS = 10000; // poll /deposit/refresh while the sheet is open
type DepositInfo = {min_confirmations: number; deposit_fee: number; deposit_min_amount: number | null};
type MintedUtxo = {block_index: string; amount: number};
type PendingUtxo = {value: number; confirmations: number};
type DepositRefresh = {minted_total: number; minted: MintedUtxo[]; pending: PendingUtxo[]; required_confirmations: number};

// Format satoshis as BTC (8 decimals), e.g. 12345 -> "0.00012345 BTC". Parallel to usd(cents).
const btc = (sats: number) => {
  const n = Math.max(0, Math.floor(sats));
  const whole = Math.floor(n / 1e8);
  const frac = String(n % 1e8).padStart(8, '0');
  return `${whole}.${frac} BTC`;
};

// Relay deposit client — same fetch style as the inline balance/faucet/pay calls (AbortController
// optional, errors thrown to the caller). Co-located here to match the existing pattern.
async function depositInfo(relayUrl: string, currency: number, signal?: AbortSignal): Promise<DepositInfo> {
  const r = await fetch(`${base(relayUrl)}/api/v1/deposit/info?currency=${currency}`, {signal});
  if (!r.ok) throw new Error(`deposit/info ${r.status}`);
  return r.json();
}
async function depositAddress(relayUrl: string, accountHex: string, currency: number, signal?: AbortSignal): Promise<string> {
  const r = await fetch(`${base(relayUrl)}/api/v1/deposit/address/${accountHex}?currency=${currency}`, {signal});
  if (!r.ok) throw new Error(`deposit/address ${r.status}`);
  const j = await r.json();
  return j.address as string;
}
async function depositRefresh(relayUrl: string, accountHex: string, currency: number, signal?: AbortSignal): Promise<DepositRefresh> {
  const r = await fetch(`${base(relayUrl)}/api/v1/deposit/refresh/${accountHex}?currency=${currency}`, {method: 'POST', signal});
  if (!r.ok) throw new Error(`deposit/refresh ${r.status}`);
  return r.json();
}

// Deposit copy is single-sourced per chain. ckBTC deposits come in on the Bitcoin network as BTC;
// surfaced ONLY in the deposit instructions (the deposit asset/network, never the wallet balance,
// which always shows `$`). Honest ranges where the minter omits them.
const DEPOSIT_NETWORK = 'Bitcoin';   // the native chain a ck-deposit lands on (BTC for ckBTC)
const DEPOSIT_ASSET = 'BTC';         // the asset the user sends on that chain
const BTC_BLOCK_MIN = 10;            // avg Bitcoin block time in minutes → est. time-to-credit

/**
 * Copy `text` to the system clipboard when available; otherwise fall back to the platform share
 * sheet (`Share.share` on Android opens a sheet that includes "Copy"; web's `navigator.clipboard`
 * is the real clipboard). Returns the path taken so the UI can say "Copied ✓" vs "Shared ✓".
 * Every fallible op is caught + logged with context (no silent errors); a failure degrades to the
 * Share fallback rather than throwing.
 */
async function copyToClipboard(text: string): Promise<'clipboard' | 'shared'> {
  // Web: prefer the real clipboard API (works in react-native-web + the e2e browser harness).
  if (Platform.OS === 'web') {
    try {
      const clip = (globalThis as {navigator?: {clipboard?: {writeText?: (t: string) => Promise<void>}}}).navigator?.clipboard;
      if (clip && typeof clip.writeText === 'function') {
        await clip.writeText(text);
        return 'clipboard';
      }
    } catch (e) {
      console.warn('[dpay] clipboard write failed, falling back to Share:', String(e));
    }
  }
  // Native (or web without a clipboard API): Share sheet. On Android this reliably exposes "Copy".
  try {
    await Share.share({message: text});
  } catch (e) {
    // Even Share failing must not break the sheet — log with context and report the best outcome.
    console.warn('[dpay] Share.share failed during copy:', String(e));
  }
  return 'shared';
}

/**
 * Escape closes an open sheet/modal — the seed of the keyboard-shortcuts surface (plan flow 14).
 * Web-only: attaches a real DOM `keydown` listener; on native there is no Escape key (Android uses
 * the hardware Back button, handled separately), so this is a harmless no-op there. Uses `globalThis`
 * + a structural key type so it typechecks without the DOM lib (RN's tsconfig ships no DOM types).
 */
function useEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    // The web global exposes addEventListener/removeEventListener + a KeyboardEvent carrying `.key`.
    type HasKey = {key: string};
    const g = globalThis as unknown as {
      addEventListener?: (type: string, fn: (e: HasKey) => void) => void;
      removeEventListener?: (type: string, fn: (e: HasKey) => void) => void;
    };
    if (typeof g.addEventListener !== 'function') {
      return;
    }
    const onKey = (e: HasKey) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    g.addEventListener('keydown', onKey);
    return () => { g.removeEventListener?.('keydown', onKey); };
  }, [onClose]);
}

/**
 * Web-only deep link: `?screen=deposit` auto-opens the deposit sheet on load (so the page is
 * bookmarkable/shareable to top-up, and the e2e harness can deep-link straight in). Harmless on
 * native — there's no URL bar, and Platform.OS !== 'web' short-circuits before reading location.
 */
function readDepositDeepLink(): boolean {
  if (Platform.OS !== 'web') {
    return false;
  }
  const w = globalThis as unknown as {location?: {search?: string}};
  if (!w.location) {
    return false;
  }
  try {
    return new URLSearchParams(w.location.search ?? '').get('screen') === 'deposit';
  } catch {
    return false;
  }
}
// ---------------------------------------------------------------------------------------------

// The mint-green geometric "d" used by both the app icon and the in-app emblem. Bowl LEFT, ascender
// stem RIGHT (1024 viewBox, matches the adaptive-icon foreground).
const D_PATH = 'M622 276a52 52 0 0 1 52 52v348a52 52 0 0 1-52 52 52 52 0 0 1-52-52V328a52 52 0 0 1 52-52zM508 396a176 176 0 1 0 .1 0zM508 498a74 74 0 1 1-.1 0z';

function Logo({size = 96}: {size?: number}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024">
      <Defs>
        <RadialGradient id="dpbg" cx="0.5" cy="0.34" r="0.82">
          <Stop offset="0" stopColor="#15191f" />
          <Stop offset="1" stopColor="#0a0c11" />
        </RadialGradient>
        <RadialGradient id="dphalo" cx="0.5" cy="0.4" r="0.5">
          <Stop offset="0" stopColor="#3ee0ac" stopOpacity="0.32" />
          <Stop offset="1" stopColor="#3ee0ac" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="1024" height="1024" rx="228" fill="url(#dpbg)" />
      <Rect x="0" y="0" width="1024" height="1024" rx="228" fill="url(#dphalo)" />
      <Path d={D_PATH} fill="#3ee0ac" />
    </Svg>
  );
}

function Wordmark({style}: {style?: object}) {
  return (
    <Text style={[S.wordmark, style]}>
      d<Text style={S.wordmarkPay}>pay</Text>
    </Text>
  );
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
        const wire = await DpayCore.signAuthorization(kp.secretHex, kp.publicHex, 1, randNonceHex(), 4102444800, 0);
        console.log(`DPAY_SELFCHECK ${(await DpayCore.verifyWire(wire)) && wire.length === 392 ? 'PASS' : 'FAIL'}`);
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
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <View style={S.onboard}>
        <Logo size={104} />
        <Wordmark style={S.wordmarkBig} />
        <Text style={S.onboardSub}>Tap or scan to pay — online or offline.</Text>
        <Text style={S.label}>Choose a username</Text>
        <TextInput style={S.usernameInput} value={username} onChangeText={setUsername} placeholder="e.g. Alice" placeholderTextColor={C.sub2} autoCapitalize="words" autoCorrect={false} />
        {err ? <Text style={S.err}>{err}</Text> : null}
        <Pressable testID="btn-create" style={[S.primary, busy && S.dim]} disabled={busy} onPress={create}>
          <Text style={S.primaryText}>{busy ? 'Creating…' : 'Create & fund wallet'}</Text>
        </Pressable>
        <Text style={S.dim2}>Generates a key on this device and adds demo $100 to start.</Text>
      </View>
    </SafeAreaView>
  );
}

function Wallet({identity, relayUrl, setRelayUrl, onReset}: {identity: Identity; relayUrl: string; setRelayUrl: (s: string) => void; onReset: () => void}) {
  const [mode, setMode] = useState<'pay' | 'receive'>('pay');
  const [balance, setBalance] = useState<number | null>(null);
  // ckBTC (currency 1, DEPOSIT_CURRENCY) is a SEPARATE asset on a separate ledger. The primary
  // wallet header shows `$` = DEMO_USD (currency 0) only — by CLAUDE.md's hard rule ("Money shown
  // as `$`, never token name"). But a topped-up ckBTC balance must be VISIBLE (the seamless top-up
  // goal: after the deposit sheet closes, the credited asset is still on screen). So we fetch
  // currency 1 on the same poll and render it as a clearly-labeled, separate "Bitcoin" asset card
  // (the deposit instructions already legitimately say "Bitcoin"/"BTC") — never merged into `$`.
  const [ckBtcBalance, setCkBtcBalance] = useState<number | null>(null);
  const [online, setOnline] = useState(false);
  const [offlineSpent, setOfflineSpent] = useState(0);
  const [history, setHistory] = useState<Txn[]>([]);
  const [nfc, setNfc] = useState<NfcStatus>('unknown');
  // Demo top-up: a single click adds $50 of demo currency via /api/v1/faucet. The button sits next
  // to the balance so users find it without hunting. `topUpBusy` drives the spinner; `topUpErr`
  // surfaces a one-line failure (offline / faucet disabled) without blocking the rest of the UI.
  const [topUpBusy, setTopUpBusy] = useState(false);
  const [topUpErr, setTopUpErr] = useState<string | null>(null);
  // ck-deposit sheet (ckBTC-style native-chain deposit). Opens over the wallet; closing tears down
  // its address/refresh polling. Independent of the DEMO_USD faucet (btn-topup) above. On web it
  // auto-opens when the page is loaded with `?screen=deposit` (bookmarkable top-up deep link).
  const [depositOpen, setDepositOpen] = useState<boolean>(readDepositDeepLink);

  const TOP_UP_CENTS = 5000; // $50.00 in minor units

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
      // ckBTC (currency 1) fetch runs in PARALLEL + best-effort with its own AbortController, so a
      // currency-1 hiccup can never flip the primary `$` balance offline or fail its poll. The two
      // assets live on separate ledgers — fetching one must not affect the other's display.
      const ctrlCk = new AbortController();
      const tCk = setTimeout(() => ctrlCk.abort(), 4000);
      const ckFetch = fetch(`${base(relayUrl)}/api/v1/balance/${identity.publicHex}?currency=${DEPOSIT_CURRENCY}`, {signal: ctrlCk.signal})
        .then(r => r.ok ? r.json().catch(() => null) : null)
        .then(j => (j && typeof j.balance === 'number') ? (j.balance as number) : null)
        .catch(() => null)
        .finally(() => clearTimeout(tCk));
      try {
        const r = await fetch(`${base(relayUrl)}/api/v1/balance/${identity.publicHex}`, {signal: ctrl.signal});
        const j = await r.json();
        if (alive && r.ok && typeof j.balance === 'number') { setBalance(j.balance); setOnline(true); setOfflineSpent(0); }
        else if (alive) setOnline(false);
      } catch { if (alive) setOnline(false); } finally { clearTimeout(t); }
      // Settle the ckBTC balance after the primary poll resolves; null = keep the prior value
      // (offline / transient), so the asset card never flaps on a single miss.
      const ck = await ckFetch;
      if (alive && ck != null) { setCkBtcBalance(ck); }
    };
    poll(); const id = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [relayUrl, identity.publicHex]);

  // Durable transaction history sourced from the ledger (the canister records every settled payment;
  // the relay surfaces it at GET /api/v1/transactions/{hex}). This replaces the ephemeral in-memory
  // list that was empty on every restart. Each row's direction (in/out) is derived by comparing the
  // queried account to `from`.
  const refreshHistory = useCallback(async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(`${base(relayUrl)}/api/v1/transactions/${identity.publicHex}?currency=0&limit=20`, {signal: ctrl.signal});
      const j = await r.json().catch(() => ({} as any));
      if (r.ok && Array.isArray(j.transactions)) {
        const me = identity.publicHex.toLowerCase();
        setHistory((j.transactions as TransactionsRow[]).map((rec): Txn => {
          const dir: 'out' | 'in' = rec.from.toLowerCase() === me ? 'out' : 'in';
          const who = dir === 'out' ? short(rec.to) : short(rec.from);
          return {nonce: rec.nonce, amount: rec.amount, who, time: fmtTime(rec.timestamp), dir};
        }));
      }
    } catch { /* offline: keep the existing list */ } finally { clearTimeout(t); }
  }, [relayUrl, identity.publicHex]);

  // Fetch on mount and re-poll while online (the balance poll runs every 2.5s; history every 5s is
  // plenty for a list that only changes when a payment settles). Clears on unmount.
  useEffect(() => {
    let alive = true;
    const wrapped = () => { if (alive) refreshHistory(); };
    wrapped();
    const id = setInterval(wrapped, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [refreshHistory]);

  // Children signal that a payment activity happened; the ledger-sourced `refreshHistory` is the SOLE
  // writer to `history` (fetched eagerly here — no optimistic in-memory state). Stable across renders.
  const onActivity = useCallback(() => { refreshHistory(); }, [refreshHistory]);
  const markOfflinePaid = useCallback((amount: number) => setOfflineSpent(s => s + amount), []);
  const shownBalance = balance == null ? null : online ? balance : Math.max(0, balance - offlineSpent);

  // Demo top-up: POST /api/v1/faucet {account, amount}. Uses the response balance directly for an
  // immediate refresh (no waiting on the 2.5s poll). Errors are surfaced inline under the button.
  const topUp = useCallback(async () => {
    if (topUpBusy) return;
    setTopUpBusy(true); setTopUpErr(null);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(`${base(relayUrl)}/api/v1/faucet`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({account: identity.publicHex, amount: TOP_UP_CENTS}),
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => ({} as any));
      if (r.ok && typeof j.balance === 'number') {
        setBalance(j.balance); setOnline(true); setOfflineSpent(0);
      } else {
        setTopUpErr(r.ok ? 'Top-up failed' : 'Faucet unavailable');
      }
    } catch {
      setTopUpErr('Offline — try again when connected');
    } finally {
      clearTimeout(t);
      setTopUpBusy(false);
    }
  }, [topUpBusy, relayUrl, identity.publicHex]);

  return (
    <SafeAreaView style={S.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <View style={S.header}>
        <View>
          <Wordmark style={S.brand} />
          <Text style={S.who}>{identity.username} · {short(identity.publicHex)}</Text>
          <NfcPill status={nfc} />
        </View>
        <View style={S.balBox}>
          <View style={S.balLabelRow}>
            <View style={[S.dot, {backgroundColor: online ? C.ok : C.sub2}]} />
            <Text style={S.balLabel}>{online ? 'balance' : '~ approx.'}</Text>
            <View style={S.demoPill}><Text style={S.demoPillText}>DEMO</Text></View>
          </View>
          <View style={S.balAmtRow}>
            <Text testID="balance" style={S.balAmt}>{shownBalance == null ? '—' : `${online ? '' : '~'}${usd(shownBalance)}`}</Text>
            <Pressable testID="btn-topup" style={[S.topUpBtn, topUpBusy && S.dim]} disabled={topUpBusy} onPress={topUp}>
              {topUpBusy
                ? <ActivityIndicator size="small" color={C.brand} />
                : <Text style={S.topUpText}>+ ${TOP_UP_CENTS / 100}</Text>}
            </Pressable>
            {/* The PRIMARY funding affordance: a real chain-key deposit (ckBTC). Promoted from a
                jargon "ckBTC" pill to a clear "Add money" button so topping up is the obvious next
                action. The DEMO_USD faucet (btn-topup) stays secondary. Opens DepositSheet. */}
            <Pressable testID="btn-deposit" style={S.addMoneyBtn} onPress={() => setDepositOpen(true)}>
              <Text style={S.addMoneyBtnText}>＋ Add money</Text>
            </Pressable>
          </View>
          {topUpErr ? <Text style={S.topUpErr}>{topUpErr}</Text> : null}
        </View>
      </View>

      <View style={S.tabs}>
        <Tab label="Pay" active={mode === 'pay'} onPress={() => setMode('pay')} />
        <Tab label="Receive" active={mode === 'receive'} onPress={() => setMode('receive')} />
      </View>

      <ScrollView contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        {mode === 'pay'
          ? <PayMode identity={identity} online={online} relayUrl={relayUrl} nfcReady={nfc === 'ready'} onSettled={onActivity} onOfflinePaid={markOfflinePaid} shownBalance={shownBalance} />
          : <ReceiveMode identity={identity} relayUrl={relayUrl} nfcReady={nfc === 'ready'} onReceived={onActivity} />}
        {/* ckBTC asset card — a SEPARATE asset (currency 1), shown only when non-zero so a topped-up
            wallet keeps its credited Bitcoin VISIBLE after the deposit sheet closes. Deliberately
            distinct from the `$` header (DEMO_USD): different label, BTC units, its own card. This
            is the asset affordance CLAUDE.md permits; the primary `$` balance stays clean. The
            "Bitcoin" label matches the deposit instructions' network/asset name. */}
        {ckBtcBalance != null && ckBtcBalance > 0 ? (
          <View testID="asset-ckbtc" style={S.assetCard}>
            <View style={S.assetRow}>
              <Text style={S.assetLabel}>Bitcoin</Text>
              <Text style={S.assetAmt}>{btc(ckBtcBalance)}</Text>
            </View>
            <Text style={S.assetSub}>your deposited Bitcoin · spendable where a merchant requests it</Text>
          </View>
        ) : null}
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
        <TextInput testID="settings-relay" style={S.settingsInput} value={relayUrl} onChangeText={setRelayUrl} autoCapitalize="none" autoCorrect={false} placeholder="http://<ip>:8787" placeholderTextColor={C.sub2} />
        <Pressable testID="btn-reset" onPress={onReset}><Text style={S.resetLink}>reset</Text></Pressable>
      </View>

      {depositOpen ? (
        <DepositSheet identity={identity} relayUrl={relayUrl} onClose={() => setDepositOpen(false)} />
      ) : null}
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
  unsupported: {dot: C.sub2, label: 'No NFC'},
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
  onSettled?: () => void;
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
  // True once we've optimistically deducted the payment from the local balance (when the wire
  // leaves the phone). Prevents double-deduction if the receipt later arrives with success, and
  // enables undo if the receipt says declined.
  const deductedRef = useRef(false);
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

  const record = useCallback(() => {
    if (recordedRef.current || !onSettled) return;
    recordedRef.current = true;
    onSettled();
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
        record();
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
  const autoSign = useCallback(async (req: {toHex: string; amount: number; nonceHex: string; expiry: number; currency: number}) => {
    try {
      const wireHex = await DpayCore.signAuthorization(identity.secretHex, req.toHex, req.amount, req.nonceHex, req.expiry, req.currency);
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
      if (e.type === 'request') { markActive(); setPhase('exchanging'); autoSign({toHex: e.toHex, amount: e.amount, nonceHex: e.nonceHex, expiry: e.expiry, currency: e.currency}); }
      else if (e.type === 'done') { markActive(); committed.current = true; submitWire(e.wireHex); }
      else if (e.type === 'receipt') {
        // The payer's outcome, learned offline over the tap — believed only if it answers the exact
        // payment we signed (nonce match). UNREACHABLE ⇒ pending (unknown), never a false decline.
        const outcome = decidePayerReceipt({status: e.status, nonceHex: e.nonceHex}, sentRef.current?.nonce ?? '');
        if (outcome === 'ignore') return; // a receipt for some other payment — keep waiting
        if (outcome === 'success') {
          // Balance was already deducted when the wire left the phone — just record the txn.
          record();
          finalize('success');
        } else if (outcome === 'declined') {
          // The ledger refused — undo the optimistic deduction so the local balance is whole again.
          if (deductedRef.current && sentRef.current) { onOfflinePaid?.(-sentRef.current.amount); }
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
          // The wire has left the phone — optimistically deduct from the local balance. The real
          // balance reconciles on the next online poll; if the receipt says declined we undo below.
          if (!deductedRef.current && sentRef.current) {
            deductedRef.current = true;
            onOfflinePaid?.(sentRef.current.amount);
          }
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
    <View style={S.center} testID="nfc-status">
      <View style={[S.nfcBadge, {borderColor: m.tone}]}>
        {m.spin ? <ActivityIndicator size="large" color={m.tone} /> : <Text style={[S.nfcGlyph, {color: m.tone}]}>{m.glyph}</Text>}
      </View>
      <Text style={S.nfcTitle}>{title}</Text>
      {sub ? <Text style={S.nfcSub}>{sub}</Text> : null}
      <Pressable style={S.linkBtn} onPress={onClose}><Text style={S.linkText}>{terminal ? 'Done' : 'Cancel'}</Text></Pressable>
    </View>
  );
}

function PayMode({identity, online, relayUrl, nfcReady, onSettled, onOfflinePaid, shownBalance}: {identity: Identity; online: boolean; relayUrl: string; nfcReady: boolean; onSettled: () => void; onOfflinePaid: (amount: number) => void; shownBalance: number | null}) {
  const [phase, setPhase] = useState<'scan' | 'review' | 'qr' | 'paid'>('scan');
  const [req, setReq] = useState<(Req & {name: string}) | null>(null);
  const [qr, setQr] = useState<{code: string; amount: number; who: string; nonce: string} | null>(null);
  // `pending` = handed to the merchant offline but NOT confirmed by the ledger (we can't claim it
  // settled). `already` = the ledger reported this nonce was already settled (idempotent replay).
  const [paid, setPaid] = useState<{amount: number; who: string; already: boolean; pending?: boolean} | null>(null);
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
        if (alive && r.ok) { onSettled(); setPaid({amount: qr.amount, who: qr.who, already: false}); setPhase('paid'); }
      } catch {} finally { clearTimeout(t); }
    };
    check(); const id = setInterval(check, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [phase, qr, relayUrl, onSettled]);

  async function approve() {
    if (!req) return;
    setBusy(true);
    try {
      const wireHex = await DpayCore.signAuthorization(identity.secretHex, req.toHex, req.amount, req.nonceHex, req.expiry, req.currency);
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
          if (!j.replayed) onSettled();
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

  function reset() { setReq(null); setQr(null); setPaid(null); setErr(null); setPhase('scan'); }

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
        {!online && shownBalance != null && req.amount > shownBalance ? (
          <Text testID="review-lowbal" style={S.warnNote}>Your local balance may not cover this — the merchant will verify.</Text>
        ) : null}
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
        </>
      ) : null}
    </View>
  );
}

function ReceiveMode({identity, relayUrl, nfcReady, onReceived}: {identity: Identity; relayUrl: string; nfcReady: boolean; onReceived: () => void}) {
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
      const reqB64 = await DpayCore.encodeRequest(identity.publicHex, cents, nonce, expiry, 0);
      // Build the NFC request too so reader mode can start alongside the QR (best-effort).
      let nfcHex: string | null = null;
      if (nfcReady && DpayNfc) { try { nfcHex = await DpayNfc.buildRequest(identity.publicHex, cents, nonce, expiry, 0); } catch {} }
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
        if (alive && r.ok) { const j = await r.json(); const from = j.receipt?.from ? short(j.receipt.from) : 'payer'; setResult({amount: reqQr.cents, from}); onReceived(); }
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
            <View testID="request-qr" style={S.qrCard}><QRCode value={reqQr.value} size={220} ecl="M" /></View>
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
      <View style={S.amountRow}><Text style={S.currency}>$</Text><TextInput testID="amount-input" style={S.amountInput} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={C.sub2} /></View>
      <Pressable testID="btn-request" style={S.primaryWide} onPress={makeRequest}><Text style={S.primaryText}>Request</Text></Pressable>
      {err ? <Text style={S.err}>{err}</Text> : null}
    </View>
  );
}

/**
 * ckBTC-style deposit sheet. A native-chain deposit address (BTC for ckBTC) generated by the facade-
 * proxied minter. Flow: instructions + address + QR → poll /deposit/refresh → "Deposited ✓" once the
 * mint lands (minted_total > 0), after which the wallet's balance poll reflects the new ckBTC. The
 * sheet is additive: it never touches the faucet (DEMO_USD) or the Pay/Receive/NFC flows.
 */
function DepositSheet({identity, relayUrl, onClose}: {identity: Identity; relayUrl: string; onClose: () => void}) {
  const currency = DEPOSIT_CURRENCY;
  const [info, setInfo] = useState<DepositInfo | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [refresh, setRefresh] = useState<DepositRefresh | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<'clipboard' | 'shared' | null>(null);
  const [minted, setMinted] = useState(false);
  // Manual "Check now": debounced + disabled while a refresh is in-flight (reuses the poll's fetch).
  const [checkBusy, setCheckBusy] = useState(false);

  // Escape closes the sheet (seed of the keyboard-shortcuts surface — plan flow 14).
  useEscapeToClose(onClose);

  // Load deposit info + the deposit address once on open (same AbortController/timeout style as the
  // balance/pay calls). Address reveal is safe — sending to it only credits the user.
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    (async () => {
      setLoading(true); setErr(null);
      try {
        const [i, a] = await Promise.all([
          depositInfo(relayUrl, currency, ctrl.signal),
          depositAddress(relayUrl, identity.publicHex, currency, ctrl.signal),
        ]);
        if (!alive) return;
        setInfo(i); setAddress(a);
      } catch {
        if (alive) setErr('Could not reach the ledger for a deposit address');
      } finally {
        if (alive) setLoading(false);
        clearTimeout(t);
      }
    })();
    return () => { alive = false; ctrl.abort(); };
  }, [relayUrl, identity.publicHex, currency]);

  // ONE refresh function reused by BOTH the 10s poll and the manual "Check now" button — single
  // source of truth. minted_total > 0 => the deposit credited (mint landed on the user's subaccount).
  // The manual path is debounced via `checkBusy`; the poll is already spaced, so it never sets it.
  const refreshNow = useCallback(async (manual: boolean) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    if (manual) {
      setCheckBusy(true);
    }
    try {
      const r = await depositRefresh(relayUrl, identity.publicHex, currency, ctrl.signal);
      setRefresh(r);
      if (r.minted_total > 0) {
        setMinted(true);
      }
    } catch { /* offline: keep the last status; the next tick retries */ }
    finally {
      clearTimeout(t);
      if (manual) {
        setCheckBusy(false);
      }
    }
  }, [relayUrl, identity.publicHex, currency]);

  // Poll every DEPOSIT_REFRESH_MS while open; cleans up on close.
  useEffect(() => {
    let alive = true;
    const poll = () => { if (alive) { refreshNow(false); } };
    poll(); const id = setInterval(poll, DEPOSIT_REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, [refreshNow]);

  // Real clipboard on web (navigator.clipboard) + Share fallback on native. Returns the path taken
  // so the button label reflects what actually happened ("Copied ✓" vs "Shared ✓").
  const copy = useCallback(async () => {
    if (!address) return;
    const how = await copyToClipboard(address);
    setCopied(how);
    setTimeout(() => setCopied(null), 1500);
  }, [address]);

  const required = info?.min_confirmations ?? refresh?.required_confirmations ?? 0;
  const pending = refresh?.pending ?? [];
  // The linear progress cue: best confirmation count among pending UTXOs vs the required count.
  const maxConf = pending.reduce((m, p) => Math.max(m, p.confirmations), 0);
  const estMin = required > 0 ? required * BTC_BLOCK_MIN : 0;
  const feeTxt = info ? btc(info.deposit_fee) : null;
  const minTxt = info?.deposit_min_amount != null ? btc(info.deposit_min_amount) : null;

  return (
    <View style={S.sheetOverlay}>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>Add money</Text>
          <Pressable testID="btn-deposit-close" style={S.sheetClose} onPress={onClose}><Text style={S.sheetCloseX}>✕</Text></Pressable>
        </View>

        <ScrollView contentContainerStyle={S.sheetBody} keyboardShouldPersistTaps="handled">
          {loading ? (
            <View style={S.centerAll}>
              <ActivityIndicator color={C.brand} />
              <Text style={S.dim2}>Fetching your deposit address…</Text>
            </View>
          ) : err || !address ? (
            <View style={S.centerAll}>
              <Text style={S.err}>{err ?? 'No deposit address available'}</Text>
              <Text style={S.dim2}>Check the relay is reachable, then reopen the sheet.</Text>
            </View>
          ) : minted ? (
            <View style={S.centerAll}>
              <View style={S.check}><Text style={S.checkMark}>✓</Text></View>
              <Text style={S.paidText}>Deposited ✓</Text>
              <Text style={S.paidSub}>{btc(refresh?.minted_total ?? 0)} minted</Text>
              <Text style={S.dim2}>Your balance updates automatically.</Text>
            </View>
          ) : (
            <>
              {/* Complete, scannable instructions: network + asset + est. time + fee + min + the
                  one-line non-custody reassurance. All values come from `deposit_info` (never
                  hardcoded); the network/asset are single-sourced constants. */}
              <View testID="deposit-instructions" style={S.instrCard}>
                <Text style={S.instrLine}>
                  Send <Text style={S.instrAsset}>{DEPOSIT_ASSET}</Text> to your{' '}
                  <Text style={S.instrAsset}>{DEPOSIT_NETWORK}</Text> address below.
                </Text>
                <Text style={S.instrMeta}>
                  {required > 0 ? `~${required} confirmation${required === 1 ? '' : 's'}` : 'confirmations'}
                  {estMin > 0 ? ` · typically ~${estMin} min` : ''}
                </Text>
                <Text style={S.instrMeta}>
                  {`Network fee ${feeTxt ?? '—'}`}{minTxt != null ? ` · Min deposit ${minTxt}` : ''}
                </Text>
                <Text style={S.instrCustody}>
                  dpay never holds your keys — funds mint 1:1 to your wallet on confirmation.
                </Text>
              </View>

              <View style={S.qrCard}><QRCode value={address} size={200} ecl="L" /></View>

              <Text testID="deposit-address" style={S.sheetAddr} selectable={true}>{address}</Text>

              <Pressable testID="btn-deposit-copy" style={[S.primaryWide, S.depositCopy]} onPress={copy}>
                <Text style={S.primaryText}>{copied === 'clipboard' ? 'Copied ✓' : copied === 'shared' ? 'Shared ✓' : 'Copy address'}</Text>
              </Pressable>

              {/* ONE single linear progress cue (no dual zero-state): either "Waiting for your
                  deposit" (no pending utxos yet) or "Confirming · k/N". The manual "Check now"
                  button nudges the poll instead of relying solely on the 10s interval. The cue line
                  is normal-case (readable); only the "STATUS" label is the small uppercase tag. */}
              <View testID="deposit-status" style={S.depositStatus}>
                <Text style={S.depositStatusTitle}>Status</Text>
                <Text style={S.depositStatusMain}>
                  {pending.length > 0 ? `Confirming · ${maxConf}/${required || '?'}` : 'Waiting for your deposit'}
                </Text>
                <Text style={S.depositStatusRow}>
                  {pending.length > 0
                    ? `${pending.map(p => btc(p.value)).join(', ')} · ${required || '?'} confirmation${required === 1 ? '' : 's'} needed`
                    : `checking every ${DEPOSIT_REFRESH_MS / 1000}s`}
                </Text>
              </View>

              <Pressable
                testID="btn-deposit-check"
                style={[S.checkBtn, checkBusy && S.dim]}
                disabled={checkBusy}
                onPress={() => refreshNow(true)}>
                {checkBusy
                  ? <ActivityIndicator size="small" color={C.brand} />
                  : <Text style={S.checkBtnText}>Check now</Text>}
              </Pressable>

              {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const S = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg},
  centerAll: {alignItems: 'center', justifyContent: 'center'},
  onboard: {flex: 1, padding: 28, justifyContent: 'center', alignItems: 'center'},
  wordmark: {fontSize: 26, fontWeight: '800', letterSpacing: -0.8, color: C.ink},
  wordmarkPay: {color: C.brand},
  wordmarkBig: {fontSize: 34, marginTop: 18},
  brandBig: {fontSize: 44, fontWeight: '800', color: C.brand, textAlign: 'center'},
  onboardSub: {fontSize: 15, color: C.sub, textAlign: 'center', marginTop: 8, marginBottom: 40, paddingHorizontal: 12, lineHeight: 22},
  usernameInput: {backgroundColor: C.field, borderRadius: 14, height: 60, paddingHorizontal: 18, fontSize: 20, color: C.ink, marginBottom: 8, borderWidth: 1, borderColor: C.line2, alignSelf: 'stretch'},
  header: {paddingTop: 20, paddingHorizontal: 22, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottomWidth: 1, borderBottomColor: C.line},
  brand: {fontSize: 24},
  who: {fontSize: 12, color: C.sub, marginTop: 2},
  nfcPill: {flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6, alignSelf: 'flex-start', backgroundColor: C.field, borderRadius: 12, paddingHorizontal: 9, height: 22},
  nfcLabel: {fontSize: 12, fontWeight: '600', color: C.sub},
  nfcBadge: {width: 108, height: 108, borderRadius: 54, borderWidth: 4, borderColor: C.line, alignItems: 'center', justifyContent: 'center', marginBottom: 26},
  nfcGlyph: {fontSize: 54, fontWeight: '700', lineHeight: 62},
  nfcTitle: {fontSize: 24, fontWeight: '800', color: C.ink, textAlign: 'center'},
  nfcSub: {fontSize: 15, color: C.sub, marginTop: 10, textAlign: 'center', paddingHorizontal: 20},
  balBox: {alignItems: 'flex-end'},
  balLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 5},
  demoPill: {backgroundColor: 'rgba(62,224,172,0.12)', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1, marginLeft: 2},
  demoPillText: {fontSize: 9, fontWeight: '800', color: C.brand, letterSpacing: 0.5},
  balAmtRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  topUpBtn: {borderWidth: 1, borderColor: C.brand, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5},
  topUpText: {fontSize: 13, fontWeight: '700', color: C.brand},
  topUpErr: {fontSize: 10, color: C.bad, marginTop: 3, textAlign: 'right'},
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
  camBox: {width: 250, height: 250, borderRadius: 20, overflow: 'hidden', backgroundColor: '#0a0d11', borderWidth: 1, borderColor: C.line},
  camPlaceholder: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  reviewAmount: {fontSize: 30, fontWeight: '800', color: C.ink, textAlign: 'center'},
  reviewTo: {fontSize: 17, color: C.ink, marginTop: 6, textAlign: 'center'},
  reviewReq: {fontSize: 12, color: C.sub, fontFamily: 'monospace', marginTop: 6, marginBottom: 24},
  warnNote: {fontSize: 13, color: C.warn, textAlign: 'center', marginTop: -10, marginBottom: 18, paddingHorizontal: 8, lineHeight: 18},
  primary: {backgroundColor: C.brand, borderRadius: 14, height: 56, minWidth: 240, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center', marginTop: 12, shadowColor: C.brand, shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: {width: 0, height: 8}, elevation: 8},
  primaryWide: {backgroundColor: C.brand, borderRadius: 14, height: 56, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', marginTop: 20, shadowColor: C.brand, shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: {width: 0, height: 8}, elevation: 8},
  primaryText: {color: C.brandInk, fontSize: 18, fontWeight: '700'},
  qrCard: {backgroundColor: '#ffffff', padding: 16, borderRadius: 18, borderWidth: 1, borderColor: C.line, marginBottom: 16},
  amountBig: {fontSize: 24, fontWeight: '800', color: C.ink, textAlign: 'center'},
  badgeOk: {marginTop: 10, fontSize: 13, fontWeight: '600', color: C.brand, backgroundColor: 'rgba(62,224,172,0.12)', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, overflow: 'hidden'},
  qrHint: {marginTop: 16, fontSize: 13, color: C.sub, textAlign: 'center'},
  confirmRow: {flexDirection: 'row', gap: 12, marginTop: 12},
  paidBtn: {backgroundColor: C.ok, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 24},
  paidBtnText: {color: C.brandInk, fontWeight: '700', fontSize: 16},
  notPaidBtn: {backgroundColor: C.field, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 24},
  notPaidText: {color: C.sub, fontWeight: '600', fontSize: 16},
  check: {width: 92, height: 92, borderRadius: 46, backgroundColor: C.ok, alignItems: 'center', justifyContent: 'center', marginBottom: 18, shadowColor: C.ok, shadowOpacity: 0.4, shadowRadius: 18, shadowOffset: {width: 0, height: 8}, elevation: 8},
  checkAlready: {backgroundColor: C.warn, shadowColor: C.warn},
  checkMark: {color: C.brandInk, fontSize: 50, fontWeight: '700'},
  paidText: {fontSize: 30, fontWeight: '800', color: C.ok},
  alreadyText: {color: C.warn},
  paidSub: {fontSize: 16, color: C.sub, marginTop: 6},
  amountRow: {flexDirection: 'row', alignItems: 'center', backgroundColor: C.field, borderRadius: 14, paddingHorizontal: 18, height: 76, alignSelf: 'stretch', borderWidth: 1, borderColor: C.line2},
  currency: {fontSize: 36, fontWeight: '700', color: C.ink},
  amountInput: {flex: 1, fontSize: 36, fontWeight: '700', color: C.ink, marginLeft: 6},
  linkBtn: {marginTop: 18},
  linkText: {color: C.brand, fontWeight: '600', fontSize: 16},
  linkTextMuted: {color: C.sub, fontWeight: '600', fontSize: 15},
  smallBtn: {backgroundColor: C.brand, borderRadius: 10, paddingHorizontal: 16, height: 44, alignItems: 'center', justifyContent: 'center', shadowColor: C.brand, shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: {width: 0, height: 6}, elevation: 6},
  smallBtnText: {color: C.brandInk, fontWeight: '700'},
  histCard: {marginTop: 28, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 14},
  histTitle: {fontSize: 12, fontWeight: '700', color: C.sub2, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 6, fontFamily: 'monospace'},
  histRow: {flexDirection: 'row', alignItems: 'baseline', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line2},
  histWho: {flex: 1, fontSize: 15, color: C.ink},
  histAmt: {fontSize: 15, fontWeight: '700', marginRight: 12, fontFamily: 'monospace'},
  histTime: {fontSize: 12, color: C.sub2, fontFamily: 'monospace'},
  // ckBTC asset card — a DISTINCT, clearly-labeled asset (not the `$` balance). Same card chrome as
  // the deposit status block so it reads as a related-but-separate asset affordance. The brand-tinted
  // left edge + "Bitcoin" label + BTC units make it unambiguously NOT the DEMO_USD `$` header.
  assetCard: {marginTop: 28, alignSelf: 'stretch', backgroundColor: C.card, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: C.line2, borderLeftColor: C.brand, borderLeftWidth: 3},
  assetRow: {flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between'},
  assetLabel: {fontSize: 16, fontWeight: '700', color: C.ink},
  assetAmt: {fontSize: 16, fontWeight: '700', color: C.brand, fontFamily: 'monospace'},
  assetSub: {fontSize: 12, color: C.sub2, marginTop: 6},
  settings: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 22, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.line},
  settingsLabel: {fontSize: 12, fontWeight: '700', color: C.sub2, textTransform: 'uppercase', letterSpacing: 1, fontFamily: 'monospace'},
  settingsInput: {flex: 1, fontSize: 12, color: C.ink, fontFamily: 'monospace', paddingVertical: 4},
  resetLink: {fontSize: 12, color: C.bad, fontWeight: '600'},
  // The PRIMARY funding affordance in the balance header: a clear "Add money" brand button that
  // opens the deposit sheet. Filled brand so it reads as primary; the DEMO_USD faucet (topUpBtn)
  // is the secondary outline pill beside it.
  addMoneyBtn: {backgroundColor: C.brand, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, shadowColor: C.brand, shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: {width: 0, height: 6}, elevation: 6},
  addMoneyBtnText: {fontSize: 13, fontWeight: '800', color: C.brandInk},
  // Deposit sheet — a full-screen overlay above the wallet.
  sheetOverlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.bg, zIndex: 10},
  sheet: {flex: 1, backgroundColor: C.bg},
  sheetHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 20, paddingHorizontal: 22, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: C.line},
  sheetTitle: {fontSize: 20, fontWeight: '800', color: C.ink},
  sheetClose: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: C.field},
  sheetCloseX: {fontSize: 16, fontWeight: '700', color: C.sub},
  sheetBody: {flexGrow: 1, paddingHorizontal: 22, paddingTop: 22, alignItems: 'center'},
  // Deposit instructions — a scannable card (network/asset + est. time + fee/min + non-custody line).
  instrCard: {alignSelf: 'stretch', backgroundColor: C.card, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: C.line2, marginBottom: 18},
  instrLine: {fontSize: 15, color: C.ink, textAlign: 'center', lineHeight: 21, marginBottom: 10},
  instrAsset: {color: C.brand, fontWeight: '700'},
  instrMeta: {fontSize: 13, color: C.sub, textAlign: 'center', fontFamily: 'monospace', paddingVertical: 2},
  instrCustody: {fontSize: 12, color: C.sub2, textAlign: 'center', marginTop: 10, lineHeight: 17},
  sheetAddr: {fontSize: 13, color: C.ink, fontFamily: 'monospace', textAlign: 'center', marginTop: 4, marginBottom: 8, letterSpacing: 0.2},
  depositCopy: {alignSelf: 'stretch', marginTop: 12},
  depositStatus: {marginTop: 22, alignSelf: 'stretch', backgroundColor: C.card, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: C.line2},
  depositStatusTitle: {fontSize: 12, fontWeight: '700', color: C.sub2, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 6, fontFamily: 'monospace'},
  depositStatusMain: {fontSize: 16, fontWeight: '700', color: C.ink, marginBottom: 4},
  depositStatusRow: {fontSize: 13, color: C.sub, fontFamily: 'monospace'},
  // Manual "Check now" — secondary (outline brand), debounced + spinner while in-flight.
  checkBtn: {marginTop: 16, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 24, borderWidth: 1, borderColor: C.brand, alignItems: 'center', justifyContent: 'center', height: 46},
  checkBtnText: {color: C.brand, fontWeight: '700', fontSize: 15},
});
