import {useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {fmtAssetCompact, fmtTime, short} from '../lib/format';
import {cmpRaw} from '../lib/amount';
import {withTimeout} from '../lib/timeout';
import {detectAddressShape, chainNameOfShape} from '../lib/destination';
import type {Identity, Txn} from '../lib/types';
import type {SelectableAsset} from '../config/assets';
import {
  deriveEvmAddress,
  isValidEvmAddress,
  isEvmRailConfigured,
  quoteEvmFee,
  sendErc20,
  preloadEvmRpc,
  getEvmReceiptStatus,
  isEvmGasGateError,
  isEvmWrongChainError,
  type EvmFeeQuote,
} from '../evm';
import {encodeTransfer} from '../evm/abi';
import {toHex0x} from '../evm/tx';
import {fromBaseUnits, toBaseUnitsSoft} from '../evm/chains';
import {eip55ChecksumBad} from '../lib/eip55';
import {loadAddressBook, rememberAddress, forgetAddress, type SavedAddress} from '../services/addressBook';
import {saveTxNote} from '../services/txNotes';
import {awardPaymentTested} from '../lib/readiness';
import {useJourney} from '../lib/journey';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {AddressField} from './AddressField';
import {SendTerminal} from './SendTerminal';
import {QrCode} from './QrCode';
import {QR_SIZE_SMALL} from '../config/constants';
import {M} from '../i18n';

/** The whole-sheet submit bound (the D10 table's last row): import 10s + receipt poll 60s +
 *  slack for the gate reads — a send that outlives this REJECTS into the honest unknown. */
const EVM_SHEET_TIMEOUT_MS = 90_000;

/**
 * EvmWithdrawSheet — send the selected EVM token to a 0x address (D15). The
 * `SolanaWithdrawSheet` mirror: form → submitting → done/unknown/error phases, the shared
 * `AddressField` + address book + `SendTerminal`, one honest split around the broadcast
 * boundary (`onBroadcast` fires the moment the network ACCEPTS — a throw after it is UNKNOWN,
 * never an error that invites a resend).
 *
 * The rail's own disclosures are the FEE LINE and the GAS HONESTY GATE (D15): the sheet quotes
 * the chain's own arithmetic while the form fills ("Fee ≈ 0.0001 ETH (estimate)" — dpay never
 * quotes; this is estimateGas + gasPrice over the user's typed inputs), and a send whose gas
 * cannot be covered REFUSES with the instructive gate surface — fee named, the payer's own 0x
 * address (QR) to receive gas at, amount retained, nothing broadcast. The wrong-chain guard
 * renders its own copy naming both chains.
 */
export function EvmWithdrawSheet({identity, asset, balance, gasWei, gasChecking = false, online = true, prefill = null, onPrefillConsumed, onOpenAddressBook, onSent, onClose, onSendActiveChange, onReviewShown, onOpenReceipt}: {
  identity: Identity;
  /** The SELECTED EVM asset row — the send spends THIS token on THIS chain. */
  asset: SelectableAsset & {protocol: 'evm'};
  /** The token's LAST-KNOWN raw balance — null when never read (the stale-ok rule). */
  balance: string | null;
  /** The chain's native (gas) balance in wei, from the balance poll — null when never read. */
  gasWei: string | null;
  gasChecking?: boolean;
  online?: boolean;
  prefill?: {address: string; amount: string; label?: string; memo?: string} | null;
  onPrefillConsumed?: () => void;
  onOpenAddressBook?: () => void;
  onSent: () => void;
  onClose: () => void;
  onSendActiveChange?: (active: boolean) => void;
  onReviewShown?: (shown: boolean) => void;
  onOpenReceipt?: (t: Txn) => void;
}) {
  const [address, setAddress] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [phase, setPhase] = useState<'form' | 'submitting' | 'done' | 'unknown' | 'error' | 'gasgate'>('form');
  const [err, setErr] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [gate, setGate] = useState<{requiredWei: string; address: string} | null>(null);
  const [saved, setSaved] = useState<SavedAddress[]>([]);
  const [saveName, setSaveName] = useState('');
  const [quote, setQuote] = useState<EvmFeeQuote | null>(null);
  const [quotePending, setQuotePending] = useState(false);
  const quoteSeq = useRef(0);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [linkNote, setLinkNote] = useState<{who: string; msg: string; for: string} | null>(null);
  const {journey} = useJourney();

  useEscapeToClose(onClose);

  // Warm the network module off the money path (the SolanaWithdrawSheet discipline).
  useEffect(() => { preloadEvmRpc(); }, []);

  const sendActive = phase !== 'form';
  useEffect(() => { onSendActiveChange?.(sendActive); }, [sendActive, onSendActiveChange]);
  useEffect(() => () => onSendActiveChange?.(false), []);

  // Pay-link prefill — the SOL sheet's contract verbatim: pre-fill only, the presses below are
  // the consent, consumed as taken.
  useEffect(() => {
    if (prefill == null || phase !== 'form') return;
    setAddress(prefill.address);
    setAmountStr(prefill.amount);
    setLinkNote((prefill.label ?? '') !== '' || (prefill.memo ?? '') !== '' ? {who: prefill.label ?? '', msg: prefill.memo ?? '', for: prefill.address} : null);
    onPrefillConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, phase]);

  const {chainId, chainName} = {chainId: asset.chainId, chainName: asset.chainName};
  const decimals = asset.decimals;
  const unit = asset.symbol;
  const fmt = (rawAmount: string) => fmtAssetCompact(rawAmount, decimals, unit, undefined, asset.minFractionDigits);
  const assetKey = asset.id;

  useEffect(() => {
    let alive = true;
    loadAddressBook(assetKey).then(list => { if (alive) setSaved(list); });
    return () => { alive = false; };
  }, [assetKey]);

  // The wallet's own EVM address — the self-send warning (pure derivation, like the SOL sheet).
  const selfAddress = useMemo(() => {
    try { return deriveEvmAddress(identity.secretHex); }
    catch (e) { console.warn('deriveEvmAddress failed:', e instanceof Error ? e.message : String(e)); return null; }
  }, [identity.secretHex]);

  // The typed destination. Synchronous shape checks here; the CHAIN proves itself at quote time.
  // Narrowed once into `destination` so every consumer below reads a plain string | null.
  const resolved = useMemo((): {ok: boolean; destination: string; message: string; tone: 'bad' | 'warn' | 'ok'} | null => {
    const text = address.trim();
    if (text.length === 0) return null;
    if (!isValidEvmAddress(text)) {
      const shape = detectAddressShape(text);
      if (shape === 'evm' || shape === 'unknown') return {ok: false, destination: text, message: M.evm.badAddress, tone: 'bad'};
      return {ok: false, destination: text, message: M.evm.wrongChain(asset.chainName, chainNameOfShape(shape) ?? ''), tone: 'bad'};
    }
    if (selfAddress != null && text.toLowerCase() === selfAddress.toLowerCase()) {
      // Self-sends are legal — warn, never block (the SOL sheet's rule).
      return {ok: true, destination: text, message: M.evm.selfSend, tone: 'warn'};
    }
    const badSum = eip55ChecksumBad(text);
    // D15.1: a checksum verdict is a WARNING with an explicit continue, never a block — a
    // fully-lower/upper address is legal EVM with nothing to check, and a mismatch is the
    // sender's typo to catch by reading the warning, not by a disabled button.
    if (badSum === true) return {ok: true, destination: text, message: M.evm.badChecksum, tone: 'warn'};
    if (badSum === null) return {ok: true, destination: text, message: M.evm.uncheckableChecksum, tone: 'warn'};
    return {ok: true, destination: text, message: M.evm.route(asset.chainName), tone: 'ok' as 'bad' | 'warn' | 'ok'};
  }, [address, selfAddress, asset.chainName]);
  const destination = resolved != null && resolved.ok ? resolved.destination : null;

  // uint256-width soft parse: toUnits' u64 bound would read 42 ZCHF (18 dec) as overflow.
  const raw = toBaseUnitsSoft(amountStr, decimals);
  const balanceKnown = balance != null;
  const overBalance = balanceKnown && cmpRaw(raw, balance!) > 0;
  const canReview = resolved?.ok === true && raw !== '0' && balanceKnown && !overBalance;

  // The fee quote (D15.2) — the chain's OWN arithmetic over the typed inputs, debounced while
  // the user types. A failed quote renders '—' and the confirm re-quotes anyway (the gate runs
  // inside the send regardless of what the line showed).
  useEffect(() => {
    const seq = ++quoteSeq.current;
    setQuote(null);
    setQuotePending(false);
    if (destination === null || raw === '0' || !isEvmRailConfigured()) return;
    const data = toHex0x(encodeTransfer(destination, BigInt(raw)));
    setQuotePending(true);
    const t = setTimeout(() => {
      quoteEvmFee(chainId, deriveEvmAddress(identity.secretHex), asset.address, data)
        .then(q => { if (seq === quoteSeq.current) { setQuote(q); setQuotePending(false); } })
        .catch((e: unknown) => {
          if (seq !== quoteSeq.current) return;
          console.warn('evm fee quote failed:', e instanceof Error ? e.message : String(e));
          setQuote(null);
          setQuotePending(false);
        });
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, raw, chainId, asset.address]);

  const reviewVisible = (phase === 'form' || phase === 'error') && raw !== '0';
  const reviewShownRef = useRef(false);
  useEffect(() => {
    if (!reviewVisible || reviewShownRef.current) return;
    reviewShownRef.current = true;
    onReviewShown?.(true);
  }, [reviewVisible, onReviewShown]);

  const notedDestination = linkNote != null && address.trim() === linkNote.for && linkNote.who !== ''
    ? linkNote.who
    : null;

  async function confirm() {
    if (!canReview || destination === null) {
      console.warn(`money: evm send confirm pressed but NOT sendable (canReview=${canReview}, resolved=${resolved?.ok === true})`);
      return;
    }
    const to = destination;
    console.warn(`money: evm send sheet submit ${unit} to=${to} amount=${raw} chain=${chainId}`);
    setPhase('submitting');
    setErr(null);
    setAccepted(false);
    setCheckFailed(false);
    setCheckErr(null);
    setGate(null);
    setSentTo(to);
    const {signal, cancel} = withTimeout(EVM_SHEET_TIMEOUT_MS);
    const broadcast: {hash: string | null} = {hash: null};
    try {
      const {txHash: hash} = await sendErc20(identity.secretHex, {
        chainId, tokenAddress: asset.address, to, rawAmount: amountStr, decimals,
      }, signal, (h) => { broadcast.hash = h; setAccepted(true); });
      setTxHash(hash);
      setPhase('done');
      void rememberAddress(assetKey, to, saveName.trim(), Date.now());
      if (linkNote != null && to === linkNote.for) {
        void saveTxNote(identity.publicHex, {k: hash.toLowerCase(), who: linkNote.who || undefined, msg: linkNote.msg || undefined}, Date.now());
      }
      onSent();
      awardPaymentTested(journey);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`money: evm send sheet ERROR (accepted=${broadcast.hash !== null}): ${msg}`);
      if (isEvmGasGateError(e)) {
        // THE GATE (D15.3): refused BEFORE any signing material existed. Amount retained; the
        // gate surface instructs (fee, receive-ETH at the payer's own 0x).
        const g = e as unknown as {requiredWei: string; address: string};
        setGate({requiredWei: g.requiredWei, address: g.address});
        setPhase('gasgate');
        return;
      }
      if (broadcast.hash !== null) {
        // The network ACCEPTED; only the receipt is missing — the honest unknown, never a retry.
        setTxHash(broadcast.hash);
        setPhase('unknown');
        onSent();
        return;
      }
      setErr(isEvmWrongChainError(e)
        ? M.evm.wrongChain(asset.chainName, String((e as unknown as {actualChainId?: number}).actualChainId ?? ''))
        : friendly(msg));
      setPhase('error');
    } finally {
      cancel();
    }
  }

  /** The unknown terminal's read-only re-read of the chain (the SolanaWithdrawSheet contract):
   *  included ⇒ settled; failed ⇒ the terminal failed panel; pending/unknown ⇒ the honest
   *  pending stays; a throw ⇒ a check-failed line, the pending STAYS. */
  async function checkStatus() {
    if (!txHash || checkBusy) return;
    setCheckBusy(true);
    setCheckErr(null);
    try {
      const st = await getEvmReceiptStatus(chainId, txHash);
      if (st === 'included') { setPhase('done'); awardPaymentTested(journey); return; }
      if (st === 'failed') { setCheckFailed(true); return; }
    } catch (e: unknown) {
      setCheckErr(M.evm.tryAgain);
      console.warn('evm send sheet check failed:', e instanceof Error ? e.message : String(e));
    } finally {
      setCheckBusy(false);
    }
  }

  const status = resolved == null || resolved.ok ? (resolved != null && resolved.ok ? {text: M.evm.route(asset.chainName), tone: 'ok' as const} : null) : {text: resolved.message, tone: resolved.tone};
  const feeLine = quote != null ? M.evm.feeEstimate(fmtNative(quote.maxFeeWei)) : quotePending ? '…' : '—';

  const body = (
    <>
      {(phase === 'done' || (phase === 'unknown' && txHash)) ? (
        <SendTerminal
          settled={phase === 'done'}
          failed={phase === 'unknown' && checkFailed}
          headline={phase === 'done' ? M.evm.sentSeenOn(chainName) : checkFailed ? M.evm.failedTitle : M.evm.sentUnknownTitle}
          amountText={fmt(raw)}
          destinationLabel={M.evm.reviewTo}
          destination={sentTo}
          pendingBody={checkFailed ? undefined : M.evm.sentUnknownBody(chainName)}
          failedBody={checkFailed ? M.evm.failedBody : undefined}
          referenceLabel={M.evm.txHash}
          reference={txHash ?? ''}
          refTestID="evm-send-hash"
          prefix="evm-send"
          onOpenReceipt={onOpenReceipt != null && txHash != null
            ? () => onOpenReceipt({
                nonce: txHash!.toLowerCase(),
                amount: raw,
                who: '',
                memo: '',
                time: fmtTime(Date.now()),
                ts: Date.now(),
                dir: 'out',
                assetId: asset.id,
                counterparty: sentTo,
                ledgerRef: txHash!.toLowerCase(),
                ...(phase === 'unknown' && !checkFailed ? {pending: true as const} : {}),
              })
            : undefined}
          onCheckStatus={phase === 'unknown' ? () => { void checkStatus(); } : undefined}
          checkBusy={checkBusy}
          checkErr={checkErr}
          onDone={onClose}
        />
      ) : phase === 'submitting' ? (
        <View style={S.centerAll}>
          <ActivityIndicator color={C.brandText} />
          <Text style={S.dim2}>{M.evm.sending(fmt(raw))}</Text>
          <Text style={S.dim2}>{M.evm.confirming(chainName)}</Text>
        </View>
      ) : phase === 'gasgate' && gate != null ? (
        // THE REFUSAL SCREEN (D15.3) — instructs: the fee, the chain, the payer's own address.
        <View style={S.sheetBody}>
          <View testID="evm-send-gasgate" style={S.reviewCard}>
            <Text style={S.reviewLabel}>{M.evm.gasGateTitle}</Text>
            <Text testID="evm-send-gasgate-body" style={S.warnNote}>
              {M.evm.gasGateBody(fmtNative(gate.requiredWei), chainName)}
            </Text>
            <Text style={S.dim2}>{M.evm.gasGateAddressLabel('ETH')}</Text>
            <Text testID="evm-send-gasgate-addr" selectable={true} style={S.sheetAddr}>{gate.address}</Text>
            <View testID="evm-send-gasgate-qr" style={S.qrCard}><QrCode value={gate.address} size={QR_SIZE_SMALL} ecl="M" /></View>
          </View>
          <Pressable
            testID="btn-evm-send-gasgate-retry"
            style={S.primaryWide}
            onPress={() => { setPhase('form'); setGate(null); void confirm(); }}
            accessibilityRole="button"
            accessibilityLabel={M.evm.gasGateReady}
            accessibilityState={{disabled: false}}>
            <Text style={S.primaryText}>{M.evm.gasGateReady}</Text>
          </Pressable>
          <Pressable testID="btn-evm-send-gasgate-back" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={() => { setPhase('form'); setGate(null); }} accessibilityRole="button" accessibilityLabel={M.common.cancel} accessibilityState={{disabled: false}}>
            <Text style={S.ghostBtnText}>{M.common.cancel}</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Text style={S.label}>{M.evm.sendTo(unit, chainName)}</Text>
          {balance != null ? <Text style={S.dim2}>{M.evm.available(fmt(balance))}</Text> : null}

          <AddressField
            value={address}
            onChange={setAddress}
            status={status}
            saved={saved}
            onPickSaved={setAddress}
            onForgetSaved={a => { void forgetAddress(assetKey, a).then(setSaved); }}
            onManageSaved={onOpenAddressBook}
            testIDPrefix="evm-send"
          />

          {resolved?.ok && saved.every(sv => sv.address !== resolved.destination) ? (
            <TextInput
              testID="evm-send-save-name"
              accessibilityLabel={M.evm.reviewTo}
              style={S.withdrawAddrInput}
              value={saveName}
              onChangeText={setSaveName}
              placeholder={M.evm.reviewTo}
              placeholderTextColor={C.sub2}
              autoCapitalize="words"
            />
          ) : null}

          <Text style={S.inputLabel}>{M.evm.amountLabel(unit)}</Text>
          <TextInput
            testID="evm-send-amount-input"
            accessibilityLabel={M.evm.amountLabel(unit)}
            style={S.withdrawAmtInput}
            value={amountStr}
            onChangeText={setAmountStr}
            keyboardType="decimal-pad"
            placeholder={M.evm.amountPlaceholder}
            placeholderTextColor={C.sub2}
          />

          {overBalance ? <Text testID="evm-send-overbal" style={S.warnNote}>{M.pay.notEnoughBalance}</Text> : null}
          {/* Native-gas visibility (D19): the fee pays in ETH even though the row is ZCHF. */}
          {!gasChecking && gasWei === '0' ? <Text testID="evm-send-needs-gas" style={S.warnNote}>{M.evm.needsGas(unit)}</Text> : null}

          {(phase === 'form' || phase === 'error') && raw !== '0' ? (
            <View testID="evm-send-review" style={S.reviewCard}>
              <Text style={S.reviewLabel}>{M.evm.reviewTitle}</Text>
              <Text testID="evm-send-review-amount" style={S.reviewAmount}>{M.evm.reviewAmount(fmt(raw))}</Text>
              <View style={S.reviewRow}>
                <Text style={S.reviewRowLabel}>{M.evm.feeLabel}</Text>
                <Text testID="evm-send-review-fee" style={S.reviewRowValue}>{feeLine}</Text>
              </View>
              {notedDestination != null ? (
                <>
                  <Text style={S.reviewTo}>{M.pay.toWho(notedDestination)}</Text>
                  <Text testID="evm-send-review-payee" style={S.dim2}>{short(address.trim() || '—')}</Text>
                </>
              ) : (
                <Text testID="evm-send-review-payee" style={S.reviewTo}>{address.trim() || '—'}</Text>
              )}
            </View>
          ) : null}

          {err ? <Text testID="evm-send-err" style={S.err}>{err}</Text> : null}
          {phase === 'error' && !accepted ? <Text testID="evm-send-nothing-sent" style={S.dim2}>{M.evm.nothingSent}</Text> : null}
          {!online ? <Text testID="evm-send-offline-note" style={S.warnNote}>{M.withdraw.offlineReviewNote}</Text> : null}

          <Pressable
            testID="btn-evm-send-confirm"
            style={[S.primaryWide, !canReview && S.disabledFlat]}
            disabled={!canReview}
            onPress={confirm}
            accessibilityRole="button"
            accessibilityLabel={M.evm.confirm(fmt(raw))}
            accessibilityState={{disabled: !canReview}}>
            <Text style={[S.primaryText, !canReview && S.disabledText]}>{raw !== '0' ? M.evm.confirm(fmt(raw)) : M.evm.enterAmount}</Text>
          </Pressable>

          {Platform.OS === 'web' ? <Text style={S.dim2}>{M.withdraw.pressEsc}</Text> : null}
        </>
      )}
    </>
  );

  return <View style={S.sheetBody}>{body}</View>;
}

// ── Local helpers (module-scope, pure) ─────────────────────────────────────────────────────────

function fmtNative(wei: string): string {
  return fromBaseUnits(BigInt(wei), 18) + ' ETH';
}

function friendly(msg: string): string {
  if (/failed to load|engine chunk/.test(msg)) return M.evm.engineLoad;
  return msg;
}
