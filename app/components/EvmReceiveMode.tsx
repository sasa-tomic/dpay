import {useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, type TextStyle} from 'react-native';
import {QrCode} from './QrCode';
import {QrScanner} from './QrScanner';
import {ModeToggle} from './ModeToggle';
import {AssetPicker} from './AssetPicker';
import {AssetSwitchRow} from './AssetSwitchRow';
import {RailDisclosure} from './RailDisclosure';
import {FundingRoutes} from './FundingRoutes';
import {CoachTip} from './CoachTip';
import {LinkRow} from './ConvertShared';
import {S, amountFontFor} from '../styles';
import {C, FONT} from '../config/palette';
import {IconCheck, IconChevronDown, IconClock, IconCopy, IconQr, IconShare} from './icons';
import {QR_SIZE} from '../config/constants';
import {SOL_ACTIVE_POLL_WINDOW_MS} from '../config/constants';
import {fmtAssetCompact} from '../lib/format';
import {cmpRaw} from '../lib/amount';
import type {AssetId, Identity} from '../lib/types';
import type {SelectableAsset} from '../config/assets';
import type {CurrencyDescriptor} from '../config/catalog';
import type {HomeCurrency} from '../config/currency';
import type {BalanceView} from '../lib/assetBalances';
import {
  createEvmPaymentRequest,
  decodeEvmPay,
  enqueueEvmClaim,
  evmClaimsKey,
  isEvmReqExpired,
  loadEvmClaims,
  settleEvmClaim,
  type EvmClaimRow,
  type EvmReqV1,
} from '../evm';
import {deriveEvmAddress} from '../evm';
import {EVM_CHAINS, toBaseUnitsSoft, type EvmChainId} from '../evm/chains';
import {toChecksumAddress} from '../evm/identity';
import {useReportLock} from '../hooks/useReportLock';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {useShareFeedback} from '../hooks/useShareFeedback';
import {M} from '../i18n';

// Twin of ReceiveMode's memoInputStyle — the IC/SOL Receive forms' pixel-twin input idiom. A
// FUNCTION, not a const: `C` is mutated in place on a theme flip.
const memoInputStyle = (): TextStyle => ({alignSelf: 'stretch', marginTop: 14, minHeight: 44, backgroundColor: C.card, borderWidth: 1, borderColor: C.line2, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: C.ink, fontFamily: FONT.sans});

/** The chains the ONE device address serves, as the registry names them — the "same address"
 *  note's material (D14: one key, every chain; stated where IC/SOL name a single chain). */
const NOTE_CHAINS = 'Ethereum and Arbitrum One';

/**
 * EvmReceiveMode — the merchant side of the EVM rail (D14/D20/D21/D24/D18). Rendered INLINE in
 * the Receive tab when an EVM asset is selected. Two sub-modes, exactly the SOL/IC surfaces:
 *
 *   address — the device's bare EIP-55 0x address as text + QR + copy (+ an explorer link only
 *             where the registry names one — none on the dev chain), the native-gas line, and
 *             the funding card (send-to-address; no fiat ramp on this rail — D20).
 *
 *   request — amount + memo → an `evmreq:v1` QR minted FULLY OFFLINE (D21: no chain read — the
 *             request needs no blockhash analog). When the payer's signed `evmpay:v1` code is
 *             scanned back, the claim is queued (rid single-use) and settled ONLINE through the
 *             pipe (permit → transferFrom, the merchant's ETH pays gas — D24): settled flips
 *             this screen to Received; a stale payer nonce reports needs-resign (re-scan after
 *             the payer signs fresh); a transport death keeps the claim queued honestly.
 *
 * A dpay LINK payment does NOT auto-confirm this screen (D18 — no on-chain memo channel exists
 * on ERC-20); the offline claim path is the deterministic exception: the settle echoes the rid
 * this device minted.
 */
