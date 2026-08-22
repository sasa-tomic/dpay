import {useState} from 'react';
import {View, Text, Pressable} from 'react-native';
import {QrCode} from './QrCode';
import {FundFirstPanel} from './FundFirstPanel';
import {SolanaAtaSetupCard} from './SolanaAtaSetupCard';
import {S} from '../styles';
import {C} from '../config/palette';
import {IconClock, IconScan, IconShare} from './icons';
import {QR_SIZE} from '../config/constants';
import type {SolPayGate} from '../config/assets';
import type {Identity} from '../lib/types';
import {fmtAsset, short} from '../lib/format';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {USDC_DECIMALS, SOL_ATA_SETUP_MIN_LAMPORTS} from '../solana/spl';
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
import {useShareFeedback, shareConfirmLabel} from '../hooks/useShareFeedback';
import {CoachTip} from './CoachTip';

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
export function SolPayMode({identity, nfcReady, solBalance, usdcBalance, usdcAtaAbsent, payGate = 'none', solZero = false, solChecking = false, selectedToken, onSent, onSentUsdc, onShowSolAddress, onShowUsdcAddress, onRecheckBalances, recheckBusy = false, ataSetupBusy = false, ataSetupErr = null, onCreateAta, subMode, onSubModeChange, onLockChange}: {identity: Identity; nfcReady: boolean; solBalance: string; usdcBalance: string; usdcAtaAbsent: boolean; payGate?: SolPayGate; solZero?: boolean; solChecking?: boolean; selectedToken: 'SOL' | 'USDC'; onSent: () => void; onSentUsdc: () => void; onShowSolAddress: () => void; onShowUsdcAddress: () => void; onRecheckBalances: () => void; recheckBusy?: boolean; ataSetupBusy?: boolean; ataSetupErr?: string | null; onCreateAta?: () => void; subMode: 'scan' | 'send'; onSubModeChange: (m: 'scan' | 'send') => void; onLockChange?: (locked: boolean) => void}) {
  const [phase, setPhase] = useState<'scan' | 'review' | 'qr' | 'paid'>('scan');
  const [req, setReq] = useState<SolReqV2 | null>(null);
  const [solpayUri, setSolpayUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A tap arriving on the always-armed card takes over the scan screen; nfcKey re-arms after each.
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);

  // U-F1 — visible confirmation after the share resolves (the DepositSheet copy pattern). Dismissed
  // sheets leave the label honest.
  const {shared, share} = useShareFeedback();

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
    // Zero-funds gate (2026-08-16): the send form is replaced by the fund-first panel while the
    // active token is KNOWN unfunded — no amount entry against a zero balance. Same panel, same
    // copy family as the scan branch (only "…to send" instead of "…to pay"), per the spec.
    if (payGate !== 'none' && payGate !== 'usdc-absent') {
      const isSol = payGate === 'sol-zero';
      return (
        <View style={S.center}>
          {toggle}
          <FundFirstPanel
            testID="sol-send-fund"
            title={isSol ? 'Add SOL to send' : 'Add USDC to send'}
            body={isSol
              ? 'This wallet has no SOL yet. Send SOL to your address and you can send right away.'
              : 'Send USDC (Solana) to your USDC address. Keep a little SOL in the wallet for network fees.'}
            primaryLabel={isSol ? 'Show my SOL address' : 'Show my USDC address'}
            onPrimary={isSol ? onShowSolAddress : onShowUsdcAddress}
            secondaryLabel={!isSol && solZero ? 'Show my SOL address' : undefined}
            onSecondary={!isSol && solZero ? onShowSolAddress : undefined}
            onRecheck={onRecheckBalances}
            recheckBusy={recheckBusy}
          />
          {err ? <Text testID="sol-pay-err" style={S.err}>{err}</Text> : null}
        </View>
      );
    }
    return (
      <View style={S.center}>
        {toggle}
        <SolanaWithdrawSheet
          identity={identity}
          token={selectedToken}
          balance={sendBalance}
          usdcAtaAbsent={usdcAtaAbsent}
          solBalance={solBalance}
          solChecking={solChecking}
          ataSetupBusy={ataSetupBusy}
          ataSetupErr={ataSetupErr}
          onCreateAta={onCreateAta}
          onShowSolAddress={onShowSolAddress}
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
    // Zero-funds gate (2026-08-16 UX): when the active asset is KNOWN unfunded the scanner is
    // replaced by the fund-first panel. NFC does NOT arm while gated — a tap is auto-sign consent,
    // and a zero balance would sign a payment the merchant can never settle (doomed signature).
    // loading/error/unavailable NEVER reach here (the Wallet's gate fails OPEN to the scanner —
    // offline-first rule; the honest backstop is the same review/RPC failure as before).
    if (payGate === 'sol-zero' || payGate === 'usdc-zero') {
      const isSol = payGate === 'sol-zero';
      return (
        <View style={S.center}>
          {toggle}
          <FundFirstPanel
            testID="sol-pay-fund"
            title={isSol ? 'Add SOL to pay' : 'Add USDC to pay'}
            body={isSol
              ? 'This wallet has no SOL yet. Send SOL to your address and you can pay right away.'
              : 'Send USDC (Solana) to your USDC address. Keep a little SOL in the wallet for network fees.'}
            primaryLabel={isSol ? 'Show my SOL address' : 'Show my USDC address'}
            onPrimary={isSol ? onShowSolAddress : onShowUsdcAddress}
            secondaryLabel={!isSol && solZero ? 'Show my SOL address' : undefined}
            onSecondary={!isSol && solZero ? onShowSolAddress : undefined}
            onRecheck={onRecheckBalances}
            recheckBusy={recheckBusy}
          />
          {err ? <Text testID="sol-pay-err" style={S.err}>{err}</Text> : null}
        </View>
      );
    }
    if (payGate === 'usdc-absent') {
      // USDC-selected + ATA KNOWN absent: the one-tap setup card (with the fund-SOL secondary when
      // SOL is also zero) replaces the scanner. Setup first, then pay — never a doomed SPL sign.
      const hasSol = BigInt(solBalance) >= SOL_ATA_SETUP_MIN_LAMPORTS;
      return (
        <View style={S.center}>
          {toggle}
          <SolanaAtaSetupCard
            instrTestID="sol-pay-ata-instructions"
            btnTestID="btn-sol-pay-ata-create"
            buttonLabel="Create my USDC account"
            hasSol={hasSol}
            checkingSol={solChecking}
            busy={ataSetupBusy}
            err={ataSetupErr}
            onCreateAta={onCreateAta}
            onShowSolAddress={onShowSolAddress}
          />
          {err ? <Text testID="sol-pay-err" style={S.err}>{err}</Text> : null}
        </View>
      );
    }
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
              {/* P3 — a leading IconScan on the hint only; the camBox/scanWrap/center nesting is
                  UNTOUCHED (the 0×0 camBox collapse class is gated by `just campreview`). */}
              <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 8}}>
                <IconScan size={18} color={C.sub}/>
                <Text style={[S.dim2, {marginTop: 0}]}>Scan the merchant's payment code to pay offline.</Text>
              </View>
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
        {/* U-F5 twin of PayMode's review-payee: a merchant name alone is not verifiable — show the
            short destination under it. Without a name the primary line already carries the full
            base58 address (more precise than a short form), so no duplicate line. */}
        {req.name ? <Text testID="sol-pay-payee" style={S.dim2}>{short(req.to)}</Text> : null}
        {req.memo ? <Text testID="sol-pay-memo" style={S.dim2}>{req.memo}</Text> : null}
        {/* Trip Ready J4 — same payReview truth as the IC rail (the copy is rail-agnostic: exact
            asset + amount, your key). Reading-zone mount (under the amount/payee block it
            explains). Same seen-key: one dismissal covers both rails. */}
        <CoachTip tipKey="payReview" />
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
        <View testID="sol-pay-qr" style={S.qrCard}><QrCode value={solpayUri} size={QR_SIZE} ecl="L" /></View>
        <Text style={S.amountBig}>{`${fmtAsset(req!.amt, decimals, unit)} to ${req!.name || req!.to}`}</Text>
        <Text style={S.badgeOk}>signed offline ✓</Text>
        <Text style={S.qrHint}>Offline — the merchant settles this when they submit it. You'll see it on your balance once it's confirmed.</Text>
        {/* Trip Ready J4 — the SOL QR hand-off is ALWAYS offline-pending (no online branch), and
            the offlineQr truth ("the receiver's connection settles it") is exactly what this
            phase already says. Reading-zone mount (under the status line, above the confirm row).
            Same seen-key as the IC offline branch. */}
        <CoachTip tipKey="offlineQr" />
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
        <Pressable style={S.ghostBtn} onPress={() => share(solpayUri)} accessibilityRole="button" accessibilityLabel="Share signed payment" accessibilityState={{disabled: false}}>
          <IconShare size={16} color={C.sub}/>
          <Text style={S.ghostBtnText}>{shared ? shareConfirmLabel('Copied ✓') : 'Share signed code'}</Text>
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
      {/* P3 — SVG mark (was a '⋯' text glyph): the SOL pay outcome is ALWAYS the honest pending
          hand-off, so the clock reads on the warn-tinted checkAlready circle. */}
      <View style={[S.check, S.checkAlready]}><IconClock size={44} color={C.brandInk}/></View>
      <Text testID="sol-pay-status" style={[S.paidText, S.alreadyText]}>{paidAmt ? `Sent ${paidAmt}` : 'Sent'}</Text>
      <Text style={S.paidSub}>{`${paidTo}awaiting the merchant's confirmation`}</Text>
      {/* Trip Ready J4 — the SOL paid phase is ALWAYS the honest pending hand-off, so the
          pendingOutcome truth applies on every visit until dismissed. Reading-zone mount (under
          the headline it explains). Same seen-key as IC. */}
      <CoachTip tipKey="pendingOutcome" />
      <Text style={S.dim2}>Your balance updates when the merchant settles this on-chain.</Text>
      <Pressable testID="btn-sol-pay-done" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel="New payment" accessibilityState={{disabled: false}}>
        <Text style={S.ghostBtnText}>New payment</Text>
      </Pressable>
    </View>
  );
}
