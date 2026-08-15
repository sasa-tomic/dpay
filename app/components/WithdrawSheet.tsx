import {useCallback, useEffect, useState} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {WITHDRAW_TIMEOUT_MS, WITHDRAW_EXPIRY_WINDOW} from '../config/constants';
import {fmtAsset, toUnits, randNonceHex, nowSecs} from '../lib/format';
import {cmpRaw} from '../lib/amount';
import type {Identity} from '../lib/types';
import type {FamilyDisplay, MinterFamily} from '../config/catalog';
import {isValidDestinationAddress} from '../config/catalog';
import {withdrawFunds} from '../services/relay';
import {withdrawRejectionMessage} from '../payments';
import {loadSavedWithdrawAddr, saveWithdrawAddr} from '../services/withdraw';
import {DpayCore} from '../services/native';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {withTimeout} from '../lib/timeout';

/**
 * Withdraw a chain-key asset to a native address (ckBTC → BTC, native ckETH → ETH, ckERC20 tokens like
 * ckUSDC → USDC). The user enters a destination address + amount, reviews "Withdraw X <asset> to …",
 * then the app signs the WithdrawAuth ON-DEVICE (the non-custodial gate) and submits to the relay's
 * POST /api/v1/withdraw. The facade verifies the signature before moving funds. Amounts are converted
 * to raw smallest-units via the family's `amountDecimals` (8 for BTC sats, 18 for ETH Wei, 6 for
 * USDC micro-units); the on-device `WithdrawAuth.amount` is a u64 carrying those raw units. Escape
 * closes the sheet (web), matching DepositSheet.
 *
 * ckERC20 gas dependency (Fork-C — no-swap): a ckERC20 withdraw (token_contract is Some) burns ckETH
 * for gas + the token amount from its own ledger (the dual-ledger `withdraw_erc20` path). dpay NEVER
 * converts ckUSDC→ckETH, so the user MUST independently hold ckETH for gas. The sheet shows an honest
 * "You need ckETH for gas" note when `tokenContract` is present; the real gas check happens at the
 * canister (the minter returns InsufficientFunds if the user has no ckETH gas → honest retryable
 * error). A partial-failure settlement surfaces "Gas was burned but the transfer may not have landed"
 * so the user checks their balance rather than assuming success.
 */
