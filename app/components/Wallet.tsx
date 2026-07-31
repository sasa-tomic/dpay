import {useCallback, useEffect, useMemo, useState} from 'react';
import {SafeAreaView, StatusBar, View, Text, Pressable, ScrollView, AppState} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {C} from '../config/palette';
import {S} from '../styles';
import {STORAGE_KEY, POLL, TOP_UP_CENTS} from '../config/constants';
import {
  type CurrencyDescriptor, CATALOG_CACHE_KEY, BUNDLED_CATALOG, fetchCurrencies, familyDisplay, assetTestKey, displayName,
} from '../config/catalog';
import {usd, short, isMintSentinel, fmtTime, fmtAsset, base} from '../lib/format';
import type {Identity, Txn, TransactionsRow, NfcStatus} from '../lib/types';
import {DpayCore} from '../services/native';
import {useHotkeys} from '../hooks/useHotkeys';
import {readDepositDeepLink} from '../hooks/useDeepLink';
import {Wordmark} from './Logo';
import {HotkeyHint} from './HotkeyHint';
import {NfcPill} from './NfcPill';
import {Tab} from './Tab';
import {PayMode} from './PayMode';
import {ReceiveMode} from './ReceiveMode';
import {DepositSheet} from './DepositSheet';
import {WithdrawSheet} from './WithdrawSheet';
import {SettingsSheet} from './SettingsSheet';
import {AssetPickerSheet} from './AssetPickerSheet';
import {CkErc20DepositSheet} from './CkErc20DepositSheet';

export function Wallet({identity, relayUrl, setRelayUrl, onReset}: {identity: Identity; relayUrl: string; setRelayUrl: (s: string) => void; onReset: () => void}) {
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
  // The full set of currency ids to fetch HISTORY for (H2): every catalog currency (DEMO_USD + every
  // ramp asset), since transactions_of is per-currency and a hardcoded currency=0 hid non-USD
  // payments. Stable signature for the history effect deps (mirrors rampCurrencyIds).
  const catalogCurrencyIds = useMemo(() => catalog.map(c => c.currency).join(','), [catalog]);

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
  //
  // H2: history is fetched for EVERY catalog currency (not just currency=0). Each currency lives on
  // a separate ledger, and `transactions_of` is per-currency, so a single hardcoded currency=0 hid
  // every ckBTC/ckUSDC payment. We fan out one bounded fetch per currency, best-effort per currency
  // (a transient failure on one must NOT blank the others — only the currencies that respond
  // contribute), union the rows, dedup by nonce, and sort newest-first. If EVERY fetch fails
  // (offline), the prior list is kept — mirroring the old single-fetch behavior so an outage never
  // blanks the RECENT card.
  const refreshHistory = useCallback(async () => {
    const currencies = catalog.map(c => c.currency);
    let anySucceeded = false;
    const perCurrency = await Promise.all(currencies.map(async (currency) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch(`${base(relayUrl)}/api/v1/transactions/${identity.publicHex}?currency=${currency}&limit=20`, {signal: ctrl.signal});
        const j = await r.json().catch(() => null);
        if (r.ok && j && Array.isArray(j.transactions)) { anySucceeded = true; return j.transactions as TransactionsRow[]; }
        return [];
      } catch { return []; } finally { clearTimeout(t); }
    }));
    if (!anySucceeded) return; // offline / all failed: keep the existing list
    const me = identity.publicHex.toLowerCase();
    // Dedup by nonce (a payment id is globally unique) across currencies, then sort the UNION
    // newest-first by raw timestamp — each per-currency fetch is already newest-first within its own
    // currency, but mixed currencies must interleave by time.
    const seen = new Set<string>();
    const all: TransactionsRow[] = [];
    for (const rows of perCurrency) {
      for (const rec of rows) {
        if (seen.has(rec.nonce)) continue;
        seen.add(rec.nonce);
        all.push(rec);
      }
    }
    all.sort((a, b) => b.timestamp - a.timestamp);
    setHistory(all.map((rec): Txn => {
      const dir: 'out' | 'in' = rec.from.toLowerCase() === me ? 'out' : 'in';
      const counterparty = dir === 'out' ? rec.to.toLowerCase() : rec.from.toLowerCase();
      // N6/H3: the username isn't in the signed wire (FROZEN core), so the counterparty is a pubkey.
      // Show a friendly SHORT form (not the raw 64 chars); mint/burn rows get an honest label.
      const who = isMintSentinel(counterparty)
        ? (dir === 'in' ? 'Demo funds' : 'Withdrawal')
        : short(dir === 'out' ? rec.to : rec.from);
      return {nonce: rec.nonce, amount: rec.amount, who, time: fmtTime(rec.timestamp), dir};
    }));
  }, [relayUrl, identity.publicHex, catalogCurrencyIds]);

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
          {/* H4: the header shows ONLY the username. The hex pubkey was developer-facing protocol data
              ("Alice · 1b8a5ee7…") that made the header read like a debug panel; it's removed from the
              main display. The short hex is no longer appended anywhere in the header. */}
          <Text style={S.who} testID="header-who">{identity.username}</Text>
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
            <Pressable
              testID="btn-deposit"
              style={S.addMoneyBtn}
              onPress={addMoney}
              accessibilityRole="button"
              accessibilityLabel="Add money"
            >
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
          // H1: the card's primary label is the asset NAME (ckBTC/ckUSDC), not the chain. The chain
          // (networkLabel) is descriptive context only; the subtitle names the deposited asset too.
          const name = displayName(a);
          return (
            <View key={a.currency} testID={`asset-${testKey}`} style={S.assetCard}>
              <View style={S.assetRow}>
                <Text style={S.assetLabel}>{name}</Text>
                <Text style={S.assetAmt}>{fmtAsset(bal, disp.amountDecimals, disp.nativeAsset)}</Text>
              </View>
              <Text style={S.assetSub}>{`your deposited ${name} · spendable where a merchant requests it`}</Text>
              <View style={S.assetActions}>
                <Pressable
                  testID={`asset-add-${testKey}`}
                  style={S.assetActionBtn}
                  onPress={() => setDepositCurrency(a.currency)}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${name}`}
                >
                  <Text style={S.assetActionText}>＋ Add</Text>
                </Pressable>
                {a.minter_family === 'CkBtcUtxo' ? (
                  <Pressable
                    testID="btn-withdraw"
                    style={S.withdrawLink}
                    onPress={() => setWithdrawCurrency(a.currency)}
                    accessibilityRole="button"
                    accessibilityLabel={`Cash out ${name}`}
                  >
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
        <Pressable
          testID="btn-settings"
          style={S.settingsLinkBtn}
          onPress={() => setSettingsOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Settings"
        >
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
