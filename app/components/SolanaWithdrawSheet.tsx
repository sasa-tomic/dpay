import {useState} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {SOL_SEND_TIMEOUT_MS, IS_SOLANA_DEVNET} from '../config/constants';
import {fmtAsset, toUnits} from '../lib/format';
import {cmpRaw} from '../lib/amount';
import type {Identity} from '../lib/types';
import {SOL_DECIMALS, SOL_UNIT, isValidSolanaAddress} from '../solana/identity';
import {USDC_DECIMALS} from '../solana/spl';
import {sendSol, sendSpl} from '../solana';
import {friendlySolError} from '../solana/errors';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {withTimeout} from '../lib/timeout';

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
 *              sendSpl + checked fail-closed (the Token program rejects transfers to non-existent
 *              accounts). The device's source ATA is pre-checked here via `usdcAtaAbsent` (the honest
 *              fail-closed: you can't send USDC you don't have an account for — mirror Phase 4's
 *              receive-side ATA gate).
 *
 * Rendered inline in the Pay tab's "Send to address" sub-mode. The testIDs stay token-agnostic
 * (`sol-send-*`) — "send" applies to both SOL and SPL. The review-amount text carries the unit
 * (USDC vs SOL) so e2e can distinguish them.
 */
export function SolanaWithdrawSheet({identity, token, balance, usdcAtaAbsent, onSent, onClose}: {identity: Identity; token: 'SOL' | 'USDC'; balance: string; usdcAtaAbsent?: boolean; onSent: () => void; onClose: () => void}) {
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

  // Phase 6 fail-closed: USDC send when the device's ATA is known absent → instruction card (mirror
  // SolanaReceiveSheet). You can't send USDC you don't have an account for; surfacing this BEFORE the
  // form saves a doomed submit. The user must receive USDC first (creating the ATA externally).
  if (isUsdc && usdcAtaAbsent) {
    return (
      <View style={S.sheetBody}>
        <View testID="sol-send-instructions" style={S.instrCard}>
          <Text style={S.instrLine}>You don't have a USDC account on this device yet.</Text>
          <Text style={S.instrCustody}>Solana USDC needs a one-time Associated Token Account setup. Set one up from a wallet that supports it, then come back to send USDC.</Text>
          {IS_SOLANA_DEVNET ? <Text style={S.warnNote}>Devnet USDC — not real USDC.</Text> : null}
        </View>
        <Pressable testID="btn-sol-send-done" style={S.primaryWide} onPress={onClose} accessibilityRole="button" accessibilityLabel="Back to scan"><Text style={S.primaryText}>Back to scan</Text></Pressable>
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
            </View>
          ) : null}

          {err ? <Text testID="sol-send-err" style={S.err}>{err}</Text> : null}

          <Pressable
            testID="btn-sol-send-confirm"
            style={[S.primaryWide, !canReview && S.dim]}
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
