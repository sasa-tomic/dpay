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
import {ActivityIndicator, Linking, Pressable, Text, TextInput, View} from 'react-native';
import {isValidDestinationAddress, icpCatalogOf, BUNDLED_NETWORKS, type CurrencyDescriptor} from '../config/catalog';
import type {SelectableAsset} from '../config/assets';
import {
  CONVERT_SLIPPAGE_BPS_DEFAULT,
  CONVERT_SLIPPAGE_BPS_OPTIONS,
  resolveConvertDestinations,
  resolveConvertDirection,
  type ConvertDestination,
  type ConvertRouteOption,
} from '../config/convert';
import {BUNDLED_VENUES, cefiOtherSide, cefiVenuesForLedger, venueDisplayName, venueEndpointOf, venueOfId, venuesForPair, type VenueEntry} from '../config/venues';
import {
  buildCctpHandoff,
  ceFiQuoteFromResult,
  ceFiServiceError,
  convertRecordMinOut,
  deriveConvertMath,
  fetchCeFiConvertQuote,
  fetchConvertQuote,
  fetchCctpBurnFee,
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
  acknowledgeStuckRecord,
  adoptConvertRecord,
  attachCctpBurnTx,
  confirmCrossRailSolLeg,
  convertResumeSnapshot,
  declineCctpHandoff,
  subscribeConvertRecords,
} from '../convertResume';
import {cctpMaxFee, cctpMintFloor} from '../cctp';
import {fetchJupiterQuote, type JupiterQuote} from '../services/jupiter';
import {createSideShiftFixedShift, fetchSideShiftQuote, type SideShiftQuoteResult} from '../services/sideshift';
import {deriveSolanaAddress} from '../solana/identity';
import {fetchGasFeeWei, fetchLedgerFee} from '../services/rail';
import {hubRoutes, multihopRoutesFrom, type HubRoute, type MultihopRoute} from '../routes';
import {solanaVenuesForMint} from '../config/venues';
import {SOLANA_TOKENS, USDC_MINT_ADDRESS, WRAPPED_SOL_MINT_ADDRESS, WRAPPED_SOL_TOKEN} from '../solana/tokens';
import {formatClock} from '../i18n/intl';
import {M} from '../i18n';
import {fmtAssetCompact, parseUserAmount, rawToDecimal, toUnits} from '../lib/format';
import {copyToClipboard} from '../lib/clipboard';
import type {AssetId, Identity} from '../lib/types';
import {C} from '../config/palette';
import {S} from '../styles';
import {IconChevronDown, IconSwap} from './icons';
import {InstructionPanel} from './InstructionPanel';

/** Everything the quote panel needs about the two legs, resolved + validated from the bundled catalog. */
type ConvertLegs = {
  inDesc: CurrencyDescriptor;
  outDesc: CurrencyDescriptor;
  /** The catalog's BACKING symbol for each leg (`backing_symbol`, falling back to `symbol`) — the
   *  same string every other surface shows for that asset. For the PoC pair that is 'ICP' and
   *  'VCHF': VCHF's own backing symbol IS "VCHF", because it is a third party's franc-denominated
   *  token whose peg dpay does not verify, so nothing here may shorten it to "CHF". */
  inSym: string;
  outSym: string;
  inDecimals: number;
  outDecimals: number;
  /** Raw-unit ledger fees straight from the catalog fee fields (never hardcoded literals). */
  inFee: string;
  outFee: string;
};

// --- destination GROUPS (2026-09-18 hub UX guidance D1–D6): the picker shows ONE row per
//     destination ASSET — the direct pair first (the standing default), then every other
//     in-wallet asset, then every external destination. Where a destination is reachable by
//     MORE than one mechanism (direct pool vs via-hub; CCTP vs a CeFi venue — two routes to
//     the same landing spot), selecting the row reveals an indented MECHANISM sub-picker:
//     registry order, direct first, never ranked, nothing preselected beyond that order
//     (the V5 venue rules one level down). Quotes fetch for the SELECTED mechanism only.
/** One user pick in the mechanism sub-picker (what a row resolves to). */
type DestMechPick =
  | {kind: 'direct'}
  | {kind: 'hub'; routeId: string}
  | {kind: 'route'; routeId: string}
  | {kind: 'cefi'; venueId: string};

/** The render-side option behind a mechanism row: the pick plus the object its copy and
 *  its quote flow need. */
type DestMechOption =
  | {kind: 'direct'}
  | {kind: 'hub'; route: HubRoute}
  | {kind: 'route'; route: MultihopRoute}
  | {kind: 'cefi'; venue: VenueEntry};

/** One destination-asset row: a stable identity key, the row's testID, its label, and the
 *  mechanisms that reach it (ONE mechanism = no sub-picker; more = the D2 sub-picker). */
type DestGroup = {
  key: string;
  testID: string;
  label: string;
  mechs: DestMechOption[];
  /** For in-wallet groups: the destination ledger this row resolves to (the direct
   *  mechanism's output leg). Absent for the standing group and external groups. */
  destLedger?: string;
};

const mechPickOf = (m: DestMechOption): DestMechPick =>
  m.kind === 'direct' ? {kind: 'direct'}
  : m.kind === 'hub' ? {kind: 'hub', routeId: m.route.routeId}
  : m.kind === 'route' ? {kind: 'route', routeId: m.route.routeId}
  : {kind: 'cefi', venueId: m.venue.venue_id};

const mechIdOf = (p: DestMechPick): string =>
  p.kind === 'direct' ? 'direct'
  : p.kind === 'cefi' ? p.venueId
  : p.routeId;

/** The D1 destination groups for one asset, in render order: the direct pair (standing
 *  default) first, then every other in-wallet asset, then every external destination.
 *  Mechanisms inside a group keep registry order — direct first, hub/CCTP/CeFi after —
 *  never ranked, nothing preselected beyond that order (V5 one level down). External
 *  routes and CeFi venues that land on the SAME asset merge into ONE group (D4):
 *  USDC-on-Solana via CCTP and via a CeFi venue are two mechanisms, one destination. */
