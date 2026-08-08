import {useState} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, type TextStyle} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {C} from '../config/palette';
import {S} from '../styles';
import {QR_SIZE_SMALL, SOL_SEND_TIMEOUT_MS} from '../config/constants';
import {fmtAsset, toUnits} from '../lib/format';
import type {Identity} from '../lib/types';
import bs58 from 'bs58';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {USDC_DECIMALS, USDC_MINT_ADDRESS, deriveAta} from '../solana/spl';
import {encodeSolReq, decodeSolPay, type SolReq} from '../solana/qr';
import {deriveSolanaAddress, broadcastSolPayment} from '../solana';
import {friendlySolError} from '../solana/errors';
import {RECEIPT_SETTLED, RECEIPT_REJECTED, RECEIPT_UNREACHABLE} from '../payments';
import {DpaySolNfc} from '../services/native';
import {copyToClipboard} from '../lib/clipboard';
import {QrScanner} from './QrScanner';
import {SolNfcTap} from './SolNfcTap';
import {withTimeout} from '../lib/timeout';

const memoInputStyle: TextStyle = {alignSelf: 'stretch', marginTop: 14, minHeight: 44, borderWidth: 1, borderColor: C.sub2, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: C.ink};

/**
 * SolReceiveMode — the merchant-side offline-pay component for the SOL durable-nonce rail.
 *
 * Rendered INLINE in the Receive tab body when SOL is the active asset (selected in Balances).
 * rail. The merchant builds a `solreq:` QR (amount + currency + their address), the payer scans it +
 * signs offline (SolPayMode), then the merchant scans the payer's `solpay:` QR and broadcasts it
 * online (broadcastSolPayment). On success, the merchant sees the received amount + the tx
 * signature. The advanced nonce is available for visual relay back to the payer (fully automated
 * in the NFC path, Phase E).
 *
 * Mirrors ReceiveMode.tsx's form → reqQr → result phase machine, but settles directly on Solana
 * (no relay, no /receipt poll — `confirmTransaction` is the source of truth).
 *
 * NFC arming: this component mounts only while the SOL rail is selected. Switching the rail (via
 * Switching the active asset unmounts it, whose `useNfcTapState` cleanup stops the reader — no arm-leak.
 */
