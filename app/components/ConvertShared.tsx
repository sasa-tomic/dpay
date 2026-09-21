// ConvertShared — the conversion surface's shared types, helpers, and chrome. Extracted
// verbatim from ConvertMode.tsx (2026-09-21 decomposition): every component here is rendered by
// more than one conversion surface (the IC form, the route/hub/cross-rail record views, the
// Solana surface), so it lives exactly once. The venue fail-closed constants stay in
// ConvertMode.tsx (the IC form owns them); this file reads REGISTERED_VENUE_NAME from there.
import {Linking, Pressable, Text, View} from 'react-native';
import {icpCatalogOf, BUNDLED_NETWORKS, type CurrencyDescriptor} from '../config/catalog';
import type {SelectableAsset} from '../config/assets';
import {resolveConvertDestinations, type ConvertDestination, type ConvertRouteOption} from '../config/convert';
import {BUNDLED_VENUES, cefiOtherSide, venueDisplayName, venueOfId, type VenueEntry} from '../config/venues';
import {deriveConvertMath, fetchConvertQuote, isTerminalConvertStep, type ConvertMath, type ConvertQuote, type ConvertRecord, type LegPlan} from '../convert';
import type {HubRoute, MultihopRoute} from '../routes';
import {SOLANA_TOKENS, WRAPPED_SOL_TOKEN} from '../solana/tokens';
import {formatClock} from '../i18n/intl';
import {M} from '../i18n';
import {fmtAssetCompact} from '../lib/format';
import {C} from '../config/palette';
import {S} from '../styles';
import {IconChevronDown, IconSwap} from './icons';
import {REGISTERED_VENUE_NAME} from './ConvertMode';
import {solAssetOfMint} from './ConvertSolDest';

