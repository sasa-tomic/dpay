import {useState} from 'react';
import {Pressable, Text, View} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {AssetPicker} from './AssetPicker';
import {IconChevronDown} from './icons';
import {M} from '../i18n';
import type {SelectableAsset} from '../config/assets';
import type {HomeCurrency} from '../config/currency';
import type {BalanceView} from '../lib/assetBalances';
import type {AssetId} from '../lib/types';

/**
 * Switch which asset's receiving address is on screen, without leaving the screen.
 *
 * THE DEFECT THIS CLOSES (UX swarm 2026-09-08). Getting a receiving address for an asset that was
 * not already selected took four taps and a tab switch: header chip → accounts route → tap the row
 * → Receive tab → My address. The Receive tab's REQUEST half has had a one-tap asset picker on its
 * amount prefix since 2026-08-12; the ADDRESS half never got one, so the two halves of one tab
 * disagreed about whether choosing an asset was a gesture or a journey.
 *
 * WHY IT NEEDS ITS OWN SELECT CALLBACK, and this is the reason it was not simply added earlier:
 * Wallet's ordinary `handleSelect` deliberately RESETS the within-tab sub-modes, so picking an
 * asset from the address surface would bounce the user back to the request form — the opposite of
 * what they asked for. The caller therefore passes the sub-mode-preserving selector (Wallet's
 * `receiveRailSelect`), which is the same one `RailDisclosure` already uses from this very surface.
 *
 * Shared by BOTH Receive surfaces (IC and Solana) because `CLAUDE.md`'s uniform-IA rule is a hard
 * rule: a control that exists on one rail's Receive tab and not another's is a bug, not an
 * exception. One component is how that stays true without anyone having to remember it.
 */
export function AssetSwitchRow({asset, assets, balances, selectedId, homeCurrency, onSelect}: {
  /** The asset whose address is currently shown — what the row names. */
  asset: SelectableAsset;
  assets: SelectableAsset[];
  balances: Record<AssetId, BalanceView>;
  selectedId: AssetId | null;
  homeCurrency: HomeCurrency | null;
  /** MUST preserve the address sub-mode — see the note above. */
  onSelect: (id: AssetId) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={S.assetSwitchWrap}>
      <Pressable
        testID="btn-receive-asset-switch"
        style={S.assetSwitchBtn}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={M.receive.receiveIn(asset.symbol)}
        accessibilityHint={M.receive.chooseCurrencyHint}
        accessibilityState={{disabled: false}}>
        <Text style={S.assetSwitchText}>{M.receive.receiveIn(asset.symbol)}</Text>
        <IconChevronDown size={16} color={C.sub} />
      </Pressable>
      <AssetPicker
        open={open}
        assets={assets}
        selectedId={selectedId}
        balances={balances}
        homeCurrency={homeCurrency}
        onSelect={onSelect}
        onClose={() => setOpen(false)}
      />
    </View>
  );
}
