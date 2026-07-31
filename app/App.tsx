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
import {
  type MinterFamily, type CurrencyDescriptor, type FamilyDisplay, CATALOG_CACHE_KEY, BUNDLED_CATALOG,
  fetchCurrencies, familyDisplay, assetTestKey,
} from './config/catalog';
import {S} from './styles';
import {useHotkeys, useEscapeToClose} from './hooks/useHotkeys';
import {copyToClipboard, readFromClipboard} from './hooks/clipboard';
import {readDepositDeepLink} from './hooks/useDeepLink';
import {DpayCore, DpayNfc} from './services/native';
import {verifyOutcomeReceipt} from './services/receipt';
import {
  type DepositInfo, type DepositRefresh, type CkErc20OnrampParams, type WithdrawReceipt,
  depositInfo, depositAddress, depositRefresh, ckerc20OnrampParams, withdrawFunds,
} from './services/relay';
import {loadSavedWithdrawAddr, saveWithdrawAddr} from './services/withdraw';
import {Logo, Wordmark} from './components/Logo';
import {HotkeyHint} from './components/HotkeyHint';
import {NfcPill} from './components/NfcPill';
import {Tab} from './components/Tab';
import {QrScanner} from './components/QrScanner';
import {NfcTap} from './components/NfcTap';
import {PayMode} from './components/PayMode';
import {ReceiveMode} from './components/ReceiveMode';
import {SettingsSheet} from './components/SettingsSheet';
import {AssetPickerSheet} from './components/AssetPickerSheet';




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