/** Everything the quote panel needs about the two legs, resolved + validated from the bundled catalog. */
export type ConvertLegs = {
  inDesc: CurrencyDescriptor;
  /** The STANDING pair's other leg — null for a hub-only asset (it converts with no direct
   *  pair; every rendered number names the SELECTED destination instead). */
  outDesc: CurrencyDescriptor | null;
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
export type DestMechPick =
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
export type DestGroup = {
  key: string;
  testID: string;
  label: string;
  mechs: DestMechOption[];
  /** For in-wallet groups: the destination ledger this row resolves to (the direct
   *  mechanism's output leg). Absent for the standing group and external groups. */
  destLedger?: string;
};

export const mechPickOf = (m: DestMechOption): DestMechPick =>
  m.kind === 'direct' ? {kind: 'direct'}
  : m.kind === 'hub' ? {kind: 'hub', routeId: m.route.routeId}
  : m.kind === 'route' ? {kind: 'route', routeId: m.route.routeId}
  : {kind: 'cefi', venueId: m.venue.venue_id};

export const mechIdOf = (p: DestMechPick): string =>
  p.kind === 'direct' ? 'direct'
  : p.kind === 'cefi' ? p.venueId
  : p.routeId;

/** The D1 destination groups for one asset, in render order: the direct pair (standing
 *  default) first, then every other in-wallet asset, then every external destination.
 *  Mechanisms inside a group keep registry order — direct first, hub/CCTP/CeFi after —
 *  never ranked, nothing preselected beyond that order (V5 one level down). External
 *  routes and CeFi venues that land on the SAME asset merge into ONE group (D4):
 *  USDC-on-Solana via CCTP and via a CeFi venue are two mechanisms, one destination. */
export const buildDestGroups = (
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
  //     route) merges under it, direct first. A hub-only asset has NO direct pair — no
  //     standing row exists; its destinations render as plain in-wallet rows (D2).
  if (legs.outDesc != null) {
    const standing = legs.outDesc;
    const standingDests = convDests.find(d => d.destLedger === standing.ledger)
      ?? ({destLedger: standing.ledger, routes: []} as ConvertDestination);
    push({
      key: 'direct',
      testID: 'convert-dest-direct',
      label: M.convert.multihop.destDirect(symOf(standing)),
      mechs: mechsOf(standingDests.routes),
    });
  }
  // 2 — every OTHER in-wallet destination (direct venue or via-hub — both land here).
  for (const d of convDests) {
    if (legs.outDesc != null && d.destLedger === legs.outDesc.ledger) continue;
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
export const fetchHubQuotes = async (
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

/** A record past 'quote'/'confirming' means signed bytes or a provider order exist — the screen
 *  must show state, not a form. The terminal set is app/convert.ts's OWN export — never a
 *  hand-mirrored copy here (the mirror drifted by construction risk; one source of truth). */
export const isLiveRecord = (r: ConvertRecord | null): boolean =>
  r !== null && !isTerminalConvertStep(r.step) && r.step !== 'quote' && r.step !== 'confirming';

/** The per-venue disclosure sentence for the pre-sign checklist: the venue registry's OWN
 *  `disclosure_key` picks the copy, and a key the catalog does not carry falls back to the
 *  generic sentence — fail closed: a disclosure always renders, never a blank, never copy that
 *  guesses a venue fact the registry never made. `venueId` is the QUOTE's own attribution (or
 *  the standing registered venue before one arrives). */
export const venueDisclosure = (venueId: string): string => {
  const venue = venueOfId(venueId);
  const name = venueDisplayName(venueId);
  const line = venue != null ? M.convert.disclosures.byKey[venue.disclosure_key] : undefined;
  return (line ?? M.convert.disclosures.generic)(name);
};

/** A clock string that must never wrap inside itself: attribution lines end "…fetched 2:59 PM",
 *  and a line break between the time and its meridiem orphans the "PM" onto its own row (the
 *  2026-09-11 chooser screenshot). Every space inside the formatted time becomes a
 *  non-breaking one — the words around it may still wrap, the time never does. */
export const nonBreakingClock = (d: Date): string => formatClock(d).replace(/ /g, '\u00A0');

/** Shared header: back chevron + screen title (the same shape the mode surfaces use). */
export function ConvertHeader({title, onBack}: {title: string; onBack: () => void}) {

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
export function DetailsToggle({open, onToggle, label, testID = 'convert-details'}: {open: boolean; onToggle: () => void; label: string; testID?: string}) {
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

export function UnavailablePanel({selectedAsset, onBack}: {selectedAsset: SelectableAsset | null; onBack: () => void}) {
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

/** Resolve the two legs from the bundled catalog; null when the selected asset has no venue or the
 *  catalog row is too incomplete to display honestly (fail closed — never guessed, never defaulted). */
export function resolveLegs(catalog: CurrencyDescriptor[], asset: Extract<SelectableAsset, {protocol: 'ic'}>): ConvertLegs | null {
  const inDesc = catalog.find((c) => c.currency === asset.currency);
  if (inDesc == null || inDesc.ledger == null) return null;
  // The entry gate (2026-09-18 hub widening): an asset converts when it has AT LEAST ONE
  // destination — a direct pool pair OR any hub route (registry-derived, fail-closed on the
  // same bar the engine prices at). A venue-less asset keeps the derived unavailable copy.
  const dests = resolveConvertDestinations(inDesc.ledger, inDesc.testnet);
  if (dests.length === 0) return null;
  const inSym = inDesc.backing_symbol ?? inDesc.symbol;
  if (inSym == null || inDesc.decimals == null || inDesc.fee == null) return null;
  // The standing output leg is the FIRST direct destination, where one exists. A hub-only
  // asset (ckETH today: hub-reachable from VCHF/ckUSDC, no direct venue) converts with NO
  // standing out leg — the out* fields below carry the input row's own facts as inert
  // fallbacks; no direct surface renders without a direct row, and every number such a
  // screen shows names the selected hub destination.
  const standing = dests.find((d) => d.routes.some((r) => r.kind === 'direct'));
  const outDesc = standing != null
    ? catalog.find((c) => c.ledger === standing.destLedger) ?? null
    : null;
  const outSym = outDesc?.backing_symbol ?? outDesc?.symbol ?? null;
  if (outDesc != null && (outSym == null || outDesc.decimals == null || outDesc.fee == null)) return null;
  return {
    inDesc,
    outDesc,
    inSym,
    outSym: outSym ?? inSym,
    inDecimals: inDesc.decimals,
    outDecimals: outDesc?.decimals ?? inDesc.decimals,
    inFee: inDesc.fee,
    outFee: outDesc?.fee ?? inDesc.fee,
  };
}

/** price(out) per 1 DISPLAY unit of in, as raw units at the OUTPUT ledger's own scale, via BigInt
 *  (exact, floor): (out_raw / in_raw) × 10^inDecimals. The caller renders it with
 *  fmtAssetCompact(…, outDecimals, outSym). With equal decimals (every IC pair, 8/8) this is the
 *  plain ratio the IC card always had; 9→6 (SOL→USDC) needs the IN scale named — a one-scale
 *  formula reads 1000× off on cross-decimal pairs. */
export function scaledRate(outGross: string, amountIn: string, inDecimals: number): string {
  const out = BigInt(outGross);
  const inn = BigInt(amountIn);
  if (inn <= 0n) return '0';
  return ((out * 10n ** BigInt(inDecimals)) / inn).toString();
}

/** The venue's own fee tier, in ITS unit (millionths of the trade: 3000 = 0.30%), rendered as a
 *  percentage. Never fewer than 2 decimals (0.30%, not 0.3%) and never more precision lost than
 *  the venue published — a fee tier is the pool's fact, so rounding it would be a claim. */
export function formatMillionthsPct(millionths: number): string {
  return `${(millionths / 10_000).toFixed(4).replace(/(\.\d{2}\d*?)0+$/, '$1')}%`;
}

/** bps → a display percentage ('0.50%', '1%', '3%', '12.40%'). */
export function formatBps(bps: number): string {
  const pct = bps / 100;
  const s = pct % 1 === 0 ? String(pct) : pct.toFixed(2);
  return `${s}%`;
}

/** One planned leg's label — the kind + the leg's own canister decide the copy, never the
 *  position alone (the two asset approves differ by WHICH asset they unlock). */
/** F1 (2026-09-18 hub UX §e): a same-asset hop is not a three-leg route — "Route: ICP → USDC →
 *  USDC on Ethereum" duplicated the symbol and hung a delivery network off what reads like a
 *  receipt. Say the through-route and the landing place instead. Hub records never route here:
 *  their header is the plain selection heading, decided at the call site. */
export function routeTitleOf(record: ConvertRecord, hopSymbol: string, destSymbol: string): string {
  return hopSymbol === destSymbol
    ? M.convert.multihop.routeHeadingCollapsed(record.inSymbol, hopSymbol, record.destNetwork ?? '')
    : M.convert.multihop.routeHeading(record.inSymbol, hopSymbol, destSymbol, record.destNetwork ?? '');
}

export function plannedLegLabel(record: ConvertRecord, lp: LegPlan, legCanister: string, venueName: string, swapOrdinal = 0): string {
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
export function plannedLegFee(record: ConvertRecord, lp: LegPlan, legCanister: string): string | null {
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


/** A plain external link row (Etherscan / Circle status) — Linking.openURL is the same OS
 *  path Settings' privacy link and the Trust fund button already use; inert nowhere. */
export function LinkRow({testID, label, href}: {testID: string; label: string; href: string}) {
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
