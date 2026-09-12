import {useCallback, useRef, useState} from 'react';
import {useJourney} from '../lib/journey';
import {awardPaymentTested} from '../lib/readiness';
import bs58 from 'bs58';
import {SOL_BROADCAST_TIMEOUT_MS} from '../config/constants';
import {fmtAsset} from '../lib/format';
import type {SolNfcEvent, Identity} from '../lib/types';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {solanaTokenInfo, solanaTokenOfMint} from '../solana/tokens';
import {solSignCaveat, solSplSignGate, type SolMintStates} from '../config/assets';
import {decodeSolReq, decodeSolPay, encodeSolPay} from '../solana/qr';
import type {SolReqV2, SolPayV2} from '../solana/qr';
import {extractSignedTxParts} from '../solana/tx';
import {signSolPayment, signSplPayment, broadcastSolPayment} from '../solana';
import {friendlySolTapError} from '../solana/errors';
import {decideSolPayerReceiptV2, isSolReqV2Expired, RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE, RECEIPT_MISMATCH} from '../solana/payments';
import {DpaySolNfc} from '../services/native';
import {saveTxNote} from '../services/txNotes';
import {sanitiseDisplayText} from '../lib/deepLink';
import {withTimeout} from '../lib/timeout';
import {useNfcTapState, type TapCtx} from '../hooks/useNfcTapState';
import {NfcTapView} from './NfcTapView';
import {M} from '../i18n';

/** Display facts for a request's token: registry decimals + the token literal as its own unit.
 *  SOL is the identity case (lamports); any registry SPL symbol (USDC, EURC, …) reads its own
 *  row. Unknown tokens (the codec is shape-only) render their literal with SOL decimals as a
 *  display-only fallback — the SIGN path refuses them authoritatively. */
function solUnit(cur: string): {decimals: number; unit: string} {
  if (cur === 'SOL') return {decimals: SOL_DECIMALS, unit: SOL_UNIT};
  const info = solanaTokenInfo(cur);
  return {decimals: info?.decimals ?? SOL_DECIMALS, unit: cur};
}

/**
 * SOL NFC tap adapter (v2 recent-blockhash). Drives one tap through the native glue (DpaySolNfc —
 * pure Kotlin transport, no Rust core). SolPay mode arms the HCE card (payer is tapped); SolReceive
 * mode runs the reader. When a `solreq:v2:` arrives the payer AUTO-SIGNS (one-press rule: the "Pay
 * Now" gate armed the tap — the request's arrival is the payment, no review park). The payer signs
 * fully offline (against the recent blockhash embedded in the request) and serves the
 * `solpay:v2:`. The merchant broadcasts online and hands a receipt `{status, rid, sig}` back; the
 * payer matches rid+sig and transitions (or ignores a cross-tap receipt). The shared lifecycle
 * lives in `useNfcTapState`; this adapter fills ONLY the SOL protocol: signSolPayment/
 * signSplPayment + RPC broadcast + rid/sig receipt matching.
 */
