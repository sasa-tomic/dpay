// ConvertMode — the delegated-conversion surface (spec 2026-09-07 §5), opened from the Balances
// action row for EVERY selected asset (uniform-IA hard rule). One screen carries the whole
// transparency checklist BEFORE anything is signed — no tap-to-reveal, no second surface:
//   * counterparty: the venue's pool canister, named by its registry display name (autonomous
//     contract, not a licensed provider, not dpay) + "your phone signs; the pool pulls exactly
//     the approved amount";
//   * the venue's own quote, attributed + timestamped, auto-refreshed when stale (>30 s) and
//     re-quoted at confirm (a changed quote demands a fresh review, never a silent submit);
//   * every fee on its own line (pool tier, input fee, output fee, dpay = nothing either way);
//   * price impact ONLY when the venue's model supports measuring it (the IC-AMM curve) — other
//     venue kinds get no impact line at all, never a faked number (V8);
//   * minimum-you'll-receive + the refusal outcome; the exact net end-state amount; and every
//     failure branch names which asset the user is left holding and that dpay cannot reverse it.
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
import type {CurrencyDescriptor} from '../config/catalog';
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
  type ConvertMath,
  type ConvertQuote,
  type ConvertRecord,
} from '../convert';
import {
  acknowledgeStuckRecord,
  adoptConvertRecord,
  convertResumeSnapshot,
  subscribeConvertRecords,
} from '../convertResume';
import {formatClock} from '../i18n/intl';
import {M} from '../i18n';
import {fmtAsset, parseUserAmount} from '../lib/format';
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

const TERMINAL_STEPS = new Set<ConvertRecord['step']>(['done', 'failed_refunded', 'stuck', 'quote_expired', 'provider_refunded']);
/** A record past 'quote'/'confirming' means signed bytes or a provider order exist — the screen
 *  must show state, not a form. */
const isLiveRecord = (r: ConvertRecord | null): boolean =>
  r !== null && !isTerminalConvertStep(r.step) && r.step !== 'quote' && r.step !== 'confirming';

/** The name of the one registered REAL conversion venue — for the fail-closed panel's honest
 *  "what exists today" copy (a registry lookup, not a literal; the chooser itself renders
 *  whatever `venuesForPair` serves, V5). */
