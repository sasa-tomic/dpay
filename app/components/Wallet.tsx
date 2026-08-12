import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {SafeAreaView, StatusBar, View, Text, Pressable, ScrollView, AppState, Linking} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {C} from '../config/palette';
import {S} from '../styles';
import {TOP_UP_CENTS, FAUCET_TIMEOUT_MS, SHOW_TESTNET_STORAGE_KEY} from '../config/constants';
import {familyDisplay, isTestnetCurrency} from '../config/catalog';
import {base} from '../lib/format';
import {applyOffline} from '../lib/amount';
import {buildSelectableAssets, reconcileSelectedAsset, routeDeeplinkToIc, shouldAllowUserSelect, solanaUsdcAvailable} from '../config/assets';
import {buildAssetBalances} from '../lib/assetBalances';
import type {AssetId, Identity, NfcStatus} from '../lib/types';
import {DpayCore} from '../services/native';
import {loadDeposit} from '../services/ckerc20Persist';
import {fetchWithTimeout, readJsonOrEmpty} from '../services/relay';
import {useHotkeys} from '../hooks/useHotkeys';
import {useCatalog} from '../hooks/useCatalog';
import {useBalancePoll} from '../hooks/useBalancePoll';
import {useSolanaBalances} from '../hooks/useSolanaBalances';
import {useTransactionHistory} from '../hooks/useTransactionHistory';
import {deriveSolanaAddress} from '../solana';
import {readDepositDeepLink, readRequestDeeplink, readPaymentDeeplink, decodeDeeplink, type DeeplinkKind} from '../lib/deepLink';
import {Wordmark} from './Logo';
import {HotkeyHint} from './HotkeyHint';
import {Tab} from './Tab';
import {PayMode} from './PayMode';
import {ReceiveMode} from './ReceiveMode';
import {Ledger} from './Ledger';
import {SolPayMode} from './SolPayMode';
import {SolReceiveMode} from './SolReceiveMode';
import {SettingsSheet} from './SettingsSheet';
import {BalancesSheet} from './BalancesSheet';

