import {useEffect, useState} from 'react';
import {View, Text, Pressable, Share, Modal} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {S} from '../styles';
import {C} from '../config/palette';
import {EXPIRY_WINDOW, DIRECT_PAY_TIMEOUT_MS, NFC_PAY_TIMEOUT_MS, POLL} from '../config/constants';
import {usd, short, base, parseRequestQR, randNonceHex, nowSecs} from '../lib/format';
import {type CurrencyDescriptor, fmtCurrencyAmount} from '../config/catalog';
import type {Identity, Req, NfcStatus} from '../lib/types';
import {classifyPayHttp, rejectionMessage, isNonceReused} from '../payments';
import {verifyOutcomeReceipt} from '../services/receipt';
import {DpayCore, DpayNfc} from '../services/native';
import {NfcTap} from './NfcTap';
import {NfcIcon} from './NfcIcon';
import {QrScanner} from './QrScanner';
import {useEscapeToClose} from '../hooks/useHotkeys';

// Plain-language per-reason text for the NFC-unavailable info popup. Each ends with the honest
// fallback that QR always works, so the payer is never stuck.
const NFC_REASON: Record<Exclude<NfcStatus, 'ready'>, string> = {
  off: 'NFC is turned off in your device settings. Turn NFC on to pay by tap — or scan the QR code to pay now.',
  unsupported: "This device doesn't have NFC hardware. Scan the QR code to pay.",
  unknown: "Couldn't check NFC status. Scan the QR code to pay.",
};

