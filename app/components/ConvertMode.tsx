// ConvertMode — the delegated-conversion surface (spec 2026-09-07 §5), opened from the Accounts
// route's SELECTED-row action (`btn-accounts-convert`) for EVERY asset — the SAME gesture for all
// of them (uniform-IA hard rule; venue-less rows fail closed INSIDE this surface). One screen carries the whole
// transparency checklist BEFORE anything is signed — no tap-to-reveal, no second surface:
//   * counterparty: the venue's pool canister, named by its registry display name (autonomous
//     contract, not a licensed provider, not dpay) + "your phone signs; the pool pulls exactly
//     the approved amount";
//   * the venue's own quote, attributed + timestamped, auto-refreshed when stale (>30 s) and
//     re-quoted at confirm (a changed quote demands a fresh review, never a silent submit);
//   * every fee on its own line (pool tier, input fee, output fee, dpay = nothing either way);
//   * a per-venue disclosure sentence chosen by the venue registry's own `disclosure_key`
//     (unknown keys fall back to honest generic copy — fail closed, never blank);
//   * minimum-you'll-receive + the refusal outcome; the exact net end-state amount; and every
//     failure branch names which asset the user is left holding and that dpay cannot reverse it.
// There is deliberately NO price-impact line (V8, removed 2026-09-11): the venues dpay quotes
// publish no impact figure, so none is fetched, computed, or displayed — the second per-venue
// reference quote that used to feed it doubled quote traffic per keystroke and presented a
// curve-slope estimate as venue fact.
// When the pair has TWO+ venues (multi-venue readiness V5) a venue chooser renders above the
// headline: N rows in REGISTRY order (never ranked by output), NONE preselected, each row
// showing its OWN quote, attributed + timestamped; the checklist + confirm appear only under an
// explicit pick, and execution follows the picked venue's own pool. With exactly one venue the
// screen is unchanged — no chooser chrome, today's layout.
// The SOLANA surface (multi-venue readiness V11, 2026-09-15) is a sibling branch below
// (SolConvertMode): the same entry gesture, the same pre-sign transparency checklist, the same
// engine-driven record view — with the venue being a keyless https aggregator (Jupiter) instead
// of a pool canister: the quote is fetched DEVICE-DIRECT (no relay hop), rendered verbatim
// (inAmount/outAmount/priceImpact exactly as published), and what gets signed is the venue's
// own built transaction, beneficiary-checked before the signature (see app/solana/tx.ts).
// The CeFi surface (founder decision 3, 2026-09-14 — SideShift first adapter, 2026-09-15) is
// an IC-asset DESTINATION row in the picker below: the venue's quote arrives through the
// relay's partner-key proxy (the device never sees the credential), the fixed order is created
// through the same proxy with the user's OWN derived settle address, and the handoff is honest
// CeFi — the user sends the deposit to the VENUE's address, shown verbatim, and the resume
// engine polls the venue's keyless status endpoint device-direct. No dpay signature, no dpay
// custody, commissionRate pinned "0" relay-side: dpay is not a party and is paid nothing.
// Venue facts (display name, pool principal) are LOOKED UP from the record's/quote's own
// `venueId` against the registry (../config/venues) — never module constants (V1). Venue-less
// assets fail closed with honest copy that names what exists today (ICP ↔ VCHF), and ckUSDC's
// copy additionally names the measured-saturated direct pool refusal (spec §1). The §4 state
// machine lives in app/convert.ts; the DRIVERS live in app/convertResume.ts (the engine Wallet
// mounts once per session, V6) — this screen only RENDERS records (a view onto the engine: it
// subscribes for updates and hands freshly-prepared records to it, never running a private copy).
import {Fragment, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, Text, TextInput, View} from 'react-native';
import {isValidDestinationAddress, type CurrencyDescriptor} from '../config/catalog';
import type {SelectableAsset} from '../config/assets';
import {
  CONVERT_CEFI_CONFIRM_TIMEOUT_MS,
  CONVERT_SLIPPAGE_BPS_DEFAULT,
  CONVERT_SLIPPAGE_BPS_OPTIONS,
  resolveConvertDestinations,
} from '../config/convert';
import {BUNDLED_VENUES, cefiOtherSide, cefiVenuesForLedger, venueDisplayName, venueEndpointOf, venueOfId, venuesForPair, type VenueEntry} from '../config/venues';
import {
  buildCctpHandoff,
  ceFiQuoteFromResult,
  createCeFiOrder,
  fetchCeFiQuoteResult,
  type CeFiQuoteResult,
  ceFiServiceError,
  convertAbortFlavor,
  convertRecordMinOut,
  deriveConvertMath,
  fetchCeFiConvertQuote,
  fetchConvertQuote,
  fetchCctpBurnFee,
  gasFundNeededWei,
  isQuoteStale,
  isTerminalConvertStep,
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
  type LegPlan,
} from '../convert';
import {
  abortConvertRecord,
  acknowledgeStuckRecord,
  adoptConvertRecord,
  attachCctpBurnTx,
  confirmCrossRailSolLeg,
  convertResumeSnapshot,
  declineCctpHandoff,
  subscribeConvertRecords,
} from '../convertResume';
import {cctpMaxFee, cctpMintFloor, fetchEthBalance} from '../cctp';
import {fetchJupiterQuote, type JupiterQuote} from '../services/jupiter';
import {DpayCore} from '../services/native';
import {deriveSolanaAddress} from '../solana/identity';
import {fetchGasFeeWei, fetchLedgerFee} from '../services/rail';
import {hubRoutes, multihopRoutesFrom, gasFundRoutes, type HubRoute, type MultihopRoute} from '../routes';
import {solanaVenuesForMint} from '../config/venues';
import {SOLANA_TOKENS, USDC_MINT_ADDRESS, WRAPPED_SOL_MINT_ADDRESS, WRAPPED_SOL_TOKEN, solanaTokenOfMint} from '../solana/tokens';
import {formatClock} from '../i18n/intl';
import {M} from '../i18n';
import {fmtAssetCompact, parseUserAmount, rawToDecimal, toUnits} from '../lib/format';
import {copyToClipboard} from '../lib/clipboard';
import {eip55ChecksumBad} from '../lib/eip55';
import type {AssetId, Identity} from '../lib/types';
import {C} from '../config/palette';
import {S} from '../styles';
import {IconSwap} from './icons';
import {InstructionPanel} from './InstructionPanel';
import {
  buildDestGroups,
  ConvertHeader,
  DetailsToggle,
  fetchHubQuotes,
  formatBps,
  formatMillionthsPct,
  isLiveRecord,
  LinkRow,
  mechIdOf,
  mechPickOf,
  nonBreakingClock,
  plannedLegFee,
  plannedLegLabel,
  resolveLegs,
  routeTitleOf,
  scaledRate,
  UnavailablePanel,
  venueDisclosure,
  type ConvertLegs,
  type DestGroup,
  type DestMechPick,
} from './ConvertShared';

type Props = {
  identity: Identity;
  relayUrl: string;
  catalog: CurrencyDescriptor[];
  selectedAsset: SelectableAsset | null;
  /** The user's spendable raw-unit balance strings for IC assets, if known. */
  assetBalances: Record<number, string>;
  onBack: () => void;
  /** Fires when a swap reaches a terminal state so Wallet refreshes balances + history rows. */
  onActivity: () => void;
  /** The zero-balance gate's one action: land the selected asset's own deposit surface
   *  (Receive ▸ My address) — Wallet's `goToDeposit`, the SAME callback the Pay tab's fund gate
   *  fires. The gate names that route in its copy, so it also offers it. */
  onShowDepositAddress: () => void;
  /** Switch the wallet's selection to the venue pair's OTHER leg, so the empty account the user
   *  is standing on becomes the conversion's DESTINATION. Wallet's `payRailSelect`: a user gesture
   *  that respects the selection lock and does NOT reset the tabs' sub-modes — the user's goal
   *  survives the switch, which is the whole point of a pointer. Absent while locked, in which
   *  case the account is still NAMED and only the button is withheld (the Pay pointer's rule). */
  onSwitchAsset?: (id: AssetId) => void;
  /** Solana-rail balances for the V11 surface (SolConvertMode): raw-unit spendable SOL
   *  (lamports) + per-mint token amounts — the fund gate + insufficient check read these.
   *  Absent/empty means "unknown" and the checks fail soft (no false 'insufficient'). */
  solana?: {sol: string | null; tokens: Record<string, string | null>};
};

/** The name of the one registered REAL conversion venue — for the fail-closed panel's honest
 *  "what exists today" copy (a registry lookup, not a literal; the chooser itself renders
 *  whatever `venuesForPair` serves, V5). */
const REGISTERED_VENUE_ID = BUNDLED_VENUES.find(v => v.kind === 'ic_amm' && !v.testnet)?.venue_id ?? '';
export const REGISTERED_VENUE_NAME = venueDisplayName(REGISTERED_VENUE_ID);

