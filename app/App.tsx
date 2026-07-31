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
import {encodeApprove, encodeDepositErc20, principalToBytes32} from './cketh';
import {getEthereumProvider, connectWallet, sendTransaction} from './wallet';
import {C} from './config/palette';
import type {
  DpayNfcApi, NfcEvent, NfcPhaseName, Req, Identity, Txn, TransactionsRow, DpayCoreApi, NfcStatus,
} from './lib/types';
import {
  usd, short, MINT_HEX, isMintSentinel, fmtTime, nowSecs, randNonceHex, toCents, toSats, base,
  parseRequestQR, fmtAsset,
} from './lib/format';
import {
  EXPIRY_WINDOW, DIRECT_PAY_TIMEOUT_MS, NFC_PAY_TIMEOUT_MS, RECONCILE_ATTEMPTS, RECONCILE_INTERVAL_MS,
  RECEIPT_WAIT_MS, STORAGE_KEY, RELAY_STORAGE_KEY, POLL, WITHDRAW_TIMEOUT_MS, WITHDRAW_EXPIRY_WINDOW,
} from './config/constants';

const {DpayCore, DpayNfc} = NativeModules as {DpayCore: DpayCoreApi; DpayNfc: DpayNfcApi};

// R2: verify a settled receipt's canister/ledger Ed25519 signature before trusting the outcome.
// Returns true only if `receipt_sig` verifies under `pubkey` over the canonical ReceiptClaim built
// from the receipt's fields. A merchant/relay cannot forge this; an unverifiable receipt is treated
// as UNKNOWN (honest, never a fake "Paid ✓"). The nonce match is enforced by the caller.
async function verifyOutcomeReceipt(receipt: any): Promise<boolean> {
  const sigHex = receipt?.receipt_sig;
  const pubHex = receipt?.pubkey;
  if (typeof sigHex !== 'string' || typeof pubHex !== 'string') return false;
  try {
    return await DpayCore.verifyReceiptSig(
      String(receipt.nonce), String(receipt.from), String(receipt.to),
      Number(receipt.amount), Number(receipt.currency),
      Number(receipt.block_index), Number(receipt.settle_ts),
      sigHex, pubHex,
    );
  } catch {
    return false;
  }
}

// --- ck-deposit (ckBTC-style top-up) --------------------------------------------------------
type DepositInfo = {min_confirmations: number; deposit_fee: number; deposit_min_amount: number | null};
type MintedUtxo = {block_index: string; amount: number};
type PendingUtxo = {value: number; confirmations: number};
type DepositRefresh = {minted_total: number; minted: MintedUtxo[]; pending: PendingUtxo[]; required_confirmations: number};

// --- currency catalog (M0) -------------------------------------------------------------------
// The wallet's runtime source of truth for which assets exist + how to display/fund them. Fetched
// from GET /api/v1/currencies (the canister's currencies() catalog), cached in AsyncStorage, with a
// bundled default fallback so the UI renders on a cold/offline first load. Closes issue #7: the
// ckBTC currency id is RESOLVED from the catalog (the CkBtcUtxo entry) instead of the old hardcoded
// `DEPOSIT_CURRENCY = 1`, so adding a currency is canister-config-only (no app redeploy).
type MinterFamily = 'CkBtcUtxo' | 'CkEthErc20' | 'CkSol';
type CurrencyDescriptor = {
  currency: number;          // the Currency u32 — read from the catalog, NEVER hardcoded
  ledger: string;            // ICRC ledger principal as text
  mintable: boolean;         // true for the demo currency the facade mints/burns
  minter: string | null;     // ramp (ck minter) principal as text, or null (no deposit/withdraw path)
  minter_family: MinterFamily | null;
  symbol: string | null;     // display symbol ("$", "₿", "Ξ")
  decimals: number | null;   // smallest-unit decimal count (USD=2, BTC=8)
};
const CATALOG_CACHE_KEY = 'dpay.currencies.v1';
// Bundled fallback so a cold/offline first load still renders. Overwritten by the live catalog on
// the first successful fetch. Mirrors the canister's demo deployment (DEMO_USD + ckBTC). The ledger
// principals are empty here (the wallet reads currency/symbol/decimals/minter_family for display;
// the relay resolves ledgers server-side from the query's currency id).
const BUNDLED_CATALOG: CurrencyDescriptor[] = [
  {currency: 0, ledger: '', mintable: true, minter: null, minter_family: null, symbol: '$', decimals: 2},
  {currency: 1, ledger: '', mintable: false, minter: 'mqygn-kiaaa-aaaar-qaadq-cai', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8},
  {currency: 2, ledger: 'xevnm-gaaaa-aaaar-qafnq-cai', mintable: false, minter: 'sv3dd-oaaaa-aaaar-qacoa-cai', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6},
];
// Fetch the catalog from the relay, caching to AsyncStorage. Best-effort: on any failure (offline,
// timeout, bad JSON) returns `prior` (the cache or bundled default) so the UI never blocks on it.
// Timeout-bound like every other fetch.
async function fetchCurrencies(relayUrl: string, prior: CurrencyDescriptor[]): Promise<CurrencyDescriptor[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(`${base(relayUrl)}/api/v1/currencies`, {signal: ctrl.signal});
    if (!r.ok) return prior;
    const j = await r.json();
    const list: unknown = j?.currencies;
    if (!Array.isArray(list) || list.length === 0) return prior;
    const clean: CurrencyDescriptor[] = list
      .filter((c: any): c is Record<string, unknown> => !!c && typeof c.currency === 'number')
      .map((c: any) => ({
        currency: c.currency as number,
        ledger: typeof c.ledger === 'string' ? c.ledger : '',
        mintable: !!c.mintable,
        minter: typeof c.minter === 'string' ? c.minter : null,
        minter_family: (typeof c.minter_family === 'string' ? c.minter_family : null) as MinterFamily | null,
        symbol: typeof c.symbol === 'string' ? c.symbol : null,
        decimals: typeof c.decimals === 'number' ? c.decimals : null,
      }));
    if (clean.length === 0) return prior;
    AsyncStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(clean)).catch(() => {});
    return clean;
  } catch { return prior; } finally { clearTimeout(t); }
}

// Per-minter-family display + rail config. Single-sources the old per-asset literals
// (DEPOSIT_NETWORK/DEPOSIT_ASSET/BTC_BLOCK_MIN/WITHDRAW_MIN_SATS): every asset of a given family
// shares the same native chain, so the chain/rail metadata lives HERE keyed by minter_family, not
// per-currency and not hardcoded inside the sheets. Adding a new family (e.g. CkEthErc20) = one entry.
type FamilyDisplay = {
  networkLabel: string;       // chain name shown in instructions + the asset card label ('Bitcoin')
  nativeAsset: string;        // the asset the user sends on that chain; also the amount-unit suffix ('BTC')
  blockMin: number;           // avg native-chain block time (min) → est. time-to-credit
  withdrawMinRaw: number;     // raw smallest-unit floor for offramp (mirrors the minter's min)
  amountDecimals: number;     // decimal count for amount formatting (BTC=8)
  addressPlaceholder: string; // native-chain address placeholder ('bc1q…')
};
const FD_CKBTC: FamilyDisplay = {
  networkLabel: 'Bitcoin', nativeAsset: 'BTC', blockMin: 10,
  withdrawMinRaw: 50_000, amountDecimals: 8, addressPlaceholder: 'bc1q…',
};
// ckERC-20 (ckUSDC etc.): the onramp is a wallet-connect contract-call flow (NOT a per-principal
// address) — see CkErc20DepositSheet. These display fields still drive the asset card + amounts.
const FD_CKETH_ERC20: FamilyDisplay = {
  networkLabel: 'Ethereum', nativeAsset: 'USDC', blockMin: 1,
  withdrawMinRaw: 0, amountDecimals: 6, addressPlaceholder: '0x…',
};
const FAMILY_DISPLAY: Partial<Record<MinterFamily, FamilyDisplay>> = {CkBtcUtxo: FD_CKBTC, CkEthErc20: FD_CKETH_ERC20};
// Resolve a currency's family display from the catalog; falls back to the ckBTC config so the flows
// always render (the catalog guarantees the CkBtcUtxo entry carries its family).
function familyDisplay(catalog: CurrencyDescriptor[], currency: number): FamilyDisplay {
  const f = catalog.find(c => c.currency === currency)?.minter_family ?? null;
  return (f ? FAMILY_DISPLAY[f] : null) ?? FD_CKBTC;
}
// A stable ASCII key for an asset's testID (the catalog symbol may be a non-ASCII glyph like ₿).
// ckBTC keeps 'ckbtc' to honour the existing e2e testID contract; other assets use their symbol.
function assetTestKey(a: CurrencyDescriptor): string {
  if (a.minter_family === 'CkBtcUtxo') return 'ckbtc';
  return (a.symbol ?? familyDisplay([], a.currency).nativeAsset ?? 'asset').toLowerCase();
}
// Format raw smallest-units as a decimal amount + unit suffix (e.g. sats → "0.00012345 BTC").
// Generalizes the old btc() so any family's amounts render from its config — no per-asset literals.
function fmtAsset(raw: number, decimals: number, unit: string): string {
  const n = Math.max(0, Math.floor(raw));
  const div = 10 ** decimals;
  return `${Math.floor(n / div)}.${String(n % div).padStart(decimals, '0')} ${unit}`;
}

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

