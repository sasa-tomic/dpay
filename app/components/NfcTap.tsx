import {useCallback, useRef, useState} from 'react';
import {useJourney} from '../lib/journey';
import {awardPaymentTested} from '../lib/readiness';
import {type CurrencyDescriptor, type NfcDisclosure, isPayableAsset, resolveNfcDisclosure, fmtCurrencyAmountCompact} from '../config/catalog';
import type {NfcEvent, Identity} from '../lib/types';
import {
  confirmIncomingTransfer,
  fetchLedgerFee,
  prepareNfcTransfer,
  submitNfcTransfer,
  type RailPrepared,
} from '../services/rail';
import {DpayNfc} from '../services/native';
import {saveTxNote} from '../services/txNotes';
import {addPendingPays, removePendingPays} from '../services/pendingPays';
import {fallbackLedgerFee} from '../services/ledgerFees';
import {useNfcTapState, type TapCtx} from '../hooks/useNfcTapState';
import {NfcTapView} from './NfcTapView';
import {M} from '../i18n';

const SETTLEMENT_POLL = {attempts: 24, intervalMs: 500};
const HISTORY_POLL = {attempts: 8, intervalMs: 500};
const RESULT_SETTLED = 0;
const RESULT_REJECTED = 1;
const RESULT_UNKNOWN = 2;

/**
 * EVERYTHING THE MERCHANT MAY CLAIM ABOUT A TAP, and nothing more.
 *
 * There are exactly three, and the two that are not `settled` are different dead ends for the person
 * at the counter, which is why they are told apart here rather than collapsed into one "pending":
 *
 *  * `settled` — an exact row in the merchant's own durable ledger history. The only state that
 *    hands over goods.
 *  * `refused-unverified` — the ledger's own answer said the transfer did not execute (a payer with
 *    no VCHF, or too little, arrives here), AND no history row appeared. That answer is NOT
 *    promoted to a decline: `read_state` trees are structurally decoded but not BLS-verified on
 *    device, so this phone cannot prove the refusal is the ledger's. It is a stronger reason to
 *    doubt than silence, and still only doubt.
 *  * `nothing-seen` — no exact row inside the poll budget, and nothing said otherwise. Honest
 *    absence, never a decline: the transfer may still be in flight.
 *
 * Both non-settled verdicts return `RESULT_UNKNOWN` to the payer — a false decline on the payer's
 * phone would be worse than an honest unknown, and the payer's own wallet is not the ledger either.
 */
type MerchantVerdict = 'settled' | 'refused-unverified' | 'nothing-seen';

/**
 * IC NFC v2 has one settlement owner. The offline payer signs an update plus a reusable read_state
 * envelope and serves that DPN2 bundle. The online merchant submits/polls it, signs one nonce-bound
 * result, and returns the result over the still-open NFC channel. The payer never needs a network.
 */