export function SolReceiveMode({identity, online, nfcReady}: {identity: Identity; online: boolean; nfcReady: boolean}) {
  const [amount, setAmount] = useState('0.025');
  const [cur, setCur] = useState<'SOL' | 'USDC'>('SOL');
  const [memo, setMemo] = useState('');
  const [phase, setPhase] = useState<'form' | 'reqQr' | 'result'>('form');
  const [reqUri, setReqUri] = useState<string | null>(null);
  const [reqSnapshot, setReqSnapshot] = useState<SolReq | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{amount: string; cur: 'SOL' | 'USDC'; sig: string | null} | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<'clipboard' | 'shared' | null>(null);
  // A tap taking over while the QR is shown; nfcKey re-starts the reader after each.
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);

  const decimals = cur === 'SOL' ? SOL_DECIMALS : USDC_DECIMALS;
  const unit = cur === 'SOL' ? SOL_UNIT : 'USDC';

  // Build the solreq: QR. Derives the merchant's SOL address (or their USDC ATA) for the `to`/`toAta`.
  function makeRequest() {
    const raw = toUnits(amount, decimals);
    if (!raw || raw === '0') return;
    try {
      const addr = deriveSolanaAddress(identity.secretHex);
      const reqInput = cur === 'SOL'
        ? {to: addr, amt: raw, cur: 'SOL' as const, mint: null, toAta: null, exp: Math.floor(Date.now() / 1000) + 300, name: identity.username, memo: memo.trim()}
        : {to: addr, amt: raw, cur: 'USDC' as const, mint: USDC_MINT_ADDRESS,         toAta: bs58.encode(deriveAta(addr, USDC_MINT_ADDRESS)), exp: Math.floor(Date.now() / 1000) + 300, name: identity.username, memo: memo.trim()};
      const uri = encodeSolReq(reqInput);
      setReqUri(uri);
      setReqSnapshot({...reqInput, v: 1 as const});
      setResult(null);
      setErr(null);
      setPhase('reqQr');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  // Scan the payer's signed solpay: QR → broadcast → confirm.
  async function onSignedQr(raw: string) {
    setScanning(false);
    setBusy(true);
    setErr(null);
    const {signal, cancel} = withTimeout(SOL_SEND_TIMEOUT_MS * 2);
    try {
      const solpay = decodeSolPay(raw);
      const receipt = await broadcastSolPayment(solpay, signal);
      if (receipt.status === RECEIPT_SETTLED) {
        setResult({amount: solpay.amt, cur: solpay.cur, sig: receipt.sig});
        setPhase('result');
      } else if (receipt.status === RECEIPT_REJECTED) {
        setErr('Payment rejected — the payer may have a stale nonce or insufficient balance.');
      } else {
        setErr("Couldn't confirm — the payment may still settle. Check your balance shortly.");
      }
    } catch (e: unknown) {
      setErr(friendlySolError(e instanceof Error ? e.message : String(e)));
    } finally {
      cancel();
      setBusy(false);
    }
  }

  function reset() { setReqUri(null); setReqSnapshot(null); setResult(null); setScanning(false); setErr(null); setMemo(''); setNfcActive(false); setNfcKey(k => k + 1); setPhase('form'); }

  const copySig = async () => {
    if (!result?.sig) return;
    const how = await copyToClipboard(result.sig);
    setCopied(how);
    setTimeout(() => setCopied(null), 1500);
  };

  if (phase === 'result' && result && !nfcActive) {
    return (
      <View style={S.center}>
        <View style={S.check}><Text style={S.checkMark}>✓</Text></View>
        <Text testID="sol-req-status" style={S.paidText}>{`Received ${fmtAsset(result.amount, result.cur === 'USDC' ? USDC_DECIMALS : SOL_DECIMALS, result.cur === 'USDC' ? 'USDC' : SOL_UNIT)}`}</Text>
        {result.sig ? (
          <>
            <Text style={S.dim2}>transaction signature</Text>
            <Text testID="sol-req-sig" selectable={true} style={S.sheetAddr}>{result.sig}</Text>
            <Pressable testID="btn-sol-req-copy" style={S.primaryWide} onPress={copySig} accessibilityRole="button" accessibilityLabel="Copy transaction signature">
              <Text style={S.primaryText}>{copied === 'clipboard' ? 'Copied ✓' : copied === 'shared' ? 'Shared ✓' : 'Copy signature'}</Text>
            </Pressable>
          </>
        ) : null}
        <Pressable testID="btn-sol-req-done" style={S.linkBtn} onPress={reset} accessibilityRole="button" accessibilityLabel="New request" accessibilityState={{disabled: false}}>
          <Text style={S.linkText}>New request</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'reqQr' && reqUri) {
    return (
      <View style={S.center}>
        {/* Reader runs in the background while the QR is shown: the payer taps OR scans. */}
        {nfcReady && DpaySolNfc ? (
          <SolNfcTap
            key={nfcKey} role="reader" identity={identity} solreqUri={reqUri}
            onActive={() => setNfcActive(true)}
            onClose={() => { setNfcActive(false); setNfcKey(k => k + 1); }}
          />
        ) : null}
        {!nfcActive ? (
          <>
            {!scanning && !busy ? (
              <>
                <View style={S.nfcHintRow}>
                  <Text style={S.nfcHintLabel}>Show this to the payer{nfcReady ? ' · or let them tap' : ''}</Text>
                </View>
                <View testID="sol-req-qr" style={S.qrCard}><QRCode value={reqUri} size={QR_SIZE_SMALL} ecl="M" /></View>
                <Text style={S.amountBig}>{fmtAsset(reqSnapshot!.amt, decimals, unit)}</Text>
                <Text style={S.qrHint}>Waiting for the payer to sign offline…</Text>
                <Pressable style={S.linkBtn} onPress={() => setScanning(true)} accessibilityRole="button" accessibilityLabel="Scan the payer's signed code" accessibilityHint="Scan the payer's signed QR to submit their offline payment" accessibilityState={{disabled: false}}>
                  <Text style={S.linkText}>Scan the payer's signed code</Text>
                </Pressable>
                {err ? <Text testID="sol-req-err" style={S.err}>{err}</Text> : null}
                <Pressable style={S.linkBtn} onPress={reset} accessibilityRole="button" accessibilityLabel="New request" accessibilityState={{disabled: false}}>
                  <Text style={S.linkTextMuted}>New request</Text>
                </Pressable>
              </>
            ) : busy ? (
              <>
                <ActivityIndicator color={C.brand} />
                <Text style={S.dim2}>Broadcasting on Solana — this can take up to a minute.</Text>
              </>
            ) : (
              <>
                <QrScanner onScan={onSignedQr} />
                <Text style={S.dim2}>Scan the payer's signed code</Text>
                {err ? <Text testID="sol-req-err" style={S.err}>{err}</Text> : null}
                <Pressable style={S.linkBtn} onPress={() => setScanning(false)} accessibilityRole="button" accessibilityLabel="Back" accessibilityState={{disabled: false}}>
                  <Text style={S.linkTextMuted}>Back</Text>
                </Pressable>
              </>
            )}
          </>
        ) : null}
      </View>
    );
  }

  // phase === 'form'
  return (
    <View style={S.center}>
      <Text style={S.label}>Amount to receive</Text>
      <View style={S.amountRow}>
        <Pressable
          testID="sol-req-prefix"
          style={S.prefixBtn}
          onPress={() => setCur(c => c === 'SOL' ? 'USDC' : 'SOL')}
          accessibilityRole="button"
          accessibilityLabel={`Receive in ${cur === 'SOL' ? 'USDC' : 'SOL'}`}
          accessibilityHint="Toggle between SOL and USDC"
          accessibilityState={{disabled: false}}>
          <Text style={S.currency}>{cur === 'SOL' ? '◎' : '$'}</Text>
          <Text style={S.caret}>{cur === 'SOL' ? 'SOL' : 'USDC'} ▾</Text>
        </Pressable>
        <TextInput
          testID="sol-req-amount-input"
          style={S.amountInput}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0.025"
          placeholderTextColor={C.sub2}
          accessibilityLabel="Amount to receive"
        />
      </View>
      <TextInput
        testID="sol-req-memo-input"
        style={memoInputStyle}
        value={memo}
        onChangeText={setMemo}
        placeholder="Add a note (optional)"
        placeholderTextColor={C.sub2}
        accessibilityLabel="Memo"
        maxLength={32}
      />
      {!online ? <Text style={S.warnNote}>You're offline — the payer can sign, but you need a connection to broadcast their payment.</Text> : null}
      {err ? <Text style={S.err}>{err}</Text> : null}
      <Pressable
        testID="btn-sol-req-make"
        style={[S.primaryWide, !online && S.dim]}
        disabled={!online}
        onPress={makeRequest}
        accessibilityRole="button"
        accessibilityLabel="Request"
        accessibilityHint="Show your QR code so the payer can scan it to pay you"
        accessibilityState={{disabled: !online}}>
        <Text style={S.primaryText}>Request</Text>
      </Pressable>
    </View>
  );
}
