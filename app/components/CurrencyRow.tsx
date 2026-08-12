import {View, Text, Pressable} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';

// Shared currency row — the single presentational component consumed by BOTH the BalancesSheet
// (variant='card') and the ReceiveMode CurrencyPicker (variant='plain'). Closes founder issues #2
// (unify IC + SOL in one list) + #3 (two selectors must look/work the same): one component, one
// active indicator (brand dot + trailing ✓ check), one subtitle logic.
//
// testID contract (preserves the e2e net byte-for-byte):
//   • variant='card': renders <View testID={testId}>…<Pressable testID={`${testId}-select`}>…</Pressable>…</View>
//     → matches the existing `asset-<key>` (container) + `asset-<key>-select` (inner Pressable) pattern.
//   • variant='plain': renders <Pressable testID={testId}>…</Pressable> → matches `req-pick-<key>`.
//
// Active indicator (UNIFIED across both variants): the `dot` turns C.brand when active AND a `✓`
// check renders at the row's trailing edge. The card variant KEEPS its brand left-edge
// (assetCardActive) as a card-level affordance — the dot+check is the primary shared cue.
export type CurrencyRowProps = {
  testId: string;                  // base testID — 'asset-ckbtc' (card) | 'req-pick-ckbtc' (plain)
  name: string;                    // 'BTC' | 'USDC' | 'SOL' | 'DEMO'
  subtitle?: string;               // chain label / curated description
  amount?: string;                 // '0.00050000 BTC' (card); omit in plain (the picker is a selector)
  active: boolean;                 // selects dot color + check mark + (card) left-edge
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  variant: 'card' | 'plain';       // card = Balances assetCard chrome; plain = picker pickItem
  showCheck?: boolean;             // render ✓ when active (default true in BOTH → unified indicator)
  zero?: boolean;                  // dim the amount (unfunded asset → assetCardZero); card variant only
  actions?: React.ReactNode;       // DEMO faucet button slot (card variant only)
  children?: React.ReactNode;      // extra nodes below the subtitle (topUpErr line; card variant only)
};

export function CurrencyRow({testId, name, subtitle, amount, active, onPress, accessibilityLabel, accessibilityHint, variant, showCheck = true, zero, actions, children}: CurrencyRowProps) {
  const check = active && showCheck ? <Text style={S.pickCheck}>✓</Text> : null;
  const dot = <View style={[S.dot, {backgroundColor: active ? C.brand : C.line}]} />;

  if (variant === 'plain') {
    // Plain variant (the Receive picker): a bare Pressable (no card chrome) — dot + name/subtitle
    // column + trailing ✓. The amount is OMITTED (the picker is a selector, not a balance list).
    return (
      <Pressable
        testID={testId}
        style={S.pickItem}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{disabled: false}}
      >
        {dot}
        <View style={S.pickTextCol}>
          <Text style={S.pickName}>{name}</Text>
          {subtitle ? <Text style={S.pickSubtitle}>{subtitle}</Text> : null}
        </View>
        {check}
      </Pressable>
    );
  }

  // Card variant (BalancesSheet): a container View (assetCard, optional assetCardActive) with an
  // assetRow holding the select Pressable (dot + name + amount + ✓) and an optional actions sibling
  // (the DEMO faucet button). The subtitle renders full-width below the row; children (topUpErr)
  // below that. The container View keeps `asset-<key>`; the Pressable carries `asset-<key>-select`.
  return (
    <View testID={testId} style={[S.assetCard, active && S.assetCardActive]}>
      <View style={S.assetRow}>
        <Pressable
          testID={`${testId}-select`}
          style={S.assetSelect}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={accessibilityHint}
          accessibilityState={{disabled: false}}
        >
          {dot}
          <Text style={S.assetLabel}>{name}</Text>
          {amount != null ? <Text style={[S.assetAmt, zero && S.assetCardZero]}>{amount}</Text> : null}
          {check}
        </Pressable>
        {actions ? <View style={S.assetActions}>{actions}</View> : null}
      </View>
      {subtitle ? <Text style={S.assetSub}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}