export function Wallet({identity, relayUrl, setRelayUrl, onReset, onRestore}: {identity: Identity; relayUrl: string; setRelayUrl: (s: string) => void; onReset: () => void; onRestore: (id: Identity) => Promise<void>}) {
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
  // THE one user-selection state (Phase 3 — 2026-08-12 unified asset selection rewrite). A single
  // stable `AssetId` (`ic:${currency}` | 'solana:SOL' | 'solana:USDC') is the SOLE idle selection
  // truth. It replaces the old `currentCurrency: number` + `activeSol: boolean` pair whose split was
  // the root cause of the Balances↔Receive inconsistency and the SOL picker collapse. Every derived
  // value (header name/balance, active chip, which Pay/Receive engine mounts, deposit/withdraw
  // family, NFC AID dispatch) is computed from `selectedAsset` below. `null` only before the first
  // reconcile runs; `effectiveSelectedId` (the reconciled value) is what every render reads.
  const [selectedAssetId, setSelectedAssetId] = useState<AssetId | null>(null);
  const [balancesOpen, setBalancesOpen] = useState(false);
  // Phase 5 — selection lock. While the mounted Pay/Receive engine is mid-flight (a pay review/qr/
  // paid, or a receive request-QR/result), it reports `true` via `onLockChange`. A USER-initiated
  // asset switch (Balances button, AssetPicker) is then suppressed so the active engine is not
  // unmounted — that would destroy the captured, immutable request snapshot the review reads. The
  // lock is per-component and resets on unmount (see useReportLock); a tab switch to Ledger clears it.
  // PROGRAMMATIC selection (deeplink routing — see the routing effect below) calls setSelectedAssetId
  // directly and bypasses this lock: an incoming request must always route to its engine.
  const [selectionLocked, setSelectionLocked] = useState(false);
  // Within-tab sub-modes for the Receive/Pay IA: "request"/"address" (Receive) and "scan"/"send"
  // (Pay). The on-chain deposit + withdraw surfaces now live INLINE in these tabs (lifted out of the
  // Balances per-row buttons + the overlay sheets). Owned here so deeplinks (?screen=deposit, the
  // auto-open-ckERC20 effect) can land the user directly on the right sub-mode + asset.
  const [receiveSubMode, setReceiveSubMode] = useState<'request' | 'address'>('request');
  const [paySubMode, setPaySubMode] = useState<'scan' | 'send'>('scan');
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
  // useSolanaBalances polls the SOL RPC directly (no relay) AND the device's USDC ATA concurrently
  // with independent statuses; when SOLANA_RPC_URL is empty (jest/e2e) it no-ops and the SOL card
  // renders `—`. Both halves feed the per-asset balance map below.
  const solAddress = useMemo(() => {
    try { return deriveSolanaAddress(identity.secretHex); }
    catch (e) { console.warn('deriveSolanaAddress failed:', e instanceof Error ? e.message : String(e)); return null; }
  }, [identity.secretHex]);
  const {sol: solState, usdc: usdcState, refreshSol, refreshUsdc} = useSolanaBalances(identity.secretHex, solAddress);
  const solBalance = solState.balance;

  // --- Phase 3 selection layer --------------------------------------------------------------
  // The ONE complete visible asset list, rebuilt from the catalog + Solana config. Pure; rebuilt on
  // every catalog/testnet/SOL-address change. SOL is appended only when the device key is derived;
  // Solana USDC only when the cluster is coherent (`solanaUsdcAvailable` — fail-closed on devnet +
  // mainnet mint or an empty RPC). This list IS the visibility filter (testnet omitted, not flagged).
  const assets = useMemo(
    () => buildSelectableAssets(catalog, {showTestnet, solanaEnabled: !!solAddress, solanaUsdc: solanaUsdcAvailable()}),
    [catalog, showTestnet, solAddress],
  );
  // Whether the FULL catalog carries any testnet currency (the assets list is already filtered, so
  // it cannot answer this — the Balances sheet's reveal-toggle needs the unfiltered truth).
  const hasTestnet = useMemo(() => catalog.some(isTestnetCurrency), [catalog]);
  // The reconciled selection: preserve the selected id while it remains visible; fall back to ic:0
  // (then first visible, else null) when it disappears. Computed every render so the header + chip
  // + engine dispatch read a VALID id immediately (no flash on the first paint, no stale testnet
  // selection leaking through a testnet hide). The effect below syncs the state so the fallback
  // sticks; declared before the auto-open-deposit effect so a deep-link/persisted-deposit seed
  // (which also runs on mount) wins the mount-time write order.
  const effectiveSelectedId = useMemo(
    () => reconcileSelectedAsset(selectedAssetId, assets),
    [selectedAssetId, assets],
  );
  useEffect(() => {
    if (effectiveSelectedId !== selectedAssetId) setSelectedAssetId(effectiveSelectedId);
  }, [effectiveSelectedId, selectedAssetId]);
  // The resolved selection view model (symbol/networkLabel/decimals/protocol). Null only before the
  // first assets list resolves; downstream derived consts fall back to DEMO/IC in that case.
  const selectedAsset = assets.find(a => a.id === effectiveSelectedId) ?? null;
  // DERIVED dispatch consts (NOT state — the truth is selectedAssetId). `activeSol` picks which
  // Pay/Receive engine mounts (and thus which NFC AID is armed); `selectedCurrency`/`selectedDesc`
  // resolve the IC deposit/withdraw family for the "My address"/"Send to address" sub-modes.
  const activeSol = selectedAsset?.protocol === 'solana';
  const selectedCurrency = selectedAsset?.protocol === 'ic' ? selectedAsset.currency : 0;
  const selectedDesc = selectedAsset?.protocol === 'ic' ? (catalog.find(c => c.currency === selectedAsset.currency) ?? null) : null;
  const selectedFamily = selectedDesc?.minter_family ?? null;
  const depositDisplay = selectedFamily ? familyDisplay(catalog, selectedCurrency) : null;
  const depositFamily = (selectedFamily === 'CkBtcUtxo' || selectedFamily === 'CkEthErc20') ? selectedFamily : null;
  const depositChainId = selectedDesc?.chain_id ?? null;
  const depositNativeEth = selectedFamily === 'CkEthErc20' && selectedDesc?.token_contract == null;
  // The header name + active-rail chip text. `selectedAsset.symbol` is the display NAME
  // (DEMO/BTC/USDC/SOL/…), never a raw ledger id. The 'DEMO' fallback covers the pre-reconcile
  // first paint (effectiveSelectedId resolves to ic:0 immediately, so this is defense-in-depth).
  const activeAssetName = selectedAsset?.symbol ?? 'DEMO';

  // Read the device NFC radio state once (re-checked when the app returns to the foreground, since
  // the user may toggle NFC in system settings). Purely informational for the status chip; failure
  // or a missing native method leaves it 'unknown' and the chip hidden.
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const s = (await DpayCore.nfcStatus?.()) as NfcStatus | undefined;
        if (alive) setNfc(s ?? 'unknown');
      } catch (e) { console.warn('NFC status read failed:', e instanceof Error ? e.message : String(e)); if (alive) setNfc('unknown'); }
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
    // Phase 5 test seam — simulate a FOREGROUND native deeplink arriving while a Solana asset is
    // idle-selected. This is the scenario web reload CANNOT reproduce: selectedAssetId is
    // session-local, so a reload resets it to the IC default and the SOL→IC routing never fires. The
    // harness injects `dpay:req`/`dpay:pay` via this hook instead of a real OS intent — it drives the
    // SAME applyBlob path as the web readers + getInitialURL + the foreground listener above.
    // Mirrors the __DPAY_TEST_RECEIPT_PUBKEY precedent (a test global read in prod code).
    if (typeof globalThis !== 'undefined') {
      (globalThis as unknown as {__DPAY_TEST_DEEPLINK?: (d: {kind: DeeplinkKind; blob: string}) => void}).__DPAY_TEST_DEEPLINK = (d) => applyBlob(d.kind, d.blob);
    }
    return () => {
      alive = false;
      sub.remove();
      if (typeof globalThis !== 'undefined') {
        delete (globalThis as unknown as {__DPAY_TEST_DEEPLINK?: unknown}).__DPAY_TEST_DEEPLINK;
      }
    };
  }, []);

  // Phase 5 (concern A) — route an IC deeplink to the IC engine regardless of the idle selection. A
  // `dpay:req`/`dpay:pay` blob is IC-only (the requested currency lives INSIDE the blob, readable only
  // by DpayCore.decodeRequest). If a Solana asset is idle-selected when the blob arrives,
  // SolPayMode/SolReceiveMode would mount instead and the blob would be SILENTLY LOST (those engines
  // never consume IC prefills). This programmatically selects an IC asset so the IC engine mounts +
  // consumes the blob; the engine then reviews with the EXACT requested asset. PROGRAMMATIC — calls
  // setSelectedAssetId directly, NOT handleSelect, so it bypasses the selection lock (an incoming
  // request is not a user gesture; routing to the right engine must always win).
  useEffect(() => {
    if (prefillRequest == null && prefillReceipt == null) return;
    if (selectedAsset?.protocol === 'ic') return;          // IC engine already mounts — nothing to do
    const icId = routeDeeplinkToIc(effectiveSelectedId, assets);
    if (icId) setSelectedAssetId(icId);
  }, [prefillRequest, prefillReceipt, selectedAsset, effectiveSelectedId, assets]);

  // MC8 U5 — AUTO-OPEN the ckERC20 deposit on mount if a watching deposit was persisted across a
  // restart. The watching poll is relay-bound (NOT Ethereum), so it is resumable WITHOUT a wallet
  // reconnect — surfacing the in-flight watch immediately on launch is the honest UX (the user
  // mid-deposit doesn't want to hunt for the right tab after a restart). Scans the catalog's
  // CkEthErc20 currencies (the only family whose CkErc20DepositSheet persists a watching key) and
  // lands on the Receive tab's "My address" sub-mode for the first one with a persisted watching
  // state. Once-only (a manual flip back must NOT be re-opened by a later catalog refresh); the
  // `?screen=deposit` deep link seeds the ckBTC deposit, so it takes priority.
  const autoOpenAttempted = useRef(false);
  useEffect(() => {
    if (autoOpenAttempted.current) return;
    autoOpenAttempted.current = true;
    const seedDeposit = (currency: number) => {
      setSelectedAssetId(`ic:${currency}`);
      setMode('receive');
      setReceiveSubMode('address');
      setBalancesOpen(false);
    };
    if (readDepositDeepLink()) { seedDeposit(ckBtcCurrency); return; } // deep link → ckBTC deposit
    let alive = true;
    (async () => {
      for (const a of catalog) {
        if (a.minter_family !== 'CkEthErc20') continue;
        const persisted = await loadDeposit(identity.publicHex, a.currency);
        if (!alive) return;
        if (persisted && persisted.phase === 'watching') {
          seedDeposit(a.currency);
          return; // one resume is enough
        }
      }
    })();
    return () => { alive = false; };
    // Mount-only: `catalog` at mount is the bundled default (covers every shipped ckERC20 id). The
    // scan reads AsyncStorage directly, independent of catalog state. Re-running on a catalog refresh
    // would re-seed a sub-mode the user may have just flipped away from.
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

  // The per-asset balance map — the ONE source every balance-rendering surface reads (header + the
  // Balances sheet rows). Built pure from the IC poll + DEMO shownBalance + the SOL/USDC hook
  // states; keyed by stable AssetId so a catalog object refresh never invalidates it.
  const balances = useMemo(
    () => buildAssetBalances({
      catalog, assets,
      icBalances: displayAssetBalances,
      primaryBalance: shownBalance,
      online,
      solState, usdcState,
    }),
    [catalog, assets, displayAssetBalances, shownBalance, online, solState, usdcState],
  );
  // Solana-USDC refresh is consumed by the balance map (status/amount drive the USDC row) AND by the
  // Phase 6 USDC send path (SolPayMode's onSentUsdc refreshes USDC only after a confirmed SPL send).
  // The SOL send path refreshes SOL only via `refreshSol`, so a confirmed native-SOL send does NOT
  // perturb the independent USDC status (plan invariant: independent statuses).

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
    } catch (e) {
      console.warn('topUp failed:', e instanceof Error ? e.message : String(e));
      setTopUpErr('Offline — try again when connected');
    } finally {
      setTopUpBusy(false);
    }
  }, [topUpBusy, relayUrl, identity.publicHex, setBalance, setOnline, resetDeduction]);

  // Web keyboard shortcuts (plan 1b / UX-V5): the first letters of the main actions —
  // P=Pay, R=Receive, T=Top-up (demo money), A=Balances (the asset hub), L=Ledger (transactions). Active ONLY on the wallet
  // main view with no text input focused and no sheet/overlay open (Esc is handled per-sheet by
  // useEscapeToClose). Native (no physical keyboard) is a no-op; the on-UI hints are web-only too.
  const anySheetOpen = balancesOpen || settingsOpen;
  // Phase 5 (concern B) — the Balances header button is disabled only while a PAY engine holds the
  // lock (review/QR/paid = money-critical mid-transaction; opening the sheet over a review is a
  // distraction and tapping a row would be a no-op anyway). During a RECEIVE lock (request QR shown /
  // result) the button STAYS tappable: the Balances sheet is a harmless modal overlay that does NOT
  // unmount the engine, and the tour/screen-capture flows legitimately open it over a request QR.
  // The actual protection on the receive side is handleSelect bailing on the lock — a cross-protocol
  // selection (the only thing that would unmount the engine) is suppressed regardless.
  const balancesDisabled = selectionLocked && mode === 'pay';

  useHotkeys({
    p: () => setMode('pay'),
    r: () => setMode('receive'),
    t: topUp,
    a: () => { if (!balancesDisabled) setBalancesOpen(true); },
    l: () => setMode('ledger'),
  }, {ignoreIfInputFocused: true, enabled: !anySheetOpen});

  // The ONE selection setter. Setting the selection is a deliberate user action, so it dismisses the
  // Balances sheet AND resets the within-tab sub-modes + clears any idle draft (the scan/send +
  // request/address surfaces start fresh on the new asset). Money-critical review/sign flows are NOT
  // affected: an active payer request is bound to its own immutable snapshot.
  //
  // Phase 5 — this is a USER gesture, so it respects the selection lock (shouldAllowUserSelect). An
  // in-flight pay/receive op reports the lock via onLockChange; bailing here keeps the active engine
  // mounted so the captured request snapshot is not destroyed. PROGRAMMATIC selection (deeplink
  // routing) calls setSelectedAssetId DIRECTLY, never here, so it bypasses the lock.
  const handleSelect = useCallback((id: AssetId) => {
    if (!shouldAllowUserSelect(selectionLocked)) return;
    setSelectedAssetId(id);
    setBalancesOpen(false);
    setReceiveSubMode('request');
    setPaySubMode('scan');
  }, [selectionLocked]);

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
          style={[S.balBox, balancesDisabled && S.dim]}
          disabled={balancesDisabled}
          onPress={() => setBalancesOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Balances — switch currency or receive"
          accessibilityHint={balancesDisabled ? 'Finish or cancel the current payment first' : 'Open the full asset list, switch the displayed currency, or receive'}
          accessibilityState={{disabled: balancesDisabled}}
        >
          <View style={S.balLabelRow}>
            <View style={[S.dot, {backgroundColor: online ? C.ok : C.sub2}]} />
            {/* D3: the header label names the active asset in BOTH branches — online reads "X balance",
                offline reads "~ X approx.". `activeAssetName` is the single source of truth for the
                symbol (shared with the active-rail chip below). */}
            <Text style={S.balLabel}>{online ? `${activeAssetName} balance` : `~ ${activeAssetName} approx.`}</Text>
            <HotkeyHint k="A" />
          </View>
          <View style={S.balAmtRow}>
            {/* The header reads the selected asset's pre-formatted displayText from the ONE balance
                map. DEMO keeps its offline '~' prefix (baked into the map); an IC asset shows its
                polled native-units balance; SOL/USDC show '—' when the RPC is offline (jest/e2e). */}
            <Text style={S.balAmt}>{selectedAsset ? (balances[selectedAsset.id]?.displayText ?? '—') : '—'}</Text>
          </View>
        </Pressable>
      </View>

      <View style={S.tabs}>
        <Tab label="Pay" active={mode === 'pay'} onPress={() => setMode('pay')} hotkey="P" />
        <Tab label="Receive" active={mode === 'receive'} onPress={() => setMode('receive')} hotkey="R" />
        <Tab label="Transactions" active={mode === 'ledger'} onPress={() => setMode('ledger')} hotkey="L" />
        {/* A6 — active-asset chip: labels which asset's Pay/Receive flow is armed so a user who
            switched assets doesn't get silently stuck on the wrong NFC AID (IC `…01` vs SOL `…02`). */}
        <View testID="active-rail-chip" style={S.activeRailChip}>
          <Text style={S.activeRailChipText}>{activeAssetName}</Text>
        </View>
      </View>

      <ScrollView style={S.scroll} contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        {mode === 'pay'
          ? (activeSol && solAddress
              ? <SolPayMode identity={identity} online={online} nfcReady={nfc === 'ready'} solBalance={solBalance ?? '0'} usdcBalance={usdcState.amount ?? '0'} usdcAtaAbsent={usdcState.status === 'absent'} selectedToken={selectedAsset?.protocol === 'solana' ? selectedAsset.token : 'SOL'} onSent={refreshSol} onSentUsdc={refreshUsdc} subMode={paySubMode} onSubModeChange={setPaySubMode} onShowDeposit={() => { setMode('receive'); setReceiveSubMode('address'); }} onLockChange={setSelectionLocked} />
              : <PayMode
                  identity={identity} online={online} relayUrl={relayUrl} nfcStatus={nfc}
                  onSettled={onActivity} onOfflinePaid={markOfflinePaid} shownBalance={shownBalance}
                  catalog={catalog} assetBalances={displayAssetBalances}
                  withdrawCurrency={selectedCurrency}
                  withdrawDisplay={depositDisplay} withdrawFamily={depositFamily}
                  withdrawTokenContract={selectedDesc?.token_contract ?? null}
                  withdrawBalance={displayAssetBalances[selectedCurrency] ?? '0'}
                  subMode={paySubMode} onSubModeChange={setPaySubMode}
                  prefillRequest={prefillRequest} onPrefillConsumed={() => setPrefillRequest(null)}
                  onLockChange={setSelectionLocked}
                />
          )
          : mode === 'receive'
          ? (activeSol && solAddress
              ? <SolReceiveMode
                  identity={identity} online={online} nfcReady={nfc === 'ready'} solAddress={solAddress}
                  subMode={receiveSubMode} onSubModeChange={setReceiveSubMode}
                  selectedToken={selectedAsset?.protocol === 'solana' ? selectedAsset.token : 'SOL'}
                  assets={assets}
                  selectedAssetId={effectiveSelectedId}
                  balances={balances}
                  onSelectAsset={handleSelect}
                  onLockChange={setSelectionLocked}
                />
              : (
                  /* Phase 4 (2026-08-12 unified asset selection rewrite): the PHASE 3 INTERIM bridge
                     (`activeSol`/`onSelectSol`/`solAddress`/`solBalance` props on ReceiveMode) is
                     DELETED. ReceiveMode now receives the SAME selection contract as Balances:
                     `selectedAssetId` + `assets` + `balances` + `onSelectAsset` (Wallet's single
                     `handleSelect`). The amount-prefix picker in ReceiveMode opens the unified
                     AssetPicker; selecting any row (IC or SOL) flips the rail via Wallet's
                     reconcileSelectedAsset + re-mounts the right Receive form. ONE selection state. */
                  <ReceiveMode
                    identity={identity} relayUrl={relayUrl} online={online} nfcReady={nfc === 'ready'}
                    onReceived={onActivity} catalog={catalog}
                    depositCurrency={selectedCurrency}
                    depositDisplay={depositDisplay} depositChainId={depositChainId}
                    depositNativeEth={depositNativeEth} depositFamily={depositFamily}
                    subMode={receiveSubMode} onSubModeChange={setReceiveSubMode}
                    prefillReceipt={prefillReceipt} onReceiptConsumed={() => setPrefillReceipt(null)}
                    selectedCurrency={selectedCurrency}
                    assets={assets}
                    selectedAssetId={effectiveSelectedId}
                    balances={balances}
                    onSelectAsset={handleSelect}
                    onLockChange={setSelectionLocked}
                  />
                )
          )
          : <Ledger history={history} catalog={catalog} />}
      </ScrollView>

      {balancesOpen ? (
        <BalancesSheet
          assets={assets}
          balances={balances}
          selectedId={effectiveSelectedId}
          onSelect={handleSelect}
          hasTestnet={hasTestnet}
          onTopUp={topUp}
          topUpBusy={topUpBusy}
          topUpErr={topUpErr}
          showTestnet={showTestnet}
          onToggleTestnet={toggleTestnet}
          onClose={() => setBalancesOpen(false)}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsSheet
          relayUrl={relayUrl}
          setRelayUrl={setRelayUrl}
          onClose={() => setSettingsOpen(false)}
          onReset={onReset}
          onRestore={onRestore}
          secretHex={identity.secretHex}
          username={identity.username}
        />
      ) : null}
    </SafeAreaView>
  );
}
