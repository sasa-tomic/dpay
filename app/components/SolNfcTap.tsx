import {useCallback, useRef, useState} from 'react';
import bs58 from 'bs58';
import {SOL_BROADCAST_TIMEOUT_MS} from '../config/constants';
import {fmtAsset} from '../lib/format';
import type {SolNfcEvent, Identity} from '../lib/types';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {USDC_DECIMALS} from '../solana/spl';
import {decodeSolReq, decodeSolPay, encodeSolPay} from '../solana/qr';
import type {SolReqV2, SolPayV2} from '../solana/qr';
import {extractSignedTxParts} from '../solana/tx';
import {signSolPayment, signSplPayment, broadcastSolPayment} from '../solana';
import {decideSolPayerReceiptV2, isSolReqV2Expired} from '../solana/payments';
import {RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE} from '../payments';
import {DpaySolNfc} from '../services/native';
import {withTimeout} from '../lib/timeout';
import {useNfcTapState, type TapCtx} from '../hooks/useNfcTapState';
import {NfcTapView} from './NfcTapView';

function solUnit(cur: 'SOL' | 'USDC'): {decimals: number; unit: string} {
  return cur === 'USDC' ? {decimals: USDC_DECIMALS, unit: 'USDC'} : {decimals: SOL_DECIMALS, unit: SOL_UNIT};
}

/**
 * SOL NFC tap adapter (v2 recent-blockhash). Drives one tap through the native glue (DpaySolNfc —
 * pure Kotlin transport, no Rust core). SolPay mode arms the HCE card (payer is tapped); SolReceive
 * mode runs the reader. The **tap itself is the consent** — when a `solreq:v2:` arrives the payer
 * signs fully offline (against the recent blockhash embedded in the request) and serves the
 * `solpay:v2:` immediately. The merchant broadcasts online and hands a receipt `{status, rid, sig}`
 * back; the payer matches rid+sig and transitions (or ignores a cross-tap receipt). The shared
 * lifecycle lives in `useNfcTapState`; this adapter fills ONLY the SOL protocol:
 * signSolPayment/signSplPayment + RPC broadcast + rid/sig receipt matching.
 */
