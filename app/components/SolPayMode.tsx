import {useEffect, useState} from 'react';
import {View, Text, Pressable, ActivityIndicator, Share} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {C} from '../config/palette';
import {S} from '../styles';
import {QR_SIZE, SOL_SEND_TIMEOUT_MS, SOL_BROADCAST_TIMEOUT_MS, IS_SOLANA_DEVNET} from '../config/constants';
import {fmtAsset} from '../lib/format';
import type {Identity} from '../lib/types';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {USDC_DECIMALS} from '../solana/spl';
import {decodeSolReq, type SolReq} from '../solana/qr';
import {isSolReqExpired} from '../solana/payments';
import {createNonceAccount, resyncNonce, signOfflineSolPayment, signOfflineSplPayment} from '../solana';
import {friendlySolError} from '../solana/errors';
import {loadSolNonce, saveSolNonce, type SolNonceState} from '../services/solNoncePersist';
import {DpaySolNfc} from '../services/native';
import {QrScanner} from './QrScanner';
import {SolNfcTap} from './SolNfcTap';
import {ModeToggle} from './ModeToggle';
import {SolanaWithdrawSheet} from './SolanaWithdrawSheet';
import {withTimeout} from '../lib/timeout';

/**
 * SolPayMode — the payer-side offline-pay component for the SOL durable-nonce rail.
 *
 * Rendered INLINE in the Pay tab body when SOL is the active asset (selected in Balances).
 * The payer scans a merchant's `solreq:` QR, reviews, and signs FULLY OFFLINE (no RPC needed — the
 * signature uses the stored durable-nonce value as the recentBlockhash). The signed `solpay:` QR is
 * shown for the merchant to scan + broadcast.
 *
 * The honest-pending UX mirrors the IC offline hand-off (PayMode.tsx phase='qr'): the payer can
 * NEVER claim "Paid ✓" from an offline sign — they mark "Handed to merchant" (pending) and the
 * nextNonce is adopted when the merchant relays it back (NFC, Phase E) or on a manual resync.
 *
 * First-use gate: the payer must create a nonce account once (online) before offline pay works.
 * The 'setup' phase handles this — createNonceAccount funds + initializes the durable-nonce
 * account on-chain and persists its address + initial value.
 *
 * NFC arming: this component mounts only while the SOL rail is selected. Switching the rail (via
 * switching the active asset unmounts it, whose `useNfcTapState` cleanup disarms the HCE card — no arm-leak.
 */
