import {View, Text, Pressable, type TextStyle} from 'react-native';
import {S} from '../styles';
import {M} from '../i18n';
import {type SelectableAsset, linkNetworkOf, prettyNetwork} from '../config/assets';
import {type HomeCurrency, currencyRails, railLineLabel, type RailBalances} from '../config/currency';
import type {AssetId} from '../lib/types';
import {RailLiquidityNote} from './RailLiquidityNote';

const pointerLine: TextStyle = {marginTop: 2, textAlign: 'center'};

/**
 * The funded-sibling pointer for the Pay tab's fund-first gates (Objective 2, S5). When the
 * payment wants a rail whose balance is the reason the gate exists at all, and a SIBLING rail of
 * the same home currency is funded (`balances[sibling].status === 'ok'`), the gate stops being a
 * dead end: it names that rail and how much it holds — the amount line exactly as the balances
 * map renders it (unit included; never merged with the unfunded rail's, never converted) — and
 * offers the switch as ONE tap.
 *
 * THE SWITCH IS A USER GESTURE, never a side effect: `onSwitch` is Wallet's `payRailSelect`,
 * which routes through `shouldAllowUserSelect` before `selectAsset`. The selection lock exists
 * because a programmatic mid-flight switch unmounts the active engine and destroys the captured
 * request; Wallet therefore passes NO `onSwitch` while locked, and this component renders the
 * pointer WITHOUT the button (the rail is still named — knowledge is not gated on the lock).
 *
 * Renders NOTHING unless a funded sibling exists, so single-rail currencies (CHF today),
 * foreign-currency selections and unfunded groups render exactly as before. THE SAME COMPONENT
 * serves both engines (PayMode for IC rails, SolPayMode for Solana rails), which is what
 * guarantees the same pointer shape on both rails.
 */
export function FundedSiblingRail({homeCurrency, assets, balances, selectedAssetId, onSwitch}: {
  homeCurrency: HomeCurrency | null;
  assets: SelectableAsset[];
  balances: RailBalances;
  selectedAssetId: AssetId | null;
  onSwitch?: (id: AssetId) => void;
}) {
  if (homeCurrency == null || selectedAssetId == null) return null;
  // The pointer is a SAME-CURRENCY surface only: the gated selection must itself be a rail of
  // the home currency's group. A ckBTC or SOL gate has no sibling — any funded USDC row is
  // somebody else's currency group — and must render exactly as before.
  const rails = currencyRails(homeCurrency, assets);
  if (!rails.some(r => r.id === selectedAssetId)) return null;
  // Preference order (currencyRails): with more than one funded sibling, the wallet's own
  // preference wins — the same rail the chooser would have picked.
  const sibling = rails.find(r => r.id !== selectedAssetId && balances[r.id]?.status === 'ok');
  if (sibling == null) return null;
  const held = balances[sibling.id]!;
  const network = prettyNetwork(linkNetworkOf(sibling));
  return (
    <View testID="fund-sibling-rail">
      <Text testID="fund-sibling-holds" style={[S.assetSub, pointerLine]}>
        {M.pay.fundSibling.holds(held.displayText, railLineLabel(sibling))}
      </Text>
      {/* The sibling's rail-health note — rendered BEFORE the switch button because it is the
          cost of the very thing the button offers: the user is one tap from moving to this rail,
          and a thin one (VEUR) must say so at the decision, not after it. Warn tone: it renders
          exactly on the thin rails; a deep sibling shows no caution (and no icon). */}
      <RailLiquidityNote asset={sibling} tone="warn" />
      {onSwitch ? (
        <Pressable
          testID="btn-fund-sibling-switch"
          style={S.linkBtn}
          onPress={() => onSwitch(sibling.id)}
          accessibilityRole="button"
          accessibilityLabel={M.pay.fundSibling.switchTo(network)}
        >
          <Text style={S.linkText}>{M.pay.fundSibling.switchTo(network)}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
