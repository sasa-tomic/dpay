import {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, ScrollView, Text, TextInput, View} from 'react-native';
import {AppModal} from './AppModal';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {formatClock, formatMonthDayYear} from '../i18n/intl';
import {useEscapeToClose} from '../hooks/useHotkeys';
import type {Identity} from '../lib/types';
import type {SelectableAsset} from '../config/assets';
import {MTP_FACTS_READ_ON, type MtpBuyAsset} from '../config/funding';
import {toBaseUnitsSoft} from '../evm/chains';
import {cmpRaw} from '../lib/amount';
import {fmtAssetCompact, randNonceHex, toUnits} from '../lib/format';
import {StatePanel} from './ConvertStatePanel';
import {EvmWithdrawSheet} from './EvmWithdrawSheet';
import {adoptConvertRecord, convertResumeSnapshot, subscribeConvertRecords} from '../convertResume';
import type {ConvertRecord} from '../convert/types';
import {
  createMtpCashOrder, fetchMtpCashQuote, isValidIban, mtpCashStatusUrl, mtpSellNetworkOf,
  type MtpCashOrder, type MtpCashQuote,
} from '../services/mtpelerin';

// MtpCashOutSheet — the Mt Pelerin OFF-ramp's ONE surface (plan R2 step 2). Three phases in
// one root-mounted card (the MtpBuySheet mount discipline):
//
//   form      IBAN + account holder + amount; the quote is fetched THROUGH THE RELAY and shown
//             attributed + timestamped (plan §4: relayed, never computed); the provider's own
//             published figures ride verbatim + dated. Continue CREATES the sell order (the
//             relay mints the `mtp-…` correlation id and answers `offRampAddress`) — this is
//             the flow's ONE pre-broadcast side effect (lifecycle law C1): the order exists
//             from here on, and backing out before the send leaves it to expire unused at the
//             venue (the send-phase note says so, verbatim).
//   send      the wallet's OWN send: EvmWithdrawSheet prefilled to `offRampAddress` with the
//             exact asset/amount (the gas honesty gate + the submitted-not-settled terminal
//             are that sheet's, untouched). The record is ADOPTED at broadcast acceptance
//             (`onSent`) — no record exists before value moves (C1), and from then on the
//             resume engine drives it whether or not this sheet stays open.
//   lifecycle the adopted record renders through ConvertStatePanel (the CeFi lifecycle law:
//             awaiting_deposit → done | provider_refunded, webhook-first — the relay's status
//             store answers with zero upstream calls and caps reads at one per order per
//             minute; the engine mirrors that floor client-side). The provider Stop semantics
//             are the C2 flavor: dpay stops watching, the venue order's life is the venue's.
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

export type MtpCashOutSendPrefill = {address: string; amount: string};

/** The lifecycle record a successful broadcast adopts (pure; jest-pinned). Legless +
 *  providerRef (the CeFi shape), born at `awaiting_deposit`: the venue holds the order, the
 *  wallet's own transfer is on the wire, and the provider driver advances it by the relay's
 *  webhook-first status reads. The venue's deposit facts ride the providerDeposit block
 *  VERBATIM (`offRampAddress`, the exact typed amount, the venue's own expiry when the order
 *  carried one — `noExpiryLine` when it did not). `expectedNet` is the QUOTE's net fiat figure
 *  (the venue's own `destAmount`, converted to minor units for the record's raw-money field —
 *  the same normalization every cefi deposit block applies); no fee split is recorded because
 *  the venue publishes none for this method (the net figure already includes all fees). */
export function buildMtpCashOutRecord(args: {
  id: string;
  createdAtMs: number;
  venueId: string;
  /** The dpay order id (the relay's `mtp-…` correlation id) — providerRef.orderId AND the
   *  status route's key. */
  orderId: string;
  statusUrl: string;
  offRampAddress: string;
  /** The input rail identifier: the ERC-20 contract, lowercase (the Solana-record convention:
   *  no IC catalog ids on this rail — the ledger string names the token contract). */
  inLedger: string;
  /** The exact decimal amount the send moves (the user's typed figure, verbatim). */
  depositAmountDecimal: string;
  /** The same amount in the token's raw units — the record's amountIn. */
  amountIn: string;
  inSymbol: string;
  inDecimals: number;
  /** The venue's own net fiat figure for the amount (decimal string) — the expected end
   *  state. CHF is the v1 payout currency (plan §8 item 4). */
  expectedFiatDecimal: string;
  expiresAtMs: number | null;
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
    providerDeposit: {
      depositAddress: args.offRampAddress,
      depositAmount: args.depositAmountDecimal,
      ...(args.expiresAtMs != null ? {expiresAtMs: args.expiresAtMs} : {}),
    },
  };
}

