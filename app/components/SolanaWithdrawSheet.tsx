import {useEffect, useMemo, useState} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {SOL_SEND_TIMEOUT_MS} from '../config/constants';
import {fmtAsset, toUnits} from '../lib/format';
import {cmpRaw} from '../lib/amount';
import {useJourney} from '../lib/journey';
import {awardPaymentTested} from '../lib/readiness';
import {detectAddressShape, routeForSolana, chainNameOfShape} from '../lib/destination';
import type {Identity} from '../lib/types';
import {SOL_DECIMALS, SOL_UNIT, deriveSolanaAddress, isValidSolanaAddress} from '../solana/identity';
import {USDC_DECIMALS, SOL_ATA_SETUP_MIN_LAMPORTS} from '../solana/spl';
import {sendSol, sendSpl} from '../solana';
import {friendlySolError} from '../solana/errors';
import {loadAddressBook, rememberAddress, forgetAddress, type SavedAddress} from '../services/addressBook';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {withTimeout} from '../lib/timeout';
import {AddressField} from './AddressField';
import {SolanaAtaSetupCard} from './SolanaAtaSetupCard';
import {IconCheck, IconCopy} from './icons';
import {M} from '../i18n';

/** The chain this rail settles on. Wire/display proper noun, never translated — the twin of
 *  SendSheet's `IC_NETWORK`. */
const SOL_NETWORK = 'Solana';

/**
 * Send SOL or USDC to a native Solana address (Phase 6 — asset-aware direct send). Mirrors
 * WithdrawSheet's form/submitting/done/error phases, but signs LOCALLY on the device (SLIP-10
 * ed25519 via noble) and broadcasts directly to the Solana RPC — no relay, no DpayCore, no facade.
 * The non-custodial gate is the on-device SLIP-10 key itself.
 *
 * The `token` prop selects which transfer path runs:
 *   - 'SOL'  → System Program Transfer (sendSol). `balance` is lamports (9 decimals).
 *   - 'USDC' → SPL Token transfer (sendSpl). `balance` is USDC base units (6 decimals). The recipient
 *              is still a base58 Solana WALLET address — the recipient ATA is derived internally by
 *              sendSpl. If the recipient has NO USDC account yet, sendSpl creates it IN THE SAME
 *              transaction (real createIdempotent instruction; the sender pays the one-time rent,
 *              disclosed on the review card via `sol-send-ata-note`). The device's source ATA is
 *              pre-checked here via `usdcAtaAbsent` — when absent, the form is replaced by the
 *              same one-tap "Create my USDC account" setup card the Receive tab has (2026-08-14;
 *              was a dead-end "set one up elsewhere" message).
 *
 * Rendered inline in the Pay tab's "Send to address" sub-mode. The testIDs stay token-agnostic
 * (`sol-send-*`) — "send" applies to both SOL and SPL. The review-amount text carries the unit
 * (USDC vs SOL) so e2e can distinguish them.
 *
 * The destination is the SHARED `AddressField` — the same input, scanner button and saved-address
 * list the IC rail uses — over the shared `destination.ts` classifier. Before this it was a bare
 * TextInput whose only verdict was "not a valid Solana address", which cannot tell a typo from a
 * Bitcoin address pasted into the wrong wallet, and which offered neither a scanner nor an address
 * book that the IC surface had. CLAUDE.md's same-surfaces rule calls that divergence a bug.
 */
