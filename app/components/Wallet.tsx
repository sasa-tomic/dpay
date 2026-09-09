import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AppState, BackHandler, Linking, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, Text, View} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {C} from '../config/palette';
import {S, isDark} from '../styles';
import {M} from '../i18n';
import {TOP_UP_CENTS, FAUCET_TIMEOUT_MS, SHOW_TESTNET_STORAGE_KEY, SOL_BROADCAST_TIMEOUT_MS, SELECTED_ASSET_STORAGE_KEY} from '../config/constants';
import {familyDisplay, icpCatalogOf, isTestnetCurrency} from '../config/catalog';
import {base, randNonceHex} from '../lib/format';
import {applyOffline} from '../lib/amount';
import {withTimeout} from '../lib/timeout';
import {buildSelectableAssets, chipLabel, parseAssetId, prettyNetwork, reconcileSelectedAsset, resolvePayLink, routeDeeplinkToIc, shouldAllowUserSelect, solPayGate, visibleSolanaMints} from '../config/assets';
import {buildAssetBalances} from '../lib/assetBalances';
import {mergeHistoryByTime} from '../lib/ledger';
import type {AssetId, Identity, NfcStatus, PayIntent, Txn} from '../lib/types';
import {DpayCore} from '../services/native';
import {loadDeposit} from '../services/ckerc20Persist';
import {fetchWithTimeout, readJsonOrEmpty, relayCapabilities, NO_RELAY_CAPABILITIES, type RelayCapabilities} from '../services/relay';
import {useHotkeys} from '../hooks/useHotkeys';
import {useCatalog} from '../hooks/useCatalog';
import {useBalancePoll} from '../hooks/useBalancePoll';
import {useSolanaBalances} from '../hooks/useSolanaBalances';
import {useTransactionHistory} from '../hooks/useTransactionHistory';
import {useSolanaHistory} from '../hooks/useSolanaHistory';
import {useFundsReady} from '../hooks/useFundsReady';
import {TripStrip} from './TripStrip';
import {deriveSolanaAddress, createTokenAta} from '../solana';
import {isValidSolanaAddress} from '../solana/identity';
import {friendlySolError} from '../solana/errors';
import {readDepositDeepLink, readPayLink, readPaymentDeeplink, parsePayLink, decodeDeeplink, type PayLink, type PayLinkParse} from '../lib/deepLink';
import {WordmarkLink} from './Logo';
import {HotkeyHint} from './HotkeyHint';
import {Tab} from './Tab';
import {PayMode} from './PayMode';
import {ReceiveMode} from './ReceiveMode';
import {Ledger} from './Ledger';
import {TxnReceipt} from './HistoryRow';
import {HomeTab} from './HomeTab';
import {AccountsTab} from './AccountsTab';
import {ConvertMode} from './ConvertMode';
import {SolPayMode} from './SolPayMode';
import {SolReceiveMode} from './SolReceiveMode';
import {SettingsSheet} from './SettingsSheet';
import {PassportArchive} from './TripPassport';
import {Walkthrough} from './Walkthrough';
import {AppModal} from './AppModal';
import {IconArrowDownLeft, IconChevronDown, IconClock, IconHome, IconMoon, IconQr, IconSettings, IconSun} from './icons';
import {nextTheme, themeLabel, type ThemeOverride} from '../config/theme';
import {HomeCurrencyChooser} from './HomeCurrencyChooser';
import {type HomeCurrency, currencyName, currencyOfAsset, preferredRail} from '../config/currency';
import type {LocaleChoice} from '../i18n/locale';
import type {ReadinessKey} from '../lib/readiness';
import {modeForScreen, screenForMode, type WalletMode, type WalletRoute} from '../lib/walletRoute';
import {useWalletHistory} from '../hooks/useWalletHistory';