export function MtpCashOutSheet({identity, relayUrl, asset, token, balance, gasWei, gasChecking = false, online = true, onClose, onReject, onSent: onSentRefresh}: {
  identity: Identity;
  /** The relay this phone talks to — the quote, the order AND the record's status read all
   *  ride it (the trocador-family rule: there is no keyless venue surface here). */
  relayUrl: string;
  /** The SELECTED EVM asset row — the send spends THIS token on THIS chain. The opener
   *  resolved it through `mtpCashOutEligible`, so `token` always has a value. */
  asset: SelectableAsset & {protocol: 'evm'};
  token: MtpBuyAsset;
  /** The token's LAST-KNOWN raw balance — the send's over-balance gate reads the same view. */
  balance: string | null;
  gasWei: string | null;
  gasChecking?: boolean;
  online?: boolean;
  onClose: () => void;
  /** Cancel observes the typed user-rejected error. Absent = Cancel simply closes. */
  onReject?: (e: MtpCashOutUserRejected) => void;
  /** Fired when the send's broadcast was ACCEPTED (after the record's adoption) — the
   *  mounting Wallet refreshes balances/history with it. */
  onSent?: () => void;
}) {
  const [phase, setPhase] = useState<'form' | 'send' | 'lifecycle'>('form');
  const [iban, setIban] = useState('');
  const [holder, setHolder] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [quote, setQuote] = useState<MtpCashQuote | null>(null);
  const [quotePending, setQuotePending] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const quoteSeq = useRef(0);
  const [ordering, setOrdering] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [order, setOrder] = useState<MtpCashOrder | null>(null);
  const [prefill, setPrefill] = useState<MtpCashOutSendPrefill | null>(null);
  const [record, setRecord] = useState<ConvertRecord | null>(null);
  const [liveRecord, setLiveRecord] = useState<ConvertRecord | null>(null);

  useEscapeToClose(phase === 'form' ? onClose : () => {});

  const decimals = asset.decimals;
  const unit = asset.symbol;
  const fmt = (rawAmount: string) => fmtAssetCompact(rawAmount, decimals, unit, undefined, asset.minFractionDigits);

  // The amount's raw units + the balance gate (the send's own rule, mirrored so the form
  // cannot price an impossible cash-out).
  const raw = toBaseUnitsSoft(amountStr, decimals);
  const balanceKnown = balance != null;
  const overBalance = balanceKnown && cmpRaw(raw, balance!) > 0;

  const ibanOk = isValidIban(iban);
  const holderOk = holder.trim().length > 0;
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

  const continueCashOut = useCallback(async () => {
    if (!ibanOk || !holderOk || !amountOk || ordering) return;
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
        iban: iban.replace(/[\s-]/g, '').toUpperCase(),
        holderName: holder.trim(),
        clientOrderId: recordId,
      });
      setPrefill({address: created.offRampAddress, amount: amountStr.trim()});
      setOrder(created);
      setPhase('send');
    } catch (e: unknown) {
      setErr(orderErrLine(e));
    } finally {
      setOrdering(false);
    }
  }, [ibanOk, holderOk, amountOk, ordering, relayUrl, token, amountStr, sourceNetwork, iban, holder]);

  // Broadcast acceptance (EvmWithdrawSheet's onSent fires the moment the network ACCEPTS —
  // done AND unknown both land here): build + adopt the lifecycle record. A kill after this
  // point still leaves the record live in the engine (crash safety — the order and the funds
  // both exist; only the watching was missing).
  const handleSent = useCallback(() => {
    if (order == null || record != null) return;
    const rec = buildMtpCashOutRecord({
      id: `${order.orderId}`,
      createdAtMs: Date.now(),
      venueId: 'mtpelerin',
      orderId: order.orderId,
      statusUrl: mtpCashStatusUrl(relayUrl, order.orderId),
      offRampAddress: order.offRampAddress,
      inLedger: asset.address.toLowerCase(),
      depositAmountDecimal: amountStr.trim(),
      amountIn: raw,
      inSymbol: unit,
      inDecimals: decimals,
      expectedFiatDecimal: quote != null ? quote.destAmount : '0',
      expiresAtMs: order.expiresAtMs,
    });
    setRecord(rec);
    void adoptConvertRecord(rec);
    onSentRefresh?.();
  }, [order, record, relayUrl, asset.address, amountStr, raw, unit, decimals, quote, onSentRefresh]);

  // The send step's close: Done/Escape after a send lands the lifecycle view; backing out
  // BEFORE any send dismisses the whole sheet (the venue order expires unused — the note said
  // so while the form was live).
  const sendClose = useCallback(() => {
    if (record != null) setPhase('lifecycle');
    else onClose();
  }, [record, onClose]);

  const cancel = useCallback(() => {
    onReject?.(new MtpCashOutUserRejected());
    onClose();
  }, [onReject, onClose]);

  const shown = liveRecord ?? record;

  return (
    <AppModal onRequestClose={onClose}>
      <Pressable style={S.pickBackdrop} onPress={onClose}>
        <View testID="mtp-cashout-sheet" style={S.pickCard} onStartShouldSetResponder={() => true}>
          <ScrollView style={S.pickScroll}>
            {phase === 'lifecycle' && shown != null ? (
              <View testID="mtp-cashout-lifecycle">
                <StatePanel record={shown} onBack={onClose} />
              </View>
            ) : phase === 'send' && order != null ? (
              <>
                {/* The order's honest state while the wallet's own send is pending: the venue
                    order exists from the Continue tap (C1's one pre-broadcast side effect), and
                    backing out now leaves it to expire unused at the venue — said verbatim. */}
                <Text testID="mtp-cashout-order-note" style={S.receiptNote}>
                  {M.deposit.mtpCash.orderNote(order.orderId)}
                </Text>
                <EvmWithdrawSheet
                  identity={identity}
                  asset={asset}
                  balance={balance}
                  gasWei={gasWei}
                  gasChecking={gasChecking}
                  online={online}
                  prefill={prefill}
                  onPrefillConsumed={() => setPrefill(null)}
                  onSent={handleSent}
                  onClose={sendClose}
                />
              </>
            ) : (
              <>
                <Text style={S.pickTitle}>{M.deposit.mtpCash.sheetTitle}</Text>
                <Text style={S.receiptNote}>{M.deposit.mtpCash.cashOutLine(unit, asset.chainName)}</Text>

                <Text style={S.inputLabel}>{M.deposit.mtpCash.ibanLabel}</Text>
                <TextInput
                  testID="mtp-cashout-iban"
                  accessibilityLabel={M.deposit.mtpCash.ibanLabel}
                  style={S.withdrawAddrInput}
                  value={iban}
                  onChangeText={setIban}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  placeholder="CH93 0076 2011 6238 5295 7"
                  placeholderTextColor={C.sub2}
                />
                {iban.length > 0 && !ibanOk ? <Text testID="mtp-cashout-iban-err" style={S.err}>{M.deposit.mtpCash.ibanInvalid}</Text> : null}

                <Text style={S.inputLabel}>{M.deposit.mtpCash.holderLabel}</Text>
                <TextInput
                  testID="mtp-cashout-holder"
                  accessibilityLabel={M.deposit.mtpCash.holderLabel}
                  style={S.withdrawAddrInput}
                  value={holder}
                  onChangeText={setHolder}
                  autoCapitalize="words"
                  placeholderTextColor={C.sub2}
                />
                {holder.length > 0 && !holderOk ? <Text testID="mtp-cashout-holder-err" style={S.err}>{M.deposit.mtpCash.holderInvalid}</Text> : null}

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
                  style={[S.primaryWide, (!ibanOk || !holderOk || !amountOk || ordering) && S.dim]}
                  onPress={() => { void continueCashOut(); }}
                  disabled={!ibanOk || !holderOk || !amountOk || ordering}
                  accessibilityRole="button"
                  accessibilityLabel={M.deposit.mtpCash.continueLabel}
                  accessibilityState={{disabled: !ibanOk || !holderOk || !amountOk || ordering}}>
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