export function SolPayMode({identity, online, nfcReady, solBalance, onSent, subMode, onSubModeChange, onShowDeposit}: {identity: Identity; online: boolean; nfcReady: boolean; solBalance: string; onSent: () => void; subMode: 'scan' | 'send'; onSubModeChange: (m: 'scan' | 'send') => void; onShowDeposit?: () => void}) {
  const toggle = (
    <ModeToggle
      testID="pay-mode-toggle"
      value={subMode}
      onChange={(v) => onSubModeChange(v as 'scan' | 'send')}
      left={{label: 'Scan to pay', value: 'scan', testID: 'btn-pay-scan'}}
      right={{label: 'Send to address', value: 'send', testID: 'btn-pay-send'}}
    />
  );

  // "Send to address" sub-mode: render the on-chain SOL send flow INLINE (the SolanaWithdrawSheet
  // body). The toggle above lets the user flip back to "Scan to pay". `inline` skips the overlay
  // chrome. Mirrors the IC PayMode "Send to address" sub-mode byte-for-byte.
  if (subMode === 'send') {
    return (
      <View style={S.center}>
        {toggle}
        <SolanaWithdrawSheet
          identity={identity}
          balance={solBalance}
          inline
          onSent={onSent}
          onClose={() => onSubModeChange('scan')}
        />
      </View>
    );
  }

  const [phase, setPhase] = useState<'setup' | 'scan' | 'review' | 'qr' | 'paid'>('setup');
  const [nonceState, setNonceState] = useState<SolNonceState | null>(null);
  const [req, setReq] = useState<SolReq | null>(null);
  const [solpayUri, setSolpayUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A tap arriving on the always-armed card takes over the scan screen; nfcKey re-arms after each.
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);

  // Load the payer's nonce-account state on mount. If absent, stay in 'setup' (first-use gate).
  useEffect(() => {
    let alive = true;
    (async () => {
      const ns = await loadSolNonce(identity.publicHex);
      if (alive) {
        setNonceState(ns);
        setPhase(ns ? 'scan' : 'setup');
      }
    })();
    return () => { alive = false; };
  }, [identity.publicHex]);

  // First-use: create the durable-nonce account on-chain (online). This funds a nonce account at
  // SLIP-10 m/44'/501'/0'/1' (deterministic from the device seed), initializes it with the device
  // key as the authority, and reads back the initial nonce value to sign against offline.
  async function setupNonce() {
    setBusy(true); setErr(null);
    const {signal, cancel} = withTimeout(SOL_BROADCAST_TIMEOUT_MS);
    try {
      const {address, value} = await createNonceAccount(identity.secretHex, signal);
      const ns: SolNonceState = {address, value, status: 'ready'};
      await saveSolNonce(identity.publicHex, ns);
      setNonceState(ns);
      setPhase('scan');
    } catch (e: unknown) {
      setErr(friendlySolError(e instanceof Error ? e.message : String(e)));
    } finally {
      cancel();
      setBusy(false);
    }
  }

  // Scan the merchant's solreq: QR → decode → review. A1: enforce `exp` CLIENT-SIDE (the SOL rail
  // has no server to reject a stale request — unlike the IC canister — so a stale/replayed solreq is
  // fully signable unless we refuse it here, before signing).
  function onScan(raw: string) {
    try {
      const r = decodeSolReq(raw);
      if (isSolReqExpired(r)) {
        setReq(null);
        setErr('This payment request has expired. Ask the merchant for a fresh QR.');
        return;
      }
      setReq(r);
      setErr(null);
      setPhase('review');
    } catch (e: unknown) {
      setErr(`bad request QR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Approve → offline sign (PURE, no RPC) → show the signed solpay: QR.
  function approve() {
    if (!req || !nonceState || nonceState.status !== 'ready') return;
    setBusy(true);
    try {
      const uri = req.cur === 'SOL'
        ? signOfflineSolPayment(identity.secretHex, req, nonceState.address, nonceState.value)
        : signOfflineSplPayment(identity.secretHex, req, nonceState.address, nonceState.value);
      setSolpayUri(uri);
      setPhase('qr');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function reset() { setReq(null); setSolpayUri(null); setErr(null); setPhase('scan'); }

  // Resync the durable-nonce value after a stale/rejected broadcast. ONLINE — re-reads the on-chain
  // nonce value and flips the persisted state back to 'ready' so offline signing works again. Cheaper
  // than re-running setupNonce (which would create a NEW nonce account at fresh rent cost).
  async function resync() {
    const ns = nonceState;
    if (!ns || !ns.address || busy) return;
    setBusy(true); setErr(null);
    const {signal, cancel} = withTimeout(SOL_SEND_TIMEOUT_MS);
    try {
      const value = await resyncNonce(ns.address, signal);
      const updated: SolNonceState = {address: ns.address, value, status: 'ready'};
      setNonceState(updated);
      await saveSolNonce(identity.publicHex, updated);
    } catch (e: unknown) {
      setErr(friendlySolError(e instanceof Error ? e.message : String(e)));
    } finally {
      cancel();
      setBusy(false);
    }
  }

  // NFC card callbacks. onPaid: the merchant's settled receipt carried the advanced nonce — adopt it
  // optimistically (the receipt-nonce-relay win: the NEXT offline payment needs NO online resync) +
  // persist. onStale: the broadcast was rejected — mark the nonce stale so the next sign refuses.
  async function onNfcPaid(nextNonce: string) {
    const ns = nonceState;
    if (!ns || !nextNonce) return;
    const updated: SolNonceState = {address: ns.address, value: nextNonce, status: 'ready'};
    setNonceState(updated);
    await saveSolNonce(identity.publicHex, updated);
  }
  async function onNfcStale() {
    const ns = nonceState;
    if (!ns) return;
    const updated: SolNonceState = {address: ns.address, value: ns.value, status: 'stale'};
    setNonceState(updated);
    await saveSolNonce(identity.publicHex, updated);
  }

  const decimals = req?.cur === 'USDC' ? USDC_DECIMALS : SOL_DECIMALS;
  const unit = req?.cur === 'USDC' ? 'USDC' : SOL_UNIT;

  if (phase === 'setup') {
    return (
      <View style={S.center} testID="sol-pay-setup">
        {toggle}
        {IS_SOLANA_DEVNET ? (
          <View style={S.devnetBadge}>
            <View style={S.devnetBadgeDot} />
            <Text style={S.devnetBadgeText}>Devnet — not real SOL</Text>
          </View>
        ) : null}
        <Text style={S.label}>Set up offline pay</Text>
        <Text style={S.dim2}>Set up once so you can pay without a connection. This needs a brief connection and a small amount of SOL (~0.0015 SOL, recoverable).</Text>
        {err ? <Text testID="sol-pay-setup-err" style={S.err}>{err}</Text> : null}
        {/* A3 — unfunded escape hatch: the 0-SOL setup error points the user at their deposit
            address but offered no link to it. Surface it here so the dead-end has an exit. */}
        {onShowDeposit && err ? (
          <Pressable
            testID="sol-show-deposit"
            style={S.linkBtn}
            onPress={onShowDeposit}
            accessibilityRole="button"
            accessibilityLabel="Show my SOL address"
            accessibilityHint="Open the SOL receive sheet to fund your address"
            accessibilityState={{disabled: false}}>
            <Text style={S.linkText}>Show my SOL address</Text>
          </Pressable>
        ) : null}
        {busy ? (
          <>
            <ActivityIndicator color={C.brand} />
            <Text style={S.dim2}>Creating nonce account…</Text>
          </>
        ) : (
          <Pressable
            testID="btn-sol-pay-setup"
            style={[S.primaryWide, !online && S.dim]}
            disabled={!online}
            onPress={setupNonce}
            accessibilityRole="button"
            accessibilityLabel="Set up offline pay"
            accessibilityHint="Create a durable-nonce account so you can sign payments offline"
            accessibilityState={{disabled: !online}}>
            <Text style={S.primaryText}>{online ? 'Set up offline pay' : 'Go online to set up'}</Text>
          </Pressable>
        )}
        {/* No Cancel button: the user switches the active asset in Balances, not a per-phase cancel. */}
      </View>
    );
  }

  if (phase === 'scan') {
    return (
      <View style={S.center}>
        {toggle}
        {IS_SOLANA_DEVNET ? (
          <View style={S.devnetBadge}>
            <View style={S.devnetBadgeDot} />
            <Text style={S.devnetBadgeText}>Devnet — not real SOL</Text>
          </View>
        ) : null}
        {/* NFC card runs in the background (if ready + a live nonce) while the QR scanner is
            live at the same time — the payer taps the merchant's phone OR scans its QR. */}
        {nfcReady && DpaySolNfc && nonceState?.status === 'ready' ? (
          <SolNfcTap
            key={nfcKey} role="card" identity={identity} nonceState={nonceState}
            onPaid={onNfcPaid} onStale={onNfcStale}
            onClose={() => { setNfcActive(false); setNfcKey(k => k + 1); }}
          />
        ) : null}
        {!nfcActive ? (
          <>
            {nonceState?.status === 'stale' ? (
              <View testID="sol-pay-stale" style={S.reviewCard}>
                <Text style={S.reviewLabel}>Offline pay needs a resync</Text>
                <Text style={S.warnNote}>A recent payment couldn't be confirmed, so offline pay needs a refresh. {online ? 'Resync to keep paying offline.' : 'Go online and resync to keep paying offline.'}</Text>
                {err ? <Text testID="sol-pay-stale-err" style={S.err}>{err}</Text> : null}
                {/* A3 — escape hatch on the stale-nonce dead-end too. */}
                {onShowDeposit ? (
                  <Pressable
                    testID="sol-show-deposit"
                    style={S.linkBtn}
                    onPress={onShowDeposit}
                    accessibilityRole="button"
                    accessibilityLabel="Show my SOL address"
                    accessibilityHint="Open the SOL receive sheet to fund your address"
                    accessibilityState={{disabled: false}}>
                    <Text style={S.linkText}>Show my SOL address</Text>
                  </Pressable>
                ) : null}
                {busy ? (
                  <>
                    <ActivityIndicator color={C.brand} />
                    <Text style={S.dim2}>Resyncing…</Text>
                  </>
                ) : (
                  <Pressable
                    testID="btn-sol-pay-resync"
                    style={[S.primaryWide, !online && S.dim]}
                    disabled={!online}
                    onPress={resync}
                    accessibilityRole="button"
                    accessibilityLabel="Resync offline pay"
                    accessibilityHint="Re-read the current on-chain nonce value so you can sign offline again"
                    accessibilityState={{disabled: !online}}>
                    <Text style={S.primaryText}>{online ? 'Resync' : 'Go online to resync'}</Text>
                  </Pressable>
                )}
              </View>
            ) : null}
            <View testID="sol-pay-scan">
              <Text style={S.dim2}>Scan the merchant's payment code to pay offline.</Text>
              <QrScanner onScan={onScan} />
            </View>
            {err ? <Text style={S.err}>{err}</Text> : null}
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
          style={[S.primaryWide, busy && S.dim]}
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

  // phase === 'paid'
  return (
    <View style={S.center}>
      {toggle}
      <View style={[S.check, S.checkAlready]}><Text style={S.checkMark}>⋯</Text></View>
      <Text testID="sol-pay-status" style={[S.paidText, S.alreadyText]}>{`Sent ${fmtAsset(req!.amt, decimals, unit)}`}</Text>
      <Text style={S.paidSub}>{`to ${req!.name || req!.to} · awaiting the merchant's confirmation`}</Text>
      <Text style={S.dim2}>Your balance updates when the merchant settles this. Come back online to resync your offline-pay state.</Text>
      <Pressable testID="btn-sol-pay-done" style={S.linkBtn} onPress={reset} accessibilityRole="button" accessibilityLabel="New payment" accessibilityState={{disabled: false}}>
        <Text style={S.linkText}>New payment</Text>
      </Pressable>
    </View>
  );
}
