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
import type {OfframpStep} from '../services/rail';
import {planOfframpConfirm, type RetainedOfframp} from '../services/offrampRetry';
import {loadOfframp, saveOfframp, clearOfframp} from '../services/offrampPersist';
import {loadSavedWithdrawAddr, saveWithdrawAddr} from '../services/withdraw';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {IconCheck, IconCopy} from './icons';
import {M} from '../i18n';

/**
 * Withdraw a chain-key asset to a native address (ckBTC → BTC, native ckETH → ETH, ckERC20 tokens like
 * ckUSDC → USDC) over the IC user-principal rail. The user enters a destination + amount and the app
 * signs EVERY envelope on-device: icrc2_approve(s) on the ledger(s) then the minter call
 * (retrieve_btc_with_approval / withdraw_eth / withdraw_erc20) — all POSTed straight to /api/v2.
 * There is no relay in the value path and no facade custody. Amounts convert to raw smallest-units
 * via the family's `amountDecimals`. Escape closes the sheet (web), matching DepositSheet.
 *
 * Retry discipline (rail-wide): every envelope is resubmitted VERBATIM — re-signing a submitted
 * envelope is forbidden (new request_id = double-spend). Once a sequence is prepared the steps are
 * RETAINED (component state + AsyncStorage), so a Confirm-after-error or an app-restart-mid-sequence
 * RESUMES from the first unsettled step with the SAME bytes; only a clean pre-submit failure (e.g.
 * the gas-fee fetch throwing before anything is signed) re-prepares. Deliberately editing the
 * destination/amount drops the retained steps — that is a NEW withdrawal intent; any in-flight old
 * envelopes settle independently (visible via the balance refresh). An 'unknown' approve is honest
 * pending — the minter call is NOT submitted blind after it.
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
  // The prepared offramp retained across retries and restarts (double-burn guard — see header).
  // null ⇒ the next Confirm PREPARES fresh envelopes; non-null ⇒ Confirm RESUMES the SAME bytes.
  const [retained, setRetained] = useState<RetainedOfframp | null>(null);
  const {copied, copy: doCopy} = useCopyFeedback();
  // Every amount on this sheet is the same asset at the same precision — one formatter, one place.
  const fmt = (rawAmount: string) => fmtAsset(rawAmount, decimals, display.nativeAsset, display.amountDecimals);

  useEscapeToClose(onClose);

  // Load the last-used destination for this currency on open (Fork-B: tap-to-reuse, no re-paste).
  useEffect(() => {
    let alive = true;
    loadSavedWithdrawAddr(currency).then(a => { if (alive && a) { setSavedAddr(a); } });
    return () => { alive = false; };
  }, [currency]);

  // RESUME an offramp persisted by a previous session (app died mid-sequence). Re-preparing would
  // mint fresh request_ids for a withdrawal that may already be in flight (double-burn); instead
  // hydrate the retained envelopes + the first unsettled step. The form pre-fills the in-flight
  // destination and Confirm resumes verbatim — never re-signs.
  useEffect(() => {
    let alive = true;
    loadOfframp(identity.publicHex, currency).then(rec => {
      if (!alive || !rec) return;
      setRetained({steps: rec.steps, nextIdx: rec.nextIdx, destination: rec.destination, amountRaw: rec.amountRaw});
      setAddress(rec.destination);
      setErr(M.withdraw.ic.resumed);
    });
    return () => { alive = false; };
  }, [identity.publicHex, currency]);

  // Editing the form = a NEW withdrawal intent: drop the retained envelopes (any in-flight ones
  // settle independently — honest, visible via the balance refresh). Routed through wrappers so
  // every input path (typing, the saved-address chip) invalidates.
  const editAddress = useCallback((t: string) => {
    setAddress(t);
    if (retained) setRetained(null);
  }, [retained]);
  const editAmount = useCallback((t: string) => {
    setAmountStr(t);
    if (retained) setRetained(null);
  }, [retained]);

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

  // Submit the prepared steps in order from `fromIdx`; STOP on anything but settled. Approve
  // 'unknown' is honest pending — the minter call is never submitted blind after it. The record is
  // persisted BEFORE each submission (a crash mid-submit resumes that step verbatim) and CLEARED
  // only when the whole sequence settles.
  async function runOfframp(steps: OfframpStep[], fromIdx: number, dest: string, amountRawArg: string) {
    for (let i = fromIdx; i < steps.length; i++) {
      await saveOfframp(identity.publicHex, {currency, destination: dest, amountRaw: amountRawArg, steps, nextIdx: i});
      const out = await submitOfframpStep(steps[i], identity.secretHex, {attempts: 12, intervalMs: 500});
      if (out.kind === 'settled') {
        if (i + 1 < steps.length) setRetained({steps, nextIdx: i + 1, destination: dest, amountRaw: amountRawArg});
        continue;
      }
      if (out.kind === 'rejected') throw new Error(out.reason);
      throw new Error(i === 0 && steps.length > 1 ? M.withdraw.ic.approvalUnknown : M.withdraw.ic.withdrawalUnknown);
    }
    await clearOfframp(identity.publicHex, currency);
    setRetained(null);
    setReceipt({amount: amountRawArg, btcAddress: dest});
    setPhase('done');
    void saveWithdrawAddr(currency, dest); // remember for next cash-out (Fork-B)
    onWithdrawn(); // trigger a balance/history refresh
  }

  async function confirm() {
    if (phase === 'submitting') return;
    // Double-burn guard: with a retained offramp, Confirm RESUMES the SAME envelope bytes — only a
    // null retained state (first attempt, or a clean pre-submit failure) prepares fresh envelopes.
    const plan = planOfframpConfirm(retained);
    if (plan.kind === 'prepare' && !canReview) {
      return;
    }
    setPhase('submitting');
    setErr(null);
    try {
      if (plan.kind === 'resume') {
        await runOfframp(plan.record.steps, plan.from, plan.record.destination, plan.record.amountRaw);
        return;
      }
      const desc = catalog.find(c => c.currency === currency);
      const dest = address.trim();
      // Family-dispatched, all-user-signed envelopes. gas_ledger carries the ckETH ledger for
      // dual-ledger ckERC20; the minter principal comes from the catalog row. Anything thrown in
      // here (rail misconfig, gas-fee fetch) is a CLEAN PRE-SUBMIT failure — no envelope was
      // signed or submitted, so a retry may safely re-prepare.
      const minter = desc?.minter ?? '';
      const ledger = desc?.ledger ?? '';
      const gasLedger = desc?.gas_ledger ?? '';
      if (!ledger || !minter) throw new Error(M.withdraw.ic.noRail);
      let steps: OfframpStep[];
      if (family === 'CkBtcUtxo') {
        steps = await prepareBtcWithdrawal(identity.secretHex, ledger, minter, dest, raw);
      } else if (family === 'CkEthErc20' && tokenContract != null) {
        if (!gasLedger) throw new Error(M.withdraw.ic.noRail);
        const gas = await fetchGasFeeWei(identity.secretHex, minter, ledger);
        if (gas == null) throw new Error(M.withdraw.ic.gasFeeErr);
        steps = await prepareErc20Withdrawal(identity.secretHex, ledger, gasLedger, minter, dest, raw, gas);
      } else {
        // Native ETH: passes the ckETH AMOUNT ledger as the eip_1559_transaction_price arg.
        // Semantically the minter wants None here (facade-era kernel sent None), but MEASURED LIVE
        // 2026-08-20 the mainnet minter TOLERATES an unregistered ledger and returns the identical
        // native price (gas_limit 21000) — see OPEN_ISSUES.md ckETH-minter block + the
        // mainnet_cketh_minter_eip1559_price_args probe. No observable difference; revisit only if
        // the minter ever starts rejecting it.
        const gas = await fetchGasFeeWei(identity.secretHex, minter, ledger);
        if (gas == null) throw new Error(M.withdraw.ic.gasFeeErr);
        steps = await prepareEthWithdrawal(identity.secretHex, ledger, minter, dest, raw, gas);
      }
      // Retain the prepared steps BEFORE the first submission so every subsequent retry (or an app
      // restart) resumes these exact bytes instead of re-signing.
      setRetained({steps, nextIdx: 0, destination: dest, amountRaw: raw});
      await runOfframp(steps, 0, dest, raw);
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
          <Text testID="withdraw-status" style={S.paidText}>{M.withdraw.ic.withdrawn}</Text>
          <Text style={S.paidSub}>{fmt(receipt.amount)}</Text>
          <Text style={S.dim2}>{M.withdraw.ic.sentTo}</Text>
          <Text testID="withdraw-destination" selectable={true} style={S.sheetAddr}>{receipt.btcAddress}</Text>
          <Pressable testID="btn-copy-destination" style={S.primaryWide} onPress={copyDest} accessibilityRole="button" accessibilityLabel={M.withdraw.ic.copyDestinationLabel} accessibilityState={{disabled: false}}>
            <IconCopy size={18} color={C.brandInk}/>
            <Text style={S.primaryText}>{copied === 'clipboard' ? M.withdraw.copied : copied === 'shared' ? M.withdraw.shared : M.withdraw.copyAddress}</Text>
          </Pressable>
          <Text style={S.dim2}>{M.withdraw.balanceAuto}</Text>
          <Pressable testID="btn-withdraw-done" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={onClose} accessibilityRole="button" accessibilityLabel={M.common.done} accessibilityState={{disabled: false}}><Text style={S.ghostBtnText}>{M.common.done}</Text></Pressable>
        </View>
      ) : phase === 'submitting' ? (
        <View style={S.centerAll}>
          <ActivityIndicator color={C.brand} />
          <Text style={S.dim2}>{M.withdraw.ic.withdrawing(fmt(raw))}</Text>
        </View>
      ) : (
        <>
          <Text style={S.label}>{M.withdraw.ic.sendToNative(display.networkLabel, display.nativeAsset)}</Text>
          <Text style={S.dim2}>{M.withdraw.ic.availableMin(fmt(balance), fmt(String(display.withdrawMinRaw)))}</Text>

          <Text style={S.inputLabel}>{M.withdraw.ic.addressLabel(display.nativeAsset)}</Text>
          {savedAddr && address.trim().length === 0 ? (
            <Pressable testID="btn-withdraw-saved" style={S.savedAddrChip} onPress={() => editAddress(savedAddr)} accessibilityRole="button" accessibilityLabel={M.withdraw.ic.useLastLabel} accessibilityState={{disabled: false}}>
              <Text style={S.savedAddrText}>{M.withdraw.ic.useLast(savedAddr.length > 28 ? savedAddr.slice(0, 14) + '…' + savedAddr.slice(-12) : savedAddr)}</Text>
            </Pressable>
          ) : null}
          <TextInput
            testID="withdraw-address-input"
            style={S.withdrawAddrInput}
            value={address}
            onChangeText={editAddress}
            placeholder={display.addressPlaceholder}
            placeholderTextColor={C.sub2}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={S.inputLabel}>{M.withdraw.amountLabel(display.nativeAsset)}</Text>
          <TextInput
            testID="withdraw-amount-input"
            style={S.withdrawAmtInput}
            value={amountStr}
            onChangeText={editAmount}
            keyboardType="decimal-pad"
            placeholder={M.withdraw.ic.amountPlaceholder}
            placeholderTextColor={C.sub2}
          />

          {belowMin ? <Text style={S.warnNote}>{M.withdraw.ic.belowMin(fmt(String(display.withdrawMinRaw)))}</Text> : null}
          {overBalance ? <Text style={S.warnNote}>{M.withdraw.overBalance(fmt(balance))}</Text> : null}
          {badAddr ? <Text testID="withdraw-bad-addr" style={S.warnNote}>{M.withdraw.badAddress(display.nativeAsset)}</Text> : null}

          {isErc20 ? (
            <Text testID="withdraw-gas-note" style={S.warnNote}>{M.withdraw.ic.gasNote}</Text>
          ) : null}

          {retained ? (
            // An in-flight offramp is retained (failure mid-sequence, or resumed after an app
            // restart): show WHAT is in flight instead of the form-derived review — the envelopes
            // are already signed for this destination/amount.
            <View testID="withdraw-resume" style={S.reviewCard}>
              <Text style={S.reviewLabel}>{M.withdraw.ic.inProgress}</Text>
              <Text testID="withdraw-resume-amount" style={S.reviewAmount}>{M.withdraw.ic.withdrawAmount(fmt(retained.amountRaw))}</Text>
              <Text style={S.reviewTo}>{M.withdraw.toDestination(retained.destination)}</Text>
              <Text style={S.dim2}>{M.withdraw.ic.resumeNote}</Text>
            </View>
          ) : (phase === 'form' || phase === 'error') && raw !== '0' ? (
            <View testID="withdraw-review" style={S.reviewCard}>
              <Text style={S.reviewLabel}>{M.withdraw.ic.reviewTitle}</Text>
              <Text testID="withdraw-review-amount" style={S.reviewAmount}>{M.withdraw.ic.withdrawAmount(fmt(raw))}</Text>
              <Text style={S.reviewTo}>{M.withdraw.toDestination(address.trim() || '—')}</Text>
            </View>
          ) : null}

          {err ? <Text testID="withdraw-err" style={S.err}>{err}</Text> : null}

          <Pressable
            testID="btn-withdraw-confirm"
            style={[S.primaryWide, !canReview && !retained && S.disabledFlat]}
            disabled={!canReview && !retained}
            onPress={confirm}
            accessibilityRole="button"
            accessibilityLabel={M.withdraw.ic.confirmLabel}
            accessibilityState={{disabled: !canReview && !retained}}>
            <Text style={S.primaryText}>{retained ? M.withdraw.ic.retry : raw !== '0' ? M.withdraw.ic.withdrawAmount(fmt(raw)) : M.withdraw.enterAmount}</Text>
          </Pressable>

          {Platform.OS === 'web' ? <Text style={S.dim2}>{M.withdraw.pressEsc}</Text> : null}
        </>
      )}
    </>
  );

  return <View style={S.sheetBody}>{body}</View>;
}
