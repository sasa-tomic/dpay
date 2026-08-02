import {useEffect, useMemo, useState} from 'react';
import {View, Text, Pressable, TextInput, Modal, type TextStyle} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {C} from '../config/palette';
import {S} from '../styles';
import {EXPIRY_WINDOW, NFC_PAY_TIMEOUT_MS, POLL} from '../config/constants';
import {short, base, toUnits, randNonceHex, nowSecs} from '../lib/format';
import {type CurrencyDescriptor, assetTestKey, displayName, fmtCurrencyAmount, currencySymbol} from '../config/catalog';
import type {Identity} from '../lib/types';
import {classifyPayHttp, rejectionMessage, isNonceReused} from '../payments';
import {DpayCore, DpayNfc} from '../services/native';
import {NfcTap} from './NfcTap';
import {QrScanner} from './QrScanner';
import {NfcIcon} from './NfcIcon';
import {useEscapeToClose} from '../hooks/useHotkeys';

// The optional merchant memo input — a real secondary field (not a bare text link), mirroring the
// paste-button affordance pattern (44pt-min touch target + a visible border). Inline (Group E owns
// styles.ts as ONE block): outline sub color on a subtle wash, full-width (alignSelf stretch so it
// lines up with the amount row above and the Request button below — was a narrower maxWidth:320 that
// left the field floating shorter than its neighbors), 44pt-min.
const memoInputStyle: TextStyle = {alignSelf: 'stretch', marginTop: 14, minHeight: 44, borderWidth: 1, borderColor: C.sub2, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: C.ink};