const REGISTERED_VENUE_ID = BUNDLED_VENUES.find(v => v.kind === 'ic_amm' && !v.testnet)?.venue_id ?? '';
const REGISTERED_VENUE_NAME = venueDisplayName(REGISTERED_VENUE_ID);

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
  // OWN attribution (venue_id) takes over (V1).
  const counterVenueId = activeQuote?.venueId ?? REGISTERED_VENUE_ID;

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
    // world) the rows re-fetch per venue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountText, legs?.inDesc.ledger, legs?.outDesc.ledger, relayUrl, record != null && isLiveRecord(record), venueList]);

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
          const fresh = await fetchConvertQuote(relayUrl, legs.inDesc.ledger, legs.outDesc.ledger, quote.amountIn);
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
  }, [quote?.fetchedAtMs, quote?.amountIn, staleRefreshing, legs?.inDesc.ledger, relayUrl, record != null && isLiveRecord(record), chooserMode]);

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
        const m = await deriveConvertMath(activeQuote, legs.inFee, legs.outFee, slippageBps);
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
  }, [activeQuote?.venueId, activeQuote?.fetchedAtMs, activeQuote?.amountOutGross, slippageBps, legs?.inDesc.ledger]);

  const onConfirm = async () => {
    if (legs == null || activeQuote == null || math == null || confirmBusy) return;
    // Chooser mode: the confirm executes through the PICKED row's venue — the fresh quote, the
    // record's venueId and the signed legs all follow that one pick (Wave-1 pool-keyed legs).
    const venueOpt = chooserMode ? {venue: selectedVenue ?? undefined} : {};
    const reviewed = activeQuote;
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
  if (record != null && (isLiveRecord(record) || TERMINAL_STEPS.has(record.step))) {
    return <StatePanel record={record} onBack={onBack} />;
  }

  const {inSym, outSym, inDecimals, outDecimals} = legs;
  const balanceRaw = selectedAsset != null && selectedAsset.protocol === 'ic' ? assetBalances[selectedAsset.currency] : undefined;
  const balanceN = balanceRaw != null ? BigInt(balanceRaw) : null;
  const balanceStr = balanceRaw != null ? fmtAsset(balanceRaw, inDecimals, inSym) : null;

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
      ? fmtAsset(otherRaw, outDecimals, outSym)
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

  // In chooser mode this also withholds the confirm until a row is picked (activeQuote is null
  // without a selection — the none-preselected red line, expressed as data, not as a flag).
  const canConfirm = activeQuote != null && math != null && !quoteBusy && !confirmBusy && !insufficient;
  const netStr = math != null ? fmtAsset(math.netOut, outDecimals, outSym) : null;
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
          {M.convert.insufficientLine(fmtAsset(neededN!.toString(), inDecimals, inSym), balanceStr!)}
        </Text>
      ) : null}

      {/* The venue chooser (multi-venue readiness V5): N rows in REGISTRY order — the relay's
          own row order, rendered verbatim and NEVER ranked or sorted by output. Each row shows
          its OWN quote, attributed + timestamped; nothing is preselected and the checklist +
          confirm below stay gated on an explicit pick. Renders only when the pair has 2+ venues
          — with one venue this whole block is absent and the screen is exactly today's. */}
      {chooserVenues != null ? (
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
                accessibilityState={{selected: on}}
                accessibilityLabel={v.display_name}>
                <View style={S.convertVenueRowText}>
                  <Text style={[S.convertVenueName, on && S.convertVenueNameOn]}>{v.display_name}</Text>
                  {vq != null ? (
                    <Text testID={`convert-venue-${v.venue_id}-quote`} style={S.convertVenueAmount}>
                      {M.convert.venueRowQuote(fmtAsset(vq.amountOutGross, outDecimals, outSym))}
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
                      {M.convert.quoteSource(formatClock(new Date(vq.fetchedAtMs)), venueDisplayName(v.venue_id))}
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
            <Text style={S.convertRateLabel}>{M.convert.rateLabel(inSym, outSym)}</Text>
            <Text style={S.convertRateValue}>{fmtAsset(scaledRate(activeQuote.amountOutGross, activeQuote.amountIn), outDecimals, outSym)}</Text>
          </View>
          <Text testID="convert-quote-source" style={S.convertHeadlineMeta}>
            {M.convert.quoteSource(formatClock(new Date(activeQuote.fetchedAtMs)), venueDisplayName(activeQuote.venueId))}
          </Text>
        </View>
      ) : null}

      {/* In chooser mode the checklist (like the headline) appears only under an explicit pick —
          with one venue the card renders exactly as it always has. */}
      {(!chooserMode || selectedVenue != null) ? (
      <View style={S.convertChecklistCard}>
      {/* Counterparty disclosure: the venue the QUOTE is attributed to names itself — display
            name and pool principal are registry lookups on the quote's own venueId, so a second
            venue cannot render under the first one's identity (V1). Before a quote arrives the
            standing disclosure names the one registered venue; attribution follows the quote. */}
        <View testID="convert-counterparty">
          <Text style={S.convertChecklistLine}>{M.convert.counterparty(venueDisplayName(counterVenueId))}</Text>
          <Text testID="convert-pool-principal" style={S.convertPrincipal}>{activeQuote?.pool ?? venueEndpointOf(counterVenueId)}</Text>
          <Text style={S.convertChecklistLine}>{M.convert.counterpartySigns}</Text>
        </View>
        {math != null ? (
          <Text testID="convert-pool-fee" style={S.convertChecklistLine}>
            {M.convert.poolFeeTier(formatMillionthsPct(activeQuote!.feeMillionths), venueDisplayName(activeQuote!.venueId))}
          </Text>
        ) : null}
        {math != null ? (
          <Text testID="convert-in-fee" style={S.convertChecklistLine}>
            {M.convert.inputFeeLine(fmtAsset(math.inFee, inDecimals, inSym))}
          </Text>
        ) : null}
        {math != null ? (
          <Text testID="convert-out-fee" style={S.convertChecklistLine}>
            {M.convert.outputFeeLine(fmtAsset(math.outFee, outDecimals, outSym))}
          </Text>
        ) : null}
        {math != null ? (
          <Text testID="convert-dpay-fee" style={S.convertChecklistLine}>
            {M.convert.dpayFeeLine}
          </Text>
        ) : null}
        {/* Impact is a MEASUREMENT the venue model must support (V8): only an IC-AMM curve gets
            the line (measured against the venue's own near-zero reference — never a second
            fetched reference beyond it); any other venue kind gets NO line, not a faked one.
            Unknown venue kind → no line (fail closed, never a guess). */}
        {math != null && venueOfId(activeQuote?.venueId ?? '')?.kind === 'ic_amm' ? (
          <Text
            testID={math.impactBps != null && math.impactWarn ? 'convert-impact-warn' : 'convert-impact'}
            style={math.impactBps != null && math.impactWarn ? S.convertChecklistWarn : S.convertChecklistLine}>
            {math.impactBps == null
              ? M.convert.impactUnavailable(venueDisplayName(activeQuote!.venueId))
              : math.impactWarn
                ? M.convert.impactWarnLine(formatBps(math.impactBps))
                : M.convert.impactLine(formatBps(math.impactBps))}
          </Text>
        ) : null}
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
        {math != null ? (
          <Text testID="convert-min-out" style={S.convertMinOutLine}>
            {M.convert.minReceiveLine(fmtAsset(math.minOut, outDecimals, outSym), formatBps(slippageBps))}
          </Text>
        ) : null}
        {math != null ? (
          <Text testID="convert-refusal" style={S.convertChecklistLine}>
            {M.convert.refusalLine(inSym)}
          </Text>
        ) : null}
        {math != null && netStr != null ? (
          <Text testID="convert-net" style={S.convertChecklistLine}>
            {M.convert.netEndStateLine(netStr)}
          </Text>
        ) : null}
        {staleRefreshing ? (
          <Text testID="convert-stale" style={S.convertMetaLine}>
            {M.convert.staleRefreshing}
          </Text>
        ) : null}
        {quoteChanged != null ? (
          <Text testID="convert-quote-changed" style={S.convertChecklistWarn}>
            {M.convert.quoteChanged(
              fmtAsset(quoteChanged.oldAmt, outDecimals, outSym),
              fmtAsset(quoteChanged.newAmt, outDecimals, outSym),
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
        {M.convert.unavailableBody('ICP ↔ Swiss francs (VCHF)', REGISTERED_VENUE_NAME)}
      </Text>
      {selectedAsset != null && selectedAsset.protocol === 'ic' && selectedAsset.currency === 2 ? (
        <Text testID="convert-unavailable-ckusdc" style={S.convertUnavailableBody}>
          {M.convert.unavailableCkusdc(REGISTERED_VENUE_NAME)}
        </Text>
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
            {M.convert.approvingBody(fmtAsset(record.amountIn, 8, inSymbol), formatClock(new Date(legExpiryMs)))}
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
          <Text style={S.convertStateBody}>{M.convert.doneBody(fmtAsset(record.outAmountNet ?? '0', 8, outSymbol))}</Text>
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
              {M.convert.stuckSigned(fmtAsset(record.amountIn, 8, inSymbol), fmtAsset(minOut, 8, outSymbol), venueName)}
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

/** price(out) per 1 unit of in, scaled to the output ledger's decimals via BigInt (exact, floor). */
function scaledRate(outGross: string, amountIn: string): string {
  const out = BigInt(outGross);
  const inn = BigInt(amountIn);
  if (inn <= 0n) return '0';
  return ((out * 10n ** 8n) / inn).toString();
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