// ckERC-20 onramp params (helper contract, ERC-20 address, facade principal) for a CkEthErc20-family
// currency. The app builds the user's two Ethereum transactions from these (cketh.ts); the user signs
// in their own wallet (non-custodial). Errors throw with the status (503 = no ckERC-20 onramp for the
// currency / relay unreachable).
type CkErc20OnrampParams = {helper_address: string; erc20_address: string; facade_principal: string};
async function ckerc20OnrampParams(relayUrl: string, currency: number, signal?: AbortSignal): Promise<CkErc20OnrampParams> {
  const r = await fetch(`${base(relayUrl)}/api/v1/onramp/ckerc20?currency=${currency}`, {signal});
  if (!r.ok) throw new Error(`onramp/ckerc20 ${r.status}`);
  return r.json();
}

// Withdraw a ckBTC balance to a native BTC address. The app signs the WithdrawAuth on-device (the
// sig is the non-custodial gate); the relay forwards to the facade's `withdraw`. Returns the burn
// receipt (block_index). Errors throw with the status so the sheet can surface a decline vs offline.
type WithdrawReceipt = {from: string; destination: string; amount: number; nonce: string; currency: number; block_index: number};

// Saved last-used withdrawal destination, one per currency (Fork-B: NUTS-simple offramp — a returning
// user re-cashes-out without re-pasting their external address). Best-effort AsyncStorage; never blocks.
const withdrawAddrKey = (currency: number) => `dpay.withdraw.addr.${currency}`;
async function loadSavedWithdrawAddr(currency: number): Promise<string | null> {
  try { return await AsyncStorage.getItem(withdrawAddrKey(currency)); } catch { return null; }
}
async function saveWithdrawAddr(currency: number, addr: string): Promise<void> {
  try { await AsyncStorage.setItem(withdrawAddrKey(currency), addr); } catch { /* best-effort */ }
}

async function withdrawFunds(relayUrl: string, accountHex: string, btcAddress: string, amountSats: number, nonceHex: string, expiry: number, currency: number, sigHex: string, signal?: AbortSignal): Promise<WithdrawReceipt> {
  const r = await fetch(`${base(relayUrl)}/api/v1/withdraw`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({from: accountHex, destination: btcAddress, amount: amountSats, nonce: nonceHex, expiry, currency, sig: sigHex}),
    signal,
  });
  const j = await r.json().catch(() => ({} as any));
  if (r.ok && j?.receipt) {
    return j.receipt as WithdrawReceipt;
  }
  // A 422 carries a policy error (bad sig / expired / below min / insufficient / nonce reused); a
  // 503 is a transient ledger hiccup. Surface the body's error string so the sheet can show WHY.
  throw new Error(typeof j?.error === 'string' ? j.error : `withdraw ${r.status}`);
}

// Parse a user-entered BTC amount (decimal string) into integer satoshis. Mirrors `toCents` for `$`.
// NaN/negative → 0; the sheet gates the review on > 0 + >= the min withdrawal floor.
function toSats(s: string): number { const n = Math.round(parseFloat(s || '0') * 1e8); return Number.isFinite(n) && n > 0 ? n : 0; }

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
 * Web-only keyboard-shortcut surface — the single source of truth for keyboard wiring. Attaches ONE
 * real DOM `keydown` listener (web only; native has no physical keyboard, and Android uses the
 * hardware Back button which is handled separately) and dispatches `e.key` (lower-cased) to the
 * matching handler in `handlers`.
 *
 *   - `ignoreIfInputFocused`: when set, a key pressed while an INPUT/TEXTAREA is focused is ignored
 *     (so typing into the amount/address/username fields never trips a shortcut). Escape is exempt
 *     — it should close a sheet even with a field focused (universal dialog-dismiss behaviour).
 *   - `enabled`: when false the listener is not attached at all (e.g. the wallet main-view actions
 *     are suspended while any sheet/overlay covers the screen).
 *
 * Plan flow 14 / UX-V5: `useEscapeToClose` delegates here with `{escape: onClose}`; the wallet's
 * P/R/T/A actions pass both options. Uses `globalThis` + a structural key type so it typechecks
 * without the DOM lib (RN's tsconfig ships no DOM types). `handlers`/`opts` are caller-inline
 * closures (recreated each render) so the effect re-subscribes per render — one cheap add/remove,
 * matching the prior `useEscapeToClose` behaviour.
 */
function useHotkeys(handlers: Record<string, () => void>, opts?: {ignoreIfInputFocused?: boolean; enabled?: boolean}): void {
  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    if (opts?.enabled === false) {
      return;
    }
    type HasKey = {key: string};
    const g = globalThis as unknown as {
      addEventListener?: (type: string, fn: (e: HasKey) => void) => void;
      removeEventListener?: (type: string, fn: (e: HasKey) => void) => void;
    };
    if (typeof g.addEventListener !== 'function') {
      return;
    }
    const doc = globalThis as unknown as {document?: {activeElement?: {tagName?: string}}};
    const onKey = (e: HasKey) => {
      if (opts?.ignoreIfInputFocused) {
        const tag = doc.document?.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          return;
        }
      }
      const fn = handlers[(e.key ?? '').toLowerCase()];
      if (fn) {
        fn();
      }
    };
    g.addEventListener('keydown', onKey);
    return () => { g.removeEventListener?.('keydown', onKey); };
  }, [handlers, opts]);
}

/**
 * Escape closes an open sheet/modal — the seed keyboard affordance (plan flow 14). Thin wrapper over
 * `useHotkeys`; deliberately carries NO input guard so Escape dismisses a sheet even when a field is
 * focused (the universal dialog-dismiss behaviour).
 */
function useEscapeToClose(onClose: () => void): void {
  useHotkeys({escape: onClose});
}

/**
 * Read text from the system clipboard when available (for the Pay "paste request" fallback — N10).
 * Web uses navigator.clipboard.readText; native would use @react-native-clipboard/clipboard (not
 * bundled, so the Share path is the fallback). Returns null on any failure (permission denied, no
 * clipboard API, empty clipboard).
 */
