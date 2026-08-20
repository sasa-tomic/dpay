import {useCallback, useRef, useState} from 'react';
import {short} from '../lib/format';
import {type CurrencyDescriptor, type NfcDisclosure, isPayableAsset, resolveNfcDisclosure, fmtCurrencyAmount} from '../config/catalog';
import type {NfcEvent, Identity} from '../lib/types';
import {receiptCodeFor, decidePayerReceipt, type SettleOutcome} from '../payments';
import {prepareTransfer, submitTransfer} from '../services/rail';
import {DpayCore, DpayNfc} from '../services/native';
import {useNfcTapState, type TapCtx} from '../hooks/useNfcTapState';
import {NfcTapView} from './NfcTapView';

/**
 * IC NFC tap adapter. Drives one tap through the native glue (DpayNfc): Pay mode arms the HCE card
 * (payer is tapped), Receive mode runs the reader (merchant reads the tap). The **tap itself is the
 * consent** — when a request arrives the payer's phone signs and serves it immediately. The shared
 * lifecycle (phase state machine, finalize, settle timer, the subscribe→arm→cleanup effect) lives
 * in `useNfcTapState`; this adapter fills ONLY the IC user-principal rail: local envelope signing
 * (dpay-icp, byte-identical to ic-agent) + direct /api/v2 submission + read_state reconciliation
 * + optimistic balance deduction. The NFC framing carries the ~390-byte envelope in 2×240B frames
 * (provide_wire/Done are payload-length-agnostic); the 17-byte outcome receipt stays byte-compatible.
 */