export function SolNfcTap({role, identity, req, reqUri, tokenBalances, onOutcome, onResult, onActive, onClose}: {
  role: 'card' | 'reader';
  identity: Identity;
  req?: SolReqV2;
  reqUri?: string;
  /** Per-mint token states (useSolanaBalances tokens) for the per-request-mint sign gate —
   *  card role only (the reader/broadcast side signs nothing). Optional: readers and legacy
   *  mounts fail open exactly like an unpolled mint. */
  tokenBalances?: SolMintStates;
  onOutcome?: (o: 'success' | 'pending' | 'declined') => void;
  onResult?: (r: {amount: string; cur: string; sig: string} | null) => void;
  onActive?: () => void;
  onClose: () => void;
}) {
  // The asset-correct amount string resolved SYNCHRONOUSLY in validateRequest (card) /
  // submitPayment (reader) BEFORE the first await, so React renders the honest amount during the
  // in-flight window.
  const [amtText, setAmtText] = useState<string | null>(null);
  // Trip-prep auto-detection (founder rule 2026-08-24): a settled SOL tap must tick FIRST PAYMENT
  // (+ flowUnderstood co-award) on BOTH sides — the payer (onReceipt success) and the merchant
  // reader (submitPayment broadcast-settles). journeyRef = fresh snapshot for async callbacks.
  const {journey} = useJourney();
  const journeyRef = useRef(journey);
  journeyRef.current = journey;
  // One-press rule: a validated request signs IMMEDIATELY (no parked review). `signingRef` latches
  // at sign start so the transport's re-tap re-push of the same rid can't double-sign; the hook
  // drops post-sign request duplicates, this guards the async window before `advance` fires.
  const signingRef = useRef(false);
  // The rid of the request we've signed (or are signing): re-tap duplicates with the SAME rid are
  // ignored; a different rid after a completed sign is dropped too (the signed payment owns the
  // UI — the merchant must re-arm for a fresh payment).
  const signedRidRef = useRef<string | null>(null);
  // The auto-sign entry, reachable from the hook's request dispatch (which runs before `advance`
  // exists as a binding). Assigned right after the hook call below.
  const approveRef = useRef<(decoded: SolReqV2, ctx: TapCtx) => Promise<void>>(async () => {});
  // The v2 receipt bindings captured at sign time: expectedRid (the request's 32-hex rid) +
  // expectedSig (the first tx signature, base58). The receipt must match BOTH or it's ignored
  // (defense against a cross-tap receipt for a different payment).
  const expectedRidRef = useRef<string>('');
  const expectedSigRef = useRef<string>('');
  // The disclosure a payment signed on NO fact owes its payer (`solSignCaveat`). The QR rail can
  // put it on the hand-off screen; this one CANNOT — a tap auto-signs with no review, and by the
  // time anything renders the payment has already left the phone. So it is carried to the terminal
  // message instead, which is the only sentence this flow ever shows the payer. Null whenever the
  // gate decided on a fact.
  const signCaveatRef = useRef<string | null>(null);
  /** Append the fact-less-signature caveat to a terminal reason, when there is one to append. */
  const withSignCaveat = (reason: string) =>
    signCaveatRef.current === null ? reason : `${reason}. ${signCaveatRef.current}`;

  // Payer (card): decode the incoming solreq:v2 and AUTO-SIGN. The SOL transport re-emits
  // `request` on every re-tap (no requestSent latch): a duplicate with the SAME rid is ignored
  // (the sign already fired); a different rid before any sign replaces it (last-writer-wins, e.g.
  // the merchant pushed a fresh request within the validate window). Expiry is re-checked
  // authoritatively INSIDE the sign (isSolReqV2Expired) — an expired request declines honestly.
  const validateRequest = useCallback(async (solreqUri: string, ctx: TapCtx) => {
    try {
      const decoded = decodeSolReq(solreqUri);
      if (signedRidRef.current === decoded.rid) return; // re-tap duplicate — sign already fired
      signedRidRef.current = decoded.rid;
      const {decimals, unit} = solUnit(decoded.cur);
      setAmtText(fmtAsset(decoded.amt, decimals, unit));
      await approveRef.current(decoded, ctx);
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      console.warn('SolNfcTap request validation failed:', raw);
      try { await DpaySolNfc.declineSolCard(); } catch (e2: unknown) { console.warn('DpaySolNfc.declineSolCard failed (bad req)', e2); }
      ctx.finalize('error', friendlySolTapError(raw));
    }
  }, []);

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
        ctx.finalize('declined', M.errors.tap.noOpenRequest);
        return;
      }
      // The amount/cur are known from the merchant's own request (the v2 SolPay carries only rid+tx).
      const {decimals, unit} = solUnit(req.cur);
      setAmtText(fmtAsset(req.amt, decimals, unit));
      const receipt = await broadcastSolPayment(req, reqUri, solpay, signal);
      if (receipt.status === RECEIPT_SETTLED) {
        try { await DpaySolNfc.confirmSolReceipt(RECEIPT_SETTLED, receipt.rid, receipt.sig); } catch (e: unknown) { console.warn('DpaySolNfc.confirmSolReceipt failed (settled)', e); }
        onResult?.({amount: req.amt, cur: req.cur, sig: receipt.sig});
        awardPaymentTested(journeyRef.current); // merchant reader: broadcast-settled tap counts
        ctx.finalize('success');
      } else if (receipt.status === RECEIPT_REJECTED) {
        try { await DpaySolNfc.confirmSolReceipt(RECEIPT_REJECTED, receipt.rid, receipt.sig); } catch (e: unknown) { console.warn('DpaySolNfc.confirmSolReceipt failed (rejected)', e); }
        ctx.finalize('declined', M.errors.tap.paymentRejected);
      } else if (receipt.status === RECEIPT_MISMATCH) {
        // Settle-verify mismatch: the confirmed body isn't this request. Honest pending for the
        // payer (Kotlin maps the unknown code 3 to the PENDING card phase and re-emits it
        // verbatim — the payer's own decideSolPayerReceiptV2 maps 3→pending); never a decline.
        try { await DpaySolNfc.confirmSolReceipt(RECEIPT_MISMATCH, receipt.rid, receipt.sig); } catch (e: unknown) { console.warn('DpaySolNfc.confirmSolReceipt failed (mismatch)', e); }
        ctx.finalize('pending', M.errors.tap.settlementNotVerified);
      } else {
        try { await DpaySolNfc.confirmSolReceipt(RECEIPT_UNREACHABLE, receipt.rid, receipt.sig); } catch (e: unknown) { console.warn('DpaySolNfc.confirmSolReceipt failed (unreachable)', e); }
        ctx.finalize('pending', M.errors.tap.couldntConfirm);
      }
    } catch (e: unknown) {
      // A network/RPC throw is genuinely unknown — hand UNREACHABLE so the payer falls back to
      // "couldn't confirm" honestly (never a false decline). A2: the merchant's own sub-line maps
      // via friendlySolTapError with check-your-balance fallback copy (an unknown outcome must not
      // read as "try again" — the broadcast may still land); the raw message is warn'd for the
      // dev loop.
      const raw = e instanceof Error ? e.message : String(e);
      console.warn('SolNfcTap submitPayment failed:', raw);
      try { await DpaySolNfc.confirmSolReceipt(RECEIPT_UNREACHABLE, '', ''); } catch (e2: unknown) { console.warn('DpaySolNfc.confirmSolReceipt failed (catch-all)', e2); }
      ctx.finalize('pending', friendlySolTapError(raw, M.errors.tap.couldntConfirmCheckBalance));
    } finally {
      cancel();
    }
  }, [req, reqUri, onResult]);

  const {phase, reason, activeRef, advance} = useNfcTapState<SolNfcEvent>({
    role, readerPayload: reqUri, onActive,
    eventName: 'DpaySolNfcEvent', nativeModule: DpaySolNfc,
    armCard: () => DpaySolNfc.armCard(),
    disarmCard: () => DpaySolNfc.disarmCard(),
    startReader: (p) => DpaySolNfc.startSolReader(p),
    stopReader: () => DpaySolNfc.stopSolReader(),
    onRequest: (e, ctx) => { if (e.type === 'request') void validateRequest(e.solreqUri, ctx); },
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
        awardPaymentTested(journeyRef.current); // payer: tap-settled payment counts
        // No caveat on a settlement: the chain just proved the token account exists, so repeating
        // "dpay couldn't check it" would be the wallet contradicting the ledger.
        ctx.finalize('success');
      } else if (outcome.outcome === 'declined') {
        onOutcome?.('declined');
        // A decline is EXACTLY the outcome an absent token account produces (the merchant's
        // broadcast is rejected on chain), so the unchecked-account caveat is the most useful
        // thing this screen can add to "Payment rejected".
        ctx.finalize('declined', withSignCaveat(M.errors.tap.paymentRejected));
      } else {
        onOutcome?.('pending');
        ctx.finalize('pending', withSignCaveat(M.errors.tap.couldntConfirm));
      }
    },
  });

  // The auto-sign: authoritative expiry re-check at sign time (isSolReqV2Expired — the request's
  // frozen blockhash also goes stale, so an old request is refused here, not by a chip), then the
  // fully-offline sign against the frozen blockhash + provideWire (cached; served on this tap or
  // the next re-tap). (Lives AFTER the hook call: it closes over `advance`; validateRequest
  // reaches it through `approveRef`.)
  const approve = useCallback(async (decoded: SolReqV2, ctx: TapCtx) => {
    if (signingRef.current) return;
    signingRef.current = true;
    if (isSolReqV2Expired(decoded)) {
      try { await DpaySolNfc.declineSolCard(); } catch (e: unknown) { console.warn('DpaySolNfc.declineSolCard failed (expired)', e); }
      ctx.finalize('declined', M.errors.tap.paymentRequestExpired);
      return;
    }
    // Per-request-mint absent-ATA gate (OPEN_ISSUES 6(a)): the request names its OWN mint, which
    // need not be the armed asset's — a KNOWN-absent mint would sign pure against an ATA that
    // doesn't exist and the merchant's broadcast would be REJECTED (dead tap). Decline the card
    // with the named instruction (same shape as the expired decline above). Unconfirmed states
    // fail open — see solSplSignGate.
    const signGate = solSplSignGate(decoded.mint, tokenBalances ?? {});
    if (signGate === 'unregistered' || signGate === 'absent') {
      try { await DpaySolNfc.declineSolCard(); } catch (e: unknown) { console.warn('DpaySolNfc.declineSolCard failed (sign gate)', e); }
      ctx.finalize(
        'declined',
        signGate === 'unregistered'
          ? M.pay.spay.unknownMint(decoded.mint ?? '')
          : M.errors.solana.senderNoTokenAccount(solanaTokenOfMint(decoded.mint) ?? decoded.mint ?? ''),
      );
      return;
    }
    // …and when the gate failed OPEN, carry WHY to whatever this tap ends up saying (below).
    signCaveatRef.current = solSignCaveat(signGate, decoded.mint);
    advance('exchanging');
    try {
      const solpay: SolPayV2 = decoded.cur === 'SOL'
        ? signSolPayment(identity.secretHex, decoded)
        : signSplPayment(identity.secretHex, decoded);
      // Capture the rid + first signature for receipt binding (BEFORE the tap delivers the receipt).
      expectedRidRef.current = decoded.rid;
      const parts = extractSignedTxParts(solpay.tx);
      expectedSigRef.current = parts ? bs58.encode(parts.signature) : '';
      // Device-saved annotation (services/txNotes): the tap request's claimed name + human memo
      // ride nowhere else — record them against the signature just captured (the SOL join key; the
      // settling row will carry it), same seam as SolPayMode's QR sign. Best-effort by contract.
      void saveTxNote(identity.publicHex, {k: expectedSigRef.current, who: sanitiseDisplayText(decoded.name) || undefined, msg: sanitiseDisplayText(decoded.memo) || undefined}, Date.now());
      const solpayUri = encodeSolPay(solpay);
      await DpaySolNfc.approveSolCard(solpayUri);
    } catch (e: unknown) {
      // A2: map via friendlySolTapError (never the raw string — the status view renders it
      // verbatim); the raw message is warn'd so the dev loop stays fail-loud.
      const raw = e instanceof Error ? e.message : String(e);
      console.warn('SolNfcTap approve failed:', raw);
      ctx.finalize('error', friendlySolTapError(raw));
    }
  }, [advance, identity.secretHex, tokenBalances]);
  approveRef.current = approve;

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
