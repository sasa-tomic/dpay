// ConvertIntentSheet — the TWO-TAP convert (design brief Part V, 2026-09-26).
//
// Tap 1 is the Convert entry on a currency row (or Home's Convert action); this sheet is what
// opens. Everything is pre-computed before the user reads a word:
//   • source rail  — chosen by the entry gesture (chooseRail: funded rail, else preference);
//   • target       — one default, mechanically derived (stable twin for a stable source, the
//                    home currency otherwise), rendered as ONE line + sibling chips; changing
//                    it is optional, never required;
//   • amount       — pre-filled to the full spendable balance net of the route's known fees,
//                    with 25% / 50% / Max presets under the field;
//   • venue        — the row with the HIGHEST NET QUOTED OUTPUT among live quotes, disclosed
//                    mechanically ("Executed via ICPSwap, highest quoted rate of 2 venues").
//                    The quote is the venue's own attributed + timestamped number, verbatim;
//                    the word "best" never appears. Other rows sit behind the ONE
//                    "Other venues" expander, registry order, each still pickable in one tap;
//   • slippage     — the 1% default, disclosed inside Details; not a visible decision.
// Tap 2 is the CTA ("Convert 4.54 CHF"). Confirm re-quotes fresh at the gesture (red line):
// a moved market shows old and new inline and the same button re-arms; an unchanged market
// hands the prepared record to the engine (adoptConvertRecord) and the screen floods to the
// Settlement Field (ConvertFieldTracker, below) for signing → in-flight → done.
//
// What does NOT change: dpay is never a party; the venue's quote is attributed + timestamped;
// every fee on its own line; the minimum-you'll-receive; the refusal line; the CeFi deposit
// handoff, the CCTP external-signature machinery and the Solana surface all keep their exact
// panels. The COMPOSED IC+CeFi kind (engine slice 2026-09-26) is consumed end to end: its rows
// arrive from resolveSwapTargets (the resolveConvertDestinations walk), its bundle quotes IC
// legs + the settle leg's CeFi quote, and its CTA is the ONE consent (the founder's 2-press
// directive, folded 2026-09-26: press 1 is the entry, press 2 converts). The gesture
// re-quotes fresh, and a moved IC gross re-arms the same button with the old/new inline note
// and creates NOTHING. A held market runs the ORDER-FIRST prepare and CONTINUES straight
// into the device-signed legs in the same press: no intermediate stop. The venue's deposit
// address (which does not exist until the order does) is disclosed live on the Settlement
// Field tracker, which narrates order created -> deposit address revealed -> exact amount
// -> signing -> sent -> payout watch -> done/failed.
import {useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, Text, TextInput, View} from 'react-native';
import {isValidDestinationAddress, type CurrencyDescriptor} from '../config/catalog';
import type {SelectableAsset} from '../config/assets';
import {CONVERT_SLIPPAGE_BPS_DEFAULT} from '../config/convert';
import {currencyName, currencyOfAsset, currencyOfCatalogRow, currencyOfLinkToken, isStableCurrency, STABLE_TWIN, type HomeCurrency} from '../config/currency';
import {standingTarget, type SwapRow, type SwapTarget} from '../config/swap';
import {venueDisplayName, venueOfId} from '../config/venues';
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
  prepareCeFiConvertRecord,
  prepareChainConvertRecord,
  prepareComposedConvertRecord,
  prepareConvertRecord,
  prepareHubConvertRecord,
  prepareMultihopConvertRecord,
  prepareSolanaConvertRecord,
  type ConvertMath,
  type ConvertQuote,
  type ConvertRecord,
  type CeFiQuoteResult,
} from '../convert';
import {cctpMaxFee, cctpMintFloor, fetchEthBalance} from '../cctp';
import {DpayCore} from '../services/native';
import {fetchJupiterQuote, type JupiterQuote} from '../services/jupiter';
import {USDC_MINT_ADDRESS} from '../solana/tokens';
import {deriveSolanaAddress} from '../solana/identity';
import {deriveEvmAddress} from '../evm';
import {toChecksumAddress} from '../evm/identity';
import {fetchGasFeeWei, fetchLedgerFee} from '../services/rail';
import {gasFundRoutes} from '../routes';
import {M} from '../i18n';
import {fmtAssetCompact, parseUserAmount, randNonceHex, rawToDecimal} from '../lib/format';
import {eip55ChecksumBad} from '../lib/eip55';
import type {Identity} from '../lib/types';
import type {BalanceView} from '../lib/assetBalances';
import {C} from '../config/palette';
import {S} from '../styles';
import {IconChevronDown} from './icons';
import {
  ConvertHeader,
  DetailsToggle,
  chainFinalNet,
  composedFloorRaw,
  fetchChainQuotes,
  fetchComposedQuotes,
  fetchHubQuotes,
  formatBps,
  formatMillionthsPct,
  nonBreakingClock,
  scaledRate,
  venueDisclosure,
  type ChainBundle,
  type ComposedBundle,
} from './ConvertShared';

type Props = {
  identity: Identity;
  relayUrl: string;
  catalog: CurrencyDescriptor[];
  /** The standing SOURCE rail — resolved by the entry gesture (chooseRail). Non-null here:
   *  the host's fail-closed panels (no route, no balance) render instead of the sheet. */
  selectedAsset: SelectableAsset;
  assetBalances: Record<number, string>;
  /** The per-currency SUMMED views — the target chips' balance context (fork #4). */
  currencyBalances: Readonly<Partial<Record<HomeCurrency, BalanceView>>>;
  /** The resolved pair walk (host-computed, one copy with the host's gates). */
  targets: SwapTarget[];
  /** The wallet's home currency — a non-stable source's default target (brief 5.3). */
  homeCurrency: HomeCurrency | null;
  /** The source rail's raw-unit spendable balance, when known (null fails open). */
  balanceRaw: string | null;
  /** Hand a PREPARED record to the host: it adopts it into the engine and switches the
   *  screen into the record view (the Settlement Field tracker or the kind's own panel). */
  onPrepared: (rec: ConvertRecord) => void;
  /** Back goes where Convert was launched from (the accounts route). */
  onBack: () => void;
};

/** One hub row's two-quote bundle (quote1 from→hub, quote2 hub→dest sized on m1.minOut). */
type HubBundle = {q1: ConvertQuote; m1: ConvertMath; q2: ConvertQuote; m2: ConvertMath};

/** The mechanical venue pick: the row + how many live quotes the pick compared. */
type AutoPick = {rowId: string; compared: number} | null;

/** A row's NET quoted output, as a decimal string in the OUTPUT asset's own unit — comparable
 *  across rows serving the same target currency. Null when the row carries no live quote.
 *  Crossrail rows never rank: their final leg needs an external EVM signature, so they are
 *  auto-picked only when they are the ONLY path (brief 5.4.1). A composed row's figure is the
 *  settle leg's own CeFi quote — the venue's number in the settle asset's unit. */
function rowNetValue(
  r: SwapRow,
  rowQuotes: Record<string, ConvertQuote>,
  jupQuotes: Record<string, JupiterQuote>,
  hubBundles: Record<string, HubBundle>,
  composedBundles: Record<string, ComposedBundle>,
  chainBundles: Record<string, ChainBundle>,
): string | null {
  if (r.kind === 'direct') {
    const q = rowQuotes[r.rowId];
    if (q == null) return null;
    const fee = r.outDesc.fee ?? '0';
    const gross = BigInt(q.amountOutGross);
    const net = gross > BigInt(fee) ? gross - BigInt(fee) : 0n;
    return rawToDecimal(net.toString(), r.outDesc.decimals ?? 8);
  }
  if (r.kind === 'solamm') {
    const q = jupQuotes[r.rowId];
    return q != null ? rawToDecimal(q.outAmount, r.outDecimals) : null;
  }
  if (r.kind === 'cefi') {
    const q = rowQuotes[r.rowId];
    return q != null ? rawToDecimal(q.amountOutGross, r.outDecimals) : null;
  }
  if (r.kind === 'hub') {
    const b = hubBundles[r.rowId];
    return b != null ? rawToDecimal(b.m2.netOut, r.route.dest.decimals) : null;
  }
  if (r.kind === 'composed') {
    const b = composedBundles[r.rowId];
    return b != null ? rawToDecimal(b.cefi.amountOutGross, r.route.settleDecimals) : null;
  }
  if (r.kind === 'chain') {
    const b = chainBundles[r.rowId];
    return b != null ? rawToDecimal(chainFinalNet(b), r.route.endpoints[r.route.legs.length]!.decimals) : null;
  }
  return null;
}

/** The AUTO PICK (brief 5.3, the superseding directive): highest net quoted output among the
 *  live-quoted rows, ties broken by registry order (the first row wins a tie, never the
 *  later one). Venue rows (pools, Solana venues, CeFi) are the ranked class; composed routes
 *  win only when they are all the pair reaches, and a crossrail route never wins while any
 *  device-signable path exists. Null while the quotes that would decide it are still missing. */
function computeAutoPick(
  rows: SwapRow[],
  rowQuotes: Record<string, ConvertQuote>,
  jupQuotes: Record<string, JupiterQuote>,
  hubBundles: Record<string, HubBundle>,
  composedBundles: Record<string, ComposedBundle>,
  chainBundles: Record<string, ChainBundle>,
): AutoPick {
  const cmp = (a: string, b: string) => Number(a) - Number(b);
  type Quoted = {rowId: string; v: string};
  const venueRows = rows.filter(r => r.kind === 'direct' || r.kind === 'solamm' || r.kind === 'cefi');
  if (venueRows.length > 0) {
    const quoted: Quoted[] = [];
    for (const r of venueRows) {
      const v = rowNetValue(r, rowQuotes, jupQuotes, hubBundles, composedBundles, chainBundles);
      if (v != null) quoted.push({rowId: r.rowId, v});
    }
    if (quoted.length === 0) return null;
    const positive = quoted.filter(x => Number(x.v) > 0);
    const pool = positive.length > 0 ? positive : quoted;
    let best = pool[0];
    for (const x of pool.slice(1)) if (cmp(x.v, best.v) > 0) best = x;
    return {rowId: best.rowId, compared: quoted.length};
  }
  const hubRows = rows.filter(r => r.kind === 'hub');
  if (hubRows.length > 0) {
    const quoted: Quoted[] = [];
    for (const r of hubRows) {
      const v = rowNetValue(r, rowQuotes, jupQuotes, hubBundles, composedBundles, chainBundles);
      if (v != null) quoted.push({rowId: r.rowId, v});
    }
    if (quoted.length === 0) return null;
    let best = quoted[0];
    for (const x of quoted.slice(1)) if (cmp(x.v, best.v) > 0) best = x;
    return {rowId: best.rowId, compared: quoted.length};
  }
  // Composed routes rank only among themselves, only when the pair reaches nothing
  // device-signable above them (the pick criterion stays mechanical, registry-order tie-break).
  const composedRows = rows.filter(r => r.kind === 'composed');
  if (composedRows.length > 0) {
    const quoted: Quoted[] = [];
    for (const r of composedRows) {
      const v = rowNetValue(r, rowQuotes, jupQuotes, hubBundles, composedBundles, chainBundles);
      if (v != null) quoted.push({rowId: r.rowId, v});
    }
    if (quoted.length === 0) return null;
    let best = quoted[0];
    for (const x of quoted.slice(1)) if (cmp(x.v, best.v) > 0) best = x;
    return {rowId: best.rowId, compared: quoted.length};
  }
  // The CHAIN pass (2026-09-28): the same class rule — chain rows (a SOL source's route to
  // an IC target) rank among themselves only when nothing above them exists, registry-order
  // tie-break. A crossrail route still never wins while any device-signable path exists.
  const chainRows = rows.filter(r => r.kind === 'chain');
  if (chainRows.length > 0) {
    const quoted: Quoted[] = [];
    for (const r of chainRows) {
      const v = rowNetValue(r, rowQuotes, jupQuotes, hubBundles, composedBundles, chainBundles);
      if (v != null) quoted.push({rowId: r.rowId, v});
    }
    if (quoted.length === 0) return null;
    let best = quoted[0];
    for (const x of quoted.slice(1)) if (cmp(x.v, best.v) > 0) best = x;
    return {rowId: best.rowId, compared: quoted.length};
  }
  const cross = rows.find(r => r.kind === 'crossrail');
  if (cross != null && rowQuotes[cross.rowId] != null) return {rowId: cross.rowId, compared: 1};
  return null;
}

/** The PROVISIONAL pick (the quote-fetch demand while no live quote has decided anything):
 *  the first device-signable row in kind preference order (direct pool → Solana venue →
 *  single-venue CeFi → hub → crossrail, brief 5.3's composition order). A CeFi-only or
 *  hub-only pair therefore fetches its standing row's quote on open — the entry tap is the
 *  user's own demand; the partner agreement's no-machine-demand rule is untouched. */
