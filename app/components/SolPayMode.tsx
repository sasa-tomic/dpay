import {useState} from 'react';
import {View, Text, Pressable, Share} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {S} from '../styles';
import {QR_SIZE} from '../config/constants';
import {fmtAsset} from '../lib/format';
import type {Identity} from '../lib/types';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {USDC_DECIMALS} from '../solana/spl';
import {decodeSolReq, encodeSolPay} from '../solana/qr';
import type {SolReqV2} from '../solana/qr';
import {isSolReqV2Expired} from '../solana/payments';
import {signSolPayment, signSplPayment} from '../solana';
import {DpaySolNfc} from '../services/native';
import {QrScanner} from './QrScanner';
import {SolNfcTap} from './SolNfcTap';
import {ModeToggle} from './ModeToggle';
import {SolanaWithdrawSheet} from './SolanaWithdrawSheet';
import {useReportLock} from '../hooks/useReportLock';

/**
 * SolPayMode — the payer-side offline-pay component for the v2 recent-blockhash SOL rail.
 *
 * Rendered INLINE in the Pay tab body when SOL is the active asset (selected in Balances).
 * The payer scans a merchant's `solreq:v2:` QR, reviews, and signs FULLY OFFLINE (no RPC needed —
 * the signature uses the recent blockhash embedded in the request). The signed `solpay:v2:` QR is
 * shown for the merchant to scan + broadcast.
 *
 * No setup phase — v2 needs no durable-nonce account. The payer signs immediately on scan+approve.
 *
 * The honest-pending UX mirrors the IC offline hand-off (PayMode.tsx phase='qr'): the payer can
 * NEVER claim "Paid ✓" from an offline sign — they mark "Handed to merchant" (pending) and the
 * outcome is learned via NFC receipt or when the merchant settles on-chain.
 *
 * NFC arming: this component mounts only while the SOL rail is selected. Switching the rail unmounts
 * it, whose `useNfcTapState` cleanup disarms the HCE card — no arm-leak.
 */
