import {useEffect, useMemo, useState} from 'react';
import {View, Text, Pressable, TextInput} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {C} from '../config/palette';
import {S} from '../styles';
import {EXPIRY_WINDOW, NFC_PAY_TIMEOUT_MS, POLL} from '../config/constants';
import {usd, short, base, toCents, randNonceHex, nowSecs} from '../lib/format';
import type {Identity} from '../lib/types';
import {classifyPayHttp, rejectionMessage, isNonceReused} from '../payments';
import {DpayCore, DpayNfc} from '../services/native';
import {NfcTap} from './NfcTap';
import {QrScanner} from './QrScanner';

export function ReceiveMode({identity, relayUrl, nfcReady, onReceived}: {identity: Identity; relayUrl: string; nfcReady: boolean; onReceived: () => void}) {
  const [amount, setAmount] = useState('25.00');
  const [reqQr, setReqQr] = useState<{value: string; cents: number; nonce: string; nfcHex: string | null} | null>(null);
  const [result, setResult] = useState<{amount: number; from: string} | null>(null);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);
  // Stable across renders (NfcTap's effect depends on it) — only changes when the request does.
  const readerReqInfo = useMemo(
    () => (reqQr ? {amount: reqQr.cents, nonce: reqQr.nonce, who: 'payer'} : undefined),
    [reqQr],
  );

  async function makeRequest() {
    const cents = toCents(amount);
    if (!cents) return;
    try {
      const nonce = randNonceHex();
      const expiry = nowSecs() + EXPIRY_WINDOW;
      const reqB64 = await DpayCore.encodeRequest(identity.publicHex, cents, nonce, expiry, 0);
      // Build the NFC request too so reader mode can start alongside the QR (best-effort).
      let nfcHex: string | null = null;
      if (nfcReady && DpayNfc) { try { nfcHex = await DpayNfc.buildRequest(identity.publicHex, cents, nonce, expiry, 0); } catch {} }
      setReqQr({value: `${reqB64}|${identity.username}`, cents, nonce, nfcHex});
      setResult(null); setErr(null);
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }

  // Poll the ledger for this request's settlement (payer paid directly, or we submitted their QR).
  useEffect(() => {
    if (!reqQr || result) return;
    let alive = true;
    const check = async () => {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch(`${base(relayUrl)}/api/v1/receipt/${reqQr.nonce}`, {signal: ctrl.signal});
        if (alive && r.ok) { const j = await r.json(); const from = j.receipt?.from ? short(j.receipt.from) : 'payer'; setResult({amount: reqQr.cents, from}); onReceived(); }
      } catch {} finally { clearTimeout(t); }
    };
    check(); const id = setInterval(check, POLL.receiptRcv);
    return () => { alive = false; clearInterval(id); };
  }, [reqQr, result, relayUrl, onReceived]);

  async function onSignedQr(raw: string) {
    setScanning(false);
    setErr(null);
    try {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), NFC_PAY_TIMEOUT_MS);
      let r;
      try {
        r = await fetch(`${base(relayUrl)}/api/v1/pay`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({qr: raw.trim()}), signal: ctrl.signal});
      } finally { clearTimeout(timer); }
      const j = await r.json().catch(() => ({} as any));
      // Only a definitive rejection is worth an error. A settled or ambiguous (network) result is
      // surfaced by the /receipt poll (which sets `result`), so we never flash a false failure on a
      // payment that actually went through.
      if (classifyPayHttp({ok: r.ok, status: r.status}) === 'rejected' && !isNonceReused(j?.error)) {
        setErr(rejectionMessage(typeof j?.error === 'string' ? j.error : null));
      }
    } catch { /* network/timeout — the /receipt poll reconciles; don't show a false error */ }
  }

  function reset() { setReqQr(null); setResult(null); setScanning(false); setErr(null); setNfcActive(false); setNfcKey(k => k + 1); }

  // While an NFC tap is mid-flow, let it own the screen (so the receipt gets back to the payer)
  // rather than the settlement poll swapping in the "Received" view underneath it.
  if (result && !nfcActive) {
    return (
      <View style={S.center}>
        <View style={S.check}><Text style={S.checkMark}>✓</Text></View>
        <Text style={S.paidText}>{`Received ${usd(result.amount)}`}</Text>
        <Text style={S.paidSub}>{`from ${result.from}`}</Text>
        <Pressable style={S.linkBtn} onPress={reset} accessibilityRole="button" accessibilityLabel="New request" accessibilityState={{disabled: false}}><Text style={S.linkText}>New request</Text></Pressable>
      </View>
    );
  }

  if (reqQr) {
    return (
      <View style={S.center}>
        {/* Reader mode runs in the background while the QR is shown: the payer taps OR scans. */}
        {reqQr.nfcHex && nfcReady && DpayNfc ? (
          <NfcTap
            key={nfcKey} role="reader" identity={identity} relayUrl={relayUrl} requestHex={reqQr.nfcHex}
            reqInfo={readerReqInfo}
            onSettled={onReceived} onActive={() => setNfcActive(true)}
            onClose={() => { setNfcActive(false); reset(); }}
          />
        ) : null}
        {!nfcActive ? (
          <>
            <Text style={S.label}>Show this to the payer{reqQr.nfcHex ? ' · or let them tap' : ''}</Text>
            <View testID="request-qr" style={S.qrCard}><QRCode value={reqQr.value} size={220} ecl="M" /></View>
            <Text style={S.amountBig}>{usd(reqQr.cents)}</Text>
            <Text style={S.qrHint}>Waiting for payment…</Text>
            {scanning ? (
              <><QrScanner onScan={onSignedQr} /><Text style={S.dim2}>Scan the payer's signed QR</Text></>
            ) : (
              <Pressable style={S.linkBtn} onPress={() => setScanning(true)} accessibilityRole="button" accessibilityLabel="Payer paid offline, scan their signed code to settle" accessibilityState={{disabled: false}}><Text style={S.linkText}>Payer paid offline? Scan their signed code to settle.</Text></Pressable>
            )}
            {err ? <Text style={S.err}>{err}</Text> : null}
            <Pressable style={S.linkBtn} onPress={reset} accessibilityRole="button" accessibilityLabel="New request" accessibilityState={{disabled: false}}><Text style={S.linkTextMuted}>New request</Text></Pressable>
          </>
        ) : null}
      </View>
    );
  }

  return (
    <View style={S.center}>
      <Text style={S.label}>Amount to receive</Text>
      <View style={S.amountRow}><Text style={S.currency}>$</Text><TextInput testID="amount-input" style={S.amountInput} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={C.sub2} /></View>
      <Pressable testID="btn-request" style={S.primaryWide} onPress={makeRequest} accessibilityRole="button" accessibilityLabel="Request" accessibilityState={{disabled: false}}><Text style={S.primaryText}>Request</Text></Pressable>
      {err ? <Text style={S.err}>{err}</Text> : null}
    </View>
  );
}
