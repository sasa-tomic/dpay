import {useEffect, useMemo, useState} from 'react';
import {View, Text, Pressable} from 'react-native';
import {QrCode} from './QrCode';
import {QrScanner} from './QrScanner';
import {EvmWithdrawSheet} from './EvmWithdrawSheet';
import {InstructionPanel} from './InstructionPanel';
import {ModeToggle} from './ModeToggle';
import {S} from '../styles';
import {C} from '../config/palette';
import {IconClock, IconScan} from './icons';
import {QR_SIZE} from '../config/constants';
import {cmpRaw} from '../lib/amount';
import {sanitiseDisplayText} from '../lib/deepLink';
import {classifyScan} from '../lib/scan';
import {fmtAssetCompact, short} from '../lib/format';
import type {Identity, Txn} from '../lib/types';
import type {SelectableAsset} from '../config/assets';
import {
  decodeEvmReq,
  deriveEvmAddress,
  enqueueEvmClaim,
  evmClaimsKey,
  findEvmSettledTransfer,
  isEvmReqExpired,
  loadEvmClaims,
  patchEvmClaim,
  resolveEvmTokenAddress,
  signEvmPermitClaim,
  type EvmClaimRow,
  type EvmReqV1,
} from '../evm';
import {useReportLock} from '../hooks/useReportLock';
import {M} from '../i18n';

/**
 * EvmPayMode — the payer side of the EVM rail (D21/D22/D25). Rendered INLINE in the Pay tab when
 * an EVM asset is selected. Two sub-modes, exactly the SOL rail's:
 *
 *   scan — the merchant shows an `evmreq:v1` QR; the payer scans, the permit signature is
 *          produced FULLY OFFLINE (the cached nonce, D22.2 — the only await is AsyncStorage),
 *          and the signed `evmpay:v1` QR is shown for the merchant to scan back. "Handed to
 *          merchant" is the honest pending (the payer never claims "Paid" from an offline sign);
 *          the pending-claims notice below carries a read-only "Check now" that asks the chain
 *          whether the claim's Transfer already landed.
 *
 *   send — the EvmWithdrawSheet (amount + address + fee estimate + the gas honesty gate).
 *
 * The camera also accepts a dpay payment link and a plain 0x address (classifyScan) — the same
 * three verdicts every rail's scanner answers.
 */
