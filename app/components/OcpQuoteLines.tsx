import {useEffect, useState} from 'react';
import {View, Text} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {IconClock} from './icons';
import {ocpPriceText, type OcpAssetAmount} from '../lib/opencryptopay';
import {M} from '../i18n';

/**
 * The four things an OpenCryptoPay review must say that no other review does — rendered ONCE, here,
 * so both rails' review screens say them identically (CLAUDE.md's same-surfaces rule).
 *
 *   • WHERE the price came from. A scanned LNURL can name any host on earth, and the host then
 *     supplies the merchant name, the amount and the destination. Showing it is what makes "why
 *     does this say api.evil.example" answerable before the payer approves
 *     (`docs/specs/2026-09-01-opencryptopay-findings.md`, "Trust model"). ONE host is shown and it
 *     is the whole truth: the proof of the transfer goes to the host named by the provider's own
 *     `callback` — a different string from a different source — and `fetchPaymentDetails` REFUSES a
 *     quote whose two hosts differ (`OcpDetails.proofHost`), so the host on this line is also the
 *     host that receives the money's proof. Without that refusal this line would name the host the
 *     payer scanned while the payment answered to another one.
 *   • That the merchant name is CLAIMED, not verified — the same posture a payment link's `label`
 *     gets (`lib/deepLink.ts` is the authority for it).
 *   • WHAT THE TILL IS CHARGING, in the till's own unit. `0.0000162 BTC` is uncheckable on its own:
 *     the number printed on the till and read out by the cashier is "CHF 1", so without this line
 *     the payer approves an amount they have no way to compare against the price of the sale. It is
 *     the PROVIDER's figure and the copy says so — the provider decided how much crypto that price
 *     costs, and dpay neither quotes nor converts (CLAUDE.md non-negotiable). Absent when the
 *     provider sent none, exactly like the claimed name: display context never blocks a payment.
 *   • HOW LONG the price can still be ACTED ON. This is not decoration: approving too late moves
 *     irreversible funds against a quote the provider will refuse, which is the single worst
 *     outcome the loss path has. The countdown therefore runs to `payableUntil` — the last instant
 *     Approve may be pressed (`OcpTarget.payableUntil`), not the quote's own expiry — because a
 *     countdown that invites a press it cannot honour is the bug this component exists to prevent.
 *     `onTooLate` fires once at that deadline so the parent can disable Approve while the payer is
 *     still looking at the screen.
 *
 * The countdown reuses the request-QR expiry copy (`M.receive.validForMin` / `expiresIn`): the same
 * fact — this thing stops being usable at T — so it gets the same words, not a second set.
 */
export function OcpQuoteLines({
  host,
  claimedName,
  requested,
  payableUntil,
  onTooLate,
}: {
  host: string;
  /** The provider's claimed merchant name, or null when it sent none (then nothing is claimed). */
  claimedName: string | null;
  /** What the till asked for in ITS OWN unit (`OcpDetails.requestedAmount`), or null when the
   *  provider sent none or sent it unreadably. */
  requested: OcpAssetAmount | null;
  payableUntil: number;
  onTooLate: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = Math.max(0, Math.floor((payableUntil - now) / 1000));
  const tooLate = remaining === 0;
  useEffect(() => {
    if (tooLate) onTooLate();
    // `onTooLate` is an inline closure at every call site; the boolean gate is what makes this
    // fire once, so re-running on a new closure identity would be noise (PayMode's prefill effect
    // takes the same shape for the same reason).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tooLate]);

  const minutes = Math.floor(remaining / 60);
  return (
    <>
      {claimedName ? <Text testID="review-claimed" style={S.dim2}>{M.pay.ocp.claimedMerchant}</Text> : null}
      {/* Under the claimed-name marker (which belongs beside the NAME above it) and above the host,
          so the two provider-supplied facts — what it is charging and who priced it — read together. */}
      {requested ? <Text testID="ocp-requested" style={S.dim2}>{M.pay.ocp.tillCharging(ocpPriceText(requested))}</Text> : null}
      <Text testID="ocp-host" style={S.dim2}>{M.pay.ocp.providerHost(host)}</Text>
      {minutes >= 1 ? (
        <View style={{flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6}}>
          <IconClock size={14} color={C.sub} />
          <Text testID="ocp-expiry" style={[S.qrExpiry, {marginTop: 0}]}>{M.receive.validForMin(minutes)}</Text>
        </View>
      ) : (
        <Text testID="ocp-expiry" style={S.qrExpiryWarn}>{M.receive.expiresIn(remaining.toString().padStart(2, '0'))}</Text>
      )}
    </>
  );
}
