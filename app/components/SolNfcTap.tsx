import {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, Pressable, ActivityIndicator, NativeEventEmitter} from 'react-native';
import {C} from '../config/palette';
import {RECEIPT_WAIT_MS, SOL_SEND_TIMEOUT_MS} from '../config/constants';
import {S} from '../styles';
import {fmtAsset} from '../lib/format';
import type {SolNfcEvent, SolNfcPhaseName, Identity} from '../lib/types';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {USDC_DECIMALS} from '../solana/spl';
import {decodeSolReq, decodeSolPay} from '../solana/qr';
import {signOfflineSolPayment, signOfflineSplPayment, broadcastSolPayment} from '../solana';
import {decideSolPayerReceipt} from '../solana/payments';
import {RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE} from '../payments';
import type {SolNonceState} from '../services/solNoncePersist';
import {DpaySolNfc} from '../services/native';
import {NfcIcon} from './NfcIcon';

// Phase → status-view presentation (mirrors NfcTap's NFC_UI). `spin` renders a spinner; `icon`
// renders the NFC contactless mark (the listening/"armed" state) in place of a text glyph.
const SOL_NFC_UI: Record<string, {tone: string; glyph?: string; spin?: boolean; icon?: 'nfc'; title: string; sub: string}> = {
  listening: {tone: C.brand, icon: 'nfc', title: 'Hold near the other phone', sub: 'dpay is listening for a tap'},
  linking: {tone: C.brand, spin: true, title: 'Connecting…', sub: 'Linking the two phones'},
  exchanging: {tone: C.brand, spin: true, title: 'Communicating…', sub: 'Keep the phones together'},
  awaitingApproval: {tone: C.brand, spin: true, title: 'Authorizing…', sub: 'Signing on the payer’s phone'},
  settling: {tone: C.brand, spin: true, title: 'Confirming…', sub: 'Keep the phones together while the merchant settles'},
  success: {tone: C.ok, glyph: '✓', title: 'Done ✓', sub: ''},
  declined: {tone: C.sub, glyph: '✕', title: 'Declined', sub: 'The payment was declined'},
  pending: {tone: C.warn, glyph: '?', title: 'Not confirmed', sub: 'Couldn’t reach the ledger'},
  error: {tone: C.bad, glyph: '!', title: 'Tap failed', sub: 'Move the phones together and try again'},
};

function solUnit(cur: 'SOL' | 'USDC'): {decimals: number; unit: string} {
  return cur === 'USDC' ? {decimals: USDC_DECIMALS, unit: 'USDC'} : {decimals: SOL_DECIMALS, unit: SOL_UNIT};
}

/**
 * Drives one SOL NFC tap through the native glue (DpaySolNfc — pure Kotlin transport, no Rust core).
 * SolPay mode arms the HCE card (payer is tapped); SolReceive mode runs the reader (merchant reads
 * the tap). The **tap itself is the consent** — when a `solreq:` arrives the payer's phone signs
 * fully offline (against its stored durable nonce) and serves the `solpay:` immediately (contactless
 * tap-to-pay, no Approve button). The merchant then broadcasts online and hands a receipt back over
 * the same tap; the payer adopts the advanced nonce (the receipt-nonce-relay). The radio hop is a
 * physical-device gate.
 */