export function WithdrawSheet({identity, relayUrl, currency, decimals, display, family, tokenContract, balance, onClose, onWithdrawn}: {identity: Identity; relayUrl: string; currency: number; decimals: number; display: FamilyDisplay; family: MinterFamily; tokenContract: string | null; balance: string; onClose: () => void; onWithdrawn: () => void}) {
  const [address, setAddress] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [phase, setPhase] = useState<'form' | 'submitting' | 'done' | 'error'>('form');
  const [err, setErr] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{amount: string; btcAddress: string} | null>(null);
  const [savedAddr, setSavedAddr] = useState<string | null>(null);
  const {copied, copy: doCopy} = useCopyFeedback();

  useEscapeToClose(onClose);

  // Load the last-used destination for this currency on open (Fork-B: tap-to-reuse, no re-paste).
  useEffect(() => {
    let alive = true;
    loadSavedWithdrawAddr(currency).then(a => { if (alive && a) { setSavedAddr(a); } });
    return () => { alive = false; };
  }, [currency]);

  // Convert the entered amount to raw smallest-units at the asset's PROTOCOL decimal count (8 sats
  // for BTC, 18 Wei for ETH — NOT the display_decimals). The display precision (display.amountDecimals,
  // e.g. 6 for ETH) only governs how many fractional places are SHOWN, not the raw encoding.
  const raw = toUnits(amountStr, decimals);
  const belowMin = raw !== '0' && cmpRaw(raw, String(display.withdrawMinRaw)) < 0;
  const overBalance = cmpRaw(raw, balance) > 0;
  const addrEntered = address.trim().length > 0;
  const badAddr = addrEntered && !isValidDestinationAddress(family, address);
  const canReview = addrEntered && !badAddr && raw !== '0' && !belowMin && !overBalance;
  // ckERC20 (token_contract Some) burns ckETH for gas on the dual-ledger withdraw_erc20 path. Native
  // ETH (token_contract None) and BTC are NOT affected — they don't carry a separate gas ledger.
  const isErc20 = family === 'CkEthErc20' && tokenContract != null;

  async function confirm() {
    if (!canReview) {
      return;
    }
    setPhase('submitting');
    setErr(null);
    const {signal, cancel} = withTimeout(WITHDRAW_TIMEOUT_MS);
    try {
      const nonce = randNonceHex();
      const expiry = nowSecs() + WITHDRAW_EXPIRY_WINDOW;
      // Sign the WithdrawAuth on-device (non-custodial gate). The facade verifies this exact sig.
      const sigHex = await DpayCore.signWithdrawal(identity.secretHex, address.trim(), raw, nonce, expiry, currency);
      const r = await withdrawFunds(relayUrl, identity.publicHex, address.trim(), raw, nonce, expiry, currency, sigHex, signal);
      setReceipt({amount: r.amount, btcAddress: r.destination});
      setPhase('done');
      void saveWithdrawAddr(currency, address.trim()); // remember for next cash-out (Fork-B)
      onWithdrawn(); // trigger a balance/history refresh
    } catch (e: unknown) {
      // A 422 policy error (bad sig / insufficient / below min / nonce) or a 503 transient / offline.
      // A8: the raw relay/canister body (e.g. "InsufficientFunds: balance 0", "nonce already used")
      // is protocol jargon to a user — mapped to friendly copy by `withdrawRejectionMessage` (pure,
      // unit-tested in payments.test.ts). The raw reason is ALWAYS console.warn'd so the dev loop
      // stays fail-loud. For a ckERC20 partial-failure settlement (the dual-ledger path burned ckETH
      // gas but the ERC-20 transfer may not have landed — the canister RELEASES with an honest
      // partial-failure marker), surface the specific "gas was burned" guidance so the user checks
      // their balance instead of assuming success.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('withdraw failed:', msg);
      if (/partial[ _-]?failure/i.test(msg)) {
        setErr('Gas was burned but the transfer may not have landed. Check your balance.');
      } else {
        setErr(withdrawRejectionMessage(msg));
      }
      setPhase('error');
    } finally {
      cancel();
    }
  }

  // L3 — copy the destination address on the success screen (otherwise it's a raw, long, un-copyable
  // string). Mirrors the deposit copy button: real clipboard on web, Share sheet fallback on native.
  const copyDest = useCallback(async () => {
    if (receipt?.btcAddress) { await doCopy(receipt.btcAddress); }
  }, [receipt, doCopy]);

  // The body content is rendered inline in the Pay tab's "Send to address" sub-mode (the tab body
  // already provides the scroll surface + the overlay chrome). `onClose` is wired to the inner
  // "Done" button so a completed flow returns to the scan sub-mode.
  const body = (
    <>
      {phase === 'done' && receipt ? (
        <View style={S.centerAll}>
          <View style={S.check}><Text style={S.checkMark}>✓</Text></View>
          <Text testID="withdraw-status" style={S.paidText}>Withdrawn ✓</Text>
          <Text style={S.paidSub}>{fmtAsset(receipt.amount, decimals, display.nativeAsset, display.amountDecimals)}</Text>
          <Text style={S.dim2}>sent to</Text>
          <Text testID="withdraw-destination" selectable={true} style={S.sheetAddr}>{receipt.btcAddress}</Text>
          <Pressable testID="btn-copy-destination" style={S.primaryWide} onPress={copyDest} accessibilityRole="button" accessibilityLabel="Copy destination address" accessibilityState={{disabled: false}}>
            <Text style={S.primaryText}>{copied === 'clipboard' ? 'Copied ✓' : copied === 'shared' ? 'Shared ✓' : 'Copy address'}</Text>
          </Pressable>
          <Text style={S.dim2}>Your balance updates automatically.</Text>
          <Pressable testID="btn-withdraw-done" style={S.linkBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel="Done" accessibilityState={{disabled: false}}><Text style={S.linkText}>Done</Text></Pressable>
        </View>
      ) : phase === 'submitting' ? (
        <View style={S.centerAll}>
          <ActivityIndicator color={C.brand} />
          <Text style={S.dim2}>{`Withdrawing ${fmtAsset(raw, decimals, display.nativeAsset, display.amountDecimals)}…`}</Text>
        </View>
      ) : (
        <>
          <Text style={S.label}>{`Send your ${display.networkLabel} to a native ${display.nativeAsset} address`}</Text>
          <Text style={S.dim2}>{`Available: ${fmtAsset(balance, decimals, display.nativeAsset, display.amountDecimals)} · min ${fmtAsset(String(display.withdrawMinRaw), decimals, display.nativeAsset, display.amountDecimals)}`}</Text>

          <Text style={S.inputLabel}>{`${display.nativeAsset} address`}</Text>
          {savedAddr && address.trim().length === 0 ? (
            <Pressable testID="btn-withdraw-saved" style={S.savedAddrChip} onPress={() => setAddress(savedAddr)} accessibilityRole="button" accessibilityLabel="Use last saved address" accessibilityState={{disabled: false}}>
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

          {belowMin ? <Text style={S.warnNote}>{`Below the ${fmtAsset(String(display.withdrawMinRaw), decimals, display.nativeAsset, display.amountDecimals)} minimum withdrawal.`}</Text> : null}
          {overBalance ? <Text style={S.warnNote}>{`More than your available ${fmtAsset(balance, decimals, display.nativeAsset, display.amountDecimals)}.`}</Text> : null}
          {badAddr ? <Text testID="withdraw-bad-addr" style={S.warnNote}>{`That doesn't look like a valid ${display.nativeAsset} address.`}</Text> : null}

          {isErc20 ? (
            <Text testID="withdraw-gas-note" style={S.warnNote}>You need ckETH for gas. Add ckETH first if you don't have any.</Text>
          ) : null}

          {(phase === 'form' || phase === 'error') && raw !== '0' ? (
            <View testID="withdraw-review" style={S.reviewCard}>
              <Text style={S.reviewLabel}>Review withdrawal</Text>
              <Text testID="withdraw-review-amount" style={S.reviewAmount}>{`Withdraw ${fmtAsset(raw, decimals, display.nativeAsset, display.amountDecimals)}`}</Text>
              <Text style={S.reviewTo}>{`to ${address.trim() || '—'}`}</Text>
            </View>
          ) : null}

          {err ? <Text testID="withdraw-err" style={S.err}>{err}</Text> : null}

          <Pressable
            testID="btn-withdraw-confirm"
            style={[S.primaryWide, !canReview && S.disabledFlat]}
            disabled={!canReview}
            onPress={confirm}
            accessibilityRole="button"
            accessibilityLabel="Confirm withdrawal"
            accessibilityState={{disabled: !canReview}}>
            <Text style={S.primaryText}>{raw !== '0' ? `Withdraw ${fmtAsset(raw, decimals, display.nativeAsset, display.amountDecimals)}` : 'Enter an amount'}</Text>
          </Pressable>

          {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
        </>
      )}
    </>
  );

  return <View style={S.sheetBody}>{body}</View>;
}
