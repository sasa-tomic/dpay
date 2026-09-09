import type {ReactNode} from 'react';
import {View, Text, Pressable} from 'react-native';
import {S} from '../styles';
import {type CurrencyDescriptor, fmtCurrencyAmount} from '../config/catalog';
import type {PayIntent} from '../lib/types';
import {M} from '../i18n';

/**
 * PaymentReview — the screen a payer approves money on, extracted from PayMode (2026-09-08) so
 * there is exactly ONE of it.
 *
 * It was extracted for the first-run practice payment (spec
 * docs/specs/2026-09-08-first-run-redesign.md §6): practice has to be the real thing, and a
 * lookalike review would teach the wrong screen — the one gesture a user must recognise for the
 * rest of their trip is Approve on THIS card. Rendering a second, prettier copy for the tutorial is
 * how a tutorial teaches a habit that does not transfer.
 *
 * Every testID is byte-stable with the card PayMode rendered before the extraction (`pay-amount`,
 * `review-payee`, `review-lowbal`, `review-err`, `btn-approve`, `btn-review-cancel`) — the e2e
 * suite's contract for the pay path is unchanged by construction.
 *
 * What varies between entries is passed as `notes`, rendered under the payee block: an
 * OpenCryptoPay till adds its one quote line, practice adds its fee row and the sentence about one
 * phone playing both sides. The component itself knows nothing about where a payment came from, so
 * no entry can quietly grow its own review.
 *
 * `approveDisabled` is computed HERE, once: a shown error or a blocked balance must never leave a
 * doomed payment re-tappable, and two call sites deriving that separately is two chances to get it
 * wrong.
 */
export function PaymentReview({catalog, intent, notes, insufficient, blockApprove, err, busy, onApprove, onCancel}: {
  catalog: CurrencyDescriptor[];
  intent: PayIntent;
  notes?: ReactNode;
  insufficient: boolean;
  blockApprove: boolean;
  err: string | null;
  busy: boolean;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const approveDisabled = busy || !!err || blockApprove;
  return (
    <View style={S.center}>
      {/* No screen title. "Review payment" sat directly above "Pay <amount>" with Approve and
          Cancel underneath — the screen named itself three times, and the eyebrow was the copy that
          said the least (founder, 2026-09-09). */}
      <Text testID="pay-amount" style={S.reviewAmount}>{M.pay.payAmount(fmtCurrencyAmount(catalog, intent.currency, intent.amount))}</Text>
      <PayeeLine intent={intent} />
      {notes}
      {/* C1/C2 + L5: the warning + any error render ABOVE the button (not below) so they're seen
          first; the raw request nonce is no longer surfaced (internal protocol data). */}
      {insufficient ? (
        <Text testID="review-lowbal" style={S.warnNote}>{blockApprove
          ? M.pay.notEnoughBalance
          : M.pay.localBalanceMayNotCover}</Text>
      ) : null}
      {err ? <Text testID="review-err" style={S.err}>{err}</Text> : null}
      <Pressable
        testID="btn-approve"
        style={[S.primary, approveDisabled && S.disabledFlat]}
        disabled={approveDisabled}
        accessibilityRole="button"
        accessibilityLabel={M.pay.approveA11y}
        accessibilityHint={M.pay.approveHint}
        accessibilityState={{disabled: approveDisabled}}
        onPress={onApprove}>
        <Text style={[S.primaryText, approveDisabled && S.disabledText]}>{busy ? M.pay.signing : M.pay.approve}</Text>
      </Pressable>
      {/* Audit P2: Cancel-as-secondary-button parity — a bordered secondary button of the same
          width as Approve so the tap targets are equivalent and the user makes a deliberate choice
          (a reflex Approve tap was the asymmetry risk). Matches the Cancel style used by the
          offline confirm row + the unsupported-asset cancel. */}
      <Pressable
        testID="btn-review-cancel"
        style={S.secondaryBtn}
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel={M.common.cancel}
        accessibilityState={{disabled: false}}>
        <Text style={S.secondaryBtnText}>{M.common.cancel}</Text>
      </Pressable>
    </View>
  );
}

/**
 * The destination, always rendered: the short pubkey of a scanned request, the FULL ICRC-1
 * principal of a payment link. A link can name any account on the ledger, and the account IS the
 * identity — the label beside it is only what the sender claims to be called.
 *
 * Exported because PayMode's camera-entry surface (read-only while it signs, no Approve) shows the
 * same two lines, and a payer must read the same destination on both.
 */
export function PayeeLine({intent}: {intent: PayIntent}) {
  return (
    <>
      <Text style={S.reviewTo}>{M.pay.toWho(intent.toName || intent.toAccountText)}</Text>
      {/* U-F5 — the destination account as a subdued second line when a display name is shown,
          so the payer can verify where the money goes beyond a claimed name (phishing surface).
          The no-name fallback already renders the account as the primary "to" line. */}
      {intent.toName ? <Text testID="review-payee" style={S.dim2}>{intent.toAccountText}</Text> : null}
    </>
  );
}
