import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {SafeAreaView, StatusBar, View, Text, Pressable, ScrollView, AppState} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {C} from '../config/palette';
import {S} from '../styles';
import {STORAGE_KEY, POLL, TOP_UP_CENTS, BALANCE_TIMEOUT_MS, FAUCET_TIMEOUT_MS} from '../config/constants';
import {
  type CurrencyDescriptor, CATALOG_CACHE_KEY, BUNDLED_CATALOG, fetchCurrencies, familyDisplay, fmtCurrencyAmount,
} from '../config/catalog';
import {usd, short, isMintSentinel, fmtTime, base} from '../lib/format';
import {cmpRaw, applyOffline} from '../lib/amount';
import type {Identity, Txn, TransactionsRow, NfcStatus} from '../lib/types';
import {DpayCore} from '../services/native';
import {loadDeposit} from '../services/ckerc20Persist';
import {readJsonOrEmpty} from '../services/relay';
import {useHotkeys} from '../hooks/useHotkeys';
import {readDepositDeepLink} from '../lib/deepLink';
import {Wordmark} from './Logo';
import {HotkeyHint} from './HotkeyHint';
import {Tab} from './Tab';
import {PayMode} from './PayMode';
import {ReceiveMode} from './ReceiveMode';
import {Ledger} from './Ledger';
import {DepositSheet} from './DepositSheet';
import {WithdrawSheet} from './WithdrawSheet';
import {SettingsSheet} from './SettingsSheet';
import {CkErc20DepositSheet} from './CkErc20DepositSheet';
import {BalancesSheet} from './BalancesSheet';

