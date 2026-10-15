import {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Platform, Pressable, ScrollView, Text, TextInput, View} from 'react-native';
import {AppModal} from './AppModal';
import {MtpWidgetEmbed} from './MtpWidgetEmbed';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {formatClock, formatMonthDayYear} from '../i18n/intl';
import {useEscapeToClose} from '../hooks/useHotkeys';
import type {SelectableAsset} from '../config/assets';
import {MTP_FACTS_READ_ON, type MtpBuyAsset} from '../config/funding';
import {toBaseUnitsSoft} from '../evm/chains';
import {cmpRaw} from '../lib/amount';
import {fmtAssetCompact, randNonceHex, toUnits} from '../lib/format';
import {StatePanel} from './ConvertStatePanel';
import {openWidgetUrl} from './MtpBuySheet';
import {widgetTokenOf} from '../services/mtpelerin';
import {buildMtpSellWidgetLink} from '../ramp/mtpelerin';
import {adoptConvertRecord, convertResumeSnapshot, subscribeConvertRecords} from '../convertResume';
import type {ConvertRecord} from '../convert/types';
import {
  createMtpCashOrder, fetchMtpCashQuote, mtpCashStatusUrl, mtpSellNetworkOf,
  type MtpCashQuote,
} from '../services/mtpelerin';

// MtpCashOutSheet - the Mt Pelerin OFF-ramp's ONE surface (plan R2 step 2). Two phases in
// one root-mounted card (the MtpBuySheet mount discipline):
//
//   form      amount; the quote is fetched THROUGH THE RELAY and shown attributed +
//             timestamped (plan §4: relayed, never computed); the provider's own published
//             figures ride verbatim + dated. Continue REGISTERS the sell order THROUGH THE
//             RELAY (local creation since the venue's API tier closed for dpay,
//             2026-10-13: the relay mints the `mtp-…` correlation id; the bank details and
//             the deposit address are the WIDGET SESSION's to collect - dpay collects
//             neither). The adopted lifecycle record is born HERE (the C1 moment moved
//             with the flow: value moves only inside the user's widget session, which dpay
//             cannot observe, so the watch starts at registration).
//   lifecycle the adopted record renders through ConvertStatePanel under the widget
//             handoff note; the sell widget (the venue's documented bare URL - no sell-side
//             or correlation parameters are documented, so nothing is prefilled and no oid
//             can ride it, the ramp builder's doc) opens IN-APP on native (the embed - the
//             relay injects the `_ctkn` server-side, the client never holds it), EXTERNAL
//             on web and whenever the token fetch fails (the fallback; the
//             `__DPAY_TEST_MTP_OPEN` seam rides only that path - an open failure keeps the
//             sheet with its honest line and a retry). The panel is webhook-first - the
//             relay's status store answers with zero upstream calls and caps reads at one
//             per order per minute; the engine mirrors that floor client-side. The provider
//             Stop semantics are the C2 flavor: dpay stops watching, the venue order's life
//             is the venue's.
//
// CANCEL vs CLOSE: only the form's Cancel button rejects. Backdrop, Escape and Android Back
// dismiss without answering anything. The typed error exists so the mounting Wallet (and
// tests) can tell a refusal from a dismissal — the MtpBuySheet precedent.

/** The typed user-rejected outcome (the MtpBuyUserRejected semantics, localized to this
 *  sheet): Cancel refused the cash-out form — no order was created, nothing was signed,
 *  nothing was sent. */
export class MtpCashOutUserRejected extends Error {
  constructor() {
    super('user rejected the Mt Pelerin cash-out');
    this.name = 'MtpCashOutUserRejected';
  }
}

/** The lifecycle record a successful registration adopts (pure; jest-pinned). Legless +
 *  providerRef (the CeFi shape), born `awaiting_deposit` at REGISTRATION (the widget flow's
 *  C1 moment: value moves only inside the user's own widget session, which dpay cannot
 *  observe, so the watch starts here). NO `providerDeposit` block: dpay never learns a
 *  deposit address (the venue's own widget session holds it and the webhook payload never
 *  carries one), and a handoff block without an address would invite a transfer to
 *  nothing. `expectedNet` is the QUOTE's net fiat figure (the venue's own `destAmount`,
 *  converted to minor units for the record's raw-money field - the same normalization
 *  every cefi deposit block applies); no fee split is recorded because the venue publishes
 *  none for this method (the net figure already includes all fees). */
