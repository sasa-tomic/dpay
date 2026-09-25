// ConvertMode — the SWAP SCREEN (the currency-level Convert surface, 2026-09-24 redesign).
//
// The founder's sketch, verbatim grammar:
//   <Source currency>             <amount sell, user enter>
//   <Source balance>
//   ---------------------------------------
//   <Target currency>             <amount get, calculated>
//   <Target balance>
//
// One surface for EVERY currency and EVERY rail (the uniform-IA hard rule — the old per-rail
// SOL sibling screen is folded in as a row kind, not a separate UI). The source is the currency
// the user came from (a currency-row Convert button, or Home's Convert for the main currency);
// the target is a currency the user picks — the source's own row renders DISABLED. Both balance
// lines render in the CURRENCY unit (fork #4); every quote-side number keeps the venue's own
// token unit — the peg disclosure lives where fees and quotes are shown.
//
// Below the target row: THE VENUE AREA (fork #3, the 2026-09-11 no-ranking rule). The pair
// (source rail → target currency) resolves through app/config/swap.ts into executable rows —
// direct pools, hub compositions, CCTP cross-rail routes, CeFi venues, Solana venues — in
// REGISTRY order. Several rows: side-by-side, each showing its own quote where its venue serves
// one live (the V5 chooser rule), NONE preselected, the checklist + confirm withheld until the
// user picks. One row: no chooser chrome — an attributed line. A venue's own listed-but-unquoted
// verdict renders the honest attributed no-market state (the flow-207 pattern), never a red
// error shaped like a quote.
//
// What does NOT change (the spec's own list): dpay is never a party — the user's phone signs
// every value-moving call; the venue's quote is attributed + timestamped; every fee on its own
// line; the minimum-you'll-receive; the failure branches naming what the user is left holding.
// The whole transparency checklist lives behind the confirm button's review card, exactly as
// before. The §4 state machine (app/convert.ts) and the record/resume engine are reused whole.
//
// Quote-fetch discipline (per venue kind, inherited unchanged): IC pool + Solana venue quotes
// are public surfaces — one call per keystroke per RENDERED row, auto-refreshed when stale
// (>30 s, test-seam overridable). Hub compositions re-quote BOTH hops fresh at confirm. CeFi
// quotes ride the relay's partner-key proxy — fetched when the row is PICKED (and again at the
// confirm gesture, which mints the order's own locked quote), NEVER on a timer and never for an
// unpicked row (the 2026-09-22 partner agreement: no machine-generated demand).
import {useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, Text, TextInput, View} from 'react-native';
import {isValidDestinationAddress, type CurrencyDescriptor} from '../config/catalog';
import type {SelectableAsset} from '../config/assets';
import {
  CONVERT_CEFI_CONFIRM_TIMEOUT_MS,
  CONVERT_SLIPPAGE_BPS_DEFAULT,
  CONVERT_SLIPPAGE_BPS_OPTIONS,
} from '../config/convert';
import {currencyName, currencyOfAsset, type HomeCurrency} from '../config/currency';
import {
  resolveSwapTargets,
  standingTarget,
  type SwapRow,
  type SwapTarget,
} from '../config/swap';
import {venueDisplayName, venueOfId, type VenueEntry} from '../config/venues';
import {
  CeFiNoQuoteError,
  ceFiQuoteFromResult,
  ceFiServiceError,
  createCeFiOrder,
  deriveConvertMath,
  fetchCeFiConvertQuote,
  fetchCeFiQuoteResult,
  fetchConvertQuote,
  fetchCctpBurnFee,
  gasFundNeededWei,
  isQuoteStale,
  loadVenueRegistry,
  prepareCeFiConvertRecord,
  prepareConvertRecord,
  prepareHubConvertRecord,
  prepareMultihopConvertRecord,
  prepareSolanaConvertRecord,
  TERMINAL_CONVERT_STEPS,
  type ConvertMath,
  type ConvertQuote,
  type ConvertRecord,
  type CeFiQuoteResult,
} from '../convert';
import {
  adoptConvertRecord,
  convertResumeSnapshot,
  subscribeConvertRecords,
} from '../convertResume';
import {cctpMaxFee, cctpMintFloor, fetchEthBalance} from '../cctp';
import {DpayCore} from '../services/native';
import {fetchJupiterQuote, type JupiterQuote} from '../services/jupiter';
import {USDC_MINT_ADDRESS, WRAPPED_SOL_MINT_ADDRESS} from '../solana/tokens';
import {deriveSolanaAddress} from '../solana/identity';
import {fetchGasFeeWei, fetchLedgerFee} from '../services/rail';
import {gasFundRoutes} from '../routes';
import {M} from '../i18n';
import {fmtAssetCompact, parseUserAmount, randNonceHex, rawToDecimal} from '../lib/format';
import {eip55ChecksumBad} from '../lib/eip55';
import type {AssetId, Identity} from '../lib/types';
import type {BalanceView} from '../lib/assetBalances';
import {C} from '../config/palette';
import {S} from '../styles';
import {IconChevronDown, IconSwap} from './icons';
import {InstructionPanel} from './InstructionPanel';
import {
  ConvertHeader,
  DetailsToggle,
  fetchHubQuotes,
  formatBps,
  formatMillionthsPct,
  isLiveRecord,
  nonBreakingClock,
  scaledRate,
  UnavailablePanel,
  venueDisclosure,
} from './ConvertShared';
import {StatePanel} from './ConvertStatePanel';
import {RouteStatePanel} from './ConvertRouteStatePanel';
import {CrossRailStatePanel} from './ConvertCrossRailStatePanel';
import {SolStatePanel} from './SolStatePanel';

type Props = {
  identity: Identity;
  relayUrl: string;
  catalog: CurrencyDescriptor[];
  /** The standing SOURCE rail — resolved by the entry gesture (chooseRail: the funded rail,
   *  else the stated preference). Null renders the fail-closed panel. */
  selectedAsset: SelectableAsset | null;
  /** The user's spendable raw-unit balance strings for IC assets, if known. */
  assetBalances: Record<number, string>;
  /** The VISIBLE currencies, in list order — the swap's target scope (a hidden currency is
   *  re-added via Add new currency first; that is the list-first IA's own answer). */
  visibleCurrencies: readonly HomeCurrency[];
  /** The per-currency SUMMED views — both balance lines render in currency unit (fork #4). */
  currencyBalances: Readonly<Partial<Record<HomeCurrency, BalanceView>>>;
  onBack: () => void;
  /** Fires when a swap reaches a terminal state so Wallet refreshes balances + history rows. */
  onActivity: () => void;
  /** The zero-balance gate's one action: land the selected asset's own deposit surface. */
  onShowDepositAddress: () => void;
  /** Switch the wallet's selection (the funded-account pointer on the fund gate). Absent while
   *  the wallet's selection is locked — the account is still named, the button withheld. */
  onSwitchAsset?: (id: AssetId) => void;
  /** Solana-rail balances: raw-unit spendable SOL (lamports) + per-mint token amounts. The
   *  fund gate + insufficient check read these; absent/empty means "unknown" (fail soft). */
  solana?: {sol: string | null; tokens: Record<string, string | null>};
};

/** One hub row's two-quote bundle (quote1 from→hub, quote2 hub→dest sized on m1.minOut). */
type HubBundle = {q1: ConvertQuote; m1: ConvertMath; q2: ConvertQuote; m2: ConvertMath};

