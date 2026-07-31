import {useEffect, useState} from 'react';
import {View, Text, Pressable, Share} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {C} from '../config/palette';
import {S} from '../styles';
import {EXPIRY_WINDOW, DIRECT_PAY_TIMEOUT_MS, NFC_PAY_TIMEOUT_MS, POLL} from '../config/constants';
import {usd, short, base, parseRequestQR, toCents, randNonceHex, nowSecs} from '../lib/format';
import type {Identity, Req} from '../lib/types';
import {classifyPayHttp, rejectionMessage, isNonceReused} from '../payments';
import {verifyOutcomeReceipt} from '../services/receipt';
import {DpayCore, DpayNfc} from '../services/native';
import {readFromClipboard} from '../hooks/clipboard';
import {NfcTap} from './NfcTap';
import {QrScanner} from './QrScanner';

export function PayMode({identity, online, relayUrl, nfcReady, onSettled, onOfflinePaid, shownBalance}: {identity: Identity; online: boolean; relayUrl: string; nfcReady: boolean; onSettled: () => void; onOfflinePaid: (amount: number) => void; shownBalance: number | null}) {
  const [phase, setPhase] = useState<'scan' | 'review' | 'qr' | 'paid'>('scan');
  const [req, setReq] = useState<(Req & {name: string}) | null>(null);
  const [qr, setQr] = useState<{code: string; amount: number; who: string; nonce: string} | null>(null);
  // `pending` = handed to the merchant offline but NOT confirmed by the ledger (we can't claim it
  // settled). `already` = the ledger reported this nonce was already settled (idempotent replay).
  const [paid, setPaid] = useState<{amount: number; who: string; already: boolean; pending?: boolean} | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A tap arriving on the always-armed card takes over the scan screen; nfcKey re-arms after each.
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);

  async function onRequestString(raw: string) {
    try {
      const {reqB64, name} = parseRequestQR(raw);
      const r = await DpayCore.decodeRequest(reqB64);
      setReq({...r, name}); setErr(null); setPhase('review');
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
            onSettled(); setPaid({amount: qr.amount, who: qr.who, already: false}); setPhase('paid');
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
      const wireHex = await DpayCore.signAuthorization(identity.secretHex, req.toHex, req.amount, req.nonceHex, req.expiry, req.currency);
      if (!(await DpayCore.verifyWire(wireHex))) throw new Error('local verify failed');
      const code = await DpayCore.encodeQr(wireHex);
      const who = req.name || short(req.toHex);
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
            setPaid({amount: req.amount, who, already: !!j.replayed}); setPhase('paid'); return;
          }
          // Settled at the HTTP layer but the receipt did not verify — honest, never a fake Paid.
          setErr('Couldn’t verify the payment — check the balance'); return;
        }
        if (outcome === 'rejected') {
          // A definitive refusal: show WHY (e.g. "Not enough balance") rather than silently
          // dropping to the QR screen, which reads as if the payment is fine. NonceReused is the
          // exception — it means this exact payment already settled.
          if (isNonceReused(j?.error)) { setPaid({amount: req.amount, who, already: true}); setPhase('paid'); return; }
          setErr(rejectionMessage(typeof j?.error === 'string' ? j.error : null)); return;
        }
        // outcome === 'unknown': couldn't reach the ledger cleanly. Fall through to the offline QR
        // hand-off (the merchant can still scan it) — the /receipt poll reconciles if it settles.
      }
      setQr({code, amount: req.amount, who, nonce});
      setPhase('qr');
    } catch (e: any) { setErr(String(e?.message ?? e)); } finally { setBusy(false); }
  }

  function reset() { setReq(null); setQr(null); setPaid(null); setErr(null); setPhase('scan'); }

  if (phase === 'paid' && paid) {
    const warn = paid.already || paid.pending;
    const glyph = paid.pending ? '⋯' : paid.already ? '↩' : '✓';
    const headline = paid.pending ? `Sent ${usd(paid.amount)}` : paid.already ? 'Already paid' : `Paid ✓ ${usd(paid.amount)}`;
    const sub = paid.pending ? `to ${paid.who} · awaiting the merchant’s confirmation`
      : paid.already ? `${usd(paid.amount)} to ${paid.who} · not charged again`
      : `to ${paid.who}`;
    return (
      <View style={S.center}>
        <View style={[S.check, warn && S.checkAlready]}><Text style={S.checkMark}>{glyph}</Text></View>
        <Text style={[S.paidText, warn && S.alreadyText]}>{headline}</Text>
        <Text style={S.paidSub}>{sub}</Text>
        <Pressable testID="btn-new" style={S.linkBtn} onPress={reset}><Text style={S.linkText}>New payment</Text></Pressable>
      </View>
    );
  }

  if (phase === 'qr' && qr) {
    return (
      <View style={S.center}>
        <Text style={S.label}>Show this to {qr.who}</Text>
        <View style={S.qrCard}><QRCode value={qr.code} size={220} ecl="L" /></View>
        <Text style={S.amountBig}>{`${usd(qr.amount)} to ${qr.who}`}</Text>
        <Text style={S.badgeOk}>signed on this device ✓</Text>
        {online ? <Text style={S.qrHint}>Waiting for {qr.who} to scan…</Text> : (
          <>
            <Text style={S.qrHint}>Offline — {qr.who} settles this when they submit it. You’ll see it on your balance once you’re back online.</Text>
            <View style={S.confirmRow}>
              {/* Offline we CANNOT know the ledger settled it, so this is an honest "handed off",
                  not "Paid ✓". It optimistically reduces the local balance; the real balance
                  reconciles on the next online poll. It does NOT fabricate a settled history entry. */}
              <Pressable testID="btn-paid" style={S.paidBtn} onPress={() => { onOfflinePaid(qr.amount); setPaid({amount: qr.amount, who: qr.who, already: false, pending: true}); setPhase('paid'); }}><Text style={S.paidBtnText}>Handed to {qr.who}</Text></Pressable>
              <Pressable testID="btn-notpaid" style={S.notPaidBtn} onPress={reset}><Text style={S.notPaidText}>Cancel</Text></Pressable>
            </View>
          </>
        )}
        <Pressable style={S.linkBtn} onPress={() => Share.share({message: qr.code})}><Text style={S.linkText}>Share auth code</Text></Pressable>
      </View>
    );
  }

  if (phase === 'review' && req) {
    return (
      <View style={S.center}>
        <Text style={S.label}>Review payment</Text>
        <Text testID="pay-amount" style={S.reviewAmount}>{`Pay ${usd(req.amount)}`}</Text>
        <Text style={S.reviewTo}>{`to ${req.name || short(req.toHex)}`}</Text>
        <Text style={S.reviewReq}>{`request ${req.nonceHex.slice(0, 12)}…`}</Text>
        {!online && shownBalance != null && req.amount > shownBalance ? (
          <Text testID="review-lowbal" style={S.warnNote}>Your local balance may not cover this — the merchant will verify.</Text>
        ) : null}
        <Pressable testID="btn-approve" style={[S.primary, busy && S.dim]} disabled={busy} onPress={approve}><Text style={S.primaryText}>{busy ? 'Signing…' : 'Approve'}</Text></Pressable>
        {err ? <Text testID="review-err" style={S.err}>{err}</Text> : null}
        <Pressable style={S.linkBtn} onPress={reset}><Text style={S.linkTextMuted}>Cancel</Text></Pressable>
      </View>
    );
  }

  // Scan screen: the card is armed in the background (if NFC is ready) AND the QR scanner is live at
  // the same time — the payer taps the merchant's phone OR scans its QR, with no button in between.
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
          <Text style={S.label}>{nfcReady ? 'Tap or scan to pay' : 'Scan a request to pay'}</Text>
          <QrScanner onScan={onRequestString} />
          <Text style={S.dim2}>{nfcReady ? "Tap the merchant's phone, or point at its request QR" : "Point at the payee's request QR"}</Text>
          {/* N10: paste-request fallback — on web/desktop where there's no camera or NFC, the user can
              paste a request string they copied or received via another channel. The decode path
              accepts a raw string identical to what the scanner produces. */}
          <Pressable testID="btn-paste" style={S.linkBtn} onPress={async () => {
            const text = await readFromClipboard();
            if (text && text.trim()) onRequestString(text.trim());
          }}>
            <Text style={S.linkText}>Paste request</Text>
          </Pressable>
          {err ? <Text style={S.err}>{err}</Text> : null}
        </>
      ) : null}
    </View>
  );
}