function provisionalRowId(rows: SwapRow[]): string | null {
  const first = (pred: (r: SwapRow) => boolean) => rows.find(pred)?.rowId ?? null;
  return first(r => r.kind === 'direct')
    ?? first(r => r.kind === 'solamm')
    ?? first(r => r.kind === 'cefi')
    ?? first(r => r.kind === 'hub')
    ?? first(r => r.kind === 'composed')
    ?? first(r => r.kind === 'chain')
    ?? first(r => r.kind === 'crossrail');
}

/** The HERO display precision (round-1 validation item 8): the standard precision per asset
 *  class. A currency-class out reads like money — 2 decimals, the same grammar as the home
 *  headline; a token-class out keeps its registry display precision (ckBTC 8, ckETH 6,
 *  ckUSDC 6, SOL 9). PRESENTATION ONLY, and only on the sheet's receive hero: the venue's
 *  verbatim figure renders in Details (`quoteVerbatim`) and stays verbatim on the tracker,
 *  the record and the receipt — the never-computed/blended/ranked red line governs the
 *  QUOTE, which is untouched everywhere money is committed. */
function heroDisplayDecimals(out: {currency: HomeCurrency | null; registryDisplay: number | null; decimals: number}): number {
  if (out.currency != null && isStableCurrency(out.currency)) return 2;
  return out.registryDisplay ?? out.decimals;
}

/** The hero figure: the compact form at the hero's standard precision, with the formatter's
 *  own truncation marker stripped — the copy (`youReceive`) already carries the one ≈, and
 *  two would read as noise. The below-resolution threshold form ("< 0.01 EUR") survives:
 *  it is information, not a duplicated marker. */
function heroFigure(raw: string, decimals: number, unit: string, displayDecimals: number): string {
  return fmtAssetCompact(raw, decimals, unit, displayDecimals).replace(/^≈ /, '');
}

/** The fee overhead of a row kind, in the INPUT ledger's raw units — what the pre-filled
 *  Max and the insufficient gate subtract from the balance. A composed route's overhead is
 *  its IC chain's (one approve+pull pair per leg; a second leg's approve costs the mid
 *  ledger's fee). The settle leg's deposit fee is paid on top from the HUB asset, never
 *  from the source balance. */
function kindOverhead(kind: SwapRow['kind'], hubFee: string | null, inFee: string): bigint {
  switch (kind) {
    case 'solamm': return 0n;
    // The chain's source side is a Solana transfer (its fee is SOL's own, separate) — no
    // IC fee rides the source balance; the IC fees come out of the venue's payout.
    case 'chain': return 0n;
    case 'cefi': return BigInt(inFee);
    case 'hub':
    case 'composed': return 2n * BigInt(inFee) + BigInt(hubFee ?? '0'); // D21: three fees total
    default: return 2n * BigInt(inFee); // direct pool + crossrail: approve + input transfer
  }
}

/** The mid-ledger fee a composed/hub row's second approve costs (null = no second leg). */
function overheadHubFee(r: SwapRow | undefined): string | null {
  if (r == null) return null;
  if (r.kind === 'hub') return r.route.hub.fee;
  if (r.kind === 'composed' && r.route.legs.length === 2) return r.route.endpoints[1]!.fee;
  return null;
}