export function buildMtpCashOutRecord(args: {
  id: string;
  createdAtMs: number;
  venueId: string;
  /** The dpay order id (the relay's `mtp-…` correlation id) — providerRef.orderId AND the
   *  status route's key. */
  orderId: string;
  statusUrl: string;
  /** The input rail identifier: the ERC-20 contract, lowercase (the Solana-record convention:
   *  no IC catalog ids on this rail — the ledger string names the token contract). */
  inLedger: string;
  /** The exact decimal amount the user registered (the typed figure, verbatim). */
  registeredAmountDecimal: string;
  /** The same amount in the token's raw units — the record's amountIn. */
  amountIn: string;
  inSymbol: string;
  inDecimals: number;
  /** The venue's own net fiat figure for the amount (decimal string) — the expected end
   *  state. CHF is the v1 payout currency (plan §8 item 4). */
  expectedFiatDecimal: string;
}): ConvertRecord {
  return {
    id: args.id,
    createdAtMs: args.createdAtMs,
    step: 'awaiting_deposit',
    venueId: args.venueId,
    // The record's rail identifiers, Solana-record convention (no IC catalog ids on this
    // rail): the input side is the token contract, the output side is the fiat code —
    // hydration's cefi exemption covers the absent currency ids exactly like the SOL-side
    // cefi records'.
    inLedger: args.inLedger,
    outLedger: 'CHF',
    inSymbol: args.inSymbol,
    outSymbol: 'CHF',
    inDecimals: args.inDecimals,
    outDecimals: 2,
    amountIn: args.amountIn,
    expectedGross: toUnits(args.expectedFiatDecimal, 2),
    expectedNet: toUnits(args.expectedFiatDecimal, 2),
    inFee: '0',
    outFee: '0',
    slippageBps: 0,
    legs: [],
    providerRef: {orderId: args.orderId, statusUrl: args.statusUrl},
  };
}

