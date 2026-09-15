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
// Venue facts (display name, pool principal) are LOOKED UP from the record's/quote's own
// `venueId` against the registry (../config/venues) — never module constants (V1). Venue-less
// assets fail closed with honest copy that names what exists today (ICP ↔ VCHF), and ckUSDC's
// copy additionally names the measured-saturated direct pool refusal (spec §1). The §4 state
// machine lives in app/convert.ts; the DRIVERS live in app/convertResume.ts (the engine Wallet
// mounts once per session, V6) — this screen only RENDERS records (a view onto the engine: it
// subscribes for updates and hands freshly-prepared records to it, never running a private copy).
import {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, Text, TextInput, View} from 'react-native';
import {isValidDestinationAddress, type CurrencyDescriptor} from '../config/catalog';
import type {SelectableAsset} from '../config/assets';
import {
  CONVERT_SLIPPAGE_BPS_DEFAULT,
  CONVERT_SLIPPAGE_BPS_OPTIONS,
  resolveConvertDirection,
} from '../config/convert';
import {BUNDLED_VENUES, venueDisplayName, venueEndpointOf, venueOfId, venuesForPair, type VenueEntry} from '../config/venues';
import {
  convertRecordMinOut,
  deriveConvertMath,
  fetchConvertQuote,
  isQuoteStale,
  isTerminalConvertStep,
  loadVenueRegistry,
  prepareConvertRecord,
  prepareMultihopConvertRecord,
  TERMINAL_CONVERT_STEPS,
  type ConvertMath,
  type ConvertQuote,
  type ConvertRecord,
  type LegPlan,
} from '../convert';
import {
  acknowledgeStuckRecord,
  adoptConvertRecord,
  convertResumeSnapshot,
  subscribeConvertRecords,
} from '../convertResume';
import {fetchGasFeeWei, fetchLedgerFee} from '../services/rail';
import {multihopRoutesFrom} from '../routes';
import {formatClock} from '../i18n/intl';
import {M} from '../i18n';
import {fmtAssetCompact, parseUserAmount} from '../lib/format';
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

