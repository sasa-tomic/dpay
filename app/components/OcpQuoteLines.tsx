import {useEffect, useState} from 'react';
import {View, Text} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {IconClock} from './icons';
import {M} from '../i18n';

/**
 * The three things an OpenCryptoPay review must say that no other review does — rendered ONCE, here,
 * so both rails' review screens say them identically (CLAUDE.md's same-surfaces rule).
 *
 *   • WHERE the price came from. A scanned LNURL can name any host on earth, and the host then
 *     supplies the merchant name, the amount and the destination. Showing it is what makes "why
 *     does this say api.evil.example" answerable before the payer approves
 *     (`docs/specs/2026-09-01-opencryptopay-findings.md`, "Trust model").
 *   • That the merchant name is CLAIMED, not verified — the same posture a payment link's `label`
 *     gets (`lib/deepLink.ts` is the authority for it).
 *   • HOW LONG the price is good for. This is not decoration: approving after the quote lapses
 *     moves irreversible funds against a quote the provider will refuse, which is the single worst
 *     outcome the loss path has. `onExpired` fires once at the deadline so the parent can disable
 *     Approve while the payer is still looking at the screen.
 *
 * The countdown reuses the request-QR expiry copy (`M.receive.validForMin` / `expiresIn`): the same
 * fact — this thing stops being valid at T — so it gets the same words, not a second set.
 */
export function OcpQuoteLines({
  host,
  claimedName,
  expiresAt,
  onExpired,
}: {
  host: string;
  /** The provider's claimed merchant name, or null when it sent none (then nothing is claimed). */
  claimedName: string | null;
  expiresAt: number;
  onExpired: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const expired = remaining === 0;
  useEffect(() => {
    if (expired) onExpired();
    // `onExpired` is an inline closure at every call site; the boolean gate is what makes this
    // fire once, so re-running on a new closure identity would be noise (PayMode's prefill effect
    // takes the same shape for the same reason).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired]);

  const minutes = Math.floor(remaining / 60);
  return (
    <>
      {claimedName ? <Text testID="review-claimed" style={S.dim2}>{M.pay.ocp.claimedMerchant}</Text> : null}
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