export function SolPayMode({identity, nfcReady, solBalance, usdcBalance, usdcAtaAbsent, selectedToken, onSent, onSentUsdc, ataSetupBusy = false, ataSetupErr = null, onCreateAta, subMode, onSubModeChange, onLockChange}: {identity: Identity; nfcReady: boolean; solBalance: string; usdcBalance: string; usdcAtaAbsent: boolean; selectedToken: 'SOL' | 'USDC'; onSent: () => void; onSentUsdc: () => void; ataSetupBusy?: boolean; ataSetupErr?: string | null; onCreateAta?: () => void; subMode: 'scan' | 'send'; onSubModeChange: (m: 'scan' | 'send') => void; onLockChange?: (locked: boolean) => void}) {
  const [phase, setPhase] = useState<'scan' | 'review' | 'qr' | 'paid'>('scan');
  const [req, setReq] = useState<SolReqV2 | null>(null);
  const [solpayUri, setSolpayUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A tap arriving on the always-armed card takes over the scan screen; nfcKey re-arms after each.
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);

  // Lock the idle asset selection while a SOL payment is in flight. review/qr/paid hold the
  // captured, immutable SolReqV2 snapshot the user must not lose to an asset switch.
  const locked = phase === 'review' || phase === 'qr' || phase === 'paid';
  useReportLock(onLockChange, locked);

  const toggle = (
    <ModeToggle
      testID="pay-mode-toggle"
      value={subMode}
      onChange={(v) => onSubModeChange(v as 'scan' | 'send')}
      left={{label: 'Scan to pay', value: 'scan', testID: 'btn-pay-scan'}}
      right={{label: 'Send to address', value: 'send', testID: 'btn-pay-send'}}
    />
  );

  // "Send to address" sub-mode: render the on-chain send flow INLINE (the SolanaWithdrawSheet body).
  // The toggle above lets the user flip back to "Scan to pay". The sheet is inline-only (no overlay
  // chrome — the tab body provides the surface). Mirrors the IC PayMode "Send to address" sub-mode.
  // Sits BELOW the useState so React's Rules of Hooks hold across sub-mode flips (the payer's
  // phase state survives a Send detour without re-mounting).
  if (subMode === 'send') {
    const sendBalance = selectedToken === 'SOL' ? solBalance : usdcBalance;
    const sendOnSent = selectedToken === 'SOL' ? onSent : onSentUsdc;
    return (
      <View style={S.center}>
        {toggle}
        <SolanaWithdrawSheet
          identity={identity}
          token={selectedToken}
          balance={sendBalance}
          usdcAtaAbsent={usdcAtaAbsent}
          solBalance={solBalance}
          ataSetupBusy={ataSetupBusy}
          ataSetupErr={ataSetupErr}
          onCreateAta={onCreateAta}
          onSent={sendOnSent}
          onClose={() => onSubModeChange('scan')}
        />
      </View>
    );
  }

  // Scan the merchant's solreq:v2: QR → decode → review. Enforce `exp` CLIENT-SIDE (the SOL rail
  // has no server to reject a stale request — unlike the IC canister — so a stale/replayed solreq is
  // fully signable unless we refuse it here, before signing).
  function onScan(raw: string) {
    try {
      const r = decodeSolReq(raw);
      if (isSolReqV2Expired(r)) {
        setReq(null);
        setErr('This payment request has expired. Ask the merchant for a fresh QR.');
        return;
      }
      setReq(r);
      setErr(null);
      setPhase('review');
    } catch (e: unknown) {
      // Same honest-contract split as PayMode's decode failure: the user gets friendly copy (never
      // the raw codec error), the dev cause goes to the console.
      console.warn('solpay decode failed:', e);
      setErr('This isn\'t a dpay payment code');
    }
  }

  // Approve → offline sign (PURE, no RPC) → show the signed solpay:v2: QR.
  function approve() {
    if (!req) return;
    setBusy(true);
    try {
      const solpay = req.cur === 'SOL'
        ? signSolPayment(identity.secretHex, req)
        : signSplPayment(identity.secretHex, req);
      setSolpayUri(encodeSolPay(solpay));
      setPhase('qr');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function reset() { setReq(null); setSolpayUri(null); setErr(null); setPhase('scan'); }

  // NFC card outcome: success/pending → paid (awaiting merchant confirmation); declined → back to scan.
  function onNfcOutcome(outcome: 'success' | 'pending' | 'declined') {
    if (outcome === 'declined') { reset(); return; }
    setPhase('paid');
  }

  const decimals = req?.cur === 'USDC' ? USDC_DECIMALS : SOL_DECIMALS;
  const unit = req?.cur === 'USDC' ? 'USDC' : SOL_UNIT;

  if (phase === 'scan') {
    return (
      <View style={S.center}>
        {toggle}
        {/* NFC card runs in the background (if ready) while the QR scanner is live at the same
            time — the payer taps the merchant's phone OR scans its QR. No setup needed in v2. */}
        {nfcReady && DpaySolNfc ? (
          <SolNfcTap
            key={nfcKey} role="card" identity={identity}
            onOutcome={onNfcOutcome}
            onClose={() => { setNfcActive(false); setNfcKey(k => k + 1); }}
          />
        ) : null}
        {!nfcActive ? (
          <>
            <View testID="sol-pay-scan" style={S.scanWrap}>
              <Text style={S.dim2}>Scan the merchant's payment code to pay offline.</Text>
              <QrScanner onScan={onScan} />
            </View>
            {err ? <Text testID="sol-pay-err" style={S.err}>{err}</Text> : null}
          </>
        ) : null}
      </View>
    );
  }

  if (phase === 'review' && req) {
    return (
      <View style={S.center}>
        {toggle}
        <Text style={S.label}>Review payment</Text>
        <Text testID="sol-pay-amount" style={S.reviewAmount}>{`Pay ${fmtAsset(req.amt, decimals, unit)}`}</Text>
        <Text style={S.reviewTo}>{`to ${req.name || req.to}`}</Text>
        {req.memo ? <Text testID="sol-pay-memo" style={S.dim2}>{req.memo}</Text> : null}
        <Text style={S.badgeOk}>signed on this device ✓</Text>
        <Text style={S.dim2}>This signs offline — the merchant settles when they submit it.</Text>
        {err ? <Text testID="sol-pay-err" style={S.err}>{err}</Text> : null}
        <Pressable
          testID="btn-sol-pay-approve"
          style={[S.primaryWide, busy && S.disabledFlat]}
          disabled={busy}
          onPress={approve}
          accessibilityRole="button"
          accessibilityLabel="Approve offline payment"
          accessibilityHint="Sign the payment offline with your key"
          accessibilityState={{disabled: busy}}>
          <Text style={S.primaryText}>{busy ? 'Signing…' : 'Approve'}</Text>
        </Pressable>
        <Pressable testID="btn-sol-pay-cancel" style={S.secondaryBtn} onPress={reset} accessibilityRole="button" accessibilityLabel="Cancel" accessibilityState={{disabled: false}}>
          <Text style={S.secondaryBtnText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'qr' && solpayUri) {
    return (
      <View style={S.center}>
        {toggle}
        <Text style={S.label}>Show this to the merchant</Text>
        <View testID="sol-pay-qr" style={S.qrCard}><QRCode value={solpayUri} size={QR_SIZE} ecl="L" /></View>
        <Text style={S.amountBig}>{`${fmtAsset(req!.amt, decimals, unit)} to ${req!.name || req!.to}`}</Text>
        <Text style={S.badgeOk}>signed offline ✓</Text>
        <Text style={S.qrHint}>Offline — the merchant settles this when they submit it. You'll see it on your balance once it's confirmed.</Text>
        <View style={S.confirmRow}>
          <Pressable
            testID="btn-sol-pay-handed"
            style={S.paidBtn}
            onPress={() => { setPhase('paid'); }}
            accessibilityRole="button"
            accessibilityLabel="Handed to merchant"
            accessibilityHint="Mark the signed payment as handed off; your balance updates when the merchant settles"
            accessibilityState={{disabled: false}}>
            <Text style={S.paidBtnText}>Handed to merchant</Text>
          </Pressable>
          <Pressable testID="btn-sol-pay-discard" style={S.notPaidBtn} onPress={reset} accessibilityRole="button" accessibilityLabel="Cancel" accessibilityState={{disabled: false}}>
            <Text style={S.notPaidText}>Cancel</Text>
          </Pressable>
        </View>
        <Pressable style={S.linkBtn} onPress={() => Share.share({message: solpayUri})} accessibilityRole="button" accessibilityLabel="Share signed payment" accessibilityState={{disabled: false}}>
          <Text style={S.linkText}>Share signed code</Text>
        </Pressable>
      </View>
    );
  }

  // phase === 'paid'. `req` may be null if the payment was via NFC (the autoSign decoded the
  // request internally; SolPayMode's `req` state is only set on QR scan).
  const paidAmt = req ? fmtAsset(req.amt, decimals, unit) : '';
  const paidTo = req ? `to ${req.name || req.to} · ` : '';
  return (
    <View style={S.center}>
      {toggle}
      <View style={[S.check, S.checkAlready]}><Text style={S.checkMark}>⋯</Text></View>
      <Text testID="sol-pay-status" style={[S.paidText, S.alreadyText]}>{paidAmt ? `Sent ${paidAmt}` : 'Sent'}</Text>
      <Text style={S.paidSub}>{`${paidTo}awaiting the merchant's confirmation`}</Text>
      <Text style={S.dim2}>Your balance updates when the merchant settles this on-chain.</Text>
      <Pressable testID="btn-sol-pay-done" style={S.linkBtn} onPress={reset} accessibilityRole="button" accessibilityLabel="New payment" accessibilityState={{disabled: false}}>
        <Text style={S.linkText}>New payment</Text>
      </Pressable>
    </View>
  );
}