export function ConvertMode({identity, relayUrl, catalog, selectedAsset, assetBalances, onBack, onShowDepositAddress, onSwitchAsset}: Props) {
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
  // --- multi-hop destinations (2026-09-14 spec §7): the direct pair stays the standing
  //     default; every composed route is an EXPLICIT opt-in row — never preselected, never
  //     auto-chosen (a route chooser arrives with a second route, under the V5 rules).
  const [destRouteId, setDestRouteId] = useState<string | null>(null);
  const [destAddress, setDestAddress] = useState('');
  // The minter's live gas quote for the census + preflight — refreshed per route, re-queried
  // fresh inside prepare at confirm (the signed number is never this cached one).
  const [routeGas, setRouteGas] = useState<{feeWei: string; gasLedgerFee: string} | null>(null);
  const [routeGasErr, setRouteGasErr] = useState<string | null>(null);
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
  // The chooser's candidate rows: every venue this pair (registry order, unordered-set match).
  // `chooserMode` (2+ rows) switches the screen to the chooser layout; ONE row = today's screen.
  const pairVenues = legs != null ? venuesForPair(legs.inDesc.ledger, legs.outDesc.ledger) : [];
  const chooserVenues = pairVenues.length > 1 ? pairVenues : null;
  // Composed routes out of this asset (app/routes.ts — pure registry walk). The venue chooser
  // never coexists with a route pick: a route IS a destination choice, and its swap hop runs
  // through the route's own single registered venue.
  const routes = legs != null ? multihopRoutesFrom(catalog, legs.inDesc.currency) : [];
  const activeRoute = destRouteId != null ? routes.find(r => r.routeId === destRouteId) ?? null : null;
  const routeMode = activeRoute != null;
  const chooserMode = !routeMode && chooserVenues != null;
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
    ?? (activeRoute != null ? activeRoute.swapVenueId : REGISTERED_VENUE_ID);

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
    const rows = venuesForPair(legs.inDesc.ledger, legs.outDesc.ledger);
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
          rows.map(v => fetchConvertQuote(relayUrl, legs.inDesc.ledger, legs.outDesc.ledger, parsed.raw, {venue: v})),
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
        const q = await fetchConvertQuote(relayUrl, legs.inDesc.ledger, legs.outDesc.ledger, parsed.raw);
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
    // fetch when a destination row is picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountText, legs?.inDesc.ledger, legs?.outDesc.ledger, relayUrl, record != null && isLiveRecord(record), venueList, activeRoute?.routeId, activeRoute?.hop.ledger]);

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
          const fresh = await fetchConvertQuote(
            relayUrl, legs.inDesc.ledger,
            activeRoute != null ? activeRoute.hop.ledger : legs.outDesc.ledger,
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
  }, [quote?.fetchedAtMs, quote?.amountIn, staleRefreshing, legs?.inDesc.ledger, relayUrl, record != null && isLiveRecord(record), chooserMode, activeRoute?.routeId, activeRoute?.hop.ledger]);

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
              fetchConvertQuote(relayUrl, legs.inDesc.ledger, legs.outDesc.ledger, venueQuotes[v.venue_id].amountIn, {venue: v}),
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
  }, [chooserMode, venueQuotes, selectedVenueId, staleRefreshing, legs?.inDesc.ledger, relayUrl, record != null && isLiveRecord(record)]);

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
        // enters a composed quote's arithmetic.
        const m = await deriveConvertMath(activeQuote, legs.inFee, activeRoute != null ? activeRoute.hop.fee : legs.outFee, slippageBps);
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
  }, [activeQuote?.venueId, activeQuote?.fetchedAtMs, activeQuote?.amountOutGross, slippageBps, legs?.inDesc.ledger, activeRoute?.routeId]);

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

  const onConfirm = async () => {
    if (legs == null || activeQuote == null || math == null || confirmBusy) return;
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
    setConfirmBusy(true);
    setConfirmErr(null);
    setQuoteChanged(null);
    try {
      // Re-quote at confirm (spec §5): a moved market must be reviewed, never silently submitted.
      const fresh = await fetchConvertQuote(relayUrl, legs.inDesc.ledger, legs.outDesc.ledger, reviewed.amountIn, venueOpt);
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
        outDesc: legs.outDesc,
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
    // A PLANNED record renders its own per-leg surface — the route's leg list IS the progress UI.
    return record.legPlan != null
      ? <RouteStatePanel record={record} onBack={onBack} />
      : <StatePanel record={record} onBack={onBack} />;
  }

  const {inSym, outSym, inDecimals, outDecimals} = legs;
  const balanceRaw = selectedAsset != null && selectedAsset.protocol === 'ic' ? assetBalances[selectedAsset.currency] : undefined;
  const balanceN = balanceRaw != null ? BigInt(balanceRaw) : null;
  const balanceStr = balanceRaw != null ? fmtAssetCompact(balanceRaw, inDecimals, inSym) : null;

  // Fail closed BEFORE the confirm, never after it (2026-09-08: the button was live on a wallet
  // holding nothing — a confirm that can only be refused by the ledger). A conversion costs the
  // amount PLUS TWO input-ledger fees: the icrc2_approve, and the pool's own pull — which is
  // exactly why `prepareConvertRecord` approves `amountIn + inFee`. A null balance (not yet read)
  // fails OPEN, matching the Pay tab's gate: a balance nobody has measured is not a zero.
  const parsedIn = parseUserAmount(amountText, inDecimals);
  const neededN = parsedIn.ok && parsedIn.raw !== '0' ? BigInt(parsedIn.raw) + 2n * BigInt(legs.inFee) : null;
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

/** One planned leg's label — the kind + the leg's own canister decide the copy, never the
 *  position alone (the two asset approves differ by WHICH asset they unlock). */
function plannedLegLabel(record: ConvertRecord, lp: LegPlan, legCanister: string, venueName: string): string {
  if (lp.kind === 'swap') {
    return M.convert.multihop.legSwap(venueName, record.inSymbol, record.hopSymbol ?? record.outSymbol);
  }
  if (lp.kind === 'approve') {
    return legCanister === record.inLedger
      ? M.convert.multihop.legApprovePull(record.inSymbol)
      : M.convert.multihop.legApproveBurn(record.hopSymbol ?? record.outSymbol);
  }
  if (lp.kind === 'approve_gas') {
    return M.convert.multihop.legApproveGas(record.gasSymbol ?? 'ckETH');
  }
  return M.convert.multihop.legWithdraw(record.hopSymbol ?? record.outSymbol, record.destSymbol ?? record.outSymbol, record.destNetwork ?? '');
}

/** A leg's own fee, formatted in the FEE'S ledger's units (approve legs pay their ledger's
 *  fee; the swap leg's cost is the pool tier, shown in the census, not here; the withdraw leg
 *  charges none — its cost is the gas leg above it). */
function plannedLegFee(record: ConvertRecord, lp: LegPlan, legCanister: string): string | null {
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
  return (
    <View testID="convert-state" style={S.convertWrap}>
      <ConvertHeader title={M.convert.heading(record.inSymbol, record.outSymbol)} onBack={onBack} />

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
      ) : null}

      {record.step === 'failed_refunded' ? (
        <View testID="convert-failed">
          <Text style={S.convertStateTitle}>{M.convert.failedTitle}</Text>
          {record.failureCode === 'approve_refused' ? (
            <Text style={S.convertStateBody}>{M.convert.failedApproveBody(record.inSymbol)}</Text>
          ) : (
            <Text style={S.convertStateBody}>{M.convert.failedSwapBody(record.failureDetail ?? '', record.inSymbol, venueName)}</Text>
          )}
          <Text testID="convert-expiry" style={S.convertStateMeta}>
            {M.convert.expiryLine(formatClock(new Date(legExpiryMs)))}
          </Text>
        </View>
      ) : null}

      {record.step === 'failed_leg' ? (
        <View testID="convert-failed-leg">
          <Text style={S.convertStateTitle}>{M.convert.multihop.failedLegTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.multihop.failedLegBody(hopSymbol, record.failureDetail ?? '')}</Text>
          {/* The actionable exit (spec §4): the funds are NOT lost — they are the hop asset,
              in this wallet, and the standalone Withdraw is the door out. */}
          <Text style={S.convertChecklistWarn}>{M.convert.multihop.failedLegExit}</Text>
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
          itself by its refusal state. This list is the progress UI the route promised. */}
      <View testID="convert-route-legs" style={S.convertChecklistCard}>
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
  const canConfirm = activeQuote != null && math != null && !quoteBusy && !confirmBusy && !insufficient
    && (!routeMode || (destValid && routeGas != null && routeGasErr == null && !gasShort));
  // Route-mode quote-derived figures describe the HOP asset (ckUSDC), not the direct pair's
  // other side — the destination's own figure is the min-you'll-receive line in the checklist.
  const dispOutSym = activeRoute != null ? activeRoute.hop.symbol : outSym;
  const dispOutDecimals = activeRoute != null ? activeRoute.hop.decimals : outDecimals;
  const netStr = math != null ? fmtAssetCompact(math.netOut, dispOutDecimals, dispOutSym) : null;
  return (
    <View testID="convert-screen" style={S.convertWrap}>
      <ConvertHeader title={M.convert.heading(inSym, outSym)} onBack={onBack} />

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
          {M.convert.insufficientLine(fmtAssetCompact(neededN!.toString(), inDecimals, inSym), balanceStr!)}
        </Text>
      ) : null}

      {/* The destination picker (multi-hop, 2026-09-14 spec §7): the direct pair as the
          standing default row, plus every composed route the registry walks out of this asset.
          A destination is a decision of the same rank as a venue, so the rows use the venue
          chooser's own visual language — and the same red lines: registry order, explicit pick,
          never chosen for the user. */}
      {routes.length > 0 ? (
        <View testID="convert-dest">
          <Text style={S.convertSlippageLabel}>{M.convert.multihop.destLabel}</Text>
          <Pressable
            testID="convert-dest-direct"
            style={[S.convertVenueRow, !routeMode && S.convertVenueRowOn]}
            onPress={() => {
              setDestRouteId(null);
              setQuoteChanged(null);
            }}
            accessibilityRole="radio"
            accessibilityState={{checked: !routeMode}}
            accessibilityLabel={M.convert.multihop.destDirect(outSym)}>
            <View style={[S.convertVenueRadio, !routeMode && S.convertVenueRadioOn]}>
              {!routeMode ? <View style={S.convertVenueRadioDot} /> : null}
            </View>
            <View style={S.convertVenueRowText}>
              <Text style={[S.convertVenueName, !routeMode && S.convertVenueNameOn]}>{M.convert.multihop.destDirect(outSym)}</Text>
            </View>
          </Pressable>
          {routes.map(r => {
            const on = activeRoute?.routeId === r.routeId;
            return (
              <Pressable
                key={r.routeId}
                testID={`convert-dest-route-${r.routeId}`}
                style={[S.convertVenueRow, on && S.convertVenueRowOn]}
                onPress={() => {
                  setDestRouteId(r.routeId);
                  setQuoteChanged(null);
                }}
                accessibilityRole="radio"
                accessibilityState={{checked: on}}
                accessibilityLabel={M.convert.multihop.destRoute(r.dest.symbol, r.dest.network)}>
                <View style={[S.convertVenueRadio, on && S.convertVenueRadioOn]}>
                  {on ? <View style={S.convertVenueRadioDot} /> : null}
                </View>
                <View style={S.convertVenueRowText}>
                  <Text style={[S.convertVenueName, on && S.convertVenueNameOn]}>
                    {M.convert.multihop.destRoute(r.dest.symbol, r.dest.network)}
                  </Text>
                </View>
              </Pressable>
            );
          })}
          {/* One-route honesty (spec §7): no chooser, and the copy says exactly that. */}
          <Text testID="convert-route-note" style={S.convertMetaLine}>{M.convert.multihop.routeNote}</Text>
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
        </View>
      ) : null}

      {/* The venue chooser (multi-venue readiness V5): N rows in REGISTRY order — the relay's
          own row order, rendered verbatim and NEVER ranked or sorted by output. Each row shows
          its OWN quote, attributed + timestamped; nothing is preselected and the checklist +
          confirm below stay gated on an explicit pick. Renders only when the pair has 2+ venues
          — with one venue this whole block is absent and the screen is exactly today's.
          A route pick suppresses it entirely: the route's swap hop runs through its own single
          registered venue, and a second venue list would read as a route choice we never make. */}
      {!routeMode && chooserVenues != null ? (
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
                      {M.convert.venueRowQuote(fmtAssetCompact(vq.amountOutGross, outDecimals, outSym))}
                    </Text>
                  ) : verr != null ? (
                    <Text testID={`convert-venue-${v.venue_id}-err`} style={S.err}>{verr}</Text>
                  ) : (
                    <View style={S.convertBtnBusyRow}>
                      <ActivityIndicator color={C.sub} />
                    </View>
                  )}
                  {vq != null ? (
                    <Text testID={`convert-venue-${v.venue_id}-source`} style={S.convertMetaLine}>
                      {M.convert.quoteSource(nonBreakingClock(new Date(vq.fetchedAtMs)), venueDisplayName(v.venue_id))}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
          {selectedVenue == null ? (
            <Text testID="convert-venue-none" style={S.convertMetaLine}>
              {M.convert.venueNoneSelected}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* The decision, as one number: what actually lands in the wallet, the rate it came from,
          and whose quote it is. Everything the user is agreeing TO lives below, in the checklist. */}
      {math != null && activeQuote != null ? (
        <View testID="convert-headline" style={S.convertHeadlineCard}>
          <Text style={S.convertHeadlineLabel}>{M.convert.receiveHeadline}</Text>
          <Text style={S.convertHeadlineAmount}>{netStr}</Text>
          <View testID="convert-rate" style={S.convertRateRow}>
            <Text style={S.convertRateLabel}>{M.convert.rateLabel(inSym, dispOutSym)}</Text>
            <Text style={S.convertRateValue}>{fmtAssetCompact(scaledRate(activeQuote.amountOutGross, activeQuote.amountIn, dispOutDecimals), dispOutDecimals, dispOutSym)}</Text>
          </View>
          <Text testID="convert-quote-source" style={S.convertHeadlineMeta}>
            {M.convert.quoteSource(nonBreakingClock(new Date(activeQuote.fetchedAtMs)), venueDisplayName(activeQuote.venueId))}
          </Text>
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
      {/* Counterparty disclosure: the venue the QUOTE is attributed to names itself — display
            name and pool principal are registry lookups on the quote's own venueId, so a second
            venue cannot render under the first one's identity (V1). Before a quote arrives the
            standing disclosure names the one registered venue; attribution follows the quote —
            or, under a chooser pick, the PICKED venue (counterVenueId above). */}
        <View testID="convert-counterparty">
          <Text style={S.convertChecklistLine}>{M.convert.counterparty(venueDisplayName(counterVenueId))}</Text>
          {/* The pool principal renders only when THIS venue's own number stands behind it: the
              quote's pool echo once one arrives, or the standing single-venue disclosure. Under a
              chooser pick whose quote has not settled (or errored) NO principal renders — the
              picked venue is still named above, but an execution fact is never asserted without
              its quote, and another venue's principal is never borrowed. */}
          {activeQuote != null || !chooserMode ? (
            <Text testID="convert-pool-principal" style={S.convertPrincipal}>{activeQuote?.pool ?? venueEndpointOf(counterVenueId)}</Text>
          ) : null}
          <Text style={S.convertChecklistLine}>{M.convert.counterpartySigns}</Text>
          {/* A route names its SECOND counterparty too: the ckETH minter that executes the
              burn — its principal is an execution fact, shown as plainly as the pool's. */}
          {routeMode && activeRoute != null ? (
            <Text testID="convert-minter-principal" style={S.convertPrincipal}>{activeRoute.burn.minter}</Text>
          ) : null}
        </View>
        {/* The per-venue disclosure sentence (the registry's own `disclosure_key` picks the
            copy; an unknown key falls back to honest generic copy — fail closed). Checklist
            ONLY: the chooser rows never carry it, and in chooser mode it follows the PICKED
            venue (the counterVenueId the quote's own attribution resolves to). */}
        <Text testID="convert-venue-disclosure" style={S.convertChecklistLine}>
          {venueDisclosure(counterVenueId)}
        </Text>
        {math != null ? (
          <Text testID="convert-pool-fee" style={S.convertChecklistLine}>
            {M.convert.poolFeeTier(formatMillionthsPct(activeQuote!.feeMillionths), venueDisplayName(activeQuote!.venueId))}
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
        {math != null ? (
          <Text testID="convert-dpay-fee" style={S.convertChecklistLine}>
            {M.convert.dpayFeeLine}
          </Text>
        ) : null}
        {/* There is deliberately NO price-impact line here (V8, 2026-09-11): the venue
            publishes no impact figure, so nothing renders — the minimum-you'll-receive and
            slippage chips below are the execution protection. */}
        {math != null ? (
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
        {/* The minimum line is where route mode and direct mode part ways: a route's floor is
            the DESTINATION's floor (the burn amount is the swap's min-you'll-receive — spec
            §5), any swap surplus stays in the wallet as the hop asset, and the route's gas
            joins the census as its own itemized line. The direct min-you'll-receive stays. */}
        {math != null && routeMode && activeRoute != null ? (
          <View testID="convert-route-min">
            <Text style={S.convertMinOutLine}>
              {M.convert.multihop.routeMinLine(fmtAssetCompact(math.minOut, dispOutDecimals, activeRoute.dest.symbol), formatBps(slippageBps))}
            </Text>
            <Text style={S.convertChecklistLine}>{M.convert.multihop.routeSurplusNote(dispOutSym)}</Text>
            {routeGas != null ? (
              <Text testID="convert-gas-note" style={S.convertChecklistLine}>
                {M.convert.multihop.gasFeeLine(fmtAssetCompact(routeGas.feeWei, activeRoute.burn.gasDecimals, activeRoute.burn.gasSymbol))}
              </Text>
            ) : routeGasErr != null ? (
              <Text testID="convert-gas-note" style={S.err}>{routeGasErr}</Text>
            ) : null}
          </View>
        ) : math != null ? (
          <Text testID="convert-min-out" style={S.convertMinOutLine}>
            {M.convert.minReceiveLine(fmtAssetCompact(math.minOut, outDecimals, outSym), formatBps(slippageBps))}
          </Text>
        ) : null}
        {math != null ? (
          <Text testID="convert-refusal" style={S.convertChecklistLine}>
            {M.convert.refusalLine(inSym)}
          </Text>
        ) : null}
        {/* In route mode the END state is the destination floor above (routeMinLine) — a second
            net line naming the hop asset would read as a second promise. */}
        {math != null && netStr != null && !routeMode ? (
          <Text testID="convert-net" style={S.convertChecklistLine}>
            {M.convert.netEndStateLine(netStr)}
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
      </View>
      ) : null}

      {quoteErr != null ? (
        <Text testID="convert-quote-err" style={S.err}>
          {quoteErr}
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

/** The fail-closed panel: same entry point for every asset, honest copy for everything venue-less. */
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
        {M.convert.unavailableBody('ICP ↔ VCHF, ICP ↔ ckUSDC and ICP ↔ ckETH', REGISTERED_VENUE_NAME)}
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
          <Text testID="convert-expiry" style={S.convertStateMeta}>
            {M.convert.expiryLine(formatClock(new Date(legExpiryMs)))}
          </Text>
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
          <Text style={S.convertStateMeta}>{M.convert.stillWatching}</Text>
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

/** price(out) per 1 unit of in, scaled to the OUTPUT ledger's own decimals via BigInt (exact,
 *  floor) — the scale is threaded in from the catalog row, never a hardcoded 8. */
function scaledRate(outGross: string, amountIn: string, outDecimals: number): string {
  const out = BigInt(outGross);
  const inn = BigInt(amountIn);
  if (inn <= 0n) return '0';
  return ((out * 10n ** BigInt(outDecimals)) / inn).toString();
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
