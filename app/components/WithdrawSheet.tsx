import {useEffect, useState} from 'react';
import {View, Text, Pressable, TextInput, ScrollView, SafeAreaView, StatusBar, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {WITHDRAW_TIMEOUT_MS, WITHDRAW_EXPIRY_WINDOW} from '../config/constants';
import {fmtAsset, toSats, randNonceHex, nowSecs} from '../lib/format';
import type {Identity} from '../lib/types';
import type {FamilyDisplay} from '../config/catalog';
import {withdrawFunds} from '../services/relay';
import {loadSavedWithdrawAddr, saveWithdrawAddr} from '../services/withdraw';
import {DpayCore} from '../services/native';
import {useEscapeToClose} from '../hooks/useHotkeys';

/**
 * Withdraw ckBTC to a native BTC address. The user enters a BTC address + amount, reviews
 * "Withdraw X BTC to bc1…", then the app signs the WithdrawAuth ON-DEVICE (the non-custodial gate)
 * and submits to the relay's POST /api/v1/withdraw. The facade verifies the signature before moving
 * funds. Amounts are shown in BTC (the backing currency symbol — never the wrapper/raw ledger id).
 * Escape closes the sheet (web), matching DepositSheet.
 */
export function WithdrawSheet({identity, relayUrl, currency, display, ckBtcBalance, onClose, onWithdrawn}: {identity: Identity; relayUrl: string; currency: number; display: FamilyDisplay; ckBtcBalance: number; onClose: () => void; onWithdrawn: () => void}) {
  const [address, setAddress] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [phase, setPhase] = useState<'form' | 'submitting' | 'done' | 'error'>('form');
  const [err, setErr] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{amount: number; btcAddress: string} | null>(null);
  const [savedAddr, setSavedAddr] = useState<string | null>(null);

  useEscapeToClose(onClose);

  // Load the last-used destination for this currency on open (Fork-B: tap-to-reuse, no re-paste).
  useEffect(() => {
    let alive = true;
    loadSavedWithdrawAddr(currency).then(a => { if (alive && a) { setSavedAddr(a); } });
    return () => { alive = false; };
  }, [currency]);

  const sats = toSats(amountStr);
  const belowMin = sats > 0 && sats < display.withdrawMinRaw;
  const overBalance = sats > ckBtcBalance;
  const canReview = address.trim().length > 0 && sats > 0 && !belowMin && !overBalance;

  async function confirm() {
    if (!canReview) {
      return;
    }
    setPhase('submitting');
    setErr(null);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), WITHDRAW_TIMEOUT_MS);
    try {
      const nonce = randNonceHex();
      const expiry = nowSecs() + WITHDRAW_EXPIRY_WINDOW;
      // Sign the WithdrawAuth on-device (non-custodial gate). The facade verifies this exact sig.
      const sigHex = await DpayCore.signWithdrawal(identity.secretHex, address.trim(), sats, nonce, expiry, currency);
      const r = await withdrawFunds(relayUrl, identity.publicHex, address.trim(), sats, nonce, expiry, currency, sigHex, ctrl.signal);
      setReceipt({amount: r.amount, btcAddress: r.destination});
      setPhase('done');
      void saveWithdrawAddr(currency, address.trim()); // remember for next cash-out (Fork-B)
      onWithdrawn(); // trigger a balance/history refresh
    } catch (e: any) {
      // A 422 policy error (bad sig / insufficient / below min / nonce) or a 503 transient / offline.
      // Surface the reason; the user can correct + retry from the form.
      setErr(String(e?.message ?? e));
      setPhase('error');
    } finally {
      clearTimeout(t);
    }
  }

  function reset() { setAddress(''); setAmountStr(''); setErr(null); setReceipt(null); setPhase('form'); }

  return (
    <View style={S.sheetOverlay}>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>{`Cash out ${display.networkLabel}`}</Text>
          <Pressable testID="btn-withdraw-close" style={S.sheetClose} onPress={onClose}><Text style={S.sheetCloseX}>✕</Text></Pressable>
        </View>

        <ScrollView contentContainerStyle={S.sheetBody} keyboardShouldPersistTaps="handled">
          {phase === 'done' && receipt ? (
            <View style={S.centerAll}>
              <View style={S.check}><Text style={S.checkMark}>✓</Text></View>
              <Text testID="withdraw-status" style={S.paidText}>Withdrawn ✓</Text>
              <Text style={S.paidSub}>{fmtAsset(receipt.amount, display.amountDecimals, display.nativeAsset)}</Text>
              <Text style={S.dim2}>sent to {receipt.btcAddress}</Text>
              <Text style={S.dim2}>Your balance updates automatically.</Text>
              <Pressable testID="btn-withdraw-done" style={S.linkBtn} onPress={onClose}><Text style={S.linkText}>Done</Text></Pressable>
            </View>
          ) : phase === 'submitting' ? (
            <View style={S.centerAll}>
              <ActivityIndicator color={C.brand} />
              <Text style={S.dim2}>{`Withdrawing ${fmtAsset(sats, display.amountDecimals, display.nativeAsset)}…`}</Text>
            </View>
          ) : (
            <>
              <Text style={S.label}>{`Send your ${display.networkLabel} to a native ${display.nativeAsset} address`}</Text>
              <Text style={S.dim2}>{`Available: ${fmtAsset(ckBtcBalance, display.amountDecimals, display.nativeAsset)} · min ${fmtAsset(display.withdrawMinRaw, display.amountDecimals, display.nativeAsset)}`}</Text>

              <Text style={S.inputLabel}>{`${display.nativeAsset} address`}</Text>
              {savedAddr && address.trim().length === 0 ? (
                <Pressable testID="btn-withdraw-saved" style={S.savedAddrChip} onPress={() => setAddress(savedAddr)}>
                  <Text style={S.savedAddrText}>{`Use last: ${savedAddr.length > 28 ? savedAddr.slice(0, 14) + '…' + savedAddr.slice(-12) : savedAddr}`}</Text>
                </Pressable>
              ) : null}
              <TextInput
                testID="withdraw-address-input"
                style={S.withdrawAddrInput}
                value={address}
                onChangeText={setAddress}
                placeholder={display.addressPlaceholder}
                placeholderTextColor={C.sub2}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={S.inputLabel}>{`Amount (${display.nativeAsset})`}</Text>
              <TextInput
                testID="withdraw-amount-input"
                style={S.withdrawAmtInput}
                value={amountStr}
                onChangeText={setAmountStr}
                keyboardType="decimal-pad"
                placeholder="0.00050000"
                placeholderTextColor={C.sub2}
              />

              {belowMin ? <Text style={S.warnNote}>{`Below the ${fmtAsset(display.withdrawMinRaw, display.amountDecimals, display.nativeAsset)} minimum withdrawal.`}</Text> : null}
              {overBalance ? <Text style={S.warnNote}>{`More than your available ${fmtAsset(ckBtcBalance, display.amountDecimals, display.nativeAsset)}.`}</Text> : null}

              {(phase === 'form' || phase === 'error') && sats > 0 ? (
                <View testID="withdraw-review" style={S.reviewCard}>
                  <Text style={S.reviewLabel}>Review withdrawal</Text>
                  <Text testID="withdraw-review-amount" style={S.reviewAmount}>{`Withdraw ${fmtAsset(sats, display.amountDecimals, display.nativeAsset)}`}</Text>
                  <Text style={S.reviewTo}>{`to ${address.trim() || '—'}`}</Text>
                </View>
              ) : null}

              {err ? <Text testID="withdraw-err" style={S.err}>{err}</Text> : null}

              <Pressable
                testID="btn-withdraw-confirm"
                style={[S.primaryWide, !canReview && S.dim]}
                disabled={!canReview}
                onPress={confirm}>
                <Text style={S.primaryText}>{sats > 0 ? `Withdraw ${fmtAsset(sats, display.amountDecimals, display.nativeAsset)}` : 'Enter an amount'}</Text>
              </Pressable>

              {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