export function SolNfcTap({role, identity, req, reqUri, onOutcome, onResult, onActive, onClose}: {
  role: 'card' | 'reader';
  identity: Identity;
  req?: SolReqV2;
  reqUri?: string;
  onOutcome?: (o: 'success' | 'pending' | 'declined') => void;
  onResult?: (r: {amount: string; cur: 'SOL' | 'USDC'; sig: string} | null) => void;
  onActive?: () => void;
  onClose: () => void;
}) {
  // The asset-correct amount string resolved SYNCHRONOUSLY in autoSign (card) / submitPayment
  // (reader) BEFORE the first await, so React renders the honest amount during the in-flight window.
  const [amtText, setAmtText] = useState<string | null>(null);
  // The v2 receipt bindings captured at sign time: expectedRid (the request's 32-hex rid) +
  // expectedSig (the first tx signature, base58). The receipt must match BOTH or it's ignored
  // (defense against a cross-tap receipt for a different payment).
  const expectedRidRef = useRef<string>('');
  const expectedSigRef = useRef<string>('');

  // Payer (card): the tap is the consent — decode the incoming solreq:v2, check it's not expired,
  // sign fully offline against the recent blockhash, and serve the solpay:v2 immediately.
  const autoSign = useCallback(async (solreqUri: string, ctx: TapCtx) => {
    try {
      const decoded = decodeSolReq(solreqUri);
      if (isSolReqV2Expired(decoded)) {
        try { await DpaySolNfc.declineSolCard(); } catch (e: unknown) { console.warn('DpaySolNfc.declineSolCard failed (expired req)', e); }
        ctx.finalize('declined', 'This payment request has expired');
        return;
      }
      const {decimals, unit} = solUnit(decoded.cur);
      setAmtText(fmtAsset(decoded.amt, decimals, unit));
      const solpay: SolPayV2 = decoded.cur === 'SOL'
        ? signSolPayment(identity.secretHex, decoded)
        : signSplPayment(identity.secretHex, decoded);
      // Capture the rid + first signature for receipt binding (BEFORE the tap delivers the receipt).
      expectedRidRef.current = decoded.rid;
      const parts = extractSignedTxParts(solpay.tx);
      expectedSigRef.current = parts ? bs58.encode(parts.signature) : '';
      const solpayUri = encodeSolPay(solpay);
      await DpaySolNfc.approveSolCard(solpayUri);
    } catch (e: unknown) { ctx.finalize('error', e instanceof Error ? e.message : String(e)); }
  }, [identity]);

  // Merchant (reader): decode the payer's solpay:v2, broadcast online (strict verify + freshness +
  // confirm inside broadcastSolPayment), then hand the receipt {status, rid, sig} back to the payer
  // over the same tap. The 12s native receipt window + 8s JS settlement budget are enforced by
  // SOL_BROADCAST_TIMEOUT_MS (withTimeout).
  const submitPayment = useCallback(async (solpayUri: string, ctx: TapCtx) => {
    const {signal, cancel} = withTimeout(SOL_BROADCAST_TIMEOUT_MS);
    try {
      const solpay = decodeSolPay(solpayUri);
      if (!req || !reqUri) {
        try { await DpaySolNfc.confirmSolReceipt(RECEIPT_REJECTED, '', ''); } catch (e: unknown) { console.warn('DpaySolNfc.confirmSolReceipt failed (no req)', e); }
        ctx.finalize('declined', 'No open request');
        return;
      }
      // The amount/cur are known from the merchant's own request (the v2 SolPay carries only rid+tx).
      const {decimals, unit} = solUnit(req.cur);
      setAmtText(fmtAsset(req.amt, decimals, unit));
      const receipt = await broadcastSolPayment(req, reqUri, solpay, signal);
      if (receipt.status === RECEIPT_SETTLED) {
        try { await DpaySolNfc.confirmSolReceipt(RECEIPT_SETTLED, receipt.rid, receipt.sig); } catch (e: unknown) { console.warn('DpaySolNfc.confirmSolReceipt failed (settled)', e); }
        onResult?.({amount: req.amt, cur: req.cur, sig: receipt.sig});
        ctx.finalize('success');
      } else if (receipt.status === RECEIPT_REJECTED) {
        try { await DpaySolNfc.confirmSolReceipt(RECEIPT_REJECTED, receipt.rid, receipt.sig); } catch (e: unknown) { console.warn('DpaySolNfc.confirmSolReceipt failed (rejected)', e); }
        ctx.finalize('declined', 'Payment rejected');
      } else {
        try { await DpaySolNfc.confirmSolReceipt(RECEIPT_UNREACHABLE, receipt.rid, receipt.sig); } catch (e: unknown) { console.warn('DpaySolNfc.confirmSolReceipt failed (unreachable)', e); }
        ctx.finalize('pending', 'Couldn\u2019t confirm');
      }
    } catch (e: unknown) {
      // A network/RPC throw is genuinely unknown — hand UNREACHABLE so the payer falls back to
      // "couldn't confirm" honestly (never a false decline).
      try { await DpaySolNfc.confirmSolReceipt(RECEIPT_UNREACHABLE, '', ''); } catch (e2: unknown) { console.warn('DpaySolNfc.confirmSolReceipt failed (catch-all)', e2); }
      ctx.finalize('pending', e instanceof Error ? e.message : String(e));
    } finally {
      cancel();
    }
  }, [req, reqUri, onResult]);

  const {phase, reason, activeRef} = useNfcTapState<SolNfcEvent>({
    role, readerPayload: reqUri, onActive,
    eventName: 'DpaySolNfcEvent', nativeModule: DpaySolNfc,
    armCard: () => DpaySolNfc.armCard(),
    disarmCard: () => DpaySolNfc.disarmCard(),
    startReader: (p) => DpaySolNfc.startSolReader(p),
    stopReader: () => DpaySolNfc.stopSolReader(),
    onRequest: (e, ctx) => { if (e.type === 'request') autoSign(e.solreqUri, ctx); },
    onSubmit: (e, ctx) => { if (e.type === 'payment') submitPayment(e.solpayUri, ctx); },
    onReceipt: (e, ctx) => {
      if (e.type !== 'receipt') return;
      // The payer's outcome, learned offline over the tap — believed only if it answers the exact
      // payment we signed (rid match EXACT hex, sig match EXACT base58).
      const outcome = decideSolPayerReceiptV2(
        {status: e.status, rid: e.rid, sig: e.sig},
        expectedRidRef.current,
        expectedSigRef.current,
      );
      if (outcome.outcome === 'ignore') return; // a receipt for a different payment (cross-tap)
      if (outcome.outcome === 'success') {
        onOutcome?.('success');
        ctx.finalize('success');
      } else if (outcome.outcome === 'declined') {
        onOutcome?.('declined');
        ctx.finalize('declined', 'Payment rejected');
      } else {
        onOutcome?.('pending');
        ctx.finalize('pending', 'Couldn\u2019t confirm');
      }
    },
  });

  // While merely armed/listening (no tap yet) render nothing, so the parent's QR shows and the phone
  // can be tapped OR scanned with no mode switch.
  if (phase === 'listening' && !activeRef.current) return null;

  return (
    <NfcTapView
      phase={phase} reason={reason} role={role} testID="sol-nfc-status"
      formattedAmt={amtText} onClose={onClose}
    />
  );
}
