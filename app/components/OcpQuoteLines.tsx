import {useEffect, useState} from 'react';
import {View, Text} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {IconClock} from './icons';
import {ocpPriceText, type OcpAssetAmount} from '../lib/opencryptopay';
import {M} from '../i18n';

/**
 * The two things an OpenCryptoPay review must say that no other review does — rendered ONCE, here,
 * so both rails' review screens say them identically (CLAUDE.md's same-surfaces rule).
 *
 *   • ONE LINE carrying the checkout's PRICE and WHO SET IT: `CHF 1 · price from api.dfx.swiss`.
 *     - The price, because `0.0000162 BTC` is uncheckable on its own: the number printed on the
 *       checkout and read out by the cashier is "CHF 1", so without it the payer approves an amount
 *       they have no way to compare against the sale. Absent when the provider sent none, and then
 *       the line is the host alone — display context never blocks a payment.
 *     - The host, because a scanned LNURL can name any host on earth, and the host then supplies
 *       the merchant name, the amount and the destination. It is what makes "why does this say
 *       api.evil.example" answerable before the payer approves
 *       (`docs/specs/2026-09-01-opencryptopay-findings.md`, "Trust model"). ONE host is shown and
 *       it is the whole truth: the proof of the transfer goes to the host named by the provider's
 *       own `callback` — a different string from a different source — and `fetchPaymentDetails`
 *       REFUSES a quote whose two hosts differ (`OcpDetails.proofHost`).
 *     Naming the host IS the attribution the no-quote rule requires: the price is stated as the
 *     provider's, never as dpay's. It used to take three lines and two policy sentences to say
 *     that ("Their payment provider set the amount above — dpay doesn't convert"), which is copy
 *     written for dpay rather than for the payer (founder, 2026-09-09).
 *
 *   • HOW LONG the price can still be ACTED ON — but ONLY once that is about to stop being true.
 *     Approving too late moves irreversible funds against a quote the provider will refuse, which
 *     is the single worst outcome the loss path has, so the deadline itself is never softened: the
 *     clock still ticks every second and `onTooLate` still fires at `payableUntil` — the last
 *     instant Approve may be pressed (`OcpTarget.payableUntil`), not the quote's own expiry — so
 *     the parent can disable Approve while the payer is still looking at the screen. What changed
 *     is only the DISPLAY: with four minutes left a countdown changes nothing a payer would do, and
 *     is one more thing to read at a checkout; inside the last minute it is the reason they hurry. So
 *     it renders exactly there, in the warn tone it already had for that branch.
 *
 * The countdown reuses the request-QR expiry copy (`M.receive.expiresIn`): the same fact — this
 * thing stops being usable at T — so it gets the same words, not a second set.
 */
/** Below this much time left, the countdown is the payer's cue to hurry; above it, it is noise. */
const URGENT_S = 60;

export function OcpQuoteLines({
  host,
  requested,
  payableUntil,
  onTooLate,
}: {
  host: string;
  /** What the checkout asked for in ITS OWN unit (`OcpDetails.requestedAmount`), or null when the
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

  return (
    <>
      <Text testID="ocp-price" style={S.dim2}>
        {requested ? M.pay.ocp.checkoutPrice(ocpPriceText(requested), host) : M.pay.ocp.providerHost(host)}
      </Text>
      {remaining < URGENT_S ? (
        <View style={{flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6}}>
          <IconClock size={14} color={C.warn} />
          <Text testID="ocp-expiry" style={[S.qrExpiryWarn, {marginTop: 0}]}>{M.receive.expiresIn(remaining.toString().padStart(2, '0'))}</Text>
        </View>
      ) : null}
    </>
  );
}
