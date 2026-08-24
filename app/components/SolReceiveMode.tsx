import {useState, useEffect, useRef} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, type TextStyle} from 'react-native';
import {QrCode} from './QrCode';
import bs58 from 'bs58';
import {C, FONT} from '../config/palette';
import {S} from '../styles';
import {QR_SIZE_SMALL, SOL_BROADCAST_TIMEOUT_MS} from '../config/constants';
import {fmtAsset, toUnits} from '../lib/format';
import {bytesToBase64Url, base64UrlToBytes} from '../lib/base64';
import {type SelectableAsset} from '../config/assets';
import {type BalanceView} from '../lib/assetBalances';
import type {Identity, AssetId} from '../lib/types';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {USDC_DECIMALS, USDC_MINT_ADDRESS, deriveAta, SOL_ATA_SETUP_MIN_LAMPORTS} from '../solana/spl';
import {decodeSolPay} from '../solana/qr';
import type {SolReqV2, SolPayV2} from '../solana/qr';
import {isSolReqV2Expired, RECEIPT_SETTLED, RECEIPT_REJECTED} from '../solana/payments';
import {extractSignedTxParts} from '../solana/tx';
import {createSolPaymentRequest, broadcastSolPayment, isSolanaRpcAvailable} from '../solana';
import {friendlySolError} from '../solana/errors';
import {loadSolMerchantState, saveSolMerchantState, clearSolMerchantState} from '../services/solMerchantPersist';
import {type SolUsdcStatus} from '../hooks/useSolanaBalances';
import {DpaySolNfc} from '../services/native';
import {withTimeout} from '../lib/timeout';
import {QrScanner} from './QrScanner';
import {SolNfcTap} from './SolNfcTap';
import {ModeToggle} from './ModeToggle';
import {SolanaReceiveSheet} from './SolanaReceiveSheet';
import {SolanaAtaSetupCard} from './SolanaAtaSetupCard';
import {AssetPicker} from './AssetPicker';
import {useJourney} from '../lib/journey';
import {awardPaymentTested} from '../lib/readiness';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {useReportLock} from '../hooks/useReportLock';
import {IconCheck, IconChevronDown, IconClock, IconCopy, IconQr} from './icons';
import {CoachTip} from './CoachTip';

// Twin of ReceiveMode's memoInputStyle — Traveler Paper input idiom (white field, hairline border,
// Space Grotesk), kept inline + identical so the IC and SOL Receive forms stay pixel-twins.
const memoInputStyle: TextStyle = {alignSelf: 'stretch', marginTop: 14, minHeight: 44, backgroundColor: C.card, borderWidth: 1, borderColor: C.line2, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: C.ink, fontFamily: FONT.sans};

/**
 * SolReceiveMode — the merchant-side payment component for the v2 recent-blockhash SOL rail.
 *
 * Rendered INLINE in the Receive tab body when SOL is the active asset (selected in Balances).
 * The merchant builds a `solreq:v2:` QR (ONLINE — fetches genesis hash + fresh blockhash), the payer
 * scans it + signs offline (SolPayMode), then the merchant scans the payer's `solpay:v2:` QR and
 * broadcasts it online (broadcastSolPayment — strict verify + freshness + confirm). On success, the
 * merchant sees the received amount + the tx signature.
 *
 * Durable state: the open request + any atomically-reserved accepted tx are persisted to AsyncStorage
 * (solMerchantPersist) so a kill/restart mid-flow can reconcile (invariants #10/#11/#12). On mount,
 * the component loads any saved state and restores/repairs accordingly.
 *
 * Mirrors ReceiveMode.tsx's form → reqQr → result phase machine, but settles directly on Solana
 * (no relay, no /receipt poll — `confirmTransaction` is the source of truth).
 */
