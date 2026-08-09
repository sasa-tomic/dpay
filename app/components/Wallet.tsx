import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {SafeAreaView, StatusBar, View, Text, Pressable, ScrollView, AppState, Linking} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {C} from '../config/palette';
import {S} from '../styles';
import {TOP_UP_CENTS, FAUCET_TIMEOUT_MS, SHOW_TESTNET_STORAGE_KEY} from '../config/constants';
import {familyDisplay, fmtCurrencyAmount} from '../config/catalog';
import {usd, base, fmtAsset} from '../lib/format';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {cmpRaw, applyOffline} from '../lib/amount';
import type {Identity, NfcStatus} from '../lib/types';
import {DpayCore} from '../services/native';
import {loadDeposit} from '../services/ckerc20Persist';
import {fetchWithTimeout, readJsonOrEmpty} from '../services/relay';
import {useHotkeys} from '../hooks/useHotkeys';
import {useCatalog} from '../hooks/useCatalog';
import {useBalancePoll} from '../hooks/useBalancePoll';
import {useSolanaBalance} from '../hooks/useSolanaBalance';
import {useTransactionHistory} from '../hooks/useTransactionHistory';
import {deriveSolanaAddress} from '../solana';
import {readDepositDeepLink, readRequestDeeplink, readPaymentDeeplink, decodeDeeplink, type DeeplinkKind} from '../lib/deepLink';
import {Wordmark} from './Logo';
import {HotkeyHint} from './HotkeyHint';
import {Tab} from './Tab';
import {PayMode} from './PayMode';
import {ReceiveMode} from './ReceiveMode';
import {Ledger} from './Ledger';
import {DepositSheet} from './DepositSheet';
import {WithdrawSheet} from './WithdrawSheet';
import {SolanaReceiveSheet} from './SolanaReceiveSheet';
import {SolanaWithdrawSheet} from './SolanaWithdrawSheet';
import {SolPayMode} from './SolPayMode';
import {SolReceiveMode} from './SolReceiveMode';
import {SettingsSheet} from './SettingsSheet';
import {CkErc20DepositSheet} from './CkErc20DepositSheet';
import {BalancesSheet} from './BalancesSheet';