const buildDestGroups = (
  catalog: CurrencyDescriptor[],
  legs: ConvertLegs,
  convDests: ConvertDestination[],
  hubRoutesAll: HubRoute[],
  routes: MultihopRoute[],
  cefiVenues: readonly VenueEntry[],
): DestGroup[] => {
  const inLedger = legs.inDesc.ledger;
  if (inLedger == null) return [];
  const symOf = (row: CurrencyDescriptor): string => row.backing_symbol ?? row.symbol ?? '';
  const optOf = (o: ConvertRouteOption): DestMechOption | null => {
    if (o.kind === 'direct') return {kind: 'direct'};
    const hr = o.kind === 'hub' ? hubRoutesAll.find(r => r.routeId === o.routeId) : null;
    return hr != null ? {kind: 'hub', route: hr} : null;
  };
  const mechsOf = (routes: ConvertRouteOption[]): DestMechOption[] => {
    const mechs: DestMechOption[] = [];
    for (const o of routes) {
      const m = optOf(o);
      if (m != null) mechs.push(m);
    }
    return mechs;
  };
  const groups: DestGroup[] = [];
  const byKey = new Map<string, DestGroup>();
  const push = (g: DestGroup): void => {
    groups.push(g);
    byKey.set(g.key, g);
  };
  // 1 — the STANDING group: the direct pair's other leg, the pinned `convert-dest-direct`
  //     row. Every mechanism that reaches the SAME ledger (its direct venue + any via-hub
  //     route) merges under it, direct first.
  const standing = legs.outDesc;
  const standingDests = convDests.find(d => d.destLedger === standing.ledger)
    ?? ({destLedger: standing.ledger, routes: []} as ConvertDestination);
  push({
    key: 'direct',
    testID: 'convert-dest-direct',
    label: M.convert.multihop.destDirect(symOf(standing)),
    mechs: mechsOf(standingDests.routes),
  });
  // 2 — every OTHER in-wallet destination (direct venue or via-hub — both land here).
  for (const d of convDests) {
    if (d.destLedger === standing.ledger) continue;
    const row = catalog.find(c => c.ledger === d.destLedger);
    if (row == null) continue;
    push({
      key: `ic:${row.currency}`,
      destLedger: d.destLedger,
      testID: `convert-dest-inwallet-${row.currency}`,
      label: M.convert.multihop.destInWallet(symOf(row)),
      mechs: mechsOf(d.routes),
    });
  }
  // 3 — external destinations, merged by where they LAND (`ext:<symbol>:<network>`):
  //     composed routes first (their pinned `convert-dest-route-<routeId>` testIDs are the
  //     group's identity), then CeFi venues folding into an existing landing spot or forming
  //     their own group.
  for (const r of routes) {
    const key = `ext:${r.dest.symbol}:${r.dest.network}`;
    const existing = byKey.get(key);
    if (existing != null) {
      existing.mechs.push({kind: 'route', route: r});
      continue;
    }
    push({
      key,
      testID: `convert-dest-route-${r.routeId}`,
      label: M.convert.multihop.destRoute(r.dest.symbol, r.dest.network),
      mechs: [{kind: 'route', route: r}],
    });
  }
  for (const v of cefiVenues) {
    const mint = cefiOtherSide(v, inLedger);
    if (mint == null) continue;
    const asset = solAssetOfMint(mint);
    if (asset == null) continue;
    const key = `ext:${asset.symbol}:Solana`;
    const existing = byKey.get(key);
    if (existing != null) {
      existing.mechs.push({kind: 'cefi', venue: v});
      continue;
    }
    push({
      key,
      testID: `convert-dest-cefi-${v.venue_id}`,
      label: M.convert.cefi.destRow(asset.symbol, 'Solana', v.display_name),
      mechs: [{kind: 'cefi', venue: v}],
    });
  }
  return groups;
};

/** The hub two-quote fetch (D9/D13): quote1 (from → hub) through the route's own first
 *  venue, quote2 (hub → dest) through the second, SIZED ON math1.minOut — the compounding
 *  floor prepareHubConvertRecord validates (quote2.amountIn === math1.minOut). One helper so
 *  the live fetch, the stale refresh, and the confirm-time re-quote fetch byte-identical
 *  pairs — never two drift-prone copies of the composition. */
const fetchHubQuotes = async (
  relayUrl: string,
  route: HubRoute,
  amountIn: string,
  inFee: string,
  slippageBps: number,
): Promise<{q1: ConvertQuote; m1: ConvertMath; q2: ConvertQuote; m2: ConvertMath}> => {
  const q1 = await fetchConvertQuote(
    relayUrl, route.from.ledger, route.hub.ledger, amountIn,
    {venue: venueOfId(route.legs[0].venueId) ?? undefined},
  );
  const m1 = await deriveConvertMath(q1, inFee, route.hub.fee, slippageBps);
  const q2 = await fetchConvertQuote(
    relayUrl, route.hub.ledger, route.dest.ledger, m1.minOut,
    {venue: venueOfId(route.legs[1].venueId) ?? undefined},
  );
  const m2 = await deriveConvertMath(q2, route.hub.fee, route.dest.fee, slippageBps);
  return {q1, m1, q2, m2};
};

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

/** A record past 'quote'/'confirming' means signed bytes or a provider order exist — the screen
 *  must show state, not a form. The terminal set is app/convert.ts's OWN export — never a
 *  hand-mirrored copy here (the mirror drifted by construction risk; one source of truth). */
const isLiveRecord = (r: ConvertRecord | null): boolean =>
  r !== null && !isTerminalConvertStep(r.step) && r.step !== 'quote' && r.step !== 'confirming';

/** The name of the one registered REAL conversion venue — for the fail-closed panel's honest
 *  "what exists today" copy (a registry lookup, not a literal; the chooser itself renders
 *  whatever `venuesForPair` serves, V5). */
const REGISTERED_VENUE_ID = BUNDLED_VENUES.find(v => v.kind === 'ic_amm' && !v.testnet)?.venue_id ?? '';
const REGISTERED_VENUE_NAME = venueDisplayName(REGISTERED_VENUE_ID);

