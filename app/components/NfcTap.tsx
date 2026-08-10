import {useCallback, useRef, useState} from 'react';
import {
  NFC_PAY_TIMEOUT_MS, RECONCILE_ATTEMPTS, RECONCILE_INTERVAL_MS,
  RECONCILE_FETCH_TIMEOUT_MS,
} from '../config/constants';
import {short, base} from '../lib/format';
import {type CurrencyDescriptor, type NfcDisclosure, isPayableAsset, resolveNfcDisclosure, fmtCurrencyAmount} from '../config/catalog';
import type {NfcEvent, Identity} from '../lib/types';
import {
  receiptCodeFor, decidePayerReceipt, rejectionMessage, isNonceReused,
  isReceiptForRequest,
  type SettleOutcome,
} from '../payments';
import {verifyOutcomeReceipt} from '../services/receipt';
import {fetchWithTimeout, payAndClassify, readJsonOrEmpty} from '../services/relay';
import {DpayCore, DpayNfc} from '../services/native';
import {withTimeout} from '../lib/timeout';
import {useNfcTapState, type TapCtx} from '../hooks/useNfcTapState';
import {NfcTapView} from './NfcTapView';

/**
 * IC NFC tap adapter. Drives one tap through the native glue (DpayNfc): Pay mode arms the HCE card
 * (payer is tapped), Receive mode runs the reader (merchant reads the tap). The **tap itself is the
 * consent** — when a request arrives the payer's phone signs and serves it immediately. The shared
 * lifecycle (phase state machine, finalize, settle timer, the subscribe→arm→cleanup effect) lives
 * in `useNfcTapState`; this adapter fills ONLY the IC protocol: `signAuthorization` + relay `/pay`
 * + nonce-reconcile + optimistic balance deduction + canister-signed receipt verification.
 */
