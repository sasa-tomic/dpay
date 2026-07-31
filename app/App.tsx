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
import {DepositSheet} from './components/DepositSheet';
import {WithdrawSheet} from './components/WithdrawSheet';
import {CkErc20DepositSheet} from './components/CkErc20DepositSheet';
import {Onboarding} from './components/Onboarding';




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