export function MtpCashOutSheet({relayUrl, asset, token, balance, onClose, onReject, onWidgetOpened}: {
  /** The relay this phone talks to — the quote, the order AND the record's status read all
   *  ride it (the trocador-family rule: there is no keyless venue surface here). */
  relayUrl: string;
  /** The SELECTED EVM asset row - the sale sells THIS token on THIS chain. The opener
   *  resolved it through `mtpCashOutEligible`, so `token` always has a value. */
  asset: SelectableAsset & {protocol: 'evm'};
  token: MtpBuyAsset;
  /** The token's LAST-KNOWN raw balance - the form's over-balance gate reads the same view. */
  balance: string | null;
  onClose: () => void;
  /** Cancel observes the typed user-rejected error. Absent = Cancel simply closes. */
  onReject?: (e: MtpCashOutUserRejected) => void;
  /** Fired once the sell widget link OPENED (the MtpBuySheet contract): the mounting Wallet
   *  arms its useAppActive rising-edge refresh with it. */
  onWidgetOpened?: () => void;
}) {
  const [phase, setPhase] = useState<'form' | 'lifecycle'>('form');
  const [amountStr, setAmountStr] = useState('');
  const [quote, setQuote] = useState<MtpCashQuote | null>(null);
  const [quotePending, setQuotePending] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const quoteSeq = useRef(0);
  const [ordering, setOrdering] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [record, setRecord] = useState<ConvertRecord | null>(null);
  const [liveRecord, setLiveRecord] = useState<ConvertRecord | null>(null);
  const [widgetFailed, setWidgetFailed] = useState(false);
  /** The tokenized widget URL while the IN-APP embed is open (null = closed). */
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);

  // One Esc closes one thing: the embed layer owns Escape while open; the lifecycle phase
  // keeps the sheet's own handler off (the panel's Back button is the exit there).
  useEscapeToClose(embedUrl != null ? () => {} : (phase === 'form' ? onClose : () => {}));

  const decimals = asset.decimals;
  const unit = asset.symbol;
  const fmt = (rawAmount: string) => fmtAssetCompact(rawAmount, decimals, unit, undefined, asset.minFractionDigits);

  // The amount's raw units + the balance gate (the venue's own economics, mirrored so the
  // form cannot price an impossible cash-out).
  const raw = toBaseUnitsSoft(amountStr, decimals);
  const balanceKnown = balance != null;
  const overBalance = balanceKnown && cmpRaw(raw, balance!) > 0;

  const amountOk = raw !== '0' && !overBalance;
  const sourceNetwork = mtpSellNetworkOf(asset.chainId);

  // The relay quote (plan §4): fetched while the amount is sendable, debounced and
  // seq-guarded like the send sheet's fee quote. A failed quote renders its own line and the
  // next keystroke retries; nothing is ever computed client-side.
  useEffect(() => {
    const seq = ++quoteSeq.current;
    setQuote(null);
    setQuotePending(false);
    setQuoteErr(null);
    if (!amountOk) return;
    setQuotePending(true);
    const t = setTimeout(() => {
      fetchMtpCashQuote(relayUrl, {
        sourceCurrency: token,
        destCurrency: 'CHF',
        sourceAmount: amountStr.trim(),
        ...(sourceNetwork != null ? {sourceNetwork} : {}),
      })
        .then(q => { if (seq === quoteSeq.current) { setQuote(q); setQuotePending(false); } })
        .catch((e: unknown) => {
          if (seq !== quoteSeq.current) return;
          setQuote(null);
          setQuotePending(false);
          setQuoteErr(orderErrLine(e));
        });
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountStr, token, relayUrl, sourceNetwork, amountOk]);

  // The adopted record's LIVE copy (the engine view, ConvertMode's pattern): the panel renders
  // from the engine's snapshot so polls and aborts arrive while the sheet stays open.
  useEffect(() => {
    if (record == null) return;
    const pick = (records: Record<string, ConvertRecord>) => setLiveRecord(records[record.id] ?? null);
    pick(convertResumeSnapshot());
    return subscribeConvertRecords(pick);
  }, [record]);

  // The widget handoff: the EMBED first (native — the tokenized URL comes from the RELAY,
  // the `_ctkn` is injected server-side and the client never holds it), the EXTERNAL open
  // as the web-platform and token-fetch-failure fallback (any service word — unconfigured
  // relay, limiter, transport — falls back; the `__DPAY_TEST_MTP_OPEN` seam rides only this
  // path). An open failure keeps the sheet with its honest line and a retry (the
  // registration + the watch stand; only the window is missing).
  const openSellWidget = useCallback(async () => {
    const url = buildMtpSellWidgetLink();
    // `__DPAY_TEST_MTP_EMBED` lets the web-hosted flow tier exercise the embed path
    // (prod web never sets it, so web keeps the external open).
    if (Platform.OS !== 'web' || (globalThis as {__DPAY_TEST_MTP_EMBED?: boolean}).__DPAY_TEST_MTP_EMBED === true) {
      try {
        const tokened = await widgetTokenOf(relayUrl, url);
        setEmbedUrl(tokened);
        setWidgetFailed(false);
        onWidgetOpened?.();
        return;
      } catch (e) {
        // fall through to the external open — the fallback IS the feature here
      }
    }
    try {
      await openWidgetUrl(url);
      setWidgetFailed(false);
      onWidgetOpened?.();
    } catch {
      setWidgetFailed(true);
    }
  }, [relayUrl, onWidgetOpened]);

  const continueCashOut = useCallback(async () => {
    // quoteOk on the gate: the order is registered only when the venue's attributed net figure is
    // on screen (the review's honesty law) - no quote, no order, never a '0 expected' record.
    if (!amountOk || quote == null || ordering) return;
    setOrdering(true);
    setErr(null);
    try {
      // The correlation id is minted HERE, before the order exists (the partner-agreement
      // law): the record that persists locally IS the id the relay logs for this order.
      const recordId = randNonceHex();
      const created = await createMtpCashOrder(relayUrl, {
        sourceCurrency: token,
        destCurrency: 'CHF',
        sourceAmount: amountStr.trim(),
        ...(sourceNetwork != null ? {sourceNetwork} : {}),
        clientOrderId: recordId,
      });
      // The record is born at REGISTRATION (the widget flow's C1 moment): the sale itself
      // - the deposit to the venue's own address - happens inside the user's widget
      // session, which dpay cannot observe, so the watch starts here and the engine drives
      // it whether or not this sheet stays open. A kill after this point still leaves the
      // record live in the engine (crash safety: the correlation order exists).
      const rec = buildMtpCashOutRecord({
        id: `${created.orderId}`,
        createdAtMs: Date.now(),
        venueId: 'mtpelerin',
        orderId: created.orderId,
        statusUrl: mtpCashStatusUrl(relayUrl, created.orderId),
        inLedger: asset.address.toLowerCase(),
        registeredAmountDecimal: amountStr.trim(),
        amountIn: raw,
        inSymbol: unit,
        inDecimals: decimals,
        expectedFiatDecimal: quote.destAmount,
      });
      setRecord(rec);
      void adoptConvertRecord(rec);
      setPhase('lifecycle');
      await openSellWidget();
    } catch (e: unknown) {
      setErr(orderErrLine(e));
    } finally {
      setOrdering(false);
    }
  }, [amountOk, quote, ordering, relayUrl, token, amountStr, sourceNetwork, asset.address, raw, unit, decimals, openSellWidget]);

  const cancel = useCallback(() => {
    onReject?.(new MtpCashOutUserRejected());
    onClose();
  }, [onReject, onClose]);

  const shown = liveRecord ?? record;

  return (
    <>
    <AppModal onRequestClose={embedUrl != null ? () => {} : onClose}>
      <Pressable style={S.pickBackdrop} onPress={embedUrl != null ? () => {} : onClose}>
        <View testID="mtp-cashout-sheet" style={S.pickCard} onStartShouldSetResponder={() => true}>
          <ScrollView style={S.pickScroll}>
            {phase === 'lifecycle' && shown != null ? (
              <View testID="mtp-cashout-lifecycle">
                {/* The handoff note: the sale itself happens in the venue's own window (the
                    bank details and the deposit address are the session's, never dpay's);
                    dpay watches the correlation order here. */}
                <Text testID="mtp-cashout-widget-note" style={S.receiptNote}>
                  {M.deposit.mtpCash.widgetNote}
                </Text>
                {widgetFailed ? (
                  <>
                    <Text testID="mtp-cashout-widget-failed" style={S.err}>
                      {M.deposit.mtpCash.widgetOpenFailed}
                    </Text>
                    <Pressable
                      testID="btn-mtp-cashout-widget-retry"
                      style={S.ghostBtn}
                      onPress={() => { void openSellWidget(); }}
                      accessibilityRole="button"
                      accessibilityLabel={M.deposit.mtpCash.widgetOpenRetry}>
                      <Text style={S.ghostBtnText}>{M.deposit.mtpCash.widgetOpenRetry}</Text>
                    </Pressable>
                  </>
                ) : null}
                <StatePanel record={shown} onBack={onClose} />
              </View>
            ) : (
              <>
                <Text style={S.pickTitle}>{M.deposit.mtpCash.sheetTitle}</Text>
                <Text style={S.receiptNote}>{M.deposit.mtpCash.cashOutLine(unit, asset.chainName)}</Text>

                {/* The bank details (IBAN, holder) are the WIDGET SESSION's to collect: the
                    venue's API tier is closed for dpay, so no bank data enters dpay at all. */}

                <Text style={S.inputLabel}>{M.deposit.mtpCash.amountLabel(unit)}</Text>
                <TextInput
                  testID="mtp-cashout-amount"
                  accessibilityLabel={M.deposit.mtpCash.amountLabel(unit)}
                  style={S.withdrawAmtInput}
                  value={amountStr}
                  onChangeText={setAmountStr}
                  keyboardType="decimal-pad"
                  placeholder={M.deposit.mtpCash.amountPlaceholder}
                  placeholderTextColor={C.sub2}
                />
                {balance != null ? <Text style={S.dim2}>{fmt(balance)} {unit}</Text> : null}
                {overBalance ? <Text testID="mtp-cashout-overbal" style={S.warnNote}>{M.pay.notEnoughBalance}</Text> : null}

                {/* The relay's attributed + timestamped quote (plan §4): the venue's own net
                    figure, never a dpay computation. No timestamp read, no timestamp claimed. */}
                <View testID="mtp-cashout-quote" style={S.reviewCard}>
                  <Text style={S.reviewLabel}>{M.deposit.mtpCash.quoteHeadline}</Text>
                  {quote != null ? (
                    <>
                      <Text testID="mtp-cashout-quote-net" style={S.reviewAmount}>
                        {M.deposit.mtpCash.quoteNet(`${quote.destAmount} CHF`)}
                      </Text>
                      {quote.fetchedAtMs > 0 ? (
                        <Text testID="mtp-cashout-quote-at" style={S.dim2}>
                          {M.deposit.mtpCash.quoteBy('Mt Pelerin', formatClock(new Date(quote.fetchedAtMs)))}
                        </Text>
                      ) : null}
                    </>
                  ) : quotePending ? (
                    <Text testID="mtp-cashout-quote-pending" style={S.dim2}>{M.deposit.mtpCash.quotePending}</Text>
                  ) : quoteErr != null ? (
                    <Text testID="mtp-cashout-quote-err" style={S.dim2}>{quoteErr}</Text>
                  ) : null}
                </View>

                {err ? <Text testID="mtp-cashout-err" style={S.err}>{err}</Text> : null}

                <Pressable
                  testID="btn-mtp-cashout-continue"
                  style={[S.primaryWide, (!amountOk || quote == null || ordering) && S.dim]}
                  onPress={() => { void continueCashOut(); }}
                  disabled={!amountOk || quote == null || ordering}
                  accessibilityRole="button"
                  accessibilityLabel={M.deposit.mtpCash.continueLabel}
                  accessibilityState={{disabled: !amountOk || quote == null || ordering}}>
                  {ordering
                    ? <>
                        <ActivityIndicator size="small" color={C.brandInk} />
                        <Text style={S.primaryText}>{M.deposit.mtpCash.orderCreating}</Text>
                      </>
                    : <Text style={S.primaryText}>{M.deposit.mtpCash.continueLabel}</Text>}
                </Pressable>
                <Pressable
                  testID="btn-mtp-cashout-cancel"
                  style={S.ghostBtn}
                  onPress={cancel}
                  accessibilityRole="button"
                  accessibilityLabel={M.deposit.mtp.cancel}
                  accessibilityState={{disabled: false}}>
                  <Text style={S.ghostBtnText}>{M.deposit.mtp.cancel}</Text>
                </Pressable>

                {/* The provider's own published figures, verbatim + dated (plan §2.2, §8 item
                    4). Card is a BUY-side method: the venue publishes no cash-out card figure,
                    so no card row renders (the funding-table law: published or nothing). The
                    7-day hold holds on-ramp bank transfers — equally absent here. */}
                <View testID="mtp-cashout-fees" style={S.instrCard}>
                  <Text style={S.depositStatusTitle}>{M.deposit.mtpCash.feesTitle}</Text>
                  <Text style={S.instrMeta}>{M.deposit.mtpCash.feeBank}</Text>
                  {token === 'ZCHF' ? <Text style={S.instrMeta}>{M.deposit.mtpCash.feeZchf}</Text> : null}
                  <Text style={S.instrMeta}>{M.deposit.mtpCash.kycLine}</Text>
                  <Text style={S.instrMeta}>{M.deposit.mtpCash.minNote}</Text>
                  <Text style={S.dim2}>{M.deposit.mtpCash.feesAsOf(formatMonthDayYear(new Date(MTP_FACTS_READ_ON)))}</Text>
                </View>
                <Text testID="mtp-cashout-counterparty" style={S.dim2}>{M.deposit.mtpCash.counterparty}</Text>
              </>
            )}
          </ScrollView>
        </View>
      </Pressable>
    </AppModal>
    {/* The IN-APP embed: a ROOT-LEVEL SIBLING of the sheet's own AppModal (the MtpBuySheet
        discipline — never nested inside the card). Closing it returns to the lifecycle view
        with the watch still running; the external fallback never renders it. */}
    {embedUrl != null ? (
      <MtpWidgetEmbed url={embedUrl} onClose={() => setEmbedUrl(null)} />
    ) : null}
    </>
  );
}

/** One service refusal word → its honest line (no verdict, one next step). */
function orderErrLine(e: unknown): string {
  const word = e instanceof Error ? e.message : '';
  switch (word) {
    case 'unconfigured': return M.deposit.mtpCash.errUnconfigured;
    case 'unreachable': return M.deposit.mtpCash.errUnreachable;
    case 'refused': return M.deposit.mtpCash.errRefused;
    case 'unavailable': return M.deposit.mtpCash.errUnavailable;
    default: return M.deposit.mtpCash.errShape;
  }
}