export function ConvertMode({
  identity, relayUrl, catalog, selectedAsset, assetBalances, visibleCurrencies,
  currencyBalances, onBack, onShowDepositAddress, onSwitchAsset, solana,
}: Props) {
  // ── Source facts ─────────────────────────────────────────────────────────────────────────────
  // The standing rail's own unit (the thing the venue actually converts) plus the CURRENCY it
  // settles (the unit both balance lines render in). DEMO carries no currency — the practice
  // rail is not a currency in this model — and reaches no venue: the fail-closed panel is the
  // honest screen for it, as it always was.
  const sourceCurrency: HomeCurrency | null = selectedAsset != null ? currencyOfAsset(selectedAsset) : null;
  const isSolSource = selectedAsset?.protocol === 'solana';
  const sourceDesc: CurrencyDescriptor | null = selectedAsset != null && selectedAsset.protocol === 'ic'
    ? catalog.find(c => c.currency === selectedAsset.currency) ?? null
    : null;
  const inMint: string | null = isSolSource ? (selectedAsset!.mint ?? WRAPPED_SOL_MINT_ADDRESS) : null;
  const inSym: string = selectedAsset == null
    ? ''
    : isSolSource
      ? selectedAsset.symbol
      : sourceDesc?.backing_symbol ?? sourceDesc?.symbol ?? selectedAsset.symbol;
  const inDecimals: number = selectedAsset?.decimals ?? 8;
  const inFee: string = sourceDesc?.fee ?? '0';
  // The SOURCE balance the gates compute against — the standing rail's own raw figure (the sell
  // draws from THIS rail). The balance LINE renders the currency-unit sum above it.
  const balanceRaw: string | null = selectedAsset == null
    ? null
    : isSolSource
      ? (inMint === WRAPPED_SOL_MINT_ADDRESS ? solana?.sol ?? null : solana?.tokens[inMint ?? ''] ?? null)
      : assetBalances[selectedAsset.currency];
  const balanceN = balanceRaw != null && /^\d+$/.test(balanceRaw) ? BigInt(balanceRaw) : null;

  // ── The resolved pair ────────────────────────────────────────────────────────────────────────
  const targetScope = useMemo(
    () => visibleCurrencies.filter(c => c !== sourceCurrency),
    [visibleCurrencies, sourceCurrency],
  );
  // The relay's served venue registry (V5): what THIS relay serves, loaded once per relay;
  // the bundled table is the fallback until it lands. Key input to the pair walk.
  const [venueList, setVenueList] = useState<readonly VenueEntry[] | null>(null);
  // `venueList` IS a dependency: when the relay's served registry lands (the knob-armed
  // fixture venue, a new pool) the pairs re-resolve — the old chooser re-quoted per served
  // row, and the currency-level walk inherits exactly that.
  const targets: SwapTarget[] = useMemo(
    () => selectedAsset != null
      ? resolveSwapTargets({catalog, source: selectedAsset, targetCurrencies: targetScope}) ?? []
      : [],
    [selectedAsset, catalog, targetScope, venueList],
  );
  // The target pick. Keyed to the SOURCE asset like every per-pair state here: a different
  // source re-derives the standing pair (render-phase adjustment — the SolConvertMode
  // destMintKey precedent), and an explicit pick wins until the source changes.
  const [targetSel, setTargetSel] = useState<HomeCurrency | null>(null);
  const [pairKey, setPairKey] = useState<string | null>(null);
  const [targetListOpen, setTargetListOpen] = useState(false);
  const [selRowId, setSelRowId] = useState<string | null>(null);
  if ((selectedAsset?.id ?? null) !== pairKey) {
    setPairKey(selectedAsset?.id ?? null);
    setTargetSel(null);
    setTargetListOpen(false);
    setSelRowId(null);
  }
  const target: SwapTarget | null = targetSel != null
    ? targets.find(t => t.currency === targetSel) ?? standingTarget(targets)
    : standingTarget(targets);
  const targetCode: HomeCurrency | null = target?.currency ?? null;
  const rows: SwapRow[] = target?.rows ?? [];
  // THE red line, expressed as data — scoped exactly as fork #3 states it: when SEVERAL VENUES
  // (registry rows — pools, Solana venues, CeFi services) serve the pair, NOTHING is
  // preselected and the checklist/confirm stay withheld until a user pick (the 2026-09-11
  // no-ranking rule; venues are the things a price could rank). Composed routes (hub, CCTP)
  // are not venues and cannot be ranked against one: under the standing-default rule (hub UX
  // D2, 2026-09-18 — the direct pool is the standing surface, a hub is an explicit switch
  // away) the single-venue pair arms on its one venue, and the route rows below render as
  // explicit opt-ins. One row total → no chooser chrome at all: an attributed line, exactly
  // the single-venue surface that always was.
  const multiVenue = rows.filter(r => r.kind !== 'hub' && r.kind !== 'crossrail').length > 1;
  const standingRow: SwapRow | null = multiVenue
    ? null
    : rows.find(r => r.kind !== 'hub' && r.kind !== 'crossrail') ?? rows[0] ?? null;
  const activeRow: SwapRow | null = multiVenue
    ? rows.find(r => r.rowId === selRowId) ?? null
    : selRowId != null ? rows.find(r => r.rowId === selRowId) ?? standingRow : standingRow;
  const directRow = activeRow != null && activeRow.kind === 'direct' ? activeRow : null;
  const hubRow = activeRow != null && activeRow.kind === 'hub' ? activeRow : null;
  const crossRow = activeRow != null && activeRow.kind === 'crossrail' ? activeRow : null;
  const cefiRow = activeRow != null && activeRow.kind === 'cefi' ? activeRow : null;
  const ammRow = activeRow != null && activeRow.kind === 'solamm' ? activeRow : null;
  const hubMode = hubRow != null;
  const routeMode = crossRow != null;
  const cefiMode = cefiRow != null;
  const ammMode = ammRow != null;
  // The OUTPUT leg the form names (per active row): the direct pool's catalog row, the hub
  // destination, the route's destination, the CeFi settle asset, the Solana venue's other mint.
  const outSym: string =
    directRow != null ? directRow.outDesc.backing_symbol ?? directRow.outDesc.symbol ?? ''
    : hubRow != null ? hubRow.route.dest.symbol
    : crossRow != null ? (crossRow.route.crossRail?.sol != null ? crossRow.route.crossRail.sol.outSymbol : crossRow.route.dest.symbol)
    : cefiRow != null ? cefiRow.outSym
    : ammRow != null ? ammRow.outSym
    : inSym;
  const outDecimals: number =
    directRow != null ? directRow.outDesc.decimals ?? inDecimals
    : hubRow != null ? hubRow.route.dest.decimals
    : crossRow != null ? (crossRow.route.crossRail?.sol != null ? crossRow.route.crossRail.sol.outDecimals : crossRow.route.hop.decimals)
    : cefiRow != null ? cefiRow.outDecimals
    : ammRow != null ? ammRow.outDecimals
    : inDecimals;

  // ── Screen state ─────────────────────────────────────────────────────────────────────────────
  const [amountText, setAmountText] = useState('');
  const [slippageBps, setSlippageBps] = useState<number>(CONVERT_SLIPPAGE_BPS_DEFAULT);
  // Per-row quotes: direct pools + crossrail swap-hops + CeFi settle figures live here (all are
  // ConvertQuote-shaped); Solana venue quotes in their own map (Jupiter's own shape, rendered
  // verbatim); hub rows carry the two-quote bundle.
  const [rowQuotes, setRowQuotes] = useState<Record<string, ConvertQuote>>({});
  const [rowQuoteErrs, setRowQuoteErrs] = useState<Record<string, string>>({});
  // The raw amount each row's quote was fetched AT — a row whose cached quote predates the
  // current amount re-fetches; a pick that re-keys the effect does NOT disturb fresh quotes
  // (the old chooser's pick was instant for exactly this reason). REF, not state: this is
  // fetch bookkeeping, never a render fact — a state copy here would re-key the fetch effect
  // by its own write (the maximum-update-depth loop).
  const rowQuoteAmts = useRef<Record<string, string>>({});
  const [jupQuotes, setJupQuotes] = useState<Record<string, JupiterQuote>>({});
  const jupQuoteAmts = useRef<Record<string, string>>({});
  const [hubBundles, setHubBundles] = useState<Record<string, HubBundle>>({});
  const hubBundleAmts = useRef<Record<string, string>>({});
  // The venue's own listed-but-unquoted verdict (CeFi no-quote, 2026-09-22): a STATE, not an
  // error — it renders as the attributed no-market line for its row, never a red quote error.
  const [noQuoteRow, setNoQuoteRow] = useState<{rowId: string; venueName: string} | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [staleRefreshing, setStaleRefreshing] = useState(false);
  const [quoteChanged, setQuoteChanged] = useState<{oldAmt: string; newAmt: string} | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [record, setRecord] = useState<ConvertRecord | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Sync latch for the confirm gesture: `confirmBusy` state lags a re-render, and a duplicate
  // press delivered inside that window would run prepare twice (observed once under heavy host
  // load, 2026-09-17). The ref closes it same-tick.
  const confirmBusyRef = useRef(false);
  const mountedRef = useRef(true);
  // WHICH record this screen is showing (the engine-view pick + the confirm handoff).
  const recordIdRef = useRef<string | null>(null);

  // The active row's quote bundle, resolved per render from the maps. A quote lives keyed under
  // its own row id, so a re-key (amount/target/pick change) drops it by construction — the old
  // stale-destination-quote race class cannot recur.
  const activeIcQuote: ConvertQuote | null = activeRow != null && (activeRow.kind === 'direct' || activeRow.kind === 'crossrail')
    ? rowQuotes[activeRow.rowId] ?? null
    : null;
  const activeJup: JupiterQuote | null = ammRow != null ? jupQuotes[ammRow.rowId] ?? null : null;
  const activeCefiQuote: ConvertQuote | null = cefiRow != null ? rowQuotes[cefiRow.rowId] ?? null : null;
  const activeHub: HubBundle | null = hubRow != null ? hubBundles[hubRow.rowId] ?? null : null;
  const activeRowErr: string | null = activeRow != null ? rowQuoteErrs[activeRow.rowId] ?? null : null;

  // ── The engine view (V6): pick the record to render, then follow it. The resume engine
  //    (hooks/useConvertResumeEngine, mounted from Wallet) drives EVERY live record from wallet
  //    load — this screen is a read model: the newest live/pending record on mount, then
  //    whatever updates arrive for the record this screen adopted or confirmed.
  useEffect(() => {
    mountedRef.current = true;
    const pick = (records: Record<string, ConvertRecord>) => {
      const id = recordIdRef.current;
      if (id != null) {
        setRecord(records[id] ?? null);
        return;
      }
      const live = Object.values(records)
        .filter((r) => isLiveRecord(r)
          || (r.step === 'stuck' && r.acknowledgedStuckAtMs == null)) // still needs the user's eye
        .sort((a, b) => b.createdAtMs - a.createdAtMs)[0] ?? null;
      if (live != null) recordIdRef.current = live.id;
      setRecord(live);
    };
    pick(convertResumeSnapshot());
    const unsubscribe = subscribeConvertRecords((records) => {
      if (mountedRef.current) pick(records);
    });
    return () => {
      unsubscribe();
      mountedRef.current = false;
    };
    // identity/relayUrl are stable for the wallet session; the view binds once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Venue registry: what THIS relay serves (multi-venue readiness V5). One load per relay
  //    per session (loadVenueRegistry caches); until it lands the bundled registry IS the list.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await loadVenueRegistry(relayUrl);
      if (!cancelled && mountedRef.current) setVenueList(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [relayUrl]);

  // ── Quote fetch: only for a valid positive amount while the form (not a record) is showing.
  //    The plan: every LIVE row (direct pools + Solana venues — public quote surfaces) quotes
  //    whenever rendered; a hub/crossrail/cefi row quotes only once PICKED (the D5 rule one
  //    level up: an unpicked row carries its label, never another mechanism's live number — and
  //    a CeFi row is never quoted for demand the user did not initiate).
  useEffect(() => {
    if (target == null || isLiveRecord(record)) return;
    const parsed = parseUserAmount(amountText, inDecimals);
    if (!parsed.ok || parsed.raw === '0') {
      setRowQuotes({});
      setRowQuoteErrs({});
      rowQuoteAmts.current = {};
      setJupQuotes({});
      jupQuoteAmts.current = {};
      setHubBundles({});
      hubBundleAmts.current = {};
      setNoQuoteRow(null);
      setQuoteErr(null);
      setQuoteBusy(false);
      return;
    }
    // The fetch plan: every LIVE row (direct pools + Solana venues — public quote surfaces)
    // whose cached quote is missing or predates the current amount, plus the PICKED row of a
    // wait-for-pick kind (hub / crossrail hop / cefi). Cefi rows are NEVER quoted for an
    // unpicked row — no machine-generated partner demand (2026-09-22 agreement).
    const live = rows.filter(r => r.kind === 'direct' || r.kind === 'solamm');
    const pickedWait = activeRow != null && !live.some(r => r.rowId === activeRow.rowId) ? [activeRow] : [];
    const needs = (r: typeof rows[number]): boolean => {
      if (r.kind === 'direct' || r.kind === 'crossrail') return rowQuoteAmts.current[r.rowId] !== parsed.raw;
      if (r.kind === 'solamm') return jupQuoteAmts.current[r.rowId] !== parsed.raw;
      if (r.kind === 'hub') return hubBundleAmts.current[r.rowId] !== parsed.raw;
      return rowQuoteAmts.current[r.rowId] !== parsed.raw; // cefi (picked only)
    };
    const plan = [...live, ...pickedWait].filter(needs);
    if (plan.length === 0) return;
    let cancelled = false;
    setQuoteBusy(true);
    setQuoteErr(null);
    void (async () => {
      const quotes: Record<string, ConvertQuote> = {};
      const errs: Record<string, string> = {};
      const amts: Record<string, string> = {};
      const jups: Record<string, JupiterQuote> = {};
      const jupAmts: Record<string, string> = {};
      const hubs: Record<string, HubBundle> = {};
      const hubAmts: Record<string, string> = {};
      const noQuoteRef: {v: {rowId: string; venueName: string} | null} = {v: null};
      await Promise.allSettled(plan.map(async (r) => {
        try {
          if (r.kind === 'direct') {
            quotes[r.rowId] = await fetchConvertQuote(relayUrl, r.inLedger, r.outLedger, parsed.raw, {venue: r.venue});
            amts[r.rowId] = parsed.raw;
          } else if (r.kind === 'solamm') {
            const name = venueDisplayName(r.venue.venue_id);
            const res = await fetchJupiterQuote(relayUrl, r.venue, r.inMint, r.outMint, parsed.raw, slippageBps);
            if (res.ok) {
              jups[r.rowId] = res.quote;
              jupAmts[r.rowId] = parsed.raw;
            } else {
              errs[r.rowId] = res.code === 'refused' ? M.convert.errors.quoteRefused(name) : M.convert.errors.quoteUnreachable(name);
            }
          } else if (r.kind === 'crossrail') {
            quotes[r.rowId] = await fetchConvertQuote(relayUrl, r.route.from.ledger, r.route.hop.ledger, parsed.raw, {venue: venueOfId(r.route.swapVenueId) ?? undefined});
            amts[r.rowId] = parsed.raw;
          } else if (r.kind === 'hub') {
            hubs[r.rowId] = await fetchHubQuotes(relayUrl, r.route, parsed.raw, inFee, slippageBps);
            hubAmts[r.rowId] = parsed.raw;
          } else {
            quotes[r.rowId] = await fetchCeFiConvertQuote(relayUrl, r.venue, r.inLedgerOrMint, r.outLedger ?? r.outMint ?? '', parsed.raw, {inDecimals, outDecimals: r.outDecimals});
            amts[r.rowId] = parsed.raw;
          }
        } catch (e) {
          // The venue's OWN listed-but-unquoted verdict is a state, not a failure.
          if (e instanceof CeFiNoQuoteError) noQuoteRef.v = {rowId: r.rowId, venueName: e.venueName};
          else errs[r.rowId] = e instanceof Error ? e.message : String(e);
        }
      }));
      if (cancelled || !mountedRef.current) return;
      setRowQuotes(prev => ({...prev, ...quotes}));
      setRowQuoteErrs(errs);
      rowQuoteAmts.current = {...rowQuoteAmts.current, ...amts};
      setJupQuotes(prev => ({...prev, ...jups}));
      jupQuoteAmts.current = {...jupQuoteAmts.current, ...jupAmts};
      setHubBundles(prev => ({...prev, ...hubs}));
      hubBundleAmts.current = {...hubBundleAmts.current, ...hubAmts};
      setNoQuoteRow(noQuoteRef.v);
      setQuoteBusy(false);
    })();
    return () => {
      cancelled = true;
    };
    // slippageBps IS a dep: it re-keys the Solana venue's route + threshold (and both hub
    // floors). `venueList` re-keys when the relay's served registry lands. `targets`/`rows`
    // re-key on the resolved pair; `activeRow` re-keys on the pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountText, target, targets, venueList, record != null && isLiveRecord(record), slippageBps, activeRow?.rowId, inDecimals, inFee, relayUrl]);

  // ── Stale refresh (the 30 s clock, single-flight): every RENDERED live quote refreshes its
  //    own number in place; a moved ACTIVE quote is surfaced as the review line, never a silent
  //    swap. CeFi rows are EXEMPT (the partner agreement: no timed partner demand) — their
  //    confirm-time re-quote is the execution protection.
  useEffect(() => {
    if (target == null || isLiveRecord(record)) return;
    const id = setInterval(() => {
      if (!mountedRef.current || staleRefreshing) return;
      const candidates = rows.filter(r => r.kind === 'direct' || r.kind === 'solamm' || r.rowId === selRowId)
        .filter(r => r.kind !== 'cefi');
      const staleIc = candidates.filter((r): r is Extract<SwapRow, {kind: 'direct'} | {kind: 'crossrail'}> => {
        const q = rowQuotes[r.rowId];
        return (r.kind === 'direct' || r.kind === 'crossrail') && q != null && isQuoteStale(q);
      });
      const staleJup = candidates.filter((r): r is Extract<SwapRow, {kind: 'solamm'}> => {
        const q = jupQuotes[r.rowId];
        return r.kind === 'solamm' && q != null && isQuoteStale(q);
      });
      const staleHub = candidates.filter((r): r is Extract<SwapRow, {kind: 'hub'}> => {
        const b = hubBundles[r.rowId];
        return r.kind === 'hub' && b != null && (isQuoteStale(b.q1) || isQuoteStale(b.q2));
      });
      if (staleIc.length === 0 && staleJup.length === 0 && staleHub.length === 0) return;
      setStaleRefreshing(true);
      void (async () => {
        try {
          for (const r of staleIc) {
            const q = rowQuotes[r.rowId];
            if (q == null) continue;
            const fresh = r.kind === 'crossrail'
              ? await fetchConvertQuote(relayUrl, r.route.from.ledger, r.route.hop.ledger, q.amountIn, {venue: venueOfId(r.route.swapVenueId) ?? undefined})
              : await fetchConvertQuote(relayUrl, r.inLedger, r.outLedger, q.amountIn);
            if (!mountedRef.current) return;
            setRowQuotes(prev => ({...prev, [r.rowId]: fresh}));
            if (activeRow != null && r.rowId === activeRow.rowId && fresh.amountOutGross !== q.amountOutGross) {
              setQuoteChanged({oldAmt: q.amountOutGross, newAmt: fresh.amountOutGross});
            }
          }
          for (const r of staleJup) {
            const q = jupQuotes[r.rowId];
            if (q == null) continue;
            const res = await fetchJupiterQuote(relayUrl, r.venue, r.inMint, r.outMint, q.inAmount, slippageBps);
            if (!mountedRef.current) return;
            if (res.ok) {
              setJupQuotes(prev => ({...prev, [r.rowId]: res.quote}));
              if (activeRow != null && r.rowId === activeRow.rowId && res.quote.outAmount !== q.outAmount) {
                setQuoteChanged({oldAmt: q.outAmount, newAmt: res.quote.outAmount});
              }
            }
          }
          for (const r of staleHub) {
            const b = hubBundles[r.rowId];
            if (b == null) continue;
            const got = await fetchHubQuotes(relayUrl, r.route, b.q1.amountIn, inFee, slippageBps);
            if (!mountedRef.current) return;
            setHubBundles(prev => ({...prev, [r.rowId]: got}));
            if (activeRow != null && r.rowId === activeRow.rowId
              && (got.q1.amountOutGross !== b.q1.amountOutGross || got.q2.amountOutGross !== b.q2.amountOutGross)) {
              setQuoteChanged({oldAmt: b.m2.netOut, newAmt: got.m2.netOut});
            }
          }
        } catch {
          // Stale quotes stay on screen; the next tick tries again. Errors while merely
          // refreshing are not confirm errors — the confirm re-quotes and would refuse.
        } finally {
          if (mountedRef.current) setStaleRefreshing(false);
        }
      })();
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, rows, rowQuotes, jupQuotes, hubBundles, selRowId, activeRow?.rowId, staleRefreshing, slippageBps, record != null && isLiveRecord(record), inFee, relayUrl]);

  // ── Min-out derivation (the compiled core's arithmetic — never TS): from the ACTIVE IC quote
  //    (a direct pool's own quote, or a cross-rail route's swap-hop quote).
  const [math, setMath] = useState<ConvertMath | null>(null);
  useEffect(() => {
    if (activeIcQuote == null) {
      setMath(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // A route's "output fee" is the HOP ledger's own fee (the ckUSDC the burn side pays its
        // approve with) — the direct pair's output fee never enters a composed quote's math.
        const outFee = directRow != null ? directRow.outDesc.fee ?? '0' : crossRow != null ? crossRow.route.hop.fee : '0';
        const m = await deriveConvertMath(activeIcQuote, inFee, outFee, slippageBps);
        if (!cancelled && mountedRef.current) setMath(m);
      } catch (e) {
        // No honest number → the screen says so, never a silently blank checklist.
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('convert math derivation failed:', msg);
        if (!cancelled && mountedRef.current) {
          setMath(null);
          setQuoteErr(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIcQuote?.venueId, activeIcQuote?.fetchedAtMs, activeIcQuote?.amountOutGross, slippageBps, directRow?.rowId, crossRow?.rowId, inFee]);

  // ── The cross-rail route's live gas quote (2026-09-14 spec §5/§6): the minter's OWN eip-1559
  //    figure, shown as its own census line and preflighted BEFORE anything is signed. prepare
  //    re-queries at confirm; this copy is for review, never for signing.
  const [routeGas, setRouteGas] = useState<{feeWei: string; gasLedgerFee: string} | null>(null);
  const [routeGasErr, setRouteGasErr] = useState<string | null>(null);
  const [gasNonce, setGasNonce] = useState(0);
  useEffect(() => {
    if (crossRow == null || isLiveRecord(record)) {
      setRouteGas(null);
      setRouteGasErr(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const feeWei = await fetchGasFeeWei(identity.secretHex, crossRow.route.burn.minter, crossRow.route.hop.ledger);
        if (feeWei == null) throw new Error(M.convert.errors.gasUnavailable);
        const gasLedgerFee = await fetchLedgerFee(identity.secretHex, crossRow.route.burn.gasLedger);
        if (!cancelled && mountedRef.current) {
          setRouteGas({feeWei, gasLedgerFee});
          setRouteGasErr(null);
        }
      } catch (e) {
        if (!cancelled && mountedRef.current) {
          setRouteGas(null);
          setRouteGasErr(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossRow?.rowId, relayUrl, record != null && isLiveRecord(record), gasNonce]);

  // ── Circle's OWN published fee for the crossing — shown in the census as the venue's own
  //    number; prepare re-fetches live at confirm. Fail-closed: no fee → no confirm.
  const [crossFee, setCrossFee] = useState<{maxFee: string; floor: string} | null>(null);
  const [crossFeeErr, setCrossFeeErr] = useState<string | null>(null);
  useEffect(() => {
    if (crossRow == null || math == null || isLiveRecord(record)) {
      setCrossFee(null);
      setCrossFeeErr(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const fee = await fetchCctpBurnFee();
        const amount = BigInt(math.minOut);
        const maxFee = cctpMaxFee(amount, fee);
        if (!cancelled && mountedRef.current) {
          setCrossFee({maxFee: maxFee.toString(), floor: cctpMintFloor(amount, maxFee).toString()});
          setCrossFeeErr(null);
        }
      } catch {
        if (!cancelled && mountedRef.current) {
          setCrossFee(null);
          setCrossFeeErr(M.convert.errors.cctpFeeUnavailable);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossRow?.rowId, math?.minOut, record != null && isLiveRecord(record)]);

  // ── Route C's review-time destination estimate (founder clarity fix, 2026-09-22): what the
  //    USDC mint floor would land as at the destination, from the SAME quote machinery the
  //    final leg runs. EVENT-DRIVEN, fail-soft: absent until it fetches, never an error.
  const [destEstimate, setDestEstimate] = useState<string | null>(null);
  useEffect(() => {
    const sol = crossRow?.route.crossRail?.sol;
    if (sol == null || crossFee == null || isLiveRecord(record)) {
      setDestEstimate(null);
      return;
    }
    const venue = venueOfId(sol.venueId);
    if (venue == null) {
      setDestEstimate(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const q = await fetchJupiterQuote(relayUrl, venue, USDC_MINT_ADDRESS, sol.outMint, crossFee.floor, slippageBps);
        if (!cancelled && mountedRef.current) setDestEstimate(q.ok ? q.quote.outAmount : null);
      } catch {
        if (!cancelled && mountedRef.current) setDestEstimate(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossRow?.rowId, crossFee?.floor, relayUrl, record != null && isLiveRecord(record)]);

  // ── The CeFi handoff addresses: BOTH rails' derivations, one copy. The payout target
  //    (settle) is the user's OWN address ON THE DESTINATION RAIL; the refund address is the
  //    user's own address ON THE DEPOSIT RAIL (where the venue returns funds on a failed
  //    deposit or expiry — never a dpay-controlled address, and the relay refuses an order
  //    without one). The IC-side identifier is the wallet's 64-hex ACCOUNT IDENTIFIER — the
  //    form the venue's ICP payout layer can actually deliver to (SideShift engineering,
  //    confirmed in writing 2026-09-21) — derived async from the device key.
  const [cefiIcAccountId, setCefiIcAccountId] = useState<string | null>(null);
  useEffect(() => {
    if (!cefiMode) {
      setCefiIcAccountId(null);
      return;
    }
    let alive = true;
    DpayCore.icpPrincipalFromPubkey(identity.publicHex)
      .then(p => DpayCore.icpAccountIdFromPrincipal(p, ''))
      .then(id => {
        if (alive) setCefiIcAccountId(id);
      })
      .catch(() => {
        if (alive) setCefiIcAccountId(null);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cefiMode, cefiRow?.rowId, identity.publicHex]);
  // Memoized: the derivation is real crypto, not per-keystroke work.
  const cefiSolAddress = useMemo(
    () => (cefiMode ? deriveSolanaAddress(identity.secretHex) : null),
    [cefiMode, identity.secretHex],
  );
  // The payout target (settle) lives on the DESTINATION rail; the refund address on the
  // DEPOSIT rail (where the venue returns funds on a failed deposit or expiry).
  const cefiSettleAddress = cefiRow != null
    ? (cefiRow.outLedger != null ? cefiIcAccountId : cefiSolAddress)
    : null;
  const cefiRefundAddress = cefiRow != null
    ? (cefiRow.outLedger != null ? cefiSolAddress : cefiIcAccountId)
    : null;

  // ── The route's destination address (the CCTP crossing's signer side) — a required input,
  //    validated live, re-typed once before the gas-fund offer can ever render. The checksum
  //    and re-entry gates are verbatim from the multihop surface.
  const [destAddress, setDestAddress] = useState('');
  const [destRetype, setDestRetype] = useState('');
  const [destReentered, setDestReentered] = useState<string | null>(null);
  const [destEthWei, setDestEthWei] = useState<string | null | undefined>(undefined);
  const [ethRecheckNonce, setEthRecheckNonce] = useState(0);
  const [selfFundOpen, setSelfFundOpen] = useState(false);

  // ── Gas-fund derivations (2026-09-20) — every hook above sits before the early returns (the
  //    196 hooks rule); these consts are the hooks' dependency closure.
  const destShapeValid = isValidDestinationAddress('CkEthErc20', destAddress);
  const destChecksumBad = eip55ChecksumBad(destAddress);
  const destValid = destShapeValid && !destChecksumBad;
  const destConfirmed = destReentered != null && destReentered === destAddress.toLowerCase();
  const gasNeededN = routeGas != null ? BigInt(routeGas.feeWei) + BigInt(routeGas.gasLedgerFee) : null;
  const gasBalRaw = crossRow != null ? assetBalances[crossRow.route.burn.gasCurrency] : undefined;
  const gasShort = crossRow != null && gasNeededN != null && gasBalRaw != null && gasBalRaw.length > 0 && BigInt(gasBalRaw) < gasNeededN;
  const gasNeededStr = gasNeededN != null && crossRow != null
    ? fmtAssetCompact(gasNeededN.toString(), crossRow.route.burn.gasDecimals, crossRow.route.burn.gasSymbol)
    : null;
  // The measured HAVE for the gas-fund offer: the DESTINATION wallet's ETH (eth_getBalance,
  // publicnode). Unknown → the card hides (a need-vs-have offer without a have is not honest).
  const gasFundCardWanted = routeMode && gasShort && destConfirmed;
  const gasFundNeedStr = routeGas != null && crossRow != null
    ? fmtAssetCompact(gasFundNeededWei(routeGas.feeWei).toString(), crossRow.route.burn.gasDecimals, crossRow.route.burn.gasSymbol)
    : null;
  const gasFundHaveStr = destEthWei != null && crossRow != null
    ? fmtAssetCompact(destEthWei, crossRow.route.burn.gasDecimals, crossRow.route.burn.gasSymbol)
    : null;
  const gasFundShortStr = gasFundNeedStr != null && destEthWei != null && routeGas != null && crossRow != null
    ? (() => {
        const need = gasFundNeededWei(routeGas.feeWei);
        const have = BigInt(destEthWei);
        return have >= need ? null : fmtAssetCompact((need - have).toString(), crossRow.route.burn.gasDecimals, crossRow.route.burn.gasSymbol);
      })()
    : null;
  const gasFundCardShown = gasFundCardWanted && destEthWei != null && gasFundNeedStr != null && gasFundHaveStr != null;
  // [Fund from this wallet] is enabled iff a funding path exists — the engine's enumeration
  // over the registry (direct venue first, else hub) from the conversion's input ledger.
  const gasFundRouteOk = crossRow != null
    && gasFundRoutes(catalog, crossRow.route.from.ledger, crossRow.route.burn.gasLedger).length > 0;
  const gasFundFreshRef = useRef(false);
  useEffect(() => {
    if (gasFundCardWanted && !gasFundFreshRef.current) {
      gasFundFreshRef.current = true;
      setGasNonce(n => n + 1);
    } else if (!gasFundCardWanted) {
      gasFundFreshRef.current = false;
    }
  }, [gasFundCardWanted]);
  useEffect(() => {
    if (!gasFundCardWanted) {
      setDestEthWei(ethWei => (ethWei === undefined ? ethWei : undefined));
      return;
    }
    const addr = destAddress;
    setDestEthWei(undefined); // measuring
    let cancelled = false;
    void (async () => {
      const wei = await fetchEthBalance(addr);
      if (!cancelled && mountedRef.current && destAddress === addr) setDestEthWei(wei);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gasFundCardWanted, destAddress, ethRecheckNonce]);
  useEffect(() => {
    if (selfFundOpen && ethRecheckNonce > 0 && destEthWei != null && gasFundShortStr == null) setSelfFundOpen(false);
  }, [selfFundOpen, ethRecheckNonce, destEthWei, gasFundShortStr]);

  // ── The gates (fail closed BEFORE the confirm, never after it). A null balance (not yet
  //    read) fails OPEN — a balance nobody has measured is not a zero (the Pay tab's rule).
  const parsed = parseUserAmount(amountText, inDecimals);
  const amountRaw = parsed.ok ? parsed.raw : null;
  const amountN = amountRaw != null && /^\d+$/.test(amountRaw) ? BigInt(amountRaw) : 0n;
  const hubFeeN = hubRow != null ? BigInt(hubRow.route.hub.fee) : 0n;
  const neededN = parsed.ok && amountRaw !== '0' && !ammMode
    ? BigInt(parsed.raw) + (cefiMode ? 1n : 2n) * BigInt(inFee) + hubFeeN
    : null;
  // The Solana venue tx's network fee is paid in SOL on top of the swapped amount — when SOL is
  // the INPUT the honest available figure is the balance itself (a dust edge fails on-chain and
  // lands in the honest failure state, never a false pass).
  const insufficient = ammMode
    ? amountN > 0n && balanceN != null && amountN > balanceN
    : balanceN != null && neededN != null && neededN > balanceN;
  const feeOverheadN = !ammMode && parsed.ok ? (cefiMode ? 1n : 2n) * BigInt(inFee) + hubFeeN : null;
  const maxRaw = ammMode
    ? (balanceN != null && balanceN > 0n ? balanceN.toString() : null)
    : (balanceN != null && feeOverheadN != null && balanceN > feeOverheadN ? (balanceN - feeOverheadN).toString() : null);

  // The decision bundle each kind must have on the table before confirm arms.
  const hubReady = activeHub != null;
  const crossReady = math != null && destValid && routeGas != null && routeGasErr == null && !gasShort && crossFee != null;
  const cefiReady = activeCefiQuote != null && cefiSettleAddress != null && cefiRefundAddress != null;
  const ammReady = activeJup != null;
  const directReady = directRow != null && activeIcQuote != null && math != null;
  const pickedReady = directReady || hubReady || crossReady || cefiReady || ammReady;
  const canConfirm = activeRow != null && pickedReady && !quoteBusy && !confirmBusy && !insufficient && amountN > 0n;

  // ── THE CONFIRM — one gesture, dispatched on the picked row's kind. Every branch re-quotes
  //    fresh at the gesture (a moved market is reviewed, never silently submitted), then hands
  //    the prepared record to the ENGINE (adoptConvertRecord) — this screen keeps rendering
  //    FROM the engine's notifications.
  const onConfirm = async (gasFundArg?: {relayUrl: string; balances: Record<number, string>} | null) => {
    if (confirmBusyRef.current || activeRow == null || amountRaw == null || confirmBusy) return;
    confirmBusyRef.current = true;
    setConfirmBusy(true);
    setConfirmErr(null);
    setQuoteChanged(null);
    try {
      if (activeRow.kind === 'direct') {
        const q = rowQuotes[activeRow.rowId];
        if (q == null || math == null) return;
        // Re-quote at confirm (spec §5): a moved market must be reviewed, never silently submitted.
        const fresh = await fetchConvertQuote(relayUrl, activeRow.inLedger, activeRow.outLedger, q.amountIn, {venue: activeRow.venue});
        if (fresh.amountOutGross !== q.amountOutGross) {
          setRowQuotes(prev => ({...prev, [activeRow.rowId]: fresh}));
          setQuoteChanged({oldAmt: q.amountOutGross, newAmt: fresh.amountOutGross});
          return;
        }
        const rec = await prepareConvertRecord({
          secretHex: identity.secretHex,
          relayUrl,
          quote: fresh,
          math,
          inDesc: sourceDesc!,
          outDesc: activeRow.outDesc,
        });
        if (!mountedRef.current) return;
        recordIdRef.current = rec.id;
        setRecord(rec);
        await adoptConvertRecord(rec);
        return;
      }
      if (activeRow.kind === 'hub') {
        const b = hubBundles[activeRow.rowId];
        if (b == null) return;
        // Both hops re-quoted fresh at confirm (UX §6 red line 7): quote2 is sized on the FRESH
        // floor; a moved number is reviewed, never silently signed.
        const fresh = await fetchHubQuotes(relayUrl, activeRow.route, b.q1.amountIn, inFee, slippageBps);
        if (fresh.q1.amountOutGross !== b.q1.amountOutGross || fresh.q2.amountOutGross !== b.q2.amountOutGross) {
          if (mountedRef.current) {
            setHubBundles(prev => ({...prev, [activeRow.rowId]: fresh}));
            setQuoteChanged({oldAmt: b.m2.netOut, newAmt: fresh.m2.netOut});
          }
          return;
        }
        const rec = await prepareHubConvertRecord({
          secretHex: identity.secretHex,
          quote1: fresh.q1,
          quote2: fresh.q2,
          math1: fresh.m1,
          math2: fresh.m2,
          route: activeRow.route,
        });
        if (!mountedRef.current) return;
        recordIdRef.current = rec.id;
        setRecord(rec);
        await adoptConvertRecord(rec);
        return;
      }
      if (activeRow.kind === 'crossrail') {
        const q = rowQuotes[activeRow.rowId];
        if (q == null || math == null) return;
        if (!destValid) return;
        // Re-quote at confirm on the SWAP HOP (the reviewed number is the hop payout).
        const fresh = await fetchConvertQuote(relayUrl, activeRow.route.from.ledger, activeRow.route.hop.ledger, q.amountIn, {venue: venueOfId(activeRow.route.swapVenueId) ?? undefined});
        if (fresh.amountOutGross !== q.amountOutGross) {
          setRowQuotes(prev => ({...prev, [activeRow.rowId]: fresh}));
          setQuoteChanged({oldAmt: q.amountOutGross, newAmt: fresh.amountOutGross});
          return;
        }
        const rec = await prepareMultihopConvertRecord({
          secretHex: identity.secretHex,
          quote: fresh,
          math,
          route: activeRow.route,
          destAddress,
          ...(gasFundArg != null ? {gasFund: gasFundArg} : {}),
        });
        if (!mountedRef.current) return;
        recordIdRef.current = rec.id;
        setRecord(rec);
        await adoptConvertRecord(rec);
        return;
      }
      if (activeRow.kind === 'cefi') {
        if (activeCefiQuote == null || cefiSettleAddress == null || cefiRefundAddress == null) return;
        // The re-quote exists ONLY to mint a FRESH QUOTE ID (SideShift pins quoteId↔rate);
        // there is deliberately NO exact-match gate against the reviewed quote — a ticking
        // venue rate can never be matched exactly and the gate would livelock. The ORDER is
        // the lock and the consent point: its depositAmount is the reviewed deposit, its
        // settle figure is the venue's own locked number.
        const cefiRecordId = randNonceHex();
        let freshRes: CeFiQuoteResult;
        try {
          // The 20s confirm budget, NOT the 8s review default: an abort below the relay's own
          // 15s upstream bound means the phone gives up while the venue is still answering —
          // the order 201s venue-side and the handoff never begins (the live attempt-#3
          // signature, 2026-09-21).
          freshRes = await fetchCeFiQuoteResult(
            relayUrl, activeRow.venue, activeRow.inLedgerOrMint, activeRow.outLedger ?? activeRow.outMint ?? '',
            rawToDecimal(amountRaw, inDecimals), CONVERT_CEFI_CONFIRM_TIMEOUT_MS,
          );
        } catch (e) {
          throw ceFiServiceError(e, venueDisplayName(activeRow.venue.venue_id));
        }
        const fresh = ceFiQuoteFromResult(
          activeRow.venue, activeRow.inLedgerOrMint, activeRow.outLedger ?? activeRow.outMint ?? '',
          amountRaw, freshRes, activeRow.outDecimals,
        );
        let order;
        try {
          order = await createCeFiOrder(relayUrl, activeRow.venue, freshRes, {
            settleAddress: cefiSettleAddress,
            refundAddress: cefiRefundAddress,
            depositLedger: activeRow.inLedgerOrMint,
            settleLedger: activeRow.outLedger ?? activeRow.outMint ?? '',
            depositAmountDecimal: rawToDecimal(amountRaw, inDecimals),
            // The partner agreement's correlation field: the record id is minted NOW, before
            // the order exists, so the local record and the relay's logged clientOrderId are
            // the SAME id.
            clientOrderId: cefiRecordId,
          }, CONVERT_CEFI_CONFIRM_TIMEOUT_MS);
        } catch (e) {
          throw ceFiServiceError(e, venueDisplayName(activeRow.venue.venue_id));
        }
        const rec = prepareCeFiConvertRecord({
          id: cefiRecordId,
          quote: fresh,
          order,
          relayUrl,
          settleAddress: cefiSettleAddress,
          inCurrency: sourceDesc != null ? sourceDesc.currency : null,
          inSymbol: inSym,
          outSymbol: activeRow.outSym,
          inDecimals,
          outDecimals: activeRow.outDecimals,
        });
        if (!mountedRef.current) return;
        recordIdRef.current = rec.id;
        setRecord(rec);
        await adoptConvertRecord(rec);
        return;
      }
      // activeRow.kind === 'solamm' — the Solana venue (Jupiter): re-quote, review a moved
      // output, then the venue-built transaction is beneficiary-checked and device-signed by
      // the engine's prepare.
      if (ammRow == null) return;
      const q = jupQuotes[ammRow.rowId];
      if (q == null) return;
      const fresh = await fetchJupiterQuote(relayUrl, ammRow.venue, ammRow.inMint, ammRow.outMint, amountRaw, slippageBps);
      if (!fresh.ok) {
        setConfirmErr(M.convert.errors.quoteUnreachable(venueDisplayName(ammRow.venue.venue_id)));
        return;
      }
      if (fresh.quote.outAmount !== q.outAmount) {
        setJupQuotes(prev => ({...prev, [ammRow.rowId]: fresh.quote}));
        setQuoteChanged({oldAmt: q.outAmount, newAmt: fresh.quote.outAmount});
        return;
      }
      const rec = await prepareSolanaConvertRecord({
        secretHex: identity.secretHex,
        relayUrl,
        quote: fresh.quote,
        inAsset: {symbol: inSym, mint: ammRow.inMint, decimals: inDecimals},
        outAsset: {symbol: ammRow.outSym, mint: ammRow.outMint, decimals: ammRow.outDecimals},
      });
      if (!mountedRef.current) return;
      recordIdRef.current = rec.id;
      setRecord(rec);
      await adoptConvertRecord(rec);
    } catch (e) {
      if (mountedRef.current) setConfirmErr(e instanceof Error ? e.message : String(e));
    } finally {
      confirmBusyRef.current = false;
      if (mountedRef.current) setConfirmBusy(false);
    }
  };

  // ── Early returns (AFTER every hook — the 196 rule). ─────────────────────────────────────────
  if (selectedAsset == null || targets.length === 0) {
    return <UnavailablePanel selectedAsset={selectedAsset} onBack={onBack} />;
  }
  if (record != null && (isLiveRecord(record) || TERMINAL_CONVERT_STEPS.has(record.step))) {
    // A provider-shaped record (the CeFi family) renders through the GENERIC StatePanel — its
    // awaiting_deposit handoff, provider_processing and refunded states are rail-agnostic. A
    // CROSS-RAIL record carries the IC leg list PLUS the crossing phases; a plain Solana record
    // renders its own machine; a leg-planned record renders the per-leg tracker.
    if (record.providerRef != null) return <StatePanel record={record} onBack={onBack} />;
    if (record.crossRail != null) {
      return <CrossRailStatePanel record={record} secretHex={identity.secretHex} relayUrl={relayUrl} solLamports={solana?.sol ?? null} onBack={onBack} />;
    }
    if (record.solanaLeg != null) return <SolStatePanel record={record} onBack={onBack} />;
    return record.legPlan != null
      ? <RouteStatePanel record={record} onBack={onBack} />
      : <StatePanel record={record} onBack={onBack} />;
  }

  // The zero-balance gate: the Pay tab's fund-gate shape, pointed at the ONE surface that can
  // fund this asset (Receive ▸ My address — reachable from the bottom nav on this very screen).
  if (balanceN === 0n) {
    // The funded-account pointer, generalized to the pair walk: the first TARGET rail (in
    // resolution order) this wallet provably holds value on. A balance that has not been read
    // (null) is not a zero and is not offered — the same fail-open rule the gate uses.
    let otherHeld: {held: string; toSym: string; assetId: AssetId} | null = null;
    for (const t of targets) {
      for (const r of t.rows) {
        if (r.kind !== 'direct' && r.kind !== 'solamm') continue;
        const raw = r.kind === 'direct'
          ? assetBalances[r.outDesc.currency]
          : (r.outMint === WRAPPED_SOL_MINT_ADDRESS ? solana?.sol ?? null : solana?.tokens[r.outMint] ?? null);
        if (raw != null && /^\d+$/.test(raw) && BigInt(raw) > 0n) {
          otherHeld = {
            held: r.kind === 'direct'
              ? fmtAssetCompact(raw, r.outDesc.decimals ?? 8, r.outDesc.backing_symbol ?? r.outDesc.symbol ?? '')
              : fmtAssetCompact(raw, r.outDecimals, r.outSym),
            toSym: inSym,
            assetId: r.kind === 'direct' ? `ic:${r.outDesc.currency}` as AssetId : `solana:${r.outSym}` as AssetId,
          };
          break;
        }
      }
      if (otherHeld != null) break;
    }
    return (
      <View testID="convert-screen" style={S.convertWrap}>
        <ConvertHeader title={M.convert.actionConvert} onBack={onBack} />
        <InstructionPanel
          testID="convert-fund"
          title={M.pay.fundTitle(inSym)}
          body={M.convert.fundBody(inSym, M.wallet.tab.receive, M.receive.myAddress)}
          primaryLabel={M.pay.showMyAddress(inSym)}
          onPrimary={onShowDepositAddress}
        />
        {otherHeld != null ? (
          <View testID="convert-fund-other">
            <Text testID="convert-fund-other-holds" style={S.convertMetaLine}>
              {M.convert.fundOtherHolds(otherHeld.held, otherHeld.toSym)}
            </Text>
            {onSwitchAsset ? (
              <Pressable
                testID="btn-convert-fund-other"
                style={S.linkBtn}
                onPress={() => onSwitchAsset(otherHeld!.assetId)}
                accessibilityRole="button"
                accessibilityLabel={M.convert.fundOtherSwitch(otherHeld.held)}
                accessibilityState={{disabled: false}}
              >
                <Text style={S.linkText}>{M.convert.fundOtherSwitch(otherHeld.held)}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }

  // ── The form's derived display figures ──────────────────────────────────────────────────────
  // The narrowed cross-rail block (a crossrail row is created with crossRail non-null; the
  // binding just carries that fact into JSX).
  const crossInfo = crossRow != null ? crossRow.route.crossRail ?? null : null;
  const dispInName = sourceCurrency != null ? currencyName(sourceCurrency) : inSym;
  const sourceBalanceLine = sourceCurrency != null
    ? currencyBalances[sourceCurrency]?.displayText ?? '—'
    : (balanceRaw != null ? fmtAssetCompact(balanceRaw, inDecimals, inSym) : null);
  const targetBalanceLine = targetCode != null ? currencyBalances[targetCode]?.displayText ?? '—' : null;
  // "Amount get, calculated" — the ACTIVE row's own number, in the venue's own out unit:
  const receiveStr: string | null =
    directRow != null && math != null ? fmtAssetCompact(math.netOut, outDecimals, outSym)
    : crossRow != null && math != null ? fmtAssetCompact(math.netOut, crossRow.route.hop.decimals, crossRow.route.hop.symbol)
    : hubRow != null && activeHub != null ? fmtAssetCompact(activeHub.m2.netOut, outDecimals, outSym)
    : cefiRow != null && activeCefiQuote != null ? fmtAssetCompact(activeCefiQuote.amountOutGross, outDecimals, outSym)
    : ammRow != null && activeJup != null ? fmtAssetCompact(activeJup.outAmount, outDecimals, outSym)
    : null;
  // Attribution: the quote's own venue takes over once one arrives; before that the PICKED
  // row's venue is the honest attribution (never a neighbouring row's identity).
  const counterVenueId: string | null =
    activeIcQuote?.venueId
    ?? (directRow != null ? directRow.venue.venue_id : null)
    ?? (crossRow != null ? crossRow.route.swapVenueId : null)
    ?? (cefiRow != null ? cefiRow.venue.venue_id : null)
    ?? (ammRow != null ? ammRow.venue.venue_id : null);
  // The target choices actually offered: reachable currencies plus the source itself (rendered
  // DISABLED — the same-currency target is the one pick the surface refuses).
  const targetChoices = visibleCurrencies.filter(code => code === sourceCurrency || targets.some(t => t.currency === code));
  // Every rendered live quote still loading (the venue area's per-row spinner).
  const slippageHidden = cefiMode; // a fixed shift is a LOCKED rate — there is no floor to set

  return (
    <View testID="convert-screen" style={S.convertWrap}>
      <ConvertHeader
        title={targetCode != null ? M.convert.heading(sourceCurrency ?? inSym, targetCode) : M.convert.actionConvert}
        onBack={onBack}
      />

      {/* ── The SELL leg ──────────────────────────────────────────────────────────────────────── */}
      <View testID="convert-source-leg">
        <View style={S.swapLegRow}>
          <Text style={S.swapLegName}>{dispInName}</Text>
          <TextInput
            testID="convert-amount"
            style={S.swapLegInput}
            value={amountText}
            onChangeText={setAmountText}
            keyboardType="decimal-pad"
            autoCorrect={false}
            autoCapitalize="none"
            placeholder="0"
            placeholderTextColor={C.sub}
          />
        </View>
        <View style={S.convertBalanceRow}>
          {sourceBalanceLine != null ? (
            <Text testID="convert-balance" style={S.convertMetaLine}>
              {M.convert.balanceLine(sourceBalanceLine)}
            </Text>
          ) : <View />}
          {maxRaw != null ? (
            <Pressable
              testID="btn-convert-max"
              onPress={() => {
                setAmountText(rawToDecimal(maxRaw, inDecimals));
                setQuoteChanged(null);
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={M.convert.maxAmount}>
              <Text style={S.linkText}>{M.convert.maxAmount}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={S.swapDivider} testID="convert-divider" />

      {/* ── The RECEIVE leg ───────────────────────────────────────────────────────────────────── */}
      <View testID="convert-target-leg">
        <View style={S.swapLegRow}>
          {targetChoices.length > 1 ? (
            <Pressable
              testID="btn-convert-target"
              style={{flexDirection: 'row', alignItems: 'center', gap: 4}}
              onPress={() => { if (!confirmBusy) setTargetListOpen(true); }}
              accessibilityRole="button"
              accessibilityLabel={M.convert.swapTargetPick}
              accessibilityState={{expanded: targetListOpen}}>
              <Text style={S.swapLegName}>{targetCode != null ? currencyName(targetCode) : '—'}</Text>
              <IconChevronDown size={16} color={C.sub} />
            </Pressable>
          ) : (
            <Text style={S.swapLegName}>{targetCode != null ? currencyName(targetCode) : '—'}</Text>
          )}
          <Text testID="convert-receive" style={S.swapLegAmount} numberOfLines={1}>
            {receiveStr ?? (quoteBusy ? '…' : '—')}
          </Text>
        </View>
        {targetBalanceLine != null ? (
          <Text testID="convert-target-balance" style={S.swapLegSub}>
            {M.convert.balanceLine(targetBalanceLine)}
          </Text>
        ) : null}
        {targetListOpen && targetChoices.length > 1 ? (
          <View testID="convert-target-list">
            <Text style={S.convertDestLabel}>{M.convert.swapTargetListLabel}</Text>
            {targetChoices.map(code => {
              const reachable = targets.some(t => t.currency === code);
              const same = code === sourceCurrency;
              const on = code === targetCode;
              return (
                <Pressable
                  key={code}
                  testID={`convert-target-${code}`}
                  style={[S.convertVenueRow, on && S.convertVenueRowOn]}
                  disabled={same || !reachable || confirmBusy}
                  onPress={() => {
                    if (confirmBusy) return;
                    setTargetSel(code);
                    setSelRowId(null);
                    setTargetListOpen(false);
                    setQuoteChanged(null);
                    setConfirmErr(null);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{checked: on, disabled: same || !reachable}}
                  accessibilityLabel={currencyName(code)}>
                  <View style={[S.convertVenueRadio, on && S.convertVenueRadioOn]}>
                    {on ? <View style={S.convertVenueRadioDot} /> : null}
                  </View>
                  <View style={S.convertVenueRowText}>
                    <Text style={[S.convertVenueName, on && S.convertVenueNameOn]}>{currencyName(code)}</Text>
                    {same ? (
                      <Text style={S.convertMetaLine}>{M.convert.swapTargetSame}</Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>

      {/* ── The VENUE AREA (fork #3): rows in registry order — venue rows NONE-preselected when
          several venues serve the pair; composed routes render as explicit opt-ins beneath the
          standing pick (D2). Live rows (direct pools + Solana venues) carry their own quote,
          attributed per row; a hub/crossrail/cefi row carries its label until picked (D5 — and
          no partner demand before a pick). With one row on the pair this area is ABSENT — the
          single-venue screen is an attributed line, and the headline card below is that line. */}
      {(() => {
        // A LONE row with a settlement-SLA demotion still renders the area: the honest slow
        // line is row content, not chooser chrome (the attributed line stays the headline).
        const singleHonesty = rows.length === 1 && rows[0].kind !== 'hub' && rows[0].kind !== 'crossrail'
          && rows[0].venue.health?.status === 'degraded';
        return rows.length > 1 || singleHonesty;
      })() ? (
        <View testID="convert-venues">
          <Text style={S.convertSlippageLabel}>{M.convert.venueChooserLabel}</Text>
          {rows.map(r => {
            const on = activeRow != null && activeRow.rowId === r.rowId;
            const icq = r.kind === 'direct' || r.kind === 'crossrail' ? rowQuotes[r.rowId] ?? null : null;
            const jq = r.kind === 'solamm' ? jupQuotes[r.rowId] ?? null : null;
            const rq = r.kind === 'cefi' ? rowQuotes[r.rowId] ?? null : null;
            const err = rowQuoteErrs[r.rowId] ?? null;
            const rOutSym = r.kind === 'direct' ? r.outDesc.backing_symbol ?? r.outDesc.symbol ?? ''
              : r.kind === 'hub' ? r.route.dest.symbol
              : r.kind === 'crossrail' ? (r.route.crossRail?.sol != null ? r.route.crossRail.sol.outSymbol : r.route.dest.symbol)
              : r.kind === 'cefi' ? r.outSym : r.outSym;
            const rOutDec = r.kind === 'direct' ? r.outDesc.decimals ?? 8
              : r.kind === 'hub' ? r.route.dest.decimals
              : r.kind === 'crossrail' ? (r.route.crossRail?.sol != null ? r.route.crossRail.sol.outDecimals : r.route.hop.decimals)
              : r.kind === 'cefi' ? r.outDecimals : r.outDecimals;
            const label =
              r.kind === 'direct' ? r.venue.display_name
              : r.kind === 'hub' ? M.convert.multihop.mechViaHub(r.route.hub.symbol)
              : r.kind === 'crossrail' ? M.convert.multihop.mechViaCctp
              : M.convert.multihop.mechViaVenue(r.venue.display_name);
            return (
              <Pressable
                key={r.rowId}
                testID={`convert-venue-${r.rowId}`}
                style={[S.convertVenueRow, on && S.convertVenueRowOn]}
                onPress={() => {
                  if (confirmBusy) return;
                  setSelRowId(r.rowId);
                  setQuoteChanged(null);
                  setConfirmErr(null);
                }}
                accessibilityRole="radio"
                accessibilityState={{checked: on}}
                accessibilityLabel={label}>
                <View style={[S.convertVenueRadio, on && S.convertVenueRadioOn]}>
                  {on ? <View style={S.convertVenueRadioDot} /> : null}
                </View>
                <View style={S.convertVenueRowText}>
                  <Text style={[S.convertVenueName, on && S.convertVenueNameOn]}>{label}</Text>
                  {(r.kind === 'cefi' || r.kind === 'direct' || r.kind === 'solamm') && r.venue.health?.status === 'degraded' ? (
                    <Text testID={`convert-venue-${r.rowId}-slow`} style={S.convertMetaLine}>
                      {M.convert.venueSlow}
                    </Text>
                  ) : null}
                  {icq != null ? (
                    <Text testID={`convert-venue-${r.rowId}-quote`} style={S.convertVenueAmount}>
                      {fmtAssetCompact(icq.amountOutGross, rOutDec, rOutSym)}
                    </Text>
                  ) : jq != null ? (
                    <Text testID={`convert-venue-${r.rowId}-quote`} style={S.convertVenueAmount}>
                      {fmtAssetCompact(jq.outAmount, rOutDec, rOutSym)}
                    </Text>
                  ) : rq != null ? (
                    <Text testID={`convert-venue-${r.rowId}-quote`} style={S.convertVenueAmount}>
                      {fmtAssetCompact(rq.amountOutGross, rOutDec, rOutSym)}
                    </Text>
                  ) : err != null ? (
                    <Text testID={`convert-venue-${r.rowId}-err`} style={S.err}>{err}</Text>
                  ) : r.kind === 'hub' ? (
                    <Text style={S.convertMetaLine}>{M.convert.multihop.hubShape()}</Text>
                  ) : (/* crossrail: the label IS the mechanism line — no meta echo */
                    <View style={S.convertBtnBusyRow}>
                      <ActivityIndicator color={C.sub} />
                    </View>
                  )}
                </View>
              </Pressable>
            );
          })}
          {/* The chooser's own Details control + per-row fetch timestamps (attribution lines),
              default CLOSED — distinct from the checklist's `convert-details`. */}
          <DetailsToggle
            testID="convert-venue-details"
            open={detailsOpen}
            onToggle={() => setDetailsOpen(o => !o)}
            label={M.convert.detailsLabel}
          />
          {detailsOpen ? rows.map(r => {
            if (r.kind === 'hub' || r.kind === 'crossrail') return null;
            const q = r.kind === 'solamm' ? jupQuotes[r.rowId] ?? null : rowQuotes[r.rowId] ?? null;
            if (q == null) return null;
            return (
              <Text key={`src-${r.rowId}`} testID={`convert-venue-${r.rowId}-source`} style={S.convertMetaLine}>
                {M.convert.quoteSource(nonBreakingClock(new Date(q.fetchedAtMs)), venueDisplayName(r.venue.venue_id))}
              </Text>
            );
          }) : null}
          {multiVenue && activeRow == null ? (
            <Text testID="convert-venue-none" style={S.convertMetaLine}>
              {M.convert.venueNoneSelected}
            </Text>
          ) : null}
        </View>
      ) : null}

      {insufficient ? (
        <Text testID="convert-insufficient" style={S.err}>
          {ammMode
            ? M.convert.insufficientLine(fmtAssetCompact(amountN.toString(), inDecimals, inSym), fmtAssetCompact(balanceRaw ?? '0', inDecimals, inSym))
            : cefiMode
              ? M.convert.cefi.insufficientLine(fmtAssetCompact(neededN!.toString(), inDecimals, inSym), fmtAssetCompact(balanceRaw ?? '0', inDecimals, inSym))
              : hubRow != null
                ? M.convert.multihop.insufficientHubLine(fmtAssetCompact(neededN!.toString(), inDecimals, inSym), fmtAssetCompact(balanceRaw ?? '0', inDecimals, inSym))
                : M.convert.insufficientLine(fmtAssetCompact(neededN!.toString(), inDecimals, inSym), fmtAssetCompact(balanceRaw ?? '0', inDecimals, inSym))}
        </Text>
      ) : null}

      {/* ── The decision, as one number + whose it is (the single-venue ATTRIBUTED LINE; under a
          multi-row pick it appears once the user has chosen). ────────────────────────────────── */}
      {receiveStr != null ? (
        <View testID="convert-headline" style={S.convertHeadlineCard}>
          <Text style={S.convertHeadlineLabel}>
            {routeMode ? M.convert.multihop.swapPaysLabel : M.convert.receiveHeadline}
          </Text>
          <Text style={S.convertHeadlineAmount}>{receiveStr}</Text>
          {hubMode && activeHub != null ? (
            <Text testID="convert-quote-source" style={S.convertHeadlineMeta}>
              {M.convert.multihop.hubQuoteSource(
                venueDisplayName(activeHub.q1.venueId),
                venueDisplayName(activeHub.q2.venueId),
                nonBreakingClock(new Date(Math.max(activeHub.q1.fetchedAtMs, activeHub.q2.fetchedAtMs))),
              )}
            </Text>
          ) : activeIcQuote != null && counterVenueId != null ? (
            <Text testID="convert-quote-source" style={S.convertHeadlineMeta}>
              {M.convert.quoteSource(nonBreakingClock(new Date(activeIcQuote.fetchedAtMs)), venueDisplayName(counterVenueId))}
            </Text>
          ) : activeCefiQuote != null && counterVenueId != null ? (
            <Text testID="convert-quote-source" style={S.convertHeadlineMeta}>
              {M.convert.quoteSource(nonBreakingClock(new Date(activeCefiQuote.fetchedAtMs)), venueDisplayName(counterVenueId))}
            </Text>
          ) : activeJup != null && counterVenueId != null ? (
            <Text testID="convert-quote-source" style={S.convertHeadlineMeta}>
              {M.convert.quoteSource(nonBreakingClock(new Date(activeJup.fetchedAtMs)), venueDisplayName(counterVenueId))}
            </Text>
          ) : null}
          {hubRow != null ? (
            <Text testID="convert-route-via" style={S.convertMetaLine}>
              {M.convert.multihop.viaHub(hubRow.route.hub.symbol)}
            </Text>
          ) : null}
          {staleRefreshing ? (
            <Text testID="convert-stale" style={S.convertHeadlineMeta}>
              {M.convert.staleRefreshing}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* ── The pre-sign transparency checklist (what does NOT change): the decision card carries
          the slippage axis + the minimum + the quote-change warning; the venue/fee/signing
          census folds behind the ONE Details control, default CLOSED. ────────────────────────── */}
      {activeRow != null ? (
        <View style={S.convertChecklistCard}>
          {!slippageHidden ? (
            <View testID="convert-slippage">
              <Text style={S.convertSlippageLabel}>{M.convert.slippageLabel}</Text>
              <View
                testID="convert-slippage-chips"
                style={S.convertSlippageRow}
                accessibilityRole="radiogroup"
                accessibilityLabel={M.convert.slippageLabel}>
                {CONVERT_SLIPPAGE_BPS_OPTIONS.map((bps) => (
                  <Pressable
                    key={bps}
                    testID={`convert-bps-${bps}`}
                    style={[S.convertSlippageChip, slippageBps === bps && S.convertSlippageChipOn]}
                    onPress={() => setSlippageBps(bps)}
                    accessibilityRole="radio"
                    accessibilityState={{selected: slippageBps === bps}}
                    accessibilityLabel={formatBps(bps)}>
                    <Text style={[S.convertSlippageChipText, slippageBps === bps && S.convertSlippageChipTextOn]}>{formatBps(bps)}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
          {/* The minimum line, per kind. */}
          {hubRow != null && activeHub != null ? (
            <View testID="convert-route-min">
              <Text style={S.convertMinOutLine}>
                {M.convert.multihop.routeMinWalletLine(
                  fmtAssetCompact(activeHub.m2.minOut, outDecimals, outSym),
                  formatBps(slippageBps),
                )}
              </Text>
            </View>
          ) : math != null && routeMode && crossRow != null ? (
            <View testID="convert-route-min">
              <Text style={S.convertMinOutLine}>
                {M.convert.multihop.routeMinLine(
                  fmtAssetCompact(math.minOut, crossRow.route.hop.decimals, crossRow.route.hop.symbol),
                  formatBps(slippageBps),
                )}
              </Text>
              {routeGasErr != null ? (
                <Text testID="convert-gas-note" style={S.err}>{routeGasErr}</Text>
              ) : null}
              {crossFeeErr != null ? (
                <View testID="convert-crossrail-fees">
                  <Text testID="crossrail-circle-fee" style={S.err}>{crossFeeErr}</Text>
                </View>
              ) : null}
            </View>
          ) : math != null && !cefiMode ? (
            <Text testID="convert-min-out" style={S.convertMinOutLine}>
              {M.convert.minReceiveLine(fmtAssetCompact(math.minOut, outDecimals, outSym), formatBps(slippageBps))}
            </Text>
          ) : ammMode && activeJup != null ? (
            <Text testID="convert-min-out" style={S.convertMinOutLine}>
              {M.convert.minReceiveLine(fmtAssetCompact(activeJup.otherAmountThreshold, outDecimals, outSym), formatBps(slippageBps))}
            </Text>
          ) : null}
          {quoteChanged != null ? (
            <Text testID="convert-quote-changed" style={S.convertChecklistWarn}>
              {M.convert.quoteChanged(
                fmtAssetCompact(quoteChanged.oldAmt, outDecimals, outSym),
                fmtAssetCompact(quoteChanged.newAmt, outDecimals, outSym),
              )}
            </Text>
          ) : null}
          {/* The route's destination address — required by the CCTP crossing (the user's OWN EVM
              wallet signs the burn from there; dpay never holds EVM keys), validated live,
              re-typed once before the gas-fund offer can render. */}
          {routeMode ? (
            <View>
              <Text style={S.convertAmountLabel}>{M.convert.multihop.destAddressLabel}</Text>
              <View style={S.amountRow}>
                <TextInput
                  testID="convert-dest-address"
                  style={S.monoInput}
                  value={destAddress}
                  onChangeText={t => {
                    setDestAddress(t);
                    setDestRetype('');
                    setDestReentered(null);
                  }}
                  autoCorrect={false}
                  autoCapitalize="none"
                  placeholderTextColor={C.sub}
                />
              </View>
              {destAddress.length > 0 && !destShapeValid ? (
                <Text testID="convert-dest-address-invalid" style={S.err}>{M.convert.multihop.destAddressInvalid}</Text>
              ) : destChecksumBad ? (
                <Text testID="convert-dest-checksum" style={S.err}>{M.convert.crossrail.checksumMismatch}</Text>
              ) : null}
              {destShapeValid && !destChecksumBad && !destConfirmed ? (
                <View>
                  <Text style={S.convertAmountLabel}>{M.convert.crossrail.retypeAddress}</Text>
                  <View style={S.amountRow}>
                    <TextInput
                      testID="convert-dest-reenter"
                      style={S.monoInput}
                      value={destRetype}
                      onChangeText={t => {
                        setDestRetype(t);
                        if (t.toLowerCase() === destAddress.toLowerCase()) setDestReentered(t.toLowerCase());
                      }}
                      autoCorrect={false}
                      autoCapitalize="none"
                      placeholderTextColor={C.sub}
                    />
                  </View>
                  {destRetype.length >= destAddress.length && destAddress.length > 0 && !destConfirmed ? (
                    <Text testID="convert-dest-reenter-mismatch" style={S.err}>{M.convert.crossrail.retypeMismatch}</Text>
                  ) : null}
                </View>
              ) : null}
              <Text testID="convert-dest-cross-note" style={S.convertMetaLine}>{M.convert.crossrail.destAddressCrossNote}</Text>
            </View>
          ) : null}
          {/* The CeFi payout target: not an input — the user's OWN derived address, shown
              read-only before the order is created. */}
          {cefiMode && cefiSettleAddress != null ? (
            <View>
              <Text style={S.convertAmountLabel}>{M.convert.cefi.settleAddressLabel}</Text>
              <Text testID="convert-settle-address" style={S.convertMetaLine} selectable>{cefiSettleAddress}</Text>
            </View>
          ) : null}
          <DetailsToggle
            open={detailsOpen}
            onToggle={() => setDetailsOpen(o => !o)}
            label={M.convert.detailsLabel}
          />
          {detailsOpen ? (
            <View testID="convert-details-block">
              {/* Rate — derived (amount_out ÷ amount_in), never presented as venue-published. */}
              {math != null && activeIcQuote != null ? (
                <View testID="convert-rate" style={S.convertRateRow}>
                  <Text style={S.convertRateLabel}>{M.convert.rateLabel(inSym, routeMode && crossRow != null ? crossRow.route.hop.symbol : outSym)}</Text>
                  <Text style={S.convertRateValue}>{fmtAssetCompact(scaledRate(activeIcQuote.amountOutGross, activeIcQuote.amountIn, inDecimals), routeMode && crossRow != null ? crossRow.route.hop.decimals : outDecimals, routeMode && crossRow != null ? crossRow.route.hop.symbol : outSym)}</Text>
                </View>
              ) : null}
              {cefiMode && activeCefiQuote != null && cefiRow != null ? (
                <View testID="convert-rate" style={S.convertRateRow}>
                  <Text style={S.convertRateLabel}>{M.convert.rateLabel(inSym, cefiRow.outSym)}</Text>
                  <Text style={S.convertRateValue}>{fmtAssetCompact(scaledRate(activeCefiQuote.amountOutGross, activeCefiQuote.amountIn, inDecimals), cefiRow.outDecimals, cefiRow.outSym)}</Text>
                </View>
              ) : null}
              {ammMode && activeJup != null && ammRow != null ? (
                <View testID="convert-rate" style={S.convertRateRow}>
                  <Text style={S.convertRateLabel}>{M.convert.rateLabel(inSym, ammRow.outSym)}</Text>
                  <Text style={S.convertRateValue}>{fmtAssetCompact(scaledRate(activeJup.outAmount, activeJup.inAmount, inDecimals), ammRow.outDecimals, ammRow.outSym)}</Text>
                </View>
              ) : null}
              {/* Counterparty census — per kind, one copy each. */}
              {!hubMode ? (
                <View testID="convert-counterparty">
                  <Text style={S.convertChecklistLine}>
                    {cefiMode && cefiRow != null
                      ? M.convert.cefi.counterparty(venueDisplayName(cefiRow.venue.venue_id))
                      : ammMode && ammRow != null
                        ? M.convert.sol.counterparty(venueDisplayName(ammRow.venue.venue_id))
                        : counterVenueId != null ? M.convert.counterparty(venueDisplayName(counterVenueId))
                        : ''}
                  </Text>
                  {/* The pool/endpoint principal renders only when THIS venue's own number stands
                      behind it; a CeFi venue renders none (its https API base is where the relay
                      carries the partner key — not a depositor-checkable fact). */}
                  {/* The principal renders only when THIS venue's own number stands behind it:
                      the quote's pool echo once one arrives, or the standing single-venue
                      disclosure. Under a multi-venue pick whose quote has not settled NO
                      principal renders — an execution fact is never asserted without its
                      quote, and another venue's principal is never borrowed. */}
                  {!cefiMode && (activeIcQuote?.pool != null || (counterVenueId != null && !multiVenue)) && (directRow != null || (activeIcQuote != null && routeMode)) ? (
                    <Text testID="convert-pool-principal" style={S.convertPrincipal}>{activeIcQuote?.pool ?? (counterVenueId != null ? venueOfId(counterVenueId)?.endpoint ?? '' : '')}</Text>
                  ) : null}
                  {!cefiMode && ammRow != null ? (
                    <Text testID="convert-pool-principal" style={S.convertPrincipal}>{ammRow.venue.endpoint}</Text>
                  ) : null}
                  <Text style={S.convertChecklistLine}>
                    {cefiMode
                      ? M.convert.cefi.checklistSigns
                      : ammMode ? M.convert.sol.counterpartySigns
                      : M.convert.counterpartySigns}
                  </Text>
                  {routeMode && crossRow != null ? (
                    <Text testID="convert-minter-principal" style={S.convertPrincipal}>{crossRow.route.burn.minter}</Text>
                  ) : null}
                </View>
              ) : null}
              {!hubMode && counterVenueId != null ? (
                <Text testID="convert-venue-disclosure" style={S.convertChecklistLine}>
                  {venueDisclosure(counterVenueId)}
                </Text>
              ) : null}
              {math != null && activeIcQuote != null ? (
                <Text testID="convert-pool-fee" style={S.convertChecklistLine}>
                  {M.convert.poolFeeTier(formatMillionthsPct(activeIcQuote.feeMillionths), venueDisplayName(activeIcQuote.venueId))}
                </Text>
              ) : null}
              {math != null ? (
                <Text testID="convert-in-fee" style={S.convertChecklistLine}>
                  {M.convert.inputFeeLine(fmtAssetCompact(math.inFee, inDecimals, inSym))}
                </Text>
              ) : null}
              {math != null ? (
                <Text testID="convert-out-fee" style={S.convertChecklistLine}>
                  {M.convert.outputFeeLine(fmtAssetCompact(math.outFee, routeMode && crossRow != null ? crossRow.route.hop.decimals : outDecimals, routeMode && crossRow != null ? crossRow.route.hop.symbol : outSym))}
                </Text>
              ) : null}
              {/* Route census (cross-rail only): surplus, gas, Circle's fee, the destination
                  estimate — verbatim from the multihop surface. */}
              {math != null && routeMode && crossRow != null ? (
                <View testID="convert-route-census">
                  <Text style={S.convertChecklistLine}>{M.convert.multihop.routeSurplusNote(crossRow.route.hop.symbol)}</Text>
                  {routeGas != null ? (
                    <Text testID="convert-gas-note" style={S.convertChecklistLine}>
                      {M.convert.multihop.gasFeeLine(fmtAssetCompact(routeGas.feeWei, crossRow.route.burn.gasDecimals, crossRow.route.burn.gasSymbol))}
                    </Text>
                  ) : null}
                  <View testID="convert-crossrail-fees">
                    {crossInfo != null && crossInfo.sol != null ? (
                      <Text testID="convert-route-venues" style={S.convertChecklistLine}>
                        {M.convert.multihop.routeVenues(
                          venueDisplayName(crossRow.route.swapVenueId),
                          venueDisplayName(crossInfo.sol.venueId),
                        )}
                      </Text>
                    ) : null}
                    <Text testID="crossrail-external-gas" style={S.convertChecklistLine}>
                      {M.convert.crossrail.externalGasLine}
                    </Text>
                    {crossFee != null ? (
                      <>
                        <Text testID="crossrail-circle-fee" style={S.convertChecklistLine}>
                          {M.convert.crossrail.circleFeeLine(fmtAssetCompact(crossFee.maxFee, crossRow.route.hop.decimals, crossRow.route.hop.symbol))}
                        </Text>
                        {/* The floor reads the HOP asset (USDC) as the mid-stop on a Route C
                            (the final Jupiter step swaps it onward); Route B's USDC IS the
                            outcome, so it keeps the arrives-here phrasing. Bare number + the
                            copy's own unit (solMinLine's rule). */}
                        <Text testID="crossrail-mint-floor" style={S.convertChecklistLine}>
                          {crossInfo?.sol != null
                            ? M.convert.crossrail.mintFloorLine(fmtAssetCompact(crossFee.floor, crossRow.route.hop.decimals, '').trim(), crossRow.route.hop.symbol)
                            : M.convert.crossrail.mintFloorDestLine(fmtAssetCompact(crossFee.floor, crossRow.route.hop.decimals, '').trim(), crossRow.route.hop.symbol)}
                        </Text>
                        {crossInfo?.sol != null && destEstimate != null ? (
                          <Text testID="crossrail-dest-estimate" style={S.convertChecklistLine}>
                            {M.convert.multihop.routeDestEstimate(
                              fmtAssetCompact(destEstimate, crossInfo.sol.outDecimals, '').trim(),
                              crossRow.route.dest.symbol,
                            )}
                          </Text>
                        ) : null}
                      </>
                    ) : null}
                  </View>
                </View>
              ) : null}
              {/* HUB per-hop census (D10): each hop names its venue, its fee tier, its approve
                  cost and its OWN attributed+timestamped quote. */}
              {hubRow != null && activeHub != null ? (
                <View testID="convert-hub-census">
                  <Text style={S.convertChecklistLine}>{M.convert.multihop.hubCensusHeading}</Text>
                  <Text style={S.convertRateLabel}>{M.convert.multihop.hubRateLine(inSym, hubRow.route.dest.symbol)}
                    <Text style={S.convertRateValue}> {fmtAssetCompact(scaledRate(activeHub.m2.netOut, activeHub.q1.amountIn, inDecimals), hubRow.route.dest.decimals, hubRow.route.dest.symbol)}</Text>
                  </Text>
                  <Text style={S.convertChecklistLine}>{M.convert.multihop.legSwap(venueDisplayName(hubRow.route.legs[0].venueId), inSym, hubRow.route.hub.symbol)}</Text>
                  <Text style={S.convertPrincipal}>{M.convert.poolFeeTier(formatMillionthsPct(activeHub.q1.feeMillionths), venueDisplayName(activeHub.q1.venueId))}</Text>
                  <Text style={S.convertPrincipal}>{M.convert.multihop.approveFeeLine(fmtAssetCompact(activeHub.m1.inFee, inDecimals, inSym))}</Text>
                  <Text style={S.convertPrincipal}>{M.convert.quoteSource(nonBreakingClock(new Date(activeHub.q1.fetchedAtMs)), venueDisplayName(activeHub.q1.venueId))}</Text>
                  <Text style={S.convertChecklistLine}>{M.convert.multihop.legSwap(venueDisplayName(hubRow.route.legs[1].venueId), hubRow.route.hub.symbol, hubRow.route.dest.symbol)}</Text>
                  <Text style={S.convertPrincipal}>{M.convert.poolFeeTier(formatMillionthsPct(activeHub.q2.feeMillionths), venueDisplayName(activeHub.q2.venueId))}</Text>
                  <Text style={S.convertPrincipal}>{M.convert.multihop.approveFeeLine(fmtAssetCompact(hubRow.route.hub.fee, hubRow.route.hub.decimals, hubRow.route.hub.symbol))}</Text>
                  <Text style={S.convertPrincipal}>{M.convert.quoteSource(nonBreakingClock(new Date(activeHub.q2.fetchedAtMs)), venueDisplayName(activeHub.q2.venueId))}</Text>
                  <Text style={S.convertChecklistLine}>{M.convert.multihop.hubSurplusNote(hubRow.route.hub.symbol, hubRow.route.dest.symbol)}</Text>
                </View>
              ) : null}
              {/* Jupiter's own published price impact — the ONE impact figure any venue here
                  publishes (V8: display what the venue publishes, derive nothing). */}
              {ammMode && activeJup?.priceImpactPct != null && ammRow != null ? (
                <Text testID="convert-sol-impact" style={S.convertChecklistLine}>
                  {M.convert.sol.priceImpactLine(activeJup.priceImpactPct, venueDisplayName(ammRow.venue.venue_id))}
                </Text>
              ) : null}
              {/* The refusal line names THIS trade's failure mode. */}
              {cefiMode ? (
                <Text testID="convert-refusal" style={S.convertChecklistLine}>
                  {M.convert.cefi.refusalLine(inSym)}
                </Text>
              ) : ammMode ? (
                <Text testID="convert-refusal" style={S.convertChecklistLine}>
                  {M.convert.sol.refusalLine(inSym)}
                </Text>
              ) : math != null ? (
                <Text testID="convert-refusal" style={S.convertChecklistLine}>
                  {M.convert.refusalLine(inSym)}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      {/* The CeFi no-quote verdict (listed but unquoted) — the honest attributed no-market state
          for the row whose venue answered it. */}
      {noQuoteRow != null && noQuoteRow.rowId === activeRow?.rowId ? (
        <View testID="convert-no-quote">
          <Text style={S.convertChecklistWarn}>{M.convert.cefi.noQuoteTitle}</Text>
          <Text style={S.convertChecklistLine}>{M.convert.cefi.noQuoteBody(noQuoteRow.venueName)}</Text>
        </View>
      ) : null}
      {(activeRowErr ?? quoteErr) != null ? (
        <Text testID="convert-quote-err" style={S.err}>
          {activeRowErr ?? quoteErr}
        </Text>
      ) : null}
      {confirmErr != null ? (
        <Text testID="convert-confirm-err" style={S.err}>
          {confirmErr}
        </Text>
      ) : null}

      {/* ckETH-gas preflight + the gas-fund offer (cross-rail only) — verbatim machinery. */}
      {routeMode && gasShort && gasNeededStr != null && !gasFundCardShown ? (
        <View testID="convert-gas-preflight">
          <Text style={S.convertChecklistWarn}>{M.convert.multihop.gasPreflightTitle}</Text>
          <Text style={S.convertChecklistLine}>{M.convert.multihop.gasPreflightBody(gasNeededStr)}</Text>
        </View>
      ) : null}
      {gasFundCardShown ? (
        <View testID="convert-gas-fund-card">
          <Text style={S.convertChecklistWarn}>{M.convert.crossrail.gasFundTitle}</Text>
          {!selfFundOpen ? (
            <>
              <Text testID="gas-fund-need" style={S.convertChecklistLine}>{M.convert.crossrail.gasFundNeed(gasFundNeedStr!)}</Text>
              <Text testID="gas-fund-have" style={S.convertChecklistLine}>{M.convert.crossrail.gasFundHave(gasFundHaveStr!)}</Text>
              <Pressable
                testID="btn-gas-fund-wallet"
                style={[S.primary, !gasFundRouteOk && S.disabledFlat]}
                onPress={() => void onConfirm({relayUrl, balances: assetBalances})}
                disabled={!gasFundRouteOk}
                accessibilityRole="button"
                accessibilityState={{disabled: !gasFundRouteOk}}
                accessibilityLabel={M.convert.crossrail.gasFundWalletButton}>
                <Text style={[S.primaryText, !gasFundRouteOk && S.disabledText]}>{M.convert.crossrail.gasFundWalletButton}</Text>
              </Pressable>
              <Pressable
                testID="btn-gas-fund-self"
                onPress={() => setSelfFundOpen(true)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={M.convert.crossrail.gasFundSelfButton}>
                <Text style={S.linkText}>{M.convert.crossrail.gasFundSelfButton}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={S.convertChecklistLine}>{M.convert.crossrail.gasFundSelfMin(gasFundNeedStr!)}</Text>
              <Text testID="gas-fund-self-address" style={S.convertPrincipal} selectable>{destAddress}</Text>
              {gasFundShortStr != null ? (
                <Text testID="gas-fund-short" style={S.err}>{M.convert.crossrail.gasFundShort(gasFundShortStr)}</Text>
              ) : null}
              <Pressable
                testID="btn-gas-fund-recheck"
                onPress={() => setEthRecheckNonce(n => n + 1)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={M.convert.crossrail.gasFundRecheck}>
                <Text style={S.linkText}>{M.convert.crossrail.gasFundRecheck}</Text>
              </Pressable>
            </>
          )}
        </View>
      ) : null}

      <Pressable
        testID="btn-convert-confirm"
        style={[S.primary, !canConfirm && S.disabledFlat]}
        onPress={() => void onConfirm()}
        disabled={!canConfirm}
        accessibilityRole="button"
        accessibilityState={{disabled: !canConfirm}}
        accessibilityLabel={M.convert.confirmButton}>
        {confirmBusy || quoteBusy ? (
          <View style={S.convertBtnBusyRow}>
            <ActivityIndicator color={C.card} />
            <Text style={S.primaryText}>{M.convert.confirmButton}</Text>
          </View>
        ) : (
          <Text style={[S.primaryText, !canConfirm && S.disabledText]}>{M.convert.confirmButton}</Text>
        )}
      </Pressable>
      <View style={S.convertFooting}>
        <IconSwap size={20} color={C.sub} />
      </View>
    </View>
  );
}