export function NfcTap({role, identity, relayUrl, requestHex, reqInfo, catalog, onSettled, onOfflinePaid, onActive, onClose}: {
  role: 'card' | 'reader';
  identity: Identity;
  relayUrl: string;
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
  // True once we've optimistically deducted the payment from the local balance (when the wire
  // leaves the phone). Prevents double-deduction if the receipt later arrives with success, and
  // enables undo if the receipt says declined.
  const deductedRef = useRef(false);

  const record = useCallback(() => {
    if (recordedRef.current || !onSettled) return;
    recordedRef.current = true;
    onSettled();
  }, [onSettled]);

  // POST /pay once, bounded by a timeout. Returns the classified outcome + parsed body, or
  // outcome='unknown' + empty body when fetch threw (network/timeout/abort) — which the caller
  // treats as UNKNOWN, not failure. PR25 — delegates to the shared `payAndClassify` helper.
  const postPay = useCallback(async (code: string) => {
    const {signal, cancel} = withTimeout(NFC_PAY_TIMEOUT_MS);
    try {
      return await payAndClassify(relayUrl, code, signal);
    } finally { cancel(); }
  }, [relayUrl]);

  // Reconcile an ambiguous outcome via the idempotent GET /receipt/:nonce. Returns the settled
  // receipt (or null if not settled after a few polls). Safe by construction: the nonce is
  // single-use, so this can never cause a second charge — it only *reads* whether it landed.
  const reconcile = useCallback(async (nonceHex: string) => {
    for (let i = 0; i < RECONCILE_ATTEMPTS; i++) {
      try {
        const r = await fetchWithTimeout(`${base(relayUrl)}/api/v1/receipt/${nonceHex}`, undefined, RECONCILE_FETCH_TIMEOUT_MS);
        if (r.ok) { const j = await readJsonOrEmpty(r); return j.receipt ?? {}; }
      } catch (e) { console.warn('NFC receipt reconcile poll failed:', e instanceof Error ? e.message : String(e)); /* keep polling */ }
      await new Promise(res => setTimeout(res, RECONCILE_INTERVAL_MS));
    }
    return null;
  }, [relayUrl]);

  // Merchant side: submit the reassembled wire, decide the authoritative outcome, then hand it back
  // to the payer over the same tap. The ledger is the source of truth; an ambiguous transport/HTTP
  // result is reconciled by nonce before we ever call a payment failed. R2: we verify the settled
  // receipt's canister/ledger signature before finalizing success.
  const submitWire = useCallback(async (wireHex: string, ctx: TapCtx) => {
    const nonceHex = reqInfo?.nonce ?? null;
    const code = await DpayCore.encodeQr(wireHex).catch((e: unknown) => { console.warn('encodeQr failed:', e instanceof Error ? e.message : String(e)); return null; });
    if (!code) { ctx.finalize('error', 'Could not encode the authorization'); return; } // pre-settlement

    const {outcome: payOutcome, body} = await postPay(code);
    let outcome: SettleOutcome = payOutcome;
    let settledNonceHex: string | null = nonceHex;
    let settledReceipt: any = null;

    if (outcome === 'settled') {
      settledNonceHex = body?.receipt?.nonce ?? nonceHex;
      settledReceipt = body?.receipt ?? null;
    } else if (outcome === 'rejected') {
      // "Nonce reused" is not a real refusal — it means this exact payment already settled.
      // Reconcile to the real receipt instead of showing a scary (and false) decline.
      if (isNonceReused(body?.error) && nonceHex) {
        const rec = await reconcile(nonceHex);
        if (rec) { outcome = 'settled'; settledNonceHex = rec.nonce ?? nonceHex; settledReceipt = rec; }
      }
    } else if (nonceHex) {
      // UNKNOWN (network drop / timeout / 5xx): the ledger MAY have committed. Reconcile before
      // deciding — this is the fix for "settled but reported as failed".
      const rec = await reconcile(nonceHex);
      if (rec) { outcome = 'settled'; settledNonceHex = rec.nonce ?? nonceHex; settledReceipt = rec; }
    }

    if (outcome === 'settled') {
      // PR1 (goods-fraud guard): bind the receipt to THIS request's nonce BEFORE the signature
      // check. A malicious relay can replay any past valid canister-signed receipt for a different
      // payment — the key-pin + signature would pass on their own, so the nonce mismatch must
      // reject it first. MC4 U5: the full-auth binding is intentionally NOT passed here (merchant
      // path — the merchant forwards the payer's opaque signed wire but never decodes its `from`).
      const nonceMatches = settledReceipt && reqInfo?.nonce
        ? isReceiptForRequest(settledReceipt, reqInfo.nonce)
        : true;
      const verified = nonceMatches && settledReceipt ? await verifyOutcomeReceipt(settledReceipt) : false;
      if (verified) {
        record();
        ctx.finalize('success');
      } else {
        ctx.finalize('pending', 'Couldn’t verify the payment — check the balance');
      }
    } else if (outcome === 'rejected') {
      ctx.finalize('declined', rejectionMessage(typeof body?.error === 'string' ? body.error : null));
    } else {
      // Genuinely unknown even after reconciliation — truthful, never a fake success or failure.
      ctx.finalize('pending', 'Couldn’t confirm with the ledger — check the balance');
    }
    // Best-effort: hand the outcome back to the payer, stamped with the authoritative nonce.
    try { await DpayNfc.confirmReceipt(receiptCodeFor(outcome), settledNonceHex ?? nonceHex ?? ''); } catch (e: unknown) { console.warn('DpayNfc.confirmReceipt failed (native-module regression?)', e); }
  }, [reqInfo, record, postPay, reconcile]);

  // Payer side: the tap is the consent — sign the incoming request and serve it right away.
  // MC5 — fail closed BEFORE signing: a request carrying an unknown/unsupported currency must NEVER
  // reach signAuthorization. The tap is the consent, so we cannot surface an Approve button —
  // instead we cancel the tap with an honest "Unsupported asset" phase (never sign a garbage
  // currency). A null disclosure is likewise a defense-in-depth decline.
  const autoSign = useCallback(async (req: {toHex: string; amount: string; nonceHex: string; expiry: number; currency: number}, ctx: TapCtx) => {
    try {
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
      const wireHex = await DpayCore.signAuthorization(identity.secretHex, req.toHex, req.amount, req.nonceHex, req.expiry, req.currency, identity.username, '', '');
      if (!(await DpayCore.verifyWire(wireHex))) throw new Error('local verify failed');
      sentRef.current = {amount: req.amount, currency: req.currency, who: short(req.toHex), nonce: req.nonceHex};
      await DpayNfc.approveCard(wireHex);
    } catch (e: unknown) { ctx.finalize('error', e instanceof Error ? e.message : String(e)); }
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