export function ConvertIntentSheet({
  identity, relayUrl, catalog, selectedAsset, assetBalances, currencyBalances,
  targets, homeCurrency, balanceRaw, onPrepared, onBack,
}: Props) {
  // ── Source facts (the standing rail's own unit + the currency it settles) ────────────────
  const sourceCurrency: HomeCurrency | null = currencyOfAsset(selectedAsset);
  const isSolSource = selectedAsset.protocol === 'solana';
  const sourceDesc: CurrencyDescriptor | null = selectedAsset.protocol === 'ic'
    ? catalog.find(c => c.currency === selectedAsset.currency) ?? null
    : null;
  const inSym: string = isSolSource
    ? selectedAsset.symbol
    : sourceDesc?.backing_symbol ?? sourceDesc?.symbol ?? selectedAsset.symbol;
  const inDecimals: number = selectedAsset.decimals ?? 8;
  const inFee: string = sourceDesc?.fee ?? '0';
  const balanceN: bigint | null = balanceRaw != null && /^\d+$/.test(balanceRaw) ? BigInt(balanceRaw) : null;

  // ── The resolved pair ────────────────────────────────────────────────────────────────────
  // The target pick. Keyed to the SOURCE asset like every per-pair state: a different source
  // re-derives the standing pair (render-phase adjustment), an explicit pick wins until then.
  const [targetSel, setTargetSel] = useState<HomeCurrency | null>(null);
  const [pairKey, setPairKey] = useState<string | null>(null);
  const [selRowId, setSelRowId] = useState<string | null>(null);
  const [targetChipsOpen, setTargetChipsOpen] = useState(true);
  const [venuesOpen, setVenuesOpen] = useState(false);
  if ((selectedAsset.id ?? null) !== pairKey) {
    setPairKey(selectedAsset.id ?? null);
    setTargetSel(null);
    setSelRowId(null);
    setTargetChipsOpen(true);
    setVenuesOpen(false);
  }
  // The standing default (brief 5.3): a stable source converts into its value TWIN; a
  // non-stable source into the home currency; standingTarget's registry walk answers
  // everything else. A categorical rule — no price ever ranks currencies.
  const target: SwapTarget | null = useMemo(() => {
    if (targetSel != null) return targets.find(t => t.currency === targetSel) ?? null;
    if (sourceCurrency != null && !isStableCurrency(sourceCurrency)
      && homeCurrency != null && homeCurrency !== sourceCurrency) {
      const home = targets.find(t => t.currency === homeCurrency);
      if (home != null) return home;
    }
    // The twin over ANY mechanism: which route carries CHF→EUR (a composed IC+CeFi chain, say)
    // is dpay's pick, never the user's extra tap — the founder's 2-press example stands only
    // when the twin is the standing target. Registry order answers when the twin is unreachable.
    if (sourceCurrency != null) {
      const twin = STABLE_TWIN[sourceCurrency];
      if (twin != null && twin !== sourceCurrency) {
        const t = targets.find(x => x.currency === twin);
        if (t != null) return t;
      }
    }
    return standingTarget(targets);
  }, [targets, targetSel, sourceCurrency, homeCurrency]);
  const targetCode: HomeCurrency | null = target?.currency ?? null;
  const rows: SwapRow[] = useMemo(() => target?.rows ?? [], [target]);

  // ── Screen state ─────────────────────────────────────────────────────────────────────────
  const [amountText, setAmountText] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const slippageBps = CONVERT_SLIPPAGE_BPS_DEFAULT; // disclosed inside Details; not a decision
  const [rowQuotes, setRowQuotes] = useState<Record<string, ConvertQuote>>({});
  const [rowQuoteErrs, setRowQuoteErrs] = useState<Record<string, string>>({});
  const rowQuoteAmts = useRef<Record<string, string>>({});
  const [jupQuotes, setJupQuotes] = useState<Record<string, JupiterQuote>>({});
  const jupQuoteAmts = useRef<Record<string, string>>({});
  const [hubBundles, setHubBundles] = useState<Record<string, HubBundle>>({});
  const hubBundleAmts = useRef<Record<string, string>>({});
  // The live typed text's raw amount (normalization identical to the amt refs). The refresh tick
  // reads it to skip quotes whose amount the user already superseded: the typed effect replaces
  // those anyway, and refreshing the captured one wastes venue traffic on a result the
  // late-echo guard always drops.
  const liveAmtRef = useRef('');
  useEffect(() => {
    const parsed = parseUserAmount(amountText, inDecimals);
    liveAmtRef.current = parsed.ok ? parsed.raw : '';
  }, [amountText, inDecimals]);
  const [composedBundles, setComposedBundles] = useState<Record<string, ComposedBundle>>({});
  const composedBundleAmts = useRef<Record<string, string>>({});
  const [chainBundles, setChainBundles] = useState<Record<string, ChainBundle>>({});
  const chainBundleAmts = useRef<Record<string, string>>({});
  // The venue's own listed-but-unquoted verdict (CeFi no-quote): a STATE, not an error.
  const [noQuoteRow, setNoQuoteRow] = useState<{rowId: string; venueName: string} | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [staleRefreshing, setStaleRefreshing] = useState(false);
  // The moved-quote note: old then new inline, the same button re-armed (brief 5.5).
  const [moved, setMoved] = useState<{oldAmt: string; newAmt: string} | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Sync latch for the confirm gesture: state lags a re-render, a duplicate press inside
  // that window would run prepare twice (observed under heavy host load, 2026-09-17).
  const confirmBusyRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── The picks: provisional (fetch demand) → mechanical auto pick → explicit override ─────
  const autoPick = useMemo(
    () => computeAutoPick(rows, rowQuotes, jupQuotes, hubBundles, composedBundles, chainBundles),
    [rows, rowQuotes, jupQuotes, hubBundles, composedBundles, chainBundles],
  );
  const provId = useMemo(() => provisionalRowId(rows), [rows]);
  const activeRowId: string | null = selRowId ?? autoPick?.rowId ?? provId;
  const activeRow: SwapRow | null = activeRowId != null ? rows.find(r => r.rowId === activeRowId) ?? null : null;
  const autoApplied = selRowId == null && autoPick != null;
  const directRow = activeRow != null && activeRow.kind === 'direct' ? activeRow : null;
  const hubRow = activeRow != null && activeRow.kind === 'hub' ? activeRow : null;
  const crossRow = activeRow != null && activeRow.kind === 'crossrail' ? activeRow : null;
  const cefiRow = activeRow != null && activeRow.kind === 'cefi' ? activeRow : null;
  const ammRow = activeRow != null && activeRow.kind === 'solamm' ? activeRow : null;
  const composedRow = activeRow != null && activeRow.kind === 'composed' ? activeRow : null;
  const chainRow = activeRow != null && activeRow.kind === 'chain' ? activeRow : null;
  const hubMode = hubRow != null;
  const routeMode = crossRow != null;
  const cefiMode = cefiRow != null;
  const ammMode = ammRow != null;
  const chainMode = chainRow != null;
  const outSym: string =
    directRow != null ? directRow.outDesc.backing_symbol ?? directRow.outDesc.symbol ?? ''
    : hubRow != null ? hubRow.route.dest.symbol
    : crossRow != null ? (crossRow.route.crossRail?.sol != null ? crossRow.route.crossRail.sol.outSymbol : crossRow.route.dest.symbol)
    : cefiRow != null ? cefiRow.outSym
    : ammRow != null ? ammRow.outSym
    : composedRow != null ? composedRow.route.settleSymbol
    : chainRow != null ? chainRow.route.endpoints[chainRow.route.legs.length]!.symbol
    : inSym;
  const outDecimals: number =
    directRow != null ? directRow.outDesc.decimals ?? inDecimals
    : hubRow != null ? hubRow.route.dest.decimals
    : crossRow != null ? (crossRow.route.crossRail?.sol != null ? crossRow.route.crossRail.sol.outDecimals : crossRow.route.hop.decimals)
    : cefiRow != null ? cefiRow.outDecimals
    : ammRow != null ? ammRow.outDecimals
    : composedRow != null ? composedRow.route.settleDecimals
    : chainRow != null ? chainRow.route.endpoints[chainRow.route.legs.length]!.decimals
    : inDecimals;

  // The rows that are NOT the standing pick — the Other-venues expander's contents, verbatim
  // in registry order, each still one tap away (brief 5.2).
  const otherRows = useMemo(() => rows.filter(r => r.rowId !== activeRowId), [rows, activeRowId]);

  const activeIcQuote: ConvertQuote | null = activeRow != null && (activeRow.kind === 'direct' || activeRow.kind === 'crossrail')
    ? rowQuotes[activeRow.rowId] ?? null
    : null;
  const activeJup: JupiterQuote | null = ammRow != null ? jupQuotes[ammRow.rowId] ?? null : null;
  const activeCefiQuote: ConvertQuote | null = cefiRow != null ? rowQuotes[cefiRow.rowId] ?? null : null;
  const activeHub: HubBundle | null = hubRow != null ? hubBundles[hubRow.rowId] ?? null : null;
  const activeComposed: ComposedBundle | null = composedRow != null ? composedBundles[composedRow.rowId] ?? null : null;
  const activeChain: ChainBundle | null = chainRow != null ? chainBundles[chainRow.rowId] ?? null : null;
  const activeRowErr: string | null = activeRow != null ? rowQuoteErrs[activeRow.rowId] ?? null : null;

  // ── Quote fetch (per-kind discipline inherited verbatim) ─────────────────────────────────
  // Live rows (direct pools + Solana venues — public quote surfaces) quote whenever rendered:
  // that is what lets the pick compare. A hub/crossrail/cefi row quotes once it is the
  // EFFECTIVE pick (auto or override) — an unpicked row carries its label, never another
  // mechanism's live number, and a CeFi row is never quoted for demand the user did not
  // initiate (the 2026-09-22 partner agreement).
  useEffect(() => {
    const parsed = parseUserAmount(amountText, inDecimals);
    if (!parsed.ok || parsed.raw === '0') {
      setRowQuotes({});
      setRowQuoteErrs({});
      rowQuoteAmts.current = {};
      setJupQuotes({});
      jupQuoteAmts.current = {};
      setHubBundles({});
      hubBundleAmts.current = {};
      setComposedBundles({});
      composedBundleAmts.current = {};
      setChainBundles({});
      chainBundleAmts.current = {};
      setNoQuoteRow(null);
      setQuoteErr(null);
      setQuoteBusy(false);
      return;
    }
    const live = rows.filter(r => r.kind === 'direct' || r.kind === 'solamm');
    const pickedWait = activeRow != null && !live.some(r => r.rowId === activeRow.rowId) ? [activeRow] : [];
    const needs = (r: typeof rows[number]): boolean => {
      if (r.kind === 'direct' || r.kind === 'crossrail') return rowQuoteAmts.current[r.rowId] !== parsed.raw;
      if (r.kind === 'solamm') return jupQuoteAmts.current[r.rowId] !== parsed.raw;
      if (r.kind === 'hub') return hubBundleAmts.current[r.rowId] !== parsed.raw;
      if (r.kind === 'composed') return composedBundleAmts.current[r.rowId] !== parsed.raw;
      if (r.kind === 'chain') return chainBundleAmts.current[r.rowId] !== parsed.raw;
      return rowQuoteAmts.current[r.rowId] !== parsed.raw; // cefi (effective pick only)
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
      const comps: Record<string, ComposedBundle> = {};
      const compAmts: Record<string, string> = {};
      const chains: Record<string, ChainBundle> = {};
      const chainAmts: Record<string, string> = {};
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
          } else if (r.kind === 'composed') {
            comps[r.rowId] = await fetchComposedQuotes(relayUrl, r.route, parsed.raw, inFee, slippageBps);
            compAmts[r.rowId] = parsed.raw;
          } else if (r.kind === 'chain') {
            chains[r.rowId] = await fetchChainQuotes(relayUrl, r.route, parsed.raw, slippageBps);
            chainAmts[r.rowId] = parsed.raw;
          } else {
            quotes[r.rowId] = await fetchCeFiConvertQuote(relayUrl, r.venue, r.inLedgerOrMint, r.outLedger ?? r.outMint ?? r.outRailId ?? '', parsed.raw, {inDecimals, outDecimals: r.outDecimals});
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
      setComposedBundles(prev => ({...prev, ...comps}));
      composedBundleAmts.current = {...composedBundleAmts.current, ...compAmts};
      setChainBundles(prev => ({...prev, ...chains}));
      chainBundleAmts.current = {...chainBundleAmts.current, ...chainAmts};
      setNoQuoteRow(noQuoteRef.v);
      setQuoteBusy(false);
    })();
    return () => {
      cancelled = true;
    };
    // slippageBps re-keys the Solana route + both hub floors; rows/activeRow re-key on the
    // resolved pair and the effective pick; inDecimals/inFee/relayUrl are mount-stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountText, rows, activeRow?.rowId, slippageBps, inDecimals, inFee, relayUrl]);

  // ── Stale refresh (the 30 s clock, single-flight): every rendered live quote refreshes in
  //    place; a moved ACTIVE quote surfaces as the moved note, never a silent swap. CeFi rows
  //    are EXEMPT (no timed partner demand) — the confirm re-quote is the protection. A
  //    composed row is exempt with them: its bundle mixes IC quotes with a partner-key CeFi
  //    quote, and a half-fresh card would read as a fact. The confirm re-quotes the whole
  //    bundle fresh at the gesture.
  useEffect(() => {
    const id = setInterval(() => {
      if (!mountedRef.current || staleRefreshing) return;
      const candidates = rows.filter(r => r.kind === 'direct' || r.kind === 'solamm' || r.rowId === activeRowId)
        .filter(r => r.kind !== 'cefi' && r.kind !== 'composed' && r.kind !== 'chain');
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
            // The user may have re-typed while this cycle ran: the store now holds a NEWER
            // amount's quote — refreshing the CAPTURED one would overwrite it (the classic
            // late-echo). Skip; the next tick re-reads the live map.
            if (rowQuoteAmts.current[r.rowId] !== q.amountIn) continue;
            if (liveAmtRef.current !== q.amountIn) continue; // superseded amount — the typed effect owns it
            const fresh = r.kind === 'crossrail'
              ? await fetchConvertQuote(relayUrl, r.route.from.ledger, r.route.hop.ledger, q.amountIn, {venue: venueOfId(r.route.swapVenueId) ?? undefined})
              : await fetchConvertQuote(relayUrl, r.inLedger, r.outLedger, q.amountIn, {venue: r.venue});
            if (!mountedRef.current) return;
            if (rowQuoteAmts.current[r.rowId] !== q.amountIn) continue; // re-typed mid-refresh
            setRowQuotes(prev => ({...prev, [r.rowId]: fresh}));
            if (activeRowId === r.rowId && fresh.amountOutGross !== q.amountOutGross) {
              setMoved({oldAmt: q.amountOutGross, newAmt: fresh.amountOutGross});
            }
          }
          for (const r of staleJup) {
            const q = jupQuotes[r.rowId];
            if (q == null) continue;
            if (jupQuoteAmts.current[r.rowId] !== q.inAmount) continue; // re-typed before this cycle
            if (liveAmtRef.current !== q.inAmount) continue; // superseded amount — the typed effect owns it
            const res = await fetchJupiterQuote(relayUrl, r.venue, r.inMint, r.outMint, q.inAmount, slippageBps);
            if (!mountedRef.current) return;
            if (res.ok) {
              if (jupQuoteAmts.current[r.rowId] !== q.inAmount) continue; // re-typed mid-refresh
              setJupQuotes(prev => ({...prev, [r.rowId]: res.quote}));
              if (activeRowId === r.rowId && res.quote.outAmount !== q.outAmount) {
                setMoved({oldAmt: q.outAmount, newAmt: res.quote.outAmount});
              }
            }
          }
          for (const r of staleHub) {
            const b = hubBundles[r.rowId];
            if (b == null) continue;
            if (hubBundleAmts.current[r.rowId] !== b.q1.amountIn) continue; // re-typed before this cycle
            if (liveAmtRef.current !== b.q1.amountIn) continue; // superseded amount — the typed effect owns it
            const got = await fetchHubQuotes(relayUrl, r.route, b.q1.amountIn, inFee, slippageBps);
            if (!mountedRef.current) return;
            if (hubBundleAmts.current[r.rowId] !== b.q1.amountIn) continue; // re-typed mid-refresh
            setHubBundles(prev => ({...prev, [r.rowId]: got}));
            if (activeRowId === r.rowId
              && (got.q1.amountOutGross !== b.q1.amountOutGross || got.q2.amountOutGross !== b.q2.amountOutGross)) {
              setMoved({oldAmt: b.m2.netOut, newAmt: got.m2.netOut});
            }
          }
        } catch {
          // Stale quotes stay on screen; the next tick tries again.
        } finally {
          if (mountedRef.current) setStaleRefreshing(false);
        }
      })();
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, rowQuotes, jupQuotes, hubBundles, activeRowId, staleRefreshing, slippageBps, inFee, relayUrl]);

  // ── Min-out derivation (the compiled core's arithmetic — never TS) ───────────────────────
  const [math, setMath] = useState<ConvertMath | null>(null);
  useEffect(() => {
    // A composed row's decision math is its bundle's FINAL leg (the floor the venue order
    // prices); no separate derivation is needed.
    if (activeComposed != null) {
      setMath(activeComposed.m2 ?? activeComposed.m1);
      return;
    }
    if (activeIcQuote == null) {
      setMath(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const outFee = directRow != null ? directRow.outDesc.fee ?? '0' : crossRow != null ? crossRow.route.hop.fee : '0';
        const m = await deriveConvertMath(activeIcQuote, inFee, outFee, slippageBps);
        if (!cancelled && mountedRef.current) setMath(m);
      } catch (e) {
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
  }, [activeIcQuote?.venueId, activeIcQuote?.fetchedAtMs, activeIcQuote?.amountOutGross, activeComposed, slippageBps, directRow?.rowId, crossRow?.rowId, inFee]);

  // ── The cross-rail route's live gas quote (its own census line; prepare re-queries at
  //    confirm — this copy is for review, never for signing). ───────────────────────────────
  const [routeGas, setRouteGas] = useState<{feeWei: string; gasLedgerFee: string} | null>(null);
  const [routeGasErr, setRouteGasErr] = useState<string | null>(null);
  const [gasNonce, setGasNonce] = useState(0);
  useEffect(() => {
    if (crossRow == null) {
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
  }, [crossRow?.rowId, gasNonce]);

  // ── Circle's OWN published fee for the crossing — fail-closed: no fee → no confirm. ──────
  const [crossFee, setCrossFee] = useState<{maxFee: string; floor: string} | null>(null);
  const [crossFeeErr, setCrossFeeErr] = useState<string | null>(null);
  useEffect(() => {
    if (crossRow == null || math == null) {
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
  }, [crossRow?.rowId, math?.minOut]);

  // ── Route C's review-time destination estimate — event-driven, fail-soft. ────────────────
  const [destEstimate, setDestEstimate] = useState<string | null>(null);
  useEffect(() => {
    const sol = crossRow?.route.crossRail?.sol;
    if (sol == null || crossFee == null) {
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
  }, [crossRow?.rowId, crossFee?.floor, relayUrl]);

  // ── The CeFi handoff addresses: BOTH rails' derivations, one copy. The CHAIN settle is
  // the user's own IC account too (the venue pays the mid asset there — phase 2's input).
  const [cefiIcAccountId, setCefiIcAccountId] = useState<string | null>(null);
  useEffect(() => {
    if (!cefiMode && !chainMode) {
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
  }, [cefiMode, chainMode, cefiRow?.rowId, chainRow?.rowId, identity.publicHex]);
  const cefiSolAddress = useMemo(
    () => (cefiMode ? deriveSolanaAddress(identity.secretHex) : null),
    [cefiMode, identity.secretHex],
  );
  // The EVM-native settle rail's payout address (2026-09-27): the device's OWN EVM address
  // — m/44'/60'/0'/0/0 over the same identity seed, EIP-55-checksummed for display. The
  // derivation is a function of the key, NOT of the chain: the same address receives the
  // native ETH payout on Ethereum mainnet and would receive it on any other EVM chain.
  const cefiEthAddress = useMemo(
    () => (cefiMode && cefiRow?.outRailId != null
      ? toChecksumAddress(deriveEvmAddress(identity.secretHex))
      : null),
    [cefiMode, cefiRow?.outRailId, identity.secretHex],
  );
  const cefiSettleAddress = cefiRow != null
    ? (cefiRow.outLedger != null ? cefiIcAccountId
      : cefiRow.outRailId != null ? cefiEthAddress
      : cefiSolAddress)
    : null;
  const cefiRefundAddress = cefiRow != null
    ? (cefiRow.outLedger != null ? cefiSolAddress : cefiIcAccountId)
    : null;

  // ── The route's destination address (the CCTP crossing's signer side) — verbatim gates. ──
  const [destAddress, setDestAddress] = useState('');
  const [destRetype, setDestRetype] = useState('');
  const [destReentered, setDestReentered] = useState<string | null>(null);
  const [destEthWei, setDestEthWei] = useState<string | null | undefined>(undefined);
  const [ethRecheckNonce, setEthRecheckNonce] = useState(0);
  const [selfFundOpen, setSelfFundOpen] = useState(false);

  // ── Gas-fund derivations — every hook sits before any conditional return. ────────────────
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

  // ── The gates (fail closed BEFORE the confirm). A null balance fails OPEN. ───────────────
  const parsed = parseUserAmount(amountText, inDecimals);
  const amountRaw = parsed.ok ? parsed.raw : null;
  const amountN = amountRaw != null && /^\d+$/.test(amountRaw) ? BigInt(amountRaw) : 0n;
  // The overhead comes from the EFFECTIVE kind when one stands, else the provisional row's
  // kind (the Max prefill must exist before any quote does).
  const overheadKind: SwapRow['kind'] = activeRow?.kind ?? rows.find(r => r.rowId === provId)?.kind ?? 'direct';
  const overheadN = kindOverhead(
    overheadKind,
    activeRow != null ? overheadHubFee(activeRow) : overheadHubFee(rows.find(r => r.rowId === provId)),
    inFee,
  );
  const neededN = parsed.ok && amountRaw !== '0' && !ammMode
    ? BigInt(parsed.raw) + overheadN
    : null;
  const insufficient = ammMode
    ? amountN > 0n && balanceN != null && amountN > balanceN
    : balanceN != null && neededN != null && neededN > balanceN;
  const maxRaw = useMemo(() => {
    if (balanceN == null) return null;
    const prov = rows.find(r => r.rowId === provId);
    const overhead = kindOverhead(prov?.kind ?? 'direct', overheadHubFee(prov), inFee);
    return balanceN > overhead ? (balanceN - overhead).toString() : null;
  }, [balanceN, rows, provId, inFee]);

  // The amount pre-fill: the full spendable balance net of the route's known fees (brief
  // 5.2 "convert what I have"). Re-applied per (source, target) until the user types.
  const prefillKey = `${selectedAsset.id}|${targetCode ?? ''}`;
  const lastPrefill = useRef<string | null>(null);
  useEffect(() => {
    if (amountTouched || maxRaw == null) return;
    if (lastPrefill.current === prefillKey) return;
    lastPrefill.current = prefillKey;
    setAmountText(rawToDecimal(maxRaw, inDecimals));
  }, [prefillKey, maxRaw, amountTouched, inDecimals]);

  const applyPreset = (pct: 25 | 50 | 'max') => {
    if (maxRaw == null) return;
    const raw = pct === 'max' ? BigInt(maxRaw) : BigInt(maxRaw) * BigInt(pct) / 100n;
    if (raw <= 0n) return;
    setAmountText(rawToDecimal(raw.toString(), inDecimals));
    setMoved(null);
    setConfirmErr(null);
  };

  // The decision bundle each kind must have on the table before the CTA arms.
  const hubReady = activeHub != null;
  const crossReady = math != null && destValid && routeGas != null && routeGasErr == null && !gasShort && crossFee != null;
  const cefiReady = activeCefiQuote != null && cefiSettleAddress != null && cefiRefundAddress != null;
  const ammReady = activeJup != null;
  const directReady = directRow != null && activeIcQuote != null && math != null;
  const composedReady = activeComposed != null;
  // The chain's one extra gate: the venue pays the mid asset to the user's own IC account
  // — its derivation must have landed before the order is created (never typed).
  const chainReady = activeChain != null && cefiIcAccountId != null;
  const pickedReady = directReady || hubReady || crossReady || cefiReady || ammReady || composedReady || chainReady;
  const canConfirm = activeRow != null && pickedReady && !quoteBusy && !confirmBusy && !insufficient && amountN > 0n;

  // ── THE CONFIRM — one gesture on the effective row. Re-quotes fresh at the gesture; a
  //    moved market re-arms the same button with old/new inline; an unchanged market hands
  //    the prepared record to the engine. ──────────────────────────────────────────────────
  const onConfirm = async (gasFundArg?: {relayUrl: string; balances: Record<number, string>} | null) => {
    if (confirmBusyRef.current || activeRow == null || amountRaw == null || confirmBusy) return;
    confirmBusyRef.current = true;
    setConfirmBusy(true);
    setConfirmErr(null);
    setMoved(null);
    try {
      if (activeRow.kind === 'direct') {
        const q = rowQuotes[activeRow.rowId];
        if (q == null || math == null) return;
        const fresh = await fetchConvertQuote(relayUrl, activeRow.inLedger, activeRow.outLedger, q.amountIn, {venue: activeRow.venue});
        if (fresh.amountOutGross !== q.amountOutGross) {
          if (mountedRef.current) {
            setRowQuotes(prev => ({...prev, [activeRow.rowId]: fresh}));
            setMoved({oldAmt: q.amountOutGross, newAmt: fresh.amountOutGross});
          }
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
        onPrepared(rec);
        return;
      }
      if (activeRow.kind === 'hub') {
        const b = hubBundles[activeRow.rowId];
        if (b == null) return;
        // Both hops re-quoted fresh at confirm; quote2 is sized on the FRESH floor.
        const fresh = await fetchHubQuotes(relayUrl, activeRow.route, b.q1.amountIn, inFee, slippageBps);
        if (fresh.q1.amountOutGross !== b.q1.amountOutGross || fresh.q2.amountOutGross !== b.q2.amountOutGross) {
          if (mountedRef.current) {
            setHubBundles(prev => ({...prev, [activeRow.rowId]: fresh}));
            setMoved({oldAmt: b.m2.netOut, newAmt: fresh.m2.netOut});
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
        onPrepared(rec);
        return;
      }
      if (activeRow.kind === 'crossrail') {
        const q = rowQuotes[activeRow.rowId];
        if (q == null || math == null || !destValid) return;
        const fresh = await fetchConvertQuote(relayUrl, activeRow.route.from.ledger, activeRow.route.hop.ledger, q.amountIn, {venue: venueOfId(activeRow.route.swapVenueId) ?? undefined});
        if (fresh.amountOutGross !== q.amountOutGross) {
          if (mountedRef.current) {
            setRowQuotes(prev => ({...prev, [activeRow.rowId]: fresh}));
            setMoved({oldAmt: q.amountOutGross, newAmt: fresh.amountOutGross});
          }
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
        onPrepared(rec);
        return;
      }
      if (activeRow.kind === 'cefi') {
        if (activeCefiQuote == null || cefiSettleAddress == null || cefiRefundAddress == null) return;
        // The re-quote exists ONLY to mint a FRESH QUOTE ID (SideShift pins quoteId↔rate);
        // the ORDER is the lock and the consent point.
        const cefiRecordId = randNonceHex();
        const cefiSettleRail = activeRow.outLedger ?? activeRow.outMint ?? activeRow.outRailId ?? '';
        let freshRes: CeFiQuoteResult;
        try {
          freshRes = await fetchCeFiQuoteResult(
            relayUrl, activeRow.venue, activeRow.inLedgerOrMint, cefiSettleRail,
            rawToDecimal(amountRaw, inDecimals), 20_000,
          );
        } catch (e) {
          throw ceFiServiceError(e, venueDisplayName(activeRow.venue.venue_id));
        }
        const fresh = ceFiQuoteFromResult(
          activeRow.venue, activeRow.inLedgerOrMint, cefiSettleRail,
          amountRaw, freshRes, activeRow.outDecimals,
        );
        let order;
        try {
          order = await createCeFiOrder(relayUrl, activeRow.venue, freshRes, {
            settleAddress: cefiSettleAddress,
            refundAddress: cefiRefundAddress,
            depositLedger: activeRow.inLedgerOrMint,
            settleLedger: cefiSettleRail,
            depositAmountDecimal: rawToDecimal(amountRaw, inDecimals),
            clientOrderId: cefiRecordId,
          }, 20_000);
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
        onPrepared(rec);
        return;
      }
      if (activeRow.kind === 'composed') {
        const b = composedBundles[activeRow.rowId];
        if (b == null) return;
        // THE ONE CONSENT (the founder's 2-press directive, folded 2026-09-26). The gesture
        // re-quotes the whole bundle fresh (red line): a moved leg-1 gross re-arms the same
        // button with the old/new inline note BEFORE the venue order exists (nothing
        // created, nothing signed — prepare's own gate is the second copy of this check,
        // raced-press-proof). A held market creates the venue order (prepare's order-first
        // sequence: the order exists before any byte is signed) and CONTINUES immediately
        // into the device-signed legs — the deposit transfer to the venue's own address is
        // the last signed leg of the SAME intent. No intermediate stop, no second press.
        // An unmount before this point adopts nothing and the order dies unfunded.
        const fresh = await fetchComposedQuotes(relayUrl, activeRow.route, b.q1.amountIn, inFee, slippageBps);
        if (fresh.q1.amountOutGross !== b.q1.amountOutGross) {
          if (mountedRef.current) {
            setComposedBundles(prev => ({...prev, [activeRow.rowId]: fresh}));
            setMoved({oldAmt: b.q1.amountOutGross, newAmt: fresh.q1.amountOutGross});
          }
          return;
        }
        const rec = await prepareComposedConvertRecord({
          id: randNonceHex(),
          secretHex: identity.secretHex,
          publicHex: identity.publicHex,
          relayUrl,
          route: activeRow.route,
          inDesc: sourceDesc!,
          quote1: fresh.q1,
          math1: fresh.m1,
          ...(fresh.q2 != null && fresh.m2 != null ? {quote2: fresh.q2, math2: fresh.m2} : {}),
          reviewedGrossRaw: b.q1.amountOutGross,
        });
        if (!mountedRef.current) return;
        onPrepared(rec); // adopted in the SAME gesture; the tracker narrates the venue facts live
        return;
      }
      if (activeRow.kind === 'chain') {
        const b = chainBundles[activeRow.rowId];
        if (b == null || cefiIcAccountId == null) return;
        // THE ONE CONSENT for the whole chain (the any-pair mandate). The gesture runs the
        // order-first prepare: the venue order is created (its locked deposit + settle
        // figures are facts before anything signs), the Solana deposit transfer is signed
        // and FROZEN, and the record adopts into the engine — which submits the deposit
        // and, when the venue names the settle, signs the IC legs from the record's own
        // frozen plan on a fresh quote. No intermediate stop, no second press. Like the
        // plain cefi kind, the ORDER is the lock: no moved-quote gate can ever match a
        // ticking venue rate (the review's plan figures are the disclosure, not the lock).
        const rec = await prepareChainConvertRecord({
          id: randNonceHex(),
          secretHex: identity.secretHex,
          publicHex: identity.publicHex,
          relayUrl,
          route: activeRow.route,
          amountRaw: amountRaw,
          slippageBps,
          settleAddressIc: cefiIcAccountId,
        });
        if (!mountedRef.current) return;
        onPrepared(rec); // adopted in the SAME gesture; the tracker narrates both phases live
        return;
      }
      // activeRow.kind === 'solamm' — the Solana venue (Jupiter).
      const q = jupQuotes[activeRow.rowId];
      if (q == null) return;
      const fresh = await fetchJupiterQuote(relayUrl, activeRow.venue, activeRow.inMint, activeRow.outMint, amountRaw, slippageBps);
      if (!fresh.ok) {
        if (mountedRef.current) setConfirmErr(M.convert.errors.quoteUnreachable(venueDisplayName(activeRow.venue.venue_id)));
        return;
      }
      if (fresh.quote.outAmount !== q.outAmount) {
        if (mountedRef.current) {
          setJupQuotes(prev => ({...prev, [activeRow.rowId]: fresh.quote}));
          setMoved({oldAmt: q.outAmount, newAmt: fresh.quote.outAmount});
        }
        return;
      }
      const rec = await prepareSolanaConvertRecord({
        secretHex: identity.secretHex,
        relayUrl,
        quote: fresh.quote,
        inAsset: {symbol: inSym, mint: activeRow.inMint, decimals: inDecimals},
        outAsset: {symbol: activeRow.outSym, mint: activeRow.outMint, decimals: activeRow.outDecimals},
      });
      if (!mountedRef.current) return;
      onPrepared(rec);
    } catch (e) {
      if (mountedRef.current) setConfirmErr(e instanceof Error ? e.message : String(e));
    } finally {
      confirmBusyRef.current = false;
      if (mountedRef.current) setConfirmBusy(false);
    }
  };

  // ── Derived display figures ──────────────────────────────────────────────────────────────
  const crossInfo = crossRow != null ? crossRow.route.crossRail ?? null : null;
  const sourceBalanceLine = sourceCurrency != null
    ? currencyBalances[sourceCurrency]?.displayText ?? '—'
    : (balanceRaw != null ? fmtAssetCompact(balanceRaw, inDecimals, inSym) : null);
  const sellStr = amountN > 0n ? fmtAssetCompact(amountN.toString(), inDecimals, inSym) : null;
  // "You receive ≈ …" — the ACTIVE row's own number, in the venue's own out unit. The HERO
  // figure renders at the asset's standard display precision (round-1 item 8: presentation
  // only); the venue's verbatim figure renders in Details (`convert-quote-verbatim`) and
  // stays verbatim everywhere money is committed (tracker, record, receipt).
  const receiveRaw: string | null =
    directRow != null && math != null ? math.netOut
    : crossRow != null && math != null ? math.netOut
    : hubRow != null && activeHub != null ? activeHub.m2.netOut
    : cefiRow != null && activeCefiQuote != null ? activeCefiQuote.amountOutGross
    : ammRow != null && activeJup != null ? activeJup.outAmount
    : composedRow != null && activeComposed != null ? activeComposed.cefi.amountOutGross
    : chainRow != null && activeChain != null ? chainFinalNet(activeChain)
    : null;
  const outDescriptor: CurrencyDescriptor | null =
    directRow != null ? directRow.outDesc
    : hubRow != null ? catalog.find(c => c.ledger === hubRow.route.dest.ledger) ?? null
    : crossRow != null ? catalog.find(c => c.ledger === crossRow.route.hop.ledger) ?? null
    : null;
  // The hero's own unit: a cross-rail hero states the HOP figure (the swap pays into this
  // wallet; the crossing's dest estimate has its own line) — every other kind states the out.
  const heroUnit: {decimals: number; symbol: string} =
    crossRow != null ? {decimals: crossRow.route.hop.decimals, symbol: crossRow.route.hop.symbol}
    : {decimals: outDecimals, symbol: outSym};
  const outCurrency: HomeCurrency | null =
    outDescriptor != null ? currencyOfCatalogRow(outDescriptor)
    : composedRow != null ? currencyOfLinkToken(composedRow.route.settleSymbol)
    : chainRow != null ? targetCode
    : (cefiRow != null || ammRow != null) ? currencyOfLinkToken(outSym)
    : null;
  const heroDd = heroDisplayDecimals({currency: outCurrency, registryDisplay: outDescriptor?.display_decimals ?? null, decimals: heroUnit.decimals});
  const receiveStr: string | null = receiveRaw != null ? heroFigure(receiveRaw, heroUnit.decimals, heroUnit.symbol, heroDd) : null;
  // The venue's OWN verbatim figure behind that hero — the quote the user is confirming,
  // rendered exactly as the venue published it, attributed, inside Details.
  const verbatimQuote = (() => {
    const venueAmt = (venueId: string | null | undefined, raw: string | null | undefined, dec: number, sym: string): {venue: string; amt: string} | null =>
      raw == null || venueId == null ? null : {venue: venueDisplayName(venueId), amt: fmtAssetCompact(raw, dec, sym)};
    if (directRow != null && activeIcQuote != null) {
      return venueAmt(activeIcQuote.venueId, activeIcQuote.amountOutGross, outDecimals, outSym);
    }
    if (crossRow != null && activeIcQuote != null) {
      return venueAmt(activeIcQuote.venueId, activeIcQuote.amountOutGross, crossRow.route.hop.decimals, crossRow.route.hop.symbol);
    }
    if (hubRow != null && activeHub != null) {
      return venueAmt(activeHub.q2.venueId, activeHub.q2.amountOutGross, hubRow.route.dest.decimals, hubRow.route.dest.symbol);
    }
    if (cefiRow != null && activeCefiQuote != null) {
      return venueAmt(cefiRow.venue.venue_id, activeCefiQuote.amountOutGross, cefiRow.outDecimals, cefiRow.outSym);
    }
    if (ammRow != null && activeJup != null) {
      return venueAmt(ammRow.venue.venue_id, activeJup.outAmount, ammRow.outDecimals, ammRow.outSym);
    }
    if (composedRow != null && activeComposed != null) {
      return venueAmt(composedRow.route.cefiVenueId, activeComposed.cefi.amountOutGross, composedRow.route.settleDecimals, composedRow.route.settleSymbol);
    }
    if (chainRow != null && activeChain != null) {
      // The chain's LAST venue quote is the figure the receive hero is floored by — the
      // settle leg's venue number sits on its own census line below.
      const lastLeg = chainRow.route.legs[chainRow.route.legs.length - 1]!;
      const lastQ = activeChain.m2 != null ? activeChain.q2! : activeChain.q1;
      return venueAmt(lastLeg.venueId, lastQ.amountOutGross, chainRow.route.endpoints[chainRow.route.legs.length]!.decimals, chainRow.route.endpoints[chainRow.route.legs.length]!.symbol);
    }
    return null;
  })();
  // The min-out line's amount + the atLeast copy's pair, per kind. A composed row's floor is
  // its IC chain's final minimum — the exact figure the venue's order prices (the settle leg
  // locks its own rate, no slippage axis of its own).
  const minOutStr: string | null =
    directRow != null && math != null ? fmtAssetCompact(math.minOut, outDecimals, outSym)
    : crossRow != null && math != null ? fmtAssetCompact(math.minOut, crossRow.route.hop.decimals, crossRow.route.hop.symbol)
    : hubRow != null && activeHub != null ? fmtAssetCompact(activeHub.m2.minOut, outDecimals, outSym)
    : ammRow != null && activeJup != null ? fmtAssetCompact(activeJup.otherAmountThreshold, outDecimals, outSym)
    : composedRow != null && activeComposed != null
      ? fmtAssetCompact(composedFloorRaw(activeComposed), composedRow.route.endpoints[composedRow.route.legs.length]!.decimals, composedRow.route.endpoints[composedRow.route.legs.length]!.symbol)
    : chainRow != null && activeChain != null
      ? fmtAssetCompact(activeChain.m2?.minOut ?? activeChain.m1.minOut, outDecimals, outSym)
    : null;
  // Attribution: the quote's own venue once one arrives; before that the effective row's.
  const counterVenueId: string | null =
    activeIcQuote?.venueId
    ?? (directRow != null ? directRow.venue.venue_id : null)
    ?? (crossRow != null ? crossRow.route.swapVenueId : null)
    ?? (cefiRow != null ? cefiRow.venue.venue_id : null)
    ?? (ammRow != null ? ammRow.venue.venue_id : null)
    ?? (composedRow != null ? composedRow.route.cefiVenueId : null) // the receive figure's venue
    ?? (chainRow != null ? chainRow.route.legs[chainRow.route.legs.length - 1]!.venueId : null);
  // The target chips: every OTHER reachable currency (the source is not a target; the
  // standing target IS the line).
  const chipTargets = targets.filter(t => t.currency !== targetCode);
  const chipCodes = chipTargets.map(t => t.currency);

  // The host's fail-closed panels render instead of the sheet when the pair resolves
  // to nothing; the sheet only renders over a live pair.
  if (target == null) return null;

  return (
    <View testID="convert-screen" style={S.convertWrap}>
      <ConvertHeader title={targetCode != null ? M.convert.heading(sourceCurrency ?? inSym, targetCode) : M.convert.sheetTitle(sourceCurrency ?? inSym)} onBack={onBack} />
      <View testID="convert-sheet" style={S.sheetRoot}>
        <View style={S.sheetGrabber} />

        {/* ── The SELL leg: amount + presets ─────────────────────────────────────────────── */}
        <View testID="convert-source-leg">
          <Text style={S.convertAmountLabel}>{M.convert.amountLabel(inSym)}</Text>
          <View style={S.amountRow}>
            <TextInput
              testID="convert-amount"
              style={S.amountInput}
              value={amountText}
              onChangeText={t => {
                setAmountText(t);
                setAmountTouched(true);
                setMoved(null);
                setConfirmErr(null);
              }}
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
            <View style={S.presetRow}>
              <Pressable
                testID="convert-preset-25"
                style={[S.chip, amountTouched ? undefined : S.dim]}
                onPress={() => { if (!confirmBusy) applyPreset(25); }}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel="25%">
                <Text style={S.chipText}>25%</Text>
              </Pressable>
              <Pressable
                testID="convert-preset-50"
                style={S.chip}
                onPress={() => { if (!confirmBusy) applyPreset(50); }}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel="50%">
                <Text style={S.chipText}>50%</Text>
              </Pressable>
              <Pressable
                testID="convert-preset-max"
                style={S.chip}
                onPress={() => { if (!confirmBusy) applyPreset('max'); }}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel={M.convert.maxAmount}>
                <View testID="btn-convert-max">
                  <Text style={S.chipText}>{M.convert.maxAmount}</Text>
                </View>
              </Pressable>
            </View>
          </View>
        </View>

        {/* ── The RECEIVE leg: one tappable line + sibling chips (the optional decision) ──── */}
        <View testID="convert-target-leg">
          {chipCodes.length > 0 ? (
            <Pressable
              testID="convert-target-line"
              style={S.targetLine}
              onPress={() => { if (!confirmBusy) setTargetChipsOpen(o => !o); }}
              accessibilityRole="button"
              accessibilityState={{expanded: targetChipsOpen}}>
              <Text style={S.targetLineName}>{targetCode != null ? currencyName(targetCode) : '—'}</Text>
              <View style={targetChipsOpen ? S.convertDetailsChevronOpen : undefined}>
                <IconChevronDown size={16} color={C.sub} />
              </View>
            </Pressable>
          ) : (
            <View style={S.targetLine}>
              <Text style={S.targetLineName}>{targetCode != null ? currencyName(targetCode) : '—'}</Text>
            </View>
          )}
          {chipCodes.length > 0 && targetChipsOpen ? (
            <View testID="convert-target-chips" style={S.chipRow}>
              {chipCodes.map(code => (
                <Pressable
                  key={code}
                  testID={`convert-target-chip-${code}`}
                  style={S.chip}
                  onPress={() => {
                    if (confirmBusy) return;
                    setTargetSel(code);
                    setSelRowId(null);
                    setMoved(null);
                    setConfirmErr(null);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={currencyName(code)}>
                  <Text style={S.chipText}>{currencyName(code)}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>

        {/* ── The review card (the sheet's whole body) ────────────────────────────────────── */}
        <View testID="convert-headline" style={S.intentCard}>
          <Text testID="convert-receive" style={S.reviewReceiveAmount} numberOfLines={2}>
            {receiveStr != null
              ? M.convert.youReceive(receiveStr)
              : quoteBusy
                ? (counterVenueId != null ? M.convert.quoteFetching(venueDisplayName(counterVenueId)) : M.convert.quoteFetching(''))
                : '—'}
          </Text>
          {/* THE one quote line (second verbosity pass 2026-09-29): attribution + read instant,
              and — when the AUTO pick compared venues — the mechanical count on the same line.
              The venue + timestamp red line lives here; an override renders the plain
              attribution and the mechanical-pick line stands down. A hub names BOTH venues. */}
          {receiveStr != null && hubRow != null && activeHub != null ? (
            <Text testID="convert-quote-source" style={S.reviewMeta}>
              {M.convert.multihop.hubQuoteSource(
                venueDisplayName(activeHub.q1.venueId),
                venueDisplayName(activeHub.q2.venueId),
                nonBreakingClock(new Date(Math.max(activeHub.q1.fetchedAtMs, activeHub.q2.fetchedAtMs))),
              )}
            </Text>
          ) : receiveStr != null && counterVenueId != null ? (() => {
            const at = nonBreakingClock(new Date(
              activeIcQuote?.fetchedAtMs
              ?? activeCefiQuote?.fetchedAtMs
              ?? activeComposed?.cefi.fetchedAtMs
              ?? activeJup?.fetchedAtMs
              ?? Date.now(),
            ));
            return (
              <Text testID={autoApplied ? 'convert-venue-auto' : 'convert-quote-source'} style={S.reviewMeta}>
                {autoApplied && autoPick!.compared >= 2
                  ? M.convert.autoVenueLine(venueDisplayName(counterVenueId), at, autoPick!.compared)
                  : M.convert.quoteSource(at, venueDisplayName(counterVenueId))}
              </Text>
            );
          })() : null}
          {activeRow != null && (activeRow.kind === 'direct' || activeRow.kind === 'solamm' || activeRow.kind === 'cefi')
            && activeRow.venue.health?.status === 'degraded' ? (
            <Text testID={`convert-venue-${activeRow.rowId}-slow`} style={S.reviewMeta}>
              {M.convert.venueSlow}
            </Text>
          ) : null}
          {hubRow != null ? (
            <Text testID="convert-route-via" style={S.reviewMeta}>
              {M.convert.multihop.viaHub(hubRow.route.hub.symbol)}
            </Text>
          ) : null}
          {/* The composed route names its IC chain, leg by leg (the settle leg's venue is the
              attribution line above). The ONE CTA press creates the venue order and runs
              everything; the tracker narrates the venue-side facts live from execution. */}
          {composedRow != null && activeComposed != null ? (
            <View testID="convert-route-via">
              {composedRow.route.legs.map((leg, i) => (
                <Text key={leg.venueId + String(i)} style={S.reviewMeta}>
                  {M.convert.multihop.legSwap(
                    venueDisplayName(leg.venueId),
                    composedRow.route.endpoints[i]!.symbol,
                    composedRow.route.endpoints[i + 1]!.symbol,
                  )}
                </Text>
              ))}
              <Text style={S.reviewMeta}>
                {M.convert.depositLegPending(
                  venueDisplayName(composedRow.route.cefiVenueId),
                  minOutStr ?? '',
                )}
              </Text>
            </View>
          ) : null}
          {/* The chain names BOTH its executors, leg by leg: the cefi venue that holds the
              order, then the registered pool(s) that finish the route (the any-pair
              mandate's one review — every venue's own quote sits in Details). */}
          {chainRow != null && activeChain != null ? (
            <View testID="convert-route-via">
              <Text style={S.reviewMeta}>
                {M.convert.multihop.legSwap(
                  venueDisplayName(chainRow.route.cefiVenueId),
                  inSym,
                  chainRow.route.endpoints[0]!.symbol,
                )}
              </Text>
              {chainRow.route.legs.map((leg, i) => (
                <Text key={leg.venueId + String(i)} style={S.reviewMeta}>
                  {M.convert.multihop.legSwap(
                    venueDisplayName(leg.venueId),
                    chainRow.route.endpoints[i]!.symbol,
                    chainRow.route.endpoints[i + 1]!.symbol,
                  )}
                </Text>
              ))}
              <Text style={S.reviewMeta}>{M.convert.chain.phase2Note}</Text>
            </View>
          ) : null}
          {staleRefreshing ? (
            <Text testID="convert-stale" style={S.reviewMeta}>{M.convert.staleRefreshing}</Text>
          ) : null}
          {/* The floor, per kind (hub/crossrail keep their own container testIDs). */}
          {hubMode && activeHub != null ? (
            <View testID="convert-route-min">
              <Text style={S.convertMinOutLine}>
                {M.convert.multihop.routeMinWalletLine(minOutStr ?? '')}
              </Text>
            </View>
          ) : math != null && routeMode && crossRow != null ? (
            <View testID="convert-route-min">
              <Text style={S.convertMinOutLine}>
                {M.convert.multihop.routeMinLine(minOutStr ?? '')}
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
          ) : minOutStr != null && !cefiMode ? (
            <Text testID="convert-min-out" style={S.convertMinOutLine}>
              {M.convert.atLeast(minOutStr)}
            </Text>
          ) : null}
          {moved != null ? (() => {
            // A composed row's moved compare is its IC gross — the note formats in the
            // DEPOSIT asset's unit (what the venue order prices), never the settle unit.
            const u = composedRow != null
              ? composedRow.route.endpoints[composedRow.route.legs.length]!
              : null;
            return (
              <Text testID="convert-moved-note" style={S.movedNote}>
                {M.convert.rateMoved(
                  fmtAssetCompact(moved.oldAmt, u?.decimals ?? outDecimals, u?.symbol ?? outSym),
                  fmtAssetCompact(moved.newAmt, u?.decimals ?? outDecimals, u?.symbol ?? outSym),
                )}
              </Text>
            );
          })() : null}

          {/* Details: the fee/venue/signing census, default CLOSED, one control. */}
          <DetailsToggle
            open={detailsOpen}
            onToggle={() => setDetailsOpen(o => !o)}
            label={M.convert.detailsLabel}
          />
          {detailsOpen && activeRow != null ? (
            <View testID="convert-details-block">
              {/* The venue's own verbatim figure behind the hero: the quote the user is
                  confirming, exactly as the venue published it (round-1 item 8 — the hero
                  renders at standard display precision, this line keeps the verbatim). */}
              {verbatimQuote != null ? (
                <Text testID="convert-quote-verbatim" style={S.convertChecklistLine}>
                  {M.convert.quoteVerbatim(verbatimQuote.venue, verbatimQuote.amt)}
                </Text>
              ) : null}
              <Text testID="convert-slippage" style={S.convertChecklistLine}>
                {M.convert.slippageLabel}: {formatBps(slippageBps)}
              </Text>
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
              {/* Composed: the combined rate across the IC chain INTO the settle leg's own
                  quote — both venue numbers, never a blend of the two. */}
              {composedRow != null && activeComposed != null ? (
                <View testID="convert-rate" style={S.convertRateRow}>
                  <Text style={S.convertRateLabel}>{M.convert.rateLabel(inSym, composedRow.route.settleSymbol)}</Text>
                  <Text style={S.convertRateValue}>{fmtAssetCompact(scaledRate(activeComposed.cefi.amountOutGross, activeComposed.q1.amountIn, inDecimals), composedRow.route.settleDecimals, composedRow.route.settleSymbol)}</Text>
                </View>
              ) : null}
              {/* Counterparty census — per kind, one copy each. A composed route names BOTH
                  its executors: the IC pool that runs the swap legs, then the CeFi venue that
                  holds the order. */}
              {!hubMode ? (
                <View testID="convert-counterparty">
                  <Text style={S.convertChecklistLine}>
                    {cefiMode && cefiRow != null
                      ? M.convert.cefi.counterparty(venueDisplayName(cefiRow.venue.venue_id))
                      : ammMode && ammRow != null
                        ? M.convert.sol.counterparty(venueDisplayName(ammRow.venue.venue_id))
                        : composedRow != null
                          ? M.convert.counterparty(venueDisplayName(composedRow.route.legs[0]!.venueId))
                          : chainRow != null
                            ? M.convert.counterparty(venueDisplayName(chainRow.route.legs[0]!.venueId))
                            : counterVenueId != null ? M.convert.counterparty(venueDisplayName(counterVenueId))
                            : ''}
                  </Text>
                  {composedRow != null ? (
                    <Text style={S.convertChecklistLine}>
                      {M.convert.cefi.counterparty(venueDisplayName(composedRow.route.cefiVenueId))}
                    </Text>
                  ) : null}
                  {chainRow != null ? (
                    <Text style={S.convertChecklistLine}>
                      {M.convert.cefi.counterparty(venueDisplayName(chainRow.route.cefiVenueId))}
                    </Text>
                  ) : null}
                  {/* The pool/endpoint principal renders only when THIS venue's own number
                      stands behind it (an execution fact is never asserted without its quote). */}
                  {!cefiMode && (activeIcQuote?.pool != null || (counterVenueId != null && otherRows.length === 0)) && (directRow != null || (activeIcQuote != null && routeMode)) ? (
                    <Text testID="convert-pool-principal" style={S.convertPrincipal}>{activeIcQuote?.pool ?? (counterVenueId != null ? venueOfId(counterVenueId)?.endpoint ?? '' : '')}</Text>
                  ) : null}
                  {composedRow != null && activeComposed != null ? (
                    <Text testID="convert-pool-principal" style={S.convertPrincipal}>{activeComposed.q1.pool}</Text>
                  ) : null}
                  {chainRow != null && activeChain != null ? (
                    <Text testID="convert-pool-principal" style={S.convertPrincipal}>{activeChain.q1.pool}</Text>
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
              {composedRow != null && activeComposed != null ? (
                <Text testID="convert-pool-fee" style={S.convertChecklistLine}>
                  {M.convert.poolFeeTier(formatMillionthsPct(activeComposed.q1.feeMillionths), venueDisplayName(activeComposed.q1.venueId))}
                </Text>
              ) : null}
              {chainRow != null && activeChain != null ? (
                <Text testID="convert-pool-fee" style={S.convertChecklistLine}>
                  {M.convert.poolFeeTier(formatMillionthsPct(activeChain.q1.feeMillionths), venueDisplayName(activeChain.q1.venueId))}
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
              {/* Route census (cross-rail only) — verbatim from the multihop surface. */}
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
              {/* Jupiter's own published price impact (V8: display what the venue publishes). */}
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

          {/* The external-signature exception, disclosed at tap 1 (brief 5.4.1): a picked
              crossrail route is the one path whose final leg signs OUTSIDE this device. */}
          {routeMode ? (
            <View testID="convert-external-sign-note">
              <Text style={S.convertChecklistWarn}>{M.convert.externalSignTitle}</Text>
              <Text style={S.convertChecklistLine}>{M.convert.externalSignBody}</Text>
            </View>
          ) : null}

          {/* The route's destination address — required by the CCTP crossing, validated live,
              re-typed once (verbatim machinery). */}
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

          {/* The CeFi payout target: not an input — the user's OWN derived address. For a
              chain it is the MID asset's landing spot (phase 2's input ledger). */}
          {cefiMode && cefiSettleAddress != null ? (
            <View>
              {/* The EVM-native settle rail names itself: "native ETH on Ethereum mainnet"
                  — inside the ETH target this is the one line that separates the SideShift
                  row's NATIVE-ETH payout from the IC pool's ckETH payout (the two rails
                  settle the same currency on different chains). */}
              {cefiRow?.outRailId != null ? (
                <Text testID="convert-settle-rail" style={S.convertMetaLine}>
                  {M.convert.cefi.settleRailEthereum}
                </Text>
              ) : null}
              <Text style={S.convertAmountLabel}>{M.convert.cefi.settleAddressLabel}</Text>
              <Text testID="convert-settle-address" style={S.convertMetaLine} selectable>{cefiSettleAddress}</Text>
            </View>
          ) : null}
          {chainMode && cefiIcAccountId != null ? (
            <View>
              <Text style={S.convertAmountLabel}>{M.convert.cefi.settleAddressLabel}</Text>
              <Text testID="convert-settle-address" style={S.convertMetaLine} selectable>{cefiIcAccountId}</Text>
            </View>
          ) : null}
        </View>

        {/* ── Other venues: every other row verbatim, registry order, one tap each ─────────── */}
        {otherRows.length > 0 ? (
          <View testID="convert-venues">
            <Pressable
              testID="btn-convert-venues-other"
              style={S.venuesToggle}
              onPress={() => setVenuesOpen(o => !o)}
              accessibilityRole="button"
              accessibilityState={{expanded: venuesOpen}}>
              <Text style={S.venuesToggleText}>{M.convert.otherVenues(otherRows.length)}</Text>
              <View style={venuesOpen ? S.convertDetailsChevronOpen : undefined}>
                <IconChevronDown size={16} color={C.sub} />
              </View>
            </Pressable>
            {venuesOpen ? (
              <View testID="convert-venues-expanded" style={S.venuesList}>
                {otherRows.map(r => {
                  const icq = r.kind === 'direct' || r.kind === 'crossrail' ? rowQuotes[r.rowId] ?? null : null;
                  const jq = r.kind === 'solamm' ? jupQuotes[r.rowId] ?? null : null;
                  const rq = r.kind === 'cefi' ? rowQuotes[r.rowId] ?? null : null;
                  const cb = r.kind === 'composed' ? composedBundles[r.rowId] ?? null : null;
                  const chb = r.kind === 'chain' ? chainBundles[r.rowId] ?? null : null;
                  const err = rowQuoteErrs[r.rowId] ?? null;
                  const rOutSym = r.kind === 'direct' ? r.outDesc.backing_symbol ?? r.outDesc.symbol ?? ''
                    : r.kind === 'hub' ? r.route.dest.symbol
                    : r.kind === 'crossrail' ? (r.route.crossRail?.sol != null ? r.route.crossRail.sol.outSymbol : r.route.dest.symbol)
                    : r.kind === 'composed' ? r.route.settleSymbol
                    : r.kind === 'chain' ? r.route.endpoints[r.route.legs.length]!.symbol
                    : r.kind === 'cefi' ? r.outSym : r.outSym;
                  const rOutDec = r.kind === 'direct' ? r.outDesc.decimals ?? 8
                    : r.kind === 'hub' ? r.route.dest.decimals
                    : r.kind === 'crossrail' ? (r.route.crossRail?.sol != null ? r.route.crossRail.sol.outDecimals : r.route.hop.decimals)
                    : r.kind === 'composed' ? r.route.settleDecimals
                    : r.kind === 'chain' ? r.route.endpoints[r.route.legs.length]!.decimals
                    : r.kind === 'cefi' ? r.outDecimals : r.outDecimals;
                  const label =
                    r.kind === 'direct' ? r.venue.display_name
                    : r.kind === 'hub' ? M.convert.multihop.mechViaHub(r.route.hub.symbol)
                    : r.kind === 'crossrail' ? M.convert.multihop.mechViaCctp
                    : r.kind === 'composed' ? M.convert.multihop.mechViaVenue(venueDisplayName(r.route.cefiVenueId))
                    : r.kind === 'chain' ? M.convert.multihop.mechViaVenue(venueDisplayName(r.route.cefiVenueId))
                    : M.convert.multihop.mechViaVenue(r.venue.display_name);
                  return (
                    <Pressable
                      key={r.rowId}
                      testID={`convert-venue-${r.rowId}`}
                      style={S.convertVenueRow}
                      onPress={() => {
                        if (confirmBusy) return;
                        setSelRowId(r.rowId);
                        setMoved(null);
                        setConfirmErr(null);
                      }}
                      accessibilityRole="radio"
                      accessibilityState={{checked: false}}
                      accessibilityLabel={label}>
                      <View style={S.convertVenueRowText}>
                        <Text style={S.convertVenueName}>{label}</Text>
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
                        ) : cb != null ? (
                          <Text testID={`convert-venue-${r.rowId}-quote`} style={S.convertVenueAmount}>
                            {fmtAssetCompact(cb.cefi.amountOutGross, rOutDec, rOutSym)}
                          </Text>
                        ) : chb != null ? (
                          <Text testID={`convert-venue-${r.rowId}-quote`} style={S.convertVenueAmount}>
                            {fmtAssetCompact(chainFinalNet(chb), rOutDec, rOutSym)}
                          </Text>
                        ) : err != null ? (
                          <Text testID={`convert-venue-${r.rowId}-err`} style={S.err}>{err}</Text>
                        ) : r.kind === 'hub' ? (
                          <Text style={S.convertMetaLine}>{M.convert.multihop.hubShape()}</Text>
                        ) : r.kind === 'composed' ? (
                          <Text style={S.convertMetaLine}>{M.convert.multihop.mechViaHub(r.route.endpoints[1]!.symbol)}</Text>
                        ) : r.kind === 'chain' ? (
                          <Text style={S.convertMetaLine}>{M.convert.chain.rowShape(r.route.endpoints[0]!.symbol)}</Text>
                        ) : r.kind === 'cefi' && r.outRailId != null ? (
                          // An EVM-native settle row names its payout rail while it sits
                          // unpicked (it quotes only once picked — a spinner here would
                          // promise a fetch the partner agreement forbids).
                          <Text style={S.convertMetaLine}>{M.convert.cefi.settleRailEthereum}</Text>
                        ) : (/* crossrail: the label IS the mechanism line — no meta echo */
                          <View style={S.convertBtnBusyRow}>
                            <ActivityIndicator color={C.sub} />
                          </View>
                        )}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </View>
        ) : null}

        {/* ── The named failures, each with its concrete next action ──────────────────────── */}
        {insufficient ? (
          <View testID="convert-insufficient">
            <Text style={S.convertChecklistWarn}>
              {ammMode
                ? M.convert.insufficientLine(
                    fmtAssetCompact(amountN.toString(), inDecimals, inSym),
                    fmtAssetCompact(balanceRaw ?? '0', inDecimals, inSym))
                : cefiMode
                  ? M.convert.cefi.insufficientLine(
                      fmtAssetCompact(neededN!.toString(), inDecimals, inSym),
                      fmtAssetCompact(balanceRaw ?? '0', inDecimals, inSym))
                  : hubRow != null
                    ? M.convert.multihop.insufficientHubLine(
                        fmtAssetCompact(neededN!.toString(), inDecimals, inSym),
                        fmtAssetCompact(balanceRaw ?? '0', inDecimals, inSym))
                    : M.convert.neededVsHave(
                        fmtAssetCompact(neededN!.toString(), inDecimals, inSym),
                        fmtAssetCompact(balanceRaw ?? '0', inDecimals, inSym))}
            </Text>
            <Text style={S.convertChecklistLine}>{M.convert.smallerAmount}</Text>
          </View>
        ) : null}
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

        {/* ── THE one bottom-anchored CTA — press 2 of the 2-press grammar, THE consent for
            every kind (composed included: the venue order is created and the device-signed
            legs run in this same gesture, no intermediate stop) ──────────────────────────── */}
        <Pressable
          testID="btn-convert-confirm"
          style={[S.primary, !canConfirm && S.disabledFlat]}
          onPress={() => { void onConfirm(); }}
          disabled={!canConfirm}
          accessibilityRole="button"
          accessibilityState={{disabled: !canConfirm}}
          accessibilityLabel={M.convert.ctaConvert(sellStr ?? fmtAssetCompact('0', inDecimals, inSym))}>
          {confirmBusy || quoteBusy ? (
            <View style={S.convertBtnBusyRow}>
              <ActivityIndicator color={C.card} />
              <Text style={[S.primaryText, !canConfirm && S.disabledText]}>{M.convert.ctaConvert(sellStr ?? fmtAssetCompact('0', inDecimals, inSym))}</Text>
            </View>
          ) : (
            <Text testID="convert-cta" style={[S.primaryText, !canConfirm && S.disabledText]}>
              {M.convert.ctaConvert(sellStr ?? fmtAssetCompact('0', inDecimals, inSym))}
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

// ── ConvertFieldTracker — the Settlement Field record view (brief Part I + V.5) ─────────────
//
// After tap 2 the screen floods to the full-bleed brand fill and becomes the in-flight
// tracker: what was signed, which leg is running, what landed. One component renders the
// DIRECT and HUB (legPlan) record kinds — the paths the sheet itself confirms; the CeFi
// provider, cross-rail and Solana record kinds keep their own panels (their deposit handoff,
// calldata signing and chain watches are their own surfaces). Copy + testIDs carry over from
// the state panels this tracker re-skins, so every invariant the flows assert survives.
import {venueEndpointOf} from '../config/venues';
import {convertAbortFlavor, convertRecordMinOut} from '../convert';
import {abortConvertRecord, acknowledgeStuckRecord} from '../convertResume';
import {formatClock} from '../i18n/intl';
import {IconChevronLeft} from './icons';
import {gasPreFundedAborted, plannedLegFee, plannedLegLabel, routeTitleOf} from './ConvertShared';

export function ConvertFieldTracker({record, onBack}: {record: ConvertRecord; onBack: () => void}) {
  const [, forceTick] = useState(0);
  // stuck/pending states show when the signed envelopes expire — a 30 s tick keeps the
  // countdown honest; the engine (not this screen) advances the record itself.
  useEffect(() => {
    if (record.step !== 'stuck' && record.step !== 'pending_withdrawal') return;
    const id = setInterval(() => forceTick(n => n + 1), 30_000);
    return () => clearInterval(id);
  }, [record.step]);
  // The stuck screen restates what was signed, including the minimum bound — re-derived by
  // the compiled core from the record's own frozen quote + slippage (never persisted).
  const [minOut, setMinOut] = useState<string | null>(null);
  useEffect(() => {
    if (record.step !== 'stuck') return;
    let cancelled = false;
    convertRecordMinOut(record).then(
      m => { if (!cancelled) setMinOut(m); },
      () => { if (!cancelled) setMinOut(null); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id, record.step]);
  const inDecimals = record.inDecimals ?? 8;
  const outDecimals = record.outDecimals ?? 8;
  const hopDecimals = record.hopDecimals ?? record.outDecimals ?? 8;
  const hopSymbol = record.hopSymbol ?? record.outSymbol;
  const destSymbol = record.destSymbol ?? record.outSymbol;
  const venueName = venueDisplayName(record.venueId);
  const venuePool = venueEndpointOf(record.venueId);
  const legExpiryMs = record.legs[0]?.expiresAtMs ?? record.chainRoute?.expiresAtMs ?? record.createdAtMs;
  const legPlan = record.legPlan ?? [];
  const isHub = record.venue2Id != null;
  // The CHAIN record (2026-09-28): phase 1 has NO legPlan (the deposit transfer is the
  // only signed thing; the IC legs sign at phase time) — phase 2 carries the plan and
  // renders through the same leg list below.
  const chain = record.chainRoute ?? null;
  const chainPhase1 = chain != null && legPlan.length === 0;
  const legStateText = (s: typeof legPlan[number]['state']) =>
    s === 'pending' ? M.convert.multihop.legStatePending
    : s === 'sent' ? M.convert.multihop.legStateSent
    : s === 'confirmed' ? M.convert.multihop.legStateConfirmed
    : M.convert.multihop.legStateFailed;
  // D15: the top line tracks the CURRENT leg — the first non-confirmed leg of the frozen plan.
  const activeLegIndex = legPlan.findIndex(lp => lp.state !== 'confirmed');
  const activeLeg = activeLegIndex >= 0 ? legPlan[activeLegIndex] : null;
  const swapOrdinalOf = (i: number) => legPlan.slice(0, i).filter(x => x.kind === 'swap').length;
  const stepLine = activeLeg != null
    ? M.convert.multihop.legProgress(activeLegIndex + 1, legPlan.length) + ' — '
      + plannedLegLabel(record, activeLeg, activeLeg.canister, venueName, swapOrdinalOf(activeLegIndex))
    : null;
  const stopLabel = convertAbortFlavor(record) === 'watching' ? M.convert.stopWatching
    : convertAbortFlavor(record) === 'provider' ? M.convert.stopProvider
    : M.convert.stop;
  const inflight = record.step === 'approving' || record.step === 'approved'
    || record.step === 'swapping' || record.step === 'settling';
  // The resolved figure: the SEEN ledger row when done (never the pool's own #ok). A
  // composed record's figure is the SETTLE asset (the venue's locked figure until the
  // venue's own completion names the exact amount).
  const doneAmt = fmtAssetCompact(
    record.composedDeposit != null
      ? record.outAmountNet ?? record.expectedNet ?? '0'
      : record.outAmountNet ?? record.expectedNet2 ?? '0',
    isHub ? (record.destDecimals ?? hopDecimals) : outDecimals,
    destSymbol,
  );
  const inflightTitle =
    chainPhase1 && record.step === 'swapping' ? M.convert.chain.depositSending(venueDisplayName(chain!.venueId))
    : record.step === 'swapping' ? M.convert.swapVia(venueName)
    : record.step === 'settling' ? M.convert.awaitingPool
    : M.convert.signing;
  const inflightBody =
    record.step === 'approving' || record.step === 'approved'
      ? M.convert.approvingBody(fmtAssetCompact(record.amountIn, inDecimals, record.inSymbol), formatClock(new Date(legExpiryMs)))
      : record.step === 'swapping'
        ? M.convert.swappingBody(venueName)
        : M.convert.settlingBody(destSymbol);
  return (
    <View testID="convert-state" style={S.fieldRoot}>
      {/* The field header: back + the record's own title, inverted ink. */}
      <View style={S.routeHeaderRow}>
        <Pressable testID="btn-convert-back" onPress={onBack} accessibilityRole="button" accessibilityLabel={M.convert.backToWallet}>
          <IconChevronLeft size={26} color={C.brandInk} />
        </Pressable>
        <Text style={S.fieldHeaderTitle}>
          {isHub
            ? M.convert.heading(record.inSymbol, destSymbol)
            : legPlan.length > 0
              ? routeTitleOf(record, hopSymbol, destSymbol)
              : M.convert.heading(record.inSymbol, record.outSymbol)}
        </Text>
        <View style={S.routeHeaderSpacer} />
      </View>

      {stepLine != null ? (
        <Text testID="convert-step" style={S.fieldBody}>{stepLine}</Text>
      ) : null}

      {/* COMPOSED: the ONE consent's live narration (2-press fold, 2026-09-26). The venue
          order was created before anything signed, so its facts are narrated here AS the
          legs run: the venue + its locked payout figure verbatim (attributed + timestamped),
          the venue's own deposit address revealed live, the exact amount the signed
          transfer moves, and the venue's deposit window. Terminal states below name the
          venue and the way out on their own. */}
      {record.composedDeposit != null
        && (inflight || record.step === 'pending_withdrawal' || record.step === 'awaiting_deposit') ? (() => {
        const cd = record.composedDeposit!;
        const cdVenue = venueDisplayName(cd.venueId);
        return (
          <View testID="convert-composed-live" style={S.fieldLegs}>
            <Text testID="convert-composed-order" style={S.fieldLegLabel}>
              {M.convert.composedOrderLine(
                cdVenue,
                fmtAssetCompact(cd.settleAmountRaw ?? '0', cd.settleDecimals, cd.settleSymbol),
              )}
            </Text>
            <Text testID="convert-composed-order-id" style={S.fieldLegLabel}>{M.convert.cefi.shiftId(cd.orderId)}</Text>
            <Text testID="convert-composed-order-at" style={S.fieldLegLabel}>
              {M.convert.quoteSource(nonBreakingClock(new Date(record.createdAtMs)), cdVenue)}
            </Text>
            <Text testID="convert-composed-deposit-amount" style={S.fieldLegLabel}>
              {M.convert.cefi.depositAmountLabel}: {fmtAssetCompact(cd.amountRaw, hopDecimals, hopSymbol)}
            </Text>
            <Text testID="convert-composed-address-label" style={S.fieldLegLabel}>{M.convert.cefi.depositAddressLabel}</Text>
            <Text testID="convert-composed-deposit-address" style={S.fieldPrincipal} selectable>{cd.depositAddress}</Text>
            {cd.expiresAtMs != null ? (
              <Text testID="convert-composed-expiry" style={S.fieldLegLabel}>
                {M.convert.cefi.depositExpiryLine(nonBreakingClock(new Date(cd.expiresAtMs)))}
              </Text>
            ) : null}
          </View>
        );
      })() : null}

      {/* CHAIN phase 1: the ONE consent's live narration — the venue order (its locked
          figures verbatim), the venue's own Solana deposit address, the exact amount the
          signed transfer moves, and the deposit window. The venue-side wait after it is
          the provider poll; phase 2's legs join the leg list below when they sign. */}
      {chainPhase1
        && (inflight || record.step === 'pending_withdrawal' || record.step === 'awaiting_deposit'
          || record.step === 'provider_processing' || record.step === 'stuck') ? (() => {
        const venueNm = venueDisplayName(chain!.venueId);
        const midSymbol = record.hopSymbol ?? '';
        return (
          <View testID="convert-chain-live" style={S.fieldLegs}>
            <Text testID="convert-chain-order" style={S.fieldLegLabel}>
              {M.convert.chain.orderLine(
                venueNm,
                fmtAssetCompact(record.amountIn, record.inDecimals ?? 8, record.inSymbol),
                midSymbol,
              )}
            </Text>
            <Text testID="convert-chain-order-id" style={S.fieldLegLabel}>{M.convert.cefi.shiftId(chain!.orderId)}</Text>
            <Text testID="convert-chain-order-at" style={S.fieldLegLabel}>
              {M.convert.quoteSource(nonBreakingClock(new Date(record.createdAtMs)), venueNm)}
            </Text>
            <Text testID="convert-chain-deposit-amount" style={S.fieldLegLabel}>
              {M.convert.cefi.depositAmountLabel}: {fmtAssetCompact(chain!.amountRaw, record.inDecimals ?? 8, record.inSymbol)}
            </Text>
            <Text testID="convert-chain-address-label" style={S.fieldLegLabel}>{M.convert.cefi.depositAddressLabel}</Text>
            <Text testID="convert-chain-deposit-address" style={S.fieldPrincipal} selectable>{chain!.depositAddress}</Text>
            {chain!.expiresAtMs != null ? (
              <Text testID="convert-chain-expiry" style={S.fieldLegLabel}>
                {M.convert.cefi.depositExpiryLine(nonBreakingClock(new Date(chain!.expiresAtMs)))}
              </Text>
            ) : null}
            <Text testID="convert-chain-phase2" style={S.fieldLegLabel}>
              {/* The IC leg's OWN venue (the frozen plan's last leg) — the cefi venue at
                  record.venueId would misattribute the phase-2 quote on a 1-leg chain. */}
              {M.convert.chain.phase2Leg(midSymbol, record.outSymbol, venueDisplayName(chain!.icLegs[chain!.icLegs.length - 1]!.venueId))}
            </Text>
          </View>
        );
      })() : null}

      {inflight ? (
        <View testID="convert-inflight">
          <View testID={record.step === 'swapping' ? 'convert-swapping' : record.step === 'settling' ? 'convert-settling' : 'convert-approving'}>
          <ActivityIndicator size="large" color={C.brandInk} />
          <Text style={S.fieldTitle}>{inflightTitle}</Text>
          <Text style={S.fieldBody}>{inflightBody}</Text>
          </View>
        </View>
      ) : null}

      {record.step === 'done' ? (
        <View testID="convert-done">
          <Text style={S.fieldTitle}>{M.convert.doneTitle}</Text>
          <Text style={S.fieldBody}>
            {isHub
              ? M.convert.doneBody(doneAmt)
              : M.convert.receivedDone(doneAmt)}
          </Text>
          {venueName !== '' ? (
            <Text style={S.fieldBody}>
              {M.convert.viaChain(record.composedDeposit != null ? venueDisplayName(record.composedDeposit.venueId) : venueName)}
            </Text>
          ) : null}
          {record.outTx != null ? <Text style={S.fieldTx}>{M.convert.doneTx(record.outTx)}</Text> : null}
          <Pressable
            testID="btn-convert-done"
            style={S.fieldAction}
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel={M.common.done}>
            <Text style={S.fieldActionText}>{M.common.done}</Text>
          </Pressable>
        </View>
      ) : null}

      {record.step === 'pending_withdrawal' ? (
        <View testID="convert-pending">
          <ActivityIndicator size="large" color={C.brandInk} />
          <Text style={S.fieldTitle}>{M.convert.pendingTitle}</Text>
          <Text style={S.fieldBody}>{M.convert.pendingBody(destSymbol, venuePool, formatClock(new Date(record.createdAtMs)))}</Text>
          <Text style={S.fieldBody}>{M.convert.stillWatching}</Text>
          {legPlan.length > 0 ? (
            <Text testID="convert-expiry" style={S.fieldBody}>
              {M.convert.expiryLine(formatClock(new Date(legExpiryMs)))}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Composed: the deposit transfer went out automatically; this phase is the VENUE's
          payout watch (the provider driver polls its status here). The leg list below shows
          the deposit leg as sent — the depositLeg copy is the state line. */}
      {record.step === 'awaiting_deposit' && record.composedDeposit != null ? (
        <View testID="convert-awaiting-deposit">
          <ActivityIndicator size="large" color={C.brandInk} />
          <Text style={S.fieldTitle}>{M.convert.pendingTitle}</Text>
          <Text style={S.fieldBody}>
            {M.convert.depositLegSent(
              venueDisplayName(record.composedDeposit.venueId),
              fmtAssetCompact(record.composedDeposit.amountRaw, hopDecimals, hopSymbol),
            )}
          </Text>
          <Text style={S.fieldBody}>{M.convert.providerProcessingBody(destSymbol, venueDisplayName(record.composedDeposit.venueId))}</Text>
          <Text style={S.fieldBody}>{M.convert.stillWatching}</Text>
        </View>
      ) : null}

      {/* CHAIN: the deposit went out automatically; this phase is the VENUE's payout watch
          (the provider poll), after which the second leg signs itself from the frozen plan. */}
      {record.step === 'awaiting_deposit' && chainPhase1 ? (
        <View testID="convert-chain-awaiting">
          <ActivityIndicator size="large" color={C.brandInk} />
          <Text style={S.fieldTitle}>{M.convert.pendingTitle}</Text>
          <Text style={S.fieldBody}>
            {M.convert.chain.depositSent(
              venueDisplayName(chain!.venueId),
              fmtAssetCompact(chain!.amountRaw, record.inDecimals ?? 8, record.inSymbol),
              hopSymbol,
            )}
          </Text>
          <Text style={S.fieldBody}>{M.convert.providerProcessingBody(hopSymbol, venueDisplayName(chain!.venueId))}</Text>
          <Text style={S.fieldBody}>{M.convert.stillWatching}</Text>
        </View>
      ) : null}

      {inflight ? (
        <Pressable
          testID="btn-convert-stop"
          style={S.fieldAction}
          onPress={() => { void abortConvertRecord(record.id); }}
          accessibilityRole="button"
          accessibilityLabel={stopLabel}
          accessibilityState={{disabled: false}}>
          <Text style={S.fieldActionText}>{stopLabel}</Text>
        </Pressable>
      ) : null}
      {record.step === 'pending_withdrawal' ? (
        <Pressable
          testID="btn-convert-stop"
          style={S.fieldAction}
          onPress={() => { void abortConvertRecord(record.id); }}
          accessibilityRole="button"
          accessibilityLabel={stopLabel}
          accessibilityState={{disabled: false}}>
          <Text style={S.fieldActionText}>{stopLabel}</Text>
        </Pressable>
      ) : null}

      {record.step === 'aborted' ? (
        <View testID="convert-aborted">
          <Text style={S.fieldTitle}>{M.convert.abortedTitle}</Text>
          <Text style={S.fieldBody}>
            {gasPreFundedAborted(record) ? M.convert.crossrail.abortedGasBody
              : convertAbortFlavor(record) === 'provider' ? M.convert.abortedProvider
              : convertAbortFlavor(record) === 'watching' ? M.convert.abortedWatching
              : convertAbortFlavor(record) === 'fee' ? M.convert.abortedFee
              : M.convert.abortedClean}
          </Text>
          <Pressable
            testID="btn-convert-back-aborted"
            style={S.fieldAction}
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel={M.convert.backToWallet}>
            <Text style={S.fieldActionText}>{M.convert.backToWallet}</Text>
          </Pressable>
        </View>
      ) : null}

      {record.step === 'failed_refunded' ? (
        <View testID="convert-failed">
          <Text style={S.fieldTitle}>{M.convert.failedTitle}</Text>
          {record.chainRoute != null && record.legs.length === 0 ? (
            // The chain's dead FIRST phase: the deposit transfer never landed on-chain —
            // the pool bodies below would claim a return that never happened.
            <Text style={S.fieldBody}>{M.convert.chain.depositFailed(record.inSymbol)}</Text>
          ) : record.failureCode === 'approve_refused' ? (
            <Text style={S.fieldBody}>{M.convert.failedApproveBody(record.inSymbol)}</Text>
          ) : record.failureCode === 'swap_refused' ? (
            <Text style={S.fieldBody}>{M.convert.failedSwapBody(record.failureDetail ?? '', record.inSymbol, venueName)}</Text>
          ) : (
            <Text style={S.fieldBody}>{M.convert.refundedBody(record.inSymbol)}</Text>
          )}
          <Pressable
            testID="btn-convert-back-failed"
            style={S.fieldAction}
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel={M.convert.backToWallet}>
            <Text style={S.fieldActionText}>{M.convert.backToWallet}</Text>
          </Pressable>
        </View>
      ) : null}

      {record.step === 'failed_leg' ? (
        <View testID="convert-failed-leg">
          <Text style={S.fieldTitle}>{M.convert.failedTitle}</Text>
          {record.chainRoute != null && record.hopSymbol != null ? (
            <>
              {/* The chain's dead-end (phase-2 quote/sign refusal, or a second-leg
                  refusal): the venue's payout landed — the MID asset is in this wallet.
                  The exit is a normal 2-tap convert of it, which the copy names. */}
              <Text style={S.fieldBody}>
                {M.convert.chain.phase2Failed(hopSymbol)}
              </Text>
            </>
          ) : record.failureCode === 'deposit_refused' && record.composedDeposit != null ? (
            <>
              <Text style={S.fieldBody}>
                {M.convert.depositRefusedBody(hopSymbol, venueDisplayName(record.composedDeposit.venueId))}
              </Text>
              <Text style={S.fieldBody}>{M.convert.multihop.failedLegExit}</Text>
            </>
          ) : isHub ? (
            <>
              <Text style={S.fieldBody}>
                {M.convert.multihop.failedHop2Body(hopSymbol, destSymbol, record.failureDetail ?? '')}
              </Text>
              <Text style={S.fieldBody}>{M.convert.multihop.failedHop2Exit(hopSymbol)}</Text>
            </>
          ) : (
            <>
              <Text style={S.fieldBody}>
                {M.convert.multihop.failedLegBody(hopSymbol, record.failureDetail ?? '')}
              </Text>
              <Text style={S.fieldBody}>{M.convert.multihop.failedLegExit}</Text>
            </>
          )}
          <Pressable
            testID="btn-convert-back-failed-leg"
            style={S.fieldAction}
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel={M.convert.backToWallet}>
            <Text style={S.fieldActionText}>{M.convert.backToWallet}</Text>
          </Pressable>
        </View>
      ) : null}

      {record.step === 'stuck' ? (
        <View testID="convert-stuck">
          <Text style={S.fieldTitle}>{M.convert.stuckTitle}</Text>
          <Text style={S.fieldBody}>
            {legPlan.length > 0 ? M.convert.multihop.stuckRouteBody : M.convert.stuckBody}
          </Text>
          {isHub ? (
            <Text style={S.fieldBody}>{M.convert.multihop.stuckHoldsLine(hopSymbol)}</Text>
          ) : null}
          {!chainPhase1 && minOut != null ? (
            <Text style={S.fieldBody}>
              {M.convert.stuckSigned(fmtAssetCompact(record.amountIn, inDecimals, record.inSymbol), fmtAssetCompact(minOut, outDecimals, record.outSymbol), venueName)}
            </Text>
          ) : null}
          {/* A legless record (chain phase 1, a Jupiter leg) has NO IC envelopes: the line
              would show the record's CREATION time as an expiry — a fact nothing signed
              carries. The chain's venue window sits in the block above; a Solana leg dies
              at its own blockhash height, not at a wall clock. */}
          {record.legs.length > 0 ? (
            <Text testID="convert-expiry" style={S.fieldBody}>
              {M.convert.expiryLine(formatClock(new Date(legExpiryMs)))}
            </Text>
          ) : null}
          <Text style={S.fieldBody}>{M.convert.stuckWatching}</Text>
          {record.acknowledgedStuckAtMs == null ? (
            <Pressable
              testID="btn-convert-stuck-ack"
              style={S.fieldAction}
              onPress={() => { void acknowledgeStuckRecord(record.id); }}
              accessibilityRole="button"
              accessibilityLabel={M.convert.stuckAcknowledge}
              accessibilityState={{disabled: false}}>
              <Text style={S.fieldActionText}>{M.convert.stuckAcknowledge}</Text>
            </Pressable>
          ) : (
            <Text style={S.fieldBody}>{M.convert.stuckAcknowledged}</Text>
          )}
        </View>
      ) : null}

      {/* THE leg list — every leg, its own state, its own fee (hub records render it fully
          expanded; D14). The leg that stopped names itself by its refusal state. */}
      {record.legPlan != null ? (
        <View testID="convert-route-legs" style={S.fieldLegs}>
          {record.gasPre != null ? (
            <Text testID="convert-gas-legs-note" style={S.fieldLegLabel}>{M.convert.crossrail.gasLegsNote}</Text>
          ) : null}
          {legPlan.map((lp, i) => {
            const leg = record.legs[i];
            const canister = leg?.canister ?? lp.canister;
            const fee = plannedLegFee(record, lp, canister);
            const label = plannedLegLabel(record, lp, canister, venueName,
              legPlan.slice(0, i).filter(x => x.kind === 'swap').length);
            return (
              <View key={i} testID={`convert-leg-${i}`} style={S.fieldLegRow}>
                <Text style={S.fieldLegLabel}>{label}</Text>
                <Text
                  testID={`convert-leg-${i}-state`}
                  style={lp.state === 'failed' ? S.fieldLegStateBad : S.fieldLegState}>
                  {fee != null ? `${legStateText(lp.state)} · ${fee}` : legStateText(lp.state)}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