export function Wallet({identity, relayUrl, setRelayUrl, onReset}: {identity: Identity; relayUrl: string; setRelayUrl: (s: string) => void; onReset: () => void}) {
  const [mode, setMode] = useState<'pay' | 'receive' | 'ledger'>('pay');
  // Deeplink prefill (item 6): a `dpay:req/<blob>` (or the web `?req=<blob>` mirror) sets the raw
  // base64url blob + flips mode to 'pay'; PayMode consumes it via its prefill effect (which reuses
  // the camera-scan decode path), then calls onPrefillConsumed to clear it. A deeplink ONLY
  // pre-fills review — it never auto-signs/approves.
  const [prefillRequest, setPrefillRequest] = useState<string | null>(null);
  // The symmetric `dpay:pay/<blob>` (NFC-less receipt hand-back): a payer who settled online shares
  // the canister-signed receipt back to the merchant. This holds the raw blob; ReceiveMode consumes
  // it via its verify effect (decode → verifyOutcomeReceipt → reconcile as Paid), then calls
  // onReceiptConsumed to clear it. SECURITY: ReceiveMode verifies the signature BEFORE showing Paid.
  const [prefillReceipt, setPrefillReceipt] = useState<string | null>(null);
  // The "current" currency — the one whose balance the header reflects. Tapping the header balance
  // opens the Balances sheet, where tapping a currency row sets this. Currency 0 (DEMO) is the
  // default. This replaces the old DEMO-only header (the founder's restructure): the main screen now
  // shows a single selected currency's balance, and the full asset list + every top-up live in the
  // Balances sheet. Pay/Receive still settle in whatever currency a request specifies (unchanged).
  const [currentCurrency, setCurrentCurrency] = useState(0);
  const [balancesOpen, setBalancesOpen] = useState(false);
  const [nfc, setNfc] = useState<NfcStatus>('unknown');
  // Demo top-up: a single click adds $100 of demo currency via /api/v1/faucet. The button sits next
  // to the balance so users find it without hunting. `topUpBusy` drives the spinner; `topUpErr`
  // surfaces a one-line failure (offline / faucet disabled) without blocking the rest of the UI.
  const [topUpBusy, setTopUpBusy] = useState(false);
  const [topUpErr, setTopUpErr] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  // Whether testnet currencies (network "Bitcoin Testnet"/"Sepolia") are revealed in the Balances
  // sheet. Hidden by default (founder decision); persisted so the choice survives a restart. Mirrors
  // the identity/relay AsyncStorage pattern (best-effort load; a read failure falls back to hidden).
  const [showTestnet, setShowTestnet] = useState(false);
  // Currency catalog — the runtime source of truth for which assets exist + how to display/fund
  // them. Loaded from AsyncStorage cache then refreshed from GET /currencies on mount; the bundled
  // default covers a cold first load. The ckBTC currency id (and any future asset's) is RESOLVED
  // from this, never hardcoded (issue #7).
  const catalog = useCatalog(relayUrl);

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
  // Primary + per-asset balance poll + the MC5 currency-keyed offline-deduction state. Extracted
  // verbatim into hooks/useBalancePoll.ts (Effect B); the poll's own deduction resets stay internal
  // (coupled to a successful fetch), `markOfflinePaid` is the offline hand-off debit, and
  // `resetDeduction`/`setBalance`/`setOnline` are exposed for the faucet topUp's immediate-refresh
  // path below (it credits the DEMO balance out-of-band and clears the currency-0 deduction without
  // waiting on the 2.5s poll).
  const {
    balance, online, assetBalances, offlineSpent,
    markOfflinePaid, resetDeduction, setBalance, setOnline,
  } = useBalancePoll({relayUrl, publicHex: identity.publicHex, displayAssets, displayCurrencyIds});
  // Durable transaction history sourced from the ledger. Extracted verbatim into
  // hooks/useTransactionHistory.ts (Effect C): the per-currency fan-out + dedup-by-nonce + sort +
  // direction-derivation all move in. catalogCurrencyIds (the stable dep signature) is now internal
  // to the hook (computed from `catalog`). `onActivity` below still calls refreshHistory.
  const {history, refreshHistory} = useTransactionHistory({relayUrl, publicHex: identity.publicHex, catalog});

  // Native SOL rail — a device-derived Solana key (SLIP-10 m/44'/501'/0'/0') from the SAME IC identity
  // seed, so one backup recovers both rails. The address is derived once (pure; stable per identity).
  // useSolanaBalance polls the SOL RPC directly (no relay); when SOLANA_RPC_URL is empty (jest/e2e)
  // it no-ops and the card renders `—`. Separate from the catalog loop — SOL is not an ICRC asset.
  const solAddress = useMemo(() => { try { return deriveSolanaAddress(identity.secretHex); } catch { return null; } }, [identity.secretHex]);
  const {balance: solBalance, refresh: refreshSol} = useSolanaBalance(solAddress);
  const [solReceiveOpen, setSolReceiveOpen] = useState(false);
  const [solSendOpen, setSolSendOpen] = useState(false);
  // The active asset rail: true when the user has selected SOL in the Balances sheet, false for any
  // IC catalog currency. This REPLACES the old RailSelector toggle — the selected currency now
  // IMPLIES the rail (SOL → SOL NFC HCE / SOL send-receive; any IC currency → IC NFC HCE / IC
  // send-receive). The NFC AID is still armed before a tap — it's just driven by the asset
  // selection instead of a separate toggle. IC and SOL use SEPARATE NFC HCE services (DpayNfc AID
  // `…01` vs DpaySolNfc AID `…02`); switching the active asset unmounts the old mode component,
  // whose useNfcTapState cleanup disarms the HCE card/reader (no arm-leak).
  const [activeSol, setActiveSol] = useState(false);

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

  // Load the persisted testnet-visibility preference on mount (default false). Best-effort: a read
  // failure leaves it hidden (never blocks the UI).
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(SHOW_TESTNET_STORAGE_KEY)
      .then((v) => { if (alive && v === 'true') setShowTestnet(true); })
      .catch((e: unknown) => { console.log(`[dpay] failed to load showTestnet: ${e instanceof Error ? e.message : String(e)}`); });
    return () => { alive = false; };
  }, []);

  // Toggle + persist the testnet-visibility preference. The Balances sheet renders the toggle only
  // when there's something to reveal, so this fires solely from a meaningful affordance.
  const toggleTestnet = useCallback(() => {
    setShowTestnet((prev) => {
      const next = !prev;
      AsyncStorage.setItem(SHOW_TESTNET_STORAGE_KEY, next ? 'true' : 'false').catch((e: unknown) => {
        console.log(`[dpay] failed to persist showTestnet: ${e instanceof Error ? e.message : String(e)}`);
      });
      return next;
    });
  }, []);

  // Deeplink routing (item 6 + receipt hand-back): a `dpay:req/<blob>` arriving at launch pre-fills
  // the Pay review screen; a `dpay:pay/<blob>` carries a canister-signed receipt to the merchant's
  // Receive screen. Two receive paths each, both bounded + best-effort (a failure just doesn't
  // prefill — but it's logged, never swallowed):
  //   • Web: readRequestDeeplink()/readPaymentDeeplink() read `?req=`/`?pay=` from the page URL (the
  //     OS scheme never fires on web — there's no dpay: handler in a browser).
  //   • Native: Linking.getInitialURL() returns the dpay: URI the OS handed the app on launch
  //     (Android intent-filter), and the 'url' listener catches a dpay: link tapped while the app is
  //     foreground. On web getInitialURL returns the http page URL → decodeDeeplink → null → no-op,
  //     so BOTH paths are safe to run on every platform and decodeDeeplink's null cleanly separates.
  // getInitialURL is wrapped in a 2s timeout so a stalled native bridge can't wedge the prefill (the
  // repo rule: all I/O has a timeout). SECURITY: applyBlob only sets a blob + mode — it never signs
  // (req) and never marks Paid (pay — ReceiveMode verifies the receipt signature first).
  useEffect(() => {
    let alive = true;
    const applyBlob = (kind: DeeplinkKind, blob: string) => {
      if (!alive) return;
      if (kind === 'req') { setPrefillRequest(blob); setMode('pay'); }
      else { setPrefillReceipt(blob); setMode('receive'); }
      // A6 — a req/pay deep link targets a specific Pay/Receive flow, so dismiss the Balances landing
      // sheet (it would otherwise overlay the deep-linked screen).
      setBalancesOpen(false);
    };
    // Web path first (sync read of ?req= / ?pay=).
    const webReq = readRequestDeeplink();
    if (webReq) applyBlob('req', webReq);
    const webPay = readPaymentDeeplink();
    if (webPay) applyBlob('pay', webPay);
    // Native path: the launch dpay: URI, timeout-bounded. On web this resolves to the page URL and
    // decodeDeeplink returns null (harmless fall-through — the web readers above already handled the
    // query params).
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000));
    const initial = (Linking.getInitialURL?.() ?? Promise.resolve(null)) as Promise<string | null>;
    Promise.race([initial, timeout])
      .then((url) => {
        if (!alive || !url) return;
        const dl = decodeDeeplink(String(url));
        if (dl) applyBlob(dl.kind, dl.blob);
      })
      .catch((e: unknown) => { console.log(`[dpay] deeplink getInitialURL failed: ${e instanceof Error ? e.message : String(e)}`); });
    // Foreground links: a dpay: link tapped while the app is already open.
    const sub = Linking.addEventListener('url', ({url}) => {
      const dl = decodeDeeplink(url);
      if (dl) applyBlob(dl.kind, dl.blob);
    });
    return () => { alive = false; sub.remove(); };
  }, []);

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

  // Children signal that a payment activity happened; the ledger-sourced `refreshHistory` is the SOLE
  // writer to `history` (fetched eagerly inside the hook — no optimistic in-memory state). Stable
  // across renders.
  const onActivity = useCallback(() => { refreshHistory(); }, [refreshHistory]);
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
    try {
      const r = await fetchWithTimeout(`${base(relayUrl)}/api/v1/faucet`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({account: identity.publicHex, amount: TOP_UP_CENTS}),
      }, FAUCET_TIMEOUT_MS);
      const j = await readJsonOrEmpty(r);
      if (r.ok && typeof j.balance === 'string') {
        // MC5: topUp is a DEMO (currency-0) credit, so reset ONLY the currency-0 offline deduction.
        // The balance + online setters + resetDeduction come from useBalancePoll (the poll owns that
        // state; the next poll tick overwrites both authoritatively).
        setBalance(j.balance); setOnline(true); resetDeduction(0);
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
      setTopUpBusy(false);
    }
  }, [topUpBusy, relayUrl, identity.publicHex, setBalance, setOnline, resetDeduction]);

  // Web keyboard shortcuts (plan 1b / UX-V5): the first letters of the main actions —
  // P=Pay, R=Receive, T=Receive (demo money), A=Balances (the asset hub), L=Ledger (transactions). Active ONLY on the wallet
  // main view with no text input focused and no sheet/overlay open (Esc is handled per-sheet by
  // useEscapeToClose). Native (no physical keyboard) is a no-op; the on-UI hints are web-only too.
  const anySheetOpen = balancesOpen || depositCurrency != null || withdrawCurrency != null || settingsOpen || solReceiveOpen || solSendOpen;
  useHotkeys({
    p: () => setMode('pay'),
    r: () => setMode('receive'),
    t: topUp,
    a: () => setBalancesOpen(true),
    l: () => setMode('ledger'),
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
            {/* H4 + audit P1: the header shows ONLY the username. The hex pubkey was developer-facing
                protocol data ("Alice · 1b8a5ee7…") that made the header read like a debug panel; it's
                removed from the main display. The short hex is no longer appended anywhere in the
                header. A small "ACCOUNT" eyebrow above the username separates the wordmark from the
                user identity so the pair no longer reads as a single currency label (a fresh-eyes
                vision misread). The `header-who` element still holds ONLY the username (e2e contract). */}
            <Text style={S.whoLabel} accessibilityLabel="Account">ACCOUNT</Text>
            <Text style={S.who} testID="header-who">{identity.username}</Text>
          </View>
        </View>
        <Pressable
          testID="balance"
          style={S.balBox}
          onPress={() => setBalancesOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Balances — switch currency or receive"
          accessibilityHint="Open the full asset list, switch the displayed currency, or receive"
        >
          <View style={S.balLabelRow}>
            <View style={[S.dot, {backgroundColor: online ? C.ok : C.sub2}]} />
            <Text style={S.balLabel}>{activeSol ? 'balance' : (online ? 'balance' : '~ approx.')}</Text>
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
            <Text style={S.balAmt}>{activeSol
              ? (solBalance == null ? '—' : fmtAsset(solBalance, SOL_DECIMALS, SOL_UNIT))
              : currentCurrency === 0
                ? (shownBalance == null ? '—' : `${online ? '' : '~'}${usd(shownBalance)}`)
                : fmtCurrencyAmount(catalog, currentCurrency, displayAssetBalances[currentCurrency] ?? '0')}</Text>
            <Text style={S.swapHint}>⇅</Text>
          </View>
        </Pressable>
      </View>

      <View style={S.tabs}>
        <Tab label="Pay" active={mode === 'pay'} onPress={() => setMode('pay')} hotkey="P" />
        <Tab label="Receive" active={mode === 'receive'} onPress={() => setMode('receive')} hotkey="R" />
        <Tab label="Transactions" active={mode === 'ledger'} onPress={() => setMode('ledger')} hotkey="L" />
        {/* A6 — active-rail/asset chip: labels which asset's Pay/Receive flow is armed (SOL vs the
            selected IC currency) so a user who switched to SOL in the Balances sheet doesn't get
            silently stuck in SOL mode (the IC ↔ SOL NFC AIDs differ). */}
        <View testID="active-rail-chip" style={S.activeRailChip}>
          <Text style={S.activeRailChipText}>{activeSol ? 'SOL' : (currentCurrency === 0 ? 'DEMO' : (catalog.find(c => c.currency === currentCurrency)?.wrapper_name ?? 'IC'))}</Text>
        </View>
      </View>

      <ScrollView style={S.scroll} contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        {mode === 'pay'
          ? (activeSol && solAddress
              ? <SolPayMode identity={identity} online={online} nfcReady={nfc === 'ready'} onShowDeposit={() => setSolReceiveOpen(true)} />
              : <PayMode identity={identity} online={online} relayUrl={relayUrl} nfcStatus={nfc} onSettled={onActivity} onOfflinePaid={markOfflinePaid} shownBalance={shownBalance} catalog={catalog} assetBalances={displayAssetBalances} prefillRequest={prefillRequest} onPrefillConsumed={() => setPrefillRequest(null)} />
          )
          : mode === 'receive'
          ? (activeSol && solAddress
              ? <SolReceiveMode identity={identity} online={online} nfcReady={nfc === 'ready'} />
              : <ReceiveMode identity={identity} relayUrl={relayUrl} online={online} nfcReady={nfc === 'ready'} onReceived={onActivity} catalog={catalog} prefillReceipt={prefillReceipt} onReceiptConsumed={() => setPrefillReceipt(null)} />
          )
          : <Ledger history={history} catalog={catalog} />}
      </ScrollView>

      {balancesOpen ? (
        <BalancesSheet
          catalog={catalog}
          assetBalances={displayAssetBalances}
          primaryBalance={shownBalance}
          online={online}
          currentCurrency={currentCurrency}
          onSelect={(currency) => { setCurrentCurrency(currency); setActiveSol(false); setBalancesOpen(false); }}
          onTopUp={topUp}
          topUpBusy={topUpBusy}
          topUpErr={topUpErr}
          onAdd={(currency) => { setDepositCurrency(currency); setBalancesOpen(false); }}
          onWithdraw={(currency) => { setWithdrawCurrency(currency); setBalancesOpen(false); }}
          solAddress={solAddress}
          solBalance={solBalance}
          activeSol={activeSol}
          onSelectSol={() => { setActiveSol(true); setBalancesOpen(false); }}
          onSolReceive={() => { setSolReceiveOpen(true); setBalancesOpen(false); }}
          onSolSend={() => { setSolSendOpen(true); setBalancesOpen(false); }}
          showTestnet={showTestnet}
          onToggleTestnet={toggleTestnet}
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
        const dpDesc = catalog.find(c => c.currency === depositCurrency);
        return dpDesc?.minter_family === 'CkEthErc20'
          ? <CkErc20DepositSheet identity={identity} relayUrl={relayUrl} currency={depositCurrency} display={dpDisplay} chainId={dpDesc?.chain_id ?? null} nativeEth={dpDesc?.token_contract == null} onClose={() => setDepositCurrency(null)} />
          : <DepositSheet identity={identity} relayUrl={relayUrl} currency={depositCurrency} display={dpDisplay} onClose={() => setDepositCurrency(null)} />;
      })() : null}
      {withdrawCurrency != null ? (() => {
        // MC1 unit 6 — FAIL-CLOSED: cash-out is offered ONLY for an asset whose family has a native
        // offramp — ckBTC (CkBtcUtxo → retrieve_btc) or any CkEthErc20 asset whose `offramp` is
        // enabled (native ckETH → withdraw_eth, single-ledger; ckERC20 tokens like ckUSDC →
        // withdraw_erc20, dual-ledger). The BalancesSheet gates the button on the same predicate; an
        // unknown family renders nothing instead of a wrong cash-out form.
        const wdDisplay = familyDisplay(catalog, withdrawCurrency);
        const wdCur = catalog.find(c => c.currency === withdrawCurrency);
        const wdFamily = wdCur?.minter_family ?? null;
        if (!wdDisplay || !wdFamily) return null;
        if (wdFamily !== 'CkBtcUtxo' && wdFamily !== 'CkEthErc20') return null;
        return (
          <WithdrawSheet
            identity={identity}
            relayUrl={relayUrl}
            currency={withdrawCurrency}
            display={wdDisplay}
            family={wdFamily}
            tokenContract={wdCur?.token_contract ?? null}
            balance={assetBalances[withdrawCurrency] ?? '0'}
            onClose={() => setWithdrawCurrency(null)}
            onWithdrawn={onActivity}
          />
        );
      })(      ) : null}
      {solReceiveOpen && solAddress ? (
        <SolanaReceiveSheet
          address={solAddress}
          onClose={() => setSolReceiveOpen(false)}
        />
      ) : null}
      {solSendOpen && solAddress ? (
        <SolanaWithdrawSheet
          identity={identity}
          balance={solBalance ?? '0'}
          onSent={refreshSol}
          onClose={() => setSolSendOpen(false)}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsSheet
          relayUrl={relayUrl}
          setRelayUrl={setRelayUrl}
          onClose={() => setSettingsOpen(false)}
          onReset={onReset}
          secretHex={identity.secretHex}
        />
      ) : null}
    </SafeAreaView>
  );
}