export function NfcTap({role, identity, relayUrl, requestHex, reqInfo, catalog, onSettled, onActive, onClose, offlinePeak, onConfirmed}: {
  role: 'card' | 'reader';
  identity: Identity;
  relayUrl?: string;
  requestHex?: string;
  // `amount` is the WIRE the incoming NFC request actually moves (the ledger-match and
  // account-deduction truth — never touched by display rules). `displayAmount` is the GROSS the
  // payee's screen shows (founder rule 2026-09-14: both devices read the typed price; the wire
  // stays netted underneath). Optional because wire-only callers keep their current readout.
  reqInfo?: {amount: string; displayAmount?: string; nonce: string; who: string; currency: number};
  catalog: CurrencyDescriptor[];
  onSettled?: () => void;
  onActive?: () => void;
  onClose: () => void;
  /** Trip Ready J5 — mount the one-shot offline peak on this tap's success phase (payer card, merchant-settled-while-offline story). */
  offlinePeak?: boolean;
  /** Trip Ready J5 — card side reached a CONFIRMED settled outcome (the merchant settled; the payer never submitted). */
  onConfirmed?: () => void;
}) {
  const [disclosure, setDisclosure] = useState<NfcDisclosure | null>(null);
  // Founder rule 2026-09-14 — the payer's tap screen reads the TOTAL DEBIT (wire + fee), never
  // the netted wire alone. `cardReq`/`cardFee` hold the request + the display fee for that
  // readout; `feePromiseRef` is the same query's promise, consumed by the note save so the log
  // row gets the gross too. The fee is LIVE-first (`fetchLedgerFee` — the ledger stays
  // authoritative whenever it can be asked) with local fallbacks for the offline payer, which
  // is this rail's signature use case: the fee the ledger itself last answered
  // (`services/ledgerFees`, written through by every successful query), then the bundled
  // catalog row's drift-alarmed fee. Both are the ledger's own fact by another road, never a
  // guess, so an offline tap still reads the typed price; `cardFee` stays null (wire-only
  // display) only when no source knows (DEMO play money has no fee; ckBTC registers none).
  const [cardReq, setCardReq] = useState<{currency: number; amount: string} | null>(null);
  const [cardFee, setCardFee] = useState<string | null>(null);
  const feePromiseRef = useRef<Promise<string | null> | null>(null);
  // Trip-prep auto-detection (founder rule 2026-08-24): an NFC-settled payment must tick
  // FIRST PAYMENT (+ the flowUnderstood co-award) exactly like the QR rails. journeyRef keeps a
  // fresh snapshot for the idempotent award call inside async callbacks.
  const {journey} = useJourney();
  const journeyRef = useRef(journey);
  journeyRef.current = journey;
  // One-press rule (founder directive 2026-08-24): the "Pay Now" gate was the deliberate press,
  // so a validated request signs IMMEDIATELY — no parked review, no Approve click. `signingRef`
  // latches at sign start (a duplicate request event must not double-sign; the hook drops
  // post-sign duplicates, this guards the async window before `advance` fires).
  const signingRef = useRef(false);
  // The auto-sign entry, reachable from the hook's request dispatch (which runs before `advance`
  // exists as a binding). Assigned right after the hook call below.
  const approveRef = useRef<(req: Extract<NfcEvent, {type: 'request'}>, ctx: TapCtx) => Promise<void>>(async () => {});
  const preparedRef = useRef<(RailPrepared & {readStateEnvelopeHex: string}) | null>(null);
  const readerVerdictRef = useRef<MerchantVerdict | null>(null);
  const recordedRef = useRef(false);

  const record = useCallback(() => {
    if (recordedRef.current || !onSettled) return;
    recordedRef.current = true;
    onSettled();
  }, [onSettled]);

  const returnResult = useCallback(async (
    status: number,
    requestIdHex: string,
  ) => {
    if (!reqInfo) return;
    await DpayNfc.confirmResult(status, reqInfo.nonce, requestIdHex, identity.secretHex);
  }, [identity.secretHex, reqInfo]);

  const submitReaderBundle = useCallback(async (
    event: Extract<NfcEvent, {type: 'done'; role: 'reader'}>,
    ctx: TapCtx,
  ) => {
    const ledger = catalog.find(c => c.currency === reqInfo?.currency)?.ledger ?? '';
    if (!ledger || !relayUrl || !reqInfo) {
      try { await returnResult(RESULT_UNKNOWN, event.requestIdHex); } catch {/* best-effort */}
      ctx.finalize('pending', M.errors.tap.couldntVerifyRequest);
      return;
    }
    let verdict: MerchantVerdict = 'nothing-seen';
    try {
      const submitted = await submitNfcTransfer({
        ledger,
        envelopeHex: event.envelopeHex,
        requestIdHex: event.requestIdHex,
        readStateEnvelopeHex: event.readStateEnvelopeHex,
      }, SETTLEMENT_POLL);

      // Durable exact history is authoritative for settlement even if a status endpoint claimed
      // rejection. read_state trees are structurally decoded but not yet BLS-verified, so absence of
      // a row within this finite poll cannot safely become a decline; it remains honest unknown.
      // What the refusal DOES survive as is which unknown this is — see `MerchantVerdict`.
      const settled = await confirmIncomingTransfer({
        relayUrl,
        receiverPublicHex: identity.publicHex,
        currency: reqInfo.currency,
        amount: reqInfo.amount,
        memoHex: reqInfo.nonce,
      }, HISTORY_POLL);
      verdict = settled ? 'settled' : submitted.kind === 'rejected' ? 'refused-unverified' : 'nothing-seen';
    } catch (e: unknown) {
      console.warn('NfcTap merchant settlement failed:', e instanceof Error ? e.message : String(e));
      verdict = 'nothing-seen';
    }
    if (!ctx.isCurrent()) return;

    const status = verdict === 'settled' ? RESULT_SETTLED : RESULT_UNKNOWN;
    // Publish before native can emit `confirmed`; C6 may complete before the Promise resumes.
    readerVerdictRef.current = verdict;
    try {
      await returnResult(status, event.requestIdHex);
    } catch (e: unknown) {
      readerVerdictRef.current = null;
      console.warn('NfcTap result return failed:', e instanceof Error ? e.message : String(e));
      ctx.finalize('pending', M.errors.tap.couldntReturnResult);
      return;
    }
    // `record` is NOT a dependency: submitting the bundle is not the settlement moment. The
    // merchant's `onSettled` fires from `finishReader` below, once the transport has confirmed the
    // result reached the payer — recording it here would credit a settlement whose result hand-back
    // may still fail.
  }, [catalog, identity.publicHex, relayUrl, reqInfo, returnResult]);

  // The merchant's terminal screen. Both non-settled verdicts land on `pending` ("Not confirmed"),
  // never `declined`: this phone cannot prove a refusal, so it must not show one to the person
  // deciding whether to hand over goods. The two REASONS differ because the counter's next move
  // does — one has an answer to weigh, the other has silence to wait out — and both are written for
  // a cashier rather than for a payer (founder rule 2026-08-29: a dead end states the next action).
  const finishReader = useCallback((ctx: TapCtx) => {
    const verdict = readerVerdictRef.current;
    if (!verdict) return;
    if (verdict === 'settled') {
      record();
      awardPaymentTested(journeyRef.current); // receiving a confirmed NFC payment counts ("pay or receive")
      ctx.finalize('success');
      return;
    }
    ctx.finalize('pending', verdict === 'refused-unverified'
      ? M.errors.tap.merchantRefusalUnverified
      : M.errors.tap.merchantNothingArrived);
  }, [record]);

  // Request arrival: validate → AUTO-SIGN (the tap is the CHANNEL, not the consent — the "Pay
  // Now" gate already was). The two fail-closed legs (unknown asset / unresolvable disclosure)
  // auto-decline without signing: they are not consent decisions, they are "there is nothing
  // payable here" (QR review-unsupported parity). A payable request signs immediately.
  const validateRequest = useCallback(async (req: Extract<NfcEvent, {type: 'request'}>, ctx: TapCtx) => {
    const failClosed = async (why: string) => {
      try { await DpayNfc.declineCard(req.nonceHex); } catch (e: unknown) { console.warn('NfcTap declineCard failed (fail-closed)', e); }
      ctx.finalize('declined', why);
    };
    try {
      if (!isPayableAsset(catalog, req.currency)) {
        await failClosed(M.errors.tap.unsupportedAsset(req.currency));
        return;
      }
      const disc = resolveNfcDisclosure(catalog, {currency: req.currency, amount: req.amount});
      if (!disc) {
        await failClosed(M.errors.tap.cannotConfirmAsset(req.currency));
        return;
      }
      setDisclosure(disc); // drives the read-only "Paying <amt> on <network>" status line
      // Kick the fee query the readout + the note both consume (founder rule 2026-09-14). LIVE
      // first; offline (this rail's own use case) the chain falls back to the persisted answer
      // of this very ledger, then the catalog row — `cardFee` stays null only when no local
      // answer exists either, and the displays then show the wire.
      setCardReq({currency: req.currency, amount: req.amount});
      setCardFee(null);
      const ledger = catalog.find(c => c.currency === req.currency)?.ledger;
      if (req.currency !== 0 && ledger) {
        const p = fetchLedgerFee(identity.secretHex, ledger)
          .catch(() => fallbackLedgerFee(ledger, catalog, req.currency));
        feePromiseRef.current = p;
        void p.then(fee => {
          if (fee != null) setCardFee(fee);
        });
      } else {
        feePromiseRef.current = null;
      }
      await approveRef.current(req, ctx);
    } catch (e: unknown) {
      console.warn('NfcTap request validation failed:', e instanceof Error ? e.message : String(e));
      await failClosed(M.errors.tap.couldntReadRequest);
    }
  }, [catalog, identity.secretHex]);

  // (No onSettling deduction anymore — founder requirements 2026-09-15 #1/#3: the optimistic
  // balance subtraction moved from the EPHEMERAL onOfflinePaid funnel into the persisted
  // pending-outbox record written at approve() below. It survives restart, sums the GROSS not the
  // bare wire, and retires against the balance poll's per-currency clock — see
  // services/pendingPays.ts.)

  const onResult = useCallback((event: Extract<NfcEvent, {type: 'result'}>, ctx: TapCtx) => {
    const prepared = preparedRef.current;
    if (!prepared || event.nonceHex !== prepared.memoHex || event.requestIdHex !== prepared.requestIdHex) return;
    if (event.status === RESULT_SETTLED) {
      record();
      awardPaymentTested(journeyRef.current);
      onConfirmed?.();
      // The merchant's submission PROVED itself on-chain: the pending record retires here (the
      // settled history row replaces the pending row on the next refresh — same key, the memo).
      void removePendingPays(identity.publicHex, [prepared.memoHex]);
      ctx.finalize('success');
    } else if (event.status === RESULT_REJECTED) {
      // Terminal refusal while the payer was still tapped: nothing can settle, so the record's
      // deduction + row must both retire — this REPLACES the old negative onOfflinePaid refund
      // with the same effect (record gone → no subtraction) plus the row cleanup the old path
      // never had.
      void removePendingPays(identity.publicHex, [prepared.memoHex]);
      ctx.finalize('declined', M.rail.declined(''));
    } else {
      ctx.finalize('pending', M.errors.tap.couldntConfirmOffline);
    }
  }, [identity.publicHex, onConfirmed, record]);

  const {phase, reason, activeRef, advance} = useNfcTapState<NfcEvent>({
    role,
    readerPayload: requestHex,
    onActive,
    eventName: 'DpayNfcEvent',
    nativeModule: DpayNfc,
    armCard: () => DpayNfc.armCard(),
    disarmCard: () => DpayNfc.disarmCard(),
    startReader: p => DpayNfc.startReader(p),
    stopReader: () => DpayNfc.stopReader(),
    // Authenticated IC results remain actionable across an arbitrarily delayed result-only re-tap.
    // The user can explicitly Cancel; a local timer must never discard a later core-verified result.
    waitsForReceipt: false,
    onRequest: (e, ctx) => {
      if (e.type === 'request') void validateRequest(e, ctx);
    },
    onSubmit: (e, ctx) => {
      if (e.type !== 'done') return;
      if (e.role === 'reader') void submitReaderBundle(e, ctx);
      // Card-side done only means the bundle left; the verified merchant result owns the outcome.
    },
    onReceipt: (e, ctx) => {
      if (e.type === 'result') onResult(e, ctx);
    },
    onConfirmed: (e, ctx) => {
      if (e.type === 'confirmed' && e.role === 'reader') finishReader(ctx);
    },
  });

  // The auto-sign: authoritative sign-time expiry gate (there is no advisory countdown anymore —
  // this check is the whole gate, QR C1 parity), then the offline sign + provideWire. approveCard's
  // native nonce guard binds the wire to this request's nonce. (Lives AFTER the hook call: it
  // closes over `advance`; validateRequest reaches it through `approveRef`.)
  const approve = useCallback(async (req: Extract<NfcEvent, {type: 'request'}>, ctx: TapCtx) => {
    if (signingRef.current) return;
    signingRef.current = true;
    if (req.expiry * 1000 <= Date.now()) {
      try { await DpayNfc.declineCard(req.nonceHex); } catch (e: unknown) { console.warn('NfcTap declineCard failed (expired)', e); }
      ctx.finalize('declined', M.errors.tap.requestExpired);
      return;
    }
    advance('exchanging');
    // Payer-side annotation (services/txNotes), same seam as PayMode.approve: the tap's request
    // carries the payee's claimed name + human memo, recorded before signing so a crash after
    // provideWire still leaves the note. Join key = nonceHex = the on-chain memo. Founder rule
    // 2026-09-14: the note also carries the gross (wire + fee = the exact total debit) + the fee
    // when the fee chain answered — live, or the persisted/catalog fee when the payer is offline
    // (the ref holds the same chained promise the readout uses). No answer anywhere saves
    // neither, no guess. Fire-and-forget beside the offline sign; the query's own transport
    // timeout bounds it.
    void (async () => {
      const fee = await feePromiseRef.current;
      saveTxNote(identity.publicHex, {k: req.nonceHex, who: req.toName || undefined, msg: req.memo || undefined, ...(fee != null ? {gross: (BigInt(req.amount) + BigInt(fee)).toString(), fee} : {})}, Date.now());
      // Founder requirements 2026-09-15 #1/#3 — the persisted pending-outbox record, same key as
      // the note (nonceHex = the on-chain memo). The offline tap is UNCONFIRMED BY CONSTRUCTION
      // (the payer never submits; the merchant does, over THEIR connection, later): the record is
      // the payer's only local trace of the debit until the ledger echoes it. Its gross (wire +
      // fee — the account moves both; the old ephemeral deduction subtracted the bare wire) is
      // what the offline balance subtracts, and its row renders in Home/Ledger until a history
      // refresh matches the memo or a later result event retires it (SETTLED/REJECTED above).
      addPendingPays(identity.publicHex, [{k: req.nonceHex, assetId: `ic:${req.currency}`, currency: req.currency, wireAmount: req.amount, ...(fee != null ? {fee, gross: (BigInt(req.amount) + BigInt(fee)).toString()} : {}), ...(req.toName ? {who: req.toName} : {}), ...(req.memo ? {msg: req.memo} : {}), ts: Date.now(), kind: 'ic-nfc'}]);
    })().catch(() => {});
    try {
      const prepared = await prepareNfcTransfer(identity.secretHex, {currencies: catalog}, req);
      if (!ctx.isCurrent()) return;
      preparedRef.current = prepared;
      await DpayNfc.approveCard(prepared.envelopeHex, prepared.readStateEnvelopeHex, req.nonceHex);
    } catch (e: unknown) {
      console.warn('NfcTap authorization failed:', e instanceof Error ? e.message : String(e));
      if (!ctx.isCurrent()) return;
      try { await DpayNfc.declineCard(req.nonceHex); } catch {/* best-effort */}
      ctx.finalize('error', M.errors.tap.couldntAuthorize);
    }
  }, [advance, catalog, identity.secretHex]);
  approveRef.current = approve;

  if (phase === 'listening' && !activeRef.current) return null;

  // Founder rule 2026-09-14 — BOTH roles read the GROSS here. Card: the total debit (wire + fee
  // when the fee chain answered — live, or the persisted/catalog fee offline — and the wire
  // alone when no source knows; `disclosure` itself still gates payability above, but its
  // `formattedAmount` is the netted wire and is never shown).
  // Reader: `displayAmount` (the payee's typed price) with the wire as the legacy fallback.
  const formattedAmt = role === 'card'
    ? (disclosure != null && cardReq != null
      ? fmtCurrencyAmountCompact(catalog, cardReq.currency, cardFee != null ? (BigInt(cardReq.amount) + BigInt(cardFee)).toString() : cardReq.amount)
      : null)
    : reqInfo ? fmtCurrencyAmountCompact(catalog, reqInfo.currency, reqInfo.displayAmount ?? reqInfo.amount) : null;
  const networkLabel = role === 'card' ? disclosure?.networkLabel ?? null : null;
  return (
    <NfcTapView
      phase={phase} reason={reason} role={role} testID="nfc-status"
      formattedAmt={formattedAmt} networkLabel={networkLabel} onClose={onClose}
      offlinePeak={offlinePeak}
    />
  );
}
