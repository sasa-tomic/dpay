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
import {useEffect, useMemo, useRef, useState} from 'react';
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
  CeFiNoQuoteError,
  ceFiQuoteFromResult,
  createCeFiOrder,
  fetchCeFiQuoteResult,
  type CeFiQuoteResult,
  ceFiServiceError,
  deriveConvertMath,
  fetchCeFiConvertQuote,
  fetchConvertQuote,
  fetchCctpBurnFee,
  gasFundNeededWei,
  isQuoteStale,
  loadVenueRegistry,
  prepareCeFiConvertRecord,
  prepareConvertRecord,
  prepareHubConvertRecord,
  prepareMultihopConvertRecord,
  TERMINAL_CONVERT_STEPS,
  type ConvertMath,
  type ConvertQuote,
  type ConvertRecord,
} from '../convert';
import {
  adoptConvertRecord,
  convertResumeSnapshot,
  subscribeConvertRecords,
} from '../convertResume';
import {cctpMaxFee, cctpMintFloor, fetchEthBalance} from '../cctp';
import {DpayCore} from '../services/native';
import {fetchJupiterQuote} from '../services/jupiter';
import {USDC_MINT_ADDRESS} from '../solana/tokens';
import {deriveSolanaAddress} from '../solana/identity';
import {fetchGasFeeWei, fetchLedgerFee} from '../services/rail';
import {hubRoutes, multihopRoutesFrom, gasFundRoutes, type HubRoute, type MultihopRoute} from '../routes';
import {M} from '../i18n';
import {fmtAssetCompact, parseUserAmount, randNonceHex, rawToDecimal} from '../lib/format';
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
  groupDestSections,
  isLiveRecord,
  mechIdOf,
  mechPickOf,
  nonBreakingClock,
  resolveLegs,
  scaledRate,
  UnavailablePanel,
  venueDisclosure,
  type ConvertLegs,
  type DestGroup,
  type DestMechPick,
} from './ConvertShared';
import {currencyName} from '../config/currency';
import {StatePanel} from './ConvertStatePanel';
import {RouteStatePanel} from './ConvertRouteStatePanel';
import {CrossRailStatePanel} from './ConvertCrossRailStatePanel';
import {solAssetOfMint} from './ConvertSolDest';
import {SolConvertMode} from './SolConvertMode';

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

export function ConvertMode(props: Props) {
  const {identity, relayUrl, catalog, selectedAsset, onBack, onShowDepositAddress, onSwitchAsset, solana} = props;
  // THE V11 DISPATCH: every asset gets the same Convert gesture (uniform IA); the rail picks the
  // surface. A Solana asset renders the Solana branch (Jupiter, through the relay proxy) with the
  // same transparency rules; everything below is the IC rail unchanged. When no Solana venue
  // serves the asset the branch itself fails closed with honest copy (never a blank form).
  // The dispatcher carries NO hooks: in the monolith the SOL early-return sat ABOVE the IC form's
  // useStates — a latent rules-of-hooks hazard (an asset switch on a mounted instance would flip
  // the hook count). Both branches now render hook-consistent components, so every mount's hook
  // order is legal by construction; no conditional-hooks pattern anywhere.
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
  return <ConvertModeIc {...props} />;
}