export function Wallet({identity, relayUrl, setRelayUrl, onReset}: {identity: Identity; relayUrl: string; setRelayUrl: (s: string) => void; onReset: () => void}) {
  const [mode, setMode] = useState<'pay' | 'receive' | 'ledger'>('pay');
  // The "current" currency — the one whose balance the header reflects. Tapping the header balance
  // opens the Balances sheet, where tapping a currency row sets this. Currency 0 (DEMO) is the
  // default. This replaces the old DEMO-only header (the founder's restructure): the main screen now
  // shows a single selected currency's balance, and the full asset list + every top-up live in the
  // Balances sheet. Pay/Receive still settle in whatever currency a request specifies (unchanged).
  const [currentCurrency, setCurrentCurrency] = useState(0);
  const [balancesOpen, setBalancesOpen] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
        // Non-primary assets — each is a SEPARATE asset on a separate ledger, polled in parallel on
        // the same cadence and rendered as its own clearly-labeled card (never merged into the `$`
        // header, which is DEMO_USD only per CLAUDE.md's hard rule). Balances are keyed by the currency
        // id resolved from the runtime catalog (so adding an asset = config-only). A "0" entry means
        // "not yet funded"; the card still renders (muted) so the full asset rail is always visible.
        // MC1 units 2-4: balances are raw-u64 decimal STRINGS (never `number`).
  const [assetBalances, setAssetBalances] = useState<Record<number, string>>({});
  const [online, setOnline] = useState(false);
  // MC5 — currency-KEYED offline deduction. Was a single DEMO-only string; now a per-currency map of
  // raw-u64 decimal strings (missing key ⇒ '0' spent ⇒ no deduction). The offline QR/NFC hand-off
  // (`markOfflinePaid(amount, currency)`) debits THIS asset's entry, NOT the DEMO counter — so a
  // ckBTC offline pay reduces the ckBTC display, NOT the ∂ header. The reducer handles negative
  // inputs (the refund-on-failed-but-signed case) by summing as BigInt; this map is the source of
  // truth for every "shown" balance via the `applyOffline` helper.
  const [offlineSpent, setOfflineSpent] = useState<Record<number, string>>({});
  const [history, setHistory] = useState<Txn[]>([]);
  const [nfc, setNfc] = useState<NfcStatus>('unknown');
  // Demo top-up: a single click adds $100 of demo currency via /api/v1/faucet. The button sits next
  // to the balance so users find it without hunting. `topUpBusy` drives the spinner; `topUpErr`
  // surfaces a one-line failure (offline / faucet disabled) without blocking the rest of the UI.
  const [topUpBusy, setTopUpBusy] = useState(false);
  const [topUpErr, setTopUpErr] = useState<string | null>(null);
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
  // Which asset's deposit/withdraw sheet is open (null = closed). Set from the Balances sheet's per-
  // row actions. The sheet rendered is chosen by the currency's minter_family (DepositSheet vs
  // CkErc20DepositSheet). The `?screen=deposit` deep link seeds the ckBTC ramp on mount.
  const [depositCurrency, setDepositCurrency] = useState<number | null>(readDepositDeepLink() ? ckBtcCurrency : null);
  const [withdrawCurrency, setWithdrawCurrency] = useState<number | null>(null);
  // Every NON-primary catalog currency (the assets polled in parallel below + listed in the Balances
  // sheet). The balance poll covers every id here (a no-minter ICRC asset still has a readable ledger
  // principal; a failed read is swallowed so it never flaps the display). Each stays INDEPENDENT — no
  // cross-asset merge.
  const displayAssets = useMemo(() => catalog.filter(c => c.currency !== 0), [catalog]);
  const displayCurrencyIds = useMemo(() => displayAssets.map(a => a.currency).join(','), [displayAssets]);
  // The full set of currency ids to fetch HISTORY for (H2): every catalog currency (DEMO_USD + every
  // non-primary asset), since transactions_of is per-currency and a hardcoded currency=0 hid non-USD
  // payments. Stable signature for the history effect deps (mirrors displayCurrencyIds).
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

  // MC8 U5 — AUTO-OPEN the ckERC20 deposit sheet on mount if a watching deposit was persisted across
  // a restart. The watching poll is relay-bound (NOT Ethereum), so it is resumable WITHOUT a wallet
  // reconnect — surfacing the in-flight watch immediately on launch is the honest UX (the user
  // mid-deposit doesn't want to hunt for the right sheet after a restart). Scans the catalog's
  // CkEthErc20 currencies (the only family whose CkErc20DepositSheet persists a watching key) and
  // opens the first one with a persisted watching state. Once-only (a manual sheet-close must NOT be
  // re-opened by a later catalog refresh); the `?screen=deposit` deep link seeds the ckBTC sheet, so
  // it is left alone when present.
  const autoOpenAttempted = useRef(false);
  useEffect(() => {
    if (autoOpenAttempted.current) return;
    autoOpenAttempted.current = true;
    if (readDepositDeepLink()) return; // deep link takes priority (opens ckBTC, no ckERC20 resume)
    let alive = true;
    (async () => {
      for (const a of catalog) {
        if (a.minter_family !== 'CkEthErc20') continue;
        const persisted = await loadDeposit(identity.publicHex, a.currency);
        if (!alive) return;
        if (persisted && persisted.phase === 'watching') {
          setDepositCurrency(a.currency);
          return; // one resume is enough
        }
      }
    })();
    return () => { alive = false; };
    // Mount-only: `catalog` at mount is the bundled default (covers every shipped ckERC20 id). The
    // scan reads AsyncStorage directly, independent of catalog state. Re-running on a catalog refresh
    // would re-open a sheet the user may have just closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), BALANCE_TIMEOUT_MS);
      // Non-primary asset balances run in PARALLEL + best-effort, each with its own AbortController,
      // so a hiccup on one asset's ledger can never flip the primary `$` balance offline or fail its
      // poll. The assets live on separate ledgers — fetching one must not affect another's display. A
      // null result keeps the prior value (no flap on a single miss). Covers EVERY non-primary catalog
      // currency (ramp + no-minter ICRC), so an unfunded asset still reads its real zero balance.
      const assetFetches = displayAssets.map(a => {
        const c = new AbortController();
        const to = setTimeout(() => c.abort(), BALANCE_TIMEOUT_MS);
        return fetch(`${base(relayUrl)}/api/v1/balance/${identity.publicHex}?currency=${a.currency}`, {signal: c.signal})
          .then(r => r.ok ? r.json().catch(() => null) : null)
          .then(j => (j && typeof j.balance === 'string') ? (j.balance as string) : null)
          .catch(() => null)
          .finally(() => clearTimeout(to))
          .then(b => ({currency: a.currency, balance: b}));
      });
      try {
        const r = await fetch(`${base(relayUrl)}/api/v1/balance/${identity.publicHex}`, {signal: ctrl.signal});
        const j = await r.json();
        // MC5: reset ONLY the DEMO (currency-0) offline deduction on a successful primary poll — the
        // authoritative balance replaces the local optimistic view, and any pending offline DEMO
        // hand-off has either settled (reflected in this balance) or never will (stale). Per-asset
        // deductions reset on their own per-currency poll below (same rationale, per asset).
        if (alive && r.ok && typeof j.balance === 'string') { setBalance(j.balance); setOnline(true); setOfflineSpent(prev => prev[0] != null && prev[0] !== '0' ? {...prev, 0: '0'} : prev); }
        else if (alive) setOnline(false);
      } catch { if (alive) setOnline(false); } finally { clearTimeout(t); }
      // Settle the asset balances after the primary poll resolves; merge keeping prior on null.
      // MC5: a successful asset poll resets that currency's offline deduction (the authoritative
      // polled balance replaces the optimistic local view — same rationale as the DEMO reset above).
      const results = await Promise.all(assetFetches);
      if (alive) {
        setAssetBalances(prev => {
          const next = {...prev};
          for (const {currency, balance} of results) if (balance != null) next[currency] = balance;
          return next;
        });
        setOfflineSpent(prev => {
          let changed = false;
          const next = {...prev};
          for (const {currency, balance} of results) {
            if (balance != null && next[currency] != null && next[currency] !== '0') { next[currency] = '0'; changed = true; }
          }
          return changed ? next : prev;
        });
      }
    };
    poll(); const id = setInterval(poll, POLL.balance);
    return () => { alive = false; clearInterval(id); };
  }, [relayUrl, identity.publicHex, displayCurrencyIds]);

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
      const t = setTimeout(() => ctrl.abort(), BALANCE_TIMEOUT_MS);
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
      const fromName = rec.from_name ?? '';
      const toName = rec.to_name ?? '';
      const memo = rec.memo ?? '';
      // N6/H3 RESOLVED: the counterparty's display name now rides the signed wire (from_name/to_name)
      // and is returned per row by the relay. For an OUT row (I am `from`) the counterparty is `to`
      // → show to_name; for an IN row the counterparty is `from` → show from_name. Fall back to the
      // short hex ONLY when no name was signed (unnamed payment); the mint sentinel keeps its label.
      const who = isMintSentinel(counterparty)
        ? (dir === 'in' ? 'Demo funds' : 'Withdrawal')
        : (dir === 'out' ? (toName || short(rec.to)) : (fromName || short(rec.from)));
      return {nonce: rec.nonce, amount: rec.amount, who, memo, time: fmtTime(rec.timestamp), dir, currency: rec.currency};
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
  // MC5 — currency-KEYED offline deduction. The reducer sums BigInt(amount) under the given currency
  // key; the negative case (the refund-on-failed-but-signed NFC path) UNDOES a prior deduction. The
  // per-asset balance display + gate read this map through `applyOffline` (cmpRaw-guarded, never
  // below 0). MC1 units 2-4: amount is a raw-u64 decimal STRING; never `+`/`-` on strings.
  const markOfflinePaid = useCallback((amount: string, currency: number) => setOfflineSpent(prev => {
    const cur = prev[currency] ?? '0';
    const next = BigInt(cur) + BigInt(amount);
    return {...prev, [currency]: (next < 0n ? 0n : next).toString()};
  }), []);
  // The DEMO header balance (currency 0): when online the polled balance is authoritative (the
  // deduction resets on every successful poll); when offline we apply the per-currency deduction.
  const shownBalance = applyOffline(balance, online ? {} : offlineSpent, 0);
  // MC5 — the per-asset displayed balances fed to children. Online ⇒ the polled authoritative
  // values (offlineSpent resets on each successful poll, so passing {} is equivalent). Offline ⇒ the
  // deduction applies so the card + the per-asset balance gate honestly reflect the in-flight
  // hand-off. This is the SAME map the DEMO shownBalance reads; keyed by currency, never cross-talk.
  const displayAssetBalances = useMemo(() => {
    if (online) return assetBalances;
    const next: Record<number, string> = {};
    for (const [k, v] of Object.entries(assetBalances)) {
      const c = Number(k);
      next[c] = applyOffline(v, offlineSpent, c) ?? v;
    }
    return next;
  }, [assetBalances, offlineSpent, online]);

  // Demo top-up: POST /api/v1/faucet {account, amount}. Uses the response balance directly for an
  // immediate refresh (no waiting on the 2.5s poll). Errors are surfaced inline under the button.
  const topUp = useCallback(async () => {
    if (topUpBusy) return;
    setTopUpBusy(true); setTopUpErr(null);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FAUCET_TIMEOUT_MS);
    try {
      const r = await fetch(`${base(relayUrl)}/api/v1/faucet`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({account: identity.publicHex, amount: TOP_UP_CENTS}),
        signal: ctrl.signal,
      });
      const j = await readJsonOrEmpty(r);
      if (r.ok && typeof j.balance === 'string') {
        // MC5: topUp is a DEMO (currency-0) credit, so reset ONLY the currency-0 offline deduction.
        setBalance(j.balance); setOnline(true); setOfflineSpent(prev => prev[0] != null && prev[0] !== '0' ? {...prev, 0: '0'} : prev);
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

  // Web keyboard shortcuts (plan 1b / UX-V5): the first letters of the main actions —
  // P=Pay, R=Receive, T=Top-up (demo money), A=Balances (the asset hub). Active ONLY on the wallet
  // main view with no text input focused and no sheet/overlay open (Esc is handled per-sheet by
  // useEscapeToClose). Native (no physical keyboard) is a no-op; the on-UI hints are web-only too.
  const anySheetOpen = balancesOpen || depositCurrency != null || withdrawCurrency != null || settingsOpen;
  useHotkeys({
    p: () => setMode('pay'),
    r: () => setMode('receive'),
    t: topUp,
    a: () => setBalancesOpen(true),
  }, {ignoreIfInputFocused: true, enabled: !anySheetOpen});

  return (
    <SafeAreaView style={S.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} translucent={false} />
      <View style={S.header}>
        <View style={S.headerLeft}>
          <Pressable
            testID="btn-settings"
            style={S.headerSettingsBtn}
            onPress={() => setSettingsOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            accessibilityHint="Open relay, reset, and advanced settings"
          >
            <Text style={S.headerSettingsIcon}>⚙</Text>
          </Pressable>
          <View>
            <Wordmark style={S.brand} />
            {/* H4: the header shows ONLY the username. The hex pubkey was developer-facing protocol data
                ("Alice · 1b8a5ee7…") that made the header read like a debug panel; it's removed from the
                main display. The short hex is no longer appended anywhere in the header. */}
            <Text style={S.who} testID="header-who">{identity.username}</Text>
          </View>
        </View>
        <Pressable
          testID="balance"
          style={S.balBox}
          onPress={() => setBalancesOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Balances — switch currency or top up"
          accessibilityHint="Open the full asset list, switch the displayed currency, or top up"
        >
          <View style={S.balLabelRow}>
            <View style={[S.dot, {backgroundColor: online ? C.ok : C.sub2}]} />
            <Text style={S.balLabel}>{online ? 'balance' : '~ approx.'}</Text>
            <HotkeyHint k="A" />
          </View>
          <View style={S.balAmtRow}>
            {/* The header shows ONLY the current currency's balance. DEMO (currency 0) keeps its
                offline '~' approx + null '—' handling; an asset shows its polled balance formatted
                in native units. */}
            {/* The header shows ONLY the current currency's balance. DEMO (currency 0) keeps its
                offline '~' approx + null '—' handling; an asset shows its polled balance formatted
                in native units. MC5: a non-DEMO asset applies the per-currency offline deduction via
                `displayAssetBalances` (the per-currency deduction never crosses assets). */}
            <Text style={S.balAmt}>{currentCurrency === 0
              ? (shownBalance == null ? '—' : `${online ? '' : '~'}${usd(shownBalance)}`)
              : fmtCurrencyAmount(catalog, currentCurrency, displayAssetBalances[currentCurrency] ?? '0')}</Text>
            <Text style={S.swapHint}>⇅</Text>
          </View>
        </Pressable>
      </View>

      <View style={S.tabs}>
        <Tab label="Pay" active={mode === 'pay'} onPress={() => setMode('pay')} hotkey="P" />
        <Tab label="Receive" active={mode === 'receive'} onPress={() => setMode('receive')} hotkey="R" />
        <Tab label="Transactions" active={mode === 'ledger'} onPress={() => setMode('ledger')} />
      </View>

      <ScrollView style={S.scroll} contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        {mode === 'pay'
          ? <PayMode identity={identity} online={online} relayUrl={relayUrl} nfcStatus={nfc} onSettled={onActivity} onOfflinePaid={markOfflinePaid} shownBalance={shownBalance} catalog={catalog} assetBalances={displayAssetBalances} />
          : mode === 'receive'
          ? <ReceiveMode identity={identity} relayUrl={relayUrl} nfcReady={nfc === 'ready'} onReceived={onActivity} catalog={catalog} />
          : <Ledger history={history} catalog={catalog} />}
      </ScrollView>

      {balancesOpen ? (
        <BalancesSheet
          catalog={catalog}
          assetBalances={displayAssetBalances}
          primaryBalance={shownBalance}
          online={online}
          currentCurrency={currentCurrency}
          onSelect={(currency) => { setCurrentCurrency(currency); setBalancesOpen(false); }}
          onTopUp={topUp}
          topUpBusy={topUpBusy}
          topUpErr={topUpErr}
          onAdd={(currency) => { setDepositCurrency(currency); setBalancesOpen(false); }}
          onWithdraw={(currency) => { setWithdrawCurrency(currency); setBalancesOpen(false); }}
          onClose={() => setBalancesOpen(false)}
        />
      ) : null}
      {depositCurrency != null ? (() => {
        // MC1 unit 6 — FAIL-CLOSED: the deposit sheet is rendered ONLY when familyDisplay is
        // non-null (a known family). The BalancesSheet "Top Up" button is already gated on a known
        // family, so this is unreachable in normal flow; but if an unknown family reaches here we
        // render nothing instead of a mis-rendered BTC/ETH form (no silent wrong-currency fallback).
        const dpDisplay = familyDisplay(catalog, depositCurrency);
        if (!dpDisplay) return null;
        return catalog.find(c => c.currency === depositCurrency)?.minter_family === 'CkEthErc20'
          ? <CkErc20DepositSheet identity={identity} relayUrl={relayUrl} currency={depositCurrency} display={dpDisplay} chainId={catalog.find(c => c.currency === depositCurrency)?.chain_id ?? null} onClose={() => setDepositCurrency(null)} />
          : <DepositSheet identity={identity} relayUrl={relayUrl} currency={depositCurrency} display={dpDisplay} onClose={() => setDepositCurrency(null)} />;
      })() : null}
      {withdrawCurrency != null ? (() => {
        // MC1 unit 6 — FAIL-CLOSED: cash-out is offered ONLY for CkBtcUtxo (BalancesSheet gates the
        // button on family + funded). An unknown/non-BTC family renders nothing instead of a BTC
        // cash-out form. Removes the old `?? 'CkBtcUtxo'` fail-open family default.
        const wdDisplay = familyDisplay(catalog, withdrawCurrency);
        const wdFamily = catalog.find(c => c.currency === withdrawCurrency)?.minter_family ?? null;
        if (wdFamily !== 'CkBtcUtxo' || !wdDisplay) return null;
        return (
          <WithdrawSheet
            identity={identity}
            relayUrl={relayUrl}
            currency={withdrawCurrency}
            display={wdDisplay}
            family={wdFamily}
            ckBtcBalance={assetBalances[withdrawCurrency] ?? '0'}
            onClose={() => setWithdrawCurrency(null)}
            onWithdrawn={onActivity}
          />
        );
      })() : null}
      {settingsOpen ? (
        <SettingsSheet
          relayUrl={relayUrl}
          setRelayUrl={setRelayUrl}
          onClose={() => setSettingsOpen(false)}
          onReset={onReset}
        />
      ) : null}
    </SafeAreaView>
  );
}
