import {useState} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {SOL_SEND_TIMEOUT_MS} from '../config/constants';
import {fmtAsset, toUnits} from '../lib/format';
import {cmpRaw} from '../lib/amount';
import type {Identity} from '../lib/types';
import {SOL_DECIMALS, SOL_UNIT, isValidSolanaAddress} from '../solana/identity';
import {USDC_DECIMALS, SOL_ATA_SETUP_MIN_LAMPORTS} from '../solana/spl';
import {sendSol, sendSpl} from '../solana';
import {friendlySolError} from '../solana/errors';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {withTimeout} from '../lib/timeout';
import {SolanaAtaSetupCard} from './SolanaAtaSetupCard';

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
 */
export function SolanaWithdrawSheet({identity, token, balance, usdcAtaAbsent, solBalance = null, ataSetupBusy = false, ataSetupErr = null, onCreateAta, onSent, onClose}: {identity: Identity; token: 'SOL' | 'USDC'; balance: string; usdcAtaAbsent?: boolean; solBalance?: string | null; ataSetupBusy?: boolean; ataSetupErr?: string | null; onCreateAta?: () => void; onSent: () => void; onClose: () => void}) {
  const [address, setAddress] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [phase, setPhase] = useState<'form' | 'submitting' | 'done' | 'error'>('form');
  const [err, setErr] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const {copied, copy: doCopy} = useCopyFeedback();

  useEscapeToClose(onClose);

  const decimals = token === 'SOL' ? SOL_DECIMALS : USDC_DECIMALS;
  const unit = token === 'SOL' ? SOL_UNIT : 'USDC';
  const isUsdc = token === 'USDC';

  // Convert the entered amount to base units at the selected token's decimals. `cmpRaw` (BigInt) for
  // presence — never `>` on strings (lexicographic trap).
  const raw = toUnits(amountStr, decimals);
  const overBalance = cmpRaw(raw, balance) > 0;
  const addrEntered = address.trim().length > 0;
  const badAddr = addrEntered && !isValidSolanaAddress(address);
  const canReview = addrEntered && !badAddr && raw !== '0' && !overBalance;

  async function confirm() {
    if (!canReview) {
      return;
    }
    setPhase('submitting');
    setErr(null);
    const {signal, cancel} = withTimeout(SOL_SEND_TIMEOUT_MS);
    try {
      // Branch on token: SOL → System Transfer; USDC → SPL Token transfer (recipient ATA derived +
      // fail-closed checked inside sendSpl). Both sign locally + broadcast directly to the RPC.
      const sig = isUsdc
        ? await sendSpl(identity.secretHex, address.trim(), BigInt(raw), signal)
        : await sendSol(identity.secretHex, address.trim(), BigInt(raw), signal);
      setSignature(sig);
      setPhase('done');
      onSent(); // trigger an immediate balance refresh (SOL or USDC — the parent wires the right one)
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
    return (
      <View style={S.sheetBody}>
        <SolanaAtaSetupCard
          instrTestID="sol-send-instructions"
          btnTestID="btn-sol-send-ata-create"
          buttonLabel="Create my USDC account"
          hasSol={hasSol}
          busy={ataSetupBusy}
          err={ataSetupErr}
          onCreateAta={onCreateAta}
        />
        <Pressable testID="btn-sol-send-done" style={[S.primaryWide, S.depositCopy]} onPress={onClose} accessibilityRole="button" accessibilityLabel="Back to scan"><Text style={S.primaryText}>Back to scan</Text></Pressable>
      </View>
    );
  }

  const body = (
    <>
      {phase === 'done' && signature ? (
        <View style={S.centerAll}>
          <View style={S.check}><Text style={S.checkMark}>✓</Text></View>
          <Text testID="sol-send-status" style={S.paidText}>Sent ✓</Text>
          <Text style={S.paidSub}>{fmtAsset(raw, decimals, unit)}</Text>
          <Text style={S.dim2}>transaction signature</Text>
          <Text testID="sol-send-signature" selectable={true} style={S.sheetAddr}>{signature}</Text>
          <Pressable testID="btn-sol-send-copy" style={S.primaryWide} onPress={copySig} accessibilityRole="button" accessibilityLabel="Copy transaction signature">
            <Text style={S.primaryText}>{copied === 'clipboard' ? 'Copied ✓' : copied === 'shared' ? 'Shared ✓' : 'Copy signature'}</Text>
          </Pressable>
          <Text style={S.dim2}>Your balance updates automatically.</Text>
          <Pressable testID="btn-sol-send-done" style={S.linkBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel="Done"><Text style={S.linkText}>Done</Text></Pressable>
        </View>
      ) : phase === 'submitting' ? (
        <View style={S.centerAll}>
          <ActivityIndicator color={C.brand} />
          <Text style={S.dim2}>{`Sending ${fmtAsset(raw, decimals, unit)}…`}</Text>
          <Text style={S.dim2}>Confirming on Solana — this can take up to a minute.</Text>
        </View>
      ) : (
        <>
          <Text style={S.label}>{`Send your ${unit} to a Solana address`}</Text>
          <Text style={S.dim2}>{`Available: ${fmtAsset(balance, decimals, unit)}`}</Text>

          <Text style={S.inputLabel}>Solana address</Text>
          <TextInput
            testID="sol-send-address-input"
            style={S.withdrawAddrInput}
            value={address}
            onChangeText={setAddress}
            placeholder="Receiver base58 address"
            placeholderTextColor={C.sub2}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={S.inputLabel}>{`Amount (${unit})`}</Text>
          <TextInput
            testID="sol-send-amount-input"
            style={S.withdrawAmtInput}
            value={amountStr}
            onChangeText={setAmountStr}
            keyboardType="decimal-pad"
            placeholder={isUsdc ? '1.5' : '0.025'}
            placeholderTextColor={C.sub2}
          />

          {overBalance ? <Text style={S.warnNote}>{`More than your available ${fmtAsset(balance, decimals, unit)}.`}</Text> : null}
          {badAddr ? <Text testID="sol-send-bad-addr" style={S.warnNote}>That doesn't look like a valid Solana address.</Text> : null}

          {(phase === 'form' || phase === 'error') && raw !== '0' ? (
            <View testID="sol-send-review" style={S.reviewCard}>
              <Text style={S.reviewLabel}>Review send</Text>
              <Text testID="sol-send-review-amount" style={S.reviewAmount}>{`Send ${fmtAsset(raw, decimals, unit)}`}</Text>
              <Text style={S.reviewTo}>{`to ${address.trim() || '—'}`}</Text>
              {isUsdc ? (
                <Text testID="sol-send-ata-note" style={S.dim2}>
                  If they don't have a USDC account yet, this creates it for them (one-time ≈{fmtAsset(String(SOL_ATA_SETUP_MIN_LAMPORTS), SOL_DECIMALS, SOL_UNIT)} paid by you).
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
            accessibilityLabel={`Confirm ${unit} send`}
            accessibilityState={{disabled: !canReview}}>
            <Text style={S.primaryText}>{raw !== '0' ? `Send ${fmtAsset(raw, decimals, unit)}` : 'Enter an amount'}</Text>
          </Pressable>

          {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
        </>
      )}
    </>
  );

  return <View style={S.sheetBody}>{body}</View>;
}
