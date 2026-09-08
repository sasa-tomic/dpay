// ConvertMode — the delegated-conversion surface (spec 2026-09-07 §5), opened from the Balances
// action row for EVERY selected asset (uniform-IA hard rule). One screen carries the whole
// transparency checklist BEFORE anything is signed — no tap-to-reveal, no second surface:
//   * counterparty: the ICPSwap pool canister (autonomous contract, not a licensed provider,
//     not dpay) + "your phone signs; the pool pulls exactly the approved amount";
//   * the venue's own quote, attributed + timestamped, auto-refreshed when stale (>30 s) and
//     re-quoted at confirm (a changed quote demands a fresh review, never a silent submit);
//   * every fee on its own line (pool tier, input fee, output fee, dpay = nothing either way);
//   * price impact from the quote (warned above 5%); minimum-you'll-receive + the refusal
//     outcome; the exact net end-state amount; and every failure branch names which asset the
//     user is left holding and that dpay cannot reverse it.
// Venue-less assets fail closed with honest copy that names what exists today (ICP ↔ VCHF), and
// ckUSDC's copy additionally names the measured-saturated direct pool refusal (spec §1). The
// §4 state machine lives in app/convert.ts and is persisted in AsyncStorage — this component only
// renders records and (re)starts the executor with identical signed bytes on resume.
import {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, Text, TextInput, View} from 'react-native';
import type {CurrencyDescriptor} from '../config/catalog';
import type {SelectableAsset} from '../config/assets';
import {
  CONVERT_POOL_PRINCIPAL,
  CONVERT_SLIPPAGE_BPS_DEFAULT,
  CONVERT_SLIPPAGE_BPS_OPTIONS,
  resolveConvertDirection,
} from '../config/convert';
import {
  deriveConvertMath,
  executeConvert,
  fetchConvertQuote,
  isQuoteStale,
  loadConvertRecords,
  prepareConvertRecord,
  type ConvertMath,
  type ConvertQuote,
  type ConvertRecord,
} from '../convert';
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

const TERMINAL_STEPS = new Set<ConvertRecord['step']>(['done', 'failed_refunded', 'stuck']);
/** A record past 'quote'/'confirming' means signed bytes exist — the screen must show state, not a form. */
const isLiveRecord = (r: ConvertRecord | null): boolean =>
  r !== null && !TERMINAL_STEPS.has(r.step) && r.step !== 'quote' && r.step !== 'confirming';