// The IC form: the delegated-conversion surface for IC assets (venue checklist, destination
// groups, hub/CCTP/CeFi confirm flows). Verbatim body of the pre-split ConvertMode minus the
// SOL dispatch that moved up into the hooks-free dispatcher above.
function ConvertModeIc({identity, relayUrl, catalog, selectedAsset, assetBalances, onBack, onShowDepositAddress, onSwitchAsset, solana}: Props) {
  const [amountText, setAmountText] = useState('');
  const [slippageBps, setSlippageBps] = useState<number>(CONVERT_SLIPPAGE_BPS_DEFAULT);
  const [quote, setQuote] = useState<ConvertQuote | null>(null);
  const [math, setMath] = useState<ConvertMath | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  // The venue's own listed-but-unquoted verdict (CeFi no-quote, 2026-09-22): NOT an error —
  // when set, the surface renders the attributed no-market line instead of the red quote
  // error. The two are mutually exclusive; every quoteErr write below clears this.
  const [noQuoteVenue, setNoQuoteVenue] = useState<string | null>(null);
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
  // Route C's review-time destination estimate (founder clarity fix, 2026-09-22): the raw
  // Jupiter out-amount (subunits) the mint floor would land as at the destination. NULL is
  // the honest "no estimate yet / fetch failed" — the line is simply absent, never an error.
  const [destEstimate, setDestEstimate] = useState<string | null>(null);
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
      setNoQuoteVenue(null);
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
      setNoQuoteVenue(null);
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
        setNoQuoteVenue(null);
        return;
      }
      let cancelled = false;
      setQuoteBusy(true);
      setQuoteErr(null);
      setNoQuoteVenue(null);
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
            // The venue's OWN listed-but-unquoted verdict is a state, not a failure: it
            // renders as the attributed no-market line, never the red quote error.
            if (e instanceof CeFiNoQuoteError) {
              setQuoteErr(null);
              setNoQuoteVenue(e.venueName);
            } else {
              setNoQuoteVenue(null);
              setQuoteErr(e instanceof Error ? e.message : String(e));
            }
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
      setNoQuoteVenue(null);
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
            setNoQuoteVenue(null);
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
      setNoQuoteVenue(null);
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
    setNoQuoteVenue(null);
    void (async () => {
      try {
        const q = await fetchConvertQuote(relayUrl, legs.inDesc.ledger, effOut!.ledger, parsed.raw);
        if (!cancelled && mountedRef.current) setQuote(q);
      } catch (e) {
        if (!cancelled && mountedRef.current) {
          setQuote(null);
          setNoQuoteVenue(null);
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
  //     CEFI MODE IS EXEMPT (2026-09-22 partner agreement, organic-demand discipline): the
  //     venue's rate is fetched when the screen opens and re-fetched when the amount changes
  //     (and again at the confirm gesture, which mints the order's own locked quote) — NEVER
  //     on a timer. An interval re-quote is machine-generated demand against the partner-key
  //     proxy, exactly the traffic class the agreement forbids; the confirm-time re-quote
  //     remains the user's execution protection (a moved market is reviewed THERE).
  useEffect(() => {
    if (quote == null || legs == null || isLiveRecord(record) || chooserMode || cefiMode) return;
    const id = setInterval(() => {
      if (!mountedRef.current || staleRefreshing || !isQuoteStale(quote)) return;
      setStaleRefreshing(true);
      void (async () => {
        try {
          // IC-AMM pairs only now — the cefi surface never reaches this effect (the gate
          // above); the refresh rides the plain swap_quote path with the route's own venue.
          const fresh = await fetchConvertQuote(
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
  }, [quote?.fetchedAtMs, quote?.amountIn, staleRefreshing, legs?.inDesc.ledger, effOut?.ledger, relayUrl, record != null && isLiveRecord(record), chooserMode, cefiMode, activeRoute?.routeId, activeRoute?.hop.ledger, destMech, mechUnpicked, selGroup?.key, hubMode]);

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
          setNoQuoteVenue(null);
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

  // --- Route C's review-time destination estimate (founder clarity fix, 2026-09-22): the
  //     review numbers name the HOP asset (USDC), so the destination's own figure is a
  //     Jupiter quote for the mint FLOOR (crossFee.floor USDC → the route's out mint) — the
  //     same machinery the sol_ready final leg quotes with, sized on the floor not the
  //     verified credit (there is no credit yet; this is an estimate, labeled as one).
  //     EVENT-DRIVEN ONLY: it re-keys on the floor (which re-keys on the quote/amount via
  //     the crossFee effect) and the route — NO interval, NO polling. Fail-soft by
  //     construction: fetch error, refusal, or timeout → the line is simply absent; it can
  //     never block review or raise an error UI. Single-flight via the cancelled-flag
  //     cleanup: a superseded fetch is dropped, never a late overwrite.
  useEffect(() => {
    const sol = activeRoute?.crossRail?.sol;
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
        // fetchJupiterQuote resolves to the honest-failure union (never throws), but the
        // catch keeps the fail-soft promise airtight even against a transport surprise.
        const q = await fetchJupiterQuote(relayUrl, venue, USDC_MINT_ADDRESS, sol.outMint, crossFee.floor, slippageBps);
        if (!cancelled && mountedRef.current) setDestEstimate(q.ok ? q.quote.outAmount : null);
      } catch {
        if (!cancelled && mountedRef.current) setDestEstimate(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // slippageBps deliberately NOT a dependency: the floor re-key already bakes it in
    // (crossFee re-derives from math.minOut, which is slippage-sized).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoute?.routeId, crossFee?.floor, relayUrl, record != null && isLiveRecord(record)]);

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
        // The record id is minted BEFORE the order (the trade's clientOrderId — see below).
        const cefiRecordId = randNonceHex();
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
            // The partner agreement's correlation field (Trocador family, 2026-09-22): the
            // record id is minted NOW, before the order exists, so the locally persisted
            // record and the relay's logged clientOrderId are the SAME id. The sideshift
            // family's order body has no such field and ignores it.
            clientOrderId: cefiRecordId,
          }, CONVERT_CEFI_CONFIRM_TIMEOUT_MS);
        } catch (e) {
          throw ceFiServiceError(e, activeCefiVenue.display_name);
        }
        const rec = prepareCeFiConvertRecord({
          id: cefiRecordId,
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
        {/* The ⇄ footing affordance is deliberately NOT rendered here: with a zero balance there
            is nothing to swap yet, and the icon floated alone in the dead space under the fund
            gate. It stays on every FILLED state (the form's own footing below, the state panels),
            which render through the main return, never this early return. */}
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
          until a mechanism is picked (the venue chooser's red lines, one level down).
          Since 2026-09 the rows sit under CURRENCY section headers (`groupDestSections`,
          presentation only): the home currencies first in their fixed order, then the tail of
          destinations that settle no home currency. A header NAMES the destination currency —
          it is a label, never a total; the row order inside a section is exactly
          `buildDestGroups`' registry order, and no row is preselected by the grouping. */}
      {destGroups.length > 0 ? (
        <View testID="convert-dest">
          <Text style={S.convertDestLabel}>{M.convert.multihop.destLabel}</Text>
          {groupDestSections(destGroups, catalog, legs).map(sec => {
            const slug = sec.currency === null ? 'other' : sec.currency.toLowerCase();
            return (
              <View key={`dest-section-${slug}`}>
                <Text testID={`convert-dest-group-${slug}`} style={S.convertDestGroupLabel}>
                  {sec.currency === null ? M.convert.multihop.destGroupOther : currencyName(sec.currency)}
                </Text>
                {sec.groups.map(g => {
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
                    {/* The full venue chain, named in one line (founder clarity fix
                        2026-09-22): registry display names on both ends, Circle's crossing
                        in the middle — Route C only (Route B has no final venue). */}
                    {activeRoute.crossRail.sol != null ? (
                      <Text testID="convert-route-venues" style={S.convertChecklistLine}>
                        {M.convert.multihop.routeVenues(
                          venueDisplayName(activeRoute.swapVenueId),
                          venueDisplayName(activeRoute.crossRail.sol.venueId),
                        )}
                      </Text>
                    ) : null}
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
                        {/* The floor line reads USDC as the MID-STOP on a Route C (a final
                            Jupiter step swaps it onward); Route B's USDC IS the outcome at
                            the address, so it keeps the arrives-here phrasing. The BARE
                            number + symbol: the copy owns the unit (solMinLine's rule). */}
                        <Text testID="crossrail-mint-floor" style={S.convertChecklistLine}>
                          {activeRoute.crossRail.sol != null
                            ? M.convert.crossrail.mintFloorLine(fmtAssetCompact(crossFee.floor, dispOutDecimals, '').trim(), dispOutSym)
                            : M.convert.crossrail.mintFloorDestLine(fmtAssetCompact(crossFee.floor, dispOutDecimals, '').trim(), dispOutSym)}
                        </Text>
                        {/* The destination's own estimate (founder clarity fix 2026-09-22):
                            what the floor would land as after the final Jupiter leg, from
                            the SAME quote machinery the final leg runs. Fail-soft — absent
                            until it fetches, never an error, never a gate. */}
                        {activeRoute.crossRail.sol != null && destEstimate != null ? (
                          <Text testID="crossrail-dest-estimate" style={S.convertChecklistLine}>
                            {M.convert.multihop.routeDestEstimate(
                              fmtAssetCompact(destEstimate, activeRoute.crossRail.sol.outDecimals, '').trim(),
                              activeRoute.dest.symbol,
                            )}
                          </Text>
                        ) : null}
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

      {/* The CeFi no-quote verdict (listed but unquoted): a STATE, not an error — the
          attributed line names the venue, says nothing was sent, and names the way out. */}
      {noQuoteVenue != null ? (
        <View testID="convert-no-quote">
          <Text style={S.convertChecklistWarn}>{M.convert.cefi.noQuoteTitle}</Text>
          <Text style={S.convertChecklistLine}>{M.convert.cefi.noQuoteBody(noQuoteVenue)}</Text>
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