export function SolNfcTap({role, identity, solreqUri, nonceState, onPaid, onStale, onActive, onClose}: {
  role: 'card' | 'reader';
  identity: Identity;
  solreqUri?: string;
  nonceState?: SolNonceState | null; // card-only (the payer's stored durable nonce); null for the reader
  onPaid?: (nextNonce: string) => void;
  onStale?: () => void;
  onActive?: () => void; // fired the moment a real tap starts (so the parent can hide the QR/scanner)
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<SolNfcPhaseName | 'error'>('listening');
  const [reason, setReason] = useState<string | null>(null);
  // The asset-correct amount string resolved SYNCHRONOUSLY in autoSign (card) / submitPayment
  // (reader) BEFORE the first await, so React renders the honest amount during the in-flight window.
  const [amtText, setAmtText] = useState<string | null>(null);
  // The payer's nonce-account address (base58) — the binding key the receipt must match. Captured at
  // sign time from the live nonceState (NOT the prop, which may change after mount).
  const npubRef = useRef<string>('');
  const finalized = useRef(false);
  const activeRef = useRef(false);
  // Set once the payer's solpay has left the phone (settling). After this the ledger outcome is
  // owned by the receipt path, so a transport error during the receipt hand-back must NOT show as a
  // payment failure.
  const committed = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // False once the tap view is torn down; an in-flight promise resolving after that must not touch state.
  const aliveRef = useRef(true);

  const clearSettleTimer = useCallback(() => {
    if (settleTimer.current) { clearTimeout(settleTimer.current); settleTimer.current = null; }
  }, []);

  const finalize = useCallback((p: SolNfcPhaseName | 'error', r?: string) => {
    if (finalized.current || !aliveRef.current) return; // first terminal wins; ignore after teardown
    finalized.current = true;
    clearSettleTimer();
    setReason(r ?? null);
    setPhase(p);
  }, [clearSettleTimer]);

  // Keep onActive in a ref so markActive has a stable identity (the effect must not re-subscribe /
  // re-arm on every parent render just because an inline callback changed).
  const onActiveRef = useRef(onActive);
  onActiveRef.current = onActive;
  const markActive = useCallback(() => {
    if (!activeRef.current) { activeRef.current = true; onActiveRef.current?.(); }
  }, []);

  // Payer side: the tap is the consent — decode the incoming solreq:, sign fully offline against the
  // stored durable nonce, and serve the solpay: right away. Fail closed BEFORE signing if the nonce
  // account isn't ready (no offline sign without a stored nonce value).
  const autoSign = useCallback(async (solreqUri: string) => {
    try {
      if (!nonceState || nonceState.status !== 'ready') {
        try { await DpaySolNfc.declineSolCard(); } catch {}
        finalize('declined', 'Set up offline pay first');
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
    } catch (e: unknown) { finalize('error', e instanceof Error ? e.message : String(e)); }
  }, [identity, nonceState, finalize]);

  // Merchant side: decode the payer's solpay:, broadcast online, confirm — then hand the outcome +
  // the advanced nonce back to the payer over the same tap.
  const submitPayment = useCallback(async (solpayUri: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SOL_SEND_TIMEOUT_MS * 2);
    try {
      const solpay = decodeSolPay(solpayUri);
      const {decimals, unit} = solUnit(solpay.cur);
      setAmtText(fmtAsset(solpay.amt, decimals, unit));
      const receipt = await broadcastSolPayment(solpay, ctrl.signal);
      if (receipt.status === RECEIPT_SETTLED) {
        try { await DpaySolNfc.confirmSolReceipt(RECEIPT_SETTLED, receipt.nextNonce ?? '', receipt.sig ?? '', solpay.npub); } catch {}
        finalize('success');
      } else if (receipt.status === RECEIPT_REJECTED) {
        try { await DpaySolNfc.confirmSolReceipt(RECEIPT_REJECTED, '', '', solpay.npub); } catch {}
        finalize('declined', 'Payment rejected');
      } else {
        try { await DpaySolNfc.confirmSolReceipt(RECEIPT_UNREACHABLE, '', '', solpay.npub); } catch {}
        finalize('pending', 'Couldn’t confirm');
      }
    } catch (e: unknown) {
      // A network/RPC throw is genuinely unknown — hand UNREACHABLE so the payer falls back to
      // "couldn't confirm" honestly (never a false decline).
      try { await DpaySolNfc.confirmSolReceipt(RECEIPT_UNREACHABLE, '', '', npubRef.current); } catch {}
      finalize('pending', e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }, [finalize]);

  useEffect(() => {
    // Re-set on every effect re-run: SolPayMode passes inline onPaid/onStale (not useCallback), so a
    // parent re-render (e.g. a fast-poll balance refresh) recreates them → this effect re-runs → the
    // cleanup below sets aliveRef.current=false. Without resetting it here, finalize would be
    // permanently blocked after the first parent re-render (the !aliveRef guard).
    aliveRef.current = true;
    const emitter = new NativeEventEmitter(DpaySolNfc as any);
    const sub = emitter.addListener('DpaySolNfcEvent', (e: SolNfcEvent) => {
      if (e.role !== role) return;
      if (e.type === 'error') {
        markActive();
        // Once the payer's solpay has left the phone, a transport error says nothing about whether
        // the merchant settled — the outcome is owned by submitPayment / the receipt path.
        if (finalized.current || committed.current) return;
        finalize('error', e.reason);
        return;
      }
      if (finalized.current) return; // terminal reached; ignore late phase/confirmed events
      if (e.type === 'request') {
        markActive();
        setPhase('exchanging');
        autoSign(e.solreqUri);
      } else if (e.type === 'payment') {
        markActive();
        committed.current = true;
        submitPayment(e.solpayUri);
      } else if (e.type === 'receipt') {
        // The payer's outcome, learned offline over the tap — believed only if it answers the exact
        // payment we signed (npub match, base58 case-sensitive).
        const outcome = decideSolPayerReceipt(
          {status: e.status, npub: e.npub, nextNonce: e.nextNonce, sig: e.sig},
          npubRef.current,
        );
        if (outcome.outcome === 'ignore') return; // a receipt for a different nonce account
        if (outcome.outcome === 'success') {
          if (outcome.adoptNonce) onPaid?.(outcome.adoptNonce);
          finalize('success');
        } else if (outcome.outcome === 'declined') {
          onStale?.();
          finalize('declined', 'Payment rejected');
        } else {
          finalize('pending', 'Couldn’t confirm');
        }
      } else if (e.type === 'phase') {
        if (e.phase !== 'listening') markActive();
        // The payer's solpay has left the phone: the outcome depends on the receipt. Arm a timeout so
        // we never spin on "Confirming…" forever if the receipt never arrives.
        if (role === 'card' && e.phase === 'settling') {
          committed.current = true;
          if (!settleTimer.current) {
            settleTimer.current = setTimeout(() => {
              finalize('pending', 'Couldn’t confirm — check your balance when back online');
            }, RECEIPT_WAIT_MS);
          }
        }
        setPhase(e.phase);
      }
      // 'confirmed' (reader): the receipt reached the payer; the merchant already finalized on submit.
    });
    if (role === 'card') DpaySolNfc.armCard().catch((e: unknown) => finalize('error', e instanceof Error ? e.message : String(e)));
    else if (solreqUri) DpaySolNfc.startSolReader(solreqUri).catch((e: unknown) => finalize('error', e instanceof Error ? e.message : String(e)));
    return () => {
      aliveRef.current = false;
      clearSettleTimer();
      sub.remove();
      if (role === 'card') DpaySolNfc.disarmCard().catch(() => {});
      else DpaySolNfc.stopSolReader().catch(() => {});
    };
  }, [role, solreqUri, autoSign, submitPayment, finalize, markActive, clearSettleTimer, onPaid, onStale]);

  // While merely armed/listening (no tap yet) render nothing, so the parent's QR shows and the phone
  // can be tapped OR scanned with no mode switch.
  if (phase === 'listening' && !activeRef.current) return null;

  const m = SOL_NFC_UI[phase] ?? SOL_NFC_UI.listening;
  const terminal = phase === 'success' || phase === 'declined' || phase === 'error' || phase === 'pending';
  const active = phase === 'exchanging' || phase === 'settling' || phase === 'awaitingApproval';
  const title = phase === 'success'
    ? `${role === 'card' ? 'Paid' : 'Received'} ✓ ${amtText ?? ''}`.trim()
    : m.title;
  const sub = (phase === 'error' || phase === 'declined' || phase === 'pending') && reason ? reason
    : phase === 'success' ? 'The payment settled'
    : active && amtText != null
      ? `${role === 'card' ? 'Paying' : 'Collecting'} ${amtText}`
    : m.sub;
  return (
    <View style={S.center} testID="sol-nfc-status">
      <View style={[S.nfcBadge, {borderColor: m.tone}]}>
        {m.icon === 'nfc' ? <NfcIcon color={m.tone} size={64} /> : m.spin ? <ActivityIndicator size="large" color={m.tone} /> : <Text style={[S.nfcGlyph, {color: m.tone}]}>{m.glyph}</Text>}
      </View>
      <Text style={S.nfcTitle}>{title}</Text>
      {sub ? <Text style={S.nfcSub}>{sub}</Text> : null}
      <Pressable style={S.linkBtn} accessibilityRole="button" accessibilityLabel={terminal ? 'Done' : 'Cancel'} accessibilityState={{disabled: false}} onPress={onClose}><Text style={S.linkText}>{terminal ? 'Done' : 'Cancel'}</Text></Pressable>
    </View>
  );
}
