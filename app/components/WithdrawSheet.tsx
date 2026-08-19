import {useCallback, useEffect, useState} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {fmtAsset, toUnits} from '../lib/format';
import {cmpRaw} from '../lib/amount';
import type {Identity} from '../lib/types';
import type {CurrencyDescriptor, FamilyDisplay, MinterFamily} from '../config/catalog';
import {isValidDestinationAddress} from '../config/catalog';
import {prepareBtcWithdrawal, prepareEthWithdrawal, prepareErc20Withdrawal, submitOfframpStep, fetchGasFeeWei} from '../services/rail';
import {loadSavedWithdrawAddr, saveWithdrawAddr} from '../services/withdraw';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {IconCheck, IconCopy} from './icons';

/**
 * Withdraw a chain-key asset to a native address (ckBTC → BTC, native ckETH → ETH, ckERC20 tokens like
 * ckUSDC → USDC) over the IC user-principal rail. The user enters a destination + amount and the app
 * signs EVERY envelope on-device: icrc2_approve(s) on the ledger(s) then the minter call
 * (retrieve_btc_with_approval / withdraw_eth / withdraw_erc20) — all POSTed straight to /api/v2.
 * There is no relay in the value path and no facade custody. Amounts convert to raw smallest-units
 * via the family's `amountDecimals`. Escape closes the sheet (web), matching DepositSheet.
 *
 * Retry discipline (rail-wide): every envelope is resubmitted VERBATIM — re-signing a submitted
 * envelope is forbidden (new request_id = double-spend). An 'unknown' approve is honest pending —
 * the minter call is NOT submitted blind after it.
 *
 * ckERC20 gas dependency (Fork-C — no-swap): a ckERC20 withdraw burns ckETH for gas + the token
 * amount from its own ledger (dual-ledger withdraw_erc20). dpay NEVER converts ckUSDC→ckETH; the
 * user MUST independently hold ckETH for gas (the minter fails closed otherwise — honest retryable).
 */
export function WithdrawSheet({identity, catalog, currency, decimals, display, family, tokenContract, balance, onClose, onWithdrawn}: {identity: Identity; catalog: CurrencyDescriptor[]; currency: number; decimals: number; display: FamilyDisplay; family: MinterFamily; tokenContract: string | null; balance: string; onClose: () => void; onWithdrawn: () => void}) {
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
    try {
      const desc = catalog.find(c => c.currency === currency);
      const dest = address.trim();
      // Family-dispatched, all-user-signed envelopes. gas_ledger carries the ckETH ledger for
      // dual-ledger ckERC20; the minter principal comes from the catalog row.
      const minter = desc?.minter ?? '';
      const ledger = desc?.ledger ?? '';
      const gasLedger = desc?.gas_ledger ?? '';
      if (!ledger || !minter) throw new Error('This asset has no withdrawal rail configured');
      let steps;
      if (family === 'CkBtcUtxo') {
        steps = await prepareBtcWithdrawal(identity.secretHex, ledger, minter, dest, raw);
      } else if (family === 'CkEthErc20' && tokenContract != null) {
        if (!gasLedger) throw new Error('This asset has no withdrawal rail configured');
        const gas = await fetchGasFeeWei(identity.secretHex, minter, ledger);
        if (gas == null) throw new Error("Couldn't fetch the live gas fee — check your connection");
        steps = await prepareErc20Withdrawal(identity.secretHex, ledger, gasLedger, minter, dest, raw, gas);
      } else {
        const gas = await fetchGasFeeWei(identity.secretHex, minter, ledger);
        if (gas == null) throw new Error("Couldn't fetch the live gas fee — check your connection");
        steps = await prepareEthWithdrawal(identity.secretHex, ledger, minter, dest, raw, gas);
      }
      // Submit each step in order; STOP on anything but settled. Approve 'unknown' is honest
      // pending — the minter call is never submitted blind after it.
      for (let i = 0; i < steps.length; i++) {
        const out = await submitOfframpStep(steps[i], identity.secretHex, {attempts: 12, intervalMs: 500});
        if (out.kind === 'settled') continue;
        if (out.kind === 'rejected') throw new Error(out.reason);
        throw new Error(i === 0 && steps.length > 1
          ? "Couldn't confirm the approval — check your balance when back online"
          : "Couldn't confirm the withdrawal — it may still land; check your balance soon");
      }
      setReceipt({amount: raw, btcAddress: dest});
      setPhase('done');
      void saveWithdrawAddr(currency, dest); // remember for next cash-out (Fork-B)
      onWithdrawn(); // trigger a balance/history refresh
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('withdraw failed:', msg);
      setErr(msg);
      setPhase('error');
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
          <View style={S.check}><IconCheck size={44} color={C.brandInk}/></View>
          <Text testID="withdraw-status" style={S.paidText}>Withdrawn ✓</Text>
          <Text style={S.paidSub}>{fmtAsset(receipt.amount, decimals, display.nativeAsset, display.amountDecimals)}</Text>
          <Text style={S.dim2}>sent to</Text>
          <Text testID="withdraw-destination" selectable={true} style={S.sheetAddr}>{receipt.btcAddress}</Text>
          <Pressable testID="btn-copy-destination" style={S.primaryWide} onPress={copyDest} accessibilityRole="button" accessibilityLabel="Copy destination address" accessibilityState={{disabled: false}}>
            <IconCopy size={18} color={C.brandInk}/>
            <Text style={S.primaryText}>{copied === 'clipboard' ? 'Copied ✓' : copied === 'shared' ? 'Shared ✓' : 'Copy address'}</Text>
          </Pressable>
          <Text style={S.dim2}>Your balance updates automatically.</Text>
          <Pressable testID="btn-withdraw-done" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={onClose} accessibilityRole="button" accessibilityLabel="Done" accessibilityState={{disabled: false}}><Text style={S.ghostBtnText}>Done</Text></Pressable>
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
