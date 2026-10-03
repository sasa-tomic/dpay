import {View, Text, Pressable} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {AssetGlyph} from './AssetGlyph';
import {IconCheck} from './icons';
import type {SelectableAsset} from '../config/assets';

// Shared currency row — the single presentational component consumed by BOTH the Home tab accounts list
// (variant='card') and the ReceiveMode CurrencyPicker via AssetPicker (variant='plain'). Closes
// founder issues #2 (unify IC + SOL in one list) + #3 (two selectors must look/work the same):
// one component, one active indicator (trailing IconCheck), one subtitle logic.
//
// testID contract (preserves the e2e net byte-for-byte):
//   • variant='card': renders <View testID={testId}>…<Pressable testID={`${testId}-select`}>…</Pressable>…</View>
//     → matches the existing `asset-<key>` (container) + `asset-<key>-select` (inner Pressable) pattern.
//   • variant='plain': renders <Pressable testID={testId}>…</Pressable> → matches `req-pick-<key>`.
//
// Lead visual (2026-08-16 overhaul): every row leads with the family-hued AssetGlyph monogram
// chip — the plain dot marker (card) and the raw symbol text (plain) are gone. The name/subtitle
// derive from the `asset` itself (ONE source of truth — callers no longer re-pass symbol/networkLabel).
//
// Active indicator (UNIFIED across both variants): a trailing IconCheck in brand mint. The card
// variant KEEPS its brand left-edge (assetCardActive) as a card-level affordance — the check is
// the primary shared cue.
export type CurrencyRowProps = {
  testId: string;                  // base testID — 'asset-ckbtc' (card) | 'req-pick-ckbtc' (plain)
  asset: SelectableAsset;          // the row's asset — drives the glyph chip + name/subtitle
  /** Title override — the collision-qualified chip (`ZCHF·Arb`) when the caller computes one;
   *  defaults to the asset's own symbol. */
  label?: string;
  amount?: string;                 // '0.00050000 BTC' (card); omit in plain (the picker is a selector)
  active: boolean;                 // selects the trailing check + (card) left-edge
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  variant: 'card' | 'plain';       // card = Balances assetCard chrome; plain = picker pickItem
  showCheck?: boolean;             // render the check when active (default true in BOTH → unified indicator)
  zero?: boolean;                  // dim the amount (unfunded asset → assetCardZero); card variant only
  actions?: React.ReactNode;       // DEMO faucet button slot (card variant only)
  children?: React.ReactNode;      // extra nodes below the subtitle (topUpErr line; card variant only)
};

export function CurrencyRow({testId, asset, label, amount, active, onPress, accessibilityLabel, accessibilityHint, variant, showCheck = true, zero, actions, children}: CurrencyRowProps) {
  const title = label ?? asset.symbol;
  const check = active && showCheck ? (
    <View style={S.pickCheck}><IconCheck size={18} color={C.brandText} /></View>
  ) : null;

  if (variant === 'plain') {
    // Plain variant (the Receive picker): a bare Pressable (no card chrome) — glyph chip +
    // name/subtitle column + trailing check. The amount is OMITTED (the picker is a selector,
    // not a balance list).
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
        <AssetGlyph asset={asset} />
        <View style={S.pickTextCol}>
          <Text style={S.pickName}>{asset.symbol}</Text>
          <Text style={S.pickSubtitle}>{asset.networkLabel}</Text>
        </View>
        {check}
      </Pressable>
    );
  }

  // Card variant (the Home tab's accounts list): the WHOLE row block is the select hit target
  // (founder fix 2026-08-14 — "click ANYWHERE on the row to select"; was only the tight inner
  // row, so subtitle/padding taps fell through). The select Pressable (testID `asset-<key>-select`,
  // flex:1) stacks the glyph-led row content + children; the DEMO faucet `actions` stay a
  // row SIBLING (never nested — RN-web renders Pressables as <button>, and a button cannot
  // contain a button), so the faucet keeps its own taps and everything else selects.
  // Inside the row, the text column (pickTextCol — shared with the plain variant) stacks the
  // title line (name + right-aligned mono amount + trailing check) over the subtitle + children,
  // so the sub/annotations align under the NAME, not under the glyph chip.
  // O4 S3: the card carries its selected state — the row IS the selection state (the inline list
  // has no sheet chrome to wait on; e2e waits on aria-selected). The DIRECT prop is required:
  // RNW 0.21 forwards `aria-selected` verbatim but does NOT render accessibilityState.selected
  // to the DOM (probed live), and RN 0.86 supports the direct prop natively.
  return (
    <View testID={testId} style={[S.assetCard, active && S.assetCardActive]} aria-selected={active}>
      <View style={S.assetRow}>
        <Pressable
          testID={`${testId}-select`}
          style={S.assetSelectBlock}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={accessibilityHint}
          accessibilityState={{disabled: false}}
        >
          <View style={S.assetSelect}>
            <AssetGlyph asset={asset} />
            <View style={S.pickTextCol}>
              <View style={S.assetTitleRow}>
                {/* ONE line, always (2026-10-02 audit): the title yields to the amount (the
                    non-wrapping money column); the subtitle carries the full rail name. */}
                <Text style={S.assetLabel} numberOfLines={1}>{title}</Text>
                {amount != null ? <Text style={[S.assetAmt, zero && S.assetCardZero]}>{amount}</Text> : null}
                {check}
              </View>
              <Text style={S.assetSub}>{asset.networkLabel}</Text>
              {children}
            </View>
          </View>
        </Pressable>
        {actions ? <View style={S.assetActions}>{actions}</View> : null}
      </View>
    </View>
  );
}
