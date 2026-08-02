import {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, Pressable, ActivityIndicator, NativeEventEmitter} from 'react-native';
import {C} from '../config/palette';
import {
  NFC_PAY_TIMEOUT_MS, RECONCILE_ATTEMPTS, RECONCILE_INTERVAL_MS, RECEIPT_WAIT_MS,
} from '../config/constants';
import {S} from '../styles';
import {usd, short, base} from '../lib/format';
import type {NfcEvent, NfcPhaseName, Identity} from '../lib/types';
import {
  classifyPayHttp, receiptCodeFor, decidePayerReceipt, rejectionMessage, isNonceReused,
  type SettleOutcome,
} from '../payments';
import {verifyOutcomeReceipt} from '../services/receipt';
import {DpayCore, DpayNfc} from '../services/native';
import {NfcIcon} from './NfcIcon';

// Phase → status-view presentation (mirrors ui/src/NfcSession.jsx). `spin` renders a spinner; `icon`
// renders the NFC contactless mark (the listening/"armed" state) in place of a text glyph.
const NFC_UI: Record<string, {tone: string; glyph?: string; spin?: boolean; icon?: 'nfc'; title: string; sub: string}> = {
  listening: {tone: C.brand, icon: 'nfc', title: 'Hold near the other phone', sub: 'dpay is listening for a tap'},
  linking: {tone: C.brand, spin: true, title: 'Connecting…', sub: 'Linking the two phones'},
  exchanging: {tone: C.brand, spin: true, title: 'Communicating…', sub: 'Keep the phones together'},
  awaitingApproval: {tone: C.brand, spin: true, title: 'Authorizing…', sub: 'Signing on the payer’s phone'},
  settling: {tone: C.brand, spin: true, title: 'Confirming…', sub: 'Keep the phones together while the merchant settles'},
  success: {tone: C.ok, glyph: '✓', title: 'Done ✓', sub: ''},
  declined: {tone: C.sub, glyph: '✕', title: 'Declined', sub: 'The payment was declined'},
  // Genuinely-unknown outcome (couldn't reach the ledger / no receipt in time). Truthful, distinct
  // from both success and failure — the balance reconciles when back online.
  pending: {tone: C.warn, glyph: '?', title: 'Not confirmed', sub: 'Couldn’t reach the ledger'},
  error: {tone: C.bad, glyph: '!', title: 'Tap failed', sub: 'Move the phones together and try again'},
};

/**
 * Drives one NFC tap through the native glue (DpayNfc): Pay mode arms the HCE card (payer is tapped),
 * Receive mode runs the reader (merchant reads the tap). The **tap itself is the consent** — when a
 * request arrives the payer's phone signs and serves it immediately (contactless tap-to-pay, no
 * extra Approve button). It renders the live phase the core emits and, on the merchant side, submits
 * the reassembled wire and hands the receipt back. The radio hop is a physical-device gate.
 */
