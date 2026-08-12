import {useState, useEffect} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, type TextStyle} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {C} from '../config/palette';
import {S} from '../styles';
import {QR_SIZE_SMALL, SOL_BROADCAST_TIMEOUT_MS, SOL_ATA_CHECK_TIMEOUT_MS, IS_SOLANA_DEVNET, EXPIRY_WINDOW} from '../config/constants';
import {fmtAsset, toUnits} from '../lib/format';
import {type SelectableAsset} from '../config/assets';
import {type BalanceView} from '../lib/assetBalances';
import type {Identity, AssetId} from '../lib/types';
import bs58 from 'bs58';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {USDC_DECIMALS, USDC_MINT_ADDRESS, deriveAta} from '../solana/spl';
import {encodeSolReq, decodeSolPay, type SolReq} from '../solana/qr_v1';
import {decideUsdcAtaGate, type UsdcAtaStatus} from '../solana/payments';
import {solpayMatchesReq} from '../solana/payments_v1';
import {verifySignedTransaction} from '../solana/tx';
import {deriveSolanaAddress, broadcastSolPayment, checkUsdcAta} from '../solana';
import {friendlySolError} from '../solana/errors';
import {RECEIPT_SETTLED, RECEIPT_REJECTED} from '../payments';
import {DpaySolNfc} from '../services/native';
import {QrScanner} from './QrScanner';
import {SolNfcTap} from './SolNfcTap';
import {ModeToggle} from './ModeToggle';
import {SolanaReceiveSheet} from './SolanaReceiveSheet';
import {AssetPicker} from './AssetPicker';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {useReportLock} from '../hooks/useReportLock';
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
export function SolReceiveMode({identity, online, nfcReady, solAddress, subMode, onSubModeChange, selectedToken, assets, selectedAssetId, balances, onSelectAsset, onLockChange}: {identity: Identity; online: boolean; nfcReady: boolean; solAddress: string; subMode: 'request' | 'address'; onSubModeChange: (m: 'request' | 'address') => void; selectedToken: 'SOL' | 'USDC'; assets: SelectableAsset[]; selectedAssetId: AssetId | null; balances: Record<AssetId, BalanceView>; onSelectAsset: (id: AssetId) => void; onLockChange?: (locked: boolean) => void}) {
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [phase, setPhase] = useState<'form' | 'reqQr' | 'result'>('form');
  const [reqUri, setReqUri] = useState<string | null>(null);
  const [reqSnapshot, setReqSnapshot] = useState<SolReq | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{amount: string; cur: 'SOL' | 'USDC'; sig: string | null} | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const {copied, copy: doCopy} = useCopyFeedback();
  // A 1s display clock so the request-QR screen shows a live expiry countdown (mirrors the IC rail's
  // ReceiveMode). A stale solreq scans to a confusing payer-side rejection (SolPayMode enforces exp),
  // so the merchant is told how long the QR is good for and prompted to refresh before it expires.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  // A tap taking over while the QR is shown; nfcKey re-starts the reader after each.
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);

  // Phase 5 — lock the idle asset selection while a SOL request QR is showing or a result is
  // displayed (phase !== 'form'). The idle form is free.
  const locked = phase !== 'form';
  useReportLock(onLockChange, locked);
  // The unified asset picker (opened by tapping the SOL/USDC prefix). Phase 4: replaced the old
  // binary SOL↔USDC toggle prefix — the prefix now opens AssetPicker (same picker ReceiveMode +
  // Balances use), whose onSelect is Wallet's handleSelect. SOL↔USDC within the Solana rail stays
  // same-form (no unmount) so the amount is cleared inline before the dispatch.
  const [pickOpen, setPickOpen] = useState(false);

  const decimals = selectedToken === 'SOL' ? SOL_DECIMALS : USDC_DECIMALS;
  const unit = selectedToken === 'SOL' ? SOL_UNIT : 'USDC';

  // Tick the display clock only while a request QR is shown (not after settlement). Display-only, so
  // a plain setInterval (not a network poll seam) is the right cadence for a countdown.
  useEffect(() => {
    if (phase !== 'reqQr' || !reqSnapshot || result) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase, reqSnapshot, result]);

  // F4 (Phase 4) — USDC ATA existence gate, now FAIL-CLOSED. USDC offline-pay needs the device's
  // ATA to pre-exist on-chain (the merchant's `toAta` is encoded in the request); without it the
  // request is unfulfillable and the broadcast fails opaquely. Check ONLY when USDC is selected AND
  // online (SOL needs no ATA; offline the button is already disabled by the relay-offline gate).
  //
  // The fail-closed change (plan line ~272): the previous code let 'unknown' (offline / probe-threw
  // / RPC-failure) FALL THROUGH TO ALLOW, leaking an unfulfillable request. Now EVERY non-'present'
  // state BLOCKS Request via decideUsdcAtaGate (pure helper), with honest copy + a retry affordance
  // for the 'unknown' case. The retry bumps `ataCheckTick` to re-fire this effect (a fresh probe may
  // succeed on a transient RPC failure). 'absent' is NOT retryable (the user must set up the ATA
  // out-of-band); 'checking' briefly disables while the probe is in flight.
  const [usdcAta, setUsdcAta] = useState<UsdcAtaStatus>('unknown');
  const [ataCheckTick, setAtaCheckTick] = useState(0);
  useEffect(() => {
    if (selectedToken !== 'USDC' || !online) { setUsdcAta('unknown'); return; }
    let alive = true;
    setUsdcAta('checking');
    const {signal, cancel} = withTimeout(SOL_ATA_CHECK_TIMEOUT_MS);
    (async () => {
      try {
        const exists = await checkUsdcAta(identity.secretHex, signal);
        if (alive) setUsdcAta(exists === true ? 'present' : exists === false ? 'absent' : 'unknown');
      } catch (e: unknown) {
        console.warn('SolReceiveMode: USDC ATA check failed', e);
        if (alive) setUsdcAta('unknown');
      } finally {
        cancel();
      }
    })();
    return () => { alive = false; cancel(); };
    // ataCheckTick is the retry affordance: tapping the "Couldn't verify — retry" button bumps it to
    // re-fire the effect (a fresh probe). selectedToken replaces the deleted `cur` as the gate input.
  }, [selectedToken, online, identity.secretHex, ataCheckTick]);

  const toggle = (
    <ModeToggle
      testID="receive-mode-toggle"
      value={subMode}
      onChange={(v) => onSubModeChange(v as 'request' | 'address')}
      left={{label: 'Request payment', value: 'request', testID: 'btn-receive-request'}}
      right={{label: 'My address', value: 'address', testID: 'btn-receive-address'}}
    />
  );

  // "My address" sub-mode: render the SOL/USDC deposit-address flow INLINE (SolanaReceiveSheet body).
  // The toggle above lets the user flip back to "Request payment". The sheet is inline-only (no
  // overlay chrome — the tab body provides the surface). Mirrors the IC ReceiveMode "My address"
  // sub-mode. Sits BELOW the useState/useEffect so React's Rules of Hooks hold across sub-mode flips
  // (the merchant's amount/memo/form state survives a My-address detour without re-mounting).
  //
  // Phase 4 — asset-aware: when `selectedToken === 'USDC'`, the displayed address is the device's
  // DERIVED USDC ATA (via deriveAta(solAddress, USDC_MINT_ADDRESS)), and the sheet is gated by ATA
  // readiness — sending USDC to a non-existent ATA is unfulfillable, so when usdcAta !== 'present'
  // the sheet shows a "set up your USDC account" message instead of the address QR. Native SOL is
  // unaffected (the device key IS the account; no ATA prerequisite).
  if (subMode === 'address') {
    const usdcAtaAddress = selectedToken === 'USDC' ? bs58.encode(deriveAta(solAddress, USDC_MINT_ADDRESS)) : solAddress;
    return (
      <View style={S.center}>
        {toggle}
        <SolanaReceiveSheet
          address={usdcAtaAddress}
          token={selectedToken}
          ataReady={selectedToken === 'SOL' ? true : usdcAta === 'present'}
          onClose={() => onSubModeChange('request')}
        />
      </View>
    );
  }

  // Build the solreq: QR. Derives the merchant's SOL address (or their USDC ATA) for the `to`/`toAta`.
  function makeRequest() {
    const raw = toUnits(amount, decimals);
    if (!raw || raw === '0') return;
    try {
      const addr = deriveSolanaAddress(identity.secretHex);
      const exp = Math.floor(Date.now() / 1000) + EXPIRY_WINDOW;
      const reqInput = selectedToken === 'SOL'
        ? {to: addr, amt: raw, cur: 'SOL' as const, mint: null, toAta: null, exp, name: identity.username, memo: memo.trim()}
        : {to: addr, amt: raw, cur: 'USDC' as const, mint: USDC_MINT_ADDRESS,         toAta: bs58.encode(deriveAta(addr, USDC_MINT_ADDRESS)), exp, name: identity.username, memo: memo.trim()};
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

  // Scan the payer's signed solpay: QR → broadcast → confirm. A2: BEFORE broadcasting, assert the
  // solpay matches the open solreq (to/cur/amt). `reqSnapshot` was captured at makeRequest time but
  // previously used only for display — a cheating payer could otherwise broadcast a mismatched amount
  // and the merchant would surface the payer's claimed amount as "Received".
  async function onSignedQr(raw: string) {
    setScanning(false);
    setBusy(true);
    setErr(null);
    const {signal, cancel} = withTimeout(SOL_BROADCAST_TIMEOUT_MS);
    try {
      const solpay = decodeSolPay(raw);
      if (!reqSnapshot || !solpayMatchesReq(solpay, reqSnapshot)) {
        setErr("Payment doesn't match this request. Ask the payer to scan your request QR again.");
        return;
      }
      if (!verifySignedTransaction(solpay.tx)) {
        console.warn('SolReceiveMode: payer signature failed pre-broadcast verify (defense-in-depth; still attempting broadcast)', {npub: solpay.npub, txLen: solpay.tx.length});
      }
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
    if (result?.sig) { await doCopy(result.sig); }
  };

  if (phase === 'result' && result && !nfcActive) {
    return (
      <View style={S.center}>
        {toggle}
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
        {toggle}
        {IS_SOLANA_DEVNET ? (
          <View style={S.devnetBadge}>
            <View style={S.devnetBadgeDot} />
            <Text style={S.devnetBadgeText}>Devnet — not real SOL</Text>
          </View>
        ) : null}
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
                {/* A1 — live expiry countdown (mirrors ReceiveMode). A stale solreq scans to a
                    confusing payer-side rejection, so the merchant knows when to refresh. */}
                {(() => {
                  const remaining = (reqSnapshot?.exp ?? 0) - now;
                  if (remaining <= 0) return <Text style={S.qrExpired}>Expired — make a new request</Text>;
                  const m = Math.floor(remaining / 60);
                  const s = remaining % 60;
                  if (m >= 1) return <Text style={S.qrExpiry}>Valid for ~{m} min</Text>;
                  return <Text style={S.qrExpiryWarn}>Expires in 0:{s.toString().padStart(2, '0')}</Text>;
                })()}
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
      {toggle}
      {IS_SOLANA_DEVNET ? (
        <View style={S.devnetBadge}>
          <View style={S.devnetBadgeDot} />
          <Text style={S.devnetBadgeText}>Devnet — not real SOL</Text>
        </View>
      ) : null}
      <Text style={S.label}>Amount to receive</Text>
      <View style={S.amountRow}>
        {/* Phase 4: the prefix opens the unified AssetPicker (replaces the old binary SOL↔USDC
            toggle). The testID `sol-req-prefix` STAYS so e2e flows (45/51/62/69) still find it;
            the difference is what tapping it does — opens the picker instead of toggling inline. */}
        <Pressable
          testID="sol-req-prefix"
          style={S.prefixBtn}
          onPress={() => setPickOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Receive in ${selectedToken}`}
          accessibilityHint="Choose which asset the payer will send you"
          accessibilityState={{disabled: false}}>
          <Text style={S.currency}>{selectedToken === 'SOL' ? '◎' : '$'}</Text>
          <Text style={S.caret}>{selectedToken === 'SOL' ? 'SOL' : 'USDC'} ▾</Text>
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
      {(() => {
        // F4 fail-closed gate (pure helper). Only meaningful when USDC is selected (SOL needs no ATA);
        // for SOL the gate returns allowed:true unconditionally (usdcAta stays 'unknown' but is never
        // consulted). The decision drives the inline copy + the Request button's disabled state.
        if (selectedToken !== 'USDC') return null;
        const gate = decideUsdcAtaGate(usdcAta, online);
        if (gate.allowed) return null;
        if (gate.reason === 'checking') return <Text style={S.dim2}>{gate.message}</Text>;
        // The 'absent' / 'unverified' / 'offline' reasons carry a sol-usdc-ata-warn testID so the
        // e2e net (flow 62 / 69) finds the blocking message regardless of which fail-closed branch
        // fired — the contract is "Request is blocked + a USDC warning is shown", not a specific copy.
        return (
          <View>
            <Text testID="sol-usdc-ata-warn" style={S.warnNote}>{gate.message}</Text>
            {gate.retryable ? (
              <Pressable
                testID="btn-sol-usdc-ata-retry"
                style={S.linkBtn}
                onPress={() => setAtaCheckTick(t => t + 1)}
                accessibilityRole="button"
                accessibilityLabel="Retry USDC account check"
                accessibilityState={{disabled: false}}>
                <Text style={S.linkText}>Retry</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })()}
      {err ? <Text style={S.err}>{err}</Text> : null}
      {(() => {
        // The Request button's disabled state derives from the SAME fail-closed gate as the copy —
        // so the inline message + the button stay consistent (no "blocked copy but enabled button").
        // The `!usdcGate.allowed` narrowing gives us access to `.reason` on the blocked variant.
        const usdcGate = selectedToken === 'USDC' ? decideUsdcAtaGate(usdcAta, online) : null;
        const blockedReason = usdcGate !== null && !usdcGate.allowed ? usdcGate.reason : null;
        const blocked = !online || blockedReason !== null;
        const checking = blockedReason === 'checking';
        return (
          <Pressable
            testID="btn-sol-req-make"
            style={[S.primaryWide, blocked && S.dim]}
            disabled={blocked}
            onPress={makeRequest}
            accessibilityRole="button"
            accessibilityLabel="Request"
            accessibilityHint={blockedReason === 'absent' ? 'No USDC account on this device — set one up online first' : 'Show your QR code so the payer can scan it to pay you'}
            accessibilityState={{disabled: blocked}}>
            <Text style={S.primaryText}>{checking ? 'Checking…' : 'Request'}</Text>
          </Pressable>
        );
      })()}
      <AssetPicker
        open={pickOpen}
        assets={assets}
        selectedId={selectedAssetId}
        balances={balances}
        onSelect={(id) => { setAmount(''); onSelectAsset(id); }}
        onClose={() => setPickOpen(false)}
      />
    </View>
  );
}