async function readFromClipboard(): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      const clip = (globalThis as {navigator?: {clipboard?: {readText?: () => Promise<string>}}}).navigator?.clipboard;
      if (clip && typeof clip.readText === 'function') {
        return await clip.readText();
      }
    } catch (e) {
      console.warn('[dpay] clipboard read failed:', String(e));
    }
  }
  return null;
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

  // Load identity + the persisted relay URL on mount. Both live in AsyncStorage; the relay URL
  // defaults to `relayConfig`'s value (the ?relay= override in the harness, or the codegen'd prod
  // URL) when no persisted choice exists yet.
  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(RELAY_STORAGE_KEY),
    ])
      .then(([idV, relayV]) => {
        setIdentity(idV ? JSON.parse(idV) : null);
        if (typeof relayV === 'string' && relayV.length > 0) setRelayUrl(relayV);
      })
      .catch((e: any) => {
        // No silent errors: log with context, then fall back to a safe empty identity.
        console.log(`[dpay] failed to load identity/relay: ${e?.message ?? e}`);
        setIdentity(null);
      });
  }, []);

  // Set the relay URL AND persist it (best-effort; a persist failure is logged, never swallowed).
  // This is the single mutator SettingsSheet's input binds to, so every edit endures across reloads.
  const persistRelay = useCallback((url: string) => {
    setRelayUrl(url);
    AsyncStorage.setItem(RELAY_STORAGE_KEY, url).catch((e: any) => {
      console.log(`[dpay] failed to persist relay URL: ${e?.message ?? e}`);
    });
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
  return <Wallet identity={identity} relayUrl={relayUrl} setRelayUrl={persistRelay} onReset={onReset} />;
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
      // Bounded by a 4s timeout so a hanging/dead relay can't stall onboarding (fail fast → $0, fund later).
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
        try {
          await fetch(`${base(relayUrl)}/api/v1/faucet`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({account: id.publicHex}), signal: ctrl.signal});
        } finally { clearTimeout(t); }
      } catch { /* offline/timeout: created with $0, can be funded later */ }
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
        <TextInput testID="username-input" style={S.usernameInput} value={username} onChangeText={setUsername} placeholder="e.g. Alice" placeholderTextColor={C.sub2} autoCapitalize="words" autoCorrect={false} onSubmitEditing={busy ? undefined : create} />
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
        // Non-primary (ramp) assets — each is a SEPARATE asset on a separate ledger, polled in
        // parallel on the same cadence and rendered as its own clearly-labeled card (never merged into
        // the `$` header, which is DEMO_USD only per CLAUDE.md's hard rule). Balances are keyed by the
        // currency id resolved from the runtime catalog (so adding an asset = config-only). A null/0
        // entry means "not yet funded" — ramp asset cards render only when their balance is non-zero.
  const [assetBalances, setAssetBalances] = useState<Record<number, number>>({});
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
  // Asset picker + per-currency deposit/withdraw sheets. `?screen=deposit` deep-links to the primary
  // CkBtcUtxo ramp (bookmarkable). The header "Add money" button opens the picker when >1 onrampable
  // asset exists, else goes straight to the ckBTC sheet.
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  // Currency catalog — the runtime source of truth for which assets exist + how to display/fund
  // them. Loaded from AsyncStorage cache then refreshed from GET /currencies on mount; the bundled
  // default covers a cold first load. The ckBTC currency id (and any future asset's) is RESOLVED
  // from this, never hardcoded (issue #7).
  const [catalog, setCatalog] = useState<CurrencyDescriptor[]>(BUNDLED_CATALOG);

  const TOP_UP_CENTS = 10_000; // mirrors the canister's fixed FAUCET_AMOUNT ($100.00)

  // ckBTC currency id, resolved from the catalog (find the CkBtcUtxo-family entry). Falls back to
  // 1 only before the catalog loads (the bundled default already carries currency 1 as CkBtcUtxo).
  const ckBtcCurrency = useMemo(
    () => catalog.find(c => c.minter_family === 'CkBtcUtxo')?.currency ?? 1,
    [catalog],
  );
  // Which asset's deposit/withdraw sheet is open (null = closed). Set by the asset picker / asset
  // cards. The sheet rendered is chosen by the currency's minter_family (DepositSheet vs
  // CkErc20DepositSheet). The `?screen=deposit` deep link seeds the ckBTC ramp on mount.
  const [depositCurrency, setDepositCurrency] = useState<number | null>(readDepositDeepLink() ? ckBtcCurrency : null);
  const [withdrawCurrency, setWithdrawCurrency] = useState<number | null>(null);
  // The catalog's onrampable (ramp) assets: non-primary currencies that carry a minter_family.
  const rampAssets = useMemo(() => catalog.filter(c => c.minter_family), [catalog]);
  // Stable comma-joined id list for the balance-poll effect deps (avoids re-running the poll on
  // every catalog array identity change; only re-runs when the actual set of ramp currencies changes).
  const rampCurrencyIds = useMemo(() => rampAssets.map(a => a.currency).join(','), [rampAssets]);

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

  // Load the currency catalog: AsyncStorage cache first (instant), then refresh from the relay.
  // Re-runs when the relay URL changes (a relay switch may expose a different asset set).
  useEffect(() => {
    let alive = true;
    (async () => {
      let prior = BUNDLED_CATALOG;
      try {
        const cached = await AsyncStorage.getItem(CATALOG_CACHE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length) { prior = parsed as CurrencyDescriptor[]; if (alive) setCatalog(prior); }
        }
      } catch { /* cache miss is fine — the bundled default + live fetch cover it */ }
      const fresh = await fetchCurrencies(relayUrl, prior);
      if (alive && fresh !== prior) setCatalog(fresh);
    })();
    return () => { alive = false; };
  }, [relayUrl]);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      // Non-primary (ramp) asset balances run in PARALLEL + best-effort, each with its own
      // AbortController, so a hiccup on one asset's ledger can never flip the primary `$` balance
      // offline or fail its poll. The assets live on separate ledgers — fetching one must not affect
      // another's display. A null result keeps the prior value (no flap on a single miss).
      const rampFetches = rampAssets.map(a => {
        const c = new AbortController();
        const to = setTimeout(() => c.abort(), 4000);
        return fetch(`${base(relayUrl)}/api/v1/balance/${identity.publicHex}?currency=${a.currency}`, {signal: c.signal})
          .then(r => r.ok ? r.json().catch(() => null) : null)
          .then(j => (j && typeof j.balance === 'number') ? (j.balance as number) : null)
          .catch(() => null)
          .finally(() => clearTimeout(to))
          .then(b => ({currency: a.currency, balance: b}));
      });
      try {
        const r = await fetch(`${base(relayUrl)}/api/v1/balance/${identity.publicHex}`, {signal: ctrl.signal});
        const j = await r.json();
        if (alive && r.ok && typeof j.balance === 'number') { setBalance(j.balance); setOnline(true); setOfflineSpent(0); }
        else if (alive) setOnline(false);
      } catch { if (alive) setOnline(false); } finally { clearTimeout(t); }
      // Settle the ramp balances after the primary poll resolves; merge keeping prior on null.
      const results = await Promise.all(rampFetches);
      if (alive) {
        setAssetBalances(prev => {
          const next = {...prev};
          for (const {currency, balance} of results) if (balance != null) next[currency] = balance;
          return next;
        });
      }
    };
    poll(); const id = setInterval(poll, POLL.balance);
    return () => { alive = false; clearInterval(id); };
  }, [relayUrl, identity.publicHex, rampCurrencyIds]);

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
          const counterparty = dir === 'out' ? rec.to.toLowerCase() : rec.from.toLowerCase();
          const who = isMintSentinel(counterparty)
            ? (dir === 'in' ? 'Demo funds' : 'Withdrawal')
            : short(dir === 'out' ? rec.to : rec.from);
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
    const id = setInterval(wrapped, POLL.history);
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
        // N5: surface the relay/canister's real reason (e.g. "faucet cooldown: try again in ~58 min")
        // rather than a generic "Faucet unavailable". The canister returns the retry time; showing it
        // tells the user WHEN to retry instead of leaving them guessing.
        const reason = typeof j?.error === 'string' && j.error.length > 0 ? j.error : null;
        setTopUpErr(reason ?? (r.ok ? 'Top-up failed' : 'Faucet unavailable'));
      }
    } catch {
      setTopUpErr('Offline — try again when connected');
    } finally {
      clearTimeout(t);
      setTopUpBusy(false);
    }
  }, [topUpBusy, relayUrl, identity.publicHex]);

  // The "Add money" entry (header button + the `A` shortcut share ONE handler — single source of
  // truth): open the asset picker when >1 onrampable asset exists, else go straight to the ckBTC
  // deposit sheet.
  const addMoney = useCallback(() => {
    if (rampAssets.length > 1) {
      setPickerOpen(true);
    } else {
      setDepositCurrency(ckBtcCurrency);
    }
  }, [rampAssets.length, ckBtcCurrency]);

  // Web keyboard shortcuts (plan 1b / UX-V5): the first letters of the main actions —
  // P=Pay, R=Receive, T=Top-up (demo money), A=Add money. Active ONLY on the wallet main view with
  // no text input focused and no sheet/overlay open (Esc is handled per-sheet by useEscapeToClose).
  // Native (no physical keyboard) is a no-op; the matching on-UI hints are also web-only.
  const anySheetOpen = pickerOpen || depositCurrency != null || withdrawCurrency != null || settingsOpen;
  useHotkeys({
    p: () => setMode('pay'),
    r: () => setMode('receive'),
    t: topUp,
    a: addMoney,
  }, {ignoreIfInputFocused: true, enabled: !anySheetOpen});

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
            {/* T = add demo money (the faucet). The hint rides the DEMO pill since that's what T
                tops up; on touch this badge is hidden (no keyboard on the phone). */}
            <HotkeyHint k="T" />
          </View>
          <View style={S.balAmtRow}>
            <Text testID="balance" style={S.balAmt}>{shownBalance == null ? '—' : `${online ? '' : '~'}${usd(shownBalance)}`}</Text>
            {/* The PRIMARY onramp affordance: a real chain-key deposit. Opens the deposit flow for the
                catalog-resolved CkBtcUtxo asset. The offramp ("Cash out") lives on the asset card — it's
                contextual (only meaningful when you hold a cashable asset), so it appears exactly when a
                topped-up balance exists, and is absent for demo-$-only wallets that have nothing to cash
                out. A 390px header can't hold the balance + two action buttons without overflow, so the
                single "Add money" pill stays here and "Cash out" rides the asset card. */}
            <Pressable testID="btn-deposit" style={S.addMoneyBtn} onPress={addMoney}>
              <Text style={S.addMoneyBtnText}>＋ Add money</Text>
              <HotkeyHint k="A" tone="onBrand" />
            </Pressable>
          </View>
        </View>
      </View>

      <View style={S.tabs}>
        <Tab label="Pay" active={mode === 'pay'} onPress={() => setMode('pay')} hotkey="P" />
        <Tab label="Receive" active={mode === 'receive'} onPress={() => setMode('receive')} hotkey="R" />
      </View>

      <ScrollView contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        {mode === 'pay'
          ? <PayMode identity={identity} online={online} relayUrl={relayUrl} nfcReady={nfc === 'ready'} onSettled={onActivity} onOfflinePaid={markOfflinePaid} shownBalance={shownBalance} />
          : <ReceiveMode identity={identity} relayUrl={relayUrl} nfcReady={nfc === 'ready'} onReceived={onActivity} />}
        {/* Ramp asset cards — each is a SEPARATE asset on a separate ledger (currency N>0), shown
            only when non-zero so a topped-up wallet keeps its credited asset VISIBLE after the deposit
            sheet closes, and an unfunded wallet isn't cluttered with empty cards (e2e 05 asserts
            asset cards stay hidden at 0). Deliberately distinct from the `$` header (DEMO_USD): each
            card shows the family's network label + native-asset units, resolved from the catalog via
            FAMILY_DISPLAY. "Cash out" appears only for families with an offramp (CkBtcUtxo today). */}
        {rampAssets.map(a => {
          const bal = assetBalances[a.currency] ?? 0;
          if (bal <= 0) return null;
          const disp = familyDisplay(catalog, a.currency);
          const testKey = assetTestKey(a);
          return (
            <View key={a.currency} testID={`asset-${testKey}`} style={S.assetCard}>
              <View style={S.assetRow}>
                <Text style={S.assetLabel}>{disp.networkLabel}</Text>
                <Text style={S.assetAmt}>{fmtAsset(bal, disp.amountDecimals, disp.nativeAsset)}</Text>
              </View>
              <Text style={S.assetSub}>{`your deposited ${disp.networkLabel} · spendable where a merchant requests it`}</Text>
              <View style={S.assetActions}>
                <Pressable testID={`asset-add-${testKey}`} style={S.assetActionBtn} onPress={() => setDepositCurrency(a.currency)}>
                  <Text style={S.assetActionText}>＋ Add</Text>
                </Pressable>
                {a.minter_family === 'CkBtcUtxo' ? (
                  <Pressable testID="btn-withdraw" style={S.withdrawLink} onPress={() => setWithdrawCurrency(a.currency)}>
                    <Text style={S.withdrawLinkText}>Cash out</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          );
        })}
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

      <View style={S.settingsBar}>
        <Pressable testID="btn-settings" style={S.settingsLinkBtn} onPress={() => setSettingsOpen(true)}>
          <Text style={S.settingsLink}>⚙ Settings</Text>
        </Pressable>
      </View>

      {pickerOpen ? (
        <AssetPickerSheet
          rampAssets={rampAssets}
          catalog={catalog}
          onPick={(currency) => { setDepositCurrency(currency); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
      {depositCurrency != null ? (
        catalog.find(c => c.currency === depositCurrency)?.minter_family === 'CkEthErc20'
          ? <CkErc20DepositSheet identity={identity} relayUrl={relayUrl} currency={depositCurrency} display={familyDisplay(catalog, depositCurrency)} onClose={() => setDepositCurrency(null)} />
          : <DepositSheet identity={identity} relayUrl={relayUrl} currency={depositCurrency} display={familyDisplay(catalog, depositCurrency)} onClose={() => setDepositCurrency(null)} />
      ) : null}
      {withdrawCurrency != null ? (
        <WithdrawSheet
          identity={identity}
          relayUrl={relayUrl}
          currency={withdrawCurrency}
          display={familyDisplay(catalog, withdrawCurrency)}
          ckBtcBalance={assetBalances[withdrawCurrency] ?? 0}
          onClose={() => setWithdrawCurrency(null)}
          onWithdrawn={onActivity}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsSheet
          relayUrl={relayUrl}
          setRelayUrl={setRelayUrl}
          onTopUp={topUp}
          topUpBusy={topUpBusy}
          topUpErr={topUpErr}
          onClose={() => setSettingsOpen(false)}
          onReset={onReset}
        />
      ) : null}
    </SafeAreaView>
  );
}

function Tab({label, active, onPress, hotkey}: {label: string; active: boolean; onPress: () => void; hotkey?: string}) {
  return (
    <Pressable onPress={onPress} style={[S.tab, active && S.tabActive]} testID={`tab-${label.toLowerCase()}`}>
      <Text style={[S.tabText, active && S.tabTextActive]}>{label}</Text>
      {hotkey ? <HotkeyHint k={hotkey} tone={active ? 'onBrand' : 'muted'} /> : null}
    </Pressable>
  );
}

/**
 * Tiny keyboard-key badge shown next to a shortcut target (web only — native has no keyboard, so the
 * hints would be noise there). Always-visible-but-subtle: a small rounded square with the key's
 * letter in the palette's muted tone (`C.sub2`) so it reads as a hint, not chrome. `tone='onBrand'`
 * flips to a dark-on-brand variant for badges that sit on the green brand background (active tab,
 * the Add-money button). The pattern (a letter in a box) stays recognisable across targets, so a
 * user who learns one shortcut infers the rest.
 */
function HotkeyHint({k, tone = 'muted'}: {k: string; tone?: 'muted' | 'onBrand'}) {
  if (Platform.OS !== 'web') {
    return null;
  }
  const onBrand = tone === 'onBrand';
  return (
    <View style={[S.kbdHint, onBrand && S.kbdHintOnBrand]}>
      <Text style={[S.kbdHintText, onBrand && S.kbdHintTextOnBrand]}>{k}</Text>
    </View>
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

  // Verify a settled receipt's canister/ledger signature (R2) before trusting the outcome — see the
  // module-level `verifyOutcomeReceipt`. The nonce match is enforced upstream (settledNonceHex).
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
    // The receipt object backing a 'settled' outcome (from the /pay body or the /receipt reconcile).
    // R2: we verify its canister/ledger signature before finalizing success.
    let settledReceipt: any = null;

    if (outcome === 'settled') {
      settledNonceHex = body?.receipt?.nonce ?? nonceHex;
      settledReceipt = body?.receipt ?? null;
    } else if (outcome === 'rejected') {
      // "Nonce reused" is not a real refusal — it means this exact payment already settled.
      // Reconcile to the real receipt instead of showing a scary (and false) decline.
      if (isNonceReused(body?.error) && nonceHex) {
        const rec = await reconcile(nonceHex);
        if (rec) { outcome = 'settled'; settledNonceHex = rec.nonce ?? nonceHex; settledReceipt = rec; }
      }
    } else if (nonceHex) {
      // UNKNOWN (network drop / timeout / 5xx): the ledger MAY have committed. Reconcile before
      // deciding — this is the fix for "settled but reported as failed".
      const rec = await reconcile(nonceHex);
      if (rec) { outcome = 'settled'; settledNonceHex = rec.nonce ?? nonceHex; settledReceipt = rec; }
    }

      if (outcome === 'settled') {
        // R2: trust the outcome only if the receipt's signature verifies under the canister/ledger
        // pubkey. A merchant/relay cannot forge this; an unverifiable receipt is treated as unknown
        // (pending), never a fake success.
        const verified = settledReceipt ? await verifyOutcomeReceipt(settledReceipt) : false;
        if (verified) {
          record();
          finalize('success');
        } else {
          finalize('pending', 'Couldn’t verify the payment — check the balance');
        }
      } else if (outcome === 'rejected') {
      finalize('declined', rejectionMessage(typeof body?.error === 'string' ? body.error : null));
    } else {
      // Genuinely unknown even after reconciliation — truthful, never a fake success or failure.
      finalize('pending', 'Couldn’t confirm with the ledger — check the balance');
    }
    // Best-effort: hand the outcome back to the payer, stamped with the authoritative nonce.
    try { await DpayNfc.confirmReceipt(receiptCodeFor(outcome), settledNonceHex ?? nonceHex ?? ''); } catch {}
  }, [reqInfo, record, finalize, postPay, reconcile]); // relayUrl is captured transitively via postPay/reconcile (both depend on it)

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
        // R2: only believe the reconciled receipt if its canister/ledger signature verifies.
        if (alive && r.ok) {
          const j = await r.json().catch(() => ({} as any));
          if (await verifyOutcomeReceipt(j.receipt)) {
            onSettled(); setPaid({amount: qr.amount, who: qr.who, already: false}); setPhase('paid');
          }
        }
      } catch {} finally { clearTimeout(t); }
    };
    check(); const id = setInterval(check, POLL.receiptPay);
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
          // R2: trust the outcome only if the receipt's canister/ledger signature verifies. A
          // replay (replayed:true) returns the SAME cached receipt, which verifies identically.
          const verified = await verifyOutcomeReceipt(j.receipt);
          if (verified) {
            if (!j.replayed) onSettled();
            setPaid({amount: req.amount, who, already: !!j.replayed}); setPhase('paid'); return;
          }
          // Settled at the HTTP layer but the receipt did not verify — honest, never a fake Paid.
          setErr('Couldn’t verify the payment — check the balance'); return;
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
          {/* N10: paste-request fallback — on web/desktop where there's no camera or NFC, the user can
              paste a request string they copied or received via another channel. The decode path
              accepts a raw string identical to what the scanner produces. */}
          <Pressable testID="btn-paste" style={S.linkBtn} onPress={async () => {
            const text = await readFromClipboard();
            if (text && text.trim()) onRequestString(text.trim());
          }}>
            <Text style={S.linkText}>Paste request</Text>
          </Pressable>
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
    check(); const id = setInterval(check, POLL.receiptRcv);
    return () => { alive = false; clearInterval(id); };
  }, [reqQr, result, relayUrl, onReceived]);

  async function onSignedQr(raw: string) {
    setScanning(false);
    setErr(null);
    try {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), NFC_PAY_TIMEOUT_MS);
      let r;
      try {
        r = await fetch(`${base(relayUrl)}/api/v1/pay`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({qr: raw.trim()}), signal: ctrl.signal});
      } finally { clearTimeout(timer); }
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
function DepositSheet({identity, relayUrl, currency, display, onClose}: {identity: Identity; relayUrl: string; currency: number; display: FamilyDisplay; onClose: () => void}) {
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
      } catch (e: any) {
        // N7: distinguish "no minter" (503 — the asset has no ck-minter configured) from a transient
        // network/relay error. The relay returns 503 when no minter is registered for this currency;
        // the deposit fetch functions throw with the status in the message. A missing status means a
        // network error (relay unreachable).
        const msg = String(e?.message ?? e);
        const isNoMinter = /503/.test(msg);
        if (alive) setErr(isNoMinter
          ? 'Direct deposit for this asset isn\'t available yet.'
          : 'Could not reach the ledger for a deposit address');
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

  // Poll every POLL.deposit while open; cleans up on close.
  useEffect(() => {
    let alive = true;
    const poll = () => { if (alive) { refreshNow(false); } };
    poll(); const id = setInterval(poll, POLL.deposit);
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
  const estMin = required > 0 ? required * display.blockMin : 0;
  const feeTxt = info ? fmtAsset(info.deposit_fee, display.amountDecimals, display.nativeAsset) : null;
  const minTxt = info?.deposit_min_amount != null ? fmtAsset(info.deposit_min_amount, display.amountDecimals, display.nativeAsset) : null;

  return (
    <View style={S.sheetOverlay}>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>{`Add ${display.networkLabel}`}</Text>
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
              <Text style={S.dim2}>{err?.includes("isn't available") ? 'This asset may not have a deposit minter configured yet.' : 'Check the relay is reachable, then reopen the sheet.'}</Text>
            </View>
          ) : minted ? (
            <View style={S.centerAll}>
              <View style={S.check}><Text style={S.checkMark}>✓</Text></View>
              <Text style={S.paidText}>Deposited ✓</Text>
              <Text style={S.paidSub}>{fmtAsset(refresh?.minted_total ?? 0, display.amountDecimals, display.nativeAsset)} minted</Text>
              <Text style={S.dim2}>Your balance updates automatically.</Text>
            </View>
          ) : (
            <>
              {/* Complete, scannable instructions: network + asset + est. time + fee + min + the
                  one-line non-custody reassurance. All values come from `deposit_info` (never
                  hardcoded); the network/asset are the family's config (FAMILY_DISPLAY). */}
              <View testID="deposit-instructions" style={S.instrCard}>
                <Text style={S.instrLine}>
                  Send <Text style={S.instrAsset}>{display.nativeAsset}</Text> to your{' '}
                  <Text style={S.instrAsset}>{display.networkLabel}</Text> address below.
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
                    ? `${pending.map(p => fmtAsset(p.value, display.amountDecimals, display.nativeAsset)).join(', ')} · ${required || '?'} confirmation${required === 1 ? '' : 's'} needed`
                    : `checking every ${POLL.deposit / 1000}s`}
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

/**
 * Withdraw ckBTC to a native BTC address. The user enters a BTC address + amount, reviews
 * "Withdraw X BTC to bc1…", then the app signs the WithdrawAuth ON-DEVICE (the non-custodial gate)
 * and submits to the relay's POST /api/v1/withdraw. The facade verifies the signature before moving
 * funds. Amounts are shown in BTC (the backing currency symbol — never the wrapper/raw ledger id).
 * Escape closes the sheet (web), matching DepositSheet.
 */
function WithdrawSheet({identity, relayUrl, currency, display, ckBtcBalance, onClose, onWithdrawn}: {identity: Identity; relayUrl: string; currency: number; display: FamilyDisplay; ckBtcBalance: number; onClose: () => void; onWithdrawn: () => void}) {
  const [address, setAddress] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [phase, setPhase] = useState<'form' | 'submitting' | 'done' | 'error'>('form');
  const [err, setErr] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{amount: number; btcAddress: string} | null>(null);
  const [savedAddr, setSavedAddr] = useState<string | null>(null);

  useEscapeToClose(onClose);

  // Load the last-used destination for this currency on open (Fork-B: tap-to-reuse, no re-paste).
  useEffect(() => {
    let alive = true;
    loadSavedWithdrawAddr(currency).then(a => { if (alive && a) { setSavedAddr(a); } });
    return () => { alive = false; };
  }, [currency]);

  const sats = toSats(amountStr);
  const belowMin = sats > 0 && sats < display.withdrawMinRaw;
  const overBalance = sats > ckBtcBalance;
  const canReview = address.trim().length > 0 && sats > 0 && !belowMin && !overBalance;

  async function confirm() {
    if (!canReview) {
      return;
    }
    setPhase('submitting');
    setErr(null);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), WITHDRAW_TIMEOUT_MS);
    try {
      const nonce = randNonceHex();
      const expiry = nowSecs() + WITHDRAW_EXPIRY_WINDOW;
      // Sign the WithdrawAuth on-device (non-custodial gate). The facade verifies this exact sig.
      const sigHex = await DpayCore.signWithdrawal(identity.secretHex, address.trim(), sats, nonce, expiry, currency);
      const r = await withdrawFunds(relayUrl, identity.publicHex, address.trim(), sats, nonce, expiry, currency, sigHex, ctrl.signal);
      setReceipt({amount: r.amount, btcAddress: r.destination});
      setPhase('done');
      void saveWithdrawAddr(currency, address.trim()); // remember for next cash-out (Fork-B)
      onWithdrawn(); // trigger a balance/history refresh
    } catch (e: any) {
      // A 422 policy error (bad sig / insufficient / below min / nonce) or a 503 transient / offline.
      // Surface the reason; the user can correct + retry from the form.
      setErr(String(e?.message ?? e));
      setPhase('error');
    } finally {
      clearTimeout(t);
    }
  }

  function reset() { setAddress(''); setAmountStr(''); setErr(null); setReceipt(null); setPhase('form'); }

  return (
    <View style={S.sheetOverlay}>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>{`Cash out ${display.networkLabel}`}</Text>
          <Pressable testID="btn-withdraw-close" style={S.sheetClose} onPress={onClose}><Text style={S.sheetCloseX}>✕</Text></Pressable>
        </View>

        <ScrollView contentContainerStyle={S.sheetBody} keyboardShouldPersistTaps="handled">
          {phase === 'done' && receipt ? (
            <View style={S.centerAll}>
              <View style={S.check}><Text style={S.checkMark}>✓</Text></View>
              <Text testID="withdraw-status" style={S.paidText}>Withdrawn ✓</Text>
              <Text style={S.paidSub}>{fmtAsset(receipt.amount, display.amountDecimals, display.nativeAsset)}</Text>
              <Text style={S.dim2}>sent to {receipt.btcAddress}</Text>
              <Text style={S.dim2}>Your balance updates automatically.</Text>
              <Pressable testID="btn-withdraw-done" style={S.linkBtn} onPress={onClose}><Text style={S.linkText}>Done</Text></Pressable>
            </View>
          ) : phase === 'submitting' ? (
            <View style={S.centerAll}>
              <ActivityIndicator color={C.brand} />
              <Text style={S.dim2}>{`Withdrawing ${fmtAsset(sats, display.amountDecimals, display.nativeAsset)}…`}</Text>
            </View>
          ) : (
            <>
              <Text style={S.label}>{`Send your ${display.networkLabel} to a native ${display.nativeAsset} address`}</Text>
              <Text style={S.dim2}>{`Available: ${fmtAsset(ckBtcBalance, display.amountDecimals, display.nativeAsset)} · min ${fmtAsset(display.withdrawMinRaw, display.amountDecimals, display.nativeAsset)}`}</Text>

              <Text style={S.inputLabel}>{`${display.nativeAsset} address`}</Text>
              {savedAddr && address.trim().length === 0 ? (
                <Pressable testID="btn-withdraw-saved" style={S.savedAddrChip} onPress={() => setAddress(savedAddr)}>
                  <Text style={S.savedAddrText}>{`Use last: ${savedAddr.length > 28 ? savedAddr.slice(0, 14) + '…' + savedAddr.slice(-12) : savedAddr}`}</Text>
                </Pressable>
              ) : null}
              <TextInput
                testID="withdraw-address-input"
                style={S.withdrawAddrInput}
                value={address}
                onChangeText={setAddress}
                placeholder={display.addressPlaceholder}
                placeholderTextColor={C.sub2}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={S.inputLabel}>{`Amount (${display.nativeAsset})`}</Text>
              <TextInput
                testID="withdraw-amount-input"
                style={S.withdrawAmtInput}
                value={amountStr}
                onChangeText={setAmountStr}
                keyboardType="decimal-pad"
                placeholder="0.00050000"
                placeholderTextColor={C.sub2}
              />

              {belowMin ? <Text style={S.warnNote}>{`Below the ${fmtAsset(display.withdrawMinRaw, display.amountDecimals, display.nativeAsset)} minimum withdrawal.`}</Text> : null}
              {overBalance ? <Text style={S.warnNote}>{`More than your available ${fmtAsset(ckBtcBalance, display.amountDecimals, display.nativeAsset)}.`}</Text> : null}

              {(phase === 'form' || phase === 'error') && sats > 0 ? (
                <View testID="withdraw-review" style={S.reviewCard}>
                  <Text style={S.reviewLabel}>Review withdrawal</Text>
                  <Text testID="withdraw-review-amount" style={S.reviewAmount}>{`Withdraw ${fmtAsset(sats, display.amountDecimals, display.nativeAsset)}`}</Text>
                  <Text style={S.reviewTo}>{`to ${address.trim() || '—'}`}</Text>
                </View>
              ) : null}

              {err ? <Text testID="withdraw-err" style={S.err}>{err}</Text> : null}

              <Pressable
                testID="btn-withdraw-confirm"
                style={[S.primaryWide, !canReview && S.dim]}
                disabled={!canReview}
                onPress={confirm}>
                <Text style={S.primaryText}>{sats > 0 ? `Withdraw ${fmtAsset(sats, display.amountDecimals, display.nativeAsset)}` : 'Enter an amount'}</Text>
              </Pressable>

              {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

/**
 * Settings sheet — relay URL, demo faucet, reset. Moved off the main wallet screen (UX-V2: the
 * relay URL + bare red reset were dev chrome on a consumer surface) into its own overlay. Reset now
 * requires a confirmation dialog (UX-V3: one-tap identity wipe was dangerous). The demo faucet lives
 * here too (founder decision: keep it, label it clearly, surface the cooldown).
 */
function SettingsSheet({relayUrl, setRelayUrl, onTopUp, topUpBusy, topUpErr, onClose, onReset}: {
  relayUrl: string;
  setRelayUrl: (s: string) => void;
  onTopUp: () => void;
  topUpBusy: boolean;
  topUpErr: string | null;
  onClose: () => void;
  onReset: () => void;
}) {
  useEscapeToClose(onClose);
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <View style={S.sheetOverlay}>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>Settings</Text>
          <Pressable testID="btn-settings-close" style={S.sheetClose} onPress={onClose}><Text style={S.sheetCloseX}>✕</Text></Pressable>
        </View>

        <ScrollView contentContainerStyle={S.sheetBody} keyboardShouldPersistTaps="handled">
          {/* Relay URL */}
          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>Relay URL</Text>
            <TextInput
              testID="settings-relay"
              style={S.relayInput}
              value={relayUrl}
              onChangeText={setRelayUrl}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="http://<ip>:8787"
              placeholderTextColor={C.sub2}
            />
            <Text style={S.dim2}>The server your wallet talks to. Change this to point at a different network.</Text>
          </View>

          {/* Demo faucet */}
          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>Demo funds</Text>
            <Text style={S.dim2}>Add play money for testing. Limited to once per hour on the real network.</Text>
            <Pressable
              testID="btn-topup"
              style={[S.primaryWide, topUpBusy && S.dim]}
              disabled={topUpBusy}
              onPress={onTopUp}>
              {topUpBusy
                ? <ActivityIndicator size="small" color={C.brandInk} />
                : <Text style={S.primaryText}>Add demo money</Text>}
            </Pressable>
            {topUpErr ? <Text testID="topup-err" style={S.topUpErr}>{topUpErr}</Text> : null}
          </View>

          {/* Reset */}
          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>Reset</Text>
            {confirmReset ? (
              <View style={S.resetConfirmBox}>
                <Text style={S.warnNote}>This erases your wallet identity from this device. Funds at this address become irrecoverable. This cannot be undone.</Text>
                <Pressable testID="btn-reset-confirm" style={[S.primaryWide, {backgroundColor: C.bad, marginTop: 16}]} onPress={onReset}>
                  <Text style={S.primaryText}>Yes, reset everything</Text>
                </Pressable>
                <Pressable testID="btn-reset-cancel" style={S.linkBtn} onPress={() => setConfirmReset(false)}>
                  <Text style={S.linkTextMuted}>Cancel</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable testID="btn-reset" style={S.linkBtn} onPress={() => setConfirmReset(true)}>
                <Text style={S.resetLink}>Reset wallet</Text>
              </Pressable>
            )}
          </View>

          {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

// Asset picker — shown from the header "Add money" button when more than one onrampable asset exists.
// A vertical list of the catalog's ramp assets (those carrying a minter_family); tapping a row opens
// that asset's family-specific deposit sheet. The picker is the cohesive entry for MANY currencies:
// every onrampable asset appears uniformly — there is no "supported"/"unsupported" split.
function AssetPickerSheet({rampAssets, catalog, onPick, onClose}: {
  rampAssets: CurrencyDescriptor[];
  catalog: CurrencyDescriptor[];
  onPick: (currency: number) => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  return (
    <View style={S.sheetOverlay}>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>Add money</Text>
          <Pressable testID="btn-picker-close" style={S.sheetClose} onPress={onClose}><Text style={S.sheetCloseX}>✕</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={S.sheetBody} keyboardShouldPersistTaps="handled">
          <Text style={S.dim2}>Choose an asset to add to your wallet.</Text>
          {rampAssets.map(a => {
            const disp = familyDisplay(catalog, a.currency);
            const key = assetTestKey(a);
            return (
              <Pressable key={a.currency} testID={`asset-picker-row-${key}`} style={S.pickerRow} onPress={() => onPick(a.currency)}>
                <Text style={S.pickerLabel}>{disp.networkLabel}</Text>
                <Text style={S.pickerSub}>{`Send ${disp.nativeAsset} on ${disp.networkLabel}`}</Text>
              </Pressable>
            );
          })}
          {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

// ckERC20 (ckUSDC) direct onramp — a wallet-connect flow. The user connects their OWN Ethereum wallet
// (MetaMask/Rabby; window.ethereum on web), dpay BUILDS the two transactions (approve the helper to
// spend USDC, then depositErc20 into the helper with the facade principal + the user's pubkey as the
// subaccount), and the wallet SIGNS + broadcasts. dpay never sees the ETH key — non-custodial. The
// ckETH minter scrapes Ethereum logs on a ~3min heartbeat and mints ckUSDC to the user's subaccount
// (~20min); dpay just polls the ckUSDC balance. The calldata is built by cketh.ts (byte-exact vs the
// real helper-contract ABI; pinned by goldens).
function CkErc20DepositSheet({identity, relayUrl, currency, display, onClose}: {
  identity: Identity;
  relayUrl: string;
  currency: number;
  display: FamilyDisplay;
  onClose: () => void;
}) {
  // phase: 'connect' (no wallet yet) → 'enter' (wallet connected, enter amount) → 'sending' (txs
  // submitted, waiting on the user's wallet to sign) → 'watching' (txs mined, waiting for the mint)
  // → 'done' (balance grew).
  const [phase, setPhase] = useState<'connect' | 'enter' | 'sending' | 'watching' | 'done'>('connect');
  const [account, setAccount] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [params, setParams] = useState<CkErc20OnrampParams | null>(null);
  const [startBal, setStartBal] = useState<number | null>(null);

  useEscapeToClose(onClose);

  // Load the onramp params (helper address, ERC-20 address, facade principal) once on open.
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    (async () => {
      try {
        const p = await ckerc20OnrampParams(relayUrl, currency, ctrl.signal);
        if (alive) setParams(p);
      } catch { if (alive) setErr('Could not reach the relay for onramp details.'); }
      finally { if (alive) clearTimeout(t); }
    })();
    return () => { alive = false; ctrl.abort(); };
  }, [relayUrl, currency]);

  const connect = useCallback(async () => {
    setErr(null);
    const provider = getEthereumProvider();
    if (!provider) { setErr('No Ethereum wallet found. Install MetaMask or Rabby in this browser.'); return; }
    try {
      const acct = await connectWallet(provider);
      setAccount(acct);
      // Snapshot the starting balance so the watching poll can detect the mint (a GROWTH from here).
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(`${base(relayUrl)}/api/v1/balance/${identity.publicHex}?currency=${currency}`, {signal: ctrl.signal});
        const j = await r.json().catch(() => ({} as any));
        if (typeof j.balance === 'number') setStartBal(j.balance);
        clearTimeout(t);
      } catch { /* best-effort snapshot; watching falls back to any-positive */ }
      setPhase('enter');
    } catch (e: any) {
      setErr(String(e?.message ?? e) || 'Could not connect to your wallet.');
    }
  }, [relayUrl, currency, identity.publicHex]);

  const submit = useCallback(async () => {
    if (!account || !params) return;
    const provider = getEthereumProvider();
    if (!provider) { setErr('Wallet disconnected.'); return; }
    // Parse the human amount into the smallest units (USDC = 6 decimals).
    const units = Math.round((parseFloat(amount) || 0) * Math.pow(10, display.amountDecimals));
    if (!(units > 0)) { setErr('Enter an amount greater than zero.'); return; }
    const unitBig = BigInt(units);
    const principalWord = principalToBytes32(params.facade_principal);
    // The user's ckUSDC subaccount is their 32-byte Ed25519 pubkey (the same subaccount the balance
    // poll + pay path read), so the mint lands at the account the wallet already shows.
    const subaccount = identity.publicHex;
    setErr(null);
    setPhase('sending');
    try {
      // 1. approve(helper, amount) on the USDC ERC-20 contract.
      const approveData = encodeApprove(params.helper_address, unitBig);
      await sendTransaction(provider, account, {to: params.erc20_address, data: approveData});
      // 2. depositErc20(usdc, amount, principal, subaccount) on the helper contract.
      const depositData = encodeDepositErc20(params.erc20_address, unitBig, principalWord, subaccount);
      await sendTransaction(provider, account, {to: params.helper_address, data: depositData});
      setPhase('watching');
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setErr(/reject|denied|user/i.test(msg) ? 'Transaction not signed.' : (msg || 'Transaction failed.'));
      setPhase('enter');
    }
  }, [account, params, amount, display.amountDecimals, identity.publicHex]);

  // Watching: poll the ckUSDC balance for the mint. The minter scrapes ETH logs on a ~3min heartbeat;
  // credit typically lands within ~20min. Any growth from the snapshot (or a positive balance when no
  // snapshot) means the mint landed.
  useEffect(() => {
    if (phase !== 'watching') return;
    let alive = true;
    const poll = async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch(`${base(relayUrl)}/api/v1/balance/${identity.publicHex}?currency=${currency}`, {signal: ctrl.signal});
        const j = await r.json().catch(() => ({} as any));
        if (alive && r.ok && typeof j.balance === 'number') {
          if (startBal == null ? j.balance > 0 : j.balance > startBal) setPhase('done');
        }
      } catch { /* keep watching */ } finally { clearTimeout(t); }
    };
    poll();
    const id = setInterval(poll, POLL.deposit);
    return () => { alive = false; clearInterval(id); };
  }, [phase, relayUrl, identity.publicHex, currency, startBal]);

  const fmt = (n: number) => fmtAsset(n, display.amountDecimals, display.nativeAsset);

  return (
    <View style={S.sheetOverlay}>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>{`Add ${display.networkLabel}`}</Text>
          <Pressable testID="btn-ckerc20-close" style={S.sheetClose} onPress={onClose}><Text style={S.sheetCloseX}>✕</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={S.sheetBody} keyboardShouldPersistTaps="handled">
          {/* Wrong-network warning — unmissable, above the flow. */}
          <View testID="ckerc20-deposit" style={S.instrCard}>
            <Text style={S.instrLine}>
              Send only <Text style={S.instrAsset}>{display.nativeAsset}</Text> on{' '}
              <Text style={S.instrAsset}>{display.networkLabel}</Text>. Other assets or chains sent
              this way won't credit and may be lost.
            </Text>
            <Text style={S.instrCustody}>
              dpay never holds your keys — your wallet signs, and ckUSDC mints 1:1 to your wallet on
              confirmation (~20 min).
            </Text>
          </View>

          {err ? <Text testID="ckerc20-status" style={S.err}>{err}</Text> : null}

          {phase === 'connect' ? (
            <Pressable testID="btn-connect-wallet" style={S.primaryWide} onPress={connect}>
              <Text style={S.primaryText}>Connect wallet</Text>
            </Pressable>
          ) : phase === 'enter' || phase === 'sending' ? (
            <>
              <Text style={S.inputLabel}>{`Amount (${display.nativeAsset})`}</Text>
              <TextInput
                testID="ckerc20-amount"
                style={S.amountInput}
                keyboardType="decimal-pad"
                placeholder={`0.00`}
                value={amount}
                onChangeText={setAmount}
                editable={phase === 'enter'}
                onSubmitEditing={phase === 'enter' ? submit : undefined}
              />
              {account ? <Text style={S.dim2}>{`From ${account.slice(0, 6)}…${account.slice(-4)}`}</Text> : null}
              <Pressable testID="btn-approve" style={[S.primaryWide, phase === 'sending' && {opacity: 0.6}]} onPress={submit} disabled={phase === 'sending'}>
                <Text style={S.primaryText}>{phase === 'sending' ? 'Confirm in your wallet…' : 'Approve & deposit'}</Text>
              </Pressable>
            </>
          ) : phase === 'watching' ? (
            <View style={S.centerAll}>
              <ActivityIndicator color={C.brand} />
              <Text testID="ckerc20-status" style={S.paidSub}>Transactions submitted ✓</Text>
              <Text style={S.dim2}>Watching for your mint — the ckETH minter scrapes Ethereum every few minutes; credit typically lands within ~20 min.</Text>
            </View>
          ) : (
            <View style={S.centerAll}>
              <View style={S.check}><Text style={S.checkMark}>✓</Text></View>
              <Text style={S.paidText}>Deposited ✓</Text>
              <Text style={S.paidSub}>ckUSDC minted to your wallet.</Text>
              <Text style={S.dim2}>Your balance updates automatically.</Text>
            </View>
          )}
          {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
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
  header: {paddingTop: 20, paddingLeft: 22, paddingRight: 30, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottomWidth: 1, borderBottomColor: C.line},
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
  topUpErr: {fontSize: 13, color: C.bad, marginTop: 8, textAlign: 'center'},
  dot: {width: 8, height: 8, borderRadius: 4},
  balLabel: {fontSize: 12, color: C.sub},
  balAmt: {fontSize: 26, fontWeight: '800', color: C.ink},
  tabs: {flexDirection: 'row', paddingHorizontal: 22, gap: 10, marginTop: 10},
  tab: {flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 8, paddingHorizontal: 20, borderRadius: 999, backgroundColor: C.field},
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
  assetActions: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12},
  assetActionBtn: {paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: C.line2},
  assetActionText: {color: C.sub, fontWeight: '700', fontSize: 13},
  pickerRow: {alignSelf: 'stretch', paddingVertical: 16, paddingHorizontal: 16, borderRadius: 12, backgroundColor: C.card, borderWidth: 1, borderColor: C.line2, marginTop: 10},
  pickerLabel: {fontSize: 16, fontWeight: '700', color: C.ink},
  pickerSub: {fontSize: 12, color: C.sub2, marginTop: 4},
  settingsBar: {paddingHorizontal: 22, paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.line},
  settingsLinkBtn: {alignSelf: 'flex-start'},
  settingsLink: {fontSize: 14, color: C.sub, fontWeight: '600'},
  settingsSection: {alignSelf: 'stretch', marginBottom: 28},
  relayInput: {alignSelf: 'stretch', backgroundColor: C.field, borderRadius: 12, height: 50, paddingHorizontal: 16, fontSize: 14, color: C.ink, fontFamily: 'monospace', borderWidth: 1, borderColor: C.line2},
  resetConfirmBox: {alignSelf: 'stretch', backgroundColor: 'rgba(248,113,113,0.06)', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: 'rgba(248,113,113,0.2)'},
  resetLink: {fontSize: 15, color: C.bad, fontWeight: '600'},
  // The PRIMARY funding affordance in the balance header: a clear "Add money" brand button that
  // opens the deposit sheet. Filled brand so it reads as primary; the DEMO_USD faucet (topUpBtn)
  // is the secondary outline pill beside it.
  addMoneyBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.brand, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, shadowColor: C.brand, shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: {width: 0, height: 6}, elevation: 6},
  addMoneyBtnText: {fontSize: 13, fontWeight: '800', color: C.brandInk},
  // Keyboard-shortcut hint badge (web only — rendered by HotkeyHint). A small rounded "key" square;
  // the muted tone sits on the dark header/tabs, the onBrand variant sits on the green brand
  // background (active tab, Add-money button). Subtle by design: muted tone + monospace letter so it
  // reads as a hint, not as primary chrome.
  kbdHint: {minWidth: 16, height: 16, paddingHorizontal: 4, borderRadius: 4, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center'},
  kbdHintText: {fontSize: 10, fontWeight: '700', color: C.sub2, fontFamily: 'monospace'},
  kbdHintOnBrand: {borderColor: 'rgba(3,23,15,0.35)', backgroundColor: 'rgba(3,23,15,0.10)'},
  kbdHintTextOnBrand: {color: C.brandInk},
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
  // Withdraw affordance on the ckBTC asset card — a small brand link, distinct from the deposit
  // "Add money" flow (money OUT, not IN). Sits below the balance line.
  withdrawLink: {marginTop: 10, alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: C.brand},
  withdrawLinkText: {color: C.brand, fontWeight: '700', fontSize: 13},
  // Withdraw sheet form fields.
  inputLabel: {fontSize: 13, fontWeight: '700', color: C.sub, alignSelf: 'flex-start', marginTop: 18, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8},
  withdrawAddrInput: {alignSelf: 'stretch', backgroundColor: C.field, borderRadius: 12, height: 56, paddingHorizontal: 16, fontSize: 15, color: C.ink, fontFamily: 'monospace', borderWidth: 1, borderColor: C.line2},
  savedAddrChip: {alignSelf: 'flex-start', backgroundColor: C.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8},
  savedAddrText: {fontSize: 13, color: C.brand, fontFamily: 'monospace'},
  withdrawAmtInput: {alignSelf: 'stretch', backgroundColor: C.field, borderRadius: 12, height: 56, paddingHorizontal: 16, fontSize: 22, fontWeight: '700', color: C.ink, borderWidth: 1, borderColor: C.line2},
  reviewCard: {alignSelf: 'stretch', marginTop: 20, backgroundColor: C.card, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: C.line2},
  reviewLabel: {fontSize: 12, fontWeight: '700', color: C.sub2, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 8, fontFamily: 'monospace'},
});