export function ConvertMode({identity, relayUrl, catalog, selectedAsset, assetBalances, onBack, onActivity, onShowDepositAddress, onSwitchAsset}: Props) {
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
  const runBusyRef = useRef(false);
  const mountedRef = useRef(true);
  const legs: ConvertLegs | null = selectedAsset != null && selectedAsset.protocol === 'ic'
    ? resolveLegs(catalog, selectedAsset)
    : null;

  // Restart the executor for a persisted in-flight record (device closed mid-swap) with the SAME
  // signed bytes — request-id dedup on the ledger makes the resubmission a no-op, and the record
  // is never rebuilt mid-swap (spec §4 identical-envelope retry discipline).
  const runExecutor = async (start: ConvertRecord) => {
    runBusyRef.current = true;
    try {
      await executeConvert(start, {
        secretHex: identity.secretHex,
        publicHex: identity.publicHex,
        relayUrl,
        onUpdate: (r) => {
          if (!mountedRef.current) return;
          setRecord({...r});
          if (TERMINAL_STEPS.has(r.step)) onActivity();
        },
      }, {
        // Generous by design (spec §4: retries re-submit the SAME signed bytes — request-id
        // dedup makes it a no-op): a swap surface must tolerate a slow network without
        // parking on `stuck`, and the settle watch keeps running while the screen is open.
        submitAttempts: 3,
        poll: {attempts: 30, intervalMs: 500},
        settleAttempts: 40,
        settleIntervalMs: 1500,
      });
    } finally {
      runBusyRef.current = false;
    }
  };

  // --- resume on mount: newest persisted non-terminal record (or a pending_withdrawal watch).
  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      const records = await loadConvertRecords();
      if (!mountedRef.current) return;
      const live = Object.values(records)
        .filter((r) => isLiveRecord(r) || r.step === 'pending_withdrawal')
        .sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
      if (live != null) {
        setRecord(live);
        await runExecutor(live);
      }
    })();
    return () => {
      mountedRef.current = false;
    };
    // identity/relayUrl are stable for the wallet session; resume must run once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- pending_withdrawal keeps watching while the screen is open: the executor's settle loop
  //     exhausted, so re-arm it (submissions are skipped at this step; the ledger watch re-probes).
  useEffect(() => {
    if (record == null || record.step !== 'pending_withdrawal' || runBusyRef.current) return;
    const current = record;
    const timer = setTimeout(() => {
      if (!mountedRef.current || runBusyRef.current) return;
      void runExecutor(current);
    }, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.step, record?.id]);

  // --- quote fetch: only for a valid positive amount while the form (not a record) is showing.
  useEffect(() => {
    if (legs == null || isLiveRecord(record)) return;
    const parsed = parseUserAmount(amountText, legs.inDecimals);
    if (!parsed.ok || parsed.raw === '0') {
      setQuote(null);
      setMath(null);
      setQuoteErr(null);
      setQuoteChanged(null);
      return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountText, legs?.inDesc.ledger, legs?.outDesc.ledger, relayUrl, record != null && isLiveRecord(record)]);

  // --- stale refresh: >30 s old (test-seam overridable via __DPAY_TEST_CONVERT_STALE_MS) → fetch
  //     a fresh quote in place; a moved amount is surfaced as a review line, never silently kept.
  useEffect(() => {
    if (quote == null || legs == null || isLiveRecord(record)) return;
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
  }, [quote?.fetchedAtMs, quote?.amountIn, staleRefreshing, legs?.inDesc.ledger, relayUrl, record != null && isLiveRecord(record)]);

  // --- derivations (min-out is computed by the tested core — DpayCore.icpSwapMinOut — never in TS).
  useEffect(() => {
    if (quote == null || legs == null) {
      setMath(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const m = await deriveConvertMath(quote, legs.inFee, legs.outFee, slippageBps);
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
  }, [quote?.fetchedAtMs, quote?.amountOutGross, slippageBps, legs?.inDesc.ledger]);

  const onConfirm = async () => {
    if (legs == null || quote == null || math == null || confirmBusy || runBusyRef.current) return;
    setConfirmBusy(true);
    setConfirmErr(null);
    setQuoteChanged(null);
    try {
      // Re-quote at confirm (spec §5): a moved market must be reviewed, never silently submitted.
      const fresh = await fetchConvertQuote(relayUrl, legs.inDesc.ledger, legs.outDesc.ledger, quote.amountIn);
      if (fresh.amountOutGross !== quote.amountOutGross) {
        setQuote(fresh);
        setQuoteChanged({oldAmt: quote.amountOutGross, newAmt: fresh.amountOutGross});
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
      setRecord(rec);
      await runExecutor(rec);
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
            be made honestly HERE, where a generic "switch to BTC" could not: the PoC venue trades
            exactly ONE unordered pair (`CONVERT_VENUE_LEDGERS`), so the only account that could
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

  const canConfirm = quote != null && math != null && !quoteBusy && !confirmBusy && !insufficient;
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

      {/* The decision, as one number: what actually lands in the wallet, the rate it came from,
          and whose quote it is. Everything the user is agreeing TO lives below, in the checklist. */}
      {math != null && quote != null ? (
        <View testID="convert-headline" style={S.convertHeadlineCard}>
          <Text style={S.convertHeadlineLabel}>{M.convert.receiveHeadline}</Text>
          <Text style={S.convertHeadlineAmount}>{netStr}</Text>
          <View testID="convert-rate" style={S.convertRateRow}>
            <Text style={S.convertRateLabel}>{M.convert.rateLabel(inSym, outSym)}</Text>
            <Text style={S.convertRateValue}>{fmtAsset(scaledRate(quote.amountOutGross, quote.amountIn), outDecimals, outSym)}</Text>
          </View>
          <Text testID="convert-quote-source" style={S.convertHeadlineMeta}>
            {M.convert.quoteSource(formatClock(new Date(quote.fetchedAtMs)))}
          </Text>
        </View>
      ) : null}

      <View style={S.convertChecklistCard}>
        <View testID="convert-counterparty">
          <Text style={S.convertChecklistLine}>{M.convert.counterparty}</Text>
          <Text testID="convert-pool-principal" style={S.convertPrincipal}>{CONVERT_POOL_PRINCIPAL}</Text>
          <Text style={S.convertChecklistLine}>{M.convert.counterpartySigns}</Text>
        </View>
        {math != null ? (
          <Text testID="convert-pool-fee" style={S.convertChecklistLine}>
            {M.convert.poolFeeTier(formatMillionthsPct(quote!.feeMillionths))}
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
        {math != null ? (
          <Text
            testID={math.impactBps != null && math.impactWarn ? 'convert-impact-warn' : 'convert-impact'}
            style={math.impactBps != null && math.impactWarn ? S.convertChecklistWarn : S.convertChecklistLine}>
            {math.impactBps == null
              ? M.convert.impactUnavailable
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
        {M.convert.unavailableBody('ICP ↔ Swiss francs (VCHF)')}
      </Text>
      {selectedAsset != null && selectedAsset.protocol === 'ic' && selectedAsset.currency === 2 ? (
        <Text testID="convert-unavailable-ckusdc" style={S.convertUnavailableBody}>
          {M.convert.unavailableCkusdc}
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
  // stuck/pending states show when the approval expires — a 30 s tick keeps that line honest.
  useEffect(() => {
    if (record.step !== 'stuck' && record.step !== 'pending_withdrawal') return;
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [record.step]);
  const {inSymbol, outSymbol} = record;
  return (
    <View testID="convert-state" style={S.convertWrap}>
      <ConvertHeader title={M.convert.heading(inSymbol, outSymbol)} onBack={onBack} />

      {record.step === 'approving' || record.step === 'approved' ? (
        <View testID="convert-approving">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.approvingTitle}</Text>
          <Text style={S.convertStateBody}>
            {M.convert.approvingBody(fmtAsset(record.amountIn, 8, inSymbol), formatClock(new Date(record.approveExpiresAtMs)))}
          </Text>
        </View>
      ) : null}
      {record.step === 'swapping' ? (
        <View testID="convert-swapping">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.swappingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.swappingBody}</Text>
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
            {M.convert.pendingBody(outSymbol, '65mrh-fqaaa-aaaar-qapoa-cai', formatClock(new Date(record.createdAtMs)))}
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
            <Text style={S.convertStateBody}>{M.convert.failedSwapBody(record.failureDetail ?? '', inSymbol)}</Text>
          ) : (
            <Text style={S.convertStateBody}>{M.convert.refundedBody(inSymbol)}</Text>
          )}
          <Text testID="convert-expiry" style={S.convertStateMeta}>
            {M.convert.expiryLine(formatClock(new Date(record.approveExpiresAtMs)))}
          </Text>
        </View>
      ) : null}
      {record.step === 'stuck' ? (
        <View testID="convert-stuck">
          <Text style={S.convertStateTitle}>{M.convert.stuckTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.stuckBody}</Text>
          <Text style={S.convertStateMeta}>
            {M.convert.stuckSigned(fmtAsset(record.amountIn, 8, inSymbol), fmtAsset(record.amountOutMin, 8, outSymbol))}
          </Text>
          <Text testID="convert-expiry" style={S.convertStateMeta}>
            {M.convert.expiryLine(formatClock(new Date(record.approveExpiresAtMs)))}
          </Text>
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