export function NfcTap({role, identity, requestHex, reqInfo, catalog, onSettled, onOfflinePaid, onActive, onClose}: {
  role: 'card' | 'reader';
  identity: Identity;
  requestHex?: string;
  reqInfo?: {amount: string; nonce: string; who: string; currency: number};
  catalog: CurrencyDescriptor[];
  onSettled?: () => void;
  onOfflinePaid?: (amount: string, currency: number) => void;
  onActive?: () => void;
  onClose: () => void;
}) {
  // MC8 U1 — the asset-correct disclosure (asset name + network + formatted amount), resolved and
  // set SYNCHRONOUSLY in autoSign BEFORE the first await, so React renders "Paying 0.00050000 BTC on
  // Bitcoin" during the exchanging/awaitingApproval/settling window — never a blind "Communicating…".
  const [disclosure, setDisclosure] = useState<NfcDisclosure | null>(null);
  const sentRef = useRef<{amount: string; currency: number; who: string; nonce: string} | null>(null);
  const recordedRef = useRef(false);
  // True once we've optimistically deducted the payment from the local balance (when the envelope
  // leaves the phone). Prevents double-deduction if the receipt later arrives with success, and
  // enables undo if the receipt says declined.
  const deductedRef = useRef(false);

  const record = useCallback(() => {
    if (recordedRef.current || !onSettled) return;
    recordedRef.current = true;
    onSettled();
  }, [onSettled]);

  // Merchant side: submit the payer's signed ENVELOPE (reassembled by the reader) straight to the
  // IC boundary node and poll read_state to a terminal state. The envelope's request_id (content
  // hash — derivable from the bytes alone) is the dedup/reconciliation key, so a re-tap or retry
  // submits the SAME bytes and executes once. The ledger comes from THIS merchant's catalog for
  // the request's currency; without it we can neither submit nor poll → honest pending.
  const submitWire = useCallback(async (envelopeHex: string, ctx: TapCtx) => {
    const nonceHex = reqInfo?.nonce ?? '';
    const ledger = catalog.find(c => c.currency === reqInfo?.currency)?.ledger ?? '';
    try {
      if (!ledger) { ctx.finalize('pending', 'Unknown ledger for this asset — couldn’t submit'); return; }
      const requestIdHex = await DpayCore.icpEnvelopeRequestId(envelopeHex);
      const out = await submitTransfer({ledger, requestIdHex, envelopeHex}, identity.secretHex, {attempts: 12, intervalMs: 500});
      if (out.kind === 'settled') {
        record();
        ctx.finalize('success');
      } else if (out.kind === 'rejected') {
        // Structured-tag branch (not human-message matching): Duplicate = already executed —
        // same friendly copy either way, but the decision keys on the decoded ICRC variant.
        ctx.finalize('declined', out.variant === 'Duplicate' ? 'Already paid' : out.reason);
      } else {
        // Not terminal within budget (2–5s consensus + poll budget) — truthful, never a fake
        // success or failure. The payer's own balance reconciles when their phone next polls.
        ctx.finalize('pending', 'Couldn’t confirm with the ledger — check the balance');
      }
      const settle: SettleOutcome = out.kind; // settled | rejected | unknown — 1:1 with receipt codes
      try { await DpayNfc.confirmReceipt(receiptCodeFor(settle), nonceHex); } catch (e: unknown) { console.warn('DpayNfc.confirmReceipt failed (native-module regression?)', e); }
    } catch (e: unknown) {
      console.warn('NfcTap submitWire failed:', e instanceof Error ? e.message : String(e));
      ctx.finalize('pending', 'Couldn’t submit the payment — check the balance');
      try { await DpayNfc.confirmReceipt(receiptCodeFor('unknown'), nonceHex); } catch {/* best-effort */}
    }
  }, [reqInfo, catalog, identity, record]);

  // Payer side: the tap is the consent — sign the incoming request and serve it right away.
  // MC5 — fail closed BEFORE signing: a request carrying an unknown/unsupported currency must NEVER
  // reach the envelope signer. The tap is the consent, so we cannot surface an Approve button —
  // instead we cancel the tap with an honest "Unsupported asset" phase (never sign a garbage
  // currency). A null disclosure is likewise a defense-in-depth decline. prepareTransfer refuses
  // to sign on an unreachable/skewed IC clock — surfaced honestly as a tap error (nothing signed).
  const autoSign = useCallback(async (req: {toHex: string; amount: string; nonceHex: string; expiry: number; currency: number}, ctx: TapCtx) => {
    try {
      // Request-expiry gate (mirrors PayMode.approve): prepareTransfer stamps a FRESH ingress
      // expiry on the envelope it signs, so a STALE REQUEST would otherwise sail through — the
      // ledger never sees the request's own expiry. The tap is the consent, so decline the card
      // with an honest message instead of signing an expired request.
      if (req.expiry * 1000 <= Date.now()) {
        try { await DpayNfc.declineCard(); } catch (e: unknown) { console.warn('DpayNfc.declineCard failed (expired request)', e); }
        ctx.finalize('declined', 'request expired — ask for a fresh tap');
        return;
      }
      if (!isPayableAsset(catalog, req.currency)) {
        try { await DpayNfc.declineCard(); } catch (e: unknown) { console.warn('DpayNfc.declineCard failed (unsupported asset)', e); }
        ctx.finalize('declined', `Unsupported asset (currency ${req.currency}) — tap cancelled`);
        return;
      }
      const disc = resolveNfcDisclosure(catalog, {currency: req.currency, amount: req.amount});
      if (!disc) {
        try { await DpayNfc.declineCard(); } catch (e: unknown) { console.warn('DpayNfc.declineCard failed (no disclosure)', e); }
        ctx.finalize('declined', `Cannot confirm the asset (currency ${req.currency}) — tap cancelled`);
        return;
      }
      setDisclosure(disc);
      const prepared = await prepareTransfer(identity.secretHex, {currencies: catalog}, req);
      sentRef.current = {amount: req.amount, currency: req.currency, who: short(req.toHex), nonce: req.nonceHex};
      await DpayNfc.approveCard(prepared.envelopeHex);
    } catch (e: unknown) {
      // A2: never render the raw exception in the tap status view — generic honest copy instead;
      // the raw message is warn'd so the dev loop stays fail-loud.
      console.warn('NfcTap autoSign failed:', e instanceof Error ? e.message : String(e));
      try { await DpayNfc.declineCard(); } catch {/* best-effort */}
      ctx.finalize('error', "Payment didn't complete — try again");
    }
  }, [identity, catalog]);

  // The wire has left the phone — optimistically deduct from the local balance. The real balance
  // reconciles on the next online poll; if the receipt says declined the onReceipt branch undoes
  // it. MC5: the deduction is KEYED BY the request's currency — a ckBTC tap debits ckBTC.
  const onSettling = useCallback(() => {
    if (!deductedRef.current && sentRef.current) {
      deductedRef.current = true;
      onOfflinePaid?.(sentRef.current.amount, sentRef.current.currency);
    }
  }, [onOfflinePaid]);

  const {phase, reason, activeRef} = useNfcTapState<NfcEvent>({
    role, readerPayload: requestHex, onActive,
    eventName: 'DpayNfcEvent', nativeModule: DpayNfc,
    armCard: () => DpayNfc.armCard(),
    disarmCard: () => DpayNfc.disarmCard(),
    startReader: (p) => DpayNfc.startReader(p),
    stopReader: () => DpayNfc.stopReader(),
    onSettling,
    onRequest: (e, ctx) => { if (e.type === 'request') autoSign({toHex: e.toHex, amount: e.amount, nonceHex: e.nonceHex, expiry: e.expiry, currency: e.currency}, ctx); },
    onSubmit: (e, ctx) => { if (e.type === 'done') submitWire(e.wireHex, ctx); },
    onReceipt: (e, ctx) => {
      if (e.type !== 'receipt') return;
      // The payer's outcome, learned offline over the tap — believed only if it answers the exact
      // payment we signed (nonce match). UNREACHABLE ⇒ pending (unknown), never a false decline.
      const outcome = decidePayerReceipt({status: e.status, nonceHex: e.nonceHex}, sentRef.current?.nonce ?? '');
      if (outcome === 'ignore') return; // a receipt for some other payment — keep waiting
      if (outcome === 'success') {
        record();
        ctx.finalize('success');
      } else if (outcome === 'declined') {
        // The ledger refused — undo the optimistic deduction. MC1 units 2-4: amount is a decimal
        // STRING; negate via BigInt (the Wallet reducer sums as BigInt, so a negative raw-string is
        // the exact undo — never `−string` which is NaN).
        if (deductedRef.current && sentRef.current) { onOfflinePaid?.(`-${sentRef.current.amount}`, sentRef.current.currency); }
        ctx.finalize('declined', 'The ledger declined the payment');
      } else {
        ctx.finalize('pending', 'Couldn’t confirm — check your balance when back online');
      }
    },
  });

  // While merely armed/listening (no tap yet) render nothing, so the parent's QR/scanner shows and
  // the phone can be tapped OR scanned with no mode switch.
  if (phase === 'listening' && !activeRef.current) return null;

  // MC8 U1 — the asset-correct amount string. Card side: the disclosure resolved synchronously in
  // autoSign (asset-correct — "0.00050000 BTC"). Reader side: format from the request's currency.
  const formattedAmt = role === 'card'
    ? disclosure?.formattedAmount ?? null
    : reqInfo ? fmtCurrencyAmount(catalog, reqInfo.currency, reqInfo.amount) : null;
  const networkLabel = role === 'card' ? (disclosure?.networkLabel ?? null) : null;
  return (
    <NfcTapView
      phase={phase} reason={reason} role={role} testID="nfc-status"
      formattedAmt={formattedAmt} networkLabel={networkLabel} onClose={onClose}
    />
  );
}