export function ReceiveMode({identity, relayUrl, nfcReady, onReceived, catalog}: {identity: Identity; relayUrl: string; nfcReady: boolean; onReceived: () => void; catalog: CurrencyDescriptor[]}) {
  // The merchant's CHOSEN settlement asset. Defaults to 0 (DEMO_USD) so the existing single-`$` flows
  // keep working unchanged (MC5: merchant selects the exact asset; the payer does NOT switch).
  const [reqCurrency, setReqCurrency] = useState(0);
  const [amount, setAmount] = useState('25.00');
  const [memo, setMemo] = useState('');
  // `rawAmount` (was `cents`) is the integer smallest-units the encoded request carries (2-decimal
  // for DEMO, 8 for BTC, 6 for USDC) — now a raw-u64 decimal STRING (MC1 units 2-4). Renamed because
  // the field was never truly cents for a non-USD currency; this is more honest.
  const [reqQr, setReqQr] = useState<{value: string; rawAmount: string; currency: number; nonce: string; nfcHex: string | null; expiry: number} | null>(null);
  // A 1s display clock so the request-QR screen can show a live expiry countdown (the signed request
  // is only valid for EXPIRY_WINDOW secs; a stale QR scans to a confusing rejection). Declared here;
  // the ticking effect is wired after `result` (the gate it reads) is declared below.
  const [now, setNow] = useState(() => nowSecs());
  const [result, setResult] = useState<{amount: string; currency: number; from: string} | null>(null);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);
  // The compact currency picker (opened by tapping the amount prefix). Replaces the old always-visible
  // chip row: the settlement currency is picked from a popup, freeing the form's vertical space.
  const [pickOpen, setPickOpen] = useState(false);
  useEscapeToClose(() => setPickOpen(false));
  // Tick the display clock only while a request QR is shown (not after settlement) — display-only,
  // so a plain setInterval (not the network POLL seam) is the right cadence for a countdown.
  useEffect(() => {
    if (!reqQr || result) return;
    const id = setInterval(() => setNow(nowSecs()), 1000);
    return () => clearInterval(id);
  }, [reqQr, result]);
  // Stable across renders (NfcTap's effect depends on it) — only changes when the request does.
  const readerReqInfo = useMemo(
    () => (reqQr ? {amount: reqQr.rawAmount, nonce: reqQr.nonce, who: 'payer', currency: reqQr.currency} : undefined),
    [reqQr],
  );

  // Resolve the selected asset's display config ONCE per render. Decimals come from the catalog
  // descriptor directly (NOT familyDisplay, which falls back to BTC's 8 + would mis-render DEMO's
  // 2). The amount-input prefix is the currency's display glyph (∂/₿/$) via currencySymbol.
  const reqDesc = catalog.find(c => c.currency === reqCurrency);
  const reqDecimals = reqDesc?.decimals ?? 2;
  const reqPrefix = currencySymbol(catalog, reqCurrency);

  async function makeRequest() {
    const rawAmount = toUnits(amount, reqDecimals);
    if (!rawAmount || rawAmount === '0') return;
    try {
      const nonce = randNonceHex();
      const expiry = nowSecs() + EXPIRY_WINDOW;
      // The merchant's own username rides as `to_name`; the optional memo is attached verbatim. Both
      // now live INSIDE the 132-byte request (wire-format v2) — the QR is plain base64url (no `|name`).
      const memoVal = memo.trim();
      const reqB64 = await DpayCore.encodeRequest(identity.publicHex, rawAmount, nonce, expiry, reqCurrency, identity.username, memoVal);
      // Build the NFC request too so reader mode can start alongside the QR (best-effort). The
      // merchant's username + memo ride as to_name/memo in the request bytes, same as the QR path.
      let nfcHex: string | null = null;
      if (nfcReady && DpayNfc) { try { nfcHex = await DpayNfc.buildRequest(identity.publicHex, rawAmount, nonce, expiry, reqCurrency, identity.username, memoVal); } catch {} }
      setReqQr({value: reqB64, rawAmount, currency: reqCurrency, nonce, nfcHex, expiry});
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
        if (alive && r.ok) { const j = await r.json(); const from = j.receipt?.from ? short(j.receipt.from) : 'payer'; setResult({amount: reqQr.rawAmount, currency: reqQr.currency, from}); onReceived(); }
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

  function reset() { setReqQr(null); setResult(null); setScanning(false); setErr(null); setMemo(''); setNfcActive(false); setNfcKey(k => k + 1); }

  // While an NFC tap is mid-flow, let it own the screen (so the receipt gets back to the payer)
  // rather than the settlement poll swapping in the "Received" view underneath it.
  if (result && !nfcActive) {
    return (
      <View style={S.center}>
        <View style={S.check}><Text style={S.checkMark}>✓</Text></View>
        <Text style={S.paidText}>{`Received ${fmtCurrencyAmount(catalog, result.currency, result.amount)}`}</Text>
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
            catalog={catalog}
            onSettled={onReceived} onActive={() => setNfcActive(true)}
            onClose={() => { setNfcActive(false); reset(); }}
          />
        ) : null}
        {!nfcActive ? (
          <>
            <View style={S.nfcHintRow}>
              {reqQr.nfcHex ? <NfcIcon color={C.brand} size={18} /> : null}
              <Text style={S.nfcHintLabel}>Show this to the payer{reqQr.nfcHex ? ' · or let them tap' : ''}</Text>
            </View>
            <View testID="request-qr" style={S.qrCard}><QRCode value={reqQr.value} size={244} ecl="M" /></View>
        <Text style={S.amountBig}>{fmtCurrencyAmount(catalog, reqQr.currency, reqQr.rawAmount)}</Text>
        {(() => {
          const remaining = reqQr.expiry - now;
          if (remaining <= 0) return <Text style={S.qrExpired}>Expired — make a new request</Text>;
          const m = Math.floor(remaining / 60);
          const s = remaining % 60;
          // While there's a minute+ of headroom, show the calm "~N min" form; under a minute, count
          // down seconds (and tint red) so the merchant knows to refresh before a payer scans a stale QR.
          if (m >= 1) return <Text style={S.qrExpiry}>Valid for ~{m} min</Text>;
          return <Text style={S.qrExpiryWarn}>Expires in 0:{s.toString().padStart(2, '0')}</Text>;
        })()}
        <Text style={S.qrHint}>Waiting for payment…</Text>
            {scanning ? (
              <><QrScanner onScan={onSignedQr} /><Text style={S.dim2}>Scan the payer's signed QR</Text></>
            ) : (
              <Pressable style={S.linkBtn} onPress={() => setScanning(true)} accessibilityRole="button" accessibilityLabel="Payer paid offline, scan to settle" accessibilityState={{disabled: false}}><Text style={S.linkText}>Payer paid offline? Scan to settle.</Text></Pressable>
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
      <View style={S.amountRow}>
        {/* MC5: the merchant selects the EXACT settlement asset by tapping the amount prefix (glyph +
            ▾), which opens the compact currency picker below. The amount is cleared on switch so a
            stale '25.00' is never reinterpreted as 25 BTC (8-decimal) on the new asset. */}
        <Pressable testID="req-prefix" style={S.prefixBtn} onPress={() => setPickOpen(true)} accessibilityRole="button" accessibilityLabel="Choose settlement currency" accessibilityState={{disabled: false}}>
          <Text style={S.currency}>{reqPrefix}</Text>
          <Text style={S.caret}>▾</Text>
        </Pressable>
        <TextInput testID="amount-input" style={S.amountInput} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={C.sub2} />
      </View>
      <TextInput
        testID="memo-input"
        style={memoInputStyle}
        value={memo}
        onChangeText={setMemo}
        placeholder="Add a note (optional)"
        placeholderTextColor={C.sub2}
        accessibilityLabel="Memo"
        accessibilityHint="An optional note attached to this payment request"
        maxLength={32}
      />
      <Pressable testID="btn-request" style={S.primaryWide} onPress={makeRequest} accessibilityRole="button" accessibilityLabel="Request" accessibilityState={{disabled: false}}><Text style={S.primaryText}>Request</Text></Pressable>
      {err ? <Text style={S.err}>{err}</Text> : null}
      <CurrencyPicker
        open={pickOpen}
        catalog={catalog}
        current={reqCurrency}
        onPick={(c) => { setReqCurrency(c); setAmount(''); setPickOpen(false); }}
        onClose={() => setPickOpen(false)}
      />
    </View>
  );
}

// Compact settlement-currency picker, opened from the Receive amount prefix. Rendered in a <Modal> so
// it overlays the whole screen regardless of where ReceiveMode sits in the tree (a nested absolute
// overlay would be clipped/positioned by the ScrollView content). One row per catalog currency: glyph
// + name; a ✓ marks the active selection. Tap a row to choose, or the backdrop / Esc to dismiss.
function CurrencyPicker({open, catalog, current, onPick, onClose}: {open: boolean; catalog: CurrencyDescriptor[]; current: number; onPick: (c: number) => void; onClose: () => void}) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={S.pickBackdrop} onPress={onClose}>
        <View style={S.pickCard}>
          <Text style={S.pickTitle}>Receive in</Text>
          {catalog.map(desc => {
            const key = desc.currency === 0 ? 'demo' : assetTestKey(desc);
            const label = desc.currency === 0 ? 'DEMO' : displayName(desc);
            const active = current === desc.currency;
            return (
              <Pressable
                key={desc.currency}
                testID={`req-pick-${key}`}
                style={S.pickItem}
                onPress={() => onPick(desc.currency)}
                accessibilityRole="button"
                accessibilityLabel={`Receive in ${label}`}
                accessibilityState={{disabled: false}}
              >
                <Text style={S.pickGlyph}>{currencySymbol(catalog, desc.currency)}</Text>
                <Text style={S.pickName}>{label}</Text>
                {active ? <Text style={S.pickCheck}>✓</Text> : null}
              </Pressable>
            );
          })}
        </View>
      </Pressable>
    </Modal>
  );
}
