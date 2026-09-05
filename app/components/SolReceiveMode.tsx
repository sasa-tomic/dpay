import {useState, useEffect, useMemo, useRef} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, Platform, type TextStyle} from 'react-native';
import {QrCode} from './QrCode';
import bs58 from 'bs58';
import {C, FONT} from '../config/palette';
import {S} from '../styles';
import {QR_SIZE_SMALL, SOL_BROADCAST_TIMEOUT_MS} from '../config/constants';
import {fmtAsset, toUnits} from '../lib/format';
import {bytesToBase64Url, base64UrlToBytes} from '../lib/base64';
import {linkNetworkOf, type SelectableAsset} from '../config/assets';
import type {CurrencyDescriptor} from '../config/catalog';
import {type HomeCurrency} from '../config/currency';
import {type BalanceView} from '../lib/assetBalances';
import type {Identity, AssetId, NfcStatus} from '../lib/types';
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
import {NfcStatusRow} from './NfcStatusRow';
import {ModeToggle} from './ModeToggle';
import {TillCharge} from './TillCharge';
import {SolanaReceiveSheet} from './SolanaReceiveSheet';
import {RailDisclosure} from './RailDisclosure';
import {SolanaAtaSetupCard} from './SolanaAtaSetupCard';
import {AssetPicker} from './AssetPicker';
import {useJourney} from '../lib/journey';
import {awardPaymentTested} from '../lib/readiness';
import {encodePayLink, shareOrigin} from '../lib/deepLink';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {useShareFeedback, shareConfirmLabel} from '../hooks/useShareFeedback';
import {useReportLock} from '../hooks/useReportLock';
import {IconCheck, IconChevronDown, IconClock, IconCopy, IconQr, IconShare} from './icons';
import {CoachTip} from './CoachTip';
import {M} from '../i18n';

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
export function SolReceiveMode({identity, relayUrl, nfcStatus, solAddress, subMode, onSubModeChange, codeForm, onCodeFormChange, catalog, selectedToken, assets, selectedAssetId, balances, onSelectAsset, usdcAtaStatus = 'balance', usdcAmount = null, solBalance = null, solOk = false, ataSetupBusy = false, ataSetupErr = null, onCreateAta, onShowSolAddress, onRefreshUsdc, onRefreshSol, depositReturnLabel, onReturnFromDeposit, onLockChange, homeCurrency = null, onReceiveRailChange}: {identity: Identity; relayUrl: string; nfcStatus: NfcStatus; solAddress: string; subMode: 'request' | 'address'; onSubModeChange: (m: 'request' | 'address') => void; codeForm: 'dpay' | 'till'; onCodeFormChange: (f: 'dpay' | 'till') => void; catalog: CurrencyDescriptor[]; selectedToken: 'SOL' | 'USDC'; assets: SelectableAsset[]; selectedAssetId: AssetId | null; balances: Record<AssetId, BalanceView>; onSelectAsset: (id: AssetId) => void; usdcAtaStatus?: SolUsdcStatus; usdcAmount?: string | null; solBalance?: string | null; solOk?: boolean; ataSetupBusy?: boolean; ataSetupErr?: string | null; onCreateAta?: () => void; onShowSolAddress?: () => void; onRefreshUsdc?: () => void; onRefreshSol?: () => void;   depositReturnLabel?: string | null;
  onReturnFromDeposit?: () => void;
  onLockChange?: (locked: boolean) => void;
  homeCurrency?: HomeCurrency | null;
  onReceiveRailChange?: (id: AssetId) => void}) {
  // The 4-state radio status, and the local "is a tap possible" gate derived from it — see the
  // same pair in ReceiveMode for why the state travels whole rather than as a boolean.
  const nfcReady = nfcStatus === 'ready';
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
  const {shared, share} = useShareFeedback();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcKey, setNfcKey] = useState(0);

  // The shareable payment link for this request — the SAME grammar the IC rail shares, pointing at
  // this device's Solana address (the same-surfaces hard rule: one link format, both rails). It is
  // NOT the `solreq:v2:` QR above it: that one is blockhash-bound and dies in ~90 seconds, which is
  // exactly why it cannot be sent through a chat. This link is durable and carries no `ref` — the
  // SOL rail attaches no on-chain reconciliation memo, and a reference we cannot put on-chain
  // would be a promise the rail can't keep.
  const linkAsset = assets.find(a => a.id === selectedAssetId) ?? null;
  const payLink = useMemo(() => {
    if (linkAsset == null || linkAsset.linkToken == null || amount.trim().length === 0) return null;
    return encodePayLink(shareOrigin(), {
      recipient: solAddress,
      asset: linkAsset.linkToken,
      network: linkNetworkOf(linkAsset),
      amount: amount.trim(),
      label: identity.username,
      memo: memo.trim(),
      ref: null,
    });
  }, [linkAsset, amount, solAddress, identity.username, memo]);
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
      left={{label: M.receive.requestPayment, value: 'request', testID: 'btn-receive-request'}}
      right={{label: M.receive.myAddress, value: 'address', testID: 'btn-receive-address'}}
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
        {homeCurrency != null && onReceiveRailChange != null ? (
          <RailDisclosure
            currency={homeCurrency}
            assets={assets}
            balances={balances}
            catalog={catalog}
            selectedAssetId={selectedAssetId}
            onSwitch={onReceiveRailChange}
          />
        ) : null}
        <SolanaReceiveSheet
          address={usdcAtaAddress}
          uriRecipient={solAddress}
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
    if (!reqSnapshot || !reqUri) { setErr(M.receive.noOpenRequest); return; }
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
        setErr(M.receive.paymentRejectedDetail);
      } else {
        // UNREACHABLE — the tx MAY still land. Keep the accepted tx for reconciliation (invariant #12).
        await saveSolMerchantState(identity.publicHex, {req: reqSnapshot, uri: reqUri, acceptedSignature: acceptedSig, acceptedTx: acceptedTxStr, outcome: 'unknown'});
        setReconcile({acceptedSig, acceptedTx: acceptedTxStr});
        setErr(M.receive.couldNotConfirmMaySettle);
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
      if (!txBytes) { setErr(M.receive.savedDataCorrupt); await clearSolMerchantState(identity.publicHex); setReconcile(null); reset(); return; }
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
        setErr(M.receive.paymentRejected);
      } else {
        setErr(M.receive.stillCannotConfirm);
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
        <Text testID="sol-req-status" style={S.paidText}>{M.receive.receivedAmount(fmtAsset(result.amount, result.cur === 'USDC' ? USDC_DECIMALS : SOL_DECIMALS, result.cur === 'USDC' ? 'USDC' : SOL_UNIT))}</Text>
        {result.sig ? (
          <>
            <Text style={S.dim2}>{M.receive.transactionSignature}</Text>
            <Text testID="sol-req-sig" selectable={true} style={S.sheetAddr}>{result.sig}</Text>
            <Pressable testID="btn-sol-req-copy" style={S.primaryWide} onPress={copySig} accessibilityRole="button" accessibilityLabel={M.receive.copySignatureA11y}>
              <IconCopy size={18} color={C.brandInk}/>
              <Text style={S.primaryText}>{copied === 'clipboard' ? M.pay.copied : copied === 'shared' ? M.receive.sharedConfirm : M.receive.copySignature}</Text>
            </Pressable>
          </>
        ) : null}
        <Pressable testID="btn-sol-req-done" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel={M.receive.newRequest} accessibilityState={{disabled: false}}>
          <Text style={S.ghostBtnText}>{M.receive.newRequest}</Text>
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
                <Text style={S.reviewLabel}>{M.receive.paymentBeingConfirmed}</Text>
                <Text style={S.warnNote}>{M.receive.broadcastInterrupted}</Text>
                {err ? <Text testID="sol-req-err" style={S.err}>{err}</Text> : null}
                {busy ? (
                  <ActivityIndicator color={C.brand} />
                ) : (
                  <Pressable testID="btn-sol-req-retry" style={S.primaryWide} onPress={rebroadcast} accessibilityRole="button" accessibilityLabel={M.receive.retryBroadcast}>
                    <Text style={S.primaryText}>{M.receive.retryBroadcast}</Text>
                  </Pressable>
                )}
              </View>
            ) : null}
            {!scanning && !busy ? (
              <>
                {/* Same three-way split as the IC rail, and for the same reasons: a working
                    radio leaves only "this code is tappable" to say, a radio that is off, absent
                    or unreadable leaves an instruction (`NfcStatusRow`), and the web wallet has no
                    radio to report on at all. */}
                {nfcReady || Platform.OS === 'web' ? (
                  <View style={S.nfcHintRow}>
                    <Text style={S.nfcHintLabel}>{M.receive.showToPayer('tap')}</Text>
                  </View>
                ) : (
                  <NfcStatusRow nfcStatus={nfcStatus} testID="sol-receive-nfc" />
                )}
                <View testID="sol-req-qr" style={S.qrCard}><QrCode value={reqUri} size={QR_SIZE_SMALL} ecl="M" /></View>
                <Text style={S.amountBig}>{fmtAsset(reqSnapshot!.amt, decimals, unit)}</Text>
                {(() => {
                  const remaining = (reqSnapshot?.exp ?? 0) - now;
                  if (remaining <= 0) return <Text style={S.qrExpired}>{M.receive.expiredMakeNew}</Text>;
                  const m = Math.floor(remaining / 60);
                  const s = remaining % 60;
                  // P3 — a small clock icon leads the calm validity line (QR-card polish).
                  if (m >= 1) return (
                    <View style={{flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6}}>
                      <IconClock size={14} color={C.sub}/>
                      <Text style={[S.qrExpiry, {marginTop: 0}]}>{M.receive.validForMin(m)}</Text>
                    </View>
                  );
                  return <Text style={S.qrExpiryWarn}>{M.receive.expiresIn(s.toString().padStart(2, '0'))}</Text>;
                })()}
                <Text style={S.qrHint}>{M.receive.waitingForSign}</Text>
                {/* Trip Ready J4 — the same receiveRequest truth ("your connection confirms"):
                    the merchant's own connection scans + settles the payer's signed payment.
                    Reading-zone mount (after the status line, before the action cluster) — same
                    placement decision as the IC ReceiveMode. */}
                <CoachTip tipKey="receiveRequest" />
                {/* Share this request as a PAYMENT LINK — the same affordance, in the same place,
                    as the IC rail's (same-surfaces hard rule). It carries this device's Solana
                    address + the exact asset and amount, and unlike the QR above it does not
                    expire, so it can travel through a messaging app. */}
                {payLink ? (
                  <Pressable
                    testID="btn-share-request"
                    style={S.ghostBtn}
                    onPress={() => { share(payLink); }}
                    accessibilityRole="button"
                    accessibilityLabel={M.receive.shareRequestLink}
                    accessibilityHint={M.receive.shareRequestHint}
                    accessibilityState={{disabled: false}}>
                    <IconShare size={16} color={C.sub}/>
                    <Text style={S.ghostBtnText}>{shared ? shareConfirmLabel(M.pay.linkCopied) : M.receive.shareRequestLink}</Text>
                  </Pressable>
                ) : null}
                <Pressable style={S.ghostBtn} onPress={() => setScanning(true)} accessibilityRole="button" accessibilityLabel={M.receive.scanPayerSignedCode} accessibilityHint={M.receive.scanPayerSignedQrHint} accessibilityState={{disabled: false}}>
                  <IconQr size={16} color={C.sub}/>
                  <Text style={S.ghostBtnText}>{M.receive.scanPayerSignedCode}</Text>
                </Pressable>
                {err && !reconcile ? <Text testID="sol-req-err" style={S.err}>{err}</Text> : null}
                <Pressable style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel={M.receive.newRequest} accessibilityState={{disabled: false}}>
                  <Text style={S.ghostBtnText}>{M.receive.newRequest}</Text>
                </Pressable>
              </>
            ) : busy ? (
              <>
                <ActivityIndicator color={C.brand} />
                <Text style={S.dim2}>{M.receive.broadcasting}</Text>
              </>
            ) : (
              <>
                <QrScanner onScan={onSignedQr} />
                <Text style={S.dim2}>{M.receive.scanPayerSignedCode}</Text>
                {err ? <Text testID="sol-req-err" style={S.err}>{err}</Text> : null}
                <Pressable style={[S.ghostBtn, S.ghostBtnMuted]} onPress={() => setScanning(false)} accessibilityRole="button" accessibilityLabel={M.receive.back} accessibilityState={{disabled: false}}>
                  <Text style={S.ghostBtnText}>{M.receive.back}</Text>
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
      {/* The code-form selector, on the SOL rail exactly as on the IC one — the same-surfaces hard
          rule: a control that appeared only where it can succeed would be a per-rail special case,
          and the merchant would be left guessing whether their phone can do it at all. Here it
          always lands on the honest closed branch (a till code is paid in VCHF on the Internet
          Computer, and this request is on Solana) with the one tap that fixes it. No `onLiveChange`:
          a charge can never go live from this rail, so a live-state reporter would be dead code. */}
      <Text style={S.dim2}>{M.receive.till.codeForm}</Text>
      <ModeToggle
        testID="receive-code-form"
        value={codeForm}
        onChange={(v) => onCodeFormChange(v as 'dpay' | 'till')}
        left={{label: M.receive.till.dpayCode, value: 'dpay', testID: 'btn-code-dpay'}}
        right={{label: M.receive.till.tillCode, value: 'till', testID: 'btn-code-till'}}
      />
      {codeForm === 'till' ? (
        <TillCharge
          identity={identity}
          relayUrl={relayUrl}
          asset={assets.find(a => a.id === selectedAssetId) ?? null}
          assets={assets}
          catalog={catalog}
          nfcStatus={nfcStatus}
          onSelectAsset={onSelectAsset}
        />
      ) : (
        <>
      {/* Trip Ready J4 (UX hardening 2026-08-23) — entry-form mount, same one-time marker as the
          IC ReceiveMode (was: only visible after pressing Request). */}
      <CoachTip tipKey="receiveRequest" />
      <Text style={S.label}>{M.receive.amountToReceive}</Text>
      <View style={S.amountRow}>
        <Pressable
          testID="sol-req-prefix"
          style={S.prefixBtn}
          onPress={() => setPickOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={M.receive.receiveIn(selectedToken)}
          accessibilityHint={M.receive.chooseAssetHint}
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
          placeholder={M.receive.solAmountPlaceholder}
          placeholderTextColor={C.sub}
          accessibilityLabel={M.receive.amountToReceive}
        />
      </View>
      <TextInput
        testID="sol-req-memo-input"
        style={memoInputStyle}
        value={memo}
        onChangeText={setMemo}
        placeholder={M.receive.memoPlaceholder}
        placeholderTextColor={C.sub}
        accessibilityLabel={M.receive.memo}
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
          buttonLabel={M.pay.createUsdcAccount}
          hasSol={solBalance != null && BigInt(solBalance) >= SOL_ATA_SETUP_MIN_LAMPORTS}
          checkingSol={solBalance == null}
          busy={ataSetupBusy}
          err={ataSetupErr}
          onCreateAta={onCreateAta}
          onShowSolAddress={onShowSolAddress}
        />
      ) : null}
      {!solRpc ? <Text style={S.warnNote}>{M.receive.solanaOffline}</Text> : null}
      {busy ? (
        <>
          <ActivityIndicator color={C.brand} />
          <Text style={S.dim2}>{M.receive.creatingRequest}</Text>
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
            accessibilityLabel={M.receive.request}
            accessibilityHint={M.receive.requestHint}
            accessibilityState={{disabled: blocked}}>
            <Text style={S.primaryText}>{busy ? M.receive.creating : M.receive.request}</Text>
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
        </>
      )}
    </View>
  );
}