export function NfcTap({role, identity, relayUrl, requestHex, reqInfo, onSettled, onOfflinePaid, onActive, onClose}: {
  role: 'card' | 'reader';
  identity: Identity;
  relayUrl: string;
  requestHex?: string;
  reqInfo?: {amount: string; nonce: string; who: string};
  onSettled?: () => void;
  onOfflinePaid?: (amount: string, currency: number) => void;
  onActive?: () => void; // fired the moment a real tap starts (so the parent can hide the QR/scanner)
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<NfcPhaseName | 'error'>('listening');
  const [reason, setReason] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState<string | null>(null);
  const sentRef = useRef<{amount: string; currency: number; who: string; nonce: string} | null>(null);
  const finalized = useRef(false);
  const recordedRef = useRef(false);
  const activeRef = useRef(false);
  // Set once the authorization is in flight to settlement (merchant: the wire is submitting; payer:
  // the wire has left the phone). After this point the ledger outcome is decided elsewhere (the
  // /pay result, or the receipt / its timeout), so a *transport* error — e.g. the phones parting
  // during the receipt hand-back — must NOT be shown as a payment failure. This is the guard that
  // stops a settled payment from being reported as "Tap failed".
  const committed = useRef(false);
  // True once we've optimistically deducted the payment from the local balance (when the wire
  // leaves the phone). Prevents double-deduction if the receipt later arrives with success, and
  // enables undo if the receipt says declined.
  const deductedRef = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // False once the tap view is torn down (user hit Cancel/Done). An in-flight submit/sign promise
  // that resolves after that must not touch state — it would warn and, worse, could flip a screen
  // the user already left.
  const aliveRef = useRef(true);
  // Keep onActive in a ref so markActive has a stable identity (the effect must not re-subscribe /
  // re-arm on every parent render just because an inline callback changed).
  const onActiveRef = useRef(onActive);
  onActiveRef.current = onActive;
  const markActive = useCallback(() => {
    if (!activeRef.current) { activeRef.current = true; onActiveRef.current?.(); }
  }, []);

  const clearSettleTimer = useCallback(() => {
    if (settleTimer.current) { clearTimeout(settleTimer.current); settleTimer.current = null; }
  }, []);

  const finalize = useCallback((p: NfcPhaseName | 'error', r?: string) => {
    if (finalized.current || !aliveRef.current) return; // first terminal wins; ignore after teardown
    finalized.current = true;
    clearSettleTimer();
    setReason(r ?? null);
    setPhase(p);
  }, [clearSettleTimer]);

  const record = useCallback(() => {
    if (recordedRef.current || !onSettled) return;
    recordedRef.current = true;
    onSettled();
  }, [onSettled]);

  // POST /pay once, bounded by a timeout. Returns the (ok,status) + parsed body, or a null result
  // when fetch threw (network/timeout/abort) — which the caller treats as UNKNOWN, not failure.
  const postPay = useCallback(async (code: string) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), NFC_PAY_TIMEOUT_MS);
    try {
      const r = await fetch(`${base(relayUrl)}/api/v1/pay`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({qr: code}), signal: ctrl.signal});
      const body = await r.json().catch(() => ({} as any));
      return {res: {ok: r.ok, status: r.status}, body};
    } catch {
      return {res: null as {ok: boolean; status: number} | null, body: {} as any};
    } finally { clearTimeout(t); }
  }, [relayUrl]);

  // Reconcile an ambiguous outcome via the idempotent GET /receipt/:nonce. Returns the settled
  // receipt (or null if not settled after a few polls). Safe by construction: the nonce is
  // single-use, so this can never cause a second charge — it only *reads* whether it landed.
  const reconcile = useCallback(async (nonceHex: string) => {
    for (let i = 0; i < RECONCILE_ATTEMPTS; i++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      try {
        const r = await fetch(`${base(relayUrl)}/api/v1/receipt/${nonceHex}`, {signal: ctrl.signal});
        if (r.ok) { const j = await r.json().catch(() => ({} as any)); clearTimeout(t); return j.receipt ?? {}; }
      } catch { /* keep polling */ } finally { clearTimeout(t); }
      await new Promise(res => setTimeout(res, RECONCILE_INTERVAL_MS));
    }
    return null;
  }, [relayUrl]);

  // Verify a settled receipt's canister/ledger signature (R2) before trusting the outcome — see the
  // module-level `verifyOutcomeReceipt`. The nonce match is enforced upstream (settledNonceHex).
  // Merchant side: submit the reassembled wire, decide the authoritative outcome, then hand it back
  // to the payer over the same tap. The ledger is the source of truth; an ambiguous transport/HTTP
  // result is reconciled by nonce before we ever call a payment failed.
  const submitWire = useCallback(async (wireHex: string) => {
    const nonceHex = reqInfo?.nonce ?? null;
    const code = await DpayCore.encodeQr(wireHex).catch(() => null);
    if (!code) { finalize('error', 'Could not encode the authorization'); return; } // pre-settlement

    const {res, body} = await postPay(code);
    let outcome: SettleOutcome = classifyPayHttp(res);
    let settledNonceHex: string | null = nonceHex;
    // The receipt object backing a 'settled' outcome (from the /pay body or the /receipt reconcile).
    // R2: we verify its canister/ledger signature before finalizing success.
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
        // R2: trust the outcome only if the receipt's signature verifies under the canister/ledger
        // pubkey. A merchant/relay cannot forge this; an unverifiable receipt is treated as unknown
        // (pending), never a fake success.
        //
        // MC4 U5: the full-auth binding (the `auth` arg to verifyOutcomeReceipt) is intentionally
        // NOT passed here. This is the MERCHANT (reader) path; the merchant forwards the payer's
        // opaque signed wire but never decodes the payer's `from` pubkey, so it cannot supply the
        // full 5-field authorization. The merchant's defenses are the key-pin + signature + the
        // nonce match enforced via `settledNonceHex` above (the nonce is single-use → a receipt for
        // a different payment is already rejected there). The PAYER-side binding (PayMode) carries
        // the complete authorization.
        const verified = settledReceipt ? await verifyOutcomeReceipt(settledReceipt) : false;
        if (verified) {
          record();
          finalize('success');
        } else {
          finalize('pending', 'Couldn’t verify the payment — check the balance');
        }
      } else if (outcome === 'rejected') {
      finalize('declined', rejectionMessage(typeof body?.error === 'string' ? body.error : null));
    } else {
      // Genuinely unknown even after reconciliation — truthful, never a fake success or failure.
      finalize('pending', 'Couldn’t confirm with the ledger — check the balance');
    }
    // Best-effort: hand the outcome back to the payer, stamped with the authoritative nonce.
    try { await DpayNfc.confirmReceipt(receiptCodeFor(outcome), settledNonceHex ?? nonceHex ?? ''); } catch {}
  }, [reqInfo, record, finalize, postPay, reconcile]); // relayUrl is captured transitively via postPay/reconcile (both depend on it)

  // Payer side: the tap is the consent — sign the incoming request and serve it right away.
  const autoSign = useCallback(async (req: {toHex: string; amount: string; nonceHex: string; expiry: number; currency: number}) => {
    try {
      const wireHex = await DpayCore.signAuthorization(identity.secretHex, req.toHex, req.amount, req.nonceHex, req.expiry, req.currency, identity.username, '', '');
      if (!(await DpayCore.verifyWire(wireHex))) throw new Error('local verify failed');
      sentRef.current = {amount: req.amount, currency: req.currency, who: short(req.toHex), nonce: req.nonceHex};
      setPayAmount(req.amount);
      await DpayNfc.approveCard(wireHex);
    } catch (e: any) { finalize('error', String(e?.message ?? e)); }
  }, [identity, finalize]);

  useEffect(() => {
    const emitter = new NativeEventEmitter(DpayNfc as any);
    const sub = emitter.addListener('DpayNfcEvent', (e: NfcEvent) => {
      if (e.role !== role) return;
      if (e.type === 'error') {
        markActive();
        // Once the payment is in flight to settlement, a transport error says nothing about whether
        // the ledger settled — the outcome is owned by submitWire / the receipt path. Don't let it
        // overwrite a decided (or about-to-be-decided) outcome with a false failure.
        if (finalized.current || committed.current) return;
        finalize('error', e.reason);
        return;
      }
      if (finalized.current) return; // terminal reached; ignore late phase/confirmed events
      if (e.type === 'request') { markActive(); setPhase('exchanging'); autoSign({toHex: e.toHex, amount: e.amount, nonceHex: e.nonceHex, expiry: e.expiry, currency: e.currency}); }
      else if (e.type === 'done') { markActive(); committed.current = true; submitWire(e.wireHex); }
      else if (e.type === 'receipt') {
        // The payer's outcome, learned offline over the tap — believed only if it answers the exact
        // payment we signed (nonce match). UNREACHABLE ⇒ pending (unknown), never a false decline.
        const outcome = decidePayerReceipt({status: e.status, nonceHex: e.nonceHex}, sentRef.current?.nonce ?? '');
        if (outcome === 'ignore') return; // a receipt for some other payment — keep waiting
        if (outcome === 'success') {
          // Balance was already deducted when the wire left the phone — just record the txn.
          record();
          finalize('success');
        } else if (outcome === 'declined') {
          // The ledger refused — undo the optimistic deduction so the local balance is whole again.
          // MC1 units 2-4: amount is a decimal STRING; negate via BigInt (the Wallet reducer sums as
          // BigInt, so a negative raw-string is the exact undo — never `−string` which is NaN).
          // MC5: pass the signed request's currency so the undo lands on the SAME asset's entry.
          if (deductedRef.current && sentRef.current) { onOfflinePaid?.(`-${sentRef.current.amount}`, sentRef.current.currency); }
          finalize('declined', 'The ledger declined the payment');
        } else {
          finalize('pending', 'Couldn’t confirm — check your balance when back online');
        }
      } else if (e.type === 'phase') {
        if (e.phase !== 'listening') markActive();
        // The payer's wire has left the phone: from here the outcome depends on the receipt. Arm a
        // timeout so we never spin on "Confirming…" forever if the receipt never arrives.
        if (role === 'card' && e.phase === 'settling') {
          committed.current = true;
          // The wire has left the phone — optimistically deduct from the local balance. The real
          // balance reconciles on the next online poll; if the receipt says declined we undo below.
          // MC5: the deduction is KEYED BY the request's currency — a ckBTC tap debits ckBTC, NOT
          // the DEMO ∂ counter (per-currency offline deduction).
          if (!deductedRef.current && sentRef.current) {
            deductedRef.current = true;
            onOfflinePaid?.(sentRef.current.amount, sentRef.current.currency);
          }
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
    if (role === 'card') DpayNfc.armCard().catch((e: any) => finalize('error', String(e?.message ?? e)));
    else if (requestHex) DpayNfc.startReader(requestHex).catch((e: any) => finalize('error', String(e?.message ?? e)));
    return () => {
      aliveRef.current = false;
      clearSettleTimer();
      sub.remove();
      if (role === 'card') DpayNfc.disarmCard().catch(() => {});
      else DpayNfc.stopReader().catch(() => {});
    };
  }, [role, requestHex, submitWire, autoSign, finalize, markActive, clearSettleTimer, onOfflinePaid, record]);

  // While merely armed/listening (no tap yet) render nothing, so the parent's QR/scanner shows and
  // the phone can be tapped OR scanned with no mode switch.
  if (phase === 'listening' && !activeRef.current) return null;

  const m = NFC_UI[phase] ?? NFC_UI.listening;
  const terminal = phase === 'success' || phase === 'declined' || phase === 'error' || phase === 'pending';
  const amt = role === 'card' ? payAmount : reqInfo?.amount;
  const active = phase === 'exchanging' || phase === 'settling' || phase === 'awaitingApproval';
  const title = phase === 'success'
    ? `${role === 'card' ? 'Paid' : 'Received'} ✓ ${amt != null ? usd(amt) : ''}`.trim()
    : m.title;
  const sub = (phase === 'error' || phase === 'declined' || phase === 'pending') && reason ? reason
    : phase === 'success' ? 'The payment settled'
    : active && amt != null ? `${role === 'card' ? 'Paying' : 'Collecting'} ${usd(amt)}`
    : m.sub;
  return (
    <View style={S.center} testID="nfc-status">
      <View style={[S.nfcBadge, {borderColor: m.tone}]}>
        {m.icon === 'nfc' ? <NfcIcon color={m.tone} size={64} /> : m.spin ? <ActivityIndicator size="large" color={m.tone} /> : <Text style={[S.nfcGlyph, {color: m.tone}]}>{m.glyph}</Text>}
      </View>
      <Text style={S.nfcTitle}>{title}</Text>
      {sub ? <Text style={S.nfcSub}>{sub}</Text> : null}
      <Pressable style={S.linkBtn} accessibilityRole="button" accessibilityLabel={terminal ? 'Done' : 'Cancel'} accessibilityState={{disabled: false}} onPress={onClose}><Text style={S.linkText}>{terminal ? 'Done' : 'Cancel'}</Text></Pressable>
    </View>
  );
}
