import {useCallback, useRef, useState} from 'react';
import {useJourney} from '../lib/journey';
import {awardPaymentTested} from '../lib/readiness';
import {type CurrencyDescriptor, type NfcDisclosure, isPayableAsset, resolveNfcDisclosure, fmtCurrencyAmount} from '../config/catalog';
import type {NfcEvent, Identity} from '../lib/types';
import {
  confirmIncomingTransfer,
  prepareNfcTransfer,
  submitNfcTransfer,
  type RailOutcome,
  type RailPrepared,
} from '../services/rail';
import {DpayNfc} from '../services/native';
import {useNfcTapState, type TapCtx} from '../hooks/useNfcTapState';
import {NfcTapView} from './NfcTapView';
import {M} from '../i18n';

const SETTLEMENT_POLL = {attempts: 24, intervalMs: 500};
const HISTORY_POLL = {attempts: 8, intervalMs: 500};
const RESULT_SETTLED = 0;
const RESULT_REJECTED = 1;
const RESULT_UNKNOWN = 2;

/**
 * IC NFC v2 has one settlement owner. The offline payer signs an update plus a reusable read_state
 * envelope and serves that DPN2 bundle. The online merchant submits/polls it, signs one nonce-bound
 * result, and returns the result over the still-open NFC channel. The payer never needs a network.
 */
export function NfcTap({role, identity, relayUrl, requestHex, reqInfo, catalog, onSettled, onOfflinePaid, onActive, onClose, offlinePeak, onConfirmed}: {
  role: 'card' | 'reader';
  identity: Identity;
  relayUrl?: string;
  requestHex?: string;
  reqInfo?: {amount: string; nonce: string; who: string; currency: number};
  catalog: CurrencyDescriptor[];
  onSettled?: () => void;
  onOfflinePaid?: (amount: string, currency: number) => void;
  onActive?: () => void;
  onClose: () => void;
  /** Trip Ready J5 — mount the one-shot offline peak on this tap's success phase (payer card, merchant-settled-while-offline story). */
  offlinePeak?: boolean;
  /** Trip Ready J5 — card side reached a CONFIRMED settled outcome (the merchant settled; the payer never submitted). */
  onConfirmed?: () => void;
}) {
  const [disclosure, setDisclosure] = useState<NfcDisclosure | null>(null);
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
  const readerOutcomeRef = useRef<RailOutcome | null>(null);
  const recordedRef = useRef(false);
  const deductedRef = useRef(false);

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
    let outcome: RailOutcome = {kind: 'unknown'};
    try {
      outcome = await submitNfcTransfer({
        ledger,
        envelopeHex: event.envelopeHex,
        requestIdHex: event.requestIdHex,
        readStateEnvelopeHex: event.readStateEnvelopeHex,
      }, SETTLEMENT_POLL);

      // Durable exact history is authoritative for settlement even if a status endpoint claimed
      // rejection. read_state trees are structurally decoded but not yet BLS-verified, so absence of
      // a row within this finite poll cannot safely become a decline; it remains honest unknown.
      const settled = await confirmIncomingTransfer({
        relayUrl,
        receiverPublicHex: identity.publicHex,
        currency: reqInfo.currency,
        amount: reqInfo.amount,
        memoHex: reqInfo.nonce,
      }, HISTORY_POLL);
      outcome = settled
        ? {kind: 'settled', blockIndex: outcome.kind === 'settled' ? outcome.blockIndex : ''}
        : {kind: 'unknown'};
    } catch (e: unknown) {
      console.warn('NfcTap merchant settlement failed:', e instanceof Error ? e.message : String(e));
      outcome = {kind: 'unknown'};
    }
    if (!ctx.isCurrent()) return;

    const status = outcome.kind === 'settled' ? RESULT_SETTLED : RESULT_UNKNOWN;
    // Publish before native can emit `confirmed`; C6 may complete before the Promise resumes.
    readerOutcomeRef.current = outcome;
    try {
      await returnResult(status, event.requestIdHex);
    } catch (e: unknown) {
      readerOutcomeRef.current = null;
      console.warn('NfcTap result return failed:', e instanceof Error ? e.message : String(e));
      ctx.finalize('pending', M.errors.tap.couldntReturnResult);
      return;
    }
    // `record` is NOT a dependency: submitting the bundle is not the settlement moment. The
    // merchant's `onSettled` fires from `finishReader` below, once the transport has confirmed the
    // result reached the payer — recording it here would credit a settlement whose result hand-back
    // may still fail.
  }, [catalog, identity.publicHex, relayUrl, reqInfo, returnResult]);

  const finishReader = useCallback((ctx: TapCtx) => {
    const outcome = readerOutcomeRef.current;
    if (!outcome) return;
    if (outcome.kind === 'settled') {
      record();
      awardPaymentTested(journeyRef.current); // receiving a confirmed NFC payment counts ("pay or receive")
      ctx.finalize('success');
    } else if (outcome.kind === 'rejected') {
      ctx.finalize('declined', outcome.reason);
    } else {
      ctx.finalize('pending', M.errors.tap.stillConfirming);
    }
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
      await approveRef.current(req, ctx);
    } catch (e: unknown) {
      console.warn('NfcTap request validation failed:', e instanceof Error ? e.message : String(e));
      await failClosed(M.errors.tap.couldntReadRequest);
    }
  }, [catalog]);

  const onSettling = useCallback(() => {
    const prepared = preparedRef.current;
    if (role === 'card' && prepared && !deductedRef.current) {
      deductedRef.current = true;
      onOfflinePaid?.(prepared.amount, prepared.currency);
    }
  }, [onOfflinePaid, role]);

  const onResult = useCallback((event: Extract<NfcEvent, {type: 'result'}>, ctx: TapCtx) => {
    const prepared = preparedRef.current;
    if (!prepared || event.nonceHex !== prepared.memoHex || event.requestIdHex !== prepared.requestIdHex) return;
    if (event.status === RESULT_SETTLED) {
      record();
      awardPaymentTested(journeyRef.current);
      onConfirmed?.();
      ctx.finalize('success');
    } else if (event.status === RESULT_REJECTED) {
      if (deductedRef.current) onOfflinePaid?.(`-${prepared.amount}`, prepared.currency);
      ctx.finalize('declined', M.rail.declined(''));
    } else {
      ctx.finalize('pending', M.errors.tap.couldntConfirmOffline);
    }
  }, [onConfirmed, onOfflinePaid, record]);

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
    onSettling,
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

  const formattedAmt = role === 'card'
    ? disclosure?.formattedAmount ?? null
    : reqInfo ? fmtCurrencyAmount(catalog, reqInfo.currency, reqInfo.amount) : null;
  const networkLabel = role === 'card' ? disclosure?.networkLabel ?? null : null;
  return (
    <NfcTapView
      phase={phase} reason={reason} role={role} testID="nfc-status"
      formattedAmt={formattedAmt} networkLabel={networkLabel} onClose={onClose}
      offlinePeak={offlinePeak}
    />
  );
}