export function PayMode({identity, online, relayUrl, nfcStatus, onSettled, onOfflinePaid, shownBalance, catalog, assetBalances}: {identity: Identity; online: boolean; relayUrl: string; nfcStatus: NfcStatus; onSettled: () => void; onOfflinePaid: (amount: number) => void; shownBalance: number | null; catalog: CurrencyDescriptor[]; assetBalances: Record<number, number>}) {
  const [phase, setPhase] = useState<'scan' | 'review' | 'qr' | 'paid'>('scan');
  const [req, setReq] = useState<Req | null>(null);
  const [qr, setQr] = useState<{code: string; amount: number; currency: number; who: string; nonce: string} | null>(null);
  // `pending` = handed to the merchant offline but NOT confirmed by the ledger (we can't claim it
  // settled). `already` = the ledger reported this nonce was already settled (idempotent replay).
  const [paid, setPaid] = useState<{amount: number; currency: number; who: string; already: boolean; pending?: boolean} | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A tap arriving on the always-armed card takes over the scan screen; nfcKey re-arms after each.
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);
  // NFC is usable only when the adapter probe reports 'ready' (on + present). Everything else falls
  // through to the QR-only scan surface, with a per-reason explanation in the info popup below.
  const nfcReady = nfcStatus === 'ready';
  const [nfcInfoOpen, setNfcInfoOpen] = useState(false);
  useEscapeToClose(() => setNfcInfoOpen(false));

  async function onRequestString(raw: string) {
    try {
      // The request QR is plain base64url now (the payee's `to_name` + `memo` live inside the 132-byte
      // request — wire-format v2; the `|name` suffix is gone). parseRequestQR trims + strips a stray
      // suffix defensively; decodeRequest extracts to_name + memo from the bytes.
      const reqB64 = parseRequestQR(raw);
      const r = await DpayCore.decodeRequest(reqB64);
      setReq(r); setErr(null); setPhase('review');
    } catch (e: any) { setErr(`bad request QR: ${String(e?.message ?? e)}`); }
  }

  // Confirm an offline (QR-dance) settlement via the ledger, so it lands in Recent once, when settled.
  useEffect(() => {
    if (phase !== 'qr' || !qr) return;
     let alive = true;
    const check = async () => {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch(`${base(relayUrl)}/api/v1/receipt/${qr.nonce}`, {signal: ctrl.signal});
        // R2: only believe the reconciled receipt if its canister/ledger signature verifies.
        if (alive && r.ok) {
          const j = await r.json().catch(() => ({} as any));
          if (await verifyOutcomeReceipt(j.receipt)) {
            onSettled(); setPaid({amount: qr.amount, currency: qr.currency, who: qr.who, already: false}); setPhase('paid');
          }
        }
      } catch {} finally { clearTimeout(t); }
    };
    check(); const id = setInterval(check, POLL.receiptPay);
    return () => { alive = false; clearInterval(id); };
  }, [phase, qr, relayUrl, onSettled]);

  async function approve() {
    if (!req) return;
    setBusy(true);
    try {
      // The payer's own username rides as `from_name`; `to_name` + `memo` are copied verbatim from
      // the scanned merchant request (so the signature binds exactly what was requested). The payee
      // name no longer comes from a `|name` QR suffix — it's in the bytes (single source of truth).
      const wireHex = await DpayCore.signAuthorization(identity.secretHex, req.toHex, req.amount, req.nonceHex, req.expiry, req.currency, identity.username, req.toName, req.memo);
      if (!(await DpayCore.verifyWire(wireHex))) throw new Error('local verify failed');
      const code = await DpayCore.encodeQr(wireHex);
      const who = req.toName || short(req.toHex);
      const nonce = req.nonceHex;
      if (online) {
        const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), DIRECT_PAY_TIMEOUT_MS);
        let res: {ok: boolean; status: number} | null = null;
        let j: any = {};
        try {
          const r = await fetch(`${base(relayUrl)}/api/v1/pay`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({qr: code}), signal: ctrl.signal});
          res = {ok: r.ok, status: r.status};
          j = await r.json().catch(() => ({} as any));
        } catch { res = null; /* network/timeout → unknown, fall back to the QR hand-off below */ } finally { clearTimeout(timer); }
        const outcome = classifyPayHttp(res);
        if (outcome === 'settled') {
          // R2: trust the outcome only if the receipt's canister/ledger signature verifies. A
          // replay (replayed:true) returns the SAME cached receipt, which verifies identically.
          const verified = await verifyOutcomeReceipt(j.receipt);
          if (verified) {
            if (!j.replayed) onSettled();
            setPaid({amount: req.amount, currency: req.currency, who, already: !!j.replayed}); setPhase('paid'); return;
          }
          // Settled at the HTTP layer but the receipt did not verify — honest, never a fake Paid.
          setErr('Couldn’t verify the payment — check the balance'); return;
        }
        if (outcome === 'rejected') {
          // A definitive refusal: show WHY (e.g. "Not enough balance") rather than silently
          // dropping to the QR screen, which reads as if the payment is fine. NonceReused is the
          // exception — it means this exact payment already settled.
          if (isNonceReused(j?.error)) { setPaid({amount: req.amount, currency: req.currency, who, already: true}); setPhase('paid'); return; }
          setErr(rejectionMessage(typeof j?.error === 'string' ? j.error : null)); return;
        }
        // outcome === 'unknown': couldn't reach the ledger cleanly. Fall through to the offline QR
        // hand-off (the merchant can still scan it) — the /receipt poll reconciles if it settles.
      }
      setQr({code, amount: req.amount, currency: req.currency, who, nonce});
      setPhase('qr');
    } catch (e: any) { setErr(String(e?.message ?? e)); } finally { setBusy(false); }
  }

  function reset() { setReq(null); setQr(null); setPaid(null); setErr(null); setPhase('scan'); }

  if (phase === 'paid' && paid) {
    const warn = paid.already || paid.pending;
    const glyph = paid.pending ? '⋯' : paid.already ? '↩' : '✓';
    const amt = fmtCurrencyAmount(catalog, paid.currency, paid.amount);
    const headline = paid.pending ? `Sent ${amt}` : paid.already ? 'Already paid' : `Paid ✓ ${amt}`;
    const sub = paid.pending ? `to ${paid.who} · awaiting the merchant’s confirmation`
      : paid.already ? `${amt} to ${paid.who} · not charged again`
      : `to ${paid.who}`;
    return (
      <View style={S.center}>
        <View style={[S.check, warn && S.checkAlready]}><Text style={S.checkMark}>{glyph}</Text></View>
        <Text style={[S.paidText, warn && S.alreadyText]}>{headline}</Text>
        <Text style={S.paidSub}>{sub}</Text>
        <Pressable testID="btn-new" style={S.linkBtn} onPress={reset} accessibilityRole="button" accessibilityLabel="New payment" accessibilityState={{disabled: false}}><Text style={S.linkText}>New payment</Text></Pressable>
      </View>
    );
  }

  if (phase === 'qr' && qr) {
    return (
      <View style={S.center}>
        <Text style={S.label}>Show this to {qr.who}</Text>
        <View style={S.qrCard}><QRCode value={qr.code} size={244} ecl="L" /></View>
        <Text style={S.amountBig}>{`${fmtCurrencyAmount(catalog, qr.currency, qr.amount)} to ${qr.who}`}</Text>
        <Text style={S.badgeOk}>signed on this device ✓</Text>
        {online ? <Text style={S.qrHint}>Waiting for {qr.who} to scan…</Text> : (
          <>
            <Text style={S.qrHint}>Offline — {qr.who} settles this when they submit it. You’ll see it on your balance once you’re back online.</Text>
            <View style={S.confirmRow}>
              {/* Offline we CANNOT know the ledger settled it, so this is an honest "handed off",
                  not "Paid ✓". It optimistically reduces the local balance; the real balance
                  reconciles on the next online poll. It does NOT fabricate a settled history entry. */}
              <Pressable testID="btn-paid" style={S.paidBtn} onPress={() => { onOfflinePaid(qr.amount); setPaid({amount: qr.amount, currency: qr.currency, who: qr.who, already: false, pending: true}); setPhase('paid'); }} accessibilityRole="button" accessibilityLabel={`Handed to ${qr.who}`} accessibilityState={{disabled: false}}><Text style={S.paidBtnText}>Handed to {qr.who}</Text></Pressable>
              <Pressable testID="btn-notpaid" style={S.notPaidBtn} onPress={reset} accessibilityRole="button" accessibilityLabel="Cancel" accessibilityState={{disabled: false}}><Text style={S.notPaidText}>Cancel</Text></Pressable>
            </View>
          </>
        )}
        <Pressable style={S.linkBtn} onPress={() => Share.share({message: qr.code})} accessibilityRole="button" accessibilityLabel="Share auth code" accessibilityState={{disabled: false}}><Text style={S.linkText}>Share auth code</Text></Pressable>
      </View>
    );
  }

  if (phase === 'review' && req) {
    // MC5: locked-asset review — the payer sees + pays the EXACT asset the merchant requested (dpay
    // never swaps). The balance check uses ONLY that asset's balance: currency 0 → shownBalance
    // (DEMO_USD, tracked in the header), else assetBalances[req.currency] (the polled per-asset
    // balance). An unknown balance (null) is treated as "don't block" (same as the old DEMO path).
    const reqBalance = req.currency === 0 ? shownBalance : (assetBalances[req.currency] ?? null);
    // C2: when ONLINE and the known balance can't cover the amount, gate PRE-SUBMIT (no doomed
    // /pay). Offline we can't be sure (the local balance may be stale), so we only WARN there and
    // let the merchant's online verify be the real gate.
    const insufficient = reqBalance != null && req.amount > reqBalance;
    const blockApprove = online && insufficient;
    // C1: any shown error (expired / insufficient relay-reject / verify-fail) also disables the
    // button so a doomed payment can't be re-tapped.
    const approveDisabled = busy || !!err || blockApprove;
    return (
      <View style={S.center}>
        <Text style={S.label}>Review payment</Text>
        <Text testID="pay-amount" style={S.reviewAmount}>{`Pay ${fmtCurrencyAmount(catalog, req.currency, req.amount)}`}</Text>
        <Text style={S.reviewTo}>{`to ${req.toName || short(req.toHex)}`}</Text>
        {/* The merchant-set memo (if any) — shown as a small subtitle so the payer sees the note
            attached to this request before approving. Empty memo renders nothing. */}
        {req.memo ? <Text testID="review-memo" style={S.dim2}>{req.memo}</Text> : null}
        {/* C1/C2 + L5: the warning + any error render ABOVE the button (not below) so they're seen
            first; the raw request nonce is no longer surfaced (internal protocol data). */}
        {insufficient ? (
          <Text testID="review-lowbal" style={S.warnNote}>{blockApprove
            ? 'Not enough balance to cover this payment.'
            : 'Your local balance may not cover this — the merchant will verify.'}</Text>
        ) : null}
        {err ? <Text testID="review-err" style={S.err}>{err}</Text> : null}
        <Pressable
          testID="btn-approve"
          style={[S.primary, approveDisabled && S.dim]}
          disabled={approveDisabled}
          accessibilityRole="button"
          accessibilityLabel="Approve payment"
          accessibilityState={{disabled: approveDisabled}}
          onPress={approve}>
          <Text style={S.primaryText}>{busy ? 'Signing…' : 'Approve'}</Text>
        </Pressable>
        <Pressable style={S.linkBtn} onPress={reset} accessibilityRole="button" accessibilityLabel="Cancel" accessibilityState={{disabled: false}}><Text style={S.linkTextMuted}>Cancel</Text></Pressable>
      </View>
    );
  }

  // Scan screen: the card is armed in the background (if NFC is ready) AND the QR scanner is live at
  // the same time — the payer taps the merchant's phone OR scans its QR, with no button in between.
  // A leading NFC status row tells the payer whether tap-to-pay is available; QR always works.
  const nfcInfo: Exclude<NfcStatus, 'ready'> = (nfcStatus === 'ready' ? 'unknown' : nfcStatus);
  return (
    <View style={S.center}>
      {nfcReady && DpayNfc ? (
        <NfcTap
          key={nfcKey} role="card" identity={identity} relayUrl={relayUrl}
          onSettled={onSettled} onOfflinePaid={onOfflinePaid}
          onActive={() => setNfcActive(true)}
          onClose={() => { setNfcActive(false); setNfcKey(k => k + 1); }}
        />
      ) : null}
      {!nfcActive ? (
        <>
          {nfcReady ? (
            <View style={S.nfcStatusRow} testID="pay-scan">
              <NfcIcon color={C.brand} />
              <Text style={S.nfcStatusLabel}>Tap or scan to pay</Text>
            </View>
          ) : (
            <View style={S.nfcStatusRow} testID="pay-scan">
              <NfcIcon color={C.bad} />
              <Pressable style={S.nfcInfoLink} onPress={() => setNfcInfoOpen(true)} accessibilityRole="button" accessibilityLabel="Why NFC is unavailable" accessibilityState={{disabled: false}}>
                <Text style={S.nfcInfoLinkText}>NFC not available</Text>
                <Text style={S.nfcInfoGlyph}>ⓘ</Text>
              </Pressable>
            </View>
          )}
          {!nfcReady ? <Text style={S.dim2}>Scan the QR code to pay.</Text> : null}
          <QrScanner onScan={onRequestString} />
          {err ? <Text style={S.err}>{err}</Text> : null}
        </>
      ) : null}
      <Modal visible={nfcInfoOpen} transparent animationType="fade" onRequestClose={() => setNfcInfoOpen(false)}>
        <Pressable style={S.pickBackdrop} onPress={() => setNfcInfoOpen(false)}>
          <View style={S.pickCard} onStartShouldSetResponder={() => true}>
            <Text style={S.pickTitle}>NFC unavailable</Text>
            <Text style={S.nfcInfoBody}>{NFC_REASON[nfcInfo]}</Text>
            <Pressable style={S.nfcInfoClose} onPress={() => setNfcInfoOpen(false)} accessibilityRole="button" accessibilityLabel="Close" accessibilityState={{disabled: false}}>
              <Text style={S.nfcInfoCloseText}>Close</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}
