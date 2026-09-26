// ConvertShared — the conversion surface's shared types, helpers, and chrome. Extracted
// verbatim from ConvertMode.tsx (2026-09-21 decomposition): every component here is rendered by
// more than one conversion surface (the IC form, the route/hub/cross-rail record views, the
// Solana surface), so it lives exactly once. The venue fail-closed constants stay in
// ConvertMode.tsx (the IC form owns them); this file reads REGISTERED_VENUE_NAME from there.
import {useState} from 'react';
import {Linking, Pressable, Text, View} from 'react-native';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import type {SelectableAsset} from '../config/assets';
import {BUNDLED_VENUES, venueDisplayName, venueOfId} from '../config/venues';
import {deriveConvertMath, fetchConvertQuote, isTerminalConvertStep, type ConvertMath, type ConvertQuote, type ConvertRecord, type LegPlan} from '../convert';
import type {HubRoute} from '../routes';
import {SOLANA_TOKENS, WRAPPED_SOL_TOKEN} from '../solana/tokens';
import {formatClock} from '../i18n/intl';
import {M} from '../i18n';
import {fmtAssetCompact} from '../lib/format';
import {C} from '../config/palette';
import {S} from '../styles';
import {IconChevronDown, IconChevronLeft, IconSwap} from './icons';

/** The name of the one registered REAL conversion venue — for the fail-closed panel's honest
 *  "what exists today" copy (a registry lookup, not a literal; the venue area itself renders
 *  whatever the registry serves, V5). Lives here (shared chrome) since the 2026-09-24 swap
 *  screen folded the per-rail surfaces into one. */
export const REGISTERED_VENUE_NAME: string = (() => {
  const id = BUNDLED_VENUES.find(v => v.kind === 'ic_amm' && !v.testnet)?.venue_id ?? '';
  return venueDisplayName(id);
})();

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

/** The gas-fund abort read (2026-09-20): the funding pre-legs CONFIRMED and no main leg has
 *  moved — the generic abort flavors would misread this position, so the aborted card says
 *  exactly what happened: the gas money is still in the wallet, the conversion never ran.
 *  Lives here (shared) because gasPre records render through BOTH state panels' forks. */
export const gasPreFundedAborted = (rec: ConvertRecord): boolean => {
  if (rec.step !== 'aborted' || rec.gasPre == null) return false;
  const pre = rec.gasPre.legs.length * 2;
  const plan = rec.legPlan ?? [];
  return plan.slice(0, pre).every(l => l.state === 'confirmed')
    && plan.slice(pre).every(l => l.state === 'pending');
};

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
        <IconChevronLeft size={26} color={C.ink} />
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
 *  path Settings' privacy link uses. If the OS has no handler for the URL, the address itself
 *  renders beneath the row: a silent no-op tap is a dead end, and dead ends are bugs. */
export function LinkRow({testID, label, href}: {testID: string; label: string; href: string}) {
  const [failed, setFailed] = useState(false);
  return (
    <View>
      <Pressable
        testID={testID}
        style={S.linkBtn}
        onPress={() => { Linking.openURL(href).catch(() => setFailed(true)); }}
        accessibilityRole="link"
        accessibilityLabel={label}>
        <Text style={S.linkText}>{label}</Text>
      </Pressable>
      {failed ? <Text style={S.err}>{M.common.linkFallback(href)}</Text> : null}
    </View>
  );
}
