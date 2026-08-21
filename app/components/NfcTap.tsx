import {useCallback, useRef, useState} from 'react';
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
export function NfcTap({role, identity, relayUrl, requestHex, reqInfo, catalog, onSettled, onOfflinePaid, onActive, onClose}: {
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
}) {
  const [disclosure, setDisclosure] = useState<NfcDisclosure | null>(null);
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
      ctx.finalize('pending', 'Couldn’t verify this request');
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
      ctx.finalize('pending', 'Couldn’t return the payment result — keep the phones together and try again');
      return;
    }
  }, [catalog, identity.publicHex, record, relayUrl, reqInfo, returnResult]);

  const finishReader = useCallback((ctx: TapCtx) => {
    const outcome = readerOutcomeRef.current;
    if (!outcome) return;
    if (outcome.kind === 'settled') {
      record();
      ctx.finalize('success');
    } else if (outcome.kind === 'rejected') {
      ctx.finalize('declined', outcome.reason);
    } else {
      ctx.finalize('pending', 'Still confirming — check the balance shortly');
    }
  }, [record]);

  const signRequest = useCallback(async (req: {
    toHex: string; amount: string; nonceHex: string; expiry: number; currency: number;
  }, ctx: TapCtx) => {
    try {
      if (!isPayableAsset(catalog, req.currency)) {
        await DpayNfc.declineCard(req.nonceHex);
        ctx.finalize('declined', `Unsupported asset (currency ${req.currency})`);
        return;
      }
      const disc = resolveNfcDisclosure(catalog, {currency: req.currency, amount: req.amount});
      if (!disc) {
        await DpayNfc.declineCard(req.nonceHex);
        ctx.finalize('declined', `Cannot confirm the asset (currency ${req.currency})`);
        return;
      }
      setDisclosure(disc);
      const prepared = await prepareNfcTransfer(identity.secretHex, {currencies: catalog}, req);
      if (!ctx.isCurrent()) return;
      preparedRef.current = prepared;
      await DpayNfc.approveCard(prepared.envelopeHex, prepared.readStateEnvelopeHex, req.nonceHex);
    } catch (e: unknown) {
      console.warn('NfcTap authorization failed:', e instanceof Error ? e.message : String(e));
      if (!ctx.isCurrent()) return;
      try { await DpayNfc.declineCard(req.nonceHex); } catch {/* best-effort */}
      ctx.finalize('error', 'Couldn’t authorize payment — try again');
    }
  }, [catalog, identity.secretHex]);

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
      ctx.finalize('success');
    } else if (event.status === RESULT_REJECTED) {
      if (deductedRef.current) onOfflinePaid?.(`-${prepared.amount}`, prepared.currency);
      ctx.finalize('declined', 'The ledger declined the payment');
    } else {
      ctx.finalize('pending', 'Couldn’t confirm — check your balance when back online');
    }
  }, [onOfflinePaid, record]);

  const {phase, reason, activeRef} = useNfcTapState<NfcEvent>({
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
      if (e.type === 'request') void signRequest(e, ctx);
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

  if (phase === 'listening' && !activeRef.current) return null;

  const formattedAmt = role === 'card'
    ? disclosure?.formattedAmount ?? null
    : reqInfo ? fmtCurrencyAmount(catalog, reqInfo.currency, reqInfo.amount) : null;
  const networkLabel = role === 'card' ? disclosure?.networkLabel ?? null : null;
  return (
    <NfcTapView
      phase={phase} reason={reason} role={role} testID="nfc-status"
      formattedAmt={formattedAmt} networkLabel={networkLabel} onClose={onClose}
    />
  );
}