export function SolanaWithdrawSheet({identity, token, balance, usdcAtaAbsent, solBalance = null, solChecking = false, ataSetupBusy = false, ataSetupErr = null, onCreateAta, onShowSolAddress, prefill = null, onPrefillConsumed, onSent, onClose}: {identity: Identity; token: 'SOL' | 'USDC'; balance: string; usdcAtaAbsent?: boolean; solBalance?: string | null; solChecking?: boolean; ataSetupBusy?: boolean; ataSetupErr?: string | null; onCreateAta?: () => void; onShowSolAddress?: () => void; prefill?: {address: string; amount: string} | null; onPrefillConsumed?: () => void; onSent: () => void; onClose: () => void}) {
  const [address, setAddress] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [phase, setPhase] = useState<'form' | 'submitting' | 'done' | 'error'>('form');
  const [err, setErr] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedAddress[]>([]);
  const [saveName, setSaveName] = useState('');
  // Trip Ready J5b — paymentTested: the same stamp the IC rails award, on the same event (a send
  // that CONFIRMED). `sendSol`/`sendSpl` resolve only on a confirmed signature and throw otherwise,
  // so the catch below — the honest "we don't know" path — never reaches the award.
  const {journey} = useJourney();
  const {copied, copy: doCopy} = useCopyFeedback();

  useEscapeToClose(onClose);

  // A shared payment link resolved to this rail: fill the form with its destination + amount and
  // let the payer confirm. It ONLY pre-fills — the Review/Send presses below are still the consent,
  // exactly as when the user types the two fields by hand. Guarded on the form phase so an incoming
  // link can never rewrite a send that is already submitting, and consumed as it is taken so the
  // payer's own edits are never overwritten by a re-render.
  useEffect(() => {
    if (prefill == null || phase !== 'form') return;
    setAddress(prefill.address);
    setAmountStr(prefill.amount);
    onPrefillConsumed?.();
    // onPrefillConsumed is an inline closure; the [prefill, phase] guard + immediate clear make its
    // identity irrelevant (exhaustive-deps would force a re-run on every render's new closure).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, phase]);

  const decimals = token === 'SOL' ? SOL_DECIMALS : USDC_DECIMALS;
  const unit = token === 'SOL' ? SOL_UNIT : 'USDC';
  const isUsdc = token === 'USDC';
  // Every amount on this sheet is the same token at the same precision — one formatter, one place.
  const fmt = (rawAmount: string) => fmtAsset(rawAmount, decimals, unit);

  // Per-token address book, mirroring the IC rail's `ic:<currency>` key: SOL and USDC are sent to
  // the same KIND of address but to different people, so one shared list would mix two audiences.
  const assetKey = `sol:${token}`;
  useEffect(() => {
    let alive = true;
    loadAddressBook(assetKey).then(list => { if (alive) setSaved(list); });
    return () => { alive = false; };
  }, [assetKey]);

  // The wallet's own Solana address — the self-send warning. Derivation is pure and synchronous
  // here (SLIP-10 over the device seed), unlike the IC rail's async core validators.
  const selfAddress = useMemo(() => deriveSolanaAddress(identity.secretHex), [identity.secretHex]);

  // Convert the entered amount to base units at the selected token's decimals. `cmpRaw` (BigInt) for
  // presence — never `>` on strings (lexicographic trap).
  const raw = toUnits(amountStr, decimals);
  const overBalance = cmpRaw(raw, balance) > 0;

  // What the typed destination IS. Two stages, exactly as the IC rail: `detectAddressShape` names
  // the NAMESPACE and `routeForSolana` says whether this rail can reach it, then the rail's own
  // parser decides validity — so a checksum failure is reported against a known namespace ("not a
  // valid Solana address") instead of being lumped in with a Bitcoin address pasted by mistake.
  // Synchronous, so no resolution race to guard: `isValidSolanaAddress` is a local base58 decode.
  const resolved = useMemo((): {ok: true; destination: string} | {ok: false; message: string} | null => {
    const text = address.trim();
    if (text.length === 0) return null;
    const routed = routeForSolana(detectAddressShape(text));
    if (!routed.ok) {
      return routed.refusal.reason === 'wrong-chain'
        ? {ok: false, message: M.withdraw.send.refuseWrongChain(chainNameOfShape(routed.refusal.shape) ?? '', unit, SOL_NETWORK)}
        : {ok: false, message: M.withdraw.send.refuseUnrecognised(unit)};
    }
    if (!isValidSolanaAddress(text)) return {ok: false, message: M.withdraw.badAddress(SOL_NETWORK)};
    return {ok: true, destination: text};
  }, [address, unit]);

  // The one status line under the field: the route when usable, the specific reason when not.
  const status = useMemo((): {text: string; tone: 'ok' | 'warn' | 'bad'} | null => {
    if (resolved == null) return null;
    if (!resolved.ok) return {text: resolved.message, tone: 'bad'};
    if (resolved.destination === selfAddress) return {text: M.withdraw.send.selfWarning, tone: 'warn'};
    return {text: M.withdraw.send.routeSolana(SOL_NETWORK), tone: 'ok'};
  }, [resolved, selfAddress]);

  const canReview = resolved?.ok === true && raw !== '0' && !overBalance;

  async function confirm() {
    if (!canReview || !resolved?.ok) {
      return;
    }
    const destination = resolved.destination;
    setPhase('submitting');
    setErr(null);
    const {signal, cancel} = withTimeout(SOL_SEND_TIMEOUT_MS);
    try {
      // Branch on token: SOL → System Transfer; USDC → SPL Token transfer (recipient ATA derived +
      // fail-closed checked inside sendSpl). Both sign locally + broadcast directly to the RPC.
      const sig = isUsdc
        ? await sendSpl(identity.secretHex, destination, BigInt(raw), signal)
        : await sendSol(identity.secretHex, destination, BigInt(raw), signal);
      setSignature(sig);
      setPhase('done');
      void rememberAddress(assetKey, destination, saveName.trim(), Date.now());
      onSent(); // trigger an immediate balance refresh (SOL or USDC — the parent wires the right one)
      awardPaymentTested(journey);
    } catch (e: unknown) {
      // A Solana RPC error (insufficient funds / rent-exempt violation / network / missing ATA) or abort.
      setErr(friendlySolError(e instanceof Error ? e.message : String(e)));
      setPhase('error');
    } finally {
      cancel();
    }
  }

  const copySig = async () => {
    if (signature) { await doCopy(signature); }
  };

  // Phase 6 fail-closed + 2026-08-14 setup action: USDC send when the device's ATA is KNOWN absent
  // → the shared one-tap setup card (SolanaAtaSetupCard — same surface as the Receive tab). You
  // can't send USDC you don't have an account for; the card offers the REAL one-tap create
  // (device-key-signed createIdempotent tx) instead of a dead end. On success the parent's ATA
  // refresh flips `usdcAtaAbsent` and the form appears. Only 'absent' gates — loading/error/
  // unavailable states let the form through (the send itself fails honestly if the ATA is missing).
  if (isUsdc && usdcAtaAbsent) {
    const hasSol = solBalance != null && BigInt(solBalance) >= SOL_ATA_SETUP_MIN_LAMPORTS;
    const checkingSol = solBalance == null;
    return (
      <View style={S.sheetBody}>
        <SolanaAtaSetupCard
          instrTestID="sol-send-instructions"
          btnTestID="btn-sol-send-ata-create"
          buttonLabel={M.withdraw.sol.createAtaLabel}
          hasSol={hasSol}
          checkingSol={checkingSol}
          busy={ataSetupBusy}
          err={ataSetupErr}
          onCreateAta={onCreateAta}
          onShowSolAddress={onShowSolAddress}
        />
        <Pressable testID="btn-sol-send-done" style={[S.primaryWide, S.depositCopy]} onPress={onClose} accessibilityRole="button" accessibilityLabel={M.withdraw.sol.backToScan}><Text style={S.primaryText}>{M.withdraw.sol.backToScan}</Text></Pressable>
      </View>
    );
  }

  const body = (
    <>
      {phase === 'done' && signature ? (
        <View style={S.centerAll}>
          <View style={S.check}><IconCheck size={44} color={C.brandInk}/></View>
          <Text testID="sol-send-outcome" style={S.paidText}>{M.withdraw.sol.sent}</Text>
          <Text style={S.paidSub}>{fmt(raw)}</Text>
          <Text style={S.dim2}>{M.withdraw.sol.txSignature}</Text>
          <Text testID="sol-send-signature" selectable={true} style={S.sheetAddr}>{signature}</Text>
          <Pressable testID="btn-sol-send-copy" style={S.primaryWide} onPress={copySig} accessibilityRole="button" accessibilityLabel={M.withdraw.sol.copySignatureLabel}>
            <IconCopy size={18} color={C.brandInk}/>
            <Text style={S.primaryText}>{copied === 'clipboard' ? M.withdraw.copied : copied === 'shared' ? M.withdraw.shared : M.withdraw.sol.copySignature}</Text>
          </Pressable>
          <Text style={S.dim2}>{M.withdraw.balanceAuto}</Text>
          <Pressable testID="btn-sol-send-done" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={onClose} accessibilityRole="button" accessibilityLabel={M.common.done}><Text style={S.ghostBtnText}>{M.common.done}</Text></Pressable>
        </View>
      ) : phase === 'submitting' ? (
        <View style={S.centerAll}>
          <ActivityIndicator color={C.brand} />
          <Text style={S.dim2}>{M.withdraw.sol.sending(fmt(raw))}</Text>
          <Text style={S.dim2}>{M.withdraw.sol.confirmingOnSolana}</Text>
        </View>
      ) : (
        <>
          <Text style={S.label}>{M.withdraw.sol.sendToSolana(unit)}</Text>
          <Text style={S.dim2}>{M.withdraw.sol.available(fmt(balance))}</Text>

          <AddressField
            value={address}
            onChange={setAddress}
            status={status}
            saved={saved}
            onPickSaved={setAddress}
            onForgetSaved={a => { void forgetAddress(assetKey, a).then(setSaved); }}
            testIDPrefix="sol-send"
          />

          {/* Naming is offered once the destination is usable — the IC rail's placement exactly. */}
          {resolved?.ok && saved.every(sv => sv.address !== resolved.destination) ? (
            <TextInput
              testID="sol-send-save-name"
              accessibilityLabel={M.withdraw.send.saveNamePlaceholder}
              style={S.withdrawAddrInput}
              value={saveName}
              onChangeText={setSaveName}
              placeholder={M.withdraw.send.saveNamePlaceholder}
              placeholderTextColor={C.sub2}
              autoCapitalize="words"
            />
          ) : null}

          <Text style={S.inputLabel}>{M.withdraw.amountLabel(unit)}</Text>
          <TextInput
            testID="sol-send-amount-input"
            accessibilityLabel={M.withdraw.amountLabel(token)}
            style={S.withdrawAmtInput}
            value={amountStr}
            onChangeText={setAmountStr}
            keyboardType="decimal-pad"
            placeholder={isUsdc ? M.withdraw.sol.usdcAmountPlaceholder : M.withdraw.sol.solAmountPlaceholder}
            placeholderTextColor={C.sub2}
          />

          {overBalance ? <Text style={S.warnNote}>{M.withdraw.overBalance(fmt(balance))}</Text> : null}
          {/* Known-zero SOL while sending USDC (2026-08-16 UX review finding 13): fees + a possible
              recipient-ATA creation are paid in SOL — say so BEFORE the user types an amount, so
              a funded-USDC/zero-SOL wallet learns the real constraint up front (honest, no block). */}
          {isUsdc && !solChecking && solBalance === '0' ? <Text testID="sol-send-needs-sol" style={S.warnNote}>{M.withdraw.sol.needsSol}</Text> : null}

          {(phase === 'form' || phase === 'error') && raw !== '0' ? (
            <View testID="sol-send-review" style={S.reviewCard}>
              <Text style={S.reviewLabel}>{M.withdraw.sol.reviewTitle}</Text>
              <Text testID="sol-send-review-amount" style={S.reviewAmount}>{M.withdraw.sol.sendAmount(fmt(raw))}</Text>
              <Text style={S.reviewTo}>{M.withdraw.toDestination(address.trim() || '—')}</Text>
              {isUsdc ? (
                <Text testID="sol-send-ata-note" style={S.dim2}>
                  {M.withdraw.sol.recipientAtaNote(fmtAsset(String(SOL_ATA_SETUP_MIN_LAMPORTS), SOL_DECIMALS, SOL_UNIT))}
                </Text>
              ) : null}
            </View>
          ) : null}

          {err ? <Text testID="sol-send-err" style={S.err}>{err}</Text> : null}

          <Pressable
            testID="btn-sol-send-confirm"
            style={[S.primaryWide, !canReview && S.disabledFlat]}
            disabled={!canReview}
            onPress={confirm}
            accessibilityRole="button"
            accessibilityLabel={M.withdraw.sol.confirmLabel(unit)}
            accessibilityState={{disabled: !canReview}}>
            <Text style={S.primaryText}>{raw !== '0' ? M.withdraw.sol.sendAmount(fmt(raw)) : M.withdraw.enterAmount}</Text>
          </Pressable>

          {Platform.OS === 'web' ? <Text style={S.dim2}>{M.withdraw.pressEsc}</Text> : null}
        </>
      )}
    </>
  );

  return <View style={S.sheetBody}>{body}</View>;
}