export function SolReceiveMode({identity, nfcReady, solAddress, subMode, onSubModeChange, selectedToken, assets, selectedAssetId, balances, onSelectAsset, usdcAtaStatus = 'balance', usdcAmount = null, solBalance = null, solOk = false, ataSetupBusy = false, ataSetupErr = null, onCreateAta, onShowSolAddress, onRefreshUsdc, onRefreshSol, depositReturnLabel, onReturnFromDeposit, onLockChange}: {identity: Identity; nfcReady: boolean; solAddress: string; subMode: 'request' | 'address'; onSubModeChange: (m: 'request' | 'address') => void; selectedToken: 'SOL' | 'USDC'; assets: SelectableAsset[]; selectedAssetId: AssetId | null; balances: Record<AssetId, BalanceView>; onSelectAsset: (id: AssetId) => void; usdcAtaStatus?: SolUsdcStatus; usdcAmount?: string | null; solBalance?: string | null; solOk?: boolean; ataSetupBusy?: boolean; ataSetupErr?: string | null; onCreateAta?: () => void; onShowSolAddress?: () => void; onRefreshUsdc?: () => void; onRefreshSol?: () => void;   depositReturnLabel?: string | null;
  onReturnFromDeposit?: () => void;
  onLockChange?: (locked: boolean) => void}) {
  const solRpc = isSolanaRpcAvailable();
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [phase, setPhase] = useState<'form' | 'reqQr' | 'result'>('form');
  // Trip Ready J5b — paymentTested: awarded once at the FIRST confirmed SOL Received (the three
  // confirmed setResult branches only — never the honest-pending UNREACHABLE paths).
  const {journey} = useJourney();
  const journeyRef = useRef(journey);
  journeyRef.current = journey;
  const [reqUri, setReqUri] = useState<string | null>(null);
  const [reqSnapshot, setReqSnapshot] = useState<SolReqV2 | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{amount: string; cur: 'SOL' | 'USDC'; sig: string | null} | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const {copied, copy: doCopy} = useCopyFeedback();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);
  // Reconciliation state — when a broadcast was interrupted (outcome 'broadcasting'/'unknown' in
  // persist), the accepted tx is preserved so the merchant can retry. null when not reconciling.
  const [reconcile, setReconcile] = useState<{acceptedSig: string; acceptedTx: string} | null>(null);

  const locked = phase !== 'form';
  useReportLock(onLockChange, locked);
  const [pickOpen, setPickOpen] = useState(false);

  const decimals = selectedToken === 'SOL' ? SOL_DECIMALS : USDC_DECIMALS;
  const unit = selectedToken === 'SOL' ? SOL_UNIT : 'USDC';

  // Display clock — ticks 1s while a request QR is showing (for the expiry countdown).
  useEffect(() => {
    if (phase !== 'reqQr' || !reqSnapshot || result) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase, reqSnapshot, result]);

  // Mount reconciliation (invariant #12): load any saved merchant state and restore/repair.
  useEffect(() => {
    let alive = true;
    (async () => {
      const state = await loadSolMerchantState(identity.publicHex);
      if (!alive || !state) return;
      if (state.outcome === 'open' && !isSolReqV2Expired(state.req)) {
        setReqSnapshot(state.req);
        setReqUri(state.uri);
        setResult(null);
        setPhase('reqQr');
      } else if ((state.outcome === 'broadcasting' || state.outcome === 'unknown') && state.acceptedTx && state.acceptedSignature) {
        setReqSnapshot(state.req);
        setReqUri(state.uri);
        setReconcile({acceptedSig: state.acceptedSignature, acceptedTx: state.acceptedTx});
        setPhase('reqQr');
      } else {
        // settled / rejected / expired-open — clear + start fresh.
        await clearSolMerchantState(identity.publicHex);
      }
    })();
    return () => { alive = false; };
  }, [identity.publicHex]);

  const toggle = (
    <ModeToggle
      testID="receive-mode-toggle"
      value={subMode}
      onChange={(v) => onSubModeChange(v as 'request' | 'address')}
      left={{label: 'Request payment', value: 'request', testID: 'btn-receive-request'}}
      right={{label: 'My address', value: 'address', testID: 'btn-receive-address'}}
    />
  );

  if (subMode === 'address') {
    const usdcAtaAddress = selectedToken === 'USDC' ? bs58.encode(deriveAta(solAddress, USDC_MINT_ADDRESS)) : solAddress;
    // Map the USDC poll status onto the sheet's tri-state gate (2026-08-14 audit): only a KNOWN
    // balance shows the QR; only KNOWN absence shows the setup card. checking/unverified never
    // claim absence — fail-closed without a false "you don't have one" message.
    const ataState = selectedToken !== 'USDC'
      ? 'ready'
      : usdcAtaStatus === 'balance' ? 'ready'
      : usdcAtaStatus === 'absent' ? 'absent'
      : usdcAtaStatus === 'loading' ? 'checking'
      : 'unverified';
    return (
      <View style={S.center}>
        {toggle}
        <SolanaReceiveSheet
          address={usdcAtaAddress}
          token={selectedToken}
          ataStatus={ataState}
          solBalance={solBalance}
          tokenZero={(selectedToken === 'SOL' && solOk && solBalance === '0') || (selectedToken === 'USDC' && usdcAtaStatus === 'balance' && (usdcAmount ?? null) === '0')}
          ataSetupBusy={ataSetupBusy}
          ataSetupErr={ataSetupErr}
          onCreateAta={onCreateAta}
          onShowSolAddress={onShowSolAddress}
          onRetryAta={selectedToken === 'USDC' ? onRefreshUsdc : onRefreshSol}
          returnLabel={depositReturnLabel}
          onReturn={onReturnFromDeposit}
          onClose={() => onSubModeChange('request')}
        />
      </View>
    );
  }

  // Build the solreq:v2: QR. ONLINE — createSolPaymentRequest fetches genesis hash + a fresh
  // blockhash and builds a SolReqV2 with a ~90s validity window. The request is persisted BEFORE the
  // QR is shown (invariant #10: persist before send).
  async function makeRequest() {
    const raw = toUnits(amount, decimals);
    if (!raw || raw === '0') return;
    setBusy(true); setErr(null);
    const {signal, cancel} = withTimeout(SOL_BROADCAST_TIMEOUT_MS);
    try {
      const input = selectedToken === 'SOL'
        ? {to: solAddress, amt: raw, cur: 'SOL' as const, mint: null, toAta: null, name: identity.username, memo: memo.trim()}
        : {to: solAddress, amt: raw, cur: 'USDC' as const, mint: USDC_MINT_ADDRESS, toAta: bs58.encode(deriveAta(solAddress, USDC_MINT_ADDRESS)), name: identity.username, memo: memo.trim()};
      const {request, uri} = await createSolPaymentRequest(input, signal);
      setReqSnapshot(request);
      setReqUri(uri);
      setResult(null);
      setReconcile(null);
      setErr(null);
      // Persist BEFORE the QR is visible (invariant #10).
      await saveSolMerchantState(identity.publicHex, {req: request, uri, acceptedSignature: null, acceptedTx: null, outcome: 'open'});
      setPhase('reqQr');
    } catch (e: unknown) {
      setErr(friendlySolError(e instanceof Error ? e.message : String(e)));
    } finally {
      cancel();
      setBusy(false);
    }
  }

  // Scan the payer's signed solpay:v2: QR → reserve atomically → broadcast → confirm. The atomic
  // reservation (invariant #11) persists the accepted tx BEFORE the first network send so a
  // kill/restart can rebroadcast. broadcastSolPayment does strict canonical-verify + freshness +
  // signature-verify internally (no separate pre-check needed).
  async function onSignedQr(raw: string) {
    setScanning(false);
    if (!reqSnapshot || !reqUri) { setErr('No open request.'); return; }
    setBusy(true);
    setErr(null);
    const {signal, cancel} = withTimeout(SOL_BROADCAST_TIMEOUT_MS);
    try {
      const solpay = decodeSolPay(raw);
      // Atomically reserve BEFORE the first network send (invariant #11).
      const parts = extractSignedTxParts(solpay.tx);
      const acceptedSig = parts ? bs58.encode(parts.signature) : '';
      const acceptedTxStr = bytesToBase64Url(solpay.tx);
      await saveSolMerchantState(identity.publicHex, {req: reqSnapshot, uri: reqUri, acceptedSignature: acceptedSig, acceptedTx: acceptedTxStr, outcome: 'broadcasting'});
      const receipt = await broadcastSolPayment(reqSnapshot, reqUri, solpay, signal);
      if (receipt.status === RECEIPT_SETTLED) {
        setResult({amount: reqSnapshot.amt, cur: reqSnapshot.cur, sig: receipt.sig});
        awardPaymentTested(journeyRef.current);
        await clearSolMerchantState(identity.publicHex);
        setReconcile(null);
        setPhase('result');
      } else if (receipt.status === RECEIPT_REJECTED) {
        await clearSolMerchantState(identity.publicHex);
        setReconcile(null);
        setErr('Payment rejected — the payer may have insufficient balance or the blockhash expired.');
      } else {
        // UNREACHABLE — the tx MAY still land. Keep the accepted tx for reconciliation (invariant #12).
        await saveSolMerchantState(identity.publicHex, {req: reqSnapshot, uri: reqUri, acceptedSignature: acceptedSig, acceptedTx: acceptedTxStr, outcome: 'unknown'});
        setReconcile({acceptedSig, acceptedTx: acceptedTxStr});
        setErr("Couldn't confirm — the payment may still settle. Check your balance shortly or retry.");
      }
    } catch (e: unknown) {
      setErr(friendlySolError(e instanceof Error ? e.message : String(e)));
    } finally {
      cancel();
      setBusy(false);
    }
  }

  // NFC reader success — same handling as onSignedQr SETTLED path.
  function onNfcResult(r: {amount: string; cur: 'SOL' | 'USDC'; sig: string} | null) {
    if (!r) return;
    setResult({amount: r.amount, cur: r.cur, sig: r.sig});
    awardPaymentTested(journeyRef.current);
    setReconcile(null);
    clearSolMerchantState(identity.publicHex);
    setPhase('result');
  }

  // Rebroadcast a previously-accepted tx after an interrupted broadcast (reconciliation).
  async function rebroadcast() {
    if (!reconcile || !reqSnapshot || !reqUri || busy) return;
    setBusy(true); setErr(null);
    const {signal, cancel} = withTimeout(SOL_BROADCAST_TIMEOUT_MS);
    try {
      const txBytes = base64UrlToBytes(reconcile.acceptedTx);
      if (!txBytes) { setErr('Saved payment data is corrupt.'); await clearSolMerchantState(identity.publicHex); setReconcile(null); reset(); return; }
      const solpay: SolPayV2 = {v: 2, rid: reqSnapshot.rid, tx: txBytes};
      const receipt = await broadcastSolPayment(reqSnapshot, reqUri, solpay, signal);
      if (receipt.status === RECEIPT_SETTLED) {
        setResult({amount: reqSnapshot.amt, cur: reqSnapshot.cur, sig: receipt.sig});
        awardPaymentTested(journeyRef.current);
        await clearSolMerchantState(identity.publicHex);
        setReconcile(null);
        setPhase('result');
      } else if (receipt.status === RECEIPT_REJECTED) {
        await clearSolMerchantState(identity.publicHex);
        setReconcile(null);
        setErr('Payment rejected.');
      } else {
        setErr("Still can't confirm — the payment may still settle. Try again later.");
      }
    } catch (e: unknown) {
      setErr(friendlySolError(e instanceof Error ? e.message : String(e)));
    } finally {
      cancel();
      setBusy(false);
    }
  }

  function reset() { setReqUri(null); setReqSnapshot(null); setResult(null); setScanning(false); setErr(null); setMemo(''); setReconcile(null); setNfcActive(false); setNfcKey(k => k + 1); setPhase('form'); }

  const copySig = async () => {
    if (result?.sig) { await doCopy(result.sig); }
  };

  if (phase === 'result' && result && !nfcActive) {
    return (
      <View style={S.center}>
        {toggle}
        <View style={S.check}><IconCheck size={44} color={C.brandInk}/></View>
        <Text testID="sol-req-status" style={S.paidText}>{`Received ${fmtAsset(result.amount, result.cur === 'USDC' ? USDC_DECIMALS : SOL_DECIMALS, result.cur === 'USDC' ? 'USDC' : SOL_UNIT)}`}</Text>
        {result.sig ? (
          <>
            <Text style={S.dim2}>transaction signature</Text>
            <Text testID="sol-req-sig" selectable={true} style={S.sheetAddr}>{result.sig}</Text>
            <Pressable testID="btn-sol-req-copy" style={S.primaryWide} onPress={copySig} accessibilityRole="button" accessibilityLabel="Copy transaction signature">
              <IconCopy size={18} color={C.brandInk}/>
              <Text style={S.primaryText}>{copied === 'clipboard' ? 'Copied ✓' : copied === 'shared' ? 'Shared ✓' : 'Copy signature'}</Text>
            </Pressable>
          </>
        ) : null}
        <Pressable testID="btn-sol-req-done" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel="New request" accessibilityState={{disabled: false}}>
          <Text style={S.ghostBtnText}>New request</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'reqQr' && reqUri) {
    return (
      <View style={S.center}>
        {toggle}
        {/* Reader runs in the background while the QR is shown: the payer taps OR scans. */}
        {nfcReady && DpaySolNfc ? (
          <SolNfcTap
            key={nfcKey} role="reader" identity={identity} req={reqSnapshot ?? undefined} reqUri={reqUri}
            onResult={onNfcResult}
            onActive={() => setNfcActive(true)}
            onClose={() => { setNfcActive(false); setNfcKey(k => k + 1); }}
          />
        ) : null}
        {!nfcActive ? (
          <>
            {reconcile ? (
              <View testID="sol-req-reconcile" style={S.reviewCard}>
                <Text style={S.reviewLabel}>A payment is being confirmed</Text>
                <Text style={S.warnNote}>A broadcast was interrupted. The payment may have settled — retry to check.</Text>
                {err ? <Text testID="sol-req-err" style={S.err}>{err}</Text> : null}
                {busy ? (
                  <ActivityIndicator color={C.brand} />
                ) : (
                  <Pressable testID="btn-sol-req-retry" style={S.primaryWide} onPress={rebroadcast} accessibilityRole="button" accessibilityLabel="Retry broadcast">
                    <Text style={S.primaryText}>Retry broadcast</Text>
                  </Pressable>
                )}
              </View>
            ) : null}
            {!scanning && !busy ? (
              <>
                <View style={S.nfcHintRow}>
                  <Text style={S.nfcHintLabel}>Show this to the payer{nfcReady ? ' · or let them tap' : ''}</Text>
                </View>
                <View testID="sol-req-qr" style={S.qrCard}><QrCode value={reqUri} size={QR_SIZE_SMALL} ecl="M" /></View>
                <Text style={S.amountBig}>{fmtAsset(reqSnapshot!.amt, decimals, unit)}</Text>
                {(() => {
                  const remaining = (reqSnapshot?.exp ?? 0) - now;
                  if (remaining <= 0) return <Text style={S.qrExpired}>Expired — make a new request</Text>;
                  const m = Math.floor(remaining / 60);
                  const s = remaining % 60;
                  // P3 — a small clock icon leads the calm validity line (QR-card polish).
                  if (m >= 1) return (
                    <View style={{flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6}}>
                      <IconClock size={14} color={C.sub}/>
                      <Text style={[S.qrExpiry, {marginTop: 0}]}>Valid for ~{m} min</Text>
                    </View>
                  );
                  return <Text style={S.qrExpiryWarn}>Expires in 0:{s.toString().padStart(2, '0')}</Text>;
                })()}
                <Text style={S.qrHint}>Waiting for the payer to sign offline…</Text>
                {/* Trip Ready J4 — the same receiveRequest truth ("your connection confirms"):
                    the merchant's own connection scans + settles the payer's signed payment.
                    Reading-zone mount (after the status line, before the action cluster) — same
                    placement decision as the IC ReceiveMode. */}
                <CoachTip tipKey="receiveRequest" />
                <Pressable style={S.ghostBtn} onPress={() => setScanning(true)} accessibilityRole="button" accessibilityLabel="Scan the payer's signed code" accessibilityHint="Scan the payer's signed QR to submit their offline payment" accessibilityState={{disabled: false}}>
                  <IconQr size={16} color={C.sub}/>
                  <Text style={S.ghostBtnText}>Scan the payer's signed code</Text>
                </Pressable>
                {err && !reconcile ? <Text testID="sol-req-err" style={S.err}>{err}</Text> : null}
                <Pressable style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel="New request" accessibilityState={{disabled: false}}>
                  <Text style={S.ghostBtnText}>New request</Text>
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
                <Pressable style={[S.ghostBtn, S.ghostBtnMuted]} onPress={() => setScanning(false)} accessibilityRole="button" accessibilityLabel="Back" accessibilityState={{disabled: false}}>
                  <Text style={S.ghostBtnText}>Back</Text>
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
      {/* Trip Ready J4 (UX hardening 2026-08-23) — entry-form mount, same one-time marker as the
          IC ReceiveMode (was: only visible after pressing Request). */}
      <CoachTip tipKey="receiveRequest" />
      <Text style={S.label}>Amount to receive</Text>
      <View style={S.amountRow}>
        <Pressable
          testID="sol-req-prefix"
          style={S.prefixBtn}
          onPress={() => setPickOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Receive in ${selectedToken}`}
          accessibilityHint="Choose which asset the payer will send you"
          accessibilityState={{disabled: false}}>
          <Text style={S.currency}>{selectedToken === 'SOL' ? '◎' : '$'}</Text>
          <IconChevronDown size={20} color={C.sub}/>
        </Pressable>
        <TextInput
          testID="sol-req-amount-input"
          style={S.amountInput}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0.025"
          placeholderTextColor={C.sub}
          accessibilityLabel="Amount to receive"
        />
      </View>
      <TextInput
        testID="sol-req-memo-input"
        style={memoInputStyle}
        value={memo}
        onChangeText={setMemo}
        placeholder="Add a note (optional)"
        placeholderTextColor={C.sub}
        accessibilityLabel="Memo"
        maxLength={32}
      />
      {/* 2026-08-14 audit: a USDC request whose settlement is doomed must not be creatable. If the
          device's ATA is KNOWN absent, the payer would sign a transferChecked to a non-existent
          account — broadcast fails AFTER they walked away. Inline the same one-tap setup card and
          block Request (known-absent only; loading/error/unavailable do not block — the honest
          unknown-handling the founder set when the dead-end gate was removed in 19c6e8f). */}
      {selectedToken === 'USDC' && usdcAtaStatus === 'absent' ? (
        <SolanaAtaSetupCard
          instrTestID="sol-req-ata"
          btnTestID="btn-sol-req-ata-create"
          buttonLabel="Create my USDC account"
          hasSol={solBalance != null && BigInt(solBalance) >= SOL_ATA_SETUP_MIN_LAMPORTS}
          checkingSol={solBalance == null}
          busy={ataSetupBusy}
          err={ataSetupErr}
          onCreateAta={onCreateAta}
          onShowSolAddress={onShowSolAddress}
        />
      ) : null}
      {!solRpc ? <Text style={S.warnNote}>Solana is offline — go online to create a payment request.</Text> : null}
      {busy ? (
        <>
          <ActivityIndicator color={C.brand} />
          <Text style={S.dim2}>Creating request…</Text>
        </>
      ) : null}
      {err ? <Text style={S.err}>{err}</Text> : null}
      {(() => {
        const usdcAbsent = selectedToken === 'USDC' && usdcAtaStatus === 'absent';
        const blocked = !solRpc || busy || usdcAbsent;
        return (
          <Pressable
            testID="btn-sol-req-make"
            style={[S.primaryWide, blocked && S.disabledFlat]}
            disabled={blocked}
            onPress={makeRequest}
            accessibilityRole="button"
            accessibilityLabel="Request"
            accessibilityHint="Show your QR code so the payer can scan it to pay you"
            accessibilityState={{disabled: blocked}}>
            <Text style={S.primaryText}>{busy ? 'Creating…' : 'Request'}</Text>
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
