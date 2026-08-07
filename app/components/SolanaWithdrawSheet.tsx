import {useState} from 'react';
import {View, Text, Pressable, TextInput, ScrollView, SafeAreaView, StatusBar, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {SOL_SEND_TIMEOUT_MS} from '../config/constants';
import {fmtAsset, toUnits} from '../lib/format';
import {cmpRaw} from '../lib/amount';
import type {Identity} from '../lib/types';
import {SOL_DECIMALS, SOL_UNIT, isValidSolanaAddress} from '../solana/identity';
import {sendSol} from '../solana';
import {copyToClipboard} from '../lib/clipboard';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {SheetOverlay} from './SheetOverlay';
import {withTimeout} from '../lib/timeout';

function friendlySolError(msg: string): string {
  if (/abort/i.test(msg)) return 'Timed out. Check your connection and try again.';
  if (/insufficient/i.test(msg)) return 'Not enough SOL for this send plus the network fee.';
  if (/rent.exempt/i.test(msg)) return 'After this send, your account would fall below the minimum balance. Send a smaller amount.';
  if (/blockhash/i.test(msg)) return 'The network was too busy. Try again.';
  return msg;
}

/**
 * Send SOL to a native Solana address. Mirrors WithdrawSheet's form/submitting/done/error phases, but
 * signs LOCALLY on the device (SLIP-10 ed25519 via noble) and broadcasts directly to the Solana RPC —
 * no relay, no DpayCore, no facade. The non-custodial gate is the on-device SLIP-10 key itself. A
 * confirmed send returns the transaction signature (shown + copyable); the balance poll refreshes
 * automatically.
 */
export function SolanaWithdrawSheet({identity, balance, onSent, onClose}: {identity: Identity; balance: string; onSent: () => void; onClose: () => void}) {
  const [address, setAddress] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [phase, setPhase] = useState<'form' | 'submitting' | 'done' | 'error'>('form');
  const [err, setErr] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [copied, setCopied] = useState<'clipboard' | 'shared' | null>(null);

  useEscapeToClose(onClose);

  // Convert the entered amount to lamports at SOL's 9 decimals. `cmpRaw` (BigInt) for presence —
  // never `>` on strings (lexicographic trap).
  const raw = toUnits(amountStr, SOL_DECIMALS);
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
      const sig = await sendSol(identity.secretHex, address.trim(), BigInt(raw), signal);
      setSignature(sig);
      setPhase('done');
      onSent(); // trigger an immediate balance refresh
    } catch (e: unknown) {
      // A Solana RPC error (insufficient funds / rent-exempt violation / network) or an abort.
      setErr(friendlySolError(e instanceof Error ? e.message : String(e)));
      setPhase('error');
    } finally {
      cancel();
    }
  }

  function reset() { setAddress(''); setAmountStr(''); setErr(null); setSignature(null); setCopied(null); setPhase('form'); }

  const copySig = async () => {
    if (!signature) return;
    const how = await copyToClipboard(signature);
    setCopied(how);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <SheetOverlay>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>Send SOL</Text>
          <Pressable testID="btn-sol-send-close" accessibilityRole="button" accessibilityLabel="Close send SOL sheet" style={S.sheetClose} onPress={onClose}><Text style={S.sheetCloseX}>✕</Text></Pressable>
        </View>

        <ScrollView contentContainerStyle={S.sheetBody} keyboardShouldPersistTaps="handled">
          {phase === 'done' && signature ? (
            <View style={S.centerAll}>
              <View style={S.check}><Text style={S.checkMark}>✓</Text></View>
              <Text testID="sol-send-status" style={S.paidText}>Sent ✓</Text>
              <Text style={S.paidSub}>{fmtAsset(raw, SOL_DECIMALS, SOL_UNIT)}</Text>
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
              <Text style={S.dim2}>{`Sending ${fmtAsset(raw, SOL_DECIMALS, SOL_UNIT)}…`}</Text>
              <Text style={S.dim2}>Confirming on Solana — this can take up to a minute.</Text>
            </View>
          ) : (
            <>
              <Text style={S.label}>Send your SOL to a Solana address</Text>
              <Text style={S.dim2}>{`Available: ${fmtAsset(balance, SOL_DECIMALS, SOL_UNIT)}`}</Text>

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

              <Text style={S.inputLabel}>{`Amount (${SOL_UNIT})`}</Text>
              <TextInput
                testID="sol-send-amount-input"
                style={S.withdrawAmtInput}
                value={amountStr}
                onChangeText={setAmountStr}
                keyboardType="decimal-pad"
                placeholder="0.025"
                placeholderTextColor={C.sub2}
              />

              {overBalance ? <Text style={S.warnNote}>{`More than your available ${fmtAsset(balance, SOL_DECIMALS, SOL_UNIT)}.`}</Text> : null}
              {badAddr ? <Text testID="sol-send-bad-addr" style={S.warnNote}>That doesn't look like a valid Solana address.</Text> : null}

              {(phase === 'form' || phase === 'error') && raw !== '0' ? (
                <View testID="sol-send-review" style={S.reviewCard}>
                  <Text style={S.reviewLabel}>Review send</Text>
                  <Text testID="sol-send-review-amount" style={S.reviewAmount}>{`Send ${fmtAsset(raw, SOL_DECIMALS, SOL_UNIT)}`}</Text>
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
                accessibilityLabel="Confirm SOL send"
                accessibilityState={{disabled: !canReview}}>
                <Text style={S.primaryText}>{raw !== '0' ? `Send ${fmtAsset(raw, SOL_DECIMALS, SOL_UNIT)}` : 'Enter an amount'}</Text>
              </Pressable>

              {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </SheetOverlay>
  );
}
