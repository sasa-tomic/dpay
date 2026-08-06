import {useEffect, useState} from 'react';
import {View, Text, Pressable, ScrollView, SafeAreaView, StatusBar, ActivityIndicator, Platform, Share} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {C} from '../config/palette';
import {S} from '../styles';
import {QR_SIZE, SOL_SEND_TIMEOUT_MS} from '../config/constants';
import {fmtAsset} from '../lib/format';
import type {Identity} from '../lib/types';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {USDC_DECIMALS} from '../solana/spl';
import {decodeSolReq, type SolReq} from '../solana/qr';
import {createNonceAccount, resyncNonce, signOfflineSolPayment, signOfflineSplPayment} from '../solana';
import {loadSolNonce, saveSolNonce, type SolNonceState} from '../services/solNoncePersist';
import {DpaySolNfc} from '../services/native';
import {QrScanner} from './QrScanner';
import {SolNfcTap} from './SolNfcTap';
import {useEscapeToClose} from '../hooks/useHotkeys';

/**
 * SolPayMode — the payer-side offline-pay sheet for the SOL durable-nonce rail.
 *
 * Reached from the Balances sheet's SOL card. The payer scans a merchant's `solreq:` QR, reviews,
 * and signs FULLY OFFLINE (no RPC needed — the signature uses the stored durable-nonce value as
 * the recentBlockhash). The signed `solpay:` QR is shown for the merchant to scan + broadcast.
 *
 * The honest-pending UX mirrors the IC offline hand-off (PayMode.tsx phase='qr'): the payer can
 * NEVER claim "Paid ✓" from an offline sign — they mark "Handed to merchant" (pending) and the
 * nextNonce is adopted when the merchant relays it back (NFC, Phase E) or on a manual resync.
 *
 * First-use gate: the payer must create a nonce account once (online) before offline pay works.
 * The 'setup' phase handles this — createNonceAccount funds + initializes the durable-nonce
 * account on-chain and persists its address + initial value.
 */
export function SolPayMode({identity, online, nfcReady, onClose}: {identity: Identity; online: boolean; nfcReady: boolean; onClose: () => void}) {
  const [phase, setPhase] = useState<'setup' | 'scan' | 'review' | 'qr' | 'paid'>('setup');
  const [nonceState, setNonceState] = useState<SolNonceState | null>(null);
  const [req, setReq] = useState<SolReq | null>(null);
  const [solpayUri, setSolpayUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A tap arriving on the always-armed card takes over the scan screen; nfcKey re-arms after each.
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);

  useEscapeToClose(onClose);

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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SOL_SEND_TIMEOUT_MS * 2);
    try {
      const {address, value} = await createNonceAccount(identity.secretHex, ctrl.signal);
      const ns: SolNonceState = {address, value, status: 'ready'};
      await saveSolNonce(identity.publicHex, ns);
      setNonceState(ns);
      setPhase('scan');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  }

  // Scan the merchant's solreq: QR → decode → review.
  function onScan(raw: string) {
    try {
      const r = decodeSolReq(raw);
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SOL_SEND_TIMEOUT_MS);
    try {
      const value = await resyncNonce(ns.address, ctrl.signal);
      const updated: SolNonceState = {address: ns.address, value, status: 'ready'};
      setNonceState(updated);
      await saveSolNonce(identity.publicHex, updated);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
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

  return (
    <View style={S.sheetOverlay}>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>Pay SOL offline</Text>
          <Pressable testID="btn-sol-pay-close" accessibilityRole="button" accessibilityLabel="Close offline pay" style={S.sheetClose} onPress={onClose}>
            <Text style={S.sheetCloseX}>✕</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={S.sheetBody} keyboardShouldPersistTaps="handled">
          {phase === 'setup' ? (
            <View style={S.centerAll} testID="sol-pay-setup">
              <Text style={S.label}>Set up offline pay</Text>
              <Text style={S.dim2}>Offline pay needs a one-time setup: it creates a durable-nonce account on Solana so you can sign payments without being online. This requires a connection + a small amount of SOL for rent (~0.0015 SOL, recoverable).</Text>
              {err ? <Text testID="sol-pay-setup-err" style={S.err}>{err}</Text> : null}
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
              <Pressable style={S.linkBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel="Cancel" accessibilityState={{disabled: false}}>
                <Text style={S.linkTextMuted}>Cancel</Text>
              </Pressable>
            </View>
          ) : phase === 'scan' ? (
            <>
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
                      <Text style={S.warnNote}>Your nonce was marked stale after a failed broadcast. {online ? 'Resync to use offline pay again.' : 'Go online and resync to use offline pay again.'}</Text>
                      {err ? <Text testID="sol-pay-stale-err" style={S.err}>{err}</Text> : null}
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
            </>
          ) : phase === 'review' && req ? (
            <View style={S.centerAll}>
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
          ) : phase === 'qr' && solpayUri ? (
            <View style={S.centerAll}>
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
          ) : phase === 'paid' ? (
            <View style={S.centerAll}>
              <View style={[S.check, S.checkAlready]}><Text style={S.checkMark}>⋯</Text></View>
              <Text testID="sol-pay-status" style={[S.paidText, S.alreadyText]}>{`Sent ${fmtAsset(req!.amt, decimals, unit)}`}</Text>
              <Text style={S.paidSub}>{`to ${req!.name || req!.to} · awaiting the merchant's confirmation`}</Text>
              <Text style={S.dim2}>Your balance updates when the merchant settles this. Come back online to resync your offline-pay state.</Text>
              <Pressable testID="btn-sol-pay-done" style={S.linkBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel="Done" accessibilityState={{disabled: false}}>
                <Text style={S.linkText}>Done</Text>
              </Pressable>
            </View>
          ) : null}
          {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
