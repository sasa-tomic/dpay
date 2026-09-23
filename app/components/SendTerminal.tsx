import {View, Text, Pressable} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {IconCheck, IconClock, IconClose, IconCopy} from './icons';
import {M} from '../i18n';

/**
 * SendTerminal — the ONE surface both send rails end on (2026-09 stream D). SendSheet (IC) and
 * SolanaWithdrawSheet (SOL) route their terminal phases here instead of each painting its own
 * ending, so a send settles, pends or fails with the same shapes, the same actions and the same
 * testID grammar on every rail (CLAUDE.md's same-surfaces rule, applied to the endings).
 *
 * Three endings, one layout:
 *   • settled  — check disc, headline, amount, destination, the rail's tx reference + copy,
 *                View receipt, Done.
 *   • pending  — clock disc (the honest unknown: the send may still land), the pending body,
 *                reference + copy, and — SOL only, the rail that CAN re-read a kept signature —
 *                Check status. Read-only: it resolves an outcome, it never re-signs.
 *   • failed   — the on-chain verdict a Check status surfaced (fee-only truth; nothing was
 *                delivered). Terminal: no resend invite, the reference stays as the proof.
 *
 * The receipt affordance hands the caller's `onOpenReceipt` an already-built `Txn` — the same
 * `TxnReceipt` the History rows open, mounted at the Wallet root per its documented rule. The
 * caller owns the copy locale strings (headlines and reference labels differ per rail); this
 * component owns the terminal chrome only. testIDs derive from `prefix`:
 * `<prefix>-outcome` / `-unknown-title` / `-unknown-note` / `-failed-title` / `-destination` /
 * `btn-<prefix>-copy` / `-check` / `-receipt` / `-done`; the reference value's id is the caller's
 * `refTestID` (the SOL signature keeps the `sol-send-signature` id existing flows pin).
 */
export function SendTerminal({
  settled,
  failed = false,
  headline,
  amountText,
  destinationLabel,
  destination,
  pendingBody,
  failedBody,
  referenceLabel,
  reference,
  refTestID,
  prefix,
  onOpenReceipt,
  onCheckStatus,
  checkBusy = false,
  checkErr = null,
  onDone,
}: {
  settled: boolean;
  /** A Check-status read returned an on-chain `err` — the definitive fee-only failure panel. */
  failed?: boolean;
  headline: string;
  amountText: string;
  destinationLabel: string;
  destination: string;
  /** The honest pending body (unknown only) — names the next step, never invites a resend. */
  pendingBody?: string;
  /** The failed panel's fee-only body. */
  failedBody?: string;
  referenceLabel: string;
  reference: string;
  refTestID: string;
  /** testID prefix — 'send' (IC) | 'sol-send' (SOL). */
  prefix: string;
  onOpenReceipt?: () => void;
  /** SOL unknown only: re-read the chain for the kept signature. The panel stays honest on any
   *  answer that is not a verdict: null (never heard of it) and 'processed' stay pending. */
  onCheckStatus?: () => void;
  checkBusy?: boolean;
  /** A check that could not complete (rail unreachable) — said under the button; the pending stays. */
  checkErr?: string | null;
  onDone: () => void;
}) {
  const {copied, copy} = useCopyFeedback();
  const pending = !settled && !failed;
  const titleTestID = settled ? `${prefix}-outcome` : failed ? `${prefix}-failed-title` : `${prefix}-unknown-title`;
  return (
    <View style={S.centerAll}>
      <View style={[S.check, (!settled || failed) && S.checkAlready]}>
        {settled ? <IconCheck size={44} color={C.brandInk}/> : failed ? <IconClose size={44} color={C.brandInk}/> : <IconClock size={44} color={C.brandInk}/>}
      </View>
      <Text testID={titleTestID} style={S.paidText}>{headline}</Text>
      <Text style={S.paidSub}>{amountText}</Text>
      <Text style={S.dim2}>{destinationLabel}</Text>
      <Text testID={`${prefix}-destination`} selectable={true} style={S.sheetAddr}>{destination}</Text>
      {pending && pendingBody ? <Text testID={`${prefix}-unknown-note`} style={S.warnNote}>{pendingBody}</Text> : null}
      {failed && failedBody ? <Text testID={`${prefix}-failed-note`} style={S.warnNote}>{failedBody}</Text> : null}
      <Text style={S.dim2}>{referenceLabel}</Text>
      <Text testID={refTestID} selectable={true} style={S.sheetAddr}>{reference}</Text>
      <Pressable
        testID={`btn-${prefix}-copy`}
        style={S.primaryWide}
        onPress={() => { void copy(reference); }}
        accessibilityRole="button"
        accessibilityLabel={M.withdraw.send.copyReference}>
        <IconCopy size={18} color={C.brandInk}/>
        <Text style={S.primaryText}>{copied === 'clipboard' ? M.withdraw.copied : copied === 'shared' ? M.withdraw.shared : M.withdraw.send.copyReference}</Text>
      </Pressable>
      {onCheckStatus != null && pending ? (
        <>
          <Pressable
            testID={`btn-${prefix}-check`}
            style={[S.termBtn, checkBusy && S.disabledFlat]}
            disabled={checkBusy}
            onPress={onCheckStatus}
            accessibilityRole="button"
            accessibilityState={{disabled: checkBusy}}>
            <Text style={[S.termBtnText, checkBusy && S.disabledText]}>{checkBusy ? M.withdraw.send.checking : M.withdraw.send.checkStatus}</Text>
          </Pressable>
          {checkErr ? <Text testID={`${prefix}-check-err`} style={S.warnNote}>{checkErr}</Text> : null}
        </>
      ) : null}
      {onOpenReceipt != null && !failed ? (
        <Pressable
          testID={`btn-${prefix}-receipt`}
          style={S.termBtn}
          onPress={onOpenReceipt}
          accessibilityRole="button"
          accessibilityLabel={M.withdraw.send.viewReceipt}>
          <Text style={S.termBtnText}>{M.withdraw.send.viewReceipt}</Text>
        </Pressable>
      ) : null}
      <Text style={S.dim2}>{M.withdraw.balanceAuto}</Text>
      <Pressable
        testID={`btn-${prefix}-done`}
        style={[S.ghostBtn, S.ghostBtnMuted]}
        onPress={onDone}
        accessibilityRole="button"
        accessibilityLabel={M.common.done}
        accessibilityState={{disabled: false}}>
        <Text style={S.ghostBtnText}>{M.common.done}</Text>
      </Pressable>
    </View>
  );
}
