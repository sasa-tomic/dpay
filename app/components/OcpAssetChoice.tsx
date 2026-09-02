import {View, Text, Pressable} from 'react-native';
import {S} from '../styles';
import type {OcpOffer} from '../lib/opencryptopay';
import {M} from '../i18n';

/**
 * The till's menu, when the payer's SELECTED asset is not on it.
 *
 * WHY THIS EXISTS. An OpenCryptoPay till quotes a MENU — several assets, each with its own price
 * for the same sale. dpay used to throw that menu away, check only the one asset the payer happened
 * to have selected, and on a miss send them to Balances to switch and re-aim a camera at the QR.
 * At a supermarket checkout with a queue behind you, that round trip is the difference between
 * paying and giving up.
 *
 * This is NOT a swap and must never read as one. dpay converts nothing: each option settles in its
 * own asset natively, the provider priced all of them, and the payer picks which of their own
 * holdings to spend. That is also why the heading names the asset that was DECLINED — switching
 * what you pay with is a decision, never something the wallet does quietly on your behalf — and why
 * picking still lands on the normal review screen, where the amount, the destination and the
 * provider host are approved explicitly. (Contrast a dpay REQUEST, where the merchant names one
 * exact asset and the payer may not change it — CLAUDE.md's locked-asset rule. A till menu is the
 * opposite case: the merchant offered all of these.)
 *
 * ONE component for both rails (the IC `PayMode` and the Solana `SolPayMode`), because CLAUDE.md
 * makes a per-rail divergence on a money surface a bug rather than an exception. The rails differ
 * only in how an amount is spelled, so that is the one thing injected: `labelOf` formats an offer in
 * its asset's own units, which each rail already knows how to do and neither should re-derive here.
 */
export function OcpAssetChoice({declined, options, busy, labelOf, onPick, onCancel}: {
  /** The selected asset's symbol — the one the till would not take. Named in the heading. */
  declined: string;
  /** Every offer this wallet can pay on the rail the payer is already on. Never empty: the resolver
   *  returns a refusal instead of an empty menu, so this component cannot render a dead end. */
  options: OcpOffer[];
  /** A pick is in flight (one provider read for the chosen asset's destination). */
  busy: boolean;
  labelOf: (offer: OcpOffer) => string;
  onPick: (offer: OcpOffer) => void;
  onCancel: () => void;
}) {
  return (
    <View style={S.center}>
      <Text style={S.label}>{M.pay.reviewPayment}</Text>
      <Text testID="ocp-choose" style={S.dim2}>{M.pay.ocp.chooseAsset(declined)}</Text>
      {options.map(o => (
        <Pressable
          key={o.assetId}
          testID={`ocp-option-${o.assetId}`}
          style={[S.secondaryBtn, busy && S.disabledFlat]}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{disabled: busy}}
          onPress={() => onPick(o)}>
          {/* The EXACT amount in that asset's own units. The price differs per asset, so a menu of
              bare asset names would be a choice made blind — which is not consent. */}
          <Text style={S.secondaryBtnText}>{M.pay.payAmount(labelOf(o))}</Text>
        </Pressable>
      ))}
      {busy ? <Text testID="ocp-checking" style={S.dim2}>{M.pay.ocp.checkingTill}</Text> : null}
      <Pressable
        testID="btn-ocp-choose-cancel"
        style={S.ghostBtn}
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel={M.common.cancel}
        accessibilityState={{disabled: false}}>
        <Text style={S.ghostBtnText}>{M.common.cancel}</Text>
      </Pressable>
    </View>
  );
}