/** The per-venue disclosure sentence for the pre-sign checklist: the venue registry's OWN
 *  `disclosure_key` picks the copy, and a key the catalog does not carry falls back to the
 *  generic sentence — fail closed: a disclosure always renders, never a blank, never copy that
 *  guesses a venue fact the registry never made. `venueId` is the QUOTE's own attribution (or
 *  the standing registered venue before one arrives). */
const venueDisclosure = (venueId: string): string => {
  const venue = venueOfId(venueId);
  const name = venueDisplayName(venueId);
  const line = venue != null ? M.convert.disclosures.byKey[venue.disclosure_key] : undefined;
  return (line ?? M.convert.disclosures.generic)(name);
};

/** A clock string that must never wrap inside itself: attribution lines end "…fetched 2:59 PM",
 *  and a line break between the time and its meridiem orphans the "PM" onto its own row (the
 *  2026-09-11 chooser screenshot). Every space inside the formatted time becomes a
 *  non-breaking one — the words around it may still wrap, the time never does. */
const nonBreakingClock = (d: Date): string => formatClock(d).replace(/ /g, '\u00A0');

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
  const activeQuote = chooserMode
    ? selectedVenue != null ? venueQuotes[selectedVenue.venue_id] ?? null : null
    : quote;
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
  }, [activeRoute?.routeId, relayUrl, record != null && isLiveRecord(record)]);

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

  const onConfirm = async () => {
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
    // Route mode: the destination address is part of the intent — never signed unvalidated.
    if (activeRoute != null && !isValidDestinationAddress('CkEthErc20', destAddress)) return;
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
        const rec = await prepareMultihopConvertRecord({
          secretHex: identity.secretHex,
          quote: fresh,
          math,
          route: activeRoute,
          destAddress,
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
    if (cefiMode && activeCefiVenue != null && cefiOutMint != null && cefiOut != null && cefiSettleAddress != null) {
      setConfirmBusy(true);
      setConfirmErr(null);
      setQuoteChanged(null);
      try {
        // Same re-quote-at-confirm discipline, on the venue's own quote — but the fresh
        // fetch here returns the QUOTE ID too: the fixed order must be created from the
        // exact quote the reviewed settleAmount came from (SideShift pins quoteId ↔
        // affiliateId ↔ rate together). A moved market is reviewed, never silently ordered.
        let freshRes: SideShiftQuoteResult;
        try {
          freshRes = await fetchSideShiftQuote(
            relayUrl, activeCefiVenue, legs.inDesc.ledger, cefiOutMint,
            rawToDecimal(reviewed.amountIn, legs.inDecimals),
          );
        } catch (e) {
          throw ceFiServiceError(e, activeCefiVenue.display_name);
        }
        const fresh = ceFiQuoteFromResult(
          activeCefiVenue, legs.inDesc.ledger, cefiOutMint, reviewed.amountIn, freshRes, cefiOut.decimals,
        );
        if (fresh.amountOutGross !== reviewed.amountOutGross) {
          setQuote(fresh);
          setQuoteChanged({oldAmt: reviewed.amountOutGross, newAmt: fresh.amountOutGross});
          return;
        }
        // Order creation is CeFi: the DEVICE posts the order body to the relay proxy (the
        // relay attaches the partner credential server-side); the venue answers with its
        // OWN deposit address. The user sends the deposit to the VENUE, never to dpay —
        // the record's providerDeposit block carries exactly that handoff.
        let order;
        try {
          order = await createSideShiftFixedShift(relayUrl, activeCefiVenue, {
            quoteId: freshRes.quoteId,
            settleAddress: cefiSettleAddress,
          });
        } catch (e) {
          throw ceFiServiceError(e, activeCefiVenue.display_name);
        }
        const rec = prepareCeFiConvertRecord({
          quote: fresh,
          order,
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
  // pre-groups surface for every pinned direct flow.
  const effOutDesc = effOut ?? legs.outDesc;
  // The standing leg's own validated fields; an eff row was fail-closed priced by the
  // destination engine (fee/decimals/symbol), and falls back to the standing values —
  // never a literal — so the form's money lines stay ledger-denominated either way.
  const outSym = effOutDesc.backing_symbol ?? effOutDesc.symbol ?? legs.outSym;
  const outDecimals = effOutDesc.decimals ?? legs.outDecimals;
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

  // Nothing to convert at all: the Pay tab's fund-gate shape, pointed at the ONE surface that can
  // fund an IC asset (Receive ▸ My address — reachable from the bottom nav on this very screen).
  if (balanceN === 0n) {
    // The pair's OTHER leg, formatted, iff it holds something. A balance that has not been read
    // (undefined) is not a zero and is not offered — the same fail-open rule the gate above uses.
    const otherRaw = assetBalances[legs.outDesc.currency];
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
        {otherHeld != null ? (
          <View testID="convert-fund-other">
            <Text testID="convert-fund-other-holds" style={S.convertMetaLine}>
              {M.convert.fundOtherHolds(otherHeld, inSym)}
            </Text>
            {onSwitchAsset ? (
              <Pressable
                testID="btn-convert-fund-other"
                style={S.linkBtn}
                onPress={() => onSwitchAsset(`ic:${legs.outDesc.currency}`)}
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
            ? M.convert.multihop.routeHeading(record.inSymbol, hopSymbol, destSymbol, record.destNetwork ?? '')
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

      {/* THE leg list — every leg, its own state, its own fee; the leg that stopped names
          itself by its refusal state. This list is the progress UI the route promised. D14:
          it stays FULLY expanded for hub records — four legs, no folding. */}
      <View testID="convert-route-legs" style={S.convertChecklistCard}>
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
                style={lp.state === 'failed' ? S.err : S.convertStateMeta}>
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
  const destValid = isValidDestinationAddress('CkEthErc20', destAddress);
  const gasBalRaw = activeRoute != null ? assetBalances[activeRoute.burn.gasCurrency] : undefined;
  const gasNeededN = routeGas != null ? BigInt(routeGas.feeWei) + BigInt(routeGas.gasLedgerFee) : null;
  const gasShort = activeRoute != null && gasNeededN != null && gasBalRaw != null && gasBalRaw.length > 0 && BigInt(gasBalRaw) < gasNeededN;
  const gasNeededStr = gasNeededN != null && activeRoute != null
    ? fmtAssetCompact(gasNeededN.toString(), activeRoute.burn.gasDecimals, activeRoute.burn.gasSymbol)
    : null;
  // Hub mode replaces the quote pair entirely: the confirm needs BOTH hops' quotes and math
  // on the table (a half-quoted conversion is not confirmable), and hub mode adds no address,
  // gas, or cross-fee requirements — the destination is the user's own account.
  const hubReady = hubQuote1 != null && hubQuote2 != null && hubMath1 != null && hubMath2 != null;
  const canConfirm = !quoteBusy && !hubBusy && !confirmBusy && !insufficient && !mechUnpicked
    && (hubMode ? hubReady : activeQuote != null && math != null)
    && (!routeMode || (destValid && routeGas != null && routeGasErr == null && !gasShort))
    // Cross-rail routes also need Circle's fee on the table before confirm (fail-closed).
    && (activeRoute == null || activeRoute.crossRail == null || crossFee != null);
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
        <Text testID="convert-balance" style={S.convertMetaLine}>
          {M.convert.balanceLine(balanceStr)}
        </Text>
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
      {destGroups.length > 1 ? (
        <View testID="convert-dest">
          <Text style={S.convertSlippageLabel}>{M.convert.multihop.destLabel}</Text>
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
                            {/* D5: an UNPICKED mechanism carries its label + a static shape
                                line, never another mechanism's live number. */}
                            {!on && m.kind === 'hub' ? (
                              <Text style={S.convertMetaLine}>{M.convert.multihop.viaHub(m.route.hub.symbol)}</Text>
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
          destination's own rule: an address is never signed unvalidated). */}
      {routeMode ? (
        <View>
          <Text style={S.convertAmountLabel}>{M.convert.multihop.destAddressLabel}</Text>
          <View style={S.amountRow}>
            <TextInput
              testID="convert-dest-address"
              style={S.amountInput}
              value={destAddress}
              onChangeText={setDestAddress}
              autoCorrect={false}
              autoCapitalize="characters"
              placeholderTextColor={C.sub}
            />
          </View>
          {destAddress.length > 0 && !isValidDestinationAddress('CkEthErc20', destAddress) ? (
            <Text testID="convert-dest-address-invalid" style={S.err}>{M.convert.multihop.destAddressInvalid}</Text>
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
          anything is signed — the requirement, the minimum, and the honest path (this build
          cannot buy the slice for you). An unknown balance never blocks: the number is re-checked
          against the minter's live quote at confirm, and prepare refuses if it still fails. */}
      {routeMode && gasShort && gasNeededStr != null ? (
        <View testID="convert-gas-preflight">
          <Text style={S.convertChecklistWarn}>{M.convert.multihop.gasPreflightTitle}</Text>
          <Text style={S.convertChecklistLine}>{M.convert.multihop.gasPreflightBody(gasNeededStr)}</Text>
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
function solAssetOfMint(mint: string): {symbol: string; decimals: number} | null {
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
function resolveSolDestinations(asset: Extract<SelectableAsset, {protocol: 'solana'}>): {
  inMint: string;
  dests: {venue: VenueEntry; outMint: string; outSym: string; outDecimals: number}[];
} | null {
  // Native SOL is mint:null in the asset model but WRAPPED-sol in the venue registry — the two
  // identifiers for the same asset, translated here and only here.
  const inMint = asset.mint ?? WRAPPED_SOL_MINT_ADDRESS;
  const inTok = solAssetOfMint(inMint);
  if (inTok == null) return null;
  const dests: {venue: VenueEntry; outMint: string; outSym: string; outDecimals: number}[] = [];
  const seen = new Set<string>();
  for (const venue of solanaVenuesForMint(inMint)) {
    const outMint = venue.pair_ledgers.find(m => m !== inMint);
    if (outMint == null || seen.has(outMint)) continue;
    const outTok = solAssetOfMint(outMint);
    if (outTok == null) continue;
    seen.add(outMint);
    dests.push({venue, outMint, outSym: outTok.symbol, outDecimals: outTok.decimals});
  }
  return {inMint, dests};
}

/** The Solana analog of `resolveLegs`: the legs the SELECTED venue serves — the venue's own
 *  registry row names the pair, the OTHER side of `pair_ledgers` is the destination. Null when
 *  no venue is selected (zero destinations — the fail-closed panel renders). */
function resolveSolLegs(asset: Extract<SelectableAsset, {protocol: 'solana'}>, venue: VenueEntry | null): {
  inMint: string;
  outMint: string;
  inSym: string;
  outSym: string;
  inDecimals: number;
  outDecimals: number;
} | null {
  const inMint = asset.mint ?? WRAPPED_SOL_MINT_ADDRESS;
  if (venue == null) return null;
  const outMint = venue.pair_ledgers.find(m => m !== inMint);
  if (outMint == null) return null;
  const inTok = solAssetOfMint(inMint);
  const outTok = solAssetOfMint(outMint);
  if (inTok == null || outTok == null) return null;
  return {inMint, outMint, inSym: inTok.symbol, outSym: outTok.symbol, inDecimals: inTok.decimals, outDecimals: outTok.decimals};
}

type SolConvertProps = {
  identity: Identity;
  /** The active relay — the Jupiter quote/swap dials go through it (2026-09-16). */
  relayUrl: string;
  asset: Extract<SelectableAsset, {protocol: 'solana'}>;
  solana: {sol: string | null; tokens: Record<string, string | null>};
  onBack: () => void;
  onShowDepositAddress: () => void;
  onSwitchAsset?: (id: AssetId) => void;
};

function SolConvertMode({identity, relayUrl, asset, solana, onBack, onShowDepositAddress, onSwitchAsset}: SolConvertProps) {
  const [amountText, setAmountText] = useState('');
  const [slippageBps, setSlippageBps] = useState<number>(CONVERT_SLIPPAGE_BPS_DEFAULT);
  const [quote, setQuote] = useState<JupiterQuote | null>(null);
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

  // --- the destination (spec 2026-09-16 §2 decision 5): every registered solana_amm venue for
  //     this mint is one out option — registry order, deduped by out mint, never ranked. The
  //     DEFAULT is the FIRST option: the exact pair this surface served before a second venue
  //     existed, so a one-venue mint renders no chooser chrome and behaves exactly as before.
  //     A switch resets the quote + its review state (the amount stays — the user's number is
  //     not the venue's business).
  const inMint = asset.mint ?? WRAPPED_SOL_MINT_ADDRESS;
  const [destVenueId, setDestVenueId] = useState<string | null>(null);
  const [destMint, setDestMint] = useState<string | null>(null);
  if (destMint !== inMint) {
    // The pick is per-mint state — a different asset re-derives the default (render-phase
    // adjustment: set during render when a prop changed the fact the state is keyed on).
    setDestMint(inMint);
    setDestVenueId(null);
  }
  const solDests = resolveSolDestinations(asset);
  const destVenues: {venue: VenueEntry; outSym: string}[] = [];
  if (solDests != null) {
    for (const d of solDests.dests) destVenues.push({venue: d.venue, outSym: d.outSym});
  }
  const activeDest = destVenues.find(x => x.venue.venue_id === destVenueId) ?? destVenues[0] ?? null;
  const venue = activeDest?.venue ?? null;
  const legs = venue != null ? resolveSolLegs(asset, venue) : null;
  const venueName = venue != null ? venueDisplayName(venue.venue_id) : venueDisplayName('jupiter');

  const pickDest = (venueId: string) => {
    // Frozen while a confirm is in flight: the in-flight confirm closes over THIS pair, and its
    // late setQuote/setQuoteChanged must never land under the newly picked pair's heading.
    if (venueId === destVenueId || confirmBusy) return;
    setDestVenueId(venueId);
    setQuote(null); setQuoteErr(null); setQuoteChanged(null); setQuoteBusy(false); setConfirmErr(null);
  };
  const balanceRaw = legs == null ? null : legs.inMint === WRAPPED_SOL_MINT_ADDRESS ? solana.sol : solana.tokens[legs.inMint] ?? null;
  const outHeldRaw = legs == null ? null : legs.outMint === WRAPPED_SOL_MINT_ADDRESS ? solana.sol : solana.tokens[legs.outMint] ?? null;

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
  // Jupiter's route + threshold are computed against it, so a changed chip must re-ask the venue.
  useEffect(() => {
    if (legs == null || venue == null || showRecord) return;
    const parsed = parseUserAmount(amountText, legs.inDecimals);
    if (!parsed.ok || parsed.raw === '0') {
      setQuote(null); setQuoteErr(null); setQuoteBusy(false); setQuoteChanged(null);
      return;
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
  }, [amountText, legs?.inMint, legs?.outMint, slippageBps, showRecord]);

  // --- stale refresh (same 30s clock + test seam as IC; keeps the OLD quote on failure).
  useEffect(() => {
    if (legs == null || venue == null || quote == null || showRecord) return;
    const tick = setInterval(() => {
      if (!isQuoteStale(quote)) return;
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
  }, [quote, slippageBps, showRecord]);

  const parsedAmount = parseUserAmount(amountText, legs != null ? legs.inDecimals : 0);
  const amountRaw = parsedAmount.ok ? parsedAmount.raw : null;
  const balanceN = balanceRaw != null && /^\d+$/.test(balanceRaw) ? BigInt(balanceRaw) : null;
  const amountN = amountRaw != null && /^\d+$/.test(amountRaw) ? BigInt(amountRaw) : 0n;
  // The venue tx's network fee is paid in SOL on top of the swapped amount — when SOL is the
  // INPUT the honest available figure is the balance itself (the fee lives under the same SOL;
  // a dust edge fails on-chain and lands in the honest failure state, never a false pass).
  const insufficient = legs != null && amountN > 0n && balanceN != null && amountN > balanceN;
  const canConfirm = legs != null && quote != null && !quoteBusy && !confirmBusy && !insufficient && amountN > 0n;

  const onConfirm = async () => {
    if (confirmBusyRef.current) return; // sync latch: a duplicate press before the re-render is a no-op
    if (legs == null || venue == null || amountRaw == null) return;
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
    const otherHeld = outHeldRaw != null && /^\d+$/.test(outHeldRaw) && BigInt(outHeldRaw) > 0n
      ? fmtAssetCompact(outHeldRaw, legs.outDecimals, legs.outSym)
      : null;
    return (
      <View testID="convert-screen" style={S.convertWrap}>
        <ConvertHeader title={M.convert.sol.heading(legs.inSym, legs.outSym)} onBack={onBack} />
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
    return <SolStatePanel record={record} onBack={onBack} />;
  }

  const fmtIn = (raw: string) => fmtAssetCompact(raw, legs.inDecimals, legs.inSym);
  const fmtOut = (raw: string) => fmtAssetCompact(raw, legs.outDecimals, legs.outSym);
  const impact = quote?.priceImpactPct ?? null;
  const outEstimate = quote != null ? fmtOut(quote.outAmount) : null;
  const outFloor = quote != null ? fmtOut(quote.otherAmountThreshold) : null;

  return (
    <View testID="convert-screen" style={S.convertWrap}>
      <ConvertHeader title={M.convert.sol.heading(legs.inSym, legs.outSym)} onBack={onBack} />

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
          {M.convert.insufficientLine(fmtIn(amountN.toString()), fmtIn(balanceN.toString()))}
        </Text>
      ) : null}

      {/* The out-destination (spec 2026-09-16 §2 decision 5): one row per registered venue for
          this mint, in the venue chooser's own visual language — registry order, explicit pick,
          never chosen for the user. Only when there is a CHOICE: a single venue's destination is
          a fact of the pair, not an option, and renders no chrome. */}
      {destVenues.length > 1 ? (
        <View testID="convert-sol-dest">
          <Text style={S.convertSlippageLabel}>{M.convert.multihop.destLabel}</Text>
          {destVenues.map(x => {
            const on = venue?.venue_id === x.venue.venue_id;
            return (
              <Pressable
                key={x.venue.venue_id}
                testID={`convert-sol-dest-${x.outSym}`}
                style={[S.convertVenueRow, on && S.convertVenueRowOn]}
                onPress={() => pickDest(x.venue.venue_id)}
                accessibilityRole="radio"
                accessibilityState={{checked: on}}
                accessibilityLabel={M.convert.multihop.destDirect(x.outSym)}>
                <View style={[S.convertVenueRadio, on && S.convertVenueRadioOn]}>
                  {on ? <View style={S.convertVenueRadioDot} /> : null}
                </View>
                <View style={S.convertVenueRowText}>
                  <Text style={[S.convertVenueName, on && S.convertVenueNameOn]}>
                    {M.convert.multihop.destDirect(x.outSym)}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {/* The decision number + attribution — the IC headline card's exact shape, carrying
          Jupiter's OWN digits (outAmount verbatim). The rate folds behind the Details control
          on the checklist card below (10x-verbosity pass 2026-09-16); the attribution line
          stays — it is WHOSE number this is. */}
      {quote != null ? (
        <View testID="convert-headline" style={S.convertHeadlineCard}>
          <Text style={S.convertHeadlineLabel}>{M.convert.receiveHeadline}</Text>
          <Text style={S.convertHeadlineAmount}>{outEstimate}</Text>
          <Text testID="convert-quote-source" style={S.convertHeadlineMeta}>
            {M.convert.quoteSource(nonBreakingClock(new Date(quote.fetchedAtMs)), venueName)}
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
        {/* The floor is the VENUE'S OWN otherAmountThreshold — Jupiter computed it against the
            chosen slippage; dpay derives nothing here (V8). */}
        <Text testID="convert-min-out" style={S.convertMinOutLine}>
          {M.convert.minReceiveLine(outFloor ?? '', formatBps(slippageBps))}
        </Text>
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
            {quote != null ? (
              <View testID="convert-rate" style={S.convertRateRow}>
                <Text style={S.convertRateLabel}>{M.convert.rateLabel(legs.inSym, legs.outSym)}</Text>
                <Text style={S.convertRateValue}>{fmtAssetCompact(scaledRate(quote.outAmount, quote.inAmount, legs.inDecimals), legs.outDecimals, legs.outSym)}</Text>
              </View>
            ) : null}
            <View testID="convert-counterparty">
              <Text style={S.convertChecklistLine}>{M.convert.sol.counterparty(venueName)}</Text>
              <Text testID="convert-pool-principal" style={S.convertPrincipal}>{venue.endpoint}</Text>
              <Text style={S.convertChecklistLine}>{M.convert.sol.counterpartySigns}</Text>
            </View>
            <Text testID="convert-venue-disclosure" style={S.convertChecklistLine}>
              {venueDisclosure(venue.venue_id)}
            </Text>
            {impact != null ? (
              <Text testID="convert-sol-impact" style={S.convertChecklistLine}>
                {M.convert.sol.priceImpactLine(impact, venueName)}
              </Text>
            ) : null}
            {/* The refusal consequence (context, not an active error — the active error
                branches never fold). */}
            <Text testID="convert-refusal" style={S.convertChecklistLine}>
              {M.convert.sol.refusalLine(legs.inSym)}
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

/** Shared header: back chevron + screen title (the same shape the mode surfaces use). */
function ConvertHeader({title, onBack}: {title: string; onBack: () => void}) {

  return (
    <View style={S.routeHeaderRow}>
      <Pressable testID="btn-convert-back" onPress={onBack} accessibilityRole="button" accessibilityLabel={M.convert.backToWallet}>
        <IconChevronDown size={26} color={C.ink} />
      </Pressable>
      <Text style={S.routeHeaderTitle}>{title}</Text>
      <View style={S.routeHeaderSpacer} />
    </View>
  );
}

/** The ONE Details disclosure control (10x-verbosity pass 2026-09-16): a quiet full-width
 *  row at the bottom of the decision card that expands the venue/fee/signing census behind
 *  it. Default CLOSED for everyone — no "verbose mode" split. The chevron names the
 *  direction the tap moves you (the same rule as every chevron in the app), so it flips
 *  when open. */
function DetailsToggle({open, onToggle, label, testID = 'convert-details'}: {open: boolean; onToggle: () => void; label: string; testID?: string}) {
  return (
    <Pressable
      testID={testID}
      style={S.convertDetailsToggle}
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{expanded: open}}
      accessibilityLabel={label}>
      <Text style={S.convertDetailsToggleText}>{label}</Text>
      <View style={open ? S.convertDetailsChevronOpen : undefined}>
        <IconChevronDown size={16} color={C.sub} />
      </View>
    </Pressable>
  );
}

/** The fail-closed panel: same entry point for every asset, honest copy for everything venue-less. */

// The what-exists-today pair list is DERIVED from the bundled mainnet ic_amm registry —
// never hardcoded, so the next venue registration re-words this copy for free (the 2026-09-16
// lesson: the 9ceee43 registration added a pool but the sentence stayed stale until a flow
// caught it). Unique unordered pairs in registry first-appearance order, each named by the
// display symbols the asset rows themselves render (`backing_symbol ?? symbol` — resolveLegs'
// own rule), joined "A, B and C". A pair whose ledgers the bundled catalog cannot name is
// skipped, never invented.
const CONVERTED_PAIR_LABEL: string = (() => {
  const symbolOf = new Map<string, string>();
  for (const r of icpCatalogOf(BUNDLED_NETWORKS)) {
    if (r.testnet || r.ledger === '') continue;
    const sym = r.backing_symbol ?? r.symbol;
    if (sym != null) symbolOf.set(r.ledger, sym);
  }
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const v of BUNDLED_VENUES) {
    if (v.kind !== 'ic_amm' || v.testnet) continue;
    const [a, b] = v.pair_ledgers;
    const key = [a, b].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const sa = symbolOf.get(a);
    const sb = symbolOf.get(b);
    if (sa != null && sb != null) labels.push(`${sa} ↔ ${sb}`);
  }
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
})();

function UnavailablePanel({selectedAsset, onBack}: {selectedAsset: SelectableAsset | null; onBack: () => void}) {
  // SelectableAsset.symbol already carries the backing display name (CHF for VCHF, ICP for ICP,
  // USDC for ckUSDC) — the same symbol every other surface shows for the row.
  const label = selectedAsset == null ? '' : selectedAsset.symbol;
  return (
    <View testID="convert-unavailable" style={S.convertWrap}>
      <ConvertHeader title={M.convert.actionConvert} onBack={onBack} />
      <Text testID="convert-unavailable-title" style={S.convertUnavailableTitle}>
        {M.convert.unavailableTitle(label)}
      </Text>
      <Text testID="convert-unavailable-body" style={S.convertUnavailableBody}>
        {M.convert.unavailableBody(CONVERTED_PAIR_LABEL, REGISTERED_VENUE_NAME)}
      </Text>
      <View style={S.convertFooting}>
        <IconSwap size={20} color={C.sub} />
      </View>
    </View>
  );
}

/** Renders the §4 state-machine record — every non-done state carries practical instructions. */
function StatePanel({record, onBack}: {record: ConvertRecord; onBack: () => void}) {
  const [, forceTick] = useState(0);
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

/** Resolve the two legs from the bundled catalog; null when the selected asset has no venue or the
 *  catalog row is too incomplete to display honestly (fail closed — never guessed, never defaulted). */
function resolveLegs(catalog: CurrencyDescriptor[], asset: Extract<SelectableAsset, {protocol: 'ic'}>): ConvertLegs | null {
  const inDesc = catalog.find((c) => c.currency === asset.currency);
  if (inDesc == null || inDesc.ledger == null) return null;
  const direction = resolveConvertDirection(inDesc.ledger, inDesc.testnet);
  if (direction == null) return null;
  const outDesc = catalog.find((c) => c.ledger === direction.otherLedger);
  if (outDesc == null) return null;
  const inSym = inDesc.backing_symbol ?? inDesc.symbol;
  const outSym = outDesc.backing_symbol ?? outDesc.symbol;
  if (inSym == null || outSym == null) return null;
  if (inDesc.decimals == null || outDesc.decimals == null) return null;
  if (inDesc.fee == null || outDesc.fee == null) return null;
  return {
    inDesc,
    outDesc,
    inSym,
    outSym,
    inDecimals: inDesc.decimals,
    outDecimals: outDesc.decimals,
    inFee: inDesc.fee,
    outFee: outDesc.fee,
  };
}

/** price(out) per 1 DISPLAY unit of in, as raw units at the OUTPUT ledger's own scale, via BigInt
 *  (exact, floor): (out_raw / in_raw) × 10^inDecimals. The caller renders it with
 *  fmtAssetCompact(…, outDecimals, outSym). With equal decimals (every IC pair, 8/8) this is the
 *  plain ratio the IC card always had; 9→6 (SOL→USDC) needs the IN scale named — a one-scale
 *  formula reads 1000× off on cross-decimal pairs. */
function scaledRate(outGross: string, amountIn: string, inDecimals: number): string {
  const out = BigInt(outGross);
  const inn = BigInt(amountIn);
  if (inn <= 0n) return '0';
  return ((out * 10n ** BigInt(inDecimals)) / inn).toString();
}

/** The venue's own fee tier, in ITS unit (millionths of the trade: 3000 = 0.30%), rendered as a
 *  percentage. Never fewer than 2 decimals (0.30%, not 0.3%) and never more precision lost than
 *  the venue published — a fee tier is the pool's fact, so rounding it would be a claim. */
function formatMillionthsPct(millionths: number): string {
  return `${(millionths / 10_000).toFixed(4).replace(/(\.\d{2}\d*?)0+$/, '$1')}%`;
}

/** bps → a display percentage ('0.50%', '1%', '3%', '12.40%'). */
function formatBps(bps: number): string {
  const pct = bps / 100;
  const s = pct % 1 === 0 ? String(pct) : pct.toFixed(2);
  return `${s}%`;
}

/** One planned leg's label — the kind + the leg's own canister decide the copy, never the
 *  position alone (the two asset approves differ by WHICH asset they unlock). */
function plannedLegLabel(record: ConvertRecord, lp: LegPlan, legCanister: string, venueName: string, swapOrdinal = 0): string {
  if (lp.kind === 'sol_swap') {
    // The final Jupiter leg names ITS own venue (the cross-rail record's venueId is the IC
    // swap venue — the sol venue id is frozen on the crossRail block at prepare).
    return M.convert.crossrail.legSolSwap(venueDisplayName(record.crossRail?.solVenueId ?? record.venueId), record.destSymbol ?? record.outSymbol);
  }
  if (lp.kind === 'cctp_burn') {
    return M.convert.crossrail.legCctpBurn(record.hopSymbol ?? record.outSymbol, record.destNetwork ?? '');
  }
  if (lp.kind === 'swap') {
    // Hub records run TWO swap legs (D14, same leg vocabulary parameterised per hop):
    // the second names venue2 and lands the DESTINATION asset in this wallet.
    if (record.venue2Id != null && swapOrdinal >= 1) {
      return M.convert.multihop.legSwap(
        venueDisplayName(record.venue2Id),
        record.hopSymbol ?? record.outSymbol,
        record.destSymbol ?? record.outSymbol);
    }
    return M.convert.multihop.legSwap(venueName, record.inSymbol, record.hopSymbol ?? record.outSymbol);
  }
  if (lp.kind === 'approve') {
    if (legCanister === record.inLedger) {
      return M.convert.multihop.legApprovePull(record.inSymbol);
    }
    // Hub leg 3 approves the DESTINATION pool's pull of the hub asset — a plain pool
    // approval on the hub ledger, never the burn-side wording.
    if (record.venue2Id != null && record.hopLedger != null && legCanister === record.hopLedger) {
      return M.convert.multihop.legApprovePull(record.hopSymbol ?? record.outSymbol);
    }
    return M.convert.multihop.legApproveBurn(record.hopSymbol ?? record.outSymbol);
  }
  if (lp.kind === 'approve_gas') {
    return M.convert.multihop.legApproveGas(record.gasSymbol ?? 'ckETH');
  }
  return M.convert.multihop.legWithdraw(record.hopSymbol ?? record.outSymbol, record.destSymbol ?? record.outSymbol, record.destNetwork ?? '');
}

/** A leg's own fee, formatted in the FEE'S ledger's units (approve legs pay their ledger's
 *  fee; the swap leg's cost is the pool tier, shown in the census, not here; the withdraw leg
 *  charges none — its cost is the gas leg above it). The EXTERNAL legs pay no IC fee: the
 *  cctp_burn leg's own cost is Circle's published fee (frozen on the record at prepare) and
 *  the sol_swap leg's is the Solana message fee (frozen when the leg was signed). */
function plannedLegFee(record: ConvertRecord, lp: LegPlan, legCanister: string): string | null {
  if (lp.kind === 'cctp_burn') {
    const maxFee = record.crossRail?.maxFeeSubunits;
    return maxFee != null
      ? fmtAssetCompact(maxFee, record.hopDecimals ?? record.outDecimals ?? 6, record.hopSymbol ?? record.outSymbol)
      : null;
  }
  if (lp.kind === 'sol_swap') {
    return record.solFeeLamports != null
      ? fmtAssetCompact(record.solFeeLamports, SOLANA_TOKENS.SOL.decimals, WRAPPED_SOL_TOKEN)
      : null;
  }
  if (lp.fee === '') return null;
  if (lp.kind === 'approve') {
    return legCanister === record.inLedger
      ? fmtAssetCompact(lp.fee, record.inDecimals ?? 8, record.inSymbol)
      : fmtAssetCompact(lp.fee, record.hopDecimals ?? record.outDecimals ?? 8, record.hopSymbol ?? record.outSymbol);
  }
  if (lp.kind === 'approve_gas') {
    return fmtAssetCompact(lp.fee, record.gasDecimals ?? 18, record.gasSymbol ?? 'ckETH');
  }
  return null;
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
    fetchJupiterQuote(relayUrl, venue, USDC_MINT_ADDRESS, WRAPPED_SOL_MINT_ADDRESS, cross.mintSubunits, record.slippageBps)
      .then((q) => {
        if (!live || !mountedRef.current) return;
        if (q.ok) { setSolQuote(q.quote); setSolQuoteErr(null); }
        else if (q.code === 'refused') setSolQuoteErr(M.convert.errors.quoteRefused(solVenueName));
        else setSolQuoteErr(M.convert.errors.quoteUnavailable(q.code));
      })
      .catch(() => { if (live && mountedRef.current) setSolQuoteErr(M.convert.errors.quoteUnreachable(solVenueName)); });
    return () => { live = false; };
  }, [record.step, record.id, cross?.mintSubunits, cross?.solVenueId, record.slippageBps]);

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

  const solFeeKnown = record.solFeeLamports != null && BigInt(record.solFeeLamports) > 0n;
  const solShort = solLamports != null && solLamports.length > 0 && BigInt(solLamports) <= 0n
    && record.step !== 'done' && record.step !== 'failed_refunded' && record.step !== 'failed_leg';
  // doneBody carries its own ${sym} — hand it the BARE number (fmtAssetCompact appends the unit,
  // so pass an empty unit and trim the trailing space it leaves).
  const amountStr = fmtAssetCompact(record.outAmountNet ?? '0',
    cross.kind === 'cctp_sol' ? SOLANA_TOKENS.SOL.decimals : hopDecimals, '').trim();

  return (
    <View testID="convert-crossrail" style={S.convertWrap}>
      <ConvertHeader
        title={M.convert.multihop.routeHeading(record.inSymbol, hopSymbol, destSymbol, record.destNetwork ?? '')}
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
                  style={S.amountInput}
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
                {fmtAssetCompact(solQuote.outAmount, SOLANA_TOKENS.SOL.decimals, destSymbol)}
              </Text>
              <Text style={S.convertChecklistLine}>
                {M.convert.crossrail.solMinLine(fmtAssetCompact(solQuote.otherAmountThreshold, SOLANA_TOKENS.SOL.decimals, destSymbol))}
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
            accessibilityLabel={M.convert.crossrail.solConfirmButton}>
            <Text style={S.primaryText}>{M.convert.crossrail.solConfirmButton}</Text>
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
              {M.convert.crossrail.solFeeLine(fmtAssetCompact(record.solFeeLamports!, SOLANA_TOKENS.SOL.decimals, destSymbol))}
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
                their OWN Ethereum address — an address they control, not a dead end. */
            <>
              <Text style={S.convertStateTitle}>{M.convert.crossrail.declinedTitle}</Text>
              <Text style={S.convertStateBody}>{M.convert.crossrail.declinedBody(record.destAddress ?? '')}</Text>
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
              <Text style={S.convertStateMeta}>{M.convert.stuckWatching}</Text>
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
        {(record.legPlan ?? []).map((lp, i) => {
          const leg = record.legs[i];
          const canister = leg?.canister ?? lp.canister;
          const fee = plannedLegFee(record, lp, canister);
          return (
            <View key={i} testID={`convert-leg-${i}`}>
              <Text style={S.convertChecklistLine}>{plannedLegLabel(record, lp, canister, venueName)}</Text>
              <Text
                testID={`convert-leg-${i}-state`}
                style={lp.state === 'failed' ? S.err : S.convertStateMeta}>
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

/** A plain external link row (Etherscan / Circle status) — Linking.openURL is the same OS
 *  path Settings' privacy link and the Trust fund button already use; inert nowhere. */
function LinkRow({testID, label, href}: {testID: string; label: string; href: string}) {
  return (
    <Pressable
      testID={testID}
      style={S.linkBtn}
      onPress={() => { Linking.openURL(href).catch(() => undefined); }}
      accessibilityRole="link"
      accessibilityLabel={label}>
      <Text style={S.linkText}>{label}</Text>
    </Pressable>
  );
}