export function Wallet({identity, relayUrl, setRelayUrl, setSolanaRpc, onReset, onRestore, resolvedTheme, themeChoice, onSetTheme, localeChoice, onSetLocale, homeCurrency, onSetHomeCurrency}: {identity: Identity; relayUrl: string; setRelayUrl: (s: string) => void; /** Apply + persist the Solana endpoint (App.tsx). THROWS on a refusal — Settings renders it. */ setSolanaRpc: (s: string) => void; onReset: () => void; onRestore: (id: Identity) => Promise<void>; resolvedTheme: ThemeOverride; themeChoice: ThemeOverride | null; onSetTheme: (t: ThemeOverride | null) => void; localeChoice: LocaleChoice; onSetLocale: (l: LocaleChoice) => void; homeCurrency: HomeCurrency | null; onSetHomeCurrency: (c: HomeCurrency) => void}) {
  // The wallet's surfaces. Four are TABS (home/pay/receive/ledger — the bottom bar switches
  // between them and each is a destination); two are ROUTES (accounts/convert — entered from a
  // control, left by Back, never a bottom-bar destination).
  //
  // The app OPENS on 'home' (founder decision 2026-09-08, docs/specs/2026-09-08-first-run-redesign
  // §1 F2). This repealed the standing "the scanner stays the landing screen" rule: greeting a new
  // user with a payment-request surface is what read as a scam. The cost — one extra tap on the
  // returning traveller's most frequent action — is paid back by Home's primary Scan button, which
  // lands the camera in exactly one tap.
  // The Mode vocabulary lives in `lib/walletRoute.ts` beside the URL vocabulary it translates to
  // (X11): the two differ in exactly one word ('ledger' ↔ 'transactions'), which is the kind of
  // difference that rots when it is declared in two files.
  type Mode = WalletMode;
  const [mode, setMode] = useState<Mode>('home');
  // Where the accounts ROUTE was entered from, so Back returns there instead of guessing 'home'.
  // A ref, not state: nothing renders from it, and it must be written during the same tick as the
  // mode change that reads it.
  const accountsFrom = useRef<Mode>('home');
  const openAccounts = useCallback(() => {
    setMode(prev => {
      if (prev !== 'accounts') accountsFrom.current = prev;
      return 'accounts';
    });
  }, []);
  const closeAccounts = useCallback(() => setMode(accountsFrom.current), []);
  // A shared payment link that has been PARSED but not yet resolved against the catalog (which
  // loads async). Held here until the resolve effect below turns it into a concrete asset + amount,
  // or into an honest on-screen refusal.
  const [pendingLink, setPendingLink] = useState<PayLink | null>(null);
  // Why an incoming payment link cannot be paid, in the user's language, with the action they can
  // take. Rendered as a modal over the wallet; dismissing it drops the link.
  const [linkError, setLinkError] = useState<string | null>(null);
  // A resolved payment link handed to the IC engine: PayMode consumes it via its prefill effect,
  // then calls onPrefillConsumed to clear it. A link ONLY pre-fills the review — it never
  // auto-signs/approves.
  const [prefillIntent, setPrefillIntent] = useState<PayIntent | null>(null);
  // The Solana rail's equivalent: address + decimal amount pre-filled into the "Send to address"
  // form (SOL has no request/review engine — same tab, same toggle, per the same-surfaces rule).
  const [solPrefill, setSolPrefill] = useState<{address: string; amount: string} | null>(null);
  // The symmetric `dpay:pay/<blob>` (NFC-less receipt hand-back): a payer who settled online shares
  // the rail proof {ledger, block_index, request_id} back to the merchant. This holds the raw blob;
  // ReceiveMode consumes it via its verify effect (format-check → request_id binding → on-chain
  // read_state confirmation → reconcile as Paid), then calls onReceiptConsumed to clear it.
  // SECURITY: ReceiveMode never trusts the blob alone — the settlement poll confirms on-chain.
  const [prefillReceipt, setPrefillReceipt] = useState<string | null>(null);
  // THE one user-selection state (Phase 3 — 2026-08-12 unified asset selection rewrite). A single
  // stable `AssetId` (`ic:${currency}` | 'solana:SOL' | 'solana:USDC') is the SOLE idle selection
  // truth. It replaces the old `currentCurrency: number` + `activeSol: boolean` pair whose split was
  // the root cause of the Balances↔Receive inconsistency and the SOL picker collapse. Every derived
  // value (header name/balance, active chip, which Pay/Receive engine mounts, deposit/withdraw
  // family, NFC AID dispatch) is computed from `selectedAsset` below. `null` only before the first
  // reconcile runs; `effectiveSelectedId` (the reconciled value) is what every render reads.
  const [selectedAssetId, setSelectedAssetId] = useState<AssetId | null>(null);
  // Whether the REMEMBERED selection has been read back from storage yet. It gates the persist
  // effect below so the two cannot race: without it, the mount-time reconcile would write the home
  // currency's rail before the read landed, and the read would return the value it had just
  // overwritten — the wallet would forget where you were every single launch.
  const [selectionHydrated, setSelectionHydrated] = useState(false);
  // Has ANYTHING in this session chosen an asset — a tap, a deep link, a fund-funnel return? The
  // remembered selection is what the wallet opens with, but it must never overrule a choice already
  // made on THIS mount. That conflict is real and it is a timing one: the deep-link seeds run
  // synchronously on mount while the storage read resolves a tick later, so without this the
  // remembered asset silently clobbered `?screen=deposit`'s ckBTC. Precedence is expressed as a
  // rule here rather than left to whichever effect happens to finish last.
  const explicitlySelected = useRef(false);
  const selectAsset = useCallback((id: AssetId) => {
    explicitlySelected.current = true;
    setSelectedAssetId(id);
  }, []);
  const [passportOpen, setPassportOpen] = useState(false);
  // X6 — the transaction whose RECEIPT is open, or null. Owned HERE, not by the two lists that
  // raise it, for the reason every other overlay is owned here: `AppModal`'s web host is absolutely
  // positioned against its nearest positioned ancestor, so a receipt mounted inside the
  // Transactions list or the Home feed covers only that list's own box and clips a card taller
  // than it. One instance, at the app root, reachable from both lists.
  const [receiptTxn, setReceiptTxn] = useState<Txn | null>(null);
  // Phase 5 — selection lock. While the mounted Pay/Receive engine is mid-flight (a pay review/qr/
  // paid, or a receive request-QR/result), it reports `true` via `onLockChange`. A USER-initiated
  // asset switch (Balances button, AssetPicker) is then suppressed so the active engine is not
  // unmounted — that would destroy the captured, immutable request snapshot the review reads. The
  // lock is per-component and resets on unmount (see useReportLock); a tab switch to Ledger clears it.
  // PROGRAMMATIC selection (deeplink routing — see the routing effect below) calls setSelectedAssetId
  // directly and bypasses this lock: an incoming request must always route to its engine.
  const [selectionLocked, setSelectionLocked] = useState(false);
  // Fund-first funnel resume origin (UX review finding 8): the asset whose Pay tab spawned the
  // goToDeposit trip, or null. Cleared on resume (returnFromDeposit) or a fresh funnel trip.
  const [depositReturnTo, setDepositReturnTo] = useState<{id: AssetId; subMode: 'scan' | 'send'} | null>(null);
  // Fund-first "Check again" busy flag (UX review r2 finding 1): self-clears after ~1.5s — the
  // SOL/USDC polls are fire-and-forget (no completion signal), so this is a UI-level affordance
  // (the button reads 'Checking…' + disables) rather than a poll-lifecycle tracker. The poll's
  // own 2.5s cadence + generation gate remain the source of truth for the balance itself.
  const [recheckBusy, setRecheckBusy] = useState(false);
  // Wave 8: the header flip pins the OPPOSITE of the resolved mode (Light ↔ Dark). App.tsx owns
  // the state + AsyncStorage persistence; onSetTheme is the single mutator (Settings segments call
  // it directly with an explicit choice or null=Auto).
  const cycleTheme = useCallback(() => onSetTheme(nextTheme(resolvedTheme)), [onSetTheme, resolvedTheme]);
  const recheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (recheckTimer.current != null) clearTimeout(recheckTimer.current); }, []);
  // Within-tab sub-modes for the Receive/Pay IA: "request"/"address" (Receive) and "scan"/"send"
  // (Pay). The on-chain deposit + withdraw surfaces now live INLINE in these tabs (lifted out of the
  // Balances per-row buttons + the overlay sheets). Owned here so deeplinks (?screen=deposit, the
  // auto-open-ckERC20 effect) can land the user directly on the right sub-mode + asset.
  const [receiveSubMode, setReceiveSubMode] = useState<'request' | 'address'>('request');
  // Which CODE the Request-payment form is making: the dpay request (default — the 132-byte signed
  // request another dpay wallet scans) or this merchant's own till charge. Owned HERE, beside the
  // sub-mode, for the reason every cross-rail selection is: a merchant who picks "Till code" on the
  // Solana rail is told to switch to VCHF, and that switch re-mounts the OTHER Receive form — a
  // choice held inside either form would be lost exactly at the moment it was acted on.
  const [receiveCodeForm, setReceiveCodeForm] = useState<'dpay' | 'till'>('dpay');
  const [paySubMode, setPaySubMode] = useState<'scan' | 'send'>('scan');
  const [nfc, setNfc] = useState<NfcStatus>('unknown');
  // Demo top-up: a single click adds $100 of demo currency via /api/v1/faucet. The button sits next
  // to the balance so users find it without hunting. `topUpBusy` drives the spinner; `topUpErr`
  // surfaces a one-line failure (offline / faucet disabled) without blocking the rest of the UI.
  const [topUpBusy, setTopUpBusy] = useState(false);
  const [topUpErr, setTopUpErr] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<RelayCapabilities>(NO_RELAY_CAPABILITIES);
  useEffect(() => {
    let alive = true;
    // Back to "this relay has told us nothing" for the duration of the probe: the answer belongs
    // to the URL being asked, so the previous relay's till must not be offered against the new one.
    setCapabilities(NO_RELAY_CAPABILITIES);
    relayCapabilities(relayUrl).then(c => { if (alive) setCapabilities(c); });
    return () => { alive = false; };
  }, [relayUrl]);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);

  // ── URL routing (OPEN_ISSUES X11) ─────────────────────────────────────────────────────────────
  // Web-only, and a no-op on native (`useWalletHistory` short-circuits on Platform.OS). The wallet
  // was ONE URL for every tab and every sheet, so the browser's Back button left the wallet
  // entirely instead of moving inside it, nothing was linkable, and a refresh always landed on the
  // home screen. The route is DERIVED from the surface state rather than being a second source of
  // truth — there is no route state here to drift out of step with `mode`.
  //
  // What rides in the URL is what a link must be able to reproduce: the screen, the within-tab
  // sub-mode (arriving at "Send to address" must give that form, not the scanner), and whether
  // Settings is open (so Back CLOSES it, the same rule Android's hardware Back already follows).
  // What does NOT ride in it: the selected asset, any draft amount, and every money-critical
  // in-flight state. A URL that could re-enter a half-signed payment is a URL that can be shared.
  const route: WalletRoute = {
    screen: screenForMode(mode),
    ...(mode === 'pay' && paySubMode === 'send' ? {sub: 'send' as const} : {}),
    ...(mode === 'receive' && receiveSubMode === 'address' ? {sub: 'address' as const} : {}),
    ...(settingsOpen ? {settings: true as const} : {}),
  };
  const applyRoute = useCallback((r: WalletRoute) => {
    // `accounts` goes through openAccounts so the route remembers where it was entered from and
    // its own Back control still returns there — a URL-driven entry is an entry like any other.
    if (r.screen === 'accounts') {
      openAccounts();
    } else {
      setMode(modeForScreen(r.screen));
    }
    // Only the named screen's sub-mode is applied. Resetting the other tab's sub-mode would make a
    // Back press quietly discard a choice the user made on a screen the URL says nothing about.
    if (r.screen === 'pay') setPaySubMode(r.sub === 'send' ? 'send' : 'scan');
    if (r.screen === 'receive') setReceiveSubMode(r.sub === 'address' ? 'address' : 'request');
    setSettingsOpen(r.settings === true);
  }, [openAccounts]);
  useWalletHistory(route, applyRoute);

  // Passport deep-link (founder ask 2026-08-24): opening Settings FROM an unfilled
  // "BACKED UP" stamp also auto-reveals the backup (the step's own surface) once. Cleared on
  // Settings close so a later manual gear-open never re-reveals the seed.
  const [settingsOpenBackup, setSettingsOpenBackup] = useState<boolean>(false);
  // Passport deep-link: an unfilled "SAW THE FLOW" stamp opens the walkthrough replay here —
  // the SAME replay Settings hosts (AppModal + Walkthrough onClose/onDone, mirror of
  // SettingsSheet's usage; the replay never awards stamps).
  const [howItWorksOpen, setHowItWorksOpen] = useState<boolean>(false);
  // Whether testnet currencies (network "Bitcoin Testnet"/"Sepolia") are revealed in the Balances
  // sheet. Hidden by default (founder decision); persisted so the choice survives a restart. Mirrors
  // the identity/relay AsyncStorage pattern (best-effort load; a read failure falls back to hidden).
  const [showTestnet, setShowTestnet] = useState(false);
  // Currency catalog — the runtime source of truth for which assets exist + how to display/fund
  // them. Loaded from AsyncStorage cache then refreshed from GET /currencies on mount; the bundled
  // default covers a cold first load. Catalog v2: the hook returns the network-first sections (icp
  // mainnet + testnet + solana — ONE shape); the flat IC catalog every consumer below expects is
  // DERIVED from the icp sections, and the solana section feeds `buildSelectableAssets`' SOL rows.
  // The ckBTC currency id (and any future asset's) is RESOLVED from this, never hardcoded (issue #7).
  const networks = useCatalog(relayUrl);
  const catalog = useMemo(() => icpCatalogOf(networks), [networks]);

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
    markOfflinePaid, resetDeduction, setBalance, setOnline, refresh: refreshBalances,
  } = useBalancePoll({relayUrl, publicHex: identity.publicHex, displayAssets, displayCurrencyIds});
  // Durable transaction history sourced from the ledger. Extracted verbatim into
  // hooks/useTransactionHistory.ts (Effect C): the per-currency fan-out + dedup-by-nonce + sort +
  // direction-derivation all move in. catalogCurrencyIds (the stable dep signature) is now internal
  // to the hook (computed from `catalog`). `onActivity` below still calls refreshHistory.
  // History respects the testnet toggle (2026-08-21): hidden testnet currencies are not WALKED at
  // all — each hidden currency was a full icrc3 page-walk on the relay every poll cycle, pure
  // load for rows the user cannot see.
  const histCatalog = useMemo(
    () => catalog.filter(c => showTestnet || !isTestnetCurrency(c)),
    [catalog, showTestnet],
  );
  const {history, refreshHistory} = useTransactionHistory({relayUrl, publicHex: identity.publicHex, catalog: histCatalog});

  // Native SOL rail — a device-derived Solana key (SLIP-10 m/44'/501'/0'/0') from the SAME IC identity
  // seed, so one backup recovers both rails. The address is derived once (pure; stable per identity).
  // useSolanaBalances polls the SOL RPC directly (no relay) AND the device's token accounts for
  // every VISIBLE SPL mint (`visibleSolanaMints` mirrors the builder's availability predicate, so
  // hook membership always equals the rendered asset list) concurrently with independent per-mint
  // statuses; when the active endpoint is empty (jest/e2e) it no-ops and the SOL card renders `—`.
  // Both halves feed the per-asset balance map below.
  const solAddress = useMemo(() => {
    try { return deriveSolanaAddress(identity.secretHex); }
    catch (e) { console.warn('deriveSolanaAddress failed:', e instanceof Error ? e.message : String(e)); return null; }
  }, [identity.secretHex]);
  const solanaMints = useMemo(
    () => (!solAddress ? [] : visibleSolanaMints(networks)),
    [solAddress, networks],
  );
  const {sol: solState, tokens: tokenStates, refreshSol, refreshToken, refreshTokens} = useSolanaBalances(identity.secretHex, solAddress, solanaMints);
  // Defined AFTER the destructure (TDZ): manual re-poll for the fund-first "Check again" —
  // fire-and-forget polls get a self-clearing busy flag (UI affordance, not lifecycle tracking).
  const recheckSolBalances = useCallback(() => {
    refreshSol();
    refreshTokens();
    setRecheckBusy(true);
    if (recheckTimer.current != null) clearTimeout(recheckTimer.current);
    recheckTimer.current = setTimeout(() => setRecheckBusy(false), 1500);
  }, [refreshSol, refreshTokens]);
  // IC rail twin (UX review r3 MUST-1): same self-clearing busy affordance for the shared
  // InstructionPanel's "Check again" — without this, the IC panel's button gives zero feedback
  // while the identical SOL panel spins (per-rail divergence in a shared surface).
  const recheckIcBalances = useCallback(() => {
    refreshBalances();
    setRecheckBusy(true);
    if (recheckTimer.current != null) clearTimeout(recheckTimer.current);
    recheckTimer.current = setTimeout(() => setRecheckBusy(false), 1500);
  }, [refreshBalances]);
  const solBalance = solState.balance;
  // The SOL rail's half of the Transactions list, read straight from the Solana RPC (no relay, no
  // canister — same device-key rail as the balances above). Gated on `solAddress` exactly as
  // `buildSelectableAssets`' `solanaEnabled` is: no device key ⇒ no rail ⇒ no polling. The two
  // lists are merged newest-first below and rendered by the ONE Ledger surface both rails share;
  // `solDropped` (transactions the reader could not parse) rides along so the Ledger can say the
  // list may be short — they still exist on-chain.
  const {history: solHistory, dropped: solDropped, refreshHistory: refreshSolHistory} = useSolanaHistory(solAddress);
  const ledgerHistory = useMemo(() => mergeHistoryByTime(history, solHistory), [history, solHistory]);

  // One-time token-account (ATA) setup — Wallet-owned so BOTH entry surfaces (Receive "My address"
  // gate + Pay "Send to address"/scan gates) share one busy/err state + one handler. The handler is
  // declared below the selection layer (it creates the SELECTED asset's account); these two states
  // live here to keep the hook order section together. createTokenAta signs a REAL
  // AssociatedTokenProgram.createIdempotent tx with the device key (non-custodial — dpay never
  // holds keys); the one-time rent + fee come out of the device's SOL balance and are disclosed in
  // the setup-card copy. On success both balance rails refresh: SOL (rent debited) + the token
  // (status flips 'absent' → 'balance' with amount 0, which unhides the address QR).
  const [ataSetupBusy, setAtaSetupBusy] = useState(false);
  const [ataSetupErr, setAtaSetupErr] = useState<string | null>(null);

  // --- Phase 3 selection layer --------------------------------------------------------------
  // The ONE complete visible asset list, rebuilt from the catalog + Solana config. Pure; rebuilt on
  // every catalog/testnet/SOL-address change. SOL is appended only when the device key is derived
  // (its display facts read from the catalog's solana section — bundled fallback when offline);
  // Solana USDC only when the cluster is coherent (`solanaUsdcAvailable` — fail-closed on devnet +
  // mainnet mint or an empty RPC). This list IS the visibility filter (testnet omitted, not flagged).
  const assets = useMemo(
    // No `solanaTokens` override: the builder resolves each token row's availability from the live
    // config (`solanaTokenAvailable(row.mint)` — fail-closed per mint), which is also exactly what
    // `visibleSolanaMints` mirrors for the balance-hook membership above.
    () => buildSelectableAssets(catalog, {showTestnet, solanaEnabled: !!solAddress, networks}),
    [catalog, showTestnet, solAddress, networks],
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
  // The home currency's rail — the asset the wallet lands on when nothing else is selected. Null
  // until a currency is chosen (the chooser gate below renders instead) or when the catalog carries
  // no rail for it.
  const homeAsset = useMemo(
    () => (homeCurrency === null ? null : preferredRail(homeCurrency, assets)),
    [homeCurrency, assets],
  );
  const effectiveSelectedId = useMemo(
    () => reconcileSelectedAsset(selectedAssetId, assets, homeAsset?.id ?? null),
    [selectedAssetId, assets, homeAsset],
  );
  useEffect(() => {
    // Not while the home-currency gate is open. The chooser renders INSTEAD of the wallet, but this
    // component still mounts and these effects still run — and with no currency yet there is no
    // preferred rail, so reconcile answers DEMO. Latching that answer meant the choice the user was
    // in the middle of making arrived to find the selection already taken, and the wallet opened on
    // DEMO no matter which currency they picked. Leaving `selectedAssetId` null until the currency
    // exists lets the very first reconcile land on the rail they chose.
    if (homeCurrency === null) return;
    if (effectiveSelectedId !== selectedAssetId) setSelectedAssetId(effectiveSelectedId);
  }, [homeCurrency, effectiveSelectedId, selectedAssetId]);
  // Read back the asset the wallet was last left on, ONCE on mount. A stored id that is no longer
  // in the catalog is not special-cased here: it flows into `reconcileSelectedAsset`, which already
  // owns "the selection disappeared" and lands on the home currency instead.
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(SELECTED_ASSET_STORAGE_KEY)
      .then(v => {
        if (!alive) return;
        const id = parseAssetId(v);
        if (id !== null && !explicitlySelected.current) setSelectedAssetId(id);
        setSelectionHydrated(true);
      })
      .catch((e: unknown) => {
        console.warn(`[dpay] failed to read the remembered asset: ${e instanceof Error ? e.message : String(e)}`);
        if (alive) setSelectionHydrated(true); // a failed read means "nothing remembered", not "never persist again"
      });
    return () => { alive = false; };
  }, []);
  // Remember the RESOLVED selection — one writer for every path that can change it (a Balances tap,
  // a payment link routing the payer to the right engine, a testnet hide falling back), so no call
  // site can change the selection and forget to record it.
  useEffect(() => {
    if (homeCurrency === null || !selectionHydrated || effectiveSelectedId === null) return;
    AsyncStorage.setItem(SELECTED_ASSET_STORAGE_KEY, effectiveSelectedId).catch((e: unknown) => {
      console.warn(`[dpay] failed to remember the selected asset: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, [selectionHydrated, effectiveSelectedId]);
  // The resolved selection view model (symbol/networkLabel/decimals/protocol). Null only before the
  // first assets list resolves; downstream derived consts fall back to DEMO/IC in that case.
  const selectedAsset = assets.find(a => a.id === effectiveSelectedId) ?? null;
  // DERIVED dispatch consts (NOT state — the truth is selectedAssetId). `activeSol` picks which
  // Pay/Receive engine mounts (and thus which NFC AID is armed); `selectedCurrency`/`selectedDesc`
  // resolve the IC deposit/withdraw family for the "My address"/"Send to address" sub-modes.
  const activeSol = selectedAsset?.protocol === 'solana';
  // The selected SOLANA asset's own token facts + per-mint state (registry truth — every Solana
  // child surface reads THESE, never a USDC-shaped ternary). `activeSolAsset` is null on the IC
  // rail; the token state is undefined while its mint is outside the visible list (e.g. the RPC
  // is configured off), which every consumer treats as unknown/zero — fail closed.
  const activeSolAsset = selectedAsset?.protocol === 'solana' ? selectedAsset : null;
  const selectedSolToken = activeSolAsset?.token ?? 'SOL';
  const selectedTokenState = activeSolAsset?.mint != null ? tokenStates[activeSolAsset.mint] : undefined;
  const selectedTokenBalance = selectedTokenState?.amount ?? '0';
  const selectedTokenAbsent = selectedTokenState?.status === 'absent';
  // One-tap account setup for the SELECTED token — the only one whose gates ever render the setup
  // card. Creates that token's ATA (device-key-signed createIdempotent tx); on success both rails
  // refresh: SOL (rent debited) + the token ('absent' → 'balance' amount 0, which unhides the QR).
  const createAta = useCallback(async () => {
    if (ataSetupBusy) return;
    const mint = activeSolAsset?.mint ?? null;
    if (mint == null) return; // native SOL (or no solana selection) — no token account to create
    setAtaSetupBusy(true);
    setAtaSetupErr(null);
    const {signal, cancel} = withTimeout(SOL_BROADCAST_TIMEOUT_MS);
    try {
      await createTokenAta(identity.secretHex, mint, signal);
      refreshSol();
      refreshToken(mint);
    } catch (e: unknown) {
      console.warn('createTokenAta failed:', e instanceof Error ? e.message : String(e));
      setAtaSetupErr(friendlySolError(e instanceof Error ? e.message : String(e)));
    } finally {
      cancel();
      setAtaSetupBusy(false);
    }
  }, [ataSetupBusy, activeSolAsset, identity.secretHex, refreshSol, refreshToken]);
  // Refresh the SELECTED token's account state (naming its mint when known; else repoll all).
  const refreshSelectedToken = useCallback(() => {
    if (activeSolAsset?.mint != null) refreshToken(activeSolAsset.mint);
    else refreshTokens();
  }, [activeSolAsset, refreshToken, refreshTokens]);
  const selectedCurrency = selectedAsset?.protocol === 'ic' ? selectedAsset.currency : 0;
  const selectedDesc = selectedAsset?.protocol === 'ic' ? (catalog.find(c => c.currency === selectedAsset.currency) ?? null) : null;
  const selectedFamily = selectedDesc?.minter_family ?? null;
  const depositDisplay = selectedFamily ? familyDisplay(catalog, selectedCurrency) : null;
  const depositFamily = (selectedFamily === 'CkBtcUtxo' || selectedFamily === 'CkEthErc20') ? selectedFamily : null;
  const depositChainId = selectedDesc?.chain_id ?? null;
  const depositNativeEth = selectedFamily === 'CkEthErc20' && selectedDesc?.token_contract == null;
  // The header name + active-rail chip text. `chipLabel` returns the bare asset symbol UNLESS
  // another visible asset shares it — the USDC collision (ic:2 Ethereum + solana:USDC Solana both
  // read 'USDC') is then qualified with a short network tag (USDC·Eth / USDC·Sol) so a user can tell
  // which network is selected from the main screen. Unique symbols (DEMO/BTC/ETH/SOL) stay compact.
  // The 'DEMO' fallback covers the pre-reconcile first paint (selectedAsset is null only then).
  const activeAssetName = selectedAsset ? chipLabel(selectedAsset, assets) : 'DEMO';
  // The header eyebrow. When the selected asset IS the home currency's rail the label names the
  // CURRENCY ("Swiss francs · Main") — that is the Revolut-style "this is your money" reading, and
  // it is honest because the amount beneath it still carries the token's own unit. Any other
  // selection keeps naming the ASSET, so switching to BTC never reads as francs.
  const selectedIsHome = selectedAsset !== null && homeCurrency !== null
    && currencyOfAsset(selectedAsset) === homeCurrency && selectedAsset.id === homeAsset?.id;
  // Naming the currency changes the NAME, never the online/offline distinction. The offline branch
  // marks the balance as an approximation, and that marker outranks the main-currency label — a
  // wallet that reads "Swiss francs · Main" over a stale figure while offline would be asserting a
  // balance it cannot know. Caught by flow 100, which is exactly what that flow is for.
  const eyebrowName = selectedIsHome && homeCurrency !== null ? currencyName(homeCurrency) : activeAssetName;
  const balanceEyebrow = !online
    ? M.wallet.balance.approx(eyebrowName)
    : (selectedIsHome ? M.wallet.homeCurrency.mainLabel(eyebrowName) : M.wallet.balance.of(eyebrowName));

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

  // Inbound links (2026-08-29): the wallet accepts exactly two, and this effect is the ONE door.
  //   • a PAYMENT LINK `…/wallet/pay/<recipient>?asset=…&network=…&amount=…` — parsed here, resolved
  //     against the catalog by the effect below, and pre-filled into the Pay tab. It NEVER signs.
  //   • the receipt hand-back `dpay:pay/<blob>` — the rail proof for the merchant's Receive screen.
  // Both arrive by two routes and both are bounded + best-effort (a failure never wedges the app,
  // and is surfaced, never swallowed):
  //   • Web: the page's own location — readPayLink() reads the path, readPaymentDeeplink() the
  //     `?pay=` query (the OS scheme never fires in a browser).
  //   • Native: Linking.getInitialURL() returns the URI the OS handed the app on launch (an Android
  //     App Link for the payment link, the dpay: scheme for the receipt), and the 'url' listener
  //     catches one arriving while the app is foreground.
  // getInitialURL is wrapped in a 2s timeout so a stalled native bridge can't wedge the prefill (the
  // repo rule: all I/O has a timeout).
  // ONE link pipeline, four sources: the page location, the launch intent, a foreground intent —
  // and, since the Pay camera learned to recognise a link (PayMode/SolPayMode → classifyScan), a
  // scanned QR. A payment link is MEANT to be printed, so a wallet that opens it from an App Link
  // but not from its own camera was the same link with two different outcomes; routing the scan
  // here means one resolution, one set of per-part error messages, one cross-rail routing.
  // Stable identity (no deps): every setter it closes over is a stable useState setter.
  const applyLink = useCallback((parsed: PayLinkParse) => {
    // A malformed link is REPORTED, never silently ignored: the payer is told which part is
    // damaged so they can ask the sender for a new one (founder rule — every dead end gives an
    // instruction). A well-formed one waits for catalog resolution in the effect below.
    if (!parsed.ok) setLinkError(M.pay.link.malformed(M.pay.link.part[parsed.err]));
    else setPendingLink(parsed.link);
    setMode('pay');
  }, []);
  const applyReceipt = useCallback((blob: string) => {
    setPrefillReceipt(blob);
    setMode('receive');
  }, []);
  const handleUrl = useCallback((url: string) => {
    const link = parsePayLink(url);
    if (link) { applyLink(link); return; }
    const dl = decodeDeeplink(url);
    if (dl) applyReceipt(dl.blob);
  }, [applyLink, applyReceipt]);

  useEffect(() => {
    let alive = true;
    // Web path first (sync reads of the page location).
    const webLink = readPayLink();
    if (webLink) applyLink(webLink);
    const webPay = readPaymentDeeplink();
    if (webPay) applyReceipt(webPay);
    // Native path: the launch URI, timeout-bounded. On web this resolves to the page URL, which the
    // sync readers above already handled — parsing it again is idempotent (same link, same state).
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000));
    const initial = (Linking.getInitialURL?.() ?? Promise.resolve(null)) as Promise<string | null>;
    Promise.race([initial, timeout])
      .then((url) => { if (alive && url) handleUrl(String(url)); })
      .catch((e: unknown) => { console.log(`[dpay] deeplink getInitialURL failed: ${e instanceof Error ? e.message : String(e)}`); });
    // Foreground links: one tapped while the app is already open.
    const sub = Linking.addEventListener('url', ({url}) => handleUrl(url));
    // Phase 5 test seam — simulate a FOREGROUND native link arriving while a Solana asset is
    // idle-selected. This is the scenario web reload CANNOT reproduce: selectedAssetId is
    // session-local, so a reload resets it to the IC default and the cross-rail routing never
    // fires. The harness injects a URL through this hook instead of a real OS intent — it drives
    // the SAME handleUrl path as the web readers + getInitialURL + the foreground listener above.
    // (Test-only hook: prod code never reads it; harmless if unset.)
    if (typeof globalThis !== 'undefined') {
      (globalThis as unknown as {__DPAY_TEST_DEEPLINK?: (url: string) => void}).__DPAY_TEST_DEEPLINK = handleUrl;
    }
    return () => {
      alive = false;
      sub.remove();
      if (typeof globalThis !== 'undefined') {
        delete (globalThis as unknown as {__DPAY_TEST_DEEPLINK?: unknown}).__DPAY_TEST_DEEPLINK;
      }
    };
  }, [applyLink, applyReceipt, handleUrl]);

  // Resolve a parsed payment link against the LIVE catalog, then hand it to the right rail's engine.
  // Kept separate from the reader above because resolution needs the catalog, which loads async: the
  // bundled default renders instantly and the relay's copy lands a moment later, so this re-runs on
  // every catalog change until it succeeds. A link that resolves on the second pass therefore
  // self-heals — the earlier error is replaced, never left stale on screen.
  //
  // What it does, in order: resolve the asset + amount (refuses on unknown/wrong-chain/over-precise
  // — see resolvePayLink) → programmatically select that asset so ITS engine mounts (direct
  // setSelectedAssetId, bypassing the selection lock exactly like the receipt routing below: an
  // incoming link is not a user gesture and must reach the right engine) → validate the destination
  // account with the REAL parser for that rail → hand the engine a ready payment.
  // SECURITY: nothing here signs. The IC engine renders a review the payer must Approve; the SOL
  // engine renders a pre-filled send form the payer must confirm.
  const linkGenRef = useRef(0);
  useEffect(() => {
    if (pendingLink == null) return;
    const link = pendingLink;
    const gen = ++linkGenRef.current;
    const resolved = resolvePayLink(link, assets, catalog);
    if (!resolved.ok) {
      const chain = prettyNetwork(link.network);
      setLinkError(
        resolved.err === 'unknown_asset' ? M.pay.link.unknownAsset(link.asset, chain)
        : resolved.err === 'wrong_network' ? M.pay.link.wrongNetwork(link.asset, chain)
        : resolved.err === 'hidden_asset' ? M.pay.link.hiddenAsset(link.asset)
        : resolved.err === 'ambiguous_asset' ? M.pay.link.unknownAsset(link.asset, chain)
        : resolved.err === 'unsupported_asset' ? M.pay.link.unsupportedAsset(link.asset)
        : M.pay.link.badAmount(link.amount, link.asset),
      );
      return;
    }
    const {asset, rawAmount} = resolved.target;
    let alive = true;
    (async () => {
      if (asset.protocol === 'ic') {
        // The destination is an ICRC-1 owner principal. Validate it through the core's base32-CRC
        // parser (never a regex): a link that travelled through a chat app can arrive truncated,
        // and a bad principal must be refused BEFORE the payer sees a destination to approve.
        let principal: string;
        try {
          principal = await DpayCore.icpValidatePrincipal(link.recipient);
        } catch (e: unknown) {
          console.warn('pay link principal rejected:', e instanceof Error ? e.message : String(e));
          if (alive && gen === linkGenRef.current) setLinkError(M.pay.link.badAccount(prettyNetwork(link.network)));
          return;
        }
        if (!alive || gen !== linkGenRef.current) return;
        selectAsset(asset.id);
        setPrefillIntent({
          toAccount: principal,
          toName: link.label,
          toAccountText: principal,
          amount: rawAmount,
          currency: asset.currency,
          // `ref` present ⇒ every payment of this link carries the SAME memo, so the payee can tell
          // which invoice a transfer settles. It does NOT stop a second payment — the ledger dedups
          // nothing (`icp_transfer_arg` in dpay-ffi). Absent ⇒ a fresh nonce per payment (a tip jar).
          nonceHex: link.ref ?? randNonceHex(),
          memo: link.memo,
          expiry: null,
          source: 'link',
        });
        setPaySubMode('scan');
      } else {
        // The Solana rail: a base58 address, validated by the same check the send form applies.
        if (!isValidSolanaAddress(link.recipient)) {
          if (alive && gen === linkGenRef.current) setLinkError(M.pay.link.badAccount(prettyNetwork(link.network)));
          return;
        }
        if (!alive || gen !== linkGenRef.current) return;
        selectAsset(asset.id);
        // SOL has no IC-style request/review engine; its equivalent surface is the pre-filled
        // "Send to address" form in the SAME Pay tab (the same-surfaces hard rule).
        setSolPrefill({address: link.recipient, amount: link.amount});
        setPaySubMode('send');
      }
      setMode('pay');
      setLinkError(null);
      setPendingLink(null);
    })();
    return () => { alive = false; };
  }, [pendingLink, assets, catalog]);

  // Phase 5 (concern A) — route the receipt hand-back to the IC engine regardless of the idle
  // selection. A `dpay:pay/<blob>` proof is IC-only (its currency lives inside the settled
  // transfer). If a Solana asset is idle-selected when the blob arrives, SolReceiveMode would mount
  // instead and the blob would be SILENTLY LOST (that engine never consumes IC prefills). This
  // programmatically selects an IC asset so the IC engine mounts + consumes the blob. PROGRAMMATIC —
  // calls setSelectedAssetId directly, NOT handleSelect, so it bypasses the selection lock (an
  // incoming proof is not a user gesture; routing to the right engine must always win).
  useEffect(() => {
    if (prefillReceipt == null) return;
    if (selectedAsset?.protocol === 'ic') return;          // IC engine already mounts — nothing to do
    const icId = routeDeeplinkToIc(effectiveSelectedId, assets);
    if (icId) selectAsset(icId);
  }, [prefillReceipt, selectedAsset, effectiveSelectedId, assets]);

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
      selectAsset(`ic:${currency}`);
      setMode('receive');
      setReceiveSubMode('address');
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
  // The SOL rail's twin of `onActivity`: a confirmed send moves the balance AND adds a ledger row,
  // so both are re-read rather than waiting out the poll. The two token callbacks stay separate
  // because the BALANCES are independent (a SOL send must not perturb the USDC status); the
  // Transactions list is one list per rail, so both refresh it.
  const onSolSent = useCallback(() => { refreshSol(); refreshSolHistory(); }, [refreshSol, refreshSolHistory]);
  // Token sends name their mint (a scanned Solana Pay request may pay a token that is NOT the
  // selection); an unnamed one repolls every visible mint. Per-mint independence is preserved:
  // only the account that moved is refreshed.
  const onSolTokenSent = useCallback((mint?: string | null) => {
    if (mint != null) refreshToken(mint); else refreshTokens();
    refreshSolHistory();
  }, [refreshToken, refreshTokens, refreshSolHistory]);
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
  // Balances sheet rows). Built pure from the IC poll + DEMO shownBalance + the SOL + per-mint
  // token hook states; keyed by stable AssetId so a catalog object refresh never invalidates it.
  const balances = useMemo(
    () => buildAssetBalances({
      catalog, assets,
      icBalances: displayAssetBalances,
      primaryBalance: shownBalance,
      online,
      solState, tokenStates,
    }),
    [catalog, assets, displayAssetBalances, shownBalance, online, solState, tokenStates],
  );
  // Trip Ready J5b — fundsReady: awarded ONCE at the first sight of any spendable balance
  // (DEMO counts; `—` unknowns do not). Reads the memo above; ref-guarded against poll spam.
  useFundsReady(balances);
  // Per-mint token refreshes are consumed by the balance map (status/amount drive each token row)
  // AND by the send paths (SolPayMode's onSentToken names the mint it paid, so a confirmed SPL
  // send refreshes only that token). The SOL send path refreshes SOL only via `refreshSol`, so a
  // confirmed native-SOL send does NOT perturb any token status (plan invariant: independent
  // per-mint statuses).

  // Demo top-up: POST /api/v1/faucet {account, amount}. Uses the response balance directly for an
  // immediate refresh (no waiting on the 2.5s poll). Errors are surfaced inline under the button.
  // Gated on the relay SAYING it serves one (`GET /api/v1/capabilities`, the same flag the faucet
  // route itself obeys), which replaced a guess made from the catalog carrying a DEMO row. Against
  // a relay without a faucet the button is dead weight that can only ever error, so fail honestly
  // BEFORE the POST instead of after.
  const faucetAvailable = capabilities.demoFaucet;
  const topUp = useCallback(async () => {
    if (topUpBusy) return;
    if (!faucetAvailable) {
      setTopUpErr(M.wallet.faucet.unavailableOnRelay);
      return;
    }
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
        setTopUpErr(reason ?? (r.ok ? M.wallet.faucet.failed : M.wallet.faucet.unavailable));
      }
    } catch (e) {
      console.warn('topUp failed:', e instanceof Error ? e.message : String(e));
      setTopUpErr(M.wallet.faucet.offline);
    } finally {
      setTopUpBusy(false);
    }
  }, [topUpBusy, faucetAvailable, relayUrl, identity.publicHex, setBalance, setOnline, resetDeduction]);

  // Web keyboard shortcuts (plan 1b / UX-V5): the first letters of the main actions —
  // P=Pay, R=Receive, T=Top-up (demo money), A=Home (the asset hub), L=Ledger (transactions). Active ONLY on the wallet
  // main view with no text input focused and no sheet/overlay open (Esc is handled per-sheet by
  // useEscapeToClose). Native (no physical keyboard) is a no-op; the on-UI hints are web-only too.
  const anySheetOpen = settingsOpen || passportOpen || howItWorksOpen;
  // Phase 5 (concern C) — the Balances-header tap is disabled only while a PAY engine holds the
  // lock (review/QR/paid = money-critical mid-transaction; switching surfaces over a review is a
  // distraction and tapping a row would be a no-op anyway). During a RECEIVE lock (request QR shown /
  // result) the button STAYS tappable: the Home tab is a sibling surface that does NOT unmount the
  // engine, and the tour/screen-capture flows legitimately visit it over a request QR.
  // The actual protection on the receive side is handleSelect bailing on the lock — a cross-protocol
  // selection (the only thing that would unmount the engine) is suppressed regardless.
  const balancesDisabled = selectionLocked && mode === 'pay';

  useHotkeys({
    p: () => setMode('pay'),
    r: () => setMode('receive'),
    t: topUp,
    // `a` recovers its original Balances meaning: it opens the ACCOUNTS route, the surface the
    // list actually lives on since 2026-09-08 (it had been pointing at Home, where the list was
    // inlined). Same lock rule as the header chip it mirrors.
    a: () => { if (!balancesDisabled) openAccounts(); },
    l: () => setMode('ledger'),
  }, {ignoreIfInputFocused: true, enabled: !anySheetOpen});

  // Leaving a ROUTE — the ONE rule, shared by the Android hardware Back button and the web Escape
  // key. `accounts` returns to whatever opened it; `convert` returns to the accounts list that
  // launched it. Returns whether a route was actually left, which is what the BackHandler needs in
  // order to decide whether to fall through to its exit-confirm.
  //
  // It is one function because it was two: the hardware rule lived in the BackHandler and Escape
  // simply did not exist on these surfaces (X21 — "Esc does not close Convert though sheets
  // advertise it"). Two copies of a navigation rule is how one platform quietly grows a different
  // idea of where Back goes.
  const leaveRoute = useCallback((): boolean => {
    if (mode === 'accounts') { closeAccounts(); return true; }
    if (mode === 'convert') { openAccounts(); return true; }
    return false;
  }, [mode, closeAccounts, openAccounts]);

  // Escape carries NO input guard, deliberately: dismissing the surface you are on must work while
  // a field is focused, which is the universal dialog behaviour `useEscapeToClose` already relies
  // on. It IS gated on `anySheetOpen`, because a sheet over a route owns Escape first — otherwise
  // one press would close the sheet AND navigate out from under it.
  useHotkeys({escape: () => { leaveRoute(); }}, {enabled: !anySheetOpen});

  // D6 — Android hardware BACK must not exit the app instantly from the home screen. The sheets
  // register no BackHandler of their own, so back closes the open sheet first; otherwise the first
  // press shows a transient inline "Press back again to exit" hint and only a second press within
  // 2s calls BackHandler.exitApp(). The hint auto-hides after the same 2s window; the timer is
  // cleared on unmount/re-press (no leaked timers).
  const [backHint, setBackHint] = useState(false);
  const lastBackRef = useRef(0);
  const backHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Android-only (react-native-web's BackHandler stub console.error's on addEventListener, and the
    // e2e driver treats unexpected console.error as RED).
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (settingsOpen) { setSettingsOpen(false); return true; }
      // A ROUTE is left by Back before the app is. This is the difference between a route and a
      // tab, and it is why the accounts list is not a modal. The rule itself lives in `leaveRoute`,
      // shared with the web Escape key so the two platforms cannot disagree about where Back goes.
      if (leaveRoute()) return true;
      if (Date.now() - lastBackRef.current < 2000) { BackHandler.exitApp(); return true; }
      lastBackRef.current = Date.now();
      setBackHint(true);
      if (backHintTimerRef.current) clearTimeout(backHintTimerRef.current);
      backHintTimerRef.current = setTimeout(() => setBackHint(false), 2000);
      return true;
    });
    return () => {
      sub.remove();
      if (backHintTimerRef.current) { clearTimeout(backHintTimerRef.current); backHintTimerRef.current = null; }
    };
  }, [settingsOpen, leaveRoute]);

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
    selectAsset(id);
    setReceiveSubMode('request');
    setPaySubMode('scan');
    setDepositReturnTo(null); // a manual switch supersedes any fund-funnel resume origin
  }, [selectionLocked]);

  // The rail flip inside Receive ▸ "My address" (Objective 2, currency-first wallet): switching
  // WHICH rail of the home-currency group the address surface shows. Deliberately NOT handleSelect
  // — that one resets the within-tab sub-modes so every surface starts fresh on a new asset, which
  // would kick the user out of "My address" at the exact moment they flipped the rail. This switch
  // must KEEP the sub-mode (the whole point is the sibling rail's address one tap away); like any
  // user gesture it still respects the selection lock.
  const receiveRailSelect = useCallback((id: AssetId) => {
    if (!shouldAllowUserSelect(selectionLocked)) return;
    selectAsset(id);
  }, [selectionLocked]);

  // The rail flip inside the Pay tab's fund-first gates (Objective 2, S5): switching to a FUNDED
  // sibling rail of the home currency. Deliberately NOT handleSelect — the pointer lives on a
  // fund gate, where the user's goal (pay or send) survives the switch; handleSelect's sub-mode
  // reset would kick them off the surface they were just pointed to. Like any user gesture it
  // respects the selection lock; Wallet also passes NO switch callback to the engines while
  // locked, so the pointer renders without its button (the rail is still named).
  const payRailSelect = useCallback((id: AssetId) => {
    if (!shouldAllowUserSelect(selectionLocked)) return;
    selectAsset(id);
  }, [selectionLocked]);
  const payRailSwitch = selectionLocked ? undefined : payRailSelect;

  // Zero-funds funnel (2026-08-16 UX): the ONE programmatic "show this asset's deposit address"
  // action used by every fund-first surface (SolPayMode's InstructionPanel + AtaSetupCard's
  // fund-SOL secondary). Programmatic like the deeplink router — it bypasses the selection lock
  // (a fund prompt is never in-flight money movement, and the lock only guards payer snapshots).
  // Lands on the existing Receive → My-address surface (the ONE funding QR — no inline dupe).
  //
  // `returnTo` (UX review finding 8): when the prompt fired from ANOTHER asset's Pay tab (e.g.
  // "Show my SOL address" while paying USDC), remember the origin so My-address can offer a
  // one-tap "Back to paying <asset>" resume once the watched balance flips positive — closing
  // the >2-tap round trip without a modal and without an inline duplicate QR.
  const goToDeposit = useCallback((id: AssetId, returnTo?: AssetId) => {
    selectAsset(id);
    setMode('receive');
    setReceiveSubMode('address');
    // Remember the origin Pay sub-mode too, so the resume link returns to scan OR send exactly
    // where the user was (UX review r2 finding 3) — not always the scanner.
    setDepositReturnTo(returnTo ? {id: returnTo, subMode: paySubMode} : null);
  }, [paySubMode]);
  const returnFromDeposit = useCallback(() => {
    if (!depositReturnTo) return;
    selectAsset(depositReturnTo.id);
    setPaySubMode(depositReturnTo.subMode);
    setDepositReturnTo(null);
    setMode('pay');
  }, [depositReturnTo]);

  // Dismissing the link refusal drops the link with it: the resolve effect re-runs on every
  // catalog change, so keeping the link around would make the message reappear on the next
  // refresh after the user closed it.
  const dismissLinkError = useCallback(() => {
    setLinkError(null);
    setPendingLink(null);
  }, []);

  // Passport deep-links (founder ask 2026-08-24): tapping an unfilled stamp (or NEXT, which
  // routes with the first-missing key) goes straight to the surface where that step completes.
  // The passport closes FIRST in every branch — one surface at a time. SettingsSheet reuses
  // this same map (its onOpenStep prop) for the steps that live outside Settings.
  const goToPassportStep = useCallback((key: ReadinessKey) => {
    setPassportOpen(false);
    switch (key) {
      case 'recoverySaved':
        setSettingsOpenBackup(true);
        setSettingsOpen(true);
        break;
      case 'flowUnderstood':
        setHowItWorksOpen(true);
        break;
      case 'fundsReady':
        openAccounts();
        break;
      case 'paymentTested':
        setMode('pay');
        break;
    }
  }, [openAccounts]);

  // The home-currency gate. Until the user has said which currency they think in, that question IS
  // the wallet — every surface below reads the selection this choice seeds. It sits here, after all
  // hooks, so the hook order is identical in both branches (Rules of Hooks), and it keys on the
  // STORED value alone: a brand-new wallet and one upgrading into this build take the same path.
  if (homeCurrency === null) {
    return <HomeCurrencyChooser assets={assets} balances={balances} catalog={catalog} onChoose={c => { setMode('home'); onSetHomeCurrency(c); }} />;
  }

  return (
    <SafeAreaView style={S.root}>
      {/* Traveler Paper: porcelain bg ⇒ DARK status-bar icons (light-content was the dark-theme
          remnant — white icons on #F4F1E8 were near-invisible). */}
      <StatusBar barStyle={isDark() ? 'light-content' : 'dark-content'} backgroundColor={C.bg} translucent={false} />
      <View style={S.header}>
        <View style={S.headerLeft}>
          <Pressable
            testID="btn-settings"
            style={S.headerSettingsBtn}
            onPress={() => setSettingsOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={M.wallet.header.settings}
            accessibilityHint={M.wallet.header.settingsHint}
          >
            <IconSettings size={20} color={C.sub} />
          </Pressable>
          {/* Wave 8: the theme flip joins the gear in the header's utility cluster (left). The
              icon names the TARGET — the mode one tap lands in (moon in Light = "switch to Dark")
              — and the a11y label carries the same target-state semantics. */}
          <Pressable
            testID="btn-theme"
            style={S.headerSettingsBtn}
            onPress={cycleTheme}
            accessibilityRole="button"
            accessibilityLabel={M.wallet.header.themeSwitch(themeLabel(nextTheme(resolvedTheme)))}
            accessibilityHint={M.wallet.header.themeSwitchHint}
          >
            {nextTheme(resolvedTheme) === 'dark' ? <IconMoon size={20} color={C.sub} /> : <IconSun size={20} color={C.sub} />}
          </Pressable>
          <View style={S.headerIdentity}>
            <WordmarkLink style={S.brand} />
            {/* H4 + audit P1: the header shows ONLY the username. The hex pubkey was developer-facing
                protocol data ("Alice · 1b8a5ee7…") that made the header read like a debug panel; it's
                removed from the main display. The short hex is no longer appended anywhere in the
                header. A small "ACCOUNT" eyebrow above the username separates the wordmark from the
                user identity so the pair no longer reads as a single currency label (a fresh-eyes
                vision misread). The `header-who` element still holds ONLY the username (e2e contract). */}
            <Text style={S.whoLabel} accessibilityLabel={M.wallet.header.accountLabel}>{M.wallet.header.account}</Text>
            {/* One line, ellipsized: a long username must yield the header's width, never take it
                from the account chip (X18). `textContent` is unchanged, so the e2e `header-who`
                contract still reads the full name. */}
            <Text style={S.who} testID="header-who" numberOfLines={1}>{identity.username}</Text>
          </View>
        </View>
        {/* The header account chip. X7 (UX swarm 2026-09-08): a `⌄` beside a balance means "switch
            account" in every wallet, and this one navigated to Home — and on Home it did nothing
            at all. It now opens the ACCOUNTS route, which is what the chevron looked like it did,
            and it does so from EVERY screen including the Pay scanner — the most literal reading
            of the founder's "the list of currencies should still be easily accessible". */}
        <Pressable
          testID="balance"
          style={[S.balBox, balancesDisabled && S.dim]}
          disabled={balancesDisabled}
          onPress={openAccounts}
          accessibilityRole="button"
          accessibilityLabel={M.wallet.balance.label}
          accessibilityHint={balancesDisabled ? M.wallet.balance.lockedHint : M.wallet.balance.hint}
          accessibilityState={{disabled: balancesDisabled}}
        >
          <View style={S.balHeaderRow}>
            <View>
              {/* The header reads the selected asset's pre-formatted displayText from the ONE balance
                  map. DEMO keeps its offline '~' prefix (baked into the map); an IC asset shows its
                  polled native-units balance; SOL/USDC show '—' when the RPC is offline (jest/e2e).
                  X8: NOT on Home. There the Home headline prints a balance ~90 px below this one,
                  and printing the same number twice in one viewport is noise — so on Home the chip
                  keeps only the account name and the chevron, and becomes purely the switcher its
                  chevron always claimed to be.
                  X18: when the amount is hidden the chevron moves UP beside the label instead of
                  keeping a row to itself — that row was 16 px tall, held nothing but the chevron and
                  stretched the chip's full width, so the switcher rendered orphaned at the bottom-left
                  of its own chip (measured on Home: label y 16-32, chevron row y 32-48 at x 251.4). */}
              <View style={S.balLabelRow}>
                <View style={[S.dot, {backgroundColor: online ? C.ok : C.sub2}]} />
                {/* D3: the header label names the active asset in BOTH branches — online reads "X balance",
                    offline reads "~ X approx.". `activeAssetName` is the single source of truth for the
                    symbol; e2e asserts the active rail via this label (testID active-asset-label). */}
                <Text testID="active-asset-label" style={S.balLabel}>{balanceEyebrow}</Text>
                {mode === 'home' ? <IconChevronDown size={16} color={C.sub2} /> : null}
              </View>
              {mode === 'home' ? null : (
                <View style={S.balAmtRow}>
                  <Text style={S.balAmt}>{selectedAsset ? (balances[selectedAsset.id]?.displayText ?? '—') : '—'}</Text>
                  <IconChevronDown size={16} color={C.sub2} />
                </View>
              )}
            </View>
            {/* D5a: the A badge sits at the FAR RIGHT edge of the row (label+value column, then the
                badge) matching the tab-bar pattern — it was inline after the label text, which read
                as a keyboard glyph attached to the label, not the pressable. */}
            <HotkeyHint k="A" />
          </View>
          {backHint ? (
            <Text testID="back-exit-hint" style={S.balBackHint}>{M.wallet.balance.backAgainToExit}</Text>
          ) : null}
        </Pressable>
      </View>

      {/* Trip Ready J5b (UX hardening 2026-08-23) — the home-surface readiness line. Live progress
          that taps straight into the passport ARCHIVE (the permanent record; one fact, two
          surfaces: strip = live entry, archive = record). Retires itself when done.
          X14 (UX swarm 2026-09-08): HOME ONLY. It was rendered outside the mode switch, so a
          first-run progress meter sat on all four tabs with no dismiss — every screen telling the
          user they owed the app something. Home is what its own name says it is, and since Home is
          now the landing screen the strip is seen at launch anyway. */}
      {mode === 'home' ? <TripStrip onOpen={() => setPassportOpen(true)} /> : null}

      {/* The practice faucet's answer, rendered ONCE and rendered HERE — outside the mode switch,
          because the action can be fired from anywhere. `T` is a global hotkey (`useHotkeys` above,
          live on every surface) and the button itself lives on the accounts route, so a refusal
          printed inside one tab was invisible from the other three: press T on Pay and nothing at
          all came back. That matters in production more than it does here, because the refusal is
          the NORMAL outcome — the faucet allows one top-up per account per hour and first run has
          already spent it, so the cooldown reason is what most presses earn. One node, every
          surface (founder rule 2026-08-29: every step, especially the error path, tells the user
          what is going on). The testID is unchanged, so the flows that read it still do. */}
      {topUpErr ? <Text testID="topup-err" style={S.topUpErr}>{topUpErr}</Text> : null}

      <ScrollView style={S.scroll} contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        {mode === 'home'
          ? <HomeTab
              assets={assets}
              balances={balances}
              catalog={catalog}
              homeCurrency={homeCurrency}
              homeAsset={homeAsset}
              online={online}
              history={ledgerHistory}
              // Scan pins the sub-mode, so the camera is live in ONE tap from a cold start whatever
              // the Pay tab was last left showing (a `send` sub-mode left over from a previous
              // session would otherwise make the till gesture two taps — the exact regression the
              // primary Scan button exists to prevent).
              onScan={() => { setPaySubMode('scan'); setMode('pay'); }}
              onReceive={() => setMode('receive')}
              onDeposit={goToDeposit}
              onOpenAccounts={openAccounts}
              onSeeAll={() => setMode('ledger')}
              onOpenReceipt={setReceiptTxn}
            />
          : mode === 'accounts'
          ? <AccountsTab
              assets={assets}
              selectedId={effectiveSelectedId}
              balances={balances}
              homeCurrency={homeCurrency}
              demoFaucetAvailable={capabilities.demoFaucet}
              topUpBusy={topUpBusy}
              hasTestnet={hasTestnet}
              showTestnet={showTestnet}
              onToggleTestnet={toggleTestnet}
              onBack={closeAccounts}
              onSelect={handleSelect}
              onTopUp={topUp}
              onConvert={() => setMode('convert')}
            />
          : mode === 'pay'
          ? (activeSol && solAddress
              ? <SolPayMode identity={identity} online={online} nfcStatus={nfc} assets={assets} catalog={catalog} homeCurrency={homeCurrency} balances={balances} onSwitchRail={payRailSwitch} solBalance={solBalance ?? '0'} tokenBalance={selectedTokenBalance} tokenAtaAbsent={selectedTokenAbsent} tokenBalances={tokenStates} payGate={activeSolAsset != null ? solPayGate(selectedSolToken, solState, selectedTokenState ?? {amount: null, status: 'loading'}) : 'none'} solZero={solState.status === 'ok' && solState.balance === '0'} solChecking={solState.status === 'loading' || solState.balance == null} selectedToken={selectedSolToken} onSent={onSolSent} onSentToken={onSolTokenSent} onShowSolAddress={() => goToDeposit('solana:SOL', activeSolAsset != null && activeSolAsset.id !== 'solana:SOL' ? activeSolAsset.id : undefined)} onShowTokenAddress={() => goToDeposit(activeSolAsset?.id ?? 'solana:SOL')} onRecheckBalances={recheckSolBalances} recheckBusy={recheckBusy} ataSetupBusy={ataSetupBusy} ataSetupErr={ataSetupErr} onCreateAta={createAta} subMode={paySubMode} onSubModeChange={setPaySubMode} sendPrefill={solPrefill} onSendPrefillConsumed={() => setSolPrefill(null)} onScannedLink={handleUrl} onLockChange={setSelectionLocked} />
              : <PayMode
                  identity={identity} online={online} nfcStatus={nfc}
                  onSettled={onActivity} onOfflinePaid={markOfflinePaid} shownBalance={shownBalance}
                  onShowDepositAddress={() => goToDeposit(`ic:${selectedCurrency}`, `ic:${selectedCurrency}`)}
                  onRefreshBalances={recheckIcBalances}
                  refreshBusy={recheckBusy}
                  catalog={catalog} assets={assets} assetBalances={displayAssetBalances}
                  homeCurrency={homeCurrency} balances={balances} onSwitchRail={payRailSwitch}
                  withdrawCurrency={selectedCurrency}
                  withdrawDisplay={depositDisplay} withdrawFamily={depositFamily}
                  withdrawTokenContract={selectedDesc?.token_contract ?? null}
                  withdrawBalance={displayAssetBalances[selectedCurrency] ?? '0'}
                  subMode={paySubMode} onSubModeChange={setPaySubMode}
                  prefillIntent={prefillIntent} onPrefillConsumed={() => setPrefillIntent(null)}
                  onScannedLink={handleUrl}
                  onLockChange={setSelectionLocked}
                />
          )
          : mode === 'receive'
          ? (activeSol && solAddress
              ? <SolReceiveMode
                  identity={identity} relayUrl={relayUrl} nfcStatus={nfc} solAddress={solAddress}
                  subMode={receiveSubMode} onSubModeChange={setReceiveSubMode}
                  codeForm={receiveCodeForm} onCodeFormChange={setReceiveCodeForm}
                  tillAvailable={capabilities.till}
                  catalog={catalog}
                  selectedToken={selectedSolToken}
                  assets={assets}
                  selectedAssetId={effectiveSelectedId}
                  balances={balances}
                  onSelectAsset={handleSelect}
                  tokenAtaStatus={selectedTokenState?.status ?? 'loading'}
                  tokenAmount={selectedTokenState?.amount ?? null}
                  solBalance={solBalance}
                  solOk={solState.status === 'ok'}
                  ataSetupBusy={ataSetupBusy} ataSetupErr={ataSetupErr} onCreateAta={createAta}
                  onShowSolAddress={() => goToDeposit('solana:SOL')}
                  onRefreshToken={refreshSelectedToken}
                  onRefreshSol={refreshSol}
                  depositReturnLabel={
                    // Resume link fires ONLY when the deposit actually landed (known positive
                    // balance on the watched asset) — never on loading/error/unconfirmed state.
                    // The label names the asset being returned to by its own row's symbol.
                    selectedAsset?.id === 'solana:SOL' && solState.status === 'ok' && solBalance != null && solBalance !== '0' && depositReturnTo
                      ? M.wallet.backToPaying(assets.find(a => a.id === depositReturnTo.id)?.symbol ?? 'SOL')
                      : null}
                  onReturnFromDeposit={returnFromDeposit}
                  onLockChange={setSelectionLocked}
                  homeCurrency={homeCurrency}
                  onReceiveRailChange={receiveRailSelect}
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
                    identity={identity} relayUrl={relayUrl} online={online} nfcStatus={nfc}
                    onReceived={onActivity} catalog={catalog}
                    depositCurrency={selectedCurrency}
                    depositDisplay={depositDisplay} depositChainId={depositChainId}
                    depositNativeEth={depositNativeEth} depositFamily={depositFamily}
                    subMode={receiveSubMode} onSubModeChange={setReceiveSubMode}
                    codeForm={receiveCodeForm} onCodeFormChange={setReceiveCodeForm}
                    tillAvailable={capabilities.till}
                    depositReturnLabel={
                      // Same rule as the SOL rail: the resume link appears ONLY once the deposit
                      // actually landed (a known-positive balance on the asset being funded), never
                      // while the balance is still loading or zero — a "back to paying" offered
                      // over an unfunded account would send the user straight back to the gate.
                      depositReturnTo && selectedAsset?.protocol === 'ic'
                        && displayAssetBalances[selectedCurrency] != null
                        && displayAssetBalances[selectedCurrency] !== '0'
                        ? M.wallet.backToPaying(selectedAsset.symbol)
                        : null}
                    onReturnFromDeposit={returnFromDeposit}
                    prefillReceipt={prefillReceipt} onReceiptConsumed={() => setPrefillReceipt(null)}
                    selectedCurrency={selectedCurrency}
                    assets={assets}
                    selectedAssetId={effectiveSelectedId}
                    balances={balances}
                    onSelectAsset={handleSelect}
                    onLockChange={setSelectionLocked}
                    homeCurrency={homeCurrency}
                    onReceiveRailChange={receiveRailSelect}
                  />
                )
          )
          : mode === 'convert'
          ? <ConvertMode
              identity={identity}
              relayUrl={relayUrl}
              catalog={catalog}
              selectedAsset={selectedAsset}
              assetBalances={displayAssetBalances}
              // Back goes where Convert is launched FROM — the accounts route (X15 moved the
              // action onto the selected account's row). Returning to Home would drop the user
              // somewhere they never were.
              onBack={openAccounts}
              onActivity={onActivity}
              // The zero-balance gate's action — the SAME deposit trip the Pay tab's gate fires.
              // No `returnTo`: that argument offers a "back to PAYING <asset>" resume once the
              // balance lands (returnFromDeposit sets mode 'pay'), and this user came from
              // Convert, not from Pay. Sending them somewhere they never were is worse than
              // sending them nowhere.
              onShowDepositAddress={() => goToDeposit(`ic:${selectedCurrency}`)}
              // The pair's other leg, switched the same way the Pay gate switches a funded rail:
              // a user gesture that respects the selection lock and leaves the tabs' sub-modes
              // alone. Withheld while locked, exactly as the Pay pointer's button is.
              onSwitchAsset={payRailSwitch}
            />
          : <Ledger history={ledgerHistory} catalog={catalog} assets={assets} dropped={solDropped} onOpenReceipt={setReceiptTxn} />}
      </ScrollView>

      {/* O4 S1 — persistent bottom navigation: the primary tabs moved from the top pill row
          to a bar OUTSIDE the ScrollView (primary nav stays reachable without scrolling). Same
          `mode` union, byte-stable testIDs, and P/R/L hotkeys (useHotkeys); the enclosing
          SafeAreaView owns the bottom safe-area inset. Home sits LEFTMOST and is now the LANDING
          mode (2026-09-08); the two ROUTES (accounts, convert) light no tab — they are entered
          from a control and left by Back, which is what makes them routes rather than tabs. */}
      <View style={S.bottomNav}>
        <Tab variant="bottom" testId="tab-home" label={M.wallet.tab.home} active={mode === 'home'} onPress={() => setMode('home')} icon={c => <IconHome size={22} color={c} />} />
        <Tab variant="bottom" testId="tab-pay" label={M.wallet.tab.pay} active={mode === 'pay'} onPress={() => setMode('pay')} icon={c => <IconQr size={22} color={c} />} />
        <Tab variant="bottom" testId="tab-receive" label={M.wallet.tab.receive} active={mode === 'receive'} onPress={() => setMode('receive')} icon={c => <IconArrowDownLeft size={22} color={c} />} />
        <Tab variant="bottom" testId="tab-transactions" label={M.wallet.tab.transactions} active={mode === 'ledger'} onPress={() => setMode('ledger')} icon={c => <IconClock size={22} color={c} />} />
      </View>

      {settingsOpen ? (
        <SettingsSheet
          relayUrl={relayUrl}
          setRelayUrl={setRelayUrl}
          setSolanaRpc={setSolanaRpc}
          onSolanaRpcApplied={recheckSolBalances}
          onClose={() => { setSettingsOpen(false); setSettingsOpenBackup(false); }}
          onReset={onReset}
          onRestore={onRestore}
           secretHex={identity.secretHex}
           username={identity.username}
            themeChoice={themeChoice}
            onSetTheme={onSetTheme}
            localeChoice={localeChoice}
            onSetLocale={onSetLocale}
            homeCurrency={homeCurrency}
            onSetHomeCurrency={onSetHomeCurrency}
            assets={assets}
            openBackup={settingsOpenBackup}
            onOpenStep={goToPassportStep}
         />
      ) : null}
      {passportOpen ? (
        <AppModal onRequestClose={() => setPassportOpen(false)}>
          <PassportArchive onClose={() => setPassportOpen(false)} onStep={goToPassportStep} />
        </AppModal>
      ) : null}
      {howItWorksOpen ? (
        <AppModal onRequestClose={() => setHowItWorksOpen(false)}>
          <Walkthrough
            onClose={() => setHowItWorksOpen(false)}
            onDone={() => setHowItWorksOpen(false)}
          />
        </AppModal>
      ) : null}
      {/* X6 — the receipt for one transaction row. Mounted at the ROOT (see `receiptTxn` above),
          so the overlay covers the whole app column whichever list opened it. */}
      {receiptTxn ? (
        <TxnReceipt t={receiptTxn} catalog={catalog} assets={assets} onClose={() => setReceiptTxn(null)} />
      ) : null}
      {/* An incoming payment link that cannot be paid. It states WHICH asset/chain the link asked
          for and the one action the payer can take (founder hard rule: every dead end gives a
          useful instruction). dpay never swaps, so no "pay it with something else" is offered.
          Dismissing drops the link — nothing is retried behind the user's back. */}
      {linkError ? (
        <AppModal onRequestClose={dismissLinkError}>
          {/* Centered dimmed card — the same shape as the NFC "why is this unavailable" popup, so a
              short explanation reads as a popup on BOTH platforms instead of a full screen with one
              paragraph pinned to the top (found on the emulator, 2026-08-29). Tapping the backdrop
              dismisses, matching that popup. */}
          {/* No accessibilityRole here — an accessible backdrop renders as a <button> on web and
              nesting the Close button inside it is invalid HTML. The explicit Close button below
              carries the label; this matches the NFC popup exactly. */}
          <Pressable style={S.pickBackdrop} onPress={dismissLinkError}>
            <View testID="pay-link-error" style={S.pickCard} onStartShouldSetResponder={() => true}>
              <Text style={S.pickTitle}>{M.pay.link.title}</Text>
              <Text testID="pay-link-error-body" style={S.nfcInfoBody}>{linkError}</Text>
              <Pressable
                testID="btn-pay-link-error-close"
                style={S.nfcInfoClose}
                onPress={dismissLinkError}
                accessibilityRole="button"
                accessibilityLabel={M.pay.close}
                accessibilityState={{disabled: false}}>
                <Text style={S.nfcInfoCloseText}>{M.pay.close}</Text>
              </Pressable>
            </View>
          </Pressable>
        </AppModal>
      ) : null}
    </SafeAreaView>
  );
}