export function ConvertMode({identity, relayUrl, catalog, selectedAsset, assetBalances, onBack, onShowDepositAddress, onSwitchAsset, solana}: Props) {
  // THE V11 DISPATCH: every asset gets the same Convert gesture (uniform IA); the rail picks the
  // surface. A Solana asset renders the Solana branch (Jupiter, through the relay proxy) with the
  // same transparency rules; everything below is the IC rail unchanged. When no Solana venue
  // serves the asset the branch itself fails closed with honest copy (never a blank form).
  if (selectedAsset != null && selectedAsset.protocol === 'solana') {
    return (
      <SolConvertMode
        identity={identity}
        relayUrl={relayUrl}
        asset={selectedAsset}
        catalog={catalog}
        solana={solana ?? {sol: null, tokens: {}}}
        onBack={onBack}
        onShowDepositAddress={onShowDepositAddress}
        onSwitchAsset={onSwitchAsset}
      />
    );
  }
  const [amountText, setAmountText] = useState('');
  const [slippageBps, setSlippageBps] = useState<number>(CONVERT_SLIPPAGE_BPS_DEFAULT);
  const [quote, setQuote] = useState<ConvertQuote | null>(null);
  const [math, setMath] = useState<ConvertMath | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [staleRefreshing, setStaleRefreshing] = useState(false);
  const [quoteChanged, setQuoteChanged] = useState<{oldAmt: string; newAmt: string} | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [record, setRecord] = useState<ConvertRecord | null>(null);
  // The one Details disclosure on the quote-ready surface (10x-verbosity pass 2026-09-16):
  // the venue/fee/signing census collapses behind it, default CLOSED for everyone.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // --- destination groups (2026-09-18 hub UX guidance D1–D6): the direct pair stays the
  //     standing default; every destination is an EXPLICIT row pick — never preselected,
  //     never auto-chosen. A multi-mechanism destination additionally gates its quote flow
  //     on a MECHANISM pick (the V5 rules one level down): `destMech` is that pick, null
  //     until a sub-row is tapped.
  const [destSel, setDestSel] = useState<string | null>(null);
  const [destMech, setDestMech] = useState<DestMechPick | null>(null);
  const [destAddress, setDestAddress] = useState('');
  // The gas-fund re-entry gate (2026-09-20): the offer below moves value to the destination
  // string, so the address is confirmed by re-typing it once — keyed to the normalized
  // address, so any later edit re-locks the gate.
  const [destRetype, setDestRetype] = useState('');
  const [destReentered, setDestReentered] = useState<string | null>(null);
  // The gas-fund offer's measured have (2026-09-20): undefined = not measuring / card not
  // wanted, null = measured UNKNOWN (publicnode unreachable — the card hides), else wei.
  const [destEthWei, setDestEthWei] = useState<string | null | undefined>(undefined);
  const [ethRecheckNonce, setEthRecheckNonce] = useState(0);
  const [selfFundOpen, setSelfFundOpen] = useState(false);
  // Bumped once when the offer card first becomes wanted — the NEED line re-quotes the
  // minter's gas fresh at the moment the user is looking at it, never a stale review copy.
  const [gasNonce, setGasNonce] = useState(0);
  // The minter's live gas quote for the census + preflight — refreshed per route, re-queried
  // fresh inside prepare at confirm (the signed number is never this cached one).
  const [routeGas, setRouteGas] = useState<{feeWei: string; gasLedgerFee: string} | null>(null);
  const [routeGasErr, setRouteGasErr] = useState<string | null>(null);
  // Circle's OWN published fee for the crossing (fees API, med forward fee + fast bps) —
  // shown in the census as the venue's own number; prepare re-fetches live at confirm.
  const [crossFee, setCrossFee] = useState<{maxFee: string; floor: string} | null>(null);
  const [crossFeeErr, setCrossFeeErr] = useState<string | null>(null);
  // The HUB two-quote flow (2026-09-18 hub UX, D7–D13): quote1 (from → hub), then quote2
  // (hub → dest) QUOTED ON math1.minOut — the compounding floor the engine signs. The plain
  // quote/math pair above stays null in hub mode; these carry the composed estimate.
  const [hubQuote1, setHubQuote1] = useState<ConvertQuote | null>(null);
  const [hubMath1, setHubMath1] = useState<ConvertMath | null>(null);
  const [hubQuote2, setHubQuote2] = useState<ConvertQuote | null>(null);
  const [hubMath2, setHubMath2] = useState<ConvertMath | null>(null);
  const [hubErr, setHubErr] = useState<string | null>(null);
  const [hubBusy, setHubBusy] = useState(false);
  // --- the venue chooser (multi-venue readiness V5). RED LINES, structural by construction:
  //     (1) rows render in REGISTRY order — `venuesForPair` never sorts by output; (2) nothing
  //     is ever preselected — `selectedVenueId` starts null and only a USER tap sets it (no
  //     "obviously better" shortcut, no last-used memory); (3) confirm stays withheld until a
  //     row is picked. With exactly ONE venue on the pair the chooser chrome does not render
  //     and the screen is byte-identical to the single-venue surface (flows 140–143).
  const [venueList, setVenueList] = useState<readonly VenueEntry[] | null>(null);
  const [selectedVenueId, setSelectedVenueId] = useState<string | null>(null);
  const [venueQuotes, setVenueQuotes] = useState<Record<string, ConvertQuote>>({});
  const [venueQuoteErrs, setVenueQuoteErrs] = useState<Record<string, string>>({});
  const mountedRef = useRef(true);
  // WHICH record this screen is showing. Set on mount (the newest live one, if any) and again on
  // confirm (the record this screen just built); engine updates for that id re-render it. The
  // ENGINE (app/convertResume.ts, mounted by Wallet) owns all driving — mounted screen or not.
  const recordIdRef = useRef<string | null>(null);
  const legs: ConvertLegs | null = selectedAsset != null && selectedAsset.protocol === 'ic'
    ? resolveLegs(catalog, selectedAsset)
    : null;
  // Composed routes out of this asset (app/routes.ts — pure registry walk). The venue chooser
  // never coexists with a route pick: a route IS a destination choice, and its swap hop runs
  // through the route's own single registered venue.
  const routes = legs != null ? multihopRoutesFrom(catalog, legs.inDesc.currency) : [];
  // --- the CeFi destination venues (SideShift today): rows from the registry's cefi entries
  //     whose pair carries this asset's ledger as one side. A CeFi venue is a MECHANISM of the
  //     destination it pays out to — merged by landing spot in the D1 groups below.
  const cefiVenues = legs != null ? cefiVenuesForLedger(legs.inDesc.ledger) : [];
  // --- the destination GROUPS (D1–D4) and the user's selection. The standing group is the
  //     default (`destSel == null`), and a single-mechanism group self-resolves its mechanism
  //     — only a multi-mechanism group waits for an explicit sub-pick (D2/D5, V5 rules).
  const convDests = legs != null
    ? resolveConvertDestinations(legs.inDesc.ledger, legs.inDesc.testnet)
    : [];
  const hubRoutesAll = legs != null ? hubRoutes(catalog, legs.inDesc.ledger) : [];
  const destGroups = legs != null
    ? buildDestGroups(catalog, legs, convDests, hubRoutesAll, routes, cefiVenues)
    : [];
  const selGroup: DestGroup | null = destSel != null
    ? destGroups.find(g => g.key === destSel) ?? null
    : destGroups.length === 1 ? destGroups[0] // a single-destination asset selects its only row
    : destGroups.find(g => g.key === 'direct') ?? null;
  const selMechPick: DestMechPick | null =
    selGroup == null ? null
    : selGroup.mechs.length === 1 ? mechPickOf(selGroup.mechs[0])
    : destMech != null
      && selGroup.mechs.some(m => mechIdOf(mechPickOf(m)) === mechIdOf(destMech))
      ? destMech
      // D2's sub-picker DEFAULTS to the direct pool (UX §6 red line 9): the direct pair is
      // the standing surface for the same reason it is the first row — a hub mechanism is
      // an explicit switch away, never an upgrade the screen chose for the user. Only a
      // group with NO direct mechanism (multi-hub) waits for an explicit pick.
      : selGroup.mechs.some(m => m.kind === 'direct') ? {kind: 'direct'}
      : null;
  const mechUnpicked = selGroup != null && selGroup.mechs.length > 1 && selMechPick == null;
  const activeMech = selMechPick;
  const hubRoute: HubRoute | null = activeMech?.kind === 'hub'
    ? hubRoutesAll.find(r => r.routeId === activeMech.routeId) ?? null
    : null;
  const hubMode = hubRoute != null;
  const activeRoute: MultihopRoute | null = activeMech?.kind === 'route'
    ? routes.find(r => r.routeId === activeMech.routeId) ?? null
    : null;
  const routeMode = activeRoute != null;
  const activeCefiVenue: VenueEntry | null = activeMech?.kind === 'cefi'
    ? cefiVenues.find(v => v.venue_id === activeMech.venueId) ?? null
    : null;
  const cefiMode = activeCefiVenue != null;
  // The output leg a DIRECT mechanism converts into: the standing pair's other leg for the
  // default row, the picked catalog row for an in-wallet direct pick, null otherwise (hub/
  // route/cefi picks carry their own output facts). Everything downstream that named
  // `legs.outDesc` names `effOut` — the pair surface is now one destination among many.
  const effOut: CurrencyDescriptor | null =
    legs == null ? null
    : activeMech?.kind === 'direct' && selGroup != null && selGroup.key !== 'direct' && selGroup.destLedger != null
      ? catalog.find(c => c.ledger === selGroup.destLedger) ?? null
      : legs.outDesc;
  const cefiOutMint = activeCefiVenue != null && legs != null
    ? cefiOtherSide(activeCefiVenue, legs.inDesc.ledger)
    : null;
  const cefiOut = cefiOutMint != null ? solAssetOfMint(cefiOutMint) : null;
  // The settle address is the user's OWN derived Solana address — never typed free-hand,
  // never a third party's (this wallet owns the key; the venue pays out to it). Memoized:
  // the derivation is real crypto, not per-keystroke work.
  const cefiSettleAddress = useMemo(
    () => (cefiMode ? deriveSolanaAddress(identity.secretHex) : null),
    [cefiMode, identity.secretHex],
  );
  // The CeFi REFUND address — the user's OWN address ON THE DEPOSIT RAIL, where the venue
  // returns the funds if the deposit fails or the order expires (an order without one
  // leaves the funds with the venue: the fund-loss class). IC-side the deposit rail is the
  // IC: the wallet's own IC ACCOUNT IDENTIFIER (the 64-hex account hash of the wallet's
  // principal, default subaccount — the form the venue's payout layer can actually deliver
  // to; see the SOL surface's icSettleAddress — a refund is an ICP payout too), derived
  // from the same key that derives the Solana settle address (async native derivation →
  // state; the confirm gate withholds the order until it is in). The relay independently
  // refuses an order without a well-formed one.
  const [cefiRefundAddress, setCefiRefundAddress] = useState<string | null>(null);
  useEffect(() => {
    if (!cefiMode) {
      setCefiRefundAddress(null);
      return;
    }
    let alive = true;
    DpayCore.icpPrincipalFromPubkey(identity.publicHex)
      .then(p => DpayCore.icpAccountIdFromPrincipal(p, ''))
      .then(id => {
        if (alive) setCefiRefundAddress(id);
      })
      .catch(() => {
        if (alive) setCefiRefundAddress(null);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cefiMode, identity.publicHex]);
  // The chooser's candidate rows — only under a DIRECT mechanism pick with 2+ registered
  // venues on that pair (registry order, unordered-set match). 2+ rows switch the screen to
  // the chooser layout; ONE row = the plain single-venue surface. A hub/route/cefi pick
  // suppresses the chooser just as a route pick always did: the destination mechanism owns
  // the venue choice.
  const directMechOn = activeMech?.kind === 'direct';
  const pairVenues = legs != null && directMechOn && effOut != null
    ? venuesForPair(legs.inDesc.ledger, effOut.ledger)
    : [];
  const chooserVenues = directMechOn && pairVenues.length > 1 ? pairVenues : null;
  const chooserMode = chooserVenues != null;
  // The user's pick, re-resolved against the CURRENT rows every render — if the venue it named
  // stops serving the pair, the selection silently becomes "none" (never re-picks for the user).
  const selectedVenue = selectedVenueId != null
    ? pairVenues.find(v => v.venue_id === selectedVenueId) ?? null
    : null;
  // The quote the checklist/headline derive from: the row's own quote in chooser mode (null
  // until one is picked — that is the none-preselected red line), the single quote otherwise.
  // A re-key race guard (2026-09-19 live VCHF→USDC finding): the quote effect re-keys on the
  // picked destination, but until the new fetch lands the OLD quote object is still in state —
  // the standing VCHF→ICP quote rendered under the USDC pick as "17.074223 USDC" (an 8-decimal
  // ICP amount formatted with the 6-decimal USDC row) with the min-out floor derived from it.
  // A quote is displayable only under a destination it actually quotes; anything else is the
  // busy state the refetch already switched on. Scoped to the IN-WALLET DIRECT pick (effOut
  // overridden away from the flow's own terminal): route/hub/cefi flows legitimately quote
  // toward a hop ledger while effOut stays legs.outDesc — suppressing those would blank the
  // whole multihop/crossrail surface.
  const staleDestQuote = !chooserMode && quote != null && effOut != null
    && quote.tokenOutLedger !== effOut.ledger
    && effOut.ledger !== (legs?.outDesc?.ledger ?? '');
  const activeQuote = chooserMode
    ? selectedVenue != null ? venueQuotes[selectedVenue.venue_id] ?? null : null
    : staleDestQuote ? null : quote;
  // The counterparty disclosure is a standing fact about today's venue; once a quote arrives its
  // OWN attribution (venue_id) takes over (V1). Under a chooser PICK with no live quote — fetch
  // in flight, errored into venueQuoteErrs, or cleared by a re-key — the PICKED venue is the
  // honest attribution: falling back to the registered default here used to name venue A (and
  // its pool) under a venue B pick, misattributing the pre-sign disclosure.
  const counterVenueId = activeQuote?.venueId ?? selectedVenue?.venue_id
    ?? (cefiMode && activeCefiVenue != null ? activeCefiVenue.venue_id
      : activeRoute != null ? activeRoute.swapVenueId : REGISTERED_VENUE_ID);

  // --- the engine view (V6): pick the record to render, then follow it. The resume engine
  //     (hooks/useConvertResumeEngine, mounted from Wallet) drives EVERY live record from wallet
  //     load — this screen's old private executor + 2 s pending re-arm are gone; what remains is
  //     a read model: the newest live/pending record on mount, then whatever updates arrive for
  //     the record this screen adopted or confirmed. A terminal record the engine already parked
  //     is not resurrected here — the form shows, the balance tells the outcome.
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

  // --- venue registry: what THIS relay serves (multi-venue readiness V5). One load per relay
  //     per session (loadVenueRegistry caches); the served list becomes the runtime overlay the
  //     `venuesForPair` rows above read. Until it lands (or if the relay is unreachable) the
  //     bundled registry IS the list — venue identity fails closed to drift-alarmed truth.
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

  // --- quote fetch: only for a valid positive amount while the form (not a record) is showing.
  useEffect(() => {
    if (legs == null || isLiveRecord(record)) return;
    const parsed = parseUserAmount(amountText, legs.inDecimals);
    if (!parsed.ok || parsed.raw === '0') {
      setQuote(null);
      setMath(null);
      setQuoteErr(null);
      setQuoteChanged(null);
      setVenueQuotes({});
      setVenueQuoteErrs({});
      return;
    }
    if (mechUnpicked || hubMode) {
      // D5 (2026-09-18 hub UX): a multi-mechanism destination fetches NOTHING until a
      // mechanism sub-row is picked — the venue-chooser precedent one level up; an unpicked
      // sub-row carries its label only, never another mechanism's live number. A picked HUB
      // mechanism is quoted by its own two-quote flow (the hub branch, this effect's successor).
      setQuote(null);
      setMath(null);
      setQuoteErr(null);
      setQuoteChanged(null);
      setVenueQuotes({});
      setVenueQuoteErrs({});
      return;
    }
    if (cefiMode && legs != null) {
      // CeFI MODE: one quote through the relay's partner-key proxy — the venue's own
      // settleAmount verbatim, attributed + timestamped. An unresolvable out rail id is a
      // registry-shape failure: refused honestly, nothing fetched.
      if (activeCefiVenue == null || cefiOutMint == null || cefiOut == null) {
        setQuote(null);
        setMath(null);
        setQuoteErr(M.convert.errors.quoteUnavailable(venueDisplayName(activeCefiVenue?.venue_id ?? 'venue')));
        return;
      }
      let cancelled = false;
      setQuoteBusy(true);
      setQuoteErr(null);
      void (async () => {
        try {
          const q = await fetchCeFiConvertQuote(
            relayUrl, activeCefiVenue, legs.inDesc.ledger, cefiOutMint, parsed.raw,
            {inDecimals: legs.inDecimals, outDecimals: cefiOut.decimals},
          );
          if (!cancelled && mountedRef.current) setQuote(q);
        } catch (e) {
          if (!cancelled && mountedRef.current) {
            setQuote(null);
            setQuoteErr(e instanceof Error ? e.message : String(e));
          }
        } finally {
          if (!cancelled && mountedRef.current) setQuoteBusy(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    if (activeRoute != null) {
      // ROUTE MODE: one quote for the SWAP HOP, through the route's OWN registered venue —
      // the composed destination is not a quoteable pair and never pretends to be one; the
      // destination's own figure is the min-you'll-receive line derived from this hop quote.
      let cancelled = false;
      setQuoteBusy(true);
      setQuoteErr(null);
      void (async () => {
        try {
          const q = await fetchConvertQuote(
            relayUrl, legs.inDesc.ledger, activeRoute.hop.ledger, parsed.raw,
            {venue: venueOfId(activeRoute.swapVenueId) ?? undefined},
          );
          if (!cancelled && mountedRef.current) setQuote(q);
        } catch (e) {
          if (!cancelled && mountedRef.current) {
            setQuote(null);
            setQuoteErr(e instanceof Error ? e.message : String(e));
          }
        } finally {
          if (!cancelled && mountedRef.current) setQuoteBusy(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    const rows = venuesForPair(legs.inDesc.ledger, effOut!.ledger);
    if (rows.length > 1) {
      // CHOOSER MODE: one quote PER venue, fetched in parallel — each row owns its venue's own
      // number (attributed + timestamped in the row). Row order is `rows` order, untouched by
      // anything the fetches return (the never-rank red line). The user's selection is NOT
      // re-derived here — picking a row is a user decision, not a fetch side effect.
      let cancelled = false;
      setQuoteBusy(true);
      setQuoteErr(null);
      setVenueQuotes({});
      setVenueQuoteErrs({});
      void (async () => {
        const settled = await Promise.allSettled(
          rows.map(v => fetchConvertQuote(relayUrl, legs.inDesc.ledger, effOut!.ledger, parsed.raw, {venue: v})),
        );
        if (cancelled || !mountedRef.current) return;
        const qs: Record<string, ConvertQuote> = {};
        const es: Record<string, string> = {};
        settled.forEach((r, i) => {
          if (r.status === 'fulfilled') qs[rows[i].venue_id] = r.value;
          else es[rows[i].venue_id] = r.reason instanceof Error ? r.reason.message : String(r.reason);
        });
        setVenueQuotes(qs);
        setVenueQuoteErrs(es);
        setQuoteBusy(false);
      })();
      return () => {
        cancelled = true;
      };
    }
    let cancelled = false;
    setQuoteBusy(true);
    setQuoteErr(null);
    void (async () => {
      try {
        const q = await fetchConvertQuote(relayUrl, legs.inDesc.ledger, effOut!.ledger, parsed.raw);
        if (!cancelled && mountedRef.current) setQuote(q);
      } catch (e) {
        if (!cancelled && mountedRef.current) {
          setQuote(null);
          setQuoteErr(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled && mountedRef.current) setQuoteBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // slippageBps deliberately NOT a dependency: it changes the minimum, not the quote.
    // `venueList` IS one: when the relay's served registry lands (e.g. the offline two-venue
    // world) the rows re-fetch per venue. The route's own hop ledger likewise re-keys the
    // fetch when a destination row is picked — and so does the CeFi venue pick. `destMech`
    // re-keys on a mechanism sub-pick; `mechUnpicked` gates the fetch off entirely (D5).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountText, legs?.inDesc.ledger, effOut?.ledger, relayUrl, record != null && isLiveRecord(record), venueList, activeRoute?.routeId, activeRoute?.hop.ledger, destMech, mechUnpicked, selGroup?.key, hubMode]);

  // --- HUB two-quote fetch (D5/D9): runs only under a picked hub mechanism, for the SELECTED
  //     destination — never per-row, never per-keystroke beyond the amount itself. quote2 is
  //     fetched on math1.minOut, so the pair is sequential by construction. slippageBps IS a
  //     dependency here (it sizes both floors, hence quote2's amount).
  useEffect(() => {
    if (!hubMode || hubRoute == null || legs == null || isLiveRecord(record)) return;
    const parsed = parseUserAmount(amountText, legs.inDecimals);
    if (!parsed.ok || parsed.raw === '0') {
      setHubQuote1(null);
      setHubMath1(null);
      setHubQuote2(null);
      setHubMath2(null);
      setHubErr(null);
      return;
    }
    let cancelled = false;
    setHubBusy(true);
    setHubErr(null);
    void (async () => {
      try {
        const got = await fetchHubQuotes(relayUrl, hubRoute, parsed.raw, legs.inFee, slippageBps);
        if (cancelled || !mountedRef.current) return;
        setHubQuote1(got.q1);
        setHubMath1(got.m1);
        setHubQuote2(got.q2);
        setHubMath2(got.m2);
      } catch (e) {
        if (!cancelled && mountedRef.current) {
          setHubQuote1(null);
          setHubMath1(null);
          setHubQuote2(null);
          setHubMath2(null);
          setHubErr(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled && mountedRef.current) setHubBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountText, slippageBps, legs?.inDesc.ledger, relayUrl, record != null && isLiveRecord(record), venueList, hubRoute?.routeId]);

  // --- HUB stale refresh (D13): same 30 s staleness rule, BOTH hops re-quoted fresh and in
  //     order (quote2 on the fresh floor — a stale second quote sized on a dead floor is
  //     worse than none). A moved composed number surfaces through the SAME quoteChanged
  //     review interrupt as every other mode; no new copy.
  useEffect(() => {
    if (!hubMode || hubRoute == null || legs == null || isLiveRecord(record)) return;
    if (hubQuote1 == null || hubQuote2 == null) return;
    const id = setInterval(() => {
      if (!mountedRef.current || staleRefreshing || hubBusy) return;
      if (!isQuoteStale(hubQuote1) && !isQuoteStale(hubQuote2)) return;
      void (async () => {
        setStaleRefreshing(true);
        try {
          const got = await fetchHubQuotes(relayUrl, hubRoute, hubQuote1.amountIn, legs.inFee, slippageBps);
          if (!mountedRef.current) return;
          if (got.q1.amountOutGross !== hubQuote1.amountOutGross || got.q2.amountOutGross !== hubQuote2.amountOutGross) {
            setQuoteChanged({oldAmt: hubMath2?.netOut ?? '0', newAmt: got.m2.netOut});
          }
          setHubQuote1(got.q1);
          setHubMath1(got.m1);
          setHubQuote2(got.q2);
          setHubMath2(got.m2);
        } catch {
          // The stale pair stays on screen; the next tick tries again. Errors while merely
          // refreshing are not confirm errors — the confirm re-quotes and would refuse.
        } finally {
          if (mountedRef.current) setStaleRefreshing(false);
        }
      })();
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubMode, hubRoute?.routeId, legs?.inDesc.ledger, relayUrl, record != null && isLiveRecord(record), hubQuote1, hubQuote2, hubBusy, staleRefreshing, slippageBps, amountText]);

  // --- stale refresh: >30 s old (test-seam overridable via __DPAY_TEST_CONVERT_STALE_MS) → fetch
  //     a fresh quote in place; a moved amount is surfaced as a review line, never silently kept.
  //     Single-venue mode only — the chooser refreshes each row itself (below).
  useEffect(() => {
    if (quote == null || legs == null || isLiveRecord(record) || chooserMode) return;
    const id = setInterval(() => {
      if (!mountedRef.current || staleRefreshing || !isQuoteStale(quote)) return;
      setStaleRefreshing(true);
      void (async () => {
        try {
          // CeFi mode refreshes through the partner-key proxy with the cefi fetcher — the
          // ic_amm swap_quote path would refuse the cross-rail pair by construction.
          const fresh = cefiMode && activeCefiVenue != null && cefiOutMint != null && cefiOut != null
            ? await fetchCeFiConvertQuote(
              relayUrl, activeCefiVenue, legs.inDesc.ledger, cefiOutMint, quote.amountIn,
              {inDecimals: legs.inDecimals, outDecimals: cefiOut.decimals},
            )
            : await fetchConvertQuote(
              relayUrl, legs.inDesc.ledger,
              activeRoute != null ? activeRoute.hop.ledger : effOut!.ledger,
              quote.amountIn,
              activeRoute != null ? {venue: venueOfId(activeRoute.swapVenueId) ?? undefined} : {},
            );
          if (mountedRef.current && fresh.amountOutGross !== quote.amountOutGross) {
            setQuoteChanged({oldAmt: quote.amountOutGross, newAmt: fresh.amountOutGross});
          }
          if (mountedRef.current) setQuote(fresh);
        } catch (e) {
          // unreachable relay: leave the old quote + its timestamp visible; confirm re-quotes anyway.
          console.warn('convert stale re-quote failed:', e instanceof Error ? e.message : String(e));
        } finally {
          if (mountedRef.current) setStaleRefreshing(false);
        }
      })();
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.fetchedAtMs, quote?.amountIn, staleRefreshing, legs?.inDesc.ledger, effOut?.ledger, relayUrl, record != null && isLiveRecord(record), chooserMode, activeRoute?.routeId, activeRoute?.hop.ledger, destMech, mechUnpicked, selGroup?.key, hubMode]);

  // --- stale refresh, CHOOSER MODE: every stale row refreshes its OWN quote (row order and the
  //     user's selection are inputs here, never outputs). A moved SELECTED quote is surfaced as
  //     the same review line as single-venue mode — never a silent swap under a confirmed pick.
  useEffect(() => {
    if (legs == null || isLiveRecord(record) || !chooserMode) return;
    const id = setInterval(() => {
      if (!mountedRef.current || staleRefreshing) return;
      const staleRows = (chooserVenues ?? []).filter(v => {
        const q = venueQuotes[v.venue_id];
        return q != null && isQuoteStale(q);
      });
      if (staleRows.length === 0) return;
      setStaleRefreshing(true);
      void (async () => {
        try {
          const settled = await Promise.allSettled(
            staleRows.map(v =>
              fetchConvertQuote(relayUrl, legs.inDesc.ledger, effOut!.ledger, venueQuotes[v.venue_id].amountIn, {venue: v}),
            ),
          );
          if (!mountedRef.current) return;
          const next: Record<string, ConvertQuote> = {...venueQuotes};
          settled.forEach((r, i) => {
            if (r.status === 'fulfilled') next[staleRows[i].venue_id] = r.value;
          });
          setVenueQuotes(next);
          const selIdx = staleRows.findIndex(v => v.venue_id === selectedVenueId);
          if (selIdx >= 0 && settled[selIdx].status === 'fulfilled') {
            const fresh = settled[selIdx].value;
            const oldQ = venueQuotes[staleRows[selIdx].venue_id];
            if (oldQ != null && fresh.amountOutGross !== oldQ.amountOutGross) {
              setQuoteChanged({oldAmt: oldQ.amountOutGross, newAmt: fresh.amountOutGross});
            }
          }
        } finally {
          if (mountedRef.current) setStaleRefreshing(false);
        }
      })();
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chooserMode, venueQuotes, selectedVenueId, staleRefreshing, legs?.inDesc.ledger, effOut?.ledger, relayUrl, record != null && isLiveRecord(record), destMech]);

  // --- derivations (min-out is computed by the tested core — DpayCore.icpSwapMinOut — never in TS).
  //     Derived from the ACTIVE quote — in chooser mode that is the picked row's own quote.
  useEffect(() => {
    if (activeQuote == null || legs == null) {
      setMath(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // In route mode the "output fee" of the hop math is the HOP ledger's own fee (the
        // ckUSDC the burn side pays its approve with) — the direct pair's output fee never
        // enters a composed quote's arithmetic. In CeFi mode there IS no output ledger fee:
        // the venue's commission lives inside its own quoted rate (commissionRate "0"
        // relay-side), so the honest figure is zero, not the direct pair's VCHF fee.
        const m = await deriveConvertMath(
          activeQuote, legs.inFee,
          activeRoute != null ? activeRoute.hop.fee : cefiMode ? '0' : effOut?.fee ?? legs.outFee,
          slippageBps,
        );
        if (!cancelled && mountedRef.current) setMath(m);
      } catch (e) {
        // The min-out is the compiled core's arithmetic: if it cannot run, the screen has no
        // honest number to show and MUST say so — never a silently blank checklist.
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
  }, [activeQuote?.venueId, activeQuote?.fetchedAtMs, activeQuote?.amountOutGross, slippageBps, legs?.inDesc.ledger, effOut?.fee, activeRoute?.routeId]);

  // --- the route's live gas quote (2026-09-14 spec §5/§6): the minter's OWN eip-1559 figure,
  //     fetched through the same service the standalone Withdraw flow uses — shown as its own
  //     census line and preflighted against the wallet's ckETH balance BEFORE anything is
  //     signed. prepare re-queries at confirm; this copy is for review, never for signing.
  useEffect(() => {
    if (activeRoute == null || isLiveRecord(record)) {
      setRouteGas(null);
      setRouteGasErr(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const feeWei = await fetchGasFeeWei(identity.secretHex, activeRoute.burn.minter, activeRoute.hop.ledger);
        if (feeWei == null) throw new Error(M.convert.errors.gasUnavailable);
        const gasLedgerFee = await fetchLedgerFee(identity.secretHex, activeRoute.burn.gasLedger);
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
  }, [activeRoute?.routeId, relayUrl, record != null && isLiveRecord(record), gasNonce]);

  // --- the CROSS-RAIL fee census (Routes B/C): Circle's own published number for the burn
  //     (fast finality, med forward fee, 20% buffer) + the honest external-gas line naming
  //     WHO pays the Ethereum side. prepare re-fetches and freezes maxFee on the record;
  //     this copy is for review. Fail-closed: no fee → no confirm (same rule as route gas).
  useEffect(() => {
    if (activeRoute == null || activeRoute.crossRail == null || math == null || isLiveRecord(record)) {
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
        // Collapsed to the localized fee-unavailable line — never a partial census.
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
  }, [activeRoute?.routeId, math?.minOut, record != null && isLiveRecord(record)]);

  // HUB confirm (D7–D13): the destination is the user's OWN account on the destination
  // ledger — no address input, no gas preflight, no cross-fee. Both hops re-quoted fresh at
  // confirm (UX §6 red line 7): quote2 is sized on the FRESH floor; a moved number is
  // reviewed, never silently signed. The frozen four-leg args are prepared only after the
  // review passes. Kept as its own closure so onConfirm's single-quote guard keeps its
  // narrowing for the direct/route/CeFi branches.
  const onConfirmHub = async () => {
    if (legs == null || confirmBusy) return;
    if (mechUnpicked) return;
    if (hubRoute == null || hubQuote1 == null || hubQuote2 == null || hubMath1 == null || hubMath2 == null) return;
    setConfirmBusy(true);
    setConfirmErr(null);
    setQuoteChanged(null);
    try {
      const fresh = await fetchHubQuotes(relayUrl, hubRoute, hubQuote1.amountIn, legs.inFee, slippageBps);
      if (fresh.q1.amountOutGross !== hubQuote1.amountOutGross || fresh.q2.amountOutGross !== hubQuote2.amountOutGross) {
        if (mountedRef.current) {
          setHubQuote1(fresh.q1);
          setHubMath1(fresh.m1);
          setHubQuote2(fresh.q2);
          setHubMath2(fresh.m2);
          setQuoteChanged({oldAmt: hubMath2.netOut, newAmt: fresh.m2.netOut});
        }
        return;
      }
      const rec = await prepareHubConvertRecord({
        secretHex: identity.secretHex,
        quote1: fresh.q1,
        quote2: fresh.q2,
        math1: fresh.m1,
        math2: fresh.m2,
        route: hubRoute,
      });
      if (!mountedRef.current) return;
      // Same engine handoff as every other confirm: the ENGINE owns the four signed legs,
      // the hop watch, and every state transition from here.
      recordIdRef.current = rec.id;
      setRecord(rec);
      await adoptConvertRecord(rec);
    } catch (e) {
      if (mountedRef.current) setConfirmErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setConfirmBusy(false);
    }
  };

  // The funded variant passes the wallet's balances so the engine resolves + prepends the
  // gas-funding pre-legs; the plain confirm never does (byte-identical unfunded records).
  const onConfirm = async (gasFundArg?: {relayUrl: string; balances: Record<number, string>} | null) => {
    if (legs == null || confirmBusy) return;
    // A multi-mechanism destination signs NOTHING until a mechanism sub-row is picked (D2/D5) —
    // same rule as the venue chooser's never-preselected confirm gate, one level down.
    if (mechUnpicked) return;
    if (hubMode) {
      await onConfirmHub();
      return;
    }
    if (activeQuote == null || math == null) return;
    // Chooser mode: the confirm executes through the PICKED row's venue — the fresh quote, the
    // record's venueId and the signed legs all follow that one pick (Wave-1 pool-keyed legs).
    const venueOpt = chooserMode ? {venue: selectedVenue ?? undefined} : {};
    const reviewed = activeQuote;
    // Route mode: the destination address is part of the intent — never signed unvalidated,
    // and a mixed-case EVM address must verify its own EIP-55 checksum (one flipped case
    // verifies as a DIFFERENT address; this guard closes that exposure on EVERY route).
    if (activeRoute != null && (!isValidDestinationAddress('CkEthErc20', destAddress) || eip55ChecksumBad(destAddress))) return;
    if (activeRoute != null) {
      setConfirmBusy(true);
      setConfirmErr(null);
      setQuoteChanged(null);
      try {
        // Same re-quote-at-confirm discipline, on the SWAP HOP: a moved market is reviewed,
        // never silently submitted. prepare re-queries the minter's gas FRESH — the number
        // signed is never the review copy fetched above.
        const fresh = await fetchConvertQuote(
          relayUrl, legs.inDesc.ledger, activeRoute.hop.ledger, reviewed.amountIn,
          {venue: venueOfId(activeRoute.swapVenueId) ?? undefined},
        );
        if (fresh.amountOutGross !== reviewed.amountOutGross) {
          setQuote(fresh);
          setQuoteChanged({oldAmt: reviewed.amountOutGross, newAmt: fresh.amountOutGross});
          return;
        }
        // The gas-fund widening (2026-09-20): a funded offer passes the wallet's balances so
        // prepare resolves + prepends the funding pre-legs (the DOUBLE-GAS guard inside keeps
        // this honest against the fresh quote). Absent → byte-identical unfunded record.
        const rec = await prepareMultihopConvertRecord({
          secretHex: identity.secretHex,
          quote: fresh,
          math,
          route: activeRoute,
          destAddress,
          ...(gasFundArg != null ? {gasFund: gasFundArg} : {}),
        });
        if (!mountedRef.current) return;
        recordIdRef.current = rec.id;
        setRecord(rec);
        await adoptConvertRecord(rec);
      } catch (e) {
        if (mountedRef.current) setConfirmErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (mountedRef.current) setConfirmBusy(false);
      }
      return;
    }
    if (cefiMode && activeCefiVenue != null && cefiOutMint != null && cefiOut != null
      && cefiSettleAddress != null && cefiRefundAddress != null) {
      setConfirmBusy(true);
      setConfirmErr(null);
      setQuoteChanged(null);
      try {
        // Re-quote at the confirm gesture — but ONLY to mint a FRESH QUOTE ID: the fixed
        // order must be created from a live quote (SideShift pins quoteId ↔ affiliateId ↔
        // rate together). There is deliberately NO exact-match gate against the reviewed
        // quote: a fixed shift LOCKS its rate at order creation, not at the earlier review
        // quote, and a venue rate that ticks between the two fetches can never be matched
        // exactly — the old equality gate livelocked the confirm live (review → moved →
        // review → moved …). The user fixes the DEPOSIT (identical in both quotes); the
        // settle figure is the venue's own number locked on the ORDER, and the
        // awaiting-deposit panel renders the order's own depositAmount/settle verbatim —
        // the order is both the lock and the consent point: the user sends exactly its
        // deposit figure, or nothing (prepare still refuses an order whose depositAmount
        // is not the quoted deposit).
        let freshRes: CeFiQuoteResult;
        try {
          // The 20s confirm budget (CONVERT_CEFI_CONFIRM_TIMEOUT_MS), not the 8s review
          // default: the client must never abort below the relay's own 15s upstream bound —
          // an abort there orphans a venue-side order (the live attempt-#3 signature).
          freshRes = await fetchCeFiQuoteResult(
            relayUrl, activeCefiVenue, legs.inDesc.ledger, cefiOutMint,
            rawToDecimal(reviewed.amountIn, legs.inDecimals), CONVERT_CEFI_CONFIRM_TIMEOUT_MS,
          );
        } catch (e) {
          throw ceFiServiceError(e, activeCefiVenue.display_name);
        }
        const fresh = ceFiQuoteFromResult(
          activeCefiVenue, legs.inDesc.ledger, cefiOutMint, reviewed.amountIn, freshRes, cefiOut.decimals,
        );
        // Order creation is CeFi: the DEVICE posts the order body to the relay proxy (the
        // relay attaches the partner credential server-side); the venue answers with its
        // OWN deposit address. The user sends the deposit to the VENUE, never to dpay —
        // the record's providerDeposit block carries exactly that handoff. The refund
        // address is the user's OWN IC principal: if the deposit fails or the order
        // expires, the venue returns the funds THERE — never to a dpay-controlled
        // address, and the relay refuses an order that omits it.
        let order;
        try {
          order = await createCeFiOrder(relayUrl, activeCefiVenue, freshRes, {
            settleAddress: cefiSettleAddress,
            refundAddress: cefiRefundAddress,
            depositLedger: legs.inDesc.ledger,
            settleLedger: cefiOutMint,
            depositAmountDecimal: rawToDecimal(reviewed.amountIn, legs.inDecimals),
          }, CONVERT_CEFI_CONFIRM_TIMEOUT_MS);
        } catch (e) {
          throw ceFiServiceError(e, activeCefiVenue.display_name);
        }
        const rec = prepareCeFiConvertRecord({
          quote: fresh,
          order,
          relayUrl,
          settleAddress: cefiSettleAddress,
          inCurrency: legs.inDesc.currency,
          inSymbol: legs.inSym,
          outSymbol: cefiOut.symbol,
          inDecimals: legs.inDecimals,
          outDecimals: cefiOut.decimals,
        });
        if (!mountedRef.current) return;
        // Same engine handoff as every other confirm: the ENGINE owns polling the venue's
        // keyless status endpoint and every state transition from here.
        recordIdRef.current = rec.id;
        setRecord(rec);
        await adoptConvertRecord(rec);
      } catch (e) {
        if (mountedRef.current) setConfirmErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (mountedRef.current) setConfirmBusy(false);
      }
      return;
    }
    setConfirmBusy(true);
    setConfirmErr(null);
    setQuoteChanged(null);
    const outDesc = effOut ?? legs.outDesc;
    // Unreachable for a direct pick (a direct row is always a priced catalog row) — kept
    // fail-closed so the prepare call can never see a leg-less record.
    if (outDesc == null) {
      setConfirmBusy(false);
      return;
    }
    try {
      // Re-quote at confirm (spec §5): a moved market must be reviewed, never silently submitted.
      const fresh = await fetchConvertQuote(relayUrl, legs.inDesc.ledger, outDesc.ledger, reviewed.amountIn, venueOpt);
      if (fresh.amountOutGross !== reviewed.amountOutGross) {
        if (chooserMode && selectedVenue != null) {
          setVenueQuotes(prev => ({...prev, [selectedVenue.venue_id]: fresh}));
        } else {
          setQuote(fresh);
        }
        setQuoteChanged({oldAmt: reviewed.amountOutGross, newAmt: fresh.amountOutGross});
        return;
      }
      const rec = await prepareConvertRecord({
        secretHex: identity.secretHex,
        relayUrl,
        quote: fresh,
        math,
        inDesc: legs.inDesc,
        outDesc,
      });
      if (!mountedRef.current) return;
      // Hand the record to the ENGINE (V6): it persists, surfaces, and drives it — this screen
      // keeps rendering FROM the engine's notifications, exactly as it does a resumed record.
      recordIdRef.current = rec.id;
      setRecord(rec);
      await adoptConvertRecord(rec);
    } catch (e) {
      if (mountedRef.current) setConfirmErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setConfirmBusy(false);
    }
  };

  // --- the destination/gas offer derivations + effects (2026-09-20) ---------------------------
  // PLACEMENT RULE (the 196 lesson): every hook in ConvertMode must sit ABOVE the early
  // returns below (the fund gate, the terminal-record panel) — a render that takes one of
  // those doors skips any hook declared after it and React kills the tree with "Rendered
  // fewer hooks than expected". These consts are the hooks' dependency closure.
  const destShapeValid = isValidDestinationAddress('CkEthErc20', destAddress);
  // EIP-55 at entry (2026-09-20): a MIXED-CASE EVM address must verify against its own
  // checksum — one flipped case in a hand-copied address verifies as a DIFFERENT address.
  // No-case-information forms (all-lower / all-upper) stay valid: they carry no checksum.
  const destChecksumBad = eip55ChecksumBad(destAddress);
  const destValid = destShapeValid && !destChecksumBad;
  // The gas-fund gate: the offer renders only after the address was re-typed once.
  const destConfirmed = destReentered != null && destReentered === destAddress.toLowerCase();
  const gasBalRaw = activeRoute != null ? assetBalances[activeRoute.burn.gasCurrency] : undefined;
  const gasNeededN = routeGas != null ? BigInt(routeGas.feeWei) + BigInt(routeGas.gasLedgerFee) : null;
  const gasShort = activeRoute != null && gasNeededN != null && gasBalRaw != null && gasBalRaw.length > 0 && BigInt(gasBalRaw) < gasNeededN;
  const gasNeededStr = gasNeededN != null && activeRoute != null
    ? fmtAssetCompact(gasNeededN.toString(), activeRoute.burn.gasDecimals, activeRoute.burn.gasSymbol)
    : null;
  // --- the cross-rail gas-fund offer (2026-09-20): the gasShort warn upgraded from a dead end
  //     into the two honest paths out. NEED is the minter's live feeWei plus the engine's own
  //     20% forward-fee headroom convention; HAVE is the destination wallet's measured ETH
  //     (eth_getBalance, publicnode). No measured have → no card: a need-vs-have offer without
  //     a measured have is not honest, and today's fail-open warn stands instead.
  const gasFundCardWanted = routeMode && gasShort && destConfirmed && activeRoute?.crossRail != null;
  // NEED per the engine's own derivation (feeWei + its 20% headroom convention) — the card's
  // number is the same arithmetic prepare freezes, never a UI-local re-derivation.
  const gasFundNeedStr = routeGas != null && activeRoute != null
    ? fmtAssetCompact(gasFundNeededWei(routeGas.feeWei).toString(), activeRoute.burn.gasDecimals, activeRoute.burn.gasSymbol)
    : null;
  const gasFundHaveStr = destEthWei != null && activeRoute != null
    ? fmtAssetCompact(destEthWei, activeRoute.burn.gasDecimals, activeRoute.burn.gasSymbol)
    : null;
  const gasFundShortStr = gasFundNeedStr != null && destEthWei != null && routeGas != null && activeRoute != null
    ? (() => {
        const need = gasFundNeededWei(routeGas.feeWei);
        const have = BigInt(destEthWei);
        return have >= need ? null : fmtAssetCompact((need - have).toString(), activeRoute.burn.gasDecimals, activeRoute.burn.gasSymbol);
      })()
    : null;
  const gasFundCardShown = gasFundCardWanted && destEthWei != null && gasFundNeedStr != null && gasFundHaveStr != null;
  // Fresh NEED the moment the offer is first wanted (the effect order makes this a no-op
  // until the card's conditions hold; leaving the offer re-arms it for the next entry).
  const gasFundFreshRef = useRef(false);
  useEffect(() => {
    if (gasFundCardWanted && !gasFundFreshRef.current) {
      gasFundFreshRef.current = true;
      setGasNonce(n => n + 1);
    } else if (!gasFundCardWanted) {
      gasFundFreshRef.current = false;
    }
  }, [gasFundCardWanted]);
  // The measured HAVE: eth_getBalance on the destination wallet, only while the offer is
  // wanted. Unknown (null) keeps the card hidden — the passive warn stands, fail-open.
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
  // A recheck that finds the wallet funded closes the self-fund instruction — the offer card
  // returns with the fresh numbers (the shortfall line is its own unblock signal).
  useEffect(() => {
    if (selfFundOpen && ethRecheckNonce > 0 && destEthWei != null && gasFundShortStr == null) setSelfFundOpen(false);
  }, [selfFundOpen, ethRecheckNonce, destEthWei, gasFundShortStr]);

  if (legs == null) return <UnavailablePanel selectedAsset={selectedAsset} onBack={onBack} />;
  if (record != null && (isLiveRecord(record) || TERMINAL_CONVERT_STEPS.has(record.step))) {
    // A CROSS-RAIL record has its own surface — the IC leg list PLUS the handoff / crossing /
    // final-Solana phases. Checked before the plain planned panel: a cross-rail record always
    // carries a legPlan too, so the order matters.
    if (record.crossRail != null) {
      return <CrossRailStatePanel record={record} secretHex={identity.secretHex} relayUrl={relayUrl} solLamports={solana?.sol ?? null} onBack={onBack} />;
    }
    // A PLANNED record renders its own per-leg surface — the route's leg list IS the progress UI.
    return record.legPlan != null
      ? <RouteStatePanel record={record} onBack={onBack} />
      : <StatePanel record={record} onBack={onBack} />;
  }

  const {inSym, inDecimals} = legs;
  // The OUTPUT leg the form names/quotes: under a non-standing in-wallet direct pick it is
  // THAT row (effOut); otherwise the standing pair's other leg — byte-identical to the
  // pre-groups surface for every pinned direct flow. Null for a hub-only asset, whose out*
  // fallbacks (input row's own facts) never reach a rendered money line.
  const effOutDesc = effOut ?? legs.outDesc;
  // The standing leg's own validated fields; an eff row was fail-closed priced by the
  // destination engine (fee/decimals/symbol), and falls back to the standing values —
  // never a literal — so the form's money lines stay ledger-denominated either way.
  const outSym = effOutDesc?.backing_symbol ?? effOutDesc?.symbol ?? legs.outSym;
  const outDecimals = effOutDesc?.decimals ?? legs.outDecimals;
  const balanceRaw = selectedAsset != null && selectedAsset.protocol === 'ic' ? assetBalances[selectedAsset.currency] : undefined;
  const balanceN = balanceRaw != null ? BigInt(balanceRaw) : null;
  const balanceStr = balanceRaw != null ? fmtAssetCompact(balanceRaw, inDecimals, inSym) : null;

  // Fail closed BEFORE the confirm, never after it (2026-09-08: the button was live on a wallet
  // holding nothing — a confirm that can only be refused by the ledger). A pool conversion costs
  // the amount PLUS TWO input-ledger fees: the icrc2_approve, and the pool's own pull — which is
  // exactly why `prepareConvertRecord` approves `amountIn + inFee`. A CeFi order costs ONE: the
  // user's own deposit transfer (the phone approves nothing — nothing is signed). A null balance
  // (not yet read) fails OPEN, matching the Pay tab's fund-gate: a balance nobody has measured
  // is not a zero. D21: a HUB conversion costs THREE — the two input fees PLUS the hub-ledger
  // approve fee; without it the gate green-lights a conversion that refuses at leg 3, after the
  // input is already converted.
  const parsedIn = parseUserAmount(amountText, inDecimals);
  const neededN = parsedIn.ok && parsedIn.raw !== '0'
    ? BigInt(parsedIn.raw) + (cefiMode ? 1n : 2n) * BigInt(legs.inFee) + (hubRoute != null ? BigInt(hubRoute.hub.fee) : 0n)
    : null;
  const insufficient = balanceN != null && neededN != null && neededN > balanceN;
  // F4: the Max affordance fills the largest amount that survives the SAME fee overhead the
  // gate computes — absent (never zero) when nothing would be left to convert.
  const feeOverheadN = (cefiMode ? 1n : 2n) * BigInt(legs.inFee) + (hubRoute != null ? BigInt(hubRoute.hub.fee) : 0n);
  const maxRaw = balanceN != null && balanceN > feeOverheadN ? balanceN - feeOverheadN : null;

  // Nothing to convert at all: the Pay tab's fund-gate shape, pointed at the ONE surface that can
  // fund an IC asset (Receive ▸ My address — reachable from the bottom nav on this very screen).
  if (balanceN === 0n) {
    // The pair's OTHER leg, formatted, iff it holds something. A balance that has not been read
    // (undefined) is not a zero and is not offered — the same fail-open rule the gate above uses.
    const otherRaw = legs.outDesc != null ? assetBalances[legs.outDesc.currency] : null;
    const otherHeld = otherRaw != null && BigInt(otherRaw) > 0n
      ? fmtAssetCompact(otherRaw, outDecimals, outSym)
      : null;
    return (
      <View testID="convert-screen" style={S.convertWrap}>
        <ConvertHeader title={M.convert.heading(inSym, outSym)} onBack={onBack} />
        {/* The route this copy names is also the button under it — the same panel, label and
            callback the Pay tab's fund gate uses. Unconditional: every asset the PoC venue serves
            (ICP, VCHF) is a direct ICRC row whose My-address surface funds it by plain transfer,
            so there is no capability branch to make here. */}
        <InstructionPanel
          testID="convert-fund"
          title={M.pay.fundTitle(inSym)}
          body={M.convert.fundBody(inSym, M.wallet.tab.receive, M.receive.myAddress)}
          primaryLabel={M.pay.showMyAddress(inSym)}
          onPrimary={onShowDepositAddress}
        />
        {/* The funded-account pointer the Pay gate has had since 2026-09-08 — and the reason it can
            be made honestly HERE, where a generic "switch to BTC" could not: today's venue table
            trades exactly ONE unordered pair (../config/venues), so the only account that could
            ever help is the pair's other leg, which this screen has already resolved as its OUTPUT
            leg. It is offered only when that leg actually holds something; when it does not, there
            is provably no account to point at and the deposit route above is the whole answer.
            Switching swaps the direction (the venue serves both), so the user converts what they
            have into what they were standing on. */}
        {otherHeld != null && legs.outDesc != null ? (
          <View testID="convert-fund-other">
            <Text testID="convert-fund-other-holds" style={S.convertMetaLine}>
              {M.convert.fundOtherHolds(otherHeld, inSym)}
            </Text>
            {onSwitchAsset ? (
              <Pressable
                testID="btn-convert-fund-other"
                style={S.linkBtn}
                onPress={() => onSwitchAsset(`ic:${legs.outDesc!.currency}`)}
                accessibilityRole="button"
                accessibilityLabel={M.convert.fundOtherSwitch(outSym)}
                accessibilityState={{disabled: false}}
              >
                <Text style={S.linkText}>{M.convert.fundOtherSwitch(outSym)}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      <View style={S.convertFooting}>
        <IconSwap size={20} color={C.sub} />
      </View>
    </View>
  );
}

/** The planned-record state surface (2026-09-14 spec §7): the leg list IS the progress UI —
 *  every leg carries its own pending/sent/confirmed/refused state and its own fee, and the
 *  step copy above it names what is running and, on every dead-end, exactly what the user
 *  holds and which door is the way out. */
function RouteStatePanel({record, onBack}: {record: ConvertRecord; onBack: () => void}) {
  const [, forceTick] = useState(0);
  // stuck/pending states show when the leg envelopes expire — a 30 s tick keeps that honest.
  useEffect(() => {
    if (record.step !== 'stuck' && record.step !== 'pending_withdrawal') return;
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [record.step]);
  const inDecimals = record.inDecimals ?? 8;
  const hopDecimals = record.hopDecimals ?? record.outDecimals ?? 8;
  const hopSymbol = record.hopSymbol ?? record.outSymbol;
  const destSymbol = record.destSymbol ?? record.outSymbol;
  const venueName = venueDisplayName(record.venueId);
  const venuePool = venueEndpointOf(record.venueId);
  const legExpiryMs = record.legs[0]?.expiresAtMs ?? record.createdAtMs;
  const legStateText = (s: LegPlan['state']) =>
    s === 'pending' ? M.convert.multihop.legStatePending
    : s === 'sent' ? M.convert.multihop.legStateSent
    : s === 'confirmed' ? M.convert.multihop.legStateConfirmed
    : M.convert.multihop.legStateFailed;
  // D15: the top block tracks the CURRENT leg — the first non-confirmed leg in the frozen
  // plan. Pure render, so it stays correct regardless of executor choreography: a confirmed
  // leg never comes back, and the first open leg IS where the intent actually is.
  const legPlan = record.legPlan ?? [];
  const activeLegIndex = legPlan.findIndex(lp => lp.state !== 'confirmed');
  const activeLeg = activeLegIndex >= 0 ? legPlan[activeLegIndex] : null;
  const swapOrdinalOf = (i: number): number => legPlan.slice(0, i).filter(x => x.kind === 'swap').length;
  const stepLine = activeLeg != null
    ? M.convert.multihop.legProgress(activeLegIndex + 1, legPlan.length) + ' — '
      + plannedLegLabel(record, activeLeg, activeLeg.canister, venueName, swapOrdinalOf(activeLegIndex))
    : null;
  return (
    <View testID="convert-state" style={S.convertWrap}>
      {/* Planned records ARE the composed route — the header must name it (ICP → USDC → USDC on
          Ethereum), never the direct pair the screen was opened from (UX pass 2026-09-15).
          HUB records keep the plain selection heading: the destination is this wallet's own
          asset, and a route line would hang on an empty network name (D12). */}
      <ConvertHeader
        title={record.venue2Id != null
          ? M.convert.heading(record.inSymbol, destSymbol)
          : record.legPlan != null
            ? routeTitleOf(record, hopSymbol, destSymbol)
            : M.convert.heading(record.inSymbol, record.outSymbol)}
        onBack={onBack}
      />

      {/* D15: "Step 2 of 4 — Swapping VCHF → ICP on ICPSwap" — counter plus the leg's own
          label, always visible above the phase block. */}
      {stepLine != null ? (
        <Text testID="convert-step" style={S.convertMetaLine}>{stepLine}</Text>
      ) : null}

      {record.step === 'approving' ? (
        <View testID="convert-approving">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.multihop.executingTitle}</Text>
          <Text style={S.convertStateBody}>
            {M.convert.approvingBody(fmtAssetCompact(record.amountIn, inDecimals, record.inSymbol), formatClock(new Date(legExpiryMs)))}
          </Text>
        </View>
      ) : null}

      {record.step === 'pending_withdrawal' ? (
        <View testID="convert-pending">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.pendingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.pendingBody(hopSymbol, venuePool, formatClock(new Date(record.createdAtMs)))}</Text>
          <Text style={S.convertStateMeta}>{M.convert.stillWatching}</Text>
          <Text testID="convert-expiry" style={S.convertStateMeta}>
            {M.convert.expiryLine(formatClock(new Date(legExpiryMs)))}
          </Text>
        </View>
      ) : null}

      {record.step === 'done' ? (
        record.venue2Id != null ? (
          // D17: a hub destination IS in this wallet — the direct flow's "Converted /
          // received in your wallet" copy with the SEEN payout amount and the dest-ledger
          // payout record. No address, and the cash-out "on its way" family must not leak.
          <View testID="convert-done">
            <Text style={S.convertStateTitle}>{M.convert.doneTitle}</Text>
            <Text style={S.convertStateBody}>
              {M.convert.doneBody(fmtAssetCompact(
                record.outAmountNet ?? record.expectedNet2 ?? '0',
                record.destDecimals ?? hopDecimals, destSymbol))}
            </Text>
            {record.outTx != null ? <Text style={S.convertStateMeta}>{M.convert.doneTx(record.outTx)}</Text> : null}
          </View>
        ) : (
        <View testID="convert-done">
          <Text style={S.convertStateTitle}>{M.convert.multihop.doneRouteTitle}</Text>
          <Text style={S.convertStateBody}>
            {M.convert.multihop.doneRouteBody(fmtAssetCompact(record.outAmountNet ?? '0', hopDecimals, destSymbol), record.destAddress ?? '')}
          </Text>
          {/* Delivery on Ethereum is asynchronous and unwitnessable from IC (spec §4): the
              honest terminal says ON ITS WAY and what evidence exists — never "received". */}
          <Text style={S.convertStateMeta}>{M.convert.multihop.doneOnItsWay}</Text>
          {record.outTx != null ? <Text style={S.convertStateMeta}>{M.convert.doneTx(record.outTx)}</Text> : null}
        </View>
        )
      ) : null}

      {record.step === 'failed_refunded' ? (
        <View testID="convert-failed">
          <Text style={S.convertStateTitle}>{M.convert.failedTitle}</Text>
          {record.failureCode === 'approve_refused' ? (
            <Text style={S.convertStateBody}>{M.convert.failedApproveBody(record.inSymbol)}</Text>
          ) : (
            <Text style={S.convertStateBody}>{M.convert.failedSwapBody(record.failureDetail ?? '', record.inSymbol, venueName)}</Text>
          )}
        </View>
      ) : null}

      {record.step === 'failed_leg' ? (
        record.venue2Id != null ? (
          // D18: ONE terminal meaning for a hub refusal — a completed swap is BEHIND you,
          // the rest refused, and the funds are the named HUB asset in THIS wallet. The exit
          // is that asset's own surfaces (keep / convert from its own account / send); the
          // cash-out exit would name Pay ▸ Send-to-address, the wrong door. A leg-3 approve
          // refusal (the hub ledger refusing the allowance) lands here too, with the hub
          // ledger's own reason.
          <View testID="convert-failed-leg">
            <Text style={S.convertStateTitle}>{M.convert.multihop.failedHop2Title}</Text>
            <Text style={S.convertStateBody}>
              {M.convert.multihop.failedHop2Body(hopSymbol, destSymbol, record.failureDetail ?? '')}
            </Text>
            <Text style={S.convertChecklistWarn}>{M.convert.multihop.failedHop2Exit(hopSymbol)}</Text>
          </View>
        ) : (
        <View testID="convert-failed-leg">
          <Text style={S.convertStateTitle}>{M.convert.multihop.failedLegTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.multihop.failedLegBody(hopSymbol, record.failureDetail ?? '')}</Text>
          {/* The actionable exit (spec §4): the funds are NOT lost — they are the hop asset,
              in this wallet, and the standalone Withdraw is the door out. */}
          <Text style={S.convertChecklistWarn}>{M.convert.multihop.failedLegExit}</Text>
        </View>
        )
      ) : null}

      {record.step === 'stuck' ? (
        <View testID="convert-stuck">
          <Text style={S.convertStateTitle}>{M.convert.stuckTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.multihop.stuckRouteBody}</Text>
          {/* D19: on a hub record the outcome is NOT all-or-nothing — what is already held
              is a fact, stated plainly next to the watching copy. */}
          {record.venue2Id != null ? (
            <Text style={S.convertStateMeta}>{M.convert.multihop.stuckHoldsLine(hopSymbol)}</Text>
          ) : null}
          <Text testID="convert-expiry" style={S.convertStateMeta}>
            {M.convert.expiryLine(formatClock(new Date(legExpiryMs)))}
          </Text>
          {record.acknowledgedStuckAtMs == null ? (
            <>
              <Pressable
                testID="btn-convert-stuck-ack"
                style={S.linkBtn}
                onPress={() => {
                  void acknowledgeStuckRecord(record.id);
                }}
                accessibilityRole="button"
                accessibilityLabel={M.convert.stuckAcknowledge}
                accessibilityState={{disabled: false}}
              >
                <Text style={S.linkText}>{M.convert.stuckAcknowledge}</Text>
              </Pressable>
            </>
          ) : (
            <Text style={S.convertStateMeta}>{M.convert.stuckAcknowledged}</Text>
          )}
        </View>
      ) : null}

      {/* THE leg list — every leg, its own state, its own fee; the leg that stopped names
          itself by its refusal state. This list is the progress UI the route promised. D14:
          it stays FULLY expanded for hub records — four legs, no folding. */}
      <View testID="convert-route-legs" style={S.convertChecklistCard}>
        {record.gasPre != null ? (
          <Text testID="convert-gas-legs-note" style={S.convertStateMeta}>{M.convert.crossrail.gasLegsNote}</Text>
        ) : null}
        {(record.legPlan ?? []).map((lp, i) => {
          const leg = record.legs[i];
          const canister = leg?.canister ?? lp.canister;
          const fee = plannedLegFee(record, lp, canister);
          const label = plannedLegLabel(record, lp, canister, venueName,
            (record.legPlan ?? []).slice(0, i).filter(x => x.kind === 'swap').length);
          return (
            <View key={i} testID={`convert-leg-${i}`}>
              <Text style={S.convertChecklistLine}>{label}</Text>
              <Text
                testID={`convert-leg-${i}-state`}
                style={lp.state === 'failed' ? [S.convertStateMeta, S.convertLegStateBad] : S.convertStateMeta}>
                {fee != null ? `${legStateText(lp.state)} · ${fee}` : legStateText(lp.state)}
              </Text>
            </View>
          );
        })}
      </View>
      <View style={S.convertFooting}>
        <IconSwap size={20} color={C.sub} />
      </View>
    </View>
  );
}


  // In chooser mode this also withholds the confirm until a row is picked (activeQuote is null
  // without a selection — the none-preselected red line, expressed as data, not as a flag).
  // In route mode the confirm additionally requires a validated destination address, the gas
  // census to be complete, and — when the wallet's ckETH balance is KNOWN — to cover the gas
  // (an unknown balance stays fail-open, per spec §6; prepare re-queries everything anyway).
  // The dest/gas derivations themselves live ABOVE the early returns (the 196 hooks rule).
  // Hub mode replaces the quote pair entirely: the confirm needs BOTH hops' quotes and math
  // on the table (a half-quoted conversion is not confirmable), and hub mode adds no address,
  // gas, or cross-fee requirements — the destination is the user's own account.
  const hubReady = hubQuote1 != null && hubQuote2 != null && hubMath1 != null && hubMath2 != null;
  const canConfirm = !quoteBusy && !hubBusy && !confirmBusy && !insufficient && !mechUnpicked
    && (hubMode ? hubReady : activeQuote != null && math != null)
    && (!routeMode || (destValid && routeGas != null && routeGasErr == null && !gasShort))
    // Cross-rail routes also need Circle's fee on the table before confirm (fail-closed).
    && (activeRoute == null || activeRoute.crossRail == null || crossFee != null);
  // [Fund from this wallet] is enabled iff a funding path exists — the engine's own enumeration
  // over the registry (direct venue first, else hub), from this conversion's input ledger.
  const gasFundRouteOk = legs != null && activeRoute != null
    && gasFundRoutes(catalog, legs.inDesc.ledger, activeRoute.burn.gasLedger).length > 0;
  // Route-mode quote-derived figures describe the HOP asset (ckUSDC), not the direct pair's
  // other side — the destination's own figure is the min-you'll-receive line in the checklist.
  // CeFi mode likewise describes the VENUE's settle asset (SOL via the registry mint), not
  // the direct pair's other side. Hub mode describes the DESTINATION asset — the composed
  // estimate is what lands in this wallet.
  const hubDest = hubRoute?.dest ?? null;
  const dispOutSym = activeRoute != null ? activeRoute.hop.symbol
    : hubDest != null ? hubDest.symbol
    : cefiMode && cefiOut != null ? cefiOut.symbol : outSym;
  const dispOutDecimals = activeRoute != null ? activeRoute.hop.decimals
    : hubDest != null ? hubDest.decimals
    : cefiMode && cefiOut != null ? cefiOut.decimals : outDecimals;
  const netStr = hubDest != null && hubMath2 != null
    ? fmtAssetCompact(hubMath2.netOut, hubDest.decimals, hubDest.symbol)
    : math != null ? fmtAssetCompact(math.netOut, dispOutDecimals, dispOutSym) : null;
  // D12: the form's heading names the SELECTED destination — the direct pair only while the
  // direct row is the pick. A route/hub/CeFi pick leaving the heading stuck on the direct
  // pair made the form disagree with every state panel below it.
  const formHeading = hubDest != null ? M.convert.heading(inSym, hubDest.symbol)
    : activeRoute != null ? M.convert.heading(inSym, activeRoute.dest.symbol)
    : cefiOut != null ? M.convert.heading(inSym, cefiOut.symbol)
    : M.convert.heading(inSym, outSym);
  return (
    <View testID="convert-screen" style={S.convertWrap}>
      <ConvertHeader title={formHeading} onBack={onBack} />

      <Text style={S.convertAmountLabel}>{M.convert.amountLabel(inSym)}</Text>
      <View style={S.amountRow}>
        <TextInput
          testID="convert-amount"
          style={S.amountInput}
          value={amountText}
          onChangeText={setAmountText}
          keyboardType="decimal-pad"
          autoCorrect={false}
          autoCapitalize="none"
          placeholderTextColor={C.sub}
        />
      </View>
      {balanceStr != null ? (
        <View style={S.convertBalanceRow}>
          <Text testID="convert-balance" style={S.convertMetaLine}>
            {M.convert.balanceLine(balanceStr)}
          </Text>
          {maxRaw != null ? (
            <Pressable
              testID="btn-convert-max"
              onPress={() => {
                setAmountText(rawToDecimal(maxRaw.toString(), inDecimals));
                setQuoteChanged(null);
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={M.convert.maxAmount}>
              <Text style={S.linkText}>{M.convert.maxAmount}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {insufficient ? (
        <Text testID="convert-insufficient" style={S.err}>
          {cefiMode
            ? M.convert.cefi.insufficientLine(fmtAssetCompact(neededN!.toString(), inDecimals, inSym), balanceStr!)
            : hubRoute != null
              // D21: the copy names the honest overhead — three fees, not two.
              ? M.convert.multihop.insufficientHubLine(fmtAssetCompact(neededN!.toString(), inDecimals, inSym), balanceStr!)
              : M.convert.insufficientLine(fmtAssetCompact(neededN!.toString(), inDecimals, inSym), balanceStr!)}
        </Text>
      ) : null}

      {/* The destination picker (2026-09-18 hub UX guidance D1–D6): ONE row per destination
          ASSET — the direct pair as the standing default row first, then every other in-wallet
          asset, then every external destination (routes + CeFi venues merged by where they
          LAND). A destination with more than one mechanism reveals an indented MECHANISM
          sub-picker on selection: direct pool first, then via-hub / CCTP / venue rows in
          registry order — never ranked, nothing preselected beyond that order, and no quote
          until a mechanism is picked (the venue chooser's red lines, one level down). */}
      {destGroups.length > 0 ? (
        <View testID="convert-dest">
          <Text style={S.convertDestLabel}>{M.convert.multihop.destLabel}</Text>
          {destGroups.map(g => {
            const groupOn = selGroup != null && selGroup.key === g.key;
            const single = g.mechs.length === 1;
            return (
              <View key={g.key}>
                <Pressable
                  testID={g.testID}
                  style={[S.convertVenueRow, groupOn && S.convertVenueRowOn]}
                  onPress={() => {
                    setDestSel(g.key);
                    setDestMech(single ? mechPickOf(g.mechs[0]) : null);
                    setQuoteChanged(null);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{checked: groupOn}}
                  accessibilityLabel={g.label}>
                  <View style={[S.convertVenueRadio, groupOn && S.convertVenueRadioOn]}>
                    {groupOn ? <View style={S.convertVenueRadioDot} /> : null}
                  </View>
                  <View style={S.convertVenueRowText}>
                    <Text style={[S.convertVenueName, groupOn && S.convertVenueNameOn]}>{g.label}</Text>
                  </View>
                </Pressable>
                {groupOn && !single ? (
                  <View testID="convert-dest-mechs" style={S.convertMechGroup}>
                    {g.mechs.map(m => {
                      const pick = mechPickOf(m);
                      const id = mechIdOf(pick);
                      const on = activeMech != null && mechIdOf(activeMech) === id;
                      const mechLabel =
                        m.kind === 'direct' ? M.convert.multihop.mechDirect
                        : m.kind === 'hub' ? M.convert.multihop.mechViaHub(m.route.hub.symbol)
                        : m.kind === 'route' ? (
                          m.route.crossRail != null ? M.convert.multihop.mechViaCctp : M.convert.multihop.mechDirect
                        )
                        : M.convert.multihop.mechViaVenue(m.venue.display_name);
                      return (
                        <Pressable
                          key={id}
                          testID={`convert-dest-mech-${id}`}
                          style={[S.convertVenueRow, on && S.convertVenueRowOn]}
                          onPress={() => {
                            setDestMech(pick);
                            setQuoteChanged(null);
                          }}
                          accessibilityRole="radio"
                          accessibilityState={{checked: on}}
                          accessibilityLabel={mechLabel}>
                          <View style={[S.convertVenueRadio, on && S.convertVenueRadioOn]}>
                            {on ? <View style={S.convertVenueRadioDot} /> : null}
                          </View>
                          <View style={S.convertVenueRowText}>
                            <Text style={[S.convertVenueName, on && S.convertVenueNameOn]}>{mechLabel}</Text>
                            {/* Same settlement-SLA honesty as the venue chooser (2026-09-20). */}
                            {m.kind === 'cefi' && m.venue.health?.status === 'degraded' ? (
                              <Text testID={`convert-dest-mech-cefi-slow-${m.venue.venue_id}`} style={S.convertMetaLine}>
                                {M.convert.venueSlow}
                              </Text>
                            ) : null}
                            {/* D5: an UNPICKED mechanism carries its label + a static shape
                                line, never another mechanism's live number. */}
                            {!on && m.kind === 'hub' ? (
                              <Text style={S.convertMetaLine}>{M.convert.multihop.hubShape()}</Text>
                            ) : null}
                          </View>
                        </Pressable>
                      );
                    })}
                    {mechUnpicked ? (
                      <Text testID="convert-dest-mech-none" style={S.convertMetaLine}>
                        {M.convert.multihop.mechNoneSelected}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {/* The route's destination address — a required input, validated live (the Withdraw
          destination's own rule: an address is never signed unvalidated). Since 2026-09-20 a
          MIXED-CASE EVM address must additionally verify its own EIP-55 checksum, and the
          gas-fund offer can never render before the address was re-typed once. */}
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
                // Any edit to the address re-locks the re-entry gate and clears the copy.
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
          {/* One-time re-entry: the gate the gas-fund offer sits behind — the address moves
              value, so it is confirmed as typed, not just pasted. */}
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
          {/* Cross-rail routes (B/C): the SAME address is also the signer of the crossing —
              the user must paste one they control, not an exchange deposit address. */}
          {activeRoute?.crossRail != null ? (
            <Text testID="convert-dest-cross-note" style={S.convertMetaLine}>{M.convert.crossrail.destAddressCrossNote}</Text>
          ) : null}
        </View>
      ) : null}

      {/* The CeFi settle address: not an input — the user's OWN derived Solana address,
          shown read-only before the order is created so the payout destination is reviewed
          exactly like a route's typed destination (the phone owns this key; the venue pays
          out to it and nothing else). */}
      {cefiMode && cefiSettleAddress != null ? (
        <View>
          <Text style={S.convertAmountLabel}>{M.convert.cefi.settleAddressLabel}</Text>
          <Text testID="convert-settle-address" style={S.convertMetaLine} selectable>{cefiSettleAddress}</Text>
        </View>
      ) : null}

      {/* The venue chooser (multi-venue readiness V5): N rows in REGISTRY order — the relay's
          own row order, rendered verbatim and NEVER ranked or sorted by output. Each row shows
          its OWN quote, attributed + timestamped; nothing is preselected and the checklist +
          confirm below stay gated on an explicit pick. Renders only when the pair has 2+ venues
          — with one venue this whole block is absent and the screen is exactly today's.
          A route pick suppresses it entirely: the route's swap hop runs through its own single
          registered venue, and a second venue list would read as a route choice we never make.
          A CeFi venue pick suppresses it for the same reason — the venue IS the destination. */}
      {!routeMode && !cefiMode && chooserVenues != null ? (
        <View testID="convert-venues">
          <Text style={S.convertSlippageLabel}>{M.convert.venueChooserLabel}</Text>
          {chooserVenues.map((v) => {
            const vq = venueQuotes[v.venue_id];
            const verr = venueQuoteErrs[v.venue_id];
            const on = selectedVenueId === v.venue_id;
            return (
              <Pressable
                key={v.venue_id}
                testID={`convert-venue-${v.venue_id}`}
                style={[S.convertVenueRow, on && S.convertVenueRowOn]}
                onPress={() => {
                  setSelectedVenueId(v.venue_id);
                  setQuoteChanged(null);
                }}
                accessibilityRole="radio"
                accessibilityState={{checked: on}}
                accessibilityLabel={v.display_name}>
                {/* The selection affordance: an unchecked/checked radio circle, so a row READS
                    as tappable and as chosen (border colour alone did not — a11y + scan-ability,
                    2026-09-11). Decorative: the Pressable above carries the role/state/label. */}
                <View style={[S.convertVenueRadio, on && S.convertVenueRadioOn]}>
                  {on ? <View style={S.convertVenueRadioDot} /> : null}
                </View>
                <View style={S.convertVenueRowText}>
                  <Text style={[S.convertVenueName, on && S.convertVenueNameOn]}>{v.display_name}</Text>
                  {/* Settlement-SLA demotion (2026-09-20): the relay put a recently-slow venue
                      at the tail — this line is the honest WHY. Never a ranking, never hidden. */}
                  {v.health?.status === 'degraded' ? (
                    <Text testID={`convert-venue-${v.venue_id}-slow`} style={S.convertMetaLine}>
                      {M.convert.venueSlow}
                    </Text>
                  ) : null}
                  {vq != null ? (
                    <Text testID={`convert-venue-${v.venue_id}-quote`} style={S.convertVenueAmount}>
                      {fmtAssetCompact(vq.amountOutGross, outDecimals, outSym)}
                    </Text>
                  ) : verr != null ? (
                    <Text testID={`convert-venue-${v.venue_id}-err`} style={S.err}>{verr}</Text>
                  ) : (
                    <View style={S.convertBtnBusyRow}>
                      <ActivityIndicator color={C.sub} />
                    </View>
                  )}
                  {/* The per-row attribution+timestamp folds behind the ONE Details control
                      below (10x-verbosity pass 2026-09-16); the row shows just the digits. */}
                  {detailsOpen && vq != null ? (
                    <Text testID={`convert-venue-${v.venue_id}-source`} style={S.convertMetaLine}>
                      {M.convert.quoteSource(nonBreakingClock(new Date(vq.fetchedAtMs)), venueDisplayName(v.venue_id))}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
          {/* The chooser's own Details control: opens the per-row fetch timestamps (the
              attribution lines), default CLOSED (10x-verbosity pass 2026-09-16). Its testID is
              DISTINCT from the checklist's `convert-details` so the checklist control stays
              unique in the DOM — e2e locators resolve the first match. */}
          <DetailsToggle
            testID="convert-venue-details"
            open={detailsOpen}
            onToggle={() => setDetailsOpen(o => !o)}
            label={M.convert.detailsLabel}
          />
          {selectedVenue == null ? (
            <Text testID="convert-venue-none" style={S.convertMetaLine}>
              {M.convert.venueNoneSelected}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* The decision, as one number: what actually lands in the wallet, and whose quote it
          is. The rate folds behind the checklist's Details control (10x-verbosity pass
          2026-09-16); the attribution line stays — it is WHOSE number this is. Hub mode's
          number is the COMPOSED estimate (both pools), attributed to BOTH venues verbatim
          (D11) with the route chip naming the hub (D8). */}
      {netStr != null && (hubMode ? hubReady : activeQuote != null) ? (
        <View testID="convert-headline" style={S.convertHeadlineCard}>
          {/* Route mode: the quoted number is the HOP payout landing in THIS wallet, not the
              at-address amount (that promise is convert-route-min) — label it so (UX pass
              2026-09-15). Direct and hub modes keep "You'll receive" — the destination IS
              this wallet (D7: the label gates on where the money lands, not the route). */}
          <Text style={S.convertHeadlineLabel}>
            {routeMode ? M.convert.multihop.swapPaysLabel : M.convert.receiveHeadline}
          </Text>
          <Text style={S.convertHeadlineAmount}>{netStr}</Text>
          {hubMode && hubQuote1 != null && hubQuote2 != null ? (
            <Text testID="convert-quote-source" style={S.convertHeadlineMeta}>
              {M.convert.multihop.hubQuoteSource(
                venueDisplayName(hubQuote1.venueId),
                venueDisplayName(hubQuote2.venueId),
                nonBreakingClock(new Date(Math.max(hubQuote1.fetchedAtMs, hubQuote2.fetchedAtMs))),
              )}
            </Text>
          ) : activeQuote != null ? (
            <Text testID="convert-quote-source" style={S.convertHeadlineMeta}>
              {M.convert.quoteSource(nonBreakingClock(new Date(activeQuote.fetchedAtMs)), venueDisplayName(activeQuote.venueId))}
            </Text>
          ) : null}
          {hubRoute != null ? (
            <Text testID="convert-route-via" style={S.convertMetaLine}>
              {M.convert.multihop.viaHub(hubRoute.hub.symbol)}
            </Text>
          ) : null}
          {/* The staleness notice renders HERE, pinned to the quote-source row it is about — the
              user sees "refreshing" where the number is shown, not at the checklist bottom where
              an unscrolled viewport hides it. Same testID flows 143 pin; single instance. */}
          {staleRefreshing ? (
            <Text testID="convert-stale" style={S.convertHeadlineMeta}>
              {M.convert.staleRefreshing}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* In chooser mode the checklist (like the headline) appears only under an explicit pick —
          with one venue the card renders exactly as it always has. */}
      {(!chooserMode || selectedVenue != null) ? (
      <View style={S.convertChecklistCard}>
      {/* The MAIN surface is the decision (10x-verbosity pass 2026-09-16): the slippage axis,
            the minimum, and a quote-change warning. The venue/fee/signing census — rate,
            counterparty + principals, disclosure sentence, per-side fee lines, refusal
            consequence, route surplus/gas notes — collapses behind the ONE Details control at
            the bottom of this card, default CLOSED. Full attribution (quoteSource) stays on
            the headline card. There is deliberately NO price-impact line here (V8): the IC
            venues publish no impact figure. CeFi mode hides the slippage axis entirely: a
            fixed shift is a LOCKED rate — there is no floor to set. */}
        {/* Hub mode sizes BOTH floors on the slippage axis — the chips stay (D13 keeps the
            whole stale/re-quote loop slippage-aware). CeFi mode hides them entirely: a fixed
            shift is a LOCKED rate — there is no floor to set. */}
        {(math != null || (hubMode && hubMath2 != null)) && !cefiMode ? (
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
        {/* The minimum line is where the modes part ways. Hub mode (D9): the floor is the
            SECOND swap's floor, an in-wallet amount — routeMinWalletLine, never the
            at-address phrasing. Route mode: a route's floor is the DESTINATION's floor (the
            burn amount is the swap's min-you'll-receive — spec §5). The routes' surplus/gas
            notes and the cross-rail fee census fold behind Details; the live ERROR branches
            stay on the main surface — an instruction is never hidden (founder rule). */}
        {hubDest != null && hubMath2 != null ? (
          <View testID="convert-route-min">
            <Text style={S.convertMinOutLine}>
              {M.convert.multihop.routeMinWalletLine(
                fmtAssetCompact(hubMath2.minOut, hubDest.decimals, hubDest.symbol),
                formatBps(slippageBps),
              )}
            </Text>
          </View>
        ) : math != null && routeMode && activeRoute != null ? (
          <View testID="convert-route-min">
            <Text style={S.convertMinOutLine}>
              {/* Cross-rail honesty: the burn amount is denominated in the HOP asset (USDC) —
                  Route C's dest.symbol is SOL and must not label this number. */}
              {M.convert.multihop.routeMinLine(
                fmtAssetCompact(math.minOut, dispOutDecimals, activeRoute.crossRail != null ? dispOutSym : activeRoute.dest.symbol),
                formatBps(slippageBps),
              )}
            </Text>
            {routeGasErr != null ? (
              <Text testID="convert-gas-note" style={S.err}>{routeGasErr}</Text>
            ) : null}
            {activeRoute.crossRail != null && crossFeeErr != null ? (
              <View testID="convert-crossrail-fees">
                <Text testID="crossrail-circle-fee" style={S.err}>{crossFeeErr}</Text>
              </View>
            ) : null}
          </View>
        ) : math != null && !cefiMode ? (
          <Text testID="convert-min-out" style={S.convertMinOutLine}>
            {M.convert.minReceiveLine(fmtAssetCompact(math.minOut, outDecimals, outSym), formatBps(slippageBps))}
          </Text>
        ) : null}
        {quoteChanged != null ? (
          <Text testID="convert-quote-changed" style={S.convertChecklistWarn}>
            {M.convert.quoteChanged(
              fmtAssetCompact(quoteChanged.oldAmt, dispOutDecimals, dispOutSym),
              fmtAssetCompact(quoteChanged.newAmt, dispOutDecimals, dispOutSym),
            )}
          </Text>
        ) : null}
        {/* The one Details control, at the bottom of the decision card. Default CLOSED. */}
        <DetailsToggle
          open={detailsOpen}
          onToggle={() => setDetailsOpen(o => !o)}
          label={M.convert.detailsLabel}
        />
        {detailsOpen ? (
          <View testID="convert-details-block">
            {math != null && activeQuote != null ? (
              <View testID="convert-rate" style={S.convertRateRow}>
                <Text style={S.convertRateLabel}>{M.convert.rateLabel(inSym, dispOutSym)}</Text>
                <Text style={S.convertRateValue}>{fmtAssetCompact(scaledRate(activeQuote.amountOutGross, activeQuote.amountIn, legs.inDecimals), dispOutDecimals, dispOutSym)}</Text>
              </View>
            ) : null}
            {/* Counterparty disclosure: the venue the QUOTE is attributed to names itself —
                display name and pool principal are registry lookups on the quote's own venueId,
                so a second venue cannot render under the first one's identity (V1). Before a
                quote arrives the standing disclosure names the one registered venue; attribution
                follows the quote — or, under a chooser pick, the PICKED venue. The sentence
                itself is trimmed to bare venue attribution (the tail moved to the disclosure
                copy + quoteSource). */}
            {/* Hub mode folds the whole direct counterparty census out: the per-hop census
                below names each venue itself, and a single counterparty sentence would
                misattribute a two-venue intent (D10/D11). */}
            {!hubMode ? (
            <View testID="convert-counterparty">
              {/* The ic_amm sentence is FALSE for a CeFi venue — an exchange service is a
                  company, not a contract; the cefi block says what it is. */}
              <Text style={S.convertChecklistLine}>
                {cefiMode
                  ? M.convert.cefi.counterparty(venueDisplayName(counterVenueId))
                  : M.convert.counterparty(venueDisplayName(counterVenueId))}
              </Text>
              {/* The pool principal renders only when THIS venue's own number stands behind it:
                  the quote's pool echo once one arrives, or the standing single-venue
                  disclosure. Under a chooser pick whose quote has not settled (or errored) NO
                  principal renders — an execution fact is never asserted without its quote, and
                  another venue's principal is never borrowed. A CeFi venue renders NO principal
                  line: its https API base is where the relay carries the partner key — not a
                  fact a depositor can check. */}
              {!cefiMode && (activeQuote != null || !chooserMode) ? (
                <Text testID="convert-pool-principal" style={S.convertPrincipal}>{activeQuote?.pool ?? venueEndpointOf(counterVenueId)}</Text>
              ) : null}
              {/* "Your phone signs" is likewise false for CeFi: the phone signs NOTHING — the
                  user sends the deposit to the venue's own address. */}
              <Text style={S.convertChecklistLine}>
                {cefiMode ? M.convert.cefi.checklistSigns : M.convert.counterpartySigns}
              </Text>
              {/* A route names its SECOND counterparty too: the ckETH minter that executes the
                  burn — its principal is an execution fact, shown as plainly as the pool's. */}
              {routeMode && activeRoute != null ? (
                <Text testID="convert-minter-principal" style={S.convertPrincipal}>{activeRoute.burn.minter}</Text>
              ) : null}
            </View>
            ) : null}
            {/* The per-venue disclosure sentence (the registry's own `disclosure_key` picks the
                copy; an unknown key falls back to honest generic copy — fail closed). It
                follows the PICKED venue (the counterVenueId the quote's own attribution
                resolves to). */}
            {!hubMode ? (
              <Text testID="convert-venue-disclosure" style={S.convertChecklistLine}>
                {venueDisclosure(counterVenueId)}
              </Text>
            ) : null}
            {math != null && !cefiMode && activeQuote != null ? (
              <Text testID="convert-pool-fee" style={S.convertChecklistLine}>
                {M.convert.poolFeeTier(formatMillionthsPct(activeQuote.feeMillionths), venueDisplayName(activeQuote.venueId))}
              </Text>
            ) : null}
            {math != null ? (
              <Text testID="convert-in-fee" style={S.convertChecklistLine}>
                {M.convert.inputFeeLine(fmtAssetCompact(math.inFee, inDecimals, inSym))}
              </Text>
            ) : null}
            {math != null ? (
              <Text testID="convert-out-fee" style={S.convertChecklistLine}>
                {M.convert.outputFeeLine(fmtAssetCompact(math.outFee, dispOutDecimals, dispOutSym))}
              </Text>
            ) : null}
            {/* Route census (route mode only): the surplus note, the minter's gas line, and the
                cross-rail fee census. The happy gas/crossrail branches live here; their error
                branches stay on the main surface above. */}
            {math != null && routeMode && activeRoute != null ? (
              <View testID="convert-route-census">
                <Text style={S.convertChecklistLine}>{M.convert.multihop.routeSurplusNote(dispOutSym)}</Text>
                {routeGas != null ? (
                  <Text testID="convert-gas-note" style={S.convertChecklistLine}>
                    {M.convert.multihop.gasFeeLine(fmtAssetCompact(routeGas.feeWei, activeRoute.burn.gasDecimals, activeRoute.burn.gasSymbol))}
                  </Text>
                ) : null}
                {activeRoute.crossRail != null ? (
                  <View testID="convert-crossrail-fees">
                    {/* Fee census honesty for the crossing: the EVM gas is the USER's wallet's
                        ETH (dpay can neither pay nor quote it); Circle's mint fee is Circle's
                        own published number, deducted from the amount — never a dpay fee. */}
                    <Text testID="crossrail-external-gas" style={S.convertChecklistLine}>
                      {M.convert.crossrail.externalGasLine}
                    </Text>
                    {crossFee != null ? (
                      <>
                        <Text testID="crossrail-circle-fee" style={S.convertChecklistLine}>
                          {M.convert.crossrail.circleFeeLine(fmtAssetCompact(crossFee.maxFee, dispOutDecimals, dispOutSym))}
                        </Text>
                        <Text testID="crossrail-mint-floor" style={S.convertChecklistLine}>
                          {M.convert.crossrail.mintFloorLine(fmtAssetCompact(crossFee.floor, dispOutDecimals, dispOutSym))}
                        </Text>
                      </>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : null}
            {/* HUB per-hop census (D10): one section inside the SAME Details fold — each hop
                names its venue, its fee tier, its approve cost and its OWN verbatim
                quoteSource+timestamp; the main attribution (D11) stays on the headline. No
                total-fees line: the two fees are in different ledger units and would have to
                be summed dishonestly. */}
            {hubDest != null && hubRoute != null && hubQuote1 != null && hubQuote2 != null && hubMath1 != null && hubMath2 != null ? (
              <View testID="convert-hub-census">
                <Text style={S.convertChecklistLine}>{M.convert.multihop.hubCensusHeading}</Text>
                <Text style={S.convertRateLabel}>{M.convert.multihop.hubRateLine(inSym, hubDest.symbol)}
                  <Text style={S.convertRateValue}> {fmtAssetCompact(scaledRate(hubMath2.netOut, hubQuote1.amountIn, legs.inDecimals), hubDest.decimals, hubDest.symbol)}</Text>
                </Text>
                <Text style={S.convertChecklistLine}>{M.convert.multihop.legSwap(venueDisplayName(hubRoute.legs[0].venueId), inSym, hubRoute.hub.symbol)}</Text>
                <Text style={S.convertPrincipal}>{M.convert.poolFeeTier(formatMillionthsPct(hubQuote1.feeMillionths), venueDisplayName(hubQuote1.venueId))}</Text>
                <Text style={S.convertPrincipal}>{M.convert.multihop.approveFeeLine(fmtAssetCompact(hubMath1.inFee, inDecimals, inSym))}</Text>
                <Text style={S.convertPrincipal}>{M.convert.quoteSource(nonBreakingClock(new Date(hubQuote1.fetchedAtMs)), venueDisplayName(hubQuote1.venueId))}</Text>
                <Text style={S.convertChecklistLine}>{M.convert.multihop.legSwap(venueDisplayName(hubRoute.legs[1].venueId), hubRoute.hub.symbol, hubDest.symbol)}</Text>
                <Text style={S.convertPrincipal}>{M.convert.poolFeeTier(formatMillionthsPct(hubQuote2.feeMillionths), venueDisplayName(hubQuote2.venueId))}</Text>
                <Text style={S.convertPrincipal}>{M.convert.multihop.approveFeeLine(fmtAssetCompact(hubRoute.hub.fee, hubRoute.hub.decimals, hubRoute.hub.symbol))}</Text>
                <Text style={S.convertPrincipal}>{M.convert.quoteSource(nonBreakingClock(new Date(hubQuote2.fetchedAtMs)), venueDisplayName(hubQuote2.venueId))}</Text>
                <Text style={S.convertChecklistLine}>{M.convert.multihop.hubSurplusNote(hubRoute.hub.symbol, hubDest.symbol)}</Text>
              </View>
            ) : null}
            {/* The refusal line names THIS trade's failure mode. A pool trade fails on price
                (the pool/approval language); a CeFi deposit-order fails by never being sent —
                the order expires and nothing moved. Same slot, same rank: what happens if it
                goes wrong. Lives behind Details: it is context, not an active error — the
                active error branches (quote/confirm/gas/crossrail) never fold. */}
            {math != null ? (
              <Text testID="convert-refusal" style={S.convertChecklistLine}>
                {cefiMode ? M.convert.cefi.refusalLine(inSym) : M.convert.refusalLine(inSym)}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
      ) : null}

      {(quoteErr ?? hubErr) != null ? (
        <Text testID="convert-quote-err" style={S.err}>
          {quoteErr ?? hubErr}
        </Text>
      ) : null}
      {confirmErr != null ? (
        <Text testID="convert-confirm-err" style={S.err}>
          {confirmErr}
        </Text>
      ) : null}

      {/* ckETH-gas preflight (spec §6): with a KNOWN shortfall the intent form says so BEFORE
          anything is signed. On a cross-rail route with a CONFIRMED destination and a measured
          have, the passive warn upgrades to the gas-fund offer card (2026-09-20): need vs have,
          one number per line, and the two honest paths out. Without a measured have the card
          never renders — the passive warn stands (today's fail-open). */}
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

// --- the SOLANA convert surface (multi-venue readiness V11, 2026-09-15) -------------------------
// The rail-local pair SOL ↔ USDC(Solana) through the registered solana_amm venue (Jupiter). The
// IC surface's rules carry over one-for-one: one venue today so no chooser chrome; quote fetched
// per keystroke DEVICE-DIRECT (no relay hop — keyless https, the opencryptopay shape), rendered
// VERBATIM (Jupiter's own outAmount/priceImpact/threshold digits, V8: no deriving, no blending);
// the pre-sign checklist names the venue + its https endpoint + the disclosure; nothing is
// preselected; the confirm re-quotes and shows a moved-quote review line before adopting a
// record. What differs is the execution shape: ONE venue-built transaction, signed by the
// device AFTER the beneficiary check (app/solana/tx.ts), submitted through the same Solana RPC
// proxy the SOL payment rail uses — the engine (convertResume) drives the record through
// swapping → settling → done; this component only renders it.

/** Mint → {symbol, decimals} for venue-pair mints: the wrapped-SOL identifier resolves to SOL
 *  itself (the registry's stable id for the native side), everything else reverse-looks-up the
 *  SPL registry. Null for unknown mints — the branch fails closed on it. */
export function solAssetOfMint(mint: string): {symbol: string; decimals: number} | null {
  if (mint === WRAPPED_SOL_MINT_ADDRESS) {
    return {symbol: WRAPPED_SOL_TOKEN, decimals: SOLANA_TOKENS.SOL.decimals};
  }
  const found = Object.entries(SOLANA_TOKENS).find(([, info]) => info.mint === mint);
  return found != null ? {symbol: found[0], decimals: found[1].decimals} : null;
}

/** Every registered out-destination for a SOL asset's input mint: the solana_amm registry rows
 *  that serve it, folded to the OTHER side of each pair and deduped by out mint, in REGISTRY
 *  ORDER (the registry's order is the display order — never sorted, never ranked). Null for a
 *  mint the SPL registry does not know; an empty `dests` for a mint no venue serves — both
 *  fail closed on the unavailable panel. */
/** One MECHANISM the Solana surface offers toward a destination: a solana_amm (Jupiter) pair,
 *  or — since 2026-09-20 (live-sweep defect 1, founder rule: every currency through the SAME
 *  surfaces) — a registered cefi venue whose pair carries this mint as the DEPOSIT side. A
 *  cefi mechanism's output lives on the IC rail: `outLedger` is the catalog ledger it settles. */
type SolDestMech =
  | {kind: 'amm'; venue: VenueEntry; outMint: string; outSym: string; outDecimals: number}
  | {kind: 'cefi'; venue: VenueEntry; outLedger: string; outSym: string; outDecimals: number};

/** One DESTINATION row (where the money LANDS) with its mechanisms — the IC-side D4 group
 *  shape mirrored: in-wallet SPL destinations keyed by mint, IC destinations keyed by the
 *  settling catalog ledger (two venues landing the same asset merge into ONE group). */
type SolDestGroup = {key: string; testID: string; label: string; mechs: SolDestMech[]};

/** The e2e asset testKeys ('sol', 'sol-usdc', 'sol-eurc') — the dest-row testID contract,
 *  the same keys HomeAccounts/Ledger/AssetPicker pin (never derived from metadata). */
const solDestTestKey = (sym: string): string =>
  sym === WRAPPED_SOL_TOKEN ? 'sol' : `sol-${sym.toLowerCase()}`;

/** The venue sub-picker's key for one mechanism: the venue id for cefi (each venue is
 *  its own service), 'amm' for the in-wallet route (single-mech groups never show a
 *  picker). Module-level so every reader above its definition still hoists it. */
function solMechKeyOf(m: SolDestMech): string {
  return m.kind === 'cefi' ? m.venue.venue_id : 'amm';
}

function resolveSolDestinations(
  asset: Extract<SelectableAsset, {protocol: 'solana'}>,
  catalog: CurrencyDescriptor[],
): {inMint: string; groups: SolDestGroup[]} | null {
  // Native SOL is mint:null in the asset model but WRAPPED-sol in the venue registry — the two
  // identifiers for the same asset, translated here and only here.
  const inMint = asset.mint ?? WRAPPED_SOL_MINT_ADDRESS;
  if (solAssetOfMint(inMint) == null) return null;
  const groups: SolDestGroup[] = [];
  const byKey = new Map<string, SolDestGroup>();
  const push = (g: SolDestGroup): void => {
    groups.push(g);
    byKey.set(g.key, g);
  };
  for (const venue of solanaVenuesForMint(inMint)) {
    const outMint = venue.pair_ledgers.find(m => m !== inMint);
    if (outMint == null || byKey.has(outMint)) continue;
    const outTok = solAssetOfMint(outMint);
    if (outTok == null) continue;
    push({
      key: outMint,
      testID: `convert-sol-dest-${solDestTestKey(outTok.symbol)}`,
      label: M.convert.multihop.destDirect(outTok.symbol),
      mechs: [{kind: 'amm', venue, outMint, outSym: outTok.symbol, outDecimals: outTok.decimals}],
    });
  }
  // The CeFi half: registered cefi venues whose pair carries this mint as the deposit side —
  // the SAME rows the IC surface offers in the other direction, merged by landing spot. A
  // settle ledger the catalog doesn't know is registry/catalog drift: fail closed, no row.
  for (const venue of cefiVenuesForLedger(inMint)) {
    const outLedger = cefiOtherSide(venue, inMint);
    if (outLedger == null) continue;
    const row = catalog.find(c => c.ledger === outLedger);
    // The pricing gate's own red lines (same as resolveConvertDestinations): a settle side
    // without a catalog row or without decimals cannot be priced honestly — no row.
    if (row == null || row.decimals == null) continue;
    const outSym = row.backing_symbol ?? row.symbol ?? '';
    if (outSym === '') continue;
    const key = `ic:${outLedger}`;
    const mech: SolDestMech = {kind: 'cefi', venue, outLedger, outSym, outDecimals: row.decimals};
    const existing = byKey.get(key);
    if (existing != null) {
      existing.mechs.push(mech);
      continue;
    }
    push({
      key,
      testID: `convert-sol-dest-cefi-${venue.venue_id}`,
      label: M.convert.cefi.destRow(outSym, 'Internet Computer', venue.display_name),
      mechs: [mech],
    });
  }
  // A merged group (several venues on ONE landing spot — the trocador aggregator beside
  // sideshift since 2026-09-20) names the SPOT only; "via <venue>" moves to the mech
  // sub-picker rows. A label naming one venue would be a lie about a two-venue slot.
  for (const g of groups) {
    const first = g.mechs[0];
    if (g.mechs.length > 1 && first?.kind === 'cefi') {
      g.label = M.convert.cefi.destRowMulti(first.outSym, 'Internet Computer');
    }
  }
  return {inMint, groups};
}

/** The Solana analog of `resolveLegs`: the legs the SELECTED mechanism serves — an amm
 *  venue's other mint, or a cefi venue's settle ledger on the IC rail. Null when nothing is
 *  selected (zero destinations — the fail-closed panel renders). */
type SolLegs =
  | {kind: 'amm'; inMint: string; outMint: string; inSym: string; outSym: string; inDecimals: number; outDecimals: number}
  | {kind: 'cefi'; inMint: string; outLedger: string; inSym: string; outSym: string; inDecimals: number; outDecimals: number};

function resolveSolLegs(
  asset: Extract<SelectableAsset, {protocol: 'solana'}>,
  mech: SolDestMech | null,
): SolLegs | null {
  const inMint = asset.mint ?? WRAPPED_SOL_MINT_ADDRESS;
  const inTok = solAssetOfMint(inMint);
  if (mech == null || inTok == null) return null;
  if (mech.kind === 'amm') {
    const outTok = solAssetOfMint(mech.outMint);
    if (outTok == null) return null;
    return {kind: 'amm', inMint, outMint: mech.outMint, inSym: inTok.symbol, outSym: outTok.symbol, inDecimals: inTok.decimals, outDecimals: outTok.decimals};
  }
  return {kind: 'cefi', inMint, outLedger: mech.outLedger, inSym: inTok.symbol, outSym: mech.outSym, inDecimals: inTok.decimals, outDecimals: mech.outDecimals};
}

type SolConvertProps = {
  identity: Identity;
  /** The active relay — the Jupiter quote/swap dials go through it (2026-09-16). */
  relayUrl: string;
  asset: Extract<SelectableAsset, {protocol: 'solana'}>;
  /** The catalog — resolves a cefi venue's settle ledger into the destination row's
   *  symbol/decimals (the IC half of the pair, on this surface since 2026-09-20). */
  catalog: CurrencyDescriptor[];
  solana: {sol: string | null; tokens: Record<string, string | null>};
  onBack: () => void;
  onShowDepositAddress: () => void;
  onSwitchAsset?: (id: AssetId) => void;
};

function SolConvertMode({identity, relayUrl, asset, catalog, solana, onBack, onShowDepositAddress, onSwitchAsset}: SolConvertProps) {
  const [amountText, setAmountText] = useState('');
  const [slippageBps, setSlippageBps] = useState<number>(CONVERT_SLIPPAGE_BPS_DEFAULT);
  const [quote, setQuote] = useState<JupiterQuote | null>(null);
  // The CeFi quote (a ConvertQuote — the venue's verbatim settle figure), parallel to the
  // Jupiter quote: whichever MECHANISM is active renders its own quote's digits.
  const [cefiQuote, setCefiQuote] = useState<ConvertQuote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [staleRefreshing, setStaleRefreshing] = useState(false);
  const [quoteChanged, setQuoteChanged] = useState<{oldAmt: string; newAmt: string} | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [record, setRecord] = useState<ConvertRecord | null>(null);
  // The one Details disclosure on the quote-ready surface (10x-verbosity pass 2026-09-16):
  // the venue/fee/signing census collapses behind it, default CLOSED for everyone.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const mountedRef = useRef(true);
  const recordIdRef = useRef<string | null>(null);
  // Sync latch for the confirm gesture: `confirmBusy` state lags a re-render, and a duplicate
  // press delivered inside that window would run prepare twice (two venue swap POSTs from one
  // gesture — observed once under heavy host load, 2026-09-17). The ref closes it same-tick.
  const confirmBusyRef = useRef(false);

  // --- the destination (spec 2026-09-16 §2 decision 5, widened 2026-09-20): one GROUP per
  //     destination ASSET — in-wallet SPL destinations (every registered solana_amm venue for
  //     this mint) plus the registered cefi venues settling onto the IC rail (defect 1 of the
  //     live sweep: the SAME rows the IC surface offers in the other direction). Registry
  //     order, merged by landing spot, never ranked. The DEFAULT is the FIRST option — the
  //     exact pair this surface served before widening, so a one-group mint renders no chooser
  //     chrome and behaves exactly as before. A switch resets the quote + its review state
  //     (the amount stays — the user's number is not the venue's business).
  const inMint = asset.mint ?? WRAPPED_SOL_MINT_ADDRESS;
  const [destKey, setDestKey] = useState<string | null>(null);
  const [destMintKey, setDestMintKey] = useState<string | null>(null);
  const [destMechKey, setDestMechKey] = useState<string | null>(null);
  if (destMintKey !== inMint) {
    // The pick is per-mint state — a different asset re-derives the default (render-phase
    // adjustment: set during render when a prop changed the fact the state is keyed on).
    setDestMintKey(inMint);
    setDestKey(null);
    setDestMechKey(null);
  }
  const solDests = resolveSolDestinations(asset, catalog);
  const destGroups: SolDestGroup[] = solDests?.groups ?? [];
  const activeGroup = destGroups.find(g => g.key === destKey) ?? destGroups[0] ?? null;
  // A group can hold SEVERAL mechanisms since 2026-09-20 (the trocador aggregator beside
  // sideshift on the IC landing spot). The sub-pick defaults to the FIRST — the registry's
  // order, never a ranking — and an explicit pick wins. A group with no mechanism cannot exist.
  const activeMech = activeGroup != null
    ? activeGroup.mechs.find(m => solMechKeyOf(m) === destMechKey) ?? activeGroup.mechs[0] ?? null
    : null;
  const venue = activeMech?.venue ?? null;
  const legs = activeMech != null ? resolveSolLegs(asset, activeMech) : null;
  const cefiMode = activeMech?.kind === 'cefi';
  const venueName = venue != null ? venueDisplayName(venue.venue_id) : venueDisplayName('jupiter');

  const pickDest = (key: string) => {
    // Frozen while a confirm is in flight: the in-flight confirm closes over THIS pair, and its
    // late setQuote/setQuoteChanged must never land under the newly picked pair's heading.
    if (key === destKey || confirmBusy) return;
    setDestKey(key);
    setDestMechKey(null); // the new group re-derives its default mechanism
    setQuote(null); setQuoteErr(null); setQuoteChanged(null); setQuoteBusy(false); setConfirmErr(null);
  };
  const balanceRaw = legs == null ? null : legs.inMint === WRAPPED_SOL_MINT_ADDRESS ? solana.sol : solana.tokens[legs.inMint] ?? null;
  const outHeldRaw = legs != null && legs.kind === 'amm'
    ? (legs.outMint === WRAPPED_SOL_MINT_ADDRESS ? solana.sol : solana.tokens[legs.outMint] ?? null)
    : null; // a cefi settle side lives on the IC rail — this wallet's other SOL token is irrelevant

  // --- the CeFi payout target (IC-side twin: the cefiSettleAddress memo): the user's OWN
  //     address ON THE DESTINATION RAIL — the wallet's IC ACCOUNT IDENTIFIER: the 64-hex
  //     account hash of the wallet's own principal (default subaccount), the SAME
  //     derivation that mints the wallet's deposit addresses, from the same key that
  //     derives the Solana address. Nothing typed, nothing entrusted. NOT the principal
  //     text: the venue's ICP payout layer cannot deliver to principal-format addresses —
  //     only to these 32-byte identifiers (SideShift engineering, confirmed in writing
  //     2026-09-21; a shift naming the principal text sat `settling` for hours and was
  //     refunded 2026-09-20) — so the principal is only the derivation's INTERMEDIATE,
  //     never the emitted target.
  const [icSettleAddress, setIcSettleAddress] = useState<string | null>(null);
  useEffect(() => {
    if (!cefiMode) {
      setIcSettleAddress(null);
      return;
    }
    let alive = true;
    DpayCore.icpPrincipalFromPubkey(identity.publicHex)
      .then(p => DpayCore.icpAccountIdFromPrincipal(p, ''))
      .then(id => {
        if (alive) setIcSettleAddress(id);
      })
      .catch(() => {
        if (alive) setIcSettleAddress(null);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cefiMode, identity.publicHex]);
  // The CeFi REFUND address, SOL surface: the DEPOSIT rail here is Solana, so refunds go
  // to the user's OWN derived Solana address (same shape as the IC surface's cefiRefundAddress —
  // the venue returns the funds there on a failed deposit or expiry; never a dpay address).
  const solRefundAddress = useMemo(
    () => deriveSolanaAddress(identity.secretHex),
    [identity.secretHex],
  );

  // --- engine view (the same shape as the IC surface: newest live/unacknowledged-stuck record,
  // honored-record lock, subscribe for updates — this screen never runs a private executor).
  useEffect(() => {
    mountedRef.current = true;
    const pick = (records: Record<string, ConvertRecord>) => {
      const id = recordIdRef.current;
      if (id != null) {
        setRecord(records[id] ?? null);
        return;
      }
      const live = Object.values(records)
        .filter(r => isLiveRecord(r) || (r.step === 'stuck' && r.acknowledgedStuckAtMs == null))
        .sort((a, b) => b.createdAtMs - a.createdAtMs)[0] ?? null;
      if (live != null) recordIdRef.current = live.id;
      setRecord(live);
    };
    pick(convertResumeSnapshot());
    const unsub = subscribeConvertRecords((records) => {
      if (mountedRef.current) pick(records);
    });
    return () => {
      unsub();
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const liveRecord = record != null && isLiveRecord(record);
  const showRecord = record != null && (liveRecord || record.step === 'stuck' || isTerminalConvertStep(record.step));

  // --- the quote: through the relay proxy per keystroke (the relay pipes the venue
  // byte-faithfully, short-TTL-caching identical asks). Slippage IS a dep here (unlike IC):
  // Jupiter's route + threshold are computed against it, so a changed chip must re-ask the
  // venue. The cefi branch goes through the SAME CeFi quote path the IC surface uses
  // (partner-key proxy, verbatim settle figure) — rails differ, the pipeline does not.
  useEffect(() => {
    if (legs == null || venue == null || showRecord) return;
    const parsed = parseUserAmount(amountText, legs.inDecimals);
    if (!parsed.ok || parsed.raw === '0') {
      setQuote(null); setCefiQuote(null); setQuoteErr(null); setQuoteBusy(false); setQuoteChanged(null);
      return;
    }
    if (legs.kind === 'cefi') {
      let cancelled = false;
      setQuoteBusy(true);
      fetchCeFiConvertQuote(relayUrl, venue, legs.inMint, legs.outLedger, parsed.raw, {
        inDecimals: legs.inDecimals,
        outDecimals: legs.outDecimals,
      })
        .then(q => {
          if (cancelled) return;
          setCefiQuote(q);
          setQuoteErr(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setCefiQuote(null);
          setQuoteErr(e instanceof Error ? e.message : M.convert.errors.quoteUnreachable(venueName));
        })
        .finally(() => {
          if (!cancelled) setQuoteBusy(false);
        });
      return () => {
        cancelled = true;
      };
    }
    let cancelled = false;
    setQuoteBusy(true);
    fetchJupiterQuote(relayUrl, venue, legs.inMint, legs.outMint, parsed.raw, slippageBps)
      .then(res => {
        if (cancelled) return;
        if (res.ok) {
          setQuote(res.quote); setQuoteErr(null);
        } else {
          setQuote(null);
          setQuoteErr(res.code === 'refused' ? M.convert.errors.quoteRefused(venueName) : M.convert.errors.quoteUnreachable(venueName));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setQuote(null);
        setQuoteErr(M.convert.errors.quoteUnreachable(venueName));
      })
      .finally(() => {
        if (!cancelled) setQuoteBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountText, legs?.inMint, legs != null && legs.kind === 'amm' ? legs.outMint : null, legs != null && legs.kind === 'cefi' ? legs.outLedger : null, slippageBps, showRecord]);

  // --- stale refresh (same 30s clock + test seam as IC; keeps the OLD quote on failure).
  // SINGLE-FLIGHT, the IC surface's exact guard (ConvertMode IC stale effect): a tick may fire
  // a refresh ONLY when none is in flight. Without the `staleRefreshing` check, a quote that
  // stays stale (venue slow or unreachable) re-fires the fetch EVERY SECOND — up to 8
  // concurrent 8s-budget calls hammering the relay's partner-key proxy. That stampede is the
  // live 2026-09-21 attempt-#3 signature: the venue throttled the shared partner credential,
  // so the CONFIRM's own re-quote could not answer inside its budget ("Could not reach
  // SideShift" alternating with the refresh's own "Quote changed" banner).
  useEffect(() => {
    if (legs == null || venue == null || showRecord) return;
    if (legs.kind === 'cefi') {
      if (cefiQuote == null) return;
      const tick = setInterval(() => {
        if (!mountedRef.current || staleRefreshing || !isQuoteStale(cefiQuote)) return;
        setStaleRefreshing(true);
        fetchCeFiConvertQuote(relayUrl, venue, legs.inMint, legs.outLedger, cefiQuote.amountIn, {
          inDecimals: legs.inDecimals,
          outDecimals: legs.outDecimals,
        })
          .then(q => {
            if (mountedRef.current) {
              setCefiQuote(q);
              if (q.amountOutGross !== cefiQuote.amountOutGross) {
                setQuoteChanged({oldAmt: cefiQuote.amountOutGross, newAmt: q.amountOutGross});
              }
            }
          })
          .catch(() => {})
          .finally(() => {
            if (mountedRef.current) setStaleRefreshing(false);
          });
      }, 1000);
      return () => clearInterval(tick);
    }
    if (quote == null) return;
    const tick = setInterval(() => {
      if (!mountedRef.current || staleRefreshing || !isQuoteStale(quote)) return;
      setStaleRefreshing(true);
      fetchJupiterQuote(relayUrl, venue, legs.inMint, legs.outMint, quote.inAmount, slippageBps)
        .then(res => {
          if (res.ok && mountedRef.current) {
            setQuote(res.quote);
            if (res.quote.outAmount !== quote.outAmount) {
              setQuoteChanged({oldAmt: quote.outAmount, newAmt: res.quote.outAmount});
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          if (mountedRef.current) setStaleRefreshing(false);
        });
    }, 1000);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote, cefiQuote, staleRefreshing, slippageBps, showRecord]);

  const parsedAmount = parseUserAmount(amountText, legs != null ? legs.inDecimals : 0);
  const amountRaw = parsedAmount.ok ? parsedAmount.raw : null;
  const balanceN = balanceRaw != null && /^\d+$/.test(balanceRaw) ? BigInt(balanceRaw) : null;
  const amountN = amountRaw != null && /^\d+$/.test(amountRaw) ? BigInt(amountRaw) : 0n;
  // The venue tx's network fee is paid in SOL on top of the swapped amount — when SOL is the
  // INPUT the honest available figure is the balance itself (the fee lives under the same SOL;
  // a dust edge fails on-chain and lands in the honest failure state, never a false pass).
  const insufficient = legs != null && amountN > 0n && balanceN != null && amountN > balanceN;
  const canConfirm = legs != null && !quoteBusy && !confirmBusy && !insufficient && amountN > 0n
    && (cefiMode ? cefiQuote != null && icSettleAddress != null : quote != null);

  const onConfirm = async () => {
    if (confirmBusyRef.current) return; // sync latch: a duplicate press before the re-render is a no-op
    if (legs == null || venue == null || amountRaw == null) return;
    if (legs.kind === 'cefi') {
      // The CeFi confirm — the IC surface's branch, mirrored rail-side. The re-quote exists
      // ONLY to mint a fresh quoteId (SideShift pins quoteId↔rate); there is deliberately NO
      // exact-match gate against the reviewed quote — a ticking venue rate can never be
      // matched exactly and the gate would livelock (the IC-side defect the same sweep found).
      // The ORDER is the lock and the consent point: its depositAmount is the reviewed
      // deposit, its settle figure is the venue's own locked number, and prepare still
      // refuses an order whose depositAmount differs.
      // The refund guard sits beside the settle guard: both addresses come from the
      // wallet's own key, and the order (per the relay's contract) needs both.
      if (icSettleAddress == null || solRefundAddress == null) {
        setConfirmErr(M.convert.errors.quoteUnavailable('order'));
        return;
      }
      confirmBusyRef.current = true;
      setConfirmBusy(true); setConfirmErr(null);
      try {
        let freshRes;
        try {
          // The 20s confirm budget, NOT the 8s review default (CONVERT_CEFI_CONFIRM_TIMEOUT_MS):
          // an abort below the relay's own 15s upstream bound means the phone gives up while
          // the venue is still answering — the order 201s venue-side, the record is never
          // adopted, and the deposit handoff never begins (the live attempt-#3 signature).
          freshRes = await fetchCeFiQuoteResult(relayUrl, venue, legs.inMint, legs.outLedger, rawToDecimal(amountRaw, legs.inDecimals), CONVERT_CEFI_CONFIRM_TIMEOUT_MS);
        } catch (e) {
          throw ceFiServiceError(e, venueName);
        }
        const fresh = ceFiQuoteFromResult(venue, legs.inMint, legs.outLedger, amountRaw, freshRes, legs.outDecimals);
        let order;
        try {
          // SOL-side cefi: the DEPOSIT rail is Solana, so the refund address — where the
          // venue returns the funds on a failed deposit or expiry — is this wallet's own
          // derived Solana address. The relay refuses any order without a well-formed one.
          order = await createCeFiOrder(relayUrl, venue, freshRes, {
            settleAddress: icSettleAddress,
            refundAddress: solRefundAddress,
            depositLedger: legs.inMint,
            settleLedger: legs.outLedger,
            depositAmountDecimal: rawToDecimal(amountRaw, legs.inDecimals),
          }, CONVERT_CEFI_CONFIRM_TIMEOUT_MS);
        } catch (e) {
          throw ceFiServiceError(e, venueName);
        }
        const rec = prepareCeFiConvertRecord({
          quote: fresh,
          order,
          relayUrl,
          settleAddress: icSettleAddress,
          inCurrency: null, // the INPUT is a Solana-rail asset — no IC catalog currency
          inSymbol: legs.inSym,
          outSymbol: legs.outSym,
          inDecimals: legs.inDecimals,
          outDecimals: legs.outDecimals,
        });
        if (!mountedRef.current) return;
        recordIdRef.current = rec.id;
        setRecord(rec);
        await adoptConvertRecord(rec);
      } catch (e) {
        setConfirmErr(e instanceof Error ? e.message : M.convert.errors.quoteUnavailable('unknown'));
      } finally {
        confirmBusyRef.current = false;
        setConfirmBusy(false);
      }
      return;
    }
    confirmBusyRef.current = true;
    setConfirmBusy(true); setConfirmErr(null);
    try {
      // Re-quote at the confirm gesture (the IC rule): a moved output gets a review line, never
      // a silent submit on stale digits.
      const fresh = await fetchJupiterQuote(relayUrl, venue, legs.inMint, legs.outMint, amountRaw, slippageBps);
      if (!fresh.ok) {
        setConfirmErr(M.convert.errors.quoteUnreachable(venueName));
        return;
      }
      if (quote != null && fresh.quote.outAmount !== quote.outAmount) {
        setQuote(fresh.quote);
        setQuoteChanged({oldAmt: quote.outAmount, newAmt: fresh.quote.outAmount});
        return;
      }
      const rec = await prepareSolanaConvertRecord({
        secretHex: identity.secretHex,
        relayUrl,
        quote: fresh.quote,
        inAsset: {symbol: legs.inSym, mint: legs.inMint, decimals: legs.inDecimals},
        outAsset: {symbol: legs.outSym, mint: legs.outMint, decimals: legs.outDecimals},
      });
      recordIdRef.current = rec.id;
      setRecord(rec);
      await adoptConvertRecord(rec);
    } catch (e) {
      setConfirmErr(e instanceof Error ? e.message : M.convert.errors.quoteUnavailable('unknown'));
    } finally {
      confirmBusyRef.current = false;
      setConfirmBusy(false);
    }
  };

  // The zero-balance fund gate, Solana side: the SAME shape + copy family as IC — land the
  // asset's own deposit surface (Receive ▸ My address works for Solana rows too), or point at
  // the OTHER leg when the user already holds it there (the pair's other side is the only
  // account that could ever help — the same argument as the IC gate).
  if (legs != null && balanceN === 0n) {
    const otherHeld = !cefiMode && outHeldRaw != null && /^\d+$/.test(outHeldRaw) && BigInt(outHeldRaw) > 0n
      ? fmtAssetCompact(outHeldRaw, legs.outDecimals, legs.outSym)
      : null;
    return (
      <View testID="convert-screen" style={S.convertWrap}>
        <ConvertHeader
          title={cefiMode ? M.convert.heading(legs.inSym, legs.outSym) : M.convert.sol.heading(legs.inSym, legs.outSym)}
          onBack={onBack}
        />
        <InstructionPanel
          testID="convert-fund"
          title={M.pay.fundTitle(legs.inSym)}
          body={M.convert.fundBody(legs.inSym, M.wallet.tab.receive, M.receive.myAddress)}
          primaryLabel={M.pay.showMyAddress(legs.inSym)}
          onPrimary={onShowDepositAddress}
        />
        {otherHeld != null ? (
          <View testID="convert-fund-other">
            <Text testID="convert-fund-other-holds" style={S.convertMetaLine}>
              {M.convert.fundOtherHolds(otherHeld, legs.inSym)}
            </Text>
            {onSwitchAsset ? (
              <Pressable
                testID="btn-convert-fund-other"
                style={S.linkBtn}
                onPress={() => onSwitchAsset(`solana:${legs.outSym}`)}
                accessibilityRole="button"
                accessibilityLabel={M.convert.fundOtherSwitch(legs.outSym)}
                accessibilityState={{disabled: false}}
              >
                <Text style={S.linkText}>{M.convert.fundOtherSwitch(legs.outSym)}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        <View style={S.convertFooting}>
          <IconSwap size={20} color={C.sub} />
        </View>
      </View>
    );
  }

  if (legs == null || venue == null) {
    return (
      <View testID="convert-unavailable" style={S.convertWrap}>
        <ConvertHeader title={M.convert.actionConvert} onBack={onBack} />
        <Text testID="convert-unavailable-title" style={S.convertUnavailableTitle}>
          {M.convert.sol.unavailableTitle(asset.symbol)}
        </Text>
        <Text testID="convert-unavailable-body" style={S.convertUnavailableBody}>
          {M.convert.sol.unavailableBody(asset.symbol, venueName)}
        </Text>
        <View style={S.convertFooting}>
          <IconSwap size={20} color={C.sub} />
        </View>
      </View>
    );
  }

  if (showRecord && record != null) {
    // A provider-shaped record (the CeFi family) renders through the GENERIC StatePanel — its
    // awaiting_deposit handoff, provider_processing and refunded states are rail-agnostic and
    // already know the venue-driven machine; the SOL surface never had its own copy.
    return record.providerRef != null
      ? <StatePanel record={record} onBack={onBack} />
      : <SolStatePanel record={record} onBack={onBack} />;
  }

  const fmtIn = (raw: string) => fmtAssetCompact(raw, legs.inDecimals, legs.inSym);
  const fmtOut = (raw: string) => fmtAssetCompact(raw, legs.outDecimals, legs.outSym);
  const impact = quote?.priceImpactPct ?? null;
  const outEstimate = cefiMode
    ? (cefiQuote != null ? fmtOut(cefiQuote.amountOutGross) : null)
    : (quote != null ? fmtOut(quote.outAmount) : null);
  const outFloor = quote != null && !cefiMode ? fmtOut(quote.otherAmountThreshold) : null;

  return (
    <View testID="convert-screen" style={S.convertWrap}>
      <ConvertHeader
        title={cefiMode ? M.convert.heading(legs.inSym, legs.outSym) : M.convert.sol.heading(legs.inSym, legs.outSym)}
        onBack={onBack}
      />

      <Text style={S.convertAmountLabel}>{M.convert.amountLabel(legs.inSym)}</Text>
      <View style={S.amountRow}>
        <TextInput
          testID="convert-amount"
          style={S.amountInput}
          value={amountText}
          onChangeText={setAmountText}
          keyboardType="decimal-pad"
          autoCorrect={false}
          autoCapitalize="none"
          placeholderTextColor={C.sub}
        />
      </View>
      {balanceRaw != null ? (
        <Text testID="convert-balance" style={S.convertMetaLine}>{M.convert.balanceLine(fmtIn(balanceRaw))}</Text>
      ) : null}
      {insufficient && balanceN != null ? (
        <Text testID="convert-insufficient" style={S.err}>
          {cefiMode
            ? M.convert.cefi.solInsufficientLine(fmtIn(amountN.toString()), fmtIn(balanceN.toString()))
            : M.convert.insufficientLine(fmtIn(amountN.toString()), fmtIn(balanceN.toString()))}
        </Text>
      ) : null}

      {/* The out-destination (spec 2026-09-16 §2 decision 5, widened 2026-09-20): one row per
          DESTINATION ASSET — in-wallet SPL rows and the cefi rows settling onto the IC rail,
          in the venue chooser's own visual language — registry order, explicit pick, never
          chosen for the user. Only when there is a CHOICE: a single destination is a fact of
          the pair, not an option, and renders no chrome. */}
      {destGroups.length > 1 ? (
        <View testID="convert-sol-dest">
          <Text style={S.convertDestLabel}>{M.convert.multihop.destLabel}</Text>
          {destGroups.map(g => {
            const on = activeGroup?.key === g.key;
            const slowCefi = g.mechs[0]?.kind === 'cefi' ? g.mechs[0] : null;
            return (
              <Fragment key={g.key}>
              <Pressable
                testID={g.testID}
                style={[S.convertVenueRow, on && S.convertVenueRowOn]}
                onPress={() => pickDest(g.key)}
                accessibilityRole="radio"
                accessibilityState={{checked: on}}
                accessibilityLabel={g.label}>
                <View style={[S.convertVenueRadio, on && S.convertVenueRadioOn]}>
                  {on ? <View style={S.convertVenueRadioDot} /> : null}
                </View>
                <View style={S.convertVenueRowText}>
                  <Text style={[S.convertVenueName, on && S.convertVenueNameOn]}>{g.label}</Text>
                  {/* Settlement-SLA honesty (2026-09-20), same as the IC chooser. */}
                  {slowCefi != null && slowCefi.venue.health?.status === 'degraded' ? (
                    <Text testID={`convert-sol-dest-cefi-slow-${slowCefi.venue.venue_id}`} style={S.convertMetaLine}>
                      {M.convert.venueSlow}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
              {/* The venue sub-picker for a merged group (the IC surface's convert-dest-mechs,
                  same shape): which SERVICE executes the spot the row names. Registry order,
                  never ranked; the default is the first. */}
              {on && g.mechs.length > 1 ? (
                <View testID="convert-sol-dest-mechs" style={S.convertMechGroup}>
                  {g.mechs.map(m => {
                    const id = solMechKeyOf(m);
                    const mechOn = activeMech != null && solMechKeyOf(activeMech) === id;
                    const mechLabel = m.kind === 'cefi'
                      ? M.convert.multihop.mechViaVenue(m.venue.display_name)
                      : M.convert.multihop.destDirect('SOL');
                    return (
                      <Pressable
                        key={id}
                        testID={`convert-sol-dest-mech-${id}`}
                        style={[S.convertVenueRow, mechOn && S.convertVenueRowOn]}
                        onPress={() => {
                          if (confirmBusy || mechOn) return;
                          setDestMechKey(id);
                          setQuote(null); setQuoteErr(null); setQuoteChanged(null); setQuoteBusy(false); setConfirmErr(null);
                        }}
                        accessibilityRole="radio"
                        accessibilityState={{checked: mechOn}}
                        accessibilityLabel={mechLabel}>
                        <View style={[S.convertVenueRadio, mechOn && S.convertVenueRadioOn]}>
                          {mechOn ? <View style={S.convertVenueRadioDot} /> : null}
                        </View>
                        <View style={S.convertVenueRowText}>
                          <Text style={[S.convertVenueName, mechOn && S.convertVenueNameOn]}>{mechLabel}</Text>
                          {m.kind === 'cefi' && m.venue.health?.status === 'degraded' ? (
                            <Text testID={`convert-sol-dest-mech-slow-${m.venue.venue_id}`} style={S.convertMetaLine}>
                              {M.convert.venueSlow}
                            </Text>
                          ) : null}
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
              </Fragment>
            );
          })}
        </View>
      ) : null}

      {/* The CeFi payout target, shown BEFORE anything is created (the IC surface's exact
          slot): the user's own derived IC principal — read-only, selectable, never typed. */}
      {cefiMode && icSettleAddress != null ? (
        <View>
          <Text style={S.convertAmountLabel}>{M.convert.cefi.settleAddressLabel}</Text>
          <Text testID="convert-settle-address" style={S.convertMetaLine} selectable>{icSettleAddress}</Text>
        </View>
      ) : null}

      {/* The decision number + attribution — the IC headline card's exact shape, carrying the
          venue's OWN digits (Jupiter's outAmount / the cefi settle figure verbatim). The rate
          folds behind the Details control on the checklist card below (10x-verbosity pass
          2026-09-16); the attribution line stays — it is WHOSE number this is. */}
      {outEstimate != null ? (
        <View testID="convert-headline" style={S.convertHeadlineCard}>
          <Text style={S.convertHeadlineLabel}>{M.convert.receiveHeadline}</Text>
          <Text style={S.convertHeadlineAmount}>{outEstimate}</Text>
          <Text testID="convert-quote-source" style={S.convertHeadlineMeta}>
            {M.convert.quoteSource(nonBreakingClock(new Date((cefiMode ? cefiQuote : quote)?.fetchedAtMs ?? 0)), venueName)}
          </Text>
          {staleRefreshing ? (
            <Text testID="convert-stale" style={S.convertHeadlineMeta}>{M.convert.staleRefreshing}</Text>
          ) : null}
        </View>
      ) : null}

      {/* The pre-sign checklist, same rules as IC (10x-verbosity pass 2026-09-16): the main
          surface is the decision — slippage axis, the floor, quote-change warning. The
          venue/fee/signing census folds behind ONE Details control (default CLOSED). The V8
          impact exception still holds — Jupiter DOES publish a price-impact figure — but it
          too is census, not decision, so it lives behind the same control. */}
      <View style={S.convertChecklistCard}>
        {/* A fixed-shift CeFi order has NO slippage axis (its rate is LOCKED at order creation
            — the same reason the IC cefi surface hides this block). */}
        {!cefiMode ? (
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
        {/* The floor is the VENUE'S OWN otherAmountThreshold — Jupiter computed it against the
            chosen slippage; dpay derives nothing here (V8). A cefi order's floor IS its locked
            settle figure — no second number, so no floor line (the IC cefi rule). */}
        {!cefiMode ? (
          <Text testID="convert-min-out" style={S.convertMinOutLine}>
            {M.convert.minReceiveLine(outFloor ?? '', formatBps(slippageBps))}
          </Text>
        ) : null}
        {quoteChanged != null ? (
          <Text testID="convert-quote-changed" style={S.convertChecklistWarn}>
            {M.convert.quoteChanged(fmtOut(quoteChanged.oldAmt), fmtOut(quoteChanged.newAmt))}
          </Text>
        ) : null}
        {/* The one Details control, at the bottom of the decision card. Default CLOSED. */}
        <DetailsToggle
          open={detailsOpen}
          onToggle={() => setDetailsOpen(o => !o)}
          label={M.convert.detailsLabel}
        />
        {detailsOpen ? (
          <View testID="convert-details-block">
            {!cefiMode && quote != null ? (
              <View testID="convert-rate" style={S.convertRateRow}>
                <Text style={S.convertRateLabel}>{M.convert.rateLabel(legs.inSym, legs.outSym)}</Text>
                <Text style={S.convertRateValue}>{fmtAssetCompact(scaledRate(quote.outAmount, quote.inAmount, legs.inDecimals), legs.outDecimals, legs.outSym)}</Text>
              </View>
            ) : null}
            {cefiMode && cefiQuote != null ? (
              <View testID="convert-rate" style={S.convertRateRow}>
                <Text style={S.convertRateLabel}>{M.convert.rateLabel(legs.inSym, legs.outSym)}</Text>
                <Text style={S.convertRateValue}>{fmtAssetCompact(scaledRate(cefiQuote.amountOutGross, cefiQuote.amountIn, legs.inDecimals), legs.outDecimals, legs.outSym)}</Text>
              </View>
            ) : null}
            <View testID="convert-counterparty">
              <Text style={S.convertChecklistLine}>
                {cefiMode ? M.convert.cefi.counterparty(venueName) : M.convert.sol.counterparty(venueName)}
              </Text>
              {/* The IC-side cefi rule: NO pool-principal line — the venue's https API base is
                  where the relay carries the partner key, not a depositor-checkable fact. */}
              {!cefiMode ? (
                <Text testID="convert-pool-principal" style={S.convertPrincipal}>{venue.endpoint}</Text>
              ) : null}
              <Text style={S.convertChecklistLine}>
                {cefiMode ? M.convert.cefi.checklistSigns : M.convert.sol.counterpartySigns}
              </Text>
            </View>
            <Text testID="convert-venue-disclosure" style={S.convertChecklistLine}>
              {venueDisclosure(venue.venue_id)}
            </Text>
            {!cefiMode && impact != null ? (
              <Text testID="convert-sol-impact" style={S.convertChecklistLine}>
                {M.convert.sol.priceImpactLine(impact, venueName)}
              </Text>
            ) : null}
            {/* The refusal consequence (context, not an active error — the active error
                branches never fold). */}
            <Text testID="convert-refusal" style={S.convertChecklistLine}>
              {cefiMode ? M.convert.cefi.refusalLine(legs.inSym) : M.convert.sol.refusalLine(legs.inSym)}
            </Text>
            {/* Fee census, Solana side: the ROUTE's fees are inside the quoted output (Jupiter
                publishes no separate tier through this keyless integration — platformFee null,
                measured 2026-09-14); the network fee is quoted per-tx at prepare and shows on
                the record panels. The old fees-note + dpay line are GONE (10x-verbosity pass
                2026-09-16): the route fee is already inside the quoted number the headline
                shows, and dpay's nothing-charged line lives nowhere on the surface. */}
          </View>
        ) : null}
      </View>

      {quoteErr != null ? (
        <Text testID="convert-quote-err" style={S.err}>{quoteErr}</Text>
      ) : null}
      {confirmErr != null ? (
        <Text testID="convert-confirm-err" style={S.err}>{confirmErr}</Text>
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

/** The Solana record view: the §4 machine's Solana-shaped states only (swapping → settling →
 *  done, with pending_withdrawal/failed_refunded/stuck for the honest edges). Same rules as
 *  StatePanel: it renders the engine's record — the numbers are the venue's own digits, the
 *  payout shown on done is the REALIZED chain credit (never the estimate). */
function SolStatePanel({record, onBack}: {record: ConvertRecord; onBack: () => void}) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (record.step === 'stuck' || record.step === 'pending_withdrawal') {
      const t = setInterval(() => forceTick(n => n + 1), 30_000);
      return () => clearInterval(t);
    }
    return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.step]);

  const venueName = venueDisplayName(record.venueId);
  const outDec = record.outDecimals ?? 8;
  const fmtOut = (raw: string) => fmtAssetCompact(raw, outDec, record.outSymbol);
  const fmtIn = (raw: string) => fmtAssetCompact(raw, record.inDecimals ?? 8, record.inSymbol);
  const solFeeLine = record.solFeeLamports != null
    ? M.convert.sol.solFeeLine(fmtAssetCompact(record.solFeeLamports, SOLANA_TOKENS.SOL.decimals, WRAPPED_SOL_TOKEN))
    : null;

  return (
    <View testID="convert-state" style={S.convertWrap}>
      <ConvertHeader title={M.convert.sol.heading(record.inSymbol, record.outSymbol)} onBack={onBack} />

      {record.step === 'swapping' ? (
        <View testID="convert-swapping">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.swappingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.swappingBody(venueName)}</Text>
        </View>
      ) : null}
      {record.step === 'settling' ? (
        <View testID="convert-settling">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.settlingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.settlingBody(record.outSymbol)}</Text>
        </View>
      ) : null}
      {record.step === 'done' ? (
        <View testID="convert-done">
          <Text style={S.convertStateTitle}>{M.convert.doneTitle}</Text>
          {/* The realized chain credit — the record's outAmountNet (filled by the driver from
              the transaction's own token-balance delta), the venue floor only as the fallback. */}
          <Text style={S.convertStateBody}>{M.convert.doneBody(fmtOut(record.outAmountNet ?? record.expectedNet))}</Text>
          {record.outTx != null ? <Text style={S.convertStateMeta}>{M.convert.doneTx(record.outTx)}</Text> : null}
        </View>
      ) : null}
      {record.step === 'pending_withdrawal' ? (
        <View testID="convert-pending">
          <Text style={S.convertStateTitle}>{M.convert.pendingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.sol.pendingBody}</Text>
          <Text style={S.convertStateMeta}>{M.convert.stillWatching}</Text>
        </View>
      ) : null}
      {record.step === 'failed_refunded' ? (
        <View testID="convert-failed">
          <Text style={S.convertStateTitle}>{M.convert.failedTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.sol.failedBody(record.inSymbol, venueName, record.failureDetail ?? '')}</Text>
        </View>
      ) : null}
      {record.step === 'stuck' ? (
        <View testID="convert-stuck">
          <Text style={S.convertStateTitle}>{M.convert.stuckTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.stuckBody}</Text>
          {/* What was signed, restated: the amount in and the VENUE'S own floor (expectedNet is
              Jupiter's otherAmountThreshold frozen at prepare — not a re-derived figure). */}
          <Text style={S.convertStateBody}>{M.convert.stuckSigned(fmtIn(record.amountIn), fmtOut(record.expectedNet), venueName)}</Text>
          <Text style={S.convertStateMeta}>{M.convert.stuckWatching}</Text>
          {record.acknowledgedStuckAtMs == null ? (
            <Pressable
                testID="btn-convert-stuck-ack"
                style={S.primary}
                onPress={() => {
                  acknowledgeStuckRecord(record.id);
                }}
                accessibilityRole="button"
              >
                <Text style={S.primaryText}>{M.convert.stuckAcknowledge}</Text>
              </Pressable>
            ) : (
              <Text style={S.convertStateMeta}>{M.convert.stuckAcknowledged}</Text>
            )}
        </View>
      ) : null}
      {/* The fee census on every state panel (the IC stuck panel's rule): the realized network
          fee quoted by the chain before signing. dpay's nothing-charged line is GONE everywhere
          (10x-verbosity pass 2026-09-16). */}
      {solFeeLine != null ? (
        <Text testID="convert-sol-fee" style={S.convertMetaLine}>{solFeeLine}</Text>
      ) : null}
      <View style={S.convertFooting}>
        <IconSwap size={20} color={C.sub} />
      </View>
    </View>
  );
}

/** Renders the §4 state-machine record — every non-done state carries practical instructions. */
function StatePanel({record, onBack}: {record: ConvertRecord; onBack: () => void}) {
  const [, forceTick] = useState(0);
  // The gas-fund abort read (2026-09-20): the funding pre-legs CONFIRMED and no main leg has
  // moved — the generic abort flavors would misread this position, so the card says exactly
  // what happened: the gas money is still in the wallet, the conversion never ran.
  const gasPreFundedAborted = (rec: ConvertRecord): boolean => {
    if (rec.step !== 'aborted' || rec.gasPre == null) return false;
    const pre = rec.gasPre.legs.length * 2;
    const plan = rec.legPlan ?? [];
    return plan.slice(0, pre).every(l => l.state === 'confirmed')
      && plan.slice(pre).every(l => l.state === 'pending');
  };
  // Which deposit fact was last copied ('address' | 'memo') — the transient "Copied" label on
  // the CeFi handoff's copy buttons, same pattern as the cross-rail calldata buttons.
  const [copiedDeposit, setCopiedDeposit] = useState<'address' | 'memo' | null>(null);
  // The stuck screen restates what was signed, including the minimum bound. The record no
  // longer persists that figure (V2): it is re-derived by the compiled core from the record's
  // own frozen quote + slippage — the same deterministic arithmetic that computed it at prepare.
  const [minOut, setMinOut] = useState<string | null>(null);
  useEffect(() => {
    if (record.step !== 'stuck') return;
    let cancelled = false;
    convertRecordMinOut(record).then(
      (m) => { if (!cancelled) setMinOut(m); },
      () => { if (!cancelled) setMinOut(null); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id, record.step]);
  // stuck/pending states show when the approval expires — a 30 s tick keeps that line honest.
  useEffect(() => {
    if (record.step !== 'stuck' && record.step !== 'pending_withdrawal') return;
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [record.step]);
  const {inSymbol, outSymbol} = record;
  // Each leg's decimals were frozen at prepare; records older than the field (and every
  // legacy-migrated v1 record) carry none — 8 is the e8s world those were signed in.
  const inDecimals = record.inDecimals ?? 8;
  const outDecimals = record.outDecimals ?? 8;
  // The record's own venue, looked up per V1 — display name and pool principal follow the
  // record, never a module constant.
  const venueName = venueDisplayName(record.venueId);
  const venuePool = venueEndpointOf(record.venueId);
  // Both legs share the prepare-time expiry (the authority death the countdown shows).
  const legExpiryMs = record.legs[0]?.expiresAtMs ?? record.createdAtMs;
  return (
    <View testID="convert-state" style={S.convertWrap}>
      <ConvertHeader title={M.convert.heading(inSymbol, outSymbol)} onBack={onBack} />

      {record.step === 'approving' || record.step === 'approved' ? (
        <View testID="convert-approving">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.approvingTitle}</Text>
          <Text style={S.convertStateBody}>
            {M.convert.approvingBody(fmtAssetCompact(record.amountIn, inDecimals, inSymbol), formatClock(new Date(legExpiryMs)))}
          </Text>
        </View>
      ) : null}
      {record.step === 'swapping' ? (
        <View testID="convert-swapping">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.swappingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.swappingBody(venueName)}</Text>
        </View>
      ) : null}
      {record.step === 'settling' ? (
        <View testID="convert-settling">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.settlingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.settlingBody(outSymbol)}</Text>
        </View>
      ) : null}
      {record.step === 'done' ? (
        <View testID="convert-done">
          <Text style={S.convertStateTitle}>{M.convert.doneTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.doneBody(fmtAssetCompact(record.outAmountNet ?? '0', outDecimals, outSymbol))}</Text>
          {/* A cross-rail payout (the CeFi settle) lands at a destination address on ANOTHER
              rail — the completed panel says which one. Only the cefi provider record carries
              destAddress through THIS panel (planned routes render via RouteStatePanel, cctp
              handoffs via CrossRailStatePanel), so the line fires for exactly that shape. */}
          {record.destAddress != null ? (
            <Text testID="convert-payout-address" style={S.convertStateMeta}>
              {M.convert.cefi.payoutAt(record.destAddress)}
            </Text>
          ) : null}
          {record.outTx != null ? <Text style={S.convertStateMeta}>{M.convert.doneTx(record.outTx)}</Text> : null}
        </View>
      ) : null}
      {record.step === 'pending_withdrawal' ? (
        <View testID="convert-pending">
          <Text style={S.convertStateTitle}>{M.convert.pendingTitle}</Text>
          <Text style={S.convertStateBody}>
            {M.convert.pendingBody(outSymbol, venuePool, formatClock(new Date(record.createdAtMs)))}
          </Text>
          <Text style={S.convertStateMeta}>{M.convert.stillWatching}</Text>
        </View>
      ) : null}
      {/* The user's Stop (2026-09-19): offered while the conversion runs. The flavor picks the
          honest label — a submitted swap keeps its own momentum, so the button says so. */}
      {(record.step === 'approving' || record.step === 'approved' || record.step === 'swapping'
        || record.step === 'settling' || record.step === 'pending_withdrawal') ? (
        <Pressable
          testID="btn-convert-stop"
          style={S.linkBtn}
          onPress={() => {
            void abortConvertRecord(record.id);
          }}
          accessibilityRole="button"
          accessibilityLabel={convertAbortFlavor(record) === 'watching' ? M.convert.stopWatching : M.convert.stop}
          accessibilityState={{disabled: false}}
        >
          <Text style={S.linkText}>
            {convertAbortFlavor(record) === 'watching' ? M.convert.stopWatching : M.convert.stop}
          </Text>
        </Pressable>
      ) : null}
      {record.step === 'aborted' ? (
        <View testID="convert-aborted">
          <Text style={S.convertStateTitle}>{M.convert.abortedTitle}</Text>
          <Text style={S.convertStateBody}>
            {gasPreFundedAborted(record) ? M.convert.crossrail.abortedGasBody
              : convertAbortFlavor(record) === 'watching' ? M.convert.abortedWatching
              : convertAbortFlavor(record) === 'fee' ? M.convert.abortedFee
              : M.convert.abortedClean}
          </Text>
        </View>
      ) : null}
      {record.step === 'failed_refunded' ? (
        <View testID="convert-failed">
          <Text style={S.convertStateTitle}>{M.convert.failedTitle}</Text>
          {record.failureCode === 'approve_refused' ? (
            <Text style={S.convertStateBody}>{M.convert.failedApproveBody(inSymbol)}</Text>
          ) : record.failureCode === 'swap_refused' ? (
            <Text style={S.convertStateBody}>{M.convert.failedSwapBody(record.failureDetail ?? '', inSymbol, venueName)}</Text>
          ) : (
            <Text style={S.convertStateBody}>{M.convert.refundedBody(inSymbol)}</Text>
          )}
          {/* The approval-expiry line renders ONLY where the window is still live
              (10x-verbosity pass 2026-09-16): on failed_refunded the pool has returned the
              funds — the approval window is closed, so the line is noise here. */}
        </View>
      ) : null}
      {record.step === 'stuck' ? (
        <View testID="convert-stuck">
          <Text style={S.convertStateTitle}>{M.convert.stuckTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.stuckBody}</Text>
          {minOut != null ? (
            <Text style={S.convertStateMeta}>
              {M.convert.stuckSigned(fmtAssetCompact(record.amountIn, inDecimals, inSymbol), fmtAssetCompact(minOut, outDecimals, outSymbol), venueName)}
            </Text>
          ) : null}
          <Text testID="convert-expiry" style={S.convertStateMeta}>
            {M.convert.expiryLine(formatClock(new Date(legExpiryMs)))}
          </Text>
          {/* V6: the honest unknown stays WATCHABLE — the engine slow-probes a stuck record until
              it resolves or the USER acknowledges it. The button is the acknowledgement: reading
              the instructions is the user's part; the watch stops only by this gesture. */}
          {record.acknowledgedStuckAtMs == null ? (
            <>
              <Text style={S.convertStateMeta}>{M.convert.stuckWatching}</Text>
              <Pressable
                testID="btn-convert-stuck-ack"
                style={S.linkBtn}
                onPress={() => {
                  void acknowledgeStuckRecord(record.id);
                }}
                accessibilityRole="button"
                accessibilityLabel={M.convert.stuckAcknowledge}
                accessibilityState={{disabled: false}}
              >
                <Text style={S.linkText}>{M.convert.stuckAcknowledge}</Text>
              </Pressable>
            </>
          ) : (
            <Text style={S.convertStateMeta}>{M.convert.stuckAcknowledged}</Text>
          )}
        </View>
      ) : null}
      {/* The provider-held states (V6 drivers): the CeFi record's own venue is a provider, and
          every panel names it, which asset the user holds, and that dpay only WATCHES the
          provider's status — no fabricated progress, no reversal claims. */}
      {record.step === 'awaiting_user_authorization' ? (
        <View testID="convert-awaiting-authorization">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.awaitingAuthTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.awaitingAuthBody(venueName)}</Text>
        </View>
      ) : null}
      {record.step === 'awaiting_deposit' ? (
        <View testID="convert-awaiting-deposit">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.awaitingDepositTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.awaitingDepositBody(inSymbol, venueName)}</Text>
          {/* The CeFi handoff (2026-09-15): the venue's own deposit facts, frozen at order
              creation — the exact address, the exact amount (a fixed shift settles only this
              figure), the memo when the venue issued one, and the order's own expiry. The
              amount goes through the SAME formatter as every other money line (10x-verbosity
              pass audit fix): the venue's decimal string is normalized via
              decimal→raw→fmtAssetCompact, so a padded "3.00000000" renders as "3 ICP" and no
              raw-unit figure can ever leak through raw. The address stays verbatim. This IS
              the value movement: the user sends from their own wallet; dpay signed nothing. */}
          {record.providerDeposit != null ? (
            <View testID="convert-deposit-handoff">
              <Text style={S.convertStateMeta}>{M.convert.cefi.depositNote(venueName, inSymbol)}</Text>
              <Text style={S.convertStateMeta}>{M.convert.cefi.depositAddressLabel}:</Text>
              {/* The address is the ONE thing the user must move verbatim into another wallet —
                  it gets the same machine-data treatment as the cross-rail calldata blocks
                  (mono, boxed), not prose styling. The memo equally: a fixed shift settles only
                  the exact (address, amount, memo) triple. */}
              <Text testID="convert-deposit-address" style={S.convertCalldata} selectable>
                {record.providerDeposit.depositAddress}
              </Text>
              <Pressable
                testID="btn-convert-copy-deposit-address"
                style={S.linkBtn}
                onPress={() => {
                  setCopiedDeposit(null);
                  void copyToClipboard(record.providerDeposit!.depositAddress).then(() => setCopiedDeposit('address'));
                }}
                accessibilityRole="button"
                accessibilityLabel={M.convert.crossrail.copy}>
                <Text style={S.linkText}>{copiedDeposit === 'address' ? M.convert.crossrail.copied : M.convert.crossrail.copy}</Text>
              </Pressable>
              <Text testID="convert-deposit-amount" style={S.convertStateMeta}>
                {M.convert.cefi.depositAmountLabel}: {fmtAssetCompact(toUnits(record.providerDeposit.depositAmount, inDecimals), inDecimals, inSymbol)}
              </Text>
              {/* SOL-side deposit leg (2026-09-20): the user sends an SPL transfer THEMSELVES —
                  its network fee is paid in SOL from the same wallet, a fact the IC-side
                  handoff never had to name. */}
              {solanaTokenOfMint(record.inLedger) != null ? (
                <Text testID="convert-deposit-sol-fee-note" style={S.convertStateMeta}>
                  {M.convert.cefi.depositSolFeeNote}
                </Text>
              ) : null}
              {record.providerDeposit.depositMemo != null ? (
                <>
                  <Text testID="convert-deposit-memo" style={S.convertCalldata} selectable>
                    {M.convert.cefi.depositMemoLabel}: {record.providerDeposit.depositMemo}
                  </Text>
                  <Pressable
                    testID="btn-convert-copy-deposit-memo"
                    style={S.linkBtn}
                    onPress={() => {
                      setCopiedDeposit(null);
                      void copyToClipboard(record.providerDeposit!.depositMemo!).then(() => setCopiedDeposit('memo'));
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={M.convert.crossrail.copy}>
                    <Text style={S.linkText}>{copiedDeposit === 'memo' ? M.convert.crossrail.copied : M.convert.crossrail.copy}</Text>
                  </Pressable>
                </>
              ) : null}
              {record.providerDeposit.expiresAtMs != null ? (
                <Text style={S.convertStateMeta}>
                  {M.convert.cefi.depositExpiryLine(nonBreakingClock(new Date(record.providerDeposit.expiresAtMs)))}
                </Text>
              ) : null}
              {/* The venue's own order id: the one handle support and the user both need
                  when talking to the venue's own status page — visible, not buried. */}
              {record.providerRef != null ? (
                <Text testID="convert-shift-id" style={S.convertStateMeta} selectable>
                  {M.convert.cefi.shiftId(record.providerRef.orderId)}
                </Text>
              ) : null}
              {record.providerRef != null ? (
                <>
                  {/* The calming PAIR (founder escalation 2026-09-20): what is already true,
                      then dpay's commitment — never a "contact support" deflection. */}
                  <Text testID="convert-cefi-settling-note" style={S.convertStateMeta}>
                    {M.convert.cefi.settlingFundsLine}
                  </Text>
                  <Text testID="convert-cefi-settling-watch" style={S.convertStateMeta}>
                    {M.convert.cefi.settlingWatchLine}
                  </Text>
                </>
              ) : null}
            </View>
          ) : null}
          {/* Deposit context says "deposit", never "payout" — the generic watching line belongs
              to the states past the deposit (processing/settling), where a payout is what is
              being watched for. */}
          <Text style={S.convertStateMeta}>{M.convert.cefi.stillWaitingDeposit}</Text>
        </View>
      ) : null}
      {record.step === 'provider_processing' ? (
        <View testID="convert-provider-processing">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.providerProcessingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.providerProcessingBody(outSymbol, venueName)}</Text>
          <Text style={S.convertStateMeta}>{M.convert.stillWatching}</Text>
        </View>
      ) : null}
      {record.step === 'quote_expired' ? (
        <View testID="convert-quote-expired">
          <Text style={S.convertStateTitle}>{M.convert.quoteExpiredTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.quoteExpiredBody(inSymbol, venueName)}</Text>
        </View>
      ) : null}
      {record.step === 'provider_refunded' ? (
        <View testID="convert-provider-refunded">
          <Text style={S.convertStateTitle}>{M.convert.providerRefundedTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.providerRefundedBody(inSymbol, venueName)}</Text>
        </View>
      ) : null}
      <View style={S.convertFooting}>
        <IconSwap size={20} color={C.sub} />
      </View>
    </View>
  );
}

/** The cross-rail record surface (Routes B/C, 2026-09-16): everything after the five IC legs.
 *  The IC phases render exactly like RouteStatePanel's; then the surface splits —
 *  awaiting_external hands the user's OWN wallet the two exact Ethereum transactions (dpay
 *  holds no EVM key and signs nothing here), crossing watches Circle's own status feed until
 *  the mint lands AND is corroborated on-chain at the ATA, and sol_ready offers the final
 *  Jupiter leg on a fresh quote. Every dead-end names where the funds sit (in-wallet ckUSDC,
 *  USDC at the user's own EVM address, or USDC(SOL) at their ATA) and the way out. */
function CrossRailStatePanel({record, secretHex, relayUrl, solLamports, onBack}: {
  record: ConvertRecord;
  secretHex: string;
  relayUrl: string;
  solLamports: string | null;
  onBack: () => void;
}) {
  const cross = record.crossRail;
  const [, forceTick] = useState(0);
  const [handoff, setHandoff] = useState<Awaited<ReturnType<typeof buildCctpHandoff>> | null>(null);
  const [handoffErr, setHandoffErr] = useState<string | null>(null);
  const [burnTxText, setBurnTxText] = useState('');
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachErr, setAttachErr] = useState<string | null>(null);
  const [copiedWhich, setCopiedWhich] = useState<'approve' | 'burn' | null>(null);
  const [solQuote, setSolQuote] = useState<JupiterQuote | null>(null);
  const [solQuoteErr, setSolQuoteErr] = useState<string | null>(null);
  const [crossAmtStr, setCrossAmtStr] = useState('');
  // A tether for async setState after unmount (the same mountedRef discipline the form uses).
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const inDecimals = record.inDecimals ?? 8;
  const hopDecimals = record.hopDecimals ?? record.outDecimals ?? 8;
  const hopSymbol = record.hopSymbol ?? record.outSymbol;
  const destSymbol = record.destSymbol ?? record.outSymbol;
  const venueName = venueDisplayName(record.venueId);
  const solVenueName = venueDisplayName(cross?.solVenueId ?? record.venueId);
  const legExpiryMs = record.legs[0]?.expiresAtMs ?? record.createdAtMs;
  const legStateText = (s: LegPlan['state']) =>
    s === 'pending' ? M.convert.multihop.legStatePending
    : s === 'sent' ? M.convert.multihop.legStateSent
    : s === 'confirmed' ? M.convert.multihop.legStateConfirmed
    : M.convert.multihop.legStateFailed;

  // The long-haul views (crossing, hop watch) stay honest about elapsed time — a 30 s tick.
  useEffect(() => {
    if (record.step !== 'stuck' && record.step !== 'pending_withdrawal' && record.step !== 'crossing') return;
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [record.step]);

  // The crossing amount for the intro line — the AUTHORITATIVE floor (convertRecordMinOut,
  // the same function the executor's numbers come from), never a hand-rolled mirror of it.
  useEffect(() => {
    let live = true;
    convertRecordMinOut(record)
      .then((v) => { if (live && mountedRef.current) setCrossAmtStr(v); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [record.id, record.expectedGross, record.slippageBps]);

  // The handoff bytes: built + fee re-fetched LIVE the moment the surface opens (never a
  // cached copy — the number the user reads is the number the wallet will be asked to sign),
  // and the mint recipient is re-derived and matched against the frozen record first.
  useEffect(() => {
    if (record.step !== 'awaiting_external') return;
    let live = true;
    buildCctpHandoff(secretHex, record)
      .then((h) => { if (live && mountedRef.current) { setHandoff(h); setHandoffErr(null); } })
      .catch((e) => { if (live && mountedRef.current) setHandoffErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [record.step, record.id, secretHex]);

  // The final leg's offer: a FRESH Jupiter quote on the minted amount (never the prepare-time
  // number — minutes may have passed), refreshed whenever the offer surface (re)mounts.
  useEffect(() => {
    if (record.step !== 'sol_ready' || cross == null || cross.mintSubunits == null || cross.solVenueId == null) return;
    const venue = venueOfId(cross.solVenueId);
    if (venue == null) return;
    let live = true;
    fetchJupiterQuote(relayUrl, venue, USDC_MINT_ADDRESS, cross.solOutMint ?? WRAPPED_SOL_MINT_ADDRESS, cross.mintSubunits, record.slippageBps)
      .then((q) => {
        if (!live || !mountedRef.current) return;
        if (q.ok) { setSolQuote(q.quote); setSolQuoteErr(null); }
        else if (q.code === 'refused') setSolQuoteErr(M.convert.errors.quoteRefused(solVenueName));
        else setSolQuoteErr(M.convert.errors.quoteUnavailable(q.code));
      })
      .catch(() => { if (live && mountedRef.current) setSolQuoteErr(M.convert.errors.quoteUnreachable(solVenueName)); });
    return () => { live = false; };
  }, [record.step, record.id, cross?.mintSubunits, cross?.solVenueId, cross?.solOutMint, record.slippageBps]);

  // The attach gesture. Production: the hash the user pasted back from their wallet. Under
  // e2e: if the harness installed a wallet double (__DPAY_TEST_EVM_SIGN), asking IT to sign
  // IS the simulated gesture — the returned hash is what the paste field would have held, and
  // the double also records WHAT dpay asked the wallet to sign (to, calldata, per tx).
  const onAttach = async () => {
    if (attachBusy) return;
    setAttachBusy(true);
    setAttachErr(null);
    try {
      let hash = burnTxText.trim();
      const seam = (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_EVM_SIGN;
      if (typeof seam === 'function' && handoff != null) {
        const signed = await (seam as (txs: unknown) => Promise<string>)({
          approveTo: handoff.burnToken,
          approveCalldata: handoff.approveCalldata,
          burnTo: handoff.tokenMessenger,
          burnCalldata: handoff.burnCalldata,
          amountSubunits: handoff.amountSubunits,
        });
        hash = String(signed).trim();
        if (mountedRef.current) setBurnTxText(hash);
      }
      await attachCctpBurnTx(record.id, hash);
    } catch (e) {
      if (mountedRef.current) setAttachErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setAttachBusy(false);
    }
  };

  if (cross == null) return null; // the render fork only reaches here with a crossRail record

  // The final leg's out units: the record's own frozen decimals when it names an SPL out
  // mint (e.g. EURC's 6), the native-SOL 9 otherwise.
  const solOutDecimals = cross.solOutDecimals ?? SOLANA_TOKENS.SOL.decimals;
  const solFeeKnown = record.solFeeLamports != null && BigInt(record.solFeeLamports) > 0n;
  const solShort = solLamports != null && solLamports.length > 0 && BigInt(solLamports) <= 0n
    && record.step !== 'done' && record.step !== 'failed_refunded' && record.step !== 'failed_leg';
  // doneBody carries its own ${sym} — hand it the BARE number (fmtAssetCompact appends the unit,
  // so pass an empty unit and trim the trailing space it leaves).
  const amountStr = fmtAssetCompact(record.outAmountNet ?? '0',
    cross.kind === 'cctp_sol' ? solOutDecimals : hopDecimals, '').trim();

  return (
    <View testID="convert-crossrail" style={S.convertWrap}>
      <ConvertHeader
        title={routeTitleOf(record, hopSymbol, destSymbol)}
        onBack={onBack}
      />

      {/* The IC phases render exactly as Route A does — same copy, same leg list below. */}
      {record.step === 'approving' ? (
        <View testID="convert-approving">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.multihop.executingTitle}</Text>
          <Text style={S.convertStateBody}>
            {M.convert.approvingBody(fmtAssetCompact(record.amountIn, inDecimals, record.inSymbol), formatClock(new Date(legExpiryMs)))}
          </Text>
        </View>
      ) : null}

      {record.step === 'pending_withdrawal' ? (
        <View testID="convert-pending">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.pendingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.pendingBody(hopSymbol, venueEndpointOf(record.venueId), formatClock(new Date(record.createdAtMs)))}</Text>
          <Text style={S.convertStateMeta}>{M.convert.stillWatching}</Text>
          <Text testID="convert-expiry" style={S.convertStateMeta}>
            {M.convert.expiryLine(formatClock(new Date(legExpiryMs)))}
          </Text>
        </View>
      ) : null}

      {/* THE HANDOFF (spec §3, cross-rail widening): the user's own wallet signs; dpay renders
          the exact bytes, copyable, with the fee re-fetched live and the recipient re-derived. */}
      {record.step === 'awaiting_external' ? (
        <View testID="crossrail-handoff">
          <Text style={S.convertStateTitle}>{M.convert.crossrail.heading}</Text>
          <Text style={S.convertStateBody}>
            {crossAmtStr !== ''
              ? M.convert.crossrail.handoffIntro(fmtAssetCompact(crossAmtStr, hopDecimals, hopSymbol))
              : null}
          </Text>
          {handoff != null ? (
            <>
              <Text testID="crossrail-handoff-amount" style={S.convertChecklistLine}>
                {M.convert.crossrail.txAmountLabel}: {fmtAssetCompact(handoff.amountSubunits, hopDecimals, hopSymbol)}
              </Text>
              <Text style={S.convertChecklistWarn}>{M.convert.crossrail.whatSigning}</Text>
              <Text style={S.convertSlippageLabel}>{M.convert.crossrail.stepApproveLabel}</Text>
              <Text style={S.convertPrincipal}>{handoff.burnToken}</Text>
              <Text testID="crossrail-approve-calldata" style={S.convertCalldata} selectable>{handoff.approveCalldata}</Text>
              <Pressable
                testID="btn-crossrail-copy-approve"
                style={S.linkBtn}
                onPress={() => {
                  setCopiedWhich(null);
                  void copyToClipboard(handoff.approveCalldata).then(() => setCopiedWhich('approve'));
                }}
                accessibilityRole="button"
                accessibilityLabel={M.convert.crossrail.copy}>
                <Text style={S.linkText}>{copiedWhich === 'approve' ? M.convert.crossrail.copied : M.convert.crossrail.copy}</Text>
              </Pressable>
              <Text style={S.convertChecklistLine}>{M.convert.crossrail.approveHint}</Text>
              <Text style={S.convertSlippageLabel}>{M.convert.crossrail.stepBurnLabel}</Text>
              <Text style={S.convertPrincipal}>{handoff.tokenMessenger}</Text>
              <Text testID="crossrail-burn-calldata" style={S.convertCalldata} selectable>{handoff.burnCalldata}</Text>
              <Pressable
                testID="btn-crossrail-copy-burn"
                style={S.linkBtn}
                onPress={() => {
                  setCopiedWhich(null);
                  void copyToClipboard(handoff.burnCalldata).then(() => setCopiedWhich('burn'));
                }}
                accessibilityRole="button"
                accessibilityLabel={M.convert.crossrail.copy}>
                <Text style={S.linkText}>{copiedWhich === 'burn' ? M.convert.crossrail.copied : M.convert.crossrail.copy}</Text>
              </Pressable>
              <Text style={S.convertChecklistLine}>{M.convert.crossrail.burnHint}</Text>
              <Text testID="crossrail-circle-fee" style={S.convertChecklistLine}>
                {M.convert.crossrail.circleFeeLine(fmtAssetCompact(handoff.maxFeeSubunits, hopDecimals, hopSymbol))}
              </Text>
              <Text style={S.convertChecklistLine}>
                {M.convert.crossrail.mintFloorLine(fmtAssetCompact(handoff.mintFloorSubunits, hopDecimals, hopSymbol))}
              </Text>
              <Text style={S.convertChecklistLine}>{M.convert.crossrail.timingNote}</Text>
              <Text testID="crossrail-external-gas" style={S.convertChecklistLine}>{M.convert.crossrail.externalGasLine}</Text>
            </>
          ) : handoffErr != null ? (
            <Text testID="crossrail-handoff-err" style={S.err}>{handoffErr}</Text>
          ) : (
            <ActivityIndicator color={C.sub} />
          )}
          {handoff != null ? (
            <>
              <Text style={S.convertAmountLabel}>{M.convert.crossrail.burnTxLabel}</Text>
              <View style={S.amountRow}>
                <TextInput
                  testID="crossrail-burn-tx"
                  style={S.monoInput}
                  value={burnTxText}
                  onChangeText={setBurnTxText}
                  autoCorrect={false}
                  autoCapitalize="characters"
                  placeholder={M.convert.crossrail.burnTxPlaceholder}
                  placeholderTextColor={C.sub}
                />
              </View>
              <Pressable
                testID="btn-crossrail-attach"
                style={[S.primary, (attachBusy || burnTxText.trim().length === 0) && S.disabledFlat]}
                onPress={() => void onAttach()}
                disabled={attachBusy || burnTxText.trim().length === 0}
                accessibilityRole="button"
                accessibilityLabel={M.convert.crossrail.attachButton}>
                <Text style={S.primaryText}>{M.convert.crossrail.attachButton}</Text>
              </Pressable>
              {/* attachErr carries the thrown validation's own message (today that is only the
                  burn-tx hash shape check) — rendered verbatim, never re-labeled: a future error
                  must not wear the hash-error's clothes. */}
              {attachErr != null ? <Text style={S.err}>{attachErr}</Text> : null}
              <Pressable
                testID="btn-crossrail-decline"
                style={S.linkBtn}
                onPress={() => void declineCctpHandoff(record.id)}
                accessibilityRole="button"
                accessibilityLabel={M.convert.crossrail.declineButton}>
                <Text style={S.linkText}>{M.convert.crossrail.declineButton}</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}

      {/* THE CROSSING: Circle's own status feed, watched by burn tx hash. Pending is PENDING —
          never rendered as failure — and the two links make the wait independently checkable. */}
      {record.step === 'crossing' ? (
        <View testID="crossrail-crossing">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.crossrail.crossingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.crossrail.crossingBody}</Text>
          <Text testID="crossrail-still" style={S.convertStateMeta}>{M.convert.crossrail.stillCrossing}</Text>
          {cross.burnTxHash != null ? (
            <>
              <Text testID="crossrail-burn-hash" style={S.convertPrincipal} selectable>{cross.burnTxHash}</Text>
              <LinkRow testID="btn-crossrail-view-burn" label={M.convert.crossrail.viewBurnTx} href={`https://etherscan.io/tx/${cross.burnTxHash}`} />
            </>
          ) : null}
          <LinkRow testID="btn-crossrail-view-circle" label={M.convert.crossrail.viewCircle} href="https://cctp.cash/" />
        </View>
      ) : null}

      {/* THE FINAL LEG'S OFFER: USDC verified at the ATA; Jupiter re-quoted fresh; keeping the
          USDC is named as an equal outcome, not a consolation. */}
      {record.step === 'sol_ready' ? (
        <View testID="crossrail-sol-ready">
          <Text style={S.convertStateTitle}>{M.convert.crossrail.solReadyTitle}</Text>
          <Text style={S.convertStateBody}>
            {M.convert.crossrail.solReadyBody(fmtAssetCompact(cross.mintSubunits ?? '0', hopDecimals, hopSymbol), cross.mintRecipientAta)}
          </Text>
          {solQuote != null ? (
            <>
              <Text testID="crossrail-sol-quote" style={S.convertChecklistLine}>
                {/* Venue name comes from the RECORD's own frozen registry key (solVenueId, with
                    the record's venue as the type-level fallback), never a hardcoded string — the
                    same locale-invariant attribution rule as every other number on this screen. */}
                {M.convert.crossrail.solQuoteLabel(venueDisplayName(cross.solVenueId ?? record.venueId))}
              </Text>
              <Text testID="crossrail-sol-out" style={S.convertHeadlineAmount}>
                {fmtAssetCompact(solQuote.outAmount, solOutDecimals, destSymbol)}
              </Text>
              <Text style={S.convertChecklistLine}>
                {/* The BARE number + the sym: the copy owns the unit (one owner), and the
                    sym argument renders EURC and SOL through the SAME sentence. */}
                {M.convert.crossrail.solMinLine(fmtAssetCompact(solQuote.otherAmountThreshold, solOutDecimals, '').trim(), destSymbol)}
              </Text>
            </>
          ) : solQuoteErr != null ? (
            <Text testID="crossrail-sol-quote-err" style={S.err}>{solQuoteErr}</Text>
          ) : (
            <ActivityIndicator color={C.sub} />
          )}
          {solShort ? (
            <View testID="crossrail-sol-preflight">
              <Text style={S.convertChecklistWarn}>{M.convert.crossrail.solPreflightTitle}</Text>
              {/* The panel only renders this block when the wallet's measured SOL balance is
                  exactly zero — so it SAYS that, rather than fabricating a dust figure the
                  wallet was never quoted. */}
              <Text style={S.convertChecklistLine}>{M.convert.crossrail.solPreflightBody}</Text>
            </View>
          ) : null}
          <Pressable
            testID="btn-crossrail-sol-confirm"
            style={[S.primary, solQuote == null && S.disabledFlat]}
            onPress={() => void confirmCrossRailSolLeg(record.id)}
            disabled={solQuote == null}
            accessibilityRole="button"
            accessibilityLabel={M.convert.crossrail.solConfirmButton(destSymbol)}>
            <Text style={S.primaryText}>{M.convert.crossrail.solConfirmButton(destSymbol)}</Text>
          </Pressable>
        </View>
      ) : null}

      {/* The final leg running / landing: the device signature exists; the leg list below is
          the progress. */}
      {record.step === 'swapping' || record.step === 'settling' ? (
        <View testID="crossrail-sol-swap">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.multihop.executingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.crossrail.legSolSwap(solVenueName, destSymbol)}</Text>
          {solFeeKnown ? (
            <Text testID="crossrail-sol-fee" style={S.convertChecklistLine}>
              {/* The network fee is paid in SOL whatever the out token is (SOL, EURC) —
                  the fee line's unit is always the gas asset, never the destination. */}
              {M.convert.crossrail.solFeeLine(fmtAssetCompact(record.solFeeLamports!, SOLANA_TOKENS.SOL.decimals, WRAPPED_SOL_TOKEN))}
            </Text>
          ) : null}
        </View>
      ) : null}

      {record.step === 'done' ? (
        <View testID="convert-done">
          <Text style={S.convertStateTitle}>{M.convert.crossrail.doneTitle}</Text>
          <Text style={S.convertStateBody}>
            {M.convert.crossrail.doneBody(amountStr, destSymbol, cross.solAddress)}
          </Text>
          {record.outTx != null ? <Text style={S.convertStateMeta}>{M.convert.doneTx(record.outTx)}</Text> : null}
        </View>
      ) : null}

      {record.step === 'failed_refunded' ? (
        <View testID="convert-failed">
          {record.solanaLeg != null ? (
            /* The SOL leg refused: the USDC ALREADY crossed — the dead-end copy must say so. */
            <>
              <Text style={S.convertStateTitle}>{M.convert.crossrail.solFailedTitle}</Text>
              <Text style={S.convertStateBody}>{M.convert.crossrail.solFailedBody(cross.mintRecipientAta, solVenueName)}</Text>
            </>
          ) : (
            <>
              <Text style={S.convertStateTitle}>{M.convert.failedTitle}</Text>
              {record.failureCode === 'approve_refused' ? (
                <Text style={S.convertStateBody}>{M.convert.failedApproveBody(record.inSymbol)}</Text>
              ) : (
                <Text style={S.convertStateBody}>{M.convert.failedSwapBody(record.failureDetail ?? '', record.inSymbol, venueName)}</Text>
              )}
              {/* No approval-expiry line here: failed_refunded means the window is closed
                  (10x-verbosity pass 2026-09-16); only live windows carry the line. */}
            </>
          )}
        </View>
      ) : null}

      {record.step === 'failed_leg' ? (
        <View testID="convert-failed-leg">
          {record.failureCode === 'external_declined' ? (
            /* The user walked away from the wallet step: nothing crossed; the USDC is at
                their OWN Ethereum address — an address they control, not a dead end. On a
                gas-funded record BOTH stranded assets get their whereabouts named. */
            <>
              <Text style={S.convertStateTitle}>{M.convert.crossrail.declinedTitle}</Text>
              <Text style={S.convertStateBody}>{record.gasPre != null
                ? M.convert.crossrail.declinedWithGasBody(record.destAddress ?? '')
                : M.convert.crossrail.declinedBody(record.destAddress ?? '')}</Text>
            </>
          ) : record.failureCode === 'gas_short' ? (
            /* The funding pre-legs did not deliver (a refusal, or the executor's balance
                re-check came up short): the main conversion never started and every source
                value sits in-wallet — the card names the shortfall as the exit. */
            <>
              <Text style={S.convertStateTitle}>{M.convert.multihop.failedLegTitle}</Text>
              <Text testID="convert-gas-short-failed" style={S.convertStateBody}>
                {M.convert.crossrail.gasShortFailedBody(fmtAssetCompact(record.gasPre?.neededWei ?? '0', record.gasDecimals ?? 18, record.gasSymbol ?? 'ckETH'))}
              </Text>
            </>
          ) : (
            <>
              <Text style={S.convertStateTitle}>{M.convert.multihop.failedLegTitle}</Text>
              <Text style={S.convertStateBody}>{M.convert.multihop.failedLegBody(hopSymbol, record.failureDetail ?? '')}</Text>
              <Text style={S.convertChecklistWarn}>{M.convert.multihop.failedLegExit}</Text>
            </>
          )}
        </View>
      ) : null}

      {record.step === 'stuck' ? (
        <View testID="convert-stuck">
          <Text style={S.convertStateTitle}>{M.convert.stuckTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.multihop.stuckRouteBody}</Text>
          <Text testID="convert-expiry" style={S.convertStateMeta}>
            {M.convert.expiryLine(formatClock(new Date(legExpiryMs)))}
          </Text>
          {record.acknowledgedStuckAtMs == null ? (
            <>
              <Pressable
                testID="btn-convert-stuck-ack"
                style={S.linkBtn}
                onPress={() => { void acknowledgeStuckRecord(record.id); }}
                accessibilityRole="button"
                accessibilityLabel={M.convert.stuckAcknowledge}
                accessibilityState={{disabled: false}}
              >
                <Text style={S.linkText}>{M.convert.stuckAcknowledge}</Text>
              </Pressable>
            </>
          ) : (
            <Text style={S.convertStateMeta}>{M.convert.stuckAcknowledged}</Text>
          )}
        </View>
      ) : null}

      {/* The leg list — same shape as Route A's, extended with the two cross-rail kinds. */}
      <View testID="convert-crossrail-legs" style={S.convertChecklistCard}>
        {record.gasPre != null ? (
          <Text testID="convert-gas-legs-note" style={S.convertStateMeta}>{M.convert.crossrail.gasLegsNote}</Text>
        ) : null}
        {(record.legPlan ?? []).map((lp, i) => {
          const leg = record.legs[i];
          const canister = leg?.canister ?? lp.canister;
          const fee = plannedLegFee(record, lp, canister);
          return (
            <View key={i} testID={`convert-leg-${i}`}>
              <Text style={S.convertChecklistLine}>{plannedLegLabel(record, lp, canister, venueName)}</Text>
              <Text
                testID={`convert-leg-${i}-state`}
                style={lp.state === 'failed' ? [S.convertStateMeta, S.convertLegStateBad] : S.convertStateMeta}>
                {fee != null ? `${legStateText(lp.state)} · ${fee}` : legStateText(lp.state)}
              </Text>
            </View>
          );
        })}
      </View>
      <View style={S.convertFooting}>
        <IconSwap size={20} color={C.sub} />
      </View>
    </View>
  );
}

