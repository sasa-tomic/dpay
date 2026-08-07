import {useCallback, useRef, useState} from 'react';
import {SOL_SEND_TIMEOUT_MS} from '../config/constants';
import {fmtAsset} from '../lib/format';
import type {SolNfcEvent, Identity} from '../lib/types';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {USDC_DECIMALS} from '../solana/spl';
import {decodeSolReq, decodeSolPay} from '../solana/qr';
import {signOfflineSolPayment, signOfflineSplPayment, broadcastSolPayment} from '../solana';
import {decideSolPayerReceipt} from '../solana/payments';
import {RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE} from '../payments';
import type {SolNonceState} from '../services/solNoncePersist';
import {DpaySolNfc} from '../services/native';
import {withTimeout} from '../lib/timeout';
import {useNfcTapState, type TapCtx} from '../hooks/useNfcTapState';
import {NfcTapView} from './NfcTapView';

function solUnit(cur: 'SOL' | 'USDC'): {decimals: number; unit: string} {
  return cur === 'USDC' ? {decimals: USDC_DECIMALS, unit: 'USDC'} : {decimals: SOL_DECIMALS, unit: SOL_UNIT};
}

/**
 * SOL NFC tap adapter. Drives one tap through the native glue (DpaySolNfc — pure Kotlin transport,
 * no Rust core). SolPay mode arms the HCE card (payer is tapped); SolReceive mode runs the reader.
 * The **tap itself is the consent** — when a `solreq:` arrives the payer signs fully offline
 * (against its stored durable nonce) and serves the `solpay:` immediately. The merchant broadcasts
 * online and hands a receipt back; the payer adopts the advanced nonce (receipt-nonce-relay). The
 * shared lifecycle lives in `useNfcTapState`; this adapter fills ONLY the SOL protocol:
 * `signOfflineSolPayment` + RPC broadcast + npub-match + nextNonce adoption.
 */
export function SolNfcTap({role, identity, solreqUri, nonceState, onPaid, onStale, onActive, onClose}: {
  role: 'card' | 'reader';
  identity: Identity;
  solreqUri?: string;
  nonceState?: SolNonceState | null;
  onPaid?: (nextNonce: string) => void;
  onStale?: () => void;
  onActive?: () => void;
  onClose: () => void;
}) {
  // The asset-correct amount string resolved SYNCHRONOUSLY in autoSign (card) / submitPayment
  // (reader) BEFORE the first await, so React renders the honest amount during the in-flight window.
  const [amtText, setAmtText] = useState<string | null>(null);
  // The payer's nonce-account address (base58) — the binding key the receipt must match. Captured at
  // sign time from the live nonceState (NOT the prop, which may change after mount).
  const npubRef = useRef<string>('');

  // Payer side: the tap is the consent — decode the incoming solreq:, sign fully offline against the
  // stored durable nonce, and serve the solpay: right away. Fail closed BEFORE signing if the nonce
  // account isn't ready (no offline sign without a stored nonce value).
  const autoSign = useCallback(async (solreqUri: string, ctx: TapCtx) => {
    try {
      if (!nonceState || nonceState.status !== 'ready') {
        try { await DpaySolNfc.declineSolCard(); } catch {}
        ctx.finalize('declined', 'Set up offline pay first');
        return;
      }
      const req = decodeSolReq(solreqUri);
      const {decimals, unit} = solUnit(req.cur);
      setAmtText(fmtAsset(req.amt, decimals, unit));
      npubRef.current = nonceState.address;
      const solpayUri = req.cur === 'SOL'
        ? signOfflineSolPayment(identity.secretHex, req, nonceState.address, nonceState.value)
        : signOfflineSplPayment(identity.secretHex, req, nonceState.address, nonceState.value);
      await DpaySolNfc.approveSolCard(solpayUri);
    } catch (e: unknown) { ctx.finalize('error', e instanceof Error ? e.message : String(e)); }
  }, [identity, nonceState]);

  // Merchant side: decode the payer's solpay:, broadcast online, confirm — then hand the outcome +
  // the advanced nonce back to the payer over the same tap.
  const submitPayment = useCallback(async (solpayUri: string, ctx: TapCtx) => {
    const {signal, cancel} = withTimeout(SOL_SEND_TIMEOUT_MS * 2);
    try {
      const solpay = decodeSolPay(solpayUri);
      const {decimals, unit} = solUnit(solpay.cur);
      setAmtText(fmtAsset(solpay.amt, decimals, unit));
      const receipt = await broadcastSolPayment(solpay, signal);
      if (receipt.status === RECEIPT_SETTLED) {
        try { await DpaySolNfc.confirmSolReceipt(RECEIPT_SETTLED, receipt.nextNonce ?? '', receipt.sig ?? '', solpay.npub); } catch {}
        ctx.finalize('success');
      } else if (receipt.status === RECEIPT_REJECTED) {
        try { await DpaySolNfc.confirmSolReceipt(RECEIPT_REJECTED, '', '', solpay.npub); } catch {}
        ctx.finalize('declined', 'Payment rejected');
      } else {
        try { await DpaySolNfc.confirmSolReceipt(RECEIPT_UNREACHABLE, '', '', solpay.npub); } catch {}
        ctx.finalize('pending', 'Couldn’t confirm');
      }
    } catch (e: unknown) {
      // A network/RPC throw is genuinely unknown — hand UNREACHABLE so the payer falls back to
      // "couldn't confirm" honestly (never a false decline).
      try { await DpaySolNfc.confirmSolReceipt(RECEIPT_UNREACHABLE, '', '', npubRef.current); } catch {}
      ctx.finalize('pending', e instanceof Error ? e.message : String(e));
    } finally {
      cancel();
    }
  }, []);

  const {phase, reason, activeRef} = useNfcTapState<SolNfcEvent>({
    role, readerPayload: solreqUri, onActive,
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
      // payment we signed (npub match, base58 case-sensitive).
      const outcome = decideSolPayerReceipt(
        {status: e.status, npub: e.npub, nextNonce: e.nextNonce, sig: e.sig},
        npubRef.current,
      );
      if (outcome.outcome === 'ignore') return; // a receipt for a different nonce account
      if (outcome.outcome === 'success') {
        if (outcome.adoptNonce) onPaid?.(outcome.adoptNonce);
        ctx.finalize('success');
      } else if (outcome.outcome === 'declined') {
        onStale?.();
        ctx.finalize('declined', 'Payment rejected');
      } else {
        ctx.finalize('pending', 'Couldn’t confirm');
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