export function EvmPayMode({identity, online, asset, balance, gasWei, gasChecking = false, subMode, onSubModeChange, sendPrefill = null, onSendPrefillConsumed, prefillScan, onPrefillScanConsumed, onScannedLink, onLockChange, onOpenAddressBook, onOpenReceipt, onSent, onRecheckBalances, recheckBusy = false}: {
  identity: Identity;
  online: boolean;
  /** The SELECTED EVM asset row — this mode only mounts while one is selected. */
  asset: SelectableAsset & {protocol: 'evm'};
  /** The SELECTED token's last-known raw balance (null = never read; gates honestly). */
  balance: string | null;
  /** The chain's native (gas) balance in wei — null when never read (the D19 visibility leg). */
  gasWei: string | null;
  gasChecking?: boolean;
  subMode: 'scan' | 'send';
  onSubModeChange: (m: 'scan' | 'send') => void;
  sendPrefill?: {address: string; amount: string; label?: string; memo?: string} | null;
  onSendPrefillConsumed?: () => void;
  prefillScan?: string | null;
  onPrefillScanConsumed?: () => void;
  onScannedLink: (url: string) => void;
  onLockChange?: (locked: boolean) => void;
  onOpenAddressBook?: () => void;
  onOpenReceipt?: (t: Txn) => void;
  onSent: () => void;
  onRecheckBalances: () => void;
  recheckBusy?: boolean;
}) {
  const [phase, setPhase] = useState<'scan' | 'qr' | 'paid'>('scan');
  const [req, setReq] = useState<EvmReqV1 | null>(null);
  const [payUri, setPayUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scannedAddress, setScannedAddress] = useState<string | null>(null);
  // The payer's own claim log (rid → status) — the pending-claims badge's facts.
  const [claims, setClaims] = useState<EvmClaimRow[]>([]);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  // Pay-intent gate (the IC/SOL rule): the camera starts only on an explicit "Pay Now" press.
  const [scanArmed, setScanArmed] = useState(false);
  const [scanKey, setScanKey] = useState(0);
  const [sendActive, setSendActive] = useState(false);
  const evmAddress = useMemo(() => deriveEvmAddress(identity.secretHex), [identity.secretHex]);
  const claimsKey = useMemo(() => evmClaimsKey(evmAddress), [evmAddress]);

  const reloadClaims = () => { void loadEvmClaims(claimsKey).then(setClaims); };
  useEffect(() => { reloadClaims(); }, [claimsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (subMode !== 'scan') setScanArmed(false); }, [subMode]);
  useEffect(() => { if (subMode !== 'send') { setSendActive(false); } }, [subMode]);

  useEffect(() => {
    if (prefillScan == null) return;
    if (phase !== 'scan') return;
    onPrefillScanConsumed?.();
    onNotARequest(prefillScan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillScan, phase]);

  const locked = phase !== 'scan' || sendActive;
  useReportLock(onLockChange, locked);

  const pendingClaims = claims.filter(c => c.status === 'queued' || c.status === 'unknown');
  const decimals = asset.decimals;
  const unit = asset.symbol;

  const toggle = (
    <ModeToggle
      testID="pay-mode-toggle"
      value={subMode}
      onChange={(v) => onSubModeChange(v as 'scan' | 'send')}
      left={{label: M.pay.scanToPay, value: 'scan', testID: 'btn-pay-scan'}}
      right={{label: M.pay.sendToAddress, value: 'send', testID: 'btn-pay-send'}}
    />
  );

  // ── SEND sub-mode: the offline / fund gates, then the sheet (the SolPayMode shape) ─────────────
  if (subMode === 'send') {
    // A mid-send surface is never torn down by a poll flip (the 2026-09-21 surface-ownership rule).
    if (!online && !sendActive) {
      return (
        <View style={S.centerTop}>
          {toggle}
          <InstructionPanel
            testID="evm-send-offline"
            title={M.pay.offlineSendTitle}
            body={M.pay.offlineSendBody(unit)}
            primaryLabel={M.pay.scanToPay}
            onPrimary={() => onSubModeChange('scan')}
            onRecheck={onRecheckBalances}
            recheckBusy={recheckBusy}
          />
        </View>
      );
    }
    if (!sendActive && balance != null && cmpRaw(balance, '0') === 0) {
      return (
        <View style={S.centerTop}>
          {toggle}
          <InstructionPanel
            testID="evm-send-fund"
            title={M.pay.fundTitle(unit)}
            body={M.pay.fundBodyToken(unit)}
            primaryLabel={M.pay.showMyAddress(unit)}
            onPrimary={() => onSubModeChange('scan')}
            onRecheck={onRecheckBalances}
            recheckBusy={recheckBusy}
          />
          {err ? <Text testID="evm-pay-err" style={S.err}>{err}</Text> : null}
        </View>
      );
    }
    return (
      <View style={S.centerTop}>
        {toggle}
        <EvmWithdrawSheet
          identity={identity}
          asset={asset}
          balance={balance}
          gasWei={gasWei}
          gasChecking={gasChecking}
          online={online}
          prefill={scannedAddress != null ? {address: scannedAddress, amount: ''} : sendPrefill}
          onPrefillConsumed={() => { if (scannedAddress != null) setScannedAddress(null); else onSendPrefillConsumed?.(); }}
          onOpenAddressBook={onOpenAddressBook}
          onSent={() => { setClaims([]); onSent(); }}
          onClose={() => onSubModeChange('scan')}
          onSendActiveChange={setSendActive}
          onOpenReceipt={onOpenReceipt}
        />
      </View>
    );
  }

  // ── SCAN: the merchant's evmreq QR → OFFLINE sign → the evmpay QR hand-off ────────────────────
  function refuseScan(message: string) {
    setErr(message);
    setScanKey(k => k + 1);
  }

  async function onScan(raw: string) {
    let parsed: EvmReqV1;
    try {
      parsed = decodeEvmReq(raw);
    } catch {
      onNotARequest(raw);
      return;
    }
    // Client-side expiry (the SOL rule): a stale request is fully signable unless WE refuse it —
    // the merchant's settle refuses it again later (defense in depth, never a false pay).
    if (isEvmReqExpired(parsed)) {
      refuseScan(M.evm.requestExpired);
      return;
    }
    // The registry gate: the request names a (chain, token) pair the wallet can actually settle.
    if (resolveEvmTokenAddress(parsed.chainId, parsed.token) === null) {
      refuseScan(M.evm.unknownChain(parsed.chainId));
      return;
    }
    // Balance gate, fail-open on unknown (offline-first): a KNOWN-short balance signs a permit
    // the chain can never honor — refuse at the scan with the instruction that helps.
    if (balance != null && cmpRaw(parsed.amt, balance) > 0) {
      refuseScan(M.evm.notEnoughBalance(parsed.token));
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const signed = await signEvmPermitClaim(identity.secretHex, parsed);
      setReq(parsed);
      setPayUri(signed.claimUri);
      // The payer's own sent-claim record (D23's shared store, payer key): the pending badge's
      // durable fact, written the moment the QR renders (the persist-before-show discipline).
      const rows = await enqueueEvmClaim(claimsKey, {req: parsed, claim: signed.claim});
      setClaims(rows);
      setPhase('qr');
    } catch (e: unknown) {
      refuseScan(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onNotARequest(raw: string) {
    const what = classifyScan(raw);
    if (what.kind === 'link') { setErr(null); onScannedLink(raw.trim()); return; }
    if (what.kind === 'address') {
      setErr(null);
      setScannedAddress(raw.trim());
      onSubModeChange('send');
      return;
    }
    refuseScan(M.evm.badCode);
  }

  // Read-only: did a handed-off claim's Transfer already land? Flips settled rows + the badge.
  async function checkPendingClaims() {
    if (checkBusy) return;
    setCheckBusy(true);
    setCheckNote(null);
    try {
      const pending = (await loadEvmClaims(claimsKey)).filter(c => c.status === 'queued' || c.status === 'unknown');
      for (const row of pending) {
        const token = resolveEvmTokenAddress(row.req.chainId, row.req.token);
        if (token === null) continue;
        const found = await findEvmSettledTransfer(row.req.chainId, token, row.claim.owner, row.req.to, row.req.amt);
        if (found !== null) {
          await patchEvmClaim(claimsKey, row.claim.rid, {status: 'settled', txHash: found, settledAtMs: Date.now(), failDetail: null});
        }
      }
      const rows = await loadEvmClaims(claimsKey);
      setClaims(rows);
      const stillPending = rows.some(c => c.status === 'queued' || c.status === 'unknown');
      setCheckNote(stillPending ? M.evm.stillAwaiting : M.evm.settledOnChain);
    } catch {
      setCheckNote(M.evm.stillAwaiting);
    } finally {
      setCheckBusy(false);
    }
  }

  function reset() {
    setReq(null);
    setPayUri(null);
    setErr(null);
    setCheckNote(null);
    setScanArmed(false);
    setScanKey(k => k + 1);
    setPhase('scan');
  }

  const claimedName = req ? sanitiseDisplayText(req.name) : '';
  const claimedMemo = req ? sanitiseDisplayText(req.memo) : '';
  const amountText = (r: EvmReqV1) => fmtAssetCompact(r.amt, decimals, unit, undefined, asset.minFractionDigits);

  if (phase === 'qr' && payUri && req) {
    return (
      <View style={S.center}>
        <Text style={S.label}>{M.evm.showToMerchant}</Text>
        <View testID="evm-pay-qr" style={S.qrCard}><QrCode value={payUri} size={QR_SIZE} ecl="L" /></View>
        <Text testID="evm-pay-amount" style={S.amountBig}>{M.pay.amountToWho(amountText(req), claimedName || short(req.to))}</Text>
        {claimedName ? <Text testID="evm-pay-payee" style={S.dim2}>{short(req.to)}</Text> : null}
        {claimedMemo ? <Text testID="evm-pay-memo" style={S.dim2}>{claimedMemo}</Text> : null}
        <Text testID="evm-pay-signed" style={S.badgeOk}>{M.pay.signedOffline}</Text>
        {/* signingOffline is NOT repeated here: the badge above already states it, and a fact
            stated twice is the failure mode the founder rule names. The string still serves the
            scan-phase busy line below. */}
        <View style={S.confirmRow}>
          <Pressable
            testID="btn-evm-pay-handed"
            style={S.paidBtn}
            onPress={() => setPhase('paid')}
            accessibilityRole="button"
            accessibilityLabel={M.evm.handedToMerchant}
            accessibilityState={{disabled: false}}>
            <Text style={S.paidBtnText}>{M.evm.handedToMerchant}</Text>
          </Pressable>
          <Pressable testID="btn-evm-pay-cancel" style={S.notPaidBtn} onPress={reset} accessibilityRole="button" accessibilityLabel={M.common.cancel} accessibilityState={{disabled: false}}>
            <Text style={S.notPaidText}>{M.common.cancel}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (phase === 'paid') {
    return (
      <View style={S.center}>
        <View style={[S.check, S.checkAlready]}><IconClock size={44} color={C.brandInk}/></View>
        <Text testID="evm-pay-status" style={[S.paidText, S.alreadyText]}>{M.pay.sent(req ? amountText(req) : null)}</Text>
        <Text style={S.paidSub}>{M.evm.awaitingSettlement(req ? claimedName || short(req.to) : null)}</Text>
        <Pressable testID="btn-evm-pay-done" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={reset} accessibilityRole="button" accessibilityLabel={M.pay.newPayment} accessibilityState={{disabled: false}}>
          <Text style={S.ghostBtnText}>{M.pay.newPayment}</Text>
        </Pressable>
      </View>
    );
  }

  // phase === 'scan'
  return (
    <View style={S.center}>
      {toggle}
      {/* The pending-claims notice — where SOL shows the analogous payment state (D25): an
          offline hand-off is honestly pending until the merchant settles it on-chain. */}
      {pendingClaims.length > 0 ? (
        <View testID="evm-pay-pending" style={S.reviewCard}>
          <Text style={S.reviewLabel}>{M.evm.pendingBadge(pendingClaims.length)}</Text>
          {checkNote != null ? <Text testID="evm-pay-check-note" style={S.dim2}>{checkNote}</Text> : null}
          <Pressable testID="btn-evm-pay-check" style={S.smallBtn} disabled={checkBusy} onPress={() => { void checkPendingClaims(); }} accessibilityRole="button" accessibilityLabel={M.evm.checkNow} accessibilityState={{disabled: checkBusy}}>
            <Text style={S.smallBtnText}>{checkBusy ? M.evm.settling : M.evm.checkNow}</Text>
          </Pressable>
        </View>
      ) : null}
      <View testID="evm-pay-scan" style={S.scanWrap}>
        <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 8}}>
          <IconScan size={18} color={C.sub}/>
          <Text style={[S.dim2, {marginTop: 0}]}>{M.evm.scanHint}</Text>
        </View>
        {scanArmed ? (
          <QrScanner key={scanKey} onScan={(v) => { void onScan(v); }} />
        ) : (
          <Pressable
            testID="btn-evm-start-scan"
            style={S.primary}
            onPress={() => setScanArmed(true)}
            accessibilityRole="button"
            accessibilityLabel={M.pay.payNowA11y}
            accessibilityHint={M.pay.payNowHint}
            accessibilityState={{disabled: false}}>
            <Text style={S.primaryText}>{M.pay.payNow}</Text>
          </Pressable>
        )}
      </View>
      {busy ? (
        <Text testID="evm-pay-signing" style={S.dim2}>{M.evm.signingOffline}</Text>
      ) : null}
      {err ? <Text testID="evm-pay-err" style={S.err}>{err}</Text> : null}
    </View>
  );
}