export function EvmReceiveMode({identity, asset, assets, selectedAssetId, balances, catalog, onSelectAsset, subMode, onSubModeChange, onLockChange, gasWei, gasChecking = false, homeCurrency = null, onReceiveRailChange, onWatchRefresh}: {  identity: Identity;
  /** The SELECTED EVM asset row — this mode only mounts while one is selected. */
  asset: SelectableAsset & {protocol: 'evm'};
  assets: SelectableAsset[];
  selectedAssetId: AssetId | null;
  balances: Record<AssetId, BalanceView>;
  catalog: CurrencyDescriptor[];
  onSelectAsset: (id: AssetId) => void;
  subMode: 'request' | 'address';
  onSubModeChange: (m: 'request' | 'address') => void;
  onLockChange?: (locked: boolean) => void;
  /** The chain's native (gas) balance in wei — null when never read (D19). */
  gasWei: string | null;
  gasChecking?: boolean;
  homeCurrency?: HomeCurrency | null;
  onReceiveRailChange?: (id: AssetId) => void;
  /** Re-fires the balance poll while the address screen is up (the watch-the-deposit cadence). */
  onWatchRefresh?: () => void;
}) {
  // The device's 0x address, EIP-55-CHECKSUMMED for display/QR (D14 — the bare checksummed
  // address is the QR payload; the derivation is lowercase, the checksum is the display form).
  const evmAddress = useMemo(() => toChecksumAddress(deriveEvmAddress(identity.secretHex)), [identity.secretHex]);
  const claimsKey = useMemo(() => evmClaimsKey(evmAddress), [evmAddress]);
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [phase, setPhase] = useState<'form' | 'reqQr' | 'result'>('form');
  const [req, setReq] = useState<EvmReqV1 | null>(null);
  const [reqUri, setReqUri] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{amount: string; hash: string | null} | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [claims, setClaims] = useState<EvmClaimRow[]>([]);
  const {copied, copy: doCopy} = useCopyFeedback();
  const {shared, share} = useShareFeedback();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [pickOpen, setPickOpen] = useState(false);

  const locked = phase !== 'form';
  useReportLock(onLockChange, locked);

  const decimals = asset.decimals;
  const unit = asset.symbol;
  const explorer = EVM_CHAINS[asset.chainId as EvmChainId]?.explorer ?? null;
  const chain = EVM_CHAINS[asset.chainId as EvmChainId];
  const chainName = chain?.name ?? asset.chainName;
  const nativeSymbol = chain?.nativeSymbol ?? 'ETH';

  const reloadClaims = () => { void loadEvmClaims(claimsKey).then(setClaims); };
  useEffect(() => { reloadClaims(); }, [claimsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Expiry clock — ticks while a request QR is showing (the 600s window countdown).
  useEffect(() => {
    if (phase !== 'reqQr' || !req || result) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase, req, result]);

  // Watching a deposit land on the address screen is not an idle wallet (the SOL rule): being ON
  // this sub-mode re-opens the balance poll's active window on the shared cadence.
  const watchRef = useRef<(() => void) | undefined>(onWatchRefresh);
  watchRef.current = onWatchRefresh;
  useEffect(() => {
    if (subMode !== 'address' || onWatchRefresh === undefined) return;
    watchRef.current?.();
    const id = setInterval(() => watchRef.current?.(), SOL_ACTIVE_POLL_WINDOW_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subMode, onWatchRefresh === undefined]);

  const queuedClaims = claims.filter(c => c.status === 'queued');

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
    const gasLine = gasChecking || gasWei == null
      ? null
      : M.evm.gasLine(fmtAssetCompact(gasWei, 18, nativeSymbol, undefined, 0));
    return (
      <View style={S.centerTop}>
        {toggle}
        <AssetSwitchRow
          asset={asset}
          assets={assets}
          balances={balances}
          selectedId={selectedAssetId}
          homeCurrency={homeCurrency}
          onSelect={(id) => onReceiveRailChange ? onReceiveRailChange(id) : onSelectAsset(id)}
        />
        {homeCurrency != null ? (
          <RailDisclosure
            currency={homeCurrency}
            assets={assets}
            balances={balances}
            catalog={catalog}
            selectedAssetId={selectedAssetId}
            onSwitch={(id) => onReceiveRailChange ? onReceiveRailChange(id) : onSelectAsset(id)}
          />
        ) : null}
        <Text style={S.label}>{M.receive.myAddress}</Text>
        <Text testID="evm-recv-address" selectable={true} style={S.sheetAddr}>{evmAddress}</Text>
        <Text style={S.qrHint}>{M.evm.sameAddressNote(NOTE_CHAINS)}</Text>
        <View testID="evm-recv-qr" style={S.qrCard}><QrCode value={evmAddress} size={QR_SIZE} ecl="L" /></View>
        {gasLine != null ? <Text testID="evm-recv-gas" style={S.dim2}>{gasLine}</Text> : null}
        <Pressable
          testID="btn-evm-recv-copy"
          style={S.primaryWide}
          onPress={() => { void doCopy(evmAddress); }}
          accessibilityRole="button"
          accessibilityLabel={M.deposit.copyAddress}
          accessibilityState={{disabled: false}}>
          <IconCopy size={18} color={C.brandInk}/>
          <Text style={S.primaryText}>{copied ? M.pay.copied : M.deposit.copyAddress}</Text>
        </Pressable>
        {explorer != null ? (
          <LinkRow
            testID="evm-recv-explorer"
            label={M.evm.viewOnExplorer(chainName)}
            href={`${explorer}/address/${evmAddress}`}
          />
        ) : null}
        <FundingRoutes asset={asset} isTestnet={asset.testnet} mechanism="send-to-address" homeCurrency={homeCurrency} />
      </View>
    );
  }

  // Mint the evmreq:v1 QR — FULLY OFFLINE (D21). No persistence of the open request is needed:
  // the claim queue stores the FULL req with every claim, so a kill/restart reconciles from the
  // queue itself (the solMerchantPersist role, one shape further down).
  async function makeRequest() {
    const typedRaw = toBaseUnitsSoft(amount, decimals);
    if (!typedRaw || typedRaw === '0') return;
    setBusy(true);
    setErr(null);
    try {
      const {req: minted, uri} = createEvmPaymentRequest({
        chainId: asset.chainId,
        token: asset.token,
        to: evmAddress,
        amt: typedRaw,
        name: identity.username,
        memo: memo.trim(),
      });
      setReq(minted);
      setReqUri(uri);
      setResult(null);
      setPhase('reqQr');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Scan the payer's signed evmpay:v1 → queue (rid single-use) → settle ONLINE (D24). The typed
  // outcomes surface honestly: settled flips to Received; needs-resign asks the payer to sign
  // fresh; transport death keeps the claim queued for the next online window.
  async function onSignedQr(raw: string) {
    setScanning(false);
    setBusy(true);
    setErr(null);
    let parsed;
    try {
      parsed = decodeEvmPay(raw);
    } catch (e: unknown) {
      setBusy(false);
      setErr(M.evm.badCode);
      return;
    }
    try {
      // The claim binds to the OPEN request when one is showing; a scanned claim for an expired
      // or absent local request is still queueable (the row carries the FULL req) — settle
      // refuses it honestly if it does not bind (the engine's stage-0 check).
      const boundReq = req != null && req.rid === parsed.rid ? req : (claims.find(c => c.claim.rid === parsed.rid)?.req ?? null);
      if (boundReq == null) {
        setErr(M.evm.badCode);
        return;
      }
      if (isEvmReqExpired(boundReq)) {
        setErr(M.evm.failExpired);
        return;
      }
      const rows = await enqueueEvmClaim(claimsKey, {req: boundReq, claim: parsed});
      setClaims(rows);
      const out = await settleEvmClaim(identity.secretHex, boundReq, parsed);
      if (out.outcome === 'settled') {
        setResult({amount: boundReq.amt, hash: out.txHash});
        setPhase('result');
        setReq(null);
        setReqUri(null);
      } else if (out.outcome === 'needs-resign') {
        setErr(M.evm.claimNeedsResign);
      } else if (out.outcome === 'unknown') {
        setErr(M.evm.claimUnknown);
      } else {
        setErr(failCopy(out.row));
      }
    } catch (e: unknown) {
      setErr(friendlySettleError(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
      reloadClaims();
    }
  }

  // Retry a QUEUED claim from the queue (offline scan-back → online settle, D23→D24).
  async function settleQueued(row: EvmClaimRow) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const out = await settleEvmClaim(identity.secretHex, row.req, row.claim);
      if (out.outcome === 'settled') {
        setResult({amount: row.req.amt, hash: out.txHash});
        setPhase('result');
        setReq(null);
        setReqUri(null);
      } else if (out.outcome === 'needs-resign') {
        setErr(M.evm.claimNeedsResign);
      } else if (out.outcome === 'unknown') {
        setErr(M.evm.claimUnknown);
      } else {
        setErr(failCopy(out.row));
      }
    } catch (e: unknown) {
      setErr(friendlySettleError(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
      reloadClaims();
    }
  }

  function failCopy(row: EvmClaimRow): string {
    const detail = row.failDetail ?? '';
    switch (row.failReason) {
      case 'nonce': return M.evm.failNonce;
      case 'expired': return M.evm.failExpired;
      case 'gas': return M.evm.failGas(nativeSymbol, chainName, evmAddress);
      case 'rejected': return M.evm.failRejected(detail.slice(0, 120));
      default: return M.evm.failRejected(detail.slice(0, 120));
    }
  }

  function friendlySettleError(msg: string): string {
    if (/not configured/.test(msg)) return M.receive.solanaOffline;
    // Engine-chunk failures need no mapping here: `loadEvmRpcForSend` throws the CLASSIFIED final
    // copy itself (app/transportFailure.ts `engineLoadCopy`), which passes through verbatim.
    return msg;
  }

  function reset() {
    setReq(null);
    setReqUri(null);
    setResult(null);
    setScanning(false);
    setErr(null);
    setMemo('');
    setPhase('form');
  }

  const copyHash = async () => {
    if (result?.hash) await doCopy(result.hash);
  };

  if (phase === 'result' && result) {
    return (
      <View style={S.center}>
        {toggle}
        <View style={S.check}><IconCheck size={44} color={C.brandInk}/></View>
        <Text testID="evm-req-status" style={S.paidText}>{M.evm.claimSettled(fmtAssetCompact(result.amount, decimals, unit, undefined, asset.minFractionDigits))}</Text>
        {result.hash ? (
          <>
            <Text style={S.dim2}>{M.evm.txHash}</Text>
            <Text testID="evm-req-hash" selectable={true} style={S.sheetAddr}>{result.hash}</Text>
            <Pressable testID="btn-evm-req-copy" style={S.primaryWide} onPress={copyHash} accessibilityRole="button" accessibilityLabel={M.receive.copySignatureA11y} accessibilityState={{disabled: false}}>
              <IconCopy size={18} color={C.brandInk}/>
              <Text style={S.primaryText}>{copied ? M.pay.copied : M.receive.copySignature}</Text>
            </Pressable>
          </>
        ) : null}
        <Pressable testID="btn-evm-req-done" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel={M.receive.newRequest} accessibilityState={{disabled: false}}>
          <Text style={S.ghostBtnText}>{M.receive.newRequest}</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'reqQr' && req && reqUri) {
    return (
      <View style={S.center}>
        {toggle}
        <View testID="evm-req-qr" style={S.qrCard}><QrCode value={reqUri} size={QR_SIZE} ecl="L" /></View>
        <Text testID="evm-req-price" style={S.amountBig}>{fmtAssetCompact(req.amt, decimals, unit, undefined, asset.minFractionDigits)}</Text>
        {(() => {
          const remaining = req.exp - now;
          if (remaining <= 0) return <Text style={S.qrExpired}>{M.evm.expiredMakeNew}</Text>;
          const m = Math.floor(remaining / 60);
          const s = remaining % 60;
          if (m >= 1) return (
            <View style={{flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6}}>
              <IconClock size={14} color={C.sub}/>
              <Text testID="evm-req-expiry" style={[S.qrExpiry, {marginTop: 0}]}>{M.evm.validForMin(m)}</Text>
            </View>
          );
          return <Text testID="evm-req-expiry" style={S.qrExpiryWarn}>{M.evm.expiresIn(s.toString().padStart(2, '0'))}</Text>;
        })()}
        <Text style={S.qrHint}>{M.evm.waitingForSign}</Text>
        <CoachTip tipKey="receiveRequest" />
        <Pressable testID="btn-evm-share-request" style={S.ghostBtn} onPress={() => { share(reqUri); }} accessibilityRole="button" accessibilityLabel={M.receive.shareRequestLink} accessibilityState={{disabled: false}}>
          <IconShare size={16} color={C.sub}/>
          <Text style={S.ghostBtnText}>{shared ? M.pay.linkCopied : M.receive.shareRequestLink}</Text>
        </Pressable>
        {!scanning && !busy ? (
          <>
            <Pressable testID="btn-evm-req-scan" style={S.ghostBtn} onPress={() => setScanning(true)} accessibilityRole="button" accessibilityLabel={M.receive.scanPayerSignedCode} accessibilityState={{disabled: false}}>
              <IconQr size={16} color={C.sub}/>
              <Text style={S.ghostBtnText}>{M.receive.scanPayerSignedCode}</Text>
            </Pressable>
            {err ? <Text testID="evm-req-err" style={S.err}>{err}</Text> : null}
            <Pressable style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel={M.receive.newRequest} accessibilityState={{disabled: false}}>
              <Text style={S.ghostBtnText}>{M.receive.newRequest}</Text>
            </Pressable>
          </>
        ) : busy ? (
          <>
            <ActivityIndicator color={C.brandText} />
            <Text testID="evm-req-settling" style={S.dim2}>{M.evm.settling}</Text>
          </>
        ) : (
          <>
            <QrScanner onScan={(v) => { void onSignedQr(v); }} />
            <Text style={S.dim2}>{M.receive.scanPayerSignedCode}</Text>
            {err ? <Text testID="evm-req-err" style={S.err}>{err}</Text> : null}
            <Pressable style={[S.ghostBtn, S.ghostBtnMuted]} onPress={() => setScanning(false)} accessibilityRole="button" accessibilityLabel={M.receive.back} accessibilityState={{disabled: false}}>
              <Text style={S.ghostBtnText}>{M.receive.back}</Text>
            </Pressable>
          </>
        )}
      </View>
    );
  }

  // phase === 'form'
  return (
    <View style={S.centerTop}>
      {toggle}
      <CoachTip tipKey="receiveRequest" />
      <Text style={S.label}>{M.evm.requestReady}</Text>
      <View style={S.amountRow}>
        <Pressable
          testID="evm-req-prefix"
          style={S.prefixBtn}
          onPress={() => setPickOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={M.receive.receiveIn(unit)}
          accessibilityState={{disabled: false}}>
          {/* The unit text, not a glyph: no franc glyph exists in the vocabulary, and the VCHF
              precedent renders the exact unit text for a known token ('¤' is the UNKNOWN
              fallback — a ZCHF row is never unknown). */}
          <Text style={S.currency}>{unit}</Text>
          <IconChevronDown size={20} color={C.sub}/>
        </Pressable>
        <TextInput
          testID="evm-req-amount-input"
          style={[S.amountInput, amountFontFor(amount)]}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder={M.evm.amountPlaceholder}
          placeholderTextColor={C.sub}
          accessibilityLabel={M.evm.requestReady}
        />
      </View>
      <TextInput
        testID="evm-req-memo-input"
        style={memoInputStyle()}
        value={memo}
        onChangeText={setMemo}
        placeholder={M.receive.memoPlaceholder}
        placeholderTextColor={C.sub}
        accessibilityLabel={M.receive.memo}
        maxLength={32}
      />
      <Text style={S.dim2}>{M.evm.requestOffline}</Text>
      {/* Claims scanned while offline (or a needs-resign re-scan) wait here; one press settles
          each when online (D23 → D24). */}
      {queuedClaims.length > 0 ? (
        <View testID="evm-claims-queued" style={S.reviewCard}>
          <Text style={S.reviewLabel}>{M.evm.claimsQueued(queuedClaims.length)}</Text>
          {busy ? (
            <ActivityIndicator color={C.brandText} />
          ) : (
            <Pressable testID="btn-evm-claims-settle" style={S.primaryWide} onPress={() => { void settleQueued(queuedClaims[0]); }} accessibilityRole="button" accessibilityLabel={M.evm.retrySettle} accessibilityState={{disabled: false}}>
              <Text style={S.primaryText}>{M.evm.retrySettle}</Text>
            </Pressable>
          )}
        </View>
      ) : null}
      {busy ? (
        <>
          <ActivityIndicator color={C.brandText} />
          <Text style={S.dim2}>{M.receive.creating}</Text>
        </>
      ) : null}
      {err ? <Text testID="evm-req-err" style={S.err}>{err}</Text> : null}
      {(() => {
        const blocked = busy || cmpRaw(toBaseUnitsSoft(amount, decimals), '0') === 0;
        return (
          <Pressable
            testID="btn-evm-req-make"
            style={[S.primaryWide, blocked && S.disabledFlat]}
            disabled={blocked}
            onPress={makeRequest}
            accessibilityRole="button"
            accessibilityLabel={M.receive.request}
            accessibilityState={{disabled: blocked}}>
            <Text style={[S.primaryText, blocked && S.disabledText]}>{busy ? M.receive.creating : M.receive.request}</Text>
          </Pressable>
        );
      })()}
      <AssetPicker
        open={pickOpen}
        assets={assets}
        selectedId={selectedAssetId}
        balances={balances}
        homeCurrency={homeCurrency}
        onSelect={(id) => { setAmount(''); onSelectAsset(id); }}
        onClose={() => setPickOpen(false)}
      />
    </View>
  );
}
