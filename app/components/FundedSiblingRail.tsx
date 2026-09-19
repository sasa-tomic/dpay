import {View, Text, Pressable, type TextStyle} from 'react-native';
import {S} from '../styles';
import {M} from '../i18n';
import {type SelectableAsset, linkNetworkOf, prettyNetwork} from '../config/assets';
import {type HomeCurrency, fundedAlternative, railLineLabel, type RailBalances} from '../config/currency';
import type {AssetId} from '../lib/types';
import {RailLiquidityNote} from './RailLiquidityNote';

const pointerLine: TextStyle = {marginTop: 2, textAlign: 'center'};

/**
 * The FUNDED-ACCOUNT pointer: the one sentence that turns "you have no money here" into "you have
 * money there". It renders wherever a Pay surface is about to tell the user an account is empty —
 * the send fund gate on both rails, and the unfunded scan surface.
 *
 * It began (Objective 2, S5) as a same-currency rail pointer and was WIDENED on 2026-09-08 to any
 * funded account, because the measured defect was bigger than the rail group: on a brand-new
 * wallet every path converged on "show my VCHF address" while ∂100 of spendable practice money sat
 * one tap away and was never named (`OPEN_ISSUES.md`, UX swarm X1). The ranking and every honesty
 * rule behind it live in ONE place — `fundedAlternative` in config/currency.ts; this component is
 * the rendering of its answer and holds no policy of its own.
 *
 * Three kinds, three promises, and the difference is the point:
 *   • 'sibling'  — the same currency on another chain. The button names the CHAIN, because that is
 *                  the only thing telling the two rails apart.
 *   • 'other'    — real money in a different currency. The button names the ASSET, because two
 *                  accounts can sit on the same chain and the chain would not distinguish them.
 *                  Nothing is converted: switching changes which account the tab acts on.
 *   • 'practice' — the DEMO balance. Its own sentence, never `holds`: it must say in the same
 *                  breath that a payment can be rehearsed with it AND that it buys nothing from a
 *                  real merchant. `fundedAlternative` only ever returns it for a PAY surface.
 *
 * THE SWITCH IS A USER GESTURE, never a side effect: `onSwitch` is Wallet's `payRailSelect`,
 * which routes through `shouldAllowUserSelect` before `selectAsset`. The selection lock exists
 * because a programmatic mid-flight switch unmounts the active engine and destroys the captured
 * request; Wallet therefore passes NO `onSwitch` while locked, and this component renders the
 * pointer WITHOUT the button (the account is still named — knowledge is not gated on the lock).
 *
 * Renders NOTHING when no funded account exists, so a genuinely empty wallet is unchanged. THE
 * SAME COMPONENT serves both engines (PayMode for IC rails, SolPayMode for Solana rails), which is
 * what guarantees the same offer shape on both rails.
 */
export function FundedSiblingRail({homeCurrency, assets, balances, selectedAssetId, purpose, onSwitch}: {
  homeCurrency: HomeCurrency | null;
  assets: SelectableAsset[];
  balances: RailBalances;
  selectedAssetId: AssetId | null;
  /** What the blocked surface was for. Practice money is only ever offered for 'pay' — it has no
   *  route off the wallet, so a send surface must not dangle it. */
  purpose: 'pay' | 'send';
  onSwitch?: (id: AssetId) => void;
}) {
  const alt = fundedAlternative({homeCurrency, assets, balances, selectedAssetId, purpose});
  if (alt == null) return null;
  const {asset, held, kind} = alt;
  const line = kind === 'practice'
    ? M.pay.fundSibling.practice(held.displayText)
    : M.pay.fundSibling.holds(held.displayText, railLineLabel(asset));
  const cta = kind === 'sibling'
    ? M.pay.fundSibling.switchTo(prettyNetwork(linkNetworkOf(asset)))
    : kind === 'other'
      ? M.pay.fundSibling.switchToAsset(asset.symbol)
      : M.pay.fundSibling.switchToPractice;
  return (
    <View testID="fund-sibling-rail">
      <Text testID="fund-sibling-holds" style={[S.assetSub, pointerLine]}>{line}</Text>
      {/* The named account's rail-health note — rendered BEFORE the switch button because it is the
          cost of the very thing the button offers: the user is one tap from moving there, and a
          thin rail must say so at the decision, not after it. Warn tone: it renders exactly
          on the thin rails; a deep or untiered account (practice money included) shows nothing. */}
      <RailLiquidityNote asset={asset} tone="warn" />
      {onSwitch ? (
        <Pressable
          testID="btn-fund-sibling-switch"
          style={S.linkBtn}
          onPress={() => onSwitch(asset.id)}
          accessibilityRole="button"
          accessibilityLabel={cta}
        >
          <Text style={S.linkText}>{cta}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
